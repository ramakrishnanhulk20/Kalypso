import { z } from "zod";
import type { Config } from "./config.ts";
import { fetchWithTimeout, parseJsonBytes } from "./http.ts";

/*
 * A small Stellar RPC client over fetchWithTimeout. The SDK's own client has
 * its own HTTP stack, which would bypass the fixed-origin, timeout and size
 * rules. Every reply is schema-checked here because RPC is an upstream the
 * archive and the sponsor must not take on trust (threat model TB4).
 */

const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_TOPICS = 8;
/** RPC's own cap on keys per getLedgerEntries call. */
export const MAX_LEDGER_KEYS = 200;

export class RpcError extends Error {
  /** A JSON-RPC error code, or what went wrong with the reply itself. */
  readonly code: number | "http_status" | "bad_reply";
  /** Short, printable, for logs only. Never put in a response body. */
  readonly detail: string;
  constructor(code: number | "http_status" | "bad_reply", detail = "") {
    super("rpc error " + String(code));
    this.name = "RpcError";
    this.code = code;
    this.detail = detail.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
  }
}

const ledgerNumber = z.number().int().min(1).max(0xffffffff);

const healthSchema = z
  .object({ status: z.literal("healthy"), latestLedger: ledgerNumber, oldestLedger: ledgerNumber })
  .refine((h) => h.oldestLedger <= h.latestLedger);

const eventSchema = z.object({
  type: z.string().max(32),
  ledger: ledgerNumber,
  ledgerClosedAt: z.string().max(64),
  contractId: z.string().max(64),
  id: z.string().max(64),
  operationIndex: z.number().int().min(0).optional(),
  transactionIndex: z.number().int().min(0).optional(),
  txHash: z.string().max(64),
  inSuccessfulContractCall: z.boolean(),
  topic: z.array(z.string().max(4096)).max(MAX_EVENT_TOPICS),
  value: z.string().max(65536),
});

const eventsSchema = z.object({
  events: z.array(eventSchema).max(10_000),
  cursor: z.string().max(64).optional(),
  latestLedger: ledgerNumber,
  oldestLedger: ledgerNumber.optional(),
});

const simulationSchema = z.object({
  latestLedger: ledgerNumber,
  minResourceFee: z.string().regex(/^\d{1,19}$/).optional(),
  /** Base64 SorobanTransactionData: the footprint and resources the call needs. */
  transactionData: z.string().max(262_144).optional(),
  error: z.string().optional(),
  restorePreamble: z.unknown().optional(),
  results: z
    .array(z.object({ auth: z.array(z.string().max(65_536)).max(64).optional(), xdr: z.string().max(65_536).optional() }))
    .max(1)
    .optional(),
});

const ledgerEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        /** Base64 LedgerKey. */
        key: z.string().max(4_096),
        /** Base64 LedgerEntryData. */
        xdr: z.string().max(262_144),
        lastModifiedLedgerSeq: z.number().int().min(0).optional(),
        liveUntilLedgerSeq: z.number().int().min(0).optional(),
      }),
    )
    .max(MAX_LEDGER_KEYS)
    .nullish()
    .transform((entries) => entries ?? []),
  latestLedger: ledgerNumber,
});

const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
});

export type RpcHealth = z.infer<typeof healthSchema>;
export type RpcEvent = z.infer<typeof eventSchema>;
export type RpcEventsPage = z.infer<typeof eventsSchema>;
export type RpcSimulation = z.infer<typeof simulationSchema>;
export type RpcLedgerEntries = z.output<typeof ledgerEntriesSchema>;

export interface GetEventsQuery {
  /** Required when there is no cursor; RPC refuses both together. */
  startLedger?: number;
  cursor?: string;
  contractIds: readonly string[];
  limit: number;
}

export type SimulationAuthMode = "enforce" | "record";

export interface RpcClient {
  getHealth(signal?: AbortSignal): Promise<RpcHealth>;
  getEvents(query: GetEventsQuery, signal?: AbortSignal): Promise<RpcEventsPage>;
  /**
   * "enforce" (the default) checks the signatures in the auth entries.
   * "record" runs the call without auth entries and reports the ones it
   * needs; RPC refuses a record run that carries auth entries.
   */
  simulateTransaction(txBase64: string, authMode?: SimulationAuthMode, signal?: AbortSignal): Promise<RpcSimulation>;
  /**
   * Reads 1 to 200 ledger entries by base64 LedgerKey. A key with no entry
   * is simply missing from the reply. Throws RangeError for an empty or
   * oversized key list, before any network call.
   */
  getLedgerEntries(keys: readonly string[], signal?: AbortSignal): Promise<RpcLedgerEntries>;
}

/** RPC answers -32600 when a startLedger has fallen out of its retention window. */
export const RPC_INVALID_REQUEST = -32600;

export function createRpcClient(cfg: Pick<Config, "RPC_URL" | "CHANNELS_URL">, fetchImpl: typeof fetch = fetch): RpcClient {
  let nextId = 1;

  async function call<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const id = nextId++;
    const request: Parameters<typeof fetchWithTimeout>[2] = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }),
      maxResponseBytes: MAX_RPC_RESPONSE_BYTES,
    };
    if (signal) request.signal = signal;
    const res = await fetchWithTimeout(cfg, "RPC_URL", request, fetchImpl);
    if (res.status !== 200) throw new RpcError("http_status", String(res.status));
    let payload: unknown;
    try {
      payload = parseJsonBytes(res.body);
    } catch {
      throw new RpcError("bad_reply", "not json");
    }
    const envelope = envelopeSchema.safeParse(payload);
    if (!envelope.success || envelope.data.id !== id) throw new RpcError("bad_reply", "bad envelope");
    if (envelope.data.error) throw new RpcError(envelope.data.error.code, envelope.data.error.message ?? "");
    const result = schema.safeParse(envelope.data.result);
    if (!result.success) throw new RpcError("bad_reply", method + " result failed its schema");
    return result.data;
  }

  return {
    getHealth: (signal) => call("getHealth", undefined, healthSchema, signal),
    getEvents: (query, signal) => {
      const params: Record<string, unknown> = {
        filters: [{ type: "contract", contractIds: [...query.contractIds] }],
        pagination: query.cursor === undefined ? { limit: query.limit } : { cursor: query.cursor, limit: query.limit },
      };
      if (query.cursor === undefined) params.startLedger = query.startLedger;
      return call("getEvents", params, eventsSchema, signal);
    },
    simulateTransaction: (txBase64, authMode = "enforce", signal) =>
      call("simulateTransaction", { transaction: txBase64, authMode }, simulationSchema, signal),
    getLedgerEntries: async (keys, signal) => {
      if (keys.length === 0 || keys.length > MAX_LEDGER_KEYS) throw new RangeError("getLedgerEntries takes 1 to 200 keys");
      return call("getLedgerEntries", { keys: [...keys] }, ledgerEntriesSchema, signal);
    },
  };
}

import { xdr } from "@stellar/stellar-sdk";
import type { Config } from "../config.ts";
import { errorResponse, json } from "../http.ts";
import type { Logger } from "../log.ts";
import { RpcError, type RpcClient } from "../rpc.ts";
import { canonicalAccountId, canonicalContractId } from "../stellar.ts";
import { coverageOf, ingestedFrom, ingestedThrough, isComplete, type Coverage } from "./coverage.ts";
import {
  claimIngestSlot,
  eventsForAccount,
  eventsForCompany,
  eventsForContract,
  latestCheckpoint,
  readCoverage,
  type Db,
  type Position,
  type StoredEvent,
} from "./db.ts";
import { ingestOnce } from "./ingest.ts";
import { scValToPlainJson } from "./scval-json.ts";

/*
 * Read API over the archive, shaped so the confidential SDK's clients work
 * against it unchanged:
 *
 *   GET /v1/health
 *   GET /v1/tokens/{contract}/accounts/{account}/events      IndexerV1Client (INDEXER.md C2, C3)
 *   GET /v1/tokens/{contract}/accounts/{account}/checkpoint  IndexerV1Client (INDEXER.md C1)
 *   GET /v1/payroll/{contract}/companies/{companyId}/events  our payroll events
 *   GET /v1/payroll/{contract}/accounts/{account}/events     our payroll events that name a worker
 *   GET /contracts/{contract}/events                         IndexerClient, the one hybridFetchEvents takes
 *
 * Every data reply carries `complete` and `ingested_through` (threat model
 * C17). `complete` is true only when the archive read every ledger of the
 * requested range in full and no gap touches it. /v1/health answers 503
 * while its alarm is raised: a permanent gap, or no successful ingest for
 * 48 hours. Its ingested_from is 1 only when the archive proved it began
 * before our token existed; otherwise it is the first ledger the archive
 * read, and nothing earlier is ever reported complete.
 *
 * Every parameter is checked before anything else runs (C24): contract ids
 * must equal our configured ids after the shared address parser, accounts
 * must parse as G or C addresses, cursors must be our own format, page sizes
 * are 1 to 200, and anything else is a 400. Queries are parameterized and run
 * on the read-only API connection. Only a valid request triggers the bounded
 * catch-up, which uses the ingest connection and config values only.
 */

export interface ArchiveContext {
  cfg: Config;
  db: { ingest: Db; api: Db };
  rpc: RpcClient;
  log: Logger;
  /** The path prefix this handler is mounted under, for example "/api/archive". */
  basePath?: string;
  /** Overrides ARCHIVE_START_LEDGER for the first ingest of an empty archive (see IngestOptions.startLedger). */
  archiveStartLedger?: number;
  now?: () => Date;
  catchUpDeadlineMs?: number;
  catchUpIntervalMs?: number;
}

export const CATCH_UP_DEADLINE_MS = 2_000;
const CATCH_UP_INTERVAL_MS = 5_000;
export const MAX_PAGE_SIZE = 200;
const MAX_URL_LENGTH = 2_048;
const MAX_TYPES = 16;
const SECONDS_PER_LEDGER = 5;
/** The health alarm fires well inside RPC's 7-day window: after 48 hours without a successful pass. */
const STALE_AFTER_MS = 48 * 3_600_000;
const STALE_AFTER_LEDGERS = (48 * 3_600) / SECONDS_PER_LEDGER;
/**
 * INDEXER.md section 3.2: the owner-initiated, proof-carrying events that
 * publish the spendable balance. The owner is topic 1 in each.
 */
const CHECKPOINT_EVENTS = ["withdraw", "transfer", "set_spender", "revoke_spender"] as const;

const CORS = { "access-control-allow-origin": "*" };

class BadRequest extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * GET handler for the archive routes above. Never throws; failures become a
 * response with one of our own error codes.
 */
export async function archiveHandler(req: Request, ctx: ArchiveContext): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" },
    });
  }
  if (req.method !== "GET") return errorResponse(405, "method_not_allowed", { ...CORS, allow: "GET, OPTIONS" });
  if (req.url.length > MAX_URL_LENGTH) return errorResponse(400, "request_too_long", CORS);

  try {
    const url = new URL(req.url);
    const route = matchRoute(url.pathname, ctx.basePath ?? "");
    if (route === null) return errorResponse(404, "not_found", CORS);
    const answer = route(ctx, readQuery(url.searchParams));
    await catchUp(ctx);
    const coverage = coverageOf(await readCoverage(ctx.db.api));
    const reply = await answer(coverage);
    return json(reply.body, reply.status, CORS);
  } catch (err) {
    if (err instanceof BadRequest) return errorResponse(400, err.code, CORS);
    ctx.log.warn("archive_internal_error", { error: err instanceof Error ? err.name : "unknown" });
    return errorResponse(500, "internal_error", CORS);
  }
}

type Reply = { status: number; body: unknown };
type Answer = (coverage: Coverage) => Promise<Reply>;
type Route = (ctx: ArchiveContext, query: Query) => Answer;

function matchRoute(pathname: string, basePath: string): Route | null {
  if (basePath && !pathname.startsWith(basePath + "/")) return null;
  const parts = pathname.slice(basePath.length).replace(/\/$/, "").split("/").slice(1);
  if (parts.length === 2 && parts[0] === "v1" && parts[1] === "health") return health;
  if (parts.length === 6 && parts[0] === "v1" && parts[1] === "tokens" && parts[3] === "accounts") {
    const [contract, account] = [parts[2]!, parts[4]!];
    if (parts[5] === "events") return (ctx, q) => accountEvents(ctx, q, contract, account);
    if (parts[5] === "checkpoint") return (ctx, q) => checkpoint(ctx, q, contract, account);
  }
  if (parts.length === 6 && parts[0] === "v1" && parts[1] === "payroll" && parts[3] === "companies" && parts[5] === "events") {
    const [contract, company] = [parts[2]!, parts[4]!];
    return (ctx, q) => companyEvents(ctx, q, contract, company);
  }
  if (parts.length === 6 && parts[0] === "v1" && parts[1] === "payroll" && parts[3] === "accounts" && parts[5] === "events") {
    const [contract, account] = [parts[2]!, parts[4]!];
    return (ctx, q) => payrollAccountEvents(ctx, q, contract, account);
  }
  if (parts.length === 3 && parts[0] === "contracts" && parts[2] === "events") {
    const contract = parts[1]!;
    return (ctx, q) => contractStream(ctx, q, contract);
  }
  return null;
}

/** Brings the archive up to the RPC tip within the deadline. A failure is logged and the reply is served from what is held. */
async function catchUp(ctx: ArchiveContext): Promise<void> {
  const now = ctx.now?.() ?? new Date();
  try {
    if (!(await claimIngestSlot(ctx.db.ingest, now, ctx.catchUpIntervalMs ?? CATCH_UP_INTERVAL_MS))) return;
    await ingestOnce(ctx.db.ingest, ctx.rpc, ctx.cfg, {
      deadlineMs: ctx.catchUpDeadlineMs ?? CATCH_UP_DEADLINE_MS,
      log: ctx.log,
      ...(ctx.archiveStartLedger === undefined ? {} : { startLedger: ctx.archiveStartLedger }),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
  } catch (err) {
    ctx.log.warn("archive_catch_up_failed", {
      error: err instanceof Error ? err.name : "unknown",
      ...(err instanceof RpcError ? { rpcCode: err.code } : {}),
    });
  }
}

class Query {
  private readonly params: URLSearchParams;
  constructor(params: URLSearchParams) {
    this.params = params;
  }
  /** A parameter given twice is ambiguous, so it is refused rather than guessed. */
  get(name: string): string | null {
    const values = this.params.getAll(name);
    if (values.length > 1) throw new BadRequest("duplicate_parameter");
    return values[0] ?? null;
  }
}

const readQuery = (params: URLSearchParams) => new Query(params);

function ledgerParam(value: string | null, name: string): number | null {
  if (value === null) return null;
  if (!/^\d{1,10}$/.test(value) || Number(value) > 0xffffffff) throw new BadRequest("bad_" + name);
  return Number(value);
}

function limitParam(value: string | null): number {
  if (value === null) return MAX_PAGE_SIZE;
  if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE_SIZE) throw new BadRequest("bad_limit");
  return Number(value);
}

/** Our cursor: ledger-txIndex-opIndex-eventIndex of the last event returned. */
function cursorParam(value: string | null): Position | null {
  if (value === null) return null;
  const m = value.length <= 40 ? /^(\d{1,10})-(\d{1,7})-(\d{1,4})-(\d{1,10})$/.exec(value) : null;
  if (!m) throw new BadRequest("bad_cursor");
  const [ledger, txIndex, opIndex, eventIndex] = m.slice(1).map(Number) as [number, number, number, number];
  if (ledger < 1 || ledger > 0xffffffff || txIndex > 0xfffff || opIndex > 0xfff || eventIndex > 0xffffffff) {
    throw new BadRequest("bad_cursor");
  }
  return { ledger, txIndex, opIndex, eventIndex };
}

function cursorOf(e: StoredEvent): string {
  return [e.ledger, e.txIndex, e.opIndex, e.eventIndex].join("-");
}

function typesParam(value: string | null): string[] | null {
  if (value === null) return null;
  const types = value.split(",");
  if (types.length > MAX_TYPES || !types.every((t) => /^[A-Za-z0-9_]{1,32}$/.test(t))) throw new BadRequest("bad_types");
  return types;
}

function contractParam(value: string, expected: string): string {
  if (canonicalContractId(value) !== expected) throw new BadRequest("unknown_contract");
  return expected;
}

function accountParam(value: string): string {
  const account = canonicalAccountId(value);
  if (account === null) throw new BadRequest("bad_account");
  return account;
}

/** Company ids are unsigned 64-bit integers in plain decimal, one spelling only. */
function companyParam(value: string): string {
  if (!/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 0xffffffffffffffffn) throw new BadRequest("bad_company");
  return value;
}

interface LedgerRange {
  from: number;
  /** null: up to the newest ledger the archive has seen when it answers. */
  to: number | null;
}

/** Ledger 0 means "from the beginning". There is no ledger 0, so raising it to 1 cannot hide a gap. */
function rangeParams(q: Query, fromName: string, toName: string | null): LedgerRange {
  const from = Math.max(ledgerParam(q.get(fromName), fromName) ?? 1, 1);
  const to = toName === null ? null : ledgerParam(q.get(toName), toName);
  if (to !== null && to < from) throw new BadRequest("bad_range");
  return { from, to };
}

const endOf = (range: LedgerRange, c: Coverage): number => range.to ?? Math.max(c.latestLedger, range.from);

function v1Row(e: StoredEvent) {
  return {
    ledger_seq: e.ledger,
    tx_hash: e.txHash,
    tx_application_order: e.txIndex,
    operation_index: e.opIndex,
    event_index: e.eventIndex,
    ledger_close_time: e.ledgerClosedAt.toISOString(),
    contract_id: e.contractId,
    topics_xdr: e.topicsXdr,
    data_xdr: e.valueXdr,
  };
}

/** Splits one extra row off the end: its presence is how we know there is a next page. */
function page(rows: StoredEvent[], limit: number) {
  const events = rows.slice(0, limit);
  return { events, cursor: rows.length > limit ? cursorOf(events[events.length - 1]!) : null };
}

const health: Route = (ctx) => async (c) => {
  const now = ctx.now?.() ?? new Date();
  const through = ingestedThrough(c);
  const latest = Math.max(c.latestLedger, through);
  const reasons: string[] = [];
  if (c.gaps.length > 0) reasons.push("permanent_gap");
  const stale =
    c.lastIngestAt === null || now.getTime() - c.lastIngestAt.getTime() > STALE_AFTER_MS || latest - through > STALE_AFTER_LEDGERS;
  if (stale) reasons.push("stale");
  const from = ingestedFrom(c);
  // The status code is the alarm a person sees: an uptime check or a
  // scheduled job reads it without parsing the body.
  return {
    status: reasons.length > 0 ? 503 : 200,
    body: {
      latest_ledger: latest,
      ingested_through: through,
      ingested_from: from,
      lag_seconds: (latest - through) * SECONDS_PER_LEDGER,
      complete: through > 0 && isComplete(c, from, latest),
      alarm: reasons.length > 0,
      alarm_reasons: reasons,
      gaps: c.gaps.slice(0, 50).map((g) => ({
        from_ledger: g.fromLedger,
        to_ledger: g.toLedger,
        detected_at: g.detectedAt.toISOString(),
      })),
      last_ingest_at: c.lastIngestAt?.toISOString() ?? null,
    },
  };
};

function accountEvents(ctx: ArchiveContext, q: Query, contractSeg: string, accountSeg: string): Answer {
  const contractId = contractParam(contractSeg, ctx.cfg.TOKEN_CONTRACT_ID);
  const account = accountParam(accountSeg);
  const types = typesParam(q.get("types"));
  const after = cursorParam(q.get("cursor"));
  const limit = limitParam(q.get("limit"));
  const range = rangeParams(q, "from_ledger", "to_ledger");
  return async (c) => {
    const to = endOf(range, c);
    const rows = await eventsForAccount(ctx.db.api, { contractId, account, fromLedger: range.from, toLedger: to, types, after, limit: limit + 1 });
    const { events, cursor } = page(rows, limit);
    return {
      status: 200,
      body: { events: events.map(v1Row), cursor, complete: isComplete(c, range.from, to), ingested_through: ingestedThrough(c) },
    };
  };
}

function checkpoint(ctx: ArchiveContext, q: Query, contractSeg: string, accountSeg: string): Answer {
  const contractId = contractParam(contractSeg, ctx.cfg.TOKEN_CONTRACT_ID);
  const account = accountParam(accountSeg);
  const atGiven = ledgerParam(q.get("at_ledger"), "at_ledger");
  return async (c) => {
    const atLedger = atGiven ?? ingestedThrough(c);
    const event = await latestCheckpoint(ctx.db.api, { contractId, account, atLedger, eventNames: CHECKPOINT_EVENTS });
    return {
      status: 200,
      body: { event: event ? v1Row(event) : null, complete: isComplete(c, 1, atLedger), ingested_through: ingestedThrough(c) },
    };
  };
}

function companyEvents(ctx: ArchiveContext, q: Query, contractSeg: string, companySeg: string): Answer {
  const contractId = contractParam(contractSeg, ctx.cfg.PAYROLL_CONTRACT_ID);
  const companyId = companyParam(companySeg);
  const after = cursorParam(q.get("cursor"));
  const limit = limitParam(q.get("limit"));
  const range = rangeParams(q, "from_ledger", null);
  return async (c) => {
    const to = endOf(range, c);
    const rows = await eventsForCompany(ctx.db.api, { contractId, companyId, fromLedger: range.from, toLedger: to, after, limit: limit + 1 });
    const { events, cursor } = page(rows, limit);
    return {
      status: 200,
      body: { events: events.map(v1Row), cursor, complete: isComplete(c, range.from, to), ingested_through: ingestedThrough(c) },
    };
  };
}

/**
 * Our payroll events with `account` among their topic addresses (ingest files
 * every topic address under accounts): its invites, joins, removals and
 * payslips, so a worker on a new device can find the companies they joined.
 * The same parameters and reply as companyEvents.
 */
function payrollAccountEvents(ctx: ArchiveContext, q: Query, contractSeg: string, accountSeg: string): Answer {
  const contractId = contractParam(contractSeg, ctx.cfg.PAYROLL_CONTRACT_ID);
  const account = accountParam(accountSeg);
  const after = cursorParam(q.get("cursor"));
  const limit = limitParam(q.get("limit"));
  const range = rangeParams(q, "from_ledger", null);
  return async (c) => {
    const to = endOf(range, c);
    const rows = await eventsForAccount(ctx.db.api, { contractId, account, fromLedger: range.from, toLedger: to, types: null, after, limit: limit + 1 });
    const { events, cursor } = page(rows, limit);
    return {
      status: 200,
      body: { events: events.map(v1Row), cursor, complete: isComplete(c, range.from, to), ingested_through: ingestedThrough(c) },
    };
  };
}

/**
 * The per-contract stream the SDK's IndexerClient reads. That client has no
 * completeness check of its own, so this route refuses (409) any range the
 * archive cannot vouch for instead of returning part of it. hybridFetchEvents
 * then falls back to RPC alone, and the wallet's on-chain balance check (C16)
 * reports the history as incomplete.
 */
function contractStream(ctx: ArchiveContext, q: Query, contractSeg: string): Answer {
  const contractId = contractParam(contractSeg, ctx.cfg.TOKEN_CONTRACT_ID);
  const after = cursorParam(q.get("cursor"));
  const limit = limitParam(q.get("limit"));
  const range = rangeParams(q, "startLedger", "endLedger");
  return async (c) => {
    const to = endOf(range, c);
    // A continuation page only needs to vouch for what is left of the range.
    const checkFrom = after ? Math.max(range.from, after.ledger) : range.from;
    if (!isComplete(c, checkFrom, to)) {
      return { status: 409, body: { error: "history_incomplete", complete: false, ingested_through: ingestedThrough(c) } };
    }
    const rows = await eventsForContract(ctx.db.api, { contractId, fromLedger: range.from, toLedger: to, after, limit: limit + 1 });
    const { events, cursor } = page(rows, limit);
    return {
      status: 200,
      body: {
        latestLedger: c.latestLedger,
        cursor,
        events: events.map((e) => ({
          id: [e.ledger, e.txHash, "op", e.opIndex, "event", e.eventIndex].join("-"),
          ledger: e.ledger,
          txHash: e.txHash,
          topic: e.topicsXdr.map((t) => scValToPlainJson(xdr.ScVal.fromXDR(t, "base64"))),
          value: scValToPlainJson(xdr.ScVal.fromXDR(e.valueXdr, "base64")),
        })),
        complete: true,
        ingested_through: ingestedThrough(c),
      },
    };
  };
}

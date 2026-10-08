import { z } from "zod";
import {
  claimAuthEntries,
  claimRelay,
  countAuthoriserRelays,
  countSponsorRequest,
  forgetExpiredRelays,
  holdRelay,
  recordRelay,
  releaseAuthoriserRelays,
  releaseDailyFee,
  releaseRelay,
  reserveDailyFee,
  type Db,
} from "../archive/db.ts";
import type { Config } from "../config.ts";
import { OutboundError, errorResponse, fetchWithTimeout, json, parseJsonBytes, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import type { RpcClient } from "../rpc.ts";
import { clientBucket, ipTag } from "./client-ip.ts";
import { authExpiryLedger, requestDigest, signedEntryKeys, simulate, validateSponsorRequest, type SimulateFn } from "./validate.ts";

export interface SponsorContext {
  cfg: Config;
  /** A connection that may write (DATABASE_URL_INGEST): the counters live here. */
  db: Db;
  rpc: Pick<RpcClient, "simulateTransaction" | "getLedgerEntries">;
  log: Logger;
  simulate?: SimulateFn;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Tests shorten the relay timeout; production keeps the 10 s default. */
  relayTimeoutMs?: number;
}

export type SponsorStatusContext = Pick<SponsorContext, "cfg" | "db" | "log" | "now" | "fetchImpl" | "relayTimeoutMs">;

/**
 * How long a claim stands before it is held to its auth entries' expiry
 * ledger: long enough for simulation and the relay call, after which a claim
 * left by a crash no longer blocks the body. An envelope whose entries carry
 * no expiry is never held, so this is its whole duplicate window.
 */
export const CLAIM_WINDOW_MS = 120_000;
const MAX_RELAY_REPLY_BYTES = 64 * 1024;
/** One format for Channels transaction ids, used both for what we accept and for what we pass on. */
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Channels' reply is input to us and, once relayed, to the browser. Only the
// fields we return leave, each in its documented format.
const channelsReply = z.object({
  success: z.literal(true),
  data: z.object({
    transactionId: z.string().regex(TRANSACTION_ID),
    hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    status: z.enum(["pending", "sent", "submitted", "confirmed", "failed", "expired"]),
  }),
});
type ChannelsData = z.infer<typeof channelsReply>["data"];

const hourStartOf = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

/**
 * POST /api/sponsor: pays the network fee for a worker's own action.
 *
 * Order: trusted client IP present, the per-IP hourly limit, JSON body under
 * 64 KiB, the structural sponsor rule, the duplicate check, simulation, the
 * per-address daily limit, the daily fee budget, then the relay. Every
 * parsing step, every signature check and every outbound call sits behind
 * the per-IP limit.
 *
 * Channels is asked not to wait for the ledger (skipWait), so the reply is
 * `{ transactionId, status }` at once; the caller polls the status route. A
 * duplicate body, sent any time until its auth entries expire, gets the
 * first relay's reply without a second relay, or 409 while the first is
 * still in flight or its outcome is unknown. A different body carrying a
 * signed auth entry already claimed by another body is refused with 409
 * auth_entry_in_use until that entry expires. Refusals are `{ error: code }`.
 *
 * Logging: every refusal and failure carries its code and the caller's
 * salted IP tag (never the IP); every relay carries its transaction id and
 * hash and nothing derived from the IP, so no log line ties a caller to a
 * transaction. No secret and no request body is ever logged.
 */
export async function sponsorHandler(req: Request, ctx: SponsorContext): Promise<Response> {
  const { cfg, log } = ctx;
  const refuse = (status: number, code: string, tag?: string, headers: Record<string, string> = {}) => {
    log.info("sponsor_refused", tag === undefined ? { code } : { code, ipTag: tag });
    return errorResponse(status, code, headers);
  };

  if (req.method !== "POST") return refuse(405, "method_not_allowed", undefined, { allow: "POST" });
  const ip = clientBucket(req.headers.get(cfg.TRUSTED_IP_HEADER));
  if (ip === null) return refuse(400, "no_client_ip");
  const tag = ipTag(ip, cfg.LOG_SALT);

  try {
    const now = ctx.now?.() ?? new Date();
    // Counted before the body is read: a body we refuse costs its sender a
    // request like any other, so parsing and signature checks never run
    // unmetered.
    if (!(await countSponsorRequest(ctx.db, ip, hourStartOf(now), cfg.PER_IP_LIMIT_PER_HOUR))) {
      return refuse(429, "rate_limited", tag);
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
      return refuse(415, "unsupported_media_type", tag);
    }
    const body = await readJsonBody(req);
    if (!body.ok) return refuse(body.status, body.code, tag);
    const request = validateSponsorRequest(body.value, cfg);
    if (!request.ok) return refuse(400, request.code, tag);

    const digest = requestDigest(request);
    const claim = await claimRelay(ctx.db, digest, now, CLAIM_WINDOW_MS);
    if (!claim.claimed) {
      if (claim.transactionId !== null && claim.status !== null) {
        log.info("sponsor_duplicate", { transactionId: claim.transactionId });
        return json({ transactionId: claim.transactionId, status: claim.status });
      }
      return refuse(409, "duplicate_in_flight", tag);
    }
    if (!(await claimAuthEntries(ctx.db, signedEntryKeys(request), digest, claim.claimedAt, CLAIM_WINDOW_MS))) {
      await releaseRelay(ctx.db, digest, claim.claimedAt);
      return refuse(409, "auth_entry_in_use", tag);
    }

    const verdict = await (ctx.simulate ?? simulate)(cfg, request, ctx.rpc);
    if (!verdict.ok) {
      await releaseRelay(ctx.db, digest, claim.claimedAt);
      return refuse(verdict.code === "rpc_unavailable" ? 503 : 400, verdict.code, tag);
    }
    await forgetExpiredRelays(ctx.db, verdict.latestLedger);
    const day = now.toISOString().slice(0, 10);
    // Counted only once validation (the envelope signature) and enforce-mode
    // simulation (every auth entry) have proved each authoriser signed, so
    // nobody can use up another worker's relays by naming their address in
    // entries that do not verify.
    if (!(await countAuthoriserRelays(ctx.db, request.authorisers, day, cfg.PER_ADDRESS_LIMIT_PER_DAY))) {
      await releaseRelay(ctx.db, digest, claim.claimedAt);
      return refuse(429, "address_rate_limited", tag);
    }
    if (!(await reserveDailyFee(ctx.db, day, verdict.chargeStroops, cfg.DAILY_FEE_BUDGET_STROOPS))) {
      await releaseRelay(ctx.db, digest, claim.claimedAt);
      await releaseAuthoriserRelays(ctx.db, request.authorisers, day);
      return refuse(429, "daily_budget_spent", tag);
    }
    // Until its entries expire the body can still land, so a second copy
    // relayed while the first is pending would reach a ledger too and fail
    // there, with our fee.
    const lastUsableLedger = authExpiryLedger(request);
    if (lastUsableLedger !== null) await holdRelay(ctx.db, digest, claim.claimedAt, lastUsableLedger);

    const params =
      request.kind === "func"
        ? { func: request.func, auth: request.auth, skipWait: true }
        : { xdr: request.xdr, skipWait: true };
    const relayed = await callChannels(ctx, { params }, { ipTag: tag, kind: request.kind });
    if (!relayed.ok) {
      // Only a documented pre-submission refusal proves nothing was sent, so
      // only then do the claim, the reserved fee and the authorisers' daily
      // counts come back. A timeout, a 5xx, a garbled reply or any other 4xx
      // (ONCHAIN_FAILED is a 400) might hide a submitted transaction, so all
      // three stay.
      if (relayed.notSubmitted) {
        await releaseRelay(ctx.db, digest, claim.claimedAt);
        await releaseDailyFee(ctx.db, day, verdict.chargeStroops);
        await releaseAuthoriserRelays(ctx.db, request.authorisers, day);
      }
      return relayed.response;
    }
    const { transactionId, status, hash } = relayed.data;
    await recordRelay(ctx.db, digest, claim.claimedAt, transactionId, status);
    log.info("sponsor_relayed", {
      transactionId,
      status,
      hash,
      kind: request.kind,
      rootContract: request.rootContract,
      chargeStroops: verdict.chargeStroops,
    });
    return json({ transactionId, status });
  } catch (err) {
    log.warn("sponsor_internal_error", { ipTag: tag, error: err instanceof Error ? err.name : "unknown" });
    return errorResponse(500, "internal_error");
  }
}

/**
 * GET /api/sponsor/status?id=<transactionId>: asks Channels where a relayed
 * transaction is and replies `{ status, hash }` (hash is null until it is
 * submitted). The id must be in Channels' format and is passed on only as a
 * value inside the JSON body. Requests are limited per IP per hour at the
 * same rate as the POST, counted before the id is read and separately from
 * the POST, so polling cannot use up a worker's relays. Logged the same way as the POST: the salted IP tag on
 * refusals and failures, no IP-derived field next to the id and hash.
 */
export async function sponsorStatusHandler(req: Request, ctx: SponsorStatusContext): Promise<Response> {
  const { cfg, log } = ctx;
  const refuse = (status: number, code: string, tag?: string, headers: Record<string, string> = {}) => {
    log.info("sponsor_status_refused", tag === undefined ? { code } : { code, ipTag: tag });
    return errorResponse(status, code, headers);
  };

  if (req.method !== "GET") return refuse(405, "method_not_allowed", undefined, { allow: "GET" });
  const ip = clientBucket(req.headers.get(cfg.TRUSTED_IP_HEADER));
  if (ip === null) return refuse(400, "no_client_ip");
  const tag = ipTag(ip, cfg.LOG_SALT);

  try {
    const now = ctx.now?.() ?? new Date();
    // Counted before the id is read, like the relay route: a bad id costs
    // its sender a request too.
    if (!(await countSponsorRequest(ctx.db, "status " + ip, hourStartOf(now), cfg.PER_IP_LIMIT_PER_HOUR))) {
      return refuse(429, "rate_limited", tag);
    }
    if (req.url.length > 2_048) return refuse(400, "bad_id", tag);
    const ids = new URL(req.url).searchParams.getAll("id");
    const id = ids.length === 1 ? ids[0]! : "";
    if (!TRANSACTION_ID.test(id)) return refuse(400, "bad_id", tag);

    const answer = await callChannels(ctx, { params: { getTransaction: { transactionId: id } } }, { ipTag: tag, kind: "status" });
    if (!answer.ok) return answer.response;
    if (answer.data.transactionId !== id) {
      log.warn("sponsor_status_bad_reply", { ipTag: tag, reason: "transaction id mismatch" });
      return errorResponse(502, "relay_bad_reply");
    }
    log.info("sponsor_status", { transactionId: id, status: answer.data.status, hash: answer.data.hash });
    return json({ status: answer.data.status, hash: answer.data.hash });
  } catch (err) {
    log.warn("sponsor_internal_error", { ipTag: tag, error: err instanceof Error ? err.name : "unknown" });
    return errorResponse(500, "internal_error");
  }
}

type ChannelsResult = { ok: true; data: ChannelsData } | { ok: false; notSubmitted: boolean; response: Response };

/** `logFields` goes on failure lines only, which carry no transaction id or hash. */
async function callChannels(
  ctx: SponsorStatusContext,
  body: unknown,
  logFields: { ipTag: string; kind: string },
): Promise<ChannelsResult> {
  const { cfg, log } = ctx;
  let upstream;
  try {
    upstream = await fetchWithTimeout(
      cfg,
      "CHANNELS_URL",
      {
        method: "POST",
        headers: { authorization: "Bearer " + cfg.CHANNELS_API_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
        maxResponseBytes: MAX_RELAY_REPLY_BYTES,
        ...(ctx.relayTimeoutMs === undefined ? {} : { timeoutMs: ctx.relayTimeoutMs }),
      },
      ctx.fetchImpl,
    );
  } catch (err) {
    const failure = err instanceof OutboundError ? err.failure : "network";
    log.warn("sponsor_relay_failed", { failure, ...logFields });
    const response = failure === "timeout" ? errorResponse(504, "relay_timeout") : errorResponse(502, "relay_unavailable");
    return { ok: false, notSubmitted: false, response };
  }

  let payload: unknown;
  try {
    payload = parseJsonBytes(upstream.body);
  } catch {
    payload = undefined;
  }
  const reply = channelsReply.safeParse(payload);
  if (upstream.status >= 200 && upstream.status < 300 && reply.success) return { ok: true, data: reply.data.data };

  const envelope = payload as { success?: unknown; data?: { code?: unknown } } | null | undefined;
  const refused = upstream.status < 200 || upstream.status >= 300 || envelope?.success === false;
  const code = envelope?.data?.code;
  log.warn(refused ? "sponsor_relay_refused" : "sponsor_relay_bad_reply", {
    upstreamStatus: upstream.status,
    upstreamCode: typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "unknown",
    ...logFields,
  });
  return {
    ok: false,
    notSubmitted: provablyNotSubmitted(upstream.status, payload),
    response: errorResponse(502, refused ? "relay_refused" : "relay_bad_reply"),
  };
}

/**
 * The codes relayer-plugin-channels documents in the groups it lists before
 * "Submission" (README "Error Codes": Request Validation, Pool & Channel,
 * Simulation & Assembly, Fee Tracking); its source raises each of them
 * before the transaction is sent. Not here: ONCHAIN_FAILED, which the plugin
 * sends as a 400 after the transaction failed on chain with its fee spent,
 * and every other Submission code. A code missing from this list only keeps
 * a reservation that could have been returned.
 */
const PRE_SUBMISSION_CODES: ReadonlySet<string> = new Set([
  "INVALID_PARAMS",
  "INVALID_XDR",
  "INVALID_ENVELOPE_TYPE",
  "INVALID_UNSIGNED_XDR",
  "INVALID_TIME_BOUNDS",
  "TIMEBOUNDS_EXPIRED",
  "TIMEBOUNDS_TOO_FAR",
  "FEE_MISMATCH",
  "INVALID_OPERATION_SOURCE",
  "NO_CHANNELS_CONFIGURED",
  "POOL_CAPACITY",
  "RELAYER_UNAVAILABLE",
  "FAILED_TO_GET_SEQUENCE",
  "ACCOUNT_NOT_FOUND",
  "SIMULATION_FAILED",
  "SIMULATION_NETWORK_ERROR",
  "SIMULATION_RPC_FAILURE",
  "SIMULATION_SIGNED_AUTH_VALIDATION_FAILED",
  "AUTH_EXPIRY_TOO_SHORT",
  "ASSEMBLY_FAILED",
  "API_KEY_REQUIRED",
  "FEE_LIMIT_EXCEEDED",
]);

/**
 * True only for a 4xx plugin error (success false) whose code is a
 * documented pre-submission code and whose body names no transaction hash.
 * Everything else, a 4xx included, might follow a submission, so the claim,
 * the fee and the daily counts stay, as on a 5xx.
 */
function provablyNotSubmitted(status: number, payload: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const envelope = payload as { success?: unknown; data?: { code?: unknown } } | null | undefined;
  if (envelope?.success !== false) return false;
  const code = envelope.data?.code;
  if (typeof code !== "string" || !PRE_SUBMISSION_CODES.has(code)) return false;
  return !/[0-9a-fA-F]{64}/.test(JSON.stringify(payload));
}

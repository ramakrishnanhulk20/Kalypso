import { z } from "zod";
import { claimRelay, countSponsorRequest, recordRelay, releaseRelay, reserveDailyFee, type Db } from "../archive/db.ts";
import type { Config } from "../config.ts";
import { OutboundError, errorResponse, fetchWithTimeout, json, parseJsonBytes, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import type { RpcClient } from "../rpc.ts";
import { clientBucket, ipTag } from "./client-ip.ts";
import { requestDigest, simulate, validateSponsorRequest, type SimulateFn } from "./validate.ts";

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

/** A second copy of the same body inside this window gets the first transaction id back. */
export const DEDUPE_WINDOW_MS = 120_000;
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
 * Order: trusted client IP present, JSON body under 64 KiB, the structural
 * sponsor rule, the per-IP hourly limit, the 120 s duplicate check,
 * simulation, the daily fee budget, then the relay. Everything that costs an
 * outbound call sits behind the per-IP limit.
 *
 * Channels is asked not to wait for the ledger (skipWait), so the reply is
 * `{ transactionId, status }` at once; the caller polls the status route. A
 * duplicate body gets the first relay's reply without a second relay, or 409
 * while the first is still in flight. Refusals are `{ error: code }`.
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
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return refuse(415, "unsupported_media_type", tag);
  }

  try {
    const body = await readJsonBody(req);
    if (!body.ok) return refuse(body.status, body.code, tag);
    const request = validateSponsorRequest(body.value, cfg);
    if (!request.ok) return refuse(400, request.code, tag);

    const now = ctx.now?.() ?? new Date();
    if (!(await countSponsorRequest(ctx.db, ip, hourStartOf(now), cfg.PER_IP_LIMIT_PER_HOUR))) {
      return refuse(429, "rate_limited", tag);
    }

    const digest = requestDigest(request);
    const claim = await claimRelay(ctx.db, digest, now, DEDUPE_WINDOW_MS);
    if (!claim.claimed) {
      if (claim.transactionId !== null && claim.status !== null) {
        log.info("sponsor_duplicate", { transactionId: claim.transactionId });
        return json({ transactionId: claim.transactionId, status: claim.status });
      }
      return refuse(409, "duplicate_in_flight", tag);
    }

    const verdict = await (ctx.simulate ?? simulate)(cfg, request, ctx.rpc);
    if (!verdict.ok) {
      await releaseRelay(ctx.db, digest, claim.claimedAt);
      return refuse(verdict.code === "rpc_unavailable" ? 503 : 400, verdict.code, tag);
    }
    if (!(await reserveDailyFee(ctx.db, now.toISOString().slice(0, 10), verdict.chargeStroops, cfg.DAILY_FEE_BUDGET_STROOPS))) {
      await releaseRelay(ctx.db, digest, claim.claimedAt);
      return refuse(429, "daily_budget_spent", tag);
    }

    const params =
      request.kind === "func"
        ? { func: request.func, auth: request.auth, skipWait: true }
        : { xdr: request.xdr, skipWait: true };
    const relayed = await callChannels(ctx, { params }, { ipTag: tag, kind: request.kind });
    if (!relayed.ok) {
      // Only a 4xx refusal proves nothing was submitted. A timeout, a 5xx or
      // a garbled reply might hide a submitted transaction, so the claim stays.
      if (relayed.notSubmitted) await releaseRelay(ctx.db, digest, claim.claimedAt);
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
 * same rate as the POST, counted separately so polling cannot use up a
 * worker's relays. Logged the same way as the POST: the salted IP tag on
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
  if (req.url.length > 2_048) return refuse(400, "bad_id", tag);

  try {
    const ids = new URL(req.url).searchParams.getAll("id");
    const id = ids.length === 1 ? ids[0]! : "";
    if (!TRANSACTION_ID.test(id)) return refuse(400, "bad_id", tag);

    const now = ctx.now?.() ?? new Date();
    if (!(await countSponsorRequest(ctx.db, "status " + ip, hourStartOf(now), cfg.PER_IP_LIMIT_PER_HOUR))) {
      return refuse(429, "rate_limited", tag);
    }

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
    notSubmitted: upstream.status >= 400 && upstream.status < 500,
    response: errorResponse(502, refused ? "relay_refused" : "relay_bad_reply"),
  };
}

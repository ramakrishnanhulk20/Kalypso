import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import { errorResponse, json } from "../http.ts";
import type { Logger } from "../log.ts";
import { RpcError, type RpcClient } from "../rpc.ts";
import type { Db } from "./db.ts";
import { ingestOnce } from "./ingest.ts";

/** Stops starting new RPC calls after this, so the pass commits and replies before the scheduler gives up on it. */
export const INGEST_CRON_DEADLINE_MS = 25_000;

export interface IngestCronContext {
  cfg: Config;
  /** The connection that may write (DATABASE_URL_INGEST). */
  db: Db;
  rpc: RpcClient;
  log: Logger;
  /** Overrides ARCHIVE_START_LEDGER for the first ingest of an empty archive (see IngestOptions.startLedger). */
  archiveStartLedger?: number;
  now?: () => Date;
  /** Tests shorten the deadline; production keeps INGEST_CRON_DEADLINE_MS. */
  deadlineMs?: number;
}

/**
 * POST /api/archive/ingest: one scheduled ingest pass (threat model C17).
 *
 * The archive must keep reading even when nobody visits, or RPC's 7-day
 * window closes over unread ledgers and the gap locks workers' funds. A
 * scheduler (Vercel Cron, or a scheduled GitHub job) calls this route.
 *
 * Requires `Authorization: Bearer <CRON_SECRET>`, compared in constant time.
 * A missing or wrong header is 401 `{ error: "unauthorized" }` and nothing
 * runs. With the right one it runs ingestOnce with a 25 s deadline and
 * replies 200 with what the pass did; a pass that fails is logged and
 * replies 503, so the scheduler's run shows as failed. Request bodies are
 * never read.
 */
export async function ingestCronHandler(req: Request, ctx: IngestCronContext): Promise<Response> {
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", { allow: "POST" });
  if (!isScheduler(req.headers.get("authorization"), ctx.cfg.CRON_SECRET)) {
    ctx.log.warn("archive_cron_refused", { code: "unauthorized" });
    return errorResponse(401, "unauthorized");
  }
  try {
    const result = await ingestOnce(ctx.db, ctx.rpc, ctx.cfg, {
      deadlineMs: ctx.deadlineMs ?? INGEST_CRON_DEADLINE_MS,
      log: ctx.log,
      ...(ctx.archiveStartLedger === undefined ? {} : { startLedger: ctx.archiveStartLedger }),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    const summary = {
      ingested_through: result.ingestedThrough,
      events_stored: result.eventsStored,
      pages: result.pages,
      caught_up: result.caughtUp,
      gaps: result.gaps.length,
    };
    ctx.log.info("archive_cron_ingested", summary);
    return json(summary);
  } catch (err) {
    ctx.log.warn("archive_cron_failed", {
      error: err instanceof Error ? err.name : "unknown",
      ...(err instanceof RpcError ? { rpcCode: err.code } : {}),
    });
    return errorResponse(503, "ingest_failed");
  }
}

/**
 * Both sides are hashed before the comparison, so it takes the same time
 * whatever was sent, its length included.
 */
function isScheduler(header: string | null, secret: string): boolean {
  const sent = createHash("sha256").update(header ?? "").digest();
  const expected = createHash("sha256").update("Bearer " + secret).digest();
  return timingSafeEqual(sent, expected);
}

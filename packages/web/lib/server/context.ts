import {
  connectPostgres,
  createLogger,
  createRpcClient,
  secretValues,
  type ArchiveContext,
  type Config,
  type Db,
  type IngestCronContext,
  type SponsorContext,
  type SponsorStatusContext,
  type WalletBirthLookupContext,
  type WalletBirthRecordContext,
} from "@kalypso/server";
import { serverConfig } from "./config";

/** The handler context each server route runs with. */
export interface ServerContexts {
  sponsor: SponsorContext;
  sponsorStatus: SponsorStatusContext;
  sponsorBirth: WalletBirthRecordContext;
  sponsorBirthLookup: WalletBirthLookupContext;
  archive: ArchiveContext;
  ingest: IngestCronContext;
}

export type ServerRoute = keyof ServerContexts;

/** The archive handler matches its /v1 paths below this prefix. */
export const ARCHIVE_BASE_PATH = "/api/archive";

let wiring: Promise<ServerContexts> | undefined;
let wired: ServerContexts | undefined;

// Carries route names and variable names only, so it scrubs nothing.
const bootLog = createLogger([]);

/**
 * One connection pool per role, opened lazily by the driver on first query.
 * The archive reads through the read-only API role, and the session is
 * read-only on top of that; every write (ingest, the archive's catch-up, the
 * sponsor's counters) goes through the ingest role.
 */
async function databases(cfg: Config, memoryDb: boolean): Promise<{ ingest: Db; api: Db }> {
  // Literal process.env.NODE_ENV on purpose: a production build folds the
  // test to false and drops the dynamic import, and PGlite with it.
  if (process.env.NODE_ENV === "development" && memoryDb) {
    const { devMemoryDb } = await import("./dev-memory");
    const db = await devMemoryDb();
    return { ingest: db, api: db };
  }
  return {
    ingest: connectPostgres(cfg.DATABASE_URL_INGEST),
    api: connectPostgres(cfg.DATABASE_URL_API, { readOnly: true }),
  };
}

async function wire(cfg: Config, memoryDb: boolean): Promise<ServerContexts> {
  const log = createLogger(secretValues(cfg));
  const rpc = createRpcClient(cfg);
  const { ingest, api } = await databases(cfg, memoryDb);
  return {
    sponsor: { cfg, db: ingest, rpc, log },
    sponsorStatus: { cfg, db: ingest, log },
    sponsorBirth: { cfg, db: ingest, rpc, log },
    sponsorBirthLookup: { cfg, db: ingest, log },
    archive: { cfg, db: { ingest, api }, rpc, log, basePath: ARCHIVE_BASE_PATH },
    ingest: { cfg, db: ingest, rpc, log },
  };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// The archive handler sends this on every reply, so another site's wallet
// can read our refusal too instead of seeing a network error.
const ARCHIVE_CORS = { "access-control-allow-origin": "*" };

function refusal(route: ServerRoute, status: number, code: string): Response {
  const headers = route === "archive" ? { ...JSON_HEADERS, ...ARCHIVE_CORS } : JSON_HEADERS;
  return new Response(JSON.stringify({ error: code }), { status, headers });
}

function noStore(res: Response): Response {
  if (res.headers.get("cache-control") === "no-store") return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Runs one server route with its handler context.
 *
 * With any server variable missing or invalid it answers 503
 * `{ error: "not_configured" }` and logs one line naming the variables,
 * never their values, so the site's pages keep working with no server set
 * up (local dev, previews). Anything the handler throws becomes 500
 * `{ error: "internal_error" }` with only the error's class name logged.
 * Every reply carries cache-control: no-store.
 */
export async function serve<R extends ServerRoute>(
  route: R,
  handle: (ctx: ServerContexts[R]) => Promise<Response>,
): Promise<Response> {
  const config = serverConfig();
  if (!config.ok) {
    bootLog.warn("server_not_configured", { route, missing: config.missing, invalid: config.invalid });
    return refusal(route, 503, "not_configured");
  }
  try {
    // A failed wiring is forgotten, so the next request tries again.
    wiring ??= wire(config.cfg, config.memoryDb).then(
      (ctx) => (wired = ctx),
      (err: unknown) => {
        wiring = undefined;
        throw err;
      },
    );
    return noStore(await handle((await wiring)[route]));
  } catch (err) {
    (wired?.sponsor.log ?? bootLog).warn("server_route_failed", { route, error: err instanceof Error ? err.name : "unknown" });
    return refusal(route, 500, "internal_error");
  }
}

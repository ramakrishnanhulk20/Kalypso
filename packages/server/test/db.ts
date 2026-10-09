import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll } from "vitest";
import { applySchema, pgliteDb, postgresDb, postgresOptions, type Db } from "../src/archive/db.ts";

// KALYPSO_TEST_DB=wire sends every query over a real socket through postgres.js with production's
// options, the way the deploy reaches Neon. PGlite called directly skips the driver's own parameter
// typing and serialising, so a query can pass here and fail in production without this mode.
const WIRE = process.env.KALYPSO_TEST_DB === "wire";

const closers: Array<() => Promise<void>> = [];
// Registered while the test file imports this module, so it runs once at the end of that file.
if (WIRE) {
  afterAll(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });
}

export async function freshDb(): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  const db = WIRE ? await wireDb(pg) : pgliteDb(pg);
  await applySchema(db);
  return { pg, db };
}

async function wireDb(pg: PGlite): Promise<Db> {
  // One PGlite is one database session, so the pool is one connection: two would share a
  // transaction. The server allows two so a reconnect after the driver's idle timeout is not
  // refused while the old socket's close is still being processed.
  const server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 2 });
  await server.start();
  closers.push(async () => {
    await server.stop();
    await pg.close();
  });
  const sql = postgres("postgres://postgres@" + server.getServerConn() + "/postgres", { ...postgresOptions(), max: 1 });
  closers.push(() => sql.end({ timeout: 5 }));
  return postgresDb(sql);
}

export async function clearTables(db: Db, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    // Table names come from the test's own constant list, never from input.
    await db.exec("truncate table " + table);
  }
}

/** Empties the archive and forgets where it started, so one database can serve many tests. */
export async function resetArchive(db: Db): Promise<void> {
  await clearTables(db, ["events", "ingested_ranges", "gaps"]);
  await db.exec(
    "update archive_state set start_ledger = null, covers_from_genesis = false, start_check_pending = false, latest_ledger = null, " +
      "rpc_oldest_ledger = null, last_ingest_at = null, ingest_started_at = null",
  );
}

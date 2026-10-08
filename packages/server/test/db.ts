import { PGlite } from "@electric-sql/pglite";
import { applySchema, pgliteDb, type Db } from "../src/archive/db.ts";

export async function freshDb(): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  const db = pgliteDb(pg);
  await applySchema(db);
  return { pg, db };
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

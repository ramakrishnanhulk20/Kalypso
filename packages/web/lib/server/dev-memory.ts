import { PGlite } from "@electric-sql/pglite";
import { applySchema, pgliteDb, type Db } from "@kalypso/server";

/*
 * Development only. Reached solely through a dynamic import behind a literal
 * process.env.NODE_ENV === "development" test (databases() in context.ts),
 * which a production build folds to false and drops, so neither this file
 * nor PGlite is in a deployed site.
 */

// Kept on globalThis because a dev reload re-runs this module, and the
// archive and the sponsor counters must last for the life of the dev server.
const KEY: unique symbol = Symbol.for("kalypso.devMemoryDb");
const holder = globalThis as { [KEY]?: Promise<Db> };

/**
 * One in-memory Postgres (PGlite, as the server package's tests use) with
 * the archive schema applied, shared by the ingest and the API side. Unlike
 * production, the API side is not read-only: PGlite is a single session with
 * no read-only role to read through, and the server's test helper adds none.
 */
export function devMemoryDb(): Promise<Db> {
  holder[KEY] ??= open().catch((err: unknown) => {
    delete holder[KEY];
    throw err;
  });
  return holder[KEY];
}

async function open(): Promise<Db> {
  const db = pgliteDb(new PGlite());
  await applySchema(db);
  console.log("archive and sponsor are using an in-memory database (development only)");
  return db;
}

// Creates the archive and sponsor tables in the database DATABASE_URL_INGEST
// points at, then lists them. Safe to run again: every statement is
// "if not exists". Run it once a database exists, before the deploy that sets
// the server variables:
//
//   DATABASE_URL_INGEST='postgresql://...' node scripts/apply-archive-schema.mjs
//
// The read-only role for DATABASE_URL_API comes after, by hand, with the SQL
// in packages/server/src/archive/schema.sql, because it needs the tables.
// Nothing here prints the URL or its password.
import { applySchema, connectPostgres, createLogger } from "@kalypso/server";

const TABLES = ["events", "ingested_ranges", "gaps", "archive_state", "ip_hour", "address_day", "day_budget", "creation_budget", "relay_dedupe", "relay_auth", "wallet_births", "relayed_creations"];

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

const raw = process.env.DATABASE_URL_INGEST ?? "";
let url;
try {
  url = new URL(raw);
} catch {
  fail("DATABASE_URL_INGEST is missing or is not a URL");
}
if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail("DATABASE_URL_INGEST must start with postgres:// or postgresql://");

// The driver sends every query parameter it does not know to the server as a
// setting, so Neon's channel_binding=require fails the connection, and its
// sslmode=require encrypts without checking the certificate. Only
// sslmode=verify-full passes, except to this machine.
const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
const params = [...url.searchParams.keys()];
if (params.some((name) => name !== "sslmode")) fail("DATABASE_URL_INGEST may carry only ?sslmode=verify-full; remove " + params.filter((n) => n !== "sslmode").join(", "));
if (!local && url.searchParams.get("sslmode") !== "verify-full") fail("DATABASE_URL_INGEST must end with ?sslmode=verify-full");

const secrets = [raw];
if (url.password) secrets.push(url.password, decodeURIComponent(url.password));
const log = createLogger(secrets, (line) => console.log(line));

try {
  const db = connectPostgres(raw);
  await applySchema(db);
  const rows = await db.query(
    // Through text, as in db.ts: postgres.js would JSON-encode a jsonb parameter a second time.
    "select table_name from information_schema.tables where table_schema = current_schema() and table_name in (select jsonb_array_elements_text($1::text::jsonb))",
    [JSON.stringify(TABLES)],
  );
  const present = new Set(rows.map((r) => r.table_name));
  const absent = TABLES.filter((t) => !present.has(t));
  if (absent.length > 0) fail("schema ran but these tables are absent: " + absent.join(", "));
  log.info("archive_schema_applied", { database: url.pathname.slice(1), tables: TABLES });
  console.log("OK: " + TABLES.length + " tables present. Next: create the read-only kalypso_api role (packages/server/src/archive/schema.sql).");
  process.exit(0);
} catch (err) {
  // The line goes through the server's scrubbing logger, so a message that
  // echoes the URL or the password prints [redacted] instead.
  log.warn("archive_schema_failed", { error: err instanceof Error ? err.name : "unknown", detail: err instanceof Error ? err.message.slice(0, 200) : "" });
  fail("could not apply the schema; see the line above");
}

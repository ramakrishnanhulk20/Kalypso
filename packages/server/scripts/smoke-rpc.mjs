// Live check against real Stellar testnet RPC: ingests our deployed token's
// and payroll's events into an in-memory archive (PGlite), then reads one
// account's history back through the archive API. Proves real RPC event
// shapes parse end to end, and that the archive proves its own start from
// the token's deploy transaction. Contract ids and the token's deploy ledger
// and hash come from packages/contracts/deployments/testnet.json. Fails once
// that ledger leaves RPC's retention window (about 7 days), because the
// archive can then no longer prove where the token's history begins.
// Needs network access only: no keys, no database server, no Channels calls.
//
//   node scripts/smoke-rpc.mjs
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { xdr } from "@stellar/stellar-sdk";
import {
  applySchema,
  archiveHandler,
  createLogger,
  createRpcClient,
  ingestOnce,
  loadConfig,
  pgliteDb,
} from "../src/index.ts";

const deployment = JSON.parse(readFileSync(new URL("../../contracts/deployments/testnet.json", import.meta.url), "utf8"));
const contracts = deployment.contracts ?? {};
const TOKEN = contracts.token?.id;
const PAYROLL = contracts.payroll?.id;
const START_LEDGER = contracts.token?.deployTx?.ledger;
const DEPLOY_TX = contracts.token?.deployTx?.hash;
if (!Number.isInteger(START_LEDGER) || typeof DEPLOY_TX !== "string") {
  console.log("FAIL: deployments/testnet.json has no contracts.token.deployTx ledger and hash");
  process.exit(1);
}

// loadConfig checks every id, the ledger and the hash, and fails loudly on any of them.
const cfg = loadConfig({
  NETWORK: "testnet",
  RPC_URL: process.env.RPC_URL,
  TOKEN_CONTRACT_ID: TOKEN,
  PAYROLL_CONTRACT_ID: PAYROLL,
  AUDITOR_CONTRACT_ID: contracts.auditorRegistry?.id,
  VERIFIER_CONTRACT_ID: contracts.verifier?.id,
  ARCHIVE_START_LEDGER: String(START_LEDGER),
  TOKEN_DEPLOY_TX: DEPLOY_TX,
  CHANNELS_API_KEY: "smoke-run-makes-no-relay-calls",
  DATABASE_URL_INGEST: "postgres://unused@localhost/smoke",
  DATABASE_URL_API: "postgres://unused@localhost/smoke",
  CRON_SECRET: "smoke-run-makes-no-cron-calls-0000000000",
  LOG_SALT: "smoke-run-logs-no-sponsor-lines-00000000",
});

const db = pgliteDb(new PGlite());
await applySchema(db);
const rpc = createRpcClient(cfg);
const warnings = [];
const log = createLogger([], (line) => warnings.push(line));

const started = Date.now();
const result = await ingestOnce(db, rpc, cfg, { log });
console.log(
  "ingestOnce: " + result.eventsStored + " events stored in " + result.pages + " RPC pages, ingested through ledger " +
    result.ingestedThrough + ", gaps: " + result.gaps.length + ", caught up: " + result.caughtUp + " (" + (Date.now() - started) + " ms)",
);

const busiest = await db.query(
  "select a as account, count(*)::int as n from events, unnest(accounts) a where contract_id = $1 group by a order by n desc, a limit 1",
  [TOKEN],
);
if (busiest.length === 0) {
  console.log("FAIL: no token events were archived");
  process.exit(1);
}
const account = busiest[0].account;

const ctx = { cfg, db: { ingest: db, api: db }, rpc, log };
const call = async (path) => {
  const res = await archiveHandler(new Request("http://archive.local" + path), ctx);
  return { status: res.status, body: await res.json() };
};

const rows = [];
let complete = true;
let cursor = null;
let ingestedThrough = 0;
do {
  const { status, body } = await call(
    "/v1/tokens/" + TOKEN + "/accounts/" + account + "/events?from_ledger=0&limit=200" + (cursor ? "&cursor=" + cursor : ""),
  );
  if (status !== 200) {
    console.log("FAIL: events endpoint answered " + status + " " + JSON.stringify(body));
    process.exit(1);
  }
  rows.push(...body.events);
  complete = complete && body.complete;
  ingestedThrough = body.ingested_through;
  cursor = body.cursor;
} while (cursor !== null);

const byType = {};
for (const row of rows) {
  const name = xdr.ScVal.fromXDR(row.topics_xdr[0], "base64").sym().toString();
  xdr.ScVal.fromXDR(row.data_xdr, "base64");
  byType[name] = (byType[name] ?? 0) + 1;
}
console.log("account " + account + ": " + rows.length + " events " + JSON.stringify(byType));
console.log("complete: " + complete + ", ingested_through: " + ingestedThrough);

const health = (await call("/v1/health")).body;
console.log(
  "health: latest " + health.latest_ledger + ", ingested_from " + health.ingested_from + ", complete " + health.complete +
    ", alarm " + health.alarm,
);
const checkpoint = (await call("/v1/tokens/" + TOKEN + "/accounts/" + account + "/checkpoint")).body;
console.log("checkpoint: " + (checkpoint.event ? "ledger " + checkpoint.event.ledger_seq : "none") + ", complete " + checkpoint.complete);
const payroll = (await call("/v1/payroll/" + PAYROLL + "/companies/1/events?from_ledger=0")).body;
console.log("payroll company 1: " + payroll.events.length + " events, complete " + payroll.complete);
const stream = (await call("/contracts/" + TOKEN + "/events?startLedger=" + START_LEDGER)).body;
console.log("token stream (SDK IndexerClient shape): " + stream.events.length + " events, complete " + stream.complete);
for (const line of warnings) console.log("log: " + line);

const pass = rows.length > 0 && complete && health.ingested_from === 1 && health.complete && !health.alarm && payroll.complete;
console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(pass ? 0 : 1);

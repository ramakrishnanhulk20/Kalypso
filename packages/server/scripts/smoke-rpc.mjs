// Live check against real Stellar testnet RPC: ingests the M1a spike token's
// events into an in-memory archive (PGlite), then reads one account's history
// back through the archive API. Proves real RPC event shapes parse end to end.
// Needs network access only: no keys, no database server, no Channels calls.
//
//   node scripts/smoke-rpc.mjs
import { PGlite } from "@electric-sql/pglite";
import { StrKey, hash, xdr } from "@stellar/stellar-sdk";
import {
  applySchema,
  archiveHandler,
  createLogger,
  createRpcClient,
  ingestOnce,
  loadConfig,
  pgliteDb,
} from "../src/index.ts";

const SPIKE_TOKEN = "CCFD5X2XSCS6N6S67UQ3P3PMTNCN7O2NA5ZOET4LIHLMCEPFKXVFAEEN";
const SPIKE_AUDITOR = "CCMJNKU7DDERYUUMRLDUKM7FVXFOHK7HUH6TFH2XEYBBXZNTTKY2MGWV";
// First ledger of the M1a deploy run that created the spike token (token deployed at 5070103).
const SPIKE_START_LEDGER = 5_070_101;
// A valid contract id that was never deployed, so it has no events.
const DUMMY_PAYROLL = StrKey.encodeContract(hash(Buffer.from("kalypso smoke: payroll with no events")));

const cfg = loadConfig({
  NETWORK: "testnet",
  RPC_URL: process.env.RPC_URL,
  TOKEN_CONTRACT_ID: SPIKE_TOKEN,
  PAYROLL_CONTRACT_ID: DUMMY_PAYROLL,
  AUDITOR_CONTRACT_ID: SPIKE_AUDITOR,
  CHANNELS_API_KEY: "smoke-run-makes-no-relay-calls",
  DATABASE_URL_INGEST: "postgres://unused@localhost/smoke",
  DATABASE_URL_API: "postgres://unused@localhost/smoke",
});

const db = pgliteDb(new PGlite());
await applySchema(db);
const rpc = createRpcClient(cfg);
const warnings = [];
const log = createLogger([], (line) => warnings.push(line));

const started = Date.now();
const result = await ingestOnce(db, rpc, cfg, { startLedger: SPIKE_START_LEDGER });
console.log(
  "ingestOnce: " + result.eventsStored + " events stored in " + result.pages + " RPC pages, ingested through ledger " +
    result.ingestedThrough + ", gaps: " + result.gaps.length + ", caught up: " + result.caughtUp + " (" + (Date.now() - started) + " ms)",
);

const busiest = await db.query(
  "select a as account, count(*)::int as n from events, unnest(accounts) a where contract_id = $1 group by a order by n desc, a limit 1",
  [SPIKE_TOKEN],
);
if (busiest.length === 0) {
  console.log("FAIL: no token events were archived");
  process.exit(1);
}
const account = busiest[0].account;

const ctx = { cfg, db: { ingest: db, api: db }, rpc, log, archiveStartLedger: SPIKE_START_LEDGER };
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
    "/v1/tokens/" + SPIKE_TOKEN + "/accounts/" + account + "/events?from_ledger=0&limit=200" + (cursor ? "&cursor=" + cursor : ""),
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
const checkpoint = (await call("/v1/tokens/" + SPIKE_TOKEN + "/accounts/" + account + "/checkpoint")).body;
console.log("checkpoint: " + (checkpoint.event ? "ledger " + checkpoint.event.ledger_seq : "none") + ", complete " + checkpoint.complete);
const payroll = (await call("/v1/payroll/" + DUMMY_PAYROLL + "/companies/1/events?from_ledger=0")).body;
console.log("dummy payroll company 1: " + payroll.events.length + " events, complete " + payroll.complete);
const stream = (await call("/contracts/" + SPIKE_TOKEN + "/events?startLedger=" + SPIKE_START_LEDGER)).body;
console.log("token stream (SDK IndexerClient shape): " + stream.events.length + " events, complete " + stream.complete);
for (const line of warnings) console.log("log: " + line);

const pass = rows.length > 0 && complete && health.complete && !health.alarm && payroll.complete;
console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(pass ? 0 : 1);

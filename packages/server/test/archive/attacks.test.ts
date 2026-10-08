// Attacks on the archive: vouching for ledgers it never read, guessing the
// cron secret, and reading callers out of its logs. Not covered here: real
// RPC (the fake chain plays it), a real database server (PGlite runs the same
// SQL), and the hosting platform's own request logs, which see the account
// address in every archive URL.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveHandler, type ArchiveContext } from "../../src/archive/api.ts";
import { ingestCronHandler, type IngestCronContext } from "../../src/archive/cron.ts";
import { readArchiveState, type Db } from "../../src/archive/db.ts";
import { createLogger } from "../../src/log.ts";
import { CRON_SECRET, PAYROLL, TOKEN, keypairFor, testConfig } from "../helpers.ts";
import { freshDb, resetArchive } from "../db.ts";
import { FakeChain, deployTxEvent, depositEvent, payslipIssued, transferEvent, txHashOf } from "./fake-chain.ts";

const cfg = testConfig({ ARCHIVE_START_LEDGER: "100", TOKEN_DEPLOY_TX: txHashOf(100) });
const alice = keypairFor("alice").publicKey();
const bob = keypairFor("bob").publicKey();
const NOW = new Date("2026-10-08T12:00:00Z");
const CLIENT_IP = "203.0.113.7";

let db: Db;
let chain: FakeChain;
const logs: string[] = [];

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await resetArchive(db);
  logs.length = 0;
  chain = new FakeChain(100, 500).add(depositEvent(TOKEN, 105, alice, alice, 5_000_000n), transferEvent(TOKEN, 120, alice, bob));
});

function context(overrides: Partial<ArchiveContext> = {}): ArchiveContext {
  return { cfg, db: { ingest: db, api: db }, rpc: chain, log: createLogger([], (line) => logs.push(line)), archiveStartLedger: 100, now: () => NOW, ...overrides };
}

async function get(path: string, ctx = context()) {
  const res = await archiveHandler(new Request("https://kalypso.test" + path, { headers: { "x-real-ip": CLIENT_IP } }), ctx);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, any> };
}

const tokenEvents = (account: string, query = "") => "/v1/tokens/" + TOKEN + "/accounts/" + account + "/events" + query;

describe("what the archive vouches for (C17)", () => {
  it("refuses to vouch for ledgers it never read when it starts after the token existed: health names its start, replies say incomplete, and it warns", async () => {
    // The operator set the start ledger to 110; the token already had an event at 105.
    const ctx = context({ archiveStartLedger: 110 });
    const health = await get("/v1/health", ctx);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ingested_from: 110, ingested_through: 500, alarm: false, gaps: [] });
    const events = await get(tokenEvents(alice, "?from_ledger=0"), ctx);
    expect(events.body.complete).toBe(false);
    expect(events.body.events.map((r: { ledger_seq: number }) => r.ledger_seq)).toEqual([120]);
    expect((await get(tokenEvents(alice, "?from_ledger=110"), ctx)).body.complete).toBe(true);
    const warning = logs.filter((l) => l.includes('"event":"archive_start_unproven"'));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain('"level":"warn"');
    expect(warning[0]).toContain('"startLedger":110');
    expect(warning[0]).toContain('"firstTokenEvent":"transfer"');
  });

  it("refuses to vouch from genesis while the start check is still pending: health and every complete answer begin at the start ledger", async () => {
    chain = new FakeChain(100, 500).add(payslipIssued(PAYROLL, 150, 7n, 1n, bob));
    const health = await get("/v1/health");
    expect(await readArchiveState(db)).toMatchObject({ startLedger: 100, startCheckPending: true, coversFromGenesis: false });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ingested_from: 100, ingested_through: 500, complete: true });
    for (const query of ["?from_ledger=0", "?from_ledger=1", "?from_ledger=99&to_ledger=200"]) {
      expect((await get(tokenEvents(alice, query))).body.complete, query).toBe(false);
    }
    expect((await get(tokenEvents(alice, "?from_ledger=100"))).body.complete).toBe(true);
    expect((await get("/v1/tokens/" + TOKEN + "/accounts/" + alice + "/checkpoint")).body.complete).toBe(false);
    expect((await get("/v1/payroll/" + PAYROLL + "/companies/7/events?from_ledger=0")).body.complete).toBe(false);
    expect((await get("/v1/payroll/" + PAYROLL + "/companies/7/events?from_ledger=100")).body.complete).toBe(true);
    expect((await get("/contracts/" + TOKEN + "/events")).status).toBe(409);
    expect((await get("/contracts/" + TOKEN + "/events?startLedger=99")).status).toBe(409);
    expect((await get("/contracts/" + TOKEN + "/events?startLedger=100")).status).toBe(200);
  });

  it("refuses to vouch from genesis on a configured start alone, until it reads the token's deploy transaction there first", async () => {
    const before = await get(tokenEvents(alice, "?from_ledger=0"));
    expect(before.body.complete).toBe(false);
    expect((await get("/v1/health")).body.ingested_from).toBe(100);

    // The constructor's events in any order: underlying_asset_set is not first here.
    const deployed = () =>
      new FakeChain(100, 500).add(
        deployTxEvent(TOKEN, 100, "verifier_set", 0),
        deployTxEvent(TOKEN, 100, "underlying_asset_set", 1),
        depositEvent(TOKEN, 105, alice, alice, 5_000_000n),
      );
    await resetArchive(db);
    chain = deployed();
    const proven = await get("/v1/health", context({ now: () => new Date(NOW.getTime() + 10_000) }));
    expect(proven.body).toMatchObject({ ingested_from: 1, complete: true });
    expect((await get(tokenEvents(alice, "?from_ledger=0"), context({ now: () => new Date(NOW.getTime() + 20_000) }))).body.complete).toBe(true);
    expect(logs.some((l) => l.includes('"event":"archive_start_proven"'))).toBe(true);

    await resetArchive(db);
    chain = deployed();
    const unconfigured = context({ cfg: testConfig(), now: () => new Date(NOW.getTime() + 30_000) });
    expect((await get("/v1/health", unconfigured)).body).toMatchObject({ ingested_from: 100 });
    expect((await get(tokenEvents(alice, "?from_ledger=0"), unconfigured)).body.complete).toBe(false);
    expect(logs.some((l) => l.includes("TOKEN_DEPLOY_TX is not set"))).toBe(true);
  });
});

describe("the cron secret", () => {
  const cron = (headers: Record<string, string>) =>
    ingestCronHandler(new Request("https://kalypso.test/api/archive/ingest", { method: "POST", headers }), {
      cfg,
      db,
      rpc: chain,
      log: createLogger([], (line) => logs.push(line)),
      archiveStartLedger: 100,
      now: () => NOW,
    } satisfies IngestCronContext);

  it("refuses a bearer with a tab, a double space, another case, the secret upper-cased, or two values", async () => {
    const variants = [
      "Bearer\t" + CRON_SECRET,
      "Bearer  " + CRON_SECRET,
      "BEARER " + CRON_SECRET,
      "Bearer " + CRON_SECRET.toUpperCase(),
      "Bearer " + CRON_SECRET + ", Bearer " + CRON_SECRET,
    ];
    for (const authorization of variants) {
      const res = await cron({ authorization });
      expect(res.status, JSON.stringify(authorization)).toBe(401);
    }
    expect(chain.calls).toBe(0);
    expect((await cron({ authorization: "Bearer " + CRON_SECRET })).status).toBe(200);
    expect(logs.join("\n")).not.toContain(CRON_SECRET);
  });
});

describe("what the archive logs (C36)", () => {
  it("refuses to log any caller IP, account or company, on normal and failing requests alike", async () => {
    await get("/v1/health");
    await get(tokenEvents(alice, "?from_ledger=0"));
    await get("/v1/payroll/" + cfg.PAYROLL_CONTRACT_ID + "/companies/7/events");
    await get(tokenEvents("G'%20OR%201=1--"));
    const broken: Db = { ...db, query: async () => Promise.reject(new Error("where " + alice + " from " + CLIENT_IP)) };
    expect((await get(tokenEvents(alice), context({ db: { ingest: db, api: broken } }))).status).toBe(500);
    const down = { ...chain, getHealth: async () => Promise.reject(new Error("rpc down for " + CLIENT_IP)), getEvents: chain.getEvents.bind(chain), simulateTransaction: chain.simulateTransaction, getLedgerEntries: chain.getLedgerEntries };
    await get(tokenEvents(bob), context({ rpc: down, now: () => new Date(NOW.getTime() + 10_000) }));
    const hay = logs.join("\n");
    expect(logs.length).toBeGreaterThan(1);
    expect(hay).not.toContain(CLIENT_IP);
    expect(hay).not.toMatch(/G[A-Z2-7]{55}/);
    expect(hay).not.toContain("/v1/");
    expect(hay).not.toContain("companies/7");
  });
});

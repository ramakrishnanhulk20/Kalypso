// Not covered here: the confidential SDK's own clients (they are not a
// dependency of this package; scratchpad/m5a/parity.mjs runs IndexerV1Client,
// IndexerClient and hybridFetchEvents against this handler with live testnet
// data), and the production read-only role (db.test.ts proves the SQL).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import { CATCH_UP_DEADLINE_MS, archiveHandler, type ArchiveContext } from "../../src/archive/api.ts";
import { recordGap, type Db } from "../../src/archive/db.ts";
import { createLogger } from "../../src/log.ts";
import { PAYROLL, STRANGER, TOKEN, contractFor, keypairFor, testConfig } from "../helpers.ts";
import { freshDb, resetArchive } from "../db.ts";
import { FakeChain, addrVal, deployTxEvent, depositEvent, mergeEvent, payslipIssued, rpcEvent, sym, transferEvent, txHashOf } from "./fake-chain.ts";

const cfg = testConfig({ ARCHIVE_START_LEDGER: "100", TOKEN_DEPLOY_TX: txHashOf(100) });
const alice = keypairFor("alice").publicKey();
const bob = keypairFor("bob").publicKey();
const carol = contractFor("carol passkey");
const NOW = new Date("2026-10-07T12:00:00Z");

let db: Db;
let chain: FakeChain;
const logs: string[] = [];

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await resetArchive(db);
  chain = new FakeChain(100, 500);
  chain.add(
    deployTxEvent(TOKEN, 100),
    depositEvent(TOKEN, 110, alice, alice, 5_000_000n),
    transferEvent(TOKEN, 120, alice, bob),
    transferEvent(TOKEN, 130, alice, carol),
    mergeEvent(TOKEN, 140, bob),
    transferEvent(TOKEN, 150, bob, alice),
    transferEvent(TOKEN, 160, alice, bob, 1, 0),
    transferEvent(TOKEN, 160, alice, bob, 2, 0),
    rpcEvent({ ledger: 170, contract: TOKEN, topics: [sym("withdraw"), addrVal(bob), addrVal(alice)] }),
    mergeEvent(TOKEN, 180, bob),
    payslipIssued(PAYROLL, 125, 7n, 1n, bob),
    payslipIssued(PAYROLL, 126, 8n, 1n, alice),
    payslipIssued(PAYROLL, 165, 7n, 2n, bob),
  );
});

function context(overrides: Partial<ArchiveContext> = {}): ArchiveContext {
  return {
    cfg,
    db: { ingest: db, api: db },
    rpc: chain,
    log: createLogger([], (line) => logs.push(line)),
    archiveStartLedger: 100,
    now: () => NOW,
    ...overrides,
  };
}

async function get(path: string, ctx = context(), method = "GET") {
  const res = await archiveHandler(new Request("https://kalypso.test" + path, { method }), ctx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const tokenEvents = (account: string, query = "") => "/v1/tokens/" + TOKEN + "/accounts/" + account + "/events" + query;
const decodeName = (row: { topics_xdr: string[] }) => xdr.ScVal.fromXDR(row.topics_xdr[0]!, "base64").sym().toString();

describe("GET /v1/health", () => {
  it("catches up first, then reports coverage with no alarm", async () => {
    const res = await get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.body).toEqual({
      latest_ledger: 500,
      ingested_through: 500,
      ingested_from: 1,
      lag_seconds: 0,
      complete: true,
      alarm: false,
      alarm_reasons: [],
      gaps: [],
      last_ingest_at: NOW.toISOString(),
    });
  });

  const rpcDown = () => ({
    getHealth: async () => Promise.reject(new Error("down")),
    getEvents: chain.getEvents.bind(chain),
    simulateTransaction: chain.simulateTransaction,
    getLedgerEntries: chain.getLedgerEntries,
  });
  const hoursLater = (hours: number, extraMs = 0) => () => new Date(NOW.getTime() + hours * 3_600_000 + extraMs);

  it("answers 503 for a permanent gap on its own", async () => {
    expect((await get("/v1/health")).status).toBe(200);
    await recordGap(db, 200, 210, NOW);
    const res = await get("/v1/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ alarm: true, alarm_reasons: ["permanent_gap"], complete: false });
  });

  it("answers 503 after 48 hours without a successful ingest, and 200 again once an ingest succeeds", async () => {
    expect((await get("/v1/health")).status).toBe(200);
    expect((await get("/v1/health", context({ now: hoursLater(47), rpc: rpcDown() }))).status).toBe(200);
    const stale = await get("/v1/health", context({ now: hoursLater(49), rpc: rpcDown() }));
    expect(stale.status).toBe(503);
    expect(stale.body).toMatchObject({ alarm: true, alarm_reasons: ["stale"], last_ingest_at: NOW.toISOString() });
    const resumed = await get("/v1/health", context({ now: hoursLater(49, 10_000) }));
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ alarm: false, alarm_reasons: [] });
  });

  it("raises the alarm for a permanent gap and for 48 hours without an ingest together", async () => {
    await get("/v1/health");
    await recordGap(db, 200, 210, NOW);
    const res = await get("/v1/health", context({ now: hoursLater(49), rpc: rpcDown() }));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      complete: false,
      alarm: true,
      alarm_reasons: ["permanent_gap", "stale"],
      gaps: [{ from_ledger: 200, to_ledger: 210, detected_at: NOW.toISOString() }],
    });
    expect(logs.at(-1)).toContain("archive_catch_up_failed");
  });

  it("reports an empty archive honestly, with 503, when RPC is down", async () => {
    const res = await get("/v1/health", context({ rpc: rpcDown() }));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ingested_through: 0, ingested_from: 0, complete: false, alarm: true });
  });
});

describe("GET /v1/tokens/{contract}/accounts/{account}/events", () => {
  it("returns the account's events in chain order, as stored XDR rows, with complete and ingested_through", async () => {
    const res = await get(tokenEvents(bob, "?from_ledger=0"));
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(true);
    expect(res.body.ingested_through).toBe(500);
    expect(res.body.cursor).toBeNull();
    expect(res.body.events.map((r: any) => [r.ledger_seq, r.tx_application_order, decodeName(r)])).toEqual([
      [120, 1, "transfer"],
      [140, 1, "merge"],
      [150, 1, "transfer"],
      [160, 1, "transfer"],
      [160, 2, "transfer"],
      [170, 1, "withdraw"],
      [180, 1, "merge"],
    ]);
    const first = res.body.events[0];
    const source = chain.events.find((e) => e.ledger === 120)!;
    expect(first).toEqual({
      ledger_seq: 120,
      tx_hash: source.txHash,
      tx_application_order: 1,
      operation_index: 0,
      event_index: 0,
      ledger_close_time: source.ledgerClosedAt.replace("Z", ".000Z"),
      contract_id: TOKEN,
      topics_xdr: source.topic,
      data_xdr: source.value,
    });
  });

  it("pages with our cursor until it is null", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(tokenEvents(bob, "?limit=3" + (cursor ? "&cursor=" + cursor : "")));
      expect(res.body.complete).toBe(true);
      seen.push(...res.body.events.map((r: any) => r.ledger_seq));
      cursor = res.body.cursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual([120, 140, 150, 160, 160, 170, 180]);
  });

  it("filters by ledger range and event type, and serves contract accounts", async () => {
    const res = await get(tokenEvents(bob, "?from_ledger=141&to_ledger=175&types=transfer"));
    expect(res.body.events.map((r: any) => r.ledger_seq)).toEqual([150, 160, 160]);
    expect(res.body.complete).toBe(true);
    expect((await get(tokenEvents(carol))).body.events.map((r: any) => r.ledger_seq)).toEqual([130]);
  });

  it("says complete: false for any range a gap or an un-ingested ledger touches", async () => {
    await get("/v1/health");
    await recordGap(db, 200, 210, NOW);
    expect((await get(tokenEvents(bob, "?from_ledger=190&to_ledger=205"))).body.complete).toBe(false);
    expect((await get(tokenEvents(bob, "?from_ledger=0"))).body.complete).toBe(false);
    expect((await get(tokenEvents(bob, "?from_ledger=211"))).body.complete).toBe(true);
    expect((await get(tokenEvents(bob, "?from_ledger=100&to_ledger=199"))).body.complete).toBe(true);
    expect((await get(tokenEvents(bob, "?from_ledger=400&to_ledger=501"))).body.complete).toBe(false);
  });

  it("vouches for nothing before RPC's oldest ledger when the archive was not started at deployment", async () => {
    const res = await get(tokenEvents(bob, "?from_ledger=0"), context({ cfg: testConfig(), archiveStartLedger: undefined }));
    expect(res.body.complete).toBe(false);
    expect((await get(tokenEvents(bob, "?from_ledger=100"))).body.complete).toBe(true);
  });
});

describe("GET /v1/tokens/{contract}/accounts/{account}/checkpoint", () => {
  it("returns the latest outgoing proof-carrying event at or before the ledger, never a merge", async () => {
    expect((await get("/v1/tokens/" + TOKEN + "/accounts/" + bob + "/checkpoint")).body).toMatchObject({
      event: { ledger_seq: 170 },
      complete: true,
      ingested_through: 500,
    });
    expect((await get("/v1/tokens/" + TOKEN + "/accounts/" + bob + "/checkpoint?at_ledger=169")).body.event.ledger_seq).toBe(150);
    expect((await get("/v1/tokens/" + TOKEN + "/accounts/" + bob + "/checkpoint?at_ledger=149")).body).toMatchObject({
      event: null,
      complete: true,
    });
    expect((await get("/v1/tokens/" + TOKEN + "/accounts/" + bob + "/checkpoint?at_ledger=900")).body.complete).toBe(false);
  });
});

describe("GET /v1/payroll/{contract}/companies/{companyId}/events", () => {
  it("returns only that company's payroll events", async () => {
    const res = await get("/v1/payroll/" + PAYROLL + "/companies/7/events?from_ledger=0");
    expect(res.body.events.map((r: any) => r.ledger_seq)).toEqual([125, 165]);
    expect(res.body).toMatchObject({ cursor: null, complete: true, ingested_through: 500 });
    const paged = await get("/v1/payroll/" + PAYROLL + "/companies/7/events?limit=1");
    expect(paged.body.cursor).toBe("125-1-0-0");
    const next = await get("/v1/payroll/" + PAYROLL + "/companies/7/events?limit=1&cursor=125-1-0-0");
    expect(next.body.events.map((r: any) => r.ledger_seq)).toEqual([165]);
    expect((await get("/v1/payroll/" + PAYROLL + "/companies/9/events")).body.events).toEqual([]);
  });
});

describe("GET /contracts/{contract}/events (the SDK IndexerClient shape)", () => {
  it("serves the token's whole stream as decoded JSON rows with source-independent ids", async () => {
    const res = await get("/contracts/" + TOKEN + "/events?startLedger=101&endLedger=125&limit=200");
    expect(res.status).toBe(200);
    const deposit = chain.events.find((e) => e.ledger === 110)!;
    expect(res.body).toMatchObject({ latestLedger: 500, cursor: null, complete: true, ingested_through: 500 });
    expect(res.body.events[0]).toEqual({
      id: "110-" + deposit.txHash + "-op-0-event-0",
      ledger: 110,
      txHash: deposit.txHash,
      topic: ["deposit", alice, alice],
      value: { amount: "5000000" },
    });
    expect(res.body.events[1]).toMatchObject({
      topic: ["transfer", alice, bob],
      value: { b_tilde: "78".repeat(32), r_e_point: "03".repeat(64) },
    });
  });

  it("continues from a cursor, and refuses (409) any range it cannot vouch for", async () => {
    const first = await get("/contracts/" + TOKEN + "/events?startLedger=101&limit=2");
    expect(first.body.cursor).toBe("120-1-0-0");
    const second = await get("/contracts/" + TOKEN + "/events?limit=2&cursor=" + first.body.cursor);
    expect(second.body.events.map((e: any) => e.ledger)).toEqual([130, 140]);
    await recordGap(db, 300, 301, NOW);
    expect(await get("/contracts/" + TOKEN + "/events?startLedger=250&endLedger=350")).toMatchObject({
      status: 409,
      body: { error: "history_incomplete", complete: false, ingested_through: 500 },
    });
  });
});

describe("bad inputs are refused with 400 before anything runs (C24)", () => {
  const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([keypairFor("alice").rawPublicKey(), Buffer.alloc(8, 1)]));
  const cases: Array<[string, string, string]> = [
    ["SQL metacharacters in account", tokenEvents("G'%20OR%201=1--"), "bad_account"],
    ["SQL metacharacters spelled out", tokenEvents("GAAAA';DROP%20TABLE%20events;--"), "bad_account"],
    ["an unknown contract", "/v1/tokens/" + STRANGER + "/accounts/" + bob + "/events", "unknown_contract"],
    ["the payroll id on a token route", "/v1/tokens/" + PAYROLL + "/accounts/" + bob + "/events", "unknown_contract"],
    ["a lower-case contract id", "/v1/tokens/" + TOKEN.toLowerCase() + "/accounts/" + bob + "/events", "unknown_contract"],
    ["an M address", tokenEvents(muxed), "bad_account"],
    ["a lower-case account", tokenEvents(bob.toLowerCase()), "bad_account"],
    ["a 10 MB cursor", tokenEvents(bob, "?cursor=" + "1".repeat(10 * 1024 * 1024)), "request_too_long"],
    ["a cursor in the wrong format", tokenEvents(bob, "?cursor=0021775926572404736-0000000002"), "bad_cursor"],
    ["a cursor with SQL in it", tokenEvents(bob, "?cursor=1-1-1-1);DROP"), "bad_cursor"],
    ["limit 1e9", tokenEvents(bob, "?limit=1e9"), "bad_limit"],
    ["limit 1000000000", tokenEvents(bob, "?limit=1000000000"), "bad_limit"],
    ["limit 0", tokenEvents(bob, "?limit=0"), "bad_limit"],
    ["limit 201", tokenEvents(bob, "?limit=201"), "bad_limit"],
    ["a negative ledger", tokenEvents(bob, "?from_ledger=-1"), "bad_from_ledger"],
    ["a ledger beyond u32", tokenEvents(bob, "?to_ledger=4294967296"), "bad_to_ledger"],
    ["a range that ends before it starts", tokenEvents(bob, "?from_ledger=10&to_ledger=9"), "bad_range"],
    ["a parameter given twice", tokenEvents(bob, "?limit=5&limit=6"), "duplicate_parameter"],
    ["types with punctuation", tokenEvents(bob, "?types=transfer,merge'--"), "bad_types"],
    ["a company id with a sign", "/v1/payroll/" + PAYROLL + "/companies/-1/events", "bad_company"],
    ["a company id with leading zero", "/v1/payroll/" + PAYROLL + "/companies/07/events", "bad_company"],
    ["a company id beyond u64", "/v1/payroll/" + PAYROLL + "/companies/18446744073709551616/events", "bad_company"],
    ["a token id on the payroll route", "/v1/payroll/" + TOKEN + "/companies/7/events", "unknown_contract"],
    ["a checkpoint ledger that is not a number", "/v1/tokens/" + TOKEN + "/accounts/" + bob + "/checkpoint?at_ledger=1;", "bad_at_ledger"],
    ["a stream limit of 1e9", "/contracts/" + TOKEN + "/events?limit=1e9", "bad_limit"],
  ];

  for (const [label, path, code] of cases) {
    it("refuses " + label, async () => {
      const calls = chain.calls;
      const res = await get(path);
      expect(res).toMatchObject({ status: 400, body: { error: code } });
      expect(chain.calls).toBe(calls);
    });
  }

  it("answers 404 for unknown paths, 405 for other methods and 204 to a preflight", async () => {
    expect((await get("/v1/tokens/" + TOKEN + "/accounts/" + bob + "/balance")).status).toBe(404);
    expect((await get("/v2/health")).status).toBe(404);
    expect((await get("/v1/health", context(), "POST")).status).toBe(405);
    const preflight = await get("/v1/health", context(), "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});

describe("reads stay read-only and bounded", () => {
  it("sends only select statements to the API connection", async () => {
    const statements: string[] = [];
    const api: Db = {
      query: async (text, params) => {
        statements.push(text);
        if (!/^\s*select\b/i.test(text)) throw new Error("write on the read-only connection");
        return db.query(text, params);
      },
      transaction: async () => Promise.reject(new Error("no transactions on the read-only connection")),
      exec: async () => Promise.reject(new Error("no exec on the read-only connection")),
    };
    const ctx = context({ db: { ingest: db, api } });
    for (const path of [
      "/v1/health",
      tokenEvents(bob),
      "/v1/tokens/" + TOKEN + "/accounts/" + bob + "/checkpoint",
      "/v1/payroll/" + PAYROLL + "/companies/7/events",
      "/contracts/" + TOKEN + "/events",
    ]) {
      expect((await get(path, ctx)).status).toBe(200);
    }
    expect(statements.length).toBeGreaterThan(10);
  });

  it("starts at most one catch-up per interval", async () => {
    await get("/v1/health");
    const calls = chain.calls;
    await get(tokenEvents(bob));
    expect(chain.calls).toBe(calls);
  });

  it("caps the catch-up at 2 seconds when RPC hangs, then answers from what it holds", async () => {
    expect(CATCH_UP_DEADLINE_MS).toBe(2_000);
    chain.delayMs = 60_000;
    const started = Date.now();
    const res = await get(tokenEvents(bob));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(res).toMatchObject({ status: 200, body: { events: [], complete: false, ingested_through: 0 } });
  });

  it("hides internal failures behind one code", async () => {
    const broken: Db = { ...db, query: async () => Promise.reject(new Error("secret detail")) };
    const res = await get(tokenEvents(bob), context({ db: { ingest: db, api: broken } }));
    expect(res).toMatchObject({ status: 500, body: { error: "internal_error" } });
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });

  it("serves under a base path", async () => {
    const ctx = context({ basePath: "/api/archive" });
    expect((await get("/api/archive/v1/health", ctx)).status).toBe(200);
    expect((await get("/v1/health", ctx)).status).toBe(404);
  });
});

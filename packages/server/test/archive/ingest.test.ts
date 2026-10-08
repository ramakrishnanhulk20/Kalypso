// Not covered here: real RPC reply shapes (scripts/smoke-rpc.mjs reads live
// testnet), a real database server (PGlite runs the same SQL in process), and
// two server instances ingesting at the same moment (overlapping ranges merge
// by construction; the atomic catch-up claim is tested in db.test.ts).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { coverageOf, ingestedFrom, ingestedThrough, isComplete, mergeRanges } from "../../src/archive/coverage.ts";
import { readCoverage, type Db } from "../../src/archive/db.ts";
import { UpstreamDataError, ingestOnce, parseRpcCursor } from "../../src/archive/ingest.ts";
import type { RpcClient } from "../../src/rpc.ts";
import { PAYROLL, STRANGER, TOKEN, contractFor, keypairFor, testConfig } from "../helpers.ts";
import { freshDb, resetArchive } from "../db.ts";
import {
  FakeChain,
  addrVal,
  companyCreated,
  endOfLedgerCursor,
  mergeEvent,
  payslipIssued,
  rpcEvent,
  sym,
  transferEvent,
  u64,
} from "./fake-chain.ts";

const cfg = testConfig();
const alice = keypairFor("alice").publicKey();
const bob = keypairFor("bob").publicKey();
const wallet = contractFor("bob passkey");

let db: Db;
beforeAll(async () => {
  db = (await freshDb()).db;
});
beforeEach(async () => {
  await resetArchive(db);
});

const count = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from events"))[0]!.n);
const coverage = async () => coverageOf(await readCoverage(db));

function busyChain(): FakeChain {
  const chain = new FakeChain(100, 400);
  chain.window = 150;
  for (let ledger = 110; ledger <= 390; ledger += 12) chain.add(transferEvent(TOKEN, ledger, alice, bob));
  chain.add(mergeEvent(TOKEN, 200, bob, 2), mergeEvent(TOKEN, 200, bob, 3), mergeEvent(TOKEN, 200, bob, 4));
  return chain;
}

describe("ingestOnce", () => {
  it("reads every page across RPC's scan windows and records one contiguous range", async () => {
    const chain = busyChain();
    const result = await ingestOnce(db, chain, cfg, { startLedger: 100, pageLimit: 5 });
    expect(result).toMatchObject({ ingestedThrough: 400, gaps: [], eventsStored: chain.events.length, caughtUp: true });
    expect(result.pages).toBeGreaterThanOrEqual(Math.ceil(chain.events.length / 5));
    expect(await count()).toBe(chain.events.length);
    expect((await coverage()).ranges).toEqual([[100, 400]]);
    const rows = await db.query<{ ledger: number; tx_index: number }>("select ledger, tx_index from events order by ledger, tx_index");
    expect(rows.filter((r) => r.ledger === 200).map((r) => r.tx_index)).toEqual([2, 3, 4]);
  });

  it("stores each event once by id, even when a ledger is read twice or RPC changes the payload", async () => {
    const chain = busyChain();
    // One full page ending inside ledger 200 leaves that ledger unproven, so
    // the next pass reads it again.
    chain.window = 10_000;
    const first = await ingestOnce(db, chain, cfg, { startLedger: 190, pageLimit: 3, maxPages: 1 });
    expect(first.ingestedThrough).toBe(199);
    const second = await ingestOnce(db, chain, cfg, { pageLimit: 3 });
    expect(second.ingestedThrough).toBe(400);
    expect(await count()).toBe(chain.events.filter((e) => e.ledger >= 190).length);

    const before = await db.query<{ value_xdr: string }>("select value_xdr from events where ledger = 206");
    chain.events = chain.events.map((e) => (e.ledger === 206 ? { ...e, value: xdr.ScVal.scvVoid().toXDR("base64") } : e));
    await db.exec("truncate table ingested_ranges");
    await ingestOnce(db, chain, cfg);
    expect(await db.query("select value_xdr from events where ledger = 206")).toEqual(before);
  });

  it("records a permanent gap when RPC has already forgotten the next ledger, and carries on", async () => {
    const chain = busyChain();
    await ingestOnce(db, chain, cfg, { startLedger: 100 });
    chain.oldestLedger = 450;
    chain.latestLedger = 600;
    chain.add(transferEvent(TOKEN, 420, bob, alice), transferEvent(TOKEN, 500, bob, alice));
    const result = await ingestOnce(db, chain, cfg);
    expect(result.gaps.map((g) => [g.fromLedger, g.toLedger])).toEqual([[401, 449]]);
    expect(result.ingestedThrough).toBe(600);
    const c = await coverage();
    expect(c.ranges).toEqual([[100, 400], [450, 600]]);
    expect(isComplete(c, 1, 400)).toBe(true);
    expect(isComplete(c, 300, 500)).toBe(false);
    expect(isComplete(c, 449, 449)).toBe(false);
    expect(isComplete(c, 450, 600)).toBe(true);
    expect(await db.query("select ledger from events where ledger = 420")).toEqual([]);
  });

  it("records a gap at the very start when the deploy ledger is already older than RPC remembers", async () => {
    const chain = busyChain();
    const result = await ingestOnce(db, chain, cfg, { startLedger: 40 });
    expect(result.gaps.map((g) => [g.fromLedger, g.toLedger])).toEqual([[40, 99]]);
    expect(isComplete(await coverage(), 1, 400)).toBe(false);
  });

  it("vouches only from RPC's oldest ledger when no start ledger was given", async () => {
    await ingestOnce(db, busyChain(), cfg);
    const c = await coverage();
    expect(ingestedFrom(c)).toBe(100);
    expect(isComplete(c, 100, 400)).toBe(true);
    expect(isComplete(c, 1, 400)).toBe(false);
  });

  it("looks again when the retention floor moves between getHealth and getEvents", async () => {
    const chain = busyChain();
    await ingestOnce(db, chain, cfg, { startLedger: 100 });
    chain.latestLedger = 700;
    chain.oldestLedger = 400;
    let moved = false;
    chain.beforeGetEvents = () => {
      if (!moved) chain.oldestLedger = 420;
      moved = true;
    };
    const result = await ingestOnce(db, chain, cfg);
    expect(result.gaps.map((g) => [g.fromLedger, g.toLedger])).toEqual([[401, 419]]);
    expect(result.ingestedThrough).toBe(700);
  });

  it("stops at its deadline and keeps the pages it finished", async () => {
    const chain = busyChain();
    chain.delayMs = 40;
    const result = await ingestOnce(db, chain, cfg, { startLedger: 100, pageLimit: 2, deadlineMs: 150 });
    expect(result.caughtUp).toBe(false);
    expect(result.ingestedThrough).toBeLessThan(400);
    expect(await count()).toBe(result.eventsStored);
    const rest = await ingestOnce(db, chain, cfg, { pageLimit: 50 });
    expect(rest.ingestedThrough).toBe(400);
  });

  it("does nothing more once caught up", async () => {
    const chain = busyChain();
    await ingestOnce(db, chain, cfg, { startLedger: 100 });
    const calls = chain.calls;
    expect(await ingestOnce(db, chain, cfg)).toMatchObject({ caughtUp: true, pages: 0, eventsStored: 0 });
    expect(chain.calls).toBe(calls);
  });

  it("derives the query columns: name, owner, every account, and the payroll company id", async () => {
    const chain = new FakeChain(100, 200);
    chain.add(
      transferEvent(TOKEN, 120, alice, wallet),
      companyCreated(PAYROLL, 125, 7n, alice, "Acme"),
      payslipIssued(PAYROLL, 130, 7n, 3n, bob),
      payslipIssued(PAYROLL, 131, 18_446_744_073_709_551_615n, 1n, alice),
      rpcEvent({ ledger: 140, contract: TOKEN, topics: [sym("merge"), addrVal(bob)], ok: false }),
    );
    expect((await ingestOnce(db, chain, cfg, { startLedger: 100 })).eventsStored).toBe(4);
    const rows = await db.query<Record<string, unknown>>(
      "select contract_id, event_name, topic1_address, accounts, company_id from events order by ledger",
    );
    expect(rows).toEqual([
      { contract_id: TOKEN, event_name: "transfer", topic1_address: alice, accounts: [alice, wallet], company_id: null },
      { contract_id: PAYROLL, event_name: "company_created", topic1_address: null, accounts: [], company_id: "7" },
      { contract_id: PAYROLL, event_name: "payslip_issued", topic1_address: null, accounts: [bob], company_id: "7" },
      { contract_id: PAYROLL, event_name: "payslip_issued", topic1_address: null, accounts: [alice], company_id: "18446744073709551615" },
    ]);
    const stored = await db.query<{ topics_xdr: string[] }>("select topics_xdr from events where ledger = 120");
    expect(stored[0]!.topics_xdr).toEqual(chain.events[0]!.topic);
  });

  it("refuses a page that breaks the rules and stores nothing from it", async () => {
    const good = transferEvent(TOKEN, 120, alice, bob);
    const cases: Array<[string, typeof good]> = [
      ["another contract", { ...good, contractId: STRANGER }],
      ["id and ledger disagree", { ...good, ledger: 121 }],
      ["transaction index disagrees", { ...good, transactionIndex: 9 }],
      ["not canonical base64", { ...good, topic: [good.topic[0]! + "\n"] }],
      ["not XDR", { ...good, value: "AAAA" }],
      ["bad hash", { ...good, txHash: "XYZ" }],
      ["not a contract event", { ...good, type: "system" }],
    ];
    for (const [label, bad] of cases) {
      await resetArchive(db);
      const fresh = db;
      const chain = new FakeChain(100, 200).add(transferEvent(TOKEN, 110, bob, alice), bad);
      chain.filterByContract = false;
      await expect(ingestOnce(fresh, chain, cfg, { startLedger: 100 }), label).rejects.toBeInstanceOf(UpstreamDataError);
      expect(await fresh.query("select id from events"), label).toEqual([]);
      expect((await readCoverage(fresh)).ranges, label).toEqual([]);
    }
  });

  it("refuses a payroll event without a u64 company id at topic 1, so a change in the contract's events stops ingest", async () => {
    const good = payslipIssued(PAYROLL, 120, 7n, 1n, bob);
    const shapes: Array<[string, typeof good]> = [];
    shapes.push(
      ["company id as u32", rpcEvent({ ledger: 120, contract: PAYROLL, topics: [sym("payslip_issued"), xdr.ScVal.scvU32(7), u64(1n), addrVal(bob)] })],
      ["company id as i128", rpcEvent({ ledger: 120, contract: PAYROLL, topics: [sym("payslip_issued"), nativeToScVal(7n, { type: "i128" })] })],
      ["company id at topic 2", rpcEvent({ ledger: 120, contract: PAYROLL, topics: [sym("payslip_issued"), addrVal(bob), u64(7n)] })],
      ["no company id", rpcEvent({ ledger: 120, contract: PAYROLL, topics: [sym("payslip_issued")] })],
      ["no event name", rpcEvent({ ledger: 120, contract: PAYROLL, topics: [u64(7n), u64(7n)] })],
    );
    for (const [label, bad] of shapes) {
      await resetArchive(db);
      const chain = new FakeChain(100, 200).add(transferEvent(TOKEN, 110, bob, alice), bad);
      await expect(ingestOnce(db, chain, cfg, { startLedger: 100 }), label).rejects.toThrow(/u64 company id at topic 1/);
      expect(await db.query("select id from events"), label).toEqual([]);
    }
    await resetArchive(db);
    expect((await ingestOnce(db, new FakeChain(100, 200).add(good), cfg, { startLedger: 100 })).eventsStored).toBe(1);
  });

  it("refuses a cursor that does not move forward", async () => {
    const chain = busyChain();
    const page = await chain.getEvents({ startLedger: 100, contractIds: [TOKEN, PAYROLL], limit: 2 });
    let calls = 0;
    const rpc: RpcClient = {
      getHealth: (signal) => chain.getHealth(signal),
      simulateTransaction: () => chain.simulateTransaction(),
      getLedgerEntries: () => chain.getLedgerEntries(),
      getEvents: async () => (calls++ === 0 ? page : { ...page, events: [] }),
    };
    await expect(ingestOnce(db, rpc, cfg, { startLedger: 100, pageLimit: 2 })).rejects.toThrow(/did not advance/);
  });

  it("rejects bad page limits", async () => {
    await expect(ingestOnce(db, busyChain(), cfg, { pageLimit: 0 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("coverage", () => {
  const base = { gaps: [], startLedger: 100, coversFromGenesis: true, latestLedger: 500, lastIngestAt: null };

  it("merges touching and overlapping ranges", () => {
    expect(mergeRanges([[300, 400], [100, 199], [200, 250], [240, 260]])).toEqual([[100, 260], [300, 400]]);
  });

  it("is complete only over ledgers read in full, with nothing missing in between", () => {
    const c = { ...base, ranges: mergeRanges([[100, 200], [301, 500]]) };
    expect(isComplete(c, 1, 200)).toBe(true);
    expect(isComplete(c, 150, 250)).toBe(false);
    expect(isComplete(c, 301, 500)).toBe(true);
    expect(isComplete(c, 301, 501)).toBe(false);
    expect(isComplete(c, 0, 10)).toBe(false);
    expect(isComplete(c, 20, 10)).toBe(false);
    expect(ingestedThrough(c)).toBe(500);
    expect(isComplete({ ...c, coversFromGenesis: false }, 1, 200)).toBe(false);
    const withGap = { ...c, ranges: mergeRanges([[100, 500]]), gaps: [{ fromLedger: 250, toLedger: 260, detectedAt: new Date() }] };
    expect(isComplete(withGap, 240, 250)).toBe(false);
    expect(isComplete(withGap, 261, 500)).toBe(true);
    expect(ingestedFrom({ ...c, ranges: [] })).toBe(0);
  });

  it("parses RPC cursors the way the SDK splits event ids", () => {
    expect(parseRpcCursor("0021775926572404736-0000000002")).toEqual({
      ledger: 5070103,
      txIndex: 13,
      opIndex: 0,
      eventIndex: 2,
      endOfLedger: false,
    });
    expect(parseRpcCursor(endOfLedgerCursor(5070596))).toMatchObject({ ledger: 5070596, endOfLedger: true });
    for (const bad of ["", "1", "x-1", "99999999999999999999-1", "1-99999999999"]) expect(parseRpcCursor(bad)).toBeNull();
  });
});

// Not covered here: real RPC (FakeChain plays one node behind the load
// balancer, with its own floor and reported window; healing a real gap against
// testnet RPC was checked by hand, see threat model C17),
// a real database server (PGlite runs the same SQL, and npm run test:wire runs
// it through the production driver), and two passes healing the same gap at
// once (the second delete finds no row, and events are deduplicated by id).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveHandler } from "../../src/archive/api.ts";
import { coverageOf, isComplete } from "../../src/archive/coverage.ts";
import { readCoverage, type Db } from "../../src/archive/db.ts";
import { ingestOnce, type IngestOptions } from "../../src/archive/ingest.ts";
import { OutboundError } from "../../src/http.ts";
import { createLogger } from "../../src/log.ts";
import { RPC_INVALID_REQUEST, RpcError, type RpcClient, type RpcEvent } from "../../src/rpc.ts";
import { PAYROLL, TOKEN, keypairFor, testConfig } from "../helpers.ts";
import { freshDb, resetArchive } from "../db.ts";
import { FakeChain, payslipIssued, transferEvent } from "./fake-chain.ts";

const cfg = testConfig();
const alice = keypairFor("alice").publicKey();
const bob = keypairFor("bob").publicKey();
const NOW = new Date("2026-10-16T03:00:00Z");

let db: Db;
beforeAll(async () => {
  db = (await freshDb()).db;
});
beforeEach(async () => {
  await resetArchive(db);
});

const pass = (rpc: RpcClient, opts: IngestOptions = {}) => ingestOnce(db, rpc, cfg, { now: () => NOW, ...opts });
const coverage = async () => coverageOf(await readCoverage(db));
const gapsNow = async () => (await coverage()).gaps.map((g) => [g.fromLedger, g.toLedger]);
const ledgersStored = async () => (await db.query<{ ledger: number }>("select ledger from events order by ledger")).map((r) => r.ledger);

/** The health route's own reply. RPC is unreachable, so its catch-up changes nothing. */
async function health(): Promise<Record<string, unknown>> {
  const offline = () => Promise.reject(new Error("offline"));
  const rpc: RpcClient = { getHealth: offline, getEvents: offline, simulateTransaction: offline, getLedgerEntries: offline };
  const res = await archiveHandler(new Request("https://kalypso.test/v1/health"), {
    cfg,
    db: { ingest: db, api: db },
    rpc,
    log: createLogger([], () => undefined),
    now: () => NOW,
  });
  return (await res.json()) as Record<string, unknown>;
}

function withGetEvents(chain: FakeChain, getEvents: RpcClient["getEvents"]): RpcClient {
  return {
    getHealth: (signal) => chain.getHealth(signal),
    getEvents,
    simulateTransaction: () => chain.simulateTransaction(),
    getLedgerEntries: () => chain.getLedgerEntries(),
  };
}

/** Records the startLedger of every getEvents call that starts a read. */
function watchStarts(chain: FakeChain): { rpc: RpcClient; starts: number[] } {
  const starts: number[] = [];
  const rpc = withGetEvents(chain, (query, signal) => {
    if (query.startLedger !== undefined) starts.push(query.startLedger);
    return chain.getEvents(query, signal);
  });
  return { rpc, starts };
}

/** An archive that read [from, through] in full from a node holding exactly that. */
async function archivedThrough(from: number, through: number): Promise<FakeChain> {
  const chain = new FakeChain(from, through);
  await pass(chain, { startLedger: from });
  return chain;
}

function nodeAt(chain: FakeChain, latest: number, oldest: number): FakeChain {
  chain.latestLedger = latest;
  chain.oldestLedger = oldest;
  return chain;
}

/** A node holding everything from ledger 3000. */
const fullNode = (chain: FakeChain, latest: number) => nodeAt(chain, latest, 3000);

/**
 * Ledgers 3000 to 5000 read, except a gap at 4000 to 4500 recorded from a
 * node whose floor was 4501, with a payslip at 4600 already archived. The
 * chain also holds `inGap`, out of reach until a node's floor drops again.
 */
async function archiveWithGap(...inGap: RpcEvent[]): Promise<FakeChain> {
  const chain = await archivedThrough(3000, 3999);
  chain.add(payslipIssued(PAYROLL, 4600, 7n, 3n, bob), ...inGap);
  await pass(nodeAt(chain, 5000, 4501));
  expect(await gapsNow()).toEqual([[4000, 4500]]);
  expect(await ledgersStored()).toEqual([4600]);
  return chain;
}

/** One payslip every 40 ledgers from 4010, all inside the gap. */
const payslipsEvery40 = (n: number) => Array.from({ length: n }, (_, i) => payslipIssued(PAYROLL, 4010 + 40 * i, 7n, BigInt(i + 1), bob));

const payslipsInGap = () => [
  payslipIssued(PAYROLL, 4100, 7n, 1n, alice),
  payslipIssued(PAYROLL, 4200, 7n, 2n, bob),
  payslipIssued(PAYROLL, 4300, 7n, 4n, bob),
];

describe("a node that holds less history than the network", () => {
  it("has the gap recorded from its floor while the forward read goes on, and a later pass on a node holding those ledgers heals it", async () => {
    const chain = await archivedThrough(5000, 6999);
    chain.add(payslipIssued(PAYROLL, 8000, 7n, 1n, bob), transferEvent(TOKEN, 9500, alice, bob));
    // This node restarted and holds 9000 onward; the network still holds 5001 onward.
    const first = await pass(nodeAt(chain, 10_000, 9000));
    expect(first.gaps.map((g) => [g.fromLedger, g.toLedger])).toEqual([[7000, 8999]]);
    expect(first).toMatchObject({ healed: [], ingestedThrough: 10_000, caughtUp: true });
    expect((await coverage()).ranges).toEqual([[5000, 6999], [9000, 10_000]]);
    expect(await ledgersStored()).toEqual([9500]);
    expect(await health()).toMatchObject({ complete: false, alarm: true });

    const second = await pass(nodeAt(chain, 10_000, 5001));
    expect(second).toMatchObject({ gaps: [], healed: [{ fromLedger: 7000, toLedger: 8999 }] });
    expect(await ledgersStored()).toEqual([8000, 9500]);
    expect(await health()).toMatchObject({ complete: true, alarm: false });
  });

  it("does the same when its floor shows only in the retry after getEvents refuses the start ledger", async () => {
    const chain = await archivedThrough(5000, 6999);
    chain.add(payslipIssued(PAYROLL, 8000, 7n, 1n, bob));
    nodeAt(chain, 10_000, 5001);
    let switched = false;
    chain.beforeGetEvents = () => {
      if (!switched) nodeAt(chain, 10_000, 9000);
      switched = true;
    };
    const first = await pass(chain);
    expect(first.gaps.map((g) => [g.fromLedger, g.toLedger])).toEqual([[7000, 8999]]);
    expect(first.ingestedThrough).toBe(10_000);
    expect(await ledgersStored()).toEqual([]);

    chain.beforeGetEvents = null;
    expect((await pass(nodeAt(chain, 10_000, 5001))).healed).toEqual([{ fromLedger: 7000, toLedger: 8999 }]);
    expect(await ledgersStored()).toEqual([8000]);
    expect(isComplete(await coverage(), 5000, 10_000)).toBe(true);
  });
});

describe("healing a recorded gap", () => {
  it("reads the gap in full, stores only the events inside it, and removes it in the same pass", async () => {
    const chain = await archiveWithGap(payslipIssued(PAYROLL, 4200, 7n, 2n, bob));
    // The node now also shows an event past the gap that the forward read
    // never saw, and a newer tip. Neither is the heal's to store or vouch for.
    // One page, spent on the heal, keeps the forward read from reading them.
    chain.add(transferEvent(TOKEN, 4700, alice, bob), transferEvent(TOKEN, 5500, alice, bob));
    const result = await pass(fullNode(chain, 6000), { maxPages: 1 });
    expect(result.healed).toEqual([{ fromLedger: 4000, toLedger: 4500 }]);
    expect(result.gaps).toEqual([]);
    expect(result.eventsStored).toBe(1);
    expect(result.ingestedThrough).toBe(5000);
    expect(await ledgersStored()).toEqual([4200, 4600]);
    const c = await coverage();
    expect(c.ranges).toEqual([[3000, 5000]]);
    expect(isComplete(c, 4000, 4500)).toBe(true);
    expect(isComplete(c, 3000, 5000)).toBe(true);
  });

  it("keeps the gap when the page cap stops the heal halfway, and keeps what it read in full", async () => {
    const chain = await archiveWithGap(...payslipsInGap());
    const result = await pass(fullNode(chain, 5000), { pageLimit: 2, maxPages: 1 });
    expect(result.healed).toEqual([]);
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4100, 4200, 4600]);
    const c = await coverage();
    expect(c.ranges).toEqual([[3000, 4199], [4501, 5000]]);
    expect(isComplete(c, 4000, 4500)).toBe(false);
    expect(isComplete(c, 3000, 4199)).toBe(false);
  });

  it("keeps the gap when its share of the deadline cuts the heal off in the middle of a call", async () => {
    const chain = fullNode(await archiveWithGap(...payslipsInGap()), 5000);
    let calls = 0;
    const rpc = withGetEvents(chain, (query, signal) =>
      calls++ === 0
        ? chain.getEvents(query, signal)
        : new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(new OutboundError("aborted")))),
    );
    // Half of it is long enough for the first page to commit over the wire driver too; the second call waits it out.
    const result = await pass(rpc, { pageLimit: 2, deadlineMs: 1000 });
    expect(result).toMatchObject({ healed: [], caughtUp: true });
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4100, 4200, 4600]);
    expect(isComplete(await coverage(), 4000, 4500)).toBe(false);
  });

  it("refuses a heal reply that breaks the rules, keeps the gap, and logs why", async () => {
    const chain = fullNode(await archiveWithGap(payslipIssued(PAYROLL, 4200, 7n, 2n, bob)), 5000);
    const lines: string[] = [];
    const log = createLogger([], (line) => lines.push(line));
    const failures = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "archive_heal_failed");
    const stray = payslipIssued(PAYROLL, 3999, 7n, 9n, alice);
    const outside = withGetEvents(chain, async (query, signal) => {
      const page = await chain.getEvents(query, signal);
      return query.startLedger === 4000 ? { ...page, events: [stray, ...page.events] } : page;
    });
    await pass(outside, { log });
    expect(failures()).toMatchObject([{ fromLedger: 4000, toLedger: 4500, error: "UpstreamDataError: RPC reply refused: event outside the requested ledgers" }]);
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4600]);

    const full = await chain.getEvents({ startLedger: 4000, contractIds: [TOKEN, PAYROLL], limit: 1 });
    const stuck = withGetEvents(chain, async () => full);
    await pass(stuck, { pageLimit: 1, log });
    expect(failures()[1]).toMatchObject({ error: "UpstreamDataError: RPC reply refused: cursor did not advance" });
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4200, 4600]);
    expect(isComplete(await coverage(), 4000, 4500)).toBe(false);
  });
});

describe("when a heal waits", () => {
  it("heals in the same pass when getHealth answers from a node whose floor is above the gap but getEvents reaches one that holds it", async () => {
    const chain = fullNode(await archiveWithGap(payslipIssued(PAYROLL, 4200, 7n, 2n, bob)), 5000);
    const rpc: RpcClient = {
      ...withGetEvents(chain, (query, signal) => chain.getEvents(query, signal)),
      getHealth: async () => ({ status: "healthy", latestLedger: chain.latestLedger, oldestLedger: 4800 }),
    };
    const result = await pass(rpc);
    expect(result.healed).toEqual([{ fromLedger: 4000, toLedger: 4500 }]);
    expect(await gapsNow()).toEqual([]);
    expect(await ledgersStored()).toEqual([4200, 4600]);
  });

  it("tries a refused heal start page again, and heals when the third try reaches a node that holds the gap", async () => {
    const chain = fullNode(await archiveWithGap(payslipIssued(PAYROLL, 4200, 7n, 2n, bob)), 5000);
    let refusals = 0;
    const { rpc, starts } = watchStarts(chain);
    const flaky = withGetEvents(chain, async (query, signal) => {
      if (query.startLedger === 4000 && refusals < 2) {
        refusals++;
        throw new RpcError(RPC_INVALID_REQUEST, "startLedger must be within the ledger range: 5214911 - 5219384");
      }
      return rpc.getEvents(query, signal);
    });
    const result = await pass(flaky);
    expect(refusals).toBe(2);
    expect(starts).toEqual([4000]);
    expect(result.healed).toEqual([{ fromLedger: 4000, toLedger: 4500 }]);
    expect(await ledgersStored()).toEqual([4200, 4600]);
  });

  it("ends the heal quietly after three refused start pages, keeps the gap, and reads forward", async () => {
    const chain = await archiveWithGap(payslipIssued(PAYROLL, 4200, 7n, 2n, bob));
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    chain.beforeGetEvents = () => {
      chain.oldestLedger = 4300;
    };
    const { rpc, starts } = watchStarts(chain);
    const result = await pass(rpc);
    expect(result).toMatchObject({ healed: [], ingestedThrough: 6000, caughtUp: true });
    expect(starts).toEqual([4000, 4000, 4000, 5001]);
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4600, 5500]);
    // Refused tries spend the heals' share: with a share of one page, one try.
    await pass(rpc, { maxPages: 2 });
    expect(starts).toEqual([4000, 4000, 4000, 5001, 4000]);
  });

  it("leaves the forward read at least half the page cap, however big the gap", async () => {
    const chain = await archiveWithGap(...payslipsEvery40(10));
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    const first = await pass(chain, { pageLimit: 1, maxPages: 3 });
    expect(first.ingestedThrough).toBe(6000);
    expect(await ledgersStored()).toContain(5500);
    for (let i = 0; i < 4; i++) await pass(chain, { pageLimit: 1, maxPages: 3 });
    // A one-event page never finishes ledger 4010, so a heal resuming by
    // ledger cannot get past it; the gap stays and readers are still refused.
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(isComplete(await coverage(), 4000, 4500)).toBe(false);
    expect((await coverage()).ranges).toEqual([[3000, 4009], [4501, 6000]]);
  });

  it("resumes a heal where the last pass stopped, finishes it over three passes, and reads forward every pass", async () => {
    const chain = await archiveWithGap(...payslipsEvery40(8));
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    const opts = { pageLimit: 2, maxPages: 4 };
    expect((await pass(chain, opts)).healed).toEqual([]);
    expect((await coverage()).ranges).toEqual([[3000, 4129], [4501, 6000]]);
    expect(await ledgersStored()).toContain(5500);
    expect((await pass(chain, opts)).healed).toEqual([]);
    expect((await coverage()).ranges).toEqual([[3000, 4249], [4501, 6000]]);
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect((await pass(chain, opts)).healed).toEqual([{ fromLedger: 4000, toLedger: 4500 }]);
    expect(await gapsNow()).toEqual([]);
    expect(await ledgersStored()).toEqual([4010, 4050, 4090, 4130, 4170, 4210, 4250, 4290, 4600, 5500]);
    expect(isComplete(await coverage(), 3000, 6000)).toBe(true);
  });

  it("keeps the gap when a cursor page comes from a node whose floor is above what the heal still has to read", async () => {
    const chain = fullNode(await archiveWithGap(...payslipsInGap()), 5000);
    // This node does not refuse below its floor; it answers with what it holds and says where that starts.
    const rpc = withGetEvents(chain, async (query, signal) => {
      const page = await chain.getEvents(query, signal);
      if (query.cursor === undefined) return page;
      return { ...page, events: page.events.filter((e) => e.ledger >= 4501), oldestLedger: 4501 };
    });
    const result = await pass(rpc, { pageLimit: 2 });
    expect(result.healed).toEqual([]);
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4100, 4200, 4600]);
    expect((await coverage()).ranges).toEqual([[3000, 4199], [4501, 5000]]);
  });

  it("keeps the gap when heal pages do not say where their node's history starts, and still reads forward", async () => {
    const chain = await archiveWithGap(...payslipsInGap());
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    const rpc = withGetEvents(chain, async (query, signal) => {
      const page = await chain.getEvents(query, signal);
      delete page.oldestLedger;
      return page;
    });
    const result = await pass(rpc);
    expect(result).toMatchObject({ healed: [], ingestedThrough: 6000 });
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4600, 5500]);
  });

  it("stores nothing from a forward page whose node's floor is above the next ledger, and ends the pass quietly", async () => {
    const chain = await archivedThrough(3000, 5000);
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    chain.latestLedger = 6000;
    const rpc = withGetEvents(chain, async (query, signal) => {
      const page = await chain.getEvents(query, signal);
      return { ...page, events: page.events.filter((e) => e.ledger >= 5600), oldestLedger: 5600 };
    });
    const result = await pass(rpc);
    expect(result).toMatchObject({ healed: [], gaps: [], ingestedThrough: 5000, caughtUp: false });
    expect((await coverage()).ranges).toEqual([[3000, 5000]]);
    expect(await ledgersStored()).toEqual([]);
  });

  it("ends the heal quietly when a short node refuses its cursor page, keeps what it read in full, and reads forward", async () => {
    const chain = await archiveWithGap(...payslipsInGap());
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    let refused = false;
    const rpc = withGetEvents(chain, async (query, signal) => {
      if (query.cursor !== undefined && !refused) {
        refused = true;
        throw new RpcError(RPC_INVALID_REQUEST, "startLedger must be within the ledger range: 5214911 - 5219384");
      }
      return chain.getEvents(query, signal);
    });
    const result = await pass(rpc, { pageLimit: 2 });
    expect(refused).toBe(true);
    expect(result).toMatchObject({ healed: [], ingestedThrough: 6000, caughtUp: true });
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toEqual([4100, 4200, 4600, 5500]);
    const c = await coverage();
    expect(c.ranges).toEqual([[3000, 4199], [4501, 6000]]);
    expect(isComplete(c, 4000, 4500)).toBe(false);
  });
});

describe("what a heal may cost the forward read", () => {
  it("leaves the forward read the second half of the pass when a heal keeps meeting a node that refuses it", async () => {
    const chain = await archivedThrough(5000, 6999);
    await pass(nodeAt(chain, 10_000, 9000));
    expect(await gapsNow()).toEqual([[7000, 8999]]);
    chain.add(transferEvent(TOKEN, 10_500, alice, bob));
    chain.latestLedger = 11_000;
    chain.delayMs = 100;
    for (let i = 0; i < 3; i++) await pass(chain, { deadlineMs: 350 });
    expect(await ledgersStored()).toContain(10_500);
    expect(await gapsNow()).toEqual([[7000, 8999]]);
  });

  it("stops a slow heal at half the pass's deadline, keeps the gap, and lets the forward read store a later event", async () => {
    const chain = await archiveWithGap(...payslipsEvery40(10));
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    chain.delayMs = 100;
    const result = await pass(chain, { pageLimit: 1, deadlineMs: 1000 });
    expect(result).toMatchObject({ healed: [], ingestedThrough: 6000, caughtUp: true });
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    expect(await ledgersStored()).toContain(5500);
  });

  it("never asks for a gap that starts before the window getHealth reports RPC keeping, and keeps it recorded and alarmed", async () => {
    const chain = await archivedThrough(5000, 6999);
    await pass(nodeAt(chain, 10_000, 9000));
    // This node keeps 9000 to 10000 and says so.
    chain.retentionWindow = 1001;
    const { rpc, starts } = watchStarts(chain);
    const result = await pass(rpc);
    expect(starts).toEqual([]);
    expect(result.gaps.map((g) => [g.fromLedger, g.toLedger])).toEqual([[7000, 8999]]);
    expect(await health()).toMatchObject({ alarm: true, alarm_reasons: ["permanent_gap"] });
  });

  it("takes RPC's default seven-day window when getHealth reports none", async () => {
    const chain = await archivedThrough(5000, 6999);
    await pass(nodeAt(chain, 10_000, 9000));
    // 130,000 less 120,960 plus one is 9,041, past the gap's first ledger.
    const { rpc, starts } = watchStarts(nodeAt(chain, 130_000, 9000));
    await pass(rpc);
    expect(starts).toEqual([10_001]);
    expect(await gapsNow()).toEqual([[7000, 8999]]);
  });

  it("logs a heal that fails, keeps its gap, and still reads forward, pass after pass", async () => {
    const chain = await archiveWithGap(payslipIssued(PAYROLL, 4200, 7n, 2n, bob));
    chain.add(transferEvent(TOKEN, 5500, alice, bob));
    fullNode(chain, 6000);
    const rpc = withGetEvents(chain, async (query, signal) => {
      if (query.startLedger === 4000) throw new RpcError("http_status", "502");
      return chain.getEvents(query, signal);
    });
    const lines: string[] = [];
    const log = createLogger([], (line) => lines.push(line));
    for (let i = 0; i < 2; i++) expect(await pass(rpc, { log })).toMatchObject({ healed: [], ingestedThrough: 6000 });
    expect(await ledgersStored()).toEqual([4600, 5500]);
    expect(await gapsNow()).toEqual([[4000, 4500]]);
    const failures = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "archive_heal_failed");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ level: "warn", fromLedger: 4000, toLedger: 4500, error: "RpcError: rpc error http_status" });
  });
});

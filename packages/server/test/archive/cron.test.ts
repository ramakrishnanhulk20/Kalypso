// Not covered here: the scheduler itself (Vercel Cron or a GitHub job calling
// this route on a timetable), real RPC (scripts/smoke-rpc.mjs reads live
// testnet), and a real database server (PGlite runs the same SQL in process).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { coverageOf, ingestedThrough } from "../../src/archive/coverage.ts";
import { INGEST_CRON_DEADLINE_MS, ingestCronHandler, type IngestCronContext } from "../../src/archive/cron.ts";
import { readCoverage, type Db } from "../../src/archive/db.ts";
import { createLogger } from "../../src/log.ts";
import { RpcError } from "../../src/rpc.ts";
import { CRON_SECRET, TOKEN, keypairFor, testConfig } from "../helpers.ts";
import { freshDb, resetArchive } from "../db.ts";
import { FakeChain, mergeEvent, transferEvent } from "./fake-chain.ts";

const cfg = testConfig();
const alice = keypairFor("alice").publicKey();
const bob = keypairFor("bob").publicKey();
const NOW = new Date("2026-10-07T12:00:00Z");

let db: Db;
let chain: FakeChain;
const logs: string[] = [];

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await resetArchive(db);
  chain = new FakeChain(100, 500).add(transferEvent(TOKEN, 120, alice, bob), mergeEvent(TOKEN, 140, bob));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The logger is given no secrets to scrub, so a secret in a log line would show.
const context = (overrides: Partial<IngestCronContext> = {}): IngestCronContext => ({
  cfg,
  db,
  rpc: chain,
  log: createLogger([], (line) => logs.push(line)),
  archiveStartLedger: 100,
  now: () => NOW,
  ...overrides,
});

async function call(headers: Record<string, string>, ctx = context(), method = "POST") {
  const res = await ingestCronHandler(new Request("https://kalypso.test/api/archive/ingest", { method, headers }), ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const bearer = (secret: string) => ({ authorization: "Bearer " + secret });
const archivedThrough = async () => ingestedThrough(coverageOf(await readCoverage(db)));

describe("POST /api/archive/ingest", () => {
  it("refuses a missing or wrong secret with 401 and no detail, and ingests nothing", async () => {
    const wrong: Array<Record<string, string>> = [
      {},
      bearer(""),
      bearer("x"),
      bearer(CRON_SECRET.slice(0, -1) + "X"),
      bearer(CRON_SECRET + "x"),
      { authorization: CRON_SECRET },
      { authorization: "bearer " + CRON_SECRET },
      { authorization: "Basic " + CRON_SECRET },
      { "x-cron-secret": CRON_SECRET },
    ];
    for (const headers of wrong) {
      expect(await call(headers), JSON.stringify(headers).slice(0, 30)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    expect(chain.calls).toBe(0);
    expect(await archivedThrough()).toBe(0);
    expect(logs.at(-1)).toContain('"event":"archive_cron_refused"');
    expect(logs.join("\n")).not.toContain(CRON_SECRET);
  });

  it("runs one ingest pass with the right secret, with a 25 s deadline, and reports what it did", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const res = await call(bearer(CRON_SECRET));
    expect(res).toEqual({
      status: 200,
      body: { ingested_through: 500, events_stored: 2, pages: 1, caught_up: true, gaps: 0 },
    });
    expect(await archivedThrough()).toBe(500);
    expect(INGEST_CRON_DEADLINE_MS).toBe(25_000);
    expect(timeout).toHaveBeenCalledWith(25_000);
    expect(logs.at(-1)).toContain('"event":"archive_cron_ingested"');
  });

  it("stops starting RPC calls at the deadline and still answers", async () => {
    chain.delayMs = 60_000;
    const started = Date.now();
    const res = await call(bearer(CRON_SECRET), context({ deadlineMs: 50 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res).toMatchObject({ status: 200, body: { caught_up: false, ingested_through: 0 } });
  });

  it("answers 503 when the pass fails, so the scheduled run shows as failed", async () => {
    const down = { ...context(), rpc: { ...chain, getHealth: async () => Promise.reject(new RpcError("http_status", "502")), getEvents: chain.getEvents.bind(chain), simulateTransaction: chain.simulateTransaction, getLedgerEntries: chain.getLedgerEntries } };
    expect(await call(bearer(CRON_SECRET), down)).toEqual({ status: 503, body: { error: "ingest_failed" } });
    expect(logs.at(-1)).toContain('"event":"archive_cron_failed"');
    expect(logs.at(-1)).toContain('"rpcCode":"http_status"');
  });

  it("answers 405 to any method but POST, before looking at the secret", async () => {
    const res = await call(bearer(CRON_SECRET), context(), "GET");
    expect(res).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    expect(await archivedThrough()).toBe(0);
  });
});

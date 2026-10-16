// Covers POST /api/faucet against a fake ledger that checks the faucet's signature and sequence
// number and applies each payout the way the network would: a createAccount for a missing account
// and a payment for an existing one, each envelope decoded to exactly one operation to exactly the
// requested address with only the faucet as source; USDC only into an authorised trustline with
// room; every refusal code; the per-IP request count before the body is read; the daily limits per
// address and asset, per IP (IPv6 by /48) and service-wide; the claim given back on every provable
// failure and kept when the outcome is unknown; the lock serialising two claims at once and a held
// lock answering faucet_busy; and the log lines (C36).
// Does NOT cover: live RPC or a real Postgres server (PGlite runs the same SQL, and
// `npm run test:wire` runs it through the production driver), two server instances contending for
// the advisory lock (one PGlite is one session, so a held lock is played by a stand-in connection;
// that pg_try_advisory_xact_lock refuses a second session is Postgres's own guarantee), and the
// live payouts, which a testnet run outside this suite records.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Asset, Keypair, StrKey, type Transaction } from "@stellar/stellar-sdk";
import type { Db } from "../../src/archive/db.ts";
import { secretValues } from "../../src/config.ts";
import { FEE_RESERVE_STROOPS, faucetHandler, type FaucetContext } from "../../src/faucet/handler.ts";
import { FAUCET_MAX_MS } from "../../src/faucet/limits.ts";
import { FAUCET_MAX_FEE_STROOPS } from "../../src/faucet/signer.ts";
import { createLogger } from "../../src/log.ts";
import { ipTag } from "../../src/sponsor/client-ip.ts";
import { clearTables, freshDb } from "../db.ts";
import { LOG_SALT, contractFor, keypairFor, testConfig } from "../helpers.ts";
import { FakeLedger, USDC_ASSET, XLM } from "./fake-ledger.ts";

const FAUCET = keypairFor("faucet");
const IP = "203.0.113.20";
const NOW = new Date("2026-10-11T12:00:00Z");
const HUNDRED = 100n * XLM;
// One subentry: the faucet's own USDC trustline.
const FAUCET_MINIMUM = 3n * 5_000_000n;

let db: Db;
let logs: string[] = [];

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await clearTables(db, ["ip_hour", "address_day"]);
  logs = [];
});

function setup(env: Record<string, string> = {}, ctxOverrides: Partial<FaucetContext> = {}) {
  const chain = new FakeLedger(FAUCET).fund(FAUCET.publicKey(), 10_000n * XLM, { subentries: 1 }).trust(FAUCET.publicKey(), 2_000n * XLM);
  const cfg = testConfig({ FAUCET_SECRET_KEY: FAUCET.secret(), ...env });
  const ctx: FaucetContext = {
    cfg,
    db,
    rpc: chain,
    log: createLogger(secretValues(cfg), (line) => logs.push(line)),
    now: () => NOW,
    fetchImpl: chain.fetch,
    maxMs: 300,
    pollIntervalMs: 1,
    ...ctxOverrides,
  };
  return { chain, ctx };
}

function claim(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://kalypso.test/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": IP, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ask = async (ctx: FaucetContext, body: unknown, headers?: Record<string, string>) => read(await faucetHandler(claim(body, headers), ctx));
const refusal = (status: number, error: string) => ({ status, body: { error } });
const paid = (asset: "xlm" | "usdc") => ({ status: 200, body: { hash: expect.stringMatching(/^[0-9a-f]{64}$/), asset, amount: "1000000000" } });
const unconfirmed = (hash: string) => ({ status: 503, body: { error: "payout_unconfirmed", hash } });
const fresh = () => Keypair.random().publicKey();
const counted = async () => (await db.query<{ address: string; count: number }>("select address, count from address_day order by address")).map((r) => [r.address, r.count]);

/**
 * `db`, except inside the faucet lock's own transaction: "held" answers the lock query as taken by
 * another session, "reset" fails it, "cut" lets the claim run and then fails the commit, and
 * "watch" changes nothing. Every play counts the lock attempts in `attempts.count`.
 */
function lockStandIn(play: "held" | "reset" | "cut" | "watch", attempts = { count: 0 }): Db {
  return {
    ...db,
    transaction: async (fn) => {
      const seen = { lock: false };
      const value = await db.transaction((tx) =>
        fn({
          ...tx,
          query: (async (text: string, params?: readonly unknown[]) => {
            if (!/advisory/.test(text)) return tx.query(text, params);
            seen.lock = true;
            attempts.count++;
            if (play === "held") return [{ locked: false }];
            if (play === "reset") throw new Error("connection reset");
            return tx.query(text, params);
          }) as Db["query"],
        }),
      );
      if (seen.lock && play === "cut") throw new Error("terminating connection");
      return value;
    },
  };
}

/** The one operation the envelope carries, after checking it is exactly one, from only the faucet, signed by it, fee and time bounded. */
function onlyOperation(tx: Transaction) {
  expect(tx.source).toBe(FAUCET.publicKey());
  expect(tx.operations).toHaveLength(1);
  expect(tx.operations[0]!.source).toBeUndefined();
  expect(tx.signatures).toHaveLength(1);
  expect(FAUCET.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  expect(BigInt(tx.fee)).toBeLessThanOrEqual(FAUCET_MAX_FEE_STROOPS);
  expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(NOW.getTime() / 1000 + 60) });
  expect(tx.memo.type).toBe("none");
  return tx.operations[0]!;
}

describe("POST /api/faucet", () => {
  it("creates a missing account with createAccount, and pays an existing one with a native payment, each to exactly that address", async () => {
    const { chain, ctx } = setup();
    const newcomer = fresh();
    const created = await ask(ctx, { address: newcomer, asset: "xlm" });
    expect(created).toEqual(paid("xlm"));
    const create = onlyOperation(chain.envelope(0));
    expect(create).toMatchObject({ type: "createAccount", destination: newcomer, startingBalance: "100.0000000" });
    expect(created.body.hash).toBe(chain.envelope(0).hash().toString("hex"));
    expect(chain.getTransaction).toHaveBeenCalledWith(created.body.hash, expect.any(AbortSignal));
    expect(chain.accounts.get(newcomer)?.balance).toBe(HUNDRED);

    const existing = fresh();
    chain.fund(existing, 5n * XLM);
    expect(await ask(ctx, { address: existing, asset: "xlm" }, { "x-real-ip": "198.51.100.4" })).toEqual(paid("xlm"));
    const payment = onlyOperation(chain.envelope(1));
    expect(payment).toMatchObject({ type: "payment", destination: existing, amount: "100.0000000" });
    expect(payment.type === "payment" && payment.asset.isNative()).toBe(true);
    expect(chain.accounts.get(existing)?.balance).toBe(105n * XLM);
    expect(BigInt(chain.envelope(1).sequence)).toBe(BigInt(chain.envelope(0).sequence) + 1n);
  });

  it("pays 100 of Circle's testnet USDC into an authorised trustline, in one payment to exactly that address", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    chain.fund(worker, 5n * XLM, { subentries: 1 }).trust(worker);
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(paid("usdc"));
    const op = onlyOperation(chain.envelope(0));
    expect(op).toMatchObject({ type: "payment", destination: worker, amount: "100.0000000" });
    expect(op.type === "payment" && op.asset.equals(USDC_ASSET)).toBe(true);
    expect(chain.lines.get(worker)?.balance).toBe(HUNDRED);
    expect(chain.lines.get(FAUCET.publicKey())?.balance).toBe(1_900n * XLM);
  });

  it("refuses USDC with 409 no_account, no_trustline, trustline_unauthorized or trustline_full, sends nothing and counts no claim", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(409, "no_account"));
    chain.fund(worker, 5n * XLM);
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(409, "no_trustline"));
    chain.trust(worker, 0n, { authorized: false });
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(409, "trustline_unauthorized"));
    chain.trust(worker, 0n, { limit: HUNDRED - 1n });
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(409, "trustline_full"));
    chain.trust(worker, 60n * XLM, { limit: HUNDRED + 50n * XLM });
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(409, "trustline_full"));
    expect(chain.received).toEqual([]);
    expect(await counted()).toEqual([]);
    chain.trust(worker);
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(paid("usdc"));
  });

  it("lets each address claim each asset once per UTC day, refusing the next with already_claimed", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    chain.fund(worker, 5n * XLM).trust(worker);
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(paid("xlm"));
    expect(await ask(ctx, { address: worker, asset: "xlm" }, { "x-real-ip": "198.51.100.9" })).toEqual(refusal(429, "already_claimed"));
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(paid("usdc"));
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(429, "already_claimed"));
    const tomorrow = { ...ctx, now: () => new Date(NOW.getTime() + 86_400_000) };
    expect(await ask(tomorrow, { address: worker, asset: "xlm" })).toEqual(paid("xlm"));
    expect(chain.received).toHaveLength(3);
  });

  it("holds each caller to FAUCET_CLAIMS_PER_IP_PER_DAY with IPv6 counted by /48 (network_limit), and gives the address back when it refuses", async () => {
    const { ctx } = setup({ FAUCET_CLAIMS_PER_IP_PER_DAY: "2" });
    expect(await ask(ctx, { address: fresh(), asset: "xlm" }, { "x-real-ip": "2001:db8:1:1::1" })).toEqual(paid("xlm"));
    expect(await ask(ctx, { address: fresh(), asset: "xlm" }, { "x-real-ip": "2001:db8:1:2::1" })).toEqual(paid("xlm"));
    const third = fresh();
    expect(await ask(ctx, { address: third, asset: "xlm" }, { "x-real-ip": "2001:db8:1:3::5" })).toEqual(refusal(429, "network_limit"));
    expect(await ask(ctx, { address: third, asset: "xlm" }, { "x-real-ip": "2001:db8:2:1::1" })).toEqual(paid("xlm"));
    // The /48's count is stored under its salted tag, never the IP itself.
    const rows = (await counted()).map(([key]) => String(key));
    expect(rows).toContain("faucet caller " + ipTag("2001:db8:1::/48", LOG_SALT));
    expect(rows.join(" ")).not.toContain("2001:db8");
  });

  it("holds the whole service to FAUCET_CLAIMS_PER_DAY (daily_limit), giving back the address and caller counts it took first", async () => {
    const { ctx } = setup({ FAUCET_CLAIMS_PER_DAY: "1" });
    expect(await ask(ctx, { address: fresh(), asset: "xlm" })).toEqual(paid("xlm"));
    const second = fresh();
    expect(await ask(ctx, { address: second, asset: "xlm" }, { "x-real-ip": "198.51.100.30" })).toEqual(refusal(429, "daily_limit"));
    expect((await counted()).map(([key]) => String(key)).filter((key) => key.includes(second))).toEqual([]);
    expect(await counted()).toContainEqual(["faucet claims", 1]);
  });

  it("counts every request against its IP before the body is read, so refused bodies use up the hour too (rate_limited)", async () => {
    const { chain, ctx } = setup({ PER_IP_LIMIT_PER_HOUR: "2" });
    expect(await ask(ctx, "{not json")).toEqual(refusal(400, "bad_request"));
    expect(await ask(ctx, { address: "nope", asset: "xlm" })).toEqual(refusal(400, "bad_address"));
    expect(await ask(ctx, { address: fresh(), asset: "xlm" })).toEqual(refusal(429, "rate_limited"));
    expect(chain.getLedgerEntries).not.toHaveBeenCalled();
    expect(chain.fetch).not.toHaveBeenCalled();
    expect(await ask(ctx, { address: fresh(), asset: "xlm" }, { "x-real-ip": "198.51.100.2" })).toEqual(paid("xlm"));
  });

  it("refuses a malformed body with bad_request and any address but a plain G account with bad_address, before counting a claim", async () => {
    const { chain, ctx } = setup({ PER_IP_LIMIT_PER_HOUR: "100" });
    const worker = fresh();
    const badRequests: unknown[] = [
      "{",
      "[]",
      "null",
      { address: worker },
      { address: worker, asset: "xlm", amount: "1000" },
      { address: worker, asset: "XLM" },
      { address: worker, asset: "eurc" },
      { address: worker, asset: 1 },
      { address: worker, asset: "xlm", pad: "x".repeat(1_100) },
    ];
    for (const body of badRequests) expect(await ask(ctx, body), JSON.stringify(body).slice(0, 60)).toEqual(refusal(body && typeof body === "object" && "pad" in body ? 413 : 400, "bad_request"));
    expect(await read(await faucetHandler(claim({ address: worker, asset: "xlm" }, { "content-type": "text/plain" }), ctx))).toEqual(refusal(415, "bad_request"));
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(worker), Buffer.alloc(8, 1)]));
    for (const address of [worker.toLowerCase(), " " + worker, muxed, contractFor("wallet"), FAUCET.secret(), FAUCET.publicKey(), 42, null]) {
      expect(await ask(ctx, { address, asset: "xlm" }), String(address)).toEqual(refusal(400, "bad_address"));
    }
    expect(await counted()).toEqual([]);
    expect(chain.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("answers faucet_empty when the faucet cannot cover a claim plus its fee reserve, sends nothing, and gives the claim back", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    chain.fund(worker, 5n * XLM).trust(worker);
    // Open selling offers and sponsored entries hold XLM too; only what is left above them counts.
    chain.fund(FAUCET.publicKey(), FAUCET_MINIMUM + 5_000_000n + 2n * XLM + HUNDRED + FEE_RESERVE_STROOPS - 1n, { subentries: 1, selling: 2n * XLM, sponsoring: 1 });
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(refusal(503, "faucet_empty"));
    chain.trust(FAUCET.publicKey(), HUNDRED + 5n, { selling: 6n });
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(503, "faucet_empty"));
    chain.fund(FAUCET.publicKey(), FAUCET_MINIMUM + FEE_RESERVE_STROOPS - 1n, { subentries: 1 }).trust(FAUCET.publicKey(), 2_000n * XLM);
    expect(await ask(ctx, { address: worker, asset: "usdc" })).toEqual(refusal(503, "faucet_empty"));
    chain.accounts.delete(FAUCET.publicKey());
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(refusal(503, "faucet_empty"));
    expect(chain.received).toEqual([]);
    expect(await counted()).toEqual([]);
    expect(logs.filter((line) => line.includes('"event":"faucet_low"'))).toHaveLength(4);

    chain.fund(FAUCET.publicKey(), FAUCET_MINIMUM + 5_000_000n + 2n * XLM + HUNDRED + FEE_RESERVE_STROOPS, { subentries: 1, selling: 2n * XLM, sponsoring: 1 });
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(paid("xlm"));
  });

  it("serialises two claims at once under the lock: both pay, on consecutive sequence numbers", async () => {
    const { chain, ctx } = setup();
    const [a, b] = await Promise.all([ask(ctx, { address: fresh(), asset: "xlm" }), ask(ctx, { address: fresh(), asset: "xlm" }, { "x-real-ip": "198.51.100.3" })]);
    expect([a, b]).toEqual([paid("xlm"), paid("xlm")]);
    expect(chain.received.map((_, i) => BigInt(chain.envelope(i).sequence))).toEqual([1_001n, 1_002n]);
  });

  it("answers faucet_busy at once while another claim holds the faucet lock, and gives the claim back", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    expect(await ask({ ...ctx, db: lockStandIn("held") }, { address: worker, asset: "xlm" })).toEqual(refusal(503, "faucet_busy"));
    // Only the destination read, which comes before the lock; nothing was sent.
    expect(chain.getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(chain.fetch).not.toHaveBeenCalled();
    expect(await counted()).toEqual([]);
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(paid("xlm"));
  });

  it("gives the claim back when core refuses the payout: TRY_AGAIN_LATER and txBAD_SEQ are faucet_busy, txINSUFFICIENT_BALANCE is faucet_empty", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    const refusals = [
      ["try_again_later", "faucet_busy"],
      ["error_bad_seq", "faucet_busy"],
      ["error_unreadable", "faucet_busy"],
      ["error_insufficient_balance", "faucet_empty"],
    ] as const;
    for (const [send, code] of refusals) {
      chain.send = send;
      expect(await ask(ctx, { address: worker, asset: "xlm" }), send).toEqual(refusal(503, code));
      expect(await counted(), send).toEqual([]);
    }
    expect(chain.getTransaction).not.toHaveBeenCalled();
    chain.send = "ok";
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(paid("xlm"));
  });

  it("checks the destination before the lock: no_account and no_trustline never take the faucet lock", async () => {
    const { chain, ctx } = setup();
    const attempts = { count: 0 };
    const watched = { ...ctx, db: lockStandIn("watch", attempts) };
    const worker = fresh();
    expect(await ask(watched, { address: worker, asset: "usdc" })).toEqual(refusal(409, "no_account"));
    chain.fund(worker, 5n * XLM);
    expect(await ask(watched, { address: worker, asset: "usdc" })).toEqual(refusal(409, "no_trustline"));
    expect(attempts.count).toBe(0);
    chain.trust(worker);
    expect(await ask(watched, { address: worker, asset: "usdc" })).toEqual(paid("usdc"));
    expect(attempts.count).toBe(1);
  });

  it("keeps the claim when a payout fails on chain for a cause the destination made: trustline removed, line full or unauthorised, account merged", async () => {
    const { chain, ctx } = setup();
    const moves: Array<[string, "xlm" | "usdc", (worker: string) => void]> = [
      ["trustline removed in the same ledger", "usdc", (worker) => chain.lines.delete(worker)],
      ["line filled", "usdc", (worker) => chain.trust(worker, 0n, { limit: 1n })],
      ["line no longer authorised", "usdc", (worker) => chain.trust(worker, 0n, { authorized: false })],
      ["account merged away", "xlm", (worker) => chain.accounts.delete(worker)],
    ];
    for (const [label, asset, move] of moves) {
      const worker = fresh();
      chain.fund(worker, 5n * XLM).trust(worker);
      chain.beforeApply = () => move(worker);
      expect(await ask(ctx, { address: worker, asset }, { "x-real-ip": "198.51.100." + label.length }), label).toEqual(refusal(409, "payout_failed"));
      expect(await counted(), label).toContainEqual(["faucet " + asset + " " + worker, 1]);
      chain.beforeApply = null;
      chain.fund(worker, 5n * XLM).trust(worker);
      expect(await ask(ctx, { address: worker, asset }, { "x-real-ip": "198.51.100." + label.length }), label).toEqual(refusal(429, "already_claimed"));
    }
    const causes = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "faucet_payout_failed");
    expect(causes.map((line) => [line.cause, line.claim])).toEqual([
      ["paymentNoTrust", "kept"],
      ["paymentLineFull", "kept"],
      ["paymentNotAuthorized", "kept"],
      ["paymentNoDestination", "kept"],
    ]);
  });

  it("gives the claim back when a payout fails on chain for a cause on the faucet's side, so the retry runs every check again", async () => {
    const { chain, ctx } = setup();
    const usdcWorker = fresh();
    chain.fund(usdcWorker, 5n * XLM).trust(usdcWorker);
    chain.beforeApply = () => chain.trust(FAUCET.publicKey(), 0n);
    expect(await ask(ctx, { address: usdcWorker, asset: "usdc" })).toEqual(refusal(503, "faucet_empty"));
    const newcomer = fresh();
    chain.beforeApply = () => chain.fund(newcomer, 1n * XLM);
    expect(await ask(ctx, { address: newcomer, asset: "xlm" })).toEqual(refusal(503, "faucet_busy"));
    chain.beforeApply = null;
    chain.landing = "failed";
    chain.failWith = "txBadSeq";
    const third = fresh();
    expect(await ask(ctx, { address: third, asset: "xlm" })).toEqual(refusal(503, "faucet_busy"));
    expect(await counted()).toEqual([]);

    chain.landing = "apply";
    chain.trust(FAUCET.publicKey(), 2_000n * XLM);
    expect(await ask(ctx, { address: usdcWorker, asset: "usdc" })).toEqual(paid("usdc"));
    expect(await ask(ctx, { address: newcomer, asset: "xlm" })).toEqual(paid("xlm"));
    expect(onlyOperation(chain.envelope(chain.received.length - 1)).type).toBe("payment");
    expect(await ask(ctx, { address: third, asset: "xlm" })).toEqual(paid("xlm"));
  });

  it("keeps the claim when a failure's cause cannot be read, failing closed", async () => {
    const { chain, ctx } = setup();
    chain.landing = "failed";
    chain.failWith = "unreadable";
    const first = fresh();
    expect(await ask(ctx, { address: first, asset: "xlm" })).toEqual(refusal(409, "payout_failed"));
    chain.failWith = "paymentNoTrust";
    const others: string[] = [];
    for (const causeRead of ["http_500", "network", "not_json"] as const) {
      chain.causeRead = causeRead;
      const worker = fresh();
      others.push(worker);
      expect(await ask(ctx, { address: worker, asset: "xlm" }, { "x-real-ip": "198.51.100." + causeRead.length }), causeRead).toEqual(refusal(409, "payout_failed"));
    }
    const rows = (await counted()).map(([key]) => String(key));
    expect(rows).toEqual(expect.arrayContaining([first, ...others].map((worker) => "faucet xlm " + worker)));
  });

  it("confirms by its own hash a payout whose send answer was lost or garbled, and when nothing confirms it keeps the claim and answers payout_unconfirmed with the hash", async () => {
    const { chain, ctx } = setup();
    for (const send of ["network", "http_500", "not_json", "bad_reply", "other_hash"] as const) {
      chain.send = send;
      expect(await ask(ctx, { address: fresh(), asset: "xlm" }, { "x-real-ip": "198.51.100." + (20 + send.length) }), send).toEqual(paid("xlm"));
    }
    chain.send = "ok";
    chain.landing = "never";
    const worker = fresh();
    const sent = chain.received.length;
    const answer = await ask(ctx, { address: worker, asset: "xlm" });
    expect(answer).toEqual(unconfirmed(chain.envelope(sent).hash().toString("hex")));
    expect(await counted()).toContainEqual(["faucet xlm " + worker, 1]);
    chain.landing = "apply";
    expect(await ask(ctx, { address: worker, asset: "xlm" })).toEqual(refusal(429, "already_claimed"));
  });

  it("ends every claim at its one deadline when RPC stalls: a stalled read gives the claim back, a stalled send or last poll keeps it", async () => {
    const { chain, ctx } = setup();
    const cases = [
      ["read", "rpc_unavailable", false],
      ["send", "payout_unconfirmed", true],
      ["poll", "payout_unconfirmed", true],
    ] as const;
    for (const [stall, code, kept] of cases) {
      chain.stall = stall;
      const worker = fresh();
      const started = performance.now();
      const answer = await ask(ctx, { address: worker, asset: "xlm" });
      const elapsed = performance.now() - started;
      expect(answer.body.error, stall).toBe(code);
      // It waited for the bound (300 ms in this file) and not much past it.
      expect(elapsed, stall).toBeGreaterThanOrEqual(250);
      expect(elapsed, stall).toBeLessThan(1_000);
      expect((await counted()).some(([key]) => String(key).includes(worker)), stall).toBe(kept);
    }
    expect(FAUCET_MAX_MS).toBe(45_000);
  });

  it("never reports success from an RPC that names some other transaction or an unreadable one: payout_unconfirmed, claim kept", async () => {
    const { chain, ctx } = setup();
    for (const landing of ["lie", "garbled"] as const) {
      chain.landing = landing;
      const worker = fresh();
      const sent = chain.received.length;
      const answer = await ask(ctx, { address: worker, asset: "xlm" }, { "x-real-ip": "198.51.100." + landing.length });
      expect(answer, landing).toEqual(unconfirmed(chain.envelope(sent).hash().toString("hex")));
      expect(await counted()).toContainEqual(["faucet xlm " + worker, 1]);
    }
  });

  it("answers rpc_unavailable when the ledger read fails, sends nothing, and gives the claim back; undecodable entries read as missing", async () => {
    const { chain, ctx } = setup();
    chain.readFails = true;
    expect(await ask(ctx, { address: fresh(), asset: "xlm" })).toEqual(refusal(503, "rpc_unavailable"));
    expect(chain.received).toEqual([]);
    expect(await counted()).toEqual([]);
    chain.readFails = false;
    // The destination read before the lock passes and the faucet's own read inside it fails.
    let reads = 0;
    const second = {
      getTransaction: chain.getTransaction,
      getLedgerEntries: async (keys: readonly string[], signal?: AbortSignal) => {
        if (++reads === 2) throw new Error("connection reset");
        return chain.getLedgerEntries(keys, signal);
      },
    };
    expect(await ask({ ...ctx, rpc: second }, { address: fresh(), asset: "xlm" })).toEqual(refusal(503, "rpc_unavailable"));
    expect(reads).toBe(2);
    expect(chain.received).toEqual([]);
    expect(await counted()).toEqual([]);
    chain.garbage = true;
    expect(await ask(ctx, { address: fresh(), asset: "xlm" })).toEqual(paid("xlm"));
  });

  it("answers 503 not_configured without FAUCET_SECRET_KEY or Circle's USDC, before counting or reading anything", async () => {
    const { chain, ctx } = setup();
    for (const cfg of [testConfig(), { ...ctx.cfg, USDC_SAC_ID: new Asset("USDC", FAUCET.publicKey()).contractId(ctx.cfg.NETWORK_PASSPHRASE) }]) {
      expect(await ask({ ...ctx, cfg }, { address: fresh(), asset: "xlm" })).toEqual(refusal(503, "not_configured"));
    }
    expect(await db.query("select * from ip_hour")).toEqual([]);
    expect(chain.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("refuses another method and a request it cannot place, and reports an unexpected failure as 500 with the claim given back", async () => {
    const { ctx } = setup();
    const get = await faucetHandler(new Request("https://kalypso.test/api/faucet", { headers: { "x-real-ip": IP } }), ctx);
    expect(get.headers.get("allow")).toBe("POST");
    expect(await read(get)).toEqual(refusal(405, "method_not_allowed"));
    expect(await ask(ctx, { address: fresh(), asset: "xlm" }, { "x-real-ip": "not an ip" })).toEqual(refusal(400, "no_client_ip"));
    expect(await ask({ ...ctx, db: lockStandIn("reset") }, { address: fresh(), asset: "xlm" })).toEqual(refusal(500, "internal_error"));
    expect(await counted()).toEqual([]);
  });

  it("keeps the payout's answer when the commit after it fails, because the lock went with the session", async () => {
    const { chain, ctx } = setup();
    expect(await ask({ ...ctx, db: lockStandIn("cut") }, { address: fresh(), asset: "xlm" })).toEqual(paid("xlm"));
    expect(chain.received).toHaveLength(1);
  });

  it("never lets one request log both the IP tag and a transaction hash: failed on chain, unconfirmed, paid and refused (C36)", async () => {
    const { chain, ctx } = setup();
    const linesOf = async (landing: typeof chain.landing, address = fresh()) => {
      chain.landing = landing;
      logs = [];
      const answer = await ask(ctx, { address, asset: "xlm" });
      return { answer, lines: logs.map((line) => JSON.parse(line) as Record<string, unknown>) };
    };
    for (const landing of ["failed", "never", "apply"] as const) {
      const { answer, lines } = await linesOf(landing);
      const tagged = lines.filter((line) => "ipTag" in line);
      const hashed = lines.filter((line) => /[0-9a-f]{64}/.test(JSON.stringify(line)));
      expect(hashed.length, landing).toBeGreaterThan(0);
      expect(tagged, landing).toEqual([]);
      // The refusal is still logged, only without the tag.
      if (answer.status !== 200) expect(lines.some((line) => line.event === "faucet_refused" && line.code === answer.body.error), landing).toBe(true);
    }
    const { lines } = await linesOf("apply", "not an address");
    expect(lines).toEqual([expect.objectContaining({ event: "faucet_refused", code: "bad_address", ipTag: ipTag(IP, LOG_SALT) })]);
  });

  it("never logs the address, the IP or the faucet secret, and no line joins the IP tag with a transaction hash (C36)", async () => {
    const { chain, ctx } = setup();
    const worker = fresh();
    chain.fund(worker, 5n * XLM);
    await ask(ctx, { address: worker, asset: "xlm" });
    await ask(ctx, { address: worker, asset: "xlm" });
    await ask(ctx, { address: worker, asset: "usdc" });
    chain.landing = "failed";
    await ask(ctx, { address: fresh(), asset: "xlm" });
    chain.landing = "never";
    await ask(ctx, { address: fresh(), asset: "xlm" });
    const all = logs.join("\n");
    for (const secret of [worker, IP, FAUCET.secret()]) expect(all).not.toContain(secret);
    const tag = ipTag(IP, LOG_SALT);
    expect(all).toContain(tag);
    for (const line of logs) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if ("ipTag" in parsed) expect(line, line).not.toMatch(/[0-9a-f]{64}/);
    }
    const events = logs.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(["faucet_paid", "faucet_refused", "faucet_payout_failed", "faucet_unconfirmed"]));
  });
});

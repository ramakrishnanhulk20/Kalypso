// Not covered here: the live Channels service (a local HTTP server stands in
// for it, no API key exists yet), a real database server (PGlite runs the
// same SQL in process), and the hosting platform's guarantee that the
// trusted IP header cannot be set by the caller.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { dailyFeeSpent, reserveDailyFee, type Db } from "../../src/archive/db.ts";
import { createLogger } from "../../src/log.ts";
import { clientBucket, ipTag } from "../../src/sponsor/client-ip.ts";
import { CLAIM_WINDOW_MS, sponsorHandler, sponsorStatusHandler, type SponsorContext } from "../../src/sponsor/handler.ts";
import { INCLUSION_FEE_ALLOWANCE_STROOPS, type SimulateFn } from "../../src/sponsor/validate.ts";
import { API_KEY, CRON_SECRET, DB_API, DB_INGEST, LOG_SALT, STRANGER, TOKEN, testConfig } from "../helpers.ts";
import { clearTables, freshDb } from "../db.ts";
import { defaultFootprint, fakeSimulation } from "./fake-rpc.ts";
import {
  LATEST_LEDGER,
  addr,
  b64,
  codeKey,
  contractAccountEntry,
  createContractOperation,
  depositTree,
  employer,
  envelope,
  fakeCode,
  hostCall,
  instanceKey,
  mergeFuncAuth,
  passkeyMergeFootprint,
  passkeyWallet,
  paymentOperation,
  signedEntry,
  thirdPartyOperation,
  uploadOperation,
  worker,
} from "./fixtures.ts";

interface Seen {
  method: string;
  headers: IncomingHttpHeaders;
  body: any;
}
type StubReply = { status: number; body: unknown; delayMs?: number };

const HASH = "a".repeat(64);
let relayCount = 0;
/** What Channels answers: a submit with skipWait is pending with no hash yet; a lookup echoes the id. */
const okReply = (body: any): StubReply => {
  const lookup = body?.params?.getTransaction?.transactionId;
  if (lookup) {
    return { status: 200, body: { success: true, data: { transactionId: lookup, hash: HASH, status: "confirmed" }, error: null } };
  }
  relayCount++;
  return {
    status: 200,
    body: { success: true, data: { transactionId: "tx_" + relayCount, hash: null, status: "pending", extra: "dropped" }, error: null },
  };
};

let server: Server;
let channelsUrl = "";
const seen: Seen[] = [];
let nextReply: (body: any) => StubReply = okReply;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ method: req.method ?? "", headers: req.headers, body });
      const reply = nextReply(body);
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  channelsUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

let db: Db;
const logs: string[] = [];
const responses: string[] = [];
const NOW = new Date("2026-10-07T12:30:00Z");
const CHARGE = 490_000n + INCLUSION_FEE_ALLOWANCE_STROOPS;

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await clearTables(db, ["ip_hour", "address_day", "day_budget", "relay_dedupe", "relay_auth"]);
  seen.length = 0;
  nextReply = okReply;
});

function context(overrides: Partial<SponsorContext> = {}, env: Record<string, string> = {}): SponsorContext {
  const cfg = testConfig({ CHANNELS_URL: channelsUrl, PER_IP_LIMIT_PER_HOUR: "3", ...env });
  return {
    cfg,
    db,
    rpc: fakeSimulation(),
    log: createLogger([API_KEY, DB_INGEST, DB_API], (line) => logs.push(line)),
    now: () => NOW,
    ...overrides,
  };
}

const at = (ms: number) => () => new Date(NOW.getTime() + ms);

/** How many relays the address has used on 7 Oct; 0 when it has no row. */
async function relaysUsed(address: string): Promise<number> {
  const rows = await db.query<{ count: number }>("select count from address_day where address = $1 and day = '2026-10-07'", [address]);
  return rows[0]?.count ?? 0;
}

/** Every client IP this file sends, as sent and as its rate-limit bucket, for the log sweep at the end. */
const sentIps = new Set<string>();
function noteIp(value: string | undefined) {
  if (!value) return;
  sentIps.add(value.trim().toLowerCase());
  const bucket = clientBucket(value);
  if (bucket) sentIps.add(bucket);
}

async function send(body: unknown, ctx: SponsorContext, headers: Record<string, string> = {}) {
  const all = { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers };
  noteIp(all["x-real-ip"]);
  const res = await sponsorHandler(
    new Request("https://kalypso.test/api/sponsor", {
      method: "POST",
      headers: all,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx,
  );
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

async function status(query: string, ctx: SponsorContext, headers: Record<string, string> = { "x-real-ip": "203.0.113.7" }, method = "GET") {
  noteIp(headers["x-real-ip"]);
  const res = await sponsorStatusHandler(new Request("https://kalypso.test/api/sponsor/status" + query, { method, headers }), ctx);
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

describe("POST /api/sponsor relays a valid worker action", () => {
  it("relays a token merge func+auth with skipWait and returns only transactionId and status, at once", async () => {
    const good = await mergeFuncAuth();
    const res = await send(good, context());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["status", "transactionId"]);
    expect(res.body.status).toBe("pending");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.authorization).toBe("Bearer " + API_KEY);
    expect(seen[0]!.body).toEqual({ params: { func: good.func, auth: good.auth, skipWait: true } });
    expect(logs.some((l) => l.includes('"event":"sponsor_relayed"') && l.includes(String(res.body.transactionId)))).toBe(true);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE);
  });

  it("relays a signed envelope as {params: {xdr, skipWait}}", async () => {
    const xdr = envelope({ footprint: defaultFootprint() });
    expect((await send({ xdr }, context())).status).toBe(200);
    expect(seen[0]!.body).toEqual({ params: { xdr, skipWait: true } });
  });
});

describe("POST /api/sponsor and passkey wallets (C20)", () => {
  const walletMerge = () => ({
    func: b64(hostCall(TOKEN, "merge", [addr(passkeyWallet)])),
    auth: [b64(contractAccountEntry({ contract: TOKEN, fn: "merge", args: [addr(passkeyWallet)] }))],
  });

  it("relays a passkey worker's merge when the wallet runs the pinned wallet code", async () => {
    const body = walletMerge();
    const res = await send(body, context({ rpc: fakeSimulation({ footprint: passkeyMergeFootprint() }) }));
    expect(res).toMatchObject({ status: 200, body: { status: "pending" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({ params: { ...body, skipWait: true } });
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE);
  });

  it("refuses a self-deployed wallet and a wallet whose check touches a third-party contract, relaying and paying nothing", async () => {
    const otherCode = fakeSimulation({
      footprint: passkeyMergeFootprint(),
      code: (c) => (c === passkeyWallet ? "ab".repeat(32) : fakeCode(c)),
    });
    expect(await send(walletMerge(), context({ rpc: otherCode }))).toEqual({ status: 400, body: { error: "unknown_wallet_code" } });
    const touching = passkeyMergeFootprint();
    touching.readOnly.push(instanceKey(STRANGER), codeKey(fakeCode(STRANGER)!));
    expect(await send(walletMerge(), context({ rpc: fakeSimulation({ footprint: touching }) }))).toEqual({
      status: 400,
      body: { error: "foreign_contract_in_footprint" },
    });
    expect(seen).toHaveLength(0);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(0n);
  });
});

describe("POST /api/sponsor refuses before anything is relayed", () => {
  const refusals: Array<[string, () => Promise<unknown>, string]> = [
    ["a classic payment", async () => ({ xdr: envelope({ operations: [paymentOperation()], soroban: false }) }), "not_invoke_host_function"],
    ["a wasm upload", async () => ({ xdr: envelope({ operations: [uploadOperation()] }) }), "wasm_upload"],
    ["a createContract", async () => ({ xdr: envelope({ operations: [createContractOperation()] }) }), "contract_creation"],
    ["a root call into a third-party contract", async () => ({ xdr: envelope({ operations: [thirdPartyOperation()] }) }), "root_contract_not_allowed"],
    [
      "a nested call into a non-allowed contract",
      async () => ({
        func: b64(hostCall(TOKEN, "deposit", [addr(worker.publicKey())])),
        auth: [b64(await signedEntry(depositTree([{ contract: STRANGER, fn: "drain" }])))],
      }),
      "nested_contract_not_allowed",
    ],
    ["a mainnet passphrase", async () => ({ xdr: envelope({ network: Networks.PUBLIC }) }), "not_signed_for_testnet"],
    ["a fee over the cap", async () => ({ xdr: envelope({ fee: "1600000", resourceFee: 500_000 }) }), "fee_over_cap"],
  ];

  for (const [label, build, code] of refusals) {
    it("refuses " + label, async () => {
      const ctx = context();
      expect(await send(await build(), ctx)).toEqual({ status: 400, body: { error: code } });
      expect(seen).toHaveLength(0);
      expect(ctx.rpc.simulateTransaction).not.toHaveBeenCalled();
      expect(logs.at(-1)).toContain('"code":"' + code + '"');
    });
  }

  it("refuses a failed simulation, a read-only call and an unused auth entry, and pays nothing", async () => {
    const failing: SimulateFn = vi.fn(async () => ({ ok: false as const, code: "simulation_failed" as const }));
    expect(await send(await mergeFuncAuth(), context({ simulate: failing }))).toEqual({ status: 400, body: { error: "simulation_failed" } });
    expect(await send(await mergeFuncAuth(), context({ rpc: fakeSimulation({ readWrite: 0 }) }))).toEqual({
      status: 400,
      body: { error: "read_only_call" },
    });
    expect(await send(await mergeFuncAuth(), context({ rpc: fakeSimulation({ requiredAuth: () => [] }) }))).toEqual({
      status: 400,
      body: { error: "unused_auth" },
    });
    expect(seen).toHaveLength(0);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(0n);
  });

  it("refuses a body over 64 KiB", async () => {
    const big = JSON.stringify({ xdr: "A".repeat(64 * 1024) });
    expect(await send(big, context())).toEqual({ status: 413, body: { error: "body_too_large" } });
    expect(seen).toHaveLength(0);
  });

  it("refuses a body that tries to carry a plaintext amount, which then reaches neither Channels nor the logs", async () => {
    const good = await mergeFuncAuth();
    expect(await send({ ...good, amount: "1234567.89" }, context())).toEqual({ status: 400, body: { error: "bad_shape" } });
    expect(seen).toHaveLength(0);
    expect(logs.join("\n")).not.toContain("1234567.89");
  });

  it("refuses a missing or malformed trusted IP header, a wrong method and a wrong content type", async () => {
    const ctx = context();
    const good = await mergeFuncAuth();
    expect((await send(good, ctx, { "x-real-ip": "" })).body).toEqual({ error: "no_client_ip" });
    expect((await send(good, ctx, { "x-real-ip": "1.2.3.4, 5.6.7.8" })).body).toEqual({ error: "no_client_ip" });
    expect((await send(good, ctx, { "content-type": "text/plain" })).status).toBe(415);
    const get = await sponsorHandler(new Request("https://kalypso.test/api/sponsor"), ctx);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(seen).toHaveLength(0);
  });
});

describe("per-IP hourly limit and daily fee budget", () => {
  it("refuses an IP over its hourly limit, counted on the trusted header and never on a cookie", async () => {
    const ctx = context();
    for (let i = 0; i < 3; i++) {
      expect((await send(await mergeFuncAuth(), ctx, { cookie: "visitor=" + i })).status).toBe(200);
    }
    expect(await send(await mergeFuncAuth(), ctx, { cookie: "visitor=fresh" })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(seen).toHaveLength(3);
    expect((await send(await mergeFuncAuth(), ctx, { "x-real-ip": "198.51.100.9" })).status).toBe(200);
    expect((await send(await mergeFuncAuth(), context({ now: at(3_600_000) }))).status).toBe(200);
  });

  it("counts a whole IPv6 /64 as one caller", async () => {
    const ctx = context();
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:DB8:1:2:ffff::9"]) {
      expect((await send(await mergeFuncAuth(), ctx, { "x-real-ip": ip })).status).toBe(200);
    }
    expect((await send(await mergeFuncAuth(), ctx, { "x-real-ip": "2001:db8:1:2:abcd::1" })).body).toEqual({ error: "rate_limited" });
    expect((await send(await mergeFuncAuth(), ctx, { "x-real-ip": "2001:db8:1:3::1" })).status).toBe(200);
  });

  it("refuses a request after the daily budget is spent, and opens again the next day", async () => {
    const env = { DAILY_FEE_BUDGET_STROOPS: String(CHARGE * 2n), FEE_CAP_STROOPS: String(CHARGE), PER_IP_LIMIT_PER_HOUR: "100" };
    const ctx = context({}, env);
    expect((await send(await mergeFuncAuth(), ctx)).status).toBe(200);
    expect((await send(await mergeFuncAuth(), ctx)).status).toBe(200);
    const third = await mergeFuncAuth();
    expect(await send(third, ctx)).toEqual({ status: 429, body: { error: "daily_budget_spent" } });
    expect(seen).toHaveLength(2);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE * 2n);
    expect(await relaysUsed(worker.publicKey())).toBe(2);
    expect((await send(third, context({ now: () => new Date("2026-10-08T00:00:01Z") }, env))).status).toBe(200);
  });

  it("counts refused bodies against the IP before any parsing: bad JSON, a wrong content type and a refused shape", async () => {
    const ctx = context();
    expect(await send("{not json", ctx)).toEqual({ status: 400, body: { error: "invalid_json" } });
    expect((await send(await mergeFuncAuth(), ctx, { "content-type": "text/plain" })).status).toBe(415);
    expect(await send({ nope: 1 }, ctx)).toEqual({ status: 400, body: { error: "bad_shape" } });
    expect(await send(await mergeFuncAuth(), ctx)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(seen).toHaveLength(0);
  });

  it("gives the reserved fee and the worker's daily relay back when Channels refuses with a 4xx, and keeps both on a 5xx or a timeout", async () => {
    const env = { PER_IP_LIMIT_PER_HOUR: "10" };
    nextReply = () => ({ status: 400, body: { success: false, data: { code: "INVALID_PARAMS" }, error: "bad" } });
    expect(await send(await mergeFuncAuth(), context({}, env))).toEqual({ status: 502, body: { error: "relay_refused" } });
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(0n);
    expect(await relaysUsed(worker.publicKey())).toBe(0);
    nextReply = () => ({ status: 503, body: { success: false, data: { code: "PLUGIN_ERROR" }, error: "down" } });
    expect(await send(await mergeFuncAuth(), context({}, env))).toEqual({ status: 502, body: { error: "relay_refused" } });
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE);
    expect(await relaysUsed(worker.publicKey())).toBe(1);
    nextReply = (body) => ({ ...okReply(body), delayMs: 300 });
    expect(await send(await mergeFuncAuth(), context({ relayTimeoutMs: 50 }, env))).toEqual({ status: 504, body: { error: "relay_timeout" } });
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE * 2n);
    expect(await relaysUsed(worker.publicKey())).toBe(2);
  });
});

describe("which Channels refusals give the claim, the fee and the daily count back", () => {
  it("keeps all three on a 4xx that can follow a submission: ONCHAIN_FAILED, an undocumented code, a hash in the body, or a body that is not a plugin error", async () => {
    const env = { PER_IP_LIMIT_PER_HOUR: "20" };
    const replies: StubReply[] = [
      { status: 400, body: { success: false, data: { code: "ONCHAIN_FAILED", details: { hash: HASH } }, error: "Transaction failed" } },
      { status: 400, body: { success: false, data: { code: "ONCHAIN_FAILED" }, error: "Transaction failed" } },
      { status: 409, body: { success: false, data: { code: "SOMETHING_NEW" }, error: "conflict" } },
      { status: 400, body: { success: false, data: { code: "SIMULATION_FAILED" }, error: "seen as " + "c".repeat(64) } },
      { status: 401, body: "Unauthorized" },
      { status: 400, body: { success: true, data: { code: "INVALID_PARAMS" } } },
    ];
    for (const [i, reply] of replies.entries()) {
      nextReply = () => reply;
      const body = await mergeFuncAuth();
      expect(await send(body, context({}, env)), JSON.stringify(reply.body)).toEqual({ status: 502, body: { error: "relay_refused" } });
      expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE * BigInt(i + 1));
      expect(await relaysUsed(worker.publicKey())).toBe(i + 1);
      nextReply = okReply;
      expect(await send(body, context({}, env))).toEqual({ status: 409, body: { error: "duplicate_in_flight" } });
    }
  });

  it("gives all three back on documented pre-submission refusals with no hash in them", async () => {
    const env = { PER_IP_LIMIT_PER_HOUR: "20" };
    for (const [status, code] of [
      [400, "SIMULATION_SIGNED_AUTH_VALIDATION_FAILED"],
      [400, "TIMEBOUNDS_EXPIRED"],
      [400, "AUTH_EXPIRY_TOO_SHORT"],
      [429, "FEE_LIMIT_EXCEEDED"],
    ] as const) {
      nextReply = () => ({ status, body: { success: false, data: { code, details: { consumed: 5, fee: 7 } }, error: "refused" } });
      const body = await mergeFuncAuth();
      expect((await send(body, context({}, env))).body).toEqual({ error: "relay_refused" });
      expect(await dailyFeeSpent(db, "2026-10-07")).toBe(0n);
      expect(await relaysUsed(worker.publicKey())).toBe(0);
      nextReply = okReply;
      expect((await send(body, context({}, env))).status).toBe(200);
      await clearTables(db, ["day_budget", "address_day"]);
    }
  });
});

describe("per-address daily limit", () => {
  it("refuses an authorising address over its daily relays from any IP, never counting a refused simulation", async () => {
    const env = { PER_ADDRESS_LIMIT_PER_DAY: "2" };
    const failing: SimulateFn = async () => ({ ok: false, code: "simulation_failed" });
    expect((await send(await mergeFuncAuth(), context({ simulate: failing }, env), { "x-real-ip": "198.51.100.30" })).status).toBe(400);
    expect((await send(await mergeFuncAuth(), context({}, env), { "x-real-ip": "198.51.100.31" })).status).toBe(200);
    expect((await send(await mergeFuncAuth(), context({}, env), { "x-real-ip": "198.51.100.32" })).status).toBe(200);
    const third = await mergeFuncAuth();
    expect(await send(third, context({}, env), { "x-real-ip": "198.51.100.33" })).toEqual({ status: 429, body: { error: "address_rate_limited" } });
    expect(logs.at(-1)).toContain('"code":"address_rate_limited"');
    expect(logs.at(-1)).not.toContain(worker.publicKey());
    expect(seen).toHaveLength(2);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE * 2n);
    expect((await send(await mergeFuncAuth(employer), context({}, env), { "x-real-ip": "198.51.100.34" })).status).toBe(200);
    expect((await send(third, context({ now: () => new Date("2026-10-08T00:00:01Z") }, env), { "x-real-ip": "198.51.100.35" })).status).toBe(200);
  });

  it("never spends a worker's last relay of the day on a relay the budget or Channels refused", async () => {
    const env = { PER_ADDRESS_LIMIT_PER_DAY: "1", PER_IP_LIMIT_PER_HOUR: "10" };
    const spent = { ...env, DAILY_FEE_BUDGET_STROOPS: String(CHARGE), FEE_CAP_STROOPS: String(CHARGE) };
    await reserveDailyFee(db, "2026-10-07", 1n, CHARGE);
    expect(await send(await mergeFuncAuth(), context({}, spent))).toEqual({ status: 429, body: { error: "daily_budget_spent" } });
    await clearTables(db, ["day_budget"]);
    nextReply = () => ({ status: 429, body: { success: false, data: { code: "FEE_LIMIT_EXCEEDED" }, error: "limit" } });
    expect(await send(await mergeFuncAuth(), context({}, env))).toEqual({ status: 502, body: { error: "relay_refused" } });
    expect(await relaysUsed(worker.publicKey())).toBe(0);
    nextReply = okReply;
    expect((await send(await mergeFuncAuth(), context({}, env))).status).toBe(200);
    expect(await send(await mergeFuncAuth(), context({}, env))).toEqual({ status: 429, body: { error: "address_rate_limited" } });
  });
});

/** A merge whose entry lives 500 ledgers, so it outlasts the default fixture's 100. */
async function longLivedMerge(signer = employer) {
  const call = { contract: TOKEN, fn: "merge", args: [addr(signer.publicKey())] };
  return {
    func: b64(hostCall(TOKEN, "merge", [addr(signer.publicKey())])),
    auth: [b64(await signedEntry(call, signer, { validUntil: LATEST_LEDGER + 500 }))],
  };
}

describe("the same body is relayed once while its auth entries can still land", () => {
  it("returns the first transactionId without relaying or paying again, seconds or many minutes later", async () => {
    const env = { PER_IP_LIMIT_PER_HOUR: "10" };
    const good = await mergeFuncAuth();
    const first = await send(good, context({}, env));
    for (const later of [1_000, CLAIM_WINDOW_MS, 2 * CLAIM_WINDOW_MS + 1, 25 * 60_000]) {
      expect(await send(JSON.parse(JSON.stringify(good)), context({ now: at(later) }, env))).toEqual({ status: 200, body: first.body });
    }
    expect(seen).toHaveLength(1);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE);
    expect(logs.at(-1)).toContain('"event":"sponsor_duplicate"');
  });

  it("forgets the body once a simulation reports its entries' expiry ledger, and then refuses a copy as expired without relaying it", async () => {
    const env = { PER_IP_LIMIT_PER_HOUR: "10" };
    const good = await mergeFuncAuth();
    expect((await send(good, context({}, env))).status).toBe(200);
    const expiryReached = () => fakeSimulation({ enforce: { latestLedger: LATEST_LEDGER + 100 } });
    expect((await send(await longLivedMerge(), context({ rpc: expiryReached() }, env))).status).toBe(200);
    expect(await send(good, context({ rpc: expiryReached(), now: at(20 * 60_000) }, env))).toEqual({ status: 400, body: { error: "auth_expired" } });
    expect(seen).toHaveLength(2);
    expect(await dailyFeeSpent(db, "2026-10-07")).toBe(CHARGE * 2n);
  });

  it("keeps holding a body whose entries have not expired when another relay prunes", async () => {
    const env = { PER_IP_LIMIT_PER_HOUR: "10" };
    const good = await longLivedMerge();
    const first = await send(good, context({}, env));
    const pruning = () => fakeSimulation({ enforce: { latestLedger: LATEST_LEDGER + 499 } });
    expect((await send(await longLivedMerge(worker), context({ rpc: pruning() }, env))).status).toBe(200);
    expect(await send(good, context({ rpc: pruning(), now: at(30 * 60_000) }, env))).toEqual({ status: 200, body: first.body });
    expect(seen).toHaveLength(2);
  });

  it("answers 409 to a copy that arrives while the first is still being relayed", async () => {
    nextReply = (body) => ({ ...okReply(body), delayMs: 150 });
    const good = await mergeFuncAuth();
    const [a, b] = await Promise.all([send(good, context()), send(good, context())]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body, b.body]).toContainEqual({ error: "duplicate_in_flight" });
    expect(seen).toHaveLength(1);
  });

  it("frees the body for an immediate retry when nothing was relayed, and holds it past the claim window when the outcome is unknown", async () => {
    const good = await mergeFuncAuth();
    const failing: SimulateFn = async () => ({ ok: false, code: "simulation_failed" });
    expect((await send(good, context({ simulate: failing }))).status).toBe(400);
    nextReply = () => ({ status: 429, body: { success: false, data: { code: "FEE_LIMIT_EXCEEDED" }, error: "limit" } });
    expect((await send(good, context())).body).toEqual({ error: "relay_refused" });
    nextReply = okReply;
    expect((await send(good, context())).status).toBe(200);

    const slow = await mergeFuncAuth();
    nextReply = (body) => ({ ...okReply(body), delayMs: 300 });
    const other = { "x-real-ip": "198.51.100.20" };
    expect((await send(slow, context({ relayTimeoutMs: 50 }), other)).body).toEqual({ error: "relay_timeout" });
    nextReply = okReply;
    expect(await send(slow, context(), other)).toEqual({ status: 409, body: { error: "duplicate_in_flight" } });
    expect(await send(slow, context({ now: at(5 * CLAIM_WINDOW_MS) }), other)).toEqual({ status: 409, body: { error: "duplicate_in_flight" } });
  });
});

describe("GET /api/sponsor/status", () => {
  it("asks Channels for the transaction with our key and returns only status and hash", async () => {
    const res = await status("?id=tx_42", context());
    expect(res).toEqual({ status: 200, body: { status: "confirmed", hash: HASH } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe("Bearer " + API_KEY);
    expect(seen[0]!.body).toEqual({ params: { getTransaction: { transactionId: "tx_42" } } });
  });

  it("refuses an id that is not in Channels' format, or given twice, before calling Channels", async () => {
    const ctx = context({}, { PER_IP_LIMIT_PER_HOUR: "20" });
    for (const query of ["", "?id=", "?id=tx%201", "?id=tx_1%22%7D", "?id=" + "a".repeat(129), "?id=tx_1&id=tx_2", "?id=" + "1".repeat(3_000)]) {
      expect(await status(query, ctx), query.slice(0, 40)).toEqual({ status: 400, body: { error: "bad_id" } });
    }
    expect((await status("?id=tx_1", context(), {})).body).toEqual({ error: "no_client_ip" });
    expect((await status("?id=tx_1", context(), { "x-real-ip": "203.0.113.7" }, "POST")).status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it("counts a bad id against the IP before reading it", async () => {
    const ctx = context();
    for (const query of ["?id=tx%201", "?id=" + "1".repeat(3_000), "?id=tx_1&id=tx_2"]) {
      expect((await status(query, ctx)).body).toEqual({ error: "bad_id" });
    }
    expect(await status("?id=tx_1", ctx)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(seen).toHaveLength(0);
  });

  it("limits each IP at the POST's hourly rate, on a count of its own", async () => {
    const ctx = context();
    for (let i = 0; i < 3; i++) expect((await status("?id=tx_" + i, ctx)).status).toBe(200);
    expect(await status("?id=tx_9", ctx)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect((await send(await mergeFuncAuth(), ctx)).status).toBe(200);
  });

  it("contains a wrong, refused or slow answer from Channels", async () => {
    nextReply = () => ({ status: 200, body: { success: true, data: { transactionId: "tx_other", hash: HASH, status: "confirmed" } } });
    expect(await status("?id=tx_1", context())).toEqual({ status: 502, body: { error: "relay_bad_reply" } });
    nextReply = () => ({ status: 500, body: { success: false, data: { code: "PLUGIN_ERROR" }, error: "Not Found: tx_1 " + API_KEY } });
    expect(await status("?id=tx_1", context())).toEqual({ status: 502, body: { error: "relay_refused" } });
    nextReply = (body) => ({ ...okReply(body), delayMs: 300 });
    expect(await status("?id=tx_1", context({ relayTimeoutMs: 50 }))).toEqual({ status: 504, body: { error: "relay_timeout" } });
  });
});

describe("Channels failures stay contained", () => {
  it("never passes upstream text back, even when Channels echoes our key", async () => {
    nextReply = () => ({
      status: 429,
      body: { success: false, data: { code: "FEE_LIMIT_EXCEEDED" }, error: "limit for Bearer " + API_KEY },
    });
    expect(await send(await mergeFuncAuth(), context())).toEqual({ status: 502, body: { error: "relay_refused" } });
    expect(logs.at(-1)).toContain('"upstreamCode":"FEE_LIMIT_EXCEEDED"');
    nextReply = () => ({ status: 200, body: { success: true, data: { transactionId: "tx 1; drop", hash: "zz", status: "won" } } });
    expect(await send(await mergeFuncAuth(), context())).toEqual({ status: 502, body: { error: "relay_bad_reply" } });
    nextReply = () => ({ status: 200, body: "not json " + API_KEY });
    expect(await send(await mergeFuncAuth(), context())).toEqual({ status: 502, body: { error: "relay_bad_reply" } });
  });

  it("reports an unreachable relay and a database failure without detail", async () => {
    const dead = context({}, { CHANNELS_URL: "http://127.0.0.1:1" });
    expect(await send(await mergeFuncAuth(), dead)).toEqual({ status: 502, body: { error: "relay_unavailable" } });
    const broken = context({ db: { ...db, query: async () => Promise.reject(new Error("password=" + DB_INGEST)) } });
    expect(await send(await mergeFuncAuth(), broken)).toEqual({ status: 500, body: { error: "internal_error" } });
    expect(await status("?id=tx_1", broken)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("maps an unreachable RPC to 503", async () => {
    expect(await send(await mergeFuncAuth(), context({ rpc: fakeSimulation({ fail: "enforce" }) }))).toEqual({
      status: 503,
      body: { error: "rpc_unavailable" },
    });
  });
});

describe("what the logs say about callers", () => {
  it("logs a relay with its transaction id and hash, and nothing derived from the caller's IP", async () => {
    const relayedHash = "b".repeat(64);
    nextReply = () => ({ status: 200, body: { success: true, data: { transactionId: "tx_hashed", hash: relayedHash, status: "submitted" } } });
    expect((await send(await mergeFuncAuth(), context())).status).toBe(200);
    const line = logs.find((l) => l.includes('"event":"sponsor_relayed"') && l.includes("tx_hashed"))!;
    expect(line).toContain('"hash":"' + relayedHash + '"');
    expect(line).not.toContain("ipTag");
    expect(line).not.toContain("203.0.113.7");
  });

  it("logs a rate-limit refusal with the salted tag of the IP bucket, never the IP itself", async () => {
    const ctx = context({}, { PER_IP_LIMIT_PER_HOUR: "1" });
    expect((await send(await mergeFuncAuth(), ctx, { "x-real-ip": "2001:db8:9:9::1" })).status).toBe(200);
    expect((await send(await mergeFuncAuth(), ctx, { "x-real-ip": "2001:db8:9:9::2" })).body).toEqual({ error: "rate_limited" });
    const line = logs.at(-1)!;
    expect(line).toContain('"code":"rate_limited"');
    expect(line).toContain('"ipTag":"' + ipTag("2001:db8:9:9::/64", LOG_SALT) + '"');
    expect(line).not.toMatch(/2001:db8/i);
  });
});

describe("no secret in any response or log line (C23)", () => {
  it("found none of the API key, database URLs, cron secret or log salt across every request in this file", () => {
    expect(responses.length).toBeGreaterThan(30);
    for (const secret of [API_KEY, DB_INGEST, DB_API, "ingest-pass-7Hq2", "reader-pass-K9z4", CRON_SECRET, LOG_SALT]) {
      expect(responses.join("\n")).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
  });
});

describe("no log line ties a caller's IP to a transaction", () => {
  it("no captured log line contains both an IP string and a 64-hex hash", () => {
    const hex64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/;
    const ipv4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/;
    const hasIp = (line: string) => ipv4.test(line) || [...sentIps].some((ip) => line.toLowerCase().includes(ip));
    // The sweep means something only if this file sent many IPs and logged hashes.
    expect(sentIps.size).toBeGreaterThan(8);
    expect(logs.filter((line) => hex64.test(line)).length).toBeGreaterThan(3);
    expect(logs.filter((line) => line.includes('"ipTag":"')).length).toBeGreaterThan(20);
    expect(logs.filter((line) => hex64.test(line) && hasIp(line))).toEqual([]);
    // Stronger than the rule, and true of this handler: no line carries a raw IP at all.
    expect(logs.filter(hasIp)).toEqual([]);
  });
});

describe("ipTag", () => {
  it("is 16 hex characters, stable for one bucket and salt, and different for another bucket or salt", () => {
    const tag = ipTag("203.0.113.7", LOG_SALT);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(ipTag("203.0.113.7", LOG_SALT)).toBe(tag);
    expect(ipTag("203.0.113.8", LOG_SALT)).not.toBe(tag);
    expect(ipTag("203.0.113.7", LOG_SALT + "x")).not.toBe(tag);
  });
});

describe("clientBucket", () => {
  it("normalises IPv4, IPv4-mapped IPv6 and IPv6 /64s, and refuses anything else", () => {
    expect(clientBucket(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(clientBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucket("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe("2001:db8:1:2::/64");
    expect(clientBucket("::1")).toBe("0:0:0:0::/64");
    for (const bad of [null, "", "localhost", "1.2.3", "fe80::1%eth0", "1.2.3.4:80"]) expect(clientBucket(bad)).toBeNull();
  });
});

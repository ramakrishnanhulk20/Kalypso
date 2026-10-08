// Attacks on the fee sponsor: draining the daily budget with refused relays,
// unmetered refused bodies, envelopes that under-declare their footprint or
// limits, and
// the wallet-code and footprint rules at their edges. Not covered here: a live
// enforce-mode simulation (RPC is faked), the live Channels service (every
// relay in this file answers from a stub fetch, nothing leaves the process),
// and whether the hosting platform really sets the trusted IP header itself.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Networks, Operation, xdr } from "@stellar/stellar-sdk";
import { dailyFeeSpent, type Db } from "../../src/archive/db.ts";
import { createLogger } from "../../src/log.ts";
import { clientBucket } from "../../src/sponsor/client-ip.ts";
import { sponsorHandler, type SponsorContext } from "../../src/sponsor/handler.ts";
import { INCLUSION_FEE_ALLOWANCE_STROOPS, simulate, validateSponsorRequest } from "../../src/sponsor/validate.ts";
import { AUDITOR, PAYROLL, TOKEN, VERIFIER, contractFor, keypairFor, testConfig } from "../helpers.ts";
import { clearTables, freshDb } from "../db.ts";
import { defaultFootprint, fakeSimulation } from "./fake-rpc.ts";
import {
  LATEST_LEDGER,
  addr,
  b64,
  codeKey,
  contractAccountEntry,
  envelope,
  fakeCode,
  hostCall,
  instanceKey,
  mergeFuncAuth,
  passkeyMergeFootprint,
  passkeyWallet,
  signedEntry,
  storageKey,
  worker,
  employer,
} from "./fixtures.ts";

const CHARGE = 490_000n + INCLUSION_FEE_ALLOWANCE_STROOPS;
const NOW = new Date("2026-10-08T12:00:00Z");
const DAY = "2026-10-08";
const cfg = testConfig();

let db: Db;
const logs: string[] = [];

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await clearTables(db, ["ip_hour", "address_day", "day_budget", "relay_dedupe", "relay_auth"]);
});

/** Channels refusing with a 4xx, which proves nothing was submitted. */
const refusing: typeof fetch = async () =>
  new Response(JSON.stringify({ success: false, data: { code: "FEE_LIMIT_EXCEEDED" }, error: "limit" }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });

const relaying: typeof fetch = async () =>
  new Response(JSON.stringify({ success: true, data: { transactionId: "tx_stub", hash: null, status: "pending" }, error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function context(overrides: Partial<SponsorContext> = {}, env: Record<string, string> = {}): SponsorContext {
  return {
    cfg: testConfig({ PER_IP_LIMIT_PER_HOUR: "100", ...env }),
    db,
    rpc: fakeSimulation(),
    log: createLogger([], (line) => logs.push(line)),
    now: () => NOW,
    fetchImpl: refusing,
    ...overrides,
  };
}

async function send(body: unknown, ctx: SponsorContext, ip = "203.0.113.7") {
  const res = await sponsorHandler(
    new Request("https://kalypso.test/api/sponsor", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the daily budget on a relay Channels provably refused", () => {
  it("refuses to keep the fee of a relay Channels turned away with a 4xx, so refusals never drain the daily budget", async () => {
    const env = { DAILY_FEE_BUDGET_STROOPS: String(CHARGE * 2n), FEE_CAP_STROOPS: String(CHARGE) };
    const good = await mergeFuncAuth();
    for (let i = 0; i < 3; i++) {
      expect(await send(good, context({}, env))).toEqual({ status: 502, body: { error: "relay_refused" } });
      expect(await dailyFeeSpent(db, DAY)).toBe(0n);
    }
    expect(await send(good, context({ fetchImpl: relaying }, env))).toEqual({ status: 200, body: { transactionId: "tx_stub", status: "pending" } });
    expect(await dailyFeeSpent(db, DAY)).toBe(CHARGE);
  });
});

describe("one signed auth entry in many bodies (S1)", () => {
  const merge = { contract: TOKEN, fn: "merge", args: [addr(worker.publicKey())] };
  const funcBody = (entry: xdr.SorobanAuthorizationEntry) => ({ func: b64(hostCall(TOKEN, "merge", [addr(worker.publicKey())])), auth: [b64(entry)] });
  const envelopeBody = (entry: xdr.SorobanAuthorizationEntry, source = employer) => ({
    xdr: envelope({
      signer: source,
      footprint: defaultFootprint(),
      operations: [Operation.invokeHostFunction({ func: hostCall(TOKEN, "merge", [addr(worker.publicKey())]), auth: [entry] })],
    }),
  });
  let relays = 0;
  const counting: typeof fetch = async (...args) => {
    relays++;
    return relaying(...args);
  };
  const relaysUsed = async () =>
    (await db.query<{ count: number }>("select count from address_day where address = $1", [worker.publicKey()]))[0]?.count ?? 0;
  /** A relay by someone else whose simulation reports the network at `ledger`, which prunes expired holds. */
  const someoneElseAt = async (ledger: number) => {
    const other = { contract: TOKEN, fn: "merge", args: [addr(employer.publicKey())] };
    const body = { func: b64(hostCall(TOKEN, "merge", [addr(employer.publicKey())])), auth: [b64(await signedEntry(other, employer, { validUntil: ledger + 500 }))] };
    expect((await send(body, context({ rpc: fakeSimulation({ enforce: { latestLedger: ledger } }), fetchImpl: counting }), "198.51.100.77")).status).toBe(200);
  };

  beforeEach(() => {
    relays = 0;
  });

  it("refuses the worker's entry rewrapped from a func body into another account's envelope, while the first is pending and after it lands", async () => {
    const entry = await signedEntry(merge, worker);
    expect(await send(funcBody(entry), context({ fetchImpl: counting }))).toMatchObject({ status: 200 });
    expect(await send(envelopeBody(entry), context({ fetchImpl: counting }), "198.51.100.5")).toEqual({ status: 409, body: { error: "auth_entry_in_use" } });

    const landed = fakeSimulation({ enforce: { error: "HostError: Error(Auth, ExistingValue) nonce already exists" } });
    const later = context({ fetchImpl: counting, rpc: landed, now: () => new Date(NOW.getTime() + 40 * 60_000) });
    expect(await send(envelopeBody(entry), later, "198.51.100.6")).toEqual({ status: 409, body: { error: "auth_entry_in_use" } });
    expect(landed.simulateTransaction).not.toHaveBeenCalled();

    expect(relays).toBe(1);
    expect(await dailyFeeSpent(db, DAY)).toBe(CHARGE);
    expect(await relaysUsed()).toBe(1);
  });

  it("refuses the worker's entry moved from one account's envelope to another's, and back into a func body", async () => {
    const entry = await signedEntry(merge, worker);
    expect(await send(envelopeBody(entry), context({ fetchImpl: counting }))).toMatchObject({ status: 200 });
    const stranger = keypairFor("stranger who copied the entry");
    expect(await send(envelopeBody(entry, stranger), context({ fetchImpl: counting }), "198.51.100.7")).toEqual({
      status: 409,
      body: { error: "auth_entry_in_use" },
    });
    expect(await send(funcBody(entry), context({ fetchImpl: counting }), "198.51.100.8")).toEqual({ status: 409, body: { error: "auth_entry_in_use" } });
    expect(relays).toBe(1);
    expect(await relaysUsed()).toBe(1);
  });

  it("refuses the rewrap only until the entry's own expiry ledger, after which simulation refuses it as expired and nothing is relayed", async () => {
    const entry = await signedEntry(merge, worker, { validUntil: LATEST_LEDGER + 100 });
    expect(await send(funcBody(entry), context({ fetchImpl: counting }))).toMatchObject({ status: 200 });
    await someoneElseAt(LATEST_LEDGER + 99);
    expect((await send(envelopeBody(entry), context({ fetchImpl: counting }), "198.51.100.9")).body).toEqual({ error: "auth_entry_in_use" });
    await someoneElseAt(LATEST_LEDGER + 100);
    const expired = context({ fetchImpl: counting, rpc: fakeSimulation({ enforce: { latestLedger: LATEST_LEDGER + 100 } }) });
    expect(await send(envelopeBody(entry), expired, "198.51.100.10")).toEqual({ status: 400, body: { error: "auth_expired" } });
    expect(relays).toBe(3);
    expect(await relaysUsed()).toBe(1);
  });

  it("gives the entry back with its body when the first relay was refused before submission, so the worker can resend it in any body", async () => {
    const entry = await signedEntry(merge, worker);
    expect(await send(funcBody(entry), context())).toEqual({ status: 502, body: { error: "relay_refused" } });
    expect(await send(envelopeBody(entry), context({ fetchImpl: counting }), "198.51.100.11")).toMatchObject({ status: 200 });
    expect(relays).toBe(1);
  });
});

describe("the per-IP limit and refused bodies", () => {
  it("refuses a sender over its hourly limit even when every body it sent was refused, because it counts before any parsing", async () => {
    const ctx = context({}, { PER_IP_LIMIT_PER_HOUR: "1" });
    const mainnet = { xdr: envelope({ network: Networks.PUBLIC }) };
    expect(await send(mainnet, ctx)).toEqual({ status: 400, body: { error: "not_signed_for_testnet" } });
    for (let i = 0; i < 19; i++) expect(await send(mainnet, ctx)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(await db.query("select count from ip_hour")).toEqual([{ count: 1 }]);
    expect(await send(await mergeFuncAuth(), context({ fetchImpl: relaying }, { PER_IP_LIMIT_PER_HOUR: "1" }))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect((await send(await mergeFuncAuth(), context({ fetchImpl: relaying }, { PER_IP_LIMIT_PER_HOUR: "1" }), "198.51.100.4")).status).toBe(200);
  });
});

describe("the footprint an envelope declares", () => {
  const needs = () => ({ readOnly: [instanceKey(TOKEN), codeKey(fakeCode(TOKEN)!)], readWrite: [storageKey(TOKEN)] });

  it("refuses an envelope that declares none of the entries its call touches, before any fee is reserved", async () => {
    const v = validateSponsorRequest({ xdr: envelope() }, cfg);
    if (!v.ok) throw new Error(v.code);
    const declared = xdr.TransactionEnvelope.fromXDR(v.kind === "xdr" ? v.xdr : "", "base64").v1().tx().ext().sorobanData().resources().footprint();
    expect(declared.readOnly()).toHaveLength(0);
    expect(declared.readWrite()).toHaveLength(0);
    expect(await simulate(cfg, v, fakeSimulation({ footprint: needs() }))).toEqual({ ok: false, code: "footprint_not_declared" });
    const ctx = context({ rpc: fakeSimulation({ footprint: needs() }), fetchImpl: relaying });
    expect(await send({ xdr: envelope() }, ctx)).toEqual({ status: 400, body: { error: "footprint_not_declared" } });
    expect(await dailyFeeSpent(db, DAY)).toBe(0n);
    expect(await send({ xdr: envelope({ footprint: needs() }) }, ctx)).toMatchObject({ status: 200 });
  });

  it("refuses an envelope that declares lower limits than its call uses, before any fee is reserved", async () => {
    const used = { instructions: 4_000_000, diskReadBytes: 20_000, writeBytes: 2_000 };
    const ctx = context({ rpc: fakeSimulation({ footprint: needs(), limits: used }), fetchImpl: relaying });
    expect(await send({ xdr: envelope({ footprint: needs() }) }, ctx)).toEqual({ status: 400, body: { error: "resources_not_declared" } });
    expect(await send({ xdr: envelope({ footprint: needs(), limits: used, resourceFee: 100_000 }) }, ctx)).toEqual({
      status: 400,
      body: { error: "resources_not_declared" },
    });
    expect(await dailyFeeSpent(db, DAY)).toBe(0n);
    expect(await send({ xdr: envelope({ footprint: needs(), limits: used }) }, ctx)).toMatchObject({ status: 200 });
  });

  it("refuses an envelope that declares a key read-only when the call writes it", async () => {
    const readOnlyWrite = envelope({ footprint: { readOnly: [...needs().readOnly, storageKey(TOKEN)], readWrite: [] } });
    const v = validateSponsorRequest({ xdr: readOnlyWrite }, cfg);
    if (!v.ok) throw new Error(v.code);
    expect(await simulate(cfg, v, fakeSimulation({ footprint: needs() }))).toEqual({ ok: false, code: "footprint_not_declared" });
  });
});

describe("the wallet-code and footprint rules at their edges (C31)", () => {
  const walletMerge = (wallet: string) => {
    const call = { contract: TOKEN, fn: "merge", args: [addr(wallet)] };
    const v = validateSponsorRequest({ func: b64(hostCall(TOKEN, "merge", [addr(wallet)])), auth: [b64(contractAccountEntry(call, undefined, wallet))] }, cfg);
    if (!v.ok) throw new Error(v.code);
    return v;
  };

  it("refuses one of our own contracts posing as the authorising wallet", async () => {
    for (const ours of [PAYROLL, TOKEN, AUDITOR, VERIFIER]) {
      expect(await simulate(cfg, walletMerge(ours), fakeSimulation({ footprint: passkeyMergeFootprint() })), ours).toEqual({ ok: false, code: "unknown_wallet_code" });
    }
  });

  it("refuses a second deployment of our token's own wasm when its instance is in the footprint", async () => {
    const twin = contractFor("second confidential token on the same wasm");
    const fp = passkeyMergeFootprint();
    fp.readOnly.push(instanceKey(twin), codeKey(fakeCode(TOKEN)!));
    expect(await simulate(cfg, walletMerge(passkeyWallet), fakeSimulation({ footprint: fp }))).toEqual({ ok: false, code: "foreign_contract_in_footprint" });
  });

  it("refuses ledger entry kinds the rule does not name, and a nonce under a muxed account", async () => {
    const worker = keypairFor("worker");
    const muxedOwner = xdr.ScAddress.scAddressTypeMuxedAccount(new xdr.MuxedEd25519Account({ id: xdr.Uint64.fromString("7"), ed25519: worker.rawPublicKey() }));
    const keys: Array<[string, xdr.LedgerKey]> = [
      ["ttl", xdr.LedgerKey.ttl(new xdr.LedgerKeyTtl({ keyHash: Buffer.alloc(32, 9) }))],
      ["config setting", xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingContractMaxSizeBytes() }))],
      ["claimable balance", xdr.LedgerKey.claimableBalance(new xdr.LedgerKeyClaimableBalance({ balanceId: xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(Buffer.alloc(32, 1)) }))],
      ["liquidity pool", xdr.LedgerKey.liquidityPool(new xdr.LedgerKeyLiquidityPool({ liquidityPoolId: Buffer.alloc(32, 2) as never }))],
      ["offer", xdr.LedgerKey.offer(new xdr.LedgerKeyOffer({ sellerId: worker.xdrAccountId(), offerId: xdr.Int64.fromString("1") }))],
      ["data", xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId: worker.xdrAccountId(), dataName: "x" }))],
      [
        "nonce under a muxed account",
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: muxedOwner,
            key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString("42") })),
            durability: xdr.ContractDataDurability.temporary(),
          }),
        ),
      ],
    ];
    for (const [label, key] of keys) {
      const fp = passkeyMergeFootprint();
      fp.readOnly.push(key);
      expect(await simulate(cfg, walletMerge(passkeyWallet), fakeSimulation({ footprint: fp })), label).toEqual({ ok: false, code: "foreign_contract_in_footprint" });
    }
  });
});

describe("clientBucket spellings", () => {
  it("refuses IPv4 spellings that are not plain dotted decimal, and folds every spelling of one address into one bucket", () => {
    for (const bad of ["203.0.113.007", "0203.0.113.7", "3405803783", "0xCB007107", "203.0.113.7:443", "203.0.113.7/32", "::ffff:203.0.113.7:443", "203.0.113"]) {
      expect(clientBucket(bad), bad).toBeNull();
    }
    expect(new Set(["::ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:cb00:7107", "0:0:0:0:0:ffff:203.0.113.7"].map(clientBucket))).toEqual(new Set(["203.0.113.7"]));
    expect(new Set(["2001:db8:1:2::1", "2001:DB8:1:2::1", "2001:0db8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2:ffff:ffff:ffff:ffff"].map(clientBucket))).toEqual(
      new Set(["2001:db8:1:2::/64"]),
    );
  });
});

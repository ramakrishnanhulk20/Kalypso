// Covers the wallet birth routes: a birth is stored only for a successful transaction, read from
// RPC by its hash, whose envelope hashes to that hash and whose one operation creates the address
// (the live testnet creation behind live-wallet-creation.json, fed through the fake RPC, is accepted
// and then found by lookup, which also lists the creations the sponsor relayed, newest first, at
// most 20, saying when older ones were left out); a second record changes nothing; a failed
// transaction, another address's creation, a lying envelope, NOT_FOUND, malformed input, an
// oversized body and the shared hourly limit are each refused, and no log line carries an IP or a
// wallet.
// Does NOT cover: live RPC (the fake serves the envelope testnet served), whether a birth is the
// worker's own (the browser judges that: packages/web/lib/worker/passkey.test.ts), or a real
// Postgres server (PGlite runs the same SQL).
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Account, FeeBumpTransaction, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { MAX_CREATION_RELAYS, finishCreationRelay, startCreationRelay, type Db } from "../../src/archive/db.ts";
import { createLogger } from "../../src/log.ts";
import { walletBirthLookupHandler, walletBirthRecordHandler, type WalletBirthRecordContext } from "../../src/sponsor/birth.ts";
import { sponsorStatusHandler } from "../../src/sponsor/handler.ts";
import { testConfig } from "../helpers.ts";
import { clearTables, freshDb } from "../db.ts";
import { LIVE_CREATION, fakeTransactions } from "./fake-rpc.ts";

const liveCreation = JSON.parse(readFileSync(new URL("./live-wallet-creation.json", import.meta.url), "utf8")) as { created: string; func: string };
const WALLET = liveCreation.created;
const OTHER_WALLET = "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL";
const IP = "203.0.113.9";
const NOW = new Date("2026-10-09T12:00:00Z");
const LIVE = { status: "SUCCESS", envelopeXdr: LIVE_CREATION.envelopeXdr, ledger: LIVE_CREATION.ledger } as const;

let db: Db;
let logs: string[] = [];

beforeAll(async () => {
  db = (await freshDb()).db;
});

beforeEach(async () => {
  await clearTables(db, ["ip_hour", "wallet_births", "relayed_creations"]);
  logs = [];
});

function context(rpc = fakeTransactions({ [LIVE_CREATION.hash]: LIVE }), env: Record<string, string> = {}): WalletBirthRecordContext & { rpc: ReturnType<typeof fakeTransactions> } {
  return { cfg: testConfig({ PER_IP_LIMIT_PER_HOUR: "20", ...env }), db, rpc, log: createLogger([], (line) => logs.push(line)), now: () => NOW };
}

function post(path: "birth" | "birth/lookup", body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://kalypso.test/api/sponsor/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": IP, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

/** A transaction, signed and successful in the fake RPC, whose one operation runs `func`. */
function landed(func: xdr.HostFunction): { hash: string; envelopeXdr: string } {
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(300)
    .build();
  tx.sign(source);
  return { hash: tx.hash().toString("hex"), envelopeXdr: tx.toXDR() };
}

describe("POST /api/sponsor/birth and /api/sponsor/birth/lookup", () => {
  it("stores the live testnet creation of the fixture wallet, then the lookup finds it, and no line names the wallet or the IP", async () => {
    const ctx = context();
    expect(await read(await walletBirthRecordHandler(post("birth", { address: WALLET, hash: LIVE_CREATION.hash }), ctx))).toEqual({ status: 200, body: { recorded: true } });
    expect(ctx.rpc.getTransaction).toHaveBeenCalledWith(LIVE_CREATION.hash);
    expect(await read(await walletBirthLookupHandler(post("birth/lookup", { address: WALLET }), ctx))).toEqual({ status: 200, body: { hash: LIVE_CREATION.hash, relayed: [], more: false } });
    expect(await read(await walletBirthLookupHandler(post("birth/lookup", { address: OTHER_WALLET }), ctx))).toEqual({ status: 200, body: { hash: null, relayed: [], more: false } });
    expect(await db.query("select address, tx_hash, ledger from wallet_births")).toEqual([{ address: WALLET, tx_hash: LIVE_CREATION.hash, ledger: LIVE_CREATION.ledger }]);
    expect(logs.join("\n")).not.toContain(WALLET);
    expect(logs.join("\n")).not.toContain(IP);
  });

  it("returns the newest 20 creations the sponsor relayed for the wallet, newest first, and says more only when older ones were left out (f)", async () => {
    const relay = async (n: number) => {
      const id = await startCreationRelay(db, WALLET);
      if (n !== 1) await finishCreationRelay(db, id, `tx_${n}`, n === 0 ? "ab".repeat(32) : null);
    };
    const entry = (n: number) => (n === 1 ? { transactionId: null, hash: null } : { transactionId: `tx_${n}`, hash: n === 0 ? "ab".repeat(32) : null });
    const newestFirst = (oldest: number, newest: number) => Array.from({ length: newest - oldest + 1 }, (_, i) => entry(newest - i));
    const lookup = async () => read(await walletBirthLookupHandler(post("birth/lookup", { address: WALLET }), context()));
    for (let n = 0; n < MAX_CREATION_RELAYS; n++) await relay(n);
    await startCreationRelay(db, OTHER_WALLET);
    expect(await lookup()).toEqual({ status: 200, body: { hash: null, relayed: newestFirst(0, 19), more: false } });
    await relay(MAX_CREATION_RELAYS);
    expect(await lookup()).toEqual({ status: 200, body: { hash: null, relayed: newestFirst(1, 20), more: true } });
  });

  it("keeps the first birth: a second record, by the outer or the inner hash, changes nothing", async () => {
    const inner = (TransactionBuilder.fromXDR(LIVE_CREATION.envelopeXdr, Networks.TESTNET) as FeeBumpTransaction).innerTransaction.hash().toString("hex");
    const ctx = context(fakeTransactions({ [LIVE_CREATION.hash]: LIVE, [inner]: LIVE }));
    for (const hash of [LIVE_CREATION.hash, LIVE_CREATION.hash, inner]) {
      expect(await read(await walletBirthRecordHandler(post("birth", { address: WALLET, hash }), ctx))).toEqual({ status: 200, body: { recorded: true } });
    }
    expect(await db.query("select tx_hash from wallet_births")).toEqual([{ tx_hash: LIVE_CREATION.hash }]);
  });

  it("refuses what is not this address's birth: a failed transaction, another address's creation, an envelope that does not hash to the pointer", async () => {
    const elsewhere = xdr.HostFunction.fromXDR(liveCreation.func, "base64");
    elsewhere.createContractV2().contractIdPreimage().fromAddress().salt(Buffer.alloc(32, 9));
    const other = landed(elsewhere);
    const lie = "ab".repeat(32);
    const ctx = context(
      fakeTransactions({
        [LIVE_CREATION.hash]: { ...LIVE, status: "FAILED" },
        [other.hash]: { status: "SUCCESS", envelopeXdr: other.envelopeXdr, ledger: 5_100_900 },
        [lie]: LIVE,
      }),
    );
    for (const hash of [LIVE_CREATION.hash, other.hash, lie]) {
      expect(await read(await walletBirthRecordHandler(post("birth", { address: WALLET, hash }), ctx)), hash).toEqual({ status: 400, body: { error: "not_a_birth" } });
    }
    expect(await db.query("select * from wallet_births")).toEqual([]);
  });

  it("answers 404 when RPC does not hold the transaction and 503 when RPC cannot answer, storing nothing", async () => {
    const missing = await walletBirthRecordHandler(post("birth", { address: WALLET, hash: "cd".repeat(32) }), context());
    expect(await read(missing)).toEqual({ status: 404, body: { error: "birth_unavailable" } });
    const down = await walletBirthRecordHandler(post("birth", { address: WALLET, hash: LIVE_CREATION.hash }), context(fakeTransactions({}, { fail: true })));
    expect(await read(down)).toEqual({ status: 503, body: { error: "rpc_unavailable" } });
    expect(await db.query("select * from wallet_births")).toEqual([]);
  });

  it("refuses a malformed address or hash, a body of the wrong shape or size, and a request it cannot place, all before RPC", async () => {
    const ctx = context();
    const record = (body: unknown, headers?: Record<string, string>) => walletBirthRecordHandler(post("birth", body, headers), ctx).then(read);
    const lookup = (body: unknown) => walletBirthLookupHandler(post("birth/lookup", body), ctx).then(read);
    const refused = (status: number, error: string) => ({ status, body: { error } });
    for (const address of [Keypair.random().publicKey(), WALLET.toLowerCase(), " " + WALLET, "C123", 7]) {
      expect(await record({ address, hash: LIVE_CREATION.hash }), String(address)).toEqual(refused(400, "bad_address"));
      expect(await lookup({ address }), String(address)).toEqual(refused(400, "bad_address"));
    }
    for (const hash of [LIVE_CREATION.hash.toUpperCase(), "ab", null]) expect(await record({ address: WALLET, hash })).toEqual(refused(400, "bad_hash"));
    expect(await record({ address: WALLET, hash: LIVE_CREATION.hash, ledger: 1 })).toEqual(refused(400, "bad_request"));
    expect(await lookup({ address: WALLET, hash: LIVE_CREATION.hash })).toEqual(refused(400, "bad_request"));
    expect(await lookup([WALLET])).toEqual(refused(400, "bad_request"));
    expect(await record("{not json")).toEqual(refused(400, "invalid_json"));
    expect(await record(JSON.stringify({ address: WALLET, hash: LIVE_CREATION.hash, pad: "x".repeat(2_048) }))).toEqual(refused(413, "body_too_large"));
    expect(await record({ address: WALLET, hash: LIVE_CREATION.hash }, { "content-type": "text/plain" })).toEqual(refused(415, "unsupported_media_type"));
    expect(await read(await walletBirthLookupHandler(new Request("https://kalypso.test/api/sponsor/birth/lookup", { headers: { "x-real-ip": IP } }), ctx))).toEqual(refused(405, "method_not_allowed"));
    expect(await read(await walletBirthLookupHandler(post("birth/lookup", { address: WALLET }, { "x-real-ip": "" }), ctx))).toEqual(refused(400, "no_client_ip"));
    expect(ctx.rpc.getTransaction).not.toHaveBeenCalled();
  });

  it("counts every request per IP before reading it, in the status route's own hourly bucket, and logs the refusal with the salted tag", async () => {
    const ctx = context(undefined, { PER_IP_LIMIT_PER_HOUR: "3" });
    expect((await walletBirthLookupHandler(post("birth/lookup", "{broken"), ctx)).status).toBe(400);
    expect((await walletBirthRecordHandler(post("birth", { address: WALLET, hash: LIVE_CREATION.hash }), ctx)).status).toBe(200);
    expect((await sponsorStatusHandler(new Request("https://kalypso.test/api/sponsor/status?id=not%20an%20id", { headers: { "x-real-ip": IP } }), ctx)).status).toBe(400);
    expect(await read(await walletBirthLookupHandler(post("birth/lookup", { address: WALLET }), ctx))).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(await read(await walletBirthRecordHandler(post("birth", { address: WALLET, hash: LIVE_CREATION.hash }), ctx))).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(ctx.rpc.getTransaction).toHaveBeenCalledTimes(1);
    const limited = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.code === "rate_limited");
    expect(limited.map((line) => line.event)).toEqual(["wallet_birth_lookup_refused", "wallet_birth_record_refused"]);
    expect(limited.every((line) => typeof line.ipTag === "string" && (line.ipTag as string).length === 16)).toBe(true);
    expect(await read(await walletBirthLookupHandler(post("birth/lookup", { address: WALLET }, { "x-real-ip": "198.51.100.4" }), ctx))).toEqual({ status: 200, body: { hash: LIVE_CREATION.hash, relayed: [], more: false } });
  });

  it("answers 500 internal_error, naming only the error class, when the database fails", async () => {
    const broken = { ...context(), db: { ...db, query: async () => Promise.reject(new Error("connection lost to db.internal")) } };
    expect(await read(await walletBirthLookupHandler(post("birth/lookup", { address: WALLET }), broken))).toEqual({ status: 500, body: { error: "internal_error" } });
    expect(logs.at(-1)).toContain('"error":"Error"');
    expect(logs.join("\n")).not.toContain("connection lost");
  });
});

// Covers the cash-out at the anchor (threat model C27): the SEP-10 challenge is read with the SDK's
// checker before anything is signed, endpoints are taken only on the anchor's own https origin,
// window messages pass only from the exact origin, the payment is built and sent only as the
// anchor's authenticated record asks, and the screen follows that record's status in plain words.
// Does NOT cover: the live test anchor and its hosted page (the scratch live run does), a real
// Freighter prompt (a keypair stands in), or Horizon's own answers beyond the fields read here.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, Transaction, TransactionBuilder, WebAuth, xdr } from "@stellar/stellar-sdk";
import { parseUsdc, type KalypsoKeys } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { buildAnchorPayment, isAnchorMessage, sendAnchorPayment, startCashOut, watchCashOut, type CashOutStatus } from "./anchor";
import { workerConfig } from "./config";
import { openSession, type WorkerRuntime } from "./session";

const config = workerConfig();
const HOME = "testanchor.stellar.org";
const BASE = `https://${HOME}`;
const server = Keypair.random();
const UI = "https://anchor-ref-ui-testanchor.stellar.org/sep24/withdraw?token=abc";

function worker() {
  const seed = new Uint8Array(randomBytes(32));
  const cash = Keypair.fromRawEd25519Seed(Buffer.from(seed));
  const session = openSession(
    { kind: "passkey", address: "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL", cashOutAddress: cash.publicKey(), keys: {} as KalypsoKeys, auditorId: null },
    { kind: "passkey", keyId: "a", publicKey: new Uint8Array(65), cashOutSeed: seed, signEntry: async () => "", deployFunc: null, proven: true, deployed: true },
  );
  return { session, cash };
}

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

interface Horizon {
  /** The cash-out account as Horizon shows it; null for an account that does not exist. */
  account?: Record<string, unknown> | null;
  payments?: Record<string, unknown>[];
  transactions?: Record<string, Record<string, unknown>>;
}

const funded = (xlm: string, subentries = 1) => ({ balances: [{ asset_type: "native", balance: xlm, selling_liabilities: "0.0000000" }], subentry_count: subentries, num_sponsoring: 0, num_sponsored: 0 });

function anchor(p: {
  cash: Keypair;
  challenge?: (account: string) => string;
  toml?: Record<string, unknown>;
  /** The anchor's record, or the record for the nth read of it (from 1). */
  record?: Record<string, unknown> | ((read: number) => Record<string, unknown>);
  /** Reads of the record that fail to connect. */
  unreachable?: number[];
  horizon?: Horizon;
  sleep?: (ms: number) => Promise<void>;
  final?: "SUCCESS" | "FAILED" | "NOT_FOUND";
}) {
  const calls: { method: string; url: string; body?: unknown; auth?: string | undefined }[] = [];
  const sleeps: number[] = [];
  const submitted: string[] = [];
  let reads = 0;
  let clock = Date.now();
  const toml = p.toml ?? { WEB_AUTH_ENDPOINT: `${BASE}/auth`, TRANSFER_SERVER_SEP0024: `${BASE}/sep24`, SIGNING_KEY: server.publicKey(), NETWORK_PASSPHRASE: Networks.TESTNET };
  const challenge = p.challenge ?? ((account: string) => WebAuth.buildChallengeTx(server, account, HOME, 300, Networks.TESTNET, HOME));
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const horizon = { account: funded("10000.0000000"), payments: [], transactions: {}, ...p.horizon };
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ method, url, body, auth });
    const u = new URL(url);
    if (u.origin === config.horizonUrl) {
      if (u.pathname === `/accounts/${p.cash.publicKey()}`) return horizon.account === null ? reply({ status: 404 }, 404) : reply(horizon.account);
      if (u.pathname === `/accounts/${p.cash.publicKey()}/payments`) return reply({ _embedded: { records: horizon.payments } });
      if (u.pathname === "/ledgers") return reply({ _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } });
      const tx = u.pathname.startsWith("/transactions/") ? (horizon.transactions as Record<string, Record<string, unknown>>)[u.pathname.slice(14)] : undefined;
      return tx ? reply(tx) : reply({ status: 404 }, 404);
    }
    if (method === "GET" && u.pathname === "/auth") return reply({ transaction: challenge(u.searchParams.get("account")!), network_passphrase: Networks.TESTNET });
    if (method === "POST" && u.pathname === "/auth") return reply({ token: jwt({ sub: p.cash.publicKey(), exp: Math.floor(Date.now() / 1000) + 3600 }) });
    if (method === "POST" && u.pathname === "/sep24/transactions/withdraw/interactive") return reply({ type: "interactive_customer_info_needed", url: UI, id: "8a5b-41" });
    if (method === "GET" && u.pathname === "/sep24/transaction") {
      reads++;
      if (p.unreachable?.includes(reads)) throw new TypeError("fetch failed");
      return reply({ transaction: (typeof p.record === "function" ? p.record(reads) : p.record) ?? {} });
    }
    return reply({ error: "not found" }, 404);
  };
  const rt = {
    config,
    now: () => clock,
    sleep:
      p.sleep ??
      (async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        // Gives way to timers, so a watch that never stops fails on the test timeout instead of hanging.
        await new Promise((resolve) => setImmediate(resolve));
      }),
    fetch,
    resolveToml: async () => toml,
    exclusive: <T>(_name: string, work: () => Promise<T>) => work(),
    port: {
      sourceAccount: async () => ({ sequence: "4294967296" }),
      submit: async (signed: string) => {
        submitted.push(signed);
        return { hash: new Transaction(signed, Networks.TESTNET).hash().toString("hex") };
      },
      waitFor: async () => ({ status: p.final ?? "SUCCESS" }),
    },
  } as unknown as WorkerRuntime;
  return { rt, calls, sleeps, submitted, reads: () => reads };
}

function resigned(challengeXdr: string, change: (tx: xdr.Transaction) => void): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(challengeXdr, "base64");
  change(envelope.v1().tx());
  envelope.v1().signatures([]);
  const tx = new Transaction(envelope, Networks.TESTNET);
  tx.sign(server);
  return tx.toXDR();
}

describe("startCashOut", () => {
  it("logs in with SEP-10, opens a USDC withdrawal and names the anchor page's origin", async () => {
    const { session, cash } = worker();
    const { rt, calls } = anchor({ cash });
    const start = await startCashOut(rt, session);
    expect(start).toEqual({ interactiveUrl: UI, anchorOrigin: "https://anchor-ref-ui-testanchor.stellar.org", transactionId: "8a5b-41" });
    const signedChallenge = calls.find((c) => c.method === "POST" && c.url === `${BASE}/auth`)!.body as { transaction: string };
    const tx = new Transaction(signedChallenge.transaction, Networks.TESTNET);
    expect(tx.signatures.some((s) => cash.verify(tx.hash(), s.signature()))).toBe(true);
    const interactive = calls.find((c) => c.url.endsWith("/withdraw/interactive"))!;
    expect(interactive.body).toEqual({ asset_code: "USDC", asset_issuer: config.usdc.issuer, account: cash.publicKey() });
    expect(interactive.auth).toMatch(/^Bearer e30\./);
  });

  it.each<[string, (account: string) => string]>([
    ["sequence 1", (account) => resigned(WebAuth.buildChallengeTx(server, account, HOME, 300, Networks.TESTNET, HOME), (tx) => tx.seqNum(xdr.Int64.fromString("1")))],
    [
      "a payment operation",
      (account) => {
        const now = Math.floor(Date.now() / 1000);
        const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), { fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: now, maxTime: now + 300 } })
          .addOperation(Operation.manageData({ name: `${HOME} auth`, value: randomBytes(48).toString("base64"), source: account }))
          .addOperation(Operation.manageData({ name: "web_auth_domain", value: HOME, source: server.publicKey() }))
          .addOperation(Operation.payment({ destination: server.publicKey(), asset: Asset.native(), amount: "100", source: account }))
          .build();
        tx.sign(server);
        return tx.toXDR();
      },
    ],
    ["another account", () => WebAuth.buildChallengeTx(server, Keypair.random().publicKey(), HOME, 300, Networks.TESTNET, HOME)],
    ["a signature from another server key", (account) => WebAuth.buildChallengeTx(Keypair.random(), account, HOME, 300, Networks.TESTNET, HOME)],
  ])("refuses a challenge with %s before signing it", async (_label, challenge) => {
    const { session, cash } = worker();
    const { rt, calls } = anchor({ cash, challenge });
    await expect(startCashOut(rt, session)).rejects.toMatchObject({ code: "ANCHOR_CHALLENGE_INVALID" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("takes endpoints only on the anchor's own https origin", async () => {
    const { session, cash } = worker();
    for (const WEB_AUTH_ENDPOINT of ["https://evil.example/auth", "http://testanchor.stellar.org/auth", "https://testanchor.stellar.org.evil.example/auth"]) {
      const { rt, calls } = anchor({ cash, toml: { WEB_AUTH_ENDPOINT, TRANSFER_SERVER_SEP0024: `${BASE}/sep24`, SIGNING_KEY: server.publicKey() } });
      await expect(startCashOut(rt, session)).rejects.toMatchObject({ code: "ANCHOR_CONFIG_INVALID" });
      expect(calls).toEqual([]);
    }
  });
});

describe("isAnchorMessage", () => {
  const origin = "https://anchor-ref-ui-testanchor.stellar.org";
  it("accepts only the anchor page's exact origin, both sides through URL().origin", () => {
    expect(isAnchorMessage("https://anchor-ref-ui-testanchor.stellar.org", origin)).toBe(true);
    expect(isAnchorMessage("https://ANCHOR-REF-UI-testanchor.stellar.org", `${origin}/sep24/withdraw?x=1`)).toBe(true);
    for (const other of ["https://anchor-ref-ui-testanchor.stellar.org.evil.example", "http://anchor-ref-ui-testanchor.stellar.org", "https://testanchor.stellar.org", "https://anchor-ref-ui-testanchor.stellar.org:8443", "null", "", "not a url"]) {
      expect(isAnchorMessage(other, origin), other).toBe(false);
    }
  });
});

describe("buildAnchorPayment", () => {
  const destination = Keypair.random().publicKey();
  const record = (fields: Record<string, unknown>) => ({
    id: "8a5b-41",
    kind: "withdrawal",
    status: "pending_user_transfer_start",
    amount_in: "12.5",
    amount_in_asset: `stellar:USDC:${config.usdc.issuer}`,
    withdraw_anchor_account: destination,
    withdraw_memo_type: "text",
    withdraw_memo: "kalypso-42",
    ...fields,
  });

  it("builds the payment only from the anchor's authenticated record, unsigned", async () => {
    const { session, cash } = worker();
    const { rt, calls } = anchor({ cash, record: record({}) });
    const payment = await buildAnchorPayment(rt, session, "8a5b-41");
    expect(payment).toMatchObject({ destination, amount: 125_000_000n, memo: { type: "text", value: "kalypso-42" } });
    const tx = new Transaction(payment.xdr, Networks.TESTNET);
    expect(tx.signatures).toEqual([]);
    expect(tx.source).toBe(cash.publicKey());
    expect(tx.memo.value?.toString()).toBe("kalypso-42");
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({ type: "payment", destination, amount: "12.5000000", asset: { code: "USDC", issuer: config.usdc.issuer } });
    const read = calls.find((c) => c.url.startsWith(`${BASE}/sep24/transaction?`))!;
    expect(new URL(read.url).searchParams.get("id")).toBe("8a5b-41");
    expect(read.auth).toMatch(/^Bearer /);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["before the worker finishes the anchor's page", { status: "incomplete" }, "ANCHOR_NOT_READY"],
    ["for another withdrawal", { id: "other" }, "ANCHOR_RECORD_INVALID"],
    ["for another asset", { amount_in_asset: "stellar:USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }, "ANCHOR_RECORD_INVALID"],
    ["to a contract", { withdraw_anchor_account: "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL" }, "ANCHOR_RECORD_INVALID"],
    ["with an amount in another format", { amount_in: "1e2" }, "ANCHOR_RECORD_INVALID"],
    ["with an unknown memo type", { withdraw_memo_type: "return" }, "ANCHOR_RECORD_INVALID"],
  ])("refuses a record %s", async (_label, fields, code) => {
    const { session, cash } = worker();
    const { rt } = anchor({ cash, record: record(fields) });
    await expect(buildAnchorPayment(rt, session, "8a5b-41")).rejects.toMatchObject({ code });
  });
});

describe("watchCashOut", () => {
  const ID = "8a5b-41";
  const at = (status: string, fields: Record<string, unknown> = {}) => ({ id: ID, kind: "withdrawal", status, ...fields });
  const SENTENCES: [CashOutStatus, string][] = [
    ["incomplete", "The anchor is waiting for you to finish its page."],
    ["pending_user_transfer_start", "The anchor is ready. Approve the USDC transfer."],
    ["pending_user_transfer_complete", "The anchor has your USDC, and the cash is ready to collect."],
    ["pending_external", "The anchor has sent the cash and is waiting for the bank to confirm it."],
    ["pending_anchor", "The anchor is processing your cash-out."],
    ["on_hold", "The anchor is reviewing this cash-out before it continues."],
    ["pending_stellar", "The anchor is sending a Stellar transaction for this cash-out."],
    ["pending_trust", "The anchor is waiting for your account to accept the asset it is sending."],
    ["pending_user", "The anchor needs something more from you. Open its page to see what."],
    ["completed", "Done. The anchor has paid out."],
    ["refunded", "The anchor sent your USDC back."],
    ["expired", "The anchor closed this cash-out because the USDC did not arrive in time."],
    ["no_market", "The anchor could not find a market to convert this cash-out, so it stopped."],
    ["too_small", "This amount is below the anchor's minimum, so it stopped."],
    ["too_large", "This amount is above the anchor's maximum, so it stopped."],
    ["error", "The anchor stopped this cash-out."],
  ];
  const STOPS_AT = new Set(["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error", "pending_user_transfer_start"]);

  it.each(SENTENCES)("names %s in a plain sentence", async (status, message) => {
    const { session, cash } = worker();
    const { rt, reads } = anchor({ cash, record: (read) => at(read === 1 ? status : "completed") });
    const seen: { status: string; message: string }[] = [];
    const last = await watchCashOut(rt, session, ID, (s) => seen.push(s));
    expect(seen[0]).toEqual({ status, message });
    expect(last.status).toBe(STOPS_AT.has(status) ? status : "completed");
    expect(reads()).toBe(STOPS_AT.has(status) ? 1 : 2);
  });

  it("shows the anchor's own explanation of an error as plain text, capped, and reads the record's amounts with core's parser", async () => {
    const { session, cash } = worker();
    const bidi = String.fromCharCode(0x202e);
    const said = `Bank\u0000 account ${bidi}closed.\n\n${"x".repeat(400)}`;
    const { rt } = anchor({ cash, record: at("error", { message: said, amount_in: "1.5", amount_fee: "0", amount_out: "1.5", more_info_url: "javascript:alert(1)" }) });
    const last = await watchCashOut(rt, session, ID, () => undefined);
    expect(last.message.startsWith("Bank account closed. xxx")).toBe(true);
    expect(last.message).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(Array.from(last.message).length).toBeLessThanOrEqual(283);
    expect(last).toMatchObject({ amountIn: parseUsdc("1.5"), amountFee: 0n, amountOut: 15_000_000n, moreInfoUrl: null });
  });

  it("refuses a status SEP-24 does not define, and an amount in another format", async () => {
    const { session, cash } = worker();
    await expect(watchCashOut(anchor({ cash, record: at("paid") }).rt, session, ID, () => undefined)).rejects.toMatchObject({ code: "ANCHOR_RECORD_INVALID" });
    await expect(watchCashOut(anchor({ cash, record: at("constructor") }).rt, session, ID, () => undefined)).rejects.toMatchObject({ code: "ANCHOR_RECORD_INVALID" });
    await expect(watchCashOut(anchor({ cash, record: at("completed", { amount_in: "1e2" }) }).rt, session, ID, () => undefined)).rejects.toMatchObject({ code: "ANCHOR_RECORD_INVALID" });
  });

  it("polls every 5 s for the first minute, then every 15 s, and tells each new status once", async () => {
    const { session, cash } = worker();
    const { rt, sleeps } = anchor({ cash, record: (read) => at(read <= 15 ? "pending_anchor" : "completed") });
    const seen: string[] = [];
    await watchCashOut(rt, session, ID, (s) => seen.push(s.status));
    expect(sleeps).toEqual([...Array<number>(12).fill(5_000), 15_000, 15_000, 15_000]);
    expect(seen).toEqual(["pending_anchor", "completed"]);
  });

  it("stops polling after 30 minutes and hands back the latest record", async () => {
    const { session, cash } = worker();
    const { rt, sleeps, reads } = anchor({ cash, record: at("pending_anchor") });
    const last = await watchCashOut(rt, session, ID, () => undefined);
    expect(last.status).toBe("pending_anchor");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    expect(reads()).toBe(1 + 12 + 116);
  });

  it("rides out two failed polls in a row and stops on the third", async () => {
    const { session, cash } = worker();
    const rides = anchor({ cash, unreachable: [2, 3], record: (read) => at(read < 5 ? "pending_anchor" : "completed") });
    await expect(watchCashOut(rides.rt, session, ID, () => undefined)).resolves.toMatchObject({ status: "completed" });
    const stops = anchor({ cash, unreachable: [2, 3, 4], record: at("pending_anchor") });
    await expect(watchCashOut(stops.rt, session, ID, () => undefined)).rejects.toMatchObject({ code: "ANCHOR_UNAVAILABLE" });
    expect(stops.reads()).toBe(4);
  });

  it("stops on abort with the signal's own reason, before a poll or while waiting, and reads nothing after it", async () => {
    const { session, cash } = worker();
    const reason = new Error("screen closed");
    const early = new AbortController();
    early.abort(reason);
    const before = anchor({ cash, record: at("pending_anchor") });
    await expect(watchCashOut(before.rt, session, ID, () => undefined, early.signal)).rejects.toBe(reason);
    expect(before.reads()).toBe(0);

    const late = new AbortController();
    const waiting = anchor({
      cash,
      record: at("pending_anchor"),
      sleep: () => {
        late.abort(reason);
        return new Promise(() => undefined);
      },
    });
    await expect(watchCashOut(waiting.rt, session, ID, () => undefined, late.signal)).rejects.toBe(reason);
    expect(waiting.reads()).toBe(1);
  });
});

describe("sendAnchorPayment", () => {
  const ID = "8a5b-41";
  const destination = Keypair.random().publicKey();
  const ready = (fields: Record<string, unknown> = {}) => ({
    id: ID,
    kind: "withdrawal",
    status: "pending_user_transfer_start",
    started_at: "2026-10-09T10:00:00.000Z",
    amount_in: "12.5",
    amount_in_asset: `stellar:USDC:${config.usdc.issuer}`,
    withdraw_anchor_account: destination,
    withdraw_memo_type: "text",
    withdraw_memo: "kalypso-42",
    ...fields,
  });
  const recordReads = (calls: { url: string }[]) => calls.filter((c) => c.url.startsWith(`${BASE}/sep24/transaction?`)).length;
  const horizonCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.startsWith(config.horizonUrl)).length;

  function walletWorker(sign?: (xdr: string) => string) {
    const key = Keypair.random();
    const wallet: WalletPort = {
      kind: "throwaway",
      address: key.publicKey(),
      signMessage: async () => {
        throw new Error("not used");
      },
      signTransaction: async (envelope, passphrase) => {
        if (sign) return sign(envelope);
        const tx = new Transaction(envelope, passphrase);
        tx.sign(key);
        return tx.toXDR();
      },
    };
    const session = openSession({ kind: "wallet", address: key.publicKey(), cashOutAddress: key.publicKey(), keys: {} as KalypsoKeys, auditorId: null }, { kind: "wallet", wallet });
    return { session, cash: key };
  }

  it("re-reads the record, signs exactly what it asks with the cash-out key, and watching then follows it to completed", async () => {
    const { session, cash } = worker();
    const { rt, calls, submitted } = anchor({ cash, record: (read) => (read <= 3 ? ready() : ready({ status: read === 4 ? "pending_anchor" : "completed" })) });
    const payment = await buildAnchorPayment(rt, session, ID);
    expect(recordReads(calls)).toBe(1);
    const { hash } = await sendAnchorPayment(rt, session, payment);
    expect(recordReads(calls)).toBe(2);
    expect(submitted).toHaveLength(1);
    const tx = new Transaction(submitted[0]!, Networks.TESTNET);
    const record = ready();
    expect(tx.hash().toString("hex")).toBe(hash);
    expect(tx.source).toBe(cash.publicKey());
    expect(tx.signatures.some((s) => cash.verify(tx.hash(), s.signature()))).toBe(true);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.Payment;
    expect(op).toMatchObject({ type: "payment", destination: record.withdraw_anchor_account, asset: { code: "USDC", issuer: config.usdc.issuer } });
    expect(parseUsdc(op.amount)).toBe(parseUsdc(record.amount_in));
    expect(tx.memo.type).toBe(record.withdraw_memo_type);
    expect(tx.memo.value?.toString()).toBe(record.withdraw_memo);

    await expect(sendAnchorPayment(rt, session, payment)).rejects.toMatchObject({ code: "ANCHOR_ALREADY_PAID", hash });
    expect(submitted).toHaveLength(1);
    const seen: string[] = [];
    const last = await watchCashOut(rt, session, ID, (s) => seen.push(s.status));
    expect(seen).toEqual(["pending_user_transfer_start", "pending_anchor", "completed"]);
    expect(last.status).toBe("completed");
  });

  it("has a wallet worker's own wallet sign it, and refuses a wallet that hands back another transaction", async () => {
    const honest = walletWorker();
    const ok = anchor({ cash: honest.cash, record: ready() });
    await sendAnchorPayment(ok.rt, honest.session, await buildAnchorPayment(ok.rt, honest.session, ID));
    const sent = new Transaction(ok.submitted[0]!, Networks.TESTNET);
    expect(sent.signatures.some((s) => honest.cash.verify(sent.hash(), s.signature()))).toBe(true);

    let key: Keypair | undefined;
    const swapping = walletWorker((envelope) => {
      const tx = new Transaction(envelope, Networks.TESTNET);
      if (tx.operations[0]?.type === "payment") {
        const other = new TransactionBuilder(new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()), { fee: "10000", networkPassphrase: Networks.TESTNET })
          .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: new Asset("USDC", config.usdc.issuer), amount: "12.5" }))
          .setTimeout(300)
          .build();
        other.sign(key!);
        return other.toXDR();
      }
      tx.sign(key!);
      return tx.toXDR();
    });
    key = swapping.cash;
    const bad = anchor({ cash: swapping.cash, record: ready() });
    const payment = await buildAnchorPayment(bad.rt, swapping.session, ID);
    await expect(sendAnchorPayment(bad.rt, swapping.session, payment)).rejects.toMatchObject({ code: "WALLET_CHANGED_TRANSACTION" });
    expect(bad.submitted).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["another destination", { withdraw_anchor_account: Keypair.random().publicKey() }],
    ["another memo", { withdraw_memo: "kalypso-43" }],
    ["no memo", { withdraw_memo_type: undefined, withdraw_memo: undefined }],
    ["another amount", { amount_in: "12.5000001" }],
    ["a status past ready", { status: "pending_anchor" }],
  ])("refuses, signing nothing, when the record now asks for %s", async (_label, fields) => {
    const { session, cash } = worker();
    const { rt, calls, submitted } = anchor({ cash, record: (read) => (read === 1 ? ready() : ready(fields)) });
    const payment = await buildAnchorPayment(rt, session, ID);
    await expect(sendAnchorPayment(rt, session, payment)).rejects.toMatchObject({ code: "ANCHOR_RECORD_CHANGED" });
    expect(submitted).toEqual([]);
    expect(horizonCalls(calls)).toBe(0);
  });

  it("refuses an envelope that is not exactly the payment its fields describe, before reading the record", async () => {
    const { session, cash } = worker();
    const { rt, calls, submitted } = anchor({ cash, record: ready() });
    const payment = await buildAnchorPayment(rt, session, ID);
    const elsewhere = new TransactionBuilder(new Account(cash.publicKey(), "4294967296"), { fee: "10000", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: new Asset("USDC", config.usdc.issuer), amount: "12.5" }))
      .setTimeout(300)
      .build();
    const extra = TransactionBuilder.cloneFrom(new Transaction(payment.xdr, Networks.TESTNET), { fee: "10000", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
      .build();
    for (const xdrText of [elsewhere.toXDR(), extra.toXDR(), "not xdr"]) {
      await expect(sendAnchorPayment(rt, session, { ...payment, xdr: xdrText })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(recordReads(calls)).toBe(1);
    expect(submitted).toEqual([]);
  });

  it("refuses, naming friendbot, when the cash-out account cannot pay the fee from XLM above its reserve", async () => {
    const { session, cash } = worker();
    for (const account of [null, funded("1.5009999")]) {
      const { rt, submitted } = anchor({ cash, record: ready(), horizon: { account } });
      const err = await sendAnchorPayment(rt, session, await buildAnchorPayment(rt, session, ID)).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CASHOUT_NO_XLM" });
      expect((err as Error).message).toContain("friendbot");
      expect(submitted).toEqual([]);
    }
    const enough = anchor({ cash, record: ready(), horizon: { account: funded("1.5010000") } });
    await sendAnchorPayment(enough.rt, session, await buildAnchorPayment(enough.rt, session, ID));
    expect(enough.submitted).toHaveLength(1);
  });

  it("refuses when Horizon shows this account already paid the same destination, memo and amount since the cash-out started", async () => {
    const earlier = "ab".repeat(32);
    const paidBefore = (fields: Record<string, unknown> = {}, memo = "kalypso-42") => ({
      horizon: {
        payments: [
          {
            created_at: "2026-10-09T10:01:00Z",
            paging_token: "7",
            from: "",
            to: destination,
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: config.usdc.issuer,
            amount: "12.5000000",
            transaction_hash: earlier,
            ...fields,
          },
        ],
        transactions: { [earlier]: { memo_type: "text", memo } },
      },
    });
    const { session, cash } = worker();
    const from = { from: cash.publicKey() };
    const { rt, submitted } = anchor({ cash, record: (read) => ready(read <= 3 ? {} : { status: "completed" }), ...paidBefore(from) });
    const payment = await buildAnchorPayment(rt, session, ID);
    await expect(sendAnchorPayment(rt, session, payment)).rejects.toMatchObject({ code: "ANCHOR_ALREADY_PAID", hash: earlier });
    expect(submitted).toEqual([]);
    const seen: string[] = [];
    await expect(watchCashOut(rt, session, ID, (s) => seen.push(s.status))).resolves.toMatchObject({ status: "completed" });
    expect(seen).toEqual(["pending_user_transfer_start", "completed"]);

    for (const [fields, memo] of [
      [{ ...from, created_at: "2026-10-09T09:00:00Z" }, "kalypso-42"],
      [{ ...from, amount: "12.4" }, "kalypso-42"],
      [{ ...from, to: Keypair.random().publicKey() }, "kalypso-42"],
      [from, "kalypso-43"],
    ] as const) {
      const other = worker();
      const fresh = anchor({ cash: other.cash, record: ready(), ...paidBefore({ ...fields, from: other.cash.publicKey() }, memo) });
      await sendAnchorPayment(fresh.rt, other.session, await buildAnchorPayment(fresh.rt, other.session, ID));
      expect(fresh.submitted).toHaveLength(1);
    }
  });

  it("counts a payment that has not landed yet as sent, so a retry cannot pay twice", async () => {
    const { session, cash } = worker();
    const { rt, submitted } = anchor({ cash, record: ready(), final: "NOT_FOUND" });
    await expect(sendAnchorPayment(rt, session, await buildAnchorPayment(rt, session, ID))).rejects.toMatchObject({ code: "TX_PENDING" });
    await expect(sendAnchorPayment(rt, session, await buildAnchorPayment(rt, session, ID))).rejects.toMatchObject({ code: "ANCHOR_ALREADY_PAID" });
    expect(submitted).toHaveLength(1);
  });
});

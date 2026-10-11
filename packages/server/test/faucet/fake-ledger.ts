import { vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { CIRCLE_TESTNET_USDC_ISSUER } from "../../src/faucet/signer.ts";
import { RpcError, type RpcLedgerEntries, type RpcTransaction } from "../../src/rpc.ts";

export const XLM = 10_000_000n;
export const USDC_ASSET = new Asset("USDC", CIRCLE_TESTNET_USDC_ISSUER);
const LATEST_LEDGER = 5_200_000;

interface FakeAccount {
  balance: bigint;
  seq: bigint;
  subentries: number;
  selling: bigint;
  /** Entries this account pays the reserve for on others' behalf. */
  sponsoring: number;
}

interface FakeLine {
  balance: bigint;
  limit: bigint;
  authorized: boolean;
  selling: bigint;
}

/** What sendTransaction answers. The ones after "ok" still let the payout reach core and land per `landing`. */
export type SendMode =
  | "ok"
  | "try_again_later"
  | "error_bad_seq"
  | "error_insufficient_balance"
  | "error_unreadable"
  | "network"
  | "http_500"
  | "not_json"
  | "bad_reply"
  | "other_hash";
/** What happens to a payout core accepted: applied by the rules, failed on chain, never seen again, or an RPC that names another transaction or an unreadable one. */
export type Landing = "apply" | "failed" | "never" | "lie" | "garbled";

const accountId = (id: string) => Keypair.fromPublicKey(id).xdrAccountId();

/** Never resolves; rejects once `signal` aborts, the way a stalled request ends. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const liabilities = (buying: bigint, selling: bigint) =>
  new xdr.Liabilities({ buying: xdr.Int64.fromString(buying.toString()), selling: xdr.Int64.fromString(selling.toString()) });

type Arms<T> = Record<string, () => T>;

/** A transaction result in XDR: success for null, the transaction's own code for tx*, else one failed operation with this code. */
function resultXdrOf(code: string | null): string {
  if (code === "unreadable") return "AAAA";
  let result: xdr.TransactionResultResult;
  if (code === null) result = xdr.TransactionResultResult.txSuccess([]);
  else if (code.startsWith("tx")) result = (xdr.TransactionResultResult as unknown as Arms<xdr.TransactionResultResult>)[code]!();
  else {
    const tr = code.startsWith("payment")
      ? xdr.OperationResultTr.payment((xdr.PaymentResult as unknown as Arms<xdr.PaymentResult>)[code]!())
      : xdr.OperationResultTr.createAccount((xdr.CreateAccountResult as unknown as Arms<xdr.CreateAccountResult>)[code]!());
    result = xdr.TransactionResultResult.txFailed([xdr.OperationResult.opInner(tr)]);
  }
  return new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString("100"), result, ext: new xdr.TransactionResultExt(0) }).toXDR("base64");
}

/**
 * A stand-in for the RPC calls the faucet makes. getLedgerEntries answers from the accounts and
 * USDC trustlines held here; sendTransaction and the faucet's own getTransaction for a failure's
 * cause are reached through `fetch`, the way the faucet reaches them, and every envelope sent is
 * recorded. An accepted payout is applied the way the network would: the faucet's signature and the
 * next sequence number are required, the fee is charged either way, and a failure carries the
 * network's own result code (createAccountAlreadyExist, paymentNoTrust, paymentUnderfunded...).
 */
export class FakeLedger {
  readonly accounts = new Map<string, FakeAccount>();
  readonly lines = new Map<string, FakeLine>();
  readonly known = new Map<string, RpcTransaction>();
  /** Every envelope sendTransaction received, base64, in order. */
  readonly received: string[] = [];
  send: SendMode = "ok";
  landing: Landing = "apply";
  readFails = false;
  /** Entries RPC adds to every reply that are not what they claim (undecodable XDR). */
  garbage = false;
  /** One call that never answers on its own, only ending when the caller's signal aborts. */
  stall: "read" | "send" | "poll" | null = null;
  /** The result code a "failed" landing records; "unreadable" records a result that does not decode. */
  failWith = "txBadSeq";
  /** Runs just before an accepted payout applies: the ledger moving in between, as the same ledger would. */
  beforeApply: (() => void) | null = null;
  /** How the faucet's read of a failure's cause goes wrong, if it does. */
  causeRead: "ok" | "http_500" | "network" | "not_json" = "ok";
  private readonly results = new Map<string, string>();

  private readonly faucet: Keypair;

  constructor(faucet: Keypair) {
    this.faucet = faucet;
  }

  fund(account: string, balance: bigint, opts: { subentries?: number; selling?: bigint; sponsoring?: number; seq?: bigint } = {}): this {
    this.accounts.set(account, {
      balance,
      seq: opts.seq ?? 1_000n,
      subentries: opts.subentries ?? 0,
      selling: opts.selling ?? 0n,
      sponsoring: opts.sponsoring ?? 0,
    });
    return this;
  }

  trust(account: string, balance = 0n, opts: { limit?: bigint; authorized?: boolean; selling?: bigint } = {}): this {
    this.lines.set(account, { balance, limit: opts.limit ?? 922_337_203_685_477_580n, authorized: opts.authorized ?? true, selling: opts.selling ?? 0n });
    return this;
  }

  envelope(i: number): Transaction {
    return new Transaction(this.received[i]!, Networks.TESTNET);
  }

  readonly getLedgerEntries = vi.fn(async (keys: readonly string[], signal?: AbortSignal): Promise<RpcLedgerEntries> => {
    if (this.stall === "read") await untilAborted(signal);
    if (this.readFails) throw new RpcError("http_status", "503");
    const entries: RpcLedgerEntries["entries"] = [];
    for (const key of keys) {
      const k = xdr.LedgerKey.fromXDR(key, "base64");
      const id = StrKey.encodeEd25519PublicKey((k.switch().name === "account" ? k.account().accountId() : k.trustLine().accountId()).ed25519());
      const data = k.switch().name === "account" ? this.accountEntry(id) : this.lineEntry(id, k.trustLine().asset());
      if (data !== null) entries.push({ key, xdr: data.toXDR("base64") });
    }
    if (this.garbage) entries.push({ key: keys[0]!, xdr: "AAAAAA==" });
    return { entries, latestLedger: LATEST_LEDGER };
  });

  readonly getTransaction = vi.fn(async (hash: string, signal?: AbortSignal): Promise<RpcTransaction> => {
    if (this.stall === "poll") await untilAborted(signal);
    if (this.readFails) throw new RpcError("http_status", "503");
    return this.known.get(hash) ?? { status: "NOT_FOUND" };
  });

  readonly fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: { transaction: string; hash: string } };
    const reply = (result: Record<string, unknown>, status = 200) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status });
    if (request.method === "getTransaction") {
      if (this.causeRead === "http_500") return new Response("upstream down", { status: 500 });
      if (this.causeRead === "network") throw new TypeError("fetch failed");
      if (this.causeRead === "not_json") return new Response("<html>gateway</html>", { status: 200 });
      const found = this.known.get(request.params.hash) ?? { status: "NOT_FOUND" as const };
      return reply(found.status === "NOT_FOUND" ? found : { ...found, resultXdr: this.results.get(request.params.hash) });
    }
    if (request.method !== "sendTransaction") throw new Error("the faucet does not call " + request.method);
    if (this.stall === "send") await untilAborted(init?.signal ?? undefined);
    const envelope = request.params.transaction;
    this.received.push(envelope);
    const tx = new Transaction(envelope, Networks.TESTNET);
    const hash = tx.hash().toString("hex");
    const refusedWith = (code: "txBadSeq" | "txInsufficientBalance") =>
      reply({
        status: "ERROR",
        hash,
        errorResultXdr: new xdr.TransactionResult({
          feeCharged: xdr.Int64.fromString("100"),
          result: code === "txBadSeq" ? xdr.TransactionResultResult.txBadSeq() : xdr.TransactionResultResult.txInsufficientBalance(),
          ext: new xdr.TransactionResultExt(0),
        }).toXDR("base64"),
      });

    if (this.send === "try_again_later") return reply({ status: "TRY_AGAIN_LATER", hash });
    if (this.send === "error_bad_seq") return refusedWith("txBadSeq");
    if (this.send === "error_insufficient_balance") return refusedWith("txInsufficientBalance");
    if (this.send === "error_unreadable") return reply({ status: "ERROR", hash, errorResultXdr: "AAAA" });
    this.land(tx, hash);
    if (this.send === "network") throw new TypeError("fetch failed");
    if (this.send === "http_500") return new Response("upstream down", { status: 500 });
    if (this.send === "not_json") return new Response("<html>gateway</html>", { status: 200 });
    if (this.send === "bad_reply") return reply({ status: "SOMETHING", hash });
    if (this.send === "other_hash") return reply({ status: "PENDING", hash: "ef".repeat(32) });
    return reply({ status: "PENDING", hash, latestLedger: LATEST_LEDGER });
  });

  private land(tx: Transaction, hash: string): void {
    if (this.landing === "never") return;
    if (this.landing === "garbled") {
      this.known.set(hash, { status: "SUCCESS", envelopeXdr: "AAAA", ledger: LATEST_LEDGER + 1 });
      return;
    }
    if (this.landing === "lie") {
      const other = new TransactionBuilder(new Account(this.faucet.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.bumpSequence({ bumpTo: "5" }))
        .setTimeout(60)
        .build();
      this.known.set(hash, { status: "SUCCESS", envelopeXdr: other.toXDR(), ledger: LATEST_LEDGER + 1 });
      return;
    }
    const source = this.accounts.get(tx.source);
    const signed = tx.signatures.some((s) => this.faucet.verify(tx.hash(), s.signature()));
    if (!source || !signed || BigInt(tx.sequence) !== source.seq + 1n) return;
    source.seq += 1n;
    source.balance -= BigInt(tx.fee);
    this.beforeApply?.();
    const failure = this.landing === "failed" ? this.failWith : this.apply(tx);
    this.known.set(hash, { status: failure === null ? "SUCCESS" : "FAILED", envelopeXdr: tx.toXDR(), ledger: LATEST_LEDGER + 1 });
    this.results.set(hash, resultXdrOf(failure));
  }

  /** Applies the one operation, or names the result code it fails with. */
  private apply(tx: Transaction): string | null {
    const op = tx.operations[0]!;
    const source = this.accounts.get(tx.source)!;
    if (op.type === "createAccount") {
      const amount = BigInt(Math.round(Number(op.startingBalance) * 1e7));
      if (this.accounts.has(op.destination)) return "createAccountAlreadyExist";
      if (source.balance < amount) return "createAccountUnderfunded";
      source.balance -= amount;
      this.fund(op.destination, amount);
      return null;
    }
    if (op.type !== "payment") return "txNotSupported";
    const amount = BigInt(Math.round(Number(op.amount) * 1e7));
    const to = this.accounts.get(op.destination);
    if (!to) return "paymentNoDestination";
    if (op.asset.isNative()) {
      if (source.balance < amount) return "paymentUnderfunded";
      source.balance -= amount;
      to.balance += amount;
      return null;
    }
    const from = this.lines.get(tx.source);
    const into = this.lines.get(op.destination);
    if (!from) return "paymentSrcNoTrust";
    if (!into) return "paymentNoTrust";
    if (!into.authorized) return "paymentNotAuthorized";
    if (from.balance < amount) return "paymentUnderfunded";
    if (into.balance + amount > into.limit) return "paymentLineFull";
    from.balance -= amount;
    into.balance += amount;
    return null;
  }

  private accountEntry(id: string): xdr.LedgerEntryData | null {
    const a = this.accounts.get(id);
    if (!a) return null;
    const v2 = new xdr.AccountEntryExtensionV2({
      numSponsored: 0,
      numSponsoring: a.sponsoring,
      signerSponsoringIDs: [],
      ext: new xdr.AccountEntryExtensionV2Ext(0),
    });
    const ext =
      a.selling === 0n && a.sponsoring === 0
        ? new xdr.AccountEntryExt(0)
        : new xdr.AccountEntryExt(
            1,
            new xdr.AccountEntryExtensionV1({
              liabilities: liabilities(0n, a.selling),
              ext: a.sponsoring === 0 ? new xdr.AccountEntryExtensionV1Ext(0) : new xdr.AccountEntryExtensionV1Ext(2, v2),
            }),
          );
    return xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId: accountId(id),
        balance: xdr.Int64.fromString(a.balance.toString()),
        seqNum: xdr.Int64.fromString(a.seq.toString()),
        numSubEntries: a.subentries,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext,
      }),
    );
  }

  private lineEntry(id: string, asset: xdr.TrustLineAsset): xdr.LedgerEntryData | null {
    const line = this.lines.get(id);
    if (!line || asset.toXDR("base64") !== USDC_ASSET.toTrustLineXDRObject().toXDR("base64")) return null;
    return xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId: accountId(id),
        asset,
        balance: xdr.Int64.fromString(line.balance.toString()),
        limit: xdr.Int64.fromString(line.limit.toString()),
        flags: line.authorized ? 1 : 0,
        ext:
          line.selling === 0n
            ? new xdr.TrustLineEntryExt(0)
            : new xdr.TrustLineEntryExt(1, new xdr.TrustLineEntryV1({ liabilities: liabilities(0n, line.selling), ext: new xdr.TrustLineEntryV1Ext(0) })),
      }),
    );
  }
}

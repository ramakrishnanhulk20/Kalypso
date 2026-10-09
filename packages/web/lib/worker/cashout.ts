import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  MAX_STROOPS,
  buildMerge,
  buildWithdraw,
  buildWorkerMerge,
  buildWorkerWithdraw,
  confidentialBalance,
  getAuditorKey,
  loadWorkerBalance,
  transactionHash,
} from "@kalypso/core";
import type { InvocationBase, Opening } from "@kalypso/core";
import { WorkerError, toWorkerError } from "./errors";
import { historyFrom, historyStart } from "./payslips";
import { commit, type Point } from "./sdk";
import { sendCall, sendSelfPaid, type WorkerCall } from "./send";
import { heldBy, type WorkerRuntime, type WorkerSession } from "./session";
import { SponsorError, type SponsorPort } from "./sponsor";
import { readWorkerRecord } from "./storage";

export interface WithdrawResult {
  /**
   * The withdraw transaction, or null when the chain shows the withdraw landed but its hash was
   * lost with a relay's answer. Its amount is public on chain, as every withdraw's is.
   */
  hash: string | null;
  /** The merge sent first, when incoming pay had to be moved into the spendable balance. */
  mergeHash: string | null;
  /** Classic transactions that readied the cash-out account (testnet funding, the USDC trustline). */
  setup: string[];
}

// Classic operations pay at most this, enough to clear testnet surge pricing (the seed's figure).
const CLASSIC_FEE = "10000";
const CLASSIC_TIMEOUT_SECONDS = 120;
const APPEAR_LOOKS = 10;
const APPEAR_WAIT_MS = 2_000;
const BALANCE_LOOKS = 6;
const BALANCE_WAIT_MS = 3_000;
// RPC can answer for a ledger a moment before its state reads back, so a landed withdraw is looked
// for a few times before it is called unconfirmed.
const CONFIRM_LOOKS = 3;
const CONFIRM_WAIT_MS = 2_000;
// After a relay went quiet the withdraw may land some seconds later, so the chain is watched for
// about half a minute before the screen offers to pay the fee another way.
const QUIET_LOOKS = 15;

export interface WithdrawOptions {
  /**
   * "sponsor" (the default) relays every call through the fee sponsor. "self" sends the same calls
   * with a G account the worker controls as source and fee payer (sendSelfPaid), for when the
   * sponsor refuses or cannot be reached.
   */
  payFee?: "sponsor" | "self";
}

async function submitClassic(rt: WorkerRuntime, signedXdr: string): Promise<string> {
  const hash = transactionHash(signedXdr, rt.config.networkPassphrase);
  await rt.port.submit(signedXdr);
  const final = await rt.port.waitFor(hash, 60_000);
  if (final.status !== "SUCCESS") throw new WorkerError(final.status === "FAILED" ? "TX_FAILED" : "TX_PENDING", { hash });
  return hash;
}

async function friendbot(rt: WorkerRuntime, account: string): Promise<void> {
  try {
    await rt.fetch(`${rt.config.friendbotUrl}/?addr=${encodeURIComponent(account)}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  } catch {
    // A lost reply is settled by whether the account appears, below.
  }
  for (let look = 0; look < APPEAR_LOOKS; look++) {
    if ((await rt.ledger.classicAccount(account)).exists) return;
    await rt.sleep(APPEAR_WAIT_MS);
  }
  throw new WorkerError("CASHOUT_SETUP_FAILED");
}

/**
 * Makes sure the cash-out account can receive USDC: it exists and holds a USDC trustline, because the
 * token's withdraw pays USDC through Circle's asset contract, which refuses an account without one.
 * The fee sponsor relays only contract calls, so these classic steps are paid from the account's
 * own XLM. A passkey worker's cash-out account is Kalypso's to make, so on testnet friendbot funds
 * it and its PRF-derived key signs the trustline. A wallet worker's account is their own: it must
 * already exist, and their wallet is asked to approve the trustline.
 *
 * @throws WorkerError WALLET_ACCOUNT_MISSING, WALLET_REJECTED, CASHOUT_SETUP_FAILED, TX_FAILED.
 */
async function ensureCashOutAccount(rt: WorkerRuntime, worker: WorkerSession): Promise<string[]> {
  const held = heldBy(worker);
  const account = worker.cashOutAddress;
  let state = await rt.ledger.classicAccount(account);
  if (state.exists && state.usdcTrustline) return [];
  if (!state.exists) {
    if (held.kind === "wallet") throw new WorkerError("WALLET_ACCOUNT_MISSING");
    await friendbot(rt, account);
    state = await rt.ledger.classicAccount(account);
    if (state.usdcTrustline) return [];
  }
  const { sequence } = await rt.port.sourceAccount(account);
  const tx = new TransactionBuilder(new Account(account, sequence), { fee: CLASSIC_FEE, networkPassphrase: rt.config.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", rt.config.usdc.issuer) }))
    .setTimeout(CLASSIC_TIMEOUT_SECONDS)
    .build();
  let signed: string;
  if (held.kind === "passkey") {
    tx.sign(Keypair.fromRawEd25519Seed(Buffer.from(held.cashOutSeed)));
    signed = tx.toXDR();
  } else {
    try {
      signed = await held.wallet.signTransaction(tx.toXDR(), rt.config.networkPassphrase);
    } catch {
      throw new WorkerError("WALLET_REJECTED");
    }
    if (transactionHash(signed, rt.config.networkPassphrase) !== tx.hash().toString("hex")) throw new WorkerError("WALLET_CHANGED_TRANSACTION");
  }
  return [await submitClassic(rt, signed)];
}

/** The worker's balance openings, only when the rebuilt history opens the chain (C16). */
async function openBalance(rt: WorkerRuntime, worker: WorkerSession): Promise<{ spendable: Opening; receiving: Opening }> {
  const balance = await loadWorkerBalance({
    port: rt.port,
    history: historyFrom(rt, await historyStart(rt, readWorkerRecord(rt.storage, worker.address))),
    contracts: { payroll: rt.config.contracts.payroll, token: rt.config.contracts.token },
    worker: worker.address,
    keys: worker.keys,
  });
  if (!balance.complete || balance.spendable === undefined || balance.receiving === undefined) throw new WorkerError("HISTORY_INCOMPLETE");
  return { spendable: balance.spendable, receiving: balance.receiving };
}

/** After a merge, RPC's events can trail the ledger it landed in by a moment, so the balance is read until it opens and covers the amount. */
async function openBalanceAfterMerge(rt: WorkerRuntime, worker: WorkerSession, amount: bigint): Promise<{ spendable: Opening; receiving: Opening }> {
  for (let look = 1; look <= BALANCE_LOOKS; look++) {
    try {
      const balance = await openBalance(rt, worker);
      if (balance.spendable.v >= amount) return balance;
    } catch (err) {
      if (!(err instanceof WorkerError && err.code === "HISTORY_INCOMPLETE")) throw err;
    }
    if (look < BALANCE_LOOKS) await rt.sleep(BALANCE_WAIT_MS);
  }
  throw new WorkerError("HISTORY_INCOMPLETE");
}

/**
 * merge(worker) for either kind. core's buildWorkerMerge accepts only a G worker who is also the
 * transaction source; a passkey wallet never is, so for it the same two checks are made here
 * before the same builder runs.
 */
async function mergeEnvelope(rt: WorkerRuntime, worker: WorkerSession, base: InvocationBase): Promise<string> {
  if (worker.kind === "wallet") return buildWorkerMerge(base, { port: rt.port, worker: worker.address });
  const account = await confidentialBalance(rt.port, rt.config.contracts.token, worker.address);
  if (account === null) throw new WorkerError("NOT_REGISTERED");
  if (account.receiving.is0()) throw new WorkerError("NOTHING_TO_MERGE");
  return buildMerge(base, { account: worker.address });
}

/**
 * withdraw(worker, cash-out account, amount) with its proof, for either kind. A wallet worker goes
 * through core's buildWorkerWithdraw. A passkey wallet cannot (it is never the transaction source),
 * so buildWorkerWithdraw's checks are repeated here in the same order before core's buildWithdraw:
 * the keys are the ones on chain, the opening opens the spendable commitment right now (C16), the
 * amount fits, the prover draws its own salt (C11), and the proof leaves exactly spendable minus amount.
 * next is the spendable commitment the proof leaves, which only this withdraw landing can produce.
 */
async function withdrawEnvelope(rt: WorkerRuntime, worker: WorkerSession, base: InvocationBase, spendable: Opening, amount: bigint): Promise<{ xdr: string; next: Point }> {
  const prover = await rt.prover();
  const registry = rt.config.contracts.auditor;
  if (worker.kind === "wallet") {
    const built = await buildWorkerWithdraw(base, { port: rt.port, prover, registry, worker: worker.address, keys: worker.keys, spendable, to: worker.cashOutAddress, amount });
    return { xdr: built.xdr, next: commit(built.next.v, built.next.r) };
  }
  const account = await confidentialBalance(rt.port, rt.config.contracts.token, worker.address);
  if (account === null) throw new WorkerError("NOT_REGISTERED");
  if (!account.pvk.equals(worker.keys.PVK)) throw new WorkerError("KEYS_MISMATCH");
  if (spendable.v < 0n || spendable.v > MAX_STROOPS || !commit(spendable.v, spendable.r).equals(account.spendable)) throw new WorkerError("HISTORY_INCOMPLETE");
  if (amount > spendable.v) throw new WorkerError("INSUFFICIENT_FUNDS");
  const kAudS = await getAuditorKey(rt.port, registry, account.auditorId);
  const proved = await prover.proveWithdraw({ keys: worker.keys, v: spendable.v, r: spendable.r, amount, kAudS });
  const { v, r } = proved.next;
  if (v !== spendable.v - amount || !proved.next.cSpend.equals(commit(v, r))) throw new WorkerError("AMOUNT_MISMATCH");
  return { xdr: buildWithdraw(base, { from: worker.address, to: worker.cashOutAddress, amount, data: { payload: proved.payload } }), next: proved.next.cSpend };
}

/** Which of `next`, the spendable commitments withdraw proofs left, the chain now holds, or null for none of them. */
async function landedProof(rt: WorkerRuntime, worker: WorkerSession, next: readonly Point[], looks: number): Promise<Point | null> {
  for (let look = 1; look <= looks; look++) {
    const account = await confidentialBalance(rt.port, rt.config.contracts.token, worker.address);
    const found = account === null ? undefined : next.find((point) => account.spendable.equals(point));
    if (found !== undefined) return found;
    if (look < looks) await rt.sleep(CONFIRM_WAIT_MS);
  }
  return null;
}

/**
 * A failure after which the withdraw may still have landed: a sponsor answer that leaves the outcome
 * unknown, a hash not final yet, a network failure, or a failure on chain (which is what a send on
 * an already spent balance gets when an earlier attempt landed first).
 */
function mayHaveLanded(err: unknown): boolean {
  if (err instanceof SponsorError) return err.outcome === "unknown";
  return err instanceof WorkerError && (err.code === "TX_PENDING" || err.code === "TX_FAILED" || err.code === "NETWORK");
}

function hashOf(err: unknown): string | null {
  const hash = (err as { hash?: unknown } | null)?.hash;
  return typeof hash === "string" ? hash : null;
}

/**
 * Moves `amount` stroops of the worker's confidential pay out to their cash-out account as plain
 * USDC: readies that account, merges incoming pay first when the spendable balance alone is short,
 * then proves and sends the withdraw. By default every contract call goes through the sponsor, so
 * the worker pays no contract fee; with payFee "self" the worker's own G account pays instead. It
 * returns only once the chain's spendable balance is the one a proof left (C55).
 *
 * A withdraw whose relay went quiet is watched on chain before the failure is passed on. A retry
 * for the same amount first reads whether it landed after all, and if not, is proved again on the
 * same balance, so one move can never happen twice: if the earlier send lands first, the retry's
 * proof no longer opens the spendable balance and it fails on chain. The amount is public on chain
 * once withdrawn; it is never logged here.
 *
 * @throws WorkerError INVALID_AMOUNT, INVALID_INPUT, INSUFFICIENT_FUNDS, HISTORY_INCOMPLETE,
 *   KEYS_MISMATCH, AMOUNT_MISMATCH, WITHDRAW_NOT_CONFIRMED, CASHOUT_NO_XLM, BUSY, the cash-out
 *   account's own errors, or a send's; SponsorError.
 */
export async function withdraw(rt: WorkerRuntime, worker: WorkerSession, amount: bigint, sponsor: SponsorPort, options: WithdrawOptions = {}): Promise<WithdrawResult> {
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_STROOPS) throw new WorkerError("INVALID_AMOUNT");
  if (typeof sponsor?.send !== "function" || typeof sponsor.status !== "function") throw new WorkerError("INVALID_INPUT");
  const payFee = options?.payFee ?? "sponsor";
  if (payFee !== "sponsor" && payFee !== "self") throw new WorkerError("INVALID_INPUT");
  const held = heldBy(worker);
  const token = rt.config.contracts.token;
  const send = (call: WorkerCall) => (payFee === "self" ? sendSelfPaid(rt, worker, call) : sendCall(rt, worker, sponsor, call));
  return rt.exclusive(`kalypso/worker/v1/withdraw/${worker.address}`, async () => {
    try {
      const setup = await ensureCashOutAccount(rt, worker);
      let basis: Opening | null = null;
      let mergeHash: string | null = null;
      const earlier = held.withdrawal?.amount === amount ? held.withdrawal : undefined;
      if (earlier !== undefined) {
        const account = await confidentialBalance(rt.port, token, worker.address);
        if (account !== null && earlier.next.some((point) => account.spendable.equals(point))) {
          held.withdrawal = undefined;
          return { hash: null, mergeHash: null, setup };
        }
        if (account !== null && account.spendable.equals(commit(earlier.basis.v, earlier.basis.r))) basis = earlier.basis;
      }
      if (basis === null) {
        held.withdrawal = undefined;
        let balance = await openBalance(rt, worker);
        if (amount > balance.spendable.v + balance.receiving.v) throw new WorkerError("INSUFFICIENT_FUNDS");
        if (amount > balance.spendable.v) {
          mergeHash = (await send({ contractId: token, build: (base) => mergeEnvelope(rt, worker, base) })).hash;
          balance = await openBalanceAfterMerge(rt, worker, amount);
        }
        basis = balance.spendable;
      }
      const spendable = basis;
      const pending = held.withdrawal ?? { amount, basis: spendable, next: [] };
      const proof: { mine?: Point } = {};
      let hash: string | null;
      try {
        hash = (
          await send({
            contractId: token,
            build: async (base) => {
              const built = await withdrawEnvelope(rt, worker, base, spendable, amount);
              proof.mine = built.next;
              pending.next.push(built.next);
              held.withdrawal = pending;
              return built.xdr;
            },
          })
        ).hash;
      } catch (err) {
        if (pending.next.length === 0 || !mayHaveLanded(err)) throw err;
        if ((await landedProof(rt, worker, pending.next, err instanceof SponsorError ? QUIET_LOOKS : CONFIRM_LOOKS)) === null) throw err;
        hash = hashOf(err);
      }
      // RPC confirmed the hash the sender named, but a relayer can name any successful transaction:
      // only a balance one of these proofs leaves makes it this withdraw (C55).
      const landed = await landedProof(rt, worker, pending.next, CONFIRM_LOOKS);
      if (landed === null) throw new WorkerError("WITHDRAW_NOT_CONFIRMED", hash === null ? {} : { hash });
      held.withdrawal = undefined;
      // When an earlier attempt is the one that landed, this send's hash is not the move.
      return { hash: landed === proof.mine ? hash : null, mergeHash, setup };
    } catch (err) {
      throw toWorkerError(err);
    }
  });
}

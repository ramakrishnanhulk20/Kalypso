import {
  FeeCapError,
  MAX_SETUP_FEE_STROOPS,
  SubmitRejectedError,
  assembleFromSimulation,
  contractErrorCode,
  decodeInvocation,
  transactionHash,
} from "@kalypso/core";
import type { ChainPort, InvocationBase } from "@kalypso/core";
import { signEnvelope } from "./accounts";
import { SandboxError } from "./errors";
import { Account, TransactionBuilder, type Keypair, type xdr } from "./sdk";
import type { JournalEntry } from "./storage";

const TIMEOUT_SECONDS = 120;
// Ledger close times trail this machine's clock a little; the first wait runs this far past the window.
const CLOCK_MARGIN_MS = 30_000;
// A transaction counts as never landing only once a ledger closed this long after its window, by chain time.
const FINALITY_MARGIN_SECONDS = 30;
// core's live port refuses longer waits.
const MAX_WAIT_MS = 15 * 60_000;
// Classic operations pay at most this per operation, enough to clear testnet surge pricing.
const CLASSIC_FEE = "10000";

/** The record of every transaction a sandbox sent, kept in its saved state. */
export interface Journal {
  get(label: string): JournalEntry | undefined;
  /** Saved before the transaction is handed to the network. */
  pending(label: string, hash: string, validUntil: number): void;
  landed(label: string, hash: string, ledger: number | undefined): void;
  forget(label: string): void;
}

export function journalOf(txs: Record<string, JournalEntry>, save: () => void): Journal {
  return {
    get: (label) => (Object.hasOwn(txs, label) ? txs[label] : undefined),
    pending(label, hash, validUntil) {
      txs[label] = { hash, landed: false, validUntil };
      save();
    },
    landed(label, hash, ledger) {
      txs[label] = ledger === undefined ? { hash, landed: true } : { hash, landed: true, ledger };
      save();
    },
    forget(label) {
      if (!Object.hasOwn(txs, label)) return;
      delete txs[label];
      save();
    },
  };
}

export interface Landed {
  hash: string;
  ledger?: number;
  /** The call's return value as the RPC reported it; decode it with that call's strict decoder. */
  returnValue?: xdr.ScVal;
  /** True when this call found the transaction already on chain and sent nothing. */
  reused: boolean;
}

export interface TxContext {
  port: ChainPort;
  journal: Journal;
  networkPassphrase: string;
}

/**
 * Waits until the chain's answer for a sent transaction is final: SUCCESS, FAILED, or NOT_FOUND
 * once a ledger has closed FINALITY_MARGIN_SECONDS past its window by the chain's own clock.
 *
 * @throws SandboxError PENDING when the chain cannot say yet; the record stays, so a later run looks again.
 */
async function settle(port: ChainPort, hash: string, validUntil: number): Promise<Awaited<ReturnType<ChainPort["waitFor"]>>> {
  const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, validUntil * 1000 - Date.now()) + CLOCK_MARGIN_MS);
  const result = await port.waitFor(hash, waitMs);
  if (result.status !== "NOT_FOUND") return result;
  if (typeof result.closeTime === "number" && result.closeTime > validUntil + FINALITY_MARGIN_SECONDS) return result;
  throw new SandboxError("PENDING", "A sandbox transaction is still waiting on the network. Run the sandbox again in a minute and it carries on.");
}

/**
 * The transaction already sent under `label`, when the chain has it. One recorded as landed is
 * never sent again, even when the RPC no longer finds it. A pending one is waited on until final;
 * if it failed or can no longer land, its record is dropped and null tells the caller to build it
 * again, which is safe because a failed or expired transaction changed nothing.
 */
export async function findRecorded(ctx: TxContext, label: string): Promise<Landed | null> {
  const prior = ctx.journal.get(label);
  if (prior === undefined) return null;
  if (prior.landed) {
    const look = await ctx.port.waitFor(prior.hash, 0);
    if (look.status === "SUCCESS") return { hash: prior.hash, ledger: look.ledger, returnValue: look.returnValue, reused: true };
    return prior.ledger === undefined ? { hash: prior.hash, reused: true } : { hash: prior.hash, ledger: prior.ledger, reused: true };
  }
  const final = await settle(ctx.port, prior.hash, prior.validUntil ?? 0);
  if (final.status === "SUCCESS") {
    ctx.journal.landed(label, prior.hash, final.ledger);
    return { hash: prior.hash, ledger: final.ledger, returnValue: final.returnValue, reused: true };
  }
  ctx.journal.forget(label);
  return null;
}

async function submitAndWait(ctx: TxContext, label: string, signedXdr: string, validUntil: number): Promise<Landed> {
  const hash = transactionHash(signedXdr, ctx.networkPassphrase);
  ctx.journal.pending(label, hash, validUntil);
  try {
    await ctx.port.submit(signedXdr);
  } catch (err) {
    if (err instanceof SubmitRejectedError) {
      ctx.journal.forget(label);
      throw new SandboxError("SUBMIT_REFUSED", `The network refused the ${label} transaction. Run the sandbox again to retry it.`);
    }
    // A lost reply is settled by the chain's answer for this hash, never by the error alone.
  }
  const final = await settle(ctx.port, hash, validUntil);
  if (final.status === "SUCCESS") {
    ctx.journal.landed(label, hash, final.ledger);
    return { hash, ledger: final.ledger, returnValue: final.returnValue, reused: false };
  }
  ctx.journal.forget(label);
  if (final.status === "FAILED") throw new SandboxError("TRANSACTION_FAILED", `The ${label} transaction failed on chain. Run the sandbox again to retry it.`);
  throw new SandboxError("TRANSACTION_EXPIRED", `The ${label} transaction expired before it landed. Run the sandbox again to retry it.`);
}

/**
 * One contract call signed by `signer`, the seed's invoke: build(base) returns the unsigned
 * envelope (it may prove first), then simulate, assemble under the setup fee cap (C39), sign,
 * save the hash, send and wait. A call already on chain under `label` is not sent again.
 *
 * @throws SandboxError SIMULATION_FAILED (with the contract's error number when it named one),
 *   FEE_TOO_HIGH, SUBMIT_REFUSED, TRANSACTION_FAILED, TRANSACTION_EXPIRED or PENDING; or whatever
 *   build or the port threw.
 */
export async function invoke(
  ctx: TxContext,
  p: { label: string; signer: Keypair; build: (base: Omit<InvocationBase, "contractId">) => string | Promise<string> },
): Promise<Landed> {
  const done = await findRecorded(ctx, p.label);
  if (done) return done;
  const address = p.signer.publicKey();
  const { sequence } = await ctx.port.sourceAccount(address);
  const unsigned = await p.build({ source: { address, sequence }, networkPassphrase: ctx.networkPassphrase, timeoutSeconds: TIMEOUT_SECONDS });
  const sim = await ctx.port.simulate(unsigned);
  if (!sim.ok) {
    const code = contractErrorCode(sim.error);
    const why = code === undefined ? "" : ` (contract error ${code})`;
    throw new SandboxError("SIMULATION_FAILED", `The network would not run the ${p.label} call${why}.`, code);
  }
  let assembled: string;
  try {
    assembled = assembleFromSimulation(unsigned, sim, ctx.networkPassphrase, MAX_SETUP_FEE_STROOPS);
  } catch (err) {
    if (err instanceof FeeCapError) throw new SandboxError("FEE_TOO_HIGH", `The network asked too high a fee for the ${p.label} call, so nothing was signed.`);
    throw err;
  }
  const signed = signEnvelope(p.signer, assembled, ctx.networkPassphrase);
  return submitAndWait(ctx, p.label, signed, decodeInvocation(assembled, ctx.networkPassphrase).maxTime);
}

/** One classic transaction (a trustline, a path payment) signed by `signer`, under the same journal rules. */
export async function classic(ctx: TxContext, p: { label: string; signer: Keypair; operations: xdr.Operation[] }): Promise<Landed> {
  const done = await findRecorded(ctx, p.label);
  if (done) return done;
  const address = p.signer.publicKey();
  const { sequence } = await ctx.port.sourceAccount(address);
  const builder = new TransactionBuilder(new Account(address, sequence), { fee: CLASSIC_FEE, networkPassphrase: ctx.networkPassphrase });
  for (const op of p.operations) builder.addOperation(op);
  const tx = builder.setTimeout(TIMEOUT_SECONDS).build();
  tx.sign(p.signer);
  return submitAndWait(ctx, p.label, tx.toXDR(), Number(tx.timeBounds?.maxTime ?? 0));
}

/** True when the transaction recorded under `label` was confirmed by the chain. Only a SUCCESS answer ever records that. */
export function landed(ctx: TxContext, label: string): boolean {
  return ctx.journal.get(label)?.landed === true;
}

/**
 * A u64 contract return value, such as create_company's new id.
 * @throws SandboxError CHAIN_DISAGREES for a missing value or any other type.
 */
export function readU64(value: xdr.ScVal | undefined, what: string): bigint {
  if (value === undefined || value.switch().name !== "scvU64") throw new SandboxError("CHAIN_DISAGREES", `The ${what} call did not return an id.`);
  return BigInt(value.u64().toString());
}

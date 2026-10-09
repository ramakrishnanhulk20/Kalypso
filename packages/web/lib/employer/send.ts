import {
  FeeCapError,
  MAX_SETUP_FEE_STROOPS,
  PAYROLL_ERROR_MESSAGES,
  PayrollErrorCode,
  SubmitRejectedError,
  TokenErrorCode,
  assembleFromSimulation,
  contractErrorCode,
  decodeInvocation,
  transactionHash,
} from "@kalypso/core";
import type { InvocationBase } from "@kalypso/core";
import { Account, TransactionBuilder, type xdr } from "../sandbox/sdk";
import type { WalletPort } from "../wallet/port";
import type { ConsoleContext } from "./context";
import { ConsoleError } from "./errors";

const TIMEOUT_SECONDS = 120;
// Ledger close times trail this machine's clock a little; the first wait runs this far past the window.
const CLOCK_MARGIN_MS = 30_000;
// A transaction counts as never landing only once a ledger closed this long after its window, by chain time.
const FINALITY_MARGIN_SECONDS = 30;
const LEDGER_GAP_MS = 6_000;
const MAX_WAIT_MS = 10 * 60_000;
const MAX_LOOKS = 3;
// A classic operation pays at most this, enough to clear testnet surge pricing. It is set here,
// never taken from the network, so no RPC answer can raise it.
const CLASSIC_FEE = "10000";
// RPC nodes behind one URL can trail each other by a ledger, so a step that just landed is read
// back a few times before it counts as missing.
const CONFIRM_LOOKS = 4;
const CONFIRM_WAIT_MS = 2_500;

export interface Landed {
  hash: string;
  ledger?: number;
  /** The call's return value as the RPC reported it; decode it with that call's strict decoder. */
  returnValue?: xdr.ScVal;
}

// Plain text for the refusals a console call can meet, keyed by contract error number. Payroll,
// token and registry numbers do not overlap, so one table serves every call.
const REFUSALS: Readonly<Record<number, string>> = {
  [PayrollErrorCode.CompanyNotFound]: "No company exists under this id.",
  [PayrollErrorCode.NotRegisteredWithToken]: "The company wallet is not registered with the confidential token yet.",
  [PayrollErrorCode.AuditorMismatch]: "The company wallet is registered under a different accountant id from the one named.",
  [PayrollErrorCode.LabelInvalid]: "The name is empty or longer than the contract allows.",
  [PayrollErrorCode.WorkerIsAdmin]: "The company's own wallet cannot be a worker.",
  [PayrollErrorCode.AlreadyMember]: "This worker is already invited to or active in the company.",
  [PayrollErrorCode.InviteNotFound]: "There is no open invite for this worker.",
  [PayrollErrorCode.RunExists]: "A run for this month already exists.",
  [PayrollErrorCode.RunNotFound]: "This company never opened this run.",
  [PayrollErrorCode.RunNotOpen]: "This run is closed.",
  [PayrollErrorCode.ExpectedCountInvalid]: "A run cannot expect more payments than workers who have joined.",
  [PayrollErrorCode.AuditorNotOwnedByAccountant]: PAYROLL_ERROR_MESSAGES.AuditorNotOwnedByAccountant as string,
  [PayrollErrorCode.TokenUnavailable]: PAYROLL_ERROR_MESSAGES.TokenUnavailable as string,
  [TokenErrorCode.AccountAlreadyRegistered]: "This account is already registered with the confidential token.",
  [TokenErrorCode.AccountNotRegistered]: "This account is not registered with the confidential token yet.",
  [TokenErrorCode.InvalidProof]: "The network refused the proof made in this browser. Try again.",
};

/**
 * Why a simulation refused, from the contract error that ended the call (the first one in the
 * RPC's text, per core's contractErrorCode), never from the text itself.
 */
function refusal(what: string, simError: string | undefined): ConsoleError {
  const code = contractErrorCode(simError);
  const known = code === undefined ? undefined : REFUSALS[code];
  const message = known
    ? `The network would not run the ${what} call: ${known}`
    : `The network would not run the ${what} call${code === undefined ? "" : ` (contract error ${code})`}, so nothing was signed.`;
  return new ConsoleError("SIMULATION_FAILED", code === undefined ? { message } : { message, contractCode: code });
}

/**
 * Waits until the chain's answer for a sent transaction is final: SUCCESS, FAILED, or NOT_FOUND
 * once a ledger has closed FINALITY_MARGIN_SECONDS past its window by the chain's own clock. Also
 * settles a transaction an earlier session sent, from its saved hash and window.
 *
 * @throws ConsoleError TRANSACTION_PENDING when the chain cannot say after MAX_LOOKS waits.
 */
export async function settle(ctx: ConsoleContext, hash: string, validUntil: number): Promise<Awaited<ReturnType<ConsoleContext["port"]["waitFor"]>>> {
  let waitMs = Math.max(0, validUntil * 1000 - Date.now()) + CLOCK_MARGIN_MS;
  for (let look = 0; look < MAX_LOOKS; look++) {
    const result = await ctx.port.waitFor(hash, Math.min(waitMs, MAX_WAIT_MS));
    if (result.status !== "NOT_FOUND") return result;
    if (typeof result.closeTime !== "number" || !Number.isFinite(result.closeTime)) break;
    const shortBySeconds = validUntil + FINALITY_MARGIN_SECONDS - result.closeTime;
    if (shortBySeconds < 0) return result;
    waitMs = shortBySeconds * 1000 + LEDGER_GAP_MS;
  }
  throw new ConsoleError("TRANSACTION_PENDING");
}

/**
 * Has the wallet sign `assembled`, refuses anything but the same transaction back, sends it, and
 * waits for the chain's final answer for the hash computed here, never the RPC's echo of it.
 */
async function signSendSettle(
  ctx: ConsoleContext,
  wallet: WalletPort,
  what: string,
  assembled: string,
  validUntil: number,
  beforeSubmit?: (hash: string, validUntil: number) => Promise<void>,
): Promise<Landed> {
  const { networkPassphrase } = ctx.config;
  const hash = transactionHash(assembled, networkPassphrase);
  const signed = await wallet.signTransaction(assembled, networkPassphrase);
  let signedHash: string | undefined;
  try {
    signedHash = transactionHash(signed, networkPassphrase);
  } catch {
    signedHash = undefined;
  }
  if (signedHash !== hash) throw new ConsoleError("WALLET_CHANGED_TRANSACTION");
  // Once this resolves the caller has kept the hash, so a crash from here on can be settled by it.
  if (beforeSubmit) await beforeSubmit(hash, validUntil);
  try {
    await ctx.port.submit(signed);
  } catch (err) {
    if (err instanceof SubmitRejectedError) throw new ConsoleError("SUBMIT_REFUSED", { message: `The network refused the ${what} transaction, so nothing changed. Try again.` });
    // A lost reply is settled by the chain's answer for this hash, never by the error alone.
  }
  const final = await settle(ctx, hash, validUntil);
  if (final.status === "SUCCESS") {
    const landed: Landed = { hash };
    if (final.ledger !== undefined) landed.ledger = final.ledger;
    if (final.returnValue !== undefined) landed.returnValue = final.returnValue;
    return landed;
  }
  if (final.status === "FAILED") throw new ConsoleError("TRANSACTION_FAILED", { message: `The ${what} transaction failed on chain, so nothing changed. Try again.` });
  throw new ConsoleError("TRANSACTION_EXPIRED", { message: `The ${what} transaction expired before it landed, so nothing changed. Try again.` });
}

/**
 * One contract call signed by the wallet, which also pays its fee: build(base) returns the
 * unsigned envelope (it may prove first), then simulate, assemble under the setup fee cap
 * (core holds a pay to its own lower cap whatever is passed; threat model C39), sign, send, wait.
 *
 * @throws ConsoleError SIMULATION_FAILED (with the contract's error number when it named one),
 *   FEE_TOO_HIGH, WALLET_CHANGED_TRANSACTION, SUBMIT_REFUSED, TRANSACTION_FAILED,
 *   TRANSACTION_EXPIRED or TRANSACTION_PENDING; the wallet's own error; or whatever build threw.
 */
export async function sendCall(
  ctx: ConsoleContext,
  wallet: WalletPort,
  p: {
    what: string;
    contractId: string;
    build: (base: InvocationBase) => string | Promise<string>;
    /** Runs after the wallet signed and before the network sees the transaction; if it throws, nothing is sent. */
    beforeSubmit?: (hash: string, validUntil: number) => Promise<void>;
  },
): Promise<Landed> {
  const { networkPassphrase } = ctx.config;
  const { sequence } = await ctx.port.sourceAccount(wallet.address);
  const unsigned = await p.build({
    source: { address: wallet.address, sequence },
    networkPassphrase,
    contractId: p.contractId,
    timeoutSeconds: TIMEOUT_SECONDS,
  });
  const sim = await ctx.port.simulate(unsigned);
  if (!sim.ok) throw refusal(p.what, sim.error);
  let assembled: string;
  try {
    assembled = assembleFromSimulation(unsigned, sim, networkPassphrase, MAX_SETUP_FEE_STROOPS);
  } catch (err) {
    if (err instanceof FeeCapError) throw new ConsoleError("FEE_TOO_HIGH", { message: `${err.message} (${p.what})` });
    throw err;
  }
  return signSendSettle(ctx, wallet, p.what, assembled, decodeInvocation(assembled, networkPassphrase).maxTime, p.beforeSubmit);
}

/** One classic transaction (a trustline) signed by the wallet, under the same send and settle rules. */
export async function sendClassic(ctx: ConsoleContext, wallet: WalletPort, p: { what: string; operations: xdr.Operation[] }): Promise<Landed> {
  const { networkPassphrase } = ctx.config;
  const { sequence } = await ctx.port.sourceAccount(wallet.address);
  const builder = new TransactionBuilder(new Account(wallet.address, sequence), { fee: CLASSIC_FEE, networkPassphrase });
  for (const op of p.operations) builder.addOperation(op);
  const tx = builder.setTimeout(TIMEOUT_SECONDS).build();
  return signSendSettle(ctx, wallet, p.what, tx.toXDR(), Number(tx.timeBounds?.maxTime ?? 0));
}

/**
 * Reads the chain until check() holds, a few times over a few seconds, for a step that just landed.
 * @throws ConsoleError NOT_ON_CHAIN when it still does not hold.
 */
export async function confirmOnChain(ctx: ConsoleContext, what: string, check: () => Promise<boolean>): Promise<void> {
  for (let look = 1; ; look++) {
    if (await check()) return;
    if (look === CONFIRM_LOOKS) throw new ConsoleError("NOT_ON_CHAIN", { message: `${what} landed, but the chain does not show it yet. Try again in a minute.` });
    await ctx.wait(CONFIRM_WAIT_MS);
  }
}

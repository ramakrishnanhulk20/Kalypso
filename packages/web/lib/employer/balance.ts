import {
  HistoryIncompleteError,
  attemptsKey,
  confidentialBalance,
  fetchAccountHistory,
  loadTreasuryOpening,
  readAttempts,
  readSavedOpening,
  toSavedOpening,
} from "@kalypso/core";
// core applies this rule to a worker's history (payslips/worker.ts) but does not export it; the same
// function is imported so the two can never drift apart.
import { reachesLedger } from "../../../core/dist/history/events.js";
import type { WalletPort } from "../wallet/port";
import { adminCompany } from "./company";
import { consoleContext, reporter, type ConsoleContext, type OnProgress } from "./context";
import { fromCoreError } from "./core-errors";
import { ConsoleError } from "./errors";
import { rebuiltMarkerKey } from "./rebuild";

export interface TreasuryBalance {
  /** The treasury's spendable balance in stroops, from an opening checked against the chain now. */
  value: bigint;
  /**
   * rebuilt: the opening is the one the last rebuild from chain history saved. saved: it is one
   * this browser's own payments left since. Either way it opened the on-chain commitment. empty:
   * the treasury has never had a deposit, so its balance is zero with no history to rebuild.
   */
  source: "saved" | "rebuilt" | "empty";
}

/**
 * True only for a treasury that has never held anything: both balance commitments on chain are
 * the zero opening's commitment (what registration leaves), and its token history, read in full and
 * reaching the newest ledger (core's reachesLedger), holds exactly one event: this treasury's own
 * registration. An empty history, one that stops before the registration or behind the chain, one
 * that cannot be read, or any other event answers false, so the caller keeps reporting the history
 * as incomplete (C16).
 */
async function neverFunded(ctx: ConsoleContext, treasury: string): Promise<boolean> {
  const { token, payroll } = ctx.config.contracts;
  const zero = readSavedOpening(toSavedOpening(0n, 0n));
  if (zero === undefined) return false;
  try {
    const account = await confidentialBalance(ctx.port, token, treasury);
    if (account === null || !account.spendable.equals(zero.commitment) || !account.receiving.equals(zero.commitment)) return false;
    const history = await fetchAccountHistory({
      port: ctx.history.rpc,
      ...(ctx.history.archive === undefined ? {} : { archive: ctx.history.archive }),
      contracts: { token, payroll },
      fromLedger: ctx.history.fromLedger,
      account: treasury,
    });
    const { latestLedger } = await ctx.history.rpc.ledgerWindow();
    const [only, ...more] = history.events;
    return (
      history.complete &&
      reachesLedger(history.ingestedThrough, latestLedger) &&
      more.length === 0 &&
      only !== undefined &&
      only.kind === "token" &&
      only.event.type === "register" &&
      only.event.account === treasury
    );
  } catch {
    return false;
  }
}

/**
 * The treasury balance for the dashboard. It asks the wallet for nothing and sends nothing: core's
 * loadTreasuryOpening tries this browser's saved openings (the treasury's, a pay in flight's, each
 * in the attempts list) against confidential_balance on chain, and only one that opens it is shown
 * (threat model C16). Nothing is written, and nothing is rebuilt: when no saved opening opens the
 * chain, the employer is told and rebuildTreasury is theirs to run (C14, C38). The one exception is
 * a treasury that has never had a deposit: with no saved opening there, it is read as empty, at
 * zero, when neverFunded proves it from the chain.
 *
 * @throws ConsoleError NEEDS_REBUILD (rebuildable true) when no saved opening opens the chain or
 *   this browser has none; COMPANY_ID_INVALID, COMPANY_NOT_FOUND, NOT_ADMIN,
 *   TREASURY_NOT_REGISTERED, STORAGE_UNAVAILABLE or STORAGE_FAILED; the network's own error.
 */
export async function treasuryBalance(wallet: WalletPort, companyId: bigint, onProgress?: OnProgress): Promise<TreasuryBalance> {
  const ctx = consoleContext();
  const token = ctx.config.contracts.token;
  const treasury = wallet.address;
  const p = reporter(onProgress, 1);
  await adminCompany(ctx, wallet, companyId);
  p.say("balance_checking");
  let opened: ReturnType<typeof readSavedOpening>;
  try {
    const pendingKeys = readAttempts(await ctx.store.get(attemptsKey(token, treasury))) ?? [];
    opened = readSavedOpening(await loadTreasuryOpening({ port: ctx.port, store: ctx.store, token, treasury, pendingKeys }));
  } catch (err) {
    // A new treasury has no saved opening because nothing has happened to it yet, not because
    // history went missing; only the chain itself may say which.
    if (err instanceof HistoryIncompleteError && err.reason === "NO_SAVED_OPENING" && (await neverFunded(ctx, treasury))) {
      p.tick("balance_empty");
      return { value: 0n, source: "empty" };
    }
    throw fromCoreError(err);
  }
  if (opened === undefined) throw new ConsoleError("CHAIN_DISAGREES");
  const value = opened.v;
  const marker = readSavedOpening(await ctx.store.get(rebuiltMarkerKey(token, treasury)));
  const source = marker !== undefined && marker.commitment.equals(opened.commitment) ? "rebuilt" : "saved";
  p.tick(source === "rebuilt" ? "balance_rebuilt" : "balance_saved");
  return { value, source };
}

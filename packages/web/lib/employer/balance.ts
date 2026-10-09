import { attemptsKey, loadTreasuryOpening, readAttempts, readSavedOpening } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { adminCompany } from "./company";
import { consoleContext, reporter, type OnProgress } from "./context";
import { fromCoreError } from "./core-errors";
import { ConsoleError } from "./errors";
import { rebuiltMarkerKey } from "./rebuild";

export interface TreasuryBalance {
  /** The treasury's spendable balance in stroops, from an opening checked against the chain now. */
  value: bigint;
  /**
   * rebuilt: the opening is the one the last rebuild from chain history saved. saved: it is one
   * this browser's own payments left since. Either way it opened the on-chain commitment.
   */
  source: "saved" | "rebuilt";
}

/**
 * The treasury balance for the dashboard. It asks the wallet for nothing and sends nothing: core's
 * loadTreasuryOpening tries this browser's saved openings (the treasury's, a pay in flight's, each
 * in the attempts list) against confidential_balance on chain, and only one that opens it is shown
 * (threat model C16). Nothing is written, and nothing is rebuilt: when no saved opening opens the
 * chain, the employer is told and rebuildTreasury is theirs to run (C14, C38).
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
  p.say("Checking this browser's treasury records against the chain");
  let opened: ReturnType<typeof readSavedOpening>;
  try {
    const pendingKeys = readAttempts(await ctx.store.get(attemptsKey(token, treasury))) ?? [];
    opened = readSavedOpening(await loadTreasuryOpening({ port: ctx.port, store: ctx.store, token, treasury, pendingKeys }));
  } catch (err) {
    throw fromCoreError(err);
  }
  if (opened === undefined) throw new ConsoleError("CHAIN_DISAGREES");
  const value = opened.v;
  const marker = readSavedOpening(await ctx.store.get(rebuiltMarkerKey(token, treasury)));
  const source = marker !== undefined && marker.commitment.equals(opened.commitment) ? "rebuilt" : "saved";
  p.tick(source === "rebuilt" ? "The balance comes from the last rebuild and matches the chain" : "The balance comes from this browser's records and matches the chain");
  return { value, source };
}

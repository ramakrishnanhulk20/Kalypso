import { HistoryIncompleteError, clearInFlight, inFlightKey, readInFlight, readSavedOpening, rebuildTreasuryOpening, treasuryOpeningKey } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { consoleContext, reporter, type ConsoleContext, type OnProgress } from "./context";
import { fromCoreError } from "./core-errors";
import { ConsoleError } from "./errors";
import { adminCompany } from "./company";
import { walletKeys } from "./keys";
import { withWalletLock } from "./lock";

// The RPC's event index can trail a merge that just landed by a ledger or two, which reads as an
// incomplete history; a few looks a few seconds apart cover that, and nothing is saved meanwhile.
const REBUILD_LOOKS = 4;
const REBUILD_WAIT_MS = 3_000;

/**
 * Store key of a copy of the opening the last rebuild saved. treasuryBalance compares it with the
 * opening that opens the chain to say whether the balance shown came from a rebuild or from this
 * browser's own records since.
 */
export function rebuiltMarkerKey(token: string, treasury: string): string {
  return `kalypso/employer/v1/rebuilt/${token}/${treasury}`;
}

export interface RebuiltTreasury {
  /** The treasury's spendable balance in stroops, rebuilt from history and checked against chain. */
  value: bigint;
  /** What this browser last expected, from its own records; undefined when it kept none. Never a balance. */
  deviceExpected: bigint | undefined;
  /** False is the signal the employer must see before paying on (threat model C14). */
  matchesDevice: boolean;
}

/**
 * core's rebuildTreasuryOpening for this wallet's treasury, with keys from two wallet signatures,
 * the browser's opening store and the console's history source. Errors come back as console
 * errors with core's messages. The caller holds the wallet lock.
 */
export async function rebuildFromChain(ctx: ConsoleContext, wallet: WalletPort): Promise<RebuiltTreasury> {
  const { config } = ctx;
  const keys = await walletKeys(wallet, { domain: config.keyDomain, token: config.contracts.token });
  for (let look = 1; ; look++) {
    try {
      const rebuilt = await rebuildTreasuryOpening({
        port: ctx.port,
        store: ctx.store,
        history: ctx.history,
        payroll: config.contracts.payroll,
        token: config.contracts.token,
        treasury: wallet.address,
        keys,
      });
      const saved = await ctx.store.get(treasuryOpeningKey(config.contracts.token, wallet.address));
      if (readSavedOpening(saved) !== undefined) await ctx.store.put(rebuiltMarkerKey(config.contracts.token, wallet.address), saved as NonNullable<typeof saved>);
      return { value: rebuilt.value, deviceExpected: rebuilt.deviceExpected, matchesDevice: rebuilt.matchesDevice };
    } catch (err) {
      const lagging = err instanceof HistoryIncompleteError && err.reason === "NOT_REBUILT";
      if (!lagging || look === REBUILD_LOOKS) throw fromCoreError(err);
      await ctx.wait(REBUILD_WAIT_MS);
    }
  }
}

/**
 * Rebuilds the treasury's opening from the chain's history and makes it the one this browser pays
 * from: the way back on a new device, after cleared storage, or when a run says NEEDS_REBUILD.
 * It is an explicit step the employer takes, never run by a payroll on its own, because a
 * deviceExpected that differs from value means the treasury moved in a way this browser did not
 * record (threat model C14, C38). Show both, labelled, before paying on.
 *
 * @param companyId a company this wallet is the admin of; the treasury is the admin wallet.
 * @throws ConsoleError COMPANY_ID_INVALID, COMPANY_NOT_FOUND, NOT_ADMIN, TREASURY_NOT_REGISTERED,
 *   TREASURY_KEYS_MISMATCH, HISTORY_INCOMPLETE (nothing was saved), PAYMENT_PENDING,
 *   RECORD_DAMAGED, KEY_NOT_DERIVED, BUSY, STORAGE_FAILED; the wallet's own error.
 */
export async function rebuildTreasury(wallet: WalletPort, companyId: bigint, onProgress?: OnProgress): Promise<RebuiltTreasury> {
  const ctx = consoleContext();
  return withWalletLock(wallet.address, async () => {
    const p = reporter(onProgress, 2);
    await adminCompany(ctx, wallet, companyId);
    p.say("Sign the Kalypso key message twice in your wallet to open the treasury");
    await walletKeys(wallet, { domain: ctx.config.keyDomain, token: ctx.config.contracts.token });
    p.tick("The treasury is open in this browser");
    p.say("Rebuilding the treasury balance from the chain's history");
    const rebuilt = await rebuildFromChain(ctx, wallet);
    p.tick(rebuilt.matchesDevice ? "The chain's history matches what this browser expected" : "Rebuilt from the chain. Compare it with what this browser expected before paying");
    return rebuilt;
  });
}

/**
 * Removes this browser's record of the treasury's pay in flight, through core's clearInFlight, and
 * only when that record is damaged: the RECORD_DAMAGED a run or a rebuild reports (core's
 * PaymentInFlightError UNREADABLE). A record that reads fine is refused, because it may name a pay
 * the chain can still apply; running the payroll again settles it.
 *
 * The screen must ask the employer to confirm before calling this. No opening is touched: every
 * batch opening this browser wrote stays a candidate through the attempts list, so the next run
 * still starts from whichever one opens the chain, and a rebuild can always recover the balance
 * from history (threat model C38, C41).
 *
 * @returns cleared true when a damaged record was there and is gone, false when there was none.
 * @throws ConsoleError RECORD_NOT_DAMAGED, COMPANY_ID_INVALID, COMPANY_NOT_FOUND, NOT_ADMIN, BUSY,
 *   STORAGE_UNAVAILABLE or STORAGE_FAILED.
 */
export async function clearDamagedRecord(wallet: WalletPort, companyId: bigint): Promise<{ cleared: boolean }> {
  const ctx = consoleContext();
  const token = ctx.config.contracts.token;
  const treasury = wallet.address;
  return withWalletLock(treasury, async () => {
    await adminCompany(ctx, wallet, companyId);
    const key = inFlightKey(token, treasury);
    const saved = await ctx.store.get(key);
    if (saved !== undefined && readInFlight(saved) !== undefined) throw new ConsoleError("RECORD_NOT_DAMAGED");
    // The opening store reads text that is not even the right shape as missing, so the raw text
    // says whether anything is there to clear.
    const present = (await ctx.text.get(key)) !== undefined;
    await clearInFlight(ctx.store, token, treasury);
    return { cleared: present };
  });
}

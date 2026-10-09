import { MAX_STROOPS } from "@kalypso/core";
import { SandboxError } from "./errors";

/** The treasury buys and deposits this much over the payroll, so its public deposit is never the payroll total. */
export const DEPOSIT_MARGIN_PERCENT = 2n;

/**
 * Checks the three salaries a judge entered: exactly three bigints, each above zero, and a total
 * the token can hold with the deposit margin on top.
 *
 * @throws SandboxError INVALID_AMOUNTS, naming the worker, never the amount.
 */
export function requireSalaries(amounts: unknown): [bigint, bigint, bigint] {
  if (!Array.isArray(amounts) || amounts.length !== 3) throw new SandboxError("INVALID_AMOUNTS", "Enter one salary for each of the three workers.");
  amounts.forEach((amount, i) => {
    if (typeof amount !== "bigint" || amount <= 0n) throw new SandboxError("INVALID_AMOUNTS", `Worker ${i + 1}'s salary must be above zero.`);
  });
  const checked = amounts as [bigint, bigint, bigint];
  if (depositFor(totalOf(checked)) > MAX_STROOPS) throw new SandboxError("INVALID_AMOUNTS", "These salaries are larger than the token can hold.");
  return checked;
}

export function totalOf(amounts: readonly bigint[]): bigint {
  return amounts.reduce((sum, amount) => sum + amount, 0n);
}

/** The USDC the treasury buys and deposits for a payroll total: the total plus 2 percent, rounded up to the stroop. */
export function depositFor(total: bigint): bigint {
  return total + (total * DEPOSIT_MARGIN_PERCENT + 99n) / 100n;
}

/**
 * Refuses unless the USDC bought covers the payroll.
 *
 * @throws SandboxError CHAIN_DISAGREES when bought is below the total.
 */
export function requireCovered(total: bigint, bought: bigint): void {
  if (bought < total) throw new SandboxError("CHAIN_DISAGREES", "The treasury holds less USDC than the payroll needs, so nothing was paid.");
}

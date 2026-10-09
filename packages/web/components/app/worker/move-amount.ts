import { displayUsdc, parseTypedUsdc } from "../../../lib/money";

export interface MoveReading {
  /** The typed amount in stroops, or null when the text is empty or does not read as one. */
  amount: bigint | null;
  /** Why the amount cannot be moved, as a WorkerError code, or null. */
  problem: "INVALID_AMOUNT" | "INSUFFICIENT_FUNDS" | null;
  /** The sentence that repeats the parsed amount before anything is sent, or null (C54). */
  confirm: string | null;
  label: string;
}

/**
 * What the Move box shows for the text in it. The text goes through the one typed-amount parser,
 * so "1,5" is refused instead of read as 15, and a movable amount is shown back as it was parsed,
 * in the sentence and on the button, before the irreversible withdraw (C54).
 */
export function readMove(text: string, max: bigint | null): MoveReading {
  if (text.trim() === "") return { amount: null, problem: null, confirm: null, label: "Move" };
  const amount = parseTypedUsdc(text);
  if (amount === null) return { amount, problem: "INVALID_AMOUNT", confirm: null, label: "Move" };
  if (max !== null && amount > max) return { amount, problem: "INSUFFICIENT_FUNDS", confirm: null, label: "Move" };
  const shown = displayUsdc(amount);
  return { amount, problem: null, confirm: `You are moving ${shown} USDC.`, label: `Move ${shown} USDC` };
}

// The sponsor refused, or went quiet and the chain shows the move did not land. Any other failure
// is not one that paying the fee another way fixes.
const SELF_PAY_AFTER: ReadonlySet<string> = new Set(["rate_limited", "address_rate_limited", "daily_budget_spent", "relay_unavailable", "network", "timeout", "relay_timeout"]);

/** True when the screen offers to pay the network fee from the worker's own account instead. */
export function offersSelfPay(error: { code: string | undefined } | null): boolean {
  return error?.code !== undefined && SELF_PAY_AFTER.has(error.code);
}

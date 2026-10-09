import { displayUsdc, parseTypedUsdc } from "@/lib/money";

export const INVALID_AMOUNT = "Enter an amount above zero, like 4200 or 4,200.50.";

export interface DepositAmount {
  /** The stroops to deposit, or null when the field is empty or refused. */
  amount: bigint | null;
  error: string | null;
  /** The sentence under the field, naming the exact amount the button sends. */
  confirm: string | null;
  button: string;
}

// The typed text is read once by the one strict parser, and that single value is what the
// sentence, the button and the deposit all use, so "1,5" can never be shown as one thing and sent as another.
export function depositAmount(text: string): DepositAmount {
  const amount = parseTypedUsdc(text);
  if (amount === null) return { amount, error: text.trim() === "" ? null : INVALID_AMOUNT, confirm: null, button: "Add to treasury" };
  const shown = displayUsdc(amount);
  return { amount, error: null, confirm: `You are adding ${shown} USDC.`, button: `Add ${shown} USDC` };
}

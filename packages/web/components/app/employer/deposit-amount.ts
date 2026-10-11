import type { Locale } from "@/lib/i18n/locales";
import type { PlainT } from "@/lib/i18n/types";
import { editableUsdc, parseAmount } from "@/lib/i18n/amount";
import { displayUsdc } from "@/lib/money";

export interface DepositAmount {
  /** The stroops to deposit, or null when the field is empty or refused. */
  amount: bigint | null;
  error: string | null;
  /** The sentence under the field, naming the exact amount the button sends. */
  confirm: string | null;
  button: string;
}

// The typed text is read once by the one strict parser, and that single value is what the
// sentence, the button and the deposit all use, so "1,5" can never be shown as one thing and sent
// as another. t is the employer.treasury namespace.
export function depositAmount(text: string, locale: Locale, t: PlainT): DepositAmount {
  const amount = parseAmount(text, locale);
  if (amount === null) {
    const error = text.trim() === "" ? null : t("invalid", { plain: "4200", grouped: editableUsdc(42_005_000_000n, locale) });
    return { amount, error, confirm: null, button: t("addButton") };
  }
  const shown = displayUsdc(amount, locale);
  return { amount, error: null, confirm: t("confirm", { amount: shown }), button: t("addAmount", { amount: shown }) };
}

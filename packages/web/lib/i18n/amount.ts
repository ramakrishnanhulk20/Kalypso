import { formatUsdc, parseUsdc } from "@kalypso/core";
import { parseTypedUsdc } from "../money";
import { INTL_TAG } from "./locales";
import type { Locale } from "./locales";

/** True for the locales whose amount fields take a comma as the decimal separator. */
export function commaDecimal(locale: Locale): boolean {
  return locale === "es" || locale === "pt" || locale === "fr";
}

function decimalSeparator(locale: Locale): string {
  return new Intl.NumberFormat(INTL_TAG[locale]).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
}

/**
 * The amount written the way an amount field in this locale reads it back: grouped with commas
 * in English and Chinese (what parseTypedUsdc accepts), and with no grouping at all where a comma
 * is the decimal separator, so a tidied field is always a value the field accepts.
 */
export function editableUsdc(stroops: bigint, locale: Locale = "en"): string {
  const [whole = "0", fraction = ""] = formatUsdc(stroops).split(".");
  if (!commaDecimal(locale)) return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
  // 1.125 written "1,125" would look grouped and be refused, so it gets a fourth digit.
  const digits = fraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole) ? 4 : 2;
  return `${whole}${decimalSeparator(locale)}${fraction.padEnd(digits, "0")}`;
}

// Spanish, Portuguese and French: digits, then at most one decimal separator, a comma or a dot.
// No grouping separators and never both, so "4.200,50" and "4,200.50" are refused, not guessed at.
const COMMA_OR_DOT = /^(\d+)(?:[.,](\d+))?$/;
// "4.200" is four thousand two hundred to a Spanish reader and "4,200" is the same to anyone used
// to English figures, so one to three digits, a separator and exactly three more is refused rather
// than read as 4.2. "0,125" and "4200,500" cannot be a grouped thousand and still read as decimals.
const LOOKS_GROUPED = /^[1-9]\d{0,2}[.,]\d{3}$/;

/**
 * The one parser for every amount a person types, in the page's locale. English and Chinese keep
 * lib/money's rules (a comma only as a thousands separator, so "1,5" is refused instead of read as
 * 15). In the comma-decimal locales "1,5" is one and a half. core's parseUsdc then applies its own
 * rules (at most 7 decimals, above zero, within range). Returns null for anything it refuses, and
 * the screen shows the parsed figure before anything is sent.
 */
export function parseAmount(text: string, locale: Locale = "en"): bigint | null {
  if (!commaDecimal(locale)) return parseTypedUsdc(text);
  const trimmed = text.trim();
  const match = COMMA_OR_DOT.exec(trimmed);
  if (!match || LOOKS_GROUPED.test(trimmed)) return null;
  const plain = match[2] === undefined ? (match[1] as string) : `${match[1]}.${match[2]}`;
  try {
    return parseUsdc(plain);
  } catch {
    return null;
  }
}

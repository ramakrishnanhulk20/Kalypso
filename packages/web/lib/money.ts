import { formatUsdc, parseUsdc } from "@kalypso/core";
import { INTL_TAG } from "./i18n/locales";
import type { Locale } from "./i18n/locales";

type Separators = { decimal: string; group: string };

const separators = new Map<Locale, Separators>();

// What Intl uses for this locale, read once: a dot and a comma in English and Chinese, a comma
// and a dot in Spanish and Portuguese, a comma and a narrow space in French.
function separatorsOf(locale: Locale): Separators {
  let found = separators.get(locale);
  if (!found) {
    const parts = new Intl.NumberFormat(INTL_TAG[locale]).formatToParts(1234567.5);
    found = {
      decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
      group: parts.find((part) => part.type === "group")?.value ?? ",",
    };
    separators.set(locale, found);
  }
  return found;
}

// Whole part grouped the locale's way, fraction padded to at least two digits and never cut:
// 1n is "0.0000001", 42500000000n is "4,250.00" in English and "4.250,00" in Spanish.
export function displayUsdc(stroops: bigint, locale: Locale = "en"): string {
  const [whole = "0", fraction = ""] = formatUsdc(stroops).split(".");
  const { decimal, group } = separatorsOf(locale);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, group)}${decimal}${fraction.padEnd(2, "0")}`;
}

const PLAIN = /^\d+(\.\d+)?$/;
// A first group with a leading zero is no thousands figure: "0,125" is a decimal in Spanish,
// Portuguese and French, so reading it as 125 here would let a language switch change its value.
const GROUPED = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;

// The one parser for every amount a person types in English. A comma is accepted only as a
// thousands separator, so "1,5" is refused instead of read as 15; core's parseUsdc then
// applies its own rules (at most 7 decimals, above zero, within range). Returns null for
// anything it refuses, and the screen shows displayUsdc(value) before anything is sent.
// lib/i18n/amount.ts wraps this with the comma-decimal rules of the other languages.
export function parseTypedUsdc(text: string): bigint | null {
  const trimmed = text.trim();
  if (!PLAIN.test(trimmed) && !GROUPED.test(trimmed)) return null;
  try {
    return parseUsdc(trimmed.replace(/,/g, ""));
  } catch {
    return null;
  }
}

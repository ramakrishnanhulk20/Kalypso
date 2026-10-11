import type { HistoryGap } from "@kalypso/core";
import type { PlainT } from "@/lib/i18n/types";

const U64_DECIMAL = /^(0|[1-9]\d{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const MAX_LABEL_CHARS = 120;

/** The company id an invite link carries, or null when the link has none or it is not a u64. */
export function companyIdFromQuery(search: string): bigint | null {
  const raw = new URLSearchParams(search).get("company");
  if (raw === null || !U64_DECIMAL.test(raw)) return null;
  const id = BigInt(raw);
  return id <= U64_MAX ? id : null;
}

/**
 * Text that came from the chain (a company name, a pay period) made safe to show: control and
 * formatting characters, which can reorder text on screen, become spaces, runs of space collapse,
 * and the length is capped.
 */
export function cleanChainText(value: string): string {
  const chars = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim());
  return chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS).join("").trimEnd()}...` : chars.join("");
}

/** The first 4 and last 4 characters of an address. */
export function shortAddress(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// The values each gap sentence names. Ids are strings for the message formatter.
function valuesOf(gap: HistoryGap): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(gap)) {
    if (key === "reason") continue;
    values[key] = typeof value === "bigint" ? value.toString() : (value as string | number);
  }
  return values;
}

/**
 * One plain sentence for each place the chain's counts and the history disagree, in the page's
 * language (t is the worker.gaps namespace). Never carries an amount.
 */
export function gapSentences(gaps: readonly HistoryGap[], t: PlainT): string[] {
  const sentences = gaps.map((gap) => t(gap.reason, valuesOf(gap)));
  return [...new Set(sentences)];
}

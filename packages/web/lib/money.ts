import { formatUsdc, parseUsdc } from "@kalypso/core";

// Whole part grouped with commas, fraction padded to at least two digits and
// never cut: 1n is "0.0000001", 42500000000n is "4,250.00".
export function displayUsdc(stroops: bigint): string {
  const [whole = "0", fraction = ""] = formatUsdc(stroops).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${fraction.padEnd(2, "0")}`;
}

const PLAIN = /^\d+(\.\d+)?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

// The one parser for every amount a person types. A comma is accepted only as a
// thousands separator, so "1,5" is refused instead of read as 15; core's parseUsdc then
// applies its own rules (at most 7 decimals, above zero, within range). Returns null for
// anything it refuses, and the screen shows displayUsdc(value) before anything is sent.
export function parseTypedUsdc(text: string): bigint | null {
  const trimmed = text.trim();
  if (!PLAIN.test(trimmed) && !GROUPED.test(trimmed)) return null;
  try {
    return parseUsdc(trimmed.replace(/,/g, ""));
  } catch {
    return null;
  }
}

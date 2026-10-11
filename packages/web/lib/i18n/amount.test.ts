import { describe, expect, it } from "vitest";
import { editableUsdc, parseAmount } from "./amount";

describe("editableUsdc", () => {
  it("keeps the English grouping, and drops grouping where the comma is the decimal separator", () => {
    expect(editableUsdc(42005000000n)).toBe("4,200.50");
    expect(editableUsdc(42005000000n, "zh")).toBe("4,200.50");
    expect(editableUsdc(42005000000n, "es")).toBe("4200,50");
    expect(editableUsdc(42005000000n, "pt")).toBe("4200,50");
    expect(editableUsdc(42005000000n, "fr")).toBe("4200,50");
  });

  it("reads back to the same value in every locale, down to the smallest unit", () => {
    for (const locale of ["en", "es", "pt", "fr", "zh"] as const) {
      expect(parseAmount(editableUsdc(12345678901234n, locale), locale), locale).toBe(12345678901234n);
      expect(parseAmount(editableUsdc(1n, locale), locale), locale).toBe(1n);
      expect(parseAmount(editableUsdc(11250000n, locale), locale), locale).toBe(11250000n);
      expect(parseAmount(editableUsdc(9991250000n, locale), locale), locale).toBe(9991250000n);
    }
  });
});

describe("parseAmount in English and Chinese", () => {
  it.each([
    ["4200", 42000000000n],
    [" 4200 ", 42000000000n],
    ["4,200", 42000000000n],
    ["4,200.50", 42005000000n],
    ["1,000,000", 10000000000000n],
    ["0.0000001", 1n],
  ])("reads %j", (text, stroops) => {
    expect(parseAmount(text)).toBe(stroops);
    expect(parseAmount(text, "zh")).toBe(stroops);
  });

  it.each(["1,5", "12,34", "1,5000", ",500", "4,20.00", "", "0", "-5", "1e3", "4 200", "4.", ".5", "0.00000001"])("refuses %j", (text) => {
    expect(parseAmount(text)).toBeNull();
    expect(parseAmount(text, "zh")).toBeNull();
  });

  // The comma-decimal pages read these as 0.125, and the locale switcher keeps typed text.
  it.each(["0,125", "00,125", "000,125"])("refuses %j rather than read it as 125", (text) => {
    expect(parseAmount(text)).toBeNull();
    expect(parseAmount(text, "zh")).toBeNull();
  });

  it("still reads 1,250 as one thousand two hundred and fifty, and 0.125 as a decimal", () => {
    expect(parseAmount("1,250")).toBe(12500000000n);
    expect(parseAmount("1,250", "zh")).toBe(12500000000n);
    expect(parseAmount("0.125")).toBe(1250000n);
    expect(parseAmount("0.125", "zh")).toBe(1250000n);
  });
});

describe("parseAmount in Spanish, Portuguese and French", () => {
  const locales = ["es", "pt", "fr"] as const;

  it.each([
    ["4200", 42000000000n],
    [" 4200 ", 42000000000n],
    ["4200,50", 42005000000n],
    ["4200.50", 42005000000n],
    ["1,5", 15000000n],
    ["1.5", 15000000n],
    ["4,25", 42500000n],
    ["0,125", 1250000n],
    ["4200,500", 42005000000n],
    ["0,0000001", 1n],
  ])("reads %j the same way in all three", (text, stroops) => {
    for (const locale of locales) expect(parseAmount(text, locale), locale).toBe(stroops);
  });

  it.each(["4.200", "4,200", "12.500", "999,000", "4.200,50", "4,200.50", "1.234.567", "4 200", "4 200", "4,", ",5", "1,2,3", "", "0", "-5", "1e3", "0,00000001"])("refuses %j", (text) => {
    for (const locale of locales) expect(parseAmount(text, locale), locale).toBeNull();
  });
});

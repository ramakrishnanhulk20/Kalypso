// Covers how the sandbox's salary card reads its three fields: the one strict parser, so "1,5" is
// refused in English rather than read as 15 and read as one and a half in Spanish, the total over
// the fields that read, and the blur tidy-up text reading back to the same value in every locale.
// Does NOT cover the card's layout or the engine's own salary limit.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/money", () => import("../../lib/money"));
vi.mock("@/lib/i18n/amount", () => import("../../lib/i18n/amount"));
vi.mock("@/lib/i18n/locales", () => import("../../lib/i18n/locales"));
vi.mock("@/lib/sandbox/salaries", () => import("../../lib/sandbox/salaries"));

const { readSalaries } = await import("./salary-card");
const { editableUsdc, parseAmount } = await import("../../lib/i18n/amount");

describe("readSalaries", () => {
  it("reads the default payroll and its total", () => {
    expect(readSalaries(["4,200.00", "3,650.00", "5,100.00"])).toEqual({
      values: [42_000_000_000n, 36_500_000_000n, 51_000_000_000n],
      amounts: [42_000_000_000n, 36_500_000_000n, 51_000_000_000n],
      total: 129_500_000_000n,
    });
  });

  it("refuses 1,5 and leaves it out of the total, so the sandbox cannot start", () => {
    expect(readSalaries(["1,5", "3,650.00", "5,100.00"])).toEqual({
      values: [null, 36_500_000_000n, 51_000_000_000n],
      amounts: null,
      total: 87_500_000_000n,
    });
  });

  it("reads the Spanish defaults, where the comma is the decimal separator", () => {
    expect(readSalaries(["4200,00", "3650,00", "5100,00"], "es")).toEqual({
      values: [42_000_000_000n, 36_500_000_000n, 51_000_000_000n],
      amounts: [42_000_000_000n, 36_500_000_000n, 51_000_000_000n],
      total: 129_500_000_000n,
    });
    expect(readSalaries(["1,5", "3650", "5100"], "es").values[0]).toBe(15_000_000n);
    expect(readSalaries(["4.200,00", "3650", "5100"], "es").amounts).toBeNull();
  });

  it("tidies a field into text that reads back to the same value, in every locale", () => {
    for (const locale of ["en", "es", "pt", "fr", "zh"] as const) {
      const [value] = readSalaries(["4200.5", "1", "1"], locale).values;
      expect(value, locale).toBe(42_005_000_000n);
      const tidied = editableUsdc(value as bigint, locale);
      expect(parseAmount(tidied, locale), `${locale} ${tidied}`).toBe(value);
    }
    expect(editableUsdc(42_005_000_000n)).toBe("4,200.50");
    expect(editableUsdc(42_005_000_000n, "es")).toBe("4200,50");
  });
});

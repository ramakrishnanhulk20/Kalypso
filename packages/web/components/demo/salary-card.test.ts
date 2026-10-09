// Covers how the sandbox's salary card reads its three fields: the one strict parser, so "1,5" is
// refused rather than read as 15, the total over the fields that read, and the blur tidy-up text
// reading back to the same value. Does NOT cover the card's layout or the engine's own salary limit.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/money", () => import("../../lib/money"));
vi.mock("@/lib/sandbox/salaries", () => import("../../lib/sandbox/salaries"));

const { readSalaries } = await import("./salary-card");
const { displayUsdc, parseTypedUsdc } = await import("../../lib/money");

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

  it("tidies a field into text that reads back to the same value", () => {
    const [value] = readSalaries(["4200.5", "1", "1"]).values;
    expect(value).toBe(42_005_000_000n);
    const tidied = displayUsdc(value as bigint);
    expect(tidied).toBe("4,200.50");
    expect(parseTypedUsdc(tidied)).toBe(value);
  });
});

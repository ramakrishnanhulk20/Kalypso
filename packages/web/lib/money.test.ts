import { describe, expect, it } from "vitest";
import { displayUsdc, parseTypedUsdc } from "./money";

describe("displayUsdc", () => {
  it("shows zero with two decimals", () => {
    expect(displayUsdc(0n)).toBe("0.00");
  });

  it("groups thousands and pads the fraction to two digits", () => {
    expect(displayUsdc(42500000000n)).toBe("4,250.00");
  });

  it("never cuts the smallest unit", () => {
    expect(displayUsdc(1n)).toBe("0.0000001");
  });

  it("groups the whole part and keeps every fraction digit", () => {
    expect(displayUsdc(12345678901234n)).toBe("1,234,567.8901234");
  });
});

describe("parseTypedUsdc", () => {
  it.each([
    ["4200", 42000000000n],
    [" 4200 ", 42000000000n],
    ["4,200", 42000000000n],
    ["4,200.50", 42005000000n],
    ["1,000,000", 10000000000000n],
    ["0.0000001", 1n],
  ])("reads %j", (text, stroops) => {
    expect(parseTypedUsdc(text)).toBe(stroops);
  });

  it.each(["1,5", "12,34", "1,5000", ",500", "4,20.00", "", "0", "-5", "1e3", "4 200", "4.", ".5", "0.00000001"])("refuses %j", (text) => {
    expect(parseTypedUsdc(text)).toBeNull();
  });
});

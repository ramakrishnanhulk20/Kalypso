// Covers what the treasury's Add funds field makes of typed text: the one strict parser, the
// sentence under the field and the button naming the same figure, and "1,5" refused instead of read
// as 15. Does NOT cover the deposit itself (lib/employer/recovery.test.ts and the live run cover it).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/money", () => import("../../../lib/money"));

const { INVALID_AMOUNT, depositAmount } = await import("./deposit-amount");

describe("depositAmount", () => {
  it.each(["1,5", "12,34", "4,20.00", "0", "-5", "1e3"])("refuses %j with the field's sentence and nothing to send", (text) => {
    expect(depositAmount(text)).toEqual({ amount: null, error: INVALID_AMOUNT, confirm: null, button: "Add to treasury" });
  });

  it("asks for nothing while the field is empty", () => {
    expect(depositAmount("  ")).toEqual({ amount: null, error: null, confirm: null, button: "Add to treasury" });
  });

  it("shows the exact figure it will send, under the field and on the button", () => {
    expect(depositAmount("4,200.5")).toEqual({
      amount: 42_005_000_000n,
      error: null,
      confirm: "You are adding 4,200.50 USDC.",
      button: "Add 4,200.50 USDC",
    });
    expect(depositAmount("15").confirm).toBe("You are adding 15.00 USDC.");
  });
});

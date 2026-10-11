// Covers what the treasury's Add funds field makes of typed text: the one strict parser, the
// sentence under the field and the button naming the same figure, and "1,5" refused instead of read
// as 15 in English (and read as one and a half in Spanish). Does NOT cover the deposit itself
// (lib/employer/recovery.test.ts and the live run cover it).
import { describe, expect, it, vi } from "vitest";
import { englishT } from "../../../lib/i18n/english";

vi.mock("@/lib/money", () => import("../../../lib/money"));
vi.mock("@/lib/i18n/locales", () => import("../../../lib/i18n/locales"));

const { depositAmount } = await import("./deposit-amount");
const t = englishT("employer.treasury");
const INVALID_AMOUNT = "Enter an amount above zero, like 4200 or 4,200.50.";

describe("depositAmount", () => {
  it.each(["1,5", "12,34", "4,20.00", "0", "-5", "1e3"])("refuses %j with the field's sentence and nothing to send", (text) => {
    expect(depositAmount(text, "en", t)).toEqual({ amount: null, error: INVALID_AMOUNT, confirm: null, button: "Add to treasury" });
  });

  it("asks for nothing while the field is empty", () => {
    expect(depositAmount("  ", "en", t)).toEqual({ amount: null, error: null, confirm: null, button: "Add to treasury" });
  });

  it("shows the exact figure it will send, under the field and on the button", () => {
    expect(depositAmount("4,200.5", "en", t)).toEqual({
      amount: 42_005_000_000n,
      error: null,
      confirm: "You are adding 4,200.50 USDC.",
      button: "Add 4,200.50 USDC",
    });
    expect(depositAmount("15", "en", t).confirm).toBe("You are adding 15.00 USDC.");
  });

  it("reads a Spanish comma as the decimal separator and shows the figure the Spanish way", () => {
    expect(depositAmount("1,5", "es", t)).toMatchObject({ amount: 15_000_000n, error: null, confirm: "You are adding 1,50 USDC." });
    expect(depositAmount("4.200,50", "es", t)).toMatchObject({ amount: null, error: "Enter an amount above zero, like 4200 or 4200,50." });
  });
});

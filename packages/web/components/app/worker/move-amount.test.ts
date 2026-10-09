// Covers the Move box (C54): typed text goes through the one typed-amount parser, so "1,5" is
// refused rather than read as 15, a movable amount is repeated back before the send, and paying the
// fee yourself is offered only after the sponsor refused or went quiet.
// Does NOT cover: the button itself in a browser, or the withdraw (lib/worker/cashout.test.ts).
import { describe, expect, it } from "vitest";
import { SponsorError } from "../../../lib/worker/sponsor";
import { WorkerError } from "../../../lib/worker/errors";
import { offersSelfPay, readMove } from "./move-amount";
import { shownFrom } from "./shown";

describe("readMove", () => {
  it("reads a grouped amount and repeats it, as parsed, in the sentence and on the button", () => {
    expect(readMove("1,500", null)).toEqual({ amount: 15_000_000_000n, problem: null, confirm: "You are moving 1,500.00 USDC.", label: "Move 1,500.00 USDC" });
  });

  it("refuses a comma used as a decimal point instead of reading 1,5 as 15", () => {
    expect(readMove("1,5", null)).toMatchObject({ amount: null, problem: "INVALID_AMOUNT", confirm: null, label: "Move" });
  });

  it("refuses more than the balance holds, and shows nothing for an empty box", () => {
    expect(readMove("12", 100_000_000n)).toMatchObject({ problem: "INSUFFICIENT_FUNDS", confirm: null, label: "Move" });
    expect(readMove("  ", null)).toEqual({ amount: null, problem: null, confirm: null, label: "Move" });
  });
});

describe("offersSelfPay", () => {
  it("offers it after the sponsor refused or went quiet", () => {
    for (const code of ["rate_limited", "address_rate_limited", "daily_budget_spent", "relay_unavailable", "network", "timeout", "relay_timeout"] as const) {
      expect(offersSelfPay(shownFrom(new SponsorError(code))), code).toBe(true);
    }
  });

  it("does not offer it for a refusal paying the fee another way cannot fix", () => {
    expect(offersSelfPay(shownFrom(new SponsorError("simulation_failed")))).toBe(false);
    expect(offersSelfPay(shownFrom(new WorkerError("WITHDRAW_NOT_CONFIRMED")))).toBe(false);
    expect(offersSelfPay(shownFrom(new WorkerError("NETWORK")))).toBe(false);
    expect(offersSelfPay(null)).toBe(false);
  });
});

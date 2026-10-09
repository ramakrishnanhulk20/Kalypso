import { describe, expect, it } from "vitest";
import { afterSendFailure } from "./send-outcome";

const HASH = "cd".repeat(32);

describe("what happens after the anchor payment fails", () => {
  it("keeps following the record when the payment already went out", () => {
    expect(afterSendFailure({ code: "ANCHOR_ALREADY_PAID", hash: HASH }, false)).toEqual({ next: "follow", hash: HASH });
  });

  it("keeps following the record when the payment has not landed yet", () => {
    expect(afterSendFailure({ code: "TX_PENDING", hash: HASH }, false)).toEqual({ next: "follow", hash: HASH });
  });

  it("offers to build it again when the network refused an expired approval", () => {
    expect(afterSendFailure({ code: "TX_FAILED", hash: undefined }, true)).toEqual({ next: "expired" });
  });

  it("shows the lib's sentence for a refusal inside the window, or a failure that has a hash", () => {
    expect(afterSendFailure({ code: "TX_FAILED", hash: undefined }, false)).toEqual({ next: "show" });
    expect(afterSendFailure({ code: "TX_FAILED", hash: HASH }, true)).toEqual({ next: "show" });
  });

  it("shows a changed record, a missing fee balance and anything unknown as they are", () => {
    expect(afterSendFailure({ code: "ANCHOR_RECORD_CHANGED", hash: undefined }, false)).toEqual({ next: "show" });
    expect(afterSendFailure({ code: "CASHOUT_NO_XLM", hash: undefined }, false)).toEqual({ next: "show" });
    expect(afterSendFailure(null, true)).toEqual({ next: "show" });
  });
});

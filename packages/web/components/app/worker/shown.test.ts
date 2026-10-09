import { describe, expect, it } from "vitest";
import { ShownMessage, describeError } from "../errors";
import { SponsorError } from "../../../lib/worker/sponsor";
import { WorkerError } from "../../../lib/worker/errors";
import { asShown, failureOf, needsNewPayKey, shownErrors, shownFrom, visibleError } from "./shown";

describe("the lib's errors on screen", () => {
  it("keeps a worker error's own sentence and code", () => {
    const shown = shownFrom(new WorkerError("NOT_INVITED"));
    expect(shown.message).toBe(new WorkerError("NOT_INVITED").message);
    expect(shown.code).toBe("NOT_INVITED");
  });

  it("keeps a sponsor error's own sentence and code", () => {
    const shown = shownFrom(new SponsorError("daily_budget_spent"));
    expect(shown.message).toBe("The fee sponsor has spent today's budget. Try again tomorrow.");
    expect(shown.code).toBe("daily_budget_spent");
  });

  it("carries the transaction hash so a screen can tell a refusal from a failure", () => {
    const hash = "ab".repeat(32);
    expect(failureOf(asShown(new WorkerError("TX_FAILED", { hash })))).toEqual({ code: "TX_FAILED", hash });
    expect(failureOf(asShown(new WorkerError("TX_FAILED")))).toEqual({ code: "TX_FAILED", hash: undefined });
  });

  it("leaves other errors for the shared describer, which hides their text", () => {
    const wallet = Object.assign(new Error("Freighter says no"), { name: "WalletError", code: "SIGN_REFUSED" });
    expect(asShown(wallet)).toBe(wallet);
    expect(shownFrom(new Error("internal detail")).message).not.toContain("internal detail");
  });

  it("rewraps whatever a step throws", async () => {
    await expect(shownErrors(async () => Promise.reject(new WorkerError("BUSY")))).rejects.toBeInstanceOf(ShownMessage);
    expect(describeError(await shownErrors(async () => Promise.reject(new WorkerError("BUSY"))).catch((e) => e)).code).toBe("BUSY");
  });

  it("shows nothing for a closed passkey prompt, and everything else", () => {
    expect(visibleError(shownFrom(new WorkerError("PASSKEY_CANCELLED")))).toBeNull();
    expect(visibleError(shownFrom(new WorkerError("PRF_UNAVAILABLE")))?.code).toBe("PRF_UNAVAILABLE");
    expect(visibleError(null)).toBeNull();
  });

  it("offers a new pay key only when this passkey's address belongs to someone else", () => {
    expect(needsNewPayKey(shownFrom(new WorkerError("ADDRESS_TAKEN")))).toBe(true);
    expect(needsNewPayKey(shownFrom(new WorkerError("PASSKEY_NOT_THIS_WALLET")))).toBe(true);
    expect(needsNewPayKey(shownFrom(new WorkerError("NOT_INVITED")))).toBe(false);
    expect(needsNewPayKey(null)).toBe(false);
  });
});

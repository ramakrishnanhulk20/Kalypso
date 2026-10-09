// Covers when the signed-in screen offers Finish setting up: only to a passkey worker whose
// wallet is not proven, and not while the join card is up (joining sets up) or the invite is still
// being read, so an invite to a company already joined keeps the card; and when it shows the
// payslips and cash-out: whenever the wallet is on chain, proven or not, unless the page waits for
// a first join.
// Does NOT cover: the deploy itself (lib/worker/passkey.test.ts), whether the join card is up
// (use-payslips.test.ts), or the cards in a browser.
import { describe, expect, it } from "vitest";
import { finishSetupCopy, showsFinishSetup, showsPayslips } from "./setup-gate";

describe("showsFinishSetup", () => {
  it("offers it to an unproven passkey worker with no invite", () => {
    expect(showsFinishSetup({ kind: "passkey", proven: false, joinShown: false, invite: "none" })).toBe(true);
    expect(showsFinishSetup({ kind: "passkey", proven: false, joinShown: false, invite: "missing" })).toBe(true);
  });

  it("leaves it to the join card when the card is up, and waits while the invite is read", () => {
    expect(showsFinishSetup({ kind: "passkey", proven: false, joinShown: true, invite: "found" })).toBe(false);
    expect(showsFinishSetup({ kind: "passkey", proven: false, joinShown: false, invite: "loading" })).toBe(false);
  });

  it("offers it on an invite to a company already joined, where no join card shows (ADDRESS_TAKEN, WALLET_BIRTH_UNKNOWN)", () => {
    expect(showsFinishSetup({ kind: "passkey", proven: false, joinShown: false, invite: "found" })).toBe(true);
  });

  it("never offers it once proven, or to a wallet worker", () => {
    expect(showsFinishSetup({ kind: "passkey", proven: true, joinShown: false, invite: "none" })).toBe(false);
    expect(showsFinishSetup({ kind: "wallet", proven: true, joinShown: false, invite: "found" })).toBe(false);
  });
});

describe("showsPayslips (h)", () => {
  it.each([
    [false, false, false, true],
    [false, false, true, true],
    [false, true, false, false],
    [false, true, true, true],
    [true, false, false, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, false],
  ])("waitForJoin %s, finishNeeded %s, onChain %s gives %s", (waitForJoin, finishNeeded, onChain, shown) => {
    expect(showsPayslips({ waitForJoin, finishNeeded, onChain })).toBe(shown);
  });
});

describe("finishSetupCopy, the Finish setting up card's words (d)", () => {
  it("asks an on-chain wallet whose birth was not confirmed to check again, and offers a new pay key", () => {
    expect(finishSetupCopy({ onChain: true, reasonCode: "WALLET_BIRTH_UNKNOWN" })).toEqual({
      heading: "We could not confirm your wallet yet",
      text: "Your wallet is on the network, but Kalypso has not confirmed how it was first set up, so its address stays hidden. Your payslips and cash-out below still work.",
      button: "Check again",
      offerNewKey: true,
    });
  });

  it("asks an on-chain wallet that hit a network error to check again, with no new-key link", () => {
    expect(finishSetupCopy({ onChain: true, reasonCode: "NETWORK" })).toMatchObject({ heading: "We could not confirm your wallet yet", button: "Check again", offerNewKey: false });
  });

  it("keeps today's card for a wallet not on chain, whatever the reason", () => {
    for (const reasonCode of [undefined, "NETWORK", "WALLET_BIRTH_UNKNOWN"]) {
      expect(finishSetupCopy({ onChain: false, reasonCode })).toEqual({
        heading: "Your wallet is not set up yet",
        text: "Your wallet is not on the network yet, so its address stays hidden until it is and trusts this passkey.",
        button: "Finish setting up",
        offerNewKey: false,
      });
    }
  });
});

import type { InviteState } from "./use-invite";

/**
 * True when the signed-in screen offers Finish setting up: a passkey worker whose wallet is not
 * proven yet, unless the join card is on screen, since joining runs the same setup itself, or the
 * invite is still being read. An invite to a company already joined shows no join card, so the
 * card with its reason, Check again and new pay key stays.
 */
export function showsFinishSetup(p: { kind: "passkey" | "wallet"; proven: boolean; joinShown: boolean; invite: InviteState["status"] }): boolean {
  return p.kind === "passkey" && !p.proven && !p.joinShown && p.invite !== "loading";
}

/**
 * True when the signed-in screen reads and shows the payslips and cash-out. They need only the
 * worker's keys and a wallet on chain, so a wallet whose address is still unproven shows them under
 * the Finish setting up card; only a wallet not on chain yet, or a page waiting for its first join,
 * holds them back.
 */
export function showsPayslips(p: { waitForJoin: boolean; finishNeeded: boolean; onChain: boolean }): boolean {
  return !p.waitForJoin && (!p.finishNeeded || p.onChain);
}

/** What the Finish setting up card says, and whether it offers a new pay key as a way out. */
export interface FinishSetupCopy {
  heading: string;
  text: string;
  button: string;
  /** True when a "Make a new pay key instead" link sits under the button. */
  offerNewKey: boolean;
}

/**
 * The Finish setting up card's words. A wallet not on chain yet keeps today's card. A wallet on
 * chain whose birth is not confirmed says so plainly, says the payslips below still work, and asks
 * to check again; when the reason is that its birth could not be confirmed, it also offers a new
 * pay key, for a worker who would rather not wait.
 */
export function finishSetupCopy(p: { onChain: boolean; reasonCode: string | undefined }): FinishSetupCopy {
  if (!p.onChain) {
    return {
      heading: "Your wallet is not set up yet",
      text: "Your wallet is not on the network yet, so its address stays hidden until it is and trusts this passkey.",
      button: "Finish setting up",
      offerNewKey: false,
    };
  }
  return {
    heading: "We could not confirm your wallet yet",
    text: "Your wallet is on the network, but Kalypso has not confirmed how it was first set up, so its address stays hidden. Your payslips and cash-out below still work.",
    button: "Check again",
    offerNewKey: p.reasonCode === "WALLET_BIRTH_UNKNOWN",
  };
}

import { Transaction } from "@stellar/stellar-sdk";

// A refusal this close to the end of the approval window is read as the window having closed, so a
// slightly fast clock on the worker's device does not hide the real reason.
const CLOCK_MARGIN_SECONDS = 30;

/**
 * True when the unsigned payment's own time window has closed (or is within the clock margin of
 * closing) at `nowMs`. buildAnchorPayment gives every payment a five-minute window, and the network
 * refuses a payment sent after it.
 */
export function approvalWindowClosed(xdr: string, networkPassphrase: string, nowMs: number): boolean {
  try {
    const maxTime = Number(new Transaction(xdr, networkPassphrase).timeBounds?.maxTime ?? "0");
    return maxTime > 0 && nowMs / 1000 >= maxTime - CLOCK_MARGIN_SECONDS;
  } catch {
    return false;
  }
}

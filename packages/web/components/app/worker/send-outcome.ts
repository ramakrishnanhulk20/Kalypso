import type { WorkerFailure } from "./shown";

export type AfterSendFailure =
  /** The payment is already on its way (or was sent earlier): follow the anchor's record, and remember this hash. */
  | { next: "follow"; hash: string | undefined }
  /** The network refused the payment because its approval window had closed: the screen offers to build it again. */
  | { next: "expired" }
  | { next: "show" };

/**
 * What the screen does after sendAnchorPayment fails. A refusal at submission reaches the screen as
 * TX_FAILED with no hash (a failure on the network carries one), and it is read as an expired
 * approval only when the payment's own time window had in fact closed.
 */
export function afterSendFailure(failure: WorkerFailure | null, windowClosed: boolean): AfterSendFailure {
  if (failure?.code === "ANCHOR_ALREADY_PAID" || failure?.code === "TX_PENDING") return { next: "follow", hash: failure.hash };
  if (failure?.code === "TX_FAILED" && failure.hash === undefined && windowClosed) return { next: "expired" };
  return { next: "show" };
}

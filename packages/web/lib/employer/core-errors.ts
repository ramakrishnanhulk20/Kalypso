import {
  AmountMismatchError,
  HistoryIncompleteError,
  PaidElsewhereError,
  PaymentInFlightError,
  PreflightError,
  SignedTransactionMismatchError,
} from "@kalypso/core";
import { ConsoleError, type ConsoleErrorCode } from "./errors";

const PREFLIGHT_CODES: Partial<Record<PreflightError["code"], ConsoleErrorCode>> = {
  COMPANY_NOT_FOUND: "COMPANY_NOT_FOUND",
  NOT_ADMIN: "NOT_ADMIN",
  RUN_NOT_OPEN: "RUN_CLOSED",
  TREASURY_NOT_REGISTERED: "TREASURY_NOT_REGISTERED",
  KEYS_MISMATCH: "TREASURY_KEYS_MISMATCH",
};

/**
 * core's run and rebuild errors as console errors, keeping core's own plain message (which names
 * lines, never amounts) and its rebuildable verdict. Anything else is returned unchanged.
 */
export function fromCoreError(err: unknown): unknown {
  if (err instanceof PreflightError) {
    const options = err.line === undefined ? { message: err.message } : { message: err.message, line: err.line };
    return new ConsoleError(PREFLIGHT_CODES[err.code] ?? "RUN_REFUSED", options);
  }
  if (err instanceof HistoryIncompleteError) {
    if (err.rebuildable) return new ConsoleError("NEEDS_REBUILD", { message: err.message, rebuildable: true });
    return new ConsoleError(err.reason === "NOT_REGISTERED" ? "TREASURY_NOT_REGISTERED" : "HISTORY_INCOMPLETE", { message: err.message });
  }
  if (err instanceof PaymentInFlightError) {
    if (err.rebuildable) return new ConsoleError("NEEDS_REBUILD", { message: err.message, rebuildable: true });
    return new ConsoleError(err.reason === "UNREADABLE" ? "RECORD_DAMAGED" : "PAYMENT_PENDING", { message: err.message });
  }
  if (err instanceof AmountMismatchError) {
    const line = err.lines[0];
    return new ConsoleError("AMOUNT_MISMATCH", line === undefined ? { message: err.message } : { message: err.message, line });
  }
  if (err instanceof PaidElsewhereError) return new ConsoleError("PAID_ELSEWHERE", { message: err.message });
  if (err instanceof SignedTransactionMismatchError) return new ConsoleError("WALLET_CHANGED_TRANSACTION", { message: err.message });
  return err;
}

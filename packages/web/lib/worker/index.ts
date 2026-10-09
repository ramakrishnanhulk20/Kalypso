// First, so the Buffer global passkey-kit reads while loading exists before any module imports it.
import "./sdk";
import type { WorkerView } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import {
  buildAnchorPayment as anchorPayment,
  sendAnchorPayment as anchorSend,
  startCashOut as cashOutStart,
  watchCashOut as cashOutWatch,
  type AnchorPayment,
  type CashOutRecord,
  type CashOutStart,
  type CashOutStatus,
} from "./anchor";
import { withdraw, type WithdrawOptions, type WithdrawResult } from "./cashout";
import { join, type JoinProgress, type JoinResult } from "./join";
import { connectPasskey, createPasskey, finishSetup } from "./passkey";
import { payslips } from "./payslips";
import { addressProven as proven, runtime, walletOnChain as onChain, type WorkerSession } from "./session";
import type { BirthIndexPort, SponsorError, SponsorPort } from "./sponsor";
import { connectWallet } from "./wallet";
import type { WorkerError } from "./errors";

export type { WorkerSession } from "./session";
export type { JoinProgress, JoinResult, JoinStep } from "./join";
export type { WithdrawOptions, WithdrawResult } from "./cashout";
export type { AnchorPayment, CashOutRecord, CashOutStart, CashOutStatus } from "./anchor";
export { isAnchorMessage } from "./anchor";
export { WORKER_ERROR_CODES, WorkerError, toWorkerError, type WorkerErrorCode } from "./errors";
export {
  SPONSOR_ERROR_CODES,
  SponsorError,
  createHttpSponsor,
  type BirthIndexPort,
  type RelayStatus,
  type SponsorBody,
  type SponsorErrorCode,
  type SponsorOutcome,
  type SponsorPort,
} from "./sponsor";
export { passkeyDisplayName } from "./passkey";

/**
 * A new worker signs up with a passkey (Face ID, fingerprint or a PIN). Their wallet is deployed
 * through the fee sponsor and read back from chain trusting this passkey, so its address is safe
 * to show and send to an employer. When that deploy is refused or fails, the session comes back
 * with its address hidden and the reason in setupFailure; finishWalletSetup tries again.
 */
export function createPasskeyWorker(sponsor: SponsorPort & Partial<BirthIndexPort>): Promise<{ worker: WorkerSession; setupFailure?: WorkerError | SponsorError }> {
  return createPasskey(runtime(), sponsor);
}

/** Deploys a signed-in passkey worker's wallet through the sponsor, if needed, and proves it trusts this passkey and was born ours. */
export function finishWalletSetup(worker: WorkerSession, sponsor: SponsorPort & Partial<BirthIndexPort>): Promise<{ hash: string | null }> {
  return finishSetup(runtime(), worker, sponsor);
}

/**
 * Whether the worker's address may be shown, copied or handed to anyone: always for a wallet worker,
 * and for a passkey worker only once the chain has shown their wallet trusting this passkey (C51).
 */
export function addressProven(worker: WorkerSession): boolean {
  return proven(worker);
}

/**
 * Whether the worker's wallet is on chain: always for a wallet worker, and for a passkey worker once
 * this session saw it running the pinned code and trusting this passkey. Payslips and cash-out need
 * only this; the address and joining wait for addressProven.
 */
export function walletOnChain(worker: WorkerSession): boolean {
  return onChain(worker);
}

/**
 * A returning passkey worker signs in with one prompt. The address is proven only once the chain
 * shows the wallet was born ours; when its birth cannot be found or read, or shows someone else
 * created it, the session comes back with its address hidden and the reason in setupFailure.
 */
export function connectPasskeyWorker(sponsor: SponsorPort & Partial<BirthIndexPort>): Promise<{ worker: WorkerSession; setupFailure?: WorkerError | SponsorError }> {
  return connectPasskey(runtime(), sponsor);
}

/** A worker signs in with their own wallet, which is asked to sign the key message twice. */
export function connectWalletWorker(wallet: WalletPort): Promise<{ worker: WorkerSession }> {
  return connectWallet(runtime(), wallet);
}

/** Joins a company from its invite, through the fee sponsor. Safe to run again after any failure. */
export function joinCompany(worker: WorkerSession, companyId: bigint, sponsor: SponsorPort, onProgress?: (p: JoinProgress) => void): Promise<JoinResult> {
  return join(runtime(), worker, companyId, sponsor, onProgress);
}

/**
 * The worker's own payslips and balances, checked against the chain, for every company the payroll
 * contract's join events or this browser's record name. NOT_REGISTERED means the worker is not
 * registered with the token and the chain lists them in no company yet.
 */
export function loadPayslips(worker: WorkerSession): Promise<WorkerView> {
  return payslips(runtime(), worker);
}

/**
 * Withdraws `amount` stroops of confidential pay to the cash-out account as plain USDC, through the
 * fee sponsor, or with payFee "self" paid from the worker's own G account. Resolves only once the
 * chain shows the balance the withdraw left.
 */
export function withdrawToCashOut(worker: WorkerSession, amount: bigint, sponsor: SponsorPort, options?: WithdrawOptions): Promise<WithdrawResult> {
  return withdraw(runtime(), worker, amount, sponsor, options);
}

/** Logs in at the test anchor and opens a USDC withdrawal; the screen opens interactiveUrl. */
export function startCashOut(worker: WorkerSession): Promise<CashOutStart> {
  return cashOutStart(runtime(), worker);
}

/** The anchor's requested USDC payment, built only from its authenticated record, unsigned. */
export function buildAnchorPayment(worker: WorkerSession, transactionId: string): Promise<AnchorPayment> {
  return anchorPayment(runtime(), worker, transactionId);
}

/**
 * Follows the anchor's record of a cash-out until it is final, or ready for the worker to approve
 * the USDC transfer; onStatus gets each new status in a plain sentence. Call it again after
 * sendAnchorPayment to follow the cash-out on to completed. An abort rejects with its own reason.
 */
export function watchCashOut(
  worker: WorkerSession,
  transactionId: string,
  onStatus: (s: { status: CashOutStatus; message: string }) => void,
  signal?: AbortSignal,
): Promise<CashOutRecord> {
  return cashOutWatch(runtime(), worker, transactionId, onStatus, signal);
}

/** Signs and sends the anchor payment from the cash-out account, only while the anchor's record still asks for exactly it. */
export function sendAnchorPayment(worker: WorkerSession, payment: AnchorPayment): Promise<{ hash: string }> {
  return anchorSend(runtime(), worker, payment);
}

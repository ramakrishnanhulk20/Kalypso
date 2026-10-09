import {
  AuditorBindingError,
  ContractCallError,
  DecodeError,
  FeeCapError,
  HistoryIncompleteError,
  KeyError,
  PrfUnavailableError,
  RpcTimeoutError,
  SubmitRejectedError,
  WorkerActionError,
  WorkerViewError,
  contractErrorCode,
} from "@kalypso/core";
import { SponsorError } from "./sponsor";

// Every message is a sentence a screen shows as it is. None carries an amount, a balance, a key or
// a signature (threat model C12), and none repeats another library's text.
const MESSAGES = {
  INVALID_INPUT: "Kalypso was given settings it cannot use. Reload the page and try again.",
  INVALID_AMOUNT: "Enter an amount above zero.",
  NO_SESSION: "You are signed out. Sign in again to continue.",
  BUSY: "This is already running in another tab. Finish it there, or close that tab and try again.",
  NETWORK: "Kalypso could not reach the Stellar test network. Check your connection and try again.",
  STORAGE_FAILED: "That worked, but this browser would not let Kalypso remember it. Allow site storage and try again.",
  UNEXPECTED: "Something went wrong. Try again, and Kalypso picks up from what the chain already shows.",

  PASSKEY_UNSUPPORTED: "This browser cannot use passkeys. Use a current browser, or sign in with Freighter.",
  PASSKEY_CANCELLED: "The passkey prompt was closed before it finished. Try again when you are ready.",
  PASSKEY_WRONG_SITE: "This page is not allowed to use passkeys for Kalypso. Open Kalypso from its own address.",
  PASSKEY_FAILED: "The passkey did not answer the way Kalypso needs. Try again.",
  NO_USER_VERIFICATION: "The passkey did not confirm it was you (Face ID, fingerprint or PIN). Kalypso needs that check every time.",
  PRF_UNAVAILABLE: "This passkey cannot create a Kalypso private key. Use a passkey provider that supports PRF, or sign in with Freighter.",
  WALLET_SETUP_FAILED: "Kalypso could not prepare your new wallet. Check your connection and try again.",
  WALLET_RECORD_INVALID: "This browser's record of your new wallet is damaged, so it cannot be set up. Create a new account.",
  WALLET_CODE_UNKNOWN: "The wallet at this address runs code Kalypso does not trust, so it will not be used.",
  PASSKEY_NOT_THIS_WALLET: "This passkey is not the one that controls this wallet.",
  PASSKEY_WALLET_UNKNOWN: "Kalypso cannot find the wallet for this passkey. If you made it on another device, finish joining there first.",
  ADDRESS_TAKEN: "This address was taken before your wallet was set up. Create a new pay key.",
  WALLET_BIRTH_UNKNOWN:
    "Kalypso could not confirm how this wallet was set up just now, so its address stays hidden for now. Your payslips and cash-out still work below. Try again in a minute.",

  WALLET_ADDRESS_INVALID: "The wallet did not give a Stellar account address.",
  WALLET_REJECTED: "The wallet did not approve the request.",
  WALLET_NOT_REPRODUCIBLE: "This wallet gave two different signatures for the same message, so it cannot rebuild your key next time. Use a wallet that signs the same way each time, such as Freighter.",
  WALLET_SIGNATURE_INVALID: "The wallet's signature is not this account's signature over the Kalypso key message. Sign it again.",
  WALLET_ACCOUNT_MISSING: "This wallet account is not on the Stellar test network yet. Fund it with friendbot, then try again.",
  WALLET_CHANGED_TRANSACTION: "The wallet returned a different transaction from the one it was asked to sign, so nothing was sent.",
  SIGNING_TOO_SLOW: "The approval took longer than the minute the relayer accepts. Try again and approve a little sooner.",
  KEYS_MISMATCH: "This account is registered with other private keys than the ones this sign-in made, so its pay cannot be read here.",

  COMPANY_NOT_FOUND: "There is no company with that id.",
  NOT_INVITED: "This company has not invited this account. Ask them to invite the address shown here.",
  INVITE_WITHDRAWN: "This invite was withdrawn, or you were removed from the company. Ask them to invite you again.",
  NOT_REGISTERED: "This account is not set up for private pay yet. Join a company first.",
  AUDITOR_ID_TAKEN: "The audit key id does not belong to you, so Kalypso will not register under it.",
  PROOF_REFUSED: "The network refused this browser's proof, so nothing changed. Try again.",
  SIMULATION_FAILED: "The network would not run this step, so nothing was sent.",
  FEE_TOO_HIGH: "The network asked for a fee above Kalypso's cap, so nothing was signed.",
  TX_FAILED: "The transaction reached the network but failed there, so nothing changed. Try again.",
  TX_PENDING: "The transaction has not landed yet. Check again in a minute; Kalypso will not send it twice.",
  CHAIN_DISAGREES: "The chain does not show what this step should have done. Try again in a minute.",

  HISTORY_INCOMPLETE: "History incomplete: the balance this browser rebuilt does not match the chain yet, so nothing was withdrawn. Try again shortly.",
  INSUFFICIENT_FUNDS: "That is more than your private balance holds.",
  NOTHING_TO_MERGE: "There is no incoming pay waiting to be moved into your balance.",
  AMOUNT_MISMATCH: "The withdrawal proof did not move exactly the amount asked for, so nothing was sent.",
  WITHDRAW_NOT_CONFIRMED: "The network took the move, but your balance did not change as expected, so Kalypso cannot confirm it. Check your payslips in a minute before you try again.",
  CASHOUT_SETUP_FAILED: "Kalypso could not set up your cash-out account on the test network. Try again in a minute.",

  ANCHOR_UNAVAILABLE: "The cash-out service could not be reached. Try again shortly.",
  ANCHOR_CONFIG_INVALID: "The cash-out service published settings Kalypso does not accept, so nothing was signed.",
  ANCHOR_CHALLENGE_INVALID: "The cash-out service sent a sign-in request Kalypso does not accept, so nothing was signed.",
  ANCHOR_REFUSED: "The cash-out service refused the request.",
  ANCHOR_NOT_READY: "The cash-out service is still waiting for you to finish its page.",
  ANCHOR_RECORD_INVALID: "The cash-out service's record of this withdrawal is not one Kalypso can pay, so nothing was built.",
  ANCHOR_RECORD_CHANGED: "The cash-out service changed its request after you saw it, so nothing was sent. Start the cash-out again.",
  CASHOUT_NO_XLM: "Your cash-out account has no XLM left for the network fee, so nothing was sent. Fund it with friendbot, then try again.",
  ANCHOR_ALREADY_PAID: "This cash-out was already paid from your account, so it was not sent again.",
} as const;

export type WorkerErrorCode = keyof typeof MESSAGES;

export const WORKER_ERROR_CODES = Object.keys(MESSAGES) as WorkerErrorCode[];

/** A worker action stopped. message is the plain sentence for the screen. */
export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  /** The contract's own error number, when the network named one. */
  readonly contractCode: number | undefined;
  /** The transaction concerned, when there is one. Public. */
  readonly hash: string | undefined;

  constructor(code: WorkerErrorCode, options: { contractCode?: number; hash?: string } = {}) {
    super(MESSAGES[code]);
    this.name = "WorkerError";
    this.code = code;
    this.contractCode = options.contractCode;
    this.hash = options.hash;
  }
}

// Our contracts' error numbers do not overlap: payroll 1 to 24, the registry 100 to 105 and 3300
// to 3303, the token 3500 to 3514 (core's PayrollErrorCode, AuditorErrorCode, TokenErrorCode), so
// a number names its meaning whichever of them raised it.
const CONTRACT_CODES: Readonly<Record<number, WorkerErrorCode>> = {
  1: "COMPANY_NOT_FOUND",
  2: "NOT_REGISTERED",
  7: "NOT_INVITED",
  23: "AUDITOR_ID_TAKEN",
  24: "NETWORK",
  100: "AUDITOR_ID_TAKEN",
  3500: "CHAIN_DISAGREES",
  3501: "NOT_REGISTERED",
  3506: "PROOF_REFUSED",
};

function fromContractCode(code: number | undefined, otherwise: WorkerErrorCode): WorkerError {
  if (code === undefined) return new WorkerError(otherwise);
  return new WorkerError(Object.hasOwn(CONTRACT_CODES, code) ? CONTRACT_CODES[code]! : "SIMULATION_FAILED", { contractCode: code });
}

/** A failed simulation, read for the contract's own refusal; the RPC's text itself never reaches the screen. */
export function simulationRefusal(errorText: string | undefined): WorkerError {
  return fromContractCode(contractErrorCode(errorText), "SIMULATION_FAILED");
}

const KEY_CODES: Readonly<Partial<Record<string, WorkerErrorCode>>> = {
  NOT_REPRODUCIBLE: "WALLET_NOT_REPRODUCIBLE",
  BAD_SIGNATURE: "WALLET_SIGNATURE_INVALID",
  SIGNATURE_LENGTH: "WALLET_SIGNATURE_INVALID",
  NOT_BYTES: "WALLET_SIGNATURE_INVALID",
  ALL_ZERO: "WALLET_SIGNATURE_INVALID",
  PRF_OUTPUT_LENGTH: "PRF_UNAVAILABLE",
};

const ACTION_CODES: Readonly<Record<string, WorkerErrorCode>> = {
  INVALID_INPUT: "INVALID_INPUT",
  NOT_REGISTERED: "NOT_REGISTERED",
  KEYS_MISMATCH: "KEYS_MISMATCH",
  HISTORY_INCOMPLETE: "HISTORY_INCOMPLETE",
  NOTHING_TO_MERGE: "NOTHING_TO_MERGE",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
};

/**
 * Any failure as one of the portal's own typed errors. A SponsorError stays itself: its code is the
 * sponsor's refusal and its outcome says whether the transaction may still land. Anything this
 * table does not know becomes UNEXPECTED, never the original message.
 */
export function toWorkerError(err: unknown): WorkerError | SponsorError {
  if (err instanceof WorkerError || err instanceof SponsorError) return err;
  if (err instanceof PrfUnavailableError) return new WorkerError("PRF_UNAVAILABLE");
  if (err instanceof KeyError) return new WorkerError(KEY_CODES[err.code] ?? "INVALID_INPUT");
  if (err instanceof WorkerViewError || err instanceof WorkerActionError) return new WorkerError(ACTION_CODES[err.code] ?? "INVALID_INPUT");
  if (err instanceof AuditorBindingError) return new WorkerError("AUDITOR_ID_TAKEN");
  if (err instanceof FeeCapError) return new WorkerError("FEE_TOO_HIGH");
  if (err instanceof HistoryIncompleteError) return new WorkerError("HISTORY_INCOMPLETE");
  if (err instanceof ContractCallError) return fromContractCode(err.contractCode, "NETWORK");
  if (err instanceof RpcTimeoutError) return new WorkerError("NETWORK");
  if (err instanceof SubmitRejectedError) return new WorkerError("TX_FAILED");
  if (err instanceof DecodeError) return new WorkerError("CHAIN_DISAGREES");
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new WorkerError("PASSKEY_CANCELLED");
  return new WorkerError("UNEXPECTED");
}

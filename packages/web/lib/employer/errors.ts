export type ConsoleErrorCode =
  | "NOT_TESTNET"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_FAILED"
  | "BUSY"
  | "ACCOUNT_NOT_FOUND"
  | "KEY_NOT_DERIVED"
  | "ACCOUNTANT_ID_INVALID"
  | "ACCOUNTANT_ADDRESS_INVALID"
  | "ACCOUNTANT_UNKNOWN"
  | "ACCOUNTANT_MISMATCH"
  | "ACCOUNTANT_KEY_INVALID"
  | "ACCOUNTANT_KEY_CHANGED"
  | "ACCOUNTANT_ID_NOT_YOURS"
  | "DEMO_ACCOUNTANT"
  | "BOOKS_NOT_YOURS"
  | "BOOKS_INCOMPLETE"
  | "LABEL_INVALID"
  | "COMPANY_ID_INVALID"
  | "COMPANY_NOT_FOUND"
  | "COMPANY_MISMATCH"
  | "NOT_ADMIN"
  | "TREASURY_BOUND_ELSEWHERE"
  | "TREASURY_KEYS_MISMATCH"
  | "TREASURY_NOT_REGISTERED"
  | "AMOUNT_INVALID"
  | "USDC_SHORT"
  | "WORKERS_INVALID"
  | "PERIOD_INVALID"
  | "CSV_INVALID"
  | "RUN_MISMATCH"
  | "RUN_CLOSED"
  | "NOT_ENOUGH_WORKERS"
  | "RUN_REFUSED"
  | "NEEDS_REBUILD"
  | "PAYMENT_PENDING"
  | "RECORD_DAMAGED"
  | "RECORD_NOT_DAMAGED"
  | "DEPOSIT_PENDING"
  | "AMOUNT_MISMATCH"
  | "PAID_ELSEWHERE"
  | "HISTORY_INCOMPLETE"
  | "SIMULATION_FAILED"
  | "FEE_TOO_HIGH"
  | "SUBMIT_REFUSED"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_EXPIRED"
  | "TRANSACTION_PENDING"
  | "WALLET_CHANGED_TRANSACTION"
  | "NOT_ON_CHAIN"
  | "CHAIN_DISAGREES";

// Messages name lines, ids and steps, never an amount, a balance, a key or a signature (threat model C12).
const MESSAGES: Record<ConsoleErrorCode, string> = {
  NOT_TESTNET: "This build of Kalypso is not set up for Stellar testnet, so nothing was sent.",
  STORAGE_UNAVAILABLE: "This browser does not let Kalypso keep the treasury records it needs (private browsing can block it), so nothing was sent.",
  STORAGE_FAILED: "This browser refused to save or read a treasury record, so nothing was sent. Leave private browsing or free some disk space, then try again.",
  BUSY: "Another Kalypso tab is working with this wallet right now. Finish there, then try again.",
  ACCOUNT_NOT_FOUND: "This wallet's account does not exist on testnet yet. Fund it with test XLM from friendbot (Freighter's Fund button does this), then try again.",
  KEY_NOT_DERIVED: "The wallet's signatures could not make a Kalypso key, so nothing was sent.",
  ACCOUNTANT_ID_INVALID: "The accountant id must be a whole number, exactly as the accountant's own screen shows it.",
  ACCOUNTANT_ADDRESS_INVALID: "The accountant's address is not a valid Stellar address.",
  ACCOUNTANT_UNKNOWN: "No accountant key is registered under this id. Ask your accountant for the id their own screen shows.",
  ACCOUNTANT_MISMATCH: "This accountant id belongs to a different address from the one entered. Check both with your accountant before going on.",
  ACCOUNTANT_KEY_INVALID: "The accountant key to confirm is missing or damaged. Check the accountant id again first.",
  ACCOUNTANT_KEY_CHANGED: "The key under this accountant id changed since it was checked. Check it with your accountant again before going on.",
  ACCOUNTANT_ID_NOT_YOURS: "This id is not registered to this wallet with the key it makes here, so it was not used. Register your key to get your own id.",
  DEMO_ACCOUNTANT: "This accountant id is Kalypso's public demo key: anyone can read payroll under it. Ask your accountant to register their own key and use that id.",
  BOOKS_NOT_YOURS: "This company's books are sealed to an accountant id this wallet's key does not hold, so they cannot be opened with it.",
  BOOKS_INCOMPLETE: "The books are incomplete, so nothing was exported. Try again in a minute.",
  LABEL_INVALID: "The company name must be 1 to 64 bytes long.",
  COMPANY_ID_INVALID: "The company id must be a whole number.",
  COMPANY_NOT_FOUND: "No company exists under this id on the payroll contract.",
  COMPANY_MISMATCH: "The company under this id was set up with a different admin, accountant or name, so nothing was changed.",
  NOT_ADMIN: "This wallet is not the company's admin, so it cannot act for the company.",
  TREASURY_BOUND_ELSEWHERE:
    "This wallet is already registered with the confidential token under another accountant id, and that can never change. Use a fresh wallet for a company with this accountant.",
  TREASURY_KEYS_MISMATCH: "This wallet is registered with the confidential token under keys Kalypso did not make here, so nothing was changed.",
  TREASURY_NOT_REGISTERED: "Set up the company first: this wallet is not registered with the confidential token yet.",
  AMOUNT_INVALID: "The deposit must be above zero and no more than the token can hold.",
  USDC_SHORT:
    "This wallet holds less testnet USDC than this deposit. Get testnet USDC from the Stellar Laboratory (lab.stellar.org) or swap test XLM for USDC on the testnet DEX, then try again.",
  WORKERS_INVALID: "The worker list is empty, too long, or has an address that cannot be invited.",
  PERIOD_INVALID: "Pick a month from 1 to 12 and a four-digit year.",
  CSV_INVALID: "The payroll file has problems, so nothing was sent. Fix the lines listed and upload it again.",
  RUN_MISMATCH: "This month's run is already open for a different number of payments. Pay it with the same file, or pick another month.",
  RUN_CLOSED: "This month's run is closed and takes no more payments. Pick another month.",
  NOT_ENOUGH_WORKERS: "The file lists more workers than have joined the company. Each worker must accept their invite first.",
  RUN_REFUSED: "The payroll run was refused before anything was sent.",
  NEEDS_REBUILD: "This device's treasury records do not match the chain. Rebuild the treasury from the chain, check the result, then pay again.",
  PAYMENT_PENDING: "A payment from this treasury is still settling on the network. Try again in a few minutes.",
  RECORD_DAMAGED: "This browser's record of the payment in flight is damaged, so nothing was sent.",
  RECORD_NOT_DAMAGED: "This browser's record of the payment in flight reads fine, so it was not cleared. Run the payroll again to settle it.",
  DEPOSIT_PENDING: "Your last deposit is still waiting on the network, so no new deposit was sent. Try again in a minute.",
  AMOUNT_MISMATCH: "A payment did not move exactly the approved amount, so the run stopped.",
  PAID_ELSEWHERE: "Some rows were paid by another tab or device. Nobody was paid twice. Reload the run.",
  HISTORY_INCOMPLETE: "The treasury's history could not be read in full, so nothing was saved. Try again later.",
  SIMULATION_FAILED: "The network would not run this call, so nothing was signed.",
  FEE_TOO_HIGH: "The network asked for a fee above Kalypso's cap for this call, so nothing was signed.",
  SUBMIT_REFUSED: "The network refused the transaction, so nothing changed. Try again.",
  TRANSACTION_FAILED: "The transaction failed on chain, so nothing changed. Try again.",
  TRANSACTION_EXPIRED: "The transaction expired before it landed, so nothing changed. Try again.",
  TRANSACTION_PENDING: "A transaction is still waiting on the network. Try again in a minute and Kalypso carries on from the chain.",
  WALLET_CHANGED_TRANSACTION: "The wallet returned a different transaction from the one it was asked to sign. Nothing was sent.",
  NOT_ON_CHAIN: "The transaction landed, but the chain does not show its result yet. Try again in a minute.",
  CHAIN_DISAGREES: "The chain answered in a way Kalypso does not expect, so it stopped before sending anything more.",
};

/** One refused or failed line of a payroll file, as a sentence that names the line. */
export interface CsvProblem {
  /** The line in the file, or 0 when the problem is the whole file. */
  line: number;
  code: string;
  sentence: string;
}

/**
 * An employer or accountant console step was refused or failed. The message is plain English for
 * the screen. `rebuildable` is true when rebuilding the treasury from the chain clears it, so the
 * screen can offer that. `line` names a CSV line or a list position when one is at fault.
 */
export class ConsoleError extends Error {
  readonly code: ConsoleErrorCode;
  readonly rebuildable: boolean;
  readonly line: number | undefined;
  readonly problems: readonly CsvProblem[];
  /** The contract's own error number when the network named one. */
  readonly contractCode: number | undefined;

  constructor(
    code: ConsoleErrorCode,
    options: { message?: string; rebuildable?: boolean; line?: number; problems?: readonly CsvProblem[]; contractCode?: number } = {},
  ) {
    super(options.message ?? MESSAGES[code]);
    this.name = "ConsoleError";
    this.code = code;
    this.rebuildable = options.rebuildable ?? false;
    this.line = options.line;
    this.problems = options.problems ?? [];
    this.contractCode = options.contractCode;
  }
}

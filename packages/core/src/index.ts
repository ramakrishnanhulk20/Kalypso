export { AmountError, MAX_STROOPS, USDC_DECIMALS, formatUsdc, parseUsdc } from './amounts.js';
export type { AmountErrorCode, Stroops } from './amounts.js';

export { AddressError, parseAccount, sameAccount } from './addresses.js';
export type { AccountKind, AddressErrorCode } from './addresses.js';

export {
  CSV_DEFAULT_MAX_BYTES,
  CSV_DEFAULT_MAX_ROWS,
  CSV_NAME_MAX_CHARACTERS,
  parsePayrollCsv,
  toSafeCsvCell,
} from './csv.js';
export type { CsvError, CsvErrorCode, CsvRow } from './csv.js';

export {
  KEY_VERSION,
  KeyError,
  PrfUnavailableError,
  deriveFromPrf,
  deriveFromWalletSignature,
  prfEvalSalt,
  requirePrfOutput,
  walletKeyMessage,
} from './keys.js';
export type { KeyErrorCode, KalypsoKeys, PrfUnavailableReason } from './keys.js';

export { ContractCallError, SubmitRejectedError, contractErrorCode } from './chain/ports.js';
export type { ChainPort, InFlightPay, OpeningStore, SavedOpening, SignerPort, SimResult } from './chain/ports.js';

export { RPC_TIMEOUT_MS, RpcTimeoutError, createRpcChainPort } from './chain/rpc-port.js';

export { DecodeError } from './chain/scval.js';

export {
  DEFAULT_TX_TIMEOUT_SECONDS,
  assembleFromSimulation,
  buildInvocation,
  decodeInvocation,
  transactionHash,
} from './chain/tx.js';
export type { Invocation, InvocationBase } from './chain/tx.js';

export {
  MAX_BATCH,
  MAX_COMPANY_LABEL_BYTES,
  MAX_PERIOD_LABEL_BYTES,
  MAX_ROSTER_PAGE,
  PayrollErrorCode,
  buildAcceptAdmin,
  buildAcceptInvite,
  buildCancelAdminProposal,
  buildCloseRun,
  buildCreateCompany,
  buildInviteWorker,
  buildOpenRun,
  buildPay,
  buildProposeAdmin,
  buildRemoveWorker,
  buildRevokeInvite,
  decodeCompany,
  decodeIsPaid,
  decodeRoster,
  decodeRun,
  decodeWorkerStatus,
  getCompany,
  getRoster,
  getRun,
  isPaid,
  isPayrollError,
  workerStatus,
} from './chain/payroll.js';
export type { Company, PayItem, Run, RunStatus, WorkerStatus } from './chain/payroll.js';

export {
  AuditorErrorCode,
  TokenErrorCode,
  buildConfidentialTransfer,
  buildDeposit,
  buildMerge,
  buildRegister,
  buildWithdraw,
  confidentialBalance,
  decodeAuditorKey,
  decodeConfidentialAccount,
  getAuditorKey,
  requireOnCurvePoint,
} from './chain/token.js';
export type { ConfidentialAccountView, RegisterProof, TransferProof, WithdrawProof } from './chain/token.js';

export { planRun } from './run/plan.js';

export {
  HistoryIncompleteError,
  batchOpeningKey,
  inFlightKey,
  loadTreasuryOpening,
  readInFlight,
  readSavedOpening,
  toSavedOpening,
  treasuryOpeningKey,
} from './run/treasury.js';
export type { HistoryIncompleteReason, Opening } from './run/treasury.js';

export {
  AmountMismatchError,
  PaymentInFlightError,
  PreflightError,
  SignedTransactionMismatchError,
  executeRun,
} from './run/engine.js';
export type { PreflightErrorCode, RowFailureReason, RowStatus, RunInput, RunReport } from './run/engine.js';

export { createCircuitProver } from './prover/browser.js';
export type { CircuitProverPort, CircuitSet, CompiledCircuit } from './prover/browser.js';
export type { ProofEnvelope, ProverPort, TransferEnvelope, WithdrawEnvelope } from './prover/port.js';

export { createRpcEventsPort, parseRpcEventId } from './history/rpc-events.js';
export type { ContractEventsQuery, EventPosition, EventsPort, RawContractEvent, RpcContractEvent } from './history/rpc-events.js';
export { decodeContractEvent, eventId } from './history/decode.js';
export type { EventMeta, HistoryEvent, PayrollEvent, TokenEvent } from './history/decode.js';
export { ARCHIVE_TIMEOUT_MS, fetchAccountHistory, fetchCompanyHistory } from './history/events.js';
export type { ArchiveConfig, HistoryResult, HistorySource } from './history/events.js';
export { TX_SOURCE_TIMEOUT_MS, bindTransferToTransaction, createTxSourcePort } from './history/tx-binding.js';
export type { BindingFailure, BoundCall, BoundTransferPayload, TransferBinding, TxRecord, TxSourcePort } from './history/tx-binding.js';

export { MAX_WORKER_COMPANIES, WorkerViewError, loadWorkerBalance, loadWorkerView } from './payslips/worker.js';
export type { Payslip, WorkerBalance, WorkerView, WorkerViewErrorCode } from './payslips/worker.js';
export { AuditError, auditCompany, exportAuditCsv } from './payslips/accountant.js';
export type { AuditErrorCode, AuditLine, AuditResult, AuditRun, UndecryptableReason } from './payslips/accountant.js';
export { WorkerActionError, buildWorkerMerge, buildWorkerWithdraw } from './payslips/worker-actions.js';
export type { WorkerActionErrorCode } from './payslips/worker-actions.js';

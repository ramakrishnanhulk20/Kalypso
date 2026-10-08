import type { Point } from 'stellar-confidential-token-sdk';
import { MAX_STROOPS } from '../amounts.js';
import { parseAccount, sameAccount } from '../addresses.js';
import { CSV_DEFAULT_MAX_ROWS, type CsvRow } from '../csv.js';
import type { KalypsoKeys } from '../keys.js';
import { mapInOrder } from '../map-in-order.js';
import {
  PayrollErrorCode,
  buildPay,
  getCompany,
  getRun,
  isPaid,
  isPayrollError,
  workerStatus,
  type PayItem,
} from '../chain/payroll.js';
import { SubmitRejectedError, type ChainPort, type InFlightPay, type OpeningStore, type SignerPort } from '../chain/ports.js';
import { requireAccount, requireU32, requireU64 } from '../chain/scval.js';
import { confidentialBalance, getAuditorKey, type ConfidentialAccountView } from '../chain/token.js';
import { DEFAULT_TX_TIMEOUT_SECONDS, FeeCapError, MAX_PAY_FEE_STROOPS, assembleFromSimulation, decodeInvocation, transactionHash } from '../chain/tx.js';
import type { ProverPort, TransferEnvelope } from '../prover/port.js';
import { planRun } from './plan.js';
import {
  attemptsKey,
  batchOpeningKey,
  inFlightKey,
  loadTreasuryOpening,
  readAttempts,
  readInFlight,
  readSavedOpening,
  saveAttempts,
  toSavedOpening,
  treasuryOpeningKey,
  type Opening,
} from './treasury.js';

export interface RunInput {
  port: ChainPort;
  signer: SignerPort;
  store: OpeningStore;
  networkPassphrase: string;
  contracts: { payroll: string; token: string; auditor: string };
  companyId: bigint;
  runId: bigint;
  rows: CsvRow[];
  keys: KalypsoKeys;
  /** Builds the transfer proofs: createCircuitProver in a browser, createNodeProver from "@kalypso/core/node" in Node. */
  prover: ProverPort;
  /** Called as each row moves on. `row` is the CSV line number. Events never carry an amount. */
  onProgress?: (e: { row: number; status: RowStatus }) => void;
  /**
   * Further auditor ids whose secret key is published, for deployments other than the ones in
   * PUBLISHED_DEMO_AUDITOR_IDS. A run is refused when the company, or any worker in it, is
   * registered under one of them, so real pay is never readable by whoever holds the key. These
   * are refused even when allowPublishedDemoAuditor is set. Default none.
   */
  demoAuditorIds?: number[];
  /**
   * When true, the ids PUBLISHED_DEMO_AUDITOR_IDS lists for this auditor contract are not refused.
   * Only the showcase seed sets it, because the showcase is meant to be readable by anyone.
   * Default false.
   */
  allowPublishedDemoAuditor?: boolean;
}

/**
 * Auditor ids whose secret key is published on purpose, keyed by the auditor registry contract
 * they live in. executeRun always refuses them (threat model C34) unless allowPublishedDemoAuditor
 * is set, so a frontend that forgets to pass demoAuditorIds cannot send real pay under them.
 */
export const PUBLISHED_DEMO_AUDITOR_IDS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG: Object.freeze([5]),
});


export type RowStatus = 'already-paid' | 'proving' | 'submitted' | 'paid' | 'failed';

/**
 * Why a row was not paid, taken from its batch's last attempt. A code, never an amount.
 * PROOF_FAILED and SIMULATION_FAILED mean the batch could not be built even with every key
 * re-read from chain, and FEE_TOO_HIGH that its simulation asked for a fee over
 * MAX_PAY_FEE_STROOPS, so nothing was signed: only that batch fails and the run goes on.
 * SUBMIT_REFUSED, TRANSACTION_FAILED and TRANSACTION_EXPIRED (never included before its validity
 * window closed) mean the network said no: the run stops, and every row after it reports RUN_STOPPED.
 */
export type RowFailureReason =
  | 'PROOF_FAILED'
  | 'SIMULATION_FAILED'
  | 'FEE_TOO_HIGH'
  | 'SUBMIT_REFUSED'
  | 'TRANSACTION_FAILED'
  | 'TRANSACTION_EXPIRED'
  | 'RUN_STOPPED';

/**
 * rows are in CSV order and their status is read from the on-chain paid check after the run;
 * a failed row carries its reason. transactions lists the pay transactions that landed during
 * this call, in order.
 */
export interface RunReport {
  rows: { line: number; address: string; status: 'paid' | 'already-paid' | 'failed'; txHash?: string; reason?: RowFailureReason }[];
  transactions: string[];
}

export type PreflightErrorCode =
  | 'INVALID_INPUT'
  | 'NO_ROWS'
  | 'TOO_MANY_ROWS'
  | 'INVALID_ROW'
  | 'DUPLICATE_ROW'
  | 'COMPANY_NOT_FOUND'
  | 'NOT_ADMIN'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_OPEN'
  | 'RUN_COUNT_EXCEEDED'
  | 'WORKER_NOT_ACTIVE'
  | 'WORKER_NOT_REGISTERED'
  | 'TREASURY_NOT_REGISTERED'
  | 'KEYS_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'DEMO_AUDITOR_ID';

// Messages name lines, never amounts or balances (threat model C12).
const PREFLIGHT_MESSAGES: Record<PreflightErrorCode, string> = {
  INVALID_INPUT:
    'The run settings are invalid: a contract id, the signer address, the company id, the run id, the prover or a demo auditor setting.',
  NO_ROWS: 'There are no rows to pay.',
  TOO_MANY_ROWS: `A run takes at most ${CSV_DEFAULT_MAX_ROWS} rows.`,
  INVALID_ROW: 'This row has an address or amount that did not come from the CSV parser.',
  DUPLICATE_ROW: 'This worker is listed twice. List each worker once per run.',
  COMPANY_NOT_FOUND: 'This company does not exist on the payroll contract.',
  NOT_ADMIN: 'The connected wallet is not the company admin, so it cannot pay from the treasury.',
  RUN_NOT_FOUND: 'This company never opened this run.',
  RUN_NOT_OPEN: 'This run is closed and takes no more payments.',
  RUN_COUNT_EXCEEDED: 'This run was opened for fewer payments than there are unpaid rows.',
  WORKER_NOT_ACTIVE: 'This worker is not active in the company. They must accept an invite before they can be paid.',
  WORKER_NOT_REGISTERED: 'This worker has not registered with the confidential token yet.',
  TREASURY_NOT_REGISTERED: 'The treasury has not registered with the confidential token.',
  KEYS_MISMATCH: 'These private keys do not belong to the treasury account. Sign in again with the admin wallet.',
  INSUFFICIENT_FUNDS: 'The treasury balance does not cover the unpaid rows. Deposit and merge more USDC first.',
  DEMO_AUDITOR_ID:
    'The company or this worker is registered under the demo accountant key, which is published, so anyone could read this pay. Real payroll is never sent under it.',
};

/** The run was refused before any transaction was built. Nothing was sent. */
export class PreflightError extends Error {
  readonly code: PreflightErrorCode;
  readonly line: number | undefined;

  constructor(code: PreflightErrorCode, line?: number) {
    super(line === undefined ? PREFLIGHT_MESSAGES[code] : `Line ${line}: ${PREFLIGHT_MESSAGES[code]}`);
    this.name = 'PreflightError';
    this.code = code;
    this.line = line;
  }
}

/**
 * What a proof or the chain shows does not equal the CSV amounts the employer approved
 * (threat model C14). The run stops and nothing more is paid. `lines` are the rows involved.
 */
export class AmountMismatchError extends Error {
  readonly lines: number[];

  constructor(lines: number[], where: 'proof' | 'chain') {
    super(
      where === 'proof'
        ? `Lines ${lines.join(', ')}: a payment proof does not move the approved amount. Nothing was sent for these rows and the run stopped.`
        : `Lines ${lines.join(', ')}: the treasury balance on chain does not match the approved payments. The run stopped and nothing more was paid.`,
    );
    this.name = 'AmountMismatchError';
    this.lines = lines;
  }
}

/** The wallet handed back a different transaction from the one it was asked to sign. It was not sent. */
export class SignedTransactionMismatchError extends Error {
  constructor() {
    super('The wallet returned a different transaction from the one it was asked to sign. Nothing was sent.');
    this.name = 'SignedTransactionMismatchError';
  }
}

/**
 * Rows of this batch were paid by a transaction this call did not see land, most likely another
 * tab or device paying the same run. Nobody was paid twice: the contract's paid flags refuse
 * that. The run stops; running it again reports those rows as already paid.
 */
export class PaidElsewhereError extends Error {
  readonly lines: number[];

  constructor(lines: number[]) {
    super('These rows were paid by another transaction, probably another tab or device. Nothing was paid twice. Reload the run.');
    this.name = 'PaidElsewhereError';
    this.lines = lines;
  }
}

export type PaymentInFlightReason = 'PENDING' | 'UNREADABLE' | 'UNCONFIRMED' | 'DOES_NOT_MATCH_CHAIN' | 'PAID_FLAGS_BEHIND';

const IN_FLIGHT_MESSAGES: Record<PaymentInFlightReason, string> = {
  PENDING:
    'A payment from this treasury is still waiting on the network, so nothing new was proved or sent. Run it again in a few minutes and it carries on from there.',
  UNREADABLE: "This device's record of the payment in flight is damaged, so nothing was sent.",
  UNCONFIRMED:
    'The chain says the last payment landed, but the balance read does not show it yet. Nothing new was proved or sent. Try again in a minute.',
  DOES_NOT_MATCH_CHAIN:
    "The chain's balance for this treasury does not match this device's records. Nothing new was proved or sent. Rebuild the treasury from the chain to see the difference and carry on.",
  PAID_FLAGS_BEHIND:
    'The payment landed and the balance shows it, but the paid marks are not readable yet. Nothing new was proved or sent. Try again in a minute.',
};

/**
 * A pay transaction from this treasury is not final yet, its record cannot be read, the chain
 * reports it applied while no saved opening opens the balance it returns, or it is proved landed
 * while its paid marks do not read yet, so this call proved and sent nothing new (threat model C13).
 *
 * PENDING, UNREADABLE, UNCONFIRMED and DOES_NOT_MATCH_CHAIN keep the record until the chain
 * settles it. PAID_FLAGS_BEHIND comes after the pay's own opening (or a newer one, with SUCCESS)
 * was adopted and the record removed: the balance is settled, only the is_paid reads lag, and the
 * next run reads them again. It is not rebuildable.
 *
 * UNCONFIRMED means the balance read still opens with the treasury opening from before the pay,
 * and the chain's clock is within UNCONFIRMED_GRACE_SECONDS of the pay's maxTime, so the read is
 * behind the pay and clears by itself. DOES_NOT_MATCH_CHAIN means it opens with neither, or is
 * still behind past that grace, so the treasury is not where this device's records say (a merge
 * elsewhere, a pay that left another balance than the one approved (C14), a SUCCESS the chain
 * never applied, or a rebuild cut short). Only that one is rebuildable: the console offers
 * rebuildTreasuryOpening for it.
 */
export class PaymentInFlightError extends Error {
  readonly reason: PaymentInFlightReason;
  readonly rebuildable: boolean;

  constructor(reason: PaymentInFlightReason) {
    super(IN_FLIGHT_MESSAGES[reason]);
    this.name = 'PaymentInFlightError';
    this.reason = reason;
    this.rebuildable = reason === 'DOES_NOT_MATCH_CHAIN';
  }
}
// The first wait for a result runs this long past the validity window by this machine's clock.
// It only sets how long to wait: whether the window has closed is judged by chain time.
const CLOCK_MARGIN_MS = 30_000;
// A transaction is treated as never landing only once a ledger has closed this long after its
// maxTime (threat model C13).
const FINALITY_MARGIN_SECONDS = 30;
// Ledgers close about every 5 seconds, so a wait this much past the gap sees at least one more.
const LEDGER_GAP_MS = 6_000;
// The live port refuses waits over 15 minutes; a record from the store can claim any maxTime.
const MAX_WAIT_MS = 10 * 60_000;
const MAX_LOOKS = 3;
/**
 * RPC nodes trail the network by seconds, not a minute, so a balance read still behind a pay this
 * long after its window closed is no longer lag: UNCONFIRMED becomes DOES_NOT_MATCH_CHAIN.
 */
export const UNCONFIRMED_GRACE_SECONDS = 60;

interface PayableRow extends CsvRow {
  pvk: Point;
  kAudR: Point;
}

/** Where a treasury's openings and pay in flight are kept and checked. */
export interface TreasuryRef {
  port: ChainPort;
  store: OpeningStore;
  token: string;
  treasury: string;
}

interface RunContext extends TreasuryRef {
  input: RunInput;
  payroll: string;
  auditor: string;
  companyAuditorId: number;
  /** The company's auditor key. A rebuild replaces it with the one on chain at that moment. */
  kAudS: Point;
  notify: (line: number, status: RowStatus) => void;
}

type Attempt =
  | { kind: 'landed'; hash: string }
  | { kind: 'not-built'; reason: 'PROOF_FAILED' | 'SIMULATION_FAILED' | 'FEE_TOO_HIGH' }
  | { kind: 'not-landed'; reason: 'SUBMIT_REFUSED' | 'TRANSACTION_FAILED' | 'TRANSACTION_EXPIRED' };

type BatchOutcome = { kind: 'landed'; hash: string } | { kind: 'skip' | 'stop'; reason: RowFailureReason };

function checkSettings(input: RunInput) {
  if (typeof input.prover?.proveTransfer !== 'function') throw new PreflightError('INVALID_INPUT');
  const demoIds = input.demoAuditorIds ?? [];
  if (!Array.isArray(demoIds)) throw new PreflightError('INVALID_INPUT');
  const allowPublished = input.allowPublishedDemoAuditor ?? false;
  if (typeof allowPublished !== 'boolean') throw new PreflightError('INVALID_INPUT');
  try {
    const auditor = requireAccount(input.contracts.auditor, ['C']);
    // The lookup uses the decoded address, the same form the constant is written in.
    const published = !allowPublished && Object.hasOwn(PUBLISHED_DEMO_AUDITOR_IDS, auditor) ? (PUBLISHED_DEMO_AUDITOR_IDS[auditor] ?? []) : [];
    return {
      demoAuditorIds: new Set([...published, ...demoIds.map((id) => requireU32(id, 'demoAuditorIds'))]),
      payroll: requireAccount(input.contracts.payroll, ['C']),
      token: requireAccount(input.contracts.token, ['C']),
      auditor,
      // The treasury is the transaction source, and only a G account can be one.
      treasury: requireAccount(input.signer.address, ['G']),
      companyId: requireU64(input.companyId, 'companyId'),
      runId: requireU64(input.runId, 'runId'),
    };
  } catch {
    throw new PreflightError('INVALID_INPUT');
  }
}

/** Re-decodes every row with the same parsers the CSV importer uses (threat model standard 2). */
function checkRows(rows: CsvRow[]): CsvRow[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new PreflightError('NO_ROWS');
  if (rows.length > CSV_DEFAULT_MAX_ROWS) throw new PreflightError('TOO_MANY_ROWS');
  const seen = new Set<string>();
  return rows.map((row) => {
    const line = Number.isSafeInteger(row?.line) && row.line > 0 ? row.line : 0;
    let address: string;
    try {
      address = parseAccount(row.address).address;
    } catch {
      throw new PreflightError('INVALID_ROW', line);
    }
    if (line === 0 || typeof row.amount !== 'bigint' || row.amount <= 0n || row.amount > MAX_STROOPS) {
      throw new PreflightError('INVALID_ROW', line);
    }
    if (seen.has(address)) throw new PreflightError('DUPLICATE_ROW', line);
    seen.add(address);
    return { ...row, address };
  });
}

async function orRefuse<T>(work: Promise<T>, code: (typeof PayrollErrorCode)[keyof typeof PayrollErrorCode], refusal: PreflightErrorCode): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (isPayrollError(err, code)) throw new PreflightError(refusal);
    throw err;
  }
}

/**
 * Pays a payroll run: turns parsed CSV rows into confidential payments, two per transaction,
 * one transaction in flight at a time.
 *
 * In order:
 * 1. A pay transaction this treasury left in flight, from this run or an earlier call, is
 *    waited on until final before anything is read or proved. The first saved candidate that
 *    opens the chain, its own batch opening or one from the attempts list, becomes the treasury
 *    opening. If the pay cannot be shown final, or the chain reports SUCCESS but no candidate
 *    opens the balance, the call stops with PaymentInFlightError and sends nothing.
 * 2. Preflight, before any transaction. The company exists and its admin is the signer; the run
 *    exists, is open and has room for every unpaid row; every row's worker is active in this
 *    company and registered with the token; neither the company nor any worker is under a
 *    published demo auditor id (PUBLISHED_DEMO_AUDITOR_IDS for this auditor contract, plus
 *    demoAuditorIds); the keys belong to the treasury; the treasury's verified balance covers the
 *    unpaid rows. Viewing keys and both auditor keys are read from chain. Any failure refuses
 *    the whole run and sends nothing.
 * 3. Rows already paid on chain are reported as already-paid and skipped, which is how a
 *    crashed run resumes.
 * 4. Batches run strictly one after another. Each starts from the treasury opening verified
 *    against chain, proves each transfer on the previous one's result, checks every proof
 *    moves exactly its row's CSV amount, simulates, refuses a fee over MAX_PAY_FEE_STROOPS, signs,
 *    saves the opening it leaves under a key holding its hash, adds that key to the attempts
 *    list, records itself as in flight, then submits and waits until the chain's answer is
 *    final: SUCCESS, FAILED, or NOT_FOUND once a ledger has closed 30 seconds past its validity
 *    window.
 * 5. A batch that did not land is built once more, with fresh salts, from chain state and with
 *    every key re-read from chain. If that rebuild cannot be proved, simulated or kept under the
 *    fee cap, only this batch's rows fail and the next batch starts from the same verified
 *    opening. If the network refused it or it failed on chain, the run stops and every later row
 *    reports RUN_STOPPED.
 * 6. After each landed batch the chain's treasury commitment must open with the saved result,
 *    which is the starting balance minus exactly the CSV amounts of the batch. A batch whose rows
 *    were paid by a transaction this call did not see land stops the run with PaidElsewhereError.
 * 7. Report statuses are read from the on-chain paid check, never from a submit reply.
 *
 * @throws PreflightError, PaymentInFlightError, HistoryIncompleteError (the saved treasury
 *   balance does not match chain), AmountMismatchError or PaidElsewhereError (the run stops),
 *   SignedTransactionMismatchError, or any error from the port or the signer. After an error,
 *   calling executeRun again with the same store resumes without paying anyone twice. An error
 *   with rebuildable true (HistoryIncompleteError NO_SAVED_OPENING or DOES_NOT_OPEN,
 *   PaymentInFlightError DOES_NOT_MATCH_CHAIN) is cleared by rebuildTreasuryOpening, which this
 *   never runs on its own so the employer sees any difference first.
 */
export async function executeRun(input: RunInput): Promise<RunReport> {
  const settings = checkSettings(input);
  const rows = checkRows(input.rows);
  const { port, keys } = input;
  const { payroll, token, auditor, treasury, companyId, runId, demoAuditorIds } = settings;
  const notify = (line: number, status: RowStatus) => {
    // A display callback that throws must not leave a submitted batch unobserved.
    try {
      input.onProgress?.({ row: line, status });
    } catch {
      /* ignored on purpose */
    }
  };

  // Paid flags, the run's counts and the treasury opening are all read after this, so a pay
  // that landed while nobody watched is already counted (threat model C13).
  await settleInFlight({ port, store: input.store, token, treasury });

  const company = await orRefuse(getCompany(port, payroll, companyId), PayrollErrorCode.CompanyNotFound, 'COMPANY_NOT_FOUND');
  if (!sameAccount(company.admin, treasury)) throw new PreflightError('NOT_ADMIN');
  if (demoAuditorIds.has(company.auditorId)) throw new PreflightError('DEMO_AUDITOR_ID');
  const run = await orRefuse(getRun(port, payroll, companyId, runId), PayrollErrorCode.RunNotFound, 'RUN_NOT_FOUND');
  if (run.status !== 'Open') throw new PreflightError('RUN_NOT_OPEN');

  const checked = await mapInOrder(rows, async (row) => ({
    row,
    paid: await isPaid(port, payroll, companyId, runId, row.address),
    status: await workerStatus(port, payroll, companyId, row.address),
    account: await confidentialBalance(port, token, row.address),
  }));
  const paidRows: CsvRow[] = [];
  const unpaid: { row: CsvRow; account: ConfidentialAccountView }[] = [];
  for (const { row, paid, status, account } of checked) {
    if (status !== 'Active') throw new PreflightError('WORKER_NOT_ACTIVE', row.line);
    if (account === null) throw new PreflightError('WORKER_NOT_REGISTERED', row.line);
    if (demoAuditorIds.has(account.auditorId)) throw new PreflightError('DEMO_AUDITOR_ID', row.line);
    if (paid) paidRows.push(row);
    else unpaid.push({ row, account });
  }
  if (run.expectedCount - run.paidCount < unpaid.length) throw new PreflightError('RUN_COUNT_EXCEEDED');

  const treasuryAccount = await confidentialBalance(port, token, treasury);
  if (treasuryAccount === null) throw new PreflightError('TREASURY_NOT_REGISTERED');
  if (!treasuryAccount.pvk.equals(keys.PVK)) throw new PreflightError('KEYS_MISMATCH');

  const kAudS = await getAuditorKey(port, auditor, company.auditorId);
  const auditorIds = [...new Set(unpaid.map(({ account }) => account.auditorId))];
  const auditorKeys = await mapInOrder(auditorIds, (id) => getAuditorKey(port, auditor, id));
  const payable: PayableRow[] = unpaid.map(({ row, account }) => ({
    ...row,
    pvk: account.pvk,
    kAudR: auditorKeys[auditorIds.indexOf(account.auditorId)] as Point,
  }));

  const pendingKeys = await loadAttempts({ port, store: input.store, token, treasury });
  const start = await loadTreasuryOpening({ port, store: input.store, token, treasury, pendingKeys });
  const startValue = (readSavedOpening(start) as Opening).v;
  if (payable.reduce((sum, row) => sum + row.amount, 0n) > startValue) throw new PreflightError('INSUFFICIENT_FUNDS');
  await input.store.put(treasuryOpeningKey(token, treasury), start);

  for (const row of paidRows) notify(row.line, 'already-paid');

  const ctx: RunContext = { input, port, store: input.store, payroll, token, treasury, auditor, companyAuditorId: company.auditorId, kAudS, notify };
  const landedIn = new Map<string, string>();
  const failedWhy = new Map<string, RowFailureReason>();
  const transactions: string[] = [];
  for (const batch of planRun(payable)) {
    const outcome = await payBatch(ctx, batch);
    if (outcome.kind === 'landed') {
      transactions.push(outcome.hash);
      for (const row of batch) landedIn.set(row.address, outcome.hash);
      continue;
    }
    for (const row of batch) failedWhy.set(row.address, outcome.reason);
    if (outcome.kind === 'stop') break;
  }

  const atEnd = await mapInOrder(rows, async (row) => ({ row, paid: await isPaid(port, payroll, companyId, runId, row.address) }));
  const paidBefore = new Set(paidRows);
  const report: RunReport = { rows: [], transactions };
  atEnd.forEach(({ row, paid }) => {
    if (paidBefore.has(row)) {
      report.rows.push({ line: row.line, address: row.address, status: 'already-paid' });
    } else if (paid) {
      const txHash = landedIn.get(row.address);
      report.rows.push(txHash === undefined ? { line: row.line, address: row.address, status: 'paid' } : { line: row.line, address: row.address, status: 'paid', txHash });
    } else {
      report.rows.push({ line: row.line, address: row.address, status: 'failed', reason: failedWhy.get(row.address) ?? 'RUN_STOPPED' });
      notify(row.line, 'failed');
    }
  });
  return report;
}

/**
 * Pays one batch in at most two attempts. The second is built with every key re-read from chain.
 * When that rebuild cannot be proved or simulated, only this batch fails (skip); when the network
 * refused it or it failed on chain, the run stops.
 */
async function payBatch(ctx: RunContext, batch: PayableRow[]): Promise<BatchOutcome> {
  const first = await attemptBatch(ctx, batch);
  if (first.kind === 'landed') return first;
  // Invariant: a run survives a key rotation. The rebuild uses the keys on chain now, and a batch that still cannot be built fails alone.
  const second = await attemptBatch(ctx, await rereadKeys(ctx, batch));
  if (second.kind === 'landed') return second;
  return { kind: second.kind === 'not-built' ? 'skip' : 'stop', reason: second.reason };
}

/**
 * Builds, sends and settles one attempt at a batch. Throws AmountMismatchError when a proof does
 * not move its row's CSV amount, and PAID_FLAGS_BEHIND when the pay is proved landed but a row
 * still reads unpaid; either stops the run.
 */
async function attemptBatch(ctx: RunContext, rows: PayableRow[]): Promise<Attempt> {
  const { input, port, store, payroll, token, treasury, notify } = ctx;
  const { signer, keys, networkPassphrase, companyId, runId } = input;
  // Nothing is proved while a pay from this treasury is in flight (threat model C13).
  await settleInFlight(ctx);

  // Every attempt starts from what opens the chain right now, so a retry never builds on a
  // failed attempt's balance (threat model C13, C16).
  const pendingKeys = await loadAttempts(ctx);
  let { v, r } = readSavedOpening(await loadTreasuryOpening({ port, store, token, treasury, pendingKeys })) as Opening;
  const items: PayItem[] = [];
  for (const row of rows) {
    notify(row.line, 'proving');
    let proved: TransferEnvelope;
    try {
      // No salt is passed, so the SDK draws a fresh one from crypto.getRandomValues on every
      // attempt (threat model C11).
      proved = await input.prover.proveTransfer({ keys, v, r, amount: row.amount, pvkB: row.pvk, kAudR: row.kAudR, kAudS: ctx.kAudS });
    } catch {
      return { kind: 'not-built', reason: 'PROOF_FAILED' };
    }
    if (proved.recipientView.vTx !== row.amount || proved.next.v !== v - row.amount) {
      throw new AmountMismatchError([row.line], 'proof');
    }
    items.push({ worker: row.address, data: proved.payload });
    ({ v, r } = proved.next);
  }

  const { sequence } = await port.sourceAccount(treasury);
  const unsigned = buildPay(
    { source: { address: treasury, sequence }, networkPassphrase, contractId: payroll, timeoutSeconds: DEFAULT_TX_TIMEOUT_SECONDS },
    { companyId, runId, items },
  );
  const sim = await port.simulate(unsigned);
  if (!sim.ok) return { kind: 'not-built', reason: 'SIMULATION_FAILED' };
  let assembled: string;
  try {
    // The simulation names the resource fee, so a lying RPC could otherwise name any fee up to the
    // XDR ceiling of about 429 XLM and the wallet would be asked to sign it (threat model C20).
    assembled = assembleFromSimulation(unsigned, sim, networkPassphrase, MAX_PAY_FEE_STROOPS);
  } catch (err) {
    if (err instanceof FeeCapError) return { kind: 'not-built', reason: 'FEE_TOO_HIGH' };
    throw err;
  }
  const hash = transactionHash(assembled, networkPassphrase);

  const signed = await signer.signTransaction(assembled, networkPassphrase);
  let signedHash: string | undefined;
  try {
    signedHash = transactionHash(signed, networkPassphrase);
  } catch {
    signedHash = undefined;
  }
  if (signedHash !== hash) throw new SignedTransactionMismatchError();

  const batchKey = batchOpeningKey({ payroll, companyId, runId, firstWorker: (rows[0] as PayableRow).address, txHash: hash });
  // Only this opening can ever spend what the batch leaves behind, so it is saved before the
  // transaction can land.
  await store.put(batchKey, toSavedOpening(v, r));
  // Listed before the transaction exists on the network, so whatever happens to this record the
  // opening stays a candidate until one opens the chain (threat model C29).
  await saveAttempts(store, token, treasury, [...(await loadAttempts(ctx)), batchKey]);
  const record: InFlightPay = { hash, maxTime: decodeInvocation(assembled, networkPassphrase).maxTime, batchKey };
  if (readInFlight(record) === undefined) throw new PaymentInFlightError('UNREADABLE');
  await store.put(inFlightKey(token, treasury), record);

  let refused = false;
  try {
    // The hash we wait on is the one we computed for what we signed, not the RPC's echo of it.
    await port.submit(signed);
    for (const row of rows) notify(row.line, 'submitted');
  } catch (err) {
    // A refusal and a lost reply are settled the same way: by the chain's final answer for this
    // hash, never by the error alone.
    refused = err instanceof SubmitRejectedError;
  }
  const settled = await settleRecord(ctx, record);

  const paidNow = await mapInOrder(rows, (row) => isPaid(port, payroll, companyId, runId, row.address));
  // This attempt's own opening on chain proves it landed whatever the status says. A newer opening
  // proves only that some pay landed, so it counts for this attempt only with SUCCESS.
  if (settled.adopted === 'own' || (settled.adopted === 'newer' && settled.status === 'SUCCESS')) {
    // The pay is proved landed, and the contract sets every paid flag in the same call, so a row
    // that reads unpaid here is a read behind the chain: stop, and the next run reads it again.
    if (!paidNow.every(Boolean)) throw new PaymentInFlightError('PAID_FLAGS_BEHIND');
    for (const row of rows) notify(row.line, 'paid');
    return { kind: 'landed', hash };
  }
  const paidByAnother = rows.filter((_, i) => paidNow[i] === true);
  if (paidByAnother.length > 0) throw new PaidElsewhereError(paidByAnother.map((row) => row.line));
  if (refused) return { kind: 'not-landed', reason: 'SUBMIT_REFUSED' };
  return { kind: 'not-landed', reason: settled.status === 'FAILED' ? 'TRANSACTION_FAILED' : 'TRANSACTION_EXPIRED' };
}

/** Reads again from chain every key a batch's proofs bind: each recipient's viewing and auditor keys, and the company's auditor key. */
async function rereadKeys(ctx: RunContext, rows: PayableRow[]): Promise<PayableRow[]> {
  const { port, auditor, token } = ctx;
  ctx.kAudS = await getAuditorKey(port, auditor, ctx.companyAuditorId);
  return mapInOrder(rows, async (row) => {
    const account = await confidentialBalance(port, token, row.address);
    // A token account cannot unregister. If it reads as missing, the old keys stay and the
    // simulation decides.
    if (account === null) return row;
    return { ...row, pvk: account.pvk, kAudR: await getAuditorKey(port, auditor, account.auditorId) };
  });
}

/**
 * Removes this device's record of the treasury's pay in flight, and nothing else. It is for the
 * console, behind a confirmation, when the record is damaged (PaymentInFlightError UNREADABLE) or
 * the person knows the pay is settled. No opening is touched: every batch opening this device
 * wrote stays a candidate through the attempts list, so the next run still starts from whichever
 * one opens the chain.
 *
 * @throws AddressError when token is not a C address or treasury is not a G or C address.
 */
export async function clearInFlight(store: OpeningStore, token: string, treasury: string): Promise<void> {
  await store.delete(inFlightKey(token, treasury));
}

/** The treasury's attempts list. A damaged one offers no candidate and is replaced on the next append. */
async function loadAttempts(at: TreasuryRef): Promise<string[]> {
  return readAttempts(await at.store.get(attemptsKey(at.token, at.treasury))) ?? [];
}

/**
 * Settles the treasury's pay in flight, if this device recorded one. Exported for
 * rebuildTreasuryOpening only, so a rebuild settles a record exactly as a run does.
 * @throws PaymentInFlightError UNREADABLE for a damaged record, PENDING when it is not final, or
 *   UNCONFIRMED or DOES_NOT_MATCH_CHAIN when the chain reports SUCCESS but no saved opening opens
 *   the balance (see settleRecord).
 */
export async function settleInFlight(at: TreasuryRef): Promise<void> {
  const saved = await at.store.get(inFlightKey(at.token, at.treasury));
  if (saved === undefined) return;
  const record = readInFlight(saved);
  if (record === undefined) throw new PaymentInFlightError('UNREADABLE');
  await settleRecord(at, record);
}

/** How a record settled: its final status, and whose opening, if any, now opens the chain. */
interface Settled {
  status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  /**
   * own: the record's batch opening. newer: a key listed after it. older: a key listed before it,
   * or in a list that no longer holds it, adopted only when the pay did not succeed. none: nothing.
   */
  adopted: 'own' | 'newer' | 'older' | 'none';
}

/**
 * Waits until the chain's answer for the record is final, then adopts as the treasury opening the
 * first candidate that opens the chain now: the record's batch opening, then each key listed after
 * it, then, only when the answer is not SUCCESS, each key listed before it. A SUCCESS means the
 * chain is past every earlier opening, so one of those opening the read means the read is behind,
 * never that it is the treasury's balance. Only then is the record removed, so a crash at any
 * point leaves something the next call can settle again (threat model C13, C29).
 *
 * The record is removed by compare: only while the stored record still has this hash. The store
 * has no atomic compare-and-delete, so two tabs can still race here and remove a newer record;
 * recovery from that race goes through the attempts list, which keeps every batch opening this
 * device wrote as a candidate until one opens the chain.
 *
 * A FAILED or NOT_FOUND answer never deletes an opening: both come from the RPC, which can lie.
 * Openings leave the store only when a later adoption passes them in the attempts list.
 *
 * @throws PaymentInFlightError PENDING when the answer is not final. When the chain reports
 *   SUCCESS but no candidate opens the balance it returns: UNCONFIRMED while the treasury opening
 *   from before the pay still opens it (the read is behind the pay) and pastUnconfirmedGrace is
 *   false, DOES_NOT_MATCH_CHAIN otherwise. The record stays in every case.
 */
async function settleRecord(at: TreasuryRef, record: InFlightPay): Promise<Settled> {
  const status = await finalStatus(at.port, record);
  const account = await confidentialBalance(at.port, at.token, at.treasury);
  const listed = await loadAttempts(at);
  const own = listed.indexOf(record.batchKey);
  const newer = own < 0 ? [] : listed.slice(own + 1);
  const older = listed.filter((key) => key !== record.batchKey && !newer.includes(key));
  const candidates = [record.batchKey, ...newer, ...(status === 'SUCCESS' ? [] : older)];
  let adoptedKey: string | undefined;
  if (account !== null) {
    for (const key of candidates) {
      const opening = readSavedOpening(await at.store.get(key));
      if (opening === undefined || !opening.commitment.equals(account.spendable)) continue;
      await at.store.put(treasuryOpeningKey(at.token, at.treasury), toSavedOpening(opening.v, opening.r));
      adoptedKey = key;
      break;
    }
  }
  if (adoptedKey === undefined && status === 'SUCCESS') {
    // A read that names no account shows no balance to compare, so it is treated as behind too.
    const before = readSavedOpening(await at.store.get(treasuryOpeningKey(at.token, at.treasury)));
    const behind = account === null || (before !== undefined && before.commitment.equals(account.spendable));
    throw new PaymentInFlightError(behind && !(await pastUnconfirmedGrace(at.port, record)) ? 'UNCONFIRMED' : 'DOES_NOT_MATCH_CHAIN');
  }

  const recordKey = inFlightKey(at.token, at.treasury);
  if (readInFlight(await at.store.get(recordKey))?.hash === record.hash) await at.store.delete(recordKey);
  if (adoptedKey !== undefined) await dropAttemptsBefore(at, adoptedKey);
  const adopted = adoptedKey === undefined ? 'none' : adoptedKey === record.batchKey ? 'own' : newer.includes(adoptedKey) ? 'newer' : 'older';
  return { status, adopted };
}

/**
 * Removes from the attempts list, and from the store, every batch opening listed before the one
 * just adopted. Each was appended before the adopted pay was built, so it was proved at or below
 * that pay's sequence on a balance the chain has since left, and it can never land after it. The
 * adopted key stays listed until a later adoption passes it, so a slow tab that writes an older
 * treasury opening over the adopted one cannot orphan it.
 */
async function dropAttemptsBefore(at: TreasuryRef, adoptedKey: string): Promise<void> {
  const attempts = await loadAttempts(at);
  const index = attempts.indexOf(adoptedKey);
  if (index <= 0) return;
  await saveAttempts(at.store, at.token, at.treasury, attempts.slice(index));
  for (const key of attempts.slice(0, index)) await at.store.delete(key);
}

/**
 * True once the chain's latest ledger (port.latestLedger) closed more than
 * UNCONFIRMED_GRACE_SECONDS after the record's maxTime, by the chain's own clock. A port that
 * cannot answer, or answers with a close time that is not a whole number, leaves the read
 * counted as behind (UNCONFIRMED), which offers no rebuild.
 */
async function pastUnconfirmedGrace(port: ChainPort, record: InFlightPay): Promise<boolean> {
  try {
    const { closeTime } = await port.latestLedger();
    return Number.isSafeInteger(closeTime) && closeTime > record.maxTime + UNCONFIRMED_GRACE_SECONDS;
  } catch {
    return false;
  }
}

/**
 * SUCCESS or FAILED as the network reports them, or NOT_FOUND only once a ledger closed more
 * than FINALITY_MARGIN_SECONDS after the record's maxTime, by the chain's own clock.
 * @throws PaymentInFlightError PENDING when the port gives no chain time, or the chain has not
 *   got there after MAX_LOOKS waits.
 */
async function finalStatus(port: ChainPort, record: InFlightPay): Promise<'SUCCESS' | 'FAILED' | 'NOT_FOUND'> {
  let waitMs = Math.max(0, record.maxTime * 1000 - Date.now()) + CLOCK_MARGIN_MS;
  for (let look = 0; look < MAX_LOOKS; look++) {
    const result = await port.waitFor(record.hash, Math.min(waitMs, MAX_WAIT_MS));
    if (result.status !== 'NOT_FOUND') return result.status;
    if (typeof result.closeTime !== 'number' || !Number.isFinite(result.closeTime)) break;
    const shortBySeconds = record.maxTime + FINALITY_MARGIN_SECONDS - result.closeTime;
    if (shortBySeconds < 0) return 'NOT_FOUND';
    waitMs = shortBySeconds * 1000 + LEDGER_GAP_MS;
  }
  throw new PaymentInFlightError('PENDING');
}

import type { Point } from 'stellar-confidential-token-sdk';
import { MAX_STROOPS } from '../amounts.js';
import { parseAccount, sameAccount } from '../addresses.js';
import { CSV_DEFAULT_MAX_ROWS, type CsvRow } from '../csv.js';
import type { KalypsoKeys } from '../keys.js';
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
import { SubmitRejectedError, type ChainPort, type OpeningStore, type SignerPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import { confidentialBalance, getAuditorKey, type ConfidentialAccountView } from '../chain/token.js';
import { DEFAULT_TX_TIMEOUT_SECONDS, assembleFromSimulation, decodeInvocation, transactionHash } from '../chain/tx.js';
import type { ProverPort } from '../prover/port.js';
import { planRun } from './plan.js';
import { batchOpeningKey, loadTreasuryOpening, readSavedOpening, toSavedOpening, treasuryOpeningKey } from './treasury.js';

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
}

export type RowStatus = 'already-paid' | 'proving' | 'submitted' | 'paid' | 'failed';

/**
 * rows are in CSV order and their status is read from the on-chain paid check after the run.
 * transactions lists the pay transactions that landed during this call, in order.
 */
export interface RunReport {
  rows: { line: number; address: string; status: 'paid' | 'already-paid' | 'failed'; txHash?: string }[];
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
  | 'INSUFFICIENT_FUNDS';

// Messages name lines, never amounts or balances (threat model C12).
const PREFLIGHT_MESSAGES: Record<PreflightErrorCode, string> = {
  INVALID_INPUT: 'The run settings are invalid: a contract id, the signer address, the company id, the run id or the prover.',
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

const READ_CONCURRENCY = 8;
// Validity windows are judged by ledger close times, which can sit a little apart from this
// machine's clock. Waiting this much past the window makes NOT_FOUND mean "can never land".
const CLOCK_MARGIN_MS = 30_000;

interface PayableRow extends CsvRow {
  pvk: Point;
  kAudR: Point;
}

interface RunContext {
  input: RunInput;
  payroll: string;
  token: string;
  treasury: string;
  kAudS: Point;
  notify: (line: number, status: RowStatus) => void;
}

/** Runs fn over items, at most READ_CONCURRENCY at a time, keeping results in item order. */
async function mapInOrder<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return results;
}

function checkSettings(input: RunInput) {
  if (typeof input.prover?.proveTransfer !== 'function') throw new PreflightError('INVALID_INPUT');
  try {
    return {
      payroll: requireAccount(input.contracts.payroll, ['C']),
      token: requireAccount(input.contracts.token, ['C']),
      auditor: requireAccount(input.contracts.auditor, ['C']),
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
 * 1. Preflight, before any transaction. The company exists and its admin is the signer; the run
 *    exists, is open and has room for every unpaid row; every row's worker is active in this
 *    company and registered with the token; the keys belong to the treasury; the treasury's
 *    verified balance covers the unpaid rows. Viewing keys and both auditor keys are read
 *    from chain. Any failure refuses the whole run and sends nothing.
 * 2. Rows already paid on chain are reported as already-paid and skipped, which is how a
 *    crashed run resumes.
 * 3. Batches run strictly one after another. Each starts from the treasury opening verified
 *    against chain, proves each transfer on the previous one's result, checks every proof
 *    moves exactly its row's CSV amount, saves the batch's resulting opening, then simulates,
 *    signs, submits and waits.
 * 4. A batch that fails, is refused, or is not seen once its validity window has closed is
 *    checked on chain. If its rows are paid and the chain balance is the saved result, it
 *    landed. Otherwise it is proved again from chain state with fresh salts and sent once more.
 *    A batch that fails twice stops the run; its rows and every later row report failed.
 * 5. After each landed batch the chain's treasury commitment must open with the saved result,
 *    which is the starting balance minus exactly the CSV amounts of the batch.
 * 6. Report statuses are read from the on-chain paid check, never from a submit reply.
 *
 * @throws PreflightError, HistoryIncompleteError (the saved treasury balance does not match
 *   chain), AmountMismatchError (the run stops), SignedTransactionMismatchError, or any error
 *   from the port or the signer. After an error, calling executeRun again with the same store
 *   resumes without paying anyone twice.
 */
export async function executeRun(input: RunInput): Promise<RunReport> {
  const settings = checkSettings(input);
  const rows = checkRows(input.rows);
  const { port, keys } = input;
  const { payroll, token, auditor, treasury, companyId, runId } = settings;
  const notify = (line: number, status: RowStatus) => {
    // A display callback that throws must not leave a submitted batch unobserved.
    try {
      input.onProgress?.({ row: line, status });
    } catch {
      /* ignored on purpose */
    }
  };

  const company = await orRefuse(getCompany(port, payroll, companyId), PayrollErrorCode.CompanyNotFound, 'COMPANY_NOT_FOUND');
  if (!sameAccount(company.admin, treasury)) throw new PreflightError('NOT_ADMIN');
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

  // A batch may have landed just before a crash without the treasury record moving on. Its
  // first row is paid now, so the openings saved under paid rows are the candidates.
  const pendingKeys = paidRows.map((row) => batchOpeningKey({ payroll, companyId, runId, firstWorker: row.address }));
  const start = await loadTreasuryOpening({ port, store: input.store, token, treasury, pendingKeys });
  const startValue = (readSavedOpening(start) as { v: bigint }).v;
  if (payable.reduce((sum, row) => sum + row.amount, 0n) > startValue) throw new PreflightError('INSUFFICIENT_FUNDS');
  await input.store.put(treasuryOpeningKey(token, treasury), start);

  for (const row of paidRows) notify(row.line, 'already-paid');

  const ctx: RunContext = { input, payroll, token, treasury, kAudS, notify };
  const landedIn = new Map<string, string>();
  const transactions: string[] = [];
  for (const batch of planRun(payable)) {
    const hash = await payBatch(ctx, batch);
    if (hash === undefined) break;
    transactions.push(hash);
    for (const row of batch) landedIn.set(row.address, hash);
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
      report.rows.push({ line: row.line, address: row.address, status: 'failed' });
      notify(row.line, 'failed');
    }
  });
  return report;
}

/** Returns the hash of the landed transaction, or undefined when the batch failed twice. */
async function payBatch(ctx: RunContext, batch: PayableRow[]): Promise<string | undefined> {
  const { input, payroll, token, treasury, kAudS, notify } = ctx;
  const { port, store, keys, companyId, runId } = input;
  const lines = batch.map((row) => row.line);
  const batchKey = batchOpeningKey({ payroll, companyId, runId, firstWorker: (batch[0] as PayableRow).address });

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Every attempt starts from what opens the chain right now, so a retry never builds on a
    // failed attempt's balance (threat model C13, C16).
    const start = readSavedOpening(await loadTreasuryOpening({ port, store, token, treasury })) as { v: bigint; r: bigint };
    let { v, r } = start;
    const items: PayItem[] = [];
    for (const row of batch) {
      notify(row.line, 'proving');
      // No salt is passed, so the SDK draws a fresh one from crypto.getRandomValues on every
      // attempt (threat model C11).
      const proved = await input.prover.proveTransfer({ keys, v, r, amount: row.amount, pvkB: row.pvk, kAudR: row.kAudR, kAudS });
      if (proved.recipientView.vTx !== row.amount || proved.next.v !== v - row.amount) {
        throw new AmountMismatchError([row.line], 'proof');
      }
      items.push({ worker: row.address, data: proved.payload });
      ({ v, r } = proved.next);
    }
    const next = toSavedOpening(v, r);
    // Only this opening can ever spend what the batch leaves behind, so it is saved before the
    // transaction can land.
    await store.put(batchKey, next);

    const sent = await sendBatch(ctx, batch, items);

    const paidNow = await mapInOrder(batch, (row) => isPaid(port, payroll, companyId, runId, row.address));
    const account = await confidentialBalance(port, token, treasury);
    const opensNext = account !== null && (readSavedOpening(next) as { commitment: Point }).commitment.equals(account.spendable);
    if (paidNow.every(Boolean) && opensNext && sent.hash !== undefined) {
      await store.put(treasuryOpeningKey(token, treasury), next);
      for (const row of batch) notify(row.line, 'paid');
      return sent.hash;
    }
    if (sent.status === 'SUCCESS' || paidNow.some(Boolean)) throw new AmountMismatchError(lines, 'chain');
  }
  return undefined;
}

/** Simulates, signs, submits and waits. NOT_SENT means the transaction never reached the network. */
async function sendBatch(
  ctx: RunContext,
  batch: PayableRow[],
  items: PayItem[],
): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'NOT_SENT'; hash?: string }> {
  const { input, payroll, treasury, notify } = ctx;
  const { port, signer, networkPassphrase, companyId, runId } = input;
  const { sequence } = await port.sourceAccount(treasury);
  const unsigned = buildPay(
    { source: { address: treasury, sequence }, networkPassphrase, contractId: payroll, timeoutSeconds: DEFAULT_TX_TIMEOUT_SECONDS },
    { companyId, runId, items },
  );
  const sim = await port.simulate(unsigned);
  if (!sim.ok) return { status: 'NOT_SENT' };
  const assembled = assembleFromSimulation(unsigned, sim, networkPassphrase);
  const hash = transactionHash(assembled, networkPassphrase);

  const signed = await signer.signTransaction(assembled, networkPassphrase);
  let signedHash: string | undefined;
  try {
    signedHash = transactionHash(signed, networkPassphrase);
  } catch {
    signedHash = undefined;
  }
  if (signedHash !== hash) throw new SignedTransactionMismatchError();

  try {
    // The hash we wait on is the one we computed for what we signed, not the RPC's echo of it.
    await port.submit(signed);
  } catch (err) {
    if (err instanceof SubmitRejectedError) return { status: 'NOT_SENT' };
    throw err;
  }
  for (const row of batch) notify(row.line, 'submitted');

  const maxTimeMs = decodeInvocation(assembled, networkPassphrase).maxTime * 1000;
  const result = await port.waitFor(hash, Math.max(0, maxTimeMs - Date.now()) + CLOCK_MARGIN_MS);
  return { status: result.status, hash };
}

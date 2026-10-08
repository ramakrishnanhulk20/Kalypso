import { StateEngine, commit, pointToBytes } from 'stellar-confidential-token-sdk';
import { workerStatus } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import { confidentialBalance, type ConfidentialAccountView } from '../chain/token.js';
import { fetchAccountHistory, reachesLedger, type HistoryResult, type HistorySource } from '../history/events.js';
import { bindTransferToTransaction, oncePerHash, type TxSourcePort } from '../history/tx-binding.js';
import type { KalypsoKeys } from '../keys.js';
import type { Opening } from '../run/treasury.js';
import { bindsAsPayslip, chainChecks, isMoney, readCompanyPayslips, transferInTx } from './company.js';

/** One payment a worker can show as pay: it passed every C18 check and is bound to its transaction. */
export interface Payslip {
  companyId: bigint;
  runId: bigint;
  periodLabel: string;
  amount: bigint;
  txHash: string;
  ledger: number;
}

/**
 * What a worker sees.
 *
 * complete is false when any history was incomplete or unreadable, a payslip could not be
 * matched to its transfer or bound to its transaction, or the rebuilt balance did not open the
 * on-chain commitment. spendable and receiving are given only when the balance itself opened the
 * chain (C16). payslips may be listed while complete is false: each one listed passed every
 * check, including the binding, but the list may be missing some, so the UI must say history is
 * incomplete and never present the list as the full record.
 */
export interface WorkerView {
  complete: boolean;
  spendable?: bigint;
  receiving?: bigint;
  payslips: Payslip[];
}

/** The worker's balance, rebuilt from history. Openings are only present when complete. */
export interface WorkerBalance {
  complete: boolean;
  spendable?: Opening;
  receiving?: Opening;
  history: HistoryResult;
  account: ConfidentialAccountView;
}

export type WorkerViewErrorCode = 'INVALID_INPUT' | 'NOT_REGISTERED' | 'KEYS_MISMATCH';

// Messages never carry an amount, a balance or a key (threat model C12).
const WORKER_MESSAGES: Record<WorkerViewErrorCode, string> = {
  INVALID_INPUT: 'The worker view settings are invalid: a contract id, the worker address, a company id or the keys.',
  NOT_REGISTERED: 'This worker has not registered with the confidential token yet.',
  KEYS_MISMATCH: 'These private keys do not belong to this worker. Sign in again with the worker wallet.',
};

export class WorkerViewError extends Error {
  readonly code: WorkerViewErrorCode;

  constructor(code: WorkerViewErrorCode) {
    super(WORKER_MESSAGES[code]);
    this.name = 'WorkerViewError';
    this.code = code;
  }
}

/** A worker belongs to a handful of companies; the cap bounds the reads one view makes. */
export const MAX_WORKER_COMPANIES = 50;

interface BalanceInput {
  port: ChainPort;
  history: HistorySource;
  contracts: { payroll: string; token: string };
  worker: string;
  keys: KalypsoKeys;
}

function checkContracts(contracts: { payroll: string; token: string }) {
  return { payroll: requireAccount(contracts.payroll, ['C']), token: requireAccount(contracts.token, ['C']) };
}

/**
 * Rebuilds the worker's spendable and receiving balances from the token history with the SDK's
 * StateEngine, then checks both against confidential_balance on chain (threat model C16). The
 * openings are returned only when the history is complete, reaches to within
 * INGEST_TOLERANCE_LEDGERS of the RPC's newest ledger as read after the balance, every event in
 * it could be read, both commitments open, and both values are money. A withdraw is proved only
 * from these.
 *
 * @throws WorkerViewError NOT_REGISTERED, KEYS_MISMATCH (the keys' viewing key is not the one on
 *   chain), INVALID_INPUT; or the port's or history's own errors.
 */
export async function loadWorkerBalance(input: BalanceInput): Promise<WorkerBalance> {
  let worker: string;
  let contracts: { payroll: string; token: string };
  try {
    worker = requireAccount(input.worker, ['G', 'C']);
    contracts = checkContracts(input.contracts);
  } catch {
    throw new WorkerViewError('INVALID_INPUT');
  }
  if (typeof input.keys?.PVK?.equals !== 'function') throw new WorkerViewError('INVALID_INPUT');
  const { port, history: source, keys } = input;
  const history = await fetchAccountHistory({
    port: source.rpc,
    ...(source.archive ? { archive: source.archive } : {}),
    contracts,
    account: worker,
    fromLedger: source.fromLedger,
  });
  const account = await confidentialBalance(port, contracts.token, worker);
  if (account === null) throw new WorkerViewError('NOT_REGISTERED');
  if (!account.pvk.equals(keys.PVK)) throw new WorkerViewError('KEYS_MISMATCH');
  const { latestLedger } = await source.rpc.ledgerWindow();

  const engine = new StateEngine({ address: worker, keys });
  engine.ingestEvents(history.events.flatMap((e) => (e.kind === 'token' ? [e.event] : [])));
  const check = engine.verifyAgainstChain({ spendableC: pointToBytes(account.spendable), receivingC: pointToBytes(account.receiving) });
  const spendable = engine.spendable();
  const receiving = engine.receiving();
  const complete =
    history.complete &&
    reachesLedger(history.ingestedThrough, latestLedger) &&
    !history.events.some((e) => e.kind === 'undecodable') &&
    check.ok &&
    isMoney(spendable.v) &&
    isMoney(receiving.v);
  if (!complete) return { complete: false, history, account };
  return {
    complete: true,
    spendable: { ...spendable, commitment: commit(spendable.v, spendable.r) },
    receiving: { ...receiving, commitment: commit(receiving.v, receiving.r) },
    history,
    account,
  };
}

/**
 * A worker's own payslips and verified balances.
 *
 * A payslip is listed only when every one of these holds (threat model C18, C19): a
 * PayslipIssued event from our payroll contract for this worker, in a company the worker is or
 * was a member of on chain; exactly one transfer event from our token in the same transaction,
 * from the account that was the company's treasury at that moment, to this worker; is_paid on
 * chain for (company, run, worker); the transfer bound to its transaction by
 * bindTransferToTransaction, which must be our payroll's pay for that company and run; the
 * amount, decrypted with the worker's own keys, in [0, 2^63); and that amount and its blinding
 * opening the transaction's c_transfer. Direct transfers and deposits have no payslip event and
 * bind as no pay call, so they never become payslips.
 *
 * Balances are given only when loadWorkerBalance says complete (C16). A candidate payslip that
 * fails a check because history is missing, unreadable or unbound makes the view incomplete and
 * is never shown; one the chain says was not paid is simply not a payslip. A company history
 * that ends more than INGEST_TOLERANCE_LEDGERS before the RPC's newest ledger, read after every
 * chain read, makes the view incomplete too (C17).
 *
 * @param companyIds the companies whose invites the worker accepted, as the app recorded them.
 *   Each is confirmed with worker_status first, and a company the worker never joined is ignored.
 * @param txSource where each payslip's transaction envelope is read from (createTxSourcePort).
 * @throws WorkerViewError, or the port's or history's own errors.
 */
export async function loadWorkerView(input: BalanceInput & { companyIds: bigint[]; txSource: TxSourcePort }): Promise<WorkerView> {
  if (!Array.isArray(input.companyIds) || input.companyIds.length > MAX_WORKER_COMPANIES) throw new WorkerViewError('INVALID_INPUT');
  if (typeof input.txSource?.transaction !== 'function') throw new WorkerViewError('INVALID_INPUT');
  let companyIds: bigint[];
  try {
    companyIds = [...new Set(input.companyIds.map((id) => requireU64(id, 'companyId')))];
  } catch {
    throw new WorkerViewError('INVALID_INPUT');
  }
  const balance = await loadWorkerBalance(input);
  const worker = requireAccount(input.worker, ['G', 'C']);
  const contracts = checkContracts(input.contracts);
  const { port, history } = input;
  const checks = chainChecks(port, contracts.payroll);
  const txSource = oncePerHash(input.txSource);
  const engine = new StateEngine({ address: worker, keys: input.keys });
  let complete = balance.complete;
  const payslips: Payslip[] = [];
  const companyHistoryEnds: number[] = [];

  for (const companyId of companyIds) {
    if ((await workerStatus(port, contracts.payroll, companyId, worker)) === null) continue;
    const company = await readCompanyPayslips({ port, history, contracts, companyId, worker });
    complete &&= company.complete;
    companyHistoryEnds.push(company.ingestedThrough);
    for (const candidate of company.candidates) {
      const found = transferInTx(balance.history.events, candidate.meta.txHash, candidate.treasury, worker);
      if ('problem' in found) {
        complete = false;
        continue;
      }
      if (!(await checks.isPaid(companyId, candidate.runId, worker))) continue;
      const transfer = found.transfer.event;
      const binding = await bindTransferToTransaction({ txSource, txHash: candidate.meta.txHash, event: transfer, contracts });
      if (!bindsAsPayslip(binding, candidate)) {
        complete = false;
        continue;
      }
      const { vTx: amount, rTx } = engine.decryptIncoming(transfer.rE, transfer.vTilde, transfer.sigma);
      const periodLabel = await checks.periodLabel(companyId, candidate.runId);
      // Only the recipient can make this check: what its keys decrypt must open the commitment the
      // transaction moved, so a payload the circuit did not tie to this worker never shows a number.
      if (!isMoney(amount) || !commit(amount, rTx).equals(binding.payload.cTransfer) || periodLabel === null) {
        complete = false;
        continue;
      }
      payslips.push({ companyId, runId: candidate.runId, periodLabel, amount, txHash: candidate.meta.txHash, ledger: candidate.meta.ledger });
    }
  }

  const { latestLedger } = await history.rpc.ledgerWindow();
  if (!companyHistoryEnds.every((through) => reachesLedger(through, latestLedger))) complete = false;
  payslips.sort((a, b) => a.ledger - b.ledger);
  if (!balance.complete || balance.spendable === undefined || balance.receiving === undefined) return { complete: false, payslips };
  return { complete, spendable: balance.spendable.v, receiving: balance.receiving.v, payslips };
}

import { StateEngine, commit, pointToBytes } from 'stellar-confidential-token-sdk';
import { workerStatus } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import { confidentialBalance, type ConfidentialAccountView } from '../chain/token.js';
import { fetchAccountHistory, type HistoryResult, type HistorySource } from '../history/events.js';
import type { KalypsoKeys } from '../keys.js';
import type { Opening } from '../run/treasury.js';
import { chainChecks, isMoney, readCompanyPayslips, transferInTx } from './company.js';

/** One payment a worker can show as pay: it passed every C18 check. */
export interface Payslip {
  companyId: bigint;
  runId: bigint;
  periodLabel: string;
  amount: bigint;
  txHash: string;
  ledger: number;
}

/**
 * What a worker sees. complete is false when any history was incomplete or unreadable, or the
 * rebuilt balance did not open the on-chain commitment; then no balance is given at all.
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
 * openings are returned only when the history is complete, every event in it could be read,
 * both commitments open, and both values are money. A withdraw is proved only from these.
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

  const engine = new StateEngine({ address: worker, keys });
  engine.ingestEvents(history.events.flatMap((e) => (e.kind === 'token' ? [e.event] : [])));
  const check = engine.verifyAgainstChain({ spendableC: pointToBytes(account.spendable), receivingC: pointToBytes(account.receiving) });
  const spendable = engine.spendable();
  const receiving = engine.receiving();
  const complete =
    history.complete && !history.events.some((e) => e.kind === 'undecodable') && check.ok && isMoney(spendable.v) && isMoney(receiving.v);
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
 * A payslip is listed only when every one of these holds (threat model C18): a PayslipIssued
 * event from our payroll contract for this worker, in a company the worker is or was a member
 * of on chain; exactly one transfer event from our token in the same transaction, from the
 * account that was the company's treasury at that moment, to this worker; is_paid on chain for
 * (company, run, worker); and the amount, decrypted with the worker's own keys, in [0, 2^63).
 * Direct transfers and deposits have no payslip event, so they never become payslips.
 *
 * Balances are given only when loadWorkerBalance says complete (C16). A candidate payslip that
 * fails a check because history is missing or unreadable makes the view incomplete; one the
 * chain says was not paid is simply not a payslip.
 *
 * @param companyIds the companies whose invites the worker accepted, as the app recorded them.
 *   Each is confirmed with worker_status first, and a company the worker never joined is ignored.
 * @throws WorkerViewError, or the port's or history's own errors.
 */
export async function loadWorkerView(input: BalanceInput & { companyIds: bigint[] }): Promise<WorkerView> {
  if (!Array.isArray(input.companyIds) || input.companyIds.length > MAX_WORKER_COMPANIES) throw new WorkerViewError('INVALID_INPUT');
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
  const engine = new StateEngine({ address: worker, keys: input.keys });
  let complete = balance.complete;
  const payslips: Payslip[] = [];

  for (const companyId of companyIds) {
    if ((await workerStatus(port, contracts.payroll, companyId, worker)) === null) continue;
    const company = await readCompanyPayslips({ port, history, contracts, companyId, worker });
    complete &&= company.complete;
    for (const candidate of company.candidates) {
      const found = transferInTx(balance.history.events, candidate.meta.txHash, candidate.treasury, worker);
      if ('problem' in found) {
        complete = false;
        continue;
      }
      if (!(await checks.isPaid(companyId, candidate.runId, worker))) continue;
      const { rE, vTilde, sigma } = found.transfer.event;
      const amount = engine.decryptIncoming(rE, vTilde, sigma).vTx;
      const periodLabel = await checks.periodLabel(companyId, candidate.runId);
      if (!isMoney(amount) || periodLabel === null) {
        complete = false;
        continue;
      }
      payslips.push({ companyId, runId: candidate.runId, periodLabel, amount, txHash: candidate.meta.txHash, ledger: candidate.meta.ledger });
    }
  }

  payslips.sort((a, b) => a.ledger - b.ledger);
  if (!balance.complete || balance.spendable === undefined || balance.receiving === undefined) return { complete: false, payslips };
  return { complete, spendable: balance.spendable.v, receiving: balance.receiving.v, payslips };
}

import { StateEngine, commit, pointToBytes } from 'stellar-confidential-token-sdk';
import { PayrollErrorCode, getCompany, getMembershipsOf, isPayrollError, type Company } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import { confidentialBalance, type ConfidentialAccountView } from '../chain/token.js';
import type { HistoryEvent } from '../history/decode.js';
import { fetchAccountHistory, reachesLedger, type HistoryResult, type HistorySource } from '../history/events.js';
import { bindTransferToTransaction, oncePerHash, type TxSourcePort } from '../history/tx-binding.js';
import type { KalypsoKeys } from '../keys.js';
import { mapInOrder } from '../map-in-order.js';
import type { Opening } from '../run/treasury.js';
import {
  bindsAsPayslip,
  chainChecks,
  confirmRuns,
  isMoney,
  isOnRoster,
  readCompanyPayslips,
  transferInTx,
  type HistoryGap,
  type PayslipCandidate,
} from './company.js';

/** One payment a worker can show as pay: it passed every C18 check and is bound to its transaction. */
export interface Payslip {
  companyId: bigint;
  runId: bigint;
  periodLabel: string;
  amount: bigint;
  txHash: string;
  /** The ledger the transaction source recorded for txHash, never the one history gave. */
  ledger: number;
}

/**
 * What a worker sees.
 *
 * complete is false when gaps names anything, and also when any history was incomplete or
 * unreadable, or the rebuilt balance did not open the on-chain commitment. spendable and
 * receiving are given only when the balance itself opened the chain (C16). payslips may be
 * listed while complete is false: each one listed passed every check, including the binding, but
 * the list may be missing some, so the UI must say history is incomplete and never present the
 * list as the full record.
 */
export interface WorkerView {
  complete: boolean;
  spendable?: bigint;
  receiving?: bigint;
  payslips: Payslip[];
  /** Each place the chain's own counts disagree with history (C48), such as a run the chain paid with no payslip shown. */
  gaps: HistoryGap[];
  /**
   * The companies the view counted as joined: those among companyIds that exist and have this
   * worker on their roster on chain, in the order given. Read from the chain, never from history,
   * so a caller may keep exactly these as the worker's companies.
   */
  confirmedCompanyIds: bigint[];
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

export interface AccountBalanceInput {
  port: ChainPort;
  history: HistorySource;
  contracts: { payroll: string; token: string };
  account: string;
  keys: KalypsoKeys;
}

function checkContracts(contracts: { payroll: string; token: string }) {
  return { payroll: requireAccount(contracts.payroll, ['C']), token: requireAccount(contracts.token, ['C']) };
}

/**
 * Rebuilds any token account's spendable and receiving balances from its token history with the
 * SDK's StateEngine, then checks both against confidential_balance on chain (threat model C16).
 * The openings are returned only when the history is complete, reaches to within
 * INGEST_TOLERANCE_LEDGERS of the RPC's newest ledger as read after the balance, every event in
 * it could be read, both commitments open, and both values are money. A withdraw or a pay is
 * proved only from these.
 *
 * @param input.account the G or C address whose balance is rebuilt; input.keys must be its keys.
 * @throws WorkerViewError NOT_REGISTERED, KEYS_MISMATCH (the keys' viewing key is not the one on
 *   chain), INVALID_INPUT; or the port's or history's own errors. The codes name a worker because
 *   workers call this through loadWorkerBalance; rebuildTreasuryOpening turns them into treasury errors.
 */
export async function loadAccountBalance(input: AccountBalanceInput): Promise<WorkerBalance> {
  let address: string;
  let contracts: { payroll: string; token: string };
  try {
    address = requireAccount(input.account, ['G', 'C']);
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
    account: address,
    fromLedger: source.fromLedger,
  });
  const account = await confidentialBalance(port, contracts.token, address);
  if (account === null) throw new WorkerViewError('NOT_REGISTERED');
  if (!account.pvk.equals(keys.PVK)) throw new WorkerViewError('KEYS_MISMATCH');
  const { latestLedger } = await source.rpc.ledgerWindow();

  const engine = new StateEngine({ address, keys });
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
 * The worker's balance, rebuilt and checked against chain exactly as loadAccountBalance does it.
 *
 * @throws WorkerViewError NOT_REGISTERED, KEYS_MISMATCH (the keys' viewing key is not the one on
 *   chain), INVALID_INPUT; or the port's or history's own errors.
 */
export async function loadWorkerBalance(input: BalanceInput): Promise<WorkerBalance> {
  // Optional chaining keeps a missing input an INVALID_INPUT refusal, as it was before the split.
  return loadAccountBalance({ port: input?.port, history: input?.history, contracts: input?.contracts, account: input?.worker, keys: input?.keys });
}

/**
 * A worker's own payslips and verified balances.
 *
 * The list is enumerated from the chain, never from history alone (threat model C48). The
 * companies are those in companyIds with this worker on their roster on chain (isOnRoster), and
 * there must be exactly as many as memberships_of says the worker ever joined. For each, every
 * run the company history shows opened is confirmed with get_run, and they must number exactly
 * runs_opened (confirmRuns). For every such run where is_paid is true for this worker, a payslip
 * must be listed. A transfer into the worker that is not one of these pays never touches the
 * result, whoever sent it and however old it is.
 *
 * A payslip is listed only when every one of these holds (threat model C18, C19, C30): a
 * PayslipIssued event from our payroll contract for this worker in that run; exactly one
 * transfer event from our token in the same transaction, from the account that was the
 * company's treasury at that moment, to this worker; the transfer bound to its transaction by
 * bindTransferToTransaction, which must be our payroll's pay for that company and run; the
 * amount, decrypted with the worker's own keys, in [0, 2^63); and that amount and its blinding
 * opening the transaction's c_transfer. It shows the ledger its transaction source recorded;
 * when history dated it otherwise, the view is incomplete with a ledger_mismatch.
 *
 * Balances are given only when loadWorkerBalance says complete (C16). A company history that
 * ends more than INGEST_TOLERANCE_LEDGERS before the RPC's newest ledger, read after every chain
 * read, makes the view incomplete too (C17).
 *
 * @param companyIds the companies to look in, as the app recorded or discovered them. Each is
 *   checked against the company's roster on chain; one the worker never joined, or that does not
 *   exist, is ignored and left out of confirmedCompanyIds. One the list leaves out shows as a
 *   company_count_mismatch.
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
  const gaps: HistoryGap[] = [];
  const companyHistoryEnds: number[] = [];

  /** The payslip for one paid run, or null when no candidate passes every check, with a ledger_mismatch gap when its dates disagree. */
  const checkedPayslip = async (candidate: PayslipCandidate, events: HistoryEvent[]): Promise<{ payslip: Payslip | null; gap?: HistoryGap }> => {
    const found = transferInTx(events, candidate.meta.txHash, candidate.treasury, worker);
    if ('problem' in found) return { payslip: null };
    const transfer = found.transfer.event;
    const binding = await bindTransferToTransaction({ txSource, txHash: candidate.meta.txHash, event: transfer, contracts });
    if (!bindsAsPayslip(binding, candidate)) return { payslip: null };
    const { vTx: amount, rTx } = engine.decryptIncoming(transfer.rE, transfer.vTilde, transfer.sigma);
    const periodLabel = await checks.periodLabel(candidate.companyId, candidate.runId);
    // Only the recipient can make this check: what its keys decrypt must open the commitment the
    // transaction moved, so a payload the circuit did not tie to this worker never shows a number.
    if (!isMoney(amount) || !commit(amount, rTx).equals(binding.payload.cTransfer) || periodLabel === null) return { payslip: null };
    const payslip = { companyId: candidate.companyId, runId: candidate.runId, periodLabel, amount, txHash: candidate.meta.txHash, ledger: binding.ledger };
    // The archive's ledger is only its word; the payslip is dated by the transaction source.
    if (candidate.meta.ledger !== binding.ledger || found.transfer.ledger !== binding.ledger) {
      return { payslip, gap: { reason: 'ledger_mismatch', companyId: candidate.companyId, runId: candidate.runId } };
    }
    return { payslip };
  };

  // Each step reads READ_CONCURRENCY at a time and is never nested in another, so that also bounds
  // the reads in flight; results are put back together in companyIds and run order.
  const memberships = await getMembershipsOf(port, contracts.payroll, worker);
  const joinedCompanies = (
    await mapInOrder(companyIds, async (companyId) => {
      let onChain: Company;
      try {
        onChain = await getCompany(port, contracts.payroll, companyId);
      } catch (err) {
        if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) return null;
        throw err;
      }
      if (!(await isOnRoster(port, contracts.payroll, companyId, worker, onChain.rosterLen))) return null;
      return { companyId, company: await readCompanyPayslips({ port, history, contracts, companyId, worker, company: onChain }) };
    })
  ).filter((joined) => joined !== null);
  const confirmed: Awaited<ReturnType<typeof confirmRuns>>[] = [];
  for (const { companyId, company } of joinedCompanies) confirmed.push(await confirmRuns(checks, { ...company, companyId }));

  const runsToCheck = joinedCompanies.flatMap(({ companyId, company }, i) =>
    [...(confirmed[i] as Awaited<ReturnType<typeof confirmRuns>>).runs.keys()].map((runId) => ({ companyId, runId, company })),
  );
  const paid = await mapInOrder(runsToCheck, ({ companyId, runId }) => checks.isPaid(companyId, runId, worker));
  const paidRuns = runsToCheck.filter((_, i) => paid[i] === true);
  const checked = await mapInOrder(paidRuns, async ({ runId, company }) => {
    const candidate = company.candidates.find((c) => c.runId === runId);
    return candidate === undefined ? { payslip: null } : checkedPayslip(candidate, balance.history.events);
  });

  joinedCompanies.forEach(({ companyId, company }, i) => {
    complete &&= company.complete;
    companyHistoryEnds.push(company.ingestedThrough);
    gaps.push(...company.gaps, ...(confirmed[i] as Awaited<ReturnType<typeof confirmRuns>>).gaps);
    paidRuns.forEach((run, j) => {
      if (run.companyId !== companyId) return;
      const { payslip, gap } = checked[j] as Awaited<ReturnType<typeof checkedPayslip>>;
      if (gap !== undefined) gaps.push(gap);
      if (payslip === null) gaps.push({ reason: 'payslip_missing', companyId, runId: run.runId });
      else payslips.push(payslip);
    });
  });
  const joined = joinedCompanies.length;
  if (joined !== memberships) gaps.push({ reason: 'company_count_mismatch', expected: memberships, found: joined });
  const confirmedCompanyIds = joinedCompanies.map(({ companyId }) => companyId);

  const { latestLedger } = await history.rpc.ledgerWindow();
  if (!companyHistoryEnds.every((through) => reachesLedger(through, latestLedger))) complete = false;
  if (gaps.length > 0) complete = false;
  payslips.sort((a, b) => a.ledger - b.ledger);
  if (!balance.complete || balance.spendable === undefined || balance.receiving === undefined) return { complete: false, payslips, gaps, confirmedCompanyIds };
  return { complete, spendable: balance.spendable.v, receiving: balance.receiving.v, payslips, gaps, confirmedCompanyIds };
}

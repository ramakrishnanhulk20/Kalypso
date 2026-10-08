import { MAX_STROOPS } from '../amounts.js';
import { mapInOrder } from '../map-in-order.js';
import { MAX_PERIOD_LABEL_BYTES, MAX_ROSTER_PAGE, PayrollErrorCode, getCompany, getRoster, getRun, isPaid, isPayrollError, type Company, type Run } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { utf8Length } from '../chain/scval.js';
import type { EventMeta, HistoryEvent, TokenEvent } from '../history/decode.js';
import { fetchCompanyHistory, type HistorySource } from '../history/events.js';
import type { EventPosition } from '../history/rpc-events.js';
import type { TransferBinding } from '../history/tx-binding.js';

/** A payslip event of ours, with the treasury that was the company's admin when it was issued. */
export interface PayslipCandidate {
  meta: EventMeta;
  companyId: bigint;
  runId: bigint;
  worker: string;
  treasury: string;
}

/**
 * One place where history and the chain's own counts disagree (threat model C48). Each one makes
 * a view or an audit incomplete; the archive's word that it is complete is never taken alone.
 */
export type HistoryGap =
  /** The chain's memberships_of says `expected` companies; the list given holds `found` with this worker on their roster. */
  | { reason: 'company_count_mismatch'; expected: number; found: number }
  /** The company history shows `found` RunOpened events; the chain's runs_opened says `expected`. */
  | { reason: 'runs_opened_mismatch'; companyId: bigint; expected: number; found: number }
  /** A run the company history shows opened that the chain says this company never opened. */
  | { reason: 'run_not_on_chain'; companyId: bigint; runId: bigint }
  /** The history's AdminChanged events number `found`, not the chain's admin_changes, or do not lead to the admin the chain names. */
  | { reason: 'admin_changes_mismatch'; companyId: bigint; expected: number; found: number }
  /** The chain says this worker was paid in this run, and no payslip for it passed every check. */
  | { reason: 'payslip_missing'; companyId: bigint; runId: bigint }
  /** History dated this run's payslip at another ledger than its transaction's. */
  | { reason: 'ledger_mismatch'; companyId: bigint; runId: bigint }
  /** The run's counted lines number `found`; the chain's paid_count says `expected`. */
  | { reason: 'paid_count_mismatch'; companyId: bigint; runId: bigint; expected: number; found: number };

export interface CompanyPayslips {
  company: Company;
  candidates: PayslipCandidate[];
  /** Every account that was the company's treasury within the history read, oldest first. */
  treasuries: string[];
  /** Every run the history shows opened (RunOpened), in the order first seen. Compared with runs_opened by confirmRuns. */
  runIds: bigint[];
  /** The last ledger the company's history covers. */
  ingestedThrough: number;
  /** False when the company's history is incomplete, unreadable in places, or its admin changes do not add up. */
  complete: boolean;
  /** An admin_changes_mismatch, when the history's admin changes disagree with the chain. */
  gaps: HistoryGap[];
}

export type TransferRecord = EventMeta & { event: Extract<TokenEvent, { type: 'transfer' }> };

export function comparePositions(a: EventPosition, b: EventPosition): number {
  return a.ledger - b.ledger || a.txIndex - b.txIndex || a.opIndex - b.opIndex || a.eventIndex - b.eventIndex;
}

/** True for a decrypted amount that can be money: [0, 2^63) (threat model C19). */
export function isMoney(value: bigint): boolean {
  return value >= 0n && value <= MAX_STROOPS;
}

/**
 * Works out who was the company's admin, and so its treasury, at any point in the history read,
 * by walking the AdminChanged events back from the admin get_company reports now. Each change
 * must hand over from the admin before it to the admin after it, and a CompanyCreated event, if
 * read, must name the first admin. Returns null when they do not add up, so no payslip is
 * attributed to a guessed treasury.
 */
export function adminTimeline(currentAdmin: string, events: HistoryEvent[]): { adminAt(position: EventPosition): string; admins: string[] } | null {
  const changes = events.flatMap((e) => (e.kind === 'payroll' && e.event.type === 'admin_changed' ? [{ position: e, ...e.event }] : []));
  for (const [i, change] of changes.entries()) {
    const after = changes[i + 1]?.previousAdmin ?? currentAdmin;
    if (change.newAdmin !== after) return null;
  }
  const created = events.find((e) => e.kind === 'payroll' && e.event.type === 'company_created');
  const first = changes[0]?.previousAdmin ?? currentAdmin;
  if (created?.kind === 'payroll' && created.event.type === 'company_created' && created.event.admin !== first) return null;
  return {
    adminAt: (position) => changes.find((c) => comparePositions(c.position, position) > 0)?.previousAdmin ?? currentAdmin,
    admins: [...new Set([...changes.map((c) => c.previousAdmin), currentAdmin])],
  };
}

/**
 * The company's payslip events from our payroll contract, each with the treasury of its time.
 * `worker`, when given, keeps only that worker's. Reads get_company (unless `company` is the
 * answer already read) and the company's history.
 *
 * The admin timeline counts only when the history's AdminChanged events number exactly the
 * chain's admin_changes and lead to the admin get_company names; otherwise no payslip is
 * attributed to any treasury and the result carries an admin_changes_mismatch (C48).
 */
export async function readCompanyPayslips(input: {
  port: ChainPort;
  history: HistorySource;
  contracts: { payroll: string; token: string };
  companyId: bigint;
  worker?: string;
  company?: Company;
}): Promise<CompanyPayslips> {
  const { port, history, contracts, companyId } = input;
  const company = input.company ?? (await getCompany(port, contracts.payroll, companyId));
  const read = await fetchCompanyHistory({ port: history.rpc, ...(history.archive ? { archive: history.archive } : {}), contracts, companyId, fromLedger: history.fromLedger });
  // An unreadable payroll event could be a payslip or an admin change, so the set is not known in full.
  let complete = read.complete && !read.events.some((e) => e.kind === 'undecodable');
  const runIds = [...new Set(read.events.flatMap((e) => (e.kind === 'payroll' && e.event.type === 'run_opened' && e.event.companyId === companyId ? [e.event.runId] : [])))];
  const { ingestedThrough } = read;
  const adminChanges = read.events.filter((e) => e.kind === 'payroll' && e.event.type === 'admin_changed').length;
  const timeline = adminChanges === company.adminChanges ? adminTimeline(company.admin, read.events) : null;
  if (timeline === null) {
    const gaps: HistoryGap[] = [{ reason: 'admin_changes_mismatch', companyId, expected: company.adminChanges, found: adminChanges }];
    return { company, candidates: [], treasuries: [company.admin], runIds, ingestedThrough, complete: false, gaps };
  }
  const candidates = read.events.flatMap((e): PayslipCandidate[] => {
    if (e.kind !== 'payroll' || e.event.type !== 'payslip_issued' || e.event.companyId !== companyId) return [];
    if (input.worker !== undefined && e.event.worker !== input.worker) return [];
    const { kind: _kind, event, ...meta } = e;
    return [{ meta, companyId, runId: event.runId, worker: event.worker, treasury: timeline.adminAt(e) }];
  });
  // The contract pays a worker once per run (C7), so two payslips for one (run, worker) mean the
  // history is wrong, and neither is trusted.
  const seen = new Map<string, number>();
  for (const c of candidates) seen.set(`${c.runId}/${c.worker}`, (seen.get(`${c.runId}/${c.worker}`) ?? 0) + 1);
  const unique = candidates.filter((c) => seen.get(`${c.runId}/${c.worker}`) === 1);
  if (unique.length !== candidates.length) complete = false;
  return { company, candidates: unique, treasuries: timeline.admins, runIds, ingestedThrough, complete, gaps: [] };
}

/**
 * The company's runs as the chain knows them (C48): every run id the history shows opened is read
 * with get_run, and the history must show exactly as many as the chain's runs_opened. A run the
 * chain does not know is left out with a run_not_on_chain gap; a count that differs is a
 * runs_opened_mismatch. Together these catch a hidden run, the newest one included, and a
 * fabricated one, since a run id opens once per company, ever. The get_run reads go
 * READ_CONCURRENCY at a time, so a caller must not run confirmRuns inside mapInOrder.
 */
export async function confirmRuns(
  checks: ReturnType<typeof chainChecks>,
  company: Pick<CompanyPayslips, 'company' | 'runIds'> & { companyId: bigint },
): Promise<{ runs: Map<bigint, Run>; gaps: HistoryGap[] }> {
  const { companyId } = company;
  const runs = new Map<bigint, Run>();
  const gaps: HistoryGap[] = [];
  if (company.runIds.length !== company.company.runsOpened) {
    gaps.push({ reason: 'runs_opened_mismatch', companyId, expected: company.company.runsOpened, found: company.runIds.length });
  }
  const onChain = await mapInOrder(company.runIds, (runId) => checks.run(companyId, runId));
  company.runIds.forEach((runId, i) => {
    const run = onChain[i] ?? null;
    if (run === null) gaps.push({ reason: 'run_not_on_chain', companyId, runId });
    else runs.set(runId, run);
  });
  return { runs, gaps };
}

/** get_roster pages one company will be read for; 100 pages is 5,000 workers. Past it, membership is not confirmed. */
export const MAX_ROSTER_PAGES = 100;

/**
 * True when `worker` is on the company's roster on chain, which holds exactly the workers who ever
 * joined, removed ones included. worker_status cannot tell this: a pending invite from any
 * company, or a revoked one, also has a status. Reads get_roster a page at a time up to
 * rosterLen, and stops at the worker. Both sides are compared after the same address parser.
 */
export async function isOnRoster(port: ChainPort, payroll: string, companyId: bigint, worker: string, rosterLen: number): Promise<boolean> {
  for (let start = 0, page = 0; start < rosterLen && page < MAX_ROSTER_PAGES; page++) {
    const entries = await getRoster(port, payroll, companyId, start, Math.min(MAX_ROSTER_PAGE, rosterLen - start));
    if (entries.includes(worker)) return true;
    if (entries.length === 0) return false;
    start += entries.length;
  }
  return false;
}

/**
 * The one token transfer from `from` to `to` inside the transaction `txHash`, among `events`.
 * "missing" and "ambiguous" are reported rather than guessed; "undecodable" means a transfer
 * between them in that transaction could not be read.
 */
export function transferInTx(
  events: HistoryEvent[],
  txHash: string,
  from: string,
  to: string,
): { transfer: TransferRecord } | { problem: 'missing' | 'ambiguous' | 'undecodable' } {
  const inTx = events.filter((e) => e.txHash === txHash);
  const matches = inTx.flatMap((e): TransferRecord[] => {
    if (e.kind !== 'token' || e.event.type !== 'transfer' || e.event.from !== from || e.event.to !== to) return [];
    const { kind: _kind, event, ...meta } = e;
    return [{ ...meta, event }];
  });
  if (matches.length > 1) return { problem: 'ambiguous' };
  if (matches.length === 1) return { transfer: matches[0] as TransferRecord };
  const unreadable = inTx.some((e) => e.kind === 'undecodable' && e.contract === 'token' && e.parties.includes(from) && e.parties.includes(to));
  return { problem: unreadable ? 'undecodable' : 'missing' };
}

/**
 * True only when the transfer bound to its transaction (bindTransferToTransaction) and that
 * transaction is the payslip's own pay call: our payroll's pay, for this company and this run.
 * A direct transfer, or a pay for another run, never stands in for a payslip.
 */
export function bindsAsPayslip(binding: TransferBinding, candidate: PayslipCandidate): binding is Extract<TransferBinding, { ok: true }> {
  return binding.ok && binding.call.kind === 'payroll_pay' && binding.call.companyId === candidate.companyId && binding.call.runId === candidate.runId;
}

/** Reads is_paid once per (company, run, worker) call, and each run once per (company, run). */
export function chainChecks(port: ChainPort, payroll: string) {
  const runs = new Map<string, Promise<Run | null>>();
  /** The run on chain, or null when this company never opened it: a run id from history is not trusted to exist. */
  const run = (companyId: bigint, runId: bigint): Promise<Run | null> => {
    const key = `${companyId}/${runId}`;
    let read = runs.get(key);
    if (read === undefined) {
      read = getRun(port, payroll, companyId, runId).catch((err: unknown) => {
        if (isPayrollError(err, PayrollErrorCode.RunNotFound)) return null;
        throw err;
      });
      runs.set(key, read);
    }
    return read;
  };
  return {
    isPaid: (companyId: bigint, runId: bigint, worker: string) => isPaid(port, payroll, companyId, runId, worker),
    run,
    /** The run's label from chain, or null when the run is unknown or its label is longer than the contract allows (C25). */
    async periodLabel(companyId: bigint, runId: bigint): Promise<string | null> {
      const onChain = await run(companyId, runId);
      return onChain !== null && utf8Length(onChain.periodLabel) <= MAX_PERIOD_LABEL_BYTES ? onChain.periodLabel : null;
    },
  };
}

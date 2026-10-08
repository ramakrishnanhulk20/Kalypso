import { MAX_STROOPS } from '../amounts.js';
import { MAX_PERIOD_LABEL_BYTES, getCompany, getRun, isPaid, type Company } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { utf8Length } from '../chain/scval.js';
import type { EventMeta, HistoryEvent, TokenEvent } from '../history/decode.js';
import { fetchCompanyHistory, type HistorySource } from '../history/events.js';
import type { EventPosition } from '../history/rpc-events.js';

/** A payslip event of ours, with the treasury that was the company's admin when it was issued. */
export interface PayslipCandidate {
  meta: EventMeta;
  companyId: bigint;
  runId: bigint;
  worker: string;
  treasury: string;
}

export interface CompanyPayslips {
  company: Company;
  candidates: PayslipCandidate[];
  /** Every account that was the company's treasury within the history read, oldest first. */
  treasuries: string[];
  /** False when the company's history is incomplete, unreadable in places, or its admin changes do not add up. */
  complete: boolean;
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
 * `worker`, when given, keeps only that worker's. Reads get_company and the company's history.
 */
export async function readCompanyPayslips(input: {
  port: ChainPort;
  history: HistorySource;
  contracts: { payroll: string; token: string };
  companyId: bigint;
  worker?: string;
}): Promise<CompanyPayslips> {
  const { port, history, contracts, companyId } = input;
  const company = await getCompany(port, contracts.payroll, companyId);
  const read = await fetchCompanyHistory({ port: history.rpc, ...(history.archive ? { archive: history.archive } : {}), contracts, companyId, fromLedger: history.fromLedger });
  // An unreadable payroll event could be a payslip or an admin change, so the set is not known in full.
  let complete = read.complete && !read.events.some((e) => e.kind === 'undecodable');
  const timeline = adminTimeline(company.admin, read.events);
  if (timeline === null) return { company, candidates: [], treasuries: [company.admin], complete: false };
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
  return { company, candidates: unique, treasuries: timeline.admins, complete };
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

/** Reads is_paid and the run's period label once per (company, run, worker) and (company, run). */
export function chainChecks(port: ChainPort, payroll: string) {
  const labels = new Map<string, Promise<string | null>>();
  return {
    isPaid: (companyId: bigint, runId: bigint, worker: string) => isPaid(port, payroll, companyId, runId, worker),
    /** The run's label from chain, or null when it is longer than the contract allows (C25). */
    periodLabel(companyId: bigint, runId: bigint): Promise<string | null> {
      const key = `${companyId}/${runId}`;
      let label = labels.get(key);
      if (label === undefined) {
        label = getRun(port, payroll, companyId, runId).then((run) => (utf8Length(run.periodLabel) <= MAX_PERIOD_LABEL_BYTES ? run.periodLabel : null));
        labels.set(key, label);
      }
      return label;
    },
  };
}

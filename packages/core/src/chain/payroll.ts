import { xdr } from '@stellar/stellar-sdk/base';
import { ContractCallError, type ChainPort } from './ports.js';
import {
  fromAddress,
  fromBool,
  fromOption,
  fromString,
  fromStruct,
  fromU32,
  fromU32Enum,
  fromVec,
  requireAccount,
  requireU32,
  requireU64,
  toScVal,
  utf8Length,
} from './scval.js';
import { buildInvocation, type InvocationBase } from './tx.js';

/** The payroll contract's limits, copied from packages/contracts/payroll/src/contract.rs. */
export const MAX_BATCH = 2;
export const MAX_COMPANY_LABEL_BYTES = 64;
export const MAX_PERIOD_LABEL_BYTES = 32;
export const MAX_ROSTER_PAGE = 50;

/** PayrollError codes, copied from packages/contracts/payroll/src/errors.rs. */
export const PayrollErrorCode = {
  CompanyNotFound: 1,
  NotRegisteredWithToken: 2,
  AuditorMismatch: 3,
  LabelInvalid: 4,
  WorkerIsAdmin: 5,
  AlreadyMember: 6,
  InviteNotFound: 7,
  NotActive: 8,
  RunExists: 9,
  RunNotFound: 10,
  RunNotOpen: 11,
  NoItems: 12,
  TooManyItems: 13,
  AlreadyPaid: 14,
  ExpectedCountExceeded: 15,
  ExpectedCountInvalid: 16,
  NoPendingAdmin: 17,
  AdminTransferExpired: 18,
  InvalidLiveUntil: 19,
  LimitInvalid: 20,
  CounterOverflow: 21,
  MissingRecord: 22,
} as const;

/** The contract's RunStatus, in u32 order (Open = 0, Closed = 1). */
export type RunStatus = 'Open' | 'Closed';
const RUN_STATUSES = ['Open', 'Closed'] as const;

/** The contract's WorkerStatus, in u32 order (Invited = 0, Active = 1, Removed = 2). */
export type WorkerStatus = 'Invited' | 'Active' | 'Removed';
const WORKER_STATUSES = ['Invited', 'Active', 'Removed'] as const;

/** The contract's Company. u32 fields are numbers, addresses are G or C strings. */
export interface Company {
  admin: string;
  auditorId: number;
  label: string;
  createdLedger: number;
  activeWorkers: number;
  rosterLen: number;
}

/** The contract's Run. */
export interface Run {
  status: RunStatus;
  periodLabel: string;
  expectedCount: number;
  paidCount: number;
  openedLedger: number;
}

/** One pay item: the worker and the token's `data` bytes for their transfer (a ProofEnvelope payload). */
export interface PayItem {
  worker: string;
  data: Uint8Array;
}

function requireLabel(label: string, maxBytes: number, name: string): string {
  if (typeof label !== 'string') throw new TypeError(`${name} must be a string`);
  const bytes = utf8Length(label);
  if (bytes === 0 || bytes > maxBytes) throw new RangeError(`${name} must be 1 to ${maxBytes} bytes`);
  return label;
}

const company = (id: bigint) => toScVal.u64(requireU64(id, 'companyId'));
const run = (id: bigint) => toScVal.u64(requireU64(id, 'runId'));
const account = (address: string) => toScVal.address(requireAccount(address, ['G', 'C']));

/** create_company(admin, auditor_id, label). The admin signs and becomes the treasury. */
export function buildCreateCompany(base: InvocationBase, p: { admin: string; auditorId: number; label: string }): string {
  return buildInvocation(base, 'create_company', [
    account(p.admin),
    toScVal.u32(requireU32(p.auditorId, 'auditorId')),
    toScVal.string(requireLabel(p.label, MAX_COMPANY_LABEL_BYTES, 'label')),
  ]);
}

/** invite_worker(company_id, worker). The admin signs. */
export function buildInviteWorker(base: InvocationBase, p: { companyId: bigint; worker: string }): string {
  return buildInvocation(base, 'invite_worker', [company(p.companyId), account(p.worker)]);
}

/** accept_invite(company_id, worker). The worker signs. */
export function buildAcceptInvite(base: InvocationBase, p: { companyId: bigint; worker: string }): string {
  return buildInvocation(base, 'accept_invite', [company(p.companyId), account(p.worker)]);
}

/** revoke_invite(company_id, worker). The admin signs. */
export function buildRevokeInvite(base: InvocationBase, p: { companyId: bigint; worker: string }): string {
  return buildInvocation(base, 'revoke_invite', [company(p.companyId), account(p.worker)]);
}

/** remove_worker(company_id, worker). The admin signs. */
export function buildRemoveWorker(base: InvocationBase, p: { companyId: bigint; worker: string }): string {
  return buildInvocation(base, 'remove_worker', [company(p.companyId), account(p.worker)]);
}

/** open_run(company_id, run_id, period_label, expected_count). The admin signs. */
export function buildOpenRun(
  base: InvocationBase,
  p: { companyId: bigint; runId: bigint; periodLabel: string; expectedCount: number },
): string {
  return buildInvocation(base, 'open_run', [
    company(p.companyId),
    run(p.runId),
    toScVal.string(requireLabel(p.periodLabel, MAX_PERIOD_LABEL_BYTES, 'periodLabel')),
    toScVal.u32(requireU32(p.expectedCount, 'expectedCount')),
  ]);
}

/**
 * pay(company_id, run_id, items) with items as Vec<(Address, Bytes)>, a tuple being a two-item
 * vector. The admin signs. Item k's data must be proven on the balance left after item k-1.
 *
 * @throws RangeError unless there are 1 to MAX_BATCH items with no worker listed twice. The
 *   contract refuses those too; refusing here saves a simulation.
 */
export function buildPay(base: InvocationBase, p: { companyId: bigint; runId: bigint; items: readonly PayItem[] }): string {
  if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_BATCH) {
    throw new RangeError(`items must hold 1 to ${MAX_BATCH} payments`);
  }
  const workers = p.items.map((item) => requireAccount(item.worker, ['G', 'C']));
  if (new Set(workers).size !== workers.length) throw new RangeError('items must not list a worker twice');
  const items = p.items.map((item, i) => {
    if (!(item.data instanceof Uint8Array) || item.data.length === 0) throw new TypeError('item data must be non-empty bytes');
    return xdr.ScVal.scvVec([toScVal.address(workers[i] as string), toScVal.bytes(item.data)]);
  });
  return buildInvocation(base, 'pay', [company(p.companyId), run(p.runId), xdr.ScVal.scvVec(items)]);
}

/** close_run(company_id, run_id). The admin signs. */
export function buildCloseRun(base: InvocationBase, p: { companyId: bigint; runId: bigint }): string {
  return buildInvocation(base, 'close_run', [company(p.companyId), run(p.runId)]);
}

/** propose_admin(company_id, new_admin, live_until_ledger). The current admin signs. */
export function buildProposeAdmin(
  base: InvocationBase,
  p: { companyId: bigint; newAdmin: string; liveUntilLedger: number },
): string {
  return buildInvocation(base, 'propose_admin', [
    company(p.companyId),
    account(p.newAdmin),
    toScVal.u32(requireU32(p.liveUntilLedger, 'liveUntilLedger')),
  ]);
}

/** cancel_admin_proposal(company_id). The current admin signs. */
export function buildCancelAdminProposal(base: InvocationBase, p: { companyId: bigint }): string {
  return buildInvocation(base, 'cancel_admin_proposal', [company(p.companyId)]);
}

/** accept_admin(company_id). The proposed admin signs. */
export function buildAcceptAdmin(base: InvocationBase, p: { companyId: bigint }): string {
  return buildInvocation(base, 'accept_admin', [company(p.companyId)]);
}

const COMPANY_FIELDS = ['active_workers', 'admin', 'auditor_id', 'created_ledger', 'label', 'roster_len'] as const;

export function decodeCompany(value: xdr.ScVal): Company {
  const f = fromStruct(value, COMPANY_FIELDS, 'Company');
  return {
    admin: fromAddress(f.admin, 'Company.admin'),
    auditorId: fromU32(f.auditor_id, 'Company.auditor_id'),
    label: fromString(f.label, 'Company.label'),
    createdLedger: fromU32(f.created_ledger, 'Company.created_ledger'),
    activeWorkers: fromU32(f.active_workers, 'Company.active_workers'),
    rosterLen: fromU32(f.roster_len, 'Company.roster_len'),
  };
}

const RUN_FIELDS = ['expected_count', 'opened_ledger', 'paid_count', 'period_label', 'status'] as const;

export function decodeRun(value: xdr.ScVal): Run {
  const f = fromStruct(value, RUN_FIELDS, 'Run');
  return {
    status: fromU32Enum(f.status, RUN_STATUSES, 'Run.status'),
    periodLabel: fromString(f.period_label, 'Run.period_label'),
    expectedCount: fromU32(f.expected_count, 'Run.expected_count'),
    paidCount: fromU32(f.paid_count, 'Run.paid_count'),
    openedLedger: fromU32(f.opened_ledger, 'Run.opened_ledger'),
  };
}

/** Option<WorkerStatus>: null when the worker was never invited. */
export function decodeWorkerStatus(value: xdr.ScVal): WorkerStatus | null {
  return fromOption(value, (inner) => fromU32Enum(inner, WORKER_STATUSES, 'WorkerStatus'));
}

export function decodeRoster(value: xdr.ScVal): string[] {
  return fromVec(value, 'roster').map((entry, i) => fromAddress(entry, `roster[${i}]`));
}

export function decodeIsPaid(value: xdr.ScVal): boolean {
  return fromBool(value, 'is_paid');
}

/** get_company. @throws ContractCallError, with code CompanyNotFound for an unknown id. */
export async function getCompany(port: ChainPort, payroll: string, companyId: bigint): Promise<Company> {
  return decodeCompany(await port.read(requireAccount(payroll, ['C']), 'get_company', [company(companyId)]));
}

/** get_run. @throws ContractCallError, with code RunNotFound when this company never opened it. */
export async function getRun(port: ChainPort, payroll: string, companyId: bigint, runId: bigint): Promise<Run> {
  return decodeRun(await port.read(requireAccount(payroll, ['C']), 'get_run', [company(companyId), run(runId)]));
}

/** is_paid. Unknown companies, runs and workers read as false. */
export async function isPaid(port: ChainPort, payroll: string, companyId: bigint, runId: bigint, worker: string): Promise<boolean> {
  return decodeIsPaid(
    await port.read(requireAccount(payroll, ['C']), 'is_paid', [company(companyId), run(runId), account(worker)]),
  );
}

/** worker_status: null when the worker was never invited to this company. */
export async function workerStatus(port: ChainPort, payroll: string, companyId: bigint, worker: string): Promise<WorkerStatus | null> {
  return decodeWorkerStatus(
    await port.read(requireAccount(payroll, ['C']), 'worker_status', [company(companyId), account(worker)]),
  );
}

/**
 * get_roster: up to `limit` (1 to MAX_ROSTER_PAGE) addresses from index `start`, in join order,
 * including removed workers.
 */
export async function getRoster(
  port: ChainPort,
  payroll: string,
  companyId: bigint,
  start: number,
  limit: number,
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROSTER_PAGE) {
    throw new RangeError(`limit must be a whole number from 1 to ${MAX_ROSTER_PAGE}`);
  }
  return decodeRoster(
    await port.read(requireAccount(payroll, ['C']), 'get_roster', [
      company(companyId),
      toScVal.u32(requireU32(start, 'start')),
      toScVal.u32(limit),
    ]),
  );
}

/** True when err is the payroll contract refusing with this code. */
export function isPayrollError(err: unknown, code: (typeof PayrollErrorCode)[keyof typeof PayrollErrorCode]): boolean {
  return err instanceof ContractCallError && err.contractCode === code;
}

// Does NOT cover: what the live contract returns (scratchpad/m5b2/e2e-run.mjs reads it on
// testnet), the contract's own checks (packages/contracts/payroll tests), or simulation and auth.
import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH,
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
  PayrollErrorCode,
  workerStatus,
} from '../src/chain/payroll.js';
import { ContractCallError, type ChainPort } from '../src/chain/ports.js';
import { DecodeError } from '../src/chain/scval.js';
import { AddressError } from '../src/addresses.js';
import { PASSPHRASE, b64, raw, readEnvelope, testAccount, testContract } from './independent-xdr.js';

const PAYROLL = testContract(1);
const admin = testAccount('payroll admin').publicKey();
const worker = testAccount('payroll worker').publicKey();
const otherWorker = testAccount('payroll worker two').publicKey();
const smartWallet = testContract(9);
const base = { source: { address: admin, sequence: '41' }, networkPassphrase: PASSPHRASE, contractId: PAYROLL };

describe('payroll invocation builders', () => {
  const data1 = new Uint8Array([1, 2, 3]);
  const data2 = new Uint8Array([4, 5]);
  it.each<[string, () => string, string, ReturnType<typeof raw.u32>[]]>([
    ['create_company', () => buildCreateCompany(base, { admin, auditorId: 7, label: 'Kalypso Ltd' }), 'create_company', [raw.address(admin), raw.u32(7), raw.str('Kalypso Ltd')]],
    ['invite_worker', () => buildInviteWorker(base, { companyId: 3n, worker }), 'invite_worker', [raw.u64(3n), raw.address(worker)]],
    ['accept_invite', () => buildAcceptInvite(base, { companyId: 3n, worker: smartWallet }), 'accept_invite', [raw.u64(3n), raw.address(smartWallet)]],
    ['revoke_invite', () => buildRevokeInvite(base, { companyId: 3n, worker }), 'revoke_invite', [raw.u64(3n), raw.address(worker)]],
    ['remove_worker', () => buildRemoveWorker(base, { companyId: 3n, worker }), 'remove_worker', [raw.u64(3n), raw.address(worker)]],
    ['open_run', () => buildOpenRun(base, { companyId: 3n, runId: 2026_10n, periodLabel: 'October 2026', expectedCount: 2 }), 'open_run', [raw.u64(3n), raw.u64(2026_10n), raw.str('October 2026'), raw.u32(2)]],
    [
      'pay',
      () => buildPay(base, { companyId: 3n, runId: 9n, items: [{ worker, data: data1 }, { worker: otherWorker, data: data2 }] }),
      'pay',
      [raw.u64(3n), raw.u64(9n), raw.vec([raw.vec([raw.address(worker), raw.bytes(data1)]), raw.vec([raw.address(otherWorker), raw.bytes(data2)])])],
    ],
    ['close_run', () => buildCloseRun(base, { companyId: 3n, runId: 9n }), 'close_run', [raw.u64(3n), raw.u64(9n)]],
    ['propose_admin', () => buildProposeAdmin(base, { companyId: 3n, newAdmin: worker, liveUntilLedger: 5_000_000 }), 'propose_admin', [raw.u64(3n), raw.address(worker), raw.u32(5_000_000)]],
    ['cancel_admin_proposal', () => buildCancelAdminProposal(base, { companyId: 3n }), 'cancel_admin_proposal', [raw.u64(3n)]],
    ['accept_admin', () => buildAcceptAdmin(base, { companyId: (1n << 64n) - 1n }), 'accept_admin', [raw.u64((1n << 64n) - 1n)]],
  ])('%s encodes the exact contract arguments', (_name, build, method, args) => {
    const call = readEnvelope(build());
    expect(call.contractId).toBe(PAYROLL);
    expect(call.method).toBe(method);
    expect(call.args).toEqual(args.map(b64));
    expect(call.source).toBe(admin);
    expect(call.sequence).toBe(42n);
    expect(call.fee).toBe(100);
    expect(call.maxTime).toBeGreaterThan(0n);
  });

  it('refuses arguments the contract would refuse, before any simulation', () => {
    expect(() => buildCreateCompany(base, { admin, auditorId: 1, label: '' })).toThrow(RangeError);
    expect(() => buildCreateCompany(base, { admin, auditorId: 1, label: 'x'.repeat(65) })).toThrow(RangeError);
    expect(() => buildCreateCompany(base, { admin, auditorId: -1, label: 'ok' })).toThrow(RangeError);
    expect(() => buildOpenRun(base, { companyId: 1n, runId: 1n, periodLabel: 'é'.repeat(17), expectedCount: 1 })).toThrow(RangeError);
    expect(() => buildInviteWorker(base, { companyId: -1n, worker })).toThrow(RangeError);
    expect(() => buildInviteWorker(base, { companyId: 1n << 64n, worker })).toThrow(RangeError);
    expect(() => buildPay(base, { companyId: 1n, runId: 1n, items: [] })).toThrow(RangeError);
    const three = [worker, otherWorker, smartWallet].map((w) => ({ worker: w, data: new Uint8Array([1]) }));
    expect(three.length).toBeGreaterThan(MAX_BATCH);
    expect(() => buildPay(base, { companyId: 1n, runId: 1n, items: three })).toThrow(RangeError);
    const twice = [{ worker, data: new Uint8Array([1]) }, { worker: ` ${worker}`, data: new Uint8Array([2]) }];
    expect(() => buildPay(base, { companyId: 1n, runId: 1n, items: twice })).toThrow(/twice/);
    expect(() => buildPay(base, { companyId: 1n, runId: 1n, items: [{ worker, data: new Uint8Array() }] })).toThrow(TypeError);
  });

  it('refuses a muxed worker, a C source and a G contract id', () => {
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(worker), Buffer.alloc(8)]));
    expect(() => buildInviteWorker(base, { companyId: 1n, worker: muxed })).toThrow(AddressError);
    expect(() => buildCloseRun({ ...base, source: { address: smartWallet, sequence: '1' } }, { companyId: 1n, runId: 1n })).toThrow(AddressError);
    expect(() => buildCloseRun({ ...base, contractId: admin }, { companyId: 1n, runId: 1n })).toThrow(AddressError);
    expect(() => buildCloseRun({ ...base, source: { address: admin, sequence: '-1' } }, { companyId: 1n, runId: 1n })).toThrow(RangeError);
    expect(() => buildCloseRun({ ...base, timeoutSeconds: 0 }, { companyId: 1n, runId: 1n })).toThrow(RangeError);
    expect(() => buildCloseRun({ ...base, networkPassphrase: '' }, { companyId: 1n, runId: 1n })).toThrow(TypeError);
  });
});

const companyVal = (overrides: Record<string, ReturnType<typeof raw.u32>> = {}) =>
  raw.struct({
    admin: raw.address(admin),
    auditor_id: raw.u32(4),
    label: raw.str('Kalypso Ltd'),
    created_ledger: raw.u32(5_073_600),
    active_workers: raw.u32(3),
    roster_len: raw.u32(5),
    ...overrides,
  });

const runVal = (status: number) =>
  raw.struct({
    status: raw.u32(status),
    period_label: raw.str('October 2026'),
    expected_count: raw.u32(3),
    paid_count: raw.u32(1),
    opened_ledger: raw.u32(5_073_700),
  });

describe('payroll decoders', () => {
  it('decodes Company and Run exactly as types.rs defines them', () => {
    expect(decodeCompany(companyVal())).toEqual({
      admin,
      auditorId: 4,
      label: 'Kalypso Ltd',
      createdLedger: 5_073_600,
      activeWorkers: 3,
      rosterLen: 5,
    });
    expect(decodeRun(runVal(0))).toEqual({ status: 'Open', periodLabel: 'October 2026', expectedCount: 3, paidCount: 1, openedLedger: 5_073_700 });
    expect(decodeRun(runVal(1)).status).toBe('Closed');
  });

  it('decodes Option<WorkerStatus>, the roster and the paid flag', () => {
    expect(decodeWorkerStatus(raw.void())).toBeNull();
    expect([0, 1, 2].map((n) => decodeWorkerStatus(raw.u32(n)))).toEqual(['Invited', 'Active', 'Removed']);
    expect(decodeRoster(raw.vec([raw.address(worker), raw.address(smartWallet)]))).toEqual([worker, smartWallet]);
    expect(decodeRoster(raw.vec([]))).toEqual([]);
    expect(decodeIsPaid(raw.bool(true))).toBe(true);
    expect(decodeIsPaid(raw.bool(false))).toBe(false);
  });

  it('fails closed on any value that is not exactly the contract shape', () => {
    expect(() => decodeCompany(companyVal({ extra: raw.u32(1) }))).toThrow(DecodeError);
    expect(() => decodeCompany(raw.struct({ admin: raw.address(admin) }))).toThrow(DecodeError);
    expect(() => decodeCompany(companyVal({ auditor_id: raw.u64(4n) }))).toThrow(DecodeError);
    expect(() => decodeCompany(companyVal({ label: raw.str(new Uint8Array([0xff, 0xfe])) }))).toThrow(/UTF-8/);
    expect(() => decodeCompany(raw.vec([]))).toThrow(DecodeError);
    expect(() => decodeRun(runVal(2))).toThrow(DecodeError);
    expect(() => decodeWorkerStatus(raw.u32(3))).toThrow(DecodeError);
    expect(() => decodeRoster(raw.vec([raw.u32(1)]))).toThrow(DecodeError);
    expect(() => decodeIsPaid(raw.u32(1))).toThrow(DecodeError);
  });
});

function portReturning(value: ReturnType<typeof raw.u32> | Error) {
  const calls: { contractId: string; method: string; args: string[] }[] = [];
  const port = {
    read: async (contractId: string, method: string, args: ReturnType<typeof raw.u32>[]) => {
      calls.push({ contractId, method, args: args.map(b64) });
      if (value instanceof Error) throw value;
      return value;
    },
  } as unknown as ChainPort;
  return { port, calls };
}

describe('payroll reads', () => {
  it('each read calls the right method with the right arguments and decodes the answer', async () => {
    let p = portReturning(companyVal());
    expect((await getCompany(p.port, PAYROLL, 3n)).rosterLen).toBe(5);
    expect(p.calls).toEqual([{ contractId: PAYROLL, method: 'get_company', args: [b64(raw.u64(3n))] }]);

    p = portReturning(runVal(0));
    expect((await getRun(p.port, PAYROLL, 3n, 9n)).status).toBe('Open');
    expect(p.calls[0]?.args).toEqual([b64(raw.u64(3n)), b64(raw.u64(9n))]);

    p = portReturning(raw.bool(true));
    expect(await isPaid(p.port, PAYROLL, 3n, 9n, worker)).toBe(true);
    expect(p.calls[0]).toEqual({ contractId: PAYROLL, method: 'is_paid', args: [b64(raw.u64(3n)), b64(raw.u64(9n)), b64(raw.address(worker))] });

    p = portReturning(raw.u32(1));
    expect(await workerStatus(p.port, PAYROLL, 3n, worker)).toBe('Active');
    expect(p.calls[0]?.method).toBe('worker_status');

    p = portReturning(raw.vec([raw.address(worker)]));
    expect(await getRoster(p.port, PAYROLL, 3n, 10, 50)).toEqual([worker]);
    expect(p.calls[0]?.args).toEqual([b64(raw.u64(3n)), b64(raw.u32(10)), b64(raw.u32(50))]);
  });

  it('passes contract refusals through with their code', async () => {
    const { port } = portReturning(new ContractCallError('get_run', PayrollErrorCode.RunNotFound));
    const err = await getRun(port, PAYROLL, 3n, 9n).catch((e: unknown) => e);
    expect(isPayrollError(err, PayrollErrorCode.RunNotFound)).toBe(true);
    expect(isPayrollError(err, PayrollErrorCode.CompanyNotFound)).toBe(false);
    expect(isPayrollError(new Error('x'), PayrollErrorCode.RunNotFound)).toBe(false);
  });

  it('refuses a roster page outside 1 to 50 without calling the chain', async () => {
    const { port, calls } = portReturning(raw.vec([]));
    await expect(getRoster(port, PAYROLL, 3n, 0, 0)).rejects.toThrow(RangeError);
    await expect(getRoster(port, PAYROLL, 3n, 0, 51)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

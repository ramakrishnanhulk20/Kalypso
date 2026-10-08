// Does NOT cover: what the live contract returns (scratchpad/m5b2/e2e-run.mjs reads it on
// testnet), the contract's own checks (packages/contracts/payroll tests), or simulation and auth.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrKey, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH,
  PAYROLL_ERROR_MESSAGES,
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
  getMembershipsOf,
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
import { FakeChain } from './fake-chain.js';
import { PASSPHRASE, b64, raw, readEnvelope, testAccount, testContract } from './independent-xdr.js';

const PAYROLL = testContract(1);
const admin = testAccount('payroll admin').publicKey();
const accountant = testAccount('payroll accountant').publicKey();
const worker = testAccount('payroll worker').publicKey();
const otherWorker = testAccount('payroll worker two').publicKey();
const smartWallet = testContract(9);
const base = { source: { address: admin, sequence: '41' }, networkPassphrase: PASSPHRASE, contractId: PAYROLL };

describe('payroll invocation builders', () => {
  const data1 = new Uint8Array([1, 2, 3]);
  const data2 = new Uint8Array([4, 5]);
  it.each<[string, () => string, string, ReturnType<typeof raw.u32>[]]>([
    [
      'create_company',
      () => buildCreateCompany(base, { admin, accountant, auditorId: 7, label: 'Kalypso Ltd' }),
      'create_company',
      [raw.address(admin), raw.address(accountant), raw.u32(7), raw.str('Kalypso Ltd')],
    ],
    [
      'create_company with a smart wallet accountant',
      () => buildCreateCompany(base, { admin, accountant: smartWallet, auditorId: 0, label: 'K' }),
      'create_company',
      [raw.address(admin), raw.address(smartWallet), raw.u32(0), raw.str('K')],
    ],
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
    expect(() => buildCreateCompany(base, { admin, accountant, auditorId: 1, label: '' })).toThrow(RangeError);
    expect(() => buildCreateCompany(base, { admin, accountant, auditorId: 1, label: 'x'.repeat(65) })).toThrow(RangeError);
    expect(() => buildCreateCompany(base, { admin, accountant, auditorId: -1, label: 'ok' })).toThrow(RangeError);
    expect(() => buildCreateCompany(base, { admin, accountant: '', auditorId: 1, label: 'ok' })).toThrow(AddressError);
    expect(() => buildCreateCompany(base, { admin, accountant: `${accountant}X`, auditorId: 1, label: 'ok' })).toThrow(AddressError);
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

// Every u32 differs and admin differs from accountant, so a decoder that read by position would
// put a wrong value somewhere and fail.
const companyFields = (): Record<string, ReturnType<typeof raw.u32>> => ({
  admin: raw.address(admin),
  accountant: raw.address(accountant),
  auditor_id: raw.u32(4),
  label: raw.str('Kalypso Ltd'),
  created_ledger: raw.u32(5_073_600),
  active_workers: raw.u32(3),
  roster_len: raw.u32(5),
  runs_opened: raw.u32(7),
  admin_changes: raw.u32(2),
});

const companyVal = (overrides: Record<string, ReturnType<typeof raw.u32>> = {}) => raw.struct({ ...companyFields(), ...overrides });

const decodedCompany = {
  admin,
  accountant,
  auditorId: 4,
  label: 'Kalypso Ltd',
  createdLedger: 5_073_600,
  activeWorkers: 3,
  rosterLen: 5,
  runsOpened: 7,
  adminChanges: 2,
};

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
    expect(decodeCompany(companyVal())).toEqual(decodedCompany);
    expect(decodeRun(runVal(0))).toEqual({ status: 'Open', periodLabel: 'October 2026', expectedCount: 3, paidCount: 1, openedLedger: 5_073_700 });
    expect(decodeRun(runVal(1)).status).toBe('Closed');
  });

  it('reads each Company field by its name, whatever position the map holds it in', () => {
    // The host sorts struct keys by name (raw.struct does the same); this map keeps the field
    // order of types.rs instead, so the two lay the values out differently.
    const declared = Object.entries(companyFields()).map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }));
    expect(declared.map((entry) => entry.key().sym().toString())).toEqual([
      'admin',
      'accountant',
      'auditor_id',
      'label',
      'created_ledger',
      'active_workers',
      'roster_len',
      'runs_opened',
      'admin_changes',
    ]);
    expect(decodeCompany(xdr.ScVal.scvMap(declared))).toEqual(decodedCompany);
    expect(companyVal().map()?.map((entry) => entry.key().sym().toString())[0]).toBe('accountant');
  });

  it('refuses a Company in the v0.1.0 shape, without accountant, runs_opened and admin_changes', () => {
    const old = raw.struct({
      admin: raw.address(admin),
      auditor_id: raw.u32(4),
      label: raw.str('Kalypso Ltd'),
      created_ledger: raw.u32(5_073_600),
      active_workers: raw.u32(3),
      roster_len: raw.u32(5),
    });
    expect(() => decodeCompany(old)).toThrow(DecodeError);
    expect(() => decodeCompany(companyVal({ accountant: raw.u32(1) }))).toThrow(/Company.accountant/);
    expect(() => decodeCompany(companyVal({ runs_opened: raw.u64(7n) }))).toThrow(/Company.runs_opened/);
    expect(() => decodeCompany(companyVal({ admin_changes: raw.bool(false) }))).toThrow(/Company.admin_changes/);
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

  it('reads memberships_of on the fake chain: one per company joined, none for an open invite', async () => {
    const chain = new FakeChain({ payroll: PAYROLL, token: testContract(2), auditor: testContract(3) });
    chain.workers.set(`0/${worker}`, 'Active');
    chain.workers.set(`1/${worker}`, 'Removed');
    chain.workers.set(`2/${worker}`, 'Invited');
    chain.workers.set(`0/${otherWorker}`, 'Active');
    expect(await getMembershipsOf(chain, PAYROLL, worker)).toBe(2);
    expect(await getMembershipsOf(chain, PAYROLL, ` ${otherWorker} `)).toBe(1);
    expect(await getMembershipsOf(chain, PAYROLL, smartWallet)).toBe(0);
  });

  it('sends memberships_of the worker address and refuses any answer but a u32', async () => {
    const p = portReturning(raw.u32(4));
    expect(await getMembershipsOf(p.port, PAYROLL, smartWallet)).toBe(4);
    expect(p.calls).toEqual([{ contractId: PAYROLL, method: 'memberships_of', args: [b64(raw.address(smartWallet))] }]);
    for (const bad of [raw.u64(4n), raw.i128(4n), raw.void(), raw.str('4')]) {
      await expect(getMembershipsOf(portReturning(bad).port, PAYROLL, worker)).rejects.toThrow(DecodeError);
    }
    const unused = portReturning(raw.u32(1));
    await expect(getMembershipsOf(unused.port, PAYROLL, 'not an address')).rejects.toThrow(AddressError);
    await expect(getMembershipsOf(unused.port, worker, worker)).rejects.toThrow(AddressError);
    expect(unused.calls).toEqual([]);
  });
});

describe('payroll error codes', () => {
  it('match packages/contracts/payroll/src/errors.rs exactly, 23 and 24 included', () => {
    const source = readFileSync(join(import.meta.dirname, '../../contracts/payroll/src/errors.rs'), 'utf8');
    const fromContract = Object.fromEntries([...source.matchAll(/^\s*(\w+) = (\d+),$/gm)].map((m) => [m[1], Number(m[2])]));
    expect(Object.keys(fromContract)).toHaveLength(24);
    expect(PayrollErrorCode).toEqual(fromContract);
    expect([PayrollErrorCode.AuditorNotOwnedByAccountant, PayrollErrorCode.TokenUnavailable]).toEqual([23, 24]);
  });

  it('give the two new refusals their plain-English text', () => {
    expect(PAYROLL_ERROR_MESSAGES).toEqual({
      AuditorNotOwnedByAccountant: 'The accountant named does not own this auditor id on chain, so the company was not created.',
      TokenUnavailable: 'The confidential token did not answer, so nothing was changed. Try again shortly.',
    });
    const refused = new ContractCallError('create_company', PayrollErrorCode.AuditorNotOwnedByAccountant);
    expect(isPayrollError(refused, PayrollErrorCode.AuditorNotOwnedByAccountant)).toBe(true);
    expect(isPayrollError(refused, PayrollErrorCode.TokenUnavailable)).toBe(false);
  });
});

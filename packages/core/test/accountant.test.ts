// Does NOT cover: the live network (scratchpad/m5b3/e2e-views.mjs audits a testnet company),
// or the newest spend of a treasury, which no later balance checkpoint confirms (named as a
// non-goal in accountant.ts). Every ciphertext here is real, from the SDK's witness builders.
import { commit, FR_MODULUS } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUsdc, parseUsdc } from '../src/amounts.js';
import type { TxSourcePort } from '../src/history/tx-binding.js';
import { AuditError, auditCompany, exportAuditCsv, type AuditResult } from '../src/payslips/accountant.js';
import { FakeLedger, sym, type ArchiveOptions, type EventFields } from './fake-ledger.js';
import { be32, pointBytes, raw, testAccount } from './independent-xdr.js';
import { COMPANY, COMPANY_AUDITOR_ID, COMPANY_AUDITOR_SECRET, CONTRACTS, PAY, RUN, keysFor, scenario, type Scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function audit(s: Scenario, opts: { secret?: bigint; archive?: ArchiveOptions; fromLedger?: number; txSource?: TxSourcePort } = {}): Promise<AuditResult> {
  if (opts.archive !== undefined) vi.stubGlobal('fetch', s.ledger.archiveFetch(opts.archive).fetch);
  const fromLedger = opts.fromLedger ?? s.fromLedger;
  const rpc = s.ledger.rpc();
  const history = opts.archive === undefined ? { rpc, fromLedger } : { archive: { baseUrl: FakeLedger.archiveBase }, rpc, fromLedger };
  const txSource = opts.txSource ?? s.ledger.txSource();
  return auditCompany({ port: s.ledger, history, contracts: CONTRACTS, companyId: COMPANY, auditorSecret: opts.secret ?? COMPANY_AUDITOR_SECRET, txSource });
}

/** Adds `delta` to a ciphertext field. Nobody needs the key to do this, which is why the chain is checked. */
const shift = (name: string, delta: bigint) => (fields: EventFields) => {
  const value = BigInt(`0x${Buffer.from((fields[name] as ReturnType<typeof raw.bytes>).bytes()).toString('hex')}`);
  fields[name] = raw.bytes(be32((((value + delta) % FR_MODULUS) + FR_MODULUS) % FR_MODULUS));
};

const line = (s: Scenario, i: number) => ({ worker: s.workers[i] as string, amount: PAY[i] as bigint, txHash: s.payTx });
const firstRun = (s: Scenario, indexes = [0, 1]) => ({
  runId: RUN,
  periodLabel: 'October 2026',
  lines: indexes.map((i) => line(s, i)),
  total: indexes.reduce((sum, i) => sum + (PAY[i] as bigint), 0n),
});

describe('auditCompany: what the company paid', () => {
  it('reads every payroll amount with the company key and adds them up', async () => {
    const s = scenario();
    expect(await audit(s)).toEqual({ complete: true, runs: [firstRun(s)], grandTotal: firstRun(s).total, undecryptable: [] });
  });

  it('reads the same from the archive as from the RPC, and says incomplete when the archive does', async () => {
    const s = scenario();
    expect(await audit(s, { archive: {} })).toEqual(await audit(s));
    expect((await audit(s, { archive: { gap: [s.fromLedger + 1, s.fromLedger + 1] } })).complete).toBe(false);
  });

  it('stays decryptable across a deposit and merge, an incoming transfer and a withdrawal between payroll runs', async () => {
    const s = scenario();
    const [w1, w2] = s.workers as [string, string];
    s.ledger.deposit(s.outsider, s.outsider, 40_000_000n);
    s.ledger.merge(s.outsider);
    s.ledger.transfer(s.outsider, s.treasury, 3_333_333n);
    s.ledger.deposit(s.treasury, s.treasury, 20_000_000n);
    s.ledger.merge(s.treasury);
    s.ledger.withdraw(s.treasury, s.treasury, 1_234_567n);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 2);
    const second = s.ledger.pay(COMPANY, 2n, [{ worker: w1, amount: 1_100_011n }, { worker: w2, amount: 2_200_022n }]);
    const result = await audit(s);
    expect(result.undecryptable).toEqual([]);
    expect(result.runs).toEqual([
      firstRun(s),
      {
        runId: 2n,
        periodLabel: 'November 2026',
        lines: [{ worker: w1, amount: 1_100_011n, txHash: second }, { worker: w2, amount: 2_200_022n, txHash: second }],
        total: 3_300_033n,
      },
    ]);
    expect([result.complete, result.grandTotal]).toEqual([true, firstRun(s).total + 3_300_033n]);
  });

  it('checks direct transfers and deposits around payroll but never counts them (C18)', async () => {
    const s = scenario();
    s.ledger.transfer(s.treasury, s.outsider, 9_999_999n);
    s.ledger.deposit(s.outsider, s.workers[0] as string, 2_000_002n);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    const second = s.ledger.pay(COMPANY, 2n, [{ worker: s.workers[0] as string, amount: 1_000_001n }]);
    const result = await audit(s);
    expect(result.undecryptable).toEqual([]);
    expect(result.runs.map((r) => r.lines)).toEqual([firstRun(s).lines, [{ worker: s.workers[0], amount: 1_000_001n, txHash: second }]]);
    expect(result.grandTotal).toBe(firstRun(s).total + 1_000_001n);
  });

  it('leaves out a payslip the chain says was not paid', async () => {
    const s = scenario();
    s.ledger.unpaidOverride.add(`${COMPANY}/${RUN}/${s.workers[1]}`);
    expect(await audit(s)).toMatchObject({ complete: true, runs: [firstRun(s, [0])], grandTotal: PAY[0] });
  });

  it('follows the treasury across an admin handover', async () => {
    const s = scenario();
    const next = testAccount('scenario next treasury').publicKey();
    s.ledger.register(next, keysFor(next), COMPANY_AUDITOR_ID);
    s.ledger.deposit(next, next, 90_000_000n);
    s.ledger.merge(next);
    s.ledger.changeAdmin(COMPANY, next);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    const second = s.ledger.pay(COMPANY, 2n, [{ worker: s.workers[0] as string, amount: 5_100_015n }]);
    const result = await audit(s);
    expect(result.runs).toEqual([firstRun(s), { runId: 2n, periodLabel: 'November 2026', lines: [{ worker: s.workers[0], amount: 5_100_015n, txHash: second }], total: 5_100_015n }]);
    expect(result.complete).toBe(true);
  });
});

describe('auditCompany: nothing is counted that does not check out (C19)', () => {
  it('a wrong or stranger key opens nothing: every spend is undecryptable, every total is zero, and the run is not accounted for', async () => {
    const s = scenario();
    for (const secret of [COMPANY_AUDITOR_SECRET + 1n, 0x13_13n]) {
      expect(await audit(s, { secret })).toEqual({
        complete: false,
        runs: [],
        grandTotal: 0n,
        undecryptable: [
          { txHash: s.payTx, reason: 'amount_out_of_range' },
          { txHash: s.payTx, reason: 'amount_out_of_range' },
        ],
      });
    }
  });

  it('excludes a transfer whose forged amount breaks the balance chain, and counts the rest', async () => {
    const s = scenario({ tamper: [shift('v_tilde_aud_s', 5n)] });
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [firstRun(s, [1])],
      grandTotal: PAY[1],
      undecryptable: [{ txHash: s.payTx, reason: 'balance_chain_break' }],
    });
  });

  it('catches an amount shifted up with its balance shifted down by marking both ends of the break', async () => {
    const delta = 7n;
    const s = scenario({ tamper: [(f) => (shift('v_tilde_aud_s', delta)(f), shift('b_tilde_aud_s', -delta)(f))] });
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [
        { txHash: s.payTx, reason: 'balance_chain_break' },
        { txHash: s.payTx, reason: 'balance_chain_break' },
      ],
    });
  });

  it('catches an amount shifted between two spends, which keeps the balance chain whole, by binding each line to its transaction', async () => {
    const x = 1_000n;
    const s = scenario({ tamper: [(f) => (shift('v_tilde_aud_s', x)(f), shift('b_tilde_aud_s', -x)(f)), shift('v_tilde_aud_s', -x)] });
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [
        { txHash: s.payTx, reason: 'transaction_mismatch' },
        { txHash: s.payTx, reason: 'transaction_mismatch' },
      ],
    });
  });

  it('catches a forged newest spend, which no later balance checks', async () => {
    const s = scenario();
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    const x = 2_000n;
    const last = s.ledger.pay(COMPANY, 2n, [{ worker: s.workers[0] as string, amount: 1_000_001n, tamper: (f) => (shift('v_tilde_aud_s', x)(f), shift('b_tilde_aud_s', -x)(f)) }]);
    const result = await audit(s);
    expect(result.runs).toEqual([firstRun(s)]);
    expect(result.undecryptable).toEqual([{ txHash: last, reason: 'transaction_mismatch' }]);
    expect(result.complete).toBe(false);
  });

  it('counts nothing whose transaction no source has', async () => {
    const s = scenario();
    expect(await audit(s, { txSource: s.ledger.txSource({ missing: new Set([s.payTx]) }) })).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [
        { txHash: s.payTx, reason: 'transaction_unavailable' },
        { txHash: s.payTx, reason: 'transaction_unavailable' },
      ],
    });
  });

  it('marks a transfer with an off-curve point undecodable, and the spend after it unverifiable', async () => {
    const offCurve = pointBytes(commit(5n, 6n));
    offCurve[63] = (offCurve[63] ?? 0) ^ 1;
    const s = scenario({ tamper: [(f) => void (f.r_e_point = raw.bytes(offCurve))] });
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [
        { txHash: s.payTx, reason: 'undecodable_event' },
        { txHash: s.payTx, reason: 'no_verified_balance_before' },
      ],
    });
  });

  it('counts nothing it cannot check when history starts after the treasury registered', async () => {
    const s = scenario();
    const result = await audit(s, { fromLedger: s.fromLedger + 1 });
    expect(result.runs.flatMap((r) => r.lines)).toEqual([line(s, 1)]);
    expect(result.undecryptable).toEqual([{ txHash: s.payTx, reason: 'no_verified_balance_before' }]);
  });
});

describe('auditCompany: complete only when history accounts for what the chain paid (C17)', () => {
  it('says incomplete when a run paid more workers on chain than history shows', async () => {
    const s = scenario();
    s.ledger.join(COMPANY, s.outsider);
    const third = s.ledger.pay(COMPANY, RUN, [{ worker: s.outsider, amount: 1_000_001n }]);
    const drop = new Set(s.ledger.events.filter((e) => e.txHash === third).map((e) => `${e.ledger}-${e.txHash}-${e.opIndex}-${e.eventIndex}`));
    expect(await audit(s, { archive: { drop } })).toEqual({ complete: false, runs: [firstRun(s)], grandTotal: firstRun(s).total, undecryptable: [] });
    expect((await audit(s)).complete).toBe(true);
  });

  it('counts none of a run whose on-chain paid_count is below the lines history shows', async () => {
    const s = scenario();
    s.ledger.paidCountOverride.set(`${COMPANY}/${RUN}`, 1);
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [
        { txHash: s.payTx, reason: 'run_count_mismatch' },
        { txHash: s.payTx, reason: 'run_count_mismatch' },
      ],
    });
  });

  it('says incomplete for a run the history shows but the chain never opened', async () => {
    const s = scenario();
    s.ledger.tx((emit) => emit('payroll', [sym('run_opened'), raw.u64(COMPANY), raw.u64(99n)], { period_label: raw.str('Ghost run'), expected_count: raw.u32(1) }));
    expect(await audit(s)).toMatchObject({ complete: false, runs: [firstRun(s)] });
  });

  it('says incomplete when the archive ends more than 12 ledgers behind the chain', async () => {
    const s = scenario();
    s.ledger.ledger += 20;
    expect((await audit(s, { archive: { lag: 12 } })).complete).toBe(true);
    expect(await audit(s, { archive: { lag: 13 } })).toEqual({ complete: false, runs: [firstRun(s)], grandTotal: firstRun(s).total, undecryptable: [] });
  });
});

describe('exportAuditCsv', () => {
  it('writes one row per counted line, with every cell made inert (C25)', async () => {
    const s = scenario();
    const labels = ['=HYPERLINK("http://x.test","y")', '+1', '-2', '@SUM(A1)', '\tTab', '\rCR'];
    labels.forEach((label, i) => {
      s.ledger.openRun(COMPANY, 10n + BigInt(i), label, 1);
      s.ledger.pay(COMPANY, 10n + BigInt(i), [{ worker: s.workers[0] as string, amount: 1_000_000n + BigInt(i) }]);
    });
    const result = await audit(s);
    const csv = exportAuditCsv(result);
    const rows = csv.split('\r\n');
    expect(rows[0]).toBe('run_id,period,worker,amount_usdc,tx_hash');
    expect(rows[1]).toBe(`${RUN},October 2026,${s.workers[0]},${formatUsdc(PAY[0] as bigint)},${s.payTx}`);
    const periods = rows.slice(3, 3 + labels.length).map((row) => row.split(',')[1]);
    expect(rows[3]?.startsWith(`10,"'=HYPERLINK(""http://x.test""`)).toBe(true);
    expect(periods.slice(1)).toEqual(["'+1", "'-2", "'@SUM(A1)", "'\tTab", `"'\rCR"`]);
    expect(rows.at(-1)).toBe('');
    const total = rows.slice(1, -1).reduce((sum, row) => sum + parseUsdc(row.split(',').at(-2) as string), 0n);
    expect(total).toBe(result.grandTotal);
  });
});

describe('auditCompany refusals', () => {
  it('writes nothing to the console while auditing, even when it marks transfers (C12)', async () => {
    const calls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const s = scenario({ tamper: [shift('v_tilde_aud_s', 5n)] });
    exportAuditCsv(await audit(s));
    exportAuditCsv(await audit(s, { secret: 0x13_13n }));
    expect(calls.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('refuses a bad key, company, contract or transaction source before reading anything, and names no secret', async () => {
    const s = scenario();
    const txSource = s.ledger.txSource();
    for (const auditorSecret of [0n, -1n, FR_MODULUS, 5 as unknown as bigint]) {
      const err = await auditCompany({ port: s.ledger, history: { rpc: s.ledger.rpc(), fromLedger: 1 }, contracts: CONTRACTS, companyId: COMPANY, auditorSecret, txSource }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuditError);
      expect((err as AuditError).code).toBe('INVALID_INPUT');
      expect((err as Error).message).not.toContain(String(auditorSecret));
    }
    await expect(auditCompany({ port: s.ledger, history: { rpc: s.ledger.rpc(), fromLedger: 1 }, contracts: { ...CONTRACTS, token: s.treasury }, companyId: COMPANY, auditorSecret: 1n, txSource })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(auditCompany({ port: s.ledger, history: { rpc: s.ledger.rpc(), fromLedger: 1 }, contracts: CONTRACTS, companyId: COMPANY, auditorSecret: 1n, txSource: {} as TxSourcePort })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(auditCompany({ port: s.ledger, history: { rpc: s.ledger.rpc(), fromLedger: 1 }, contracts: CONTRACTS, companyId: 99n, auditorSecret: 1n, txSource })).rejects.toMatchObject({ code: 'COMPANY_NOT_FOUND' });
    expect(txSource.calls).toEqual([]);
  });
});

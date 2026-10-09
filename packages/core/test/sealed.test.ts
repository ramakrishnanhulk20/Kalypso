// Does NOT cover: the live network or how long opening takes in a browser (both measured once
// by scratchpad/web-lens), or the archive changing between the two reads its path makes. The
// audit's own C18 and C19 refusals are proven in accountant.test.ts; here they only have to show
// through as sealed rows. Every ciphertext is real, from the SDK's witness builders.
import { Address, xdr } from '@stellar/stellar-sdk/base';
import { FR_MODULUS } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TxSourcePort } from '../src/history/tx-binding.js';
import { auditCompany } from '../src/payslips/accountant.js';
import { randomAuditorSecret, readSealedPayroll, type SealedPayrollStep } from '../src/payslips/sealed.js';
import { FakeLedger, type ArchiveOptions, type EventFields } from './fake-ledger.js';
import { be32, raw } from './independent-xdr.js';
import { COMPANY, COMPANY_AUDITOR_SECRET, CONTRACTS, PAY, RUN, scenario, type Scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECOND_RUN = 2n;
const SECOND_PAY = 1_100_011n;

/** The scenario's October run, then a November run opened after it. Its id is lower, so "newest" cannot mean the biggest id. */
function twoRuns() {
  const s = scenario();
  s.ledger.openRun(COMPANY, SECOND_RUN, 'November 2026', 1);
  const second = s.ledger.pay(COMPANY, SECOND_RUN, [{ worker: s.workers[0] as string, amount: SECOND_PAY }]);
  return { s, second };
}

interface Options {
  secret?: bigint;
  archive?: ArchiveOptions;
  onProgress?: (step: SealedPayrollStep, done: number, total: number) => void;
}

function sources(s: Scenario, archive?: ArchiveOptions) {
  if (archive !== undefined) vi.stubGlobal('fetch', s.ledger.archiveFetch(archive).fetch);
  const rpc = s.ledger.rpc();
  const history = archive === undefined ? { rpc, fromLedger: s.fromLedger } : { archive: { baseUrl: FakeLedger.archiveBase }, rpc, fromLedger: s.fromLedger };
  return { rpc, history, txSource: s.ledger.txSource() };
}

function read(s: Scenario, opts: Options = {}) {
  const { history, txSource } = sources(s, opts.archive);
  return readSealedPayroll({
    port: s.ledger,
    history,
    txSource,
    contracts: CONTRACTS,
    companyId: COMPANY,
    treasury: s.treasury,
    auditorSecret: opts.secret ?? COMPANY_AUDITOR_SECRET,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
}

function audit(s: Scenario, opts: Options = {}) {
  const { history, txSource } = sources(s, opts.archive);
  return auditCompany({ port: s.ledger, history, contracts: CONTRACTS, companyId: COMPANY, auditorSecret: opts.secret ?? COMPANY_AUDITOR_SECRET, txSource });
}

/** The v_tilde_aud_s bytes of the transfer to `worker` in `txHash`, read straight from the event XDR the fake ledger stored. */
function eventField(s: Scenario, txHash: string, worker: string): string {
  const [event, ...more] = s.ledger.events.filter((e) => {
    const topics = e.topicsXdr.map((t) => xdr.ScVal.fromXDR(t, 'base64'));
    return e.txHash === txHash && String(topics[0]?.sym()) === 'transfer' && Address.fromScVal(topics[2] as xdr.ScVal).toString() === worker;
  });
  if (event === undefined || more.length > 0) throw new Error('expected exactly one transfer');
  const entry = (xdr.ScVal.fromXDR(event.dataXdr, 'base64').map() ?? []).find((e) => String(e.key().sym()) === 'v_tilde_aud_s');
  return Buffer.from((entry as xdr.ScMapEntry).val().bytes()).toString('hex');
}

describe('readSealedPayroll: the key lens', () => {
  it("opens every payment with the accountant's secret, newest run first, and its total is the audit's grandTotal", async () => {
    const { s, second } = twoRuns();
    const [w1, w2] = s.workers as [string, string];
    const result = await read(s);
    expect(result.payments.map((p) => [p.runId, p.periodLabel, p.worker, p.txHash, p.amount])).toEqual([
      [SECOND_RUN, 'November 2026', w1, second, SECOND_PAY],
      [RUN, 'October 2026', w1, s.payTx, PAY[0]],
      [RUN, 'October 2026', w2, s.payTx, PAY[1]],
    ]);
    const { grandTotal } = await audit(s);
    expect([result.companyId, result.complete, result.total]).toEqual([COMPANY, true, grandTotal]);
    expect(grandTotal).toBe((PAY[0] as bigint) + (PAY[1] as bigint) + SECOND_PAY);
  });

  it("shows a random secret the same rows, every one sealed with amount null, and a total of 0n", async () => {
    const { s } = twoRuns();
    const secret = randomAuditorSecret();
    expect(secret > 0n && secret < FR_MODULUS && secret !== randomAuditorSecret()).toBe(true);
    const accountant = await read(s);
    const stranger = await read(s, { secret });
    expect(stranger.payments).toEqual(accountant.payments.map((p) => ({ ...p, amount: null })));
    expect([stranger.payments.length, stranger.total]).toEqual([3, 0n]);
  });

  it('gives each row the v_tilde_aud_s bytes of its own transfer event as its sealed hex', async () => {
    const { s } = twoRuns();
    const { payments } = await read(s);
    for (const p of payments) {
      expect(p.sealed).toMatch(/^[0-9a-f]{64}$/);
      expect(p.sealed).toBe(eventField(s, p.txHash, p.worker));
    }
    expect(new Set(payments.map((p) => p.sealed)).size).toBe(payments.length);
  });

  it("keeps the audit's complete flag, from the RPC, from an archive, and from an archive with a gap", async () => {
    const s = scenario();
    const cases: Options[] = [{}, { archive: {} }, { archive: { gap: [s.fromLedger + 1, s.fromLedger + 1] } }, { secret: randomAuditorSecret() }];
    const seen: boolean[] = [];
    for (const opts of cases) {
      const [sealed, audited] = [await read(s, opts), await audit(s, opts)];
      expect(sealed.complete).toBe(audited.complete);
      seen.push(sealed.complete);
    }
    expect(seen).toEqual([true, true, false, false]);
    expect((await read(s, { archive: {} })).payments).toEqual((await read(s)).payments);
  });

  it('leaves a payment the audit did not count sealed with amount null, whether the chain says unpaid or its ciphertext was forged', async () => {
    const unpaid = scenario();
    unpaid.ledger.unpaidOverride.add(`${COMPANY}/${RUN}/${unpaid.workers[1]}`);
    const quiet = await read(unpaid);
    expect(quiet.payments.map((p) => p.amount)).toEqual([PAY[0], null]);
    expect([quiet.total, quiet.complete]).toEqual([PAY[0], true]);

    // Anyone can add to a ciphertext without the key; the shift breaks the balance chain at this one spend.
    const shiftBy5 = (f: EventFields) => {
      const honest = BigInt(`0x${Buffer.from((f.v_tilde_aud_s as xdr.ScVal).bytes()).toString('hex')}`);
      f.v_tilde_aud_s = raw.bytes(be32((honest + 5n) % FR_MODULUS));
    };
    const forged = scenario({ tamper: [shiftBy5] });
    const [w1, w2] = forged.workers as [string, string];
    const loud = await read(forged);
    expect(loud.payments.map((p) => [p.worker, p.sealed, p.amount])).toEqual([
      [w1, eventField(forged, forged.payTx, w1), null],
      [w2, eventField(forged, forged.payTx, w2), PAY[1]],
    ]);
    expect([loud.total, loud.complete]).toEqual([PAY[1], false]);
  });

  it('reports history, then opening, then done', async () => {
    const { s } = twoRuns();
    const calls: [SealedPayrollStep, number, number][] = [];
    await read(s, { onProgress: (step, done, total) => calls.push([step, done, total]) });
    expect(calls.map(([step]) => step).filter((step, i, all) => step !== all[i - 1])).toEqual(['history', 'opening', 'done']);
    expect(calls).toEqual([
      ['history', 0, 0],
      ['history', 0, 3],
      ['history', 1, 3],
      ['history', 2, 3],
      ['history', 3, 3],
      ['opening', 0, 3],
      ['done', 3, 3],
    ]);
  });

  it('on the RPC path makes every read once, all of them before opening, for the right key and a random one', async () => {
    for (const secret of [COMPANY_AUDITOR_SECRET, randomAuditorSecret()]) {
      const { s, second } = twoRuns();
      const { rpc, history, txSource } = sources(s);
      const chainReads = vi.spyOn(s.ledger, 'read');
      const windows = vi.spyOn(rpc, 'ledgerWindow');
      const counts = () => [chainReads.mock.calls.length, rpc.calls, windows.mock.calls.length, txSource.calls.length];
      let atOpening: number[] = [];
      await readSealedPayroll({
        port: s.ledger,
        history,
        txSource,
        contracts: CONTRACTS,
        companyId: COMPANY,
        treasury: s.treasury,
        auditorSecret: secret,
        onProgress: (step) => {
          if (step === 'opening') atOpening = counts();
        },
      });
      expect(counts()).toEqual(atOpening);
      const keys = chainReads.mock.calls.map(([contract, method, args]) => [contract, method, ...args.map((a) => a.toXDR('base64'))].join(' '));
      expect(new Set(keys).size).toBe(keys.length);
      expect(txSource.calls).toEqual([second, s.payTx]);
      expect([rpc.calls, windows.mock.calls.length]).toEqual([2, 1]);
    }
  });

  it("refuses bad settings, an unknown company, and a treasury that was never the company's", async () => {
    const s = scenario();
    const base = {
      port: s.ledger,
      history: { rpc: s.ledger.rpc(), fromLedger: s.fromLedger },
      txSource: s.ledger.txSource() as TxSourcePort,
      contracts: CONTRACTS,
      companyId: COMPANY,
      treasury: s.treasury,
      auditorSecret: COMPANY_AUDITOR_SECRET,
    };
    const bad = [
      { auditorSecret: 0n },
      { auditorSecret: FR_MODULUS },
      { treasury: 'not an account' },
      { treasury: s.outsider },
      { contracts: { payroll: s.treasury, token: CONTRACTS.token } },
      { companyId: -1n },
      { txSource: {} as TxSourcePort },
    ];
    for (const override of bad) {
      await expect(readSealedPayroll({ ...base, ...override })).rejects.toMatchObject({ name: 'AuditError', code: 'INVALID_INPUT' });
    }
    await expect(readSealedPayroll({ ...base, companyId: 99n })).rejects.toMatchObject({ name: 'AuditError', code: 'COMPANY_NOT_FOUND' });
  });
});

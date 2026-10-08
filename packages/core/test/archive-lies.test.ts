// What a lying archive can still try once every amount is bound to its transaction and every
// count is the chain's, and what the worker and the accountant are told when it does. Every
// ciphertext is real, built by the SDK's witness builders on the fake ledger; every transaction is
// a real testnet envelope whose hash the code under test recomputes. Does NOT cover: the live
// network, or a transaction source that lies about a transaction's success or ledger, which the
// binding takes from the RPC and Horizon.
import type { xdr } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcContractEvent } from '../src/history/rpc-events.js';
import type { TxSourcePort } from '../src/history/tx-binding.js';
import { auditCompany, type AuditResult } from '../src/payslips/accountant.js';
import { loadWorkerView, type WorkerView } from '../src/payslips/worker.js';
import { FakeLedger, sym, type ArchiveOptions } from './fake-ledger.js';
import { raw, testAccount, testContract } from './independent-xdr.js';
import { COMPANY, COMPANY_AUDITOR_ID, COMPANY_AUDITOR_SECRET, CONTRACTS, PAY, RUN, keysFor, scenario, type Scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const archive = { baseUrl: FakeLedger.archiveBase };
const idOf = (e: RpcContractEvent) => `${e.ledger}-${e.txHash}-${e.opIndex}-${e.eventIndex}`;
const b64 = (v: xdr.ScVal) => v.toXDR('base64');

type Rewrite = (url: string, body: { events: Record<string, unknown>[] }) => void;

/** Serves the fake ledger as the archive, with an optional edit of every reply before the client reads it. */
function serve(s: Scenario, opts: ArchiveOptions = {}, rewrite?: Rewrite): void {
  const inner = s.ledger.archiveFetch(opts).fetch;
  vi.stubGlobal('fetch', async (url: string) => {
    const res = await inner(url);
    if (rewrite === undefined) return res;
    const body = JSON.parse(await res.text()) as { events: Record<string, unknown>[] };
    rewrite(url, body);
    return { ...res, text: async () => JSON.stringify(body) };
  });
}

const history = (s: Scenario, fromArchive = true) =>
  fromArchive ? { archive, rpc: s.ledger.rpc(), fromLedger: s.fromLedger } : { rpc: s.ledger.rpc(), fromLedger: s.fromLedger };

function view(s: Scenario, worker: string, companyIds: bigint[] = [COMPANY], txSource: TxSourcePort = s.ledger.txSource()): Promise<WorkerView> {
  return loadWorkerView({ port: s.ledger, history: history(s), contracts: CONTRACTS, worker, keys: keysFor(worker), companyIds, txSource });
}

function audit(s: Scenario, fromArchive = true, txSource: TxSourcePort = s.ledger.txSource()): Promise<AuditResult> {
  return auditCompany({ port: s.ledger, history: history(s, fromArchive), contracts: CONTRACTS, companyId: COMPANY, auditorSecret: COMPANY_AUDITOR_SECRET, txSource });
}

const payslipOf = (s: Scenario, i: number) => ({
  companyId: COMPANY,
  runId: RUN,
  periodLabel: 'October 2026',
  amount: PAY[i] as bigint,
  txHash: s.payTx,
  ledger: s.ledger.events.find((e) => e.txHash === s.payTx)?.ledger as number,
});

const payrollEventIn = (s: Scenario, txHash: string) => s.ledger.events.find((e) => e.txHash === txHash && e.contractId === CONTRACTS.payroll) as RpcContractEvent;
const transferTo = (s: Scenario, txHash: string, to: string) =>
  s.ledger.events.find((e) => e.txHash === txHash && e.contractId === CONTRACTS.token && e.topicsXdr[2] === b64(raw.address(to))) as RpcContractEvent;

/** A copy of one of our events filed in another transaction, as a dishonest archive would serve it. */
function fileUnder(s: Scenario, template: RpcContractEvent, txHash: string, topics: xdr.ScVal[], eventIndex: number): void {
  const ledger = s.ledger.events.find((e) => e.txHash === txHash)?.ledger ?? template.ledger;
  s.ledger.events.push({ ...template, ledger, txHash, eventIndex, topicsXdr: topics.map(b64) });
}

const payrollEventsOf = (s: Scenario, ...txHashes: string[]) => s.ledger.events.filter((e) => e.contractId === CONTRACTS.payroll && txHashes.includes(e.txHash)).map(idOf);
const allEventsOf = (s: Scenario, ...txHashes: string[]) => s.ledger.events.filter((e) => txHashes.includes(e.txHash)).map(idOf);
const stranger = testContract(77);

describe('complete only when the chain agrees with the archive (C17, C30, C48)', () => {
  it("refuses both views when an archive hides one run's payroll events and keeps its transfers", async () => {
    const s = scenario();
    const [w1, w2] = s.workers as [string, string];
    const opened = s.ledger.openRun(COMPANY, 2n, 'November 2026', 2);
    const second = s.ledger.pay(COMPANY, 2n, [{ worker: w1, amount: 1_100_011n }, { worker: w2, amount: 2_200_022n }]);
    const honest = await audit(s, false);
    expect(honest).toMatchObject({ complete: true, gaps: [] });
    expect(honest.runs.map((r) => r.runId)).toEqual([RUN, 2n]);

    serve(s, { drop: new Set(payrollEventsOf(s, opened, second)) });
    const gap = { reason: 'runs_opened_mismatch', companyId: COMPANY, expected: 2, found: 1 };
    expect(await audit(s)).toEqual({ complete: false, runs: honest.runs.slice(0, 1), grandTotal: honest.runs[0]?.total, undecryptable: [], gaps: [gap] });
    expect(await view(s, w1)).toMatchObject({ complete: false, payslips: [payslipOf(s, 0)], gaps: [gap] });
  });

  it('refuses both views when an archive hides every event of the newest run, which no later balance checks', async () => {
    const s = scenario();
    const [w1, w2] = s.workers as [string, string];
    const opened = s.ledger.openRun(COMPANY, 2n, 'November 2026', 2);
    const newest = s.ledger.pay(COMPANY, 2n, [{ worker: w1, amount: 1_100_011n }, { worker: w2, amount: 2_200_022n }]);
    serve(s, { drop: new Set(allEventsOf(s, opened, newest)) });
    const gap = { reason: 'runs_opened_mismatch', companyId: COMPANY, expected: 2, found: 1 };
    expect(await audit(s)).toEqual({ complete: false, runs: [(await audit(s, false)).runs[0]], grandTotal: (PAY[0] as bigint) + (PAY[1] as bigint), undecryptable: [], gaps: [gap] });
    // The worker's own balance check (C16) catches it too: the rebuilt balance is short by the hidden pay.
    expect(await view(s, w1)).toEqual({ complete: false, payslips: [payslipOf(s, 0)], gaps: [gap] });
  });

  it('refuses both views when an archive hides every payroll and token event of a run in the middle, through the balance checks as well (C16, C19)', async () => {
    const s = scenario();
    const [w1, w2] = s.workers as [string, string];
    const opened = s.ledger.openRun(COMPANY, 2n, 'November 2026', 2);
    const hidden = s.ledger.pay(COMPANY, 2n, [{ worker: w1, amount: 1_100_011n }, { worker: w2, amount: 2_200_022n }]);
    s.ledger.openRun(COMPANY, 3n, 'December 2026', 2);
    const third = s.ledger.pay(COMPANY, 3n, [{ worker: w1, amount: 1_300_013n }, { worker: w2, amount: 2_400_024n }]);
    serve(s, { drop: new Set(allEventsOf(s, opened, hidden)) });
    const gap = { reason: 'runs_opened_mismatch', companyId: COMPANY, expected: 3, found: 2 };

    const seen = await view(s, w1);
    expect(seen).toMatchObject({ complete: false, gaps: [gap] });
    expect('spendable' in seen || 'receiving' in seen).toBe(false);
    expect(seen.payslips.map((p) => p.runId)).toEqual([RUN, 3n]);

    // The treasury's next spend after the hidden ones no longer follows from the balance before it.
    const audited = await audit(s);
    expect(audited.complete).toBe(false);
    expect(audited.runs.map((r) => r.runId)).not.toContain(2n);
    expect(audited.gaps[0]).toEqual(gap);
    expect(audited.undecryptable).toEqual([
      { txHash: s.payTx, reason: 'balance_chain_break' },
      { txHash: third, reason: 'balance_chain_break' },
    ]);
  });

  it('refuses the worker view when an archive hides only the payslip event', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const slip = s.ledger.events.find((e) => e.txHash === s.payTx && e.contractId === CONTRACTS.payroll && e.topicsXdr[3] === b64(raw.address(worker))) as RpcContractEvent;
    serve(s, { drop: new Set([idOf(slip)]) });
    // The token history is whole, so the balance still opens the chain and is shown; the list is not.
    expect(await view(s, worker)).toEqual({ complete: false, spendable: 0n, receiving: PAY[0], payslips: [], gaps: [{ reason: 'payslip_missing', companyId: COMPANY, runId: RUN }] });
  });

  it('refuses the worker view when the list of companies leaves out one the chain says the worker joined', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.deposit(s.outsider, s.outsider, 50_000_000n);
    s.ledger.merge(s.outsider);
    s.ledger.createCompany(8n, s.outsider, 13, 'Second Co');
    s.ledger.join(8n, worker);
    s.ledger.openRun(8n, 1n, 'Second run', 1);
    s.ledger.pay(8n, 1n, [{ worker, amount: 7_000_007n }]);
    serve(s);
    expect(await view(s, worker)).toMatchObject({ complete: false, payslips: [payslipOf(s, 0)], gaps: [{ reason: 'company_count_mismatch', expected: 2, found: 1 }] });
    const both = await view(s, worker, [COMPANY, 8n]);
    expect(both).toMatchObject({ complete: true, gaps: [] });
    expect(both.payslips.map((p) => [p.companyId, p.amount])).toEqual([
      [COMPANY, PAY[0]],
      [8n, 7_000_007n],
    ]);
  });

  it('refuses the audit when an archive hides an admin change and the company creation that would betray it', async () => {
    const s = scenario();
    const next = testAccount('scenario next treasury').publicKey();
    s.ledger.register(next, keysFor(next), COMPANY_AUDITOR_ID);
    s.ledger.deposit(next, next, 90_000_000n);
    s.ledger.merge(next);
    const handover = s.ledger.changeAdmin(COMPANY, next);
    expect(await audit(s, false)).toMatchObject({ complete: true, gaps: [] });
    // CompanyCreated goes too, so nothing but the chain's admin_changes can show the handover.
    const created = s.ledger.events.find((e) => e.topicsXdr[0] === b64(sym('company_created'))) as RpcContractEvent;
    serve(s, { drop: new Set([...allEventsOf(s, handover), idOf(created)]) });
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [],
      gaps: [
        { reason: 'admin_changes_mismatch', companyId: COMPANY, expected: 1, found: 0 },
        { reason: 'paid_count_mismatch', companyId: COMPANY, runId: RUN, expected: 2, found: 0 },
      ],
    });
  });

  it('refuses both views when an archive swaps a real run for a made-up one, keeping the count', async () => {
    const s = scenario();
    serve(s, {}, (url, body) => {
      if (!url.includes('/payroll/')) return;
      for (const row of body.events as { topics_xdr: string[] }[]) {
        if (row.topics_xdr[0] === b64(sym('run_opened'))) row.topics_xdr[2] = b64(raw.u64(99n));
      }
    });
    const gap = { reason: 'run_not_on_chain', companyId: COMPANY, runId: 99n };
    expect(await audit(s)).toEqual({ complete: false, runs: [], grandTotal: 0n, undecryptable: [], gaps: [gap] });
    expect(await view(s, s.workers[0] as string)).toMatchObject({ complete: false, payslips: [], gaps: [gap] });
  });

  it("refuses both views when an archive points a pay's transfers at another transaction", async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const decoy = s.ledger.tx(() => {}, { contract: stranger, method: 'route', args: [] });
    const decoyLedger = s.ledger.transactions.get(decoy)?.ledger as number;
    serve(s, {}, (url, body) => {
      if (!url.includes('/tokens/')) return;
      for (const row of body.events as { ledger_seq: number; tx_hash: string; event_index: number }[]) {
        if (row.tx_hash === s.payTx) Object.assign(row, { tx_hash: decoy, ledger_seq: decoyLedger, event_index: row.event_index + 10 });
      }
    });
    expect(await view(s, worker)).toEqual({ complete: false, spendable: 0n, receiving: PAY[0], payslips: [], gaps: [{ reason: 'payslip_missing', companyId: COMPANY, runId: RUN }] });
    expect(await audit(s)).toEqual({
      complete: false,
      runs: [],
      grandTotal: 0n,
      undecryptable: [],
      gaps: [{ reason: 'paid_count_mismatch', companyId: COMPANY, runId: RUN, expected: 2, found: 0 }],
    });
  });

  it.each([
    ['payslip', '/payroll/', 'payslip_issued'],
    ['transfer', '/tokens/', 'transfer'],
  ])("shows the transaction's ledger when the archive moves the %s event, and says incomplete", async (_what, route, name) => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const real = payslipOf(s, 0).ledger;
    serve(s, {}, (url, body) => {
      if (!url.includes(route)) return;
      for (const row of body.events as { ledger_seq: number; tx_hash: string; topics_xdr: string[] }[]) {
        if (row.tx_hash === s.payTx && row.topics_xdr[0] === b64(sym(name))) row.ledger_seq = real + 500;
      }
    });
    const result = await view(s, worker);
    expect(result.complete).toBe(false);
    expect(result.payslips).toEqual([payslipOf(s, 0)]);
    expect(result.gaps).toEqual([{ reason: 'ledger_mismatch', companyId: COMPANY, runId: RUN }]);
  });
});

describe('a transfer outside payroll never touches completeness (C48)', () => {
  it("leaves both views complete after a stranger's direct and contract-made transfers, and the treasury's own, whose transactions no source still has", async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.deposit(s.outsider, s.outsider, 50_000_000n);
    s.ledger.merge(s.outsider);
    const direct = s.ledger.transfer(s.outsider, worker, 1_000_001n);
    const routed = (from: string, amount: bigint) => {
      const { topics, data } = s.ledger.transferEvent(from, worker, amount);
      return s.ledger.tx((emit) => emit('token', topics, data), { contract: stranger, method: 'route', args: [] });
    };
    const strangerRouted = routed(s.outsider, 2_000_002n);
    const treasuryRouted = routed(s.treasury, 3_000_003n);
    const txSource = s.ledger.txSource({ missing: new Set([direct, strangerRouted, treasuryRouted]) });
    serve(s);
    expect(await view(s, worker, [COMPANY], txSource)).toEqual({ complete: true, spendable: 0n, receiving: (PAY[0] as bigint) + 6_000_006n, payslips: [payslipOf(s, 0)], gaps: [] });
    expect(await audit(s, true, txSource)).toMatchObject({ complete: true, undecryptable: [], gaps: [] });
    expect(txSource.calls).toEqual([s.payTx, s.payTx]);
  });
});

describe('what the binding refuses (C18, C30)', () => {
  it("refuses a payslip filed under a forged admin interlude that points at an outsider's direct payment", async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.deposit(s.outsider, s.outsider, 50_000_000n);
    s.ledger.merge(s.outsider);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    // Two admin changes that hand over and back again pass the timeline's own consistency check.
    s.ledger.tx((emit) => emit('payroll', [sym('admin_changed'), raw.u64(COMPANY)], { previous_admin: raw.address(s.treasury), new_admin: raw.address(s.outsider) }));
    const direct = s.ledger.transfer(s.outsider, worker, 4_000_004n);
    fileUnder(s, payrollEventIn(s, s.payTx), direct, [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(2n), raw.address(worker)], 9);
    s.ledger.tx((emit) => emit('payroll', [sym('admin_changed'), raw.u64(COMPANY)], { previous_admin: raw.address(s.outsider), new_admin: raw.address(s.treasury) }));
    s.ledger.paid.add(`${COMPANY}/2/${worker}`);
    serve(s);

    // The chain counts no admin change, so the interlude is refused whole and no treasury is guessed.
    const admin = { reason: 'admin_changes_mismatch', companyId: COMPANY, expected: 0, found: 2 };
    expect(await view(s, worker)).toEqual({
      complete: false,
      spendable: 0n,
      receiving: (PAY[0] as bigint) + 4_000_004n,
      payslips: [],
      gaps: [admin, { reason: 'payslip_missing', companyId: COMPANY, runId: RUN }, { reason: 'payslip_missing', companyId: COMPANY, runId: 2n }],
    });
    expect(await audit(s)).toMatchObject({ complete: false, runs: [], grandTotal: 0n, gaps: [admin, { runId: RUN }, { runId: 2n }] });
  });

  it('refuses a real pay of another company that shares the treasury account, re-filed under this company', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.createCompany(8n, s.treasury, COMPANY_AUDITOR_ID, 'Twin Co');
    s.ledger.join(8n, worker);
    s.ledger.openRun(8n, 5n, 'Twin run', 1);
    const twin = s.ledger.pay(8n, 5n, [{ worker, amount: 4_000_004n }]);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    fileUnder(s, payrollEventIn(s, s.payTx), twin, [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(2n), raw.address(worker)], 9);
    s.ledger.paid.add(`${COMPANY}/2/${worker}`);
    serve(s);

    const seen = await view(s, worker);
    expect(seen.payslips).toEqual([payslipOf(s, 0)]);
    expect(seen.complete).toBe(false);
    const audited = await audit(s);
    expect(audited.runs.map((r) => r.runId)).toEqual([RUN]);
    expect(audited.undecryptable).toEqual([{ txHash: twin, reason: 'transaction_mismatch' }]);
    expect(audited.complete).toBe(false);
  });

  it('refuses a real payslip replayed under another worker, and counts nothing for it', async () => {
    const s = scenario();
    const w0 = s.workers[0] as string;
    s.ledger.join(COMPANY, s.outsider);
    fileUnder(s, payrollEventIn(s, s.payTx), s.payTx, [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(RUN), raw.address(s.outsider)], 9);
    fileUnder(s, transferTo(s, s.payTx, w0), s.payTx, [sym('transfer'), raw.address(s.treasury), raw.address(s.outsider)], 10);
    s.ledger.paid.add(`${COMPANY}/${RUN}/${s.outsider}`);
    serve(s);

    expect(await view(s, s.outsider)).toEqual({ complete: false, payslips: [], gaps: [{ reason: 'payslip_missing', companyId: COMPANY, runId: RUN }] });
    const audited = await audit(s);
    expect(audited.runs.flatMap((r) => r.lines.map((l) => l.worker))).not.toContain(s.outsider);
    expect(audited.complete).toBe(false);
  });
});

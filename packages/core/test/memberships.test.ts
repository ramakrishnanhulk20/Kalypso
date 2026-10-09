// Covers discoverWorkerCompanies: the companies a worker joined, read from our payroll contract's
// WorkerJoined events through the archive's account route or the RPC window, and what
// loadWorkerView makes of the list when a source hides a join (C48).
// Does NOT cover: the live network or our deployed archive (the R-J walk reads testnet), the web
// portal's union of this list with the browser's record (packages/web), or an archive and an RPC
// that agree on hiding the same join, which only memberships_of then catches.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistorySource } from '../src/history/events.js';
import { discoverWorkerCompanies } from '../src/payslips/memberships.js';
import { loadWorkerView } from '../src/payslips/worker.js';
import { FakeLedger, sym, type ArchiveOptions } from './fake-ledger.js';
import { raw } from './independent-xdr.js';
import { COMPANY, CONTRACTS, PAY, RUN, keysFor, scenario, type Scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const archive = { baseUrl: FakeLedger.archiveBase };

function history(s: Scenario, opts?: ArchiveOptions): HistorySource {
  if (opts === undefined) return { rpc: s.ledger.rpc(), fromLedger: s.fromLedger };
  vi.stubGlobal('fetch', s.ledger.archiveFetch(opts).fetch);
  return { archive, rpc: s.ledger.rpc(), fromLedger: s.fromLedger };
}

const discover = (s: Scenario, worker: string, opts?: ArchiveOptions) => discoverWorkerCompanies({ history: history(s, opts), contracts: CONTRACTS, worker });

const joinLedger = (s: Scenario, txHash: string) => s.ledger.events.find((e) => e.txHash === txHash)?.ledger as number;

describe('discoverWorkerCompanies', () => {
  it('lists every company the worker joined, in ledger order, including one they later left, from the archive and the RPC alike', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.createCompany(8n, s.outsider, 13, 'Second Co');
    s.ledger.join(8n, worker);
    s.ledger.remove(8n, worker);
    s.ledger.join(8n, worker);
    s.ledger.tx((emit) => emit('payroll', [sym('run_closed'), raw.u64(COMPANY), raw.u64(RUN)], { paid_count: raw.u32(2) }));
    expect(await discover(s, worker)).toEqual({ companyIds: [COMPANY, 8n], complete: true });
    expect(await discover(s, worker, {})).toEqual({ companyIds: [COMPANY, 8n], complete: true });

    // memberships_of counts joins, so the company the worker left still has to be in the list.
    const view = await loadWorkerView({ port: s.ledger, history: history(s), contracts: CONTRACTS, worker, keys: keysFor(worker), companyIds: [COMPANY, 8n], txSource: s.ledger.txSource() });
    expect(view).toMatchObject({ complete: true, gaps: [], payslips: [{ companyId: COMPANY, runId: RUN, amount: PAY[0] }] });
  });

  it("never takes another worker's join as this worker's, wherever it comes from", async () => {
    const s = scenario();
    const [mine, theirs] = s.workers as [string, string];
    s.ledger.createCompany(8n, s.outsider, 13, 'Their Co');
    s.ledger.join(8n, theirs);
    // A join is one worker's: one naming them beside someone else is not theirs either.
    s.ledger.tx((emit) => emit('payroll', [sym('worker_joined'), raw.u64(9n), raw.address(theirs), raw.address(mine)], {}));
    expect((await discover(s, mine)).companyIds).toEqual([COMPANY]);
    expect((await discover(s, mine, {})).companyIds).toEqual([COMPANY]);
    expect((await discover(s, theirs)).companyIds).toEqual([COMPANY, 8n]);

    // An archive that answers the other worker's rows for this one is refused, and the RPC answers.
    const inner = s.ledger.archiveFetch().fetch;
    vi.stubGlobal('fetch', (url: string) => inner(url.replace(mine, theirs)));
    const rpc = s.ledger.rpc();
    const found = await discoverWorkerCompanies({ history: { archive, rpc, fromLedger: s.fromLedger }, contracts: CONTRACTS, worker: mine });
    expect(found).toEqual({ companyIds: [COMPANY], complete: true });
    expect(rpc.calls).toBeGreaterThan(0);
  });

  it('cannot hide a company: an archive that drops a join leaves loadWorkerView with a company_count_mismatch (C48)', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.createCompany(8n, s.outsider, 13, 'Hidden Co');
    const hidden = s.ledger.join(8n, worker);
    const source = history(s, { drop: new Set([`${joinLedger(s, hidden)}-${hidden}-0-0`]) });
    const found = await discoverWorkerCompanies({ history: source, contracts: CONTRACTS, worker });
    // The archive's word alone says complete; the chain's count decides.
    expect(found).toEqual({ companyIds: [COMPANY], complete: true });
    const view = await loadWorkerView({ port: s.ledger, history: source, contracts: CONTRACTS, worker, keys: keysFor(worker), companyIds: found.companyIds, txSource: s.ledger.txSource() });
    expect(view).toMatchObject({ complete: false, gaps: [{ reason: 'company_count_mismatch', expected: 2, found: 1 }] });
  });

  it('reports incomplete when the RPC fallback cannot reach back to fromLedger, and complete again once it can', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const joined = s.ledger.events.find((e) => e.contractId === CONTRACTS.payroll && e.topicsXdr[2] === raw.address(worker).toXDR('base64'))?.ledger as number;
    s.ledger.oldestLedger = joined + 1;
    expect(await discover(s, worker)).toEqual({ companyIds: [], complete: false });
    expect(await discover(s, worker, { mode: 'down' })).toEqual({ companyIds: [], complete: false });
    s.ledger.oldestLedger = s.fromLedger;
    expect(await discover(s, worker, { mode: 'down' })).toEqual({ companyIds: [COMPANY], complete: true });
  });

  it('refuses a bad worker address before reading anything', async () => {
    const s = scenario();
    const rpc = s.ledger.rpc();
    await expect(discoverWorkerCompanies({ history: { rpc, fromLedger: 1 }, contracts: CONTRACTS, worker: 'MAAAA' })).rejects.toMatchObject({ name: 'AddressError' });
    expect(rpc.calls).toBe(0);
  });
});

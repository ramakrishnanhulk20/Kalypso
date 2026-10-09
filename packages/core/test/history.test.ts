// Does NOT cover: the live RPC or our deployed archive (scratchpad/m5b3/e2e-views.mjs reads
// testnet through createRpcEventsPort), or whether an archive that is consistent with itself
// is telling the truth about the chain. Balances rebuilt from history are checked against the
// chain by the payslip views (C16), not here.
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { xdr } from '@stellar/stellar-sdk/base';
import { commit } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressError } from '../src/addresses.js';
import { DecodeError } from '../src/chain/scval.js';
import { decodeContractEvent } from '../src/history/decode.js';
import { fetchAccountHistory, fetchCompanyHistory, fetchWorkerPayrollHistory } from '../src/history/events.js';
import { createRpcEventsPort, parseRpcEventId, type EventsPort } from '../src/history/rpc-events.js';
import { FakeLedger, rpcId, sym, type ArchiveOptions } from './fake-ledger.js';
import { pointBytes, raw } from './independent-xdr.js';
import { COMPANY, CONTRACTS, RUN, scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const archive = { baseUrl: FakeLedger.archiveBase };

function withArchive(ledger: FakeLedger, opts: ArchiveOptions = {}) {
  const served = ledger.archiveFetch(opts);
  vi.stubGlobal('fetch', served.fetch);
  return served;
}

const kinds = (events: { kind: string; event?: { type: string } }[]) => events.map((e) => (e.kind === 'token' || e.kind === 'payroll' ? e.event?.type : e.kind));

describe('fetchAccountHistory from the archive', () => {
  it('reads every token event that names the account, and passes complete through', async () => {
    const s = scenario();
    const rpc = s.ledger.rpc();
    const served = withArchive(s.ledger);
    const result = await fetchAccountHistory({ port: rpc, archive, contracts: CONTRACTS, account: s.workers[0] as string, fromLedger: s.fromLedger });
    expect(result).toMatchObject({ source: 'archive', complete: true, ingestedThrough: s.ledger.ledger });
    expect(kinds(result.events)).toEqual(['register', 'transfer']);
    expect(served.urls[0]).toBe(`${archive.baseUrl}v1/tokens/${CONTRACTS.token}/accounts/${s.workers[0]}/events?from_ledger=${s.fromLedger}&limit=200`);
    expect(rpc.calls).toBe(0);
  });

  it('says complete: false whenever the archive does, and does not paper over it with the RPC (C17)', async () => {
    const s = scenario();
    const rpc = s.ledger.rpc();
    withArchive(s.ledger, { gap: [s.fromLedger + 2, s.fromLedger + 3] });
    const result = await fetchAccountHistory({ port: rpc, archive, contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect([result.source, result.complete]).toEqual(['archive', false]);
    expect(rpc.calls).toBe(0);

    withArchive(s.ledger, { gap: [s.ledger.ledger - 1, s.ledger.ledger + 100] });
    const tail = await fetchAccountHistory({ port: rpc, archive, contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect([tail.complete, tail.ingestedThrough]).toEqual([false, s.ledger.ledger - 2]);
  });

  it('follows the archive cursor across pages and gets the same events as one page', async () => {
    const s = scenario();
    withArchive(s.ledger);
    const whole = await fetchAccountHistory({ port: s.ledger.rpc(), archive, contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    const served = withArchive(s.ledger, { pageSize: 2 });
    const paged = await fetchAccountHistory({ port: s.ledger.rpc(), archive, contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect(served.urls.length).toBeGreaterThan(1);
    expect(served.urls[1]).toContain('&cursor=');
    expect(paged.events.map((e) => e.id)).toEqual(whole.events.map((e) => e.id));
    expect(kinds(paged.events)).toEqual(['register', 'deposit', 'merge', 'transfer', 'transfer']);
  });

  it.each<[string, NonNullable<ArchiveOptions['mode']>]>([
    ['unreachable', 'down'],
    ['answering 500', 'status500'],
    ['answering out of shape', 'malformed'],
    ['returning another account\'s event', 'foreign-event'],
  ])('falls back to the RPC when the archive is %s', async (_name, mode) => {
    const s = scenario();
    const rpc = s.ledger.rpc();
    withArchive(s.ledger, { mode });
    const result = await fetchAccountHistory({ port: rpc, archive, contracts: CONTRACTS, account: s.workers[1] as string, fromLedger: s.fromLedger });
    expect([result.source, result.complete]).toEqual(['rpc', true]);
    expect(kinds(result.events)).toEqual(['register', 'transfer']);
    expect(rpc.calls).toBeGreaterThan(0);
  });

  it('refuses an archive URL that is not https, before any request', async () => {
    const s = scenario();
    const served = withArchive(s.ledger);
    for (const baseUrl of ['http://archive.kalypso.test/', 'https://archive.kalypso.test/?x=1', 'javascript:alert(1)']) {
      await expect(fetchAccountHistory({ port: s.ledger.rpc(), archive: { baseUrl }, contracts: CONTRACTS, account: s.treasury, fromLedger: 1 })).rejects.toThrow(TypeError);
    }
    expect(served.urls).toEqual([]);
  });
});

describe('fetchAccountHistory from the RPC', () => {
  it('is complete only when fromLedger is inside the RPC window', async () => {
    const s = scenario();
    const inside = await fetchAccountHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect([inside.source, inside.complete, inside.ingestedThrough]).toEqual(['rpc', true, s.ledger.ledger]);
    s.ledger.oldestLedger = s.fromLedger + 2;
    const outside = await fetchAccountHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect(outside.complete).toBe(false);
    expect(kinds(outside.events)).toEqual(['deposit', 'merge', 'transfer', 'transfer']);
  });

  it('keeps reading when a page is short only because the RPC stopped scanning, and filters to the account', async () => {
    const s = scenario();
    const rpc = s.ledger.rpc({ scanLedgers: 3 });
    const result = await fetchAccountHistory({ port: rpc, contracts: CONTRACTS, account: s.outsider, fromLedger: s.fromLedger });
    expect(rpc.calls).toBeGreaterThan(3);
    expect([result.complete, kinds(result.events)]).toEqual([true, ['register']]);
  });

  it('does not stop at a full page that ends part way through the newest ledger', async () => {
    const s = scenario();
    s.ledger.tx((emit) => {
      for (let i = 0; i < 205; i++) emit('token', [sym('deposit'), raw.address(s.outsider), raw.address(s.treasury)], { amount: raw.i128(BigInt(i + 1)) });
    });
    const result = await fetchAccountHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect(result.events.filter((e) => e.kind === 'token' && e.event.type === 'deposit')).toHaveLength(206);
  });

  it('skips events from failed calls and deduplicates by event id, never by payload', async () => {
    const s = scenario();
    s.ledger.deposit(s.outsider, s.treasury, 5n);
    s.ledger.deposit(s.outsider, s.treasury, 5n);
    const failed = s.ledger.deposit(s.outsider, s.treasury, 7n);
    for (const e of s.ledger.events) if (e.txHash === failed) e.successful = false;
    const result = await fetchAccountHistory({ port: s.ledger.rpc({ duplicate: true }), contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    const deposits = result.events.filter((e) => e.kind === 'token' && e.event.type === 'deposit');
    expect(deposits.map((e) => (e.kind === 'token' && e.event.type === 'deposit' ? e.event.amount : 0n))).toEqual([100_000_0000000n, 5n, 5n]);
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
  });

  it("treats the token's four config events as touching no account, so history from its deploy ledger stays complete", async () => {
    const s = scenario();
    const read = () => fetchAccountHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    s.ledger.tx((emit) => {
      for (const name of ['underlying_asset_set', 'verifier_set', 'auditor_set', 'address_as_field_set']) emit('token', [sym(name)], { value: raw.address(CONTRACTS.auditor) });
    });
    const result = await read();
    expect(result.complete).toBe(true);
    expect(kinds(result.events)).toEqual(['register', 'deposit', 'merge', 'transfer', 'transfer']);
    s.ledger.tx((emit) => emit('token', [sym('auditor_set'), raw.u32(1)], {}));
    expect((await read()).complete).toBe(false);
  });

  it('marks history incomplete when an event of ours cannot be attributed to anyone', async () => {
    const s = scenario();
    s.ledger.tx((emit) => emit('token', [sym('transfer'), raw.u32(1), raw.u32(2)], {}));
    const result = await fetchAccountHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, account: s.treasury, fromLedger: s.fromLedger });
    expect(result.complete).toBe(false);
  });

  it('refuses bad inputs before reading anything', async () => {
    const s = scenario();
    const rpc = s.ledger.rpc();
    await expect(fetchAccountHistory({ port: rpc, contracts: CONTRACTS, account: 'MAAAA', fromLedger: 1 })).rejects.toBeInstanceOf(AddressError);
    await expect(fetchAccountHistory({ port: rpc, contracts: CONTRACTS, account: s.treasury, fromLedger: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchCompanyHistory({ port: rpc, contracts: CONTRACTS, companyId: -1n, fromLedger: 1 })).rejects.toBeInstanceOf(RangeError);
    expect(rpc.calls).toBe(0);
  });
});

describe('fetchCompanyHistory', () => {
  it('returns only that company\'s payroll events, the same from the archive and the RPC', async () => {
    const s = scenario();
    s.ledger.createCompany(8n, s.outsider, 13, 'Other Co');
    s.ledger.openRun(8n, RUN, 'Other run', 1);
    withArchive(s.ledger);
    const fromArchive = await fetchCompanyHistory({ port: s.ledger.rpc(), archive, contracts: CONTRACTS, companyId: COMPANY, fromLedger: s.fromLedger });
    const fromRpc = await fetchCompanyHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, companyId: COMPANY, fromLedger: s.fromLedger });
    expect(fromArchive.source).toBe('archive');
    expect(fromArchive.events.map((e) => e.id)).toEqual(fromRpc.events.map((e) => e.id));
    expect(kinds(fromRpc.events)).toEqual(['company_created', 'ignored', 'ignored', 'run_opened', 'payslip_issued', 'payslip_issued']);
    const payslips = fromRpc.events.filter((e) => e.kind === 'payroll' && e.event.type === 'payslip_issued');
    expect(payslips.map((e) => (e.kind === 'payroll' ? e.event : null))).toEqual(
      s.workers.map((worker) => ({ type: 'payslip_issued', companyId: COMPANY, runId: RUN, worker })),
    );
    expect(payslips.map((e) => e.txHash)).toEqual([s.payTx, s.payTx]);
  });
});

describe('fetchWorkerPayrollHistory', () => {
  it("reads the payroll events that name the worker, the same from the archive's account route and the RPC", async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.tx((emit) => emit('payroll', [sym('run_closed'), raw.u64(COMPANY), raw.u64(RUN)], { paid_count: raw.u32(2) }));
    const served = withArchive(s.ledger);
    const fromArchive = await fetchWorkerPayrollHistory({ port: s.ledger.rpc(), archive, contracts: CONTRACTS, worker, fromLedger: s.fromLedger });
    const fromRpc = await fetchWorkerPayrollHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, worker, fromLedger: s.fromLedger });
    expect(served.urls[0]).toBe(`${archive.baseUrl}v1/payroll/${CONTRACTS.payroll}/accounts/${worker}/events?from_ledger=${s.fromLedger}&limit=200`);
    expect([fromArchive.source, fromArchive.complete, fromRpc.source, fromRpc.complete]).toEqual(['archive', true, 'rpc', true]);
    expect(fromArchive.events.map((e) => e.id)).toEqual(fromRpc.events.map((e) => e.id));
    expect(kinds(fromRpc.events)).toEqual(['ignored', 'payslip_issued']);
  });

  it('says incomplete for a payroll event of ours that names the worker, or might, but cannot be read', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const read = () => fetchWorkerPayrollHistory({ port: s.ledger.rpc(), contracts: CONTRACTS, worker, fromLedger: s.fromLedger });
    s.ledger.tx((emit) => emit('payroll', [sym('payslip_issued'), raw.u64(COMPANY), raw.address(s.outsider)], {}));
    expect((await read()).complete).toBe(true);
    s.ledger.tx((emit) => emit('payroll', [sym('payslip_issued'), raw.u64(COMPANY), raw.address(worker)], {}));
    expect((await read()).complete).toBe(false);

    const t = scenario();
    t.ledger.tx((emit) => emit('payroll', [sym('worker_joined'), raw.u32(1)], {}));
    expect((await fetchWorkerPayrollHistory({ port: t.ledger.rpc(), contracts: CONTRACTS, worker, fromLedger: t.fromLedger })).complete).toBe(false);
  });

  it('refuses a bad worker before reading anything', async () => {
    const s = scenario();
    const rpc = s.ledger.rpc();
    await expect(fetchWorkerPayrollHistory({ port: rpc, contracts: CONTRACTS, worker: 'MAAAA', fromLedger: 1 })).rejects.toBeInstanceOf(AddressError);
    expect(rpc.calls).toBe(0);
  });
});

describe('decodeContractEvent', () => {
  const base = { ledger: 10, txIndex: 1, opIndex: 0, eventIndex: 0, txHash: 'ab'.repeat(32) };
  const transferData = (fields: Record<string, xdr.ScVal> = {}) => {
    const bytes32 = raw.bytes(new Uint8Array(32).fill(1));
    return raw.struct({
      r_e_point: raw.bytes(pointBytes(commit(5n, 6n))),
      v_tilde: bytes32,
      sigma: bytes32,
      b_tilde: bytes32,
      v_tilde_aud_r: bytes32,
      r_tilde_aud_r: bytes32,
      v_tilde_aud_s: bytes32,
      b_tilde_aud_s: bytes32,
      ...fields,
    });
  };
  const event = (data: xdr.ScVal, topics = [sym('transfer'), raw.address(CONTRACTS.payroll), raw.address(CONTRACTS.auditor)]) =>
    decodeContractEvent({ ...base, contractId: CONTRACTS.token, topicsXdr: topics.map((t) => t.toXDR('base64')), dataXdr: data.toXDR('base64') }, CONTRACTS);

  it('decodes a transfer and keys it by ledger, hash, operation and index', () => {
    const decoded = event(transferData());
    expect(decoded.kind).toBe('token');
    expect(decoded.id).toBe(`10-${'ab'.repeat(32)}-0-0`);
  });

  it('marks undecodable, with the field named, any payload that is not exactly the contract\'s shape', () => {
    const offCurve = pointBytes(commit(5n, 6n));
    offCurve[63] = (offCurve[63] ?? 0) ^ 1;
    const cases: [xdr.ScVal, RegExp][] = [
      [transferData({ r_e_point: raw.bytes(offCurve) }), /r_e_point is not a point on the curve/],
      [transferData({ r_e_point: raw.bytes(new Uint8Array(64)) }), /r_e_point is the identity/],
      [transferData({ sigma: raw.bytes(new Uint8Array(32).fill(0xff)) }), /sigma is not a canonical field value/],
      [transferData({ sigma: raw.bytes(new Uint8Array(31)) }), /sigma should be 32 bytes/],
      [transferData({ extra: raw.u32(1) }), /exactly the fields/],
    ];
    for (const [data, reason] of cases) {
      const decoded = event(data);
      expect(decoded.kind).toBe('undecodable');
      if (decoded.kind === 'undecodable') {
        expect(decoded.reason).toMatch(reason);
        expect(decoded.parties).toEqual([CONTRACTS.payroll, CONTRACTS.auditor]);
      }
    }
    expect(event(transferData(), [sym('transfer'), raw.address(CONTRACTS.payroll)]).kind).toBe('undecodable');
  });

  it('refuses an event from any other contract', () => {
    expect(() => decodeContractEvent({ ...base, contractId: CONTRACTS.auditor, topicsXdr: [], dataXdr: '' }, CONTRACTS)).toThrow(DecodeError);
  });
});

describe('createRpcEventsPort', () => {
  it('maps getEvents into raw events whose ids agree with their position', async () => {
    const position = { ledger: 5_082_797, txIndex: 11, opIndex: 0, eventIndex: 1 };
    const id = rpcId(position);
    expect(parseRpcEventId(id)).toEqual(position);
    expect(() => parseRpcEventId('12-x')).toThrow(DecodeError);
    const topic = sym('merge');
    const event = { id, type: 'contract', ledger: position.ledger, ledgerClosedAt: '', transactionIndex: 11, operationIndex: 0, inSuccessfulContractCall: true, txHash: 'cd'.repeat(32), contractId: { contractId: () => CONTRACTS.token }, topic: [topic], value: raw.struct({}) };
    const getEvents = vi.spyOn(Server.prototype, 'getEvents').mockResolvedValueOnce({ events: [event], cursor: 'c-1', latestLedger: 9 } as unknown as Api.GetEventsResponse);
    vi.spyOn(Server.prototype, 'getHealth').mockResolvedValueOnce({ oldestLedger: 3, latestLedger: 9, ledgerRetentionWindow: 6, status: 'healthy' });
    const port: EventsPort = createRpcEventsPort({ rpcUrl: 'https://soroban-testnet.example.org' });
    expect(await port.ledgerWindow()).toEqual({ oldestLedger: 3, latestLedger: 9 });
    const page = await port.contractEvents({ contractId: CONTRACTS.token, startLedger: 4, limit: 200 });
    expect(getEvents.mock.calls[0]?.[0]).toEqual({ filters: [{ type: 'contract', contractIds: [CONTRACTS.token] }], startLedger: 4, limit: 200 });
    expect(page.events[0]).toEqual({ ...position, txHash: 'cd'.repeat(32), contractId: CONTRACTS.token, topicsXdr: [topic.toXDR('base64')], dataXdr: raw.struct({}).toXDR('base64'), successful: true });

    getEvents.mockResolvedValueOnce({ events: [{ ...event, transactionIndex: 12 }], cursor: '', latestLedger: 9 } as unknown as Api.GetEventsResponse);
    await expect(port.contractEvents({ contractId: CONTRACTS.token, cursor: 'c-1', limit: 200 })).rejects.toThrow(DecodeError);
    expect(() => createRpcEventsPort({ rpcUrl: 'http://soroban-testnet.example.org' })).toThrow(TypeError);
  });
});

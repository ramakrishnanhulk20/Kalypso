// Does NOT cover: whether the token accepts the withdraw proof (scratchpad/m5b3/e2e-views.mjs
// proves and submits one on testnet with createNodeProver). The prover here is the SDK's real
// witness builder and encoder with a stand-in proof, so openings and payloads are real.
import { buildWithdrawWitness, commit, encodeWithdrawData, type WithdrawParams } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProverPort, WithdrawEnvelope } from '../src/prover/port.js';
import { loadWorkerBalance } from '../src/payslips/worker.js';
import { WorkerActionError, buildWorkerMerge, buildWorkerWithdraw } from '../src/payslips/worker-actions.js';
import type { Opening } from '../src/run/treasury.js';
import { FakeLedger } from './fake-ledger.js';
import { PASSPHRASE, b64, raw, readEnvelope, testAccount } from './independent-xdr.js';
import { CONTRACTS, PAY, keysFor, scenario, type Scenario } from './scenario.js';

const proveWithdraw = vi.fn(async (params: WithdrawParams): Promise<WithdrawEnvelope> => {
  const witness = buildWithdrawWitness(params);
  const proof = new Uint8Array([4, 2]);
  return { payload: new Uint8Array(encodeWithdrawData(witness, proof).bytes()), proof, next: witness.next };
});
const unused = async (): Promise<never> => {
  throw new Error('a withdrawal only proves withdraw');
};
const prover: ProverPort = { proveWithdraw, proveRegister: unused, proveTransfer: unused };

afterEach(() => {
  proveWithdraw.mockClear();
  vi.unstubAllGlobals();
});

const baseFor = (worker: string) => ({ source: { address: worker, sequence: '41' }, networkPassphrase: PASSPHRASE, contractId: CONTRACTS.token });

async function mergedWorker(s: Scenario) {
  const worker = s.workers[0] as string;
  s.ledger.merge(worker);
  const balance = await loadWorkerBalance({ port: s.ledger, history: { rpc: s.ledger.rpc(), fromLedger: s.fromLedger }, contracts: CONTRACTS, worker, keys: keysFor(worker) });
  return { worker, balance, spendable: balance.spendable as Opening };
}

const withdraw = (s: Scenario, worker: string, spendable: Opening, amount: bigint, keysOf = worker) =>
  buildWorkerWithdraw(baseFor(worker), { port: s.ledger, prover, registry: CONTRACTS.auditor, worker, keys: keysFor(keysOf), spendable, to: s.outsider, amount });

describe('buildWorkerMerge', () => {
  it('builds merge(worker) when incoming pay is waiting, and refuses when nothing is', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const envelope = readEnvelope(await buildWorkerMerge(baseFor(worker), { port: s.ledger, worker }));
    expect([envelope.source, envelope.contractId, envelope.method, envelope.args]).toEqual([worker, CONTRACTS.token, 'merge', [b64(raw.address(worker))]]);
    s.ledger.merge(worker);
    await expect(buildWorkerMerge(baseFor(worker), { port: s.ledger, worker })).rejects.toMatchObject({ code: 'NOTHING_TO_MERGE' });
  });

  it('refuses a worker who is not the source, or is not registered', async () => {
    const s = scenario();
    await expect(buildWorkerMerge(baseFor(s.treasury), { port: s.ledger, worker: s.workers[0] as string })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const stranger = testAccount('never registered').publicKey();
    await expect(buildWorkerMerge(baseFor(stranger), { port: s.ledger, worker: stranger })).rejects.toMatchObject({ code: 'NOT_REGISTERED' });
  });
});

describe('buildWorkerWithdraw', () => {
  it('proves from the verified opening with a fresh salt and leaves exactly the rest', async () => {
    const s = scenario();
    const { worker, balance, spendable } = await mergedWorker(s);
    expect([balance.complete, spendable.v]).toEqual([true, PAY[0]]);
    const { xdr, next } = await withdraw(s, worker, spendable, 1_000_001n);
    const envelope = readEnvelope(xdr);
    expect(envelope.method).toBe('withdraw');
    expect(envelope.args.slice(0, 3)).toEqual([b64(raw.address(worker)), b64(raw.address(s.outsider)), b64(raw.i128(1_000_001n))]);
    expect(next.v).toBe((PAY[0] as bigint) - 1_000_001n);
    expect(next.commitment.equals(commit(next.v, next.r))).toBe(true);
    const params = proveWithdraw.mock.calls[0]?.[0] as WithdrawParams;
    expect([params.sigma, params.rE, params.amount, params.v]).toEqual([undefined, undefined, 1_000_001n, PAY[0]]);
    expect(params.kAudS.equals(s.ledger.auditorKey(11))).toBe(true);
  });

  it('refuses to prove from an opening that does not open the chain (C16)', async () => {
    const s = scenario();
    const { worker, spendable } = await mergedWorker(s);
    const stale = { ...spendable, v: spendable.v + 1n, commitment: commit(spendable.v + 1n, spendable.r) };
    await expect(withdraw(s, worker, stale, 1n)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
    expect(proveWithdraw).not.toHaveBeenCalled();
  });

  it('has no opening to offer when the archive silently drops an event, and refuses the last one it saw', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.merge(worker);
    const before = await mergedWorker(s);
    const dropped = s.ledger.deposit(s.outsider, worker, 2_000_002n);
    s.ledger.merge(worker);
    const event = s.ledger.events.find((e) => e.txHash === dropped);
    vi.stubGlobal('fetch', s.ledger.archiveFetch({ drop: new Set([`${event?.ledger}-${dropped}-0-0`]) }).fetch);
    const balance = await loadWorkerBalance({ port: s.ledger, history: { archive: { baseUrl: FakeLedger.archiveBase }, rpc: s.ledger.rpc(), fromLedger: s.fromLedger }, contracts: CONTRACTS, worker, keys: keysFor(worker) });
    expect([balance.complete, balance.spendable]).toEqual([false, undefined]);
    await expect(withdraw(s, worker, before.spendable, 1n)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
    expect(proveWithdraw).not.toHaveBeenCalled();
  });

  it('refuses keys that are not the worker\'s, too much, nothing, and a bad destination', async () => {
    const s = scenario();
    const { worker, spendable } = await mergedWorker(s);
    await expect(withdraw(s, worker, spendable, 1n, s.outsider)).rejects.toMatchObject({ code: 'KEYS_MISMATCH' });
    await expect(withdraw(s, worker, spendable, spendable.v + 1n)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(withdraw(s, worker, spendable, 0n)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(buildWorkerWithdraw(baseFor(worker), { port: s.ledger, prover, registry: CONTRACTS.auditor, worker, keys: keysFor(worker), spendable, to: 'MAAAA', amount: 1n })).rejects.toBeInstanceOf(WorkerActionError);
    expect(proveWithdraw).not.toHaveBeenCalled();
  });

  it('builds nothing when the proof would leave a different balance', async () => {
    const s = scenario();
    const { worker, spendable } = await mergedWorker(s);
    proveWithdraw.mockImplementationOnce(async (params) => {
      const witness = buildWithdrawWitness({ ...params, amount: params.amount + 1n });
      return { payload: new Uint8Array(encodeWithdrawData(witness, new Uint8Array([1])).bytes()), proof: new Uint8Array([1]), next: witness.next };
    });
    await expect(withdraw(s, worker, spendable, 5n)).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
  });
});

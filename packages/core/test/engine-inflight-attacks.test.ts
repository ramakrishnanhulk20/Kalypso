// Attacks on the in-flight record and the attempts list in src/run/engine.ts and
// src/run/treasury.ts: a lagging balance read, a lying close time, two tabs on one store, and a
// damaged record. Each attack that once locked the treasury is also recovered by
// rebuildTreasuryOpening after the device loses every opening it saved. The stand-in prover,
// store and FakeChain are the ones engine.test.ts uses, so commitments, salts and openings are
// real. Does NOT cover: real proofs, fees, the live network, or a store that loses a write to the
// attempts list in a two-tab race (an accepted residual).
import { Address, TransactionBuilder, xdr, type Keypair } from '@stellar/stellar-sdk/base';
import {
  addressToField,
  buildTransferWitness,
  commit,
  deriveKeys,
  encodeTransferData,
  H,
  IDENTITY,
  pointToBytes,
  scalarMul,
  type TransferParams,
} from 'stellar-confidential-token-sdk';
import { describe, expect, it } from 'vitest';
import { formatUsdc } from '../src/amounts.js';
import type { ChainPort, InFlightPay, OpeningStore, SavedOpening } from '../src/chain/ports.js';
import { parsePayrollCsv } from '../src/csv.js';
import type { KalypsoKeys } from '../src/keys.js';
import type { ProverPort, TransferEnvelope } from '../src/prover/port.js';
import { PaidElsewhereError, PaymentInFlightError, clearInFlight, executeRun, type RunInput } from '../src/run/engine.js';
import { rebuildTreasuryOpening } from '../src/run/rebuild.js';
import { readSavedOpening, toSavedOpening, treasuryOpeningKey } from '../src/run/treasury.js';
import { FakeChain, type AccountState } from './fake-chain.js';
import { PASSPHRASE, accountStruct, testAccount, testContract } from './independent-xdr.js';

async function standInProof(params: TransferParams): Promise<TransferEnvelope> {
  const witness = buildTransferWitness(params);
  const proof = new Uint8Array(
    [commit(params.v, params.r), params.kAudR, params.kAudS, params.pvkB].flatMap((point) => [...pointToBytes(point)]),
  );
  return {
    payload: new Uint8Array(encodeTransferData(witness, proof).bytes()),
    proof,
    recipientView: witness.recipientView,
    next: witness.next,
    rEScalar: witness.rEScalar,
  };
}

const unused = async (): Promise<never> => {
  throw new Error('the payroll engine only proves transfers');
};
const prover: ProverPort = { proveTransfer: standInProof, proveRegister: unused, proveWithdraw: unused };

const CONTRACTS = { payroll: testContract(21), token: testContract(22), auditor: testContract(23) };
const COMPANY = 7n;
const RUN = 202610n;
const adminKey = testAccount('inflight attacks admin');
const treasury = adminKey.publicKey();
const workers = Array.from({ length: 5 }, (_, i) => testAccount(`inflight attacks worker ${i}`).publicKey());
const AMOUNTS = [1_908_190_1n, 8_801_919_09n, 1_000_000_81n, 9_181_009_1n, 81_900_190_8n];
const FUNDS = 100_000_0000000n;
const keys: KalypsoKeys = (() => {
  const addrF = addressToField(CONTRACTS.token);
  const acctF = addressToField(treasury);
  return { ...deriveKeys(0x5eed_1234_abcdn, addrF, acctF), addrF, acctF };
})();
const treasuryKey = treasuryOpeningKey(CONTRACTS.token, treasury);
const inFlightRecordKey = `kalypso/v1/inflight/${CONTRACTS.token}/${treasury}`;

function memoryStore(): OpeningStore & { data: Map<string, SavedOpening | InFlightPay | readonly string[]> } {
  const data = new Map<string, SavedOpening | InFlightPay | readonly string[]>();
  return {
    data,
    get: async (key) => data.get(key),
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  };
}

const signerFor = (kp: Keypair) => ({
  address: kp.publicKey(),
  signTransaction: async (txXdr: string, passphrase: string) => {
    const tx = TransactionBuilder.fromXDR(txXdr, passphrase);
    tx.sign(kp);
    return tx.toXDR();
  },
});

const csvRows = (addresses: string[], amounts = AMOUNTS) =>
  parsePayrollCsv(addresses.map((a, i) => `${a},${formatUsdc(amounts[i] as bigint)}`).join('\n')).rows;

function setup(funds = FUNDS) {
  const chain = new FakeChain(CONTRACTS);
  chain.companies.set(COMPANY, { admin: treasury, auditorId: 0, activeWorkers: workers.length });
  chain.runs.set(`${COMPANY}/${RUN}`, { open: true, expected: workers.length, paid: 0 });
  chain.auditorKeys.set(0, scalarMul(1001n, H));
  chain.accounts.set(treasury, { auditorId: 0, spendingKey: keys.Y, pvk: keys.PVK, spendable: IDENTITY, receiving: IDENTITY });
  chain.recordRegister(treasury);
  chain.depositAndMerge(treasury, funds);
  chain.sequences.set(treasury, 500n);
  workers.forEach((worker, i) => {
    chain.workers.set(`${COMPANY}/${worker}`, 'Active');
    chain.auditorKeys.set(10 + i, scalarMul(2000n + BigInt(i), H));
    chain.accounts.set(worker, {
      auditorId: 10 + i,
      spendingKey: scalarMul(3000n + BigInt(i), H),
      pvk: scalarMul(4000n + BigInt(i), H),
      spendable: IDENTITY,
      receiving: IDENTITY,
    });
  });
  const store = memoryStore();
  store.data.set(treasuryKey, toSavedOpening(funds, 0n));
  const input: RunInput = {
    port: chain,
    signer: signerFor(adminKey),
    store,
    networkPassphrase: PASSPHRASE,
    contracts: CONTRACTS,
    companyId: COMPANY,
    runId: RUN,
    rows: csvRows(workers),
    keys,
    prover,
  };
  return { chain, store, input };
}

const transfersPerWorker = (chain: FakeChain) => workers.map((w) => chain.transfersTo.get(w) ?? 0);
const treasuryOpening = (store: ReturnType<typeof memoryStore>) => readSavedOpening(store.data.get(treasuryKey));
const chainSpendable = (chain: FakeChain) => (chain.accounts.get(treasury) as AccountState).spendable;

const RECOVERIES = ['by resuming', 'by rebuilding from the chain after the device loses every opening'] as const;

/**
 * Rebuilding: the device loses every opening it saved, so the next run is refused with an error
 * the console offers a rebuild for, and the rebuild from the token history clears it.
 */
async function recover(recovery: (typeof RECOVERIES)[number], input: RunInput, chain: FakeChain, store: ReturnType<typeof memoryStore>, paid: number) {
  if (recovery === 'by resuming') return;
  for (const [key, value] of [...store.data]) if (readSavedOpening(value) !== undefined) store.data.delete(key);
  const locked = await executeRun(input).catch((e: unknown) => e);
  expect((locked as { rebuildable?: boolean }).rebuildable).toBe(true);
  const rebuilt = await rebuildTreasuryOpening({
    port: chain,
    store,
    history: { rpc: chain.rpc(), fromLedger: chain.historyStart },
    payroll: CONTRACTS.payroll,
    token: CONTRACTS.token,
    treasury,
    keys,
  });
  expect(rebuilt).toEqual({ value: FUNDS - AMOUNTS.slice(0, paid).reduce((a, b) => a + b, 0n), deviceExpected: undefined, matchesDevice: false });
  expect(treasuryOpening(store)?.commitment.equals(chainSpendable(chain))).toBe(true);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The next run starts from the opening that landed, pays only the unpaid rows, and leaves the treasury opening on chain. */
async function expectResumes(input: RunInput, chain: FakeChain, store: ReturnType<typeof memoryStore>, alreadyPaid: number) {
  const report = await executeRun(input);
  expect(report.rows.map((r) => r.status)).toEqual([...Array(alreadyPaid).fill('already-paid'), ...Array(5 - alreadyPaid).fill('paid')]);
  expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
  expect(store.data.has(inFlightRecordKey)).toBe(false);
  expect(treasuryOpening(store)?.commitment.equals(chainSpendable(chain))).toBe(true);
}

describe('a pay the chain applied is never forgotten (C13, C29)', () => {
  it.each(RECOVERIES)('refuses to forget a pay whose balance read lags one ledger behind the SUCCESS answer, then recovers %s', async (recovery) => {
    const { chain, store, input } = setup();
    // An RPC pool: the node that answers getTransaction has the ledger with the pay in it, the
    // node that answers the balance simulation does not yet. One stale read, right after the
    // first pay lands.
    const staleStruct = accountStruct(chain.accounts.get(treasury) as AccountState);
    let staleReads = 1;
    const read: ChainPort['read'] = chain.read.bind(chain);
    chain.read = async (contractId, method, args) => {
      const [first] = args;
      if (method === 'confidential_balance' && staleReads > 0 && chain.submitted.length > 0 && first !== undefined && Address.fromScVal(first).toString() === treasury) {
        staleReads--;
        return staleStruct;
      }
      return read(contractId, method, args);
    };

    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentInFlightError);
    expect((err as PaymentInFlightError).reason).toBe('UNCONFIRMED');
    expect((err as PaymentInFlightError).rebuildable).toBe(false);
    expect(chain.submitted).toHaveLength(1);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 0, 0, 0]);
    // The record of the applied pay is kept, so nothing is built on the stale balance.
    expect(store.data.has(inFlightRecordKey)).toBe(true);
    expect(treasuryOpening(store)?.v).toBe(FUNDS);

    chain.read = read;
    await recover(recovery, input, chain, store, 2);
    await expectResumes(input, chain, store, 2);
    expect(chain.submitted).toHaveLength(3);
  });

  it('refuses to adopt the previous batch from a balance read one ledger behind the second pay, and raises no false alarm on stale paid flags (NEW-1)', async () => {
    const { chain, store, input } = setup();
    // The node answering the balance read still holds the ledger before the second pay, and the
    // node answering is_paid has not seen rows 3 and 4 paid yet. Each lags once.
    let stale: xdr.ScVal | undefined;
    const submit: ChainPort['submit'] = chain.submit.bind(chain);
    chain.submit = async (signed) => {
      if (chain.submitted.length === 1) stale = accountStruct(chain.accounts.get(treasury) as AccountState);
      return submit(signed);
    };
    let staleBalance = 1;
    const staleUnpaid = new Set([workers[2], workers[3]]);
    const read: ChainPort['read'] = chain.read.bind(chain);
    chain.read = async (contractId, method, args) => {
      const [first, , third] = args;
      if (stale !== undefined && method === 'confidential_balance' && staleBalance > 0 && first !== undefined && Address.fromScVal(first).toString() === treasury) {
        staleBalance--;
        return stale;
      }
      if (stale !== undefined && method === 'is_paid' && third !== undefined && staleUnpaid.delete(Address.fromScVal(third).toString())) return xdr.ScVal.scvBool(false);
      return read(contractId, method, args);
    };

    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentInFlightError);
    expect([(err as PaymentInFlightError).reason, (err as PaymentInFlightError).rebuildable]).toEqual(['UNCONFIRMED', false]);
    expect(chain.submitted).toHaveLength(2);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 0]);
    expect(store.data.has(inFlightRecordKey)).toBe(true);

    chain.read = read;
    chain.submit = submit;
    await expectResumes(input, chain, store, 4);
    expect(chain.submitted).toHaveLength(3);
  });

  it.each(RECOVERIES)('refuses to lock the treasury when a close time ahead of the chain settles a queued pay as dead and the rebuild collides with it, then recovers %s', async (recovery) => {
    const { chain, store, input } = setup();
    chain.failNext('HELD');
    const waitFor: ChainPort['waitFor'] = chain.waitFor.bind(chain);
    chain.waitFor = async (hash, timeoutMs) => {
      const result = await waitFor(hash, timeoutMs).catch(() => ({ status: 'NOT_FOUND' as const }));
      return result.status === 'NOT_FOUND' ? { status: 'NOT_FOUND', closeTime: chain.closeTime + 100_000 } : result;
    };
    const submit: ChainPort['submit'] = chain.submit.bind(chain);
    let submits = 0;
    chain.submit = async (signed) => {
      submits++;
      // The queued pay is applied by the network just before the rebuilt one reaches it.
      if (submits === 2) chain.land();
      return submit(signed);
    };

    // The queued pay paid lines 1 and 2 after this call had judged it dead, so it says so and stops.
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidElsewhereError);
    expect((err as PaidElsewhereError).lines).toEqual([1, 2]);
    expect(submits).toBe(2);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 0, 0, 0]);
    // The dead-looking pay's opening stayed a candidate and was adopted once it landed.
    expect(treasuryOpening(store)?.commitment.equals(chainSpendable(chain))).toBe(true);

    chain.waitFor = waitFor;
    chain.submit = submit;
    await recover(recovery, input, chain, store, 2);
    await expectResumes(input, chain, store, 2);
  });

  it.each(RECOVERIES)('refuses to lock the treasury when a second tab settles its refused pay after the first tab closed mid-pay, then recovers %s', async (recovery) => {
    const a = setup();
    const closedA = deferred();
    // Tab B shares the device store. Its settle is slower than tab A's crash.
    const storeB: OpeningStore = {
      get: (key) => a.store.get(key),
      put: (key, value) => a.store.put(key, value),
      delete: async (key) => {
        await closedA.promise;
        await a.store.delete(key);
      },
    };
    const inputB: RunInput = { ...a.input, store: storeB };
    // Tab A's second pay is applied, then its connection drops (the tab is closed).
    a.chain.failNext('OK', 'CRASH');

    const [tabA, tabB] = await Promise.allSettled([executeRun(a.input).finally(() => closedA.resolve()), executeRun(inputB)]);
    expect(tabA.status).toBe('rejected');
    expect(String((tabA as PromiseRejectedResult).reason)).toMatch(/connection lost/);
    expect(tabB.status).toBe('rejected');
    expect((tabB as PromiseRejectedResult).reason).toBeInstanceOf(PaidElsewhereError);
    expect(transfersPerWorker(a.chain)).toEqual([1, 1, 1, 1, 0]);

    a.chain.settle();
    await recover(recovery, a.input, a.chain, a.store, 4);
    await expectResumes(a.input, a.chain, a.store, 4);
  });

  it('refuses to pay anyone twice when two tabs run the same run at once, and tells the loser the rows were paid elsewhere', async () => {
    const a = setup();
    const inputB: RunInput = { ...a.input };
    const outcomes = await Promise.allSettled([executeRun(a.input), executeRun(inputB)]);
    expect(transfersPerWorker(a.chain)).toEqual([1, 1, 1, 1, 1]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(PaidElsewhereError);
    expect(treasuryOpening(a.store)?.commitment.equals(chainSpendable(a.chain))).toBe(true);
    const again = await executeRun(a.input);
    expect(again.rows.map((r) => r.status)).toEqual(Array(5).fill('already-paid'));
  });

  it('refuses every run over a damaged in-flight record until clearInFlight removes it, then runs from the chain', async () => {
    const { chain, store, input } = setup();
    store.data.set(inFlightRecordKey, { hash: 'f'.repeat(64), maxTime: 1, batchKey: 'kalypso/v1/batch/damaged' });
    for (let attempt = 0; attempt < 3; attempt++) {
      const err = await executeRun(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentInFlightError);
      expect((err as PaymentInFlightError).reason).toBe('UNREADABLE');
    }
    expect(store.data.has(inFlightRecordKey)).toBe(true);
    expect([chain.simulations, chain.submitted.length]).toEqual([0, 0]);

    await clearInFlight(store, CONTRACTS.token, treasury);
    await expectResumes(input, chain, store, 0);
  });
});

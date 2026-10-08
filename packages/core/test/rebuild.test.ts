// rebuildTreasuryOpening in src/run/rebuild.ts: a new device, a record a merge left unmatched, a
// device record that disagrees with the chain, every refusal, and the grace after which
// UNCONFIRMED becomes rebuildable. The stand-in prover, store and
// FakeChain are the ones engine.test.ts uses, and the FakeChain serves the treasury's real token
// events, so every opening the rebuild recovers is opened from a real b_tilde. Does NOT cover:
// real proofs, the live network, the archive as a history source (worker.test.ts reads it through
// the same loadAccountBalance), or the three lock attacks (engine-inflight-attacks.test.ts).
import { TransactionBuilder, type Keypair } from '@stellar/stellar-sdk/base';
import { addressToField, buildTransferWitness, commit, deriveKeys, encodeTransferData, H, IDENTITY, pointToBytes, scalarMul, type TransferParams } from 'stellar-confidential-token-sdk';
import { describe, expect, it } from 'vitest';
import { formatUsdc } from '../src/amounts.js';
import { ContractCallError, type InFlightPay, type OpeningStore, type SavedOpening } from '../src/chain/ports.js';
import { parsePayrollCsv } from '../src/csv.js';
import type { EventsPort } from '../src/history/rpc-events.js';
import type { KalypsoKeys } from '../src/keys.js';
import type { ProverPort, TransferEnvelope } from '../src/prover/port.js';
import { PaymentInFlightError, PreflightError, UNCONFIRMED_GRACE_SECONDS, clearInFlight, executeRun, type RunInput } from '../src/run/engine.js';
import { rebuildTreasuryOpening, type RebuildInput } from '../src/run/rebuild.js';
import { HistoryIncompleteError, attemptsKey, batchOpeningKey, readAttempts, readSavedOpening, saveAttempts, toSavedOpening, treasuryOpeningKey } from '../src/run/treasury.js';
import { FakeChain, type AccountState } from './fake-chain.js';
import { PASSPHRASE, testAccount, testContract } from './independent-xdr.js';

async function standInProof(params: TransferParams): Promise<TransferEnvelope> {
  const witness = buildTransferWitness(params);
  const proof = new Uint8Array([commit(params.v, params.r), params.kAudR, params.kAudS, params.pvkB].flatMap((point) => [...pointToBytes(point)]));
  return { payload: new Uint8Array(encodeTransferData(witness, proof).bytes()), proof, recipientView: witness.recipientView, next: witness.next, rEScalar: witness.rEScalar };
}
const unused = async (): Promise<never> => {
  throw new Error('the payroll engine only proves transfers');
};
const prover: ProverPort = { proveTransfer: standInProof, proveRegister: unused, proveWithdraw: unused };

const CONTRACTS = { payroll: testContract(31), token: testContract(32), auditor: testContract(33) };
const COMPANY = 7n;
const RUN = 202610n;
const adminKey = testAccount('rebuild admin');
const treasury = adminKey.publicKey();
const workers = Array.from({ length: 5 }, (_, i) => testAccount(`rebuild worker ${i}`).publicKey());
const AMOUNTS = [1_908_190_1n, 8_801_919_09n, 1_000_000_81n, 9_181_009_1n, 81_900_190_8n];
const FUNDS = 100_000_0000000n;
const AFTER_FIRST_BATCH = FUNDS - (AMOUNTS[0] as bigint) - (AMOUNTS[1] as bigint);
const keysOf = (seed: bigint): KalypsoKeys => {
  const addrF = addressToField(CONTRACTS.token);
  const acctF = addressToField(treasury);
  return { ...deriveKeys(seed, addrF, acctF), addrF, acctF };
};
const keys = keysOf(0x5eed_1234_abcdn);
const treasuryKey = treasuryOpeningKey(CONTRACTS.token, treasury);
const inFlightRecordKey = `kalypso/v1/inflight/${CONTRACTS.token}/${treasury}`;
const listKey = attemptsKey(CONTRACTS.token, treasury);

type Stored = SavedOpening | InFlightPay | readonly string[];

function memoryStore(): OpeningStore & { data: Map<string, Stored>; writes: string[] } {
  const data = new Map<string, Stored>();
  const writes: string[] = [];
  return {
    data,
    writes,
    get: async (key) => data.get(key),
    put: async (key, value) => {
      writes.push(`put ${key}`);
      data.set(key, value);
    },
    delete: async (key) => {
      writes.push(`delete ${key}`);
      data.delete(key);
    },
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

const csvRows = (addresses: string[]) => parsePayrollCsv(addresses.map((a, i) => `${a},${formatUsdc(AMOUNTS[i] as bigint)}`).join('\n')).rows;

function setup() {
  const chain = new FakeChain(CONTRACTS);
  chain.companies.set(COMPANY, { admin: treasury, auditorId: 0, activeWorkers: workers.length });
  chain.runs.set(`${COMPANY}/${RUN}`, { open: true, expected: workers.length, paid: 0 });
  chain.auditorKeys.set(0, scalarMul(1001n, H));
  chain.accounts.set(treasury, { auditorId: 0, spendingKey: keys.Y, pvk: keys.PVK, spendable: IDENTITY, receiving: IDENTITY });
  chain.recordRegister(treasury);
  chain.depositAndMerge(treasury, FUNDS);
  chain.sequences.set(treasury, 500n);
  workers.forEach((worker, i) => {
    chain.workers.set(`${COMPANY}/${worker}`, 'Active');
    chain.auditorKeys.set(10 + i, scalarMul(2000n + BigInt(i), H));
    chain.accounts.set(worker, { auditorId: 10 + i, spendingKey: scalarMul(3000n + BigInt(i), H), pvk: scalarMul(4000n + BigInt(i), H), spendable: IDENTITY, receiving: IDENTITY });
  });
  const store = memoryStore();
  store.data.set(treasuryKey, toSavedOpening(FUNDS, 0n));
  const input: RunInput = { port: chain, signer: signerFor(adminKey), store, networkPassphrase: PASSPHRASE, contracts: CONTRACTS, companyId: COMPANY, runId: RUN, rows: csvRows(workers), keys, prover };
  const rebuild = (over: Partial<RebuildInput> = {}) =>
    rebuildTreasuryOpening({ port: chain, store, history: { rpc: chain.rpc(), fromLedger: chain.historyStart }, payroll: CONTRACTS.payroll, token: CONTRACTS.token, treasury, keys, ...over });
  return { chain, store, input, rebuild };
}

const statuses = (report: Awaited<ReturnType<typeof executeRun>>) => report.rows.map((r) => r.status);
const transfersPerWorker = (chain: FakeChain) => workers.map((w) => chain.transfersTo.get(w) ?? 0);
const opensChain = (store: ReturnType<typeof memoryStore>, chain: FakeChain) =>
  readSavedOpening(store.data.get(treasuryKey))?.commitment.equals((chain.accounts.get(treasury) as AccountState).spendable);
const batchKeys = (store: ReturnType<typeof memoryStore>) => [...store.data.keys()].filter((key) => key.startsWith('kalypso/v1/batch/'));
const batchKey = (txHash: string) => batchOpeningKey({ payroll: CONTRACTS.payroll, companyId: COMPANY, runId: RUN, firstWorker: workers[0] as string, txHash });

describe('rebuildTreasuryOpening: back to paying from the chain (C13, C16, C38)', () => {
  it('lets a new device with an empty store rebuild, then pay the remaining rows with no lock', async () => {
    const { chain, input, rebuild } = setup();
    expect(statuses(await executeRun({ ...input, rows: csvRows(workers.slice(0, 2)) }))).toEqual(['paid', 'paid']);

    const fresh = memoryStore();
    const onNewDevice: RunInput = { ...input, store: fresh };
    const refused = await executeRun(onNewDevice).catch((e: unknown) => e);
    expect([(refused as HistoryIncompleteError).reason, (refused as HistoryIncompleteError).rebuildable]).toEqual(['NO_SAVED_OPENING', true]);
    expect(chain.submitted).toHaveLength(1);

    expect(await rebuild({ store: fresh })).toEqual({ value: AFTER_FIRST_BATCH, deviceExpected: undefined, matchesDevice: false });
    expect(statuses(await executeRun(onNewDevice))).toEqual(['already-paid', 'already-paid', 'paid', 'paid', 'paid']);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(opensChain(fresh, chain)).toBe(true);
  });

  it('clears a pay record that a deposit and merge left unmatched, shows both numbers, and the next run carries on', async () => {
    const { chain, store, input, rebuild } = setup();
    chain.failNext('CRASH');
    expect(String(await executeRun(input).catch((e: unknown) => e))).toMatch(/connection lost/);
    chain.settle();
    chain.depositAndMerge(treasury, 5_000n);

    for (let attempt = 0; attempt < 2; attempt++) {
      const err = await executeRun(input).catch((e: unknown) => e);
      expect([(err as PaymentInFlightError).reason, (err as PaymentInFlightError).rebuildable]).toEqual(['DOES_NOT_MATCH_CHAIN', true]);
    }
    expect(chain.submitted).toHaveLength(1);

    // The device expected what its own pay left; the chain also holds the top-up it never saw.
    expect(await rebuild()).toEqual({ value: AFTER_FIRST_BATCH + 5_000n, deviceExpected: AFTER_FIRST_BATCH, matchesDevice: false });
    expect([store.data.has(inFlightRecordKey), store.data.has(listKey), batchKeys(store)]).toEqual([false, false, []]);
    expect(statuses(await executeRun(input))).toEqual(['already-paid', 'already-paid', 'paid', 'paid', 'paid']);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(opensChain(store, chain)).toBe(true);
  });

  it('reports a device record that disagrees with the chain with both numbers, newest attempt first, and agrees once rebuilt', async () => {
    const { store, rebuild } = setup();
    store.data.set(treasuryKey, toSavedOpening(FUNDS - 1n, 7n));
    const older = batchKey('ab'.repeat(32));
    const damaged = batchKey('cd'.repeat(32));
    store.data.set(older, toSavedOpening(FUNDS - 2n, 9n));
    store.data.set(damaged, { ...toSavedOpening(FUNDS - 3n, 9n), v: '1' });
    store.data.set(listKey, [older, damaged]);

    expect(await rebuild()).toEqual({ value: FUNDS, deviceExpected: FUNDS - 2n, matchesDevice: false });
    expect([store.data.has(listKey), batchKeys(store)]).toEqual([false, []]);
    expect(await rebuild()).toEqual({ value: FUNDS, deviceExpected: FUNDS, matchesDevice: true });
  });

  it('keeps an attempt another tab lists while the rebuild reads history', async () => {
    const { chain, store, rebuild } = setup();
    const mine = batchKey('ab'.repeat(32));
    const theirs = batchKey('ef'.repeat(32));
    store.data.set(mine, toSavedOpening(FUNDS - 2n, 9n));
    store.data.set(listKey, [mine]);
    const rpc = chain.rpc();
    const slowTab: EventsPort = {
      ledgerWindow: () => rpc.ledgerWindow(),
      contractEvents: async (query) => {
        await store.put(theirs, toSavedOpening(FUNDS - 4n, 9n));
        await saveAttempts(store, CONTRACTS.token, treasury, [...(readAttempts(store.data.get(listKey)) ?? []), theirs]);
        return rpc.contractEvents(query);
      },
    };
    expect((await rebuild({ history: { rpc: slowTab, fromLedger: chain.historyStart } })).value).toBe(FUNDS);
    expect([readAttempts(store.data.get(listKey)), batchKeys(store)]).toEqual([[theirs], [theirs]]);
  });
});

describe('rebuildTreasuryOpening refusals: nothing is written (C14, C16, C29)', () => {
  it('throws NOT_REBUILT over a history that starts too late or leaves out an event', async () => {
    const { chain, store, rebuild } = setup();
    const before = [...store.data];
    const late = await rebuild({ history: { rpc: chain.rpc({ oldestLedger: chain.historyStart + 2 }), fromLedger: chain.historyStart } }).catch((e: unknown) => e);
    expect([(late as HistoryIncompleteError).reason, (late as HistoryIncompleteError).rebuildable]).toEqual(['NOT_REBUILT', false]);

    const rpc = chain.rpc();
    const noMerge: EventsPort = {
      ledgerWindow: () => rpc.ledgerWindow(),
      contractEvents: async (query) => {
        const page = await rpc.contractEvents(query);
        return { ...page, events: page.events.filter((e) => e.ledger !== chain.historyStart + 3) };
      },
    };
    const dropped = await rebuild({ history: { rpc: noMerge, fromLedger: chain.historyStart } }).catch((e: unknown) => e);
    expect((dropped as HistoryIncompleteError).reason).toBe('NOT_REBUILT');
    expect([store.writes, [...store.data]]).toEqual([[], before]);
  });

  it('cannot paper over a pay that left another balance than the one approved', async () => {
    const { chain, store, input, rebuild } = setup();
    chain.failNext('OK', 'TAMPER');
    expect(((await executeRun(input).catch((e: unknown) => e)) as PaymentInFlightError).reason).toBe('DOES_NOT_MATCH_CHAIN');
    const before = [...store.data];
    const writes = store.writes.length;
    expect(((await rebuild().catch((e: unknown) => e)) as HistoryIncompleteError).reason).toBe('NOT_REBUILT');
    expect([store.writes.length, [...store.data]]).toEqual([writes, before]);
    expect(((await executeRun(input).catch((e: unknown) => e)) as PaymentInFlightError).reason).toBe('DOES_NOT_MATCH_CHAIN');
  });

  it('throws PENDING while a pay may still land', async () => {
    const { chain, store, input, rebuild } = setup();
    chain.reportsCloseTime = false;
    chain.failNext('DROPPED');
    expect(((await executeRun(input).catch((e: unknown) => e)) as PaymentInFlightError).reason).toBe('PENDING');
    const before = [...store.data];
    const writes = store.writes.length;
    const err = await rebuild().catch((e: unknown) => e);
    expect([(err as PaymentInFlightError).reason, (err as PaymentInFlightError).rebuildable]).toEqual(['PENDING', false]);
    expect([store.writes.length, [...store.data]]).toEqual([writes, before]);
  });

  it('refuses a damaged in-flight record until clearInFlight removes it', async () => {
    const { store, rebuild } = setup();
    store.data.set(inFlightRecordKey, { hash: 'f'.repeat(64), maxTime: 1, batchKey: 'kalypso/v1/batch/damaged' });
    expect(((await rebuild().catch((e: unknown) => e)) as PaymentInFlightError).reason).toBe('UNREADABLE');
    expect(store.writes).toEqual([]);
    await clearInFlight(store, CONTRACTS.token, treasury);
    expect((await rebuild()).matchesDevice).toBe(true);
  });

  it('refuses keys that are not the treasury\'s, an unregistered treasury and bad settings, naming no amount (C12)', async () => {
    const { chain, store, rebuild } = setup();
    const errors = [
      await rebuild({ keys: keysOf(0x0bad_5eedn) }).catch((e: unknown) => e),
      await rebuild({ treasury: testAccount('rebuild stranger').publicKey() }).catch((e: unknown) => e),
      await rebuild({ token: 'not a contract' }).catch((e: unknown) => e),
      await rebuild({ keys: undefined as unknown as KalypsoKeys }).catch((e: unknown) => e),
    ];
    expect(errors.map((e) => (e instanceof PreflightError ? e.code : (e as HistoryIncompleteError).reason))).toEqual([
      'KEYS_MISMATCH',
      'NOT_REGISTERED',
      'INVALID_INPUT',
      'INVALID_INPUT',
    ]);
    expect((errors[1] as HistoryIncompleteError).rebuildable).toBe(false);
    for (const e of errors) expect((e as Error).message).not.toMatch(/\d{5,}/);
    expect([store.writes, chain.submitted]).toEqual([[], []]);
  });
});

describe('UNCONFIRMED does not last forever (C13, C38)', () => {
  const reasonOf = (err: unknown) => [(err as PaymentInFlightError).reason, (err as PaymentInFlightError).rebuildable];
  const recordMaxTime = (store: ReturnType<typeof memoryStore>) => (store.data.get(inFlightRecordKey) as InFlightPay).maxTime;

  it('gives a SUCCESS the balance does not show UNCONFIRMED until the chain clock passes the grace, then DOES_NOT_MATCH_CHAIN, which a rebuild clears', async () => {
    const { chain, store, input, rebuild } = setup();
    chain.failNext('LYING_SUCCESS');
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['UNCONFIRMED', false]);
    const maxTime = recordMaxTime(store);

    chain.closeTime = maxTime + UNCONFIRMED_GRACE_SECONDS;
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['UNCONFIRMED', false]);
    chain.closeTime++;
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['DOES_NOT_MATCH_CHAIN', true]);
    expect(store.data.has(inFlightRecordKey)).toBe(true);

    expect(await rebuild()).toEqual({ value: FUNDS, deviceExpected: AFTER_FIRST_BATCH, matchesDevice: false });
    expect(statuses(await executeRun(input))).toEqual(Array(5).fill('paid'));
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
  });

  it('keeps UNCONFIRMED past the grace when the chain cannot say what time it is', async () => {
    const { chain, store, input } = setup();
    chain.failNext('LYING_SUCCESS');
    await executeRun(input).catch(() => undefined);
    chain.closeTime = recordMaxTime(store) + UNCONFIRMED_GRACE_SECONDS + 1;
    const latestLedger = chain.latestLedger.bind(chain);
    chain.latestLedger = async () => {
      throw new Error('getLatestLedger did not answer');
    };
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['UNCONFIRMED', false]);
    chain.latestLedger = async () => ({ sequence: chain.ledger, closeTime: Number.POSITIVE_INFINITY });
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['UNCONFIRMED', false]);
    chain.latestLedger = latestLedger;
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['DOES_NOT_MATCH_CHAIN', true]);
  });

  it('counts a balance read that names no account as behind until the grace has passed', async () => {
    const { chain, store, input } = setup();
    chain.failNext('CRASH');
    await executeRun(input).catch(() => undefined);
    chain.settle();
    const read = chain.read.bind(chain);
    chain.read = async (contractId, method, args) => {
      if (method === 'confidential_balance') throw new ContractCallError(method, 3501);
      return read(contractId, method, args);
    };
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['UNCONFIRMED', false]);
    chain.closeTime = recordMaxTime(store) + UNCONFIRMED_GRACE_SECONDS + 1;
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['DOES_NOT_MATCH_CHAIN', true]);
    expect(chain.submitted).toHaveLength(1);
  });

  it('recovers a rebuild cut short between saving the opening and removing the record, on the next run past the grace', async () => {
    const { chain, store, input, rebuild } = setup();
    chain.failNext('CRASH');
    await executeRun(input).catch(() => undefined);
    chain.settle();
    chain.depositAndMerge(treasury, 5_000n);
    const remove = store.delete;
    store.delete = async (key) => {
      if (key === inFlightRecordKey) throw new Error('the tab was closed');
      return remove(key);
    };
    expect(String(await rebuild().catch((e: unknown) => e))).toMatch(/tab was closed/);
    store.delete = remove;
    // The saved opening opens the chain, but the record of a pay it already covers is still there.
    expect([opensChain(store, chain), store.data.has(inFlightRecordKey)]).toEqual([true, true]);

    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['UNCONFIRMED', false]);
    chain.closeTime = recordMaxTime(store) + UNCONFIRMED_GRACE_SECONDS + 1;
    expect(reasonOf(await executeRun(input).catch((e: unknown) => e))).toEqual(['DOES_NOT_MATCH_CHAIN', true]);
    expect((await rebuild()).value).toBe(AFTER_FIRST_BATCH + 5_000n);
    expect(statuses(await executeRun(input))).toEqual(['already-paid', 'already-paid', 'paid', 'paid', 'paid']);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(opensChain(store, chain)).toBe(true);
  });
});

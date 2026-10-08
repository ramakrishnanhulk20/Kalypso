// Does NOT cover: real proofs, fees or the live network (scratchpad/m5b2/e2e-run.mjs runs the
// engine on testnet), a wallet that shows the hidden amount (none can), or several tabs paying
// the same run at once from one store (engine-inflight-attacks.test.ts runs those; another
// device is held off by the network's one-transaction-per-account queue and the contract's paid
// flags, not by this engine). The injected prover is a stand-in built
// on the real SDK witness builder with a fake proof, so commitments, salts and openings are real.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TransactionBuilder, type Keypair } from '@stellar/stellar-sdk/base';
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressError } from '../src/addresses.js';
import { formatUsdc } from '../src/amounts.js';
import type { InFlightPay, OpeningStore, SavedOpening } from '../src/chain/ports.js';
import { decodeInvocation } from '../src/chain/tx.js';
import { CSV_DEFAULT_MAX_ROWS, parsePayrollCsv } from '../src/csv.js';
import type { KalypsoKeys } from '../src/keys.js';
import type { ProverPort, TransferEnvelope } from '../src/prover/port.js';
import {
  AmountMismatchError,
  PUBLISHED_DEMO_AUDITOR_IDS,
  PaidElsewhereError,
  PaymentInFlightError,
  PreflightError,
  SignedTransactionMismatchError,
  clearInFlight,
  executeRun,
  type PreflightErrorCode,
  type RowStatus,
  type RunInput,
} from '../src/run/engine.js';
import {
  HistoryIncompleteError,
  attemptsKey,
  batchOpeningKey,
  readAttempts,
  readSavedOpening,
  saveAttempts,
  toSavedOpening,
  treasuryOpeningKey,
} from '../src/run/treasury.js';
import { FakeChain, readTransferData, type AccountState } from './fake-chain.js';
import { PASSPHRASE, testAccount, testContract } from './independent-xdr.js';

// Pass-through spy, so one test can hand the engine an invocation whose record would not read back.
vi.mock(import('../src/chain/tx.js'), async (importOriginal) => {
  const tx = await importOriginal();
  return { ...tx, decodeInvocation: vi.fn(tx.decodeInvocation) };
});

// The fake proof carries the commitment and the three keys it was built on, which the fake
// token checks against chain state as the real verifier reads its public inputs.
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

const prove = vi.fn(standInProof);
const unused = async (): Promise<never> => {
  throw new Error('the payroll engine only proves transfers');
};
const prover: ProverPort = { proveTransfer: prove, proveRegister: unused, proveWithdraw: unused };

const CONTRACTS = { payroll: testContract(11), token: testContract(12), auditor: testContract(13) };
const COMPANY = 7n;
const RUN = 202610n;
const adminKey = testAccount('engine admin');
const treasury = adminKey.publicKey();
const workers = Array.from({ length: 5 }, (_, i) => testAccount(`engine worker ${i}`).publicKey());
// Distinctive amounts with digits 0, 1, 8 and 9, which never appear in a Stellar address.
const AMOUNTS = [1_908_190_1n, 8_801_919_09n, 1_000_000_81n, 9_181_009_1n, 81_900_190_8n];
const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0n);
const FUNDS = 100_000_0000000n;
const keys: KalypsoKeys = (() => {
  const addrF = addressToField(CONTRACTS.token);
  const acctF = addressToField(treasury);
  return { ...deriveKeys(0x5eed_1234_abcdn, addrF, acctF), addrF, acctF };
})();
const treasuryKey = treasuryOpeningKey(CONTRACTS.token, treasury);
// Spelled out rather than imported, so a change to the key format fails here.
const inFlightRecordKey = `kalypso/v1/inflight/${CONTRACTS.token}/${treasury}`;
const attemptsListKey = `kalypso/v1/attempts/${CONTRACTS.token}/${treasury}`;

type Stored = SavedOpening | InFlightPay | readonly string[];

function memoryStore(timeline: string[]): OpeningStore & { data: Map<string, Stored> } {
  const data = new Map<string, Stored>();
  const kind = (key: string) =>
    key.startsWith('kalypso/v1/batch/') ? 'batch' : key === inFlightRecordKey ? 'inflight' : key === attemptsListKey ? 'attempts' : 'treasury';
  return {
    data,
    get: async (key) => data.get(key),
    put: async (key, value) => {
      timeline.push(`put:${kind(key)}`);
      data.set(key, value);
    },
    delete: async (key) => {
      timeline.push(`delete:${kind(key)}`);
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

const csvRows = (addresses: string[], amounts = AMOUNTS) =>
  parsePayrollCsv(addresses.map((a, i) => `${a},${formatUsdc(amounts[i] as bigint)}`).join('\n')).rows;

function setup(funds = FUNDS, contracts = CONTRACTS) {
  const chain = new FakeChain(contracts);
  chain.companies.set(COMPANY, { admin: treasury, auditorId: 0, activeWorkers: workers.length });
  chain.runs.set(`${COMPANY}/${RUN}`, { open: true, expected: workers.length, paid: 0 });
  chain.auditorKeys.set(0, scalarMul(1001n, H));
  chain.accounts.set(treasury, { auditorId: 0, spendingKey: keys.Y, pvk: keys.PVK, spendable: commit(funds, 0n), receiving: IDENTITY });
  chain.sequences.set(treasury, 500n);
  workers.forEach((worker, i) => {
    chain.workers.set(`${COMPANY}/${worker}`, 'Active');
    chain.auditorKeys.set(10 + i, scalarMul(2000n + BigInt(i), H));
    chain.accounts.set(worker, { auditorId: 10 + i, spendingKey: scalarMul(3000n + BigInt(i), H), pvk: scalarMul(4000n + BigInt(i), H), spendable: IDENTITY, receiving: IDENTITY });
  });
  const store = memoryStore(chain.timeline);
  store.data.set(treasuryKey, toSavedOpening(funds, 0n));
  const events: { row: number; status: RowStatus }[] = [];
  const input: RunInput = {
    port: chain,
    signer: signerFor(adminKey),
    store,
    networkPassphrase: PASSPHRASE,
    contracts,
    companyId: COMPANY,
    runId: RUN,
    rows: csvRows(workers),
    keys,
    prover,
    onProgress: (e) => events.push(e),
  };
  return { chain, store, events, input };
}

const statuses = (report: Awaited<ReturnType<typeof executeRun>>) => report.rows.map((r) => r.status);
const transfersPerWorker = (chain: FakeChain) => workers.map((w) => chain.transfersTo.get(w) ?? 0);
const treasuryOpening = (store: ReturnType<typeof memoryStore>) => readSavedOpening(store.data.get(treasuryKey));
const batchKeys = (store: ReturnType<typeof memoryStore>) => [...store.data.keys()].filter((key) => key.startsWith('kalypso/v1/batch/'));
const attempts = (store: ReturnType<typeof memoryStore>) => readAttempts(store.data.get(attemptsListKey));
const chainSpendable = (chain: FakeChain) => (chain.accounts.get(treasury) as AccountState).spendable;
const unbuildable = async (): Promise<never> => {
  throw new Error('the circuit refused the witness');
};
const sigmaOfCall = async (i: number) => readTransferData((await prove.mock.results[i]?.value).payload).sigma;

/** Runs change once, just before the engine first waits on the n-th submitted transaction. */
function onFirstWait(chain: FakeChain, n: number, change: () => unknown) {
  const waitFor = chain.waitFor.bind(chain);
  let done = false;
  chain.waitFor = async (hash, timeoutMs) => {
    if (!done && hash === chain.submitted[n]) {
      done = true;
      await change();
    }
    return waitFor(hash, timeoutMs);
  };
}

// Another tab's pay of 5,000 stroops from another company, landing on top of whatever the chain holds.
const OTHER_PAY_LEFT = FUNDS - 5_000n;
const otherKey = batchOpeningKey({ payroll: CONTRACTS.payroll, companyId: 8n, runId: RUN, firstWorker: workers[0] as string, txHash: 'ab'.repeat(32) });

/** The other tab lists its opening after ours, as it would, and the chain balance moves to it. */
async function landOnTop(chain: FakeChain, store: ReturnType<typeof memoryStore>) {
  await store.put(otherKey, toSavedOpening(OTHER_PAY_LEFT, 4242n));
  await saveAttempts(store, CONTRACTS.token, treasury, [...(attempts(store) ?? []), otherKey]);
  (chain.accounts.get(treasury) as AccountState).spendable = commit(OTHER_PAY_LEFT, 4242n);
}

afterEach(() => {
  prove.mockClear();
  vi.restoreAllMocks();
});

describe('executeRun on a clean run', () => {
  it('pays 5 rows in 3 transactions, one at a time, saving each opening and the in-flight record before submitting', async () => {
    const { chain, store, events, input } = setup();
    const report = await executeRun(input);

    expect(chain.submitted).toHaveLength(3);
    expect(chain.violations).toEqual([]);
    expect(report.transactions).toEqual(chain.submitted);
    expect(statuses(report)).toEqual(['paid', 'paid', 'paid', 'paid', 'paid']);
    const [t1, t2, t3] = chain.submitted;
    expect(report.rows.map((r) => [r.line, r.txHash])).toEqual([[1, t1], [2, t1], [3, t2], [4, t2], [5, t3]]);
    expect(report.rows.map((r) => r.address)).toEqual(workers);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    // Each later batch's adoption passes the one before it, which is then unlisted and removed.
    const batch = ['put:batch', 'put:attempts', 'put:inflight', 'submit', 'put:treasury', 'delete:inflight'];
    expect(chain.timeline).toEqual(['put:treasury', ...batch, ...batch, 'put:attempts', 'delete:batch', ...batch, 'put:attempts', 'delete:batch']);
    expect(store.data.has(inFlightRecordKey)).toBe(false);
    expect(batchKeys(store).map((key) => key.slice(-64))).toEqual([t3]);
    expect(attempts(store)).toEqual(batchKeys(store));

    const left = treasuryOpening(store);
    expect(left?.v).toBe(FUNDS - TOTAL);
    expect(left?.commitment.equals(chain.accounts.get(treasury)?.spendable as never)).toBe(true);
    expect(events.filter((e) => e.row === 1).map((e) => e.status)).toEqual(['proving', 'submitted', 'paid']);
    expect(events.filter((e) => e.row === 5).map((e) => e.status)).toEqual(['proving', 'submitted', 'paid']);
  });

  it('reads every key from chain and proves each transfer on the previous one', async () => {
    const { chain, input } = setup();
    await executeRun(input);
    const calls = prove.mock.calls.map(([p]) => p);
    expect(calls.map((p) => p.amount)).toEqual(AMOUNTS);
    calls.forEach((p, i) => {
      expect(p.pvkB.equals(chain.accounts.get(workers[i] as string)?.pvk as never)).toBe(true);
      expect(p.kAudR.equals(chain.auditorKeys.get(10 + i) as never)).toBe(true);
      expect(p.kAudS.equals(chain.auditorKeys.get(0) as never)).toBe(true);
      expect(p.sigma).toBeUndefined();
      expect(p.rE).toBeUndefined();
    });
    expect(calls[1]?.v).toBe(FUNDS - (AMOUNTS[0] as bigint));
    expect(calls[2]?.v).toBe(FUNDS - (AMOUNTS[0] as bigint) - (AMOUNTS[1] as bigint));
  });

  it('pays nothing new when every row is already paid', async () => {
    const { chain, events, input } = setup();
    await executeRun(input);
    events.length = 0;
    const again = await executeRun(input);
    expect(statuses(again)).toEqual(Array(5).fill('already-paid'));
    expect(again.transactions).toEqual([]);
    expect(chain.submitted).toHaveLength(3);
    expect(events.map((e) => e.status)).toEqual(Array(5).fill('already-paid'));
  });
});

describe('executeRun when a transaction does not land cleanly', () => {
  it('retries a FAILED transaction once, with new proofs from chain state and fresh salts', async () => {
    const { chain, store, input } = setup();
    chain.failNext('FAILED');
    const written: string[] = [];
    const put = store.put;
    store.put = async (key, value) => {
      if (key.startsWith('kalypso/v1/batch/')) written.push(key);
      return put(key, value);
    };
    const report = await executeRun(input);

    expect(chain.submitted).toHaveLength(4);
    expect(report.transactions).toEqual(chain.submitted.slice(1));
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(prove).toHaveBeenCalledTimes(7);
    expect(prove.mock.calls[2]?.[0].v).toBe(FUNDS);
    expect(await sigmaOfCall(2)).not.toBe(await sigmaOfCall(0));
    expect(await sigmaOfCall(3)).not.toBe(await sigmaOfCall(1));
    expect(chain.violations).toEqual([]);
    // Each attempt's opening sat under its own hash, so the retry overwrote nothing. Openings the
    // chain has moved past are removed once a later pay is adopted.
    expect(written.map((key) => key.slice(-64))).toEqual(chain.submitted);
    expect(batchKeys(store)).toEqual([written.at(-1)]);
  });

  it('stops after failing on chain twice: those rows and every later row report failed, nothing is paid', async () => {
    const { chain, store, events, input } = setup();
    chain.failNext('FAILED', 'FAILED');
    const report = await executeRun(input);

    expect(chain.submitted).toHaveLength(2);
    expect(report.transactions).toEqual([]);
    expect(statuses(report)).toEqual(Array(5).fill('failed'));
    expect(report.rows.map((row) => row.reason)).toEqual(['TRANSACTION_FAILED', 'TRANSACTION_FAILED', 'RUN_STOPPED', 'RUN_STOPPED', 'RUN_STOPPED']);
    expect(transfersPerWorker(chain)).toEqual([0, 0, 0, 0, 0]);
    expect(events.filter((e) => e.status === 'failed').map((e) => e.row)).toEqual([1, 2, 3, 4, 5]);
    expect(treasuryOpening(store)?.v).toBe(FUNDS);
  });

  it('retries a transaction that was never seen once its validity window closed', async () => {
    const { chain, input } = setup();
    chain.failNext('OK', 'DROPPED');
    const report = await executeRun(input);
    expect(chain.submitted).toHaveLength(4);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
  });

  it('treats a batch as landed when its status was lost but the chain shows it paid', async () => {
    const { chain, input } = setup();
    chain.failNext('LOST_STATUS');
    const report = await executeRun(input);
    expect(chain.submitted).toHaveLength(3);
    expect(prove).toHaveBeenCalledTimes(5);
    expect(report.rows[0]?.txHash).toBe(chain.submitted[0]);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
  });

  it('retries after a failed simulation or a refused submit, which never reached the network', async () => {
    const first = setup();
    first.chain.simulationFailures = 1;
    expect(statuses(await executeRun(first.input))).toEqual(Array(5).fill('paid'));
    expect([first.chain.simulations, first.chain.submitted.length]).toEqual([4, 3]);

    const second = setup();
    second.chain.failNext('REJECTED');
    expect(statuses(await executeRun(second.input))).toEqual(Array(5).fill('paid'));
    expect(transfersPerWorker(second.chain)).toEqual([1, 1, 1, 1, 1]);
  });

  it('resumes after a crash right after submit without paying anyone twice', async () => {
    const { chain, store, input } = setup();
    chain.failNext('OK', 'CRASH');
    await expect(executeRun(input)).rejects.toThrow(/connection lost/);
    // Batch 2 landed, but the treasury record still holds batch 1's result.
    expect(treasuryOpening(store)?.commitment.equals(chain.accounts.get(treasury)?.spendable as never)).toBe(false);

    chain.settle();
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(['already-paid', 'already-paid', 'already-paid', 'already-paid', 'paid']);
    expect(chain.submitted).toHaveLength(3);
    expect(report.transactions).toEqual([chain.submitted[2]]);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(chain.violations).toEqual([]);
    expect(treasuryOpening(store)?.v).toBe(FUNDS - TOTAL);
  });
});

describe('executeRun keeps one pay per treasury in flight (C13)', () => {
  it('waits on a pay still in flight when resumed, never proves it again, and keeps its opening', async () => {
    const { chain, store, input } = setup();
    chain.failNext('OK', 'HELD');
    await expect(executeRun(input)).rejects.toThrow(/stopped answering/);
    const proofs = prove.mock.calls.length;

    await expect(executeRun(input)).rejects.toThrow(/stopped answering/);
    expect(prove.mock.calls.length).toBe(proofs);
    expect(chain.submitted).toHaveLength(2);

    chain.land();
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(['already-paid', 'already-paid', 'already-paid', 'already-paid', 'paid']);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(chain.submitted).toHaveLength(3);
    expect(chain.violations).toEqual([]);
    expect(store.data.has(inFlightRecordKey)).toBe(false);
    expect(treasuryOpening(store)?.v).toBe(FUNDS - TOTAL);
  });

  it('settles a pay that finished the run while nobody watched, before reading anything', async () => {
    const { chain, store, input } = setup();
    chain.failNext('OK', 'OK', 'HELD');
    await expect(executeRun(input)).rejects.toThrow(/stopped answering/);
    chain.land();
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('already-paid'));
    expect(chain.submitted).toHaveLength(3);
    expect(store.data.has(inFlightRecordKey)).toBe(false);
    expect(treasuryOpening(store)?.v).toBe(FUNDS - TOTAL);
  });

  it('settles a submit whose reply was lost after the network took it through the in-flight record', async () => {
    const { chain, store, input } = setup();
    chain.failNext('TIMEOUT_AFTER_ACCEPT');
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(report.rows[0]?.txHash).toBe(chain.submitted[0]);
    expect(chain.submitted).toHaveLength(3);
    expect(prove).toHaveBeenCalledTimes(5);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(store.data.has(inFlightRecordKey)).toBe(false);
  });

  it("never treats NOT_FOUND without the chain's close time as final: the run is refused, not retried", async () => {
    const { chain, store, input } = setup();
    chain.failNext('DROPPED');
    chain.reportsCloseTime = false;
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentInFlightError);
    expect((err as PaymentInFlightError).reason).toBe('PENDING');
    expect([chain.submitted.length, prove.mock.calls.length]).toEqual([1, 2]);
    expect(store.data.has(inFlightRecordKey)).toBe(true);

    chain.reportsCloseTime = true;
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(chain.submitted).toHaveLength(4);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
  });

  it("judges a dropped pay's window by the chain's clock, even with the chain 10 minutes behind this machine", async () => {
    const { chain, input } = setup();
    chain.closeTime -= 600;
    chain.failNext('DROPPED');
    const sent: { maxTime: number; chainTime: number }[] = [];
    const submit = chain.submit.bind(chain);
    chain.submit = async (signed) => {
      sent.push({ maxTime: decodeInvocation(signed, PASSPHRASE).maxTime, chainTime: chain.closeTime });
      return submit(signed);
    };
    expect(statuses(await executeRun(input))).toEqual(Array(5).fill('paid'));
    expect(sent[1]?.chainTime).toBeGreaterThan((sent[0]?.maxTime as number) + 30);
  });

  it('refuses to run over a damaged in-flight record and sends nothing', async () => {
    const { chain, store, input } = setup();
    store.data.set(inFlightRecordKey, toSavedOpening(1n, 1n));
    const err = await executeRun(input).catch((e: unknown) => e);
    expect((err as PaymentInFlightError).reason).toBe('UNREADABLE');
    expect([chain.simulations, chain.submitted.length, prove.mock.calls.length]).toEqual([0, 0, 0]);
  });
});

describe('executeRun survives a key rotation', () => {
  // Worker 2, on CSV line 3, is registered under auditor id 12.
  const rotatedKey = (n: number) => scalarMul(7000n + BigInt(n), H);

  it("rebuilds a batch once, with keys re-read from chain, when a worker's auditor key rotates mid-run", async () => {
    const { chain, input } = setup();
    let rotations = 0;
    input.onProgress = (e) => {
      if (e.row === 3 && e.status === 'proving' && rotations === 0) chain.auditorKeys.set(12, rotatedKey(++rotations));
    };
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(chain.submitted).toHaveLength(3);
    expect(prove).toHaveBeenCalledTimes(7);
    expect(prove.mock.calls[2]?.[0].kAudR.equals(rotatedKey(1))).toBe(false);
    expect(prove.mock.calls[4]?.[0].kAudR.equals(rotatedKey(1))).toBe(true);
    expect(chain.violations).toEqual([]);
  });

  it("rebuilds with the company's auditor key re-read from chain, and later batches keep using it", async () => {
    const { chain, input } = setup();
    let rotated = false;
    input.onProgress = (e) => {
      if (e.row === 3 && e.status === 'proving' && !rotated) {
        rotated = true;
        chain.auditorKeys.set(0, rotatedKey(9));
      }
    };
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect([chain.simulations, chain.submitted.length]).toEqual([4, 3]);
    expect(prove.mock.calls.at(-1)?.[0].kAudS.equals(rotatedKey(9))).toBe(true);
  });

  it('fails only that batch when the rebuild still cannot be simulated, and pays every other batch', async () => {
    const { chain, input } = setup();
    let rotations = 0;
    input.onProgress = (e) => {
      if (e.row === 3 && e.status === 'proving') chain.auditorKeys.set(12, rotatedKey(++rotations));
    };
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(['paid', 'paid', 'failed', 'failed', 'paid']);
    expect(report.rows.map((row) => row.reason)).toEqual([undefined, undefined, 'SIMULATION_FAILED', 'SIMULATION_FAILED', undefined]);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 0, 0, 1]);
    expect(chain.submitted).toHaveLength(2);
    // The next batch starts from the same verified opening the failed one did.
    expect(prove.mock.calls.at(-1)?.[0].v).toBe(FUNDS - (AMOUNTS[0] as bigint) - (AMOUNTS[1] as bigint));
  });

  it('fails only that batch when its proof cannot be built twice', async () => {
    const { chain, input } = setup();
    prove.mockImplementationOnce(unbuildable).mockImplementationOnce(unbuildable);
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(['failed', 'failed', 'paid', 'paid', 'paid']);
    expect(report.rows[0]?.reason).toBe('PROOF_FAILED');
    expect([chain.simulations, chain.submitted.length]).toEqual([2, 2]);
  });
});

describe('executeRun checks what was paid against the CSV (C14)', () => {
  // After a SUCCESS, a balance that no saved opening opens, not even the treasury opening from
  // before the pay, is not a read that lags: the record is kept, every later run refuses, and the
  // console offers the rebuild, which shows the difference (rebuild.test.ts).
  it('stops, keeping the record, when the chain balance after a batch is not the approved one', async () => {
    const { chain, store, input } = setup();
    chain.failNext('OK', 'TAMPER');
    const err = await executeRun(input).catch((e: unknown) => e);
    expect((err as PaymentInFlightError).reason).toBe('DOES_NOT_MATCH_CHAIN');
    expect((err as PaymentInFlightError).rebuildable).toBe(true);
    expect(chain.submitted).toHaveLength(2);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 0]);
    expect(readSavedOpening(store.data.get(treasuryKey))?.v).toBe(FUNDS - (AMOUNTS[0] as bigint) - (AMOUNTS[1] as bigint));

    const proofs = prove.mock.calls.length;
    expect(((await executeRun(input).catch((e: unknown) => e)) as PaymentInFlightError).reason).toBe('DOES_NOT_MATCH_CHAIN');
    expect([chain.submitted.length, prove.mock.calls.length]).toEqual([2, proofs]);
    expect(store.data.has(inFlightRecordKey)).toBe(true);
  });

  // The contract sets every paid flag in the same call that moves the balance, so with the pay's
  // own opening on chain an unpaid row can only be a read behind the chain (NEW-1).
  it('stops with PAID_FLAGS_BEHIND, sending nothing more, when its own opening is on chain but a row reads unpaid', async () => {
    const { chain, store, input } = setup();
    chain.failNext('OK', 'OK');
    onFirstWait(chain, 1, () => chain.paid.delete(`${COMPANY}/${RUN}/${workers[3]}`));
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentInFlightError);
    expect([(err as PaymentInFlightError).reason, (err as PaymentInFlightError).rebuildable]).toEqual(['PAID_FLAGS_BEHIND', false]);
    expect((err as Error).message).toContain('paid marks are not readable yet');
    // The balance is settled: the pay's own opening was adopted and its record removed.
    expect([store.data.has(inFlightRecordKey), treasuryOpening(store)?.commitment.equals(chainSpendable(chain))]).toEqual([false, true]);
    expect(chain.submitted).toHaveLength(2);
  });

  it('never labels a row paid from a SUCCESS reply the chain does not back, and keeps the record (C13)', async () => {
    const { chain, store, events, input } = setup();
    chain.failNext('LYING_SUCCESS');
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentInFlightError);
    expect((err as PaymentInFlightError).reason).toBe('UNCONFIRMED');
    expect((err as PaymentInFlightError).rebuildable).toBe(false);
    expect(events.some((e) => e.status === 'paid')).toBe(false);
    expect(transfersPerWorker(chain)).toEqual([0, 0, 0, 0, 0]);
    expect(store.data.has(inFlightRecordKey)).toBe(true);
  });

  it('refuses a proof that moves even 1 stroop more than its row, before anything is sent', async () => {
    const { chain, input } = setup();
    prove.mockImplementationOnce((params) => standInProof({ ...params, amount: params.amount + 1n }));
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmountMismatchError);
    expect((err as AmountMismatchError).lines).toEqual([1]);
    expect([chain.simulations, chain.submitted.length]).toEqual([0, 0]);
  });
});

describe('executeRun settles a pay against every opening this device saved (C13, C29)', () => {
  it.each<['FAILED' | 'DROPPED', string]>([
    ['FAILED', 'TRANSACTION_FAILED'],
    ['DROPPED', 'TRANSACTION_EXPIRED'],
  ])('removes only the record of a %s pay: its opening stays listed until a later adoption passes it', async (mode, reason) => {
    const { chain, store, input } = setup();
    chain.failNext(mode, mode);
    const report = await executeRun(input);
    expect(report.rows[0]?.reason).toBe(reason);
    expect(store.data.has(inFlightRecordKey)).toBe(false);
    expect(attempts(store)?.map((key) => key.slice(-64))).toEqual(chain.submitted);
    expect(batchKeys(store)).toEqual(attempts(store));

    expect(statuses(await executeRun(input))).toEqual(Array(5).fill('paid'));
    expect(batchKeys(store).map((key) => key.slice(-64))).toEqual([chain.submitted.at(-1)]);
  });

  it('counts its batch as landed when its pay succeeded and a newer pay from another tab already moved the balance', async () => {
    const { chain, store, input } = setup();
    onFirstWait(chain, 0, () => landOnTop(chain, store));
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(report.rows.map((r) => r.txHash)).toEqual([chain.submitted[0], chain.submitted[0], chain.submitted[1], chain.submitted[1], chain.submitted[2]]);
    expect(prove.mock.calls[2]?.[0].v).toBe(OTHER_PAY_LEFT);
    expect(treasuryOpening(store)?.commitment.equals(chainSpendable(chain))).toBe(true);
    // Each adoption removed the keys listed before it: ours under the other tab's, then the other tab's under the next batch.
    expect(batchKeys(store).map((key) => key.slice(-64))).toEqual([chain.submitted[2]]);
  });

  it('stops with PAID_FLAGS_BEHIND when its pay succeeded under a newer balance but a row reads unpaid', async () => {
    const { chain, store, input } = setup();
    onFirstWait(chain, 0, async () => {
      await landOnTop(chain, store);
      chain.paid.delete(`${COMPANY}/${RUN}/${workers[1]}`);
    });
    const err = await executeRun(input).catch((e: unknown) => e);
    expect((err as PaymentInFlightError).reason).toBe('PAID_FLAGS_BEHIND');
    expect(chain.submitted).toHaveLength(1);
  });

  it('rebuilds from the newer opening when its own pay failed and nothing of the batch was paid', async () => {
    const { chain, store, input } = setup();
    chain.failNext('FAILED');
    onFirstWait(chain, 0, () => landOnTop(chain, store));
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(prove.mock.calls[2]?.[0].v).toBe(OTHER_PAY_LEFT);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
  });

  it('raises PaidElsewhereError, never AmountMismatchError, when its own pay failed and another paid the rows', async () => {
    const { chain, store, input } = setup();
    chain.failNext('FAILED');
    onFirstWait(chain, 0, async () => {
      await landOnTop(chain, store);
      for (const worker of workers.slice(0, 2)) chain.paid.add(`${COMPANY}/${RUN}/${worker}`);
    });
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidElsewhereError);
    expect((err as PaidElsewhereError).lines).toEqual([1, 2]);
    expect((err as Error).message).toBe('These rows were paid by another transaction, probably another tab or device. Nothing was paid twice. Reload the run.');
    expect(chain.submitted).toHaveLength(1);
  });

  it("leaves another tab's in-flight record alone: the record is deleted only while it holds the settled hash", async () => {
    const { chain, store, input } = setup();
    const otherRecord: InFlightPay = { hash: 'ab'.repeat(32), maxTime: chain.closeTime + 60, batchKey: otherKey };
    onFirstWait(chain, 0, () => store.put(inFlightRecordKey, otherRecord));
    let storedWhenBatchOnePaid: unknown;
    input.onProgress = (e) => {
      if (e.row === 1 && e.status === 'paid') storedWhenBatchOnePaid = store.data.get(inFlightRecordKey);
    };
    const report = await executeRun(input);
    expect(storedWhenBatchOnePaid).toEqual(otherRecord);
    // The next batch settled the other record first: never seen on chain, so it was removed then.
    expect(statuses(report)).toEqual(Array(5).fill('paid'));
    expect(store.data.has(inFlightRecordKey)).toBe(false);
  });

  it('reads a damaged attempts list as no candidates and replaces it on the next append', async () => {
    const { store, input } = setup();
    store.data.set(attemptsListKey, ['kalypso/v1/batch/not-a-key']);
    expect(statuses(await executeRun(input))).toEqual(Array(5).fill('paid'));
    expect(attempts(store)).toEqual(batchKeys(store));
  });

  it('never writes an in-flight record it could not read back, and sends nothing', async () => {
    const { chain, store, input } = setup();
    const decode = vi.mocked(decodeInvocation);
    decode.mockImplementationOnce((txXdr, passphrase) => ({ ...decode.getMockImplementation()!(txXdr, passphrase), maxTime: 0 }));
    const err = await executeRun(input).catch((e: unknown) => e);
    expect((err as PaymentInFlightError).reason).toBe('UNREADABLE');
    expect(chain.submitted).toHaveLength(0);
    expect(store.data.has(inFlightRecordKey)).toBe(false);
  });
});

describe('the attempts list and clearInFlight', () => {
  const key = (n: number) => batchOpeningKey({ payroll: CONTRACTS.payroll, companyId: COMPANY, runId: RUN, firstWorker: treasury, txHash: n.toString(16).padStart(64, '0') });

  it('pins the list key and reads back only a list of distinct batch keys', () => {
    expect(attemptsKey(CONTRACTS.token, treasury)).toBe(attemptsListKey);
    expect(() => attemptsKey(treasury, treasury)).toThrow(AddressError);
    expect(readAttempts([key(1), key(2)])).toEqual([key(1), key(2)]);
    expect(readAttempts([])).toEqual([]);
    for (const bad of [undefined, null, key(1), { 0: key(1) }, [key(1), key(1)], [key(1), 7], [`${key(1)}x`], [treasuryKey], [`${key(1).slice(0, -64)}${'AB'.repeat(32)}`], [`kalypso/v1/batch/${'x'.repeat(300)}/${'ab'.repeat(32)}`]]) {
      expect(readAttempts(bad)).toBeUndefined();
    }
    expect(readAttempts(Array.from({ length: CSV_DEFAULT_MAX_ROWS + 1 }, (_, i) => key(i)))).toBeUndefined();
  });

  it('keeps the newest keys when the list is over its cap, keeps a repeated key in its first place, and writes only batch keys', async () => {
    const { store } = setup();
    await saveAttempts(store, CONTRACTS.token, treasury, Array.from({ length: CSV_DEFAULT_MAX_ROWS + 2 }, (_, i) => key(i)));
    expect(attempts(store)).toEqual(Array.from({ length: CSV_DEFAULT_MAX_ROWS }, (_, i) => key(i + 2)));
    await saveAttempts(store, CONTRACTS.token, treasury, [key(1), key(2), key(1)]);
    expect(attempts(store)).toEqual([key(1), key(2)]);
    await expect(saveAttempts(store, CONTRACTS.token, treasury, [key(3), treasuryKey])).rejects.toThrow(TypeError);
    expect(attempts(store)).toEqual([key(1), key(2)]);
  });

  it('clearInFlight removes the in-flight record and nothing else', async () => {
    const { store } = setup();
    const record: InFlightPay = { hash: '0'.repeat(63) + '1', maxTime: 1, batchKey: key(1) };
    store.data.set(inFlightRecordKey, record);
    store.data.set(key(1), toSavedOpening(1n, 1n));
    store.data.set(attemptsListKey, [key(1)]);
    const before = [...store.data.keys()];
    await clearInFlight(store, CONTRACTS.token, treasury);
    expect([...store.data.keys()]).toEqual(before.filter((k) => k !== inFlightRecordKey));
    await expect(clearInFlight(store, treasury, treasury)).rejects.toThrow(AddressError);
  });
});

describe('executeRun preflight refuses the whole run and sends nothing', () => {
  const second = workers[2] as string;
  it.each<[string, PreflightErrorCode, number | undefined, (s: ReturnType<typeof setup>) => void]>([
    ['an invited worker', 'WORKER_NOT_ACTIVE', 3, (s) => s.chain.workers.set(`${COMPANY}/${second}`, 'Invited')],
    ['a removed worker', 'WORKER_NOT_ACTIVE', 3, (s) => s.chain.workers.set(`${COMPANY}/${second}`, 'Removed')],
    ['a worker never invited', 'WORKER_NOT_ACTIVE', 3, (s) => s.chain.workers.delete(`${COMPANY}/${second}`)],
    ['a worker not registered with the token', 'WORKER_NOT_REGISTERED', 5, (s) => s.chain.accounts.delete(workers[4] as string)],
    ['a signer who is not the admin', 'NOT_ADMIN', undefined, (s) => s.chain.companies.set(COMPANY, { admin: workers[0] as string, auditorId: 0, activeWorkers: 5 })],
    ['an unknown company', 'COMPANY_NOT_FOUND', undefined, (s) => s.chain.companies.delete(COMPANY)],
    ['an unknown run', 'RUN_NOT_FOUND', undefined, (s) => s.chain.runs.clear()],
    ['a closed run', 'RUN_NOT_OPEN', undefined, (s) => s.chain.runs.set(`${COMPANY}/${RUN}`, { open: false, expected: 5, paid: 0 })],
    ['a run opened for fewer payments', 'RUN_COUNT_EXCEEDED', undefined, (s) => s.chain.runs.set(`${COMPANY}/${RUN}`, { open: true, expected: 5, paid: 1 })],
    ['an unregistered treasury', 'TREASURY_NOT_REGISTERED', undefined, (s) => s.chain.accounts.delete(treasury)],
    ['a company under a demo auditor id', 'DEMO_AUDITOR_ID', undefined, (s) => {
      s.input.demoAuditorIds = [0];
    }],
    ['a worker under a demo auditor id', 'DEMO_AUDITOR_ID', 4, (s) => {
      s.input.demoAuditorIds = [99, 13];
    }],
    ['a demo auditor id that is not a u32', 'INVALID_INPUT', undefined, (s) => {
      s.input.demoAuditorIds = [-1];
    }],
    ['keys that are not the treasury', 'KEYS_MISMATCH', undefined, (s) => {
      const account = s.chain.accounts.get(treasury);
      if (account) account.pvk = scalarMul(99n, H);
    }],
    ['a duplicated worker', 'DUPLICATE_ROW', 2, (s) => {
      s.input.rows = [s.input.rows[0], { ...s.input.rows[1], address: workers[0] }] as never;
    }],
    ['no rows', 'NO_ROWS', undefined, (s) => {
      s.input.rows = [];
    }],
    ['a row that did not come from the parser', 'INVALID_ROW', 1, (s) => {
      s.input.rows = [{ ...s.input.rows[0], amount: 0n }] as never;
    }],
    ['a G address as the token', 'INVALID_INPUT', undefined, (s) => {
      s.input.contracts = { ...CONTRACTS, token: treasury };
    }],
    ['no prover', 'INVALID_INPUT', undefined, (s) => {
      s.input.prover = undefined as never;
    }],
  ])('%s', async (_name, code, line, mutate) => {
    const s = setup();
    mutate(s);
    const err = await executeRun(s.input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect([(err as PreflightError).code, (err as PreflightError).line]).toEqual([code, line]);
    expect([s.chain.simulations, s.chain.submitted.length]).toEqual([0, 0]);
    expect(prove).not.toHaveBeenCalled();
  });

  describe('under the published demo auditor registry', () => {
    const published = Object.keys(PUBLISHED_DEMO_AUDITOR_IDS)[0] as string;
    const demoId = PUBLISHED_DEMO_AUDITOR_IDS[published]?.[0] as number;
    const demoSetup = () => {
      const s = setup(FUNDS, { ...CONTRACTS, auditor: published });
      s.chain.auditorKeys.set(demoId, scalarMul(5555n, H));
      return s;
    };
    // The treasury's token account sits under the company's auditor id, as registration puts it.
    const underDemoId = (s: ReturnType<typeof setup>) => {
      s.chain.companies.set(COMPANY, { admin: treasury, auditorId: demoId, activeWorkers: 5 });
      (s.chain.accounts.get(treasury) as AccountState).auditorId = demoId;
    };
    const refusal = async (input: RunInput) => {
      const err = await executeRun(input).catch((e: unknown) => e);
      return err instanceof PreflightError ? [err.code, err.line] : err;
    };

    it('holds id 5 for the deployed auditor registry, frozen', () => {
      expect(PUBLISHED_DEMO_AUDITOR_IDS).toEqual({ CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG: [5] });
      expect(Object.isFrozen(PUBLISHED_DEMO_AUDITOR_IDS)).toBe(true);
      expect(Object.isFrozen(PUBLISHED_DEMO_AUDITOR_IDS[published])).toBe(true);
    });

    it('refuses a company or a worker under the published id with no demoAuditorIds passed (C34)', async () => {
      const company = demoSetup();
      company.chain.companies.set(COMPANY, { admin: treasury, auditorId: demoId, activeWorkers: 5 });
      expect(await refusal(company.input)).toEqual(['DEMO_AUDITOR_ID', undefined]);

      const worker = demoSetup();
      (worker.chain.accounts.get(workers[1] as string) as AccountState).auditorId = demoId;
      expect(await refusal(worker.input)).toEqual(['DEMO_AUDITOR_ID', 2]);
      expect([company.chain.simulations, worker.chain.simulations]).toEqual([0, 0]);
    });

    it('pays under the published id only with allowPublishedDemoAuditor, and still refuses demoAuditorIds then', async () => {
      const showcase = demoSetup();
      underDemoId(showcase);
      showcase.input.allowPublishedDemoAuditor = true;
      expect(statuses(await executeRun(showcase.input))).toEqual(Array(5).fill('paid'));

      const listed = demoSetup();
      underDemoId(listed);
      listed.input.allowPublishedDemoAuditor = true;
      listed.input.demoAuditorIds = [demoId];
      expect(await refusal(listed.input)).toEqual(['DEMO_AUDITOR_ID', undefined]);

      const sloppy = demoSetup();
      sloppy.input.allowPublishedDemoAuditor = 'true' as unknown as boolean;
      expect(await refusal(sloppy.input)).toEqual(['INVALID_INPUT', undefined]);
    });

    it('does not refuse the same id under another auditor registry', async () => {
      const s = setup();
      s.chain.auditorKeys.set(demoId, scalarMul(5555n, H));
      underDemoId(s);
      expect(statuses(await executeRun(s.input))).toEqual(Array(5).fill('paid'));
    });
  });

  it('refuses a treasury balance that does not cover the unpaid rows', async () => {
    const s = setup(TOTAL - 1n);
    const err = await executeRun(s.input).catch((e: unknown) => e);
    expect((err as PreflightError).code).toBe('INSUFFICIENT_FUNDS');
    expect(s.chain.submitted).toHaveLength(0);
  });

  it('throws HistoryIncompleteError when the saved treasury opening does not match chain, or is missing', async () => {
    const wrong = setup();
    wrong.store.data.set(treasuryKey, toSavedOpening(FUNDS - 1n, 0n));
    const err = await executeRun(wrong.input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryIncompleteError);
    expect((err as HistoryIncompleteError).reason).toBe('DOES_NOT_OPEN');
    expect((err as HistoryIncompleteError).rebuildable).toBe(true);
    expect([wrong.chain.simulations, wrong.chain.submitted.length]).toEqual([0, 0]);

    const missing = setup();
    missing.store.data.clear();
    const none = await executeRun(missing.input).catch((e: unknown) => e);
    expect([(none as HistoryIncompleteError).reason, (none as HistoryIncompleteError).rebuildable]).toEqual(['NO_SAVED_OPENING', true]);
    expect(missing.chain.submitted).toHaveLength(0);
  });
});

describe('executeRun guards around the wallet and the display', () => {
  it('refuses to send when the wallet returns a different transaction', async () => {
    const { chain, input } = setup();
    input.signer = {
      address: treasury,
      signTransaction: async (txXdr, passphrase) => {
        const tx = TransactionBuilder.fromXDR(txXdr, passphrase);
        const swapped = TransactionBuilder.cloneFrom(tx as never, { fee: '999999', networkPassphrase: passphrase }).build();
        swapped.sign(adminKey);
        return swapped.toXDR();
      },
    };
    await expect(executeRun(input)).rejects.toBeInstanceOf(SignedTransactionMismatchError);
    input.signer = { address: treasury, signTransaction: async () => 'not a transaction' };
    await expect(executeRun(input)).rejects.toBeInstanceOf(SignedTransactionMismatchError);
    expect(chain.submitted).toHaveLength(0);
  });

  it('keeps paying when the progress callback throws', async () => {
    const { input } = setup();
    input.onProgress = () => {
      throw new Error('render failed');
    };
    expect(statuses(await executeRun(input))).toEqual(Array(5).fill('paid'));
  });
});

describe('secrets and salts (C11, C12)', () => {
  it('never puts an amount in a progress event, an error or a log line', async () => {
    const seen: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void seen.push(args.map(String).join(' ')));
    }
    const record = (e: unknown) => seen.push(e instanceof Error ? `${e.name} ${e.message} ${JSON.stringify(e)}` : String(e));

    const clean = setup();
    const report = await executeRun(clean.input);
    seen.push(JSON.stringify(clean.events), JSON.stringify(report));

    const tampered = setup();
    tampered.chain.failNext('TAMPER');
    await executeRun(tampered.input).catch(record);
    const bug = setup();
    prove.mockImplementationOnce((params) => standInProof({ ...params, amount: params.amount + 1n }));
    await executeRun(bug.input).catch(record);
    const poor = setup(TOTAL - 1n);
    await executeRun(poor.input).catch(record);
    const isolated = setup();
    prove.mockImplementationOnce(unbuildable).mockImplementationOnce(unbuildable);
    seen.push(JSON.stringify(await executeRun(isolated.input)));
    const waiting = setup();
    waiting.chain.failNext('DROPPED');
    waiting.chain.reportsCloseTime = false;
    await executeRun(waiting.input).catch(record);
    seen.push(JSON.stringify(tampered.events), JSON.stringify(bug.events));

    const haystack = seen.join('\n');
    expect(haystack).toContain('AmountMismatchError');
    expect(haystack).toContain('INSUFFICIENT_FUNDS');
    expect(haystack).toContain('PROOF_FAILED');
    expect(haystack).toContain('PaymentInFlightError');
    for (const amount of [...AMOUNTS, TOTAL, FUNDS - TOTAL, TOTAL - 1n]) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(amount);
      for (const encoding of [amount.toString(), formatUsdc(amount), amount.toString(16), le.toString('hex')]) {
        expect(haystack).not.toContain(encoding);
      }
    }
  });

  it('has no Math.random anywhere in src', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(join(src, file), 'utf8')).not.toContain('Math.random');
  });
});

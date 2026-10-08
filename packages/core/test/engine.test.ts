// Does NOT cover: real proofs, fees or the live network (scratchpad/m5b2/e2e-run.mjs runs the
// engine on testnet), a wallet that shows the hidden amount (none can), or several devices
// paying the same run at once (the network's one-transaction-per-account queue and the
// contract's paid flags handle that, not this engine). The injected prover is a stand-in built
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
import { formatUsdc } from '../src/amounts.js';
import type { OpeningStore, SavedOpening } from '../src/chain/ports.js';
import { parsePayrollCsv } from '../src/csv.js';
import type { KalypsoKeys } from '../src/keys.js';
import type { ProverPort, TransferEnvelope } from '../src/prover/port.js';
import {
  AmountMismatchError,
  PreflightError,
  SignedTransactionMismatchError,
  executeRun,
  type PreflightErrorCode,
  type RowStatus,
  type RunInput,
} from '../src/run/engine.js';
import { HistoryIncompleteError, readSavedOpening, toSavedOpening, treasuryOpeningKey } from '../src/run/treasury.js';
import { FakeChain, readTransferData } from './fake-chain.js';
import { PASSPHRASE, testAccount, testContract } from './independent-xdr.js';

// The fake proof carries the commitment it was built on, which the fake token checks.
async function standInProof(params: TransferParams): Promise<TransferEnvelope> {
  const witness = buildTransferWitness(params);
  const proof = pointToBytes(commit(params.v, params.r));
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

function memoryStore(timeline: string[]): OpeningStore & { data: Map<string, SavedOpening> } {
  const data = new Map<string, SavedOpening>();
  return {
    data,
    get: async (key) => data.get(key),
    put: async (key, value) => {
      timeline.push(key.startsWith('kalypso/v1/batch/') ? 'put:batch' : 'put:treasury');
      data.set(key, value);
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

function setup(funds = FUNDS) {
  const chain = new FakeChain(CONTRACTS);
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
    contracts: CONTRACTS,
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
const treasuryOpening = (store: ReturnType<typeof memoryStore>) => readSavedOpening(store.data.get(treasuryKey) as SavedOpening);
const sigmaOfCall = async (i: number) => readTransferData((await prove.mock.results[i]?.value).payload).sigma;

afterEach(() => {
  prove.mockClear();
  vi.restoreAllMocks();
});

describe('executeRun on a clean run', () => {
  it('pays 5 rows in 3 transactions, one at a time, saving each opening before submitting', async () => {
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
    expect(chain.timeline).toEqual([
      'put:treasury',
      ...Array.from({ length: 3 }, () => ['put:batch', 'submit', 'put:treasury']).flat(),
    ]);

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
    const { chain, input } = setup();
    chain.failNext('FAILED');
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
  });

  it('stops after a second failure: those rows and every later row report failed, nothing is paid', async () => {
    const { chain, store, events, input } = setup();
    chain.failNext('FAILED', 'FAILED');
    const report = await executeRun(input);

    expect(chain.submitted).toHaveLength(2);
    expect(report.transactions).toEqual([]);
    expect(statuses(report)).toEqual(Array(5).fill('failed'));
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

describe('executeRun checks what was paid against the CSV (C14)', () => {
  it('stops with AmountMismatchError when the chain balance after a batch is not the approved one', async () => {
    const { chain, input } = setup();
    chain.failNext('OK', 'TAMPER');
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmountMismatchError);
    expect((err as AmountMismatchError).lines).toEqual([3, 4]);
    expect(chain.submitted).toHaveLength(2);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 0]);
  });

  it('never labels a row paid from a SUCCESS reply the chain does not back (C13)', async () => {
    const { chain, events, input } = setup();
    chain.failNext('LYING_SUCCESS');
    const err = await executeRun(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmountMismatchError);
    expect(events.some((e) => e.status === 'paid')).toBe(false);
    expect(transfersPerWorker(chain)).toEqual([0, 0, 0, 0, 0]);
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
    expect([wrong.chain.simulations, wrong.chain.submitted.length]).toEqual([0, 0]);

    const missing = setup();
    missing.store.data.clear();
    expect(((await executeRun(missing.input).catch((e: unknown) => e)) as HistoryIncompleteError).reason).toBe('NO_SAVED_OPENING');
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
    seen.push(JSON.stringify(tampered.events), JSON.stringify(bug.events));

    const haystack = seen.join('\n');
    expect(haystack).toContain('AmountMismatchError');
    expect(haystack).toContain('INSUFFICIENT_FUNDS');
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

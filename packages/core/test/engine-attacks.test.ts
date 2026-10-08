// What a lying RPC can make the run engine sign or believe, and what hand-made rows it refuses.
// Same stand-in prover and FakeChain as engine.test.ts. Does NOT cover: real proofs, the fee the
// network finally charges, or the live network.
import { SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, type Keypair } from '@stellar/stellar-sdk/base';
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
import { MAX_STROOPS, formatUsdc } from '../src/amounts.js';
import type { ChainPort, InFlightPay, OpeningStore, SavedOpening } from '../src/chain/ports.js';
import { CSV_DEFAULT_MAX_ROWS, parsePayrollCsv, type CsvRow } from '../src/csv.js';
import type { KalypsoKeys } from '../src/keys.js';
import type { ProverPort, TransferEnvelope } from '../src/prover/port.js';
import { MAX_PAY_FEE_STROOPS } from '../src/chain/tx.js';
import { PreflightError, executeRun, type PreflightErrorCode, type RunInput } from '../src/run/engine.js';
import { toSavedOpening, treasuryOpeningKey } from '../src/run/treasury.js';
import { FakeChain } from './fake-chain.js';
import { PASSPHRASE, raw, testAccount, testContract } from './independent-xdr.js';

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

const CONTRACTS = { payroll: testContract(31), token: testContract(32), auditor: testContract(33) };
const COMPANY = 7n;
const RUN = 202610n;
const adminKey = testAccount('engine attacks admin');
const treasury = adminKey.publicKey();
const workers = Array.from({ length: 5 }, (_, i) => testAccount(`engine attacks worker ${i}`).publicKey());
const AMOUNTS = [1_908_190_1n, 8_801_919_09n, 1_000_000_81n, 9_181_009_1n, 81_900_190_8n];
const FUNDS = 100_000_0000000n;
const keys: KalypsoKeys = (() => {
  const addrF = addressToField(CONTRACTS.token);
  const acctF = addressToField(treasury);
  return { ...deriveKeys(0x5eed_1234_abcdn, addrF, acctF), addrF, acctF };
})();
const treasuryKey = treasuryOpeningKey(CONTRACTS.token, treasury);

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
  chain.accounts.set(treasury, { auditorId: 0, spendingKey: keys.Y, pvk: keys.PVK, spendable: commit(funds, 0n), receiving: IDENTITY });
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
const statuses = (report: Awaited<ReturnType<typeof executeRun>>) => report.rows.map((r) => r.status);

/** Makes every simulation name this resource fee, and records each fee the wallet is asked to sign. */
function lyingFee(chain: FakeChain, input: RunInput, resourceFee: bigint): bigint[] {
  const simulate: ChainPort['simulate'] = chain.simulate.bind(chain);
  chain.simulate = async (txXdr) => {
    const sim = await simulate(txXdr);
    if (!sim.ok) return sim;
    return {
      ...sim,
      minResourceFee: resourceFee.toString(),
      transactionDataXdr: new SorobanDataBuilder().setResources(180_000_000, 50_000, 10_000).setResourceFee(Number(resourceFee)).build().toXDR('base64'),
    };
  };
  const signer = signerFor(adminKey);
  const feesShownToWallet: bigint[] = [];
  input.signer = {
    address: treasury,
    signTransaction: async (txXdr, passphrase) => {
      feesShownToWallet.push(BigInt((TransactionBuilder.fromXDR(txXdr, passphrase) as Transaction).fee));
      return signer.signTransaction(txXdr, passphrase);
    },
  };
  return feesShownToWallet;
}

describe('a lying RPC and the pay the employer signs', () => {
  it('refuses to ask the wallet to sign a fee the simulation names above the cap, here the XDR maximum of 429 XLM per pay', async () => {
    const { chain, input } = setup();
    // The envelope's uint32 fee field tops out at 4294967295 stroops, about 429 XLM.
    const feesShownToWallet = lyingFee(chain, input, 4_294_967_295n - 100n);
    const report = await executeRun(input);
    expect(report.rows.map((r) => [r.status, r.reason])).toEqual(Array(5).fill(['failed', 'FEE_TOO_HIGH']));
    expect(feesShownToWallet).toEqual([]);
    expect(chain.submitted).toHaveLength(0);
    expect(transfersPerWorker(chain)).toEqual([0, 0, 0, 0, 0]);
  });

  it('signs a fee exactly at the cap and refuses one stroop more', async () => {
    // The inclusion fee in this envelope is 100 stroops, on top of the resource fee.
    const atCap = setup();
    const signedAtCap = lyingFee(atCap.chain, atCap.input, MAX_PAY_FEE_STROOPS - 100n);
    expect(statuses(await executeRun(atCap.input))).toEqual(Array(5).fill('paid'));
    expect(signedAtCap).toEqual([MAX_PAY_FEE_STROOPS, MAX_PAY_FEE_STROOPS, MAX_PAY_FEE_STROOPS]);

    const over = setup();
    const signedOver = lyingFee(over.chain, over.input, MAX_PAY_FEE_STROOPS - 99n);
    expect((await executeRun(over.input)).rows.map((r) => r.reason)).toEqual(Array(5).fill('FEE_TOO_HIGH'));
    expect([signedOver.length, over.chain.submitted.length]).toEqual([0, 0]);
  });

  it('refuses to pay twice when the RPC says nobody was paid, whether or not its simulation lies too', async () => {
    const { chain, input } = setup();
    await executeRun(input);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);

    const read: ChainPort['read'] = chain.read.bind(chain);
    chain.read = async (contractId, method, args) => {
      if (method === 'is_paid') return raw.bool(false);
      if (method === 'get_run') {
        return raw.struct({ status: raw.u32(0), period_label: raw.str('October 2026'), expected_count: raw.u32(5), paid_count: raw.u32(0), opened_ledger: raw.u32(2) });
      }
      return read(contractId, method, args);
    };
    const honestSimulation = await executeRun(input);
    expect(honestSimulation.rows.map((r) => [r.status, r.reason])).toEqual(Array(5).fill(['failed', 'SIMULATION_FAILED']));
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(chain.submitted).toHaveLength(3);

    chain.simulate = async () => ({
      ok: true,
      minResourceFee: '90000',
      transactionDataXdr: new SorobanDataBuilder().setResources(180_000_000, 50_000, 10_000).setResourceFee(90_000).build().toXDR('base64'),
      authXdr: [],
      latestLedger: chain.ledger,
    });
    const lyingSimulation = await executeRun(input);
    expect(lyingSimulation.rows.map((r) => r.reason)).toEqual(['TRANSACTION_FAILED', 'TRANSACTION_FAILED', 'RUN_STOPPED', 'RUN_STOPPED', 'RUN_STOPPED']);
    expect(transfersPerWorker(chain)).toEqual([1, 1, 1, 1, 1]);
    expect(chain.submitted).toHaveLength(5);
  });

  it('refuses to move money when the RPC swaps a worker viewing key or an auditor key: the chain verifies against its own copy', async () => {
    const { chain, input } = setup();
    const read: ChainPort['read'] = chain.read.bind(chain);
    const attackerKey = scalarMul(99_999n, H);
    chain.read = async (contractId, method, args) => {
      if (method === 'get_key') return raw.bytes(Buffer.from(pointToBytes(attackerKey)));
      return read(contractId, method, args);
    };
    const report = await executeRun(input);
    expect(statuses(report)).toEqual(Array(5).fill('failed'));
    expect(report.rows.map((r) => r.reason)).toEqual(Array(5).fill('SIMULATION_FAILED'));
    expect(transfersPerWorker(chain)).toEqual([0, 0, 0, 0, 0]);
    expect(chain.submitted).toHaveLength(0);
  });
});

describe('rows that did not come from the CSV parser', () => {
  const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(workers[0] as string), Buffer.alloc(8)]));
  const first = () => csvRows(workers)[0] as CsvRow;

  it.each<[string, PreflightErrorCode, number | undefined, () => CsvRow[]]>([
    ['an amount that is a Number', 'INVALID_ROW', 1, () => [{ ...first(), amount: 5 as unknown as bigint }]],
    ['an amount that is a decimal string', 'INVALID_ROW', 1, () => [{ ...first(), amount: '50000000' as unknown as bigint }]],
    ['a negative amount', 'INVALID_ROW', 1, () => [{ ...first(), amount: -1n }]],
    ['an amount one stroop over the token range', 'INVALID_ROW', 1, () => [{ ...first(), amount: MAX_STROOPS + 1n }]],
    ['a lowercase address', 'INVALID_ROW', 1, () => [{ ...first(), address: (workers[0] as string).toLowerCase() }]],
    ['a muxed address', 'INVALID_ROW', 1, () => [{ ...first(), address: muxed }]],
    ['a line number of zero', 'INVALID_ROW', 0, () => [{ ...first(), line: 0 }]],
    ['a worker listed twice with different padding', 'DUPLICATE_ROW', 2, () => [first(), { ...first(), line: 2, address: ` ${workers[0]} ` }]],
    ['more rows than the CSV cap', 'TOO_MANY_ROWS', undefined, () => Array.from({ length: CSV_DEFAULT_MAX_ROWS + 1 }, (_, i) => ({ ...first(), line: i + 1 }))],
    ['rows that are not an array', 'NO_ROWS', undefined, () => ({ length: 1 } as unknown as CsvRow[])],
  ])('refuses %s before any transaction', async (_name, code, line, rows) => {
    const s = setup();
    s.input.rows = rows();
    const err = await executeRun(s.input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect([(err as PreflightError).code, (err as PreflightError).line]).toEqual([code, line]);
    expect([s.chain.simulations, s.chain.submitted.length]).toEqual([0, 0]);
  });
});

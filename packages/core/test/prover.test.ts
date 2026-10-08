// Does NOT cover: real UltraHonk proving or verification. CircuitProver is replaced by a
// recorder here; scratchpad/m5b3/e2e-views.mjs proves register, transfer and withdraw with
// createNodeProver and the live token verifies them. Witness building and encoding are the
// real SDK functions.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { addressToField, commit, deriveKeys, H, pointToBytes, scalarMul, type TransferParams } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCircuitProver, type CircuitSet } from '../src/prover/browser.js';
import { createNodeProver } from '../src/prover/node.js';
import { readTransferData } from './fake-chain.js';
import { testAccount, testContract } from './independent-xdr.js';

const recorder = vi.hoisted(() => ({
  created: [] as { bytecode: string }[],
  proved: [] as Record<string, string>[],
  destroyed: 0,
  running: 0,
  maxRunning: 0,
  delayMs: 0,
  failNext: false,
}));

vi.mock(import('stellar-confidential-token-sdk'), async (importOriginal) => {
  const sdk = await importOriginal();
  class RecordingProver {
    constructor(circuit: { bytecode: string }) {
      recorder.created.push(circuit);
    }
    async prove(inputs: Record<string, string>) {
      recorder.running++;
      recorder.maxRunning = Math.max(recorder.maxRunning, recorder.running);
      await new Promise((resolve) => setTimeout(resolve, recorder.delayMs));
      recorder.running--;
      if (recorder.failNext) {
        recorder.failNext = false;
        throw new Error('bb.js ran out of memory');
      }
      recorder.proved.push(inputs);
      return { proof: new Uint8Array([9, 8, 7, recorder.proved.length]), publicInputs: [] };
    }
    async destroy() {
      recorder.destroyed++;
    }
  }
  return { ...sdk, CircuitProver: RecordingProver as unknown as typeof sdk.CircuitProver };
});

const circuits: CircuitSet = {
  register: { bytecode: 'register-bytecode', abi: {} } as never,
  transfer: { bytecode: 'transfer-bytecode', abi: {} } as never,
  withdraw: { bytecode: 'withdraw-bytecode', abi: {} } as never,
};
const token = testContract(31);
const account = testAccount('prover account').publicKey();
const keys = deriveKeys(0xabc_def_123n, addressToField(token), addressToField(account));
const kAud = scalarMul(55n, H);
const transferParams: TransferParams = { keys, v: 10_000n, r: 77n, amount: 2_500n, pvkB: scalarMul(66n, H), kAudR: kAud, kAudS: kAud };

afterEach(() => {
  recorder.created.length = 0;
  recorder.proved.length = 0;
  recorder.destroyed = 0;
  recorder.maxRunning = 0;
  recorder.delayMs = 0;
});

describe('createCircuitProver', () => {
  it('refuses a missing circuit or one without bytecode', () => {
    expect(() => createCircuitProver({ ...circuits, withdraw: undefined as never })).toThrow(/withdraw circuit/);
    expect(() => createCircuitProver({ ...circuits, register: { bytecode: '' } as never })).toThrow(/register circuit/);
    expect(() => createCircuitProver(undefined as never)).toThrow(TypeError);
  });

  it('proves a transfer on the circuit it was given and encodes the token data with that proof', async () => {
    const prover = createCircuitProver(circuits);
    const result = await prover.proveTransfer(transferParams);
    expect(recorder.created.map((c) => c.bytecode)).toEqual(['transfer-bytecode']);
    expect(result.next.v).toBe(transferParams.v - transferParams.amount);
    expect(result.recipientView.vTx).toBe(transferParams.amount);
    const data = readTransferData(result.payload);
    expect([...data.proof]).toEqual([...result.proof]);
    expect(pointToBytes(data.cSpendNew)).toEqual(pointToBytes(result.next.cSpend));
    expect(BigInt(recorder.proved[0]?.sigma as string).toString(16).padStart(64, '0')).toBe(data.sigma);
  });

  it('draws a fresh salt for every proof and refuses params that carry one (C11)', async () => {
    const prover = createCircuitProver(circuits);
    const a = readTransferData((await prover.proveTransfer(transferParams)).payload);
    const b = readTransferData((await prover.proveTransfer(transferParams)).payload);
    expect(a.sigma).not.toBe(b.sigma);
    expect(pointToBytes(a.cTransfer)).not.toEqual(pointToBytes(b.cTransfer));
    await expect(prover.proveTransfer({ ...transferParams, sigma: 5n })).rejects.toThrow(/sigma or rE/);
    await expect(prover.proveTransfer({ ...transferParams, rE: 5n })).rejects.toThrow(/sigma or rE/);
    await expect(prover.proveWithdraw({ keys, v: 10n, r: 1n, amount: 1n, kAudS: kAud, sigma: 3n })).rejects.toThrow(/sigma or rE/);
    expect(recorder.proved).toHaveLength(2);
  });

  it('returns the withdraw opening the SDK leaves out, and register data for the account', async () => {
    const prover = createCircuitProver(circuits);
    const withdraw = await prover.proveWithdraw({ keys, v: 10_000n, r: 77n, amount: 4_000n, kAudS: kAud });
    expect(withdraw.next.v).toBe(6_000n);
    expect(withdraw.next.cSpend.equals(commit(withdraw.next.v, withdraw.next.r))).toBe(true);
    const register = await prover.proveRegister(keys);
    expect(register.payload.length).toBeGreaterThan(register.proof.length);
    expect(recorder.created.map((c) => c.bytecode)).toEqual(['withdraw-bytecode', 'register-bytecode']);
  });

  it('keeps one prover per circuit, runs its proofs one at a time, and destroys them', async () => {
    const prover = createCircuitProver(circuits);
    recorder.delayMs = 20;
    await Promise.all([prover.proveTransfer(transferParams), prover.proveTransfer(transferParams), prover.proveTransfer(transferParams)]);
    expect(recorder.created).toHaveLength(1);
    expect(recorder.maxRunning).toBe(1);
    await prover.destroy();
    expect(recorder.destroyed).toBe(1);
    await prover.destroy();
    expect(recorder.destroyed).toBe(1);
  });

  it('keeps proving after one proof fails', async () => {
    const prover = createCircuitProver(circuits);
    recorder.failNext = true;
    const [failed, next] = await Promise.allSettled([prover.proveTransfer(transferParams), prover.proveTransfer(transferParams)]);
    expect(failed.status).toBe('rejected');
    expect(next.status).toBe('fulfilled');
    await expect(prover.proveTransfer({ ...transferParams, amount: transferParams.v + 1n })).rejects.toThrow();
  });
});

describe('createNodeProver', () => {
  it('reads the three circuits the SDK ships from disk', async () => {
    const prover = createNodeProver();
    await prover.proveTransfer(transferParams);
    await prover.proveRegister(keys);
    await prover.proveWithdraw({ keys, v: 5n, r: 1n, amount: 5n, kAudS: kAud });
    const sdkDir = createRequire(import.meta.url).resolve('stellar-confidential-token-sdk').replace(/dist[\\/]index\.c?js$/, '');
    const onDisk = (name: string) => JSON.parse(readFileSync(`${sdkDir}circuits/${name}.json`, 'utf8')).bytecode;
    expect(recorder.created.map((c) => c.bytecode)).toEqual([onDisk('transfer'), onDisk('register'), onDisk('withdraw')]);
  });
});

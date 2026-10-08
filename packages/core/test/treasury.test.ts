// Does NOT cover: rebuilding an opening from token events (the wallet's StateEngine does that
// and saves the result); this file only covers checking a saved opening against the chain.
import { commit, scalarMul, H } from 'stellar-confidential-token-sdk';
import { describe, expect, it } from 'vitest';
import { ContractCallError, type ChainPort, type OpeningStore, type SavedOpening } from '../src/chain/ports.js';
import { TokenErrorCode } from '../src/chain/token.js';
import {
  HistoryIncompleteError,
  batchOpeningKey,
  loadTreasuryOpening,
  readSavedOpening,
  toSavedOpening,
  treasuryOpeningKey,
} from '../src/run/treasury.js';
import { accountStruct, testAccount, testContract } from './independent-xdr.js';

const TOKEN = testContract(6);
const PAYROLL = testContract(7);
const treasury = testAccount('treasury').publicKey();
const worker = testAccount('treasury test worker').publicKey();

function chainWithSpendable(spendable: ReturnType<typeof commit> | 'unregistered'): ChainPort {
  return {
    read: async () => {
      if (spendable === 'unregistered') throw new ContractCallError('confidential_balance', TokenErrorCode.AccountNotRegistered);
      return accountStruct({ auditorId: 0, spendingKey: scalarMul(5n, H), pvk: scalarMul(6n, H), spendable, receiving: commit(0n, 0n) });
    },
  } as unknown as ChainPort;
}

function memoryStore(entries: Record<string, SavedOpening> = {}): OpeningStore & { data: Map<string, SavedOpening> } {
  const data = new Map(Object.entries(entries));
  return { data, get: async (key) => data.get(key), put: async (key, value) => void data.set(key, value) };
}

async function reasonOf(work: Promise<unknown>) {
  const err = await work.catch((e: unknown) => e);
  if (err instanceof HistoryIncompleteError) return err.reason;
  throw err;
}

describe('saved openings', () => {
  it('round-trips, and is refused when any part is tampered with', () => {
    const saved = toSavedOpening(1_000_0000000n, 987654321n);
    expect(saved.v).toBe('10000000000');
    expect(readSavedOpening(saved)?.commitment.equals(commit(1_000_0000000n, 987654321n))).toBe(true);
    expect(readSavedOpening({ ...saved, v: '10000000001' })).toBeUndefined();
    expect(readSavedOpening({ ...saved, commitment: saved.commitment.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).toBeUndefined();
    expect(readSavedOpening({ ...saved, v: '010000000000' })).toBeUndefined();
    expect(readSavedOpening({ ...saved, v: '-1' })).toBeUndefined();
    expect(readSavedOpening({ ...saved, v: '9223372036854775808' })).toBeUndefined();
    expect(readSavedOpening({ ...saved, commitment: saved.commitment.toUpperCase() })).toBeUndefined();
    expect(readSavedOpening({ ...saved, r: 1 as unknown as string })).toBeUndefined();
    expect(readSavedOpening(null as unknown as SavedOpening)).toBeUndefined();
  });

  it('builds store keys from decoded addresses only', () => {
    expect(treasuryOpeningKey(TOKEN, ` ${treasury}`)).toBe(`kalypso/v1/opening/${TOKEN}/${treasury}`);
    expect(batchOpeningKey({ payroll: PAYROLL, companyId: 4n, runId: 5n, firstWorker: worker })).toBe(
      `kalypso/v1/batch/${PAYROLL}/4/5/${worker}`,
    );
    expect(() => treasuryOpeningKey(treasury, treasury)).toThrow();
  });
});

describe('loadTreasuryOpening', () => {
  const opening = toSavedOpening(500n, 77n);
  const onChain = commit(500n, 77n);

  it('returns the saved opening only when it opens the on-chain commitment', async () => {
    const store = memoryStore({ [treasuryOpeningKey(TOKEN, treasury)]: opening });
    await expect(loadTreasuryOpening({ port: chainWithSpendable(onChain), store, token: TOKEN, treasury })).resolves.toEqual(opening);
  });

  it('falls back to a pending batch opening when the treasury record is one batch behind', async () => {
    const pendingKey = batchOpeningKey({ payroll: PAYROLL, companyId: 1n, runId: 1n, firstWorker: worker });
    const store = memoryStore({ [treasuryOpeningKey(TOKEN, treasury)]: toSavedOpening(900n, 1n), [pendingKey]: opening });
    const port = chainWithSpendable(onChain);
    await expect(loadTreasuryOpening({ port, store, token: TOKEN, treasury, pendingKeys: [pendingKey] })).resolves.toEqual(opening);
    expect(await reasonOf(loadTreasuryOpening({ port, store, token: TOKEN, treasury }))).toBe('DOES_NOT_OPEN');
  });

  it('says history incomplete when nothing is saved, nothing matches, or the stored hex alone matches', async () => {
    const port = chainWithSpendable(onChain);
    expect(await reasonOf(loadTreasuryOpening({ port, store: memoryStore(), token: TOKEN, treasury }))).toBe('NO_SAVED_OPENING');
    const wrong = memoryStore({ [treasuryOpeningKey(TOKEN, treasury)]: toSavedOpening(499n, 77n) });
    expect(await reasonOf(loadTreasuryOpening({ port, store: wrong, token: TOKEN, treasury }))).toBe('DOES_NOT_OPEN');
    // The stored commitment is the chain's, but v and r do not make it: refused.
    const forged = memoryStore({ [treasuryOpeningKey(TOKEN, treasury)]: { ...toSavedOpening(1n, 1n), commitment: opening.commitment } });
    expect(await reasonOf(loadTreasuryOpening({ port, store: forged, token: TOKEN, treasury }))).toBe('DOES_NOT_OPEN');
    const unregistered = chainWithSpendable('unregistered');
    expect(await reasonOf(loadTreasuryOpening({ port: unregistered, store: memoryStore(), token: TOKEN, treasury }))).toBe('NOT_REGISTERED');
  });

  it('bounds the number of pending keys it will try', async () => {
    const keys = Array.from({ length: 501 }, (_, i) => `k${i}`);
    await expect(loadTreasuryOpening({ port: chainWithSpendable(onChain), store: memoryStore(), token: TOKEN, treasury, pendingKeys: keys })).rejects.toThrow(RangeError);
  });

  it('never puts a balance or a commitment in its error text', async () => {
    const err = (await loadTreasuryOpening({ port: chainWithSpendable(onChain), store: memoryStore({ [treasuryOpeningKey(TOKEN, treasury)]: toSavedOpening(499n, 77n) }), token: TOKEN, treasury }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/499|500|77/);
    expect(err.message).not.toContain(opening.commitment.slice(0, 16));
  });
});

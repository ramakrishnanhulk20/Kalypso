import type { ChainPort, OpeningStore } from '../chain/ports.js';
import { requireAccount } from '../chain/scval.js';
import type { HistorySource } from '../history/events.js';
import type { KalypsoKeys } from '../keys.js';
import { WorkerViewError, loadAccountBalance, type WorkerBalance } from '../payslips/worker.js';
import { PaymentInFlightError, PreflightError, settleInFlight } from './engine.js';
import {
  HistoryIncompleteError,
  attemptsKey,
  inFlightKey,
  readAttempts,
  readInFlight,
  readSavedOpening,
  saveAttempts,
  toSavedOpening,
  treasuryOpeningKey,
} from './treasury.js';

export interface RebuildInput {
  port: ChainPort;
  store: OpeningStore;
  /** Where the treasury's token history is read from: the same source loadWorkerBalance takes. */
  history: HistorySource;
  payroll: string;
  token: string;
  treasury: string;
  keys: KalypsoKeys;
}

export interface RebuiltOpening {
  /** The treasury's spendable balance in stroops, rebuilt from history and checked against chain. */
  value: bigint;
  /**
   * What this device last expected the treasury to hold, from its own records. It is the
   * device's expectation only: labelled as such on screen, never adopted, never proved from and
   * never shown as the chain's balance. undefined when the device kept no readable record.
   */
  deviceExpected: bigint | undefined;
  /** deviceExpected === value. False is the signal the employer must see (threat model C14). */
  matchesDevice: boolean;
}

/**
 * Rebuilds the treasury's spendable opening from its token history and makes it the opening this
 * device pays from: the way back to paying on a new device, after cleared storage, or after any
 * lost or damaged record. It is an explicit console step and executeRun never runs it on its
 * own, because a deviceExpected that differs from value means the treasury moved in a way this
 * device did not record, which is the C14 signal the employer must see before paying on.
 *
 * In order:
 * 1. deviceExpected is read from the store before anything changes: the opening of the pay in
 *    flight if it is readable, else the newest readable attempts-list opening, else the readable
 *    saved treasury opening. C16 governs balances; this number is a C14 signal, not a balance.
 * 2. A pay this treasury left in flight is settled through the engine's own settle path. PENDING
 *    and UNREADABLE are thrown, so nothing is rebuilt while a pay may still land or while its
 *    record cannot be read (clearInFlight first). UNCONFIRMED and DOES_NOT_MATCH_CHAIN do not stop
 *    the rebuild: the pay is final, and the chain's history decides what it left.
 * 3. The spendable opening is rebuilt with loadAccountBalance, which checks it against
 *    confidential_balance (threat model C16). An incomplete history, or a result that does not
 *    open the chain, throws NOT_REBUILT and nothing is written.
 * 4. Only then is it saved as the treasury opening, the in-flight record removed by compare (same
 *    hash), and the attempts list dropped with every batch opening it held, since the chain is
 *    past each of them and a later rebuild can recover any opening from history. A key another tab
 *    listed after step 1 stays listed.
 *
 * @throws PreflightError INVALID_INPUT for a malformed address, store or keys, or KEYS_MISMATCH
 *   when the keys are not the treasury's; HistoryIncompleteError NOT_REGISTERED or NOT_REBUILT;
 *   PaymentInFlightError PENDING or UNREADABLE; or the port's or history's own errors.
 */
export async function rebuildTreasuryOpening(input: RebuildInput): Promise<RebuiltOpening> {
  let payroll: string;
  let token: string;
  let treasury: string;
  try {
    payroll = requireAccount(input.payroll, ['C']);
    token = requireAccount(input.token, ['C']);
    treasury = requireAccount(input.treasury, ['G', 'C']);
  } catch {
    throw new PreflightError('INVALID_INPUT');
  }
  const { port, store, keys } = input;
  if (typeof store?.get !== 'function' || typeof keys?.PVK?.equals !== 'function') throw new PreflightError('INVALID_INPUT');

  const recorded = readInFlight(await store.get(inFlightKey(token, treasury)));
  const listed = readAttempts(await store.get(attemptsKey(token, treasury))) ?? [];
  const deviceExpected = await deviceExpectation(store, [
    ...(recorded === undefined ? [] : [recorded.batchKey]),
    ...[...listed].reverse(),
    treasuryOpeningKey(token, treasury),
  ]);

  try {
    await settleInFlight({ port, store, token, treasury });
  } catch (err) {
    if (!(err instanceof PaymentInFlightError && (err.reason === 'UNCONFIRMED' || err.reason === 'DOES_NOT_MATCH_CHAIN'))) throw err;
  }

  let balance: WorkerBalance;
  try {
    balance = await loadAccountBalance({ port, history: input.history, contracts: { payroll, token }, account: treasury, keys });
  } catch (err) {
    if (!(err instanceof WorkerViewError)) throw err;
    throw err.code === 'NOT_REGISTERED' ? new HistoryIncompleteError('NOT_REGISTERED') : new PreflightError(err.code);
  }
  if (!balance.complete || balance.spendable === undefined) throw new HistoryIncompleteError('NOT_REBUILT');
  const { v, r } = balance.spendable;

  await store.put(treasuryOpeningKey(token, treasury), toSavedOpening(v, r));
  const recordKey = inFlightKey(token, treasury);
  if (recorded !== undefined && readInFlight(await store.get(recordKey))?.hash === recorded.hash) await store.delete(recordKey);
  await retireAttempts(store, token, treasury, [...listed, ...(recorded === undefined ? [] : [recorded.batchKey])]);
  return { value: v, deviceExpected, matchesDevice: deviceExpected === v };
}

/** The value of the first key, in order, whose stored opening reads back intact. */
async function deviceExpectation(store: OpeningStore, keys: string[]): Promise<bigint | undefined> {
  for (const key of keys) {
    const opening = readSavedOpening(await store.get(key));
    if (opening !== undefined) return opening.v;
  }
  return undefined;
}

/** Drops `retired` from the attempts list and the store. Keys listed since they were read stay. */
async function retireAttempts(store: OpeningStore, token: string, treasury: string, retired: string[]): Promise<void> {
  const listKey = attemptsKey(token, treasury);
  const kept = (readAttempts(await store.get(listKey)) ?? []).filter((key) => !retired.includes(key));
  if (kept.length > 0) await saveAttempts(store, token, treasury, kept);
  else await store.delete(listKey);
  for (const key of new Set(retired)) if (!kept.includes(key)) await store.delete(key);
}

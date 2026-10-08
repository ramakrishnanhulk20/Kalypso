import { commit } from 'stellar-confidential-token-sdk';
import { MAX_STROOPS } from '../amounts.js';
import { sameAccount } from '../addresses.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount } from '../chain/scval.js';
import { buildMerge, buildWithdraw, confidentialBalance, getAuditorKey } from '../chain/token.js';
import type { InvocationBase } from '../chain/tx.js';
import type { KalypsoKeys } from '../keys.js';
import type { ProverPort } from '../prover/port.js';
import type { Opening } from '../run/treasury.js';

export type WorkerActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_REGISTERED'
  | 'KEYS_MISMATCH'
  | 'HISTORY_INCOMPLETE'
  | 'NOTHING_TO_MERGE'
  | 'INSUFFICIENT_FUNDS'
  | 'AMOUNT_MISMATCH';

// Messages never carry an amount, a balance or a key (threat model C12).
const ACTION_MESSAGES: Record<WorkerActionErrorCode, string> = {
  INVALID_INPUT: 'The action settings are invalid: the worker must be the transaction source, with a valid destination, amount and registry.',
  NOT_REGISTERED: 'This worker has not registered with the confidential token yet.',
  KEYS_MISMATCH: 'These private keys do not belong to this worker. Sign in again with the worker wallet.',
  HISTORY_INCOMPLETE: 'History incomplete: the balance this device rebuilt does not match the balance on chain, so no withdrawal was prepared.',
  NOTHING_TO_MERGE: 'There is no incoming pay waiting to be moved into the spendable balance.',
  INSUFFICIENT_FUNDS: 'The withdrawal is larger than the spendable balance. Merge incoming pay first, or withdraw less.',
  AMOUNT_MISMATCH: 'The withdrawal proof does not move exactly the requested amount. Nothing was prepared.',
};

/** A worker action was refused before any envelope was built. Nothing was proved or sent. */
export class WorkerActionError extends Error {
  readonly code: WorkerActionErrorCode;

  constructor(code: WorkerActionErrorCode) {
    super(ACTION_MESSAGES[code]);
    this.name = 'WorkerActionError';
    this.code = code;
  }
}

/** The worker signs as the transaction source, which is what satisfies the token's require_auth. */
function requireWorkerIsSource(base: InvocationBase, worker: string): string {
  try {
    const address = requireAccount(worker, ['G']);
    if (!sameAccount(base.source.address, address)) throw new WorkerActionError('INVALID_INPUT');
    requireAccount(base.contractId, ['C']);
    return address;
  } catch {
    throw new WorkerActionError('INVALID_INPUT');
  }
}

/**
 * The unsigned envelope for merge(worker): moves the worker's incoming pay into the balance they
 * can spend. base.contractId is the token and the worker is the transaction source.
 *
 * @throws WorkerActionError INVALID_INPUT, NOT_REGISTERED, or NOTHING_TO_MERGE when the receiving
 *   commitment on chain is empty, so a fee is never spent on a merge that moves nothing.
 */
export async function buildWorkerMerge(base: InvocationBase, p: { port: ChainPort; worker: string }): Promise<string> {
  const worker = requireWorkerIsSource(base, p.worker);
  const account = await confidentialBalance(p.port, base.contractId, worker);
  if (account === null) throw new WorkerActionError('NOT_REGISTERED');
  if (account.receiving.is0()) throw new WorkerActionError('NOTHING_TO_MERGE');
  return buildMerge(base, { account: worker });
}

/**
 * Proves a withdrawal of `amount` stroops from the worker's spendable balance to `to` (any
 * Stellar account, such as the worker's own wallet or an anchor's), and returns the unsigned
 * envelope with the opening the withdrawal leaves behind. base.contractId is the token.
 *
 * Before anything is proved: the keys must be the worker's (the viewing key on chain), and
 * `spendable` must open the spendable commitment on chain right now (threat model C16). Pass
 * the opening loadWorkerBalance returned with complete true; any other value is refused. The
 * prover draws a fresh salt (C11), and the proof must leave exactly spendable minus amount.
 *
 * @throws WorkerActionError INVALID_INPUT, NOT_REGISTERED, KEYS_MISMATCH, HISTORY_INCOMPLETE,
 *   INSUFFICIENT_FUNDS or AMOUNT_MISMATCH; or the port's or prover's own errors.
 */
export async function buildWorkerWithdraw(
  base: InvocationBase,
  p: {
    port: ChainPort;
    prover: ProverPort;
    /** The auditor registry, which holds the key of the worker's own auditor id. */
    registry: string;
    worker: string;
    keys: KalypsoKeys;
    spendable: Opening;
    to: string;
    amount: bigint;
  },
): Promise<{ xdr: string; next: Opening }> {
  const worker = requireWorkerIsSource(base, p.worker);
  let to: string;
  let registry: string;
  try {
    to = requireAccount(p.to, ['G', 'C']);
    registry = requireAccount(p.registry, ['C']);
  } catch {
    throw new WorkerActionError('INVALID_INPUT');
  }
  const { amount, spendable } = p;
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_STROOPS) throw new WorkerActionError('INVALID_INPUT');
  if (typeof spendable?.v !== 'bigint' || typeof spendable.r !== 'bigint' || typeof p.prover?.proveWithdraw !== 'function') {
    throw new WorkerActionError('INVALID_INPUT');
  }

  const account = await confidentialBalance(p.port, base.contractId, worker);
  if (account === null) throw new WorkerActionError('NOT_REGISTERED');
  if (!account.pvk.equals(p.keys.PVK)) throw new WorkerActionError('KEYS_MISMATCH');
  if (spendable.v < 0n || spendable.v > MAX_STROOPS || !commit(spendable.v, spendable.r).equals(account.spendable)) {
    throw new WorkerActionError('HISTORY_INCOMPLETE');
  }
  if (amount > spendable.v) throw new WorkerActionError('INSUFFICIENT_FUNDS');

  const kAudS = await getAuditorKey(p.port, registry, account.auditorId);
  const proved = await p.prover.proveWithdraw({ keys: p.keys, v: spendable.v, r: spendable.r, amount, kAudS });
  const { v, r } = proved.next;
  if (v !== spendable.v - amount || !proved.next.cSpend.equals(commit(v, r))) throw new WorkerActionError('AMOUNT_MISMATCH');
  const xdr = buildWithdraw(base, { from: worker, to, amount, data: { payload: proved.payload } });
  return { xdr, next: { v, r, commitment: proved.next.cSpend } };
}

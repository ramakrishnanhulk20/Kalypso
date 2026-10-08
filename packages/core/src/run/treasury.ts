import { bytesToHex } from '@noble/hashes/utils.js';
import { FP_MODULUS, commit, pointToBytes, type Point } from 'stellar-confidential-token-sdk';
import { MAX_STROOPS } from '../amounts.js';
import { CSV_DEFAULT_MAX_ROWS } from '../csv.js';
import type { ChainPort, OpeningStore, SavedOpening } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import { confidentialBalance } from '../chain/token.js';

export type HistoryIncompleteReason = 'NOT_REGISTERED' | 'NO_SAVED_OPENING' | 'DOES_NOT_OPEN';

// Messages never carry a balance, a blinding factor or a commitment (threat model C12).
const HISTORY_MESSAGES: Record<HistoryIncompleteReason, string> = {
  NOT_REGISTERED: 'The treasury is not registered with the confidential token.',
  NO_SAVED_OPENING: 'History incomplete: this device has no saved treasury balance. Rebuild it from the token history first.',
  DOES_NOT_OPEN:
    'History incomplete: the saved treasury balance does not match the balance on chain. Rebuild it from the token history first.',
};

/** The treasury balance known to this device does not open the on-chain commitment (threat model C16). */
export class HistoryIncompleteError extends Error {
  readonly reason: HistoryIncompleteReason;

  constructor(reason: HistoryIncompleteReason) {
    super(HISTORY_MESSAGES[reason]);
    this.name = 'HistoryIncompleteError';
    this.reason = reason;
  }
}

/** A parsed opening: value v in stroops, blinding r, and the commitment v·G + r·H they make. */
export interface Opening {
  v: bigint;
  r: bigint;
  commitment: Point;
}

const DECIMAL = /^(0|[1-9]\d{0,79})$/;
const COMMITMENT_HEX = /^[0-9a-f]{128}$/;
const MAX_PENDING_KEYS = CSV_DEFAULT_MAX_ROWS;

/** Store key of the treasury's current spendable opening. */
export function treasuryOpeningKey(token: string, treasury: string): string {
  return `kalypso/v1/opening/${requireAccount(token, ['C'])}/${requireAccount(treasury, ['G', 'C'])}`;
}

/** Store key of the opening a batch leaves behind, written before the batch is submitted. */
export function batchOpeningKey(p: { payroll: string; companyId: bigint; runId: bigint; firstWorker: string }): string {
  const payroll = requireAccount(p.payroll, ['C']);
  const worker = requireAccount(p.firstWorker, ['G', 'C']);
  return `kalypso/v1/batch/${payroll}/${requireU64(p.companyId, 'companyId')}/${requireU64(p.runId, 'runId')}/${worker}`;
}

export function toSavedOpening(v: bigint, r: bigint): SavedOpening {
  return { v: v.toString(), r: r.toString(), commitment: bytesToHex(pointToBytes(commit(v, r))) };
}

/**
 * Parses a stored opening and checks it against itself: v in [0, MAX_STROOPS], r below the
 * curve's scalar modulus, and commit(v, r) equal to the stored commitment. Returns undefined
 * for anything else, so a corrupted or tampered record is treated as missing, never trusted.
 */
export function readSavedOpening(saved: SavedOpening): Opening | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined;
  const { v, r, commitment } = saved;
  if (typeof v !== 'string' || typeof r !== 'string' || typeof commitment !== 'string') return undefined;
  if (!DECIMAL.test(v) || !DECIMAL.test(r) || !COMMITMENT_HEX.test(commitment)) return undefined;
  const value = BigInt(v);
  const blinding = BigInt(r);
  if (value > MAX_STROOPS || blinding >= FP_MODULUS) return undefined;
  const point = commit(value, blinding);
  if (bytesToHex(pointToBytes(point)) !== commitment) return undefined;
  return { v: value, r: blinding, commitment: point };
}

/**
 * Returns the treasury opening that opens confidential_balance(treasury).spendable on chain
 * right now. It tries the saved treasury opening first, then each pending batch key in order.
 * The comparison recomputes commit(v, r) and compares curve points; a matching stored hex
 * string alone is never enough. A matching opening is the only way into a run.
 *
 * @param args.pendingKeys batch keys whose transaction may have landed without being recorded
 *   as the treasury's opening (a crash between landing and recording). At most 500.
 * @throws HistoryIncompleteError NOT_REGISTERED, NO_SAVED_OPENING when no candidate is stored,
 *   or DOES_NOT_OPEN when none opens the commitment. ContractCallError when the chain cannot be read.
 */
export async function loadTreasuryOpening(args: {
  port: ChainPort;
  store: OpeningStore;
  token: string;
  treasury: string;
  pendingKeys?: readonly string[];
}): Promise<SavedOpening> {
  const pendingKeys = args.pendingKeys ?? [];
  if (pendingKeys.length > MAX_PENDING_KEYS) throw new RangeError(`pendingKeys holds more than ${MAX_PENDING_KEYS} keys`);
  const account = await confidentialBalance(args.port, args.token, args.treasury);
  if (account === null) throw new HistoryIncompleteError('NOT_REGISTERED');

  let sawCandidate = false;
  for (const key of [treasuryOpeningKey(args.token, args.treasury), ...pendingKeys]) {
    const saved = await args.store.get(key);
    if (saved === undefined) continue;
    sawCandidate = true;
    const opening = readSavedOpening(saved);
    if (opening !== undefined && opening.commitment.equals(account.spendable)) return toSavedOpening(opening.v, opening.r);
  }
  throw new HistoryIncompleteError(sawCandidate ? 'DOES_NOT_OPEN' : 'NO_SAVED_OPENING');
}

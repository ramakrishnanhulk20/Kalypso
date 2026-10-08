import type { xdr } from '@stellar/stellar-sdk/base';
import {
  encodeRegisterData,
  encodeTransferData,
  encodeWithdrawData,
  pointFromBytes,
  type Point,
  type RegisterWitness,
  type TransferWitness,
  type WithdrawWitness,
} from 'stellar-confidential-token-sdk';
import { requireAuditorBinding } from './auditor.js';
import { ContractCallError, type ChainPort } from './ports.js';
import {
  DecodeError,
  fromBytes,
  fromStruct,
  fromU32,
  requireAccount,
  requirePositiveI128,
  requireU32,
  toScVal,
} from './scval.js';
import { buildInvocation, type InvocationBase } from './tx.js';

/** Confidential token error codes, from the deployed token's contract spec. */
export const TokenErrorCode = {
  AccountAlreadyRegistered: 3500,
  AccountNotRegistered: 3501,
  NegativeAmount: 3502,
  DelegationAlreadyExists: 3503,
  DelegationNotFound: 3504,
  DelegationExpired: 3505,
  InvalidProof: 3506,
  InvalidData: 3507,
  UnderlyingAssetNotSet: 3508,
  VerifierNotSet: 3509,
  AuditorNotSet: 3510,
  AddressAsFieldNotSet: 3511,
  AddressAsFieldAlreadySet: 3512,
  UnderlyingAssetAlreadySet: 3513,
  NonCanonicalEncoding: 3514,
} as const;

/**
 * OpenZeppelin auditor error codes, which our registry raises unchanged, plus CounterOverflow
 * from the registry's own RegistryError (packages/contracts/auditor/src/errors.rs).
 */
export const AuditorErrorCode = {
  AuditorAlreadyRegistered: 3300,
  AuditorNotRegistered: 3301,
  IdentityPoint: 3302,
  PointNotOnCurve: 3303,
  UnknownAuditor: 100,
  NoPendingOwner: 101,
  OwnerTransferExpired: 102,
  InvalidLiveUntil: 103,
  SameOwner: 104,
  CounterOverflow: 105,
} as const;

/** What the payroll engine needs from confidential_balance. Points are checked on the curve. */
export interface ConfidentialAccountView {
  auditorId: number;
  spendable: Point;
  receiving: Point;
  pvk: Point;
}

/**
 * The `data: Bytes` argument of a proof-carrying call. Either a ProofEnvelope from the SDK's
 * prove functions (its payload was made by the SDK's encoder), or a witness and proof from
 * CircuitProver in the browser, which this module encodes with the SDK's encoder. Bytes are
 * never wrapped twice, which the token rejects as InvalidData.
 */
export type RegisterProof = { payload: Uint8Array } | { witness: RegisterWitness; proof: Uint8Array };
export type WithdrawProof = { payload: Uint8Array } | { witness: WithdrawWitness; proof: Uint8Array };
export type TransferProof = { payload: Uint8Array } | { witness: TransferWitness; proof: Uint8Array };

function dataBytes<W>(
  data: { payload: Uint8Array } | { witness: W; proof: Uint8Array },
  encode: (witness: W, proof: Uint8Array) => { bytes(): Uint8Array },
): Uint8Array {
  const bytes = 'witness' in data ? new Uint8Array(encode(data.witness, data.proof).bytes()) : data.payload;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('proof data must be non-empty bytes');
  return bytes;
}

const account = (address: string) => toScVal.address(requireAccount(address, ['G', 'C']));

/**
 * register(account, auditor_id, data). The account signs, and its auditor id can never change
 * afterwards. This checks nothing about who owns auditorId. Apps call buildCheckedRegister,
 * the only registration builder an app should use; this one stays exported for scripts that
 * check the binding by hand with requireAuditorBinding first.
 */
export function buildRegister(base: InvocationBase, p: { account: string; auditorId: number; data: RegisterProof }): string {
  return buildInvocation(base, 'register', [
    account(p.account),
    toScVal.u32(requireU32(p.auditorId, 'auditorId')),
    toScVal.bytes(dataBytes(p.data, encodeRegisterData)),
  ]);
}

/**
 * register(account, auditor_id, data), built only after requireAuditorBinding confirms on chain
 * that auditorOwner owns auditorId and holds auditorKey under it (threat model C33, C43). This
 * is the only registration builder an app should call, for a treasury and for a worker alike:
 * an id somebody else took first is refused before any transaction exists.
 *
 * @throws AuditorBindingError, or the registry read's own error, with no transaction built;
 *   then anything buildRegister throws.
 */
export async function buildCheckedRegister(
  port: ChainPort,
  base: InvocationBase,
  p: { account: string; auditorId: number; data: RegisterProof; registry: string; auditorOwner: string; auditorKey: Point },
): Promise<string> {
  await requireAuditorBinding(port, p.registry, p.auditorId, { owner: p.auditorOwner, key: p.auditorKey });
  return buildRegister(base, { account: p.account, auditorId: p.auditorId, data: p.data });
}

/** deposit(from, to, amount). `from` signs and pays `amount` stroops of the underlying token. The amount is public. */
export function buildDeposit(base: InvocationBase, p: { from: string; to: string; amount: bigint }): string {
  return buildInvocation(base, 'deposit', [account(p.from), account(p.to), toScVal.i128(requirePositiveI128(p.amount, 'amount'))]);
}

/** merge(account): moves the receiving balance into the spendable one. The account signs. */
export function buildMerge(base: InvocationBase, p: { account: string }): string {
  return buildInvocation(base, 'merge', [account(p.account)]);
}

/** withdraw(from, to, amount, data). `from` signs. The amount is public. */
export function buildWithdraw(
  base: InvocationBase,
  p: { from: string; to: string; amount: bigint; data: WithdrawProof },
): string {
  return buildInvocation(base, 'withdraw', [
    account(p.from),
    account(p.to),
    toScVal.i128(requirePositiveI128(p.amount, 'amount')),
    toScVal.bytes(dataBytes(p.data, encodeWithdrawData)),
  ]);
}

/** confidential_transfer(from, to, data). `from` signs. */
export function buildConfidentialTransfer(base: InvocationBase, p: { from: string; to: string; data: TransferProof }): string {
  return buildInvocation(base, 'confidential_transfer', [
    account(p.from),
    account(p.to),
    toScVal.bytes(dataBytes(p.data, encodeTransferData)),
  ]);
}

/**
 * The one decoder for every curve point Kalypso reads from chain state, events or the archive
 * (threat model C19). It decodes 64 bytes of be(x) || be(y) with the SDK's canonical decoder,
 * then checks the point is on the Grumpkin curve, which that decoder alone does not.
 *
 * Covers: wrong length, a coordinate at or above the field modulus, a point off the curve.
 * The identity (64 zero bytes) is returned as the identity, because an empty balance is one;
 * callers for which the identity is meaningless (keys, ephemeral points) refuse it. Does not
 * cover whether the point is the right key for anyone; the caller compares it with what it expects.
 *
 * @throws DecodeError for anything else. The message names the field, never the bytes.
 */
export function requireOnCurvePoint(bytes: Uint8Array, what = 'point'): Point {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) throw new DecodeError(`${what} should be 64 bytes`);
  try {
    const point = pointFromBytes(bytes);
    if (!point.is0()) point.assertValidity();
    return point;
  } catch {
    throw new DecodeError(`${what} is not a point on the curve`);
  }
}

const ACCOUNT_FIELDS = [
  'auditor_id',
  'receiving_commitment',
  'spendable_commitment',
  'spending_public_key',
  'viewing_public_key',
] as const;

export function decodeConfidentialAccount(value: xdr.ScVal): ConfidentialAccountView {
  const f = fromStruct(value, ACCOUNT_FIELDS, 'ConfidentialAccount');
  // spending_public_key is checked like the rest even though the engine does not use it.
  requireOnCurvePoint(fromBytes(f.spending_public_key, 'spending_public_key', 64), 'spending_public_key');
  const pvk = requireOnCurvePoint(fromBytes(f.viewing_public_key, 'viewing_public_key', 64), 'viewing_public_key');
  if (pvk.is0()) throw new DecodeError('viewing_public_key is the identity point');
  return {
    auditorId: fromU32(f.auditor_id, 'auditor_id'),
    spendable: requireOnCurvePoint(fromBytes(f.spendable_commitment, 'spendable_commitment', 64), 'spendable_commitment'),
    receiving: requireOnCurvePoint(fromBytes(f.receiving_commitment, 'receiving_commitment', 64), 'receiving_commitment'),
    pvk,
  };
}

export function decodeAuditorKey(value: xdr.ScVal): Point {
  const key = requireOnCurvePoint(fromBytes(value, 'auditor key', 64), 'auditor key');
  if (key.is0()) throw new DecodeError('the auditor key is the identity point');
  return key;
}

/**
 * confidential_balance(account), or null when the token answers AccountNotRegistered. Any
 * other failure throws, so an outage is never read as "not registered".
 */
export async function confidentialBalance(port: ChainPort, token: string, accountAddress: string): Promise<ConfidentialAccountView | null> {
  try {
    return decodeConfidentialAccount(await port.read(requireAccount(token, ['C']), 'confidential_balance', [account(accountAddress)]));
  } catch (err) {
    if (err instanceof ContractCallError && err.contractCode === TokenErrorCode.AccountNotRegistered) return null;
    throw err;
  }
}

/** The auditor registry's get_key(auditor_id). @throws ContractCallError (3301 for an unknown id). */
export async function getAuditorKey(port: ChainPort, registry: string, auditorId: number): Promise<Point> {
  return decodeAuditorKey(
    await port.read(requireAccount(registry, ['C']), 'get_key', [toScVal.u32(requireU32(auditorId, 'auditorId'))]),
  );
}

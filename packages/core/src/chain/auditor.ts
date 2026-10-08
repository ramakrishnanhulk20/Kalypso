// token.ts imports this module as well, so nothing imported from token.ts may be used at module
// load time, only inside functions.
import type { xdr } from '@stellar/stellar-sdk/base';
import { pointToBytes, type Point } from 'stellar-confidential-token-sdk';
import { ContractCallError, type ChainPort } from './ports.js';
import { DecodeError, fromAddress, fromU32, requireAccount, requireU32, toScVal } from './scval.js';
import { AuditorErrorCode, getAuditorKey, requireOnCurvePoint } from './token.js';
import { buildInvocation, type InvocationBase } from './tx.js';

const account = (address: string) => toScVal.address(requireAccount(address, ['G', 'C']));
const auditor = (auditorId: number) => toScVal.u32(requireU32(auditorId, 'auditorId'));

export type AuditorBindingErrorCode = 'UNKNOWN_ID' | 'OWNER_MISMATCH' | 'KEY_MISMATCH';

const BINDING_MESSAGES: Record<AuditorBindingErrorCode, string> = {
  UNKNOWN_ID: 'No key has been registered under this auditor id yet. Register the key first and use the id it returns.',
  OWNER_MISMATCH: 'Someone else owns this auditor id. Register your own key and use the id it returns.',
  KEY_MISMATCH: 'The key under this auditor id is not the one expected, so nothing was registered under it.',
};

/** The registry does not bind this auditor id to the expected owner and key. */
export class AuditorBindingError extends Error {
  readonly code: AuditorBindingErrorCode;

  constructor(code: AuditorBindingErrorCode) {
    super(BINDING_MESSAGES[code]);
    this.name = 'AuditorBindingError';
    this.code = code;
  }
}

/**
 * A caller's auditor key, written with the SDK's encoder and read back through
 * requireOnCurvePoint, the decoder every chain read uses, so a key here and a key from the chain
 * are compared as the same kind of value. Refuses what the registry refuses: the identity and
 * anything off the curve.
 *
 * @throws TypeError when the value is not a point on the curve, or is the identity.
 */
function requireKey(point: Point, what: string): { point: Point; bytes: Uint8Array } {
  let bytes: Uint8Array;
  let decoded: Point;
  try {
    bytes = pointToBytes(point);
    decoded = requireOnCurvePoint(bytes, what);
  } catch {
    throw new TypeError(`${what} must be a point on the curve`);
  }
  if (decoded.is0()) throw new TypeError(`${what} must not be the identity point`);
  return { point: decoded, bytes };
}

/**
 * register_key(owner, point). The owner signs. The registry hands out the next free id, and the
 * only trustworthy source of that id is this transaction's confirmed return value, read with
 * readRegisteredAuditorId. Never predict it from key_count: anyone can register first (C43).
 *
 * @throws TypeError when point is off the curve or the identity; AddressError for a bad owner.
 */
export function buildRegisterKey(base: InvocationBase, p: { owner: string; point: Point }): string {
  return buildInvocation(base, 'register_key', [account(p.owner), toScVal.bytes(requireKey(p.point, 'point').bytes)]);
}

/** rotate_key(auditor_id, new_point). The id's current owner signs. Only later events use the new key. */
export function buildRotateKey(base: InvocationBase, p: { auditorId: number; newPoint: Point }): string {
  return buildInvocation(base, 'rotate_key', [auditor(p.auditorId), toScVal.bytes(requireKey(p.newPoint, 'newPoint').bytes)]);
}

/** propose_owner(auditor_id, new_owner, live_until_ledger). The id's current owner signs. */
export function buildProposeOwner(
  base: InvocationBase,
  p: { auditorId: number; newOwner: string; liveUntilLedger: number },
): string {
  return buildInvocation(base, 'propose_owner', [
    auditor(p.auditorId),
    account(p.newOwner),
    toScVal.u32(requireU32(p.liveUntilLedger, 'liveUntilLedger')),
  ]);
}

/** cancel_owner_proposal(auditor_id). The id's current owner signs. */
export function buildCancelOwnerProposal(base: InvocationBase, p: { auditorId: number }): string {
  return buildInvocation(base, 'cancel_owner_proposal', [auditor(p.auditorId)]);
}

/** accept_owner(auditor_id). The proposed new owner signs, on or before the offer's last ledger. */
export function buildAcceptOwner(base: InvocationBase, p: { auditorId: number }): string {
  return buildInvocation(base, 'accept_owner', [auditor(p.auditorId)]);
}

/** owner_of(auditor_id). @throws ContractCallError, with code UnknownAuditor (100) for an id never handed out. */
export async function getOwnerOf(port: ChainPort, registry: string, auditorId: number): Promise<string> {
  return fromAddress(await port.read(requireAccount(registry, ['C']), 'owner_of', [auditor(auditorId)]), 'owner_of');
}

/**
 * key_count: how many ids exist, so valid ids are 0 to count - 1. It says nothing about which id
 * the next registration gets, because another registration can land first.
 */
export async function getKeyCount(port: ChainPort, registry: string): Promise<number> {
  return fromU32(await port.read(requireAccount(registry, ['C']), 'key_count', []), 'key_count');
}

/**
 * The auditor id a confirmed register_key handed out, from ChainPort.waitFor's returnValue.
 * The value comes from the RPC, so it is only a claim: requireAuditorBinding then reads that
 * id's owner and key from chain before anything is registered under it.
 *
 * @throws DecodeError when there is no value or it is anything but a u32.
 */
export function readRegisteredAuditorId(returnValue: xdr.ScVal): number {
  // Scripts pass waitFor's optional returnValue straight in, so a missing one arrives here.
  if (returnValue === undefined || returnValue === null) throw new DecodeError('register_key returned no value');
  return fromU32(returnValue, 'register_key result');
}

/**
 * Refuses unless the registry, read now, says `expected.owner` owns auditorId and holds
 * `expected.key` under it (threat model C33, C43). Run it right before anyone signs a token
 * registration under an id, because registering under an id is permanent.
 *
 * Owners are compared after the one address parser on both sides, and keys as curve points after
 * the one point decoder on both sides, never as text or bytes.
 *
 * Covers who owns the id and which key it holds at this read. Does not cover a handover or a
 * rotation after it, or whether `registry` is the registry the token reads keys from: the token
 * publishes no getter for that, so the address must come from the deployment config.
 *
 * @throws AuditorBindingError UNKNOWN_ID when the id was never handed out, OWNER_MISMATCH,
 *   KEY_MISMATCH. ContractCallError or DecodeError when the registry cannot be read or answers
 *   in a shape it never uses, so an outage never passes or reads as an unknown id. TypeError or
 *   AddressError, before any read, for a bad expected key or owner.
 */
export async function requireAuditorBinding(
  port: ChainPort,
  registry: string,
  auditorId: number,
  expected: { owner: string; key: Point },
): Promise<void> {
  const owner = requireAccount(expected.owner, ['G', 'C']);
  const key = requireKey(expected.key, 'expected auditor key').point;
  requireU32(auditorId, 'auditorId');

  const unknownAs = (code: number) => (err: unknown) => {
    if (err instanceof ContractCallError && err.contractCode === code) throw new AuditorBindingError('UNKNOWN_ID');
    throw err;
  };
  const onChainOwner = await getOwnerOf(port, registry, auditorId).catch(unknownAs(AuditorErrorCode.UnknownAuditor));
  if (onChainOwner !== owner) throw new AuditorBindingError('OWNER_MISMATCH');
  const onChainKey = await getAuditorKey(port, registry, auditorId).catch(unknownAs(AuditorErrorCode.AuditorNotRegistered));
  if (!onChainKey.equals(key)) throw new AuditorBindingError('KEY_MISMATCH');
}

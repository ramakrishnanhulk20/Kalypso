import { scValToNative, xdr } from '@stellar/stellar-sdk/base';
import { fromBytesBE, isCanonicalFr, type ConfidentialEvent, type Point } from 'stellar-confidential-token-sdk';
import { MAX_STROOPS } from '../amounts.js';
import { MAX_COMPANY_LABEL_BYTES, MAX_PERIOD_LABEL_BYTES } from '../chain/payroll.js';
import { DecodeError, fromAddress, fromBytes, fromString, fromStruct, fromU32, fromU64, utf8Length } from '../chain/scval.js';
import { requireOnCurvePoint } from '../chain/token.js';
import type { EventPosition, RawContractEvent } from './rpc-events.js';

/** A confidential token event in the SDK StateEngine's own shape, so it can be replayed as is. */
export type TokenEvent = ConfidentialEvent;

/** The payroll contract's events that history readers act on (packages/contracts/payroll/src/events.rs, v0.1.1). */
export type PayrollEvent =
  | { type: 'company_created'; companyId: bigint; admin: string; accountant: string; auditorId: number; label: string }
  | { type: 'admin_changed'; companyId: bigint; previousAdmin: string; newAdmin: string }
  | { type: 'run_opened'; companyId: bigint; runId: bigint; periodLabel: string; expectedCount: number }
  | { type: 'payslip_issued'; companyId: bigint; runId: bigint; worker: string };

/** Identity and order of one event, the same whichever source served it. */
export interface EventMeta extends EventPosition {
  /** `ledger-txHash-opIndex-eventIndex`, the SDK's naturalEventId format. Events are deduplicated by this, never by payload. */
  id: string;
  txHash: string;
}

/**
 * One decoded event. `ignored` is an event of ours that no reader acts on (invites, run
 * closing, spender and config events). `undecodable` is an event of ours whose bytes do not
 * have the exact shape the contract defines; `parties` are the topic addresses that could still
 * be read, so a reader can tell whether it touched an account it cares about.
 */
export type HistoryEvent = EventMeta &
  (
    | { kind: 'token'; event: TokenEvent }
    | { kind: 'payroll'; event: PayrollEvent }
    | { kind: 'ignored'; contract: 'token' | 'payroll'; name: string; companyId?: bigint; parties: string[] }
    | { kind: 'undecodable'; contract: 'token' | 'payroll'; name: string | null; reason: string; parties: string[]; companyId?: bigint }
  );

const MAX_TOPICS = 6;

/**
 * The token's configuration events (OZ mod.rs:872-920). Each carries only its name as a topic
 * and names no account, so no account's history depends on it.
 */
export const TOKEN_CONFIG_EVENTS: ReadonlySet<string> = new Set(['underlying_asset_set', 'verifier_set', 'auditor_set', 'address_as_field_set']);

export function eventId(position: EventPosition, txHash: string): string {
  return `${position.ledger}-${txHash}-${position.opIndex}-${position.eventIndex}`;
}

/** A BytesN<32> field value read through the SDK's decoder, refused unless canonical (below the field modulus). */
export function fieldValue(value: xdr.ScVal, what: string): bigint {
  const n = fromBytesBE(fromBytes(value, what, 32));
  if (!isCanonicalFr(n)) throw new DecodeError(`${what} is not a canonical field value`);
  return n;
}

/** An ephemeral point R_e = r_e·H, where r_e is never zero, so the identity is refused too. */
export function ephemeralPoint(value: xdr.ScVal, what: string): Point {
  const point = requireOnCurvePoint(fromBytes(value, what, 64), what);
  if (point.is0()) throw new DecodeError(`${what} is the identity point`);
  return point;
}

/** A public token amount: an i128 the token refuses below zero, and never above what it can hold. */
function amountValue(value: xdr.ScVal, what: string): bigint {
  if (value.switch().name !== 'scvI128') throw new DecodeError(`${what} should be scvI128`);
  const amount = scValToNative(value) as bigint;
  if (amount < 0n || amount > MAX_STROOPS) throw new DecodeError(`${what} is outside the range the token can hold`);
  return amount;
}

function label(value: xdr.ScVal, what: string, maxBytes: number): string {
  const text = fromString(value, what);
  if (utf8Length(text) > maxBytes) throw new DecodeError(`${what} is longer than ${maxBytes} bytes`);
  return text;
}

function requireTopicCount(topics: xdr.ScVal[], count: number, name: string): void {
  if (topics.length !== count) throw new DecodeError(`${name} should have ${count} topics`);
}

function decodeToken(name: string, topics: xdr.ScVal[], data: xdr.ScVal, ledger: number): TokenEvent | null {
  const party = (i: number) => fromAddress(topics[i] as xdr.ScVal, `${name} topic ${i}`);
  switch (name) {
    case 'register': {
      requireTopicCount(topics, 2, name);
      const f = fromStruct(data, ['auditor_id'] as const, name);
      return { type: 'register', ledger, account: party(1), auditorId: fromU32(f.auditor_id, 'auditor_id') };
    }
    case 'deposit': {
      requireTopicCount(topics, 3, name);
      const f = fromStruct(data, ['amount'] as const, name);
      return { type: 'deposit', ledger, from: party(1), to: party(2), amount: amountValue(f.amount, 'amount') };
    }
    case 'merge':
      requireTopicCount(topics, 2, name);
      fromStruct(data, [] as const, name);
      return { type: 'merge', ledger, account: party(1) };
    case 'withdraw': {
      requireTopicCount(topics, 3, name);
      const f = fromStruct(data, ['amount', 'b_tilde', 'b_tilde_aud_s', 'r_e_point', 'sigma'] as const, name);
      return {
        type: 'withdraw',
        ledger,
        from: party(1),
        to: party(2),
        amount: amountValue(f.amount, 'amount'),
        rE: ephemeralPoint(f.r_e_point, 'r_e_point'),
        sigma: fieldValue(f.sigma, 'sigma'),
        bTilde: fieldValue(f.b_tilde, 'b_tilde'),
        bAudS: fieldValue(f.b_tilde_aud_s, 'b_tilde_aud_s'),
      };
    }
    case 'transfer': {
      requireTopicCount(topics, 3, name);
      const fields = ['b_tilde', 'b_tilde_aud_s', 'r_e_point', 'r_tilde_aud_r', 'sigma', 'v_tilde', 'v_tilde_aud_r', 'v_tilde_aud_s'] as const;
      const f = fromStruct(data, fields, name);
      return {
        type: 'transfer',
        ledger,
        from: party(1),
        to: party(2),
        rE: ephemeralPoint(f.r_e_point, 'r_e_point'),
        vTilde: fieldValue(f.v_tilde, 'v_tilde'),
        sigma: fieldValue(f.sigma, 'sigma'),
        bTilde: fieldValue(f.b_tilde, 'b_tilde'),
        vAudR: fieldValue(f.v_tilde_aud_r, 'v_tilde_aud_r'),
        rAudR: fieldValue(f.r_tilde_aud_r, 'r_tilde_aud_r'),
        vAudS: fieldValue(f.v_tilde_aud_s, 'v_tilde_aud_s'),
        bAudS: fieldValue(f.b_tilde_aud_s, 'b_tilde_aud_s'),
      };
    }
    default:
      return null;
  }
}

function decodePayroll(name: string, topics: xdr.ScVal[], data: xdr.ScVal): PayrollEvent | null {
  // Every payroll event names its company at topic 1 (events.rs), which the archive files it under.
  if (topics.length < 2) throw new DecodeError(`${name} has no company id topic`);
  const companyId = fromU64(topics[1] as xdr.ScVal, `${name} company id`);
  switch (name) {
    case 'company_created': {
      requireTopicCount(topics, 2, name);
      const f = fromStruct(data, ['accountant', 'admin', 'auditor_id', 'label'] as const, name);
      return {
        type: 'company_created',
        companyId,
        admin: fromAddress(f.admin, 'admin'),
        accountant: fromAddress(f.accountant, 'accountant'),
        auditorId: fromU32(f.auditor_id, 'auditor_id'),
        label: label(f.label, 'label', MAX_COMPANY_LABEL_BYTES),
      };
    }
    case 'admin_changed': {
      requireTopicCount(topics, 2, name);
      const f = fromStruct(data, ['new_admin', 'previous_admin'] as const, name);
      return { type: 'admin_changed', companyId, previousAdmin: fromAddress(f.previous_admin, 'previous_admin'), newAdmin: fromAddress(f.new_admin, 'new_admin') };
    }
    case 'run_opened': {
      requireTopicCount(topics, 3, name);
      const f = fromStruct(data, ['expected_count', 'period_label'] as const, name);
      return {
        type: 'run_opened',
        companyId,
        runId: fromU64(topics[2] as xdr.ScVal, 'run id'),
        periodLabel: label(f.period_label, 'period_label', MAX_PERIOD_LABEL_BYTES),
        expectedCount: fromU32(f.expected_count, 'expected_count'),
      };
    }
    case 'payslip_issued':
      requireTopicCount(topics, 4, name);
      fromStruct(data, [] as const, name);
      return {
        type: 'payslip_issued',
        companyId,
        runId: fromU64(topics[2] as xdr.ScVal, 'run id'),
        worker: fromAddress(topics[3] as xdr.ScVal, 'worker'),
      };
    default:
      return null;
  }
}

function parseScVal(base64: string, what: string): xdr.ScVal {
  if (typeof base64 !== 'string') throw new DecodeError(`${what} is not base64 XDR`);
  try {
    return xdr.ScVal.fromXDR(base64, 'base64');
  } catch {
    throw new DecodeError(`${what} does not parse as XDR`);
  }
}

/** The addresses among topics 1 and up that still decode, for an event whose payload did not. */
function readableParties(topics: xdr.ScVal[]): string[] {
  const parties: string[] = [];
  for (const topic of topics.slice(1)) {
    try {
      parties.push(fromAddress(topic, 'topic'));
    } catch {
      /* not an address, or not one Kalypso accepts */
    }
  }
  return parties;
}

/**
 * Decodes one event of our token or payroll contract. Addresses go through parseAccount, every
 * curve point through requireOnCurvePoint, every field value through the SDK's canonical
 * check, and every struct must hold exactly its defined fields. Nothing is guessed.
 *
 * Never throws for a bad payload: it returns kind "undecodable" with the reason, so a reader
 * can mark exactly that event (threat model C19). Reasons name fields, never values.
 *
 * @param contracts which contract id is which. An event from any other contract is refused.
 * @throws DecodeError only when the event is not from one of the two contracts.
 */
export function decodeContractEvent(raw: RawContractEvent, contracts: { token: string; payroll: string }): HistoryEvent {
  const contract = raw.contractId === contracts.token ? 'token' : raw.contractId === contracts.payroll ? 'payroll' : null;
  if (contract === null) throw new DecodeError('an event came from a contract Kalypso did not ask for');
  const meta: EventMeta = {
    id: eventId(raw, raw.txHash),
    ledger: raw.ledger,
    txIndex: raw.txIndex,
    opIndex: raw.opIndex,
    eventIndex: raw.eventIndex,
    txHash: raw.txHash,
  };
  let topics: xdr.ScVal[] = [];
  let name: string | null = null;
  try {
    if (!Array.isArray(raw.topicsXdr) || raw.topicsXdr.length < 1 || raw.topicsXdr.length > MAX_TOPICS) {
      throw new DecodeError('the event has no topics or too many');
    }
    topics = raw.topicsXdr.map((t, i) => parseScVal(t, `topic ${i}`));
    const first = topics[0] as xdr.ScVal;
    if (first.switch().name !== 'scvSymbol') throw new DecodeError('the event name is not a symbol');
    // String() because sym() is typed string | Buffer, and the build has no Node types to name Buffer.
    const eventName = String(first.sym());
    name = eventName;
    const data = parseScVal(raw.dataXdr, 'event data');
    if (contract === 'token') {
      // A config name in any other shape is not the token's config event, so it stays undecodable.
      if (TOKEN_CONFIG_EVENTS.has(eventName)) requireTopicCount(topics, 1, eventName);
      const event = decodeToken(eventName, topics, data, raw.ledger);
      return event === null ? { ...meta, kind: 'ignored', contract, name: eventName, parties: readableParties(topics) } : { ...meta, kind: 'token', event };
    }
    const event = decodePayroll(eventName, topics, data);
    if (event !== null) return { ...meta, kind: 'payroll', event };
    return { ...meta, kind: 'ignored', contract, name: eventName, companyId: fromU64(topics[1] as xdr.ScVal, 'company id'), parties: readableParties(topics) };
  } catch (err) {
    const reason = err instanceof DecodeError ? err.message : 'the event could not be read';
    const undecodable: HistoryEvent = { ...meta, kind: 'undecodable', contract, name, reason, parties: readableParties(topics) };
    const companyId = contract === 'payroll' ? readableCompanyId(topics) : undefined;
    return companyId === undefined ? undecodable : { ...undecodable, companyId };
  }
}

function readableCompanyId(topics: xdr.ScVal[]): bigint | undefined {
  try {
    return fromU64(topics[1] as xdr.ScVal, 'company id');
  } catch {
    return undefined;
  }
}

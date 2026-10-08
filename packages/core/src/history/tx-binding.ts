import { bytesToHex } from '@noble/hashes/utils.js';
import { Address, FeeBumpTransaction, Networks, TransactionBuilder, xdr, type Transaction } from '@stellar/stellar-sdk/base';
import { Server } from '@stellar/stellar-sdk/rpc';
import type { Point } from 'stellar-confidential-token-sdk';
import { RpcTimeoutError } from '../chain/rpc-port.js';
import { DecodeError, fromAddress, fromBytes, fromStruct, fromU64, fromVec, requireAccount } from '../chain/scval.js';
import { requireOnCurvePoint } from '../chain/token.js';
import { ephemeralPoint, fieldValue, type TokenEvent } from './decode.js';
import { httpsBaseUrl } from './events.js';

/** A transaction as a source recorded it. Nothing in it is trusted until its hash is recomputed. */
export interface TxRecord {
  /** The base64 TransactionEnvelope, signatures included. */
  envelopeXdr: string;
  /** True only when the network applied the transaction and it succeeded. */
  successful: boolean;
}

/**
 * Where transaction envelopes come from, by hash. The live one is createTxSourcePort; tests use an
 * in-memory model. A source may lie or be wrong, which is why bindTransferToTransaction recomputes
 * every hash from the envelope it is given.
 */
export interface TxSourcePort {
  /** The transaction with this hash, or null when the source does not have it. */
  transaction(txHash: string): Promise<TxRecord | null>;
}

/** The token's TransferPayload, decoded from the transaction's own call arguments. */
export interface BoundTransferPayload {
  cSpendNew: Point;
  cTransfer: Point;
  rE: Point;
  vTilde: bigint;
  bTilde: bigint;
  sigma: bigint;
  vAudR: bigint;
  rAudR: bigint;
  vAudS: bigint;
  bAudS: bigint;
}

/** Which of our two calls carried the transfer. A direct transfer is never a payslip. */
export type BoundCall = { kind: 'payroll_pay'; companyId: bigint; runId: bigint } | { kind: 'confidential_transfer' };

export type BindingFailure =
  /** No source had the transaction, or a source failed or answered out of shape. */
  | 'transaction_unavailable'
  /** The envelope does not hash to the event's transaction hash on the testnet passphrase. */
  | 'hash_mismatch'
  /** The network applied the transaction but it failed, so it moved nothing. */
  | 'transaction_failed'
  /** The envelope, the call arguments or the transfer data do not have the exact contract shape. */
  | 'envelope_unreadable'
  /** The transaction's one call is neither our payroll's pay nor our token's confidential_transfer. */
  | 'not_our_call'
  /** The call carries no transfer, or more than one, for the event's sender and recipient. */
  | 'no_matching_item'
  /** At least one of the event's fields differs from the payload the transaction carried. */
  | 'payload_mismatch';

export type TransferBinding = { ok: true; call: BoundCall; payload: BoundTransferPayload } | { ok: false; reason: BindingFailure };

export type TransferEventFields = Extract<TokenEvent, { type: 'transfer' }>;

export const TX_SOURCE_TIMEOUT_MS = 10_000;
// Kalypso runs on testnet only (PLAN.md). A mainnet build changes this one constant.
const NETWORK_PASSPHRASE = Networks.TESTNET;
// The network caps a transaction at 132,096 bytes, 176,128 base64 characters; a fee bump adds a few hundred.
const MAX_ENVELOPE_CHARS = 180_000;
const MAX_HORIZON_REPLY_CHARS = 4_000_000;
const TX_HASH = /^[0-9a-f]{64}$/;
const PAYLOAD_FIELDS = [
  'b_tilde',
  'b_tilde_aud_s',
  'c_spend_new',
  'c_transfer',
  'r_e_point',
  'r_tilde_aud_r',
  'sigma',
  'v_tilde',
  'v_tilde_aud_r',
  'v_tilde_aud_s',
] as const;

/** The transaction's one contract call: our payroll or token by id, anything else as null. */
function readCall(tx: Transaction, contracts: { token: string; payroll: string }) {
  const [op, ...rest] = tx.operations;
  if (op === undefined || rest.length > 0 || op.type !== 'invokeHostFunction') return null;
  if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') return null;
  const call = op.func.invokeContract();
  const contractId = requireAccount(Address.fromScAddress(call.contractAddress()).toString(), ['C']);
  const contract = contractId === contracts.payroll ? 'payroll' : contractId === contracts.token ? 'token' : null;
  return { contract, method: call.functionName().toString(), args: call.args() };
}

function requireArgCount(args: xdr.ScVal[], count: number, method: string): void {
  if (args.length !== count) throw new DecodeError(`${method} should have ${count} arguments`);
}

/**
 * The `data: Bytes` of the transfer this event reports, from the call's own arguments. For pay,
 * the item is the one to the event's recipient; the sender is the company admin, which the
 * payroll contract sets itself and which the caller compares with the treasury it expects.
 */
function findTransferData(
  call: NonNullable<ReturnType<typeof readCall>>,
  event: TransferEventFields,
): { call: BoundCall; data: xdr.ScVal } | BindingFailure {
  const { contract, method, args } = call;
  if (contract === 'payroll' && method === 'pay') {
    requireArgCount(args, 3, method);
    const companyId = fromU64(args[0] as xdr.ScVal, 'company_id');
    const runId = fromU64(args[1] as xdr.ScVal, 'run_id');
    const items = fromVec(args[2] as xdr.ScVal, 'items').map((item, i) => {
      const pair = fromVec(item, `items[${i}]`);
      if (pair.length !== 2) throw new DecodeError(`items[${i}] should be a (worker, data) pair`);
      fromBytes(pair[1] as xdr.ScVal, `items[${i}] data`);
      return { worker: fromAddress(pair[0] as xdr.ScVal, `items[${i}] worker`), data: pair[1] as xdr.ScVal };
    });
    const matches = items.filter((item) => item.worker === event.to);
    if (matches.length !== 1) return 'no_matching_item';
    return { call: { kind: 'payroll_pay', companyId, runId }, data: (matches[0] as { data: xdr.ScVal }).data };
  }
  if (contract === 'token' && method === 'confidential_transfer') {
    requireArgCount(args, 3, method);
    const from = fromAddress(args[0] as xdr.ScVal, 'from');
    const to = fromAddress(args[1] as xdr.ScVal, 'to');
    fromBytes(args[2] as xdr.ScVal, 'data');
    if (from !== event.from || to !== event.to) return 'no_matching_item';
    return { call: { kind: 'confidential_transfer' }, data: args[2] as xdr.ScVal };
  }
  return 'not_our_call';
}

/** TransferData { payload, proof }, read with the same point and field decoders as the event. */
function decodeTransferData(data: xdr.ScVal): BoundTransferPayload {
  let value: xdr.ScVal;
  try {
    value = xdr.ScVal.fromXDR(data.bytes(), 'raw');
  } catch {
    throw new DecodeError('the transfer data is not XDR');
  }
  const envelope = fromStruct(value, ['payload', 'proof'] as const, 'TransferData');
  fromBytes(envelope.proof, 'proof');
  const f = fromStruct(envelope.payload, PAYLOAD_FIELDS, 'TransferPayload');
  return {
    cSpendNew: requireOnCurvePoint(fromBytes(f.c_spend_new, 'c_spend_new', 64), 'c_spend_new'),
    cTransfer: requireOnCurvePoint(fromBytes(f.c_transfer, 'c_transfer', 64), 'c_transfer'),
    rE: ephemeralPoint(f.r_e_point, 'r_e_point'),
    vTilde: fieldValue(f.v_tilde, 'v_tilde'),
    bTilde: fieldValue(f.b_tilde, 'b_tilde'),
    sigma: fieldValue(f.sigma, 'sigma'),
    vAudR: fieldValue(f.v_tilde_aud_r, 'v_tilde_aud_r'),
    rAudR: fieldValue(f.r_tilde_aud_r, 'r_tilde_aud_r'),
    vAudS: fieldValue(f.v_tilde_aud_s, 'v_tilde_aud_s'),
    bAudS: fieldValue(f.b_tilde_aud_s, 'b_tilde_aud_s'),
  };
}

function sameFields(event: TransferEventFields, payload: BoundTransferPayload): boolean {
  return (
    event.rE.equals(payload.rE) &&
    event.vTilde === payload.vTilde &&
    event.sigma === payload.sigma &&
    event.bTilde === payload.bTilde &&
    event.vAudR === payload.vAudR &&
    event.rAudR === payload.rAudR &&
    event.vAudS === payload.vAudS &&
    event.bAudS === payload.bAudS
  );
}

/**
 * Ties a transfer event, as an archive or the RPC served it, to the transaction it claims to come
 * from (threat model C18, C19). Every amount a worker or an accountant is shown, sums or exports
 * passes this first, because event fields alone can be re-encrypted by anyone holding the public
 * viewing or auditor key.
 *
 * Fetches the envelope from txSource, recomputes its hash on the testnet passphrase (for a fee
 * bump, the outer or the inner hash) and requires it to equal txHash, requires the transaction to
 * have succeeded, decodes its one call (our payroll's pay or our token's confidential_transfer,
 * by contract id), finds the one transfer for the event's recipient (and, for a direct transfer,
 * its sender), decodes that TransferPayload, and requires r_e_point, v_tilde, sigma, b_tilde,
 * v_tilde_aud_r, r_tilde_aud_r, v_tilde_aud_s and b_tilde_aud_s to equal the event's.
 *
 * Covers: a re-encrypted or edited event, an event pointed at another transaction, a failed
 * transaction, a call to any other contract. Does not cover: whether the proof was valid (the
 * network verified it, or the transaction would have failed), a pay made through another
 * contract rather than as the transaction's own call (it is refused, so it fails closed), and
 * whether c_transfer opens to the decrypted amount, which only the recipient can check.
 *
 * Never throws for anything a source or an event says: every problem is a reason, and the
 * reasons name fields, never values.
 *
 * @throws AddressError only when contracts.token or contracts.payroll is not a C address.
 */
export async function bindTransferToTransaction(input: {
  txSource: TxSourcePort;
  txHash: string;
  event: TransferEventFields;
  contracts: { token: string; payroll: string };
}): Promise<TransferBinding> {
  const contracts = { token: requireAccount(input.contracts.token, ['C']), payroll: requireAccount(input.contracts.payroll, ['C']) };
  const { txHash, event } = input;
  if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) return { ok: false, reason: 'transaction_unavailable' };

  let record: TxRecord | null;
  try {
    record = await input.txSource.transaction(txHash);
  } catch {
    return { ok: false, reason: 'transaction_unavailable' };
  }
  if (record === null || typeof record !== 'object' || typeof record.envelopeXdr !== 'string' || typeof record.successful !== 'boolean') {
    return { ok: false, reason: 'transaction_unavailable' };
  }
  if (record.envelopeXdr.length > MAX_ENVELOPE_CHARS) return { ok: false, reason: 'envelope_unreadable' };

  try {
    const parsed = TransactionBuilder.fromXDR(record.envelopeXdr, NETWORK_PASSPHRASE);
    const inner = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    const hashes = new Set([bytesToHex(parsed.hash()), bytesToHex(inner.hash())]);
    if (!hashes.has(txHash)) return { ok: false, reason: 'hash_mismatch' };
    if (!record.successful) return { ok: false, reason: 'transaction_failed' };
    const call = readCall(inner, contracts);
    if (call === null || call.contract === null) return { ok: false, reason: 'not_our_call' };
    const found = findTransferData(call, event);
    if (typeof found === 'string') return { ok: false, reason: found };
    const payload = decodeTransferData(found.data);
    if (!sameFields(event, payload)) return { ok: false, reason: 'payload_mismatch' };
    return { ok: true, call: found.call, payload };
  } catch {
    return { ok: false, reason: 'envelope_unreadable' };
  }
}

/** One read per transaction hash, for the life of one view: a pay transaction carries several transfers. */
export function oncePerHash(port: TxSourcePort): TxSourcePort {
  const seen = new Map<string, Promise<TxRecord | null>>();
  return {
    transaction(txHash) {
      let read = seen.get(txHash);
      if (read === undefined) {
        read = port.transaction(txHash);
        seen.set(txHash, read);
      }
      return read;
    },
  };
}

class TxSourceReplyError extends Error {
  constructor(what: string) {
    super(`The transaction source reply was refused: ${what}.`);
    this.name = 'TxSourceReplyError';
  }
}

// Same note as rpc-port.ts and events.ts: the build has no DOM or Node types, every runtime has these.
const runtime = globalThis as unknown as {
  fetch(url: string, init: { signal: unknown; headers: Record<string, string>; redirect: 'error' }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  AbortSignal: { timeout(ms: number): unknown };
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

function withTimeout<T>(call: string, work: Promise<T>): Promise<T> {
  let timer: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = runtime.setTimeout(() => reject(new RpcTimeoutError(call)), TX_SOURCE_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => runtime.clearTimeout(timer));
}

/**
 * The live TxSourcePort. It asks the RPC's getTransaction first, which holds about the last 7
 * days, and Horizon's /transactions/{hash} when the RPC does not have the transaction or cannot
 * answer, since Horizon keeps envelopes beyond that window. Both origins come only from the
 * caller's config, every call is bounded by TX_SOURCE_TIMEOUT_MS, and Horizon may not redirect.
 *
 * @throws TypeError when rpcUrl or horizonUrl is not https. transaction() throws TypeError for a
 *   malformed hash, and Horizon's own failure when neither source could answer.
 */
export function createTxSourcePort(config: { rpcUrl: string; horizonUrl: string }): TxSourcePort {
  const { rpcUrl } = config;
  if (typeof rpcUrl !== 'string' || !/^https:\/\/[^\s/]+/.test(rpcUrl)) throw new TypeError('rpcUrl must be an absolute https URL');
  const horizon = httpsBaseUrl(config.horizonUrl, 'horizonUrl');
  const server = new Server(rpcUrl);

  async function fromRpc(txHash: string): Promise<TxRecord | null> {
    // The raw call, so the result meta is never parsed: only the envelope is needed.
    const found = await withTimeout('getTransaction', server._getTransaction(txHash));
    if (found.status === 'NOT_FOUND') return null;
    if ((found.status !== 'SUCCESS' && found.status !== 'FAILED') || typeof found.envelopeXdr !== 'string') {
      throw new TxSourceReplyError('the RPC answer has no envelope');
    }
    return { envelopeXdr: found.envelopeXdr, successful: found.status === 'SUCCESS' };
  }

  async function fromHorizon(txHash: string): Promise<TxRecord | null> {
    const response = await runtime.fetch(`${horizon}transactions/${txHash}`, {
      signal: runtime.AbortSignal.timeout(TX_SOURCE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new TxSourceReplyError(`Horizon answered status ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_HORIZON_REPLY_CHARS) throw new TxSourceReplyError('the Horizon reply is too large');
    const body = JSON.parse(text) as unknown;
    const { envelope_xdr: envelopeXdr, successful } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof envelopeXdr !== 'string' || typeof successful !== 'boolean') throw new TxSourceReplyError('the Horizon reply has no envelope');
    return { envelopeXdr, successful };
  }

  return {
    async transaction(txHash) {
      if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) throw new TypeError('txHash must be 64 lowercase hex characters');
      try {
        const found = await fromRpc(txHash);
        if (found !== null) return found;
      } catch {
        // An RPC that is down, slow or out of shape is not an answer; Horizon may still hold it.
      }
      return fromHorizon(txHash);
    },
  };
}

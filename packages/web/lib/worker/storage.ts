import { MAX_WORKER_COMPANIES, parseAccount } from "@kalypso/core";

/** The slice of the Web Storage API the worker portal uses, so tests can hand in a map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A passkey wallet this browser created, kept until its contract is on chain and after. All of it is public. */
export interface PasskeyRecord {
  /** The credential id, base64url. */
  keyId: string;
  /** The passkey's 65-byte uncompressed P-256 public key, base64url. */
  publicKey: string;
  /** The wallet's deploy call (a base64 HostFunction), so it can be sent later through the sponsor. */
  deployFunc: string;
  /** The transaction that created the wallet, once read from chain as its birth from the pinned code trusting this key (C51). */
  birth: { hash: string } | null;
  /** The deploy relay sent but not yet proven to be the wallet's birth, so a lost answer can still be followed to it. */
  deployRelay: { transactionId: string; hash: string | null } | null;
}

/**
 * What this browser remembers about one worker. Nothing in it is secret: the chain is the source of
 * truth for every fact here, and each one is checked against it before it is used.
 */
export interface WorkerRecord {
  /**
   * Companies the chain confirmed with this worker on their roster (a view's confirmedCompanyIds,
   * or a join the chain showed active), in join order, the newest MAX_WORKER_COMPANIES kept.
   */
  companyIds: bigint[];
  /** The auditor id this worker's own confirmed register_key returned (C43). */
  auditorId: number | null;
  /** A register_key relay sent but not yet resolved to an id, so a reload finds it instead of registering a second key. */
  auditorKeyRelay: { transactionId: string; hash: string | null } | null;
  /** The ledger of the worker's token registration: history for this worker never needs to start later. */
  registeredLedger: number | null;
  passkey: PasskeyRecord | null;
}

const PREFIX = "kalypso/worker/v1/";
const U64_DECIMAL = /^(0|[1-9]\d{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,512}$/;
const BASE64 = /^[A-Za-z0-9+/]{1,16384}={0,2}$/;
const MAX_RECORD_CHARS = 64 * 1024;

export const emptyRecord = (): WorkerRecord => ({ companyIds: [], auditorId: null, auditorKeyRelay: null, registeredLedger: null, passkey: null });

/** The storage key for a worker, built from the address after the one address parser, so one account has one key. */
export function workerRecordKey(address: string): string {
  return PREFIX + parseAccount(address).address;
}

function field(raw: unknown, key: string): unknown {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)[key] : undefined;
}

function readCompanyIds(raw: unknown): bigint[] {
  if (!Array.isArray(raw)) return [];
  const out: bigint[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !U64_DECIMAL.test(item)) continue;
    const id = BigInt(item);
    if (id > U64_MAX || out.includes(id)) continue;
    out.push(id);
    if (out.length === MAX_WORKER_COMPANIES) break;
  }
  return out;
}

function readU32(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= U32_MAX ? raw : null;
}

function readRelay(raw: unknown): WorkerRecord["auditorKeyRelay"] {
  const transactionId = field(raw, "transactionId");
  const hash = field(raw, "hash");
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) return null;
  if (!(hash === null || (typeof hash === "string" && TX_HASH.test(hash)))) return null;
  return { transactionId, hash };
}

function readBirth(raw: unknown): PasskeyRecord["birth"] {
  const hash = field(raw, "hash");
  return typeof hash === "string" && TX_HASH.test(hash) ? { hash } : null;
}

// A record saved before birth and deployRelay existed has neither field, and reads as null for
// both, the same as a damaged value: either way the birth is looked up again, never assumed.
function readPasskey(raw: unknown): PasskeyRecord | null {
  const keyId = field(raw, "keyId");
  const publicKey = field(raw, "publicKey");
  const deployFunc = field(raw, "deployFunc");
  if (typeof keyId !== "string" || !BASE64URL.test(keyId)) return null;
  // 65 bytes is 87 base64url characters with no padding.
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) return null;
  if (typeof deployFunc !== "string" || !BASE64.test(deployFunc)) return null;
  return { keyId, publicKey, deployFunc, birth: readBirth(field(raw, "birth")), deployRelay: readRelay(field(raw, "deployRelay")) };
}

/**
 * The worker's record, read as untrusted input: a missing, unreadable, oversized or damaged value
 * reads as an empty record, and each field is checked on its own, so one bad field never takes the
 * others with it. Company ids must be u64 decimals; duplicates are dropped and at most
 * MAX_WORKER_COMPANIES are kept. Never throws.
 */
export function readWorkerRecord(storage: KeyValueStorage | null, address: string): WorkerRecord {
  let text: string | null = null;
  try {
    text = storage === null ? null : storage.getItem(workerRecordKey(address));
  } catch {
    return emptyRecord();
  }
  if (text === null || text.length > MAX_RECORD_CHARS) return emptyRecord();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyRecord();
  }
  if (field(raw, "v") !== 1) return emptyRecord();
  return {
    companyIds: readCompanyIds(field(raw, "companyIds")),
    auditorId: readU32(field(raw, "auditorId")),
    auditorKeyRelay: readRelay(field(raw, "auditorKeyRelay")),
    registeredLedger: readU32(field(raw, "registeredLedger")),
    passkey: readPasskey(field(raw, "passkey")),
  };
}

/** Writes the record. Returns false when the browser refused (private mode, a full quota), so the caller can say so. */
export function writeWorkerRecord(storage: KeyValueStorage | null, address: string, record: WorkerRecord): boolean {
  if (storage === null) return false;
  const value = JSON.stringify({
    v: 1,
    companyIds: record.companyIds.map((id) => id.toString()),
    auditorId: record.auditorId,
    auditorKeyRelay: record.auditorKeyRelay,
    registeredLedger: record.registeredLedger,
    passkey: record.passkey,
  });
  try {
    storage.setItem(workerRecordKey(address), value);
    return true;
  } catch {
    return false;
  }
}

/** Reads, changes and writes the record in one step. Returns false when the write was refused. */
export function updateWorkerRecord(storage: KeyValueStorage | null, address: string, change: (record: WorkerRecord) => void): boolean {
  const record = readWorkerRecord(storage, address);
  change(record);
  return writeWorkerRecord(storage, address, record);
}

/**
 * Adds a company id once, keeping the join order. At MAX_WORKER_COMPANIES the oldest makes room
 * for it: the record only caches what the chain confirmed, and the payroll contract's join events
 * bring an old company back to a view.
 */
export function withCompany(record: WorkerRecord, companyId: bigint): void {
  if (record.companyIds.includes(companyId)) return;
  record.companyIds.push(companyId);
  if (record.companyIds.length > MAX_WORKER_COMPANIES) record.companyIds.splice(0, record.companyIds.length - MAX_WORKER_COMPANIES);
}

/** Replaces the recorded companies with these, each once, in order, the newest MAX_WORKER_COMPANIES kept. */
export function setCompanies(record: WorkerRecord, companyIds: readonly bigint[]): void {
  record.companyIds = [];
  for (const companyId of companyIds) withCompany(record, companyId);
}

/** window.localStorage when the page can use it, null when it cannot (server render, blocked storage). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

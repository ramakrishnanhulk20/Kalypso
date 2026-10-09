import { MAX_STROOPS } from "@kalypso/core";
import type { InFlightPay, OpeningStore, SavedOpening } from "@kalypso/core";
import { FR_MODULUS, StrKey } from "./sdk";

export const STORAGE_KEY = "kalypso/sandbox/v1";

export const SANDBOX_STEPS = ["keys", "fund", "usdc", "accountant", "treasury", "company", "workers", "deposit", "run", "pay", "done"] as const;
export type SandboxStep = (typeof SANDBOX_STEPS)[number];

/** A transaction the sandbox sent. The hash is saved before it is sent, so a reload finds it on chain instead of sending another. */
export interface JournalEntry {
  hash: string;
  /** True once the chain confirmed it. */
  landed: boolean;
  /** Last valid moment in Unix seconds. Always set while landed is false. */
  validUntil?: number;
  ledger?: number;
}

export type StoredValue = SavedOpening | InFlightPay | readonly string[];

type Three<T> = [T, T, T];

export interface SandboxState {
  /** The contracts this sandbox lives on. A sandbox saved on another stack is never resumed. */
  stack: { payroll: string; token: string; auditor: string };
  /** The furthest step reached. Each step still checks the chain before it skips anything. */
  step: SandboxStep;
  /** A ledger at or before every sandbox account existed, where history reads start. */
  fromLedger: number;
  runId: bigint;
  /** Salaries in stroops, worker 1 to 3. */
  amounts: Three<bigint>;
  /** What the treasury buys and deposits: the salaries plus 2 percent. Public on chain. */
  deposit: bigint;
  /** Stellar secret seeds of the five throwaway accounts. Testnet only. */
  secrets: { employer: string; accountant: string; workers: Three<string> };
  auditorSecrets: { accountant: bigint; workers: Three<bigint> };
  /** Each id exactly as its own confirmed register_key returned it (C43). */
  auditorIds: { accountant: number | null; workers: Three<number | null> };
  companyId: bigint | null;
  txs: Record<string, JournalEntry>;
  /** core's OpeningStore entries for the treasury: openings, attempts list, pay in flight. */
  openings: Record<string, StoredValue>;
  payTxHashes: string[];
}

/** The part of window.localStorage the sandbox uses, so tests can pass a map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DECIMAL = /^(0|[1-9]\d{0,77})$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_U32 = 0xffff_ffff;
const MAX_JOURNAL_ENTRIES = 100;
const MAX_LABEL_LENGTH = 120;
// core keeps at most 500 attempt keys per treasury, plus one opening each and a few fixed keys.
const MAX_OPENING_ENTRIES = 1_100;
const MAX_KEY_LENGTH = 300;
const MAX_PAY_TRANSACTIONS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bigintFrom(value: unknown, min: bigint, max: bigint): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new TypeError("not a decimal");
  const n = BigInt(value);
  if (n < min || n > max) throw new RangeError("out of range");
  return n;
}

function wholeFrom(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError("not a whole number in range");
  return value;
}

function nullable<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function three<T>(value: unknown, read: (v: unknown) => T): Three<T> {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError("not three items");
  return [read(value[0]), read(value[1]), read(value[2])];
}

function secretFrom(value: unknown): string {
  if (typeof value !== "string" || !StrKey.isValidEd25519SecretSeed(value)) throw new TypeError("not a secret seed");
  return value;
}

function contractFrom(value: unknown): string {
  if (typeof value !== "string" || !CONTRACT.test(value)) throw new TypeError("not a contract id");
  return value;
}

const auditorSecretFrom = (v: unknown) => bigintFrom(v, 1n, FR_MODULUS - 1n);
const salaryFrom = (v: unknown) => bigintFrom(v, 1n, MAX_STROOPS);
const auditorIdFrom = (v: unknown) => nullable(v, (id) => wholeFrom(id, 0, MAX_U32));

function journalFrom(value: unknown): Record<string, JournalEntry> {
  if (!isRecord(value)) throw new TypeError("journal is not an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_JOURNAL_ENTRIES) throw new RangeError("journal too long");
  const out: Record<string, JournalEntry> = Object.create(null);
  for (const [label, entry] of entries) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH || !isRecord(entry)) throw new TypeError("bad journal entry");
    if (typeof entry.hash !== "string" || !TX_HASH.test(entry.hash)) throw new TypeError("bad hash");
    if (typeof entry.landed !== "boolean") throw new TypeError("bad landed flag");
    const read: JournalEntry = { hash: entry.hash, landed: entry.landed };
    if (entry.validUntil !== undefined) read.validUntil = wholeFrom(entry.validUntil, 1, Number.MAX_SAFE_INTEGER);
    if (entry.ledger !== undefined) read.ledger = wholeFrom(entry.ledger, 1, MAX_U32);
    // A pending transaction without its validity window could never be settled.
    if (!read.landed && read.validUntil === undefined) throw new TypeError("pending entry without a window");
    out[label] = read;
  }
  return out;
}

function hashesFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PAY_TRANSACTIONS) throw new TypeError("bad pay hashes");
  return value.map((h) => {
    if (typeof h !== "string" || !TX_HASH.test(h)) throw new TypeError("bad pay hash");
    return h;
  });
}

// Only the shape is checked here: core reads every value back as untrusted and checks it against
// the chain itself, so a damaged opening is treated as missing there, never trusted.
function openingsFrom(value: unknown): Record<string, StoredValue> {
  if (!isRecord(value)) throw new TypeError("openings is not an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_OPENING_ENTRIES) throw new RangeError("too many openings");
  const out: Record<string, StoredValue> = Object.create(null);
  for (const [key, stored] of entries) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw new TypeError("bad opening key");
    const flat = Array.isArray(stored)
      ? stored.every((s) => typeof s === "string")
      : isRecord(stored) && Object.values(stored).every((v) => typeof v === "string" || typeof v === "number");
    if (!flat) throw new TypeError("bad opening value");
    out[key] = stored as StoredValue;
  }
  return out;
}

/**
 * Reads saved sandbox text back. Any missing field, wrong type, out-of-range number, duplicate
 * account or unknown version returns null, so a damaged or tampered save starts a new sandbox
 * instead of signing anything from it.
 */
export function parseState(text: string | null): SandboxState | null {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.version !== 1) return null;
    const { stack, secrets, auditorSecrets, auditorIds } = raw;
    if (!isRecord(stack) || !isRecord(secrets) || !isRecord(auditorSecrets) || !isRecord(auditorIds)) return null;
    if (typeof raw.step !== "string" || !(SANDBOX_STEPS as readonly string[]).includes(raw.step)) return null;
    const state: SandboxState = {
      stack: { payroll: contractFrom(stack.payroll), token: contractFrom(stack.token), auditor: contractFrom(stack.auditor) },
      step: raw.step as SandboxStep,
      fromLedger: wholeFrom(raw.fromLedger, 1, MAX_U32),
      runId: bigintFrom(raw.runId, 0n, MAX_U64),
      amounts: three(raw.amounts, salaryFrom),
      deposit: salaryFrom(raw.deposit),
      secrets: { employer: secretFrom(secrets.employer), accountant: secretFrom(secrets.accountant), workers: three(secrets.workers, secretFrom) },
      auditorSecrets: { accountant: auditorSecretFrom(auditorSecrets.accountant), workers: three(auditorSecrets.workers, auditorSecretFrom) },
      auditorIds: { accountant: auditorIdFrom(auditorIds.accountant), workers: three(auditorIds.workers, auditorIdFrom) },
      companyId: nullable(raw.companyId, (id) => bigintFrom(id, 0n, MAX_U64)),
      txs: journalFrom(raw.txs),
      openings: openingsFrom(raw.openings),
      payTxHashes: hashesFrom(raw.payTxHashes),
    };
    const accounts = [state.secrets.employer, state.secrets.accountant, ...state.secrets.workers];
    if (new Set(accounts).size !== accounts.length) return null;
    const total = state.amounts.reduce((a, b) => a + b, 0n);
    if (state.deposit < total) return null;
    return state;
  } catch {
    return null;
  }
}

/** The state as JSON, bigints as decimal strings. */
export function serializeState(state: SandboxState): string {
  return JSON.stringify({
    version: 1,
    stack: state.stack,
    step: state.step,
    fromLedger: state.fromLedger,
    runId: state.runId.toString(),
    amounts: state.amounts.map(String),
    deposit: state.deposit.toString(),
    secrets: state.secrets,
    auditorSecrets: { accountant: state.auditorSecrets.accountant.toString(), workers: state.auditorSecrets.workers.map(String) },
    auditorIds: state.auditorIds,
    companyId: state.companyId === null ? null : state.companyId.toString(),
    txs: state.txs,
    openings: state.openings,
    payTxHashes: state.payTxHashes,
  });
}

/** Thrown when reset() ran while a sandbox run was still saving: that run stops instead of bringing the old sandbox back. */
export class SandboxResetError extends Error {
  constructor() {
    super("The sandbox was reset, so this run stopped.");
    this.name = "SandboxResetError";
  }
}

let generation = 0;

/** Where one run reads and writes its state. Saves stop working after clear(), from any session. */
export interface SandboxSession {
  load(): SandboxState | null;
  save(state: SandboxState): void;
}

function readText(storage: KeyValueStorage): string | null {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    // Storage the browser refuses to read is treated like no sandbox at all.
    return null;
  }
}

/**
 * Opens the saved sandbox for one run. load() returns null for a missing or malformed save, and
 * for one made on another stack. save() throws SandboxResetError once clearSandbox ran after this
 * session opened, and lets the storage's own error through when the browser refuses the write, so
 * nothing is ever sent whose record could not be kept.
 */
export function openSession(storage: KeyValueStorage, stack: SandboxState["stack"]): SandboxSession {
  const opened = generation;
  return {
    load() {
      const state = parseState(readText(storage));
      if (state === null) return null;
      const same = state.stack.payroll === stack.payroll && state.stack.token === stack.token && state.stack.auditor === stack.auditor;
      return same ? state : null;
    },
    save(state) {
      if (generation !== opened) throw new SandboxResetError();
      storage.setItem(STORAGE_KEY, serializeState(state));
    },
  };
}

/** Removes the saved sandbox and stops every session opened before this call from saving again. */
export function clearSandbox(storage: KeyValueStorage): void {
  generation += 1;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing saved that could be removed */
  }
}

/**
 * core's OpeningStore kept inside the sandbox state. Every write is saved before it returns, so
 * the opening a pay leaves behind is on disk before core sends that pay (C29).
 */
export function openingStoreOf(state: SandboxState, save: () => void): OpeningStore {
  return {
    get: async (key) => (Object.hasOwn(state.openings, key) ? state.openings[key] : undefined),
    put: async (key, value) => {
      state.openings[key] = JSON.parse(JSON.stringify(value)) as StoredValue;
      save();
    },
    delete: async (key) => {
      if (!Object.hasOwn(state.openings, key)) return;
      delete state.openings[key];
      save();
    },
  };
}

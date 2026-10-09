import type { InFlightPay, OpeningStore, SavedOpening } from "@kalypso/core";
import { ConsoleError } from "./errors";

export const OPENINGS_DATABASE = "kalypso";
export const OPENINGS_STORE = "openings";
const DATABASE_VERSION = 1;

type StoredValue = SavedOpening | InFlightPay | readonly string[];

// core keeps at most 500 attempt keys per treasury, each under 240 characters, so a real value is
// far below this. The cap only bounds what JSON.parse is ever handed.
const MAX_VALUE_CHARS = 200_000;
const MAX_KEY_CHARS = 300;
const MAX_LIST_ITEMS = 1_000;

/** Text kept under a key. The IndexedDB one is the app's; tests pass a map. */
export interface TextStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, text: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/**
 * One stored value, read back as untrusted: a treasury opening ({ v, r, commitment }, all
 * strings), a pay in flight ({ hash, maxTime, batchKey }), or a list of strings. Anything else,
 * including text that is not JSON, reads as missing. Only the shape is checked here: core checks
 * each opening against itself and the chain, and each record against its own rules.
 */
export function readStoredValue(text: unknown): StoredValue | undefined {
  if (typeof text !== "string" || text.length > MAX_VALUE_CHARS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_LIST_ITEMS && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (hasExactly(value, ["v", "r", "commitment"]) && typeof value.v === "string" && typeof value.r === "string" && typeof value.commitment === "string") {
    return { v: value.v, r: value.r, commitment: value.commitment };
  }
  if (hasExactly(value, ["hash", "maxTime", "batchKey"]) && typeof value.hash === "string" && typeof value.maxTime === "number" && typeof value.batchKey === "string") {
    return { hash: value.hash, maxTime: value.maxTime, batchKey: value.batchKey };
  }
  return undefined;
}

function requireKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS) throw new TypeError("store keys are 1 to 300 characters");
  return key;
}

/**
 * core's OpeningStore over a text store, values as JSON. A value is written only if it reads back
 * as the same shape (threat model C41: never write a record that cannot be read back), and a put
 * resolves only once the text store says it is saved, so the opening a pay leaves behind is kept
 * before core sends that pay (C29).
 */
export function openingStoreOver(text: TextStore): OpeningStore {
  return {
    async get(key) {
      return readStoredValue(await text.get(requireKey(key)));
    },
    async put(key, value) {
      const json = JSON.stringify(value);
      if (readStoredValue(json) === undefined) throw new TypeError("this value cannot be stored as a treasury record");
      await text.put(requireKey(key), json);
    },
    async delete(key) {
      await text.delete(requireKey(key));
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * The browser's IndexedDB as a text store: database "kalypso", object store "openings". Writes
 * use strict durability, so a put resolves only after the browser has flushed it to disk.
 *
 * @throws ConsoleError STORAGE_UNAVAILABLE when there is no IndexedDB (server render, some
 *   private modes), or STORAGE_FAILED when the browser refuses a read or write. Nothing is sent
 *   after either, because core stops a pay whose opening could not be kept.
 */
export function indexedDbTextStore(factory: IDBFactory | undefined = globalThis.indexedDB): TextStore {
  let opened: Promise<IDBDatabase> | undefined;
  const database = (): Promise<IDBDatabase> => {
    if (factory === undefined) return Promise.reject(new ConsoleError("STORAGE_UNAVAILABLE"));
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(OPENINGS_DATABASE, DATABASE_VERSION);
      } catch {
        reject(new ConsoleError("STORAGE_UNAVAILABLE"));
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(OPENINGS_STORE)) req.result.createObjectStore(OPENINGS_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // A newer version opened in another tab closes this connection; the next call reopens.
        db.onversionchange = () => {
          db.close();
          opened = undefined;
        };
        resolve(db);
      };
      req.onerror = () => reject(new ConsoleError("STORAGE_UNAVAILABLE"));
      req.onblocked = () => reject(new ConsoleError("STORAGE_FAILED"));
    }).catch((err: unknown) => {
      opened = undefined;
      throw err;
    });
    return opened;
  };

  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await database();
    try {
      const tx = mode === "readwrite" ? db.transaction(OPENINGS_STORE, mode, { durability: "strict" }) : db.transaction(OPENINGS_STORE, mode);
      const done = finished(tx);
      // A failed request also fails its transaction; that second rejection is the same failure.
      done.catch(() => undefined);
      const result = await request(work(tx.objectStore(OPENINGS_STORE)));
      await done;
      return result;
    } catch {
      throw new ConsoleError("STORAGE_FAILED");
    }
  };

  return {
    async get(key) {
      const value = await run("readonly", (store) => store.get(key) as IDBRequest<unknown>);
      return typeof value === "string" ? value : undefined;
    },
    async put(key, text) {
      await run("readwrite", (store) => store.put(text, key));
    },
    async delete(key) {
      await run("readwrite", (store) => store.delete(key));
    },
  };
}

let browserText: TextStore | undefined;
let browserStore: OpeningStore | undefined;

/** This browser's IndexedDB text store, one connection per page. */
export function browserTextStore(): TextStore {
  browserText ??= indexedDbTextStore();
  return browserText;
}

/** This browser's treasury records: core's OpeningStore over IndexedDB. */
export function browserOpeningStore(): OpeningStore {
  browserStore ??= openingStoreOver(browserTextStore());
  return browserStore;
}

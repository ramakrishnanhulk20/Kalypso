// Covers the employer's opening store: core's OpeningStore over IndexedDB round-trips an opening, a
// pay in flight and an attempts list, refuses to write what it could not read back, and reads every
// malformed value as missing; core then treats a damaged opening as missing too. The IndexedDB side
// runs against a small in-memory stand-in written here. Does NOT cover a real browser's IndexedDB
// (quotas, private modes, strict durability on disk): the live headless Chrome run covers that.
import { readSavedOpening, toSavedOpening, treasuryOpeningKey } from "@kalypso/core";
import { describe, expect, it } from "vitest";
import { sandboxConfig } from "../sandbox/config";
import { Keypair } from "../sandbox/sdk";
import { ConsoleError } from "./errors";
import { OPENINGS_DATABASE, OPENINGS_STORE, indexedDbTextStore, openingStoreOver, readStoredValue, type TextStore } from "./opening-store";

type Handler = (() => void) | null;

/** Just enough of IndexedDB for the adapter: open with upgrade, one store, get/put/delete, oncomplete. */
function fakeIndexedDb(options: { failWrites?: boolean } = {}) {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const factory = {
    open(name: string) {
      const req = { result: undefined as unknown, error: null, onsuccess: null as Handler, onerror: null as Handler, onupgradeneeded: null as Handler, onblocked: null as Handler };
      later(() => {
        const isNew = !databases.has(name);
        const stores = databases.get(name) ?? new Map<string, Map<string, unknown>>();
        databases.set(name, stores);
        const db = {
          onversionchange: null as Handler,
          close() {},
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore(s: string) {
            stores.set(s, new Map());
          },
          transaction(s: string, mode: string) {
            const data = stores.get(s);
            if (!data) throw new Error("NotFoundError");
            const tx = { error: null, oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, objectStore: () => store };
            const settle = (req2: { onsuccess: Handler; onerror: Handler; result: unknown; error: unknown }, work: () => unknown) =>
              later(() => {
                if (mode === "readwrite" && options.failWrites) {
                  req2.error = new Error("QuotaExceededError");
                  req2.onerror?.();
                  tx.onerror?.();
                  return;
                }
                req2.result = work();
                req2.onsuccess?.();
                later(() => tx.oncomplete?.());
              });
            const request = (work: () => unknown) => {
              const r = { result: undefined as unknown, error: null as unknown, onsuccess: null as Handler, onerror: null as Handler };
              settle(r, work);
              return r;
            };
            const store = {
              get: (key: string) => request(() => data.get(key)),
              put: (value: unknown, key: string) => request(() => void data.set(key, value)),
              delete: (key: string) => request(() => void data.delete(key)),
            };
            return tx;
          },
        };
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, databases };
}

function memoryText(): TextStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}

const token = sandboxConfig().contracts.token;
const treasury = Keypair.random().publicKey();
const openingKey = treasuryOpeningKey(token, treasury);
const batchKey = `kalypso/v1/batch/${sandboxConfig().contracts.payroll}/7/202610/${treasury}/${"ab".repeat(32)}`;

describe("openingStoreOver IndexedDB", () => {
  it("round-trips an opening, a pay in flight and an attempts list in database kalypso, store openings", async () => {
    const idb = fakeIndexedDb();
    const store = openingStoreOver(indexedDbTextStore(idb.factory));
    const opening = toSavedOpening(1_234_567n, 987_654_321n);
    const inFlight = { hash: "ab".repeat(32), maxTime: 1_900_000_000, batchKey };
    await store.put(openingKey, opening);
    await store.put("kalypso/v1/inflight/x", inFlight);
    await store.put("kalypso/v1/attempts/x", [batchKey]);

    expect(await store.get(openingKey)).toEqual(opening);
    expect(readSavedOpening(await store.get(openingKey))?.v).toBe(1_234_567n);
    expect(await store.get("kalypso/v1/inflight/x")).toEqual(inFlight);
    expect(await store.get("kalypso/v1/attempts/x")).toEqual([batchKey]);
    expect(typeof idb.databases.get(OPENINGS_DATABASE)?.get(OPENINGS_STORE)?.get(openingKey)).toBe("string");

    await store.delete(openingKey);
    expect(await store.get(openingKey)).toBeUndefined();
    await expect(store.delete("never-there")).resolves.toBeUndefined();
  });

  it("refuses every write when the browser refuses it, so core never sends a pay whose opening was not kept", async () => {
    const store = openingStoreOver(indexedDbTextStore(fakeIndexedDb({ failWrites: true }).factory));
    await expect(store.put(openingKey, toSavedOpening(1n, 2n))).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });

  it("says plainly when there is no IndexedDB at all", async () => {
    const store = openingStoreOver(indexedDbTextStore(undefined));
    const refused = store.get(openingKey);
    await expect(refused).rejects.toBeInstanceOf(ConsoleError);
    await expect(refused).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});

describe("defensive reads", () => {
  it("reads every malformed value as missing", async () => {
    const text = memoryText();
    const store = openingStoreOver(text);
    const damaged: Record<string, string> = {
      notJson: "{v:1",
      number: "42",
      nullValue: "null",
      wrongTypes: JSON.stringify({ v: 1, r: "2", commitment: "c" }),
      extraField: JSON.stringify({ v: "1", r: "2", commitment: "c", note: "x" }),
      missingField: JSON.stringify({ v: "1", r: "2" }),
      inFlightBadTime: JSON.stringify({ hash: "ab", maxTime: "soon", batchKey }),
      listWithNumber: JSON.stringify(["a", 1]),
      huge: JSON.stringify(["x".repeat(300_000)]),
    };
    for (const [key, value] of Object.entries(damaged)) text.map.set(key, value);
    for (const key of Object.keys(damaged)) expect(await store.get(key), key).toBeUndefined();
    expect(readStoredValue(undefined)).toBeUndefined();
  });

  it("leaves a well-shaped but tampered opening for core to refuse", async () => {
    const text = memoryText();
    const store = openingStoreOver(text);
    const opening = toSavedOpening(500n, 77n);
    text.map.set(openingKey, JSON.stringify({ ...opening, v: "501" }));
    const read = await store.get(openingKey);
    expect(read).toEqual({ ...opening, v: "501" });
    expect(readSavedOpening(read)).toBeUndefined();
  });

  it("never writes a value it could not read back", async () => {
    const store = openingStoreOver(memoryText());
    await expect(store.put(openingKey, { v: 1n } as never)).rejects.toThrow();
    await expect(store.put(openingKey, { v: "1", r: "2" } as never)).rejects.toThrow(/cannot be stored/);
    await expect(store.put("", toSavedOpening(1n, 2n))).rejects.toThrow(/1 to 300/);
  });
});

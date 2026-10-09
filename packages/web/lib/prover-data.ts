import { setUltraHonkBackendLoader, type UltraHonkBackendLoader } from "../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";

// bb.js 0.87.0 in a browser fetches its proving data (the CRS) from crs.aztec.network with no
// way to pass another address, then caches it in IndexedDB and skips the network whenever the
// cache is long enough. Writing our own checked copy into that cache before bb.js starts means
// the browser never contacts Aztec, and the page's connect-src does not list it. Everything
// below follows bb.js 0.87.0's internals; prover-data.test.ts fails when that version changes.

/** The bb.js version whose cache layout this module writes. */
export const BB_VERSION = "0.87.0";

/** Points bb.js asks for on the largest circuit (transfer and withdraw): subgroup 32,768 plus one. */
export const CRS_POINTS = 32_769;

export const CRS_G1_BYTES = CRS_POINTS * 64;
export const CRS_G2_BYTES = 128;

/** sha256 of public/crs/g1.dat, the first 32,769 points of crs.aztec.network/g1.dat. */
export const CRS_G1_SHA256 = "d769ac6c98f8fab858a7e9967f2b7f181d8ad9fdcdf55438c915696febf0e99c";

/** sha256 of public/crs/g2.dat, a copy of crs.aztec.network/g2.dat. */
export const CRS_G2_SHA256 = "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f";

/** bb.js reads its cache through idb-keyval's default database and store, under these keys. */
export const BB_CACHE = { database: "keyval-store", store: "keyval", g1Key: "g1Data", g2Key: "g2Data" } as const;

const FILES = [
  { path: "/crs/g1.dat", bytes: CRS_G1_BYTES, sha256: CRS_G1_SHA256, key: BB_CACHE.g1Key },
  { path: "/crs/g2.dat", bytes: CRS_G2_BYTES, sha256: CRS_G2_SHA256, key: BB_CACHE.g2Key },
] as const;

type BackendCtor = Awaited<ReturnType<UltraHonkBackendLoader>>;

export interface ProverDataDeps {
  /** Fetches a same-origin path. */
  fetch(path: string): Promise<Response>;
  /** Writes every entry in one transaction, so a failure leaves none of them written. */
  write(entries: ReadonlyArray<readonly [key: string, value: Uint8Array]>): Promise<void>;
  setLoader(loader: UltraHonkBackendLoader): void;
  loadBackend(): Promise<BackendCtor>;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readChecked(deps: ProverDataDeps, file: (typeof FILES)[number]): Promise<Uint8Array> {
  const response = await deps.fetch(file.path);
  if (!response.ok) throw new Error(`The proving data ${file.path} did not load (HTTP ${response.status}).`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== file.bytes) throw new Error(`The proving data ${file.path} has the wrong size.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes || (await sha256Hex(bytes)) !== file.sha256) {
    throw new Error(`The proving data ${file.path} failed its integrity check.`);
  }
  return bytes;
}

/**
 * Builds the installer from its parts so tests can run it without a browser. The returned
 * function installs the loader once and resolves when the checked data is in bb.js's cache. Both
 * files are checked before either is written. A failed attempt is forgotten, so the next proof
 * tries again.
 */
export function createProverDataInstaller(deps: ProverDataDeps): () => Promise<void> {
  let seeded: Promise<void> | undefined;
  let installed = false;

  const seed = (): Promise<void> => {
    seeded ??= (async () => {
      const [g1, g2] = await Promise.all(FILES.map((file) => readChecked(deps, file)));
      await deps.write([
        [BB_CACHE.g1Key, g1],
        [BB_CACHE.g2Key, g2],
      ]);
    })().catch((error: unknown) => {
      seeded = undefined;
      throw error;
    });
    return seeded;
  };

  return async () => {
    if (!installed) {
      // The loader runs right before bb.js builds a backend, so awaiting the seed here holds
      // every backend back until the cache is filled, whichever path asked for it.
      deps.setLoader(async () => {
        await seed();
        return deps.loadBackend();
      });
      installed = true;
    }
    await seed();
  };
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BB_CACHE.database);
    request.onupgradeneeded = () => request.result.createObjectStore(BB_CACHE.store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeCache(entries: ReadonlyArray<readonly [string, Uint8Array]>): Promise<void> {
  const db = await openCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BB_CACHE.store, "readwrite");
      const store = tx.objectStore(BB_CACHE.store);
      for (const [key, value] of entries) store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const install = createProverDataInstaller({
  fetch: (path) => fetch(path, { redirect: "error" }),
  write: writeCache,
  setLoader: setUltraHonkBackendLoader,
  // The same file the SDK's own loader resolves to in a browser, from core's install, so the
  // bundle keeps one copy of bb.js. Its browser build ships no type declarations; the SDK's
  // loader type checks the shape on return.
  loadBackend: async () =>
    // @ts-expect-error bb.js publishes types for its Node build only.
    (await import("../../core/node_modules/@aztec/bb.js/dest/browser/index.js")).UltraHonkBackend as BackendCtor,
});

/**
 * Puts the self-hosted, hash-checked proving data where bb.js looks for it and routes bb.js
 * through it. Call before the first proof. Safe to call any number of times.
 *
 * @throws Error when a file fails to load, has the wrong size or hash, or IndexedDB refuses the
 *   write. Nothing is written in that case and bb.js cannot start, so no proof is attempted
 *   against unchecked data.
 */
export async function installProverData(): Promise<void> {
  return install();
}

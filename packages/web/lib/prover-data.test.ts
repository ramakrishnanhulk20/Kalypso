// Covers the proving-data installer: the committed files pass their own hash check and land
// under bb.js's cache keys, a tampered file is refused with nothing written, a second call does
// no new work, a failed attempt is retried, and the bb.js version and cache layout it relies on.
// Does NOT cover: a real IndexedDB, or bb.js actually reading the cache and skipping the
// network (the browser walk in the CSP work order checks that against testnet).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BB_CACHE, BB_VERSION, CRS_G1_BYTES, CRS_G2_BYTES, createProverDataInstaller, type ProverDataDeps } from "./prover-data";

const publicDir = path.join(import.meta.dirname, "../public");
const bbDir = path.join(import.meta.dirname, "../../core/node_modules/@aztec/bb.js");

function committed(urlPath: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(path.join(publicDir, urlPath)));
}

type Written = ReadonlyArray<readonly [string, Uint8Array]>;

function harness(serve: (urlPath: string) => Uint8Array<ArrayBuffer> | null = committed) {
  const fetched: string[] = [];
  const writes: Written[] = [];
  const loaders: Parameters<ProverDataDeps["setLoader"]>[0][] = [];
  const backend = class {} as unknown as Awaited<ReturnType<ProverDataDeps["loadBackend"]>>;
  const deps: ProverDataDeps = {
    fetch: async (urlPath) => {
      fetched.push(urlPath);
      const bytes = serve(urlPath);
      return bytes === null ? new Response(null, { status: 503 }) : new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    },
    write: async (entries) => void writes.push(entries),
    setLoader: (loader) => void loaders.push(loader),
    loadBackend: async () => backend,
  };
  return { deps, fetched, writes, loaders, backend, install: createProverDataInstaller(deps) };
}

describe("proving data installer", () => {
  it("writes the committed files under bb.js's two cache keys in one write", async () => {
    const h = harness();
    await h.install();
    expect(h.writes).toHaveLength(1);
    const [[g1Key, g1], [g2Key, g2]] = h.writes[0];
    expect([g1Key, g2Key]).toEqual([BB_CACHE.g1Key, BB_CACHE.g2Key]);
    expect(g1.byteLength).toBe(CRS_G1_BYTES);
    expect(g2.byteLength).toBe(CRS_G2_BYTES);
  });

  it("refuses a file whose hash does not match and writes nothing", async () => {
    const h = harness((urlPath) => {
      const bytes = committed(urlPath);
      if (urlPath === "/crs/g2.dat") bytes[7] ^= 1;
      return bytes;
    });
    await expect(h.install()).rejects.toThrow("/crs/g2.dat failed its integrity check");
    expect(h.writes).toHaveLength(0);
  });

  it("installs the loader once and fetches each file once however often it is called", async () => {
    const h = harness();
    await h.install();
    await h.install();
    expect(h.loaders).toHaveLength(1);
    await expect(h.loaders[0]()).resolves.toBe(h.backend);
    expect(h.fetched.sort()).toEqual(["/crs/g1.dat", "/crs/g2.dat"]);
    expect(h.writes).toHaveLength(1);
  });

  it("forgets a failed attempt, so the loader tries again and only then hands out bb.js", async () => {
    let up = false;
    const h = harness((urlPath) => (up ? committed(urlPath) : null));
    await expect(h.install()).rejects.toThrow("did not load (HTTP 503)");
    await expect(h.loaders[0]()).rejects.toThrow("did not load (HTTP 503)");
    up = true;
    await expect(h.loaders[0]()).resolves.toBe(h.backend);
    expect(h.writes).toHaveLength(1);
  });

  it("matches the installed bb.js version and the cache layout its browser build reads", () => {
    const pkg = JSON.parse(readFileSync(path.join(bbDir, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(BB_VERSION);
    const browserBuild = readFileSync(path.join(bbDir, "dest/browser/index.js"), "utf8");
    expect(browserBuild).toContain(`createStore("${BB_CACHE.database}", "${BB_CACHE.store}")`);
    expect(browserBuild).toContain(`await get("${BB_CACHE.g1Key}")`);
    expect(browserBuild).toContain(`await get("${BB_CACHE.g2Key}")`);
  });
});

// Not covered here: a real Postgres server or Neon (PGlite from the server
// package's test helper runs the same SQL in process, and both pools point at
// it), live RPC and Channels (the server's fake chain and a stubbed fetch),
// Vercel Cron's own scheduling, `next build` bundling of these routes, and
// the production build dropping the in-memory database (a grep of the build
// output proves that). The handlers' own rules are proved in
// packages/server/test; this file proves the mounting: config, wiring, paths
// and replies.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, RpcClient, RpcTransactionReader } from "@kalypso/server";
import { devMemoryDbRequested } from "./config";
import { clearTables, freshDb, resetArchive } from "../../../server/test/db";
import { CRON_SECRET, DB_API, DB_INGEST, TOKEN, keypairFor, testEnv } from "../../../server/test/helpers";
import { FakeChain, deployTxEvent, mergeEvent, transferEvent, txHashOf } from "../../../server/test/archive/fake-chain";
import { LIVE_CREATION, fakeTransactions } from "../../../server/test/sponsor/fake-rpc";

const fakes = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  rpc: undefined as (RpcClient & Partial<RpcTransactionReader>) | undefined,
  pools: [] as Array<{ url: string; readOnly: boolean }>,
}));

// Only the two outward connections are swapped: the database pool for the
// PGlite one and the RPC client for the fake chain. Config, logging and the
// handlers are the server package's own.
vi.mock("@kalypso/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@kalypso/server")>();
  return {
    ...real,
    connectPostgres: (url: string, opts: { readOnly?: boolean } = {}) => {
      fakes.pools.push({ url, readOnly: opts.readOnly === true });
      return fakes.db!;
    },
    createRpcClient: () => fakes.rpc!,
  };
});

const SERVER_VARIABLES = [
  "NETWORK",
  "RPC_URL",
  "PAYROLL_CONTRACT_ID",
  "TOKEN_CONTRACT_ID",
  "USDC_SAC_ID",
  "AUDITOR_CONTRACT_ID",
  "VERIFIER_CONTRACT_ID",
  "PASSKEY_WALLET_WASM_HASH",
  "CHANNELS_URL",
  "CHANNELS_API_KEY",
  "DATABASE_URL_INGEST",
  "DATABASE_URL_API",
  "FEE_CAP_STROOPS",
  "DAILY_FEE_BUDGET_STROOPS",
  "PER_IP_LIMIT_PER_HOUR",
  "PER_ADDRESS_LIMIT_PER_DAY",
  "TRUSTED_IP_HEADER",
  "CRON_SECRET",
  "LOG_SALT",
  "ARCHIVE_START_LEDGER",
  "TOKEN_DEPLOY_TX",
];

const REQUIRED = [
  "NETWORK",
  "PAYROLL_CONTRACT_ID",
  "TOKEN_CONTRACT_ID",
  "AUDITOR_CONTRACT_ID",
  "VERIFIER_CONTRACT_ID",
  "CHANNELS_API_KEY",
  "DATABASE_URL_INGEST",
  "DATABASE_URL_API",
  "CRON_SECRET",
  "LOG_SALT",
];

const ORIGIN = "https://kalypso.test";
const IP = { "x-real-ip": "203.0.113.7" };
const HASH = "ab".repeat(32);
const alice = keypairFor("alice").publicKey();
const bob = keypairFor("bob").publicKey();
// The wallet the live creation in packages/server/test/sponsor/live-wallet-creation.json made.
const WALLET = "CBSDDY2NMUMLVTXGTKJ2R7JBJDRWG2NJN6J7ZHLZHT6NJID6ZEYFGKSK";

let logLines: string[] = [];

function setEnv(values: Record<string, string | undefined>) {
  for (const name of SERVER_VARIABLES) vi.stubEnv(name, values[name] ?? "");
}

const configuredEnv = () => testEnv({ ARCHIVE_START_LEDGER: "100", TOKEN_DEPLOY_TX: txHashOf(100) });

/** A fresh import of every route module: what a cold start sees. */
async function coldStart() {
  vi.resetModules();
  return {
    sponsor: await import("../../app/api/sponsor/route"),
    status: await import("../../app/api/sponsor/status/route"),
    birth: await import("../../app/api/sponsor/birth/route"),
    birthLookup: await import("../../app/api/sponsor/birth/lookup/route"),
    archive: await import("../../app/api/archive/[...path]/route"),
    ingest: await import("../../app/api/archive/ingest/route"),
  };
}

async function read(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

beforeEach(() => {
  logLines = [];
  fakes.pools = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("with no server variables", () => {
  beforeEach(() => setEnv({}));

  it("every route answers 503 not_configured, uncached, opens nothing, and logs one line of names", async () => {
    const routes = await coldStart();
    const calls: Array<[string, () => Promise<Response>]> = [
      ["sponsor", () => routes.sponsor.POST(new Request(ORIGIN + "/api/sponsor", { method: "POST", headers: IP, body: "{}" }))],
      ["sponsorStatus", () => routes.status.GET(new Request(ORIGIN + "/api/sponsor/status?id=tx_1", { headers: IP }))],
      ["sponsorBirth", () => routes.birth.POST(new Request(ORIGIN + "/api/sponsor/birth", { method: "POST", headers: IP, body: "{}" }))],
      ["sponsorBirthLookup", () => routes.birthLookup.POST(new Request(ORIGIN + "/api/sponsor/birth/lookup", { method: "POST", headers: IP, body: "{}" }))],
      ["archive", () => routes.archive.GET(new Request(ORIGIN + "/api/archive/v1/health"))],
      ["archive", () => routes.archive.OPTIONS(new Request(ORIGIN + "/api/archive/v1/health", { method: "OPTIONS" }))],
      ["ingest", () => routes.ingest.POST(new Request(ORIGIN + "/api/archive/ingest", { method: "POST" }))],
      ["ingest", () => routes.ingest.GET(new Request(ORIGIN + "/api/archive/ingest"))],
    ];
    for (const [route, call] of calls) {
      logLines = [];
      const res = await call();
      expect(res.headers.get("cache-control"), route).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin"), route).toBe(route === "archive" ? "*" : null);
      expect(await read(res), route).toEqual({ status: 503, body: { error: "not_configured" } });
      expect(logLines, route).toHaveLength(1);
      const line = JSON.parse(logLines[0]!);
      expect(Object.keys(line).sort()).toEqual(["event", "invalid", "level", "missing", "route", "t"]);
      expect(line).toMatchObject({ level: "warn", event: "server_not_configured", route, invalid: [] });
      expect([...line.missing].sort()).toEqual([...REQUIRED].sort());
    }
    expect(fakes.pools).toEqual([]);
  });

  it("names a half-set environment's failed variables and never prints a value", async () => {
    const values = {
      CHANNELS_API_KEY: "0f6c1d3e-7a2b-4c5d-9e8f-abcdefabcdef",
      DATABASE_URL_INGEST: "postgres://owner:Owner-Pass-Zq81@db.example/kalypso",
      DATABASE_URL_API: "not a url with Reader-Pass-Jt55",
      CRON_SECRET: "too-short-Kx2",
      LOG_SALT: "log-salt-9Tq3Lm7Xc2Vb8Nz1Kp4Rw6Yh0Gd5Fs3a",
      FEE_CAP_STROOPS: "-77",
    };
    setEnv(values);
    const routes = await coldStart();
    expect(await read(await routes.archive.GET(new Request(ORIGIN + "/api/archive/v1/health")))).toEqual({
      status: 503,
      body: { error: "not_configured" },
    });
    expect(logLines).toHaveLength(1);
    const line = JSON.parse(logLines[0]!);
    expect([...line.invalid].sort()).toEqual(["CRON_SECRET", "DATABASE_URL_API", "FEE_CAP_STROOPS"]);
    expect([...line.missing].sort()).toEqual(["AUDITOR_CONTRACT_ID", "NETWORK", "PAYROLL_CONTRACT_ID", "TOKEN_CONTRACT_ID", "VERIFIER_CONTRACT_ID"]);
    for (const value of [...Object.values(values), "Owner-Pass-Zq81", "Reader-Pass-Jt55", "Kx2", "-77"]) {
      expect(logLines[0]).not.toContain(value);
    }
  });
});

describe("with a test configuration", () => {
  let db: Db;
  let chain: FakeChain;
  let routes: Awaited<ReturnType<typeof coldStart>>;

  beforeAll(async () => {
    db = (await freshDb()).db;
  });

  beforeEach(async () => {
    await resetArchive(db);
    chain = new FakeChain(100, 500).add(deployTxEvent(TOKEN, 100), transferEvent(TOKEN, 120, alice, bob), mergeEvent(TOKEN, 140, bob));
    fakes.db = db;
    fakes.rpc = chain;
    setEnv(configuredEnv());
    routes = await coldStart();
  });

  it("serves /api/archive/v1/health after catching up, on a read-write ingest pool and a read-only API pool", async () => {
    const res = await routes.archive.GET(new Request(ORIGIN + "/api/archive/v1/health"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await read(res)).toMatchObject({
      status: 200,
      body: { latest_ledger: 500, ingested_through: 500, ingested_from: 1, complete: true, alarm: false },
    });
    expect(fakes.pools).toEqual([
      { url: DB_INGEST, readOnly: false },
      { url: DB_API, readOnly: true },
    ]);
  });

  it("serves the /v1 account history route core's history client reads, and nothing outside the archive's paths", async () => {
    const events = await read(await routes.archive.GET(new Request(ORIGIN + "/api/archive/v1/tokens/" + TOKEN + "/accounts/" + bob + "/events")));
    expect(events.status).toBe(200);
    expect(events.body!.events.map((e: { ledger_seq: number }) => e.ledger_seq)).toEqual([120, 140]);
    expect(events.body).toMatchObject({ cursor: null, complete: true, ingested_through: 500 });
    expect(await read(await routes.archive.GET(new Request(ORIGIN + "/api/archive/v2/health")))).toEqual({ status: 404, body: { error: "not_found" } });
    const preflight = await routes.archive.OPTIONS(new Request(ORIGIN + "/api/archive/v1/health", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("refuses an ingest without the cron secret with 401, by POST and by Vercel Cron's GET, and runs nothing", async () => {
    const attempts = [
      routes.ingest.POST(new Request(ORIGIN + "/api/archive/ingest", { method: "POST" })),
      routes.ingest.POST(new Request(ORIGIN + "/api/archive/ingest", { method: "POST", headers: { authorization: "Bearer " + CRON_SECRET + "x" } })),
      routes.ingest.GET(new Request(ORIGIN + "/api/archive/ingest")),
      routes.ingest.GET(new Request(ORIGIN + "/api/archive/ingest", { headers: { authorization: "Bearer wrong" } })),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await read(res)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    expect(chain.calls).toBe(0);
    expect(logLines.join("\n")).not.toContain(CRON_SECRET);
  });

  it("runs one ingest pass when Vercel Cron calls GET with the cron secret", async () => {
    const res = await routes.ingest.GET(new Request(ORIGIN + "/api/archive/ingest", { headers: { authorization: "Bearer " + CRON_SECRET } }));
    expect(await read(res)).toMatchObject({ status: 200, body: { ingested_through: 500, events_stored: 3, caught_up: true, gaps: 0 } });
    expect(chain.calls).toBeGreaterThan(0);
  });

  it("refuses a malformed sponsor body with the server's own codes, before any outbound call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const post = (body: string) =>
      routes.sponsor.POST(new Request(ORIGIN + "/api/sponsor", { method: "POST", headers: { ...IP, "content-type": "application/json" }, body }));
    const broken = await post("{not json");
    expect(broken.headers.get("cache-control")).toBe("no-store");
    expect(await read(broken)).toEqual({ status: 400, body: { error: "invalid_json" } });
    expect(await read(await post(JSON.stringify({ hello: "world" })))).toEqual({ status: 400, body: { error: "bad_shape" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves GET /api/sponsor/status?id= from the handler, asking only the configured Channels origin", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ success: true, data: { transactionId: "tx_42", hash: HASH, status: "confirmed" } }));
    });
    const status = (query: string) => routes.status.GET(new Request(ORIGIN + "/api/sponsor/status" + query, { headers: IP }));
    const res = await status("?id=tx_42");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await read(res)).toEqual({ status: 200, body: { status: "confirmed", hash: HASH } });
    expect(seen).toEqual([{ url: "https://channels.openzeppelin.com/testnet", body: { params: { getTransaction: { transactionId: "tx_42" } } } }]);
    for (const query of ["", "?id=tx%201", "?id=tx_1&id=tx_2"]) {
      expect(await read(await status(query)), query).toEqual({ status: 400, body: { error: "bad_id" } });
    }
    expect(seen).toHaveLength(1);
  });

  it("serves POST /api/sponsor/birth from the handler: the live creation is read from RPC by its hash and stored", async () => {
    await clearTables(db, ["wallet_births"]);
    const transactions = fakeTransactions({ [LIVE_CREATION.hash]: { status: "SUCCESS", envelopeXdr: LIVE_CREATION.envelopeXdr, ledger: LIVE_CREATION.ledger } });
    fakes.rpc = Object.assign(chain, transactions);
    const record = (body: unknown) =>
      routes.birth.POST(new Request(ORIGIN + "/api/sponsor/birth", { method: "POST", headers: { ...IP, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const res = await record({ address: WALLET, hash: LIVE_CREATION.hash });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await read(res)).toEqual({ status: 200, body: { recorded: true } });
    expect(transactions.getTransaction).toHaveBeenCalledWith(LIVE_CREATION.hash);
    expect(await read(await record({ address: WALLET, hash: "ab".repeat(32) }))).toEqual({ status: 404, body: { error: "birth_unavailable" } });
    expect(await read(await record({ address: alice, hash: LIVE_CREATION.hash }))).toEqual({ status: 400, body: { error: "bad_address" } });
  });

  it("serves POST /api/sponsor/birth/lookup from the handler, with the wallet in the body", async () => {
    await clearTables(db, ["wallet_births"]);
    await db.query("insert into wallet_births (address, tx_hash, ledger) values ($1, $2, $3)", [WALLET, LIVE_CREATION.hash, LIVE_CREATION.ledger]);
    const lookup = (body: unknown) =>
      routes.birthLookup.POST(new Request(ORIGIN + "/api/sponsor/birth/lookup", { method: "POST", headers: { ...IP, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const res = await lookup({ address: WALLET });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await read(res)).toEqual({ status: 200, body: { hash: LIVE_CREATION.hash, relayed: [], more: false } });
    expect(await read(await lookup({ address: "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL" }))).toEqual({ status: 200, body: { hash: null, relayed: [], more: false } });
    expect(await read(await lookup({ wallet: WALLET }))).toEqual({ status: 400, body: { error: "bad_request" } });
  });

  it("reads the environment once per cold start", async () => {
    setEnv({});
    const blank = await coldStart();
    const health = () => new Request(ORIGIN + "/api/archive/v1/health");
    expect((await blank.archive.GET(health())).status).toBe(503);
    setEnv(configuredEnv());
    expect((await blank.archive.GET(health())).status).toBe(503);
    expect((await (await coldStart()).archive.GET(health())).status).toBe(200);
  });
});

describe("the in-memory database switch", () => {
  const MEMORY_LINE = "archive and sponsor are using an in-memory database (development only)";
  const URL_SET = "postgres://owner@db.example/kalypso";

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("kalypso.devMemoryDb")];
  });

  it("is on only in development, with KALYPSO_DEV_MEMORY_DB=1 and neither database URL set", () => {
    let on = 0;
    for (const NODE_ENV of ["development", "production", "test", undefined]) {
      for (const KALYPSO_DEV_MEMORY_DB of ["1", "0", "", "true", " 1", undefined]) {
        for (const DATABASE_URL_INGEST of [undefined, "", URL_SET]) {
          for (const DATABASE_URL_API of [undefined, "", URL_SET]) {
            const env = { NODE_ENV, KALYPSO_DEV_MEMORY_DB, DATABASE_URL_INGEST, DATABASE_URL_API };
            const expected = NODE_ENV === "development" && KALYPSO_DEV_MEMORY_DB === "1" && !DATABASE_URL_INGEST && !DATABASE_URL_API;
            expect(devMemoryDbRequested(env), JSON.stringify(env)).toBe(expected);
            if (expected) on++;
          }
        }
      }
    }
    // Unset and empty count alike, so 2 x 2 spellings of "no URL" are the only ones on.
    expect(on).toBe(4);
  });

  it("when on, serves every route from one in-memory database that outlives a reload, and says so once", async () => {
    const chain = new FakeChain(100, 500).add(deployTxEvent(TOKEN, 100), transferEvent(TOKEN, 120, alice, bob), mergeEvent(TOKEN, 140, bob));
    fakes.rpc = chain;
    setEnv({ ...configuredEnv(), DATABASE_URL_INGEST: undefined, DATABASE_URL_API: undefined });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("KALYPSO_DEV_MEMORY_DB", "1");

    const first = await coldStart();
    const ingest = await first.ingest.POST(new Request(ORIGIN + "/api/archive/ingest", { method: "POST", headers: { authorization: "Bearer " + CRON_SECRET } }));
    expect(await read(ingest)).toMatchObject({ status: 200, body: { ingested_through: 500, events_stored: 3 } });
    const malformed = await first.sponsor.POST(
      new Request(ORIGIN + "/api/sponsor", { method: "POST", headers: { ...IP, "content-type": "application/json" }, body: "{" }),
    );
    expect(await read(malformed)).toEqual({ status: 400, body: { error: "invalid_json" } });

    // A dev reload re-runs every module; the archive read above must still be there.
    const reloaded = await coldStart();
    const events = await read(await reloaded.archive.GET(new Request(ORIGIN + "/api/archive/v1/tokens/" + TOKEN + "/accounts/" + bob + "/events")));
    expect(events.body!.events.map((e: { ledger_seq: number }) => e.ledger_seq)).toEqual([120, 140]);

    expect(fakes.pools).toEqual([]);
    expect(logLines.filter((line) => line === MEMORY_LINE)).toHaveLength(1);
  });

  it("is off in a production build even with the flag set, and then the database URLs are simply missing", async () => {
    setEnv({ ...configuredEnv(), DATABASE_URL_INGEST: undefined, DATABASE_URL_API: undefined });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KALYPSO_DEV_MEMORY_DB", "1");
    const routes = await coldStart();
    expect(await read(await routes.archive.GET(new Request(ORIGIN + "/api/archive/v1/health")))).toEqual({
      status: 503,
      body: { error: "not_configured" },
    });
    const line = JSON.parse(logLines.at(-1)!);
    expect([...line.missing].sort()).toEqual(["DATABASE_URL_API", "DATABASE_URL_INGEST"]);
    expect(logLines).not.toContain(MEMORY_LINE);
    expect(fakes.pools).toEqual([]);
  });
});

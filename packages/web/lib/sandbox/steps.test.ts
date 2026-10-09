// Covers the resume rules against a fake chain: a step whose result is already on chain sends
// nothing, a transaction recorded before a reload is found by its hash instead of sent again, an
// expired one is rebuilt, a step whose transaction failed on chain is built again, a landed step
// that the chain does not show is refused, and friendbot is asked once per missing account, all at
// once. Does NOT cover the live network, real proofs, the DEX, or executeRun (core's own tests and
// the live headless run in scratchpad/sandbox cover those).
import { ContractCallError } from "@kalypso/core";
import type { ChainPort, EventsPort } from "@kalypso/core";
import { describe, expect, it } from "vitest";
import { Address, xdr as baseXdr } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { pointToBytes } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
import { ROLES, addressOf, auditorPublicKey, type FriendbotPort, type LedgerPort } from "./accounts";
import { sandboxConfig } from "./config";
import type { HorizonPort } from "./dex";
import { periodId } from "./engine";
import { SandboxError } from "./errors";
import { depositFor, totalOf } from "./salaries";
import { Keypair } from "./sdk";
import { accountantStep, fundStep, runStep, type SandboxProgress, type StepContext } from "./steps";
import type { SandboxState } from "./storage";
import { invoke, journalOf } from "./transactions";

const config = sandboxConfig();

function sample(): SandboxState {
  const amounts: [bigint, bigint, bigint] = [42_000_000_000n, 36_500_000_000n, 51_000_000_000n];
  return {
    stack: { ...config.contracts },
    step: "fund",
    fromLedger: 5_100_000,
    runId: 202610n,
    amounts,
    deposit: depositFor(totalOf(amounts)),
    secrets: { employer: Keypair.random().secret(), accountant: Keypair.random().secret(), workers: [Keypair.random().secret(), Keypair.random().secret(), Keypair.random().secret()] },
    auditorSecrets: { accountant: 4_242n, workers: [11n, 22n, 33n] },
    auditorIds: { accountant: null, workers: [null, null, null] },
    companyId: null,
    txs: Object.create(null) as SandboxState["txs"],
    openings: Object.create(null) as SandboxState["openings"],
    payTxHashes: [],
  };
}

/** A registry and a transaction log, nothing more. Every write the code attempts is counted. */
function fakeChain() {
  const registry = new Map<number, { owner: string; key: Uint8Array }>();
  const results = new Map<string, Awaited<ReturnType<ChainPort["waitFor"]>>>();
  const calls = { sourceAccount: 0, simulate: 0, submit: 0 };
  const port: ChainPort = {
    async read(_contract, method, args) {
      const id = (args[0] as baseXdr.ScVal).u32();
      const entry = registry.get(id);
      if (method === "owner_of") {
        if (!entry) throw new ContractCallError(method, 100);
        return new Address(entry.owner).toScVal();
      }
      if (method === "get_key") {
        if (!entry) throw new ContractCallError(method, 3301);
        return baseXdr.ScVal.scvBytes(Buffer.from(entry.key));
      }
      throw new ContractCallError(method, undefined);
    },
    async simulate() {
      calls.simulate++;
      return { ok: false, error: "HostError: Error(Contract, #7)", latestLedger: 1 };
    },
    async submit() {
      calls.submit++;
      return { hash: "0".repeat(64) };
    },
    async waitFor(hash) {
      return results.get(hash) ?? { status: "NOT_FOUND" };
    },
    async sourceAccount() {
      calls.sourceAccount++;
      return { sequence: "100" };
    },
    async latestLedger() {
      return { sequence: 5_100_100, closeTime: 1_900_000_000 };
    },
  };
  return { port, registry, results, calls };
}

function context(state: SandboxState, port: ChainPort, extra: Partial<StepContext["deps"]> = {}) {
  const progress: SandboxProgress[] = [];
  const ctx: StepContext = {
    state,
    save: () => undefined,
    report: (p) => progress.push(p),
    deps: {
      config,
      port,
      events: {} as EventsPort,
      ledger: { xlmBalance: async () => 1n, usdcBalance: async () => null } satisfies LedgerPort,
      friendbot: { fund: async () => ({ ok: true, status: 200 }) } satisfies FriendbotPort,
      horizon: { get: async () => ({}) } satisfies HorizonPort,
      prover: () => Promise.reject(new Error("no proofs in these tests")),
      wait: async () => undefined,
      ...extra,
    },
  };
  return { ctx, progress };
}

describe("runStep", () => {
  it("skips the work when the chain already shows it", async () => {
    const { ctx } = context(sample(), fakeChain().port);
    let ran = 0;
    expect(await runStep(ctx, "x", async () => true, async () => void ran++)).toBe(false);
    expect(ran).toBe(0);
  });

  it("runs, then requires the chain to show the result, looking again while an RPC node catches up", async () => {
    const { ctx } = context(sample(), fakeChain().port);
    let looks = 0;
    expect(await runStep(ctx, "x", async () => ++looks >= 3, async () => undefined)).toBe(true);
    expect(looks).toBe(3);
    await expect(runStep(ctx, "The thing", async () => false, async () => undefined)).rejects.toMatchObject({ code: "NOT_ON_CHAIN" });
  });

  it("checks and builds again after a transaction failed on chain, and only then", async () => {
    const { ctx } = context(sample(), fakeChain().port);
    let runs = 0;
    let landed = false;
    const run = async () => {
      runs++;
      if (runs < 3) throw new SandboxError("TRANSACTION_FAILED", "lost the race for the next id");
      landed = true;
    };
    expect(await runStep(ctx, "x", async () => landed, run)).toBe(true);
    expect(runs).toBe(3);

    runs = 0;
    const alwaysFails = async () => {
      runs++;
      throw new SandboxError("TRANSACTION_FAILED", "lost again");
    };
    await expect(runStep(ctx, "x", async () => false, alwaysFails)).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    expect(runs).toBe(3);

    runs = 0;
    const refused = async () => {
      runs++;
      throw new SandboxError("SIMULATION_FAILED", "refused before signing");
    };
    await expect(runStep(ctx, "x", async () => false, refused)).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
    expect(runs).toBe(1);
  });

  it("stops before any work once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = context(sample(), fakeChain().port);
    ctx.signal = controller.signal;
    let checked = 0;
    await expect(runStep(ctx, "x", async () => Boolean(checked++), async () => undefined)).rejects.toMatchObject({ name: "AbortError" });
    expect(checked).toBe(0);
  });
});

describe("accountant step against a fake registry", () => {
  it("sends nothing when the saved id already holds the accountant's key", async () => {
    const chain = fakeChain();
    const state = sample();
    state.auditorIds.accountant = 7;
    chain.registry.set(7, { owner: addressOf(state, "accountant"), key: pointToBytes(auditorPublicKey(state.auditorSecrets.accountant)) });
    const { ctx, progress } = context(state, chain.port);
    await accountantStep(ctx);
    expect(chain.calls).toEqual({ sourceAccount: 0, simulate: 0, submit: 0 });
    expect(progress.at(-1)).toMatchObject({ step: "accountant", done: 1, total: 1 });
    expect(progress.at(-1)?.txHash).toBeUndefined();
  });

  it("takes the id from the transaction sent before a reload, never sending it again (C43)", async () => {
    const chain = fakeChain();
    const state = sample();
    const hash = "ab".repeat(32);
    state.txs["accountant register_key"] = { hash, landed: false, validUntil: 1_800_000_000 };
    chain.results.set(hash, { status: "SUCCESS", ledger: 5_100_050, returnValue: baseXdr.ScVal.scvU32(12) });
    chain.registry.set(12, { owner: addressOf(state, "accountant"), key: pointToBytes(auditorPublicKey(state.auditorSecrets.accountant)) });
    const { ctx, progress } = context(state, chain.port);
    await accountantStep(ctx);
    expect(state.auditorIds.accountant).toBe(12);
    expect(state.txs["accountant register_key"]).toEqual({ hash, landed: true, ledger: 5_100_050 });
    expect(chain.calls).toEqual({ sourceAccount: 0, simulate: 0, submit: 0 });
    expect(progress.at(-1)).toMatchObject({ done: 1, txHash: hash });
  });

  it("refuses an id the registry gives to someone else", async () => {
    const chain = fakeChain();
    const state = sample();
    state.auditorIds.accountant = 3;
    chain.registry.set(3, { owner: Keypair.random().publicKey(), key: pointToBytes(auditorPublicKey(state.auditorSecrets.accountant)) });
    const { ctx } = context(state, chain.port);
    // Not held, so it registers a key of its own; the fake network refuses the simulation.
    await expect(accountantStep(ctx)).rejects.toMatchObject({ code: "SIMULATION_FAILED", contractCode: 7 });
    expect(state.auditorIds.accountant).toBe(3);
    expect(chain.calls.submit).toBe(0);
  });
});

describe("transaction journal", () => {
  it("rebuilds a transaction that expired before it landed, by chain time", async () => {
    const chain = fakeChain();
    const state = sample();
    const hash = "cd".repeat(32);
    state.txs.example = { hash, landed: false, validUntil: 1_700_000_000 };
    chain.results.set(hash, { status: "NOT_FOUND", closeTime: 1_700_000_031 });
    const tx = { port: chain.port, journal: journalOf(state.txs, () => undefined), networkPassphrase: config.networkPassphrase };
    await expect(invoke(tx, { label: "example", signer: Keypair.random(), build: () => "unused" })).rejects.toBeInstanceOf(SandboxError);
    expect(state.txs.example).toBeUndefined();
    expect(chain.calls.simulate).toBe(1);
  });

  it("keeps waiting on a transaction whose window the chain has not passed", async () => {
    const chain = fakeChain();
    const state = sample();
    const hash = "ef".repeat(32);
    state.txs.example = { hash, landed: false, validUntil: 1_700_000_000 };
    chain.results.set(hash, { status: "NOT_FOUND", closeTime: 1_700_000_010 });
    const tx = { port: chain.port, journal: journalOf(state.txs, () => undefined), networkPassphrase: config.networkPassphrase };
    await expect(invoke(tx, { label: "example", signer: Keypair.random(), build: () => "unused" })).rejects.toMatchObject({ code: "PENDING" });
    expect(state.txs.example).toEqual({ hash, landed: false, validUntil: 1_700_000_000 });
    expect(chain.calls).toEqual({ sourceAccount: 0, simulate: 0, submit: 0 });
  });
});

describe("fund step", () => {
  it("asks friendbot only for accounts that do not exist, all at once", async () => {
    const state = sample();
    const existing = new Set([addressOf(state, "employer"), addressOf(state, "worker2")]);
    const funded = new Set<string>();
    let inFlight = 0;
    let most = 0;
    const ledger: LedgerPort = { xlmBalance: async (g) => (existing.has(g) || funded.has(g) ? 10_000n : null), usdcBalance: async () => null };
    const friendbot: FriendbotPort = {
      fund: async (g) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        funded.add(g);
        inFlight--;
        return { ok: true, status: 200, hash: "9".repeat(64) };
      },
    };
    const { ctx, progress } = context(state, fakeChain().port, { ledger, friendbot });
    await fundStep(ctx);
    expect(funded.size).toBe(3);
    expect([...funded].some((g) => existing.has(g))).toBe(false);
    expect(most).toBe(3);
    expect(progress.at(-1)).toMatchObject({ step: "fund", done: ROLES.length, total: ROLES.length });
  });
});

describe("run id", () => {
  it("is the year and month, as the seed builds run ids", () => {
    expect(periodId(new Date(Date.UTC(2026, 9, 8)))).toBe(202610n);
    expect(periodId(new Date(Date.UTC(2027, 0, 31, 23, 59)))).toBe(202701n);
  });
});

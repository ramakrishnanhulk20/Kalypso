import {
  createCircuitProver,
  createRpcChainPort,
  createRpcEventsPort,
  createTxSourcePort,
  loadWorkerView,
  randomAuditorSecret,
  readSealedPayroll,
} from "@kalypso/core";
import type { CircuitProverPort, SealedPayroll, WorkerView } from "@kalypso/core";
import { archiveSource } from "../archive";
import { addressOf, createFriendbot, createLedgerPort, forgetKeys, kalypsoKeysOf, keypairOf, newSecrets, workerRole } from "./accounts";
import { sandboxConfig, type SandboxConfig } from "./config";
import { createHorizon } from "./dex";
import { SandboxError, throwIfAborted } from "./errors";
import { depositFor, requireSalaries, totalOf } from "./salaries";
import { loadCircuits } from "./sdk";
import {
  accountantStep,
  companyStep,
  depositStep,
  fundStep,
  openRunStep,
  payStep,
  treasuryStep,
  usdcStep,
  workersStep,
  type SandboxProgress,
  type StepContext,
  type StepDeps,
} from "./steps";
import { SANDBOX_STEPS, clearSandbox, openSession, type KeyValueStorage, type SandboxState, type SandboxStep } from "./storage";

export type { SandboxProgress } from "./steps";
export type { SandboxStep } from "./storage";
export { SandboxError } from "./errors";
export type { SandboxErrorCode } from "./errors";

export interface SandboxResult {
  companyId: bigint;
  treasury: string;
  accountant: { address: string; auditorId: number };
  workers: { address: string; amount: bigint }[];
  runId: bigint;
  payTxHashes: string[];
}

const LOCK_NAME = "kalypso/sandbox/v1";

const ORDER: { step: SandboxStep; run: (ctx: StepContext) => Promise<void> }[] = [
  { step: "fund", run: fundStep },
  { step: "usdc", run: usdcStep },
  { step: "accountant", run: accountantStep },
  { step: "treasury", run: treasuryStep },
  { step: "company", run: companyStep },
  { step: "workers", run: workersStep },
  { step: "deposit", run: depositStep },
  { step: "run", run: openRunStep },
  { step: "pay", run: payStep },
];

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The run id for a month, built as the seed builds them: 202610 for October 2026, by UTC. */
export function periodId(at: Date): bigint {
  return BigInt(`${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}`);
}

function resultOf(state: SandboxState): SandboxResult {
  if (state.companyId === null || state.auditorIds.accountant === null) throw new SandboxError("NO_SANDBOX", "The sandbox is not finished yet.");
  return {
    companyId: state.companyId,
    treasury: addressOf(state, "employer"),
    accountant: { address: addressOf(state, "accountant"), auditorId: state.auditorIds.accountant },
    workers: state.amounts.map((amount, i) => ({ address: addressOf(state, workerRole(i)), amount })),
    runId: state.runId,
    payTxHashes: [...state.payTxHashes],
  };
}

function finishedState(): SandboxState {
  const storage = browserStorage();
  const state = storage === null ? null : openSession(storage, sandboxConfig().contracts).load();
  if (state === null || state.step !== "done") throw new SandboxError("NO_SANDBOX", "There is no finished sandbox in this browser. Run the sandbox first.");
  return state;
}

/** The finished sandbox saved in this browser, or null when there is none, it is not finished, or the save is unreadable. */
export function loadSandbox(): SandboxResult | null {
  const storage = browserStorage();
  if (storage === null) return null;
  const state = openSession(storage, sandboxConfig().contracts).load();
  return state !== null && state.step === "done" ? resultOf(state) : null;
}

function readPorts(config: SandboxConfig) {
  return {
    port: createRpcChainPort({ rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase }),
    events: createRpcEventsPort({ rpcUrl: config.rpcUrl }),
    txSource: createTxSourcePort({ rpcUrl: config.rpcUrl, horizonUrl: config.horizonUrl }),
  };
}

let running = false;

/** One run per browser: the tab-wide flag, and the Web Locks API across tabs where the browser has it. */
async function exclusively<T>(work: () => Promise<T>): Promise<T> {
  if (running) throw new SandboxError("BUSY", "The sandbox is already running in this tab.");
  const busyElsewhere = () => new SandboxError("BUSY", "The sandbox is already running in another tab of this browser.");
  running = true;
  try {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks === undefined) return await work();
    return await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (lock === null) throw busyElsewhere();
      return work();
    });
  } finally {
    running = false;
  }
}

function newState(config: SandboxConfig, amounts: [bigint, bigint, bigint], fromLedger: number): SandboxState {
  return {
    stack: { ...config.contracts },
    step: "keys",
    fromLedger,
    runId: periodId(new Date()),
    amounts,
    deposit: depositFor(totalOf(amounts)),
    secrets: newSecrets(),
    auditorSecrets: { accountant: randomAuditorSecret(), workers: [randomAuditorSecret(), randomAuditorSecret(), randomAuditorSecret()] },
    auditorIds: { accountant: null, workers: [null, null, null] },
    companyId: null,
    txs: Object.create(null) as SandboxState["txs"],
    openings: Object.create(null) as SandboxState["openings"],
    payTxHashes: [],
  };
}

/**
 * Makes a demo company on Stellar testnet in this browser and pays it through Kalypso: five
 * throwaway accounts (employer and treasury, accountant, three workers) funded by friendbot, test
 * USDC bought on the DEX for the salaries plus 2 percent, the accountant's audit key, checked token
 * registrations, the company and its roster, the deposit, this month's run, and three confidential
 * payments proved in the browser. Everything is saved in localStorage as it happens.
 *
 * Calling it again resumes: each step reads the chain first and skips what is already there, and a
 * transaction sent before a reload is found by its saved hash, never sent twice. A sandbox already
 * under way keeps the salaries it was started with, and `amounts` is then ignored, so a reload
 * carries on with the payroll whose USDC was already bought. A finished sandbox returns at once.
 *
 * @param input.amounts the three salaries in stroops, each above zero.
 * @param input.onProgress called as each step moves on. A callback that throws is ignored.
 * @param input.signal stops the run at the next step boundary. A transaction already sent is
 *   waited on first; the next call picks up from the chain.
 * @throws SandboxError INVALID_AMOUNTS before anything happens, BUSY when a run is going in this
 *   browser, or the code of the step that failed; AbortError when stopped; SandboxResetError when
 *   reset() ran meanwhile.
 */
export async function runSandbox(input: {
  amounts: [bigint, bigint, bigint];
  onProgress: (p: SandboxProgress) => void;
  signal?: AbortSignal;
}): Promise<SandboxResult> {
  const amounts = requireSalaries(input?.amounts);
  throwIfAborted(input.signal);
  const report = (p: SandboxProgress) => {
    try {
      input.onProgress(p);
    } catch {
      /* a display callback must not stop a run that has transactions in flight */
    }
  };
  const config = sandboxConfig();
  const storage = browserStorage();
  if (storage === null) throw new SandboxError("NO_SANDBOX", "This browser does not let the demo save its progress, so the sandbox cannot run.");

  return exclusively(async () => {
    const session = openSession(storage, config.contracts);
    const { port, events } = readPorts(config);
    let state = session.load();
    if (state !== null && state.step === "done") {
      report({ step: "done", label: "This browser's sandbox is already paid", done: 1, total: 1 });
      return resultOf(state);
    }
    if (state === null) {
      report({ step: "keys", label: "Making five throwaway testnet accounts in your browser", done: 0, total: 1 });
      state = newState(config, amounts, (await port.latestLedger()).sequence);
      session.save(state);
    } else {
      report({ step: "keys", label: "Picking up the sandbox saved in this browser", done: 0, total: 1 });
    }
    const current = state;
    for (const role of ["employer", "worker1", "worker2", "worker3"] as const) kalypsoKeysOf(keypairOf(current, role), config);
    report({ step: "keys", label: "Private payroll keys made for the company and three workers", done: 1, total: 1 });

    let prover: Promise<CircuitProverPort> | undefined;
    const deps: StepDeps = {
      config,
      port,
      events,
      ledger: createLedgerPort(config),
      friendbot: createFriendbot(config),
      horizon: createHorizon(config),
      prover: () => (prover ??= loadCircuits().then(createCircuitProver)),
    };
    const ctx: StepContext = { state: current, save: () => session.save(current), deps, report, ...(input.signal ? { signal: input.signal } : {}) };
    try {
      for (const { step, run } of ORDER) {
        throwIfAborted(input.signal);
        if (SANDBOX_STEPS.indexOf(current.step) < SANDBOX_STEPS.indexOf(step)) {
          current.step = step;
          ctx.save();
        }
        await run(ctx);
      }
      current.step = "done";
      ctx.save();
      report({ step: "done", label: "Payroll paid. Every step is on chain.", done: 1, total: 1 });
      return resultOf(current);
    } finally {
      if (prover) await prover.then((p) => p.destroy()).catch(() => undefined);
    }
  });
}

/** Worker `index`'s own view, opened with that worker's own keys: their payslips and verified balance. */
export async function openAsWorker(index: 0 | 1 | 2): Promise<WorkerView> {
  const state = finishedState();
  const config = sandboxConfig();
  const { port, events, txSource } = readPorts(config);
  const worker = keypairOf(state, workerRole(index));
  return loadWorkerView({
    port,
    history: { rpc: events, ...archiveSource(), fromLedger: state.fromLedger },
    contracts: { payroll: config.contracts.payroll, token: config.contracts.token },
    worker: worker.publicKey(),
    keys: kalypsoKeysOf(worker, config),
    companyIds: [state.companyId as bigint],
    txSource,
  });
}

function sealedPayroll(state: SandboxState, auditorSecret: bigint): Promise<SealedPayroll> {
  const config = sandboxConfig();
  const { port, events, txSource } = readPorts(config);
  return readSealedPayroll({
    port,
    history: { rpc: events, ...archiveSource(), fromLedger: state.fromLedger },
    txSource,
    contracts: { payroll: config.contracts.payroll, token: config.contracts.token },
    companyId: state.companyId as bigint,
    treasury: addressOf(state, "employer"),
    auditorSecret,
  });
}

/** The company's payroll opened with the accountant's own audit secret: every payment, with its amount. */
export async function openAsAccountant(): Promise<SealedPayroll> {
  const state = finishedState();
  return sealedPayroll(state, state.auditorSecrets.accountant);
}

/** The same payroll opened with a fresh secret nobody holds: every payment stays sealed. */
export async function openAsStranger(): Promise<SealedPayroll> {
  return sealedPayroll(finishedState(), randomAuditorSecret());
}

/** Forgets this browser's sandbox. A run still going stops at its next save instead of bringing it back. */
export function reset(): void {
  const storage = browserStorage();
  if (storage !== null) clearSandbox(storage);
  forgetKeys();
}

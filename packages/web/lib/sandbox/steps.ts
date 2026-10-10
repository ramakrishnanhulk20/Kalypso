// One function per sandbox step, ported from the seed (packages/contracts/scripts/seed.mjs) for
// the browser. Every step reads the chain first and skips what is already there, the seed's
// "already done", so a reload or a crash resumes without sending anything twice.
import {
  AuditorBindingError,
  HistoryIncompleteError,
  PayrollErrorCode,
  buildAcceptInvite,
  buildCheckedRegister,
  buildCreateCompany,
  buildDeposit,
  buildInviteWorker,
  buildMerge,
  buildOpenRun,
  buildRegisterKey,
  confidentialBalance,
  executeRun,
  fetchCompanyHistory,
  formatUsdc,
  getCompany,
  getRun,
  isPaid,
  isPayrollError,
  loadTreasuryOpening,
  parsePayrollCsv,
  readRegisteredAuditorId,
  requireAuditorBinding,
  toSavedOpening,
  treasuryOpeningKey,
  workerStatus,
} from "@kalypso/core";
import type { ChainPort, EventsPort, KalypsoKeys, ProverPort } from "@kalypso/core";
import {
  ROLES,
  addressOf,
  auditorPublicKey,
  fundAll,
  kalypsoKeysOf,
  keypairOf,
  signerOf,
  sleep,
  workerRole,
  type FriendbotPort,
  type LedgerPort,
  type Role,
} from "./accounts";
import type { SandboxConfig } from "./config";
import { archiveSource } from "../archive";
import { requireAffordable, topUpUsdc, type DexContext, type HorizonPort } from "./dex";
import { SandboxError, throwIfAborted } from "./errors";
import { requireCovered, totalOf } from "./salaries";
import { Asset, Operation, commit } from "./sdk";
import { openingStoreOf, type SandboxState, type SandboxStep } from "./storage";
import { classic, invoke, journalOf, landed, readU64, type Landed, type TxContext } from "./transactions";

export interface SandboxProgress {
  step: SandboxStep;
  /** A plain sentence for the screen. Never an amount. */
  label: string;
  done: number;
  total: number;
  txHash?: string;
}

export interface StepDeps {
  config: SandboxConfig;
  port: ChainPort;
  events: EventsPort;
  ledger: LedgerPort;
  friendbot: FriendbotPort;
  horizon: HorizonPort;
  /** The browser prover, made on first use and shared by every proof of one run. */
  prover: () => Promise<ProverPort>;
  wait?: (ms: number) => Promise<void>;
}

export interface StepContext {
  state: SandboxState;
  save: () => void;
  deps: StepDeps;
  report: (p: SandboxProgress) => void;
  signal?: AbortSignal;
}

export const RUN_LABEL = "This month";
export const WORKER_COUNT = 3;
const DEPOSIT = "treasury deposit";
const MERGE = "treasury merge";
// RPC nodes behind one URL can trail each other by a ledger, so a step that just landed is read
// back a few times before it counts as missing.
const POST_CHECK_LOOKS = 4;
const POST_CHECK_WAIT_MS = 2_500;
const MAX_ATTEMPTS = 3;
// A little over one ledger, so a rebuilt transaction simulates against the state that beat it.
const LEDGER_WAIT_MS = 6_000;

const WORKERS = [0, 1, 2] as const;

function txOf(ctx: StepContext): TxContext {
  return { port: ctx.deps.port, journal: journalOf(ctx.state.txs, ctx.save), networkPassphrase: ctx.deps.config.networkPassphrase };
}

function dexOf(ctx: StepContext): DexContext {
  return { tx: txOf(ctx), ledger: ctx.deps.ledger, horizon: ctx.deps.horizon, issuer: ctx.deps.config.usdc.issuer };
}

function progress(ctx: StepContext, step: SandboxStep, total: number) {
  let done = 0;
  const send = (label: string, txHash: string | undefined) =>
    ctx.report(txHash === undefined ? { step, label, done, total } : { step, label, done, total, txHash });
  return {
    say: (label: string, txHash?: string) => send(label, txHash),
    tick: (label: string, txHash?: string) => {
      done = Math.min(total, done + 1);
      send(label, txHash);
    },
    finish: (label: string, txHash?: string) => {
      done = total;
      send(label, txHash);
    },
  };
}

/**
 * The seed's step(): skips when check() already holds, otherwise runs, then requires the chain to
 * show it. Returns whether it ran.
 *
 * A transaction that failed on chain changed nothing, so the step is checked and built again, up
 * to MAX_ATTEMPTS in all. That is what a registration does when someone else's took the
 * registry's next id in the same ledger: its footprint names a slot that is no longer next.
 *
 * @throws SandboxError NOT_ON_CHAIN when the run finished but the chain still does not show it,
 *   or the last TRANSACTION_FAILED.
 */
export async function runStep(ctx: StepContext, what: string, check: () => Promise<boolean>, run: () => Promise<void>): Promise<boolean> {
  const wait = ctx.deps.wait ?? sleep;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(ctx.signal);
    if (await check()) return attempt > 1;
    try {
      await run();
      break;
    } catch (err) {
      if (!(err instanceof SandboxError && err.code === "TRANSACTION_FAILED") || attempt === MAX_ATTEMPTS) throw err;
      await wait(LEDGER_WAIT_MS);
    }
  }
  for (let look = 1; ; look++) {
    if (await check()) return true;
    if (look === POST_CHECK_LOOKS) throw new SandboxError("NOT_ON_CHAIN", `${what} landed, but the chain does not show it yet. Run the sandbox again in a minute.`);
    await wait(POST_CHECK_WAIT_MS);
  }
}

const roleName = (role: Role) => (role === "employer" ? "employer" : role === "accountant" ? "accountant" : `worker ${role.slice(-1)}`);

// Only the two job titles take "the": a worker is named by number, and "the worker 1's" reads wrong.
const possessive = (role: Role) => (role === "employer" || role === "accountant" ? `the ${roleName(role)}'s` : `${roleName(role)}'s`);
const startOfSentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function returned(tx: Landed, what: string) {
  if (tx.returnValue === undefined) throw new SandboxError("CHAIN_DISAGREES", `The ${what} transaction landed, but the network no longer shows what it returned. Reset the sandbox to start a new one.`);
  return tx.returnValue;
}

function requireId(id: number | null, whose: string): number {
  if (id === null) throw new SandboxError("CHAIN_DISAGREES", `The ${whose} has no audit key id yet.`);
  return id;
}

function requireCompany(state: SandboxState): bigint {
  if (state.companyId === null) throw new SandboxError("CHAIN_DISAGREES", "The sandbox company does not exist yet.");
  return state.companyId;
}

export function companyLabel(state: SandboxState): string {
  return `Sandbox ${addressOf(state, "employer").slice(0, 4)}`;
}

/** True when the registry says `owner` owns `id` and holds the key for `secret` under it. An outage throws, never reads as false. */
async function auditorKeyHeld(ctx: StepContext, id: number | null, owner: string, secret: bigint): Promise<boolean> {
  if (id === null) return false;
  try {
    await requireAuditorBinding(ctx.deps.port, ctx.deps.config.contracts.auditor, id, { owner, key: auditorPublicKey(secret) });
    return true;
  } catch (err) {
    if (err instanceof AuditorBindingError) return false;
    throw err;
  }
}

/**
 * True when `account` is registered with the token under the expected id, with its own keys, and
 * the registry still binds that id to the expected owner and key. A token registration is
 * permanent, so an account registered any other way stops the sandbox instead of being reused.
 */
async function registeredUnder(ctx: StepContext, account: string, keys: KalypsoKeys, expected: { id: number; owner: string; secret: bigint }): Promise<boolean> {
  const { port, config } = ctx.deps;
  const onChain = await confidentialBalance(port, config.contracts.token, account);
  if (onChain === null) return false;
  if (onChain.auditorId !== expected.id || !onChain.pvk.equals(keys.PVK)) {
    throw new SandboxError("CHAIN_DISAGREES", "A sandbox account is registered with the token in a way this sandbox did not make, so it stopped. Reset it to start a new one.");
  }
  await requireAuditorBinding(port, config.contracts.auditor, onChain.auditorId, { owner: expected.owner, key: auditorPublicKey(expected.secret) });
  return true;
}

const workerAddresses = (state: SandboxState) => WORKERS.map((i) => addressOf(state, workerRole(i)));

async function runPaid(ctx: StepContext): Promise<boolean> {
  const { state } = ctx;
  if (state.companyId === null) return false;
  const companyId = state.companyId;
  const paid = await Promise.all(workerAddresses(state).map((g) => isPaid(ctx.deps.port, ctx.deps.config.contracts.payroll, companyId, state.runId, g)));
  return paid.every(Boolean);
}

/** Friendbot test XLM for all five accounts, at once. */
export async function fundStep(ctx: StepContext): Promise<void> {
  const p = progress(ctx, "fund", ROLES.length);
  p.say(`Asking friendbot for test XLM for ${ROLES.length} accounts`);
  throwIfAborted(ctx.signal);
  const journal = journalOf(ctx.state.txs, ctx.save);
  const roleOf = new Map(ROLES.map((role) => [addressOf(ctx.state, role), role]));
  const { ledger, friendbot, wait } = ctx.deps;
  await fundAll([...roleOf.keys()], wait ? { ledger, friendbot, wait } : { ledger, friendbot }, (account, result) => {
    const role = roleOf.get(account) as Role;
    if (result.hash !== undefined) journal.landed(`${role} account created by friendbot`, result.hash, undefined);
    p.tick(result.created ? `Friendbot funded ${possessive(role)} account` : `${startOfSentence(possessive(role))} account already has test XLM`, result.hash);
  });
}

/** The treasury's USDC trustline, then test USDC bought on the DEX for the salaries plus 2 percent. */
export async function usdcStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const tx = txOf(ctx);
  const employer = keypairOf(state, "employer");
  const treasury = employer.publicKey();
  const p = progress(ctx, "usdc", 2);

  p.say("Opening a USDC trustline for the treasury");
  let trust: Landed | undefined;
  await runStep(
    ctx,
    "The treasury's USDC trustline",
    async () => (await deps.ledger.usdcBalance(treasury)) !== null,
    async () => {
      trust = await classic(tx, { label: "treasury USDC trustline", signer: employer, operations: [Operation.changeTrust({ asset: new Asset("USDC", deps.config.usdc.issuer) })] });
    },
  );
  p.tick("The treasury can hold USDC", trust?.hash);

  // Once the deposit landed, or the run is paid, the treasury needs no more USDC on its public balance.
  const need = async () => (landed(tx, DEPOSIT) || (await runPaid(ctx)) ? 0n : state.deposit);
  const funders = ROLES.map((role) => ({ label: `${role} buys USDC for the treasury`, keypair: keypairOf(state, role) }));
  p.say("Buying test USDC on the Stellar DEX");
  await runStep(
    ctx,
    "The treasury's USDC purchase",
    async () => {
      const n = await need();
      if (n === 0n) return true;
      const have = await deps.ledger.usdcBalance(treasury);
      return have !== null && have >= n;
    },
    async () => {
      const dex = dexOf(ctx);
      const target = await need();
      const have = (await deps.ledger.usdcBalance(treasury)) ?? 0n;
      await requireAffordable(dex, target - have, funders);
      await topUpUsdc(dex, {
        destination: treasury,
        target,
        funders,
        onBought: (bought) => p.say("Bought test USDC on the Stellar DEX", bought.hash),
      });
    },
  );
  p.tick("The treasury holds the test USDC for this payroll");
}

/** The accountant registers its audit key; its id is the one the confirmed transaction returned (C43). */
export async function accountantStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const accountant = keypairOf(state, "accountant");
  const p = progress(ctx, "accountant", 1);
  p.say("Registering the accountant's audit key");
  let sent: Landed | undefined;
  await runStep(
    ctx,
    "The accountant's audit key",
    () => auditorKeyHeld(ctx, state.auditorIds.accountant, accountant.publicKey(), state.auditorSecrets.accountant),
    async () => {
      sent = await invoke(txOf(ctx), {
        label: "accountant register_key",
        signer: accountant,
        build: (base) => buildRegisterKey({ ...base, contractId: deps.config.contracts.auditor }, { owner: accountant.publicKey(), point: auditorPublicKey(state.auditorSecrets.accountant) }),
      });
      // Never predicted from key_count: anyone can register first (C43).
      state.auditorIds.accountant = readRegisteredAuditorId(returned(sent, "accountant register_key"));
      ctx.save();
    },
  );
  p.tick(`The accountant holds audit key ${state.auditorIds.accountant}`, sent?.hash);
}

/** The treasury registers with the token under the accountant's id, through core's checked builder. */
export async function treasuryStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const { port, config } = deps;
  const employer = keypairOf(state, "employer");
  const keys = kalypsoKeysOf(employer, config);
  const accountant = addressOf(state, "accountant");
  const expected = { id: requireId(state.auditorIds.accountant, "accountant"), owner: accountant, secret: state.auditorSecrets.accountant };
  const p = progress(ctx, "treasury", 1);
  p.say("Registering the treasury with the confidential token");
  let sent: Landed | undefined;
  await runStep(
    ctx,
    "The treasury's token registration",
    () => registeredUnder(ctx, employer.publicKey(), keys, expected),
    async () => {
      sent = await invoke(txOf(ctx), {
        label: "treasury token register",
        signer: employer,
        build: async (base) => {
          p.say("Proving the treasury's registration in your browser");
          const envelope = await (await deps.prover()).proveRegister(keys);
          p.say("Registering the treasury with the confidential token");
          return buildCheckedRegister(port, { ...base, contractId: config.contracts.token }, {
            account: employer.publicKey(),
            auditorId: expected.id,
            data: envelope,
            registry: config.contracts.auditor,
            auditorOwner: expected.owner,
            auditorKey: auditorPublicKey(expected.secret),
          });
        },
      });
    },
  );
  p.tick("The treasury is registered under the accountant's audit key", sent?.hash);
}

async function companyMatches(ctx: StepContext, expected: { admin: string; accountant: string; auditorId: number; label: string }): Promise<boolean> {
  const { state, deps } = ctx;
  if (state.companyId === null) return false;
  try {
    const c = await getCompany(deps.port, deps.config.contracts.payroll, state.companyId);
    return c.admin === expected.admin && c.accountant === expected.accountant && c.auditorId === expected.auditorId && c.label === expected.label;
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) return false;
    throw err;
  }
}

/** create_company names the employer as admin and treasury, and the accountant with its id. */
export async function companyStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const employer = keypairOf(state, "employer");
  const expected = {
    admin: employer.publicKey(),
    accountant: addressOf(state, "accountant"),
    auditorId: requireId(state.auditorIds.accountant, "accountant"),
    label: companyLabel(state),
  };
  const p = progress(ctx, "company", 1);
  p.say(`Creating ${expected.label} on the payroll contract`);
  let sent: Landed | undefined;
  await runStep(
    ctx,
    "The company",
    () => companyMatches(ctx, expected),
    async () => {
      sent = await invoke(txOf(ctx), {
        label: "create_company",
        signer: employer,
        build: (base) => buildCreateCompany({ ...base, contractId: deps.config.contracts.payroll }, expected),
      });
      state.companyId = readU64(returned(sent, "create_company"), "create_company");
      ctx.save();
    },
  );
  p.tick(`${expected.label} exists on the payroll contract`, sent?.hash);
}

/**
 * Each worker registers their own audit key and then registers with the token under it, as the
 * seed's workers do (C33); the employer invites each one; each accepts. Invites need no token
 * registration, so the employer's invites run beside the workers' own work. Each lane signs with
 * a different account, so nothing competes for a sequence number.
 *
 * Three things still go one at a time. Proofs share the one prover. register_key takes the
 * registry's next id and accept_invite the roster's next slot, so each one's simulated footprint
 * names that slot, and two sent into the same ledger collide: the later one fails on chain
 * (measured live: two of three parallel register_key calls failed). Token registrations write only
 * the account's own entry, so those overlap.
 */
export async function workersStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const { port, config } = deps;
  const tx = txOf(ctx);
  const companyId = requireCompany(state);
  const employer = keypairOf(state, "employer");
  const p = progress(ctx, "workers", WORKER_COUNT * 4);
  p.say("Setting up three workers");

  const oneAtATime = () => {
    let last: Promise<unknown> = Promise.resolve();
    return <T>(work: () => Promise<T>): Promise<T> => {
      const turn = last.then(work, work);
      last = turn.catch(() => undefined);
      return turn;
    };
  };
  const provingTurn = oneAtATime();
  const registryTurn = oneAtATime();
  const rosterTurn = oneAtATime();
  const status = (worker: string) => workerStatus(port, config.contracts.payroll, companyId, worker);

  const registerKey = async (i: 0 | 1 | 2) => {
    const worker = keypairOf(state, workerRole(i));
    let sent: Landed | undefined;
    await runStep(
      ctx,
      `Worker ${i + 1}'s audit key`,
      () => auditorKeyHeld(ctx, state.auditorIds.workers[i], worker.publicKey(), state.auditorSecrets.workers[i]),
      async () => {
        p.say(`Registering worker ${i + 1}'s own audit key`);
        sent = await invoke(tx, {
          label: `worker${i + 1} register_key`,
          signer: worker,
          build: (base) => buildRegisterKey({ ...base, contractId: config.contracts.auditor }, { owner: worker.publicKey(), point: auditorPublicKey(state.auditorSecrets.workers[i]) }),
        });
        state.auditorIds.workers[i] = readRegisteredAuditorId(returned(sent, `worker${i + 1} register_key`));
        ctx.save();
      },
    );
    p.tick(`Worker ${i + 1} holds their own audit key`, sent?.hash);
  };

  const registerWithToken = async (i: 0 | 1 | 2) => {
    const worker = keypairOf(state, workerRole(i));
    const keys = kalypsoKeysOf(worker, config);
    const expected = { id: requireId(state.auditorIds.workers[i], `worker ${i + 1}`), owner: worker.publicKey(), secret: state.auditorSecrets.workers[i] };
    let sent: Landed | undefined;
    await runStep(
      ctx,
      `Worker ${i + 1}'s token registration`,
      () => registeredUnder(ctx, worker.publicKey(), keys, expected),
      async () => {
        sent = await invoke(tx, {
          label: `worker${i + 1} token register`,
          signer: worker,
          build: async (base) => {
            const envelope = await provingTurn(async () => {
              p.say(`Proving worker ${i + 1}'s registration in your browser`);
              return (await deps.prover()).proveRegister(keys);
            });
            p.say(`Registering worker ${i + 1} with the confidential token`);
            return buildCheckedRegister(port, { ...base, contractId: config.contracts.token }, {
              account: worker.publicKey(),
              auditorId: expected.id,
              data: envelope,
              registry: config.contracts.auditor,
              auditorOwner: expected.owner,
              auditorKey: auditorPublicKey(expected.secret),
            });
          },
        });
      },
    );
    p.tick(`Worker ${i + 1} is registered with the confidential token`, sent?.hash);
  };

  const invite = async (i: 0 | 1 | 2) => {
    const worker = addressOf(state, workerRole(i));
    let sent: Landed | undefined;
    await runStep(
      ctx,
      `Worker ${i + 1}'s invite`,
      async () => {
        const s = await status(worker);
        return s === "Invited" || s === "Active";
      },
      async () => {
        p.say(`Inviting worker ${i + 1} to the company`);
        sent = await invoke(tx, {
          label: `invite_worker worker${i + 1}`,
          signer: employer,
          build: (base) => buildInviteWorker({ ...base, contractId: config.contracts.payroll }, { companyId, worker }),
        });
      },
    );
    p.tick(`Worker ${i + 1} is invited`, sent?.hash);
  };

  const accept = async (i: 0 | 1 | 2) => {
    const worker = keypairOf(state, workerRole(i));
    let sent: Landed | undefined;
    await runStep(
      ctx,
      `Worker ${i + 1}'s acceptance`,
      async () => (await status(worker.publicKey())) === "Active",
      async () => {
        p.say(`Worker ${i + 1} accepts the invite`);
        sent = await invoke(tx, {
          label: `accept_invite worker${i + 1}`,
          signer: worker,
          build: (base) => buildAcceptInvite({ ...base, contractId: config.contracts.payroll }, { companyId, worker: worker.publicKey() }),
        });
      },
    );
    p.tick(`Worker ${i + 1} joined the company`, sent?.hash);
  };

  // The employer signs every invite, so they go one after another on its sequence number.
  let invites: Promise<void> = Promise.resolve();
  const invited = WORKERS.map((i) => (invites = invites.then(() => invite(i))));
  const lanes = WORKERS.map(async (i) => {
    await registryTurn(() => registerKey(i));
    await registerWithToken(i);
    await invited[i];
    await rosterTurn(() => accept(i));
  });
  const settled = await Promise.allSettled([...invited, ...lanes]);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
}

/** Deposit the bought USDC into the treasury's confidential balance, merge it, and keep the opening it leaves. */
export async function depositStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const { port, config } = deps;
  const tx = txOf(ctx);
  const employer = keypairOf(state, "employer");
  const treasury = employer.publicKey();
  const token = config.contracts.token;
  const p = progress(ctx, "deposit", 3);

  p.say("Depositing test USDC into the confidential treasury");
  let sent: Landed | undefined;
  await runStep(
    ctx,
    "The treasury deposit",
    async () => landed(tx, DEPOSIT) || (await runPaid(ctx)),
    async () => {
      requireCovered(totalOf(state.amounts), state.deposit);
      const have = await deps.ledger.usdcBalance(treasury);
      if (have === null || have < state.deposit) throw new SandboxError("CHAIN_DISAGREES", "The treasury does not hold the test USDC it should deposit, so nothing was deposited.");
      sent = await invoke(tx, {
        label: DEPOSIT,
        signer: employer,
        build: (base) => buildDeposit({ ...base, contractId: token }, { from: treasury, to: treasury, amount: state.deposit }),
      });
    },
  );
  p.tick("The deposit is in the confidential treasury", sent?.hash);

  p.say("Merging the deposit into the treasury balance");
  let merged: Landed | undefined;
  await runStep(
    ctx,
    "The treasury merge",
    async () => landed(tx, MERGE) || (await runPaid(ctx)),
    async () => {
      // Only this deposit may be waiting: anything else would make the opening kept next wrong.
      const account = await confidentialBalance(port, token, treasury);
      if (account === null || !account.receiving.equals(commit(state.deposit, 0n))) {
        throw new SandboxError("CHAIN_DISAGREES", "The treasury's incoming balance is not exactly the sandbox deposit, so it was not merged.");
      }
      merged = await invoke(tx, { label: MERGE, signer: employer, build: (base) => buildMerge({ ...base, contractId: token }, { account: treasury }) });
    },
  );
  p.tick("The deposit is merged into the treasury balance", merged?.hash);

  const store = openingStoreOf(state, ctx.save);
  await runStep(
    ctx,
    "The treasury balance opening",
    async () => {
      try {
        await loadTreasuryOpening({ port, store, token, treasury });
        return true;
      } catch (err) {
        if (err instanceof HistoryIncompleteError && (err.reason === "NO_SAVED_OPENING" || err.reason === "DOES_NOT_OPEN")) return false;
        throw err;
      }
    },
    async () => {
      // A deposit adds amount·G with zero blinding, so one deposit and one merge leave (deposit, 0) (C16).
      const account = await confidentialBalance(port, token, treasury);
      if (account === null || !commit(state.deposit, 0n).equals(account.spendable)) {
        throw new SandboxError("CHAIN_DISAGREES", "The treasury balance on chain is not the sandbox deposit, so it cannot be paid from.");
      }
      await store.put(treasuryOpeningKey(token, treasury), toSavedOpening(state.deposit, 0n));
    },
  );
  p.tick("This browser can open the treasury balance");
}

/** open_run for this month, expecting three payments. */
export async function openRunStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const companyId = requireCompany(state);
  const employer = keypairOf(state, "employer");
  const p = progress(ctx, "run", 1);
  p.say("Opening this month's payroll run");
  let sent: Landed | undefined;
  await runStep(
    ctx,
    "The payroll run",
    async () => {
      try {
        const run = await getRun(deps.port, deps.config.contracts.payroll, companyId, state.runId);
        if (run.periodLabel !== RUN_LABEL || run.expectedCount !== WORKER_COUNT) {
          throw new SandboxError("CHAIN_DISAGREES", "This month's run on chain is not the one this sandbox opens, so it stopped.");
        }
        return true;
      } catch (err) {
        if (isPayrollError(err, PayrollErrorCode.RunNotFound)) return false;
        throw err;
      }
    },
    async () => {
      sent = await invoke(txOf(ctx), {
        label: "open_run",
        signer: employer,
        build: (base) =>
          buildOpenRun({ ...base, contractId: deps.config.contracts.payroll }, { companyId, runId: state.runId, periodLabel: RUN_LABEL, expectedCount: WORKER_COUNT }),
      });
    },
  );
  p.tick("This month's run is open", sent?.hash);
}

/** The run's pay transactions, read back from the payroll contract's payslip events, as the seed records them. */
async function payTransactions(ctx: StepContext): Promise<string[] | null> {
  const { state, deps } = ctx;
  const companyId = requireCompany(state);
  const history = await fetchCompanyHistory({ port: deps.events, ...archiveSource(), contracts: deps.config.contracts, companyId, fromLedger: state.fromLedger });
  if (!history.complete) return null;
  const slips = history.events.filter((e) => e.kind === "payroll" && e.event.type === "payslip_issued" && e.event.runId === state.runId);
  if (slips.length !== WORKER_COUNT) return null;
  return [...new Set(slips.map((e) => e.txHash))];
}

/**
 * Pays the three workers through core's executeRun, with the browser prover and the treasury
 * openings kept in this browser. executeRun settles any pay left in flight first and skips rows
 * already paid on chain, so a reload in the middle never pays anyone twice (C13, C29).
 */
export async function payStep(ctx: StepContext): Promise<void> {
  const { state, deps } = ctx;
  const { config } = deps;
  const companyId = requireCompany(state);
  const employer = keypairOf(state, "employer");
  const workers = workerAddresses(state);
  const p = progress(ctx, "pay", WORKER_COUNT);
  p.say("Getting ready to pay three workers");
  await runStep(
    ctx,
    "This month's payments",
    async () => state.payTxHashes.length > 0 && (await runPaid(ctx)),
    async () => {
      if (!(await runPaid(ctx))) {
        // Through core's CSV parser, so the amounts proved are the ones its one parser reads (C26).
        const csv = ["address,amount", ...workers.map((g, i) => `${g},${formatUsdc(state.amounts[i] as bigint)}`)].join("\n") + "\n";
        const { rows, errors } = parsePayrollCsv(csv);
        if (errors.length > 0 || rows.length !== WORKER_COUNT) throw new SandboxError("INVALID_AMOUNTS", "The payroll rows were refused by the CSV parser, so nothing was paid.");
        const position = new Map(rows.map((row) => [row.line, workers.indexOf(row.address) + 1]));
        const report = await executeRun({
          port: deps.port,
          signer: signerOf(employer),
          store: openingStoreOf(state, ctx.save),
          networkPassphrase: config.networkPassphrase,
          contracts: config.contracts,
          companyId,
          runId: state.runId,
          rows,
          keys: kalypsoKeysOf(employer, config),
          prover: await deps.prover(),
          onProgress: ({ row, status }) => {
            const n = position.get(row) ?? 0;
            if (status === "proving") p.say(`Proving payment ${n} of ${WORKER_COUNT} in your browser`);
            else if (status === "submitted") p.say(`Sending payment ${n} of ${WORKER_COUNT} to the network`);
            else if (status === "paid") p.tick(`Payment ${n} of ${WORKER_COUNT} landed`);
            else if (status === "already-paid") p.tick(`Payment ${n} of ${WORKER_COUNT} was already made`);
            else p.say(`Payment ${n} of ${WORKER_COUNT} did not go through`);
          },
        });
        if (report.rows.some((row) => row.status === "failed")) {
          throw new SandboxError("PAY_FAILED", "Some payments did not go through. Run the sandbox again to finish them; nobody is paid twice.");
        }
        for (const hash of report.transactions) p.say("A pay transaction landed", hash);
      }
      const wait = deps.wait ?? sleep;
      for (let look = 1; ; look++) {
        const hashes = await payTransactions(ctx);
        if (hashes !== null) {
          state.payTxHashes = hashes;
          ctx.save();
          return;
        }
        if (look === POST_CHECK_LOOKS) throw new SandboxError("NOT_ON_CHAIN", "Every worker is paid, but the payslips do not show in the history yet. Run the sandbox again in a minute.");
        await wait(POST_CHECK_WAIT_MS);
      }
    },
  );
  p.finish("Three workers are paid");
}

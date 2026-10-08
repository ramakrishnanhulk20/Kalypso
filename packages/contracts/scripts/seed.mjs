// Seeds Kalypso's showcase on the live testnet stack: "Andes Studio (demo)" with its accountant,
// six contractors, and two monthly payroll runs paid through @kalypso/core's run engine, plus
// one direct payment an outsider plants on a contractor so the prove command can show it never
// counts as pay. Every account is a throwaway testnet account made here.
//
// Run it again and it confirms every step on chain and repeats nothing. What may be public goes
// to deployments/showcase-testnet.json; secrets, amounts and balance openings go only to the
// git-ignored .stellar/showcase-secrets.json.
//
//   npm run seed:testnet
import { randomInt } from "node:crypto";
import path from "node:path";
import { KEY_DOMAIN, core, createNodeProver, cts, events, explorer, kalypsoKeys, pointHex, port, rpcServer, sdk, stack } from "./lib/kalypso.mjs";
import { invoke, txStatus } from "./lib/transactions.mjs";
import {
  FRIENDBOT_XLM_STROOPS,
  MAX_POOL_SHARE,
  XLM_KEPT_STROOPS,
  buyUsdc,
  creationTxHash,
  ensureFunded,
  ensureTrustline,
  measurePurchase,
  topUpUsdc,
  usdcBalance,
  usdcPool,
  xlmBalance,
} from "./lib/funding.mjs";
import { PUBLIC_FILE, SECRETS_FILE, loadPublic, loadSecrets, openingStore, privateAmountsOf, requireGitIgnored, savePublic, saveSecrets } from "./lib/showcase-state.mjs";

const COMPANY_LABEL = "Andes Studio (demo)";
const OUTSIDER_LABEL = "Outsider Co (demo)";
const RUNS = [
  { key: "202609", id: 202609n, label: "September 2026" },
  { key: "202610", id: 202610n, label: "October 2026" },
];
const WORKERS = ["worker1", "worker2", "worker3", "worker4", "worker5", "worker6"];
// CSV name column only. Names never reach the chain or either file.
const ROLES = ["Art director", "Illustrator", "Motion designer", "3D artist", "Sound designer", "Front-end developer"];
const PLANTED_ON = "worker1";

// Amounts are drawn here, in cents, the first time the seed runs, and live only in the secrets
// file. Every amount has non-zero cents, so its shortest decimal form always carries a dot and
// cannot be mistaken for a ledger number in a public file.
const SALARY_RANGE = [42_000n, 138_000n];
const TOTAL_RANGE = [950_000n, 990_000n];
const MIN_GAP = 2_000n;
const PLANTED_RANGE = [1_800n, 9_500n];
const CENT = 100_000n;

const AUDITOR_KEY_NOTE =
  "A demo key, published on purpose so anyone can open the accountant view: it reads only this demo company's payments and its treasury balance after each one, so never bind anything real to it.";

const log = (s = "") => console.log(s);
const WIDTH = 54;

let pub;
let secrets;
let prover;

const persistPublic = () => savePublic(pub, privateAmountsOf(secrets));
const journal = {
  get: (label) => pub.transactions[label] ?? pub.pending[label],
  pending(label, p) {
    pub.pending[label] = p;
    persistPublic();
  },
  done(label, e) {
    pub.transactions[label] = { hash: e.hash, ledger: e.ledger, feeStroops: e.feeStroops, explorer: explorer.tx(e.hash) };
    delete pub.pending[label];
    persistPublic();
  },
};

async function step(name, { check, run }) {
  const before = await check();
  if (before.done) {
    log(`  ${name.padEnd(WIDTH)} already done (${before.how})`);
    return;
  }
  await run();
  const after = await check();
  if (!after.done) throw new Error(`${name}: the step ran but the chain does not show it: ${after.how}`);
  log(`  ${name.padEnd(WIDTH)} done (${after.how})`);
}

const keypair = (name) => sdk.Keypair.fromSecret(secrets.keys[name]);
const address = (name) => keypair(name).publicKey();
const auditorSecret = (name) => BigInt(secrets.auditorSecrets[name]);
const getProver = () => (prover ??= createNodeProver());
const scvU32 = (n) => sdk.xdr.ScVal.scvU32(n);

function drawCents([lo, hi]) {
  for (;;) {
    const c = BigInt(randomInt(Number(lo), Number(hi) + 1));
    if (c % 100n !== 0n) return c;
  }
}

/** Six monthly amounts and October's changes: in range, cents everywhere, far apart, about 9,700 in all. */
function drawPayroll() {
  for (let attempt = 0; attempt < 200_000; attempt++) {
    const september = WORKERS.map(() => drawCents(SALARY_RANGE));
    const sorted = [...september].sort((a, b) => (a < b ? -1 : 1));
    if (sorted.some((v, i) => i > 0 && v - sorted[i - 1] < MIN_GAP)) continue;
    const october = [...september];
    const changing = new Set();
    const changes = 2 + randomInt(2);
    while (changing.size < changes) changing.add(randomInt(WORKERS.length));
    for (const i of changing) {
      const delta = BigInt(randomInt(1_500, 9_001)) * (randomInt(4) === 0 ? -1n : 1n);
      october[i] = september[i] + delta;
    }
    const all = [...september, ...october];
    if (all.some((c) => c < SALARY_RANGE[0] || c > SALARY_RANGE[1] || c % 100n === 0n)) continue;
    const owner = new Map();
    let clash = false;
    all.forEach((c, i) => {
      const w = i % WORKERS.length;
      if (owner.has(c) && owner.get(c) !== w) clash = true;
      owner.set(c, w);
    });
    if (clash) continue;
    const total = all.reduce((a, b) => a + b, 0n);
    if (total < TOTAL_RANGE[0] || total > TOTAL_RANGE[1]) continue;
    return { september, october };
  }
  throw new Error("could not draw a payroll that meets the showcase rules");
}

const scaled = (cents, factor) => {
  const c = (cents * factor.num) / factor.den;
  return c % 100n === 0n ? c + 1n : c;
};

/** A top-up a little above what the month needs, with cents, never exactly the payroll total. */
function topUpFor(neededCents) {
  const buffer = (neededCents * BigInt(randomInt(3, 8))) / 100n;
  const c = neededCents + buffer;
  return c % 100n === 0n ? c + 37n : c;
}

async function planScale(neededStroops) {
  const pool = await usdcPool();
  const cap = (pool.usdc * BigInt(Math.round(MAX_POOL_SHARE * 10_000))) / 10_000n;
  if (neededStroops <= cap) {
    await measurePurchase(neededStroops);
    return { num: 1n, den: 1n, text: "no scaling" };
  }
  const den = 10_000n;
  const num = (cap * den) / neededStroops;
  await measurePurchase((neededStroops * num) / den);
  return { num, den, text: `every amount scaled by ${Number(num) / Number(den)} to fit testnet liquidity` };
}

async function makePlan() {
  const keys = {};
  for (const name of ["treasury", "accountant", ...WORKERS, "outsider"]) keys[name] = sdk.Keypair.random().secret();
  const auditorSecrets = {};
  for (const name of ["accountant", ...WORKERS, "outsider"]) auditorSecrets[name] = "0x" + cts.randomScalar().toString(16);

  const draw = drawPayroll();
  const first = topUpFor(draw.september.reduce((a, b) => a + b, 0n));
  const octoberTotal = draw.october.reduce((a, b) => a + b, 0n);
  const second = topUpFor(octoberTotal - (first - draw.september.reduce((a, b) => a + b, 0n)));
  const planted = { transfer: drawCents(PLANTED_RANGE), deposit: drawCents(PLANTED_RANGE) };
  while (planted.deposit === planted.transfer) planted.deposit = drawCents(PLANTED_RANGE);

  const neededStroops = (first + second + planted.transfer + planted.deposit) * CENT;
  const factor = await planScale(neededStroops);
  const toStroops = (cents) => (scaled(cents, factor) * CENT).toString();

  const secretsOut = {
    note: "PRIVATE. Throwaway Stellar testnet keys and the seeded amounts for Kalypso's showcase. Git-ignored; never commit, never reuse.",
    keys,
    auditorSecrets,
    amounts: { runs: {}, deposits: {}, planted: {} },
    scale: factor.text,
    openings: {},
  };
  // Worker addresses are only known once the keys exist, and the amounts are keyed by them.
  const g = (name) => sdk.Keypair.fromSecret(keys[name]).publicKey();
  RUNS.forEach((run, k) => {
    const month = k === 0 ? draw.september : draw.october;
    secretsOut.amounts.runs[run.key] = Object.fromEntries(WORKERS.map((w, i) => [g(w), toStroops(month[i])]));
  });
  secretsOut.amounts.deposits[RUNS[0].key] = toStroops(first);
  secretsOut.amounts.deposits[RUNS[1].key] = toStroops(second);
  secretsOut.amounts.planted.transfer = toStroops(planted.transfer);
  secretsOut.amounts.planted.deposit = toStroops(planted.deposit);

  // Funders: enough friendbot accounts for the treasury's USDC at the measured price, plus one spare.
  const treasuryNeed = BigInt(secretsOut.amounts.deposits[RUNS[0].key]) + BigInt(secretsOut.amounts.deposits[RUNS[1].key]);
  const m = await measurePurchase(treasuryNeed);
  const perFunder = Number(FRIENDBOT_XLM_STROOPS - XLM_KEPT_STROOPS);
  const funders = Math.ceil(Number(m.quote.xlm) / perFunder) + 1;
  for (let i = 1; i <= funders; i++) keys[`funder${i}`] = sdk.Keypair.random().secret();
  return secretsOut;
}

function newPublicRecord(fromLedger) {
  return {
    about:
      "Kalypso's showcase company on Stellar testnet, made by npm run seed:testnet and attacked by npm run prove:testnet. " +
      "Public on purpose: ids, addresses, transaction hashes and one demo auditor key. No amount and no account secret is in this file.",
    network: stack.network,
    networkPassphrase: stack.passphrase,
    rpcUrl: stack.rpcUrl,
    keyDomain: KEY_DOMAIN,
    fromLedger,
    amountScale: secrets.scale,
    contracts: {
      verifier: { id: stack.contracts.verifier, explorer: explorer.contract(stack.contracts.verifier) },
      auditorRegistry: { id: stack.contracts.auditor, explorer: explorer.contract(stack.contracts.auditor) },
      token: { id: stack.contracts.token, explorer: explorer.contract(stack.contracts.token) },
      payroll: { id: stack.contracts.payroll, explorer: explorer.contract(stack.contracts.payroll) },
      usdc: { id: stack.usdc.sac, issuer: stack.usdc.issuer, explorer: explorer.contract(stack.usdc.sac) },
    },
    company: { id: null, label: COMPANY_LABEL, treasury: address("treasury"), explorer: explorer.account(address("treasury")) },
    accountant: {
      account: address("accountant"),
      auditorId: null,
      demoAccountantKeyPublishedOnPurpose: secrets.auditorSecrets.accountant,
      demoAccountantKeyNote: AUDITOR_KEY_NOTE,
    },
    workers: WORKERS.map((w) => ({ account: address(w), auditorId: null, explorer: explorer.account(address(w)) })),
    runs: RUNS.map((r) => ({ id: r.id.toString(), label: r.label, expectedCount: WORKERS.length, payTransactions: [] })),
    outsider: { account: address("outsider"), auditorId: null, companyId: null, companyLabel: OUTSIDER_LABEL, plantedOn: address(PLANTED_ON) },
    funders: [],
    transactions: {},
    pending: {},
  };
}

async function auditorKeyHeld(name, id) {
  if (id === null || id === undefined) return { done: false, how: "no id yet" };
  let owner;
  try {
    owner = sdk.Address.fromScVal(await port.read(stack.contracts.auditor, "owner_of", [scvU32(id)])).toString();
  } catch (e) {
    return { done: false, how: e.message };
  }
  const onChain = pointHex(await core.getAuditorKey(port, stack.contracts.auditor, id));
  const mine = pointHex(cts.scalarMul(auditorSecret(name), cts.H));
  return owner === address(name) && onChain === mine
    ? { done: true, how: `auditor id ${id}, owned by this account, holds this key` }
    : { done: false, how: `auditor id ${id} is not this account's key` };
}

async function registeredUnder(name, auditorId) {
  const account = await core.confidentialBalance(port, stack.contracts.token, address(name));
  if (account === null) return { done: false, how: "not registered" };
  const keysMatch = pointHex(account.pvk) === pointHex(kalypsoKeys(keypair(name)).PVK);
  return account.auditorId === auditorId && keysMatch
    ? { done: true, how: `registered under auditor id ${auditorId} with this account's keys` }
    : { done: false, how: `registered under auditor id ${account.auditorId}${keysMatch ? "" : " with other keys"}` };
}

async function landed(label) {
  const t = pub.transactions[label];
  if (!t?.ledger) return { done: false, how: "no landed transaction recorded" };
  const s = await txStatus(t.hash);
  if (s.status === "SUCCESS") return { done: true, how: `tx ${t.hash.slice(0, 12)}... in ledger ${s.ledger}` };
  if (s.status === "NOT_FOUND" && t.ledger < s.oldestLedger) return { done: true, how: `tx ${t.hash.slice(0, 12)}... landed in ledger ${t.ledger}, now older than RPC's window` };
  return { done: false, how: `tx ${t.hash} is ${s.status}` };
}

async function runPaid(k) {
  if (pub.company.id === null) return false;
  const paid = await Promise.all(WORKERS.map((w) => core.isPaid(port, stack.contracts.payroll, BigInt(pub.company.id), RUNS[k].id, address(w))));
  return paid.every(Boolean);
}

/** Done when the transaction landed, or when run k is paid, which cannot happen without it. */
async function landedOrPaid(label, k) {
  if (await runPaid(k)) return { done: true, how: `${RUNS[k].label} is paid on chain, which needs this` };
  return landed(label);
}

const depositLabel = (k) => `treasury deposit for ${RUNS[k].label}`;
const mergeLabel = (k) => `treasury merge for ${RUNS[k].label}`;
const amount = (key) => BigInt(key.split(".").reduce((o, part) => o[part], secrets.amounts));

/** Records the friendbot transaction that created account `g`, so the public file lists every transaction. */
async function recordCreation(name, g) {
  const label = `${name} account created by friendbot`;
  if (pub.transactions[label]) return;
  const hash = await creationTxHash(g);
  const s = await txStatus(hash);
  if (s.status !== "SUCCESS") throw new Error(`${label}: transaction ${hash} is ${s.status}`);
  journal.done(label, { hash, ledger: s.ledger, feeStroops: Number(s.feeCharged.toString()) });
}

async function setupAccounts() {
  log("Accounts and auditor keys");
  for (const name of ["treasury", "accountant", ...WORKERS, "outsider"]) {
    await step(`${name} account exists`, {
      check: async () => ((await xlmBalance(address(name))) !== null ? { done: true, how: address(name) } : { done: false, how: "no account" }),
      run: () => ensureFunded(address(name)),
    });
  }
  for (const name of ["treasury", "accountant", ...WORKERS, "outsider"]) await recordCreation(name, address(name));
  const idSlot = (name) => (name === "accountant" ? pub.accountant : name === "outsider" ? pub.outsider : pub.workers[WORKERS.indexOf(name)]);
  for (const name of ["accountant", ...WORKERS, "outsider"]) {
    await step(`${name} auditor key registered`, {
      check: () => auditorKeyHeld(name, idSlot(name).auditorId),
      run: async () => {
        const point = Buffer.from(cts.pointToBytes(cts.scalarMul(auditorSecret(name), cts.H)));
        const tx = await invoke({
          label: `${name} register_key`,
          signer: keypair(name),
          journal,
          build: (base) =>
            core.buildInvocation({ ...base, contractId: stack.contracts.auditor }, "register_key", [new sdk.Address(address(name)).toScVal(), sdk.xdr.ScVal.scvBytes(point)]),
        });
        idSlot(name).auditorId = tx.returnValue.u32();
        persistPublic();
      },
    });
  }
}

async function registerWithToken() {
  log("Token registration");
  await step("treasury USDC trustline", {
    check: async () => ((await usdcBalance(address("treasury"))) !== null ? { done: true, how: "trustline exists" } : { done: false, how: "no trustline" }),
    run: () => ensureTrustline({ label: "treasury USDC trustline", keypair: keypair("treasury"), journal }),
  });
  const under = (name) => (name === "treasury" ? pub.accountant.auditorId : name === "outsider" ? pub.outsider.auditorId : pub.workers[WORKERS.indexOf(name)].auditorId);
  for (const name of ["treasury", ...WORKERS, "outsider"]) {
    await step(`${name} registered with the token`, {
      check: () => registeredUnder(name, under(name)),
      run: () =>
        invoke({
          label: `${name} token register`,
          signer: keypair(name),
          journal,
          build: async (base) => {
            const envelope = await getProver().proveRegister(kalypsoKeys(keypair(name)));
            return core.buildRegister({ ...base, contractId: stack.contracts.token }, { account: address(name), auditorId: under(name), data: envelope });
          },
        }),
    });
  }
}

async function companyMatches(id, admin, auditorId, label) {
  if (id === null) return { done: false, how: "no company id yet" };
  const c = await core.getCompany(port, stack.contracts.payroll, BigInt(id));
  return c.admin === admin && c.auditorId === auditorId && c.label === label
    ? { done: true, how: `company ${id}, admin ${admin.slice(0, 6)}..., auditor id ${auditorId}` }
    : { done: false, how: `company ${id} does not match` };
}

async function setupCompanies() {
  log("Companies and roster");
  await step(`company "${COMPANY_LABEL}" created`, {
    check: () => companyMatches(pub.company.id, address("treasury"), pub.accountant.auditorId, COMPANY_LABEL),
    run: async () => {
      const tx = await invoke({
        label: "create_company Andes Studio",
        signer: keypair("treasury"),
        journal,
        build: (base) =>
          core.buildCreateCompany({ ...base, contractId: stack.contracts.payroll }, { admin: address("treasury"), auditorId: pub.accountant.auditorId, label: COMPANY_LABEL }),
      });
      pub.company.id = tx.returnValue.u64().toBigInt().toString();
      persistPublic();
    },
  });
  const companyId = BigInt(pub.company.id);
  const status = (w) => core.workerStatus(port, stack.contracts.payroll, companyId, address(w));
  for (const w of WORKERS) {
    await step(`${w} invited`, {
      check: async () => {
        const s = await status(w);
        return s === "Invited" || s === "Active" ? { done: true, how: `status ${s}` } : { done: false, how: `status ${s}` };
      },
      run: () =>
        invoke({
          label: `invite_worker ${w}`,
          signer: keypair("treasury"),
          journal,
          build: (base) => core.buildInviteWorker({ ...base, contractId: stack.contracts.payroll }, { companyId, worker: address(w) }),
        }),
    });
    await step(`${w} accepted the invite`, {
      check: async () => {
        const s = await status(w);
        return s === "Active" ? { done: true, how: "status Active" } : { done: false, how: `status ${s}` };
      },
      run: () =>
        invoke({
          label: `accept_invite ${w}`,
          signer: keypair(w),
          journal,
          build: (base) => core.buildAcceptInvite({ ...base, contractId: stack.contracts.payroll }, { companyId, worker: address(w) }),
        }),
    });
  }
  await step(`company "${OUTSIDER_LABEL}" created`, {
    check: () => companyMatches(pub.outsider.companyId, address("outsider"), pub.outsider.auditorId, OUTSIDER_LABEL),
    run: async () => {
      const tx = await invoke({
        label: "create_company Outsider Co",
        signer: keypair("outsider"),
        journal,
        build: (base) =>
          core.buildCreateCompany({ ...base, contractId: stack.contracts.payroll }, { admin: address("outsider"), auditorId: pub.outsider.auditorId, label: OUTSIDER_LABEL }),
      });
      pub.outsider.companyId = tx.returnValue.u64().toBigInt().toString();
      persistPublic();
    },
  });
}

async function fundTreasury() {
  log("Treasury USDC");
  const outstanding = async () => {
    let sum = 0n;
    for (let k = 0; k < RUNS.length; k++) if (!(await landedOrPaid(depositLabel(k), k)).done) sum += amount(`deposits.${RUNS[k].key}`);
    return sum;
  };
  await step("treasury holds the USDC the deposits need", {
    check: async () => {
      const need = await outstanding();
      if (need === 0n) return { done: true, how: "every deposit has landed" };
      return (await usdcBalance(address("treasury"))) >= need ? { done: true, how: "the balance covers every deposit still to make" } : { done: false, how: "short" };
    },
    run: async () => {
      const funders = Object.keys(secrets.keys)
        .filter((k) => k.startsWith("funder"))
        .map((k) => ({ label: `${k} buys USDC for the treasury`, keypair: keypair(k) }));
      await topUpUsdc({ destination: address("treasury"), target: await outstanding(), funders, journal, log: (s) => log(`    ${s}`) });
      pub.funders = funders.filter((f) => pub.transactions[f.label]).map((f) => f.keypair.publicKey());
      persistPublic();
    },
  });
  for (const g of pub.funders) {
    const name = Object.keys(secrets.keys).find((k) => k.startsWith("funder") && address(k) === g);
    await recordCreation(name, g);
  }
}

async function payRuns() {
  const companyId = BigInt(pub.company.id);
  const treasury = keypair("treasury");
  const store = openingStore(secrets);
  const treasuryKey = core.treasuryOpeningKey(stack.contracts.token, treasury.publicKey());
  const opensChain = async () => {
    try {
      await core.loadTreasuryOpening({ port, store, token: stack.contracts.token, treasury: treasury.publicKey() });
      return true;
    } catch (e) {
      if (e instanceof core.HistoryIncompleteError) return false;
      throw e;
    }
  };

  for (const [k, run] of RUNS.entries()) {
    log(`Run ${run.id} "${run.label}"`);
    const deposit = amount(`deposits.${run.key}`);
    await step(`treasury deposit for ${run.label}`, {
      check: () => landedOrPaid(depositLabel(k), k),
      run: async () => {
        if ((await usdcBalance(treasury.publicKey())) < deposit) throw new Error("the treasury does not hold this month's deposit");
        await invoke({
          label: depositLabel(k),
          signer: treasury,
          journal,
          build: (base) => core.buildDeposit({ ...base, contractId: stack.contracts.token }, { from: treasury.publicKey(), to: treasury.publicKey(), amount: deposit }),
        });
      },
    });
    await step(`treasury merge for ${run.label}`, {
      check: () => landedOrPaid(mergeLabel(k), k),
      run: async () => {
        // Only this month's deposit may be waiting: anything else would make the balance this
        // seed computes next wrong, so it stops instead of merging it.
        const account = await core.confidentialBalance(port, stack.contracts.token, treasury.publicKey());
        if (pointHex(account.receiving) !== pointHex(cts.commit(deposit, 0n))) throw new Error("the treasury's receiving balance is not exactly this month's deposit");
        await invoke({
          label: mergeLabel(k),
          signer: treasury,
          journal,
          build: (base) => core.buildMerge({ ...base, contractId: stack.contracts.token }, { account: treasury.publicKey() }),
        });
      },
    });
    await step(`treasury balance opening for ${run.label}`, {
      check: async () => ((await opensChain()) ? { done: true, how: "the saved opening opens the on-chain balance" } : { done: false, how: "the saved opening does not open the chain" }),
      run: async () => {
        // A deposit adds amount·G with zero blinding, so the merged balance keeps the old blinding.
        const saved = secrets.openings[treasuryKey];
        const before = saved ? core.readSavedOpening(saved) : k === 0 ? { v: 0n, r: 0n } : undefined;
        if (!before) throw new Error("no saved treasury opening to add this month's deposit to");
        const next = core.toSavedOpening(before.v + deposit, before.r);
        const account = await core.confidentialBalance(port, stack.contracts.token, treasury.publicKey());
        if (next.commitment !== pointHex(account.spendable)) throw new Error("the saved opening plus this month's deposit does not open the treasury balance on chain");
        await store.put(treasuryKey, next);
      },
    });
    await step(`run ${run.id} opened`, {
      check: async () => {
        try {
          const r = await core.getRun(port, stack.contracts.payroll, companyId, run.id);
          return r.periodLabel === run.label && r.expectedCount === WORKERS.length
            ? { done: true, how: `"${r.periodLabel}", ${r.expectedCount} expected, ${r.status}` }
            : { done: false, how: "the run on chain has another label or count" };
        } catch (e) {
          if (core.isPayrollError(e, core.PayrollErrorCode.RunNotFound)) return { done: false, how: "not opened" };
          throw e;
        }
      },
      run: () =>
        invoke({
          label: `open_run ${run.label}`,
          signer: treasury,
          journal,
          build: (base) =>
            core.buildOpenRun({ ...base, contractId: stack.contracts.payroll }, { companyId, runId: run.id, periodLabel: run.label, expectedCount: WORKERS.length }),
        }),
    });
    await step(`${run.label} paid to all ${WORKERS.length} workers`, {
      check: async () => {
        const paid = await runPaid(k);
        const recorded = pub.runs[k].payTransactions.length > 0;
        return paid && recorded
          ? { done: true, how: `is_paid true for all ${WORKERS.length}, ${pub.runs[k].payTransactions.length} pay transactions` }
          : { done: false, how: paid ? "paid, pay transactions not recorded yet" : "not every worker is paid" };
      },
      run: async () => {
        if (!(await runPaid(k))) {
          const csv = ["address,amount,name", ...WORKERS.map((w, i) => `${address(w)},${core.formatUsdc(BigInt(secrets.amounts.runs[run.key][address(w)]))},${ROLES[i]}`)].join("\n");
          const { rows, errors } = core.parsePayrollCsv(csv + "\n");
          if (errors.length > 0 || rows.length !== WORKERS.length) throw new Error(`the run's CSV was refused: ${errors.map((e) => e.code).join(", ")}`);
          const report = await core.executeRun({
            port,
            signer: {
              address: treasury.publicKey(),
              signTransaction: async (txXdr, passphrase) => {
                const tx = sdk.TransactionBuilder.fromXDR(txXdr, passphrase);
                tx.sign(treasury);
                return tx.toXDR();
              },
            },
            store,
            networkPassphrase: stack.passphrase,
            contracts: stack.contracts,
            companyId,
            runId: run.id,
            rows,
            keys: kalypsoKeys(treasury),
            prover: getProver(),
            onProgress: (e) => log(`    CSV line ${e.row}: ${e.status}`),
          });
          if (report.rows.some((r) => r.status === "failed")) throw new Error(`${run.label}: some rows failed`);
        }
        await recordPayTransactions(k, companyId);
      },
    });
  }
}

/** The run's pay transactions, read back from the payroll contract's payslip events. */
async function recordPayTransactions(k, companyId) {
  const history = await core.fetchCompanyHistory({ port: events, contracts: stack.contracts, companyId, fromLedger: pub.fromLedger });
  if (!history.complete) throw new Error("the company's history is incomplete, so its pay transactions cannot be listed");
  const slips = history.events.filter((e) => e.kind === "payroll" && e.event.type === "payslip_issued" && e.event.runId === RUNS[k].id);
  if (slips.length !== WORKERS.length) throw new Error(`${RUNS[k].label} has ${slips.length} payslip events, expected ${WORKERS.length}`);
  const hashes = [...new Set(slips.map((e) => e.txHash))];
  for (const [i, hash] of hashes.entries()) {
    const s = await txStatus(hash);
    journal.done(`pay ${RUNS[k].label} batch ${i + 1}`, { hash, ledger: s.ledger, feeStroops: Number(s.feeCharged.toString()) });
  }
  pub.runs[k].payTransactions = hashes;
  persistPublic();
}

async function plantPayments() {
  log(`Outsider plants a direct payment on ${PLANTED_ON}`);
  const outsider = keypair("outsider");
  const worker = address(PLANTED_ON);
  const transfer = amount("planted.transfer");
  const deposit = amount("planted.deposit");
  const L = {
    selfDeposit: "outsider deposit to itself",
    merge: "outsider merge",
    transfer: `outsider direct confidential transfer to ${PLANTED_ON}`,
    deposit: `outsider public deposit to ${PLANTED_ON}`,
  };
  await step("outsider USDC trustline", {
    check: async () => ((await usdcBalance(outsider.publicKey())) !== null ? { done: true, how: "trustline exists" } : { done: false, how: "no trustline" }),
    run: () => ensureTrustline({ label: "outsider USDC trustline", keypair: outsider, journal }),
  });
  const outstanding = async () => {
    let sum = 0n;
    if (!(await landed(L.transfer)).done && !(await landed(L.selfDeposit)).done) sum += transfer;
    if (!(await landed(L.deposit)).done) sum += deposit;
    return sum;
  };
  await step("outsider holds the USDC it plants", {
    check: async () => {
      const need = await outstanding();
      return (await usdcBalance(outsider.publicKey())) >= need ? { done: true, how: need === 0n ? "both payments have landed" : "the balance covers both" } : { done: false, how: "short" };
    },
    run: async () => {
      const missing = (await outstanding()) - (await usdcBalance(outsider.publicKey()));
      await buyUsdc({ label: "outsider buys USDC", funder: outsider, destination: outsider.publicKey(), usdc: missing, journal });
    },
  });
  await step("outsider deposits to itself", {
    check: async () => ((await landed(L.transfer)).done ? { done: true, how: "the transfer it funds has landed" } : landed(L.selfDeposit)),
    run: () =>
      invoke({
        label: L.selfDeposit,
        signer: outsider,
        journal,
        build: (base) => core.buildDeposit({ ...base, contractId: stack.contracts.token }, { from: outsider.publicKey(), to: outsider.publicKey(), amount: transfer }),
      }),
  });
  await step("outsider merges", {
    check: async () => ((await landed(L.transfer)).done ? { done: true, how: "the transfer it funds has landed" } : landed(L.merge)),
    run: () =>
      invoke({ label: L.merge, signer: outsider, journal, build: (base) => core.buildMerge({ ...base, contractId: stack.contracts.token }, { account: outsider.publicKey() }) }),
  });
  await step(`outsider sends ${PLANTED_ON} a direct confidential transfer`, {
    check: () => landed(L.transfer),
    run: async () => {
      const keys = kalypsoKeys(outsider);
      const mine = await core.confidentialBalance(port, stack.contracts.token, outsider.publicKey());
      // After one deposit and one merge the spendable balance is the deposit with zero blinding.
      if (pointHex(mine.spendable) !== pointHex(cts.commit(transfer, 0n))) throw new Error("the outsider's balance is not the one deposit it made");
      const recipient = await core.confidentialBalance(port, stack.contracts.token, worker);
      const kAudR = await core.getAuditorKey(port, stack.contracts.auditor, recipient.auditorId);
      const kAudS = await core.getAuditorKey(port, stack.contracts.auditor, pub.outsider.auditorId);
      await invoke({
        label: L.transfer,
        signer: outsider,
        journal,
        build: async (base) => {
          const proved = await getProver().proveTransfer({ keys, v: transfer, r: 0n, amount: transfer, pvkB: recipient.pvk, kAudR, kAudS });
          return core.buildConfidentialTransfer({ ...base, contractId: stack.contracts.token }, { from: outsider.publicKey(), to: worker, data: { payload: proved.payload } });
        },
      });
    },
  });
  await step(`outsider deposits publicly to ${PLANTED_ON}`, {
    check: () => landed(L.deposit),
    run: () =>
      invoke({
        label: L.deposit,
        signer: outsider,
        journal,
        build: (base) => core.buildDeposit({ ...base, contractId: stack.contracts.token }, { from: outsider.publicKey(), to: worker, amount: deposit }),
      }),
  });
}

function feeSummary() {
  const kinds = [
    ["register_key", / register_key$/],
    ["token register (with proof)", / token register$/],
    ["create_company", /^create_company/],
    ["invite_worker", /^invite_worker/],
    ["accept_invite", /^accept_invite/],
    ["open_run", /^open_run/],
    ["deposit", /deposit/],
    ["merge", /merge/],
    ["pay batch (2 confidential payments)", /^pay .* batch/],
    ["direct confidential transfer", /direct confidential transfer/],
  ];
  log("Fees paid, in XLM (median per transaction, network fee included)");
  for (const [name, re] of kinds) {
    const fees = Object.entries(pub.transactions).filter(([label]) => re.test(label)).map(([, t]) => t.feeStroops).sort((a, b) => a - b);
    if (fees.length) log(`  ${name.padEnd(WIDTH)} ${(fees[Math.floor(fees.length / 2)] / 1e7).toFixed(4)} XLM over ${fees.length}`);
  }
}

async function main() {
  log(`Kalypso showcase seed on ${stack.network}: payroll ${stack.contracts.payroll}, token ${stack.contracts.token}, registry ${stack.contracts.auditor}`);
  requireGitIgnored(SECRETS_FILE);
  secrets = loadSecrets();
  pub = loadPublic();
  if (pub && !secrets) throw new Error(`${path.basename(PUBLIC_FILE)} exists but the private ${path.basename(SECRETS_FILE)} does not, so the showcase keys are gone. Move the public file away to seed a new showcase`);
  if (!secrets) {
    secrets = await makePlan();
    saveSecrets(secrets);
    log(`  ${"plan".padEnd(WIDTH)} done (new throwaway keys and amounts in .stellar/${path.basename(SECRETS_FILE)}, ${secrets.scale})`);
  } else {
    log(`  ${"plan".padEnd(WIDTH)} already done (keys and amounts read from .stellar/${path.basename(SECRETS_FILE)})`);
  }
  if (!pub) {
    pub = newPublicRecord((await rpcServer.getLatestLedger()).sequence);
  }
  // The note travels with the published key, so it always says what this code says it reads.
  pub.accountant.demoAccountantKeyNote = AUDITOR_KEY_NOTE;
  persistPublic();

  await setupAccounts();
  await registerWithToken();
  await setupCompanies();
  await fundTreasury();
  await payRuns();
  await plantPayments();

  pub.seededAt ??= new Date().toISOString().replace(/\.\d+Z$/, "Z");
  persistPublic();
  log("");
  feeSummary();
  log("");
  log("Showcase ready");
  log(`  company      "${COMPANY_LABEL}", id ${pub.company.id}, treasury ${pub.company.treasury}`);
  log(`  accountant   auditor id ${pub.accountant.auditorId}; its demo key is published in deployments/${path.basename(PUBLIC_FILE)}`);
  log(`  runs         ${pub.runs.map((r) => `${r.id} "${r.label}"`).join(", ")}`);
  log(`  amounts      ${pub.amountScale}`);
  log(`  outsider     "${OUTSIDER_LABEL}", id ${pub.outsider.companyId}`);
}

main()
  .catch((e) => {
    console.error(`seed failed: ${e?.message ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => prover?.destroy());

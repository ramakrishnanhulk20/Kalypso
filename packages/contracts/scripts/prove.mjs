// Attacks Kalypso's own promises against the live showcase company and prints, for each one,
// what was tried and what stopped it. No showcase key signs anything: every attack on the
// showcase is a read or a simulation of the current testnet state, so anyone can run it with no
// keys. The one exception is P11, which stages a front-run with throwaway friendbot accounts it
// makes, holds only in memory and forgets: two transactions on testnet (about 0.12 XLM of
// friendbot money at the measured 0.070 and 0.051 XLM fees), and one more auditor id and one
// more token account left behind each run.
//
// It reads deployments/showcase-testnet.json. When the private .stellar/showcase-secrets.json
// from the seed is present it also checks every amount against what was seeded and opens a
// worker's own payslips; without it, the amounts come from the published demo accountant key.
// Exits non-zero if any check fails.
//
// RPC keeps about 7 days of history. With an archive (--archive or ARCHIVE_URL), the history
// checks read the showcase's events from it through core's history source, and transactions RPC
// no longer has from Horizon, so they keep working as long as the archive covers the ledgers.
//
//   npm run prove:testnet [-- --archive <url>]
import path from "node:path";
import { readFileSync } from "node:fs";
import { core, createNodeProver, cts, events, kalypsoKeys, pointHex, port, rpcServer, sdk, stack, txSource } from "./lib/kalypso.mjs";
import { ENCODING_NAMES, amountNeedles, findAmount, storedHaystack, transactionHaystack } from "./lib/encodings.mjs";
import { archiveBaseUrl, archiveHealth, archiveRows, archiveTokenStream, horizonTransaction } from "./lib/history.mjs";
import { startsAtDeploy, treasurySpendCount } from "./lib/prove-rules.mjs";
import { forgedAuthorization, invoke, memoryJournal, simulate } from "./lib/transactions.mjs";
import { ensureFunded } from "./lib/funding.mjs";
import { PUBLIC_FILE, earlierPayOf, loadPublic, loadSecrets } from "./lib/showcase-state.mjs";
import { readInstance, readMaxEntryTtl, simulateCall, scv } from "./lib/chain.mjs";
import { readVerificationKey, tokenWiring, verificationKeysInInstance, verifierAccessByCalls, verifierAccessFromLedger } from "./lib/contract-state.mjs";
import { UNAUTHORIZED_ERROR, VERIFICATION_KEYS, VERIFIER_WASM, VK_DIR } from "./lib/network.mjs";
import { sha256hex } from "./lib/wasm.mjs";

const PAGE = 200;
const MAX_PAGES = 250;

const results = [];
const out = (s = "") => console.log(s);

function report(id, verdict, sentence, extra = []) {
  results.push(verdict);
  out(`${verdict.padEnd(4)}  ${id.padEnd(3)}  ${sentence}`);
  for (const line of extra) out(`            ${line}`);
}

async function check(id, run) {
  try {
    const r = await run();
    report(id, r.verdict, r.sentence, r.extra);
  } catch (e) {
    report(id, "FAIL", `The check could not finish, so it counts as failed: ${e?.message ?? e}`);
  }
}

const pass = (sentence, extra) => ({ verdict: "PASS", sentence, extra });
const fail = (sentence, extra) => ({ verdict: "FAIL", sentence, extra });
const short = (g) => `${g.slice(0, 6)}...${g.slice(-4)}`;

const USAGE = `Usage: npm run prove:testnet [-- --archive <url>]

  --archive <url>  Read the showcase's history from a Kalypso archive server (https only), so the
                   history checks P1, P2, P3, P9 and P10 still work after RPC's 7-day window.
                   ARCHIVE_URL in the environment does the same; the flag wins. Without either,
                   history comes from RPC alone. The public showcase archive URL will be given
                   in the README after deploy.
  --help           Print this and exit.`;

function parseFlags(argv) {
  const flags = { help: false, archive: process.env.ARCHIVE_URL || null, archiveFrom: "ARCHIVE_URL" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--archive") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--archive needs a value");
      [flags.archive, flags.archiveFrom] = [v, "--archive"];
    } else throw new Error(`unknown argument ${a}`);
  }
  return flags;
}

let flags;
try {
  flags = parseFlags(process.argv.slice(2));
} catch (e) {
  console.error(`prove could not run: ${e.message}\n\n${USAGE}`);
  process.exit(1);
}
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
let archive = null;
try {
  // The shape core's HistorySource takes: { baseUrl }, checked by the same URL rule core applies.
  archive = flags.archive === null ? null : { baseUrl: archiveBaseUrl(flags.archive, flags.archiveFrom) };
} catch (e) {
  console.error(`prove could not run: ${e.message}`);
  process.exit(1);
}

const pub = loadPublic();
if (!pub) {
  console.error(`prove could not run: ${path.basename(PUBLIC_FILE)} not found. Run npm run seed:testnet first`);
  process.exit(1);
}
const secrets = loadSecrets();
const contracts = { payroll: pub.contracts.payroll.id, token: pub.contracts.token.id, auditor: pub.contracts.auditorRegistry.id, verifier: pub.contracts.verifier.id };
const companyId = BigInt(pub.company.id);
const treasury = pub.company.treasury;
const workers = pub.workers.map((w) => w.account);
const runs = pub.runs.map((r) => ({ id: BigInt(r.id), label: r.label, payTransactions: r.payTransactions }));
const latestRun = runs[runs.length - 1];
const withArchive = archive ? { archive } : {};
const salaryCount = runs.length * workers.length;
const txLabel = (prefix) => Object.keys(pub.transactions).find((k) => k.startsWith(prefix));
const plantedTransferTx = pub.transactions[txLabel("outsider direct confidential transfer to ")]?.hash;
const plantedDepositTx = pub.transactions[txLabel("outsider public deposit to ")]?.hash;
const firstDepositTx = pub.transactions[txLabel("treasury deposit for ")]?.hash;

/** What the seed paid, from the private file: run id, worker, amount. */
function seededPayments() {
  if (!secrets) return null;
  return runs.flatMap((r) => workers.map((w) => ({ runId: r.id, worker: w, amount: BigInt(secrets.amounts.runs[r.id.toString()][w]) })));
}

/**
 * A history source for core whose RPC event reads are counted. Core reads RPC events only when no
 * archive is set or the archive could not answer, so a count of zero means every event came from
 * the archive. That is how a check can say which source its history really came from.
 */
function observedHistory() {
  const seen = { rpcPages: 0 };
  const rpc = {
    ledgerWindow: () => events.ledgerWindow(),
    contractEvents: (query) => {
      seen.rpcPages++;
      return events.contractEvents(query);
    },
  };
  const source = () => (seen.rpcPages === 0 ? "the archive" : archive ? "RPC (the archive did not answer for at least one read)" : "RPC");
  return { history: { rpc, fromLedger: pub.fromLedger, ...withArchive }, source };
}

const sourceName = (s) => (s === "archive" ? "the archive" : "RPC");
const sourceLine = (what, source) => (archive ? [`${what} read from ${source}`] : []);

let accountantAuditRun;
/**
 * The published demo accountant's audit, which P1, P2 and P10 share. It runs once, on first use
 * inside a check, so a throw fails only the checks that need it, each with its message.
 */
function accountantAudit() {
  accountantAuditRun ??= (async () => {
    const observed = observedHistory();
    const audit = await core.auditCompany({ port, history: observed.history, txSource, contracts, companyId, auditorSecret: BigInt(pub.accountant.demoAccountantKeyPublishedOnPurpose) });
    return { audit, source: observed.source() };
  })();
  return accountantAuditRun;
}

const auditLines = (audit) => audit.runs.flatMap((r) => r.lines.map((l) => ({ runId: r.runId, ...l })));

/** Every transaction hash a stranger finds for the showcase on chain, plus every one the seed recorded. */
async function showcaseTransactions() {
  const company = await core.fetchCompanyHistory({ port: events, ...withArchive, contracts, companyId, fromLedger: pub.fromLedger });
  const treasuryHistory = await core.fetchAccountHistory({ port: events, ...withArchive, contracts, account: treasury, fromLedger: pub.fromLedger });
  const sources = `company history from ${sourceName(company.source)}, treasury history from ${sourceName(treasuryHistory.source)}`;
  if (!company.complete || !treasuryHistory.complete) {
    const why = archive ? "the archive does not vouch for all of it, and RPC keeps only about 7 days" : "it is older than RPC's 7-day window and no --archive was given";
    throw new Error(`the showcase's history is incomplete (${sources}): ${why}, so a stranger cannot list its transactions`);
  }
  const found = new Set([...company.events, ...treasuryHistory.events].map((e) => e.txHash));
  const missed = runs.flatMap((r) => r.payTransactions).filter((h) => !found.has(h));
  if (missed.length > 0) throw new Error(`the chain does not show recorded pay transactions ${missed.join(", ")}`);
  return { hashes: [...new Set([...found, ...Object.values(pub.transactions).map((t) => t.hash)])], sources };
}

let archivedRowsRun;
/**
 * The archive's raw event rows for the showcase, by transaction hash: the company's payroll events
 * and the token events of every showcase account. Read once, and only when some transaction is no
 * longer on RPC.
 */
function archivedRowsByTx() {
  archivedRowsRun ??= (async () => {
    const routes = [
      `v1/payroll/${contracts.payroll}/companies/${companyId}/events`,
      ...[treasury, ...workers, pub.outsider.account].map((a) => `v1/tokens/${contracts.token}/accounts/${a}/events`),
    ];
    const byTx = new Map();
    for (const route of routes) {
      const { rows, complete } = await archiveRows(archive.baseUrl, route, pub.fromLedger);
      if (!complete) throw new Error(`the archive does not vouch for ${route} from ledger ${pub.fromLedger}`);
      for (const r of rows) byTx.set(r.txHash, [...(byTx.get(r.txHash) ?? []), r]);
    }
    return byTx;
  })();
  return archivedRowsRun;
}

/** One transaction as a stranger can read it: from RPC while it keeps it, then from Horizon and the archive. */
async function haystackOf(hash) {
  const raw = await rpcServer._getTransaction(hash);
  if (raw.status !== "NOT_FOUND") return { haystack: transactionHaystack(raw), from: "RPC" };
  if (!archive) {
    const why = raw.oldestLedger > pub.fromLedger ? "it is older than RPC's 7-day window and no --archive was given" : "RPC does not know it";
    throw new Error(`transaction ${hash} cannot be read: ${why}`);
  }
  const rows = (await archivedRowsByTx()).get(hash) ?? [];
  return { haystack: storedHaystack(await horizonTransaction(hash), rows), from: "Horizon and the archive" };
}

async function p1() {
  const seeded = seededPayments();
  const salaries = seeded ?? auditLines((await accountantAudit()).audit).map((l) => ({ runId: l.runId, worker: l.worker, amount: l.amount }));
  if (salaries.length !== salaryCount) return fail(`The ${salaryCount} salaries to search for are not known (the private seed file is absent and the accountant key did not open all of them), so the stranger's search could not run.`);
  const { hashes, sources } = await showcaseTransactions();
  const hits = [];
  let bytes = 0;
  const fromRpc = [];
  const stored = { count: 0, parts: new Set() };
  for (const hash of hashes) {
    const { haystack, from } = await haystackOf(hash);
    bytes += haystack.size;
    if (from === "RPC") fromRpc.push(hash);
    else {
      stored.count++;
      haystack.parts.forEach((p) => stored.parts.add(p));
    }
    for (const [i, s] of salaries.entries()) {
      const found = findAmount(haystack, amountNeedles(s.amount));
      if (found.length > 0) hits.push({ i, hash, found });
    }
  }
  const readable = new Set(hits.map((h) => h.i)).size;

  // The control: a public amount must be found by the very same search.
  const { haystack: depositHay } = await haystackOf(firstDepositTx);
  const depositAmount = secrets
    ? BigInt(secrets.amounts.deposits[runs[0].id.toString()])
    : (await core.fetchAccountHistory({ port: events, ...withArchive, contracts, account: treasury, fromLedger: pub.fromLedger })).events.find(
        (e) => e.txHash === firstDepositTx && e.kind === "token" && e.event.type === "deposit",
      )?.event.amount;
  const controlFound = depositAmount === undefined ? [] : findAmount(depositHay, amountNeedles(depositAmount));

  const read =
    stored.count === 0
      ? `all ${hashes.length} showcase transactions from RPC (envelope, result, meta and events)`
      : `all ${hashes.length} showcase transactions, ${fromRpc.length} from RPC (envelope, result, meta and events) and ${stored.count} past RPC's window from Horizon and the archive (${[...stored.parts].join(", ")})`;
  const extra = [
    `Salaries a stranger can read: ${readable} of ${salaryCount}`,
    ...(archive ? [`Transactions listed from: ${sources}; bodies read from RPC ${fromRpc.length}, Horizon and the archive ${stored.count}`] : []),
    ...(stored.count > 0 ? ["Not searched past RPC's window: anything Horizon does not serve, and the auditor registry's events, which the archive does not keep"] : []),
  ];
  if (readable > 0) {
    extra.push(...hits.map((h) => `salary ${h.i + 1} shows in tx ${h.hash} as ${h.found.join(", ")}`));
    return fail(`A stranger reading the showcase's transactions found ${readable} of ${salaryCount} salaries in plain form.`, extra);
  }
  if (controlFound.length === 0) {
    return fail("The search found no salary, but it also missed the treasury's public deposit in its own deposit transaction, so the search itself is not proven to work.", extra);
  }
  return pass(
    `A stranger read ${read}, ${(bytes / 1e6).toFixed(1)} MB, and searched them for the ${salaryCount} salaries in ${ENCODING_NAMES.length} encodings each, and found none, because a salary only ever travels as an encrypted transfer; the same search does find the treasury's public deposit in its deposit transaction (as ${controlFound.join(", ")}), so it would have seen a salary in plain form.`,
    extra,
  );
}

async function p2() {
  const { audit, source } = await accountantAudit();
  const seeded = seededPayments();
  const lines = auditLines(audit);
  const problems = [];
  if (!audit.complete) problems.push("the audit says its history is incomplete");
  if (audit.undecryptable.length > 0) problems.push(`${audit.undecryptable.length} payments are undecryptable`);
  if (lines.length !== salaryCount) problems.push(`it opened ${lines.length} payments, not ${salaryCount}`);
  for (const r of runs) {
    const mine = audit.runs.find((a) => a.runId === r.id);
    const ws = new Set((mine?.lines ?? []).map((l) => l.worker));
    if (!mine || mine.lines.length !== workers.length || workers.some((w) => !ws.has(w))) problems.push(`run ${r.id} does not have one line per worker`);
    if (mine && mine.total !== mine.lines.reduce((a, l) => a + l.amount, 0n)) problems.push(`run ${r.id} total does not add up`);
    if (mine && mine.lines.some((l) => !r.payTransactions.includes(l.txHash))) problems.push(`run ${r.id} has a line outside its pay transactions`);
  }
  if (audit.grandTotal !== audit.runs.reduce((a, r) => a + r.total, 0n)) problems.push("the grand total does not add up");
  // With the seed file, a line counts as read only if it decrypts to exactly what was paid.
  const read = seeded
    ? seeded.filter((s) => lines.find((l) => l.runId === s.runId && l.worker === s.worker)?.amount === s.amount).length
    : lines.length;
  if (seeded && read !== seeded.length) problems.push(`${seeded.length - read} decrypted amounts differ from what the seed paid`);
  const extra = [`Salaries the accountant can read: ${read} of ${salaryCount}`, ...sourceLine("History", source)];
  if (problems.length > 0) return fail(`The published demo accountant key did not open the payroll cleanly: ${problems.join("; ")}.`, extra);
  return pass(
    `The published demo accountant key opened Andes Studio's payroll through Kalypso's audit: all ${salaryCount} payments decrypted, each run total adds up${seeded ? " and every amount equals what the seed paid" : ""}, and nothing is undecryptable, because the treasury's transfers are encrypted to this one accountant key.`,
    extra,
  );
}

async function p3() {
  const observed = observedHistory();
  const audit = await core.auditCompany({ port, history: observed.history, txSource, contracts, companyId, auditorSecret: cts.randomScalar() });
  const source = observed.source();
  // The audit marks every treasury spend in the history it read, which after a payroll release
  // also holds the earlier contract's pay. The same read, with the same function, source and range,
  // says how many there are.
  const treasuryRead = await core.fetchAccountHistory({ port: events, ...withArchive, contracts, account: treasury, fromLedger: pub.fromLedger });
  const spends = treasurySpendCount(treasuryRead.events, treasury);
  const read = auditLines(audit).length;
  const extra = [
    `Salaries a random key can read: ${read} of ${salaryCount}`,
    `Treasury spends in the history read: ${spends}; marked undecryptable: ${audit.undecryptable.length}`,
    ...sourceLine("History", source),
  ];
  if (read > 0 || audit.grandTotal !== 0n) return fail(`A random auditor key opened ${read} payments.`, extra);
  if (spends < salaryCount) {
    return fail(`The treasury's history holds ${spends} spends, fewer than the ${salaryCount} showcase salaries, so it is not the history those salaries were paid from.`, extra);
  }
  if (audit.undecryptable.length !== spends) {
    return fail(`A random auditor key read nothing, but ${audit.undecryptable.length} spends were marked undecryptable instead of the treasury's ${spends}.`, extra);
  }
  const earlier = spends - salaryCount;
  return pass(
    `A random auditor key tried to open the same payroll and read nothing: every amount it decrypts falls outside any possible balance, so Kalypso marks all ${spends} of the treasury's spends undecryptable (the ${salaryCount} showcase salaries${earlier > 0 ? ` and ${earlier} earlier ones` : ""}) and counts none of them.`,
    extra,
  );
}

const dummyProof = () => sdk.xdr.ScVal.scvBytes(Buffer.alloc(64));
const payArgs = (company, runId, worker) => [
  sdk.xdr.ScVal.scvU64(new sdk.xdr.Uint64(company)),
  sdk.xdr.ScVal.scvU64(new sdk.xdr.Uint64(runId)),
  sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvVec([new sdk.Address(worker).toScVal(), dummyProof()])]),
];

async function p4() {
  const run = await core.getRun(port, contracts.payroll, companyId, latestRun.id);
  const paid = await core.isPaid(port, contracts.payroll, companyId, latestRun.id, workers[0]);
  if (!paid) return fail(`${short(workers[0])} is not marked paid in run ${latestRun.id}, so there is nothing to pay twice.`);
  const expected = run.status === "Closed" ? 11 : 14;
  const name = expected === 11 ? "RunNotOpen" : "AlreadyPaid";
  const r = await simulate({ source: treasury, contractId: contracts.payroll, method: "pay", args: payArgs(companyId, latestRun.id, workers[0]), mode: "record" });
  if (r.contractCode !== expected) return fail(`Paying ${short(workers[0])} again in run ${latestRun.id} was not refused with #${expected} ${name}: ${r.head}.`);
  return pass(
    `Paying worker ${short(workers[0])} a second time in run ${latestRun.id} "${latestRun.label}", simulated as the treasury itself, was refused by the payroll contract with Error(Contract, #${expected}) ${name}, because ${expected === 14 ? "the run's paid flag for that worker is already set" : "the run is closed"} (the run is ${run.status.toLowerCase()}).`,
  );
}

const refusedFor = (r, account) => !r.ok && r.auth !== null && r.auth.account === account;

async function p5() {
  const outsider = pub.outsider.account;
  const rival = await core.getCompany(port, contracts.payroll, BigInt(pub.outsider.companyId));
  if (rival.admin !== outsider) return fail(`${short(outsider)} is not the admin of company ${pub.outsider.companyId} on chain, so it is not another company's admin.`);
  const args = payArgs(companyId, latestRun.id, workers[0]);
  const unsigned = await simulate({ source: outsider, contractId: contracts.payroll, method: "pay", args, mode: "enforce" });
  const forged = await simulate({
    source: outsider,
    contractId: contracts.payroll,
    method: "pay",
    args,
    mode: "enforce",
    auth: [await forgedAuthorization({ claimed: treasury, forger: sdk.Keypair.random(), contractId: contracts.payroll, method: "pay", args })],
  });
  const direct = await simulate({
    source: outsider,
    contractId: contracts.token,
    method: "confidential_transfer",
    args: [new sdk.Address(treasury).toScVal(), new sdk.Address(outsider).toScVal(), dummyProof()],
    mode: "enforce",
  });
  const attempts = [
    ["pay into run " + latestRun.id + " with no treasury signature", unsigned],
    ["pay with a treasury authorisation signed by another key", forged],
    ["the token's confidential_transfer out of the treasury, called directly", direct],
  ];
  const extra = attempts.map(([what, r]) => `${what}: ${r.ok ? "the simulation succeeded" : r.auth ? `Error(Auth, ${r.auth.code}), ${r.auth.reason} for ${short(r.auth.account ?? "unknown account")}` : r.head}`);
  if (!attempts.every(([, r]) => refusedFor(r, treasury))) return fail(`An attack by the admin of company ${pub.outsider.companyId} on Andes Studio's treasury was not refused for want of the treasury's signature.`, extra);
  if (!forged.auth.signerNotOnAccount) return fail("The forged treasury signature was refused, but not because its signer does not belong to the treasury.", extra);
  return pass(
    `The admin of "${pub.outsider.companyLabel}" (company ${pub.outsider.companyId}) tried to move Andes Studio's money three ways (paying into run ${latestRun.id} unsigned, paying with a forged treasury signature, and calling the token's transfer out of the treasury directly), and the network refused all three, because only the treasury's own key can authorise its money.`,
    extra,
  );
}

async function p6() {
  const outsider = pub.outsider.account;
  if ((await core.workerStatus(port, contracts.payroll, companyId, outsider)) !== null) return fail(`${short(outsider)} has a status in Andes Studio, so it is not an off-roster address.`);
  if ((await core.confidentialBalance(port, contracts.token, outsider)) === null) return fail(`${short(outsider)} is not registered with the token, so the attack would fail for another reason.`);
  const r = await simulate({ source: treasury, contractId: contracts.payroll, method: "pay", args: payArgs(companyId, latestRun.id, outsider), mode: "record" });
  if (r.contractCode !== 8) return fail(`Paying the off-roster ${short(outsider)} was not refused with #8 NotActive: ${r.head}.`);
  return pass(
    `Paying ${short(outsider)}, an address that holds a token account but is not on Andes Studio's roster, simulated as the treasury itself, was refused by the payroll contract with Error(Contract, #8) NotActive, because pay checks the roster for every worker before any money moves.`,
  );
}

async function p7() {
  const verifier = await readInstance(contracts.verifier);
  if (!verifier || verifier.wasmHash !== VERIFIER_WASM.hash) return fail("The verifier does not run the pinned OpenZeppelin verifier code.");
  const token = await readInstance(contracts.token);
  if (tokenWiring(token).verifier !== contracts.verifier) return fail("The token does not check proofs with this verifier.");
  const stored = verificationKeysInInstance(verifier);
  for (const k of VERIFICATION_KEYS) {
    const served = await readVerificationKey(stack.deployer, contracts.verifier, k.circuitType);
    if (!served || sha256hex(served) !== k.sha256 || sha256hex(stored.get(k.circuitType) ?? Buffer.alloc(0)) !== k.sha256) {
      return fail(`The ${k.name} verification key does not hash to its pin ${k.sha256.slice(0, 8)}.`);
    }
  }
  const calls = await verifierAccessByCalls(stack.deployer, contracts.verifier, stack.deployer);
  const ledger = await verifierAccessFromLedger(contracts.verifier, stack.deployer, verifier);
  const locked =
    calls.getAdmin === null && calls.hasRoleDeployerManager === null && calls.managerMemberCount === 0 &&
    ledger.instanceAdminEntry === null && ledger.otherInstanceKeys.length === 0 && ledger.pendingAdminEntry === null &&
    ledger.managerCountEntry === 0 && ledger.deployerHasRoleEntry === null && ledger.managerMember0Entry === null && ledger.existingRolesEntry?.length === 0;
  if (!locked) return fail("The verifier still has an admin or a manager.");
  const swap = await simulateCall({
    source: stack.deployer,
    contractId: contracts.verifier,
    method: "update_verification_key",
    args: [scv.u32(2), scv.bytes(readFileSync(path.join(VK_DIR, "transfer.vk.bin"))), scv.addr(stack.deployer)],
  });
  if (swap.ok || swap.code !== UNAUTHORIZED_ERROR) return fail(`Swapping the transfer key as the deployer was not refused with #${UNAUTHORIZED_ERROR}: ${swap.ok ? "the simulation succeeded" : swap.error}.`);
  return pass(
    `Swapping the proof rules was tried as the account that deployed the verifier (update_verification_key on the transfer circuit) and refused with Error(Contract, #${UNAUTHORIZED_ERROR}) Unauthorized, because the token's verifier has no admin and no manager left and its three keys still hash to the pinned circuits.`,
  );
}

async function p8() {
  const id = pub.accountant.auditorId;
  const owner = sdk.Address.fromScVal(await port.read(contracts.auditor, "owner_of", [sdk.xdr.ScVal.scvU32(id)])).toString();
  if (owner !== pub.accountant.account) return fail(`Auditor id ${id} is owned by ${short(owner)}, not the accountant.`);
  const published = cts.scalarMul(BigInt(pub.accountant.demoAccountantKeyPublishedOnPurpose), cts.H);
  if (pointHex(await core.getAuditorKey(port, contracts.auditor, id)) !== pointHex(published)) return fail(`Auditor id ${id} no longer holds the published demo key.`);
  const stranger = sdk.Keypair.random();
  const args = [sdk.xdr.ScVal.scvU32(id), sdk.xdr.ScVal.scvBytes(Buffer.from(cts.pointToBytes(cts.scalarMul(cts.randomScalar(), cts.H))))];
  const unsigned = await simulate({ source: stranger.publicKey(), contractId: contracts.auditor, method: "rotate_key", args, mode: "enforce" });
  const forged = await simulate({
    source: stranger.publicKey(),
    contractId: contracts.auditor,
    method: "rotate_key",
    args,
    mode: "enforce",
    auth: [await forgedAuthorization({ claimed: owner, forger: stranger, contractId: contracts.auditor, method: "rotate_key", args })],
  });
  const extra = [
    `unsigned: ${unsigned.auth ? `Error(Auth, ${unsigned.auth.code}), ${unsigned.auth.reason} for ${short(unsigned.auth.account ?? "unknown account")}` : unsigned.head}`,
    `forged: ${forged.auth ? `Error(Auth, ${forged.auth.code}), ${forged.auth.reason} for ${short(forged.auth.account ?? "unknown account")}` : forged.head}`,
  ];
  if (!refusedFor(unsigned, owner) || !refusedFor(forged, owner) || !forged.auth.signerNotOnAccount) {
    return fail(`Rotating auditor id ${id} by a stranger was not refused for want of the accountant's signature.`, extra);
  }
  return pass(
    `A stranger with a brand-new key tried to rotate the accountant's auditor key (id ${id}) to one of its own, unsigned and with a forged signature, and the registry refused both, because only the id's owner, the accountant's account, can change the key.`,
    extra,
  );
}

/**
 * One archived token event, in the archive's plain JSON, as a deposit or withdrawal amount.
 * Returns null for any other event. A deposit or withdrawal in any other shape throws, so it can
 * never be skipped silently.
 */
function archivedFlow(e) {
  const name = e.topic[0];
  if (name !== "deposit" && name !== "withdraw") return null;
  const amount = e.value?.amount;
  if (e.topic.length !== 3 || typeof amount !== "string" || !/^\d{1,39}$/.test(amount)) {
    throw new Error(`a ${name} event in tx ${e.txHash} cannot be read from the archive, so solvency is not proven`);
  }
  return { type: name, amount: BigInt(amount) };
}

async function p9() {
  const window = await events.ledgerWindow();
  // From deployments/testnet.json: the history must begin with this transaction's own events.
  const deployTx = stack.tokenDeployTx;
  const start = deployTx.ledger;
  let deposits = 0n;
  let withdrawals = 0n;
  const counts = { deposit: 0, withdraw: 0 };
  let first = null;
  let rpcFrom = start;
  let source = "RPC events";
  if (start < window.oldestLedger) {
    if (!archive) {
      return fail(`The token's history starts at ledger ${start}, older than RPC's oldest ledger ${window.oldestLedger}, so its deposits and withdrawals cannot all be read from RPC and solvency is not proven. Pass --archive <url> to read the older ledgers from an archive.`);
    }
    // The archive vouches up to the ledger its health names; RPC must reach back to the next one.
    const health = await archiveHealth(archive.baseUrl);
    if (health.through + 1 < window.oldestLedger) {
      return fail(`The archive vouches through ledger ${health.through} and RPC starts at ledger ${window.oldestLedger}, so the ledgers between are read by neither and solvency is not proven.`);
    }
    for (const e of await archiveTokenStream(archive.baseUrl, contracts.token, start, health.through)) {
      first ??= { ledger: e.ledger, txHash: e.txHash };
      const flow = archivedFlow(e);
      if (flow?.type === "deposit") {
        deposits += flow.amount;
        counts.deposit++;
      }
      if (flow?.type === "withdraw") {
        withdrawals += flow.amount;
        counts.withdraw++;
      }
    }
    rpcFrom = health.through + 1;
    source = `the archive for ledgers ${start} to ${health.through} (it vouches from ${health.from}) and RPC events after`;
  }
  let query = { contractId: contracts.token, limit: PAGE, startLedger: rpcFrom };
  for (let page = 0; rpcFrom <= window.latestLedger; page++) {
    if (page === MAX_PAGES) return fail("The token has more events than the check reads, so solvency is not proven.");
    const reply = await events.contractEvents(query);
    for (const raw of reply.events) {
      if (!raw.successful || raw.contractId !== contracts.token || raw.ledger < rpcFrom) continue;
      first ??= { ledger: raw.ledger, txHash: raw.txHash };
      const e = core.decodeContractEvent(raw, contracts);
      if (e.kind === "undecodable" && (e.name === "deposit" || e.name === "withdraw")) return fail(`A ${e.name} event in tx ${e.txHash} cannot be read, so solvency is not proven.`);
      if (e.kind !== "token") continue;
      if (e.event.type === "deposit") {
        deposits += e.event.amount;
        counts.deposit++;
      }
      if (e.event.type === "withdraw") {
        withdrawals += e.event.amount;
        counts.withdraw++;
      }
    }
    const scanned = reply.cursor ? core.parseRpcEventId(reply.cursor).ledger : reply.latestLedger;
    if (reply.cursor === null || (reply.events.length < PAGE && scanned >= reply.latestLedger)) break;
    query = { contractId: contracts.token, limit: PAGE, cursor: reply.cursor };
  }
  if (!startsAtDeploy(first, deployTx)) {
    const seen = first ? `ledger ${first.ledger}, tx ${first.txHash}` : "no event at all";
    return fail(`The first token event read (${seen}) is not from the token's deploy transaction ${deployTx.hash} in ledger ${deployTx.ledger}, so the history read may not start at the token's creation.`);
  }
  const balance = sdk.scValToNative(await port.read(stack.usdc.sac, "balance", [new sdk.Address(contracts.token).toScVal()]));
  if (balance !== deposits - withdrawals) {
    return fail(`The token's USDC balance is ${balance > deposits - withdrawals ? "above" : "below"} public deposits minus public withdrawals, so the pool is not exactly backed.`);
  }
  return pass(
    `Checked that no USDC can go missing behind the encryption: the token's balance on the USDC contract equals every public deposit minus every public withdrawal since its first ledger ${start} (${counts.deposit} deposit${counts.deposit === 1 ? "" : "s"} and ${counts.withdraw} withdrawal${counts.withdraw === 1 ? "" : "s"}, read from ${source}), so every confidential balance is backed.`,
    sourceLine("Token events", source),
  );
}

async function p10() {
  if (!plantedTransferTx || !plantedDepositTx) return fail("The seed record has no planted transfer or deposit to check.");
  const worker = pub.outsider.plantedOn;
  const outsider = pub.outsider.account;
  const workerHistory = await core.fetchAccountHistory({ port: events, ...withArchive, contracts, account: worker, fromLedger: pub.fromLedger });
  const { audit, source: auditSource } = await accountantAudit();
  const extra = [...sourceLine("Worker history", sourceName(workerHistory.source)), ...sourceLine("Accountant history", auditSource)];
  const seen = (hash, type) =>
    workerHistory.events.some((e) => e.txHash === hash && e.kind === "token" && e.event.type === type && e.event.from === outsider && e.event.to === worker);
  if (!seen(plantedTransferTx, "transfer") || !seen(plantedDepositTx, "deposit")) return fail("The planted transfer and deposit are not both on chain in the worker's token history.", extra);
  const planted = [plantedTransferTx, plantedDepositTx];
  const auditTxs = auditLines(audit).map((l) => l.txHash);
  if (planted.some((h) => auditTxs.includes(h)) || auditTxs.length !== salaryCount) {
    return fail("A planted payment is counted in the accountant's totals.", extra);
  }
  if (!secrets) {
    return {
      verdict: "SKIP",
      sentence: `The accountant half held (neither planted transaction is in the accountant's totals), but the worker half needs ${short(worker)}'s keys from the private seed file, which is not here, so the worker's own payslips were not opened.`,
      extra,
    };
  }
  const keypair = sdk.Keypair.fromSecret(secrets.keys[Object.keys(secrets.keys).find((k) => sdk.Keypair.fromSecret(secrets.keys[k]).publicKey() === worker)]);
  const observed = observedHistory();
  const view = await core.loadWorkerView({ port, history: observed.history, txSource, contracts, worker, keys: kalypsoKeys(keypair), companyIds: [companyId, BigInt(pub.outsider.companyId)] });
  extra.push(...sourceLine("Worker view history", observed.source()));
  const mine = seededPayments().filter((s) => s.worker === worker);
  const payslipsOk =
    view.payslips.length === mine.length &&
    mine.every((s) => view.payslips.some((p) => p.runId === s.runId && p.amount === s.amount)) &&
    !view.payslips.some((p) => planted.includes(p.txHash));
  const plantedValue = BigInt(secrets.amounts.planted.transfer) + BigInt(secrets.amounts.planted.deposit);
  // A payroll release moved the showcase to a new contract; what the earlier one paid is still in the balance.
  const earlier = earlierPayOf(secrets, worker);
  const balanceOk = view.complete && view.receiving + view.spendable === mine.reduce((a, s) => a + s.amount, 0n) + plantedValue + earlier;
  const earlierNote = earlier > 0n ? " plus its pay from the earlier payroll contract" : "";
  if (!payslipsOk) return fail(`${short(worker)}'s payslips are not exactly the ${mine.length} seeded payslips.`, extra);
  if (!balanceOk) return fail(`${short(worker)}'s verified balance does not hold the payslips plus both planted payments${earlierNote}.`, extra);
  return pass(
    `An outsider sent ${short(worker)} a direct confidential transfer and a public deposit; both reached the worker's verified balance${earlierNote ? `, which also holds its pay from the earlier payroll contract,` : ""} yet the worker sees only its ${mine.length} real payslips and the accountant's totals count neither, because a payslip needs Andes Studio's own payroll event and paid flag in the same transaction.`,
    extra,
  );
}

const u32 = (n) => sdk.xdr.ScVal.scvU32(n);
const u64 = (n) => sdk.xdr.ScVal.scvU64(new sdk.xdr.Uint64(n));
const addr = (g) => new sdk.Address(g).toScVal();
const P11_COMPANY_LABEL = "Front-run test (prove P11)";
const STAGE_ATTEMPTS = 3;

let prover;
const getProver = () => (prover ??= createNodeProver());

async function p11() {
  const journal = memoryJournal();
  const attacker = sdk.Keypair.random();
  const treasury = sdk.Keypair.random();
  // The victim accountant never signs: it is only the address the treasury names.
  const accountant = sdk.Keypair.random().publicKey();
  const accountantKey = cts.scalarMul(cts.randomScalar(), cts.H);
  await ensureFunded(attacker.publicKey());
  await ensureFunded(treasury.publicKey());

  // An app that predicts ids reads key_count and expects the accountant to get that id. The
  // attacker registers its own key first and takes it. A registration by anyone else in between
  // would hand the attacker another id, so staging is retried.
  let predicted = null;
  let taken = null;
  for (let attempt = 0; attempt < STAGE_ATTEMPTS && taken === null; attempt++) {
    const guess = Number(sdk.scValToNative(await port.read(contracts.auditor, "key_count", [])));
    const tx = await invoke({
      label: "P11 attacker register_key",
      signer: attacker,
      journal,
      build: (base) =>
        core.buildRegisterKey({ ...base, contractId: contracts.auditor }, { owner: attacker.publicKey(), point: cts.scalarMul(cts.randomScalar(), cts.H) }),
    });
    const id = core.readRegisteredAuditorId(tx.returnValue);
    if (id === guess) [predicted, taken] = [guess, tx];
  }
  if (taken === null) return fail(`Another registration landed between reading key_count and the attacker's own ${STAGE_ATTEMPTS} times, so the front-run was not staged; run the check again.`);

  const envelope = await getProver().proveRegister(kalypsoKeys(treasury));
  const { sequence } = await port.sourceAccount(treasury.publicKey());
  const base = { source: { address: treasury.publicKey(), sequence }, networkPassphrase: stack.passphrase, timeoutSeconds: 120, contractId: contracts.token };
  let refusal = null;
  try {
    await core.buildCheckedRegister(port, base, {
      account: treasury.publicKey(),
      auditorId: predicted,
      data: envelope,
      registry: contracts.auditor,
      auditorOwner: accountant,
      auditorKey: accountantKey,
    });
  } catch (e) {
    refusal = e;
  }
  const extra = [
    `predicted id ${predicted} (key_count), taken by attacker ${short(attacker.publicKey())} in tx ${taken.hash}`,
    `checked registration of treasury ${short(treasury.publicKey())} under id ${predicted}: ${refusal ? `${refusal.name} ${refusal.code ?? ""} ${refusal.message}` : "a transaction was built"}`,
  ];
  if (!(refusal instanceof core.AuditorBindingError) || refusal.code !== "OWNER_MISMATCH") {
    return fail(`The victim treasury's checked registration under the taken id ${predicted} was not refused with OWNER_MISMATCH before a transaction existed.`, extra);
  }
  if ((await core.confidentialBalance(port, contracts.token, treasury.publicKey())) !== null) {
    return fail("The checked registration was refused, yet the victim treasury is registered with the token.", extra);
  }

  // Now an app without the check: the treasury registers under the taken id by hand.
  const byHand = await invoke({
    label: "P11 treasury registers by hand",
    signer: treasury,
    journal,
    build: (b) => core.buildRegister({ ...b, contractId: contracts.token }, { account: treasury.publicKey(), auditorId: predicted, data: envelope }),
  });
  const registered = await core.confidentialBalance(port, contracts.token, treasury.publicKey());
  extra.push(`treasury registered by hand under id ${registered?.auditorId ?? "none"} in tx ${byHand.hash}`);
  if (registered?.auditorId !== predicted) return fail(`The treasury's registration by hand did not land under id ${predicted}.`, extra);
  const createArgs = (named) => [addr(treasury.publicKey()), addr(named), u32(predicted), sdk.xdr.ScVal.scvString(P11_COMPANY_LABEL)];
  const refused = await simulate({ source: treasury.publicKey(), contractId: contracts.payroll, method: "create_company", args: createArgs(accountant), mode: "record" });
  // The control: the same call naming the id's real owner passes, so the refusal is the owner check.
  const control = await simulate({ source: treasury.publicKey(), contractId: contracts.payroll, method: "create_company", args: createArgs(attacker.publicKey()), mode: "record" });
  extra.push(`create_company naming the victim accountant: ${refused.ok ? "the simulation succeeded" : refused.head}`);
  extra.push(`control, the same call naming the attacker: ${control.ok ? "the simulation succeeded" : control.head}`);
  if (refused.contractCode !== core.PayrollErrorCode.AuditorNotOwnedByAccountant) {
    return fail(`create_company for the treasury bound to the taken id was not refused with #${core.PayrollErrorCode.AuditorNotOwnedByAccountant} AuditorNotOwnedByAccountant.`, extra);
  }
  if (!control.ok) return fail("create_company naming the id's real owner was refused too, so the refusal is not shown to come from the owner check.", extra);
  return pass(
    `An attacker read the auditor registry's next id (${predicted}) and registered its own key under it first. The victim treasury's registration under that predicted id was refused before any transaction existed, because the registry says the attacker, not the accountant, owns it; and a treasury registered under it by hand still cannot found a company naming the accountant: create_company was refused with Error(Contract, #${refused.contractCode}) AuditorNotOwnedByAccountant (simulated, no fee), so no salary is ever encrypted to the attacker's key.`,
    extra,
  );
}

// A u32 expiry no limit allows, used to learn which ledger a simulation runs against.
const FAR_LEDGER = 0xffffffff;

/**
 * The furthest expiry `offer` accepts, and its answer one ledger later. Every attempt reads the
 * limit from simulations that all ran against the same ledger, so it is measured where the
 * contract applies max_live_until_ledger, with no guess about the ledger a simulation runs in.
 */
async function offerLimit(offer, maxEntryTtl) {
  for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt++) {
    const probe = await offer(FAR_LEDGER);
    if (probe.ok) return { error: `an offer to expire on ledger ${FAR_LEDGER} was accepted` };
    // The limit is the running ledger plus maxEntryTtl - 1, and a simulation runs on its latest ledger or the next.
    const top = probe.latestLedger + maxEntryTtl;
    const above = await offer(top + 1);
    const at = await offer(top);
    const below = at.ok ? null : await offer(top - 1);
    if ([above, at, below].some((r) => r !== null && r.latestLedger !== probe.latestLedger)) continue;
    if (at.ok) return { limit: top, onePast: above };
    if (below.ok) return { limit: top - 1, onePast: at };
    return { error: `offers to expire on ledgers ${top - 1} and ${top} were both refused: ${below.head}` };
  }
  return { error: `a ledger closed during each of ${STAGE_ATTEMPTS} measurements, so the limit was not pinned down` };
}

async function p12() {
  const maxEntryTtl = await readMaxEntryTtl();
  const stranger = sdk.Keypair.random().publicKey();
  const contractsUnderTest = [
    {
      name: "payroll",
      call: "propose_admin",
      code: core.PayrollErrorCode.InvalidLiveUntil,
      offer: (until) =>
        simulate({ source: treasury, contractId: contracts.payroll, method: "propose_admin", args: [u64(companyId), addr(stranger), u32(until)], mode: "record" }),
    },
    {
      name: "auditor registry",
      call: "propose_owner",
      code: core.AuditorErrorCode.InvalidLiveUntil,
      offer: (until) =>
        simulate({ source: pub.accountant.account, contractId: contracts.auditor, method: "propose_owner", args: [u32(pub.accountant.auditorId), addr(stranger), u32(until)], mode: "record" }),
    },
  ];
  const extra = [];
  const problems = [];
  for (const c of contractsUnderTest) {
    const r = await offerLimit(c.offer, maxEntryTtl);
    if (r.error) {
      problems.push(`${c.name}: ${r.error}`);
      continue;
    }
    extra.push(`${c.name} ${c.call}: expiry ${r.limit} accepted; expiry ${r.limit + 1}: ${r.onePast.ok ? "accepted" : r.onePast.head}`);
    if (r.onePast.ok || r.onePast.contractCode !== c.code) problems.push(`${c.name} did not refuse an offer one ledger past the limit with #${c.code}`);
  }
  if (problems.length) return fail(`A handover offer past the network's longest entry lifetime was not refused cleanly: ${problems.join("; ")}.`, extra);
  return pass(
    `A handover offer one ledger past the furthest ledger the network lets an entry live to (${maxEntryTtl} ledgers ahead) was refused by both contracts, simulated as the real admin and the real accountant: the payroll's propose_admin with Error(Contract, #${contractsUnderTest[0].code}) and the registry's propose_owner with Error(Contract, #${contractsUnderTest[1].code}), both InvalidLiveUntil, while an offer at the limit itself was accepted. So no handover can stay acceptable for longer than the offer itself can be stored.`,
    extra,
  );
}

async function p13() {
  const company = await core.getCompany(port, contracts.payroll, companyId);
  const memberships = await Promise.all(workers.map((w) => core.getMembershipsOf(port, contracts.payroll, w)));
  const extra = [
    `runs_opened ${company.runsOpened}, showcase runs ${runs.length}`,
    `memberships_of: ${workers.map((w, i) => `${short(w)} ${memberships[i]}`).join(", ")}`,
  ];
  if (company.runsOpened !== runs.length) return fail(`Andes Studio's on-chain runs_opened is ${company.runsOpened}, not its ${runs.length} runs.`, extra);
  const none = workers.filter((_, i) => memberships[i] < 1);
  if (none.length) return fail(`${none.length} showcase workers have memberships_of 0 although they joined Andes Studio.`, extra);
  return pass(
    `Andes Studio's on-chain runs_opened is ${company.runsOpened}, exactly its ${runs.length} runs, and each of its ${workers.length} workers has memberships_of of at least 1, so a history reader that is served fewer runs or companies than the chain counts knows something was hidden.`,
    extra,
  );
}

async function main() {
  // Only the header uses this, so an RPC that cannot answer still lets every check run and say why.
  const latest = await rpcServer.getLatestLedger().then((l) => `ledger ${l.sequence}`, (e) => `ledger unknown (${e?.message ?? e})`);
  out("Kalypso prove-it: attacking the showcase's promises on Stellar testnet");
  out(`  when       ${latest}, ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
  out(`  showcase   "${pub.company.label}", company ${pub.company.id}, treasury ${treasury}, ${workers.length} workers, runs ${runs.map((r) => `${r.id} "${r.label}"`).join(" and ")}`);
  out(`  contracts  payroll ${contracts.payroll}, token ${contracts.token}, auditor registry ${contracts.auditor}, verifier ${contracts.verifier}`);
  out(`  amounts    ${secrets ? "checked against the private seed file" : "taken from the published demo accountant key (the private seed file is not here)"}`);
  out(
    `  history    ${archive ? `archive ${archive.baseUrl} (${flags.archiveFrom}), RPC where the archive cannot answer, Horizon for transactions RPC no longer has` : "RPC only, about the last 7 days (pass --archive <url> for older ledgers)"}`,
  );
  out("  No showcase key signs anything. Every attack on the showcase is a read or a simulation of current testnet state;");
  out("  only P11 sends transactions, from throwaway friendbot accounts it makes and forgets.");
  out("");
  const sameStack = contracts.payroll === stack.contracts.payroll && contracts.token === stack.contracts.token && contracts.auditor === stack.contracts.auditor && contracts.verifier === stack.contracts.verifier;
  if (!sameStack) throw new Error("the showcase was seeded on another stack than deployments/testnet.json");

  await check("P1", p1);
  await check("P2", p2);
  await check("P3", p3);
  await check("P4", p4);
  await check("P5", p5);
  await check("P6", p6);
  await check("P7", p7);
  await check("P8", p8);
  await check("P9", p9);
  await check("P10", p10);
  await check("P11", p11);
  await check("P12", p12);
  await check("P13", p13);

  const passed = results.filter((r) => r === "PASS").length;
  const skipped = results.filter((r) => r === "SKIP").length;
  const failed = results.filter((r) => r === "FAIL").length;
  out("");
  out(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""} of ${results.length} checks. RESULT: ${failed === 0 ? "PASS" : "FAIL"}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(`prove could not run: ${e?.message ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => prover?.destroy());

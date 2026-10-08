// Attacks Kalypso's own promises against the live showcase company and prints, for each one,
// what was tried and what stopped it. Nothing here signs or sends a transaction: every attack is
// a read or a simulation of the current testnet state, so anyone can run it with no keys.
//
// It reads deployments/showcase-testnet.json. When the private .stellar/showcase-secrets.json
// from the seed is present it also checks every amount against what was seeded and opens a
// worker's own payslips; without it, the amounts come from the published demo accountant key.
// Exits non-zero if any check fails.
//
//   npm run prove:testnet
import path from "node:path";
import { readFileSync } from "node:fs";
import { core, cts, events, kalypsoKeys, pointHex, port, rpcServer, sdk, stack, txSource } from "./lib/kalypso.mjs";
import { ENCODING_NAMES, amountNeedles, findAmount, transactionHaystack } from "./lib/encodings.mjs";
import { forgedAuthorization, simulate } from "./lib/transactions.mjs";
import { PUBLIC_FILE, loadPublic, loadSecrets } from "./lib/showcase-state.mjs";
import { readInstance, simulateCall, scv } from "./lib/chain.mjs";
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
const history = { rpc: events, fromLedger: pub.fromLedger };
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

async function accountantAudit() {
  return core.auditCompany({ port, history, txSource, contracts, companyId, auditorSecret: BigInt(pub.accountant.demoAccountantKeyPublishedOnPurpose) });
}

const auditLines = (audit) => audit.runs.flatMap((r) => r.lines.map((l) => ({ runId: r.runId, ...l })));

/** Every transaction hash a stranger finds for the showcase on chain, plus every one the seed recorded. */
async function showcaseTransactions() {
  const company = await core.fetchCompanyHistory({ port: events, contracts, companyId, fromLedger: pub.fromLedger });
  const treasuryHistory = await core.fetchAccountHistory({ port: events, contracts, account: treasury, fromLedger: pub.fromLedger });
  if (!company.complete || !treasuryHistory.complete) throw new Error("the showcase's history is older than RPC's 7-day window, so a stranger cannot list its transactions from RPC");
  const found = new Set([...company.events, ...treasuryHistory.events].map((e) => e.txHash));
  const missed = runs.flatMap((r) => r.payTransactions).filter((h) => !found.has(h));
  if (missed.length > 0) throw new Error(`the chain does not show recorded pay transactions ${missed.join(", ")}`);
  return [...new Set([...found, ...Object.values(pub.transactions).map((t) => t.hash)])];
}

async function haystackOf(hash) {
  const raw = await rpcServer._getTransaction(hash);
  if (raw.status === "NOT_FOUND") {
    const why = raw.oldestLedger > pub.fromLedger ? "it is older than RPC's 7-day window" : "RPC does not know it";
    throw new Error(`transaction ${hash} cannot be read: ${why}`);
  }
  return transactionHaystack(raw);
}

async function p1(salaries) {
  if (!salaries || salaries.length !== salaryCount) return fail(`The ${salaryCount} salaries to search for are not known (the private seed file is absent and the accountant key did not open all of them), so the stranger's search could not run.`);
  const hashes = await showcaseTransactions();
  const hits = [];
  let bytes = 0;
  for (const hash of hashes) {
    const haystack = await haystackOf(hash);
    bytes += haystack.size;
    for (const [i, s] of salaries.entries()) {
      const found = findAmount(haystack, amountNeedles(s.amount));
      if (found.length > 0) hits.push({ i, hash, found });
    }
  }
  const readable = new Set(hits.map((h) => h.i)).size;

  // The control: a public amount must be found by the very same search.
  const depositHay = await haystackOf(firstDepositTx);
  const depositAmount = secrets
    ? BigInt(secrets.amounts.deposits[runs[0].id.toString()])
    : (await core.fetchAccountHistory({ port: events, contracts, account: treasury, fromLedger: pub.fromLedger })).events.find(
        (e) => e.txHash === firstDepositTx && e.kind === "token" && e.event.type === "deposit",
      )?.event.amount;
  const controlFound = depositAmount === undefined ? [] : findAmount(depositHay, amountNeedles(depositAmount));

  const extra = [`Salaries a stranger can read: ${readable} of ${salaryCount}`];
  if (readable > 0) {
    extra.push(...hits.map((h) => `salary ${h.i + 1} shows in tx ${h.hash} as ${h.found.join(", ")}`));
    return fail(`A stranger reading the showcase's transactions from RPC found ${readable} of ${salaryCount} salaries in plain form.`, extra);
  }
  if (controlFound.length === 0) {
    return fail("The search found no salary, but it also missed the treasury's public deposit in its own deposit transaction, so the search itself is not proven to work.", extra);
  }
  return pass(
    `A stranger read all ${hashes.length} showcase transactions from RPC (envelope, result, meta and events, ${(bytes / 1e6).toFixed(1)} MB) and searched them for the ${salaryCount} salaries in ${ENCODING_NAMES.length} encodings each, and found none, because a salary only ever travels as an encrypted transfer; the same search does find the treasury's public deposit in its deposit transaction (as ${controlFound.join(", ")}), so it would have seen a salary in plain form.`,
    extra,
  );
}

function p2(audit, seeded) {
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
  const extra = [`Salaries the accountant can read: ${read} of ${salaryCount}`];
  if (problems.length > 0) return fail(`The published demo accountant key did not open the payroll cleanly: ${problems.join("; ")}.`, extra);
  return pass(
    `The published demo accountant key opened Andes Studio's payroll through Kalypso's audit: all ${salaryCount} payments decrypted, each run total adds up${seeded ? " and every amount equals what the seed paid" : ""}, and nothing is undecryptable, because the treasury's transfers are encrypted to this one accountant key.`,
    extra,
  );
}

async function p3() {
  const audit = await core.auditCompany({ port, history, txSource, contracts, companyId, auditorSecret: cts.randomScalar() });
  const read = auditLines(audit).length;
  const extra = [`Salaries a random key can read: ${read} of ${salaryCount}`];
  if (read > 0 || audit.grandTotal !== 0n) return fail(`A random auditor key opened ${read} payments.`, extra);
  if (audit.undecryptable.length !== salaryCount) return fail(`A random auditor key read nothing, but ${audit.undecryptable.length} spends were marked undecryptable instead of ${salaryCount}.`, extra);
  return pass(
    `A random auditor key tried to open the same payroll and read nothing: every amount it decrypts falls outside any possible balance, so Kalypso marks all ${salaryCount} payments undecryptable and counts none of them.`,
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

async function p9() {
  const window = await events.ledgerWindow();
  const start = stack.tokenDeployLedger;
  if (start < window.oldestLedger) {
    return fail(`The token's history starts at ledger ${start}, older than RPC's oldest ledger ${window.oldestLedger}, so its deposits and withdrawals cannot all be read from RPC and solvency is not proven.`);
  }
  let query = { contractId: contracts.token, limit: PAGE, startLedger: start };
  let deposits = 0n;
  let withdrawals = 0n;
  const counts = { deposit: 0, withdraw: 0 };
  let birth = false;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) return fail("The token has more events than the check reads, so solvency is not proven.");
    const reply = await events.contractEvents(query);
    for (const raw of reply.events) {
      if (!raw.successful || raw.contractId !== contracts.token || raw.ledger < start) continue;
      const e = core.decodeContractEvent(raw, contracts);
      if (e.kind === "ignored" && e.name === "underlying_asset_set" && raw.ledger === start) birth = true;
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
  if (!birth) return fail(`No underlying_asset_set event at ledger ${start}, so the history read may not start at the token's creation.`);
  const balance = sdk.scValToNative(await port.read(stack.usdc.sac, "balance", [new sdk.Address(contracts.token).toScVal()]));
  if (balance !== deposits - withdrawals) {
    return fail(`The token's USDC balance is ${balance > deposits - withdrawals ? "above" : "below"} public deposits minus public withdrawals, so the pool is not exactly backed.`);
  }
  return pass(
    `Checked that no USDC can go missing behind the encryption: the token's balance on the USDC contract equals every public deposit minus every public withdrawal since its first ledger ${start} (${counts.deposit} deposit${counts.deposit === 1 ? "" : "s"} and ${counts.withdraw} withdrawal${counts.withdraw === 1 ? "" : "s"}, read from RPC events), so every confidential balance is backed.`,
  );
}

async function p10(audit, seeded) {
  if (!plantedTransferTx || !plantedDepositTx) return fail("The seed record has no planted transfer or deposit to check.");
  const worker = pub.outsider.plantedOn;
  const outsider = pub.outsider.account;
  const workerHistory = await core.fetchAccountHistory({ port: events, contracts, account: worker, fromLedger: pub.fromLedger });
  const seen = (hash, type) =>
    workerHistory.events.some((e) => e.txHash === hash && e.kind === "token" && e.event.type === type && e.event.from === outsider && e.event.to === worker);
  if (!seen(plantedTransferTx, "transfer") || !seen(plantedDepositTx, "deposit")) return fail("The planted transfer and deposit are not both on chain in the worker's token history.");
  const planted = [plantedTransferTx, plantedDepositTx];
  const auditTxs = auditLines(audit).map((l) => l.txHash);
  if (planted.some((h) => auditTxs.includes(h)) || auditTxs.length !== salaryCount) {
    return fail("A planted payment is counted in the accountant's totals.");
  }
  if (!secrets) {
    return {
      verdict: "SKIP",
      sentence: `The accountant half held (neither planted transaction is in the accountant's totals), but the worker half needs ${short(worker)}'s keys from the private seed file, which is not here, so the worker's own payslips were not opened.`,
    };
  }
  const keypair = sdk.Keypair.fromSecret(secrets.keys[Object.keys(secrets.keys).find((k) => sdk.Keypair.fromSecret(secrets.keys[k]).publicKey() === worker)]);
  const view = await core.loadWorkerView({ port, history, txSource, contracts, worker, keys: kalypsoKeys(keypair), companyIds: [companyId, BigInt(pub.outsider.companyId)] });
  const mine = seeded.filter((s) => s.worker === worker);
  const payslipsOk =
    view.payslips.length === mine.length &&
    mine.every((s) => view.payslips.some((p) => p.runId === s.runId && p.amount === s.amount)) &&
    !view.payslips.some((p) => planted.includes(p.txHash));
  const plantedValue = BigInt(secrets.amounts.planted.transfer) + BigInt(secrets.amounts.planted.deposit);
  const balanceOk = view.complete && view.receiving + view.spendable === mine.reduce((a, s) => a + s.amount, 0n) + plantedValue;
  if (!payslipsOk) return fail(`${short(worker)}'s payslips are not exactly the ${mine.length} seeded payslips.`);
  if (!balanceOk) return fail(`${short(worker)}'s verified balance does not hold the payslips plus both planted payments.`);
  return pass(
    `An outsider sent ${short(worker)} a direct confidential transfer and a public deposit; both reached the worker's verified balance, yet the worker sees only its ${mine.length} real payslips and the accountant's totals count neither, because a payslip needs Andes Studio's own payroll event and paid flag in the same transaction.`,
  );
}

async function main() {
  const latest = await rpcServer.getLatestLedger();
  out("Kalypso prove-it: attacking the showcase's promises on Stellar testnet");
  out(`  when       ledger ${latest.sequence}, ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
  out(`  showcase   "${pub.company.label}", company ${pub.company.id}, treasury ${treasury}, ${workers.length} workers, runs ${runs.map((r) => `${r.id} "${r.label}"`).join(" and ")}`);
  out(`  contracts  payroll ${contracts.payroll}, token ${contracts.token}, auditor registry ${contracts.auditor}, verifier ${contracts.verifier}`);
  out(`  amounts    ${secrets ? "checked against the private seed file" : "taken from the published demo accountant key (the private seed file is not here)"}`);
  out("  Nothing below signs or sends a transaction. Every attack is a read or a simulation of current testnet state.");
  out("");
  const sameStack = contracts.payroll === stack.contracts.payroll && contracts.token === stack.contracts.token && contracts.auditor === stack.contracts.auditor && contracts.verifier === stack.contracts.verifier;
  if (!sameStack) throw new Error("the showcase was seeded on another stack than deployments/testnet.json");

  const audit = await accountantAudit();
  const seeded = seededPayments();
  const salaries = seeded ?? auditLines(audit).map((l) => ({ runId: l.runId, worker: l.worker, amount: l.amount }));

  await check("P1", () => p1(salaries));
  await check("P2", async () => p2(audit, seeded));
  await check("P3", p3);
  await check("P4", p4);
  await check("P5", p5);
  await check("P6", p6);
  await check("P7", p7);
  await check("P8", p8);
  await check("P9", p9);
  await check("P10", () => p10(audit, seeded));

  const passed = results.filter((r) => r === "PASS").length;
  const skipped = results.filter((r) => r === "SKIP").length;
  const failed = results.filter((r) => r === "FAIL").length;
  out("");
  out(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""} of ${results.length} checks. RESULT: ${failed === 0 ? "PASS" : "FAIL"}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`prove could not run: ${e?.message ?? e}`);
  process.exitCode = 1;
});

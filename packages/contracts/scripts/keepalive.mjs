// Extends the four Kalypso contracts on testnet (payroll, auditor registry,
// token, verifier), and the code each one runs, to the longest lifetime the
// network allows. Anyone may pay for an extension and it changes nothing else,
// so it is paid by the stellar CLI identity the deploy uses and needs no new key.
// check:testnet fails once any of them has fewer than KEEPALIVE_MIN_DAYS left.
//
// Each contract is extended in its own transaction, so one large code entry
// can never push a transaction past the network's read limits. A contract
// whose instance and code are both within a day of the maximum is skipped.
//
//   npm run keepalive:testnet
import path from "node:path";
import { Operation } from "@stellar/stellar-sdk";
import { DEPLOYMENT_FILE, KEEPALIVE_MIN_DAYS, LEDGERS_PER_DAY } from "./lib/network.mjs";
import { deployerName, stellarCli } from "./lib/stellar-cli.mjs";
import {
  accountExists,
  codeLedgerKey,
  instanceLedgerKey,
  readInstance,
  readLiveUntil,
  readMaxEntryTtl,
  submit,
  xlm,
} from "./lib/chain.mjs";
import { loadDeployment } from "./lib/deployment-record.mjs";

const say = (text) => console.log(`  ${text}`);
const days = (until, latest) => (until === null ? "missing" : `${((until - latest) / LEDGERS_PER_DAY).toFixed(1)} days`);

async function main() {
  const record = loadDeployment({ required: true });
  const cli = stellarCli();
  const name = deployerName();
  const payer = cli.publicKeyOf(name);
  if (!payer) throw new Error(`no stellar CLI identity ${name} in packages/contracts/.stellar. Set DEPLOYER or run npm run deploy:testnet first`);
  if (!(await accountExists(payer))) throw new Error(`${name} ${payer} has no account on testnet. Fund it with friendbot first`);

  const contracts = [
    ["payroll", record.contracts.payroll?.id],
    ["auditor registry", record.contracts.auditorRegistry?.id],
    ["token", record.contracts.token?.id],
    ["verifier", record.contracts.verifier?.id],
  ];
  const targets = [];
  for (const [label, id] of contracts) {
    if (!id) throw new Error(`no ${label} id in ${path.basename(DEPLOYMENT_FILE)}`);
    const instance = await readInstance(id);
    if (!instance) throw new Error(`${label} ${id} has no instance on chain`);
    if (instance.executable !== "contractExecutableWasm") throw new Error(`${label} runs a ${instance.executable} executable`);
    targets.push({ label, id, keys: [instanceLedgerKey(id), codeLedgerKey(instance.wasmHash)] });
  }

  const maxEntryTtl = await readMaxEntryTtl();
  // The host lets an entry live to the current ledger plus maxEntryTtl - 1, its max_live_until_ledger.
  const extendTo = maxEntryTtl - 1;
  const allKeys = targets.flatMap((t) => t.keys);
  const before = await readLiveUntil(allKeys);

  console.log(`Kalypso keepalive on testnet, paid by ${name} ${payer}`);
  console.log(`network maximum: ${maxEntryTtl} ledgers, about ${(maxEntryTtl / LEDGERS_PER_DAY).toFixed(0)} days`);
  console.log("");
  for (const [i, t] of targets.entries()) {
    const [instanceUntil, codeUntil] = before.liveUntil.slice(i * 2, i * 2 + 2);
    console.log(`${t.label} ${t.id}`);
    say(`before: instance ${days(instanceUntil, before.latestLedger)}, code ${days(codeUntil, before.latestLedger)}`);
    const nearMax = (until) => until !== null && until >= before.latestLedger + extendTo - LEDGERS_PER_DAY;
    if (nearMax(instanceUntil) && nearMax(codeUntil)) {
      say("extend: already done (both within a day of the network maximum)");
      continue;
    }
    const res = await submit({
      source: payer,
      operation: Operation.extendFootprintTtl({ extendTo }),
      readOnly: t.keys,
      sign: (tx) => cli.sign(tx, name, payer),
      label: `extend ${t.label}`,
      log: say,
    });
    say(`extend: tx ${res.hash} ledger ${res.ledger} fee ${xlm(res.feeStroops)}`);
  }

  const after = await readLiveUntil(allKeys);
  console.log("");
  console.log("After");
  const low = [];
  for (const [i, t] of targets.entries()) {
    const [instanceUntil, codeUntil] = after.liveUntil.slice(i * 2, i * 2 + 2);
    say(`${t.label.padEnd(17)} instance ${days(instanceUntil, after.latestLedger)}, code ${days(codeUntil, after.latestLedger)}`);
    for (const [what, until] of [["instance", instanceUntil], ["code", codeUntil]]) {
      if (until === null || (until - after.latestLedger) / LEDGERS_PER_DAY < KEEPALIVE_MIN_DAYS) low.push(`${t.label} ${what}`);
    }
  }
  if (low.length) throw new Error(`still below ${KEEPALIVE_MIN_DAYS} days after extending: ${low.join(", ")}`);
  console.log("");
  console.log(`RESULT: PASS, every instance and its code has at least ${KEEPALIVE_MIN_DAYS} days to live`);
}

main().catch((e) => {
  console.error(`keepalive failed: ${e?.message ?? e}`);
  process.exit(1);
});

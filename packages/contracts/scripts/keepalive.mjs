// Extends the four Kalypso contracts on testnet (payroll, auditor registry, token, verifier), and
// the code each one runs, so none archives while it is being judged. Anyone may pay for an
// extension and it changes nothing else, so it is paid by the stellar CLI identity the deploy
// uses and needs no new key. check:testnet fails once any entry has fewer than
// KEEPALIVE_MIN_DAYS left.
//
// Each ledger entry is extended in its own transaction to the target (--days, default 60, capped
// at the network maximum), and an entry that already has more is left alone. Rent grows with an
// entry's size, and a transaction's fee field holds at most 2^32 - 1 stroops (about 429 XLM), so
// a large code entry may not fit a long extension: the fee is simulated first, and the target is
// halved for that entry until it fits, down to KEEPALIVE_MIN_DAYS.
//
//   npm run keepalive:testnet [-- --days <n>]
import path from "node:path";
import { BASE_FEE, Operation, SorobanDataBuilder, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { DEPLOYMENT_FILE, KEEPALIVE_MIN_DAYS, LEDGERS_PER_DAY, NETWORK_PASSPHRASE } from "./lib/network.mjs";
import { deployerName, stellarCli } from "./lib/stellar-cli.mjs";
import {
  accountExists,
  codeLedgerKey,
  instanceLedgerKey,
  readInstance,
  readLiveUntil,
  readMaxEntryTtl,
  server,
  submit,
  xlm,
} from "./lib/chain.mjs";
import { loadDeployment } from "./lib/deployment-record.mjs";

const DEFAULT_DAYS = 60;
// The transaction fee field is a uint32 of stroops.
const MAX_TX_FEE_STROOPS = 4_294_967_295n;

const say = (text) => console.log(`  ${text}`);
const daysLeft = (until, latest) => (until === null ? null : (until - latest) / LEDGERS_PER_DAY);
const daysText = (days) => (days === null ? "missing" : `${days.toFixed(1)} days`);

function parseFlags(argv) {
  const flags = { days: DEFAULT_DAYS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--days") throw new Error(`unknown argument ${argv[i]}. Flags: --days <n> (default ${DEFAULT_DAYS})`);
    const v = argv[++i];
    if (!/^\d{1,3}$/.test(v ?? "") || Number(v) < KEEPALIVE_MIN_DAYS) throw new Error(`--days needs a whole number of at least ${KEEPALIVE_MIN_DAYS}`);
    flags.days = Number(v);
  }
  return flags;
}

/**
 * What one extension of `key` to `extendTo` ledgers would cost in total, from a simulation of
 * the very transaction submit builds. null when the entry is archived: submit restores it first
 * and the extension's cost is only known after that.
 */
async function extensionFee(source, key, extendTo) {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .setSorobanData(new SorobanDataBuilder().setReadOnly([key]).build())
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulating the extension failed: ${String(sim.error).split("\n")[0]}`);
  if (rpc.Api.isSimulationRestore(sim)) return null;
  // The same sum assembleTransaction sets as the fee: base fee per operation plus the resource fee.
  return BigInt(BASE_FEE) + BigInt(sim.minResourceFee);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const record = loadDeployment({ required: true });
  const cli = stellarCli();
  const name = deployerName();
  const payer = cli.publicKeyOf(name);
  if (!payer) throw new Error(`no stellar CLI identity ${name} in packages/contracts/.stellar. Set DEPLOYER or run npm run deploy:testnet first`);
  if (!(await accountExists(payer))) throw new Error(`${name} ${payer} has no account on testnet. Fund it with friendbot first`);

  const entries = [];
  for (const [label, id] of [
    ["payroll", record.contracts.payroll?.id],
    ["auditor registry", record.contracts.auditorRegistry?.id],
    ["token", record.contracts.token?.id],
    ["verifier", record.contracts.verifier?.id],
  ]) {
    if (!id) throw new Error(`no ${label} id in ${path.basename(DEPLOYMENT_FILE)}`);
    const instance = await readInstance(id);
    if (!instance) throw new Error(`${label} ${id} has no instance on chain`);
    if (instance.executable !== "contractExecutableWasm") throw new Error(`${label} runs a ${instance.executable} executable`);
    entries.push({ label: `${label} instance`, id, key: instanceLedgerKey(id) });
    entries.push({ label: `${label} code`, id, key: codeLedgerKey(instance.wasmHash) });
  }

  const maxEntryTtl = await readMaxEntryTtl();
  // The host lets an entry live to the current ledger plus maxEntryTtl - 1, its max_live_until_ledger.
  const maxDays = Math.floor((maxEntryTtl - 1) / LEDGERS_PER_DAY);
  const targetDays = Math.min(flags.days, maxDays);
  const toLedgers = (days) => Math.min(days * LEDGERS_PER_DAY, maxEntryTtl - 1);
  const before = await readLiveUntil(entries.map((e) => e.key));

  console.log(`Kalypso keepalive on testnet, paid by ${name} ${payer}`);
  console.log(`target ${targetDays} days per entry${targetDays < flags.days ? ` (the network maximum; ${flags.days} asked)` : ""}, one entry per transaction`);
  console.log("");
  let spent = 0n;
  for (const [i, e] of entries.entries()) {
    const left = daysLeft(before.liveUntil[i], before.latestLedger);
    console.log(`${e.label} ${e.id}`);
    say(`before: ${daysText(left)}`);
    let days = targetDays;
    let skip = false;
    for (;;) {
      if (left !== null && left * LEDGERS_PER_DAY >= toLedgers(days)) {
        say(`extend: already done (${daysText(left)} left, more than the ${days}-day target)`);
        skip = true;
        break;
      }
      const fee = await extensionFee(payer, e.key, toLedgers(days));
      if (fee === null) {
        say(`archived, so it is restored first, then extended to ${days} days`);
        break;
      }
      if (fee <= MAX_TX_FEE_STROOPS) {
        say(`target ${days} days, simulated fee ${xlm(fee)}`);
        break;
      }
      if (days === KEEPALIVE_MIN_DAYS) {
        throw new Error(`${e.label}: even ${days} days would cost ${xlm(fee)}, above one transaction's fee limit of ${xlm(MAX_TX_FEE_STROOPS)}`);
      }
      const next = Math.max(Math.floor(days / 2), KEEPALIVE_MIN_DAYS);
      say(`${days} days would cost ${xlm(fee)}, above one transaction's fee limit of ${xlm(MAX_TX_FEE_STROOPS)}; trying ${next} days`);
      days = next;
    }
    if (skip) continue;
    const res = await submit({
      source: payer,
      operation: Operation.extendFootprintTtl({ extendTo: toLedgers(days) }),
      readOnly: [e.key],
      sign: (tx) => cli.sign(tx, name, payer),
      label: `extend ${e.label}`,
      log: say,
    });
    spent += BigInt(res.feeStroops);
    say(`extend: tx ${res.hash} ledger ${res.ledger} fee ${xlm(res.feeStroops)}`);
  }

  const after = await readLiveUntil(entries.map((e) => e.key));
  console.log("");
  console.log(`After (fees paid this run: ${xlm(spent)})`);
  const low = [];
  for (const [i, e] of entries.entries()) {
    const was = daysLeft(before.liveUntil[i], before.latestLedger);
    const now = daysLeft(after.liveUntil[i], after.latestLedger);
    say(`${e.label.padEnd(26)} ${daysText(was)} -> ${daysText(now)}`);
    if (now === null || now < KEEPALIVE_MIN_DAYS) low.push(e.label);
  }
  if (low.length) throw new Error(`still below ${KEEPALIVE_MIN_DAYS} days after extending: ${low.join(", ")}`);
  console.log("");
  console.log(`RESULT: PASS, every instance and its code has at least ${KEEPALIVE_MIN_DAYS} days to live`);
}

main().catch((e) => {
  console.error(`keepalive failed: ${e?.message ?? e}`);
  process.exit(1);
});

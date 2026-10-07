// Puts the whole Kalypso stack on Stellar testnet: our own verifier with its
// keys frozen, our auditor registry, the confidential USDC token and the
// payroll contract. Every step first asks the chain whether it is already
// done, so a second run changes nothing and a run that stopped halfway
// resumes where it stopped.
//
//   npm run deploy:testnet [-- --wasm-dir <dir>] [--sha256sums <file>] [--fresh]
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Address, Asset, Contract, Operation } from "@stellar/stellar-sdk";
import {
  DEPLOYMENT_FILE,
  MANAGER_ROLE,
  NETWORK_NAME,
  NETWORK_PASSPHRASE,
  OUR_PACKAGES,
  RPC_URL,
  SDK_PACKAGE,
  SDK_VERSION,
  TOKEN_WASM,
  USDC_ISSUER,
  USDC_SAC,
  VERIFICATION_KEYS,
  VERIFIER_WASM,
  VK_DIR,
  defaultWasmDir,
  explorer,
} from "./lib/network.mjs";
import { findBuiltWasm, loadPinnedWasm, parseSha256Sums, requireListedInSums, sha256hex } from "./lib/wasm.mjs";
import { deployerName, stellarCli } from "./lib/stellar-cli.mjs";
import {
  accountExists,
  addressOf,
  contractIdFor,
  normalizeAddress,
  readCode,
  readInstance,
  scv,
  server,
  settle,
  submit,
  xlm,
} from "./lib/chain.mjs";
import {
  payrollTokenKey,
  readVerificationKey,
  tokenWiring,
  verifierAccessByCalls,
  verifierAccessFromLedger,
} from "./lib/contract-state.mjs";
import { loadDeployment, readDeploymentText, saveDeployment, serializeDeployment } from "./lib/deployment-record.mjs";

const short = (h) => `${h.slice(0, 8)}...`;
const say = (text) => console.log(`  ${text}`);

function parseFlags(argv) {
  const flags = { wasmDir: null, sha256sums: null, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fresh") flags.fresh = true;
    else if (a === "--wasm-dir" || a === "--sha256sums") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      flags[a === "--wasm-dir" ? "wasmDir" : "sha256sums"] = path.resolve(v);
    } else {
      throw new Error(`unknown argument ${a}. Flags: --wasm-dir <dir>, --sha256sums <file>, --fresh`);
    }
  }
  return flags;
}

/** Every file and constant the deploy relies on, checked before any transaction. */
function loadInputs(flags) {
  const wasmDir = flags.wasmDir ?? defaultWasmDir();
  const ours = {
    auditorRegistry: findBuiltWasm(wasmDir, OUR_PACKAGES.auditorRegistry),
    payroll: findBuiltWasm(wasmDir, OUR_PACKAGES.payroll),
  };
  if (flags.sha256sums) {
    const sums = parseSha256Sums(flags.sha256sums);
    for (const w of Object.values(ours)) requireListedInSums(w, sums);
  }

  const sdkVersion = JSON.parse(readFileSync(path.join(VK_DIR, "..", "..", "package.json"), "utf8")).version;
  if (sdkVersion !== SDK_VERSION) throw new Error(`${SDK_PACKAGE} ${sdkVersion} is installed, expected ${SDK_VERSION}`);
  const keys = VERIFICATION_KEYS.map((k) => {
    const bytes = readFileSync(path.join(VK_DIR, `${k.name}.vk.bin`));
    const actual = sha256hex(bytes);
    if (actual !== k.sha256) throw new Error(`${k.name}.vk.bin has sha256 ${actual}, expected the pin ${k.sha256}`);
    return { ...k, bytes };
  });

  const derivedSac = new Asset("USDC", USDC_ISSUER).contractId(NETWORK_PASSPHRASE);
  if (derivedSac !== USDC_SAC) throw new Error(`USDC SAC ${USDC_SAC} does not derive from issuer ${USDC_ISSUER}`);

  return {
    wasmDir,
    ours,
    fixtures: { verifier: loadPinnedWasm(VERIFIER_WASM), token: loadPinnedWasm(TOKEN_WASM) },
    keys,
  };
}

function newRecord(deployer, keys) {
  return {
    network: NETWORK_NAME,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    deployer: { publicKey: deployer, explorer: explorer.account(deployer) },
    verificationKeys: Object.fromEntries(
      keys.map((k) => [
        k.name,
        {
          circuitType: k.circuitType,
          sha256: k.sha256,
          bytes: k.bytes.length,
          source: `${SDK_PACKAGE}@${SDK_VERSION} circuits/vks/${k.name}.vk.bin`,
        },
      ]),
    ),
    contracts: {},
    uploads: {},
  };
}

const txRecord = (r) => ({ hash: r.hash, ledger: r.ledger, feeStroops: r.feeStroops, explorer: explorer.tx(r.hash) });
const isRecorded = (tx) => typeof tx?.ledger === "number";
const txLine = (r) => `tx ${r.hash} ledger ${r.ledger} fee ${xlm(r.feeStroops)}`;

/** A transaction an earlier run sent but never recorded the outcome of. */
async function recoverPending(tx) {
  if (!tx?.hash || isRecorded(tx)) return null;
  const landed = await settle(tx.hash, tx.pendingUntil ?? 0);
  return landed?.ok ? { hash: tx.hash, ...landed } : null;
}

function requireWasmExecutable(name, instance, expectedHash) {
  if (instance.executable !== "contractExecutableWasm") {
    throw new Error(`${name} runs a ${instance.executable} executable, not plain wasm`);
  }
  if (instance.wasmHash !== expectedHash) {
    throw new Error(`${name} runs wasm ${instance.wasmHash}, expected ${expectedHash}`);
  }
}

async function ensureFunded(publicKey) {
  if (await accountExists(publicKey)) return false;
  await server.fundAddress(publicKey);
  if (!(await accountExists(publicKey))) throw new Error(`friendbot did not create ${publicKey}`);
  return true;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const inputs = loadInputs(flags);
  const cli = stellarCli();
  const identityName = deployerName();
  const startText = readDeploymentText();

  console.log(`stellar CLI: ${cli.version()}`);
  console.log(`wasm dir: ${inputs.wasmDir}`);
  for (const w of Object.values(inputs.ours)) console.log(`  ${w.label} sha256 ${w.hash}`);
  if (flags.sha256sums) console.log(`  both match ${flags.sha256sums}`);

  const identity = cli.ensureIdentity(identityName);
  const deployer = identity.publicKey;
  const funded = await ensureFunded(deployer);
  console.log(`deployer: ${identityName} ${deployer}${identity.created ? ", identity created" : ""}${funded ? ", funded by friendbot" : ""}`);

  let record = flags.fresh ? null : loadDeployment();
  if (record && record.deployer?.publicKey !== deployer) {
    throw new Error(
      `${path.basename(DEPLOYMENT_FILE)} was deployed by ${record.deployer?.publicKey}, but DEPLOYER is ${deployer}. ` +
        "Use the same identity or run with --fresh",
    );
  }
  record ??= newRecord(deployer, inputs.keys);
  const save = () => saveDeployment(record);
  save();

  const sign = (tx) => cli.sign(tx, identityName, deployer);
  const send = (label, operation, onPending) =>
    submit({ source: deployer, operation, sign, label, onPending, log: say });

  async function ensureCode(wasm) {
    const step = `upload ${wasm.label}`;
    const code = await readCode(wasm.hash);
    if (code?.live) {
      say(`${step}: already done (code ${short(wasm.hash)} is live on chain)`);
      return;
    }
    const res = await send(step, Operation.uploadContractWasm({ wasm: wasm.bytes }), (p) => {
      record.uploads[wasm.hash] = { file: wasm.label, tx: p };
      save();
    });
    const returned = res.returnValue?.switch().name === "scvBytes" ? res.returnValue.bytes().toString("hex") : null;
    if (returned !== wasm.hash) throw new Error(`${step}: chain returned hash ${returned}, expected ${wasm.hash}`);
    record.uploads[wasm.hash] = { file: wasm.label, tx: txRecord(res) };
    save();
    say(`${step}: ${txLine(res)}`);
  }

  /**
   * Deploys `wasm` under a salt recorded before the transaction is sent. The
   * contract id follows from the deployer and the salt, so a resumed run can
   * find a contract its predecessor created, and can never create a second.
   */
  async function deployContract(name, { wasm, ctorArgs, constructorRecord, confirm }) {
    const prior = record.contracts[name];
    if (isRecorded(prior?.deployTx)) {
      const instance = await readInstance(prior.id);
      if (!instance) {
        throw new Error(`${name} ${prior.id} is recorded but has no instance on chain (testnet reset or archived). Run with --fresh`);
      }
      requireWasmExecutable(name, instance, prior.wasmHash);
      if (prior.wasmHash !== wasm.hash) {
        throw new Error(`${name} was deployed from ${short(prior.wasmHash)} but ${wasm.label} is now ${short(wasm.hash)}. Run with --fresh`);
      }
      confirm?.(instance);
      say(`upload ${wasm.label}: already done`);
      say(`deploy: already done (${prior.id})`);
      return prior.id;
    }

    await ensureCode(wasm);
    const salt = prior?.salt ?? randomBytes(32).toString("hex");
    const id = contractIdFor(deployer, salt);
    record.contracts[name] = {
      id,
      explorer: explorer.contract(id),
      wasmHash: wasm.hash,
      wasmSource: wasm.label,
      salt,
      constructor: constructorRecord,
      deployTx: prior?.deployTx ?? null,
    };
    save();

    let tx = await recoverPending(record.contracts[name].deployTx);
    let instance = await readInstance(id);
    if (!instance) {
      tx = await send(
        `${name} deploy`,
        Operation.createCustomContract({
          address: new Address(deployer),
          wasmHash: Buffer.from(wasm.hash, "hex"),
          salt: Buffer.from(salt, "hex"),
          constructorArgs: ctorArgs,
        }),
        (p) => {
          record.contracts[name].deployTx = p;
          save();
        },
      );
      const returned = tx.returnValue ? addressOf(tx.returnValue) : null;
      if (returned !== id) throw new Error(`${name} deploy returned ${returned}, expected ${id}`);
      instance = await readInstance(id);
      if (!instance) throw new Error(`${name} deploy succeeded but ${id} has no instance on chain`);
    } else if (!tx) {
      throw new Error(`${name} ${id} exists on chain but the transaction that created it is unknown. Run with --fresh`);
    }
    requireWasmExecutable(name, instance, wasm.hash);
    confirm?.(instance);
    record.contracts[name].deployTx = txRecord(tx);
    save();
    say(`deploy: ${id}, ${txLine(tx)}`);
    return id;
  }

  /**
   * One contract call whose effect `isDone` reads back from the chain. The
   * chain decides whether it runs; the record only keeps the evidence.
   */
  async function callStep({ label, contractId, method, args, isDone, getTx, setTx }) {
    if (await isDone()) {
      if (isRecorded(getTx())) {
        say(`${label}: already done`);
        return;
      }
      const recovered = await recoverPending(getTx());
      if (!recovered) throw new Error(`${label}: done on chain but its transaction is unknown. Run with --fresh`);
      setTx(txRecord(recovered));
      save();
      say(`${label}: ${txLine(recovered)}`);
      return;
    }
    const recovered = await recoverPending(getTx());
    if (recovered && (await isDone())) {
      setTx(txRecord(recovered));
      save();
      say(`${label}: ${txLine(recovered)}`);
      return;
    }
    const res = await send(label, new Contract(contractId).call(method, ...args), (p) => {
      setTx(p);
      save();
    });
    if (!(await isDone())) throw new Error(`${label}: ${res.hash} succeeded but the chain does not show the change`);
    setTx(txRecord(res));
    save();
    say(`${label}: ${txLine(res)}`);
  }

  console.log("[1/5] verifier");
  const verifierId = await deployContract("verifier", {
    wasm: inputs.fixtures.verifier,
    ctorArgs: [scv.addr(deployer), scv.addr(deployer)],
    constructorRecord: { admin: deployer, manager: deployer },
  });
  const verifier = record.contracts.verifier;
  verifier.keyRegistrations ??= {};
  for (const key of inputs.keys) {
    const holds = async () => {
      const onChain = await readVerificationKey(deployer, verifierId, key.circuitType);
      if (onChain && !onChain.equals(key.bytes)) {
        throw new Error(`verifier holds different bytes for circuit ${key.circuitType} (sha256 ${sha256hex(onChain)}). Run with --fresh`);
      }
      return onChain !== null;
    };
    await callStep({
      label: `key ${key.circuitType} (${key.name}) registered and read back byte for byte`,
      contractId: verifierId,
      method: "register_verification_key",
      args: [scv.u32(key.circuitType), scv.bytes(key.bytes), scv.addr(deployer)],
      isDone: holds,
      getTx: () => verifier.keyRegistrations[key.name],
      setTx: (t) => (verifier.keyRegistrations[key.name] = t),
    });
  }

  verifier.lockdown ??= {};
  const lockdown = verifier.lockdown;
  const access = async () => {
    const instance = await readInstance(verifierId);
    return {
      calls: await verifierAccessByCalls(deployer, verifierId, deployer),
      ledger: await verifierAccessFromLedger(verifierId, deployer, instance),
    };
  };
  const now = await access();
  if (now.calls.getAdmin !== null || now.calls.hasRoleDeployerManager !== null) {
    // Recorded while the powers still exist: proof that the storage keys the
    // check reads do find live admin and manager entries, so their absence
    // afterwards means something.
    lockdown.before = now;
    save();
  }
  if (now.calls.getAdmin !== null && now.calls.getAdmin !== deployer) {
    throw new Error(`verifier admin is ${now.calls.getAdmin}, not the deployer. Refusing to continue`);
  }
  const othersHoldManager = now.calls.managerMemberCount - (now.calls.hasRoleDeployerManager === null ? 0 : 1);
  if (othersHoldManager > 0) throw new Error(`${othersHoldManager} other account(s) hold the manager role. Refusing to continue`);

  await callStep({
    label: `renounce_role("${MANAGER_ROLE}", deployer)`,
    contractId: verifierId,
    method: "renounce_role",
    args: [scv.sym(MANAGER_ROLE), scv.addr(deployer)],
    isDone: async () => (await verifierAccessByCalls(deployer, verifierId, deployer)).hasRoleDeployerManager === null,
    getTx: () => lockdown.renounceManagerTx,
    setTx: (t) => (lockdown.renounceManagerTx = t),
  });
  await callStep({
    label: "renounce_admin()",
    contractId: verifierId,
    method: "renounce_admin",
    args: [],
    isDone: async () => (await verifierAccessByCalls(deployer, verifierId, deployer)).getAdmin === null,
    getTx: () => lockdown.renounceAdminTx,
    setTx: (t) => (lockdown.renounceAdminTx = t),
  });

  const after = await access();
  const locked =
    after.calls.getAdmin === null &&
    after.calls.hasRoleDeployerManager === null &&
    after.calls.managerMemberCount === 0 &&
    after.ledger.instanceAdminEntry === null &&
    after.ledger.otherInstanceKeys.length === 0 &&
    after.ledger.pendingAdminEntry === null &&
    after.ledger.managerCountEntry === 0 &&
    after.ledger.deployerHasRoleEntry === null &&
    after.ledger.managerMember0Entry === null &&
    after.ledger.existingRolesEntry?.length === 0;
  if (!locked) throw new Error(`verifier is not fully locked: ${JSON.stringify(after)}`);
  const lockedBefore = JSON.stringify(lockdown.after) === JSON.stringify(after);
  lockdown.after = after;
  save();
  say(`lockdown read back two ways: ${lockedBefore ? "already done" : "done"} (no admin, no manager, keys can no longer be registered or replaced)`);

  console.log("[2/5] auditor registry");
  const auditorId = await deployContract("auditorRegistry", {
    wasm: inputs.ours.auditorRegistry,
    ctorArgs: [],
    constructorRecord: null,
  });

  console.log("[3/5] confidential USDC token");
  const sac = await readInstance(USDC_SAC);
  if (sac?.executable !== "contractExecutableStellarAsset") {
    throw new Error(`USDC SAC ${USDC_SAC} is not a deployed Stellar asset contract`);
  }
  const wantWiring = { underlyingAsset: USDC_SAC, verifier: verifierId, auditor: auditorId };
  const tokenId = await deployContract("token", {
    wasm: inputs.fixtures.token,
    ctorArgs: [scv.addr(USDC_SAC), scv.addr(verifierId), scv.addr(auditorId)],
    constructorRecord: wantWiring,
    confirm: (instance) => {
      const got = tokenWiring(instance);
      for (const [k, v] of Object.entries(wantWiring)) {
        if (got[k] !== normalizeAddress(v)) throw new Error(`token ${k} is ${got[k]}, expected ${v}`);
      }
    },
  });

  console.log("[4/5] payroll");
  const payrollId = await deployContract("payroll", {
    wasm: inputs.ours.payroll,
    ctorArgs: [scv.addr(tokenId)],
    constructorRecord: { token: tokenId },
    confirm: (instance) => {
      const v = instance.storageGet(payrollTokenKey);
      const got = v ? addressOf(v) : null;
      if (got !== normalizeAddress(tokenId)) throw new Error(`payroll token is ${got}, expected ${tokenId}`);
    },
  });

  console.log("[5/5] deployments/testnet.json");
  const finalText = saveDeployment(record);
  if (finalText !== serializeDeployment(loadDeployment())) throw new Error("deployment file did not save");
  say(finalText === startText ? "already done (unchanged)" : "written");

  console.log("");
  console.log(`verifier          ${verifierId}`);
  console.log(`auditor registry  ${auditorId}`);
  console.log(`token             ${tokenId}`);
  console.log(`payroll           ${payrollId}`);
}

main().catch((e) => {
  console.error(`deploy failed: ${e?.message ?? e}`);
  process.exit(1);
});

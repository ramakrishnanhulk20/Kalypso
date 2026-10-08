// Proves from on-chain state that nobody, the deployer included, holds an
// admin key over the Kalypso stack or can change the proof rules, that the
// payroll and the token read auditor ids from one registry, and that no
// contract is close to archiving. Only the contract ids come from
// deployments/testnet.json; every claim is read from the chain's ledger
// entries, never from events, and compared with a pin in lib/network.mjs or
// with our own build. Any error while checking counts as a FAIL, never as a skip.
//
// Our two contracts ship from their own releases: --wasm-dir holds the payroll's
// release and --auditor-wasm-dir the registry's (default: the same folder).
//
//   npm run check:testnet [-- --wasm-dir <dir>] [--auditor-wasm-dir <dir>]
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  KEEPALIVE_MIN_DAYS,
  LEDGERS_PER_DAY,
  MANAGER_ROLE,
  OUR_PACKAGES,
  TOKEN_WASM,
  UNAUTHORIZED_ERROR,
  USDC_SAC,
  VERIFICATION_KEYS,
  VERIFIER_WASM,
  VK_DIR,
  defaultWasmDir,
} from "./lib/network.mjs";
import { findBuiltWasm, inspectWasm, privilegeFindings, sha256hex } from "./lib/wasm.mjs";
import {
  addressOf,
  codeLedgerKey,
  instanceLedgerKey,
  normalizeAddress,
  readCode,
  readInstance,
  readLiveUntil,
  scv,
  simulateCall,
} from "./lib/chain.mjs";
import {
  addressesInInstance,
  readVerificationKey,
  tokenWiring,
  verificationKeysInInstance,
  verifierAccessByCalls,
  verifierAccessFromLedger,
} from "./lib/contract-state.mjs";
import { loadDeployment } from "./lib/deployment-record.mjs";

// The registry's whole public surface, from auditor/src/contract.rs.
const AUDITOR_INTERFACE = [
  "accept_owner",
  "cancel_owner_proposal",
  "get_key",
  "key_count",
  "owner_of",
  "pending_owner",
  "propose_owner",
  "register_key",
  "rotate_key",
];

// Covers any export whose name speaks of the token's verifier, its auditor registry, its underlying
// asset or an upgrade, which takes in set_verifier, set_auditor, set_underlying_asset and upgrade
// under any spelling. Does not cover an innocently named function that rewrites the wiring inside;
// the pinned code hash, checked above, and OpenZeppelin's source cover that.
const REWIRES_TOKEN = /verifier|auditor|underlying|upgrade/i;

const short = (h) => `${h.slice(0, 8)}...`;
const results = [];

async function check(title, run) {
  let outcome;
  try {
    outcome = await run();
  } catch (e) {
    outcome = { pass: false, detail: e?.message ?? String(e) };
  }
  results.push(outcome.pass);
  console.log(`${outcome.pass ? "PASS" : "FAIL"}  ${title}${outcome.detail ? ` (${outcome.detail})` : ""}`);
}

function parseFlags(argv) {
  const flags = { wasmDir: null, auditorWasmDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== "--wasm-dir" && a !== "--auditor-wasm-dir") {
      throw new Error(`unknown argument ${a}. Flags: --wasm-dir <payroll release dir>, --auditor-wasm-dir <registry release dir>`);
    }
    const v = argv[++i];
    if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
    flags[a === "--wasm-dir" ? "wasmDir" : "auditorWasmDir"] = path.resolve(v);
  }
  return flags;
}

/**
 * One of our contracts against its own release: the chain, the deployment record and the built
 * wasm from that release's folder must all name the same code. The record's version is shown,
 * not proven: the wasm carries none, so the folder is what ties the hash to a release.
 */
function sameRelease(name, instance, entry, build, dir) {
  if (!build) return { pass: false, detail: `no built wasm for ${name} in ${dir}` };
  const problems = [];
  if (instance.wasmHash !== build.hash) problems.push(`on chain ${instance.wasmHash}, ${build.label} in ${dir} is ${build.hash}`);
  if (entry?.wasmHash !== instance.wasmHash) problems.push(`deployments/testnet.json records ${entry?.wasmHash ?? "no hash"}`);
  const version = entry?.version ? `v${entry.version}` : "no version recorded";
  if (problems.length) return { pass: false, detail: `${problems.join("; ")} (${version})` };
  return { pass: true, detail: `wasm ${short(build.hash)}, ${version} per deployments/testnet.json, same as ${build.label} in ${dir}` };
}

async function instanceOf(name, id) {
  if (!id) throw new Error(`no ${name} id in deployments/testnet.json`);
  const instance = await readInstance(id);
  if (!instance) throw new Error(`${name} ${id} has no instance on chain`);
  if (instance.executable !== "contractExecutableWasm") throw new Error(`${name} runs a ${instance.executable} executable`);
  return instance;
}

function sameCode(instance, expectedHash) {
  return instance.wasmHash === expectedHash
    ? { pass: true, detail: `wasm ${short(expectedHash)}` }
    : { pass: false, detail: `on chain ${instance.wasmHash}, expected ${expectedHash}` };
}

/** The code a contract runs: the on-chain bytes, or our identical local build if the code entry is archived. */
async function codeBytes(instance, localBuild) {
  const code = await readCode(instance.wasmHash);
  if (code) {
    if (sha256hex(code.bytes) !== instance.wasmHash) throw new Error("on-chain code does not hash to its own key");
    return { bytes: code.bytes, from: "on-chain code" };
  }
  if (localBuild && localBuild.hash === instance.wasmHash) return { bytes: localBuild.bytes, from: "local build, same hash" };
  throw new Error(`code ${short(instance.wasmHash)} is not readable on chain`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const record = loadDeployment({ required: true });
  const deployer = record.deployer?.publicKey;
  const ids = Object.fromEntries(Object.entries(record.contracts ?? {}).map(([k, v]) => [k, v.id]));
  const wasmDir = flags.wasmDir ?? defaultWasmDir();
  const auditorWasmDir = flags.auditorWasmDir ?? wasmDir;
  const built = (dir, pkg) => {
    try {
      return findBuiltWasm(dir, pkg);
    } catch {
      return null;
    }
  };
  const builtAuditor = built(auditorWasmDir, OUR_PACKAGES.auditorRegistry);
  const builtPayroll = built(wasmDir, OUR_PACKAGES.payroll);

  console.log(`Kalypso testnet check, deployer ${deployer}`);
  console.log(`verifier ${ids.verifier}  auditor registry ${ids.auditorRegistry}  token ${ids.token}  payroll ${ids.payroll}`);
  console.log("");

  console.log("Verifier keys");
  await check(`verifier runs the pinned OpenZeppelin verifier`, async () =>
    sameCode(await instanceOf("verifier", ids.verifier), VERIFIER_WASM.hash),
  );
  for (const k of VERIFICATION_KEYS) {
    await check(`key ${k.circuitType} (${k.name}) hashes to the pin ${short(k.sha256)}`, async () => {
      const served = await readVerificationKey(deployer, ids.verifier, k.circuitType);
      const stored = verificationKeysInInstance(await instanceOf("verifier", ids.verifier)).get(k.circuitType);
      if (!served || !stored) return { pass: false, detail: "key missing" };
      const a = sha256hex(served);
      const b = sha256hex(stored);
      if (a !== k.sha256 || b !== k.sha256) return { pass: false, detail: `get_verification_key ${a}, instance storage ${b}` };
      return { pass: true, detail: "same through get_verification_key and in instance storage" };
    });
  }

  console.log("Verifier has no admin and no manager");
  await check(`get_admin returns None and has_role(deployer, "${MANAGER_ROLE}") returns None`, async () => {
    const a = await verifierAccessByCalls(deployer, ids.verifier, deployer);
    const pass = a.getAdmin === null && a.hasRoleDeployerManager === null && a.managerMemberCount === 0;
    return {
      pass,
      detail: `get_admin ${a.getAdmin ?? "None"}, has_role ${a.hasRoleDeployerManager ?? "None"}, ` +
        `get_role_member_count("${MANAGER_ROLE}") ${a.managerMemberCount}`,
    };
  });
  await check("getLedgerEntries: instance storage holds no admin entry, only the three keys", async () => {
    const l = await verifierAccessFromLedger(ids.verifier, deployer, await instanceOf("verifier", ids.verifier));
    const pass = l.instanceAdminEntry === null && l.otherInstanceKeys.length === 0 && l.pendingAdminEntry === null;
    return {
      pass,
      detail: `Admin ${l.instanceAdminEntry ?? "absent"}, other keys ${l.otherInstanceKeys.length ? l.otherInstanceKeys.join(", ") : "none"}, ` +
        `PendingAdmin ${l.pendingAdminEntry ?? "absent"}`,
    };
  });
  await check(`getLedgerEntries: role storage holds no "${MANAGER_ROLE}" member and no role at all`, async () => {
    const l = await verifierAccessFromLedger(ids.verifier, deployer, await instanceOf("verifier", ids.verifier));
    const pass =
      l.managerCountEntry === 0 &&
      l.deployerHasRoleEntry === null &&
      l.managerMember0Entry === null &&
      l.existingRolesEntry?.length === 0;
    return {
      pass,
      detail: `RoleAccountsCount(${MANAGER_ROLE}) ${l.managerCountEntry ?? "absent"}, ` +
        `RoleAccounts(${MANAGER_ROLE}, 0) ${l.managerMember0Entry ?? "absent"}, ` +
        `HasRole(deployer, ${MANAGER_ROLE}) ${l.deployerHasRoleEntry ?? "absent"}, ` +
        `ExistingRoles ${l.existingRolesEntry ? `[${l.existingRolesEntry.join(", ")}]` : "absent"}`,
    };
  });

  console.log("Nobody can change the proof rules");
  const transferKey = readFileSync(path.join(VK_DIR, "transfer.vk.bin"));
  const attempts = [
    // Circuit 3 has no key, so the role gate is the only thing that can refuse it.
    { method: "register_verification_key", circuit: 3 },
    // The live transfer key's own bytes, so even a wrongful success would change nothing.
    { method: "update_verification_key", circuit: 2 },
  ];
  for (const { method, circuit } of attempts) {
    await check(`simulated ${method}(${circuit}) by the deployer fails with Error(Contract, #${UNAUTHORIZED_ERROR})`, async () => {
      const r = await simulateCall({
        source: deployer,
        contractId: ids.verifier,
        method,
        args: [scv.u32(circuit), scv.bytes(transferKey), scv.addr(deployer)],
      });
      if (r.ok) return { pass: false, detail: "the simulation succeeded" };
      return { pass: r.code === UNAUTHORIZED_ERROR, detail: r.error };
    });
  }

  console.log("Auditor registry");
  await check("auditor registry runs its own release of kalypso_auditor.wasm", async () =>
    sameRelease("the auditor registry", await instanceOf("auditor registry", ids.auditorRegistry), record.contracts.auditorRegistry, builtAuditor, auditorWasmDir),
  );
  await check("auditor registry exports exactly its nine interface functions, none an admin, contract owner, upgrade or setter", async () => {
    const instance = await instanceOf("auditor registry", ids.auditorRegistry);
    const { bytes, from } = await codeBytes(instance, builtAuditor);
    const inspected = inspectWasm(bytes);
    const exported = inspected.exportedFunctions;
    const missing = AUDITOR_INTERFACE.filter((f) => !exported.includes(f));
    const extra = exported.filter((f) => !AUDITOR_INTERFACE.includes(f));
    const findings = [
      ...missing.map((f) => `missing ${f}`),
      ...extra.map((f) => `extra ${f}`),
      ...privilegeFindings(inspected, "auditor_id"),
    ];
    if (findings.length) return { pass: false, detail: findings.join("; ") };
    return { pass: true, detail: `${exported.length} exports read from ${from}; owner functions act on one auditor_id; code cannot replace itself` };
  });

  console.log("Payroll");
  await check("payroll runs its own release of kalypso_payroll.wasm", async () =>
    sameRelease("the payroll", await instanceOf("payroll", ids.payroll), record.contracts.payroll, builtPayroll, wasmDir),
  );
  await check("payroll has no admin or upgrade function", async () => {
    const instance = await instanceOf("payroll", ids.payroll);
    const { bytes, from } = await codeBytes(instance, builtPayroll);
    const inspected = inspectWasm(bytes);
    const findings = privilegeFindings(inspected, "company_id");
    const stored = addressesInInstance(instance);
    const allowed = [ids.token, ids.auditorRegistry].map(normalizeAddress);
    const strangers = stored.filter((a) => !allowed.includes(a));
    if (strangers.length) findings.push(`instance stores addresses other than the token and the registry: ${strangers.join(", ")}`);
    for (const [what, a] of [["token", allowed[0]], ["auditor registry", allowed[1]]]) {
      if (!stored.includes(a)) findings.push(`instance stores no ${what} address`);
    }
    if (findings.length) return { pass: false, detail: findings.join("; ") };
    const scoped = inspected.exportedFunctions.filter((f) => /admin/i.test(f));
    return {
      pass: true,
      detail: `${inspected.exportedFunctions.length} exports read from ${from}; ${scoped.join(", ")} act on one company_id; ` +
        "code cannot replace itself; the only addresses in its instance are the token and the auditor registry",
    };
  });
  await check("payroll asks the same auditor registry the token reads keys from", async () => {
    const r = await simulateCall({ source: deployer, contractId: ids.payroll, method: "auditor_registry", args: [] });
    if (!r.ok) return { pass: false, detail: `auditor_registry() failed: ${r.error}` };
    const asked = addressOf(r.retval);
    // The token's own instance entries (OpenZeppelin ConfidentialTokenStorageKey::Auditor and
    // ::Verifier), read from the ledger, so the answer never ages out the way an event does.
    const wired = tokenWiring(await instanceOf("token", ids.token));
    const registry = normalizeAddress(ids.auditorRegistry);
    const verifier = normalizeAddress(ids.verifier);
    return {
      pass: asked === registry && wired.auditor === registry && wired.verifier === verifier,
      detail: `auditor_registry() ${asked}, token instance Auditor ${wired.auditor}, deployments/testnet.json ${registry}; ` +
        `token instance Verifier ${wired.verifier}, deployments/testnet.json ${verifier}`,
    };
  });

  console.log("Confidential USDC token");
  await check("token runs the pinned OpenZeppelin token", async () =>
    sameCode(await instanceOf("token", ids.token), TOKEN_WASM.hash),
  );
  await check("token instance storage points at our verifier, our auditor registry and the USDC SAC", async () => {
    const got = tokenWiring(await instanceOf("token", ids.token));
    const want = { underlyingAsset: USDC_SAC, verifier: ids.verifier, auditor: ids.auditorRegistry };
    const wrong = Object.entries(want).filter(([k, v]) => !v || got[k] !== normalizeAddress(v));
    if (wrong.length) return { pass: false, detail: wrong.map(([k, v]) => `${k} is ${got[k]}, expected ${v}`).join("; ") };
    return { pass: true, detail: "UnderlyingAsset, Verifier and Auditor entries all match" };
  });
  await check("token code on chain has no setter for its verifier, registry or asset, and cannot replace itself", async () => {
    const instance = await instanceOf("token", ids.token);
    // On-chain bytes only: this claim is about the code that runs, not about the pin it should equal.
    const { bytes } = await codeBytes(instance, null);
    const inspected = inspectWasm(bytes);
    const exported = inspected.exportedFunctions;
    const findings = exported.filter((f) => REWIRES_TOKEN.test(f)).map((f) => `exports ${f}`);
    if (inspected.canReplaceOwnCode) findings.push("imports update_current_contract_wasm");
    return {
      pass: findings.length === 0,
      detail: `${findings.length ? `${findings.join("; ")}; ` : ""}${exported.length} exports read from on-chain code: ${exported.join(", ")}`,
    };
  });

  console.log("Kept alive");
  await check(`every instance and its code has at least ${KEEPALIVE_MIN_DAYS} days to live`, async () => {
    const entries = [];
    for (const [name, id] of [
      ["payroll", ids.payroll],
      ["auditor registry", ids.auditorRegistry],
      ["token", ids.token],
      ["verifier", ids.verifier],
    ]) {
      const instance = await instanceOf(name, id);
      entries.push({ label: `${name} instance`, key: instanceLedgerKey(id) });
      entries.push({ label: `${name} code`, key: codeLedgerKey(instance.wasmHash) });
    }
    const { latestLedger, liveUntil } = await readLiveUntil(entries.map((e) => e.key));
    const days = liveUntil.map((until) => (until === null ? null : (until - latestLedger) / LEDGERS_PER_DAY));
    const low = entries.filter((_, i) => days[i] === null || days[i] < KEEPALIVE_MIN_DAYS).map((e) => e.label);
    return {
      pass: low.length === 0,
      detail: `${entries.map((e, i) => `${e.label} ${days[i] === null ? "missing" : `${days[i].toFixed(1)} days`}`).join(", ")}` +
        `${low.length ? `; below ${KEEPALIVE_MIN_DAYS} days: ${low.join(", ")}, run npm run keepalive:testnet` : ""}`,
    };
  });

  const passed = results.filter(Boolean).length;
  console.log("");
  console.log(`${passed} of ${results.length} checks passed. RESULT: ${passed === results.length ? "PASS" : "FAIL"}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(`check could not run: ${e?.message ?? e}`);
  process.exit(1);
});

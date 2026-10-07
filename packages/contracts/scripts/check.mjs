// Proves from on-chain state that nobody, the deployer included, holds an
// admin key over the Kalypso stack or can change the proof rules. Only the
// contract ids come from deployments/testnet.json; every claim is read from
// the chain and compared with a pin in lib/network.mjs or with our own build.
// Any error while checking counts as a FAIL, never as a skip.
//
//   npm run check:testnet [-- --wasm-dir <dir>]
import { readFileSync } from "node:fs";
import path from "node:path";
import {
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
import { normalizeAddress, readCode, readInstance, scv, simulateCall } from "./lib/chain.mjs";
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
  const flags = { wasmDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--wasm-dir") throw new Error(`unknown argument ${argv[i]}. Flags: --wasm-dir <dir>`);
    const v = argv[++i];
    if (!v || v.startsWith("--")) throw new Error("--wasm-dir needs a value");
    flags.wasmDir = path.resolve(v);
  }
  return flags;
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
  const built = (pkg) => {
    try {
      return findBuiltWasm(wasmDir, pkg);
    } catch {
      return null;
    }
  };
  const builtAuditor = built(OUR_PACKAGES.auditorRegistry);
  const builtPayroll = built(OUR_PACKAGES.payroll);

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
  await check("auditor registry runs our built kalypso_auditor.wasm", async () => {
    if (!builtAuditor) return { pass: false, detail: `no built kalypso_auditor.wasm in ${wasmDir}` };
    return sameCode(await instanceOf("auditor registry", ids.auditorRegistry), builtAuditor.hash);
  });
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
  await check("payroll runs our built kalypso_payroll.wasm", async () => {
    if (!builtPayroll) return { pass: false, detail: `no built kalypso_payroll.wasm in ${wasmDir}` };
    return sameCode(await instanceOf("payroll", ids.payroll), builtPayroll.hash);
  });
  await check("payroll has no admin or upgrade function", async () => {
    const instance = await instanceOf("payroll", ids.payroll);
    const { bytes, from } = await codeBytes(instance, builtPayroll);
    const inspected = inspectWasm(bytes);
    const findings = privilegeFindings(inspected, "company_id");
    const stored = addressesInInstance(instance);
    const strangers = stored.filter((a) => a !== normalizeAddress(ids.token));
    if (strangers.length) findings.push(`instance stores addresses other than the token: ${strangers.join(", ")}`);
    if (!stored.length) findings.push("instance stores no token address");
    if (findings.length) return { pass: false, detail: findings.join("; ") };
    const scoped = inspected.exportedFunctions.filter((f) => /admin/i.test(f));
    return {
      pass: true,
      detail: `${inspected.exportedFunctions.length} exports read from ${from}; ${scoped.join(", ")} act on one company_id; ` +
        "code cannot replace itself; the only address in its instance is the token",
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

  const passed = results.filter(Boolean).length;
  console.log("");
  console.log(`${passed} of ${results.length} checks passed. RESULT: ${passed === results.length ? "PASS" : "FAIL"}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(`check could not run: ${e?.message ?? e}`);
  process.exit(1);
});

// Readers shared by deploy and check. Storage keys are rebuilt here exactly as
// OpenZeppelin's #[contracttype] enums encode them (stellar-contracts 98090b3:
// access/src/access_control/storage.rs, tokens/src/confidential/storage.rs and
// verifier/storage.rs), so a direct ledger read sees what the contract sees.
import {
  KEY_NOT_REGISTERED_ERROR,
  MANAGER_ROLE,
  VERIFICATION_KEYS,
} from "./network.mjs";
import { addressOf, describeScVal, isVoid, readContractData, scv, simulateCall } from "./chain.mjs";

/** The key the verifier serves for `circuitType`, or null if it has none. */
export async function readVerificationKey(source, verifierId, circuitType) {
  const r = await simulateCall({ source, contractId: verifierId, method: "get_verification_key", args: [scv.u32(circuitType)] });
  if (r.ok) return Buffer.from(r.retval.bytes());
  if (r.code === KEY_NOT_REGISTERED_ERROR) return null;
  throw new Error(`get_verification_key(${circuitType}) failed: ${r.error}`);
}

/** Who holds power over the verifier, asked through its own functions. */
export async function verifierAccessByCalls(source, verifierId, deployer) {
  const call = async (method, args) => {
    const r = await simulateCall({ source, contractId: verifierId, method, args });
    if (!r.ok) throw new Error(`${method} failed: ${r.error}`);
    return r.retval;
  };
  const admin = await call("get_admin", []);
  const deployerRole = await call("has_role", [scv.addr(deployer), scv.sym(MANAGER_ROLE)]);
  const managerCount = await call("get_role_member_count", [scv.sym(MANAGER_ROLE)]);
  return {
    getAdmin: isVoid(admin) ? null : addressOf(admin) ?? describeScVal(admin),
    hasRoleDeployerManager: isVoid(deployerRole) ? null : describeScVal(deployerRole),
    managerMemberCount: managerCount.u32(),
  };
}

const verificationKeyKey = (circuitType) => scv.variant("VerificationKey", scv.u32(circuitType));
const ADMIN_KEY = scv.variant("Admin");

/**
 * Who holds power over the verifier, read straight from its ledger entries:
 * the admin lives in instance storage, a pending admin handover in temporary
 * storage, and role membership in persistent storage.
 */
export async function verifierAccessFromLedger(verifierId, deployer, instance) {
  const otherInstanceKeys = [];
  for (const { key } of instance.storage.values()) {
    const isVerificationKey = VERIFICATION_KEYS.some(
      (k) => key.toXDR("base64") === verificationKeyKey(k.circuitType).toXDR("base64"),
    );
    if (!isVerificationKey) otherInstanceKeys.push(describeScVal(key));
  }
  const adminEntry = instance.storageGet(ADMIN_KEY);

  const [pendingAdmin, roleCount, deployerHasRole, member0, existingRoles] = await readContractData(verifierId, [
    { key: scv.variant("PendingAdmin"), durability: "temporary" },
    { key: scv.variant("RoleAccountsCount", scv.sym(MANAGER_ROLE)), durability: "persistent" },
    { key: scv.variant("HasRole", scv.addr(deployer), scv.sym(MANAGER_ROLE)), durability: "persistent" },
    {
      key: scv.variant("RoleAccounts", scv.struct({ role: scv.sym(MANAGER_ROLE), index: scv.u32(0) })),
      durability: "persistent",
    },
    { key: scv.variant("ExistingRoles"), durability: "persistent" },
  ]);

  return {
    instanceAdminEntry: adminEntry ? addressOf(adminEntry) ?? describeScVal(adminEntry) : null,
    otherInstanceKeys,
    pendingAdminEntry: pendingAdmin ? describeScVal(pendingAdmin) : null,
    // null means the ledger has no count entry at all, which is not the same as 0.
    managerCountEntry: roleCount ? roleCount.u32() : null,
    deployerHasRoleEntry: deployerHasRole ? describeScVal(deployerHasRole) : null,
    managerMember0Entry: member0 ? addressOf(member0) ?? describeScVal(member0) : null,
    existingRolesEntry: existingRoles ? (existingRoles.vec() ?? []).map(describeScVal) : null,
  };
}

/** The bytes of each verification key as stored in the verifier's instance. */
export function verificationKeysInInstance(instance) {
  return new Map(
    VERIFICATION_KEYS.map((k) => {
      const v = instance.storageGet(verificationKeyKey(k.circuitType));
      return [k.circuitType, v ? Buffer.from(v.bytes()) : null];
    }),
  );
}

/** Where the confidential token's instance storage points. */
export function tokenWiring(instance) {
  const read = (name) => {
    const v = instance.storageGet(scv.variant(name));
    return v ? addressOf(v) : null;
  };
  return { underlyingAsset: read("UnderlyingAsset"), verifier: read("Verifier"), auditor: read("Auditor") };
}

/** Every address stored anywhere in an instance's storage values. */
export function addressesInInstance(instance) {
  const found = [];
  const walk = (v) => {
    const kind = v.switch().name;
    if (kind === "scvAddress") found.push(addressOf(v));
    else if (kind === "scvVec") (v.vec() ?? []).forEach(walk);
    else if (kind === "scvMap") (v.map() ?? []).forEach((e) => (walk(e.key()), walk(e.val())));
  };
  for (const { key, val } of instance.storage.values()) {
    walk(key);
    walk(val);
  }
  return found;
}

export const payrollTokenKey = scv.variant("Token");
export const payrollRegistryKey = scv.variant("AuditorRegistry");

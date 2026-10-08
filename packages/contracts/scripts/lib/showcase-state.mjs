// Two files hold the showcase. deployments/showcase-testnet.json is public: ids, addresses,
// transaction hashes and the demo accountant key that is published on purpose. The private
// .stellar/showcase-secrets.json holds the throwaway Stellar secrets, the seeded amounts and the
// treasury's balance openings. Both are rewritten after every step, so a crashed seed resumes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONTRACTS_DIR } from "./network.mjs";
import { assertPublicText } from "./encodings.mjs";

export const PUBLIC_FILE = path.join(CONTRACTS_DIR, "deployments", "showcase-testnet.json");
export const SECRETS_FILE = path.join(CONTRACTS_DIR, ".stellar", "showcase-secrets.json");

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

/**
 * Throws unless git says `file` is ignored. A missing git, or any answer but "ignored", stops
 * the write: secrets are written only where they cannot be committed by accident.
 */
export function requireGitIgnored(file) {
  const res = spawnSync("git", ["check-ignore", "-q", "--", file], { cwd: path.dirname(CONTRACTS_DIR), encoding: "utf8" });
  if (res.error) throw new Error(`git is needed to confirm ${path.basename(file)} is ignored: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${file} is not ignored by git, so no secret is written to it`);
}

export function loadPublic() {
  return readJson(PUBLIC_FILE);
}

/**
 * Writes the public record. The text is checked as it will be published: no Stellar secret
 * seed and no encoding of any amount in `privateAmounts`.
 */
export function savePublic(record, privateAmounts) {
  const text = JSON.stringify(record, null, 2) + "\n";
  assertPublicText(text, privateAmounts);
  if (!existsSync(PUBLIC_FILE) || readFileSync(PUBLIC_FILE, "utf8") !== text) writeAtomic(PUBLIC_FILE, text);
}

export function loadSecrets() {
  return readJson(SECRETS_FILE);
}

export function saveSecrets(secrets) {
  requireGitIgnored(SECRETS_FILE);
  writeAtomic(SECRETS_FILE, JSON.stringify(secrets, null, 2) + "\n");
}

/**
 * A core OpeningStore kept inside the secrets file, under `secrets.openings`. Core checks every
 * opening it reads against the chain, so a stale or edited entry is refused, never trusted.
 */
export function openingStore(secrets) {
  secrets.openings ??= {};
  return {
    get: async (key) => secrets.openings[key],
    put: async (key, value) => {
      secrets.openings[key] = value;
      saveSecrets(secrets);
    },
    // Core clears an in-flight pay's record once that transaction is final.
    delete: async (key) => {
      if (!(key in secrets.openings)) return;
      delete secrets.openings[key];
      saveSecrets(secrets);
    },
  };
}

/** Every amount the secrets file holds, as bigints, for the public-file guard. */
export function privateAmountsOf(secrets) {
  if (!secrets?.amounts) return [];
  const { runs = {}, deposits = {}, planted = {}, earlier = [] } = secrets.amounts;
  const values = [
    ...Object.values(runs).flatMap((byWorker) => Object.values(byWorker)),
    ...Object.values(deposits),
    ...Object.values(planted),
    ...earlier.flatMap((e) => Object.values(e.runs).flatMap((byWorker) => Object.values(byWorker))),
  ];
  return values.map((v) => BigInt(v));
}

/** What earlier payroll contracts paid `worker` in the showcase, in stroops, from the secrets file. */
export function earlierPayOf(secrets, worker) {
  return (secrets?.amounts?.earlier ?? []).reduce(
    (sum, e) => sum + Object.values(e.runs).reduce((s, byWorker) => s + BigInt(byWorker[worker] ?? 0), 0n),
    0n,
  );
}

// Everything the deploy and the check trust without asking the chain. Each
// pin here was measured once (see the M1a testnet run) and is compared, never
// assumed: a value read later must equal its pin or the script stops.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Networks } from "@stellar/stellar-sdk";

export const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Optional, and never holds a secret (see .env.example). Values already set in
// the shell win over the file.
const ENV_FILE = path.join(SCRIPTS_DIR, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
export const CONTRACTS_DIR = path.resolve(SCRIPTS_DIR, "..");
export const FIXTURES_DIR = path.join(CONTRACTS_DIR, "fixtures");
export const STELLAR_CONFIG_DIR = path.join(CONTRACTS_DIR, ".stellar");
export const DEPLOYMENT_FILE = path.join(CONTRACTS_DIR, "deployments", "testnet.json");

export const NETWORK_NAME = "testnet";
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = "https://soroban-testnet.stellar.org";

export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
// Circle's testnet USDC issuer. The SAC id above must derive from it, so a
// typo in either constant stops the deploy instead of wrapping the wrong asset.
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// OpenZeppelin's compiled verifier and token (stellar-contracts 98090b3), as
// already uploaded to testnet. Kalypso deploys its own instances of this exact
// code; fixtures/ holds byte-identical copies for when the code entry expires.
export const VERIFIER_WASM = {
  hash: "93db2afdcfa45ad0ced0dcd90dd2fc2743227b786e89b2dd4c74fe6cf184957f",
  file: path.join(FIXTURES_DIR, "confidential_verifier.wasm"),
  label: "fixtures/confidential_verifier.wasm",
};
export const TOKEN_WASM = {
  hash: "c77ac818ab3af1a2b9cdbc54964d68070f106fb72c9172ba4fff186995704cfd",
  file: path.join(FIXTURES_DIR, "confidential_token.wasm"),
  label: "fixtures/confidential_token.wasm",
};

export const SDK_PACKAGE = "stellar-confidential-token-sdk";
export const SDK_VERSION = "0.1.9";
export const VK_DIR = path.join(SCRIPTS_DIR, "node_modules", SDK_PACKAGE, "circuits", "vks");

// The only three circuits Kalypso registers. Spender circuits (3, 4, 5) are
// left empty on purpose: the verifier then rejects every spender proof.
export const VERIFICATION_KEYS = [
  { circuitType: 0, name: "register", sha256: "e01ba8729578e9ec4ea982801e2d806028246eeafe1a2e551e1f9cdef69a7268" },
  { circuitType: 1, name: "withdraw", sha256: "d800122c23d7216ead4f3d7c70c84fd39db37d4f7743659b7d6bf05674ce5c09" },
  { circuitType: 2, name: "transfer", sha256: "b9c6d437368efc5343d33be20b3455840b0b66ae7ad430bebc75c93a172b173c" },
];

export const OUR_PACKAGES = {
  auditorRegistry: "kalypso-auditor",
  payroll: "kalypso-payroll",
};

export const MANAGER_ROLE = "manager";
// AccessControlError::Unauthorized in OpenZeppelin's access package.
export const UNAUTHORIZED_ERROR = 2000;
// VerifierError::VerificationKeyNotRegistered.
export const KEY_NOT_REGISTERED_ERROR = 3401;

const EXPLORER = "https://stellar.expert/explorer/testnet";
export const explorer = {
  contract: (id) => `${EXPLORER}/contract/${id}`,
  tx: (hash) => `${EXPLORER}/tx/${hash}`,
  account: (g) => `${EXPLORER}/account/${g}`,
};

export function defaultWasmDir() {
  // Same rule cargo uses, so this is wherever `stellar contract build` wrote.
  const target = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.join(CONTRACTS_DIR, "target");
  return path.join(target, "wasm32v1-none", "release");
}

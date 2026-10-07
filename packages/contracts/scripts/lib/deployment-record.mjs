// deployments/testnet.json is public. It holds contract ids, hashes, ledgers
// and public keys only. It is saved after every transaction so a crashed run
// resumes from the chain instead of deploying twice.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEPLOYMENT_FILE } from "./network.mjs";

const serialize = (record) => JSON.stringify(record, null, 2) + "\n";

export function readDeploymentText() {
  return existsSync(DEPLOYMENT_FILE) ? readFileSync(DEPLOYMENT_FILE, "utf8") : null;
}

export function loadDeployment({ required = false } = {}) {
  const text = readDeploymentText();
  if (text === null) {
    if (required) throw new Error(`${path.basename(DEPLOYMENT_FILE)} not found. Run npm run deploy:testnet first`);
    return null;
  }
  return JSON.parse(text);
}

export function saveDeployment(record) {
  mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
  const text = serialize(record);
  if (readDeploymentText() !== text) writeFileSync(DEPLOYMENT_FILE, text);
  return text;
}

export { serialize as serializeDeployment };

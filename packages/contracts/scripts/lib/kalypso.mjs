// The seed and the prove command talk to the chain through @kalypso/core, the same code the
// app runs. Core imports the Stellar SDK and the confidential SDK from its own node_modules,
// and an XDR value or curve point made by a second copy of either fails core's instanceof
// checks. So every SDK used next to core is loaded from core's own install, never ours.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "@kalypso/core";
import { createNodeProver } from "@kalypso/core/node";
import { loadDeployment } from "./deployment-record.mjs";
import { USDC_ISSUER, USDC_SAC, explorer } from "./network.mjs";

const CORE_ENTRY = fileURLToPath(import.meta.resolve("@kalypso/core"));

/** Imports `specifier` the way Node would from inside core's dist, through the package's export map. */
async function importFromCore(specifier) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = "." + specifier.slice(name.length);
  for (let dir = path.dirname(CORE_ENTRY); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, "node_modules", name);
    if (existsSync(path.join(pkgDir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const entry = pkg.exports?.[subpath];
      const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
      if (!target) throw new Error(`${specifier} has no ESM entry in core's install`);
      return import(pathToFileURL(path.join(pkgDir, target)).href);
    }
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed where @kalypso/core can see it`);
  }
}

export const sdk = await importFromCore("@stellar/stellar-sdk");
export const cts = await importFromCore("stellar-confidential-token-sdk");
export { core, createNodeProver };

// Part of every Freighter key (DECISIONS 2026-10-07). Demo keys use the production domain so
// the deployed app derives exactly the keys these demo accounts registered with.
export const KEY_DOMAIN = "kalypso-payroll.vercel.app";

const record = loadDeployment({ required: true });

export const stack = {
  network: record.network,
  passphrase: record.networkPassphrase,
  rpcUrl: record.rpcUrl,
  deployer: record.deployer.publicKey,
  contracts: {
    verifier: record.contracts.verifier.id,
    auditor: record.contracts.auditorRegistry.id,
    token: record.contracts.token.id,
    payroll: record.contracts.payroll.id,
  },
  tokenDeployLedger: record.contracts.token.deployTx.ledger,
  tokenDeployTx: { hash: record.contracts.token.deployTx.hash, ledger: record.contracts.token.deployTx.ledger },
  usdc: { sac: USDC_SAC, issuer: USDC_ISSUER, asset: new sdk.Asset("USDC", USDC_ISSUER) },
};

// The token's wiring must be what the deploy record says before anything moves money through it.
if (record.contracts.token.constructor?.underlyingAsset !== USDC_SAC) {
  throw new Error("deployments/testnet.json wraps a different asset from the pinned USDC contract");
}

export const port = core.createRpcChainPort({ rpcUrl: stack.rpcUrl, networkPassphrase: stack.passphrase });
export const events = core.createRpcEventsPort({ rpcUrl: stack.rpcUrl });
// Horizon keeps transaction envelopes past RPC's 7-day window, so payslips stay bindable after it.
export const txSource = core.createTxSourcePort({ rpcUrl: stack.rpcUrl, horizonUrl: "https://horizon-testnet.stellar.org" });
export const rpcServer = new sdk.rpc.Server(stack.rpcUrl);

/**
 * The confidential keys a Freighter user with this keypair gets in the app. Core takes two
 * signatures of the key message and requires them equal (C40), as the app asks Freighter twice;
 * an ed25519 key signs the same message to the same bytes, so signing twice here passes for real.
 */
export function kalypsoKeys(keypair) {
  const p = { domain: KEY_DOMAIN, network: "testnet", token: stack.contracts.token, account: keypair.publicKey() };
  const message = core.walletKeyMessage(p);
  const sign = () => new Uint8Array(keypair.signMessage(message));
  return core.deriveFromWalletSignatures(sign(), sign(), p);
}

/** 64-byte be(x) || be(y), the only form points are compared in across modules. */
export const pointHex = (point) => Buffer.from(cts.pointToBytes(point)).toString("hex");

export { explorer };

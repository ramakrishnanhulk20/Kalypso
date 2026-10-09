import { Asset } from "@stellar/stellar-sdk";
import deployment from "../../../contracts/deployments/testnet.json";
import showcaseRecord from "../../../contracts/deployments/showcase-testnet.json";
import { contracts as siteContracts, horizonUrl, networkPassphrase, rpcUrl } from "../stack";

/** Part of every Freighter worker's key message. The showcase's keys were derived with it, so it can never change. */
export const KEY_DOMAIN = "kalypso-payroll.vercel.app";

/**
 * passkey-kit 0.19.1's canonical testnet wallet code. The same pin as the fee sponsor's
 * PINNED_PASSKEY_WALLET_WASM_HASH (packages/server/src/config.ts), which refuses any other.
 */
export const PASSKEY_WALLET_WASM_HASH = "97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e";

/** SDF's test anchor. The portal talks to no other cash-out service. */
export const ANCHOR_HOME_DOMAIN = "testanchor.stellar.org";

export interface WorkerConfig {
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  keyDomain: string;
  contracts: { payroll: string; token: string; auditor: string };
  usdc: { sac: string; issuer: string };
  walletWasmHash: string;
  /** No Kalypso history starts before the token's deploy ledger. */
  tokenDeployLedger: number;
  anchor: { homeDomain: string; origin: string };
}

let checked: WorkerConfig | undefined;

/**
 * The testnet stack the worker portal runs on, read from the public deployment records and checked
 * the way the seed checks it before any money moves: the token wraps the pinned USDC contract, that
 * contract derives from Circle's issuer, the token and payroll read keys from one auditor registry,
 * and the key domain is the one the showcase keys were made with.
 *
 * @throws Error when the records disagree, so nothing is signed on a mismatched stack.
 */
export function workerConfig(): WorkerConfig {
  if (checked) return checked;
  const auditor = deployment.contracts.auditorRegistry.id;
  const usdc = { sac: showcaseRecord.contracts.usdc.id, issuer: showcaseRecord.contracts.usdc.issuer };
  const token = deployment.contracts.token.constructor;
  const payroll = deployment.contracts.payroll.constructor;
  const wired =
    siteContracts.token === deployment.contracts.token.id &&
    siteContracts.payroll === deployment.contracts.payroll.id &&
    token.underlyingAsset === usdc.sac &&
    token.auditor === auditor &&
    payroll.token === siteContracts.token &&
    payroll.auditorRegistry === auditor &&
    showcaseRecord.keyDomain === KEY_DOMAIN &&
    new Asset("USDC", usdc.issuer).contractId(networkPassphrase) === usdc.sac;
  if (!wired) throw new Error("The deployment records do not describe one consistent testnet stack, so the worker portal will not run.");
  checked = {
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    friendbotUrl: "https://friendbot.stellar.org",
    keyDomain: KEY_DOMAIN,
    contracts: { payroll: siteContracts.payroll, token: siteContracts.token, auditor },
    usdc,
    walletWasmHash: PASSKEY_WALLET_WASM_HASH,
    tokenDeployLedger: deployment.contracts.token.deployTx.ledger,
    anchor: { homeDomain: ANCHOR_HOME_DOMAIN, origin: `https://${ANCHOR_HOME_DOMAIN}` },
  };
  return checked;
}

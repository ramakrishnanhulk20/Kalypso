import deployment from "../../../contracts/deployments/testnet.json";
import showcaseRecord from "../../../contracts/deployments/showcase-testnet.json";
import { contracts as siteContracts, horizonUrl, networkPassphrase, rpcUrl } from "../stack";
import { Asset } from "./sdk";

export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";

export interface SandboxConfig {
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  /** Part of every Kalypso key message. The seed's KEY_DOMAIN, so these keys equal what the live app derives. */
  keyDomain: string;
  contracts: { payroll: string; token: string; auditor: string };
  usdc: { sac: string; issuer: string };
}

let checked: SandboxConfig | undefined;

/**
 * The testnet stack the sandbox runs on, read from the public deployment records, and checked
 * the way the seed checks it before any money moves: the token wraps the pinned USDC contract,
 * that contract derives from Circle's issuer, and the token and payroll both read keys from the
 * same auditor registry.
 *
 * @throws Error when the records disagree, so nothing is sent on a mismatched stack.
 */
export function sandboxConfig(): SandboxConfig {
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
    new Asset("USDC", usdc.issuer).contractId(networkPassphrase) === usdc.sac;
  if (!wired) throw new Error("The deployment records do not describe one consistent testnet stack, so the sandbox will not run.");
  checked = {
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    friendbotUrl: FRIENDBOT_URL,
    keyDomain: showcaseRecord.keyDomain,
    contracts: { payroll: siteContracts.payroll, token: siteContracts.token, auditor },
    usdc,
  };
  return checked;
}

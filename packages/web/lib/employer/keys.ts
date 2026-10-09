import { KeyError, deriveFromWalletSignatures, walletKeyMessage } from "@kalypso/core";
import type { KalypsoKeys } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { ConsoleError } from "./errors";

// Kept for the page's life and never saved, like the sandbox's keys: asking the wallet for two
// signatures before every step would mean a pair of wallet prompts per click.
const cache = new Map<string, KalypsoKeys>();

/**
 * The wallet's Kalypso keys for one token-like contract id, derived from two separate SEP-53
 * signatures of core's key message (threat model C15, C40). The wallet is asked twice, here, so
 * the key is proven reproducible before anything is registered under it; core checks both
 * signatures are this account's over exactly that text and byte-equal before deriving.
 *
 * `token` is the confidential token for a treasury, and the auditor registry for an accountant,
 * so an accountant's key can never equal any token key of the same wallet.
 *
 * @throws ConsoleError KEY_NOT_DERIVED (with core's own reason, such as a wallet that does not sign
 *   the same way twice); or the wallet's own error when the person refuses to sign.
 */
export async function walletKeys(wallet: WalletPort, p: { domain: string; token: string }): Promise<KalypsoKeys> {
  const id = `${p.domain} ${p.token} ${wallet.address}`;
  const cached = cache.get(id);
  if (cached) return cached;
  const params = { domain: p.domain, network: "testnet" as const, token: p.token, account: wallet.address };
  let message: string;
  try {
    message = walletKeyMessage(params);
  } catch (err) {
    if (err instanceof KeyError) throw new ConsoleError("KEY_NOT_DERIVED", { message: err.message });
    throw err;
  }
  const first = await wallet.signMessage(message);
  const second = await wallet.signMessage(message);
  let keys: KalypsoKeys;
  try {
    keys = deriveFromWalletSignatures(first, second, params);
  } catch (err) {
    if (err instanceof KeyError) throw new ConsoleError("KEY_NOT_DERIVED", { message: err.message });
    throw err;
  }
  cache.set(id, keys);
  return keys;
}

/** Forgets every key derived on this page, for sign-out. */
export function forgetWalletKeys(): void {
  cache.clear();
}

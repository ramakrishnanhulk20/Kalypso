import { AddressError, confidentialBalance, deriveFromWalletSignatures, parseAccount, walletKeyMessage } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { WorkerError, toWorkerError } from "./errors";
import { openSession, type WorkerRuntime, type WorkerSession } from "./session";
import { readWorkerRecord } from "./storage";

/** Any wallet failure or refusal reads as the person declining; the wallet's own text never reaches the screen. */
async function askWallet<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch {
    throw new WorkerError("WALLET_REJECTED");
  }
}

/**
 * Signs a wallet worker in. The wallet is asked to sign core's key message twice, in two separate
 * requests, and core derives the keys only when both signatures verify for this account and are
 * byte-equal (C40): a wallet that randomises its signatures would derive a key it could never
 * rebuild, and is refused before anything is registered under it. The message names Kalypso, the
 * production domain, testnet, the token and the account (C15).
 *
 * @throws WorkerError WALLET_ADDRESS_INVALID unless the wallet is a G account; WALLET_REJECTED;
 *   WALLET_NOT_REPRODUCIBLE; WALLET_SIGNATURE_INVALID; KEYS_MISMATCH when the account is already
 *   registered with the token under other keys.
 */
export async function connectWallet(rt: WorkerRuntime, wallet: WalletPort): Promise<{ worker: WorkerSession }> {
  let address: string;
  try {
    const parsed = parseAccount(wallet?.address);
    if (parsed.kind !== "G") throw new AddressError("INVALID");
    address = parsed.address;
  } catch {
    throw new WorkerError("WALLET_ADDRESS_INVALID");
  }
  const p = { domain: rt.config.keyDomain, network: "testnet" as const, token: rt.config.contracts.token, account: address };
  const message = walletKeyMessage(p);
  const first = await askWallet(() => wallet.signMessage(message));
  const second = await askWallet(() => wallet.signMessage(message));
  let keys;
  try {
    keys = deriveFromWalletSignatures(first, second, p);
  } catch (err) {
    throw toWorkerError(err);
  }
  const account = await confidentialBalance(rt.port, rt.config.contracts.token, address);
  if (account !== null && !account.pvk.equals(keys.PVK)) throw new WorkerError("KEYS_MISMATCH");
  const auditorId = account?.auditorId ?? readWorkerRecord(rt.storage, address).auditorId;
  return { worker: openSession({ kind: "wallet", address, cashOutAddress: address, keys, auditorId }, { kind: "wallet", wallet }) };
}

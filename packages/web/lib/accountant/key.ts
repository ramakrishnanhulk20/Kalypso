import { AuditorBindingError, DecodeError, buildRegisterKey, readRegisteredAuditorId, requireAuditorBinding } from "@kalypso/core";
import { pointToBytes } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
import { consoleContext, reporter, type OnProgress } from "../employer/context";
import { ConsoleError } from "../employer/errors";
import { walletKeys } from "../employer/keys";
import { withWalletLock } from "../employer/lock";
import { confirmOnChain, sendCall } from "../employer/send";
import { auditorPublicKey } from "../sandbox/accounts";
import type { Point } from "../sandbox/sdk";
import type { WalletPort } from "../wallet/port";

const MAX_U32 = 0xffff_ffff;

/** The accountant's public key as the registry stores it: 128 hex characters of be(x) || be(y). */
export function keyHex(point: Point): string {
  return Array.from(pointToBytes(point), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The first 16 hex characters of the key, in groups of four ("1f45 2e9b c760 7a31"). The employer
 * reads it off their screen and the accountant off theirs, out of band, before the employer
 * registers under the id: a stranger would need a key with the same 64-bit prefix.
 */
export function shortKeyHex(point: Point): string {
  return keyHex(point).slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
}

export interface AccountantKey {
  address: string;
  keyHex: string;
  shortKeyHex: string;
}

export interface RegisteredAccountant extends AccountantKey {
  /** The id the confirmed register_key returned, or the known id that was checked on chain. */
  accountantId: number;
  /** The register_key transaction, when this call sent one. */
  txHash?: string;
}

/**
 * The accountant's audit secret and its public point k·H, derived from two wallet signatures of
 * core's key message with the auditor registry as the token (domain separation from every token
 * key the same wallet has). Exported for books.ts only; index.ts does not re-export it, so the
 * secret never leaves the accountant modules.
 */
export async function accountantSecret(wallet: WalletPort): Promise<{ secret: bigint; point: Point }> {
  const { config } = consoleContext();
  const keys = await walletKeys(wallet, { domain: config.keyDomain, token: config.contracts.auditor });
  return { secret: keys.sk, point: auditorPublicKey(keys.sk) };
}

function publicView(wallet: WalletPort, point: Point): AccountantKey {
  return { address: wallet.address, keyHex: keyHex(point), shortKeyHex: shortKeyHex(point) };
}

/**
 * Asks the wallet for the two signatures that make the accountant's key, and returns its public
 * side for the screen. Nothing is sent.
 *
 * @throws ConsoleError KEY_NOT_DERIVED, or the wallet's own error.
 */
export async function deriveAccountantKey(wallet: WalletPort, onProgress?: OnProgress): Promise<AccountantKey> {
  const p = reporter(onProgress, 1);
  p.say("Sign the Kalypso key message twice in your wallet to make your accountant key");
  const { point } = await accountantSecret(wallet);
  p.tick("Your accountant key is ready");
  return publicView(wallet, point);
}

/** True when the registry says this wallet owns `id` and holds this point under it. An outage throws. */
async function holds(id: number, owner: string, point: Point): Promise<boolean> {
  const ctx = consoleContext();
  try {
    await requireAuditorBinding(ctx.port, ctx.config.contracts.auditor, id, { owner, key: point });
    return true;
  } catch (err) {
    if (err instanceof AuditorBindingError) return false;
    throw err;
  }
}

/**
 * Registers the accountant's key with the auditor registry, owned by this wallet, and returns the
 * id to give the employer with this wallet's address. The id is read only from the confirmed
 * register_key's return value (threat model C43), never predicted from key_count.
 *
 * With knownId (an id this accountant registered before), nothing is sent when the registry, read
 * now, says this wallet owns it and holds this key under it.
 *
 * @throws ConsoleError ACCOUNTANT_ID_INVALID, ACCOUNTANT_ID_NOT_YOURS (knownId does not bind),
 *   ACCOUNT_NOT_FOUND, BUSY, CHAIN_DISAGREES (no id came back), NOT_ON_CHAIN, any sendCall code;
 *   KEY_NOT_DERIVED or the wallet's own error.
 */
export async function registerAccountantKey(
  wallet: WalletPort,
  input: { knownId?: number } = {},
  onProgress?: OnProgress,
): Promise<RegisteredAccountant> {
  const { knownId } = input;
  if (knownId !== undefined && (!Number.isSafeInteger(knownId) || knownId < 0 || knownId > MAX_U32)) throw new ConsoleError("ACCOUNTANT_ID_INVALID");
  const ctx = consoleContext();
  return withWalletLock(wallet.address, async () => {
    const p = reporter(onProgress, 2);
    if ((await ctx.ledger.xlmBalance(wallet.address)) === null) throw new ConsoleError("ACCOUNT_NOT_FOUND");
    p.say("Sign the Kalypso key message twice in your wallet to make your accountant key");
    const { point } = await accountantSecret(wallet);
    p.tick("Your accountant key is ready");

    if (knownId !== undefined) {
      if (!(await holds(knownId, wallet.address, point))) throw new ConsoleError("ACCOUNTANT_ID_NOT_YOURS");
      p.tick(`Accountant id ${knownId} already holds your key`);
      return { ...publicView(wallet, point), accountantId: knownId };
    }

    p.say("Registering your accountant key on chain");
    const sent = await sendCall(ctx, wallet, {
      what: "register_key",
      contractId: ctx.config.contracts.auditor,
      build: (base) => buildRegisterKey(base, { owner: wallet.address, point }),
    });
    let accountantId: number;
    try {
      accountantId = readRegisteredAuditorId(sent.returnValue as Parameters<typeof readRegisteredAuditorId>[0]);
    } catch (err) {
      if (!(err instanceof DecodeError)) throw err;
      throw new ConsoleError("CHAIN_DISAGREES", { message: "The key registration landed, but the network did not say which id it got. Look the transaction up on stellar.expert to find it." });
    }
    await confirmOnChain(ctx, "The accountant key", () => holds(accountantId, wallet.address, point));
    p.tick(`Your accountant id is ${accountantId}`, sent.hash);
    return { ...publicView(wallet, point), accountantId, txHash: sent.hash };
  });
}

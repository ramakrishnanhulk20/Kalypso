import { getNetworkDetails, isConnected, requestAccess, signMessage, signTransaction } from "@stellar/freighter-api";
import { AddressError, parseAccount } from "@kalypso/core";
import { Networks } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { Keypair, TransactionBuilder } from "../sandbox/sdk";
import type { WalletPort } from "./port";

export type WalletErrorCode =
  | "NOT_INSTALLED"
  | "ACCESS_REFUSED"
  | "WRONG_NETWORK"
  | "NETWORK_UNREADABLE"
  | "SIGN_REFUSED"
  | "WRONG_SIGNER"
  | "BAD_SIGNATURE"
  | "CHANGED_TRANSACTION";

// Freighter's own error text is never passed on: it can name accounts or carry whatever the
// extension chose to say, and these messages end up on screen and in error reports.
const WALLET_MESSAGES: Record<WalletErrorCode, string> = {
  NOT_INSTALLED: "Freighter is not installed, or it is locked. Install it from freighter.app or open it and enter your password, then try again.",
  ACCESS_REFUSED: "Freighter did not share an account with Kalypso. Approve the connection in Freighter, then try again.",
  WRONG_NETWORK: "Switch Freighter to Testnet, then try again.",
  NETWORK_UNREADABLE: "Kalypso could not read which network Freighter is on, so nothing was signed. Open Freighter and enter your password, then try again.",
  SIGN_REFUSED: "Freighter did not sign, so nothing was sent.",
  WRONG_SIGNER: "Freighter signed with a different account from the one connected. Switch Freighter back to that account, then try again.",
  BAD_SIGNATURE: "Freighter returned a signature that does not check out for this account and message, so it was not used.",
  CHANGED_TRANSACTION: "Freighter returned a different transaction from the one it was asked to sign, or one this account did not sign. Nothing was sent.",
};

/** A wallet step was refused. The message is plain English for the screen and names no account or key. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode) {
    super(WALLET_MESSAGES[code]);
    this.name = "WalletError";
    this.code = code;
  }
}

const SIGNATURE_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_SIGNATURE = /^[0-9a-fA-F]{128}$/;

/**
 * The 64 signature bytes inside Freighter's signMessage reply, or null. Extension versions answer
 * with a base64 string (API v4), raw bytes (v3, a Buffer), or bytes that went through JSON on the
 * way ({ type: "Buffer", data }). Decoding is only the first gate: the caller still verifies the
 * bytes against the account and the message, so a reply decoded the wrong way is refused there.
 */
export function signatureBytesOf(reply: unknown): Uint8Array | null {
  let bytes: Uint8Array | null = null;
  if (typeof reply === "string") {
    if (HEX_SIGNATURE.test(reply)) {
      bytes = Uint8Array.from(reply.match(/../g) as string[], (pair) => parseInt(pair, 16));
    } else if (BASE64.test(reply) && reply.length % 4 === 0) {
      try {
        bytes = Uint8Array.from(atob(reply), (c) => c.charCodeAt(0));
      } catch {
        bytes = null;
      }
    }
  } else if (ArrayBuffer.isView(reply)) {
    bytes = new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength).slice();
  } else if (typeof reply === "object" && reply !== null) {
    const data = (reply as { type?: unknown; data?: unknown }).type === "Buffer" ? (reply as { data?: unknown }).data : undefined;
    if (Array.isArray(data) && data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) bytes = Uint8Array.from(data as number[]);
  }
  return bytes !== null && bytes.length === SIGNATURE_BYTES ? bytes : null;
}

// The Stellar SDK copies the signature with Buffer.from, so a plain Uint8Array works at runtime.
type SignatureArg = Parameters<Keypair["verifyMessage"]>[1];

async function requireTestnet(): Promise<void> {
  let details: Awaited<ReturnType<typeof getNetworkDetails>>;
  try {
    details = await getNetworkDetails();
  } catch {
    throw new WalletError("NETWORK_UNREADABLE");
  }
  if (details.error || typeof details.networkPassphrase !== "string") throw new WalletError("NETWORK_UNREADABLE");
  if (details.networkPassphrase !== Networks.TESTNET) throw new WalletError("WRONG_NETWORK");
}

// Only a named, different signer is refused here. The signature check after it is the real gate,
// so an extension version that leaves signerAddress empty is judged by its signature alone.
function namesAnotherSigner(reported: unknown, address: string): boolean {
  if (reported === undefined || reported === null || reported === "") return false;
  try {
    return typeof reported !== "string" || parseAccount(reported).address !== address;
  } catch (err) {
    if (err instanceof AddressError) return true;
    throw err;
  }
}

/**
 * The signed envelope Freighter returned, refused unless it is the same transaction it was given
 * (same hash for this network) and carries a valid signature by `address` over that hash.
 */
function requireSignedByAccount(unsignedXdr: string, signedXdr: unknown, networkPassphrase: string, address: string): string {
  if (typeof signedXdr !== "string" || signedXdr === "") throw new WalletError("SIGN_REFUSED");
  try {
    const want = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase).hash();
    const signed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    const hash = signed.hash();
    const signer = Keypair.fromPublicKey(address);
    if (!hash.equals(want)) throw new WalletError("CHANGED_TRANSACTION");
    if (!signed.signatures.some((s) => signer.verify(hash, s.signature()))) throw new WalletError("CHANGED_TRANSACTION");
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw new WalletError("CHANGED_TRANSACTION");
  }
  return signedXdr;
}

/**
 * Connects Freighter for Kalypso: checks the extension is there, asks it to share an account, and
 * refuses unless it is on Stellar testnet. Every later signature checks the network again,
 * because a person can switch networks in Freighter at any time.
 *
 * signTransaction hands back the signed envelope only when it is the transaction that was asked
 * for and holds a valid signature by the connected account. signMessage hands back the 64-byte
 * ed25519 signature over SEP-53's digest of the exact text, only after verifying it with the
 * account's public key; Freighter shows the text to the person before they sign (threat model
 * non-goals: no raw-hash signing).
 *
 * @throws WalletError NOT_INSTALLED, ACCESS_REFUSED, WRONG_NETWORK ("Switch Freighter to Testnet,
 *   then try again.") or NETWORK_UNREADABLE. The returned wallet's methods throw WalletError
 *   WRONG_NETWORK, NETWORK_UNREADABLE, SIGN_REFUSED, WRONG_SIGNER, BAD_SIGNATURE or CHANGED_TRANSACTION.
 */
export async function connectFreighter(): Promise<WalletPort> {
  let connected: Awaited<ReturnType<typeof isConnected>>;
  try {
    connected = await isConnected();
  } catch {
    throw new WalletError("NOT_INSTALLED");
  }
  if (connected.error || connected.isConnected !== true) throw new WalletError("NOT_INSTALLED");

  let access: Awaited<ReturnType<typeof requestAccess>>;
  try {
    access = await requestAccess();
  } catch {
    throw new WalletError("ACCESS_REFUSED");
  }
  if (access.error || typeof access.address !== "string") throw new WalletError("ACCESS_REFUSED");
  let address: string;
  try {
    const parsed = parseAccount(access.address);
    if (parsed.kind !== "G") throw new WalletError("ACCESS_REFUSED");
    address = parsed.address;
  } catch {
    throw new WalletError("ACCESS_REFUSED");
  }
  await requireTestnet();
  const signer = Keypair.fromPublicKey(address);

  return {
    kind: "freighter",
    address,
    async signTransaction(txXdr, networkPassphrase) {
      if (networkPassphrase !== Networks.TESTNET) throw new WalletError("WRONG_NETWORK");
      await requireTestnet();
      let reply: Awaited<ReturnType<typeof signTransaction>>;
      try {
        reply = await signTransaction(txXdr, { networkPassphrase, address });
      } catch {
        throw new WalletError("SIGN_REFUSED");
      }
      if (reply.error) throw new WalletError("SIGN_REFUSED");
      if (namesAnotherSigner(reply.signerAddress, address)) throw new WalletError("WRONG_SIGNER");
      return requireSignedByAccount(txXdr, reply.signedTxXdr, networkPassphrase, address);
    },
    async signMessage(message) {
      if (typeof message !== "string" || message === "") throw new TypeError("signMessage takes the message as non-empty text");
      await requireTestnet();
      let reply: Awaited<ReturnType<typeof signMessage>>;
      try {
        reply = await signMessage(message, { networkPassphrase: Networks.TESTNET, address });
      } catch {
        throw new WalletError("SIGN_REFUSED");
      }
      if (reply.error || reply.signedMessage === null || reply.signedMessage === undefined) throw new WalletError("SIGN_REFUSED");
      if (namesAnotherSigner(reply.signerAddress, address)) throw new WalletError("WRONG_SIGNER");
      const signature = signatureBytesOf(reply.signedMessage);
      if (signature === null || !signer.verifyMessage(message, signature as SignatureArg)) throw new WalletError("BAD_SIGNATURE");
      return signature;
    },
  };
}

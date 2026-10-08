import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Keypair } from '@stellar/stellar-sdk/base';
import { deriveKeys, deriveSk, type KeyPair } from 'stellar-confidential-token-sdk';
import { AddressError, parseAccount, type AccountKind } from './addresses.js';

/**
 * Version tag for every key Kalypso derives. Changing it, or any string below, changes every
 * existing user's keys, so test/vectors.json pins the outputs and CI fails on any drift.
 */
export const KEY_VERSION = 'kalypso/v1';

// Private, because a Uint8Array cannot be frozen: an exported one could be overwritten by any
// caller, silently changing every passkey key derived after that.
const PRF_EVAL_SALT = sha256(utf8ToBytes('kalypso/v1/confidential-root'));

/**
 * The fixed salt the app sends with every WebAuthn PRF request (SHA-256 of
 * "kalypso/v1/confidential-root"). Returns a fresh copy on each call, so writing to the result
 * cannot change what the next caller gets. The bytes are pinned in test/vectors.json.
 */
export function prfEvalSalt(): Uint8Array {
  return PRF_EVAL_SALT.slice();
}

const CASHOUT_SALT = utf8ToBytes('kalypso/v1');
const CASHOUT_INFO = utf8ToBytes('cashout-g');

const SIGNATURE_BYTES = 64;
const PRF_OUTPUT_BYTES = 32;

/** The SDK's KeyPair for one (token, account), with addrF and acctF always present. */
export interface KalypsoKeys extends KeyPair {
  addrF: bigint;
  acctF: bigint;
}

export type KeyErrorCode =
  | 'NOT_BYTES'
  | 'SIGNATURE_LENGTH'
  | 'BAD_SIGNATURE'
  | 'PRF_OUTPUT_LENGTH'
  | 'ALL_ZERO'
  | 'TOKEN'
  | 'ACCOUNT'
  | 'DOMAIN'
  | 'NETWORK'
  | 'NOT_REPRODUCIBLE';

// Messages never carry the bytes involved: they are key material.
const KEY_MESSAGES: Record<KeyErrorCode, string> = {
  NOT_BYTES: 'Key material must be raw bytes.',
  SIGNATURE_LENGTH: 'The wallet signature must be 64 bytes (an ed25519 SEP-53 signature).',
  BAD_SIGNATURE:
    'The wallet signature is not a valid signature by this account over the Kalypso key message for this domain and token. Sign the message again in your wallet.',
  PRF_OUTPUT_LENGTH: 'The passkey PRF output must be 32 bytes.',
  ALL_ZERO: 'The wallet or passkey returned all-zero bytes, which cannot be a private key.',
  TOKEN: 'The token must be a valid C contract address.',
  ACCOUNT: 'The account is not a valid address of the kind this sign-in method supports.',
  DOMAIN: 'The domain must be a lowercase host name such as kalypso-payroll.vercel.app, with no scheme or path.',
  NETWORK: 'Kalypso keys are only derived for testnet.',
  NOT_REPRODUCIBLE:
    'This wallet gave two different signatures for the same message, so it cannot rebuild your key next time. Use a wallet that signs deterministically, such as Freighter.',
};

export class KeyError extends Error {
  readonly code: KeyErrorCode;

  constructor(code: KeyErrorCode) {
    super(KEY_MESSAGES[code]);
    this.name = 'KeyError';
    this.code = code;
  }
}

export type PrfUnavailableReason = 'MISSING' | 'WRONG_LENGTH' | 'ALL_ZERO';

/** Thrown when a passkey gives no usable PRF output. Registration must stop: there is no weaker fallback. */
export class PrfUnavailableError extends Error {
  readonly reason: PrfUnavailableReason;

  constructor(reason: PrfUnavailableReason) {
    super(
      'This passkey cannot create a Kalypso private key (it returned no PRF result). Use a passkey provider that supports PRF, or sign in with Freighter.',
    );
    this.name = 'PrfUnavailableError';
    this.reason = reason;
  }
}

// Lowercase ASCII labels only, so one domain has exactly one spelling and therefore one key.
// The optional port is there for local development; its keys differ from production by design.
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::([1-9]\d{0,4}))?$/;

function requireDomain(domain: string): string {
  const match = typeof domain === 'string' && domain.length <= 253 ? HOST_NAME.exec(domain) : null;
  if (!match || (match[1] !== undefined && Number(match[1]) > 65_535)) throw new KeyError('DOMAIN');
  return domain;
}

function requireAddress(value: string, kinds: readonly AccountKind[], code: 'TOKEN' | 'ACCOUNT'): string {
  try {
    const parsed = parseAccount(value);
    if (kinds.includes(parsed.kind)) return parsed.address;
  } catch (err) {
    if (!(err instanceof AddressError)) throw err;
  }
  throw new KeyError(code);
}

function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

// Tag checks instead of instanceof, so bytes from another realm (an iframe) are still recognised.
function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function copyOfLength(value: unknown, length: number, lengthCode: KeyErrorCode): Uint8Array {
  if (!isUint8Array(value)) throw new KeyError('NOT_BYTES');
  if (value.length !== length) throw new KeyError(lengthCode);
  if (isAllZero(value)) throw new KeyError('ALL_ZERO');
  return new Uint8Array(value);
}

function keysFromRoot(root: Uint8Array, token: string, account: string): KalypsoKeys {
  const { sk, addrF, acctF } = deriveSk(root, token, account);
  return { ...deriveKeys(sk, addrF, acctF), addrF, acctF };
}

// One builder for both the text the wallet shows and the text the signature is checked
// against, returning the decoded addresses so derivation uses exactly what was signed.
function buildWalletKeyMessage(p: { domain: string; network: 'testnet'; token: string; account: string }): {
  message: string;
  token: string;
  account: string;
} {
  const domain = requireDomain(p.domain);
  if (p.network !== 'testnet') throw new KeyError('NETWORK');
  const token = requireAddress(p.token, ['C'], 'TOKEN');
  const account = requireAddress(p.account, ['G'], 'ACCOUNT');
  const message = [
    `Kalypso private payroll key (${KEY_VERSION})`,
    '',
    `Only sign this on https://${domain}. If any other site shows you this message, do not sign it.`,
    '',
    'Signing creates the key that keeps your pay private on Kalypso. It does not move funds or approve a transaction.',
    '',
    `Domain: ${domain}`,
    `Network: ${p.network}`,
    `Token: ${token}`,
    `Account: ${account}`,
  ].join('\n');
  return { message, token, account };
}

/**
 * The text a Freighter user signs (SEP-53) to create their Kalypso key for one token. It names
 * Kalypso, the domain, the network, the token and the account, and tells the user to sign it
 * only on https://<domain>. Because the signature over this exact text is the key root, no
 * other app's message, and no other domain, token or account, yields the same key.
 *
 * @throws KeyError DOMAIN unless domain is a lowercase host name with an optional port;
 *   NETWORK unless testnet; TOKEN unless token is a C address; ACCOUNT unless account is a G address.
 */
export function walletKeyMessage(p: { domain: string; network: 'testnet'; token: string; account: string }): string {
  return buildWalletKeyMessage(p).message;
}

// The Stellar SDK copies the signature with Buffer.from, so a plain Uint8Array works at runtime.
type SignatureBytes = Parameters<Keypair['verifyMessage']>[1];

/**
 * Derives a Freighter user's confidential keys from two signatures of the same key message, asked
 * of the wallet one after the other. It rebuilds walletKeyMessage(p), checks with the Stellar
 * SDK's SEP-53 verifyMessage (strict ed25519) that each signature is p.account's over exactly that
 * text, then requires the two to be the same bytes (requireReproducible), and only then uses the
 * 64-byte signature as the root for the confidential SDK's deriveSk(root, token, account), with
 * deriveKeys giving the KeyPair. A fake wallet cannot hand over a root it knows, and a wallet that
 * randomises its nonce can never derive a key it would not rebuild next session (threat model
 * C15, C40). There is no single-signature form, so no caller can skip the second signature.
 *
 * @throws KeyError NOT_BYTES, SIGNATURE_LENGTH (not 64 bytes), ALL_ZERO, DOMAIN, NETWORK, TOKEN
 *   (not a C address), ACCOUNT (not a G address), BAD_SIGNATURE when either signature does not
 *   verify, or NOT_REPRODUCIBLE when both verify but differ. Nothing is derived when it throws.
 */
export function deriveFromWalletSignatures(
  first: Uint8Array,
  second: Uint8Array,
  p: { domain: string; network: 'testnet'; token: string; account: string },
): KalypsoKeys {
  const roots = [first, second].map((signature) => copyOfLength(signature, SIGNATURE_BYTES, 'SIGNATURE_LENGTH'));
  const { message, token, account } = buildWalletKeyMessage(p);
  const signer = Keypair.fromPublicKey(account);
  for (const root of roots) {
    if (!signer.verifyMessage(message, root as SignatureBytes)) throw new KeyError('BAD_SIGNATURE');
  }
  const [root, again] = roots as [Uint8Array, Uint8Array];
  requireReproducible(root, again);
  return keysFromRoot(root, token, account);
}

/**
 * Checks that a wallet signs the key message the same way twice (threat model C15).
 * deriveFromWalletSignatures runs it on every derivation; it stays exported so a screen can test a
 * wallet before asking for anything else. A wallet that randomises its ed25519 nonce still passes
 * strict verification, but would derive a different key every session and leave the pay unreadable.
 *
 * @throws KeyError NOT_REPRODUCIBLE unless both are 64-byte Uint8Arrays with the same bytes.
 */
export function requireReproducible(first: Uint8Array, second: Uint8Array): void {
  const same =
    isUint8Array(first) &&
    isUint8Array(second) &&
    first.length === SIGNATURE_BYTES &&
    second.length === SIGNATURE_BYTES &&
    first.every((byte, i) => byte === second[i]);
  if (!same) throw new KeyError('NOT_REPRODUCIBLE');
}

function bytesFrom(value: unknown): Uint8Array | undefined {
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array((value as ArrayBuffer).slice(0));
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Reads the PRF output from a WebAuthn credential's getClientExtensionResults(), at
 * prf.results.first. Returns a copy of the 32 bytes.
 *
 * @throws PrfUnavailableError MISSING when there is no PRF result, WRONG_LENGTH when it is
 *   not 32 bytes, ALL_ZERO when every byte is zero. It never falls back to anything weaker.
 */
export function requirePrfOutput(ext: unknown): Uint8Array {
  const bytes = bytesFrom(field(field(field(ext, 'prf'), 'results'), 'first'));
  if (bytes === undefined) throw new PrfUnavailableError('MISSING');
  if (bytes.length !== PRF_OUTPUT_BYTES) throw new PrfUnavailableError('WRONG_LENGTH');
  if (isAllZero(bytes)) throw new PrfUnavailableError('ALL_ZERO');
  return bytes;
}

// The Stellar SDK copies the seed with Buffer.from, so a plain Uint8Array works at runtime.
type SeedBytes = Parameters<typeof Keypair.fromRawEd25519Seed>[0];

/**
 * Derives a passkey user's keys from the PRF output (taken from requirePrfOutput, with the
 * request salted by prfEvalSalt()). The PRF output is the root for the confidential SDK's deriveSk(root, token,
 * account). The cash-out account, a plain G account for SEP-10 and SEP-24 at the anchor, has
 * the ed25519 seed HKDF-SHA256(ikm = PRF output, salt = "kalypso/v1", info = "cashout-g", 32 bytes).
 *
 * @param account the passkey wallet's C address (a G address is also accepted).
 * @returns the confidential keys plus cashout.publicKey (G address) and cashout.secretSeed (32 bytes).
 * @throws KeyError NOT_BYTES, PRF_OUTPUT_LENGTH (not 32 bytes), ALL_ZERO, TOKEN or ACCOUNT.
 */
export function deriveFromPrf(
  prfOutput: Uint8Array,
  token: string,
  account: string,
): KalypsoKeys & { cashout: { publicKey: string; secretSeed: Uint8Array } } {
  const root = copyOfLength(prfOutput, PRF_OUTPUT_BYTES, 'PRF_OUTPUT_LENGTH');
  const keys = keysFromRoot(root, requireAddress(token, ['C'], 'TOKEN'), requireAddress(account, ['G', 'C'], 'ACCOUNT'));
  const secretSeed = hkdf(sha256, root, CASHOUT_SALT, CASHOUT_INFO, 32);
  const publicKey = Keypair.fromRawEd25519Seed(secretSeed as SeedBytes).publicKey();
  return { ...keys, cashout: { publicKey, secretSeed } };
}

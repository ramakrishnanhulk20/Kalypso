// What the wallet-signature key root in src/keys.ts does and does not bind. Does NOT cover: a
// real Freighter or passkey, registering the keys on chain, or the screen that must ask the wallet
// twice for the two signatures deriveFromWalletSignatures takes.
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { pointToBytes } from 'stellar-confidential-token-sdk';
import { describe, expect, it } from 'vitest';
import { KeyError, deriveFromPrf, deriveFromWalletSignatures, requireReproducible, walletKeyMessage } from '../src/keys.js';
import vectors from './vectors.json' with { type: 'json' };

const { wallet, prf } = vectors;
const params = { domain: wallet.domain, network: 'testnet' as const, token: wallet.token, account: wallet.account };
const testWallet = Keypair.fromRawEd25519Seed(createHash('sha256').update('kalypso test vector wallet, testnet only', 'utf8').digest());
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const yOf = (keys: { Y: Parameters<typeof pointToBytes>[0] }) => toHex(pointToBytes(keys.Y));
// The test wallet signs deterministically, so asking it twice gives these same bytes twice.
const derive = (signature: Uint8Array, p: typeof params = params) => deriveFromWalletSignatures(signature, signature, p);
const sep53Payload = (message: string) => createHash('sha256').update(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(message)])).digest();

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] as number);
  return v;
}

function numberToBytesLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * RFC 8032 ed25519 with the nonce chosen by the caller instead of derived from the key. Some
 * signers randomise the nonce against side channels; every signature they make is valid.
 */
function signWithNonce(seed: Uint8Array, message: Uint8Array, nonce: bigint): Uint8Array {
  const L = ed25519.CURVE.n;
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
  const r = nonce % L;
  const R = ed25519.Point.BASE.multiply(r).toRawBytes();
  const k = bytesToNumberLE(sha512(Buffer.concat([R, pointBytes, message]))) % L;
  const S = (r + k * scalar) % L;
  return Buffer.concat([R, numberToBytesLE(S, 32)]);
}

describe('what verifying the derivation signature proves', () => {
  // A stated non-goal (threat model): core cannot tell a raw-hash signing API from SEP-53, so the
  // frontend only asks for signMessage.
  it('documents that signing the SEP-53 payload as a raw 32-byte blob gives the exact key root, with no message text shown', () => {
    const blob = sep53Payload(wallet.message);
    const blobSignature = new Uint8Array(testWallet.sign(blob));
    expect(toHex(blobSignature)).toBe(wallet.signatureHex);
    expect(yOf(derive(blobSignature, params))).toBe(wallet.Y);
  });

  it('refuses a wallet that randomises its ed25519 nonce before it can register a key it will not rebuild', () => {
    const seed = createHash('sha256').update('kalypso test vector wallet, testnet only', 'utf8').digest();
    const payload = sep53Payload(wallet.message);
    const first = signWithNonce(seed, payload, 0x1234_5678n);
    const second = signWithNonce(seed, payload, 0x8765_4321n);
    // Both are valid signatures, so strict verification alone cannot catch this wallet.
    for (const signature of [first, second]) {
      expect(Keypair.fromPublicKey(wallet.account).verifyMessage(wallet.message, Buffer.from(signature))).toBe(true);
    }
    expect(toHex(second)).not.toBe(toHex(first));
    expect(() => requireReproducible(first, second)).toThrow(KeyError);
    // Derivation itself takes both signatures, so such a wallet never gets a key at all (C40).
    for (const attempt of [() => requireReproducible(first, second), () => deriveFromWalletSignatures(first, second, params)]) {
      try {
        attempt();
        expect.unreachable();
      } catch (err) {
        expect((err as KeyError).code).toBe('NOT_REPRODUCIBLE');
      }
    }
    // A deterministic wallet signs the same text the same way, passes, and gives the pinned key.
    const again = [0, 1].map(() => new Uint8Array(testWallet.signMessage(wallet.message)));
    expect(() => requireReproducible(again[0] as Uint8Array, again[1] as Uint8Array)).not.toThrow();
    expect(yOf(deriveFromWalletSignatures(again[0] as Uint8Array, again[1] as Uint8Array, params))).toBe(wallet.Y);
  });

  it.each<[string, (message: string) => string]>([
    ['CRLF line breaks', (m) => m.replace(/\n/g, '\r\n')],
    ['a trailing line break', (m) => `${m}\n`],
    ['a bumped version tag', (m) => m.replace('kalypso/v1', 'kalypso/v2')],
    ['the network line changed to public', (m) => m.replace('Network: testnet', 'Network: public')],
    ['the warning sentence removed', (m) => m.replace(/Only sign this on [^\n]*\n\n/, '')],
    ['a trailing space on the account line', (m) => `${m} `],
  ])('refuses a signature over the message with %s', (_label, change) => {
    const changed = change(wallet.message);
    expect(changed).not.toBe(wallet.message);
    const signature = new Uint8Array(testWallet.signMessage(changed));
    expect(() => derive(signature, params)).toThrow(KeyError);
    try {
      derive(signature, params);
    } catch (err) {
      expect((err as KeyError).code).toBe('BAD_SIGNATURE');
    }
  });

  it('refuses a message built for a port variant of the domain as a key for the bare domain', () => {
    const portParams = { ...params, domain: `${wallet.domain}:443` };
    const signature = new Uint8Array(testWallet.signMessage(walletKeyMessage(portParams)));
    expect(() => derive(signature, params)).toThrow(KeyError);
    expect(yOf(derive(signature, portParams))).not.toBe(wallet.Y);
  });
});

describe('passkey roots', () => {
  it('derives different keys for the same passkey under two tokens, and never reuses the confidential secret for cash-out', () => {
    const prfOutput = new Uint8Array(Buffer.from(prf.prfOutputHex, 'hex'));
    const otherToken = StrKey.encodeContract(Buffer.alloc(32, 0x77));
    const here = deriveFromPrf(prfOutput, prf.token, prf.account);
    const there = deriveFromPrf(prfOutput, otherToken, prf.account);
    expect(yOf(there)).not.toBe(yOf(here));
    expect(there.cashout.publicKey).toBe(here.cashout.publicKey);
    expect(toHex(here.cashout.secretSeed)).not.toBe(here.sk.toString(16).padStart(64, '0'));
    expect(toHex(here.cashout.secretSeed)).not.toBe(prf.prfOutputHex);
  });
});

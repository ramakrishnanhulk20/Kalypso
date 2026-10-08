// Does NOT cover: real Freighter or a real passkey (no browser here), whether PRF output stays
// the same across browser launches (M1b could not prove that with a virtual authenticator), or
// registering the derived keys on chain. vectors.json was built by scratchpad/m5b/make-vectors.mjs,
// which calls the SDK, node:crypto and stellar-sdk directly, without this package's code.
import { createHash, hkdfSync } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { addressToField, deriveKeys, deriveSk, pointToBytes, skSigningMessage } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_VERSION,
  KeyError,
  PrfUnavailableError,
  deriveFromPrf,
  deriveFromWalletSignatures,
  prfEvalSalt,
  requirePrfOutput,
  requireReproducible,
  walletKeyMessage,
  type KeyErrorCode,
  type PrfUnavailableReason,
} from '../src/keys.js';
import vectors from './vectors.json' with { type: 'json' };

// Pass-through spy, so a test can show that a refused signature never reaches derivation.
vi.mock(import('stellar-confidential-token-sdk'), async (importOriginal) => {
  const sdk = await importOriginal();
  return { ...sdk, deriveSk: vi.fn(sdk.deriveSk) };
});

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const field = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
const seededWallet = (label: string) => Keypair.fromRawEd25519Seed(createHash('sha256').update(label, 'utf8').digest());
const signWith = (signer: Keypair, message: string | Uint8Array) =>
  new Uint8Array(signer.signMessage(typeof message === 'string' ? message : Buffer.from(message)));
const yOf = (keys: { Y: Parameters<typeof pointToBytes>[0] }) => toHex(pointToBytes(keys.Y));

const { wallet, prf } = vectors;
const signature = fromHex(wallet.signatureHex);
const prfOutput = fromHex(prf.prfOutputHex);
const messageParams = { domain: wallet.domain, network: 'testnet' as const, token: wallet.token, account: wallet.account };
const testWallet = seededWallet('kalypso test vector wallet, testnet only');
// The test wallet signs deterministically, so asking it twice gives these same bytes twice.
const derive = (sig: Uint8Array, p: typeof messageParams = messageParams) => deriveFromWalletSignatures(sig, sig, p);

function keyCode(fn: () => unknown): KeyErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof KeyError) return err.code;
    throw err;
  }
  return undefined;
}

function prfReason(fn: () => unknown): PrfUnavailableReason | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PrfUnavailableError) return err.reason;
    throw err;
  }
  return undefined;
}

// R || (S + L) is the same ed25519 signature written a second way. Strict verification must
// refuse it, or one message would give two roots and so two keys.
function malleated(sig: Uint8Array): Uint8Array {
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i] ?? 0);
  let t = s + L;
  const out = sig.slice();
  for (let i = 32; i < 64; i++) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pinned vectors', () => {
  it('pins the version and the PRF salt', () => {
    expect(KEY_VERSION).toBe(vectors.keyVersion);
    expect(toHex(prfEvalSalt())).toBe(vectors.prfEvalSaltHex);
    expect(toHex(createHash('sha256').update('kalypso/v1/confidential-root', 'utf8').digest())).toBe(vectors.prfEvalSaltHex);
  });

  it('hands out the PRF salt as equal but distinct copies that a caller cannot change', () => {
    const first = prfEvalSalt();
    const second = prfEvalSalt();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.fill(0);
    expect(toHex(second)).toBe(vectors.prfEvalSaltHex);
    expect(toHex(prfEvalSalt())).toBe(vectors.prfEvalSaltHex);
  });

  it('pins the wallet message, and the pinned signature is the test wallet signing it', () => {
    expect(testWallet.publicKey()).toBe(wallet.account);
    expect(walletKeyMessage(messageParams)).toBe(wallet.message);
    expect(Keypair.fromPublicKey(wallet.account).verifyMessage(wallet.message, Buffer.from(signature))).toBe(true);
  });

  it('derives the pinned keys from the valid signature', () => {
    vi.mocked(deriveSk).mockClear();
    const keys = derive(signature, messageParams);
    expect(deriveSk).toHaveBeenCalledTimes(1);
    expect(field(keys.addrF)).toBe(wallet.addrF);
    expect(field(keys.acctF)).toBe(wallet.acctF);
    expect(yOf(keys)).toBe(wallet.Y);
    expect(toHex(pointToBytes(keys.PVK))).toBe(wallet.PVK);
  });

  it('recomputes the PRF keys and the cash-out account', () => {
    const keys = deriveFromPrf(prfOutput, prf.token, prf.account);
    expect(field(keys.addrF)).toBe(prf.addrF);
    expect(field(keys.acctF)).toBe(prf.acctF);
    expect(yOf(keys)).toBe(prf.Y);
    expect(toHex(pointToBytes(keys.PVK))).toBe(prf.PVK);
    expect(toHex(keys.cashout.secretSeed)).toBe(prf.cashoutSeedHex);
    expect(keys.cashout.publicKey).toBe(prf.cashoutPublicKey);
  });

  it('would catch a changed message: one changed character breaks the signature', () => {
    const changed = wallet.message.replace('Kalypso private', 'Kalypso Private');
    expect(Keypair.fromPublicKey(wallet.account).verifyMessage(changed, Buffer.from(signature))).toBe(false);
  });
});

describe('walletKeyMessage', () => {
  it('names Kalypso, the https domain, the network, the token and the account, in ASCII', () => {
    const message = walletKeyMessage(messageParams);
    for (const part of ['Kalypso', 'Only sign this on https://kalypso-payroll.vercel.app.', 'Network: testnet', `Token: ${wallet.token}`, `Account: ${wallet.account}`]) {
      expect(message).toContain(part);
    }
    expect(message).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it('uses the decoded addresses, so padding cannot create a second key', () => {
    expect(walletKeyMessage({ ...messageParams, token: ` ${wallet.token}\n`, account: `\t${wallet.account} ` })).toBe(wallet.message);
  });

  it.each([
    ['', 'empty'],
    ['https://kalypso-payroll.vercel.app', 'a scheme'],
    ['Kalypso.app', 'capitals'],
    ['kalypso.app/pay', 'a path'],
    ['kalypso.app\nToken: CFAKE', 'a line break'],
    ['kalypso .app', 'a space'],
    ['-kalypso.app', 'a leading hyphen'],
    ['kalypso.app:70000', 'a port above 65535'],
    ['kalypso.app:0', 'port 0'],
    [`${'a'.repeat(64)}.app`, 'a label over 63 characters'],
    [`${'a.'.repeat(130)}app`, 'over 253 characters'],
  ])('refuses the domain %j (%s)', (domain) => {
    expect(keyCode(() => walletKeyMessage({ ...messageParams, domain }))).toBe('DOMAIN');
  });

  it('accepts a local development host with a port', () => {
    expect(walletKeyMessage({ ...messageParams, domain: 'localhost:3000' })).toContain('https://localhost:3000.');
  });

  it('refuses another network, a token that is not a contract, and an account that is not a G', () => {
    expect(keyCode(() => walletKeyMessage({ ...messageParams, network: 'public' as 'testnet' }))).toBe('NETWORK');
    expect(keyCode(() => walletKeyMessage({ ...messageParams, token: wallet.account }))).toBe('TOKEN');
    expect(keyCode(() => walletKeyMessage({ ...messageParams, account: prf.account }))).toBe('ACCOUNT');
    expect(keyCode(() => walletKeyMessage({ ...messageParams, account: 'not an address' }))).toBe('ACCOUNT');
  });
});

describe('deriveFromWalletSignatures', () => {
  it('returns the SDK key pair for (token, account), usable as the SDK derives it', () => {
    const keys = derive(signature, messageParams);
    expect(keys.addrF).toBe(addressToField(wallet.token));
    expect(keys.acctF).toBe(addressToField(wallet.account));
    const again = deriveKeys(keys.sk, keys.addrF, keys.acctF);
    expect(pointToBytes(again.Y)).toEqual(pointToBytes(keys.Y));
    expect(again.vk).toBe(keys.vk);
  });

  it('decodes the addresses before verifying, so padded inputs give the same keys', () => {
    const padded = { ...messageParams, token: ` ${wallet.token} `, account: `${wallet.account}\n` };
    expect(yOf(derive(signature, padded))).toBe(wallet.Y);
  });

  it.each<[string, () => Uint8Array]>([
    ['a signature by another key over the same message', () => signWith(seededWallet('another wallet'), wallet.message)],
    ['a signature over another domain\'s message', () => signWith(testWallet, walletKeyMessage({ ...messageParams, domain: 'kalypso-pay.app' }))],
    ['a signature over another token\'s message', () => signWith(testWallet, walletKeyMessage({ ...messageParams, token: StrKey.encodeContract(Buffer.alloc(32, 9)) }))],
    ['a signature over the SDK default message', () => signWith(testWallet, skSigningMessage(wallet.token, wallet.account))],
    ['the pinned signature with the first bit flipped', () => { const s = signature.slice(); s[0] = (s[0] ?? 0) ^ 0x01; return s; }],
    ['the pinned signature with a bit flipped in R', () => { const s = signature.slice(); s[17] = (s[17] ?? 0) ^ 0x40; return s; }],
    ['the pinned signature with the last bit flipped', () => { const s = signature.slice(); s[63] = (s[63] ?? 0) ^ 0x80; return s; }],
    ['the pinned signature rewritten as R || S + L', () => malleated(signature)],
  ])('refuses %s with BAD_SIGNATURE, before deriving anything', (_label, makeSignature) => {
    const bad = makeSignature();
    expect(bad).toHaveLength(64);
    expect(toHex(bad)).not.toBe(wallet.signatureHex);
    vi.mocked(deriveSk).mockClear();
    expect(keyCode(() => derive(bad, messageParams))).toBe('BAD_SIGNATURE');
    expect(deriveSk).not.toHaveBeenCalled();
  });

  it('is bound to this app: the same wallet signing for another domain gets a different key', () => {
    const otherParams = { ...messageParams, domain: 'kalypso-pay.app' };
    const otherSignature = signWith(testWallet, walletKeyMessage(otherParams));
    expect(yOf(derive(otherSignature, otherParams))).not.toBe(wallet.Y);
  });

  it('gives different keys for a different token or account', () => {
    const tokenParams = { ...messageParams, token: StrKey.encodeContract(Buffer.alloc(32, 9)) };
    expect(yOf(derive(signWith(testWallet, walletKeyMessage(tokenParams)), tokenParams))).not.toBe(wallet.Y);

    const otherWallet = seededWallet('another wallet');
    const accountParams = { ...messageParams, account: otherWallet.publicKey() };
    expect(yOf(derive(signWith(otherWallet, walletKeyMessage(accountParams)), accountParams))).not.toBe(wallet.Y);
  });

  it('refuses a signature that is not 64 bytes, all zero, or not bytes', () => {
    expect(keyCode(() => derive(signature.slice(0, 63), messageParams))).toBe('SIGNATURE_LENGTH');
    expect(keyCode(() => derive(new Uint8Array(65).fill(1), messageParams))).toBe('SIGNATURE_LENGTH');
    expect(keyCode(() => derive(new Uint8Array(64), messageParams))).toBe('ALL_ZERO');
    expect(keyCode(() => derive([...signature] as unknown as Uint8Array, messageParams))).toBe('NOT_BYTES');
    expect(keyCode(() => derive(wallet.signatureHex as unknown as Uint8Array, messageParams))).toBe('NOT_BYTES');
    expect(yOf(derive(Buffer.from(signature), messageParams))).toBe(wallet.Y);
  });

  it('refuses a second signature that does not verify, or is not 64 bytes, before deriving anything', () => {
    const flipped = signature.slice();
    flipped[9] = (flipped[9] ?? 0) ^ 0x04;
    vi.mocked(deriveSk).mockClear();
    expect(keyCode(() => deriveFromWalletSignatures(signature, flipped, messageParams))).toBe('BAD_SIGNATURE');
    expect(keyCode(() => deriveFromWalletSignatures(flipped, signature, messageParams))).toBe('BAD_SIGNATURE');
    expect(keyCode(() => deriveFromWalletSignatures(signature, signature.slice(0, 63), messageParams))).toBe('SIGNATURE_LENGTH');
    expect(deriveSk).not.toHaveBeenCalled();
    expect(yOf(deriveFromWalletSignatures(signature, signature.slice(), messageParams))).toBe(wallet.Y);
  });

  it('refuses bad message parameters before checking the signature', () => {
    expect(keyCode(() => derive(signature, { ...messageParams, token: wallet.account }))).toBe('TOKEN');
    expect(keyCode(() => derive(signature, { ...messageParams, account: prf.account }))).toBe('ACCOUNT');
    expect(keyCode(() => derive(signature, { ...messageParams, domain: 'https://kalypso-payroll.vercel.app' }))).toBe('DOMAIN');
    expect(keyCode(() => derive(signature, { ...messageParams, network: 'public' as 'testnet' }))).toBe('NETWORK');
  });

  it('never puts key material in an error', () => {
    const flipped = signature.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    for (const bad of [signature.slice(0, 63), flipped]) {
      try {
        derive(bad, messageParams);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(KeyError);
        const text = `${String(err)} ${JSON.stringify(err)}`;
        expect(text).not.toContain(toHex(bad).slice(0, 16));
        expect(text).not.toContain(wallet.signatureHex.slice(2, 18));
        expect(text).not.toContain(Buffer.from(bad.slice(0, 12)).toString('base64'));
      }
    }
  });
});

describe('requireReproducible (C15)', () => {
  it('accepts the same 64 bytes twice, as a deterministic wallet signs, from any byte view', () => {
    const again = signWith(testWallet, wallet.message);
    expect(toHex(again)).toBe(wallet.signatureHex);
    expect(keyCode(() => requireReproducible(signature, again))).toBeUndefined();
    expect(keyCode(() => requireReproducible(Buffer.from(signature), signature.slice()))).toBeUndefined();
  });

  it.each<[string, () => [unknown, unknown]]>([
    ['two signatures one bit apart', () => { const s = signature.slice(); s[63] = (s[63] ?? 0) ^ 0x01; return [signature, s]; }],
    ['a signature by another wallet', () => [signature, signWith(seededWallet('another wallet'), wallet.message)]],
    ['the same 63 bytes twice', () => [signature.slice(0, 63), signature.slice(0, 63)]],
    ['the same 65 bytes twice', () => [new Uint8Array(65).fill(7), new Uint8Array(65).fill(7)]],
    ['a 64-byte signature and a longer one that starts with it', () => [signature, new Uint8Array([...signature, 0])]],
    ['plain arrays', () => [[...signature], [...signature]]],
    ['hex strings', () => [wallet.signatureHex, wallet.signatureHex]],
    ['nothing', () => [undefined, undefined]],
  ])('refuses %s with NOT_REPRODUCIBLE', (_label, make) => {
    const [first, second] = make();
    expect(keyCode(() => requireReproducible(first as Uint8Array, second as Uint8Array))).toBe('NOT_REPRODUCIBLE');
  });

  it('tells the user to use a deterministic wallet, without any signature bytes in the message', () => {
    const flipped = signature.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    try {
      requireReproducible(signature, flipped);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(
        'This wallet gave two different signatures for the same message, so it cannot rebuild your key next time. Use a wallet that signs deterministically, such as Freighter.',
      );
      expect(`${String(err)} ${JSON.stringify(err)}`).not.toContain(wallet.signatureHex.slice(2, 18));
    }
  });
});

describe('requirePrfOutput', () => {
  it('reads prf.results.first as an ArrayBuffer or a view, and returns a copy', () => {
    const buffer = prfOutput.slice().buffer;
    expect(requirePrfOutput({ prf: { results: { first: buffer } } })).toEqual(prfOutput);

    const padded = new Uint8Array(48);
    padded.set(prfOutput, 8);
    const view = padded.subarray(8, 40);
    const result = requirePrfOutput({ prf: { enabled: true, results: { first: view } } });
    expect(result).toEqual(prfOutput);
    padded.fill(0);
    expect(result).toEqual(prfOutput);
  });

  it.each<[string, unknown, PrfUnavailableReason]>([
    ['no extension results', undefined, 'MISSING'],
    ['null', null, 'MISSING'],
    ['no prf entry', {}, 'MISSING'],
    ['prf enabled but no results', { prf: { enabled: true } }, 'MISSING'],
    ['results without first', { prf: { results: {} } }, 'MISSING'],
    ['a base64 string', { prf: { results: { first: 'eYQuRvp3dFT1sS/PYn555KQNvFQ88q8hPgno2J7w2fM=' } } }, 'MISSING'],
    ['a plain array', { prf: { results: { first: Array.from({ length: 32 }, () => 1) } } }, 'MISSING'],
    ['16 bytes', { prf: { results: { first: new Uint8Array(16).fill(1).buffer } } }, 'WRONG_LENGTH'],
    ['64 bytes', { prf: { results: { first: new Uint8Array(64).fill(1) } } }, 'WRONG_LENGTH'],
    ['all zero', { prf: { results: { first: new ArrayBuffer(32) } } }, 'ALL_ZERO'],
  ])('refuses %s, never falling back', (_label, ext, reason) => {
    expect(prfReason(() => requirePrfOutput(ext))).toBe(reason);
  });

  it('tells the user to use PRF or Freighter, without any bytes in the message', () => {
    try {
      requirePrfOutput({ prf: { results: { first: new Uint8Array(16).fill(0xab) } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PrfUnavailableError);
      expect((err as Error).message).toContain('Freighter');
      expect((err as Error).message.toLowerCase()).not.toContain('abab');
    }
  });
});

describe('deriveFromPrf', () => {
  it('derives the cash-out seed with HKDF-SHA256 as specified, checked against node:crypto', () => {
    const keys = deriveFromPrf(prfOutput, prf.token, prf.account);
    const expected = Buffer.from(hkdfSync('sha256', prfOutput, Buffer.from('kalypso/v1'), Buffer.from('cashout-g'), 32));
    expect(toHex(keys.cashout.secretSeed)).toBe(expected.toString('hex'));
    expect(StrKey.isValidEd25519PublicKey(keys.cashout.publicKey)).toBe(true);
    expect(Keypair.fromRawEd25519Seed(Buffer.from(keys.cashout.secretSeed)).publicKey()).toBe(keys.cashout.publicKey);
  });

  it('is reproducible and depends on the PRF output', () => {
    const a = deriveFromPrf(prfOutput, prf.token, prf.account);
    const b = deriveFromPrf(prfOutput.slice(), prf.token, prf.account);
    expect(pointToBytes(b.Y)).toEqual(pointToBytes(a.Y));
    const flipped = prfOutput.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const c = deriveFromPrf(flipped, prf.token, prf.account);
    expect(pointToBytes(c.Y)).not.toEqual(pointToBytes(a.Y));
    expect(c.cashout.publicKey).not.toBe(a.cashout.publicKey);
  });

  it('accepts a G account as well as a C passkey wallet', () => {
    const keys = deriveFromPrf(prfOutput, prf.token, wallet.account);
    expect(keys.acctF).toBe(addressToField(wallet.account));
  });

  it('refuses bad PRF bytes, a token that is not a contract, and a muxed account', () => {
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 3));
    expect(keyCode(() => deriveFromPrf(prfOutput.slice(0, 31), prf.token, prf.account))).toBe('PRF_OUTPUT_LENGTH');
    expect(keyCode(() => deriveFromPrf(new Uint8Array(32), prf.token, prf.account))).toBe('ALL_ZERO');
    expect(keyCode(() => deriveFromPrf(prfOutput.buffer as unknown as Uint8Array, prf.token, prf.account))).toBe('NOT_BYTES');
    expect(keyCode(() => deriveFromPrf(prfOutput, wallet.account, prf.account))).toBe('TOKEN');
    expect(keyCode(() => deriveFromPrf(prfOutput, prf.token, muxed))).toBe('ACCOUNT');
  });
});

describe('no output channels', () => {
  it('derives keys without logging or calling the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    walletKeyMessage(messageParams);
    derive(signature, messageParams);
    deriveFromPrf(requirePrfOutput({ prf: { results: { first: prfOutput.slice().buffer } } }), prf.token, prf.account);
    const flipped = signature.slice();
    flipped[5] = (flipped[5] ?? 0) ^ 0x02;
    for (const fn of [
      () => requirePrfOutput({}),
      () => derive(new Uint8Array(3), messageParams),
      () => derive(flipped, messageParams),
    ]) {
      expect(fn).toThrow();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

// Does NOT cover: whether an address is on a company's roster or registered with the token.
// Those need the chain and are checked by the console, not by this parser.
import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { AddressError, parseAccount, sameAccount, type AddressErrorCode } from '../src/addresses.js';

const bytes = (fill: number, length = 32) => Buffer.alloc(length, fill);

const G = StrKey.encodeEd25519PublicKey(bytes(1));
const G_OTHER = StrKey.encodeEd25519PublicKey(bytes(2));
const C = StrKey.encodeContract(bytes(1));
const M = StrKey.encodeMed25519PublicKey(Buffer.concat([bytes(1), bytes(0, 8)]));
const S = StrKey.encodeEd25519SecretSeed(bytes(7));
const T = StrKey.encodePreAuthTx(bytes(1));

function flipLastChar(address: string): string {
  const last = address.at(-1) === 'A' ? 'B' : 'A';
  return address.slice(0, -1) + last;
}

function codeOf(fn: () => unknown): AddressErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof AddressError) return err.code;
    throw err;
  }
  return undefined;
}

describe('parseAccount', () => {
  it('accepts a G account and a C contract, trimming surrounding whitespace only', () => {
    expect(parseAccount(G)).toEqual({ kind: 'G', address: G });
    expect(parseAccount(C)).toEqual({ kind: 'C', address: C });
    expect(parseAccount(`  ${G}\r\n`)).toEqual({ kind: 'G', address: G });
    expect(parseAccount(`\t${C} `)).toEqual({ kind: 'C', address: C });
  });

  it.each<[string, string, AddressErrorCode]>([
    ['an empty string', '', 'EMPTY'],
    ['only whitespace', ' \t ', 'EMPTY'],
    ['a muxed M address', M, 'MUXED_NOT_ALLOWED'],
    ['a secret seed', S, 'LOOKS_LIKE_SECRET'],
    ['a secret seed with a typo in it', flipLastChar(S), 'LOOKS_LIKE_SECRET'],
    ['a G address with a broken checksum', flipLastChar(G), 'INVALID'],
    ['a lowercase G address', G.toLowerCase(), 'INVALID'],
    ['a pre-auth transaction hash (T)', T, 'INVALID'],
    ['an address with a space inside', `${G.slice(0, 20)} ${G.slice(20)}`, 'INVALID'],
    ['an address with a zero-width space', `${G}\u200b`, 'INVALID'],
    ['a truncated address', G.slice(0, 55), 'INVALID'],
    ['an Ethereum address', '0x52908400098527886E0F7030069857D2E4169EE7', 'INVALID'],
    ['a federation address', 'alice*example.com', 'INVALID'],
  ])('refuses %s', (_label, input, code) => {
    expect(codeOf(() => parseAccount(input))).toBe(code);
  });

  it('never repeats a secret seed in the error, not even part of it', () => {
    for (const secret of [S, flipLastChar(S), ` ${S} `]) {
      try {
        parseAccount(secret);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AddressError);
        const text = `${(err as Error).message} ${String(err)} ${JSON.stringify(err)}`;
        expect(text).not.toContain(S);
        expect(text).not.toContain(S.slice(1, 20));
        expect(text).not.toContain(S.slice(-20));
      }
    }
  });

  it('refuses values that are not strings', () => {
    expect(codeOf(() => parseAccount(42 as unknown as string))).toBe('INVALID');
    expect(codeOf(() => parseAccount(null as unknown as string))).toBe('INVALID');
  });
});

describe('sameAccount', () => {
  it('matches the same account written with different surrounding whitespace', () => {
    expect(sameAccount(G, ` ${G}\n`)).toBe(true);
    expect(sameAccount(C, C)).toBe(true);
  });

  it('tells different accounts apart, including a G and a C built from the same bytes', () => {
    expect(sameAccount(G, G_OTHER)).toBe(false);
    expect(sameAccount(G, C)).toBe(false);
  });

  it('throws rather than answering when either side is not an account', () => {
    expect(codeOf(() => sameAccount(G, M))).toBe('MUXED_NOT_ALLOWED');
    expect(codeOf(() => sameAccount('', G))).toBe('EMPTY');
    expect(codeOf(() => sameAccount(G, G.toLowerCase()))).toBe('INVALID');
  });
});

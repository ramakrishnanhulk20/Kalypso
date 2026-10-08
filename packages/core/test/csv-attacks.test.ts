// A malicious or careless employer CSV against src/csv.ts, src/amounts.ts and src/addresses.ts.
// Does NOT cover: the roster and registration checks, which need the chain (the engine does
// them), or how the UI renders a name.
import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { parseAccount, type AddressErrorCode } from '../src/addresses.js';
import { MAX_STROOPS, parseUsdc, type AmountErrorCode } from '../src/amounts.js';
import { parsePayrollCsv, toSafeCsvCell, type CsvError, type CsvErrorCode } from '../src/csv.js';

const gAddress = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const A = gAddress(0x61);
const B = gAddress(0x62);
const C = StrKey.encodeContract(Buffer.alloc(32, 0x61));
const M = StrKey.encodeMed25519PublicKey(Buffer.concat([Buffer.alloc(32, 0x61), Buffer.alloc(8)]));
const codes = (errors: CsvError[]) => errors.map(({ line, code }) => ({ line, code }));

function amountCode(input: string): AmountErrorCode | 'ACCEPTED' {
  try {
    parseUsdc(input);
    return 'ACCEPTED';
  } catch (err) {
    return (err as { code: AmountErrorCode }).code;
  }
}

function addressCode(input: string): AddressErrorCode | 'ACCEPTED' {
  try {
    parseAccount(input);
    return 'ACCEPTED';
  } catch (err) {
    return (err as { code: AddressErrorCode }).code;
  }
}

describe('spreadsheet formula injection', () => {
  it.each<[string, string, CsvErrorCode]>([
    ['a HYPERLINK formula with quotes as the address', `=HYPERLINK("https://evil.example","pay"),10`, 'QUOTE'],
    ['a bare formula as the address', `=1+1,10`, 'ADDRESS_INVALID'],
    ['a formula as the amount', `${A},=1+1`, 'AMOUNT_NOT_A_NUMBER'],
    ['a DDE launch as the amount', `${A},=cmd|' /C calc'!A0`, 'AMOUNT_NOT_A_NUMBER'],
    ['an @ formula as the amount', `${A},@SUM(1)`, 'AMOUNT_NOT_A_NUMBER'],
    ['a plus formula as the amount', `${A},+10`, 'AMOUNT_NOT_A_NUMBER'],
    ['a minus formula as the amount', `${A},-1+11`, 'AMOUNT_NEGATIVE'],
  ])('refuses %s', (_label, text, code) => {
    const { rows, errors } = parsePayrollCsv(text);
    expect(rows).toEqual([]);
    expect(codes(errors)).toEqual([{ line: 1, code }]);
  });

  it('refuses to let a formula name reach an export unneutralised, even behind leading blanks', () => {
    const names = ['=cmd|\' /C calc\'!A0', ' =1+1', ' +1', '\t@SUM(A1)', '-1', '\r=x'];
    const text = names.map((name, i) => `${gAddress(0x70 + i)},1,"${name.replace(/"/g, '""')}"`).join('\n');
    const { rows, errors } = parsePayrollCsv(text);
    // The name is trimmed first, so a leading blank, tab or carriage return never hides the formula start.
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.nameLooksLikeFormula)).toEqual(Array(6).fill(true));
    for (const row of rows) expect(toSafeCsvCell(row.name as string).replace(/^"/, '').startsWith("'")).toBe(true);
  });
});

describe('addresses that look right to a person', () => {
  it.each<[string, string]>([
    ['a Cyrillic capital A in place of the first letter', `А${A.slice(1)}`],
    ['a fullwidth G', `Ｇ${A.slice(1)}`],
    ['a mathematical bold G', `\u{1D406}${A.slice(1)}`],
    ['a zero-width non-joiner inside', `${A.slice(0, 10)}‌${A.slice(10)}`],
    ['a soft hyphen inside', `${A.slice(0, 10)}­${A.slice(10)}`],
    ['a combining mark after the last character', `${A}́`],
    ['a digit 0 for a letter', A.replace(/[A-Z]/, '0')],
    ['a digit 1 for a letter', A.replace(/[A-Z]/, '1')],
    ['a digit 8 for a letter', A.replace(/[A-Z]/, '8')],
    ['one character transposed', `${A.slice(0, 20)}${A[21]}${A[20]}${A.slice(22)}`],
    ['the right bytes with the wrong version byte (a pre-auth T address)', StrKey.encodePreAuthTx(Buffer.alloc(32, 0x61))],
    ['a muxed form of the same account', M],
  ])('refuses %s', (_label, input) => {
    expect(addressCode(input)).not.toBe('ACCEPTED');
    expect(codes(parsePayrollCsv(`${input},10`).errors)).toEqual([{ line: 1, code: expect.stringMatching(/^ADDRESS_/) }]);
  });

  it('accepts a G and a C built from the same 32 bytes as two different workers', () => {
    const { rows, errors } = parsePayrollCsv(`${A},1\n${C},2`);
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.kind)).toEqual(['G', 'C']);
  });

  it('refuses the same worker written with different surrounding blanks, quotes or a byte order mark', () => {
    // U+FEFF and U+00A0 are blank to the address decoder, so each spelling decodes to the same account.
    const { rows, errors } = parsePayrollCsv(`${A},1\n"${A}",2\n ${A} ,3\n﻿${A},4`);
    expect(rows.map((row) => row.line)).toEqual([1]);
    expect(codes(errors)).toEqual([
      { line: 2, code: 'DUPLICATE' },
      { line: 3, code: 'DUPLICATE' },
      { line: 4, code: 'DUPLICATE' },
    ]);
  });
});

describe('amounts that would move the wrong number of stroops', () => {
  it.each<[string, AmountErrorCode | 'ACCEPTED']>([
    ['-0', 'NEGATIVE'],
    ['−5', 'NOT_A_NUMBER'],
    ['5٫5', 'NOT_A_NUMBER'],
    ['١٠', 'NOT_A_NUMBER'],
    ['１０', 'NOT_A_NUMBER'],
    ['1 000', 'SEPARATOR'],
    ['1 000', 'SEPARATOR'],
    ['0.1e1', 'EXPONENT'],
    ['1E0', 'EXPONENT'],
    ['0.00000005', 'TOO_MANY_DECIMALS'],
    ['1.00000000', 'TOO_MANY_DECIMALS'],
    ['9223372036854775807', 'TOO_LARGE'],
    ['922337203685.4775808', 'TOO_LARGE'],
    ['922337203685.4775807', 'ACCEPTED'],
    ['0000922337203685.4775807', 'ACCEPTED'],
    ['1.', 'NOT_A_NUMBER'],
    ['.5', 'NOT_A_NUMBER'],
    ['1..5', 'SEPARATOR'],
    ['0x10', 'NOT_A_NUMBER'],
    ['1,5', 'SEPARATOR'],
    ['​10', 'NOT_A_NUMBER'],
    ['10​', 'NOT_A_NUMBER'],
  ])('%j is %s', (input, expected) => {
    expect(amountCode(input)).toBe(expected);
  });

  it('parses the largest amount to exactly the token ceiling and never above it', () => {
    expect(parseUsdc('922337203685.4775807')).toBe(MAX_STROOPS);
    expect(amountCode('922337203685.47758070')).toBe('TOO_MANY_DECIMALS');
  });

  it('refuses a thousands separator however the cells fall', () => {
    const { rows, errors } = parsePayrollCsv([`${A},1,000`, `${B},1,000,000`, `${gAddress(0x63)},"1,000"`, `${gAddress(0x64)}, 1 000`, `${gAddress(0x65)},1.000,50`].join('\n'));
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(['AMOUNT_SPLIT', 'EXTRA_COLUMN', 'AMOUNT_SEPARATOR', 'AMOUNT_SEPARATOR', 'AMOUNT_SPLIT']);
  });
});

describe('file shapes from other tools', () => {
  it('refuses semicolon and tab separated files instead of guessing a delimiter', () => {
    expect(codes(parsePayrollCsv(`${A};10;Ana`).errors)).toEqual([{ line: 1, code: 'MISSING_COLUMN' }]);
    expect(codes(parsePayrollCsv(`${A}\t10`).errors)).toEqual([{ line: 1, code: 'MISSING_COLUMN' }]);
  });

  it('treats a byte order mark anywhere around an address as blank, so a doubled or mid-file mark still decodes to the canonical address', () => {
    for (const text of [`﻿${A},10`, `﻿﻿${A},10`, `${B},5\n﻿${A},10`]) {
      const { rows, errors } = parsePayrollCsv(text);
      expect(errors).toEqual([]);
      expect(rows.at(-1)?.address).toBe(A);
    }
  });

  it('refuses a header that hides a formula only as a header, never as a row', () => {
    const { rows, errors } = parsePayrollCsv(`=address,=amount\n${A},10`);
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.line)).toEqual([2]);
  });

  it('refuses a secret seed and never echoes it, even with a typo', () => {
    const seed = StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 0x42));
    const typo = `${seed.slice(0, -1)}${seed.endsWith('A') ? 'B' : 'A'}`;
    const { errors } = parsePayrollCsv(`${seed},10\n${typo},10`);
    expect(errors.map((e) => e.code)).toEqual(['ADDRESS_LOOKS_LIKE_SECRET', 'ADDRESS_LOOKS_LIKE_SECRET']);
    expect(JSON.stringify(errors)).not.toContain(seed.slice(1, 12));
  });
});

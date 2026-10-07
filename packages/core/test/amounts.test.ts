// Does NOT cover: how amounts are shown in the UI, or whether an amount is the right salary.
// The fuzz cases are seeded, so a failure always reproduces with the same inputs.
import { describe, expect, it } from 'vitest';
import { AmountError, MAX_STROOPS, USDC_DECIMALS, formatUsdc, parseUsdc, type AmountErrorCode } from '../src/amounts.js';

function codeOf(fn: () => unknown): AmountErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof AmountError) return err.code;
    throw err;
  }
  return undefined;
}

// splitmix64, so the fuzz cases are the same on every run and every machine.
function seededBigints(seed: bigint) {
  let state = seed;
  const mask = (1n << 64n) - 1n;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & mask;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return z ^ (z >> 31n);
  };
}

describe('parseUsdc', () => {
  it('reads whole and decimal amounts into integer stroops', () => {
    expect(USDC_DECIMALS).toBe(7);
    expect(parseUsdc('1')).toBe(10_000_000n);
    expect(parseUsdc('1234.5')).toBe(12_345_000_000n);
    expect(parseUsdc('0.0000001')).toBe(1n);
    expect(parseUsdc('1.1234567')).toBe(11_234_567n);
    expect(parseUsdc('0042.10')).toBe(421_000_000n);
    expect(parseUsdc('  2500.75\t')).toBe(25_007_500_000n);
  });

  it('accepts the largest amount the token can hold and nothing above it', () => {
    expect(parseUsdc('922337203685.4775807')).toBe(MAX_STROOPS);
    expect(MAX_STROOPS).toBe(2n ** 63n - 1n);
    expect(codeOf(() => parseUsdc('922337203685.4775808'))).toBe('TOO_LARGE');
    expect(codeOf(() => parseUsdc('1' + '0'.repeat(30)))).toBe('TOO_LARGE');
    expect(parseUsdc('0'.repeat(40) + '1')).toBe(10_000_000n);
  });

  it.each<[string, AmountErrorCode]>([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['+1', 'NOT_A_NUMBER'],
    ['abc', 'NOT_A_NUMBER'],
    ['.5', 'NOT_A_NUMBER'],
    ['1.', 'NOT_A_NUMBER'],
    ['0x10', 'NOT_A_NUMBER'],
    ['Infinity', 'NOT_A_NUMBER'],
    ['NaN', 'NOT_A_NUMBER'],
    ['\uff11\uff10', 'NOT_A_NUMBER'],
    ['$100', 'NOT_A_NUMBER'],
    ['-1', 'NEGATIVE'],
    ['-0.5', 'NEGATIVE'],
    ['- 3', 'NEGATIVE'],
    ['0', 'ZERO'],
    ['000', 'ZERO'],
    ['0.0000000', 'ZERO'],
    ['1.12345678', 'TOO_MANY_DECIMALS'],
    ['0.00000001', 'TOO_MANY_DECIMALS'],
    ['1e3', 'EXPONENT'],
    ['1E-7', 'EXPONENT'],
    ['2.5e2', 'EXPONENT'],
    ['1,000', 'SEPARATOR'],
    ['1,000.50', 'SEPARATOR'],
    ['1 000', 'SEPARATOR'],
    ['1_000', 'SEPARATOR'],
    ["1'000", 'SEPARATOR'],
    ['1.000.000', 'SEPARATOR'],
    ['1.000,50', 'SEPARATOR'],
    ['1,5', 'SEPARATOR'],
  ])('refuses %j with %s', (input, code) => {
    expect(codeOf(() => parseUsdc(input))).toBe(code);
  });

  it('never repeats the amount in the error message', () => {
    for (const input of ['1,234.56', '-1234.56', '1234.123456789', '1.23456e3']) {
      try {
        parseUsdc(input);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AmountError);
        const message = (err as Error).message;
        expect(message).not.toContain(input);
        expect(message).not.toContain('1234');
      }
    }
  });

  it('refuses values that are not strings', () => {
    expect(codeOf(() => parseUsdc(100 as unknown as string))).toBe('NOT_A_NUMBER');
    expect(codeOf(() => parseUsdc(undefined as unknown as string))).toBe('NOT_A_NUMBER');
  });

  it('refuses a very long pasted value quickly', () => {
    const started = Date.now();
    expect(codeOf(() => parseUsdc('1'.repeat(1_000_000) + 'x'))).toBe('NOT_A_NUMBER');
    expect(codeOf(() => parseUsdc('9'.repeat(1_000_000)))).toBe('TOO_LARGE');
    expect(codeOf(() => parseUsdc('1' + '0'.repeat(1_000_000) + 'e5'))).toBe('EXPONENT');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('formatUsdc', () => {
  it('writes stroops as USDC with trailing zeros trimmed', () => {
    expect(formatUsdc(12_345_000_000n)).toBe('1234.5');
    expect(formatUsdc(1n)).toBe('0.0000001');
    expect(formatUsdc(10_000_000n)).toBe('1');
    expect(formatUsdc(0n)).toBe('0');
    expect(formatUsdc(MAX_STROOPS)).toBe('922337203685.4775807');
  });

  it('refuses amounts that are not money', () => {
    expect(codeOf(() => formatUsdc(-1n))).toBe('NEGATIVE');
    expect(codeOf(() => formatUsdc(MAX_STROOPS + 1n))).toBe('TOO_LARGE');
    expect(codeOf(() => formatUsdc(5 as unknown as bigint))).toBe('NOT_A_NUMBER');
  });
});

describe('round trip (seeded fuzz)', () => {
  it('formatUsdc then parseUsdc returns the same stroops across the whole range', () => {
    const next = seededBigints(0x6d697374686f73n);
    for (let i = 0; i < 20_000; i++) {
      // Mix full-range values with small ones so short decimals get exercised too.
      const raw = next();
      const value = i % 2 === 0 ? (raw % MAX_STROOPS) + 1n : (raw % 100_000_000_000n) + 1n;
      expect(parseUsdc(formatUsdc(value))).toBe(value);
    }
  });

  it('parseUsdc then formatUsdc gives the canonical spelling of any valid input', () => {
    const next = seededBigints(42n);
    for (let i = 0; i < 20_000; i++) {
      const whole = (next() % 1_000_000_000_000n).toString();
      const places = Number(next() % 8n);
      const fraction = places === 0 ? '' : (next() % 10n ** BigInt(places)).toString().padStart(places, '0');
      const leadingZeros = '0'.repeat(Number(next() % 3n));
      const input = fraction === '' ? leadingZeros + whole : `${leadingZeros}${whole}.${fraction}`;

      const expectedStroops = BigInt(whole) * 10_000_000n + BigInt((fraction || '0').padEnd(7, '0'));
      if (expectedStroops === 0n) {
        expect(codeOf(() => parseUsdc(input))).toBe('ZERO');
        continue;
      }
      if (expectedStroops > MAX_STROOPS) {
        expect(codeOf(() => parseUsdc(input))).toBe('TOO_LARGE');
        continue;
      }
      const stroops = parseUsdc(input);
      expect(stroops).toBe(expectedStroops);
      const trimmedFraction = fraction.replace(/0+$/, '');
      expect(formatUsdc(stroops)).toBe(trimmedFraction === '' ? whole : `${whole}.${trimmedFraction}`);
    }
  });
});

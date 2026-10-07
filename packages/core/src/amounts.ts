/** USDC on Stellar has 7 decimal places. One stroop is 0.0000001 USDC. */
export const USDC_DECIMALS = 7;

/** An amount in integer stroops. Always a bigint, never a Number, so no value is ever rounded. */
export type Stroops = bigint;

/**
 * The largest amount the token can hold, 2^63 - 1 stroops. Decrypted amounts outside
 * [0, MAX_STROOPS] are not money (threat model C19), so this is also the display ceiling.
 */
export const MAX_STROOPS: Stroops = 9223372036854775807n;

export type AmountErrorCode =
  | 'EMPTY'
  | 'NOT_A_NUMBER'
  | 'NEGATIVE'
  | 'ZERO'
  | 'TOO_MANY_DECIMALS'
  | 'EXPONENT'
  | 'SEPARATOR'
  | 'TOO_LARGE';

// Messages never repeat the input: an amount is a salary, and error text ends up in logs.
const AMOUNT_MESSAGES: Record<AmountErrorCode, string> = {
  EMPTY: 'The amount is empty.',
  NOT_A_NUMBER: 'The amount is not a plain number. Use digits with an optional dot, like 1250.50.',
  NEGATIVE: 'The amount is negative. Pay amounts must be above zero.',
  ZERO: 'The amount is zero. Pay amounts must be above zero.',
  TOO_MANY_DECIMALS: 'The amount has more than 7 decimal places. USDC stops at 0.0000001.',
  EXPONENT: 'The amount is written in scientific notation, like 1e3. Write the full number.',
  SEPARATOR: 'The amount has a thousands separator or a comma. Write 1000.50, not 1,000.50.',
  TOO_LARGE: 'The amount is larger than the token can hold (922337203685.4775807 USDC).',
};

export class AmountError extends Error {
  readonly code: AmountErrorCode;

  constructor(code: AmountErrorCode) {
    super(AMOUNT_MESSAGES[code]);
    this.name = 'AmountError';
    this.code = code;
  }
}

const VALID_AMOUNT = /^(\d+)(?:\.(\d{1,7}))?$/;

// The patterns below only choose which reason to show. Anything VALID_AMOUNT does not
// match is refused whatever its label, so a gap in these labels can never let a value through.
// Each one is written so it cannot backtrack, because a pasted cell can be very long.
const LOOKS_EXPONENT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/;
const LOOKS_NEGATIVE = /^-\s*\.?\d/;
const LOOKS_SEPARATED = /^[+-]?[\d.,_'\s]+$/;
const HAS_SEPARATOR = /[,_'\s]|\..*\./;
const LOOKS_TOO_PRECISE = /^\d+\.\d{8,}$/;

// The ceiling's whole-USDC part has 12 digits. Checking the digit count first keeps a
// million-digit input from ever reaching BigInt.
const MAX_WHOLE_DIGITS = 12;

function reasonForRejected(text: string): AmountErrorCode {
  if (LOOKS_NEGATIVE.test(text)) return 'NEGATIVE';
  if (LOOKS_EXPONENT.test(text)) return 'EXPONENT';
  if (LOOKS_TOO_PRECISE.test(text)) return 'TOO_MANY_DECIMALS';
  if (LOOKS_SEPARATED.test(text) && /\d/.test(text) && HAS_SEPARATOR.test(text)) return 'SEPARATOR';
  return 'NOT_A_NUMBER';
}

/**
 * Parses a USDC amount typed by a person or read from a spreadsheet into integer stroops.
 * This is the only amount parser in Kalypso: the confirmation screen, the proof input, the
 * after-payment check and the export all use the value it returns.
 *
 * Accepts, after trimming whitespace: one or more ASCII digits, optionally followed by a dot
 * and 1 to 7 digits. Leading zeros are allowed.
 *
 * @throws AmountError with code EMPTY, NOT_A_NUMBER (including a leading "+", a bare dot or
 *   non-ASCII digits), NEGATIVE, ZERO, TOO_MANY_DECIMALS, EXPONENT, SEPARATOR or TOO_LARGE
 *   (above 9223372036854775807 stroops). The error message never contains the input.
 */
export function parseUsdc(input: string): Stroops {
  if (typeof input !== 'string') throw new AmountError('NOT_A_NUMBER');
  const text = input.trim();
  if (text === '') throw new AmountError('EMPTY');

  const match = VALID_AMOUNT.exec(text);
  if (!match) throw new AmountError(reasonForRejected(text));

  const whole = (match[1] ?? '').replace(/^0+(?=\d)/, '');
  if (whole.length > MAX_WHOLE_DIGITS) throw new AmountError('TOO_LARGE');
  const fraction = (match[2] ?? '').padEnd(USDC_DECIMALS, '0');

  const stroops = BigInt(whole + fraction);
  if (stroops === 0n) throw new AmountError('ZERO');
  if (stroops > MAX_STROOPS) throw new AmountError('TOO_LARGE');
  return stroops;
}

/**
 * Formats integer stroops as a USDC string with trailing zeros trimmed: 12345000000n is
 * "1234.5", 1n is "0.0000001", 0n is "0". No thousands separators, so the output always
 * parses back to the same value with parseUsdc (zero excepted, which parseUsdc refuses).
 *
 * @throws AmountError NOT_A_NUMBER when given anything but a bigint, NEGATIVE below zero,
 *   TOO_LARGE above MAX_STROOPS. Out-of-range values are never shown as money.
 */
export function formatUsdc(s: Stroops): string {
  if (typeof s !== 'bigint') throw new AmountError('NOT_A_NUMBER');
  if (s < 0n) throw new AmountError('NEGATIVE');
  if (s > MAX_STROOPS) throw new AmountError('TOO_LARGE');

  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = (s / scale).toString();
  const fraction = (s % scale).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

import { bytesToUtf8, utf8ToBytes } from '@noble/hashes/utils.js';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk/base';
import { AddressError, parseAccount, type AccountKind } from '../addresses.js';

/**
 * A value read from the chain did not have the exact shape the contract defines. Reads fail
 * closed: a decoder never guesses, skips an unknown field or fills in a missing one.
 */
export class DecodeError extends Error {
  constructor(what: string) {
    super(`The chain returned a value Kalypso does not recognise: ${what}.`);
    this.name = 'DecodeError';
  }
}

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const I128_MAX = (1n << 127n) - 1n;

export function requireU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError(`${label} must be a whole number from 0 to ${U32_MAX}`);
  return value;
}

export function requireU64(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new RangeError(`${label} must be a bigint from 0 to 2^64 - 1`);
  return value;
}

export function requirePositiveI128(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > I128_MAX) throw new RangeError(`${label} must be a positive bigint`);
  return value;
}

/** Decodes with parseAccount, the one address parser, and checks the kind. */
export function requireAccount(value: string, kinds: readonly AccountKind[]): string {
  const parsed = parseAccount(value);
  if (!kinds.includes(parsed.kind)) throw new AddressError('INVALID');
  return parsed.address;
}

/** A label's length in UTF-8 bytes, which is what Soroban's String length counts. */
export function utf8Length(text: string): number {
  return utf8ToBytes(text).length;
}

export const toScVal = {
  address: (account: string) => new Address(account).toScVal(),
  u32: (value: number) => xdr.ScVal.scvU32(value),
  u64: (value: bigint) => xdr.ScVal.scvU64(new xdr.Uint64(value)),
  i128: (value: bigint) => nativeToScVal(value, { type: 'i128' }),
  string: (text: string) => xdr.ScVal.scvString(text),
  bytes: (bytes: Uint8Array) => xdr.ScVal.scvBytes(bytes as Parameters<typeof xdr.ScVal.scvBytes>[0]),
};

function expectType(value: xdr.ScVal, type: string, what: string): void {
  if (value.switch().name !== type) throw new DecodeError(`${what} should be ${type}, got ${value.switch().name}`);
}

export function fromU32(value: xdr.ScVal, what: string): number {
  expectType(value, 'scvU32', what);
  return value.u32();
}

export function fromU64(value: xdr.ScVal, what: string): bigint {
  expectType(value, 'scvU64', what);
  return value.u64().toBigInt();
}

export function fromBool(value: xdr.ScVal, what: string): boolean {
  expectType(value, 'scvBool', what);
  return value.b();
}

export function fromString(value: xdr.ScVal, what: string): string {
  expectType(value, 'scvString', what);
  const raw = value.str();
  if (typeof raw === 'string') return raw;
  const bytes = new Uint8Array(raw);
  const text = bytesToUtf8(bytes);
  // A lenient decoder swaps bad bytes for U+FFFD, so a round trip that changes the bytes means
  // the stored string was not UTF-8.
  const again = utf8ToBytes(text);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) {
    throw new DecodeError(`${what} is not valid UTF-8`);
  }
  return text;
}

export function fromBytes(value: xdr.ScVal, what: string, length?: number): Uint8Array {
  expectType(value, 'scvBytes', what);
  const bytes = new Uint8Array(value.bytes());
  if (length !== undefined && bytes.length !== length) throw new DecodeError(`${what} should be ${length} bytes`);
  return bytes;
}

/** Decodes an address and normalises it through parseAccount, like every other address in Kalypso. */
export function fromAddress(value: xdr.ScVal, what: string): string {
  expectType(value, 'scvAddress', what);
  try {
    return requireAccount(Address.fromScVal(value).toString(), ['G', 'C']);
  } catch {
    throw new DecodeError(`${what} is not a G or C address`);
  }
}

export function fromVec(value: xdr.ScVal, what: string): xdr.ScVal[] {
  expectType(value, 'scvVec', what);
  const items = value.vec();
  if (items === null) throw new DecodeError(`${what} is an empty vector slot`);
  return items;
}

/**
 * Decodes a #[contracttype] struct, which Soroban encodes as a map with symbol keys. The map
 * must hold exactly the expected keys, no more and no fewer.
 */
export function fromStruct<K extends string>(value: xdr.ScVal, keys: readonly K[], what: string): Record<K, xdr.ScVal> {
  expectType(value, 'scvMap', what);
  const entries = value.map() ?? [];
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    const key = entry.key();
    if (key.switch().name !== 'scvSymbol') throw new DecodeError(`${what} has a non-symbol key`);
    const name = key.sym().toString();
    if (fields.has(name)) throw new DecodeError(`${what} repeats the field ${name}`);
    fields.set(name, entry.val());
  }
  if (fields.size !== keys.length || keys.some((key) => !fields.has(key))) {
    throw new DecodeError(`${what} does not have exactly the fields ${keys.join(', ')}`);
  }
  return Object.fromEntries(keys.map((key) => [key, fields.get(key)])) as Record<K, xdr.ScVal>;
}

/** An Option<T> return: void is None, anything else is Some. */
export function fromOption<T>(value: xdr.ScVal, decode: (inner: xdr.ScVal) => T): T | null {
  return value.switch().name === 'scvVoid' ? null : decode(value);
}

/** A #[repr(u32)] contracttype enum, which Soroban encodes as its u32 value. */
export function fromU32Enum<T extends string>(value: xdr.ScVal, variants: readonly T[], what: string): T {
  const index = fromU32(value, what);
  const variant = variants[index];
  if (variant === undefined) throw new DecodeError(`${what} has no variant ${index}`);
  return variant;
}

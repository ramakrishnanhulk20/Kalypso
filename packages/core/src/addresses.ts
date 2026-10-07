import { StrKey } from '@stellar/stellar-sdk/base';

/** G is an ed25519 account (Freighter and other wallets). C is a contract, such as a passkey wallet. */
export type AccountKind = 'G' | 'C';

export type AddressErrorCode = 'EMPTY' | 'MUXED_NOT_ALLOWED' | 'LOOKS_LIKE_SECRET' | 'INVALID';

// Messages never repeat the input. A pasted secret key must not reach a screen, a log or an error report.
const ADDRESS_MESSAGES: Record<AddressErrorCode, string> = {
  EMPTY: 'The address is empty.',
  MUXED_NOT_ALLOWED:
    'This is a muxed address (starts with M). Use the plain G address of the account, or the C address of a smart wallet.',
  LOOKS_LIKE_SECRET:
    'This looks like a secret key (starts with S), not an address. Never share it. Use the public G address instead.',
  INVALID: 'This is not a valid Stellar account address. It must be a G or C address with a correct checksum.',
};

export class AddressError extends Error {
  readonly code: AddressErrorCode;

  constructor(code: AddressErrorCode) {
    super(ADDRESS_MESSAGES[code]);
    this.name = 'AddressError';
    this.code = code;
  }
}

// Only used to choose a kinder reason. A mistyped secret fails StrKey's checksum yet is still
// a secret, so the shape alone earns the warning. Both paths refuse the value either way.
const SECRET_SHAPE = /^S[A-Z2-7]{55}$/;

/**
 * Decodes a Stellar account address. This is the only address parser in Kalypso: CSV rows,
 * rosters, event addresses and archive queries are all compared after passing through it.
 *
 * Only surrounding whitespace is removed. Validity is decided by the Stellar SDK's StrKey,
 * which checks the version byte, the length and the checksum, and accepts only the canonical
 * uppercase spelling. That covers whether the address is well formed; it does not cover
 * whether it belongs to the right person, which is the roster's job.
 *
 * @returns the kind (G or C) and the address exactly as StrKey accepts it.
 * @throws AddressError EMPTY; MUXED_NOT_ALLOWED for an M address; LOOKS_LIKE_SECRET for an S
 *   secret seed (the message never contains it); INVALID for anything else.
 */
export function parseAccount(input: string): { kind: AccountKind; address: string } {
  if (typeof input !== 'string') throw new AddressError('INVALID');
  const address = input.trim();
  if (address === '') throw new AddressError('EMPTY');

  if (StrKey.isValidEd25519PublicKey(address)) return { kind: 'G', address };
  if (StrKey.isValidContract(address)) return { kind: 'C', address };

  if (StrKey.isValidMed25519PublicKey(address)) throw new AddressError('MUXED_NOT_ALLOWED');
  if (StrKey.isValidEd25519SecretSeed(address) || SECRET_SHAPE.test(address)) {
    throw new AddressError('LOOKS_LIKE_SECRET');
  }
  throw new AddressError('INVALID');
}

/**
 * True when both inputs decode to the same account. Both sides go through parseAccount, so a
 * stray space cannot make one account look like two.
 *
 * @throws AddressError when either side is not a valid account. It never answers "different"
 *   for garbage, because a caller could read "different" as permission.
 */
export function sameAccount(a: string, b: string): boolean {
  return parseAccount(a).address === parseAccount(b).address;
}

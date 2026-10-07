import { Address, StrKey, xdr } from "@stellar/stellar-sdk";

/*
 * The one address parser the whole server uses. Config values, auth-tree
 * nodes, RPC event fields and archive URL parameters all pass through these
 * functions before they are compared, so two spellings of one address can
 * never be judged differently (threat model, general standard 2).
 *
 * Covers: checksum, version byte, length and canonical spelling (decoding and
 * re-encoding must give back the exact input). Does not cover whether the
 * address is the right party; the contracts and the roster decide that.
 */

export function canonicalContractId(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 56) return null;
  if (!StrKey.isValidContract(value)) return null;
  return StrKey.encodeContract(StrKey.decodeContract(value)) === value ? value : null;
}

/** A classic account (G) or a contract account (C). Muxed (M) and every other kind are refused. */
export function canonicalAccountId(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 56) return null;
  if (StrKey.isValidEd25519PublicKey(value)) {
    return StrKey.encodeEd25519PublicKey(StrKey.decodeEd25519PublicKey(value)) === value ? value : null;
  }
  return canonicalContractId(value);
}

export function contractIdOfScAddress(address: xdr.ScAddress): string | null {
  if (address.switch().name !== "scAddressTypeContract") return null;
  try {
    return canonicalContractId(Address.fromScAddress(address).toString());
  } catch {
    return null;
  }
}

/** The strkey of an address-typed ScVal, or null for any other ScVal. */
export function addressOfScVal(value: xdr.ScVal): string | null {
  if (value.switch().name !== "scvAddress") return null;
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return null;
  }
}

/**
 * Decodes base64 only when it is in its one canonical spelling. Node's decoder
 * silently skips characters it does not understand, so a lenient decode would
 * let two different strings stand for the same bytes, and the bytes we check
 * could differ from the bytes a downstream service decodes.
 */
export function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

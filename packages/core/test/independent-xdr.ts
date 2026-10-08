// Builds and reads XDR with raw constructors only, never with src/chain, so builder and decoder
// tests compare our code against a second, separate encoding of the same contract interface.
import { createHash } from 'node:crypto';
import { Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk/base';
import type { Point } from 'stellar-confidential-token-sdk';

export const PASSPHRASE = Networks.TESTNET;

export const raw = {
  address(account: string): xdr.ScVal {
    if (account.startsWith('G')) {
      return xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(account))),
      );
    }
    return xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(account) as never));
  },
  u32: (n: number) => xdr.ScVal.scvU32(n),
  u64: (n: bigint) => xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString())),
  i128: (n: bigint) =>
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString((n >> 64n).toString()),
        lo: xdr.Uint64.fromString((n & ((1n << 64n) - 1n)).toString()),
      }),
    ),
  bool: (b: boolean) => xdr.ScVal.scvBool(b),
  str: (s: string | Uint8Array) => xdr.ScVal.scvString(s as string),
  bytes: (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b)),
  vec: (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items),
  void: () => xdr.ScVal.scvVoid(),
  /** A #[contracttype] struct: symbol keys in ascending byte order, as the Soroban host requires. */
  struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
    const names = Object.keys(fields).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return xdr.ScVal.scvMap(names.map((name) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val: fields[name] as xdr.ScVal })));
  },
};

export interface RawCall {
  source: string;
  sequence: bigint;
  fee: number;
  maxTime: bigint;
  contractId: string;
  method: string;
  args: string[];
}

/** Reads the single contract call out of a base64 envelope with the XDR types directly. */
export function readEnvelope(b64: string): RawCall {
  const envelope = xdr.TransactionEnvelope.fromXDR(b64, 'base64');
  const tx = envelope.v1().tx();
  const ops = tx.operations();
  if (ops.length !== 1) throw new Error('expected one operation');
  const call = (ops[0] as xdr.Operation).body().invokeHostFunctionOp().hostFunction().invokeContract();
  const source = StrKey.encodeEd25519PublicKey(tx.sourceAccount().ed25519());
  const contract = call.contractAddress();
  return {
    source,
    sequence: BigInt(tx.seqNum().toString()),
    fee: tx.fee(),
    maxTime: BigInt(tx.cond().timeBounds().maxTime().toString()),
    contractId: StrKey.encodeContract(Buffer.from(contract.contractId() as unknown as Uint8Array)),
    method: call.functionName().toString(),
    args: call.args().map((a) => a.toXDR('base64')),
  };
}

export const b64 = (v: xdr.ScVal) => v.toXDR('base64');

/** Deterministic test accounts, so failures are reproducible. Testnet only, no funds. */
export function testAccount(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(createHash('sha256').update(label, 'utf8').digest());
}

export const testContract = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill));

const be32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');

/** A curve point as the token stores it, be(x) || be(y), written from affine coordinates. */
export function pointBytes(p: Point): Buffer {
  if (p.is0()) return Buffer.alloc(64);
  const { x, y } = p.toAffine();
  return Buffer.concat([be32(x), be32(y)]);
}

export { be32 };

/** confidential_balance's ConfidentialAccount struct. */
export function accountStruct(a: { auditorId: number; spendingKey: Point; pvk: Point; spendable: Point; receiving: Point }): xdr.ScVal {
  return raw.struct({
    auditor_id: raw.u32(a.auditorId),
    spending_public_key: raw.bytes(pointBytes(a.spendingKey)),
    viewing_public_key: raw.bytes(pointBytes(a.pvk)),
    spendable_commitment: raw.bytes(pointBytes(a.spendable)),
    receiving_commitment: raw.bytes(pointBytes(a.receiving)),
  });
}

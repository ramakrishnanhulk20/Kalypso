// Does NOT cover: whether the token accepts these envelopes (real proofs are only built in
// scratchpad/m5b2/e2e-run.mjs on testnet), or whether a decoded point is the right person's key.
import { addressToField, buildRegisterWitness, buildTransferWitness, buildWithdrawWitness, commit, deriveKeys, FR_MODULUS, G, H, scalarMul } from 'stellar-confidential-token-sdk';
import { describe, expect, it } from 'vitest';
import { ContractCallError, type ChainPort } from '../src/chain/ports.js';
import { DecodeError } from '../src/chain/scval.js';
import {
  TokenErrorCode,
  buildConfidentialTransfer,
  buildDeposit,
  buildMerge,
  buildRegister,
  buildWithdraw,
  confidentialBalance,
  decodeAuditorKey,
  decodeConfidentialAccount,
  getAuditorKey,
  requireOnCurvePoint,
} from '../src/chain/token.js';
import { PASSPHRASE, b64, be32, pointBytes, raw, readEnvelope, testAccount, testContract } from './independent-xdr.js';

const TOKEN = testContract(2);
const REGISTRY = testContract(3);
const employer = testAccount('token employer').publicKey();
const worker = testAccount('token worker').publicKey();
const base = { source: { address: employer, sequence: '100' }, networkPassphrase: PASSPHRASE, contractId: TOKEN };

// The token decodes `data` with from_xdr into a {payload, proof} struct, and `data` itself is Bytes.
const dataArg = (payload: Record<string, ReturnType<typeof raw.u32>>, proof: Uint8Array) =>
  b64(raw.bytes(raw.struct({ payload: raw.struct(payload), proof: raw.bytes(proof) }).toXDR()));

const keys = deriveKeys(123456789n, addressToField(TOKEN), addressToField(employer));
const proof = new Uint8Array(Array.from({ length: 96 }, (_, i) => (i * 7) & 0xff));
const kAud = scalarMul(42n, H);
const recipientPvk = scalarMul(77n, H);

describe('token invocation builders', () => {
  it('register encodes RegisterData from a witness with the SDK encoder, and from a ProofEnvelope payload', () => {
    const witness = buildRegisterWitness(keys);
    const fields = { y: raw.bytes(pointBytes(witness.payload.y)), pvk: raw.bytes(pointBytes(witness.payload.pvk)) };
    const expected = dataArg(fields, proof);
    const fromWitness = readEnvelope(buildRegister(base, { account: employer, auditorId: 5, data: { witness, proof } }));
    expect(fromWitness.method).toBe('register');
    expect(fromWitness.args).toEqual([b64(raw.address(employer)), b64(raw.u32(5)), expected]);

    const payload = new Uint8Array(raw.struct({ payload: raw.struct(fields), proof: raw.bytes(proof) }).toXDR());
    const fromEnvelope = readEnvelope(buildRegister(base, { account: employer, auditorId: 5, data: { payload, proof } }));
    expect(fromEnvelope.args[2]).toBe(expected);
  });

  it('withdraw and confidential_transfer encode their payload structs field by field', () => {
    const w = buildWithdrawWitness({ keys, v: 1_000n, r: 9n, amount: 250n, kAudS: kAud });
    const withdraw = readEnvelope(buildWithdraw(base, { from: employer, to: worker, amount: 250n, data: { witness: w, proof } }));
    expect(withdraw.method).toBe('withdraw');
    expect(withdraw.args).toEqual([
      b64(raw.address(employer)),
      b64(raw.address(worker)),
      b64(raw.i128(250n)),
      dataArg(
        {
          c_spend_new: raw.bytes(pointBytes(w.payload.cSpendNew)),
          b_tilde: raw.bytes(be32(w.payload.bTilde)),
          r_e_point: raw.bytes(pointBytes(w.payload.rE)),
          sigma: raw.bytes(be32(w.payload.sigma)),
          b_tilde_aud_s: raw.bytes(be32(w.payload.bAudS)),
        },
        proof,
      ),
    ]);

    const t = buildTransferWitness({ keys, v: 1_000n, r: 9n, amount: 300n, pvkB: recipientPvk, kAudR: kAud, kAudS: kAud });
    const transfer = readEnvelope(buildConfidentialTransfer(base, { from: employer, to: worker, data: { witness: t, proof } }));
    const p = t.payload;
    expect(transfer.method).toBe('confidential_transfer');
    expect(transfer.args).toEqual([
      b64(raw.address(employer)),
      b64(raw.address(worker)),
      dataArg(
        {
          c_spend_new: raw.bytes(pointBytes(p.cSpendNew)),
          c_transfer: raw.bytes(pointBytes(p.cTx)),
          r_e_point: raw.bytes(pointBytes(p.rE)),
          v_tilde: raw.bytes(be32(p.vTilde)),
          b_tilde: raw.bytes(be32(p.bTilde)),
          sigma: raw.bytes(be32(p.sigma)),
          v_tilde_aud_r: raw.bytes(be32(p.vAudR)),
          r_tilde_aud_r: raw.bytes(be32(p.rAudR)),
          v_tilde_aud_s: raw.bytes(be32(p.vAudS)),
          b_tilde_aud_s: raw.bytes(be32(p.bAudS)),
        },
        proof,
      ),
    ]);
  });

  it('deposit and merge encode their plain arguments', () => {
    const big = (1n << 100n) + 5n;
    expect(readEnvelope(buildDeposit(base, { from: employer, to: employer, amount: big })).args).toEqual([
      b64(raw.address(employer)),
      b64(raw.address(employer)),
      b64(raw.i128(big)),
    ]);
    const merge = readEnvelope(buildMerge(base, { account: employer }));
    expect([merge.method, merge.args]).toEqual(['merge', [b64(raw.address(employer))]]);
  });

  it('refuses zero, negative and missing amounts or data', () => {
    expect(() => buildDeposit(base, { from: employer, to: employer, amount: 0n })).toThrow(RangeError);
    expect(() => buildDeposit(base, { from: employer, to: employer, amount: -5n })).toThrow(RangeError);
    expect(() => buildDeposit(base, { from: employer, to: employer, amount: 5 as unknown as bigint })).toThrow(RangeError);
    expect(() => buildConfidentialTransfer(base, { from: employer, to: worker, data: { payload: new Uint8Array() } })).toThrow(TypeError);
    expect(() => buildRegister(base, { account: employer, auditorId: 2 ** 32, data: { payload: proof } })).toThrow(RangeError);
  });
});

const accountVal = (fields: Partial<Record<string, ReturnType<typeof raw.u32>>> = {}) =>
  raw.struct({
    auditor_id: raw.u32(6),
    spending_public_key: raw.bytes(pointBytes(keys.Y)),
    viewing_public_key: raw.bytes(pointBytes(keys.PVK)),
    spendable_commitment: raw.bytes(pointBytes(commit(5_000n, 11n))),
    receiving_commitment: raw.bytes(Buffer.alloc(64)),
    ...fields,
  } as Record<string, ReturnType<typeof raw.u32>>);

const offCurve = () => {
  const bytes = pointBytes(commit(3n, 4n));
  bytes[63] = (bytes[63] ?? 0) ^ 1;
  return bytes;
};

describe('token decoders', () => {
  it('decodes ConfidentialAccount into checked points', () => {
    const view = decodeConfidentialAccount(accountVal());
    expect(view.auditorId).toBe(6);
    expect(view.pvk.equals(keys.PVK)).toBe(true);
    expect(view.spendable.equals(commit(5_000n, 11n))).toBe(true);
    expect(view.receiving.is0()).toBe(true);
  });

  it('rejects off-curve, non-canonical, wrong-length and identity keys', () => {
    expect(() => decodeConfidentialAccount(accountVal({ spendable_commitment: raw.bytes(offCurve()) }))).toThrow(DecodeError);
    expect(() => decodeConfidentialAccount(accountVal({ spending_public_key: raw.bytes(offCurve()) }))).toThrow(DecodeError);
    expect(() => decodeConfidentialAccount(accountVal({ viewing_public_key: raw.bytes(Buffer.alloc(64)) }))).toThrow(/identity/);
    expect(() => decodeConfidentialAccount(accountVal({ receiving_commitment: raw.bytes(Buffer.alloc(64, 0xff)) }))).toThrow(DecodeError);
    expect(() => decodeConfidentialAccount(accountVal({ auditor_id: raw.u64(6n) }))).toThrow(DecodeError);
    expect(() => requireOnCurvePoint(new Uint8Array(63), 'x')).toThrow(/64 bytes/);
    expect(decodeAuditorKey(raw.bytes(pointBytes(kAud))).equals(kAud)).toBe(true);
    expect(() => decodeAuditorKey(raw.bytes(Buffer.alloc(64)))).toThrow(/identity/);
    expect(() => decodeAuditorKey(raw.bytes(pointBytes(G).subarray(0, 32)))).toThrow(DecodeError);
  });
});

describe('requireOnCurvePoint, the one point decoder (C19)', () => {
  const good = pointBytes(commit(3n, 4n));
  const withX = (x: bigint) => {
    const bytes = new Uint8Array(good);
    bytes.set(be32(x), 0);
    return bytes;
  };

  it('returns the point for its canonical encoding and the identity for 64 zero bytes', () => {
    expect(requireOnCurvePoint(good).equals(commit(3n, 4n))).toBe(true);
    expect(requireOnCurvePoint(new Uint8Array(64)).is0()).toBe(true);
  });

  it('rejects a point off the curve, a coordinate at or above the modulus, and the wrong length', () => {
    const x = BigInt(`0x${Buffer.from(good.subarray(0, 32)).toString('hex')}`);
    for (const bad of [offCurve(), withX(x + FR_MODULUS), withX(FR_MODULUS), new Uint8Array(64).fill(0xff), new Uint8Array(65), new Uint8Array(0)]) {
      expect(() => requireOnCurvePoint(bad, 'r_e_point')).toThrow(DecodeError);
    }
    expect(() => requireOnCurvePoint('00'.repeat(64) as never)).toThrow(DecodeError);
  });

  it('names the field and never the bytes', () => {
    const bad = offCurve();
    const message = (() => {
      try {
        requireOnCurvePoint(bad, 'r_e_point');
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(message).toContain('r_e_point');
    expect(message).not.toContain(Buffer.from(bad).toString('hex').slice(0, 16));
  });
});

describe('token reads', () => {
  const portAnswering = (answer: (method: string) => ReturnType<typeof raw.u32>) => {
    const calls: string[] = [];
    const port = {
      read: async (contractId: string, method: string, args: ReturnType<typeof raw.u32>[]) => {
        calls.push(`${contractId}.${method}(${args.map(b64).join(',')})`);
        return answer(method);
      },
    } as unknown as ChainPort;
    return { port, calls };
  };

  it('reads confidential_balance and get_key with the right arguments', async () => {
    const { port, calls } = portAnswering((method) => (method === 'get_key' ? raw.bytes(pointBytes(kAud)) : accountVal()));
    expect((await confidentialBalance(port, TOKEN, worker))?.auditorId).toBe(6);
    expect((await getAuditorKey(port, REGISTRY, 6)).equals(kAud)).toBe(true);
    expect(calls).toEqual([
      `${TOKEN}.confidential_balance(${b64(raw.address(worker))})`,
      `${REGISTRY}.get_key(${b64(raw.u32(6))})`,
    ]);
  });

  it('reads an unregistered account as null, and never reads an outage as unregistered', async () => {
    const failing = (err: Error) => ({ read: async () => { throw err; } }) as unknown as ChainPort;
    await expect(confidentialBalance(failing(new ContractCallError('confidential_balance', TokenErrorCode.AccountNotRegistered)), TOKEN, worker)).resolves.toBeNull();
    await expect(confidentialBalance(failing(new ContractCallError('confidential_balance', undefined)), TOKEN, worker)).rejects.toThrow(ContractCallError);
    await expect(confidentialBalance(failing(new ContractCallError('confidential_balance', TokenErrorCode.InvalidData)), TOKEN, worker)).rejects.toThrow(ContractCallError);
  });
});

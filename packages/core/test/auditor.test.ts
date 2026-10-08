// Does NOT cover: the registry contract's own rules (packages/contracts/auditor tests), what the
// live RPC returns for register_key (rpc-port.test.ts feeds the SDK's parser a raw reply
// instead), a key rotation or id handover that lands after the binding check, or whether the
// registry address passed in is the one the token reads keys from.
import { TransactionBuilder, xdr, type Keypair } from '@stellar/stellar-sdk/base';
import { G, H, IDENTITY, commit, pointFromBytes, scalarMul, type Point } from 'stellar-confidential-token-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressError } from '../src/addresses.js';
import {
  AuditorBindingError,
  buildAcceptOwner,
  buildCancelOwnerProposal,
  buildProposeOwner,
  buildRegisterKey,
  buildRotateKey,
  getKeyCount,
  getOwnerOf,
  readRegisteredAuditorId,
  requireAuditorBinding,
} from '../src/chain/auditor.js';
import { ContractCallError, type ChainPort } from '../src/chain/ports.js';
import { DecodeError } from '../src/chain/scval.js';
import { AuditorErrorCode, buildCheckedRegister, buildRegister } from '../src/chain/token.js';
import { MAX_SETUP_FEE_STROOPS, assembleFromSimulation, buildInvocation, type InvocationBase } from '../src/chain/tx.js';
import { FakeChain } from './fake-chain.js';
import { PASSPHRASE, b64, pointBytes, raw, readEnvelope, testAccount, testContract } from './independent-xdr.js';

vi.mock(import('../src/chain/tx.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildInvocation: vi.fn(actual.buildInvocation) };
});

// Every envelope in this file is made through this spy, so "no transaction built" is a call count.
const built = vi.mocked(buildInvocation);

const PAYROLL = testContract(1);
const TOKEN = testContract(2);
const REGISTRY = testContract(3);
const accountant = testAccount('auditor accountant');
const attacker = testAccount('auditor attacker');
const treasury = testAccount('auditor treasury').publicKey();
const smartWallet = testContract(9);
const accountantKey = scalarMul(4242n, H);
const otherKey = scalarMul(777n, H);
const data = { payload: new Uint8Array([7, 7, 7]) };
const registryBase = (source: string): InvocationBase => ({
  source: { address: source, sequence: '10' },
  networkPassphrase: PASSPHRASE,
  contractId: REGISTRY,
});
const tokenBase: InvocationBase = { source: { address: treasury, sequence: '20' }, networkPassphrase: PASSPHRASE, contractId: TOKEN };

const offCurve = (): Point => {
  const bytes = pointBytes(commit(3n, 4n));
  bytes[63] = (bytes[63] ?? 0) ^ 1;
  return pointFromBytes(bytes);
};

type Answer = xdr.ScVal | Error;

/** A port that answers the registry's reads from a table and records every read it was asked for. */
function registryPort(answers: { owner_of?: Answer; get_key?: Answer; key_count?: Answer }) {
  const calls: string[] = [];
  const port = {
    read: async (contractId: string, method: string, args: xdr.ScVal[]) => {
      calls.push(`${contractId === REGISTRY ? 'registry' : contractId}.${method}(${args.map(b64).join(',')})`);
      const answer = answers[method as keyof typeof answers];
      if (answer === undefined) throw new Error(`unexpected read of ${method}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as ChainPort;
  return { port, calls };
}

const bound = (owner: string, key: Point) => registryPort({ owner_of: raw.address(owner), get_key: raw.bytes(pointBytes(key)) });

beforeEach(() => {
  built.mockClear();
});

describe('registry invocation builders', () => {
  const owner = accountant.publicKey();
  it.each<[string, () => string, string, xdr.ScVal[]]>([
    ['register_key', () => buildRegisterKey(registryBase(owner), { owner, point: accountantKey }), 'register_key', [raw.address(owner), raw.bytes(pointBytes(accountantKey))]],
    ['register_key for a smart wallet owner', () => buildRegisterKey(registryBase(owner), { owner: smartWallet, point: otherKey }), 'register_key', [raw.address(smartWallet), raw.bytes(pointBytes(otherKey))]],
    ['rotate_key', () => buildRotateKey(registryBase(owner), { auditorId: 3, newPoint: otherKey }), 'rotate_key', [raw.u32(3), raw.bytes(pointBytes(otherKey))]],
    [
      'propose_owner',
      () => buildProposeOwner(registryBase(owner), { auditorId: 3, newOwner: smartWallet, liveUntilLedger: 5_000_000 }),
      'propose_owner',
      [raw.u32(3), raw.address(smartWallet), raw.u32(5_000_000)],
    ],
    ['cancel_owner_proposal', () => buildCancelOwnerProposal(registryBase(owner), { auditorId: 3 }), 'cancel_owner_proposal', [raw.u32(3)]],
    ['accept_owner', () => buildAcceptOwner(registryBase(owner), { auditorId: 2 ** 32 - 1 }), 'accept_owner', [raw.u32(2 ** 32 - 1)]],
  ])('%s encodes the exact contract arguments', (_name, build, method, args) => {
    const call = readEnvelope(build());
    expect(call.contractId).toBe(REGISTRY);
    expect(call.method).toBe(method);
    expect(call.args).toEqual(args.map(b64));
    expect(call.source).toBe(owner);
    expect(call.sequence).toBe(11n);
  });

  it('writes the same 64 bytes for any representation of the same key', () => {
    const sameKey = accountantKey.add(G).subtract(G);
    const a = readEnvelope(buildRegisterKey(registryBase(treasury), { owner: treasury, point: accountantKey }));
    const b = readEnvelope(buildRegisterKey(registryBase(treasury), { owner: treasury, point: sameKey }));
    expect(b.args).toEqual(a.args);
  });

  it('refuses what the registry would refuse, before any transaction is built', () => {
    for (const bad of [IDENTITY, offCurve(), 'ab'.repeat(64) as unknown as Point, undefined as unknown as Point]) {
      expect(() => buildRegisterKey(registryBase(treasury), { owner: treasury, point: bad })).toThrow(TypeError);
      expect(() => buildRotateKey(registryBase(treasury), { auditorId: 1, newPoint: bad })).toThrow(TypeError);
    }
    expect(() => buildRegisterKey(registryBase(treasury), { owner: '', point: accountantKey })).toThrow(AddressError);
    expect(() => buildProposeOwner(registryBase(treasury), { auditorId: 1, newOwner: `${smartWallet}A`, liveUntilLedger: 9 })).toThrow(AddressError);
    for (const auditorId of [-1, 2 ** 32, 1.5]) {
      expect(() => buildAcceptOwner(registryBase(treasury), { auditorId })).toThrow(RangeError);
      expect(() => buildCancelOwnerProposal(registryBase(treasury), { auditorId })).toThrow(RangeError);
    }
    expect(() => buildProposeOwner(registryBase(treasury), { auditorId: 1, newOwner: smartWallet, liveUntilLedger: -1 })).toThrow(RangeError);
    expect(built).not.toHaveBeenCalled();
  });
});

describe('registry reads', () => {
  it('owner_of and key_count send the right arguments and decode the answer', async () => {
    const { port, calls } = registryPort({ owner_of: raw.address(smartWallet), key_count: raw.u32(12) });
    expect(await getOwnerOf(port, REGISTRY, 4)).toBe(smartWallet);
    expect(await getKeyCount(port, REGISTRY)).toBe(12);
    expect(calls).toEqual([`registry.owner_of(${b64(raw.u32(4))})`, 'registry.key_count()']);
  });

  it('refuses an answer in any other shape, and passes a refusal through with its code', async () => {
    await expect(getOwnerOf(registryPort({ owner_of: raw.u32(1) }).port, REGISTRY, 4)).rejects.toThrow(DecodeError);
    await expect(getKeyCount(registryPort({ key_count: raw.u64(12n) }).port, REGISTRY)).rejects.toThrow(DecodeError);
    const unknown = await getOwnerOf(registryPort({ owner_of: new ContractCallError('owner_of', AuditorErrorCode.UnknownAuditor) }).port, REGISTRY, 99).catch(
      (e: unknown) => e,
    );
    expect((unknown as ContractCallError).contractCode).toBe(100);
    await expect(getOwnerOf(registryPort({}).port, treasury, 1)).rejects.toThrow(AddressError);
  });

  it('readRegisteredAuditorId returns the u32 a confirmed register_key handed back, and refuses anything else', () => {
    expect(readRegisteredAuditorId(raw.u32(0))).toBe(0);
    expect(readRegisteredAuditorId(raw.u32(2 ** 32 - 1))).toBe(2 ** 32 - 1);
    for (const bad of [raw.u64(3n), xdr.ScVal.scvI32(3), raw.void(), raw.address(treasury), raw.vec([raw.u32(3)])]) {
      expect(() => readRegisteredAuditorId(bad)).toThrow(DecodeError);
    }
    expect(() => readRegisteredAuditorId(undefined as unknown as xdr.ScVal)).toThrow(/no value/);
    expect(() => readRegisteredAuditorId(null as unknown as xdr.ScVal)).toThrow(DecodeError);
  });
});

describe('requireAuditorBinding (C33, C43)', () => {
  const owner = accountant.publicKey();

  it('passes when the registry names the expected owner and key, comparing keys as points', async () => {
    const { port, calls } = bound(owner, accountantKey);
    const sameKey = accountantKey.add(G).subtract(G);
    await expect(requireAuditorBinding(port, REGISTRY, 5, { owner: `  ${owner}\n`, key: sameKey })).resolves.toBeUndefined();
    expect(calls).toEqual([`registry.owner_of(${b64(raw.u32(5))})`, `registry.get_key(${b64(raw.u32(5))})`]);
  });

  it('refuses an id the registry never handed out, from either read', async () => {
    const noOwner = registryPort({ owner_of: new ContractCallError('owner_of', AuditorErrorCode.UnknownAuditor) });
    const err = await requireAuditorBinding(noOwner.port, REGISTRY, 5, { owner, key: accountantKey }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditorBindingError);
    expect((err as AuditorBindingError).code).toBe('UNKNOWN_ID');
    expect(noOwner.calls).toHaveLength(1);

    const noKey = registryPort({ owner_of: raw.address(owner), get_key: new ContractCallError('get_key', AuditorErrorCode.AuditorNotRegistered) });
    await expect(requireAuditorBinding(noKey.port, REGISTRY, 5, { owner, key: accountantKey })).rejects.toMatchObject({ code: 'UNKNOWN_ID' });
  });

  it('refuses another owner without reading the key, and a different key', async () => {
    const taken = bound(attacker.publicKey(), accountantKey);
    const err = await requireAuditorBinding(taken.port, REGISTRY, 5, { owner, key: accountantKey }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditorBindingError);
    expect((err as AuditorBindingError).code).toBe('OWNER_MISMATCH');
    expect((err as Error).message).toBe('Someone else owns this auditor id. Register your own key and use the id it returns.');
    expect(taken.calls).toHaveLength(1);

    const rekeyed = bound(owner, otherKey);
    await expect(requireAuditorBinding(rekeyed.port, REGISTRY, 5, { owner, key: accountantKey })).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    await expect(requireAuditorBinding(rekeyed.port, REGISTRY, 5, { owner, key: accountantKey.negate() })).rejects.toThrow(AuditorBindingError);
  });

  it('never reads an outage or a malformed answer as a pass or as an unknown id', async () => {
    for (const answers of [
      { owner_of: new ContractCallError('owner_of', undefined) },
      { owner_of: new ContractCallError('owner_of', AuditorErrorCode.CounterOverflow) },
      { owner_of: raw.address(owner), get_key: new ContractCallError('get_key', undefined) },
    ]) {
      const err = await requireAuditorBinding(registryPort(answers).port, REGISTRY, 5, { owner, key: accountantKey }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContractCallError);
    }
    await expect(requireAuditorBinding(registryPort({ owner_of: raw.u32(5) }).port, REGISTRY, 5, { owner, key: accountantKey })).rejects.toThrow(DecodeError);
    const identity = registryPort({ owner_of: raw.address(owner), get_key: raw.bytes(new Uint8Array(64)) });
    await expect(requireAuditorBinding(identity.port, REGISTRY, 5, { owner, key: accountantKey })).rejects.toThrow(DecodeError);
  });

  it('refuses a bad expected owner, key or id before reading anything', async () => {
    const { port, calls } = bound(owner, accountantKey);
    await expect(requireAuditorBinding(port, REGISTRY, 5, { owner: 'nobody', key: accountantKey })).rejects.toThrow(AddressError);
    await expect(requireAuditorBinding(port, REGISTRY, 5, { owner, key: IDENTITY })).rejects.toThrow(TypeError);
    await expect(requireAuditorBinding(port, REGISTRY, 5, { owner, key: offCurve() })).rejects.toThrow(TypeError);
    const hex = Buffer.from(pointBytes(accountantKey)).toString('hex') as unknown as Point;
    await expect(requireAuditorBinding(port, REGISTRY, 5, { owner, key: hex })).rejects.toThrow(TypeError);
    await expect(requireAuditorBinding(port, REGISTRY, -1, { owner, key: accountantKey })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

describe('buildCheckedRegister', () => {
  const owner = accountant.publicKey();
  const checked = (port: ChainPort, auditorId = 5) =>
    buildCheckedRegister(port, tokenBase, { account: treasury, auditorId, data, registry: REGISTRY, auditorOwner: owner, auditorKey: accountantKey });

  it.each<[string, ChainPort, string]>([
    ['an id never handed out', registryPort({ owner_of: new ContractCallError('owner_of', AuditorErrorCode.UnknownAuditor) }).port, 'UNKNOWN_ID'],
    ['an id another address owns', bound(attacker.publicKey(), accountantKey).port, 'OWNER_MISMATCH'],
    ['an id holding another key', bound(owner, otherKey).port, 'KEY_MISMATCH'],
  ])('refuses %s with zero transactions built', async (_name, port, code) => {
    await expect(checked(port)).rejects.toMatchObject({ name: 'AuditorBindingError', code });
    expect(built).not.toHaveBeenCalled();
  });

  it('builds nothing when the registry cannot be read', async () => {
    await expect(checked(registryPort({ owner_of: new ContractCallError('owner_of', undefined) }).port)).rejects.toThrow(ContractCallError);
    expect(built).not.toHaveBeenCalled();
  });

  it('builds exactly the register call buildRegister builds when owner and key match', async () => {
    const envelope = await checked(bound(owner, accountantKey).port);
    expect(built).toHaveBeenCalledTimes(1);
    expect(envelope).toBe(buildRegister(tokenBase, { account: treasury, auditorId: 5, data }));
    const call = readEnvelope(envelope);
    expect([call.contractId, call.method, call.args[0], call.args[1]]).toEqual([TOKEN, 'register', b64(raw.address(treasury)), b64(raw.u32(5))]);
  });
});

describe('the front-run story on the fake chain (C43)', () => {
  /** Simulates, assembles, signs and submits one registry call, then waits for its result. */
  async function land(chain: FakeChain, signer: Keypair, build: (base: InvocationBase) => string) {
    const { sequence } = await chain.sourceAccount(signer.publicKey());
    const unsigned = build({ source: { address: signer.publicKey(), sequence }, networkPassphrase: PASSPHRASE, contractId: REGISTRY });
    const sim = await chain.simulate(unsigned);
    expect(sim.ok).toBe(true);
    const tx = TransactionBuilder.fromXDR(assembleFromSimulation(unsigned, sim, PASSPHRASE, MAX_SETUP_FEE_STROOPS), PASSPHRASE);
    tx.sign(signer);
    const { hash } = await chain.submit(tx.toXDR());
    return chain.waitFor(hash, 5_000);
  }

  it('an attacker who takes the predicted id, even with the accountant key copied, leaves nothing for the treasury to sign', async () => {
    const chain = new FakeChain({ payroll: PAYROLL, token: TOKEN, auditor: REGISTRY });
    chain.keyCount = 3;
    const predicted = await getKeyCount(chain, REGISTRY);

    // Auditor keys are public, so the attacker registers the accountant's own key under its own name.
    const stolen = await land(chain, attacker, (b) => buildRegisterKey(b, { owner: attacker.publicKey(), point: accountantKey }));
    expect(stolen.status).toBe('SUCCESS');
    expect(readRegisteredAuditorId(stolen.returnValue as xdr.ScVal)).toBe(predicted);
    expect(await getOwnerOf(chain, REGISTRY, predicted)).toBe(attacker.publicKey());

    built.mockClear();
    const before = { submitted: chain.submitted.length, simulations: chain.simulations };
    const treasuryRegistration = {
      account: treasury,
      data,
      registry: REGISTRY,
      auditorOwner: accountant.publicKey(),
      auditorKey: accountantKey,
    };
    const refused = await buildCheckedRegister(chain, tokenBase, { ...treasuryRegistration, auditorId: predicted }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AuditorBindingError);
    expect((refused as AuditorBindingError).code).toBe('OWNER_MISMATCH');
    expect(built).not.toHaveBeenCalled();
    expect({ submitted: chain.submitted.length, simulations: chain.simulations }).toEqual(before);

    // The id to use is the one the accountant's own confirmed registration returned.
    const own = await land(chain, accountant, (b) => buildRegisterKey(b, { owner: accountant.publicKey(), point: accountantKey }));
    const auditorId = readRegisteredAuditorId(own.returnValue as xdr.ScVal);
    expect(auditorId).toBe(predicted + 1);

    built.mockClear();
    const envelope = await buildCheckedRegister(chain, tokenBase, { ...treasuryRegistration, auditorId });
    expect(built).toHaveBeenCalledTimes(1);
    expect(readEnvelope(envelope).args.slice(0, 2)).toEqual([b64(raw.address(treasury)), b64(raw.u32(auditorId))]);
  });

  it('a register_key the network did not confirm gives no id to use', async () => {
    const chain = new FakeChain({ payroll: PAYROLL, token: TOKEN, auditor: REGISTRY });
    chain.failNext('FAILED');
    const failed = await land(chain, accountant, (b) => buildRegisterKey(b, { owner: accountant.publicKey(), point: accountantKey }));
    expect(failed).toEqual({ status: 'FAILED', ledger: chain.ledger });
    expect(() => readRegisteredAuditorId(failed.returnValue as xdr.ScVal)).toThrow(DecodeError);
    expect(chain.keyCount).toBe(0);
  });
});

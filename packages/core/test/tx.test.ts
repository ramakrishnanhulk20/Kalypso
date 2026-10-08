// Does NOT cover: whether the network accepts the assembled transaction (the e2e script does),
// or fee bump envelopes, which Kalypso never builds.
import { Account, Address, Asset, Operation, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { DecodeError } from '../src/chain/scval.js';
import { assembleFromSimulation, buildInvocation, decodeInvocation, transactionHash } from '../src/chain/tx.js';
import { PASSPHRASE, b64, raw, testAccount, testContract } from './independent-xdr.js';

const signer = testAccount('tx signer');
const CONTRACT = testContract(4);
const unsigned = () =>
  buildInvocation(
    { source: { address: signer.publicKey(), sequence: '7' }, networkPassphrase: PASSPHRASE, contractId: CONTRACT, timeoutSeconds: 60 },
    'close_run',
    [raw.u64(1n), raw.u64(2n)],
  );

function sourceAuthEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(CONTRACT).toScAddress(),
          functionName: 'close_run',
          args: [raw.u64(1n), raw.u64(2n)],
        }),
      ),
      subInvocations: [],
    }),
  });
}

describe('envelope helpers', () => {
  it('decodes the single call and its validity window', () => {
    const before = Math.floor(Date.now() / 1000);
    const call = decodeInvocation(unsigned(), PASSPHRASE);
    expect(call).toMatchObject({ source: signer.publicKey(), sequence: '8', contractId: CONTRACT, method: 'close_run' });
    expect(call.args.map(b64)).toEqual([b64(raw.u64(1n)), b64(raw.u64(2n))]);
    expect(call.maxTime).toBeGreaterThanOrEqual(before + 60);
    expect(call.maxTime).toBeLessThanOrEqual(before + 62);
  });

  it('refuses envelopes that are not exactly one contract call', () => {
    const payment = new TransactionBuilder(new Account(signer.publicKey(), '1'), { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: signer.publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    expect(() => decodeInvocation(payment.toXDR(), PASSPHRASE)).toThrow(DecodeError);
    const tx = TransactionBuilder.fromXDR(unsigned(), PASSPHRASE);
    const bump = TransactionBuilder.buildFeeBumpTransaction(signer, '1000', tx as never, PASSPHRASE);
    expect(() => decodeInvocation(bump.toXDR(), PASSPHRASE)).toThrow(DecodeError);
  });

  it('applies the simulated resources, fee and auth with the SDK assembler', () => {
    const data = new SorobanDataBuilder().setResources(1_000_000, 2_000, 3_000).setResourceFee(55_555).build();
    const assembled = assembleFromSimulation(
      unsigned(),
      { ok: true, minResourceFee: '55555', transactionDataXdr: data.toXDR('base64'), authXdr: [sourceAuthEntry().toXDR('base64')], latestLedger: 9 },
      PASSPHRASE,
    );
    const tx = xdr.TransactionEnvelope.fromXDR(assembled, 'base64').v1().tx();
    expect(tx.fee()).toBe(100 + 55_555);
    expect(tx.ext().sorobanData().resourceFee().toString()).toBe('55555');
    const op = (tx.operations()[0] as xdr.Operation).body().invokeHostFunctionOp();
    expect(op.auth().map((a) => a.toXDR('base64'))).toEqual([sourceAuthEntry().toXDR('base64')]);
    expect(() => assembleFromSimulation(unsigned(), { ok: false, error: 'boom', latestLedger: 9 }, PASSPHRASE)).toThrow(/successful simulation/);
  });

  it('hashes the transaction body, so signing does not change the hash', () => {
    const envelope = unsigned();
    const tx = TransactionBuilder.fromXDR(envelope, PASSPHRASE);
    tx.sign(signer);
    expect(transactionHash(tx.toXDR(), PASSPHRASE)).toBe(transactionHash(envelope, PASSPHRASE));
    expect(transactionHash(envelope, PASSPHRASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

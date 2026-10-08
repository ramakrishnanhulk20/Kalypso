// Does NOT cover: the live RPC (scratchpad/m5b2/e2e-run.mjs runs this port on testnet). Here
// the rpc.Server methods are replaced, so only the mapping, error and timeout rules are tested.
import { Account, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressError } from '../src/addresses.js';
import { ContractCallError, SubmitRejectedError, contractErrorCode } from '../src/chain/ports.js';
import { RPC_TIMEOUT_MS, RpcTimeoutError, createRpcChainPort } from '../src/chain/rpc-port.js';
import { buildInvocation } from '../src/chain/tx.js';
import { PASSPHRASE, raw, testAccount, testContract } from './independent-xdr.js';

const URL_OK = 'https://soroban-testnet.example.org';
const CONTRACT = testContract(5);
const signer = testAccount('rpc signer');
const HASH = 'ab'.repeat(32);
const envelope = () =>
  buildInvocation({ source: { address: signer.publicKey(), sequence: '1' }, networkPassphrase: PASSPHRASE, contractId: CONTRACT }, 'get_company', [raw.u64(1n)]);

const success = (retval: xdr.ScVal) =>
  ({
    _parsed: true,
    id: '1',
    latestLedger: 77,
    events: [],
    minResourceFee: '1234',
    transactionData: new SorobanDataBuilder().setResourceFee(1234),
    result: { auth: [], retval },
  }) as unknown as Api.SimulateTransactionResponse;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createRpcChainPort', () => {
  it('refuses a plain http URL and an empty passphrase', () => {
    expect(() => createRpcChainPort({ rpcUrl: 'http://soroban-testnet.example.org', networkPassphrase: PASSPHRASE })).toThrow(TypeError);
    expect(() => createRpcChainPort({ rpcUrl: 'not a url', networkPassphrase: PASSPHRASE })).toThrow(TypeError);
    expect(() => createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: '' })).toThrow(TypeError);
  });

  it('maps a simulation into SimResult fields', async () => {
    vi.spyOn(Server.prototype, 'simulateTransaction').mockResolvedValueOnce(success(raw.u32(9)));
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const sim = await port.simulate(envelope());
    expect(sim).toMatchObject({ ok: true, minResourceFee: '1234', authXdr: [], latestLedger: 77, retvalXdr: raw.u32(9).toXDR('base64') });
    expect(xdr.SorobanTransactionData.fromXDR(sim.transactionDataXdr as string, 'base64').resourceFee().toString()).toBe('1234');

    vi.spyOn(Server.prototype, 'simulateTransaction').mockResolvedValueOnce({ id: '1', latestLedger: 78, error: 'HostError: Error(Contract, #11)', events: [], _parsed: true } as never);
    expect(await port.simulate(envelope())).toEqual({ ok: false, error: 'HostError: Error(Contract, #11)', latestLedger: 78 });

    const restore = { ...success(raw.u32(1)), restorePreamble: { minResourceFee: '1', transactionData: new SorobanDataBuilder() } };
    vi.spyOn(Server.prototype, 'simulateTransaction').mockResolvedValueOnce(restore as never);
    expect((await port.simulate(envelope())).ok).toBe(false);
  });

  it('returns the hash only when the network queued the transaction', async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const send = vi.spyOn(Server.prototype, 'sendTransaction');
    send.mockResolvedValueOnce({ status: 'PENDING', hash: HASH } as never);
    expect(await port.submit(envelope())).toEqual({ hash: HASH });
    send.mockResolvedValueOnce({ status: 'DUPLICATE', hash: HASH } as never);
    expect(await port.submit(envelope())).toEqual({ hash: HASH });
    const errorResult = xdr.TransactionResult.fromXDR('AAAAAAAAAGT////7AAAAAA==', 'base64');
    send.mockResolvedValueOnce({ status: 'ERROR', hash: HASH, errorResult } as never);
    await expect(port.submit(envelope())).rejects.toThrow(/txBadSeq/);
    send.mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER', hash: HASH } as never);
    await expect(port.submit(envelope())).rejects.toBeInstanceOf(SubmitRejectedError);
  });

  it('waits for a final status, and answers NOT_FOUND only after an empty look at the deadline', async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const get = vi.spyOn(Server.prototype, 'getTransaction');
    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.SUCCESS, ledger: 12 } as never);
    expect(await port.waitFor(HASH, 5_000)).toEqual({ status: 'SUCCESS', ledger: 12 });
    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.FAILED, ledger: 13 } as never);
    expect(await port.waitFor(HASH, 5_000)).toEqual({ status: 'FAILED', ledger: 13 });
    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.NOT_FOUND } as never);
    expect(await port.waitFor(HASH, 0)).toEqual({ status: 'NOT_FOUND' });
    get.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(port.waitFor(HASH, 0)).rejects.toThrow('socket hang up');

    vi.useFakeTimers();
    get.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ status: Api.GetTransactionStatus.SUCCESS, ledger: 14 } as never);
    const waiting = port.waitFor(HASH, 10_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await waiting).toEqual({ status: 'SUCCESS', ledger: 14 });

    await expect(port.waitFor('ABC', 1)).rejects.toThrow(TypeError);
    await expect(port.waitFor(HASH, -1)).rejects.toThrow(RangeError);
  });

  it("passes a successful call's return value through from the same getTransaction answer, and never a failed one's", async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const get = vi.spyOn(Server.prototype, 'getTransaction');
    const sim = vi.spyOn(Server.prototype, 'simulateTransaction');
    const returnValue = raw.u32(3);
    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.SUCCESS, ledger: 15, returnValue } as never);
    const done = await port.waitFor(HASH, 5_000);
    expect(done).toEqual({ status: 'SUCCESS', ledger: 15, returnValue });
    expect(done.returnValue?.u32()).toBe(3);
    expect(get).toHaveBeenCalledTimes(1);
    expect(sim).not.toHaveBeenCalled();

    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.FAILED, ledger: 16, returnValue } as never);
    expect(await port.waitFor(HASH, 5_000)).toEqual({ status: 'FAILED', ledger: 16 });
  });

  it("reads the return value out of the RPC's raw result meta through the SDK's own parser", async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const meta = new xdr.TransactionMeta(
      4,
      new xdr.TransactionMetaV4({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMetaV2({ ext: new xdr.SorobanTransactionMetaExt(0), returnValue: raw.u32(41) }),
        events: [],
        diagnosticEvents: [],
      }),
    );
    const rpc = Server.prototype as unknown as { _getTransaction(hash: string): Promise<unknown> };
    vi.spyOn(rpc, '_getTransaction').mockResolvedValueOnce({
      status: 'SUCCESS',
      latestLedger: 20,
      latestLedgerCloseTime: '1791460800',
      oldestLedger: 1,
      oldestLedgerCloseTime: '1791400000',
      ledger: 19,
      createdAt: '1791460795',
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: envelope(),
      resultXdr: 'AAAAAAAAAGT////7AAAAAA==',
      resultMetaXdr: meta.toXDR('base64'),
    });
    const done = await port.waitFor(HASH, 5_000);
    expect(done.status).toBe('SUCCESS');
    expect(done.returnValue?.switch().name).toBe('scvU32');
    expect(done.returnValue?.u32()).toBe(41);
  });

  it("reports the chain's latest close time with NOT_FOUND, and drops a malformed one", async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const get = vi.spyOn(Server.prototype, 'getTransaction');
    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.NOT_FOUND, latestLedgerCloseTime: '1791460800' } as never);
    expect(await port.waitFor(HASH, 0)).toEqual({ status: 'NOT_FOUND', closeTime: 1_791_460_800 });
    get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.NOT_FOUND, latestLedgerCloseTime: 1_791_460_805 } as never);
    expect(await port.waitFor(HASH, 0)).toEqual({ status: 'NOT_FOUND', closeTime: 1_791_460_805 });
    for (const bad of ['1.5e9', '-5', '0', 'soon', 1.5, Number.NaN]) {
      get.mockResolvedValueOnce({ status: Api.GetTransactionStatus.NOT_FOUND, latestLedgerCloseTime: bad } as never);
      expect(await port.waitFor(HASH, 0)).toEqual({ status: 'NOT_FOUND' });
    }
  });

  it("reads the newest ledger's sequence and close time from a getLatestLedger reply, and refuses anything not whole", async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const rpc = Server.prototype as unknown as { _getLatestLedger(): Promise<unknown> };
    const latest = vi.spyOn(rpc, '_getLatestLedger');
    // The shape testnet RPC answered on 2026-10-08: protocolVersion as a number, closeTime as a
    // decimal string. The two XDR fields (headerXdr, metadataXdr) are carried but never read.
    const reply = {
      id: '97d228f61a383ae78e35aebe8e0b33f2d02173da5cf516d52d6a6b7454529de6',
      protocolVersion: 29,
      sequence: 5_088_696,
      closeTime: '1791467067',
      headerXdr: 'AAAAAA==',
      metadataXdr: 'AAAAAA==',
    };
    latest.mockResolvedValueOnce(reply);
    expect(await port.latestLedger()).toEqual({ sequence: 5_088_696, closeTime: 1_791_467_067 });
    for (const bad of [
      { closeTime: '1.79e9' },
      { closeTime: 'soon' },
      { closeTime: Number.NaN },
      { closeTime: Number.POSITIVE_INFINITY },
      { closeTime: -5 },
      { closeTime: undefined },
      { sequence: '5088696' },
      { sequence: 1.5 },
      { sequence: 0 },
      { sequence: 2 ** 32 },
    ]) {
      latest.mockResolvedValueOnce({ ...reply, ...bad });
      await expect(port.latestLedger()).rejects.toThrow(TypeError);
    }

    vi.useFakeTimers();
    latest.mockReturnValueOnce(new Promise(() => {}));
    const waiting = port.latestLedger().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS);
    expect(await waiting).toBeInstanceOf(RpcTimeoutError);
  });

  it('reads by simulation and keeps the contract error code, or none for an outage', async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    const sim = vi.spyOn(Server.prototype, 'simulateTransaction');
    sim.mockResolvedValueOnce(success(raw.bool(true)));
    expect((await port.read(CONTRACT, 'is_paid', [raw.u64(1n)])).b()).toBe(true);
    const sent = sim.mock.calls[0]?.[0] as ReturnType<TransactionBuilder['build']>;
    expect(sent.source).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');

    sim.mockResolvedValueOnce({ id: '1', latestLedger: 1, error: 'HostError: Error(Contract, #3501)\n\nEvent log:\n Error(Contract, #7)', events: [], _parsed: true } as never);
    const refused = await port.read(CONTRACT, 'confidential_balance', []).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ContractCallError);
    expect((refused as ContractCallError).contractCode).toBe(3501);

    sim.mockRejectedValueOnce(new Error('ECONNRESET'));
    const outage = (await port.read(CONTRACT, 'get_run', []).catch((e: unknown) => e)) as ContractCallError;
    expect(outage.contractCode).toBeUndefined();

    sim.mockResolvedValueOnce({ ...success(raw.u32(1)), restorePreamble: { minResourceFee: '1', transactionData: new SorobanDataBuilder() } } as never);
    await expect(port.read(CONTRACT, 'get_run', [])).rejects.toThrow(/archived/);
    sim.mockResolvedValueOnce({ ...success(raw.u32(1)), result: undefined } as never);
    await expect(port.read(CONTRACT, 'get_run', [])).rejects.toThrow(/no value/);
  });

  it('gives up on any RPC call after 10 seconds', async () => {
    vi.useFakeTimers();
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    vi.spyOn(Server.prototype, 'simulateTransaction').mockReturnValue(new Promise(() => {}) as never);
    const simulating = port.simulate(envelope()).catch((e: unknown) => e);
    const reading = port.read(CONTRACT, 'get_run', []).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS);
    expect(await simulating).toBeInstanceOf(RpcTimeoutError);
    expect(((await reading) as ContractCallError).contractCode).toBeUndefined();
  });

  it('reads the sequence of a G source account only', async () => {
    const port = createRpcChainPort({ rpcUrl: URL_OK, networkPassphrase: PASSPHRASE });
    vi.spyOn(Server.prototype, 'getAccount').mockResolvedValueOnce(new Account(signer.publicKey(), '99'));
    expect(await port.sourceAccount(signer.publicKey())).toEqual({ sequence: '99' });
    await expect(port.sourceAccount(CONTRACT)).rejects.toBeInstanceOf(AddressError);
  });

  it('finds the first contract error code in RPC text', () => {
    expect(contractErrorCode('HostError: Error(Contract, #14) then Error(Contract, #3506)')).toBe(14);
    expect(contractErrorCode('HostError: Error(Budget, ExceededLimit)')).toBeUndefined();
    expect(contractErrorCode(undefined)).toBeUndefined();
  });
});

// Does NOT cover: real testnet envelopes or a live RPC and Horizon (scratchpad/m5b3/e2e-views.mjs
// reads testnet), or whether the network verified the proof inside a transaction. Envelopes here
// are real testnet transactions built with @stellar/stellar-sdk, carrying payloads from the SDK's
// own encoder, and every hash is recomputed by the code under test.
import { Account, BASE_FEE, Contract, Networks, Operation, TimeoutInfinite, TransactionBuilder, type Transaction, type xdr } from '@stellar/stellar-sdk/base';
import { Server, type Api } from '@stellar/stellar-sdk/rpc';
import { FR_MODULUS, H, StateEngine, commit } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeContractEvent } from '../src/history/decode.js';
import { bindTransferToTransaction, createTxSourcePort, oncePerHash, type TransferEventFields, type TxSourcePort } from '../src/history/tx-binding.js';
import type { FakeCall } from './fake-ledger.js';
import { PASSPHRASE, raw, testAccount, testContract } from './independent-xdr.js';
import { COMPANY, CONTRACTS, PAY, RUN, keysFor, scenario, type Scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The decoded transfer event to `to` in `txHash`, as a history reader holds it. */
function transferIn(s: Scenario, txHash: string, to: string): TransferEventFields {
  for (const rawEvent of s.ledger.events.filter((e) => e.txHash === txHash)) {
    const decoded = decodeContractEvent(rawEvent, CONTRACTS);
    if (decoded.kind === 'token' && decoded.event.type === 'transfer' && decoded.event.to === to) return decoded.event;
  }
  throw new Error('no such transfer');
}

/** The real pay transaction's call arguments, to replay them through another envelope. */
function payArgs(s: Scenario): xdr.ScVal[] {
  const tx = TransactionBuilder.fromXDR(s.ledger.transactions.get(s.payTx)?.envelopeXdr as string, PASSPHRASE) as Transaction;
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  return op.func.invokeContract().args();
}

/** Puts `call` on the ledger as its own successful transaction, with no events, and returns its hash. */
function onChain(s: Scenario, call: FakeCall, successful = true): string {
  const { envelopeXdr, txHash } = s.ledger.envelope(call, 9_000 + s.ledger.transactions.size);
  s.ledger.transactions.set(txHash, { envelopeXdr, successful });
  return txHash;
}

const bind = (s: Scenario, txHash: string, event: TransferEventFields, txSource: TxSourcePort = s.ledger.txSource()) =>
  bindTransferToTransaction({ txSource, txHash, event, contracts: CONTRACTS });

describe('bindTransferToTransaction: what binds', () => {
  it('binds each payslip transfer to its pay call and payload, which opens to the amount the worker decrypts', async () => {
    const s = scenario();
    for (const [i, worker] of s.workers.entries()) {
      const event = transferIn(s, s.payTx, worker);
      const bound = await bind(s, s.payTx, event);
      if (!bound.ok) throw new Error(`expected a binding, got ${bound.reason}`);
      expect(bound.call).toEqual({ kind: 'payroll_pay', companyId: COMPANY, runId: RUN });
      const { vTx, rTx } = new StateEngine({ address: worker, keys: keysFor(worker) }).decryptIncoming(bound.payload.rE, bound.payload.vTilde, bound.payload.sigma);
      expect(vTx).toBe(PAY[i]);
      expect(bound.payload.cTransfer.equals(commit(vTx, rTx))).toBe(true);
    }
  });

  it('binds a direct confidential transfer as what it is, never as a pay call', async () => {
    const s = scenario();
    const direct = s.ledger.transfer(s.treasury, s.workers[0] as string, 3_000_003n);
    const bound = await bind(s, direct, transferIn(s, direct, s.workers[0] as string));
    expect(bound).toMatchObject({ ok: true, call: { kind: 'confidential_transfer' } });
  });

  it('binds through a fee bump by the outer hash and by the inner one', async () => {
    const s = scenario();
    const inner = TransactionBuilder.fromXDR(s.ledger.transactions.get(s.payTx)?.envelopeXdr as string, PASSPHRASE) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(testAccount('fee sponsor').publicKey(), '200', inner, PASSPHRASE);
    const record = { envelopeXdr: bump.toXDR(), successful: true };
    const outer = bump.hash().toString('hex');
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    const txSource = s.ledger.txSource({ serve: new Map([[outer, record], [s.payTx, record]]) });
    expect(await bind(s, outer, event, txSource)).toMatchObject({ ok: true, call: { kind: 'payroll_pay' } });
    expect(await bind(s, s.payTx, event, txSource)).toMatchObject({ ok: true, call: { kind: 'payroll_pay' } });
  });
});

describe('bindTransferToTransaction: what does not', () => {
  const edits: [string, (e: TransferEventFields) => TransferEventFields][] = [
    ['r_e_point', (e) => ({ ...e, rE: e.rE.add(H) })],
    ['v_tilde', (e) => ({ ...e, vTilde: (e.vTilde + 1n) % FR_MODULUS })],
    ['sigma', (e) => ({ ...e, sigma: (e.sigma + 1n) % FR_MODULUS })],
    ['b_tilde', (e) => ({ ...e, bTilde: (e.bTilde + 1n) % FR_MODULUS })],
    ['v_tilde_aud_r', (e) => ({ ...e, vAudR: (e.vAudR + 1n) % FR_MODULUS })],
    ['r_tilde_aud_r', (e) => ({ ...e, rAudR: (e.rAudR + 1n) % FR_MODULUS })],
    ['v_tilde_aud_s', (e) => ({ ...e, vAudS: (e.vAudS + 1n) % FR_MODULUS })],
    ['b_tilde_aud_s', (e) => ({ ...e, bAudS: (e.bAudS + 1n) % FR_MODULUS })],
  ];
  it.each(edits)('refuses an event whose %s differs from the payload the transaction carried', async (_field, edit) => {
    const s = scenario();
    const event = edit(transferIn(s, s.payTx, s.workers[1] as string));
    expect(await bind(s, s.payTx, event)).toEqual({ ok: false, reason: 'payload_mismatch' });
  });

  it('refuses an envelope whose recomputed hash differs: another transaction, or the same call on another network', async () => {
    const s = scenario();
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    const other = s.ledger.transactions.get(s.ledger.transfer(s.treasury, s.outsider, 1n)) as { envelopeXdr: string; successful: boolean };
    expect(await bind(s, s.payTx, event, s.ledger.txSource({ serve: new Map([[s.payTx, other]]) }))).toEqual({ ok: false, reason: 'hash_mismatch' });

    const mainnet = new TransactionBuilder(new Account(testAccount('fee sponsor').publicKey(), '7'), { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
      .addOperation(new Contract(CONTRACTS.payroll).call('pay', ...payArgs(s)))
      .setTimeout(TimeoutInfinite)
      .build();
    const mainnetHash = mainnet.hash().toString('hex');
    const served = s.ledger.txSource({ serve: new Map([[mainnetHash, { envelopeXdr: mainnet.toXDR(), successful: true }]]) });
    expect(await bind(s, mainnetHash, event, served)).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  it('refuses a transaction no source has, a source that fails or answers out of shape, and a malformed hash', async () => {
    const s = scenario();
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    expect(await bind(s, s.payTx, event, s.ledger.txSource({ missing: new Set([s.payTx]) }))).toEqual({ ok: false, reason: 'transaction_unavailable' });
    const failing: TxSourcePort = { transaction: async () => Promise.reject(new Error('down')) };
    expect(await bind(s, s.payTx, event, failing)).toEqual({ ok: false, reason: 'transaction_unavailable' });
    const odd = { transaction: async () => ({ envelopeXdr: 5, successful: 'yes' }) } as unknown as TxSourcePort;
    expect(await bind(s, s.payTx, event, odd)).toEqual({ ok: false, reason: 'transaction_unavailable' });
    const asked = s.ledger.txSource();
    expect(await bind(s, s.payTx.toUpperCase(), event, asked)).toEqual({ ok: false, reason: 'transaction_unavailable' });
    expect(asked.calls).toEqual([]);
  });

  it('refuses a transaction that failed on chain', async () => {
    const s = scenario();
    const record = { ...(s.ledger.transactions.get(s.payTx) as { envelopeXdr: string }), successful: false };
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    expect(await bind(s, s.payTx, event, s.ledger.txSource({ serve: new Map([[s.payTx, record]]) }))).toEqual({ ok: false, reason: 'transaction_failed' });
  });

  it('refuses a call to any contract but ours, any other method, and anything that is not one contract call', async () => {
    const s = scenario();
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    const copycat = onChain(s, { contract: testContract(99), method: 'pay', args: payArgs(s) });
    const deposit = onChain(s, { contract: 'token', method: 'deposit', args: [raw.address(s.treasury), raw.address(s.workers[0] as string), raw.i128(1n)] });
    const close = onChain(s, { contract: 'payroll', method: 'close_run', args: [raw.u64(COMPANY), raw.u64(RUN)] });
    const source = new Account(testAccount('fee sponsor').publicKey(), '70');
    const twoCalls = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(CONTRACTS.payroll).call('pay', ...payArgs(s)))
      .addOperation(new Contract(CONTRACTS.payroll).call('pay', ...payArgs(s)))
      .setTimeout(TimeoutInfinite)
      .build();
    const upload = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }))
      .setTimeout(TimeoutInfinite)
      .build();
    const classic = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: '100' }))
      .setTimeout(TimeoutInfinite)
      .build();
    const serve = new Map([twoCalls, upload, classic].map((tx) => [tx.hash().toString('hex'), { envelopeXdr: tx.toXDR(), successful: true }]));
    const txSource = s.ledger.txSource({ serve });
    for (const txHash of [copycat, deposit, close, ...serve.keys()]) {
      expect(await bind(s, txHash, event, txSource)).toEqual({ ok: false, reason: 'not_our_call' });
    }
  });

  it('refuses a call with no single transfer for the event: another recipient, another sender, or one worker listed twice', async () => {
    const s = scenario();
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    expect(await bind(s, s.payTx, { ...event, to: s.outsider })).toEqual({ ok: false, reason: 'no_matching_item' });
    const direct = s.ledger.transfer(s.treasury, s.workers[0] as string, 3_000_003n);
    expect(await bind(s, direct, { ...transferIn(s, direct, s.workers[0] as string), from: s.outsider })).toEqual({ ok: false, reason: 'no_matching_item' });
    const [company, run, items] = payArgs(s) as [xdr.ScVal, xdr.ScVal, xdr.ScVal];
    const first = (items.vec() as xdr.ScVal[])[0] as xdr.ScVal;
    const twice = onChain(s, { contract: 'payroll', method: 'pay', args: [company, run, raw.vec([first, first])] });
    expect(await bind(s, twice, event)).toEqual({ ok: false, reason: 'no_matching_item' });
  });

  it('refuses arguments, items and transfer data that are not exactly the contract shape', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const event = transferIn(s, s.payTx, worker);
    const [company, run] = payArgs(s) as [xdr.ScVal, xdr.ScVal];
    const bytes32 = raw.bytes(new Uint8Array(32).fill(1));
    const extraField = raw.struct({
      payload: raw.struct({ c_spend_new: raw.bytes(new Uint8Array(64)), c_transfer: raw.bytes(new Uint8Array(64)), extra: bytes32 }),
      proof: raw.bytes(new Uint8Array([1])),
    });
    const shapes: xdr.ScVal[][] = [
      [company, run],
      [company, run, raw.vec([raw.vec([raw.address(worker), raw.bytes(new Uint8Array([1, 2, 3])), raw.u32(1)])])],
      [company, run, raw.vec([raw.vec([raw.address(worker), raw.u32(1)])])],
      [company, run, raw.vec([raw.vec([raw.address(worker), raw.bytes(new Uint8Array([1, 2, 3]))])])],
      [company, run, raw.vec([raw.vec([raw.address(worker), raw.bytes(extraField.toXDR())])])],
      [raw.u32(7), run, raw.vec([])],
    ];
    for (const args of shapes) {
      expect(await bind(s, onChain(s, { contract: 'payroll', method: 'pay', args }), event)).toEqual({ ok: false, reason: 'envelope_unreadable' });
    }
    const shortTransfer = onChain(s, { contract: 'token', method: 'confidential_transfer', args: [raw.address(s.treasury), raw.address(worker)] });
    expect(await bind(s, shortTransfer, event)).toEqual({ ok: false, reason: 'envelope_unreadable' });
    const garbage = s.ledger.txSource({ serve: new Map([[s.payTx, { envelopeXdr: 'not an envelope', successful: true }]]) });
    expect(await bind(s, s.payTx, event, garbage)).toEqual({ ok: false, reason: 'envelope_unreadable' });
    const huge = s.ledger.txSource({ serve: new Map([[s.payTx, { envelopeXdr: 'A'.repeat(180_001), successful: true }]]) });
    expect(await bind(s, s.payTx, event, huge)).toEqual({ ok: false, reason: 'envelope_unreadable' });
  });

  it('refuses contract ids that are not C addresses before reading anything', async () => {
    const s = scenario();
    const asked = s.ledger.txSource();
    const event = transferIn(s, s.payTx, s.workers[0] as string);
    await expect(bindTransferToTransaction({ txSource: asked, txHash: s.payTx, event, contracts: { ...CONTRACTS, payroll: s.treasury } })).rejects.toThrow();
    expect(asked.calls).toEqual([]);
  });
});

describe('oncePerHash', () => {
  it('asks the source once per hash, however many transfers a transaction carries', async () => {
    const s = scenario();
    const asked = s.ledger.txSource();
    const once = oncePerHash(asked);
    for (const worker of s.workers) expect((await bind(s, s.payTx, transferIn(s, s.payTx, worker), once)).ok).toBe(true);
    expect(asked.calls).toEqual([s.payTx]);
  });
});

describe('createTxSourcePort', () => {
  const hash = 'ab'.repeat(32);
  const config = { rpcUrl: 'https://soroban-testnet.example.org', horizonUrl: 'https://horizon-testnet.example.org' };
  const rpcAnswer = (answer: Partial<Api.RawGetTransactionResponse>) => answer as Api.RawGetTransactionResponse;
  const horizonAnswer = (status: number, body: unknown) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });

  it('reads the RPC first, and Horizon only when the RPC does not have the transaction or cannot answer', async () => {
    const getTransaction = vi.spyOn(Server.prototype, '_getTransaction');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const port = createTxSourcePort(config);

    getTransaction.mockResolvedValueOnce(rpcAnswer({ status: 'SUCCESS' as never, envelopeXdr: 'AAAA' }));
    expect(await port.transaction(hash)).toEqual({ envelopeXdr: 'AAAA', successful: true });
    getTransaction.mockResolvedValueOnce(rpcAnswer({ status: 'FAILED' as never, envelopeXdr: 'AAAB' }));
    expect(await port.transaction(hash)).toEqual({ envelopeXdr: 'AAAB', successful: false });
    expect(fetch).not.toHaveBeenCalled();

    getTransaction.mockResolvedValueOnce(rpcAnswer({ status: 'NOT_FOUND' as never }));
    fetch.mockResolvedValueOnce(horizonAnswer(200, { hash, successful: true, envelope_xdr: 'BBBB' }));
    expect(await port.transaction(hash)).toEqual({ envelopeXdr: 'BBBB', successful: true });
    expect(fetch.mock.calls[0]).toEqual([`${config.horizonUrl}/transactions/${hash}`, expect.objectContaining({ redirect: 'error' })]);

    getTransaction.mockRejectedValueOnce(new Error('rpc down'));
    fetch.mockResolvedValueOnce(horizonAnswer(404, { status: 404 }));
    expect(await port.transaction(hash)).toBeNull();

    getTransaction.mockResolvedValueOnce(rpcAnswer({ status: 'SUCCESS' as never }));
    fetch.mockResolvedValueOnce(horizonAnswer(200, { hash, successful: false, envelope_xdr: 'CCCC' }));
    expect(await port.transaction(hash)).toEqual({ envelopeXdr: 'CCCC', successful: false });
  });

  it('gives up on a slow RPC after the timeout and asks Horizon', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Server.prototype, '_getTransaction').mockReturnValueOnce(new Promise(() => {}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(horizonAnswer(200, { successful: true, envelope_xdr: 'DDDD' })));
    const read = createTxSourcePort(config).transaction(hash);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await read).toEqual({ envelopeXdr: 'DDDD', successful: true });
  });

  it('fails when Horizon answers an error, out of shape or too large, and refuses bad settings', async () => {
    vi.spyOn(Server.prototype, '_getTransaction').mockResolvedValue(rpcAnswer({ status: 'NOT_FOUND' as never }));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const port = createTxSourcePort(config);
    fetch.mockResolvedValueOnce(horizonAnswer(500, {}));
    await expect(port.transaction(hash)).rejects.toThrow(/status 500/);
    fetch.mockResolvedValueOnce(horizonAnswer(200, { successful: 'true', envelope_xdr: 'EEEE' }));
    await expect(port.transaction(hash)).rejects.toThrow(/no envelope/);
    fetch.mockResolvedValueOnce(horizonAnswer(200, null));
    await expect(port.transaction(hash)).rejects.toThrow(/no envelope/);
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'x'.repeat(4_000_001) });
    await expect(port.transaction(hash)).rejects.toThrow(/too large/);
    await expect(port.transaction('xyz')).rejects.toThrow(TypeError);
    expect(() => createTxSourcePort({ ...config, rpcUrl: 'http://soroban-testnet.example.org' })).toThrow(TypeError);
    expect(() => createTxSourcePort({ ...config, horizonUrl: 'https://horizon.example.org/?redirect=evil' })).toThrow(/horizonUrl/);
  });
});

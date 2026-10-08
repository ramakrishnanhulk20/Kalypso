import { Account, BASE_FEE, Contract, TransactionBuilder, type xdr } from '@stellar/stellar-sdk/base';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { AddressError, parseAccount } from '../addresses.js';
import { ContractCallError, SubmitRejectedError, contractErrorCode, type ChainPort, type SimResult } from './ports.js';

export const RPC_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60_000;
const MAX_LEDGER = 0xffff_ffff;
const TX_HASH = /^[0-9a-f]{64}$/;

// A read simulation needs a source account but never loads or charges it. This is the
// all-zero public key, which nobody can sign for.
const READ_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** An RPC call took longer than RPC_TIMEOUT_MS. */
export class RpcTimeoutError extends Error {
  constructor(call: string) {
    super(`The Stellar RPC did not answer ${call} within ${RPC_TIMEOUT_MS / 1000} seconds.`);
    this.name = 'RpcTimeoutError';
  }
}

// The build targets plain ES2022 without DOM or Node types, yet every runtime Kalypso runs
// in (browsers, Node, workers) has these two timers.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

// rpc.Server declares a timeout option but never applies it, so the bound lives here. The
// request itself is not cancelled; only the wait for it is.
function withTimeout<T>(call: string, work: Promise<T>): Promise<T> {
  let timer: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = timers.setTimeout(() => reject(new RpcTimeoutError(call)), RPC_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => timers.clearTimeout(timer));
}

const sleep = (ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms));

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

// The SDK types this as a number but passes the RPC's JSON through unchanged, and the RPC
// sends a decimal string. Anything that is not a whole positive second count is dropped, so a
// bad value can only make a NOT_FOUND less final, never more.
function unixSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The live ChainPort, over @stellar/stellar-sdk's rpc.Server. Every RPC call is bounded by
 * RPC_TIMEOUT_MS. The URL and passphrase come only from the caller's config.
 *
 * @throws TypeError when rpcUrl is not an https URL or networkPassphrase is empty.
 */
export function createRpcChainPort(config: { rpcUrl: string; networkPassphrase: string }): ChainPort {
  const { rpcUrl, networkPassphrase } = config;
  // rpc.Server parses the URL and refuses plain http; this check only makes the refusal ours.
  if (typeof rpcUrl !== 'string' || !/^https:\/\/[^\s/]+/.test(rpcUrl)) throw new TypeError('rpcUrl must be an absolute https URL');
  if (typeof networkPassphrase !== 'string' || networkPassphrase === '') {
    throw new TypeError('networkPassphrase must be a non-empty string');
  }
  const server = new Server(rpcUrl);

  async function simulate(txXdr: string): Promise<SimResult> {
    const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
    const sim = await withTimeout('simulateTransaction', server.simulateTransaction(tx));
    if (Api.isSimulationError(sim)) return { ok: false, error: sim.error, latestLedger: sim.latestLedger };
    if (Api.isSimulationRestore(sim)) {
      return { ok: false, error: 'Some contract state is archived and must be restored first.', latestLedger: sim.latestLedger };
    }
    const result: SimResult = {
      ok: true,
      minResourceFee: sim.minResourceFee,
      transactionDataXdr: sim.transactionData.build().toXDR('base64'),
      authXdr: (sim.result?.auth ?? []).map((entry) => entry.toXDR('base64')),
      latestLedger: sim.latestLedger,
    };
    if (sim.result) result.retvalXdr = sim.result.retval.toXDR('base64');
    return result;
  }

  async function submit(signedTxXdr: string): Promise<{ hash: string }> {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
    const sent = await withTimeout('sendTransaction', server.sendTransaction(tx));
    // DUPLICATE means this exact transaction is already queued, so it is in flight either way.
    if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') return { hash: sent.hash };
    throw new SubmitRejectedError(sent.status, sent.errorResult?.result().switch().name);
  }

  async function waitFor(hash: string, timeoutMs: number) {
    if (!TX_HASH.test(hash)) throw new TypeError('hash must be 64 lowercase hex characters');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
      throw new RangeError(`timeoutMs must be between 0 and ${MAX_WAIT_MS}`);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let pollError: unknown;
      let closeTime: number | undefined;
      try {
        const found = await withTimeout('getTransaction', server.getTransaction(hash));
        if (found.status === Api.GetTransactionStatus.SUCCESS) {
          // The SDK reads returnValue out of the result meta the same getTransaction call carried.
          return found.returnValue === undefined
            ? { status: 'SUCCESS' as const, ledger: found.ledger }
            : { status: 'SUCCESS' as const, ledger: found.ledger, returnValue: found.returnValue };
        }
        if (found.status === Api.GetTransactionStatus.FAILED) return { status: 'FAILED' as const, ledger: found.ledger };
        closeTime = unixSeconds(found.latestLedgerCloseTime);
      } catch (err) {
        pollError = err;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        // NOT_FOUND is an answer the caller acts on, so it is only given when the last look
        // at the deadline actually came back empty. A failed look is not an answer.
        if (pollError !== undefined) throw pollError;
        return closeTime === undefined ? { status: 'NOT_FOUND' as const } : { status: 'NOT_FOUND' as const, closeTime };
      }
      await sleep(Math.min(POLL_INTERVAL_MS, left));
    }
  }

  async function read(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const tx = new TransactionBuilder(new Account(READ_SOURCE, '0'), { fee: BASE_FEE, networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    let sim: Api.SimulateTransactionResponse;
    try {
      sim = await withTimeout('simulateTransaction', server.simulateTransaction(tx));
    } catch (err) {
      throw new ContractCallError(method, undefined, messageOf(err));
    }
    if (Api.isSimulationError(sim)) throw new ContractCallError(method, contractErrorCode(sim.error), firstLine(sim.error));
    if (Api.isSimulationRestore(sim)) throw new ContractCallError(method, undefined, 'Some contract state is archived.');
    if (!sim.result) throw new ContractCallError(method, undefined, 'The simulation returned no value.');
    return sim.result.retval;
  }

  async function sourceAccount(address: string): Promise<{ sequence: string }> {
    const account = parseAccount(address);
    if (account.kind !== 'G') throw new AddressError('INVALID');
    const loaded = await withTimeout('getAccount', server.getAccount(account.address));
    return { sequence: loaded.sequenceNumber() };
  }

  async function latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    // The raw reply: the parsed getLatestLedger also decodes the ledger's whole close meta (about
    // 370 KB on testnet), which nothing here reads and which a newer protocol could fail to decode.
    const reply: { sequence?: unknown; closeTime?: unknown } = await withTimeout('getLatestLedger', server._getLatestLedger());
    const { sequence } = reply;
    const closeTime = unixSeconds(reply.closeTime);
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0 || sequence > MAX_LEDGER || closeTime === undefined) {
      throw new TypeError('The RPC answered getLatestLedger without a whole ledger sequence and close time.');
    }
    return { sequence, closeTime };
  }

  return { simulate, submit, waitFor, read, sourceAccount, latestLedger };
}

import { bytesToHex } from '@noble/hashes/utils.js';
import { Account, Address, BASE_FEE, Contract, Transaction, TransactionBuilder, type xdr } from '@stellar/stellar-sdk/base';
import { assembleTransaction, type Api } from '@stellar/stellar-sdk/rpc';
import type { SimResult } from './ports.js';
import { DecodeError, requireAccount } from './scval.js';

/** How long a built transaction stays valid. It must cover proving and a person reading the wallet prompt. */
export const DEFAULT_TX_TIMEOUT_SECONDS = 120;
const MAX_TX_TIMEOUT_SECONDS = 3_600;
const SEQUENCE = /^\d{1,20}$/;

/** Everything an invocation builder needs besides the call's own arguments. */
export interface InvocationBase {
  /** The transaction source, which signs and pays the fee, with its sequence from ChainPort.sourceAccount. */
  source: { address: string; sequence: string };
  networkPassphrase: string;
  contractId: string;
  /** Seconds the transaction stays valid, 1 to 3600. Default DEFAULT_TX_TIMEOUT_SECONDS. */
  timeoutSeconds?: number;
}

/** One decoded contract call, as it appears in an envelope. */
export interface Invocation {
  source: string;
  sequence: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /** The transaction's last valid moment, in Unix seconds. */
  maxTime: number;
}

/**
 * Builds the base64 unsigned envelope for one contract call. The fee is the base fee only;
 * the resource fee comes from simulation when the envelope is assembled.
 *
 * @throws AddressError when the source is not a G address or the contract not a C address;
 *   RangeError for a malformed sequence or timeout; TypeError for an empty passphrase.
 */
export function buildInvocation(base: InvocationBase, method: string, args: xdr.ScVal[]): string {
  const source = requireAccount(base.source.address, ['G']);
  const contractId = requireAccount(base.contractId, ['C']);
  if (typeof base.source.sequence !== 'string' || !SEQUENCE.test(base.source.sequence)) {
    throw new RangeError('source.sequence must be a decimal string');
  }
  const timeout = base.timeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TX_TIMEOUT_SECONDS) {
    throw new RangeError(`timeoutSeconds must be a whole number from 1 to ${MAX_TX_TIMEOUT_SECONDS}`);
  }
  if (typeof base.networkPassphrase !== 'string' || base.networkPassphrase === '') {
    throw new TypeError('networkPassphrase must be a non-empty string');
  }
  return new TransactionBuilder(new Account(source, base.source.sequence), {
    fee: BASE_FEE,
    networkPassphrase: base.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(timeout)
    .build()
    .toXDR();
}

function parseTransaction(txXdr: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new DecodeError('the envelope is a fee bump, not a plain transaction');
  return tx;
}

/**
 * Decodes an envelope that holds exactly one contract call.
 * @throws DecodeError for anything else: several operations, a non-call operation, a fee bump.
 */
export function decodeInvocation(txXdr: string, networkPassphrase: string): Invocation {
  const tx = parseTransaction(txXdr, networkPassphrase);
  const [op, ...rest] = tx.operations;
  if (op === undefined || rest.length > 0 || op.type !== 'invokeHostFunction') {
    throw new DecodeError('the envelope does not hold exactly one contract call');
  }
  if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') throw new DecodeError('the operation is not a contract call');
  const call = op.func.invokeContract();
  return {
    source: tx.source,
    sequence: tx.sequence,
    contractId: Address.fromScAddress(call.contractAddress()).toString(),
    method: call.functionName().toString(),
    args: call.args(),
    maxTime: Number(tx.timeBounds?.maxTime ?? 0),
  };
}

/** The transaction hash as 64 lowercase hex characters. Signatures do not change it. */
export function transactionHash(txXdr: string, networkPassphrase: string): string {
  return bytesToHex(TransactionBuilder.fromXDR(txXdr, networkPassphrase).hash());
}

/**
 * Applies a successful simulation to the unsigned envelope it came from: resource limits,
 * resource fee and auth entries. This is the SDK's own assembleTransaction, fed the raw
 * simulation fields a ChainPort returns.
 *
 * @throws Error when the simulation did not succeed.
 */
export function assembleFromSimulation(unsignedXdr: string, sim: SimResult, networkPassphrase: string): string {
  if (!sim.ok || sim.transactionDataXdr === undefined || sim.minResourceFee === undefined) {
    throw new Error('Only a successful simulation can be applied to a transaction.');
  }
  const raw: Api.RawSimulateTransactionResponse = {
    id: 'kalypso',
    latestLedger: sim.latestLedger,
    minResourceFee: sim.minResourceFee,
    transactionData: sim.transactionDataXdr,
    results: [{ auth: sim.authXdr ?? [], xdr: sim.retvalXdr ?? '' }],
  };
  return assembleTransaction(parseTransaction(unsignedXdr, networkPassphrase), raw).build().toXDR();
}

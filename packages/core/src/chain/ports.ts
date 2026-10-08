import type { xdr } from '@stellar/stellar-sdk/base';

/** What a simulation of an unsigned envelope returned. The XDR fields are base64. */
export interface SimResult {
  ok: boolean;
  error?: string;
  minResourceFee?: string;
  transactionDataXdr?: string;
  authXdr?: string[];
  retvalXdr?: string;
  latestLedger: number;
}

/**
 * Everything the payroll engine needs from the network. The live implementation is
 * createRpcChainPort; tests use an in-memory model. Keeping the engine behind this port is
 * what lets one engine serve the browser, the server and the scripts.
 */
export interface ChainPort {
  /** RPC simulateTransaction on an unsigned envelope. */
  simulate(txXdr: string): Promise<SimResult>;
  /**
   * Hands a signed envelope to the network.
   * @throws SubmitRejectedError when the network refused it, so it is not in flight.
   */
  submit(signedTxXdr: string): Promise<{ hash: string }>;
  /**
   * Waits up to timeoutMs for a final result. NOT_FOUND means it was not seen in that time.
   * With NOT_FOUND, closeTime is the close time in Unix seconds of the latest ledger the network
   * had at the last look. Without it, NOT_FOUND says nothing about whether the transaction can
   * still land.
   * With SUCCESS, returnValue is the contract call's return value when the network reported one.
   * It is an RPC answer like any other, so the caller decodes it with that call's strict decoder.
   */
  waitFor(
    hash: string,
    timeoutMs: number,
  ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number; closeTime?: number; returnValue?: xdr.ScVal }>;
  /**
   * Read-only contract call by simulation.
   * @throws ContractCallError when the call fails, with the contract's own error code when it raised one.
   */
  read(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  sourceAccount(address: string): Promise<{ sequence: string }>;
  /**
   * The newest ledger the network has closed, as the RPC knows it: its sequence and its close
   * time in Unix seconds, by the chain's clock, never this machine's.
   * @throws when the RPC cannot answer, or its sequence or close time is not a whole positive number.
   */
  latestLedger(): Promise<{ sequence: number; closeTime: number }>;
}

export interface SignerPort {
  address: string;
  signTransaction(txXdr: string, networkPassphrase: string): Promise<string>;
}

/** An opening of a balance commitment: v and r as decimal strings, commitment as hex. Never logged. */
export interface SavedOpening {
  v: string;
  r: string;
  commitment: string;
}

/** A pay transaction handed to the network whose result is not final yet. It holds no amount. */
export interface InFlightPay {
  /** The transaction hash, 64 lowercase hex characters. */
  hash: string;
  /** The transaction's last valid moment, in Unix seconds. */
  maxTime: number;
  /** Store key of the opening the treasury is left with if this transaction lands. */
  batchKey: string;
}

/**
 * This device's record of treasury openings and of the pay in flight. Values are read back as
 * untrusted: openings are checked against the chain and records against their shape.
 */
export interface OpeningStore {
  /**
   * A list value is the treasury's attempts list (attemptsKey): store keys of batch openings that
   * may still open the chain. It is written through put like any other value, so a store must keep
   * JSON arrays as well as objects.
   */
  get(key: string): Promise<SavedOpening | InFlightPay | readonly string[] | undefined>;
  put(key: string, value: SavedOpening | InFlightPay | readonly string[]): Promise<void>;
  /** Removes the key. Removing a key that is not there is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * A read-only call failed. contractCode is the number in Error(Contract, #n) when the contract
 * itself refused, and undefined for anything else (network, archived entry, host error), so a
 * caller can never mistake an outage for a contract answer.
 */
export class ContractCallError extends Error {
  readonly method: string;
  readonly contractCode: number | undefined;

  constructor(method: string, contractCode: number | undefined, detail?: string) {
    const reason = contractCode === undefined ? 'the call could not be completed' : `the contract refused with code ${contractCode}`;
    super(`Reading ${method} failed: ${reason}.${detail ? ` ${detail}` : ''}`);
    this.name = 'ContractCallError';
    this.method = method;
    this.contractCode = contractCode;
  }
}

/** The network refused a signed transaction outright. It was not accepted, so it is not in flight. */
export class SubmitRejectedError extends Error {
  readonly status: string;

  constructor(status: string, resultCode?: string) {
    super(`The network refused the transaction (${status}${resultCode ? `, ${resultCode}` : ''}).`);
    this.name = 'SubmitRejectedError';
    this.status = status;
  }
}

const CONTRACT_ERROR = /Error\(Contract, #(\d+)\)/;

/**
 * The contract error code inside an RPC error text, or undefined when there is none. The RPC
 * puts the error that ended the call first and the diagnostic event log after it, so the first
 * match is the one that counts.
 */
export function contractErrorCode(text: string | undefined): number | undefined {
  const match = text === undefined ? null : CONTRACT_ERROR.exec(text);
  return match ? Number(match[1]) : undefined;
}

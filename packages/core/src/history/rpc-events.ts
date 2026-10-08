import { Server } from '@stellar/stellar-sdk/rpc';
import { RPC_TIMEOUT_MS, RpcTimeoutError } from '../chain/rpc-port.js';
import { DecodeError, requireAccount } from '../chain/scval.js';

/** Where an event sits in the ledger's total order. Events are applied in this order. */
export interface EventPosition {
  ledger: number;
  txIndex: number;
  opIndex: number;
  eventIndex: number;
}

/** One contract event as a source served it: position, hash, contract and the verbatim XDR. */
export interface RawContractEvent extends EventPosition {
  txHash: string;
  contractId: string;
  topicsXdr: string[];
  dataXdr: string;
}

export interface RpcContractEvent extends RawContractEvent {
  /** False for an event from a call that failed, which changed no state. */
  successful: boolean;
}

export type ContractEventsQuery = { contractId: string; limit: number } & ({ startLedger: number } | { cursor: string });

/**
 * The Stellar RPC getEvents API, which keeps about 7 days of events. History readers use it
 * when no archive is configured or the archive cannot be reached. Tests use an in-memory model.
 */
export interface EventsPort {
  /** The oldest and newest ledgers the RPC can answer for right now. */
  ledgerWindow(): Promise<{ oldestLedger: number; latestLedger: number }>;
  /** One page of one contract's events, in ledger order. cursor is where the next page starts. */
  contractEvents(query: ContractEventsQuery): Promise<{ events: RpcContractEvent[]; cursor: string | null; latestLedger: number }>;
}

const TX_HASH = /^[0-9a-f]{64}$/;
const RPC_EVENT_ID = /^(\d{1,19})-(\d{1,10})$/;

// Same timers note as rpc-port.ts: the build has no DOM or Node types, every runtime has these.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

function withTimeout<T>(call: string, work: Promise<T>): Promise<T> {
  let timer: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = timers.setTimeout(() => reject(new RpcTimeoutError(call)), RPC_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => timers.clearTimeout(timer));
}

/**
 * Splits an RPC event id or paging cursor, `<toid>-<event index>`, where the toid packs the
 * ledger (high 32 bits), transaction order (20 bits) and operation (12 bits). The server's
 * archive splits ids the same way, so an event has one position whichever source served it.
 *
 * @throws DecodeError when the id does not have that shape.
 */
export function parseRpcEventId(id: string): EventPosition {
  const match = typeof id === 'string' ? RPC_EVENT_ID.exec(id) : null;
  const toid = match ? BigInt(match[1] as string) : -1n;
  const eventIndex = match ? Number(match[2]) : -1;
  if (toid < 0n || toid >= 1n << 63n || eventIndex < 0 || eventIndex > 0xffff_ffff) throw new DecodeError('an RPC event id is malformed');
  return {
    ledger: Number(toid >> 32n),
    txIndex: Number((toid >> 12n) & 0xf_ffffn),
    opIndex: Number(toid & 0xfffn),
    eventIndex,
  };
}

/**
 * The live EventsPort, over @stellar/stellar-sdk's rpc.Server. Every call is bounded by
 * RPC_TIMEOUT_MS. Each event's id must agree with the ledger, transaction and operation
 * fields beside it, and its hash must be 64 lowercase hex characters.
 *
 * @throws TypeError when rpcUrl is not an https URL. The returned methods throw
 *   RpcTimeoutError, DecodeError for a malformed event, or whatever the RPC raised.
 */
export function createRpcEventsPort(config: { rpcUrl: string }): EventsPort {
  const { rpcUrl } = config;
  if (typeof rpcUrl !== 'string' || !/^https:\/\/[^\s/]+/.test(rpcUrl)) throw new TypeError('rpcUrl must be an absolute https URL');
  const server = new Server(rpcUrl);

  return {
    async ledgerWindow() {
      const health = await withTimeout('getHealth', server.getHealth());
      return { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger };
    },

    async contractEvents(query) {
      const contractId = requireAccount(query.contractId, ['C']);
      const filters = [{ type: 'contract' as const, contractIds: [contractId] }];
      const request = 'cursor' in query ? { filters, cursor: query.cursor, limit: query.limit } : { filters, startLedger: query.startLedger, limit: query.limit };
      const page = await withTimeout('getEvents', server.getEvents(request));
      const events = page.events.map((event): RpcContractEvent => {
        const position = parseRpcEventId(event.id);
        if (position.ledger !== event.ledger || position.txIndex !== event.transactionIndex || position.opIndex !== event.operationIndex) {
          throw new DecodeError('an RPC event id does not match its ledger, transaction or operation');
        }
        if (!TX_HASH.test(event.txHash)) throw new DecodeError('an RPC event has a malformed transaction hash');
        return {
          ...position,
          txHash: event.txHash,
          contractId: event.contractId?.contractId() ?? '',
          topicsXdr: event.topic.map((topic) => topic.toXDR('base64')),
          dataXdr: event.value.toXDR('base64'),
          successful: event.inSuccessfulContractCall,
        };
      });
      return { events, cursor: page.cursor || null, latestLedger: page.latestLedger };
    },
  };
}

import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Config } from "../config.ts";
import { OutboundError } from "../http.ts";
import { RPC_INVALID_REQUEST, RpcError, type RpcClient, type RpcEvent, type RpcEventsPage, type RpcHealth } from "../rpc.ts";
import { addressOfScVal, canonicalContractId, decodeCanonicalBase64 } from "../stellar.ts";
import { coverageOf, ingestedThrough } from "./coverage.ts";
import {
  addIngestedRange,
  insertEvents,
  readArchiveState,
  readCoverage,
  recordGap,
  recordIngestProgress,
  setArchiveStart,
  type Db,
  type EventRow,
  type GapRecord,
} from "./db.ts";

export interface IngestOptions {
  /**
   * Where an empty archive starts reading. It must be at or before the ledger
   * where both contracts were deployed: the archive then vouches for
   * everything before it too, because nothing of ours existed. Without it an
   * empty archive starts at RPC's oldest ledger and vouches only from there.
   */
  startLedger?: number;
  /** Stop starting new RPC calls after this long; the API's lazy catch-up uses 2,000. */
  deadlineMs?: number;
  /** Events per getEvents call, 1 to 1,000. */
  pageLimit?: number;
  /** Iteration cap for one pass. */
  maxPages?: number;
  now?: () => Date;
}

export interface IngestResult {
  ingestedThrough: number;
  gaps: GapRecord[];
  eventsStored: number;
  pages: number;
  caughtUp: boolean;
}

/** RPC sent something that breaks the rules below. Nothing from that page was stored. */
export class UpstreamDataError extends Error {
  constructor(what: string) {
    super("RPC reply refused: " + what);
    this.name = "UpstreamDataError";
  }
}

const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 1_000;

/**
 * One ingest pass: reads events for exactly our token and payroll contracts
 * from the ledger after the last one read in full, page by page, up to the
 * RPC tip, the deadline or the page cap.
 *
 * Each page is stored in one transaction together with the ledger range it
 * proves was read in full, so the archive never records a range without its
 * events. If the next ledger needed is older than RPC's oldest ledger, those
 * ledgers are recorded as a permanent gap (which raises the health alarm)
 * and reading continues from the oldest ledger.
 *
 * Throws on RPC or database failure, or on an RPC reply that breaks the
 * rules, after keeping every page already stored. A deadline is not a
 * failure: the pass returns what it managed.
 */
export async function ingestOnce(db: Db, rpc: RpcClient, cfg: Config, opts: IngestOptions = {}): Promise<IngestResult> {
  const now = opts.now ?? (() => new Date());
  const limit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("pageLimit must be 1 to 1000");
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const deadline = opts.deadlineMs === undefined ? undefined : AbortSignal.timeout(opts.deadlineMs);
  const contractIds = [cfg.TOKEN_CONTRACT_ID, cfg.PAYROLL_CONTRACT_ID];
  let pages = 0;
  let eventsStored = 0;
  let caughtUp = false;

  const skipForgotten = async (next: number, health: RpcHealth): Promise<number> => {
    if (next >= health.oldestLedger) return next;
    await recordGap(db, next, health.oldestLedger - 1, now());
    return health.oldestLedger;
  };

  const pass = async (): Promise<void> => {
    let health = await rpc.getHealth(deadline);
    let state = await readArchiveState(db);
    if (state.startLedger === null) {
      await setArchiveStart(db, opts.startLedger ?? health.oldestLedger, opts.startLedger !== undefined);
      state = await readArchiveState(db);
    }
    const through = ingestedThrough(coverageOf(await readCoverage(db)));
    let next = await skipForgotten(through > 0 ? through + 1 : state.startLedger!, health);
    if (next > health.latestLedger) {
      caughtUp = true;
      await recordIngestProgress(db, health.latestLedger, health.oldestLedger, now());
      return;
    }

    let readThrough = next - 1;
    let cursor: string | undefined;
    let lastCursor: RpcCursor | null = null;
    let retried = false;
    while (pages < maxPages) {
      if (deadline?.aborted) return;
      let page: RpcEventsPage;
      try {
        page = await rpc.getEvents(
          cursor === undefined ? { startLedger: next, contractIds, limit } : { cursor, contractIds, limit },
          deadline,
        );
      } catch (err) {
        // RPC's floor can move between getHealth and getEvents. Look once more.
        if (cursor === undefined && !retried && err instanceof RpcError && err.code === RPC_INVALID_REQUEST) {
          retried = true;
          health = await rpc.getHealth(deadline);
          const moved = await skipForgotten(next, health);
          if (moved === next) throw err;
          next = moved;
          readThrough = next - 1;
          continue;
        }
        throw err;
      }
      pages++;

      const rows = rowsOf(page, cfg);
      const pageCursor = page.cursor === undefined ? null : parseRpcCursor(page.cursor);
      if (page.cursor !== undefined && pageCursor === null) throw new UpstreamDataError("cursor format");
      if (pageCursor && lastCursor && compareCursors(pageCursor, lastCursor) <= 0) {
        throw new UpstreamDataError("cursor did not advance");
      }
      const fullyRead = Math.min(fullyReadThrough(page, pageCursor, limit, readThrough), page.latestLedger);
      if (rows.some((r) => r.ledger < next || r.ledger > page.latestLedger)) {
        throw new UpstreamDataError("event outside the requested ledgers");
      }

      await db.transaction(async (tx) => {
        eventsStored += await insertEvents(tx, rows);
        if (fullyRead > readThrough) await addIngestedRange(tx, readThrough + 1, fullyRead);
        await recordIngestProgress(tx, page.latestLedger, page.oldestLedger ?? health.oldestLedger, now());
      });
      if (fullyRead > readThrough) readThrough = fullyRead;

      if (pageCursor === null) return;
      if (page.events.length < limit && pageCursor.endOfLedger && pageCursor.ledger >= page.latestLedger) {
        caughtUp = true;
        return;
      }
      lastCursor = pageCursor;
      cursor = page.cursor;
    }
  };

  try {
    await pass();
  } catch (err) {
    const stoppedByDeadline = deadline?.aborted && err instanceof OutboundError && err.failure === "aborted";
    if (!stoppedByDeadline) throw err;
  }
  const coverage = coverageOf(await readCoverage(db));
  return { ingestedThrough: ingestedThrough(coverage), gaps: coverage.gaps, eventsStored, pages, caughtUp };
}

interface RpcCursor {
  ledger: number;
  txIndex: number;
  opIndex: number;
  eventIndex: number;
  /** RPC's marker for "scanned to the end of this ledger": every position field at its maximum. */
  endOfLedger: boolean;
}

/**
 * RPC cursors and event ids are `<toid>-<event index>`, where the toid packs
 * ledger (high 32 bits), transaction order (20 bits) and operation (12 bits).
 * This is the same split the SDK's rpcEventCoords uses, so an archived event
 * and its RPC twin get the same coordinates.
 */
export function parseRpcCursor(value: string): RpcCursor | null {
  const m = /^(\d{1,19})-(\d{1,10})$/.exec(value);
  if (!m) return null;
  const toid = BigInt(m[1]!);
  const eventIndex = Number(m[2]!);
  if (toid >= 1n << 63n || eventIndex > 0xffffffff) return null;
  const txIndex = Number((toid >> 12n) & 0xfffffn);
  const opIndex = Number(toid & 0xfffn);
  return {
    ledger: Number(toid >> 32n),
    txIndex,
    opIndex,
    eventIndex,
    endOfLedger: txIndex === 0xfffff && opIndex === 0xfff && eventIndex === 0xffffffff,
  };
}

function compareCursors(a: RpcCursor, b: RpcCursor): number {
  return a.ledger - b.ledger || a.txIndex - b.txIndex || a.opIndex - b.opIndex || a.eventIndex - b.eventIndex;
}

/**
 * The last ledger this page proves was read in full. A page that is not full
 * and whose cursor is RPC's end-of-ledger marker covers through that ledger.
 * Otherwise the cursor's own ledger may hold more events, so only the ledger
 * before it counts.
 */
function fullyReadThrough(page: RpcEventsPage, cursor: RpcCursor | null, limit: number, previous: number): number {
  if (cursor === null) return previous;
  if (page.events.length < limit && cursor.endOfLedger) return cursor.ledger;
  return cursor.ledger - 1;
}

function rowsOf(page: RpcEventsPage, cfg: Config): EventRow[] {
  const rows: EventRow[] = [];
  for (const raw of page.events) {
    // An event from a call that failed changed no balance; replaying it would.
    if (!raw.inSuccessfulContractCall) continue;
    rows.push(toRow(raw, cfg));
  }
  return rows;
}

function decodeScVal(base64: string): xdr.ScVal {
  const bytes = decodeCanonicalBase64(base64);
  if (bytes === null) throw new UpstreamDataError("event XDR is not canonical base64");
  let value: xdr.ScVal;
  try {
    value = xdr.ScVal.fromXDR(bytes);
  } catch {
    throw new UpstreamDataError("event XDR does not parse");
  }
  if (!value.toXDR().equals(bytes)) throw new UpstreamDataError("event XDR does not round-trip");
  return value;
}

/** Validates one RPC event and derives the query columns. Stores the XDR exactly as served. */
function toRow(raw: RpcEvent, cfg: Config): EventRow {
  if (raw.type !== "contract") throw new UpstreamDataError("not a contract event");
  const contractId = canonicalContractId(raw.contractId);
  if (contractId !== cfg.TOKEN_CONTRACT_ID && contractId !== cfg.PAYROLL_CONTRACT_ID) {
    throw new UpstreamDataError("event from a contract we did not ask for");
  }
  const position = parseRpcCursor(raw.id);
  if (position === null || position.ledger !== raw.ledger) throw new UpstreamDataError("event id does not match its ledger");
  if (raw.transactionIndex !== undefined && raw.transactionIndex !== position.txIndex) {
    throw new UpstreamDataError("transaction index does not match the event id");
  }
  if (raw.operationIndex !== undefined && raw.operationIndex !== position.opIndex) {
    throw new UpstreamDataError("operation index does not match the event id");
  }
  if (!/^[0-9a-f]{64}$/.test(raw.txHash)) throw new UpstreamDataError("transaction hash format");
  const closedAt = new Date(raw.ledgerClosedAt);
  if (Number.isNaN(closedAt.getTime())) throw new UpstreamDataError("ledger close time");

  const topics = raw.topic.map(decodeScVal);
  decodeScVal(raw.value);
  const name = topics[0]?.switch().name === "scvSymbol" ? topics[0].sym().toString() : null;
  const accounts = [...new Set(topics.slice(1).map(addressOfScVal).filter((a): a is string => a !== null))];
  const topic1 = topics[1];
  // Every payroll event carries its company id as a u64 at topic index 1,
  // right after the event name (packages/contracts/payroll/src/events.rs).
  // A payroll event that does not is refused rather than filed under no
  // company, so a change in the contract's events stops ingest loudly.
  let companyId: string | null = null;
  if (contractId === cfg.PAYROLL_CONTRACT_ID) {
    if (name === null || topic1?.switch().name !== "scvU64") {
      throw new UpstreamDataError("payroll event without a u64 company id at topic 1");
    }
    companyId = String(scValToNative(topic1));
  }

  return {
    id: [raw.ledger, raw.txHash, position.eventIndex].join("-"),
    ledger: raw.ledger,
    txHash: raw.txHash,
    txIndex: position.txIndex,
    opIndex: position.opIndex,
    eventIndex: position.eventIndex,
    contractId,
    eventName: name,
    topic1Address: topic1 ? addressOfScVal(topic1) : null,
    accounts,
    companyId,
    topicsXdr: [...raw.topic],
    valueXdr: raw.value,
    ledgerClosedAt: closedAt.toISOString(),
  };
}

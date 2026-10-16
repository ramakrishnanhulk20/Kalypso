import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Config } from "../config.ts";
import { OutboundError } from "../http.ts";
import type { Logger } from "../log.ts";
import { RPC_INVALID_REQUEST, RpcError, type RpcClient, type RpcEvent, type RpcEventsPage, type RpcHealth } from "../rpc.ts";
import { addressOfScVal, canonicalContractId, decodeCanonicalBase64 } from "../stellar.ts";
import { coverageOf, ingestedThrough } from "./coverage.ts";
import {
  addIngestedRange,
  deleteGap,
  insertEvents,
  readArchiveState,
  readCoverage,
  recordGap,
  recordIngestProgress,
  setArchiveStart,
  settleArchiveStart,
  type Db,
  type EventRow,
  type GapRecord,
} from "./db.ts";

export interface IngestOptions {
  /**
   * Where an empty archive starts reading; defaults to ARCHIVE_START_LEDGER.
   * The archive vouches for the ledgers before it only once the start check
   * passes (see ingestOnce). Without either, an empty archive starts at
   * RPC's oldest ledger and vouches only from there.
   */
  startLedger?: number;
  /** The token's deploy transaction hash for the start check; defaults to TOKEN_DEPLOY_TX. */
  deployTx?: string;
  /** Where the start check reports its outcome. */
  log?: Logger;
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
  /** Gaps this pass read in full and removed, oldest first. */
  healed: Array<{ fromLedger: number; toLedger: number }>;
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
/** Each try may reach another node behind RPC's load balancer. */
const HEAL_START_TRIES = 3;
/** RPC's default retention, 7 days of 5 s ledgers, for a getHealth reply that does not state its window. */
const DEFAULT_RETENTION_LEDGERS = 120_960;

/**
 * One ingest pass: reads events for exactly our token and payroll contracts
 * from the ledger after the last one read in full, page by page, up to the
 * RPC tip, the deadline or the page cap.
 *
 * Each page is stored in one transaction together with the ledger range it
 * proves was read in full, so the archive never records a range without its
 * events. If the next ledger needed is older than RPC's oldest ledger, those
 * ledgers are recorded as a gap (which raises the health alarm) and reading
 * continues from the oldest ledger. RPC's load balancer can route to a node
 * that restarted and holds less than the network, so a gap may be false.
 *
 * Healing is what undoes a false gap. Before reading forward, the pass heals
 * recorded gaps, oldest first, each from its first ledger not yet read in
 * full, using at most half the page cap and half the deadline between them.
 * A gap starting before the window RPC keeps is never tried. A heal reads
 * through the same checks as the forward read, trusts a page only at or
 * above the page's own oldestLedger, and removes the gap only in the
 * transaction that stores the page proving its last ledger read in full,
 * once recorded ranges cover the whole gap. A heal cut short by its share, a
 * refusal or any error leaves the gap and keeps what it read in full; an
 * error is logged as archive_heal_failed and the pass reads forward anyway.
 *
 * The start check, the same rule the prove script uses: an archive begun at
 * a configured start ledger vouches for the ledgers before it only if the
 * first token event it reads is in that ledger and comes from the token's
 * own deploy transaction (TOKEN_DEPLOY_TX). No token event can come before
 * the transaction that created the token, whatever order its constructor
 * emitted events in. The outcome is recorded in the same transaction as that
 * event. Anything else, or no deploy transaction configured, leaves it
 * vouching only from its start ledger, with a warning. It never vouches on
 * assumption. What this does not cover: the payroll contract emits nothing
 * when it is created, so payroll events before the start ledger are ruled
 * out only by payroll being deployed after the token, as the deploy script
 * does.
 *
 * Throws on RPC or database failure, or on an RPC reply that breaks the
 * rules, outside a heal, after keeping every page already stored. A deadline
 * is not a failure: the pass returns what it managed.
 */
export async function ingestOnce(db: Db, rpc: RpcClient, cfg: Config, opts: IngestOptions = {}): Promise<IngestResult> {
  const now = opts.now ?? (() => new Date());
  const limit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("pageLimit must be 1 to 1000");
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  // A big gap could otherwise take every page of every pass and stall the archive at its old tip.
  const healPageCap = Math.max(1, Math.floor(maxPages / 2));
  const deadline = opts.deadlineMs === undefined ? undefined : AbortSignal.timeout(opts.deadlineMs);
  // Heals get at most half the pass's time as well, so a slow or refusing node cannot spend the forward read's.
  const healDeadline =
    opts.deadlineMs === undefined || deadline === undefined
      ? undefined
      : AbortSignal.any([deadline, AbortSignal.timeout(Math.floor(opts.deadlineMs / 2))]);
  const contractIds = [cfg.TOKEN_CONTRACT_ID, cfg.PAYROLL_CONTRACT_ID];
  let pages = 0;
  let eventsStored = 0;
  let caughtUp = false;
  const healed: IngestResult["healed"] = [];

  const skipForgotten = async (next: number, health: RpcHealth): Promise<number> => {
    if (next >= health.oldestLedger) return next;
    await recordGap(db, next, health.oldestLedger - 1, now());
    return health.oldestLedger;
  };

  const configuredStart = opts.startLedger ?? cfg.ARCHIVE_START_LEDGER;
  const deployTx = opts.deployTx ?? cfg.TOKEN_DEPLOY_TX;
  const pass = async (): Promise<void> => {
    let health = await rpc.getHealth(deadline);
    let state = await readArchiveState(db);
    if (state.startLedger === null) {
      const checkStart = configuredStart !== undefined && deployTx !== undefined;
      const started = await setArchiveStart(db, configuredStart ?? health.oldestLedger, checkStart);
      if (started && configuredStart !== undefined && !checkStart) {
        opts.log?.warn("archive_start_unproven", {
          startLedger: configuredStart,
          meaning: "TOKEN_DEPLOY_TX is not set, so the archive vouches for nothing before its start ledger",
        });
      }
      state = await readArchiveState(db);
    }
    const startLedger = state.startLedger!;
    let startCheckPending = state.startCheckPending;

    /**
     * The one reader of pages. From `first` it reads to RPC's tip; given a
     * recorded `gap`, it heals that gap instead, from `first` inside it: it
     * stores only events inside the gap, records ranges only inside it, stays
     * within the heals' share of the page cap, and deletes the gap in the
     * transaction of the page that proves the gap's last ledger read in full,
     * once recorded ranges cover every ledger of the gap. Returns the last
     * ledger read in full from `first`.
     */
    const readPages = async (first: number, gap?: GapRecord): Promise<number> => {
      const last = gap?.toLedger;
      const pageCap = gap === undefined ? maxPages : healPageCap;
      const signal = gap === undefined ? deadline : healDeadline;
      let next = first;
      let readThrough = first - 1;
      let cursor: string | undefined;
      let lastCursor: RpcCursor | null = null;
      let retried = false;
      let startTries = 0;
      while (pages < pageCap) {
        if (signal?.aborted) return readThrough;
        let page: RpcEventsPage;
        try {
          page = await rpc.getEvents(
            cursor === undefined ? { startLedger: next, contractIds, limit } : { cursor, contractIds, limit },
            signal,
          );
        } catch (err) {
          const refused = err instanceof RpcError && err.code === RPC_INVALID_REQUEST;
          // A node behind the load balancer keeps less than the network. Only
          // the forward read may write ledgers off, so a heal refused on its
          // start page HEAL_START_TRIES times, or on any cursor page, keeps
          // what it read in full and leaves its gap for a later pass. Refused
          // calls spend the heals' page share like served ones.
          if (refused && gap !== undefined) {
            pages++;
            if (cursor === undefined && ++startTries < HEAL_START_TRIES) continue;
            return readThrough;
          }
          // RPC's floor can move between getHealth and getEvents. Look once more.
          if (refused && cursor === undefined && !retried) {
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
        const fullyRead = Math.min(fullyReadThrough(page, pageCursor, limit, readThrough), page.latestLedger, last ?? Infinity);
        if (rows.some((r) => r.ledger < next || r.ledger > page.latestLedger)) {
          throw new UpstreamDataError("event outside the requested ledgers");
        }
        // A node behind the load balancer that restarted holds only part of the
        // window, and may answer below its floor with nothing rather than
        // refuse. Its page vouches for nothing it does not hold. A heal needs
        // the node to say where its history starts; the forward read takes a
        // reply without that, as it always has.
        if (page.oldestLedger === undefined ? gap !== undefined : page.oldestLedger > readThrough + 1) return readThrough;
        // Past its gap a heal has no say: those ledgers are the forward read's to vouch for.
        const kept = last === undefined ? rows : rows.filter((r) => r.ledger <= last);
        const ending = gap !== undefined && fullyRead >= gap.toLedger ? gap : null;

        const firstTokenEvent = startCheckPending ? kept.find((r) => r.contractId === cfg.TOKEN_CONTRACT_ID) : undefined;
        const outcome = await db.transaction(async (tx) => {
          eventsStored += await insertEvents(tx, kept);
          if (fullyRead > readThrough) await addIngestedRange(tx, readThrough + 1, fullyRead);
          let removed = false;
          if (ending !== null && coversWhole(coverageOf(await readCoverage(tx)).ranges, ending)) {
            await deleteGap(tx, ending.fromLedger, ending.toLedger);
            removed = true;
          }
          await recordIngestProgress(tx, page.latestLedger, page.oldestLedger ?? health.oldestLedger, now());
          const settled =
            firstTokenEvent !== undefined && (await settleArchiveStart(tx, isDeployEvent(firstTokenEvent, startLedger, deployTx)));
          return { settled, removed };
        });
        if (fullyRead > readThrough) readThrough = fullyRead;
        if (firstTokenEvent !== undefined) {
          startCheckPending = false;
          if (outcome.settled) reportStartCheck(opts.log, startLedger, deployTx, firstTokenEvent);
        }

        if (ending !== null) {
          if (outcome.removed) healed.push({ fromLedger: ending.fromLedger, toLedger: ending.toLedger });
          return readThrough;
        }
        if (pageCursor === null) return readThrough;
        if (page.events.length < limit && pageCursor.endOfLedger && pageCursor.ledger >= page.latestLedger) {
          if (last === undefined) caughtUp = true;
          return readThrough;
        }
        lastCursor = pageCursor;
        cursor = page.cursor;
      }
      return readThrough;
    };

    // Gaps come oldest first, before the forward read, because a gap is what
    // makes readers refuse a balance; healPageCap keeps the rest of the pass
    // for the forward read. getHealth's floor is not consulted: it may come
    // from another node than getEvents, and every heal page proves its own.
    // A gap starting before the window RPC keeps can never be served again,
    // so it stays recorded and alarmed and no call is spent on it.
    const servedFrom = health.latestLedger - (health.ledgerRetentionWindow ?? DEFAULT_RETENTION_LEDGERS) + 1;
    for (const gap of (await readCoverage(db)).gaps) {
      // Resume where earlier passes stopped. A gap already covered in full
      // still needs a page proving its last ledger, so that ledger is read.
      const resume = Math.min(firstUnread(coverageOf(await readCoverage(db)).ranges, gap.fromLedger), gap.toLedger);
      if (resume < servedFrom) continue;
      try {
        await readPages(resume, gap);
      } catch (err) {
        if (stoppedBy(deadline, err)) throw err;
        // Out of heal time: this heal ends quietly. Any other failure ends it
        // too, with its gap kept, and never stops the forward read.
        if (stoppedBy(healDeadline, err)) continue;
        opts.log?.warn("archive_heal_failed", {
          fromLedger: gap.fromLedger,
          toLedger: gap.toLedger,
          error: err instanceof Error ? err.name + ": " + err.message : "unknown",
        });
      }
    }

    const through = ingestedThrough(coverageOf(await readCoverage(db)));
    const from = await skipForgotten(through > 0 ? through + 1 : startLedger, health);
    if (from > health.latestLedger) {
      caughtUp = true;
      await recordIngestProgress(db, health.latestLedger, health.oldestLedger, now());
      return;
    }
    await readPages(from);
  };

  try {
    await pass();
  } catch (err) {
    if (!stoppedBy(deadline, err)) throw err;
  }
  const coverage = coverageOf(await readCoverage(db));
  return {
    ingestedThrough: ingestedThrough(coverage),
    gaps: coverage.gaps,
    eventsStored,
    pages,
    caughtUp,
    healed,
  };
}

/** True when `err` is the call that `signal` cut off, not some other failure. */
const stoppedBy = (signal: AbortSignal | undefined, err: unknown): boolean =>
  signal?.aborted === true && err instanceof OutboundError && err.failure === "aborted";

/** The first ledger at or after `from` that no merged range read in full covers. */
function firstUnread(ranges: ReadonlyArray<readonly [number, number]>, from: number): number {
  let next = from;
  for (const [rangeFrom, rangeTo] of ranges) if (rangeFrom <= next && rangeTo >= next) next = rangeTo + 1;
  return next;
}

/** True when one merged range read in full spans every ledger of the gap. */
const coversWhole = (ranges: ReadonlyArray<readonly [number, number]>, gap: GapRecord): boolean =>
  ranges.some(([from, to]) => from <= gap.fromLedger && to >= gap.toLedger);

/** Both sides are lower-case hex: RPC hashes are checked in toRow, TOKEN_DEPLOY_TX in config. */
const isDeployEvent = (first: EventRow, startLedger: number, deployTx: string | undefined): boolean =>
  deployTx !== undefined && first.ledger === startLedger && first.txHash === deployTx;

function reportStartCheck(log: Logger | undefined, startLedger: number, deployTx: string | undefined, first: EventRow): void {
  if (isDeployEvent(first, startLedger, deployTx)) {
    log?.info("archive_start_proven", { startLedger, deployTx });
    return;
  }
  log?.warn("archive_start_unproven", {
    startLedger,
    firstTokenEvent: first.eventName,
    firstTokenLedger: first.ledger,
    firstTokenTx: first.txHash,
    meaning:
      "the first token event read is not from the token's deploy transaction in the start ledger, so the archive vouches for nothing before it; " +
      "ARCHIVE_START_LEDGER and TOKEN_DEPLOY_TX must be the token's deployTx ledger and hash from packages/contracts/deployments/testnet.json",
  });
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

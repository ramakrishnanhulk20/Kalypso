import { requireAccount, requireU64 } from '../chain/scval.js';
import { TOKEN_CONFIG_EVENTS, decodeContractEvent, type HistoryEvent } from './decode.js';
import { parseRpcEventId, type ContractEventsQuery, type EventsPort, type RawContractEvent } from './rpc-events.js';

/** Our archive server (packages/server/src/archive/api.ts). Its URL comes from app config only, never from a request. */
export interface ArchiveConfig {
  baseUrl: string;
}

/** Where history comes from: the archive when one is configured, the RPC otherwise. */
export interface HistorySource {
  archive?: ArchiveConfig;
  rpc: EventsPort;
  /** The first ledger to read. Use a ledger at or before the account's registration. */
  fromLedger: number;
}

/**
 * Events in ledger order, deduplicated by event id. complete is true only when the source
 * vouched for every ledger from fromLedger to ingestedThrough with no gap (threat model C17);
 * a reader that replays an incomplete history must not show its result as a balance.
 */
export interface HistoryResult {
  events: HistoryEvent[];
  complete: boolean;
  ingestedThrough: number;
  source: 'archive' | 'rpc';
}

export const ARCHIVE_TIMEOUT_MS = 10_000;

/** How far a history may end behind the newest ledger and still count as current: about one minute of ledgers. */
export const INGEST_TOLERANCE_LEDGERS = 12;

/**
 * True when a history that ends at ingestedThrough reaches to within INGEST_TOLERANCE_LEDGERS of
 * latestLedger, the newest ledger the caller's chain reads could reflect. A history that ends
 * earlier may be missing events the chain already shows, so it is not complete whatever its
 * source says (threat model C17).
 */
export function reachesLedger(ingestedThrough: number, latestLedger: number): boolean {
  return Number.isInteger(ingestedThrough) && ingestedThrough >= latestLedger - INGEST_TOLERANCE_LEDGERS;
}

/** The archive's and the RPC's own page cap. */
const PAGE_LIMIT = 200;
/** 50,000 events. A history that needs more pages is reported incomplete, never cut short silently. */
const MAX_PAGES = 250;
const MAX_REPLY_CHARS = 4_000_000;
const MAX_LEDGER = 0xffff_ffff;
const TX_HASH = /^[0-9a-f]{64}$/;
const ARCHIVE_CURSOR = /^\d{1,10}-\d{1,7}-\d{1,4}-\d{1,10}$/;
const HTTPS_BASE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/** The archive answered something other than the reply shape api.ts defines. History falls back to RPC. */
class ArchiveReplyError extends Error {
  constructor(what: string) {
    super(`The archive reply was refused: ${what}.`);
    this.name = 'ArchiveReplyError';
  }
}

// The build targets plain ES2022 without DOM or Node types; every runtime Kalypso runs in has these.
const net = globalThis as unknown as {
  fetch(url: string, init: { signal: unknown; headers: Record<string, string>; redirect: 'error' }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  AbortSignal: { timeout(ms: number): unknown };
};

async function getJson(url: string): Promise<unknown> {
  // redirect "error": a reply may only come from the configured origin.
  const response = await net.fetch(url, {
    signal: net.AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) throw new ArchiveReplyError(`status ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_REPLY_CHARS) throw new ArchiveReplyError('the reply is too large');
  return JSON.parse(text) as unknown;
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ArchiveReplyError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** One api.ts v1Row, checked field by field. The contract must be the one asked for, after the address parser. */
function archiveRow(value: unknown, contractId: string, fromLedger: number): RawContractEvent {
  const row = record(value, 'an event row');
  const { ledger_seq, tx_hash, tx_application_order, operation_index, event_index, contract_id, topics_xdr, data_xdr } = row;
  if (!isIntIn(ledger_seq, fromLedger, MAX_LEDGER)) throw new ArchiveReplyError('an event ledger is outside the requested range');
  if (typeof tx_hash !== 'string' || !TX_HASH.test(tx_hash)) throw new ArchiveReplyError('an event transaction hash is malformed');
  if (!isIntIn(tx_application_order, 0, 0xf_ffff) || !isIntIn(operation_index, 0, 0xfff) || !isIntIn(event_index, 0, MAX_LEDGER)) {
    throw new ArchiveReplyError('an event position is malformed');
  }
  let contract: string;
  try {
    contract = requireAccount(contract_id as string, ['C']);
  } catch {
    throw new ArchiveReplyError('an event contract id is malformed');
  }
  if (contract !== contractId) throw new ArchiveReplyError('an event came from another contract');
  if (!Array.isArray(topics_xdr) || !topics_xdr.every((t) => typeof t === 'string') || typeof data_xdr !== 'string') {
    throw new ArchiveReplyError('an event has no XDR');
  }
  return {
    ledger: ledger_seq,
    txHash: tx_hash,
    txIndex: tx_application_order,
    opIndex: operation_index,
    eventIndex: event_index,
    contractId: contract,
    topicsXdr: topics_xdr as string[],
    dataXdr: data_xdr,
  };
}

/** mine: the event is about the account or company asked for. unknown: it is ours but unreadable, so nobody can tell. */
type Attribution = 'mine' | 'other' | 'unknown';

interface Target {
  contractId: string;
  archivePath: string;
  attribute(event: HistoryEvent): Attribution;
}

interface FetchInput {
  port: EventsPort;
  archive?: ArchiveConfig;
  contracts: { token: string; payroll: string };
  fromLedger: number;
}

function finish(events: HistoryEvent[], complete: boolean, ingestedThrough: number, source: 'archive' | 'rpc'): HistoryResult {
  const byId = new Map<string, HistoryEvent>();
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event);
  const ordered = [...byId.values()].sort(
    (a, b) => a.ledger - b.ledger || a.txIndex - b.txIndex || a.opIndex - b.opIndex || a.eventIndex - b.eventIndex,
  );
  return { events: ordered, complete, ingestedThrough, source };
}

async function fromArchive(contracts: { token: string; payroll: string }, target: Target, base: string, fromLedger: number) {
  const events: HistoryEvent[] = [];
  let complete = true;
  let ingestedThrough = MAX_LEDGER;
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      complete = false;
      break;
    }
    const query = `?from_ledger=${fromLedger}&limit=${PAGE_LIMIT}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const body = record(await getJson(`${base}${target.archivePath}${query}`), 'the reply');
    const rows = body.events;
    if (!Array.isArray(rows) || rows.length > PAGE_LIMIT) throw new ArchiveReplyError('the events list is missing or too long');
    if (typeof body.complete !== 'boolean' || !isIntIn(body.ingested_through, 0, MAX_LEDGER)) {
      throw new ArchiveReplyError('the reply has no complete or ingested_through field');
    }
    const next = body.cursor;
    if (next !== null && (typeof next !== 'string' || !ARCHIVE_CURSOR.test(next) || next === cursor)) {
      throw new ArchiveReplyError('the cursor is malformed or did not advance');
    }
    for (const row of rows) {
      const event = decodeContractEvent(archiveRow(row, target.contractId, fromLedger), contracts);
      const attribution = target.attribute(event);
      if (attribution === 'other') throw new ArchiveReplyError('the archive returned an event that is not about what was asked');
      if (attribution === 'unknown') complete = false;
      else events.push(event);
    }
    complete &&= body.complete;
    ingestedThrough = Math.min(ingestedThrough, body.ingested_through);
    if (next === null) break;
    cursor = next;
  }
  return finish(events, complete, ingestedThrough, 'archive');
}

async function fromRpc(input: FetchInput, contracts: { token: string; payroll: string }, target: Target, fromLedger: number) {
  const window = await input.port.ledgerWindow();
  const start = Math.max(fromLedger, window.oldestLedger);
  // The RPC keeps about 7 days. Ledgers older than its window are simply not there to read.
  let complete = fromLedger >= window.oldestLedger;
  if (start > window.latestLedger) return finish([], complete, window.latestLedger, 'rpc');

  const events: HistoryEvent[] = [];
  let query: ContractEventsQuery = { contractId: target.contractId, limit: PAGE_LIMIT, startLedger: start };
  let through = start - 1;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      complete = false;
      break;
    }
    const reply = await input.port.contractEvents(query);
    for (const raw of reply.events) {
      // A failed call changed no balance, so replaying its events would.
      if (!raw.successful || raw.contractId !== target.contractId || raw.ledger < start) continue;
      const event = decodeContractEvent(raw, contracts);
      const attribution = target.attribute(event);
      if (attribution === 'mine') events.push(event);
      if (attribution === 'unknown') complete = false;
    }
    if (reply.cursor === null) {
      through = reply.latestLedger;
      break;
    }
    const scanned = parseRpcEventId(reply.cursor).ledger;
    through = Math.min(scanned, reply.latestLedger);
    // A full page can end part way through the newest ledger, so only a short page that has
    // scanned to the newest ledger means there is nothing left to read.
    if (reply.events.length < PAGE_LIMIT && scanned >= reply.latestLedger) break;
    if ('cursor' in query && query.cursor === reply.cursor) {
      complete = false;
      break;
    }
    query = { contractId: target.contractId, limit: PAGE_LIMIT, cursor: reply.cursor };
  }
  return finish(events, complete, through, 'rpc');
}

function requireFromLedger(fromLedger: number): number {
  if (!Number.isInteger(fromLedger) || fromLedger < 0 || fromLedger > MAX_LEDGER) throw new RangeError('fromLedger must be a ledger number');
  // There is no ledger 0, so "from 0" means from ledger 1, as the archive reads it.
  return Math.max(fromLedger, 1);
}

/**
 * A configured service origin (the archive, Horizon), with a trailing slash. Only https, a plain
 * host and path, no query, fragment or credentials, so a path appended to it stays on that origin.
 *
 * @throws TypeError for anything else, naming the setting.
 */
export function httpsBaseUrl(baseUrl: unknown, setting: string): string {
  if (typeof baseUrl !== 'string' || !HTTPS_BASE.test(baseUrl)) throw new TypeError(`${setting} must be an https URL with no query`);
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function archiveBase(archive: ArchiveConfig): string {
  return httpsBaseUrl(archive?.baseUrl, 'archive.baseUrl');
}

async function fetchHistory(input: FetchInput, target: Target): Promise<HistoryResult> {
  const fromLedger = requireFromLedger(input.fromLedger);
  const contracts = { token: requireAccount(input.contracts.token, ['C']), payroll: requireAccount(input.contracts.payroll, ['C']) };
  if (input.archive !== undefined) {
    const base = archiveBase(input.archive);
    try {
      return await fromArchive(contracts, target, base, fromLedger);
    } catch {
      // Unreachable, slow, or answering out of shape: the RPC is the fallback for its own window.
    }
  }
  return fromRpc(input, contracts, target, fromLedger);
}

function tokenParties(event: HistoryEvent): string[] | null {
  if (event.kind === 'token') {
    const e = event.event;
    return e.type === 'register' || e.type === 'merge' ? [e.account] : [e.from, e.to];
  }
  if (event.kind === 'payroll') return [];
  // decodeContractEvent let these through as ignored only with their one name topic.
  if (event.kind === 'ignored' && event.contract === 'token' && TOKEN_CONFIG_EVENTS.has(event.name)) return [];
  return event.parties.length > 0 ? event.parties : null;
}

/**
 * Every event of our confidential token that names `account` (register, deposit, merge,
 * withdraw, transfer, to or from it), from fromLedger to the newest ledger the source holds.
 *
 * Reads the archive's /v1/tokens/{token}/accounts/{account}/events route when archive is set,
 * and passes its complete flag through unchanged. If the archive cannot be reached or answers
 * out of shape, it reads the RPC's window instead, where complete is false when fromLedger is
 * older than that window. An event of ours that cannot be read and might be this account's
 * makes the result incomplete.
 *
 * @throws RangeError for a bad fromLedger, TypeError for a bad archive URL, AddressError for a
 *   bad account or contract id, or the RPC's own error when the fallback cannot be read either.
 */
export async function fetchAccountHistory(input: FetchInput & { account: string }): Promise<HistoryResult> {
  const account = requireAccount(input.account, ['G', 'C']);
  const token = requireAccount(input.contracts.token, ['C']);
  return fetchHistory(input, {
    contractId: token,
    archivePath: `v1/tokens/${token}/accounts/${account}/events`,
    attribute(event) {
      if (event.kind === 'payroll') return 'other';
      const parties = tokenParties(event);
      if (parties === null) return 'unknown';
      return parties.includes(account) ? 'mine' : 'other';
    },
  });
}

/**
 * Every event of our payroll contract for one company (created, admin changes, runs opened,
 * payslips issued and the rest), from fromLedger to the newest ledger the source holds. Same
 * source rules as fetchAccountHistory, over the archive's /v1/payroll/{payroll}/companies/{id}/events route.
 */
export async function fetchCompanyHistory(input: FetchInput & { companyId: bigint }): Promise<HistoryResult> {
  const companyId = requireU64(input.companyId, 'companyId');
  const payroll = requireAccount(input.contracts.payroll, ['C']);
  return fetchHistory(input, {
    contractId: payroll,
    archivePath: `v1/payroll/${payroll}/companies/${companyId}/events`,
    attribute(event) {
      const id = event.kind === 'payroll' ? event.event.companyId : event.kind === 'token' ? null : event.companyId;
      if (event.kind === 'token') return 'other';
      if (id === undefined || id === null) return 'unknown';
      return id === companyId ? 'mine' : 'other';
    },
  });
}

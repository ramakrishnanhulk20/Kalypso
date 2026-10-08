import type { PGlite, Transaction as PgliteTransaction } from "@electric-sql/pglite";
import postgres from "postgres";
import { SCHEMA_SQL } from "./schema.ts";

/*
 * Every query in this file is a constant string with $n placeholders, and
 * every value travels as a bind parameter. Nothing is spliced into SQL text.
 * Lists travel as one JSON parameter and are unpacked in SQL, which keeps the
 * two drivers (PGlite in tests, postgres in production) behaving the same.
 */

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction; nested calls join the outer one. */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  /** Multi-statement SQL with no parameters. Used for the schema only. */
  exec(text: string): Promise<void>;
}

type PgliteLike = PGlite | PgliteTransaction;

export function pgliteDb(pg: PgliteLike): Db {
  const db: Db = {
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      (await pg.query<T>(text, [...params])).rows,
    transaction: async (fn) => ("transaction" in pg ? pg.transaction((tx) => fn(pgliteDb(tx))) : fn(db)),
    exec: async (text) => {
      await pg.exec(text);
    },
  };
  return db;
}

type Sql = postgres.Sql | postgres.TransactionSql;

export function postgresDb(sql: Sql): Db {
  const db: Db = {
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[],
    transaction: async (fn) =>
      "begin" in sql ? ((await sql.begin((tx) => fn(postgresDb(tx)))) as Awaited<ReturnType<typeof fn>>) : fn(db),
    exec: async (text) => {
      await sql.unsafe(text);
    },
  };
  return db;
}

/**
 * Opens a production connection pool. `readOnly` makes every transaction on
 * the session read-only, on top of the read-only role the API URL should
 * use, so a mistaken grant still cannot let an API query write.
 * Every statement is cut off after 5 s.
 */
export function connectPostgres(url: string, opts: { readOnly?: boolean } = {}): Db {
  const connection: Record<string, string> = { statement_timeout: "5000", application_name: "kalypso-server" };
  if (opts.readOnly) connection.default_transaction_read_only = "on";
  return postgresDb(postgres(url, { max: 3, connect_timeout: 10, idle_timeout: 20, prepare: false, connection }));
}

export function schemaSql(): string {
  return SCHEMA_SQL;
}

export async function applySchema(db: Db): Promise<void> {
  await db.exec(schemaSql());
}

const BUMP_IP_HOUR =
  "insert into ip_hour (ip_bucket, hour_start, count) values ($1, $2::timestamptz, 1) " +
  "on conflict (ip_bucket, hour_start) do update set count = ip_hour.count + 1 " +
  "where ip_hour.count < $3 returning count";
const PRUNE_IP_HOUR = "delete from ip_hour where hour_start < $1::timestamptz";

/**
 * Counts one sponsor request for an IP bucket in the hour starting at
 * `hourStart`. Returns false, and counts nothing, once the bucket has used
 * `limit` requests that hour. One statement, so it is atomic.
 */
export async function countSponsorRequest(db: Db, bucket: string, hourStart: Date, limit: number): Promise<boolean> {
  const rows = await db.query(BUMP_IP_HOUR, [bucket, hourStart.toISOString(), limit]);
  await db.query(PRUNE_IP_HOUR, [new Date(hourStart.getTime() - 3_600_000).toISOString()]);
  return rows.length === 1;
}

const BUMP_ADDRESS_DAY =
  "insert into address_day (address, day, count) select t.address, $2::date, 1 " +
  "from jsonb_array_elements_text($1::jsonb) as t(address) " +
  "on conflict (address, day) do update set count = address_day.count + 1 " +
  "where address_day.count < $3 returning address";
const PRUNE_ADDRESS_DAY = "delete from address_day where day < $1::date - 1";

class AddressLimitReached extends Error {}

/**
 * Counts one relay on `day` for each authorising address. All or nothing:
 * when any of them has already used `limit` relays that day, nothing is
 * counted and it returns false. Each bump is conditional on the row's own
 * count and they share one transaction, so concurrent relays cannot push an
 * address past the limit or leave half a request counted.
 */
export async function countAuthoriserRelays(db: Db, addresses: readonly string[], day: string, limit: number): Promise<boolean> {
  const unique = [...new Set(addresses)];
  let counted = true;
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.query(BUMP_ADDRESS_DAY, [JSON.stringify(unique), day, limit]);
      if (rows.length !== unique.length) throw new AddressLimitReached();
    });
  } catch (err) {
    if (!(err instanceof AddressLimitReached)) throw err;
    counted = false;
  }
  await db.query(PRUNE_ADDRESS_DAY, [day]);
  return counted;
}

// One statement, so all or nothing. Both halves read the same snapshot, so a
// row at 1 is deleted and never also decremented.
const RELEASE_ADDRESS_DAY =
  "with wanted as (select distinct t.address from jsonb_array_elements_text($1::jsonb) as t(address)), " +
  "dropped as (delete from address_day where day = $2::date and count = 1 and address in (select address from wanted) returning address) " +
  "update address_day set count = address_day.count - 1 where day = $2::date and count > 1 and address in (select address from wanted)";

/**
 * Gives back the relay countAuthoriserRelays counted on `day` for each
 * address, when that relay provably never reached the network (the daily
 * budget refused it, or Channels refused it before submission). A count reaching zero
 * removes its row, so no count ever goes below zero.
 */
export async function releaseAuthoriserRelays(db: Db, addresses: readonly string[], day: string): Promise<void> {
  await db.query(RELEASE_ADDRESS_DAY, [JSON.stringify([...new Set(addresses)]), day]);
}

const RESERVE_DAY_BUDGET =
  "insert into day_budget (day, spent_stroops) values ($1::date, $2::bigint) " +
  "on conflict (day) do update set spent_stroops = day_budget.spent_stroops + excluded.spent_stroops " +
  "where day_budget.spent_stroops + excluded.spent_stroops <= $3::bigint returning spent_stroops::text as spent";

/**
 * Reserves `stroops` of the day's fee budget before a relay, so concurrent
 * relays cannot overspend it. Returns false when the reservation would pass
 * `budget`. A reservation is kept whenever the relay's outcome is unknown
 * (a timeout, a 5xx, a garbled reply), because the fee may have been spent;
 * only releaseDailyFee gives one back.
 */
export async function reserveDailyFee(db: Db, day: string, stroops: bigint, budget: bigint): Promise<boolean> {
  if (stroops > budget || stroops < 0n) return false;
  const rows = await db.query(RESERVE_DAY_BUDGET, [day, stroops.toString(), budget.toString()]);
  return rows.length === 1;
}

const RELEASE_DAY_BUDGET =
  "update day_budget set spent_stroops = greatest(day_budget.spent_stroops - $2::bigint, 0) where day = $1::date";

/**
 * Gives back a reservation made on `day` for a relay that provably never
 * reached the network (Channels refused it before submission). Floored at zero, so
 * no release can leave the day with more budget than it started with.
 */
export async function releaseDailyFee(db: Db, day: string, stroops: bigint): Promise<void> {
  if (stroops <= 0n) return;
  await db.query(RELEASE_DAY_BUDGET, [day, stroops.toString()]);
}

const CLAIM_RELAY =
  "insert into relay_dedupe (digest, claimed_at) values ($1, $2::timestamptz) " +
  "on conflict (digest) do update set claimed_at = excluded.claimed_at, hold_until_ledger = null, " +
  "transaction_id = null, status = null " +
  "where relay_dedupe.hold_until_ledger is null and relay_dedupe.claimed_at <= $3::timestamptz returning digest";
const READ_RELAY = "select transaction_id, status from relay_dedupe where digest = $1";
const PRUNE_UNHELD_RELAYS = "delete from relay_dedupe where hold_until_ledger is null and claimed_at < $1::timestamptz";

export type RelayClaim =
  | { claimed: true; claimedAt: Date }
  | { claimed: false; transactionId: string | null; status: string | null };

/**
 * Claims the right to relay the body with this digest. Fails while an
 * earlier claim on it stands: one held to a ledger by holdRelay stands until
 * forgetExpiredRelays removes it, and one not held stands for `windowMs`.
 * A failed claim returns what the earlier relay got back (no transaction id
 * means it is still in flight, or its outcome is unknown). One atomic
 * statement, so two copies arriving together cannot both relay.
 */
export async function claimRelay(db: Db, digest: string, now: Date, windowMs: number): Promise<RelayClaim> {
  await db.query(PRUNE_UNHELD_RELAYS, [new Date(now.getTime() - 3_600_000).toISOString()]);
  const claimed = await db.query(CLAIM_RELAY, [digest, now.toISOString(), new Date(now.getTime() - windowMs).toISOString()]);
  if (claimed.length === 1) return { claimed: true, claimedAt: now };
  const rows = await db.query<{ transaction_id: string | null; status: string | null }>(READ_RELAY, [digest]);
  return { claimed: false, transactionId: rows[0]?.transaction_id ?? null, status: rows[0]?.status ?? null };
}

const CLAIM_AUTH =
  "insert into relay_auth (address, nonce, digest, claimed_at, expiry_ledger) " +
  "select e.address, e.nonce, $2, $3::timestamptz, e.expiry_ledger " +
  "from jsonb_to_recordset($1::jsonb) as e(address text, nonce text, expiry_ledger integer) " +
  "on conflict (address, nonce) do update set digest = excluded.digest, claimed_at = excluded.claimed_at, " +
  "expiry_ledger = excluded.expiry_ledger, held = false " +
  "where not relay_auth.held and relay_auth.claimed_at <= $4::timestamptz returning address";
const PRUNE_UNHELD_AUTH = "delete from relay_auth where not held and claimed_at < $1::timestamptz";

class AuthEntryInUse extends Error {}

/** One signed auth entry: who signed it, its nonce, and its own expiry ledger. */
export interface AuthEntryKey {
  address: string;
  nonce: string;
  expiryLedger: number;
}

/**
 * Claims every signed auth entry of the body with this digest, made by the
 * claim at `claimedAt`. All or nothing: false when any entry is already
 * claimed by another body, held until its own expiry or claimed less than
 * `windowMs` ago, and then nothing is claimed. The network uses an entry up
 * once per (address, nonce) whatever body carries it, so this is what stops
 * one signed entry rewrapped in a new body from being relayed twice.
 */
export async function claimAuthEntries(
  db: Db,
  entries: readonly AuthEntryKey[],
  digest: string,
  claimedAt: Date,
  windowMs: number,
): Promise<boolean> {
  await db.query(PRUNE_UNHELD_AUTH, [new Date(claimedAt.getTime() - 3_600_000).toISOString()]);
  const records = entries.map((e) => ({ address: e.address, nonce: e.nonce, expiry_ledger: e.expiryLedger }));
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.query(CLAIM_AUTH, [
        JSON.stringify(records),
        digest,
        claimedAt.toISOString(),
        new Date(claimedAt.getTime() - windowMs).toISOString(),
      ]);
      if (rows.length !== records.length) throw new AuthEntryInUse();
    });
  } catch (err) {
    if (!(err instanceof AuthEntryInUse)) throw err;
    return false;
  }
  return true;
}

// One statement each, so a claim's body and its entries are held or let go together.
const HOLD_RELAY =
  "with body as (update relay_dedupe set hold_until_ledger = $3 where digest = $1 and claimed_at = $2::timestamptz returning digest) " +
  "update relay_auth set held = true where digest = $1 and claimed_at = $2::timestamptz";
const RELEASE_RELAY =
  "with body as (delete from relay_dedupe where digest = $1 and claimed_at = $2::timestamptz and transaction_id is null returning digest) " +
  "delete from relay_auth where digest = $1 and claimed_at = $2::timestamptz and exists (select 1 from body)";

/**
 * Keeps a claimed body from being relayed again until the network passes
 * `untilLedger`, the last ledger its auth entries can be used in, and keeps
 * each of its signed entries until that entry's own expiry ledger. Called
 * before the relay, so a timeout or a 5xx leaves them held too.
 */
export async function holdRelay(db: Db, digest: string, claimedAt: Date, untilLedger: number): Promise<void> {
  await db.query(HOLD_RELAY, [digest, claimedAt.toISOString(), untilLedger]);
}

/**
 * Forgets every held body and every held entry whose last usable ledger the
 * network has reached (`latestLedger`, from a simulation). None of them can
 * land any more, and simulation refuses a later copy as auth_expired, so it
 * never reaches Channels.
 */
export async function forgetExpiredRelays(db: Db, latestLedger: number): Promise<void> {
  await db.query("delete from relay_dedupe where hold_until_ledger <= $1", [latestLedger]);
  await db.query("delete from relay_auth where held and expiry_ledger <= $1", [latestLedger]);
}

export async function recordRelay(db: Db, digest: string, claimedAt: Date, transactionId: string, status: string): Promise<void> {
  await db.query(
    "update relay_dedupe set transaction_id = $3, status = $4 where digest = $1 and claimed_at = $2::timestamptz",
    [digest, claimedAt.toISOString(), transactionId, status],
  );
}

/**
 * Gives a claim back, its signed entries with it, when nothing was relayed,
 * so the same body or the same entries can be sent again at once. A claim
 * that already recorded a relay is never given back.
 */
export async function releaseRelay(db: Db, digest: string, claimedAt: Date): Promise<void> {
  await db.query(RELEASE_RELAY, [digest, claimedAt.toISOString()]);
}

/** One archived event: the verbatim XDR plus the decoded columns used to query it. */
export interface EventRow {
  id: string;
  ledger: number;
  txHash: string;
  txIndex: number;
  opIndex: number;
  eventIndex: number;
  contractId: string;
  eventName: string | null;
  topic1Address: string | null;
  accounts: string[];
  companyId: string | null;
  topicsXdr: string[];
  valueXdr: string;
  ledgerClosedAt: string;
}

const INSERT_EVENTS =
  "insert into events (id, ledger, tx_hash, tx_index, op_index, event_index, contract_id, event_name, " +
  "topic1_address, accounts, company_id, topics_xdr, value_xdr, ledger_closed_at) " +
  "select r.id, r.ledger, r.tx_hash, r.tx_index, r.op_index, r.event_index, r.contract_id, r.event_name, " +
  "r.topic1_address, array(select jsonb_array_elements_text(r.accounts)), r.company_id, " +
  "array(select jsonb_array_elements_text(r.topics_xdr)), r.value_xdr, r.ledger_closed_at " +
  "from jsonb_to_recordset($1::jsonb) as r(id text, ledger integer, tx_hash text, tx_index integer, " +
  "op_index integer, event_index integer, contract_id text, event_name text, topic1_address text, " +
  "accounts jsonb, company_id text, topics_xdr jsonb, value_xdr text, ledger_closed_at timestamptz) " +
  "on conflict (id) do nothing returning id";

/** Stores a page of events in one statement, keeping the first copy of any id. Returns how many were new. */
export async function insertEvents(db: Db, rows: readonly EventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const records = rows.map((r) => ({
    id: r.id,
    ledger: r.ledger,
    tx_hash: r.txHash,
    tx_index: r.txIndex,
    op_index: r.opIndex,
    event_index: r.eventIndex,
    contract_id: r.contractId,
    event_name: r.eventName,
    topic1_address: r.topic1Address,
    accounts: r.accounts,
    company_id: r.companyId,
    topics_xdr: r.topicsXdr,
    value_xdr: r.valueXdr,
    ledger_closed_at: r.ledgerClosedAt,
  }));
  return (await db.query(INSERT_EVENTS, [JSON.stringify(records)])).length;
}

// Absorbs every range that overlaps or touches [$1, $2] into one row.
const ADD_RANGE =
  "with absorbed as (delete from ingested_ranges where from_ledger <= $2::integer + 1 " +
  "and to_ledger >= $1::integer - 1 returning from_ledger, to_ledger) " +
  "insert into ingested_ranges (from_ledger, to_ledger) " +
  "select least($1::integer, coalesce(min(from_ledger), $1::integer)), " +
  "greatest($2::integer, coalesce(max(to_ledger), $2::integer)) from absorbed";

export async function addIngestedRange(db: Db, fromLedger: number, toLedger: number): Promise<void> {
  await db.query(ADD_RANGE, [fromLedger, toLedger]);
}

export interface GapRecord {
  fromLedger: number;
  toLedger: number;
  detectedAt: Date;
}

export async function recordGap(db: Db, fromLedger: number, toLedger: number, detectedAt: Date): Promise<void> {
  await db.query(
    "insert into gaps (from_ledger, to_ledger, detected_at) values ($1, $2, $3::timestamptz) on conflict do nothing",
    [fromLedger, toLedger, detectedAt.toISOString()],
  );
}

export interface ArchiveState {
  startLedger: number | null;
  /** Proven by the start check, never assumed: see settleArchiveStart. */
  coversFromGenesis: boolean;
  /** The archive began at a configured ledger and has not yet read a token event. */
  startCheckPending: boolean;
  latestLedger: number | null;
  rpcOldestLedger: number | null;
  lastIngestAt: Date | null;
}

export async function readArchiveState(db: Db): Promise<ArchiveState> {
  const rows = await db.query<{
    start_ledger: number | null;
    covers_from_genesis: boolean;
    start_check_pending: boolean;
    latest_ledger: number | null;
    rpc_oldest_ledger: number | null;
    last_ingest_at: Date | null;
  }>(
    "select start_ledger, covers_from_genesis, start_check_pending, latest_ledger, rpc_oldest_ledger, last_ingest_at " +
      "from archive_state where id = 1",
  );
  const row = rows[0];
  return {
    startLedger: row?.start_ledger ?? null,
    coversFromGenesis: row?.covers_from_genesis ?? false,
    startCheckPending: row?.start_check_pending ?? false,
    latestLedger: row?.latest_ledger ?? null,
    rpcOldestLedger: row?.rpc_oldest_ledger ?? null,
    lastIngestAt: row?.last_ingest_at ? new Date(row.last_ingest_at) : null,
  };
}

/**
 * Sets where the archive begins, once; later calls change nothing and return
 * false. It never covers from genesis at this point. `checkStart` marks the
 * start check as pending, for an archive begun at a configured ledger with
 * the token's deploy transaction known.
 */
export async function setArchiveStart(db: Db, startLedger: number, checkStart: boolean): Promise<boolean> {
  const rows = await db.query(
    "update archive_state set start_ledger = $1, covers_from_genesis = false, start_check_pending = $2 " +
      "where id = 1 and start_ledger is null returning id",
    [startLedger, checkStart],
  );
  return rows.length === 1;
}

/**
 * Records the start check's outcome, once: `proven` when the first token
 * event the archive read came from the token's own deploy transaction. Returns false
 * when another pass already recorded it, so only the pass that decided it
 * reports it.
 */
export async function settleArchiveStart(db: Db, proven: boolean): Promise<boolean> {
  const rows = await db.query(
    "update archive_state set covers_from_genesis = $1, start_check_pending = false where id = 1 and start_check_pending returning id",
    [proven],
  );
  return rows.length === 1;
}

export async function recordIngestProgress(db: Db, latestLedger: number, rpcOldestLedger: number, at: Date): Promise<void> {
  await db.query(
    "update archive_state set latest_ledger = greatest(coalesce(latest_ledger, 0), $1), " +
      "rpc_oldest_ledger = $2, last_ingest_at = $3::timestamptz where id = 1",
    [latestLedger, rpcOldestLedger, at.toISOString()],
  );
}

/**
 * Claims the right to run a lazy catch-up, at most once per `minIntervalMs`
 * across every server instance. One atomic update, so two requests landing
 * together cannot both start one.
 */
export async function claimIngestSlot(db: Db, now: Date, minIntervalMs: number): Promise<boolean> {
  const rows = await db.query(
    "update archive_state set ingest_started_at = $1::timestamptz where id = 1 and " +
      "(ingest_started_at is null or ingest_started_at <= $2::timestamptz) returning id",
    [now.toISOString(), new Date(now.getTime() - minIntervalMs).toISOString()],
  );
  return rows.length === 1;
}

export interface CoverageRows {
  ranges: Array<[number, number]>;
  gaps: GapRecord[];
  state: ArchiveState;
}

export async function readCoverage(db: Db): Promise<CoverageRows> {
  const ranges = await db.query<{ from_ledger: number; to_ledger: number }>(
    "select from_ledger, to_ledger from ingested_ranges order by from_ledger, to_ledger",
  );
  const gaps = await db.query<{ from_ledger: number; to_ledger: number; detected_at: Date }>(
    "select from_ledger, to_ledger, detected_at from gaps order by from_ledger",
  );
  return {
    ranges: ranges.map((r) => [r.from_ledger, r.to_ledger]),
    gaps: gaps.map((g) => ({ fromLedger: g.from_ledger, toLedger: g.to_ledger, detectedAt: new Date(g.detected_at) })),
    state: await readArchiveState(db),
  };
}

export interface StoredEvent {
  id: string;
  ledger: number;
  txHash: string;
  txIndex: number;
  opIndex: number;
  eventIndex: number;
  contractId: string;
  topicsXdr: string[];
  valueXdr: string;
  ledgerClosedAt: Date;
}

/** A point in the archive's total order: (ledger, tx_index, op_index, event_index). */
export interface Position {
  ledger: number;
  txIndex: number;
  opIndex: number;
  eventIndex: number;
}

const BEFORE_EVERYTHING: Position = { ledger: 0, txIndex: 0, opIndex: 0, eventIndex: -1 };

const EVENT_COLUMNS =
  "select id, ledger, tx_hash, tx_index, op_index, event_index, contract_id, topics_xdr, value_xdr, ledger_closed_at from events ";

type EventDbRow = {
  id: string;
  ledger: number;
  tx_hash: string;
  tx_index: number;
  op_index: number;
  event_index: number;
  contract_id: string;
  topics_xdr: string[];
  value_xdr: string;
  ledger_closed_at: Date;
};

const toStored = (r: EventDbRow): StoredEvent => ({
  id: r.id,
  ledger: r.ledger,
  txHash: r.tx_hash,
  txIndex: r.tx_index,
  opIndex: r.op_index,
  eventIndex: r.event_index,
  contractId: r.contract_id,
  topicsXdr: r.topics_xdr,
  valueXdr: r.value_xdr,
  ledgerClosedAt: new Date(r.ledger_closed_at),
});

const positionParams = (p: Position | null) => {
  const at = p ?? BEFORE_EVERYTHING;
  return [at.ledger, at.txIndex, at.opIndex, at.eventIndex];
};

const ACCOUNT_EVENTS =
  EVENT_COLUMNS +
  "where contract_id = $1 and accounts @> array[$2::text] and ledger >= $3 and ledger <= $4 " +
  "and ($5::jsonb is null or event_name in (select jsonb_array_elements_text($5::jsonb))) " +
  "and (ledger, tx_index, op_index, event_index) > ($6, $7, $8, $9) " +
  "order by ledger, tx_index, op_index, event_index limit $10";

export async function eventsForAccount(
  db: Db,
  q: { contractId: string; account: string; fromLedger: number; toLedger: number; types: string[] | null; after: Position | null; limit: number },
): Promise<StoredEvent[]> {
  const rows = await db.query<EventDbRow>(ACCOUNT_EVENTS, [
    q.contractId,
    q.account,
    q.fromLedger,
    q.toLedger,
    q.types === null ? null : JSON.stringify(q.types),
    ...positionParams(q.after),
    q.limit,
  ]);
  return rows.map(toStored);
}

const COMPANY_EVENTS =
  EVENT_COLUMNS +
  "where contract_id = $1 and company_id = $2 and ledger >= $3 and ledger <= $4 " +
  "and (ledger, tx_index, op_index, event_index) > ($5, $6, $7, $8) " +
  "order by ledger, tx_index, op_index, event_index limit $9";

export async function eventsForCompany(
  db: Db,
  q: { contractId: string; companyId: string; fromLedger: number; toLedger: number; after: Position | null; limit: number },
): Promise<StoredEvent[]> {
  const rows = await db.query<EventDbRow>(COMPANY_EVENTS, [
    q.contractId,
    q.companyId,
    q.fromLedger,
    q.toLedger,
    ...positionParams(q.after),
    q.limit,
  ]);
  return rows.map(toStored);
}

const CONTRACT_EVENTS =
  EVENT_COLUMNS +
  "where contract_id = $1 and ledger >= $2 and ledger <= $3 " +
  "and (ledger, tx_index, op_index, event_index) > ($4, $5, $6, $7) " +
  "order by ledger, tx_index, op_index, event_index limit $8";

export async function eventsForContract(
  db: Db,
  q: { contractId: string; fromLedger: number; toLedger: number; after: Position | null; limit: number },
): Promise<StoredEvent[]> {
  const rows = await db.query<EventDbRow>(CONTRACT_EVENTS, [
    q.contractId,
    q.fromLedger,
    q.toLedger,
    ...positionParams(q.after),
    q.limit,
  ]);
  return rows.map(toStored);
}

const LATEST_CHECKPOINT =
  EVENT_COLUMNS +
  "where contract_id = $1 and topic1_address = $2 and ledger <= $3 " +
  "and event_name in (select jsonb_array_elements_text($4::jsonb)) " +
  "order by ledger desc, tx_index desc, op_index desc, event_index desc limit 1";

export async function latestCheckpoint(
  db: Db,
  q: { contractId: string; account: string; atLedger: number; eventNames: readonly string[] },
): Promise<StoredEvent | null> {
  const rows = await db.query<EventDbRow>(LATEST_CHECKPOINT, [q.contractId, q.account, q.atLedger, JSON.stringify(q.eventNames)]);
  return rows[0] ? toStored(rows[0]) : null;
}

export async function dailyFeeSpent(db: Db, day: string): Promise<bigint> {
  const rows = await db.query<{ spent: string }>(
    "select spent_stroops::text as spent from day_budget where day = $1::date",
    [day],
  );
  return BigInt(rows[0]?.spent ?? "0");
}

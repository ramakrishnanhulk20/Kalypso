// Generated from schema.sql by scripts/sync-schema.mjs. Edit schema.sql, not this file.
export const SCHEMA_SQL = `-- Kalypso server schema. Safe to run more than once.

-- Archive of public events from our token and payroll contracts, kept after
-- Stellar RPC forgets them (about 7 days). topics_xdr and value_xdr are the
-- base64 XDR exactly as RPC served it; the other columns are decoded copies
-- used only to query. Nothing here is secret: it is a copy of public chain data.
create table if not exists events (
  -- No op_index in the id: a Soroban transaction holds exactly one operation; if one could hold more, a second operation's events would share ids with the first's and be silently dropped as duplicates.
  id text primary key,               -- ledger, tx hash and event index joined by "-"
  ledger integer not null check (ledger > 0),
  tx_hash text not null,
  tx_index integer not null,         -- application order of the transaction inside its ledger
  op_index integer not null,
  event_index integer not null,
  contract_id text not null,
  event_name text,                   -- topic 0 when it is a symbol
  topic1_address text,               -- topic 1 when it is an address: the owner of a checkpoint
  accounts text[] not null,          -- every address in the topics
  company_id text,                   -- payroll events: topic 1 when it is an unsigned integer
  topics_xdr text[] not null,
  value_xdr text not null,
  ledger_closed_at timestamptz not null
);
create index if not exists events_in_order on events (contract_id, ledger, tx_index, op_index, event_index);
create index if not exists events_by_account on events using gin (accounts);
create index if not exists events_by_company on events (contract_id, company_id, ledger, tx_index, op_index, event_index)
  where company_id is not null;

-- Ledger ranges read in full from RPC. Adjacent ranges are merged on write,
-- so the table stays a handful of rows.
create table if not exists ingested_ranges (
  from_ledger integer not null,
  to_ledger integer not null,
  check (from_ledger > 0 and to_ledger >= from_ledger)
);
create index if not exists ingested_ranges_by_from on ingested_ranges (from_ledger);

-- Ledgers that RPC had already forgotten when we came to read them. These can
-- never be filled from RPC, so every reply touching them says complete: false.
create table if not exists gaps (
  from_ledger integer not null,
  to_ledger integer not null,
  detected_at timestamptz not null,
  primary key (from_ledger, to_ledger),
  check (from_ledger > 0 and to_ledger >= from_ledger)
);

-- covers_from_genesis turns true only when the first token event read is in
-- the configured start ledger and comes from the token's deploy transaction
-- (TOKEN_DEPLOY_TX), which proves no token event can exist before it.
-- start_check_pending is true from such a start until the first token event
-- is read.
create table if not exists archive_state (
  id smallint primary key check (id = 1),
  start_ledger integer,
  covers_from_genesis boolean not null default false,
  start_check_pending boolean not null default false,
  latest_ledger integer,
  rpc_oldest_ledger integer,
  last_ingest_at timestamptz,
  ingest_started_at timestamptz
);
insert into archive_state (id) values (1) on conflict (id) do nothing;

-- Read-only role for DATABASE_URL_API. Run once as the database owner, with a
-- password you generate (never commit it):
--   create role kalypso_api login password '<generate one>';
--   grant connect on database <your database> to kalypso_api;
--   grant usage on schema public to kalypso_api;
--   grant select on events, ingested_ranges, gaps, archive_state to kalypso_api;
--   alter role kalypso_api set default_transaction_read_only = on;
-- The API role can read the archive and nothing else: no writes anywhere, and
-- no access to the sponsor counters, the wallet births or the relayed
-- creations below.

-- Sponsor counters. Each is bumped with one atomic statement, so
-- concurrent requests on different server instances cannot overshoot.
create table if not exists ip_hour (
  ip_bucket text not null,
  hour_start timestamptz not null,
  count integer not null check (count > 0),
  primary key (ip_bucket, hour_start)
);
create index if not exists ip_hour_by_hour on ip_hour (hour_start);

-- Relays per authorising address (G or C, in the server's one spelling) per
-- UTC day, beside the per-IP count, so one worker cannot spend the budget
-- from many IPs. A relay that provably never reached the network is given
-- back; one that may have landed stays counted, like its fee.
create table if not exists address_day (
  address text not null,
  day date not null,
  count integer not null check (count > 0),
  primary key (address, day)
);
create index if not exists address_day_by_day on address_day (day);

create table if not exists day_budget (
  day date primary key,
  spent_stroops bigint not null check (spent_stroops >= 0)
);

-- The part of day_budget reserved for passkey wallet creations on the same
-- day, reserved and given back together with it. Creations stop at their
-- share, so new sign-ups can never use up the fees of workers already paid.
create table if not exists creation_budget (
  day date primary key,
  spent_stroops bigint not null check (spent_stroops >= 0)
);

-- One row per relayed body, keyed by the sha256 of the exact bytes forwarded.
-- A second copy of the same body gets the first transaction id back instead
-- of being relayed, and paid for, again: until the network passes
-- hold_until_ledger, the earliest expiry of the body's auth entries, or for
-- 120 s when no entry carries an expiry.
create table if not exists relay_dedupe (
  digest text primary key,
  claimed_at timestamptz not null,
  hold_until_ledger integer,
  transaction_id text,
  status text
);
create index if not exists relay_dedupe_by_time on relay_dedupe (claimed_at);
create index if not exists relay_dedupe_by_hold on relay_dedupe (hold_until_ledger);

-- One row per signed auth entry in a claimed body, keyed by the pair the
-- network uses up once: the signing address and its nonce. The same entry
-- rewrapped in another body is refused while its row stands: held rows until
-- expiry_ledger, the entry's own signature expiration, and unheld rows for
-- 120 s.
create table if not exists relay_auth (
  address text not null,
  nonce text not null,
  digest text not null,
  claimed_at timestamptz not null,
  expiry_ledger integer not null,
  held boolean not null default false,
  primary key (address, nonce)
);
create index if not exists relay_auth_by_claim on relay_auth (digest, claimed_at);

-- Which transaction created each passkey wallet, so a worker signing in on
-- another device can find its birth. A row is written only once RPC showed
-- that transaction succeeded and created the address, and an address is
-- created once, so the first row is the only birth it can have and is never
-- replaced. Public chain data only: the browser reads every hash back from
-- chain and judges the birth itself.
create table if not exists wallet_births (
  address text primary key check (address ~ '^C[A-Z2-7]{55}$'),
  tx_hash text not null check (tx_hash ~ '^[0-9a-f]{64}$'),
  ledger integer not null check (ledger > 0),
  recorded_at timestamptz not null default now()
);

-- Every wallet creation the sponsor handed to Channels, written just before
-- the hand-off so a creation that may land is always on record, then filled
-- with Channels' transaction id and, once a status read names it, the hash.
-- A browser that lost the sponsor's reply finds its creation here, and an
-- address with no row and no birth was never created through Kalypso.
-- Pointers only: the browser reads each one back from chain.
create table if not exists relayed_creations (
  id bigserial primary key,
  address text not null check (address ~ '^C[A-Z2-7]{55}$'),
  transaction_id text check (transaction_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  tx_hash text check (tx_hash ~ '^[0-9a-f]{64}$'),
  relayed_at timestamptz not null default now()
);
create index if not exists relayed_creations_by_address on relayed_creations (address, id);
create index if not exists relayed_creations_by_transaction on relayed_creations (transaction_id);
`;

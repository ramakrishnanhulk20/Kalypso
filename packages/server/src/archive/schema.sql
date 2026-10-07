-- Kalypso server schema. Safe to run more than once.

-- Archive of public events from our token and payroll contracts, kept after
-- Stellar RPC forgets them (about 7 days). topics_xdr and value_xdr are the
-- base64 XDR exactly as RPC served it; the other columns are decoded copies
-- used only to query. Nothing here is secret: it is a copy of public chain data.
create table if not exists events (
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

create table if not exists archive_state (
  id smallint primary key check (id = 1),
  start_ledger integer,
  covers_from_genesis boolean not null default false,
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
-- no access to the sponsor tables below.

-- Sponsor counters. Both are bumped with one atomic statement each, so
-- concurrent requests on different server instances cannot overshoot.
create table if not exists ip_hour (
  ip_bucket text not null,
  hour_start timestamptz not null,
  count integer not null check (count > 0),
  primary key (ip_bucket, hour_start)
);
create index if not exists ip_hour_by_hour on ip_hour (hour_start);

create table if not exists day_budget (
  day date primary key,
  spent_stroops bigint not null check (spent_stroops >= 0)
);

-- One row per relayed body, keyed by the sha256 of the exact bytes forwarded.
-- A second copy of the same body within 120 s gets the first transaction id
-- back instead of being relayed, and paid for, again.
create table if not exists relay_dedupe (
  digest text primary key,
  claimed_at timestamptz not null,
  transaction_id text,
  status text
);
create index if not exists relay_dedupe_by_time on relay_dedupe (claimed_at);

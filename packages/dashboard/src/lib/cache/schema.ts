// The cache is derived and disposable: it holds nothing the control room does not, so it has no
// migrations. Bumping CACHE_SCHEMA_VERSION is the whole migration story — an older file is
// deleted and rebuilt on the next open, and deleting the file by hand is always safe.
export const CACHE_SCHEMA_VERSION = 2

export const SCHEMA_SQL = `
create table if not exists events (
  destination text not null,
  event_id text not null,
  payload_sha256 text not null,
  payload_json text not null,
  primary key (destination, event_id)
);
create table if not exists event_sources (
  source text primary key,
  bytes text not null
);
create table if not exists invalid_events (
  source text primary key,
  reason text not null,
  bytes integer not null
);
create table if not exists sources (
  path text primary key,
  size integer not null,
  mtime_ms real not null,
  ingested_at text not null
);
create table if not exists runs (
  id integer primary key autoincrement,
  source text not null,
  ts text not null,
  month text not null,
  repo text not null,
  issue integer,
  parent integer,
  stage text,
  harness text,
  model text,
  effort text,
  mode text,
  human text,
  session_id text,
  worktree text,
  duration_s real,
  turns integer,
  tool_calls integer,
  subagents integer,
  tokens_in integer,
  tokens_out integer,
  cache_read integer,
  cache_write integer,
  cost_usd real,
  outcome text,
  review_rounds integer,
  fix_rounds integer,
  handbacks integer
);
create table if not exists skill_invocations (
  run_id integer not null,
  name text not null,
  trigger text,
  harness text
);
create index if not exists runs_month on runs (month);
create index if not exists runs_repo_month on runs (repo, month);
create index if not exists skill_run on skill_invocations (run_id);
`

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

create table if not exists metric_sources (path text primary key, content_sha256 text not null);
create table if not exists metric_metadata (key text primary key, value_json text not null);
create table if not exists activity_collections (
  repo text not null, period text not null, payload_json text not null,
  primary key(repo, period)
);
drop view if exists measurements;
create view measurements as
select e.destination, e.event_id as id, e.event_id,
  json_extract(e.destination, '$.repo') as repo,
  json_extract(e.payload_json, '$.utcDay') as utc_day,
  case substr(json_extract(e.payload_json, '$.utcDay'),6,2)
    when '01' then 'JAN' when '02' then 'FEB' when '03' then 'MAR' when '04' then 'APR'
    when '05' then 'MAY' when '06' then 'JUN' when '07' then 'JUL' when '08' then 'AUG'
    when '09' then 'SEP' when '10' then 'OCT' when '11' then 'NOV' when '12' then 'DEC'
  end || '-' || substr(json_extract(e.payload_json, '$.utcDay'),1,4) as month,
  'execution' as record_kind, 2 as definition_version,
  json_extract(e.payload_json, '$.taskRef.issue') as issue,
  json_extract(e.payload_json, '$.taskRef.taskId') as task_id,
  json_extract(e.payload_json, '$.taskOwner') as human,
  json_extract(e.payload_json, '$.taskOwner') as task_owner,
  json_extract(e.payload_json, '$.agentAccountOwner') as agent_account_owner,
  json_extract(e.payload_json, '$.executionRef') as execution_ref,
  json_extract(e.payload_json, '$.attempt') as attempt,
  json_extract(e.payload_json, '$.stage') as stage,
  json_extract(e.payload_json, '$.harness') as harness,
  json_extract(e.payload_json, '$.model') as model,
  json_extract(e.payload_json, '$.outcome') as outcome,
  json_extract(e.payload_json, '$.durationSeconds') as duration_s,
  json_extract(e.payload_json, '$.turns') as turns,
  json_extract(e.payload_json, '$.toolCalls') as tool_calls,
  json_extract(e.payload_json, '$.subagents') as subagents,
  json_extract(e.payload_json, '$.tokensIn') as tokens_in,
  json_extract(e.payload_json, '$.tokensOut') as tokens_out,
  json_extract(e.payload_json, '$.cacheReadTokens') as cache_read,
  json_extract(e.payload_json, '$.cacheWriteTokens') as cache_write,
  json_extract(e.payload_json, '$.costUsd') as cost_usd,
  json_extract(e.payload_json, '$.operatorMinutes') as operator_minutes,
  json_extract(e.payload_json, '$.apiEquivalentUsd') as api_equivalent_usd,
  json_extract(e.payload_json, '$.coverage') as coverage_json,
  json_extract(e.payload_json, '$.skills') as skills_json,
  e.payload_json
from events e where json_extract(e.payload_json, '$.recordKind') = 'execution';
drop view if exists activity_measurements;
create view activity_measurements as
select json_extract(e.destination, '$.repo') as repo, 'activity' as record_kind,
  json_extract(e.payload_json, '$.taskOwner') as task_owner,
  json_extract(e.payload_json, '$.agentAccountOwner') as agent_account_owner,
  json_extract(e.payload_json, '$.activity.taskRef.issue') as issue,
  json_extract(e.payload_json, '$.activity.taskRef.taskId') as task_id,
  json_extract(e.payload_json, '$.activity.activityId') as activity_id,
  json_extract(e.payload_json, '$.activity.kind') as kind,
  json_extract(e.payload_json, '$.activity.occurredAt') as occurred_at,
  json_extract(e.payload_json, '$.activity') as payload_json
from events e where json_extract(e.payload_json, '$.recordKind') = 'activity'
union all
select c.repo, 'activity', null, null, json_extract(a.value,'$.taskRef.issue'), json_extract(a.value,'$.taskRef.taskId'),
 json_extract(a.value,'$.activityId'), json_extract(a.value,'$.kind'), json_extract(a.value,'$.occurredAt'), a.value
from activity_collections c, json_each(c.payload_json,'$.activities') a;
drop view if exists rework_snapshots;
create view rework_snapshots as
select json_extract(e.destination, '$.repo') as repo, 'rework-snapshot' as record_kind,
 json_extract(e.payload_json, '$.taskOwner') as task_owner,
 json_extract(e.payload_json, '$.reworkSnapshot.taskRef.issue') as issue,
 json_extract(e.payload_json, '$.reworkSnapshot.taskRef.taskId') as task_id,
 json_extract(e.payload_json, '$.reworkSnapshot.counterEpoch') as counter_epoch,
 json_extract(e.payload_json, '$.reworkSnapshot.asOf') as as_of,
 json_extract(e.payload_json, '$.reworkSnapshot') as payload_json
from events e where json_extract(e.payload_json, '$.recordKind') = 'rework-snapshot'
union all
select c.repo, 'rework-snapshot', null, json_extract(a.value,'$.taskRef.issue'),json_extract(a.value,'$.taskRef.taskId'),
 json_extract(a.value,'$.counterEpoch'),json_extract(a.value,'$.asOf'),a.value
from activity_collections c, json_each(c.payload_json,'$.snapshots') a;
`

# @vegastack/vegafactory-dashboard

The local, read-only web view of the factory. It is launched by the CLI, not run directly:

```bash
vegafactory dashboard
```

The CLI selects one configured organization (or requires `--org` when selection is ambiguous),
verifies this package against its bundled artifact descriptor, and starts the Next.js standalone
server under Bun on `127.0.0.1`. Nothing here writes to GitHub or to the control room.

## The nine destinations

| View | Reads | Shows |
|---|---|---|
| Attention (`/`) | scoped live workflow/status plus cached activity | needs your decision, blocked or failed, running, then recently merged work |
| Performance (`/performance`) | the metric-v2 cache | reported usage and coverage, API-equivalent estimates, subscription fee evidence, monthly outcomes and lifetime rework snapshots |
| Activity (`/activity`) | the metric-v2 cache and scoped `status --json` | one row per repository/issue with separate owners, attempts, recovery, current machine, checkpoint uncertainty and bounded handoff history |
| Repo (`/repo/<owner>/<name>`) | the cache and the month's rollup | verified merged work, monthly/lifetime rework, nullable usage and separately labelled legacy lead/cycle summaries |
| People (`/people`) | the cache, current policy and `people.csv` | authorized task-owner metrics, resolved organization/group administration and separate unknown-owner aggregate buckets |
| Person (`/people/<login>`) | a subject-bound cache generation and current policy | task-owner or agent-account-owner metrics without transferring authority between dimensions |
| Skills (`/skills`) | the cache and the org skills rollup | invocations, trigger, outcome and nonadditive whole-run cost association |
| Board (`/board`) | live GitHub and `vegafactory status --json` | the five workflow-state columns, open PRs, worktrees |
| Dispatcher (`/dispatcher`) | scoped `vegafactory status --json` | running, idle or unavailable observation, its last tick, and sanitized run/recovery state |

Navigation preserves validated month, repo, group, harness and model filters in the URL. Clearing or
switching a visible filter never expands the current policy scope, and a person ownership dimension
is preserved separately. The selected organization is launcher-bound rather than browser-selected.

## The environment contract

The CLI sets these; the server reads them and nothing else. Identity and repository scope are
required even for an empty first-use shell. Viewer, token and CLI bridge absence degrade live data
rather than weakening validation.

| Variable | Required | Means |
|---|---|---|
| `VEGAFACTORY_CONTROL_ROOM` | yes | path to this machine's control-room clone |
| `VEGAFACTORY_CACHE` | yes | exact `~/.vegastack/dashboard/<sha256(org)>/cache-v2` namespace |
| `VEGAFACTORY_ORG` | yes | the org whose freshness entry to read |
| `VEGAFACTORY_STATE` | yes | path to `~/.vegastack/factory.json` |
| `VEGAFACTORY_REPOS` | yes | comma-separated selected-org registrations; an empty string is valid |
| `VEGAFACTORY_VERSION` | yes | exact installed version, or `unverified-development` for explicit `--dir` |
| `VEGAFACTORY_INSTANCE_ID` | yes | random identity for this child only |
| `VEGAFACTORY_CACHE_SCHEMA` | yes | exact supported cache schema (`2`) |
| `VEGAFACTORY_VIEWER` | no | the `gh` login of whoever is looking — the people gate's subject |
| `VEGAFACTORY_GH_TOKEN` | no | the viewer's own `gh` token, used server-side only |
| `VEGAFACTORY_BIN` | no | path to the `vegafactory` binary, for selected-config status and activity bridges |

## Offline behaviour

Current verified policy is required before every cached read. A stale or missing policy never becomes an authorization grant. The live board retains successfully read pages and healthy repositories when another read is partial or unavailable, displaying each repository’s reason and observation time; an incomplete empty result is unknown, not “no issues” or “no pull requests”. GitHub reads are bounded to 100 pages or 10,000 records, 10 seconds per request and 60 seconds per repository, with at most two retries and three repositories in flight. After connectivity recovers or the reported rate reset, reload to retry. Repeated unchanged failures stay visible without repeated notifications. Status preserves the CLI workflow/shared/policy/recovery projections. Missing source identity, remote liveness, checkpoint availability and recovery history remain unavailable rather than becoming idle or complete.

Readiness is separate from data availability. `/api/health` returns only
`{ok,org,version,instanceId,cacheSchema,dataState,sourceAgeSeconds}`; an `empty` or `unavailable`
first-use shell is ready when its launcher identity and cache namespace are valid. It never returns
tokens or local paths.

## Building it locally

```bash
cd packages/dashboard
bun run build && bun run assemble
cd ../.. && vegafactory dashboard --dir packages/dashboard
```

`assemble` turns `next build`'s standalone output into the tree the tarball ships —
`dist-standalone/packages/dashboard/server.js`, with the static assets where that server looks for
them. `--dir` launches a built tree in place and is never fetched over.

## Design system

Layout and type come from `@vegastack/design`'s Tailwind v4 preset, and page styling uses its
semantic tokens. This source checkpoint deliberately retains the existing native semantic table
and root setup. Signature-verified VegaStack provider and Table registry bytes were unavailable, so
no component copy-in, dependency change or provider claim was made. That integration must use
`vegastack-consume`'s fail-closed pre-write, copy-in and post-write verification once the authorized
registry input exists; hash-only substitution is not accepted.

## Metric and reader contracts

Metric version 2 distinguishes unknown from measured zero, execution segments from logical executions, and monthly activities from cumulative snapshots. Corrections are fix events; human effort is supplied operator minutes. Reported cost, API-equivalent estimates and an optional account fee remain separate. The [CLI metric dictionary](https://github.com/vegastack/vegafactory/blob/main/packages/cli/docs/metrics.md) is the definition source. Legacy data is labelled and never promoted into measured v2 coverage.

The dashboard uses the same bounded CLI activity collector, with explicit org, repo, month and selected config. An activity-only month is selectable with zero executions. Failed refreshes preserve the previous complete collection's source observation time. SQLite source associations, event identities and derived metadata commit together; a failed ingestion rolls back. Transport schema remains version 2; derived views carry metric version 2. Raw archive files are unchanged.

`withContext(search, async context => renderedResult)` obtains current aggregate authorization;
`withContext(search, async context => renderedResult, {kind:'person',subject,dimension})` obtains a
subject-bound task-owner or account-owner context. The callback is awaited before its SQLite handle
closes and its persistent reader pin is released; callers must not retain `context` or `context.db`
after the callback settles. Generic aggregates refuse person-only grants; only the matching central
person query may use that scope. `allowedRepos:[]` denies access even when group/repo filters are
cleared. Current attribution is applied again on cached fallback; stale person and issue identities
cannot survive a downgrade. Null owners are aggregate buckets, not person profiles. All seven
pre-existing page callers, plus Performance and Activity, keep their reads and returned JSX inside
the awaited callback. Person detail passes its explicit subject and task-owner or account-owner
dimension as the third argument.

Successful rebuilds publish a new immutable generation only after SQLite integrity and org/scope
metadata match. Failed refreshes retain the previous eligible rows and derive generation source age
and digest from those persisted rows, not the failed attempt's timestamp. Active, unknown or corrupt
reader ownership conservatively retains an old generation. An ordinary caught install failure cleans
only its owned current staging; crash-interrupted or unrelated staging, legacy shared `stats.db` and
wrong-org caches remain preserved for explicit recovery. None is silently relabelled or executed.

## Qualification status

Focused source tests cover scoped adapters, all callback callers, nullable formatting, navigation,
state copy and a real strict-launch board render. A descriptor-backed packed browser run has not yet
been performed for this source checkpoint. Keyboard history, automated accessibility, light/dark
and 320/768/1280 viewport evidence remain required together with the verified provider/Table input;
they are pending, not passed or waived.

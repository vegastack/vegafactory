# @vegastack/vegafactory-dashboard

The local, read-only web view of the factory. It is launched by the CLI, not run directly:

```bash
vegafactory dashboard
```

The CLI fetches this package at its own version on first use, collects the environment, and starts
the Next.js standalone server under Bun on `127.0.0.1`. Nothing here writes to GitHub or to the
control room.

## The six views

| View | Reads | Shows |
|---|---|---|
| Org (`/`) | the cache | terminal segments, nullable usage coverage, measured operator minutes, and per-repo/per-stage totals |
| Repo (`/repo/<owner>/<name>`) | the cache and the month's rollup | verified merged work, monthly/lifetime rework, nullable usage and separately labelled legacy lead/cycle summaries |
| People (`/people`, `/people/<login>`) | the cache and `people.csv` | authorized task/account-owner metrics and a separate unknown-owner aggregate bucket |
| Skills (`/skills`) | the cache and the org skills rollup | invocations, trigger, outcome and nonadditive whole-run cost association |
| Board (`/board`) | live GitHub and `vegafactory status --json` | the five workflow-state columns, open PRs, worktrees |
| Dispatcher (`/dispatcher`) | `vegafactory status --json` | whether it is alive, its last tick, and the runs in flight |

Every view takes the same filters — month, repo, group, harness, model — as search parameters, so a
filtered view is a URL you can bookmark or paste into an issue.

## The environment contract

The CLI sets these; the server reads them and nothing else. The four required ones have no sane
default, and the optional ones degrade the page rather than refusing it.

| Variable | Required | Means |
|---|---|---|
| `VEGAFACTORY_CONTROL_ROOM` | yes | path to this machine's control-room clone |
| `VEGAFACTORY_CACHE` | yes | path to the derived `bun:sqlite` index |
| `VEGAFACTORY_ORG` | yes | the org whose freshness entry to read |
| `VEGAFACTORY_STATE` | yes | path to `~/.vegastack/factory.json` |
| `VEGAFACTORY_REPOS` | no | comma-separated repos the board reads live |
| `VEGAFACTORY_VIEWER` | no | the `gh` login of whoever is looking — the people gate's subject |
| `VEGAFACTORY_GH_TOKEN` | no | the viewer's own `gh` token, used server-side only |
| `VEGAFACTORY_BIN` | no | path to the `vegafactory` binary, for selected-config status and activity bridges |

## Offline behaviour

Current verified policy is required before every cached read. A stale or missing policy never becomes an authorization grant. The live board retains successfully read pages and healthy repositories when another read is partial or unavailable, displaying each repository’s reason and observation time; an incomplete empty result is unknown, not “no issues” or “no pull requests”. GitHub reads are bounded to 100 pages or 10,000 records, 10 seconds per request and 60 seconds per repository, with at most two retries and three repositories in flight. After connectivity recovers or the reported rate reset, reload to retry. Repeated unchanged failures stay visible without repeated notifications. Status preserves the CLI workflow/shared/policy/recovery projections. Missing source identity and recovery history remain unavailable.

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

Layout and type come from `@vegastack/design`'s Tailwind v4 preset, and every colour, radius and
spacing value on these pages is one of its tokens — no literal is declared here. The registry
components themselves (`src/components/ui/`) are copied in through `vegastack-consume`'s fail-closed
flow, which needs the `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` service tokens in
`packages/dashboard/.env.local`. Until that copy-in runs, the pages render semantic markup over the
same tokens.

## Metric and reader contracts

Metric version 2 distinguishes unknown from measured zero, execution segments from logical executions, and monthly activities from cumulative snapshots. Corrections are fix events; human effort is supplied operator minutes. Reported cost, API-equivalent estimates and an optional account fee remain separate. The [CLI metric dictionary](https://github.com/vegastack/vegafactory/blob/main/packages/cli/docs/metrics.md) is the definition source. Legacy data is labelled and never promoted into measured v2 coverage.

The dashboard uses the same bounded CLI activity collector, with explicit org, repo, month and selected config. An activity-only month is selectable with zero executions. Failed refreshes preserve the previous complete collection's source observation time. SQLite source associations, event identities and derived metadata commit together; a failed ingestion rolls back. Transport schema remains version 2; derived views carry metric version 2. Raw archive files are unchanged.

`loadContext(search, {kind:'aggregate'})` obtains current repository authorization. `loadContext(search, {kind:'person',subject,dimension})` obtains a subject-bound task-owner or account-owner context. Generic aggregates refuse person-only grants; only the matching central person query may use that scope. `allowedRepos:[]` denies access even when group/repo filters are cleared. Current attribution is applied again on cached fallback; stale person and issue identities cannot survive a downgrade. Null owners are aggregate buckets, not person profiles. The context generation/lease owner and route consumers preserve these contracts.

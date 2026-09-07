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
| Org (`/`) | the cache | runs, cost, human touchpoints per run, and the same per repo and per stage |
| Repo (`/repo/<owner>/<name>`) | the cache and the month's rollup | the repo's lead time, cycle time per workflow state, runs and cost per stage, rework and cost per issue |
| People (`/people`, `/people/<login>`) | the cache and `people.csv` | runs and cost per person, behind the lead gate |
| Skills (`/skills`) | the cache and the org skills rollup | invocations, trigger, outcome, cost per invocation |
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
| `VEGAFACTORY_BIN` | no | path to the `vegafactory` binary, for the status bridge |

## Offline behaviour

The control-room clone is the source of truth and every cached view works from it alone. The live board retains successfully read pages and healthy repositories when another read is partial or unavailable, displaying each repository’s reason and observation time; an incomplete empty result is unknown, not “no issues” or “no pull requests”. GitHub reads are bounded to 100 pages or 10,000 records, 10 seconds per request and 60 seconds per repository, with at most two retries and three repositories in flight. After connectivity recovers or the reported rate reset, reload to retry. Repeated unchanged failures stay visible without repeated notifications. The status-backed views remain subject to #141’s separate status/bridge completeness integration.

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

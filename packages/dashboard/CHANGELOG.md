# @vegastack/vegafactory-dashboard

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

### Major Changes

- 86158a3: Resolve organization policy, scoped administration and registered-machine settings consistently across consumers.

  - Require exact organization delegation for locked overrides, with source and freshness diagnostics.
  - Reject stale or mismatched policy snapshots and legacy role-based authority; preserve explicit local operation and readable legacy policy.
  - Compile guard policy schema2 and keep capture/export refusals effective before side effects.
  - Batch exact policy Git blobs with bounded, verified framing while rechecking snapshot identity and freshness on every read.

- 86158a3: Resolve configured workflow states consistently across launch guards, status and boards.

  - Custom names require explicit semantic mappings; ambiguous legacy profiles refuse until an accepted migration.
  - Mixed states block launches, and dashboard rows with missing, stale or mismatched state remain visibly unresolved.
  - Board mirroring validates existing Status options and passes event labels as JSON.

- 86158a3: Keep captured telemetry durable, bound to its organization, and counted once across delivery retries.

  - Store immutable events and stable capture identities; managed hooks resolve private owned sessions before capture.
  - Preserve one reporting execution identity across separate immutable terminal segments after recovery; replay older pending segments only from their exact retained snapshots, and keep quota retries in their current segment.
  - Stop promptly on refused spool claims and preserve abandoned guards for offline recovery; retry only live-owner contention.
  - Await the managed hook’s internal flush grant after fresh private validation; preserve receiving-home reporting on hold until its original reporting context is available.
  - Verify acknowledged capture replays from immutable identities and event or tombstone evidence without allocating another event, taking claims, or rewriting acknowledgment.
  - Reconcile exact remote bytes against retained sanitized attempts, including after a crash or policy change, and preserve unrelated writer work.
  - Require explicit legacy migration, preserve original records, and expose corrupt or conflicting data for inspection.
  - Deduplicate event identities and semantic activity before CLI and SQLite ingestion; protect undelivered records during retention.
  - Route production export and typed reading through the current privacy serializer and reader; preserve pending reporting independently of task success.

- 86158a3: Align CLI and dashboard metrics around measured coverage, verified delivery periods and current reporting permissions.

  - Keep unknown usage distinct from zero and separate terminal segments, logical executions, activities and cumulative snapshots.
  - Discover accepted work and first releases independently of run months, retaining original observation times when bounded evidence refreshes fail.
  - Apply current repository and person scopes before totals, preserve distinct task/account owners, and report unknown ownership without synthetic profiles.
  - Rebuild derived metrics transactionally and show supplied operator minutes, reported cost, estimates and account fees separately.

- 86158a3: Enforce confirmed reporting privacy before export and apply current repository permissions before people totals.

  - Validate closed execution, activity and rework snapshot records; keep task and account owners distinct and local identities private.
  - Reconcile earlier deliveries before policy changes, preserve historical non-attributed data, and expose scoped private export and reporting status.
  - Retain basic logs for14days and acknowledged active reports for12calendar months, protecting pending and recovery records. Verify shared removal through the existing Git writer without erasing history.
  - Use basic private diagnostics and real disk-pressure launch/stop controls; exclude raw transcripts, credentials and built-in vendor memory.

  - Validate retained completed task state and immutable recovery evidence before managed retention; hold active, missing, changed or pending telemetry references without deleting authority or delivery history.

  - Export verified continuation terminal segments with the saved logical execution identity, refusing missing or conflicting private mappings without rewriting earlier reports.

### Minor Changes

- ddbf9ae: The ship guard no longer reads `.vegastack/dev.md` and no longer matches the raw command text.

  - Its only policy is `~/.vegastack/guard/<owner>__<repo>.json`, keyed by the checkout's origin remote and compiled from dev.md by dev-setup on your yes or by the new `vegafactory guard sync [--check]` — outside every worktree, so a run under bypassed permissions cannot edit its own profile into permission. With the file missing, stale-for-another-repo or malformed, every guarded command asks and names the sync command; `--check` exits 2 when the file is stale, and the SessionStart hook says so. Run `vegafactory guard sync` once per repo after upgrading.
  - Commands are read as a shell reads them — quotes, escapes, `;` `&&` `||` `|` `&`, subshells, `$(…)`, `sh -c` — wrappers, paths and git/gh global options resolved, then matched on the argv: every refspec spelling of a push to the default branch (`HEAD:main`, `refs/heads/main`, `main:main`, `+main`), force, delete and `--no-verify` flags in any position, `--tags`, `gh api` on a merge URL, and text handed to another interpreter. The reviewer's nineteen bypasses are now test cases.
  - A `## Ship` `ask:` step guards a command only when the step names it in backticks; a prose step is a runbook instruction, not a pattern.
  - The dispatcher refuses a repo whose compiled policy is missing, and the headless prompt fences the issue's title and outcome as data.
  - Contract change: the hook's `--check` mode takes `--policy PATH` and `--repo owner/repo` instead of `--dev-md`.

- 47bde99: Any organisation that installs the VegaFactory App can now get repository-scoped GitHub tokens from a hosted broker instead of holding a private key of its own.

  - A Cloudflare Worker at `packages/broker` exchanges a GitHub Actions OIDC token (audience `vegastack-factory`) for a one-repository installation token capped to `issues: write`, `metadata: read`, `organization_projects: write` — enforced in the request and again against the response's own permission echo.
  - The repository comes from the verified OIDC `repository` and `repository_owner` claims and from nothing the caller sends, so one organisation can never mint a token for another's repository.
  - Fails closed: 401 unverifiable token, 403 uninstalled repository, 429 rate limited, 503 rate limiter unavailable, 502 upstream failure, 500 on a widened permission echo with the token discarded. `GET /health` answers unauthenticated and reads no credential.
  - The App private key lives only in a Cloudflare Secrets Store secret; the broker declares no storage binding at all and persists no customer content — one audit record per request carries repository, owner, installation id, decision and status, never a token.
  - `github-app.md` gains the customer-facing `Hosted token broker` reference: status codes, tenancy, rotation runbook, uninstall kill switch, rate-limit honesty, and the support boundary. The `vegastack/factory-token` composite action source ships in `packages/broker/action/`.

- 86158a3: Board reads follow every bounded page and show incomplete repositories explicitly.

  - Dispatch refuses incomplete issue, comment and dependency reads before claiming work.
  - The dashboard retains available rows, names failed repositories and distinguishes missing data from an empty queue.
  - GitHub reads have cancellation, output and time limits, bounded retries and a shared repository concurrency limit.

- 86158a3: Publish validated per-repository policy snapshots through atomic versioned machine settings. Preserve previous policy, other organizations and local edits on failed refreshes; expose validation identity and freshness consistently in status and dashboard. Add source recovery APIs that require fresh validation before restored policy can authorize work.
- 86158a3: Select and isolate the dashboard organization through verified launch, cache and package identities.

  - Infer a sole configured organization, require `--org` for ambiguity, and reject foreign repository registrations.
  - Keep immutable per-org cache generations pinned for complete request callbacks, retaining honest stale provenance and unknown readers.
  - Verify descriptor-bound dashboard archives and installed trees before atomic selection, and match exact owned-child readiness before launch succeeds.
  - Preserve legacy caches, failed installs and unavailable first-use state for explicit recovery without exposing credentials.

- 86158a3: Make the local dashboard attention-first with scoped Performance and Activity reports.

  - Preserve verified repository and attribution scope before totals, task rows, links, and status history.
  - Keep unknown measurements, owners, remote liveness, and checkpoint availability distinct from zero or idle.
  - Add accessible query-preserving navigation and honest loading, empty, failed, unavailable, stale, and partial states.

- 86158a3: Prepare and verify one immutable CLI/dashboard release pair before publication, embed the dashboard identity in the CLI, and recover partial publication through verified registry readback before promotion.

  - Retain the finalized pair before publication, guard failed-preparation retries, and reconcile per-package promotion under one release workflow.
  - Bind build/runtime SBOM evidence, bound registry reads, and integrate descriptor-backed paired CI packing.
  - Verify every installed CLI file and mode against the retained pair and trusted candidate source/tree before producing external runtime identity evidence.

- 86158a3: Preserve private execution records and separate process outcomes from approved progress delivery.

  - Run an owned process wrapper with bounded cancellation and no ordinary task duration cutoff.
  - Inspect durable run status and validate complete committed history before an explicitly authorized checkpoint push.
  - Retain shared ownership and pending delivery when qualification, recovery or remote acknowledgment is unavailable.
  - Admit approved runs through registered runtime evidence and persist effect receipts for checkpoints, handback, and terminal capture.
  - Recognize subscription quota exhaustion, retain the original account and vendor session across waiting and restart, and retry only after current authority and availability checks.
  - Preserve verified physical-stop receipts when code delivery or effect coverage remains unresolved, with stable receipt payloads across retries.
  - Continue verified unfinished work with a fresh private attempt, immutable prior interruption records, and separate terminal measurement segments.
  - Recover standalone tasks on a verified receiving machine under the original run identity, preserving unavailable history and holding reporting until its original identity is available.

- d0e2b2f: `vegafactory dashboard` starts a local, read-only web view of the factory — throughput, cost, where human time goes, the board, and the dispatcher — over the control room's own statistics.

  - Six views: org overview, repo (the repo's lead time and cycle time per workflow state from `stats rollup`'s own summary, runs and cost per stage, rework and cost per issue), people, skills (invocations, trigger, outcome, cost per invocation), board, dispatcher. Filters by month, repo, group, harness and model, each one a URL you can bookmark or paste into an issue.
  - The control-room clone is the source of truth. On start the server builds a derived `bun:sqlite` index at `~/.vegastack/cache/stats.db`, rebuilt whenever a source file changes; the file is disposable and deleting it is always safe.
  - Live board data — open issues, pull requests, worktrees, dispatcher health — comes from your own `gh` token and `vegafactory status --json`. When either is unreachable the page still renders from the clone, behind a banner naming what failed and how old the clone is; one repo the board cannot read keeps every other repo's rows on the page.
  - People-level numbers stay behind the org's `stats-people` knob: you always see your own row, and anyone else's needs both that knob on and a `lead` role in `people.csv`.
  - The app ships as a second package, `@vegastack/vegafactory-dashboard`, fetched at the CLI's own version on first use into `~/.vegastack/dashboard/<version>/`, so the core install stays small. The server binds `127.0.0.1` only and the token never leaves it.

# @vegastack/skills

## 1.0.6

### Patch Changes

- 416c56b: Run npm trusted publication and GitHub Release authority on supported GitHub-hosted runners while retaining heavy artifact preparation on the self-hosted Mac runner.

## 1.0.5

### Patch Changes

- 1b85e65: Release preparation now skips executable links that resolve to files while inventorying build dependencies.

  - Preserve directory-link traversal and package metadata collection.
  - Prevent Bun-managed `.bin` file links from being opened as directories.
  - Contain the expected stale-socket reset during the release smoke teardown.

## 1.0.4

### Patch Changes

- ea259ac: Release preparation now honors exact scanner coverage acceptances already validated by the built-skill guard.

  - Match the existing baseline-accepted warning to the same skill before admitting degraded completeness.
  - Keep missing, malformed, mismatched, blocked, skipped, and unaccepted partial scanner evidence as hard failures.

## 1.0.3

### Patch Changes

- a6a537c: Machine-readable skill scans now flush their complete JSON evidence before exiting.

  - Preserve full findings and suppression evidence when stdout is a pipe, including warning and blocking exits.
  - Keep the JSON schema, newline termination, human output and verdict semantics unchanged.

## 1.0.2

### Patch Changes

- b8c57c8: Release preparation now fetches the Git history required by exact historical compatibility checks.

  - Match the full-history checkout already used by required CI while retaining disabled checkout credentials and pinned actions.
  - Keep the pre-amendment reader fixture intact so a release cannot silently lose backward-compatibility coverage.

## 1.0.1

### Patch Changes

- 020fd9b: Release preparation now validates warning-only scanner output instead of rejecting it before inspection.

  - Accept exit `1` only for the exact skill-scan call, then require the existing zero-block complete-coverage JSON contract.
  - Keep every other command zero-only and preserve scanner exit `2`, malformed, blocked, or incomplete evidence as hard failures.

## 1.0.0

### Major Changes

- 86158a3: Resolve organization policy, scoped administration and registered-machine settings consistently across consumers.

  - Require exact organization delegation for locked overrides, with source and freshness diagnostics.
  - Reject stale or mismatched policy snapshots and legacy role-based authority; preserve explicit local operation and readable legacy policy.
  - Compile guard policy schema2 and keep capture/export refusals effective before side effects.
  - Batch exact policy Git blobs with bounded, verified framing while rechecking snapshot identity and freshness on every read.

- 86158a3: Require exact reviewed commit, base and scope bindings before shipping.

  - Accept only operator-authenticated current review markers and explicit same-review finding exceptions.
  - Check clean committed candidates and refuse check-induced changes.
  - Preserve implemented deliveries separately from partial, prepared and unperformed parent scope.
  - Require legacy review records to be renewed.

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

- 86158a3: Recover approved work by exact task and canonical source identity, preserving completed work, interrupted attempts and pending delivery.

  - Recover a completely verified stopped parent/child group from the real dispatcher tick with one durable intent, one conditional succession and twice-fresh receipt/current-owner validation, including lost responses.
  - Construct and read back every same-home or remote-only attempt before starting the parent, re-resolve machine enrollment for every later action, and resume a partially started group without another transfer or start. A durable controller barrier finishes recovered children and joins before the parent vendor starts, while accepted children receive current-generation stop/completion evidence without process, check or merge replay.
  - Preserve separate parent execution/integration and exact child checkpoint authority through recovery, and refuse substituted branches, stale passes or incomplete evidence.
  - Keep task-scoped preparation, immutable accepted-child delivery evidence and bounded verified lessons with local reversible undo; session hooks use VegaFactory-owned context without native Claude or Codex memory.
  - Status derives the current recovery role through read-only task and succession inspection, so ordinary claims stay out of recovery while later claimed children and incomplete or moving history never appear as launch-ready parents.
  - Provider, platform and installed-harness qualification remains unperformed and is not implied by controlled source fixtures.

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

- 86158a3: Require current scoped operator intent before planning or implementation launches.

  - Bind approval to canonical artifacts; task progress preserves intent while scope changes require reconfirmation.
  - Require a policy-operator publisher for session attestations, or a verified identical grant relay that inherits its source’s authority and lifecycle.
  - Preserve canonical source provenance through launch, preparation and research records; unavailable source reads refuse, and recovery refreshes authority before another effect.
  - Separate parent execution from exact per-child checkpoint authority, and treat missing or invalid closed fleet-parallel declarations as repository-exclusive.
  - Retain legacy records and exact consolidated preparation, research and shipping boundaries.

### Minor Changes

- cdb3df1: Every skill now carries agentskills.io eval cases, and skillify names `claude plugin eval` as the Claude-side runner beside the subagent procedure.

  - `evals/evals.json` per skill (`skill_name`, `evals[] {id, prompt, expected_output, files[], assertions[]}`), unpackaged like `tests/`, written by the scaffolder as a placeholder, and warned on by `structure.mjs check` when missing or malformed.
  - The eval playbook documents the case format, the runner invocation with its verified status on the build date, the subagent procedure that runs the same cases on every harness, and the `timing.json` / `grading.json` / `benchmark.json` result files.
  - `**/evals/results/` and `*-workspace/` are gitignored; README tables carry the `evals/` row.

- 0ba9631: The product is now VegaFactory: the package is `@vegastack/vegafactory`, the bin is `vegafactory`, and installer verbs live under a `skills` namespace.

  - `@vegastack/skills` is orphaned with no shim, alias, or deprecation pointer — a direct cutoff.
  - Installer verbs require the namespace: `vegafactory skills add|verify|list|doctor|remove`. A bare `vegafactory add …` is a usage error naming the new form.
  - The top-level verbs `dispatch`, `service`, `status`, `worktree`, `sync`, `stats` and `dashboard` are reserved: they appear in usage and refuse until they land.
  - The authored group `dev-skills` is now `dev`, so `--group dev-skills` becomes `--group dev`. Skill names are unchanged and the published bundle stays flat.
  - Existing installs are replaced by re-running `npx @vegastack/vegafactory skills add --group dev --global --force`.

- 57eb048: Every workflow issue is now assigned to the human whose move it is, so GitHub's own notifications reach them without extra tooling.

  - dev.md gains an `operators:` knob — the csv of humans who own issues here; dev-setup writes the detected login and offers the list in Round B.
  - The workflow conventions' Labels table gains an assignee column, and states the operator rule once: an issue's operator is its approval-marker author when `operators:` names them, else its issue author when listed, else the first listed.
  - dev-intake creates with `--assignee`, dev-plan assigns on `needs-operator` and unassigns on `ready`, dev-implement claims by assigning the runner and hands back to the operator.
  - `preflight.mjs` warns (never blocks) when a `ready` issue already carries an assignee, naming who holds it.
  - `status.mjs` reads the knob and the caller, returns `assignees` and a resolved `operator` per issue, and derives `needsYou` and `unowned`; dev-status defaults to your own board and takes `--all` for the team's.

- 9441b2f: dev-setup now ships a four-hook package it writes to `.vegastack/hooks/` and wires per harness on your yes.

  - An environment-aware ship guard that reads your `## Environments` policy lines, the `gates:` knob and the `## Ship` `ask:` lines and asks before a merge, tag, publish or production deploy.
  - A SessionStart hook that opens each session with your queue and the worktree this checkout holds.
  - A Stop heartbeat that asks a session holding a `working` claim to checkpoint its ledger.
  - The decision nudge, now a packaged Node file rather than an inline shell recipe that needed `jq`.

- ddbf9ae: The ship guard no longer reads `.vegastack/dev.md` and no longer matches the raw command text.

  - Its only policy is `~/.vegastack/guard/<owner>__<repo>.json`, keyed by the checkout's origin remote and compiled from dev.md by dev-setup on your yes or by the new `vegafactory guard sync [--check]` — outside every worktree, so a run under bypassed permissions cannot edit its own profile into permission. With the file missing, stale-for-another-repo or malformed, every guarded command asks and names the sync command; `--check` exits 2 when the file is stale, and the SessionStart hook says so. Run `vegafactory guard sync` once per repo after upgrading.
  - Commands are read as a shell reads them — quotes, escapes, `;` `&&` `||` `|` `&`, subshells, `$(…)`, `sh -c` — wrappers, paths and git/gh global options resolved, then matched on the argv: every refspec spelling of a push to the default branch (`HEAD:main`, `refs/heads/main`, `main:main`, `+main`), force, delete and `--no-verify` flags in any position, `--tags`, `gh api` on a merge URL, and text handed to another interpreter. The reviewer's nineteen bypasses are now test cases.
  - A `## Ship` `ask:` step guards a command only when the step names it in backticks; a prose step is a runbook instruction, not a pattern.
  - The dispatcher refuses a repo whose compiled policy is missing, and the headless prompt fences the issue's title and outcome as data.
  - Contract change: the hook's `--check` mode takes `--policy PATH` and `--repo owner/repo` instead of `--dev-md`.

- ccb3228: The skill scanner is now its own installable skill, `skill-scan`, in a new `skills-tooling` group.

  - New group `skills-tooling` — tools that work on agent skills themselves. It is installable everywhere, so `skills add --all` brings `skill-scan` along; `skills add --group skills-tooling` installs the group on its own.
  - `skill-scan` owns the guard (`scripts/skill-scan.mjs`), its SkillSpector library (`scripts/lib/skillspector.mjs`), the baseline discipline, the `skill-scan:` and `skillspector-update:` knobs, and the six SkillSpector refresh sources — all moved from `dev-review` with their tests.
  - `dev-review` narrows to code review. It keeps its Security axis, which now consumes the scan's report as an input rather than running the scan; its refresh contract returns to an evergreen waiver.
  - dev-implement's Verify gate now runs `node <path-to-skill-scan>/scripts/skill-scan.mjs --json`, and dev-setup says that a project setting a `skill-scan:` root installs the `skill-scan` skill.
  - Migration: a project already setting `skill-scan:` should install `skill-scan` alongside `dev-review` — `vegafactory skills add skill-scan`. Nothing the scanner checks, and none of the knob defaults, changed.

- ca77712: A parent issue can now run its independent children at the same time, each in its own worktree, and join them back in plan order.

  - dev-plan's plan format gains an optional `**Independent groups:**` block — one line per child or task group with an explicit file set — and `plan-lint` blocks a group with no file set, an overlapping set, a repeated id, a member in two groups, and a line outside the grammar.
  - `plan-lint --groups --json` prints the validated groups, so the grammar has exactly one parser in the family.
  - New `dev-implement/scripts/children.mjs`: `plan | launch | join | remove` over that JSON — parallel-or-sequential with its reason, the concurrency cap, child branch and worktree names, the per-harness launch shape, the declared-file-set scope check and the fast-forward join. Dry-run until `--write`.
  - Child worktrees branch from the parent's HEAD **sha**, never a ref: `worktree.mjs create --base <sha>` and the new `childWorktreePlan` refuse anything that could move under a parallel run.
  - New saved workflow `assets/workflows/implement-children.js` runs one agent per child with `isolation: "worktree"`; dev-setup offers to install it to `.claude/workflows/` on the operator's yes. On Codex each child is one `codex exec -C <worktree>`, because `spawn_agent` takes no cwd.
  - `vegafactory dispatch` launches one parent run instead of one run per child when two or more ready, unassigned children each sit in a group of their own — on the repo's implement harness (Codex parents drive `children.mjs` directly, with no saved workflow), from a plan comment posted by a listed operator and no one else, and only while the parent's worktree exists; otherwise the children run one at a time.
  - A child that fails keeps its branch and worktree and is reported; a child whose diff leaves its declared set is not merged at all.

- 31333df: The public GitHub App "VegaFactory" has a documented contract, and the control room records its installation.

  - New `dev-setup/references/github-app.md`: what the App is for and why it is never the dispatcher's identity, the exact permission table (Issues read/write · Metadata read · Projects (organization) read/write · Pull requests read/write · Contents read), the operator-only creation walk, the org variable and secret names, the `actions/create-github-app-token@v3` mint recipe, the installations command, the rotation order, the uninstall kill switch, and the three-check acceptance drill.
  - dev-setup detects an org App installation in Step 1, offers the App-token recipe in place of a personal access token in Round C, and names the gap in its report when no installation is found. A 403 from the installations endpoint is reported as an unknown, never as a missing App.
  - Three refresh entries — `GH-APP-PERMS`, `GH-APP-TOKEN`, `GH-APP-INSTALLS` — pin the App reference whole on a 14-day clock, because that file deliberately carries no `<!-- source: -->` markers.
  - `vegafactory-setup` gains a `## Round — automation identity`, and the control room's `org.md` an `## Automation identity` block recording the App name, slug, installation id, secret **names** and granted permissions. Generating the private key is not automatable and the skill never attempts it.
  - The mint recipe names `repositories:` beside `owner:` — `owner:` alone mints for every repository the installation covers — and the acceptance drill gains the scope check that proves it.

- 092e6d0: `vegafactory sync` keeps a shallow control-room clone current at `~/.vegastack/control-room/<org>/`, and the skills read that clone instead of the network.

  - `.vegastack/dev.md` gains `sync-max-age:` and records the clone sha it was drafted from in `control-room:`; the SessionStart hook refreshes the clone when the last successful fetch is older than that age.
  - dev-status reports which org or group knobs moved since the profile was drafted, as a proposal — hand edits in dev.md still win, and nothing is edited automatically.
  - A clone with local modifications, a symlinked clone path, or an unreadable `~/.vegastack/factory.json` is refused by name; a failed fetch keeps the existing clone and reports when it last synced.
  - `vegafactory sync --org <org>` is the bootstrap path for a repo whose profile has no `control-room:` knob yet — dev-setup's first run — resolving the room as `<org>/vegafactory-control-room`; an `--org` that disagrees with an existing knob is refused.
  - Editing `remote` or `branch` in `~/.vegastack/factory.json` now takes effect on the next refresh: the clone's origin is re-pointed and reset to what was fetched, where before a refresh kept fetching the URL baked in at clone time and reported success.

- c22dbcd: dev.md gains an architecture-owner knob and two chronicle voice knobs, dev-setup writes them without a question, and dev-architect now addresses the architecture owner instead of one named person.

  - `architect: <github-username>` names the architecture owner dev-architect speaks to; dev-setup writes `gh api user -q .login` as the default.
  - `chronicle-style: plain | story | witty` and `emoji: none | sparing` set the voice of chronicle entries; dev-chronicle's new `references/styles.md` carries the rule every style follows, the boundary of witty, and one worked example per style.
  - dev-implement's chronicle write rule cites the two voice knobs.
  - dev-architect's directive sentences say "the architecture owner"; sentences recording what MK decided or reversed stay as record, and the three directives about ship consent, rollback go-ahead, and OTP/2FA entry say "the operator".
  - The profile template's `## Stop and ask` opens with the pause-only sentence — ask and end the turn rather than end on a promise — followed by the project's concrete list.

- bbc9c1a: dev-intake, dev-plan and dev-implement now ask their questions in the issue when no harness question tool is available, and parse your reply on the next run.

  - A new `questions` comment type carries the round: numbered questions, lettered options, exactly one recommendation with its reason, and a reply line.
  - Reply in an ordinary comment — `1: b`, `2: a — because …`, `3: other — …`, or `all recommended`; anyone on the issue may answer, and an answer is never an approval.
  - A partly answered round is re-asked at the next `rev` carrying only the open questions, at their original numbers.
  - The route is decided programmatically: `VSK_ASK_ROUTE` first, then whether the run has a question tool, then whether the asker is the issue's operator.
  - A later session with no local copy of the round reads it back out of the posted comment (`--round`), and text that could forge a marker or close the block is refused in both directions.
  - dev-setup ships the shared `scripts/questions.mjs` and `references/ask-route.md` into all three skills.
  - On the issue route dev-intake creates the issue before its first round — `needs-operator`, operator assigned, the request as the body — so the round has a surface; the tool route still creates it after approval.
  - A reply line whose letter runs into prose with no dash (`1: a is wrong, go with b`) is reported as malformed and re-asked, instead of being recorded as the letter it opens with.
  - `ask-route.md` points at `harness-facts.md` by path rather than by link, because the three consumer skills do not ship that reference; a repo test now resolves every link in a packaged reference against the consumer's bundle.

- dc6e843: Board mirror: dev-setup writes `.github/workflows/factory-board.yml`, the new `board:` knob names the project, and vegafactory-setup creates and links it. Labels drive the state; the board follows, one way.
  - `runs-on` is bound unquoted, so a label-array runner (`[self-hosted, x]`) renders as a YAML sequence rather than one literal label that no runner carries; the mint step is on `actions/create-github-app-token@v3`, the major the App reference documents, and passes `repositories:` so the token is scoped to the one repository the job runs in; the mirror step adds an item only on gh's own "is not an item in project" error and reports every other failure as itself.
- 05c00aa: dev-implement uploads UI evidence through a dry-run-by-default script and keeps its changelog mechanics and dev-review's scanner-provisioning detail out of the skill bodies.

  - New `scripts/evidence-upload.mjs`: `--repo <o/r> --issue <n> --file <png> [--evidence-repo <o/r>] [--dev-md <path>] [--write] [--json]` — plans the PUT (path `<repo-name>/<issue>/<timestamp>-<name>`, size) and sends only under `--write`; the `{message, content}` body rides gh's stdin so the base64 payload never touches argv or any output line; one retry under a `-r2` name on HTTP 409; symlinks, non-image extensions, empty files, and a missing `evidence-repo:` knob are refused with exit 2.
  - New `references/changelog-and-chronicle.md` carries the per-knob changelog mechanics, the entry's first-line rule, and the chronicle hand-off; dev-implement's body keeps a one-paragraph pointer and its Verify bullet names the script instead of a shell one-liner.
  - dev-review's body keeps one sentence on scanner provisioning; the uv/brew/pipx lookup, the `skillspector-update:` knob, `--no-provision`, and the upgrade-reporting rule live in its README.
  - `ghJson` in `scripts/lib/gh.mjs` accepts an `input` option that feeds the child's stdin, so one gh runner serves reads and stdin-fed writes.

- f496680: Every dev skill body now reads to the current Anthropic guidance: one stance sentence, positive rules with their reason, at most two emphasised non-negotiables per skill, no caps-emphasis, no instructions the model already follows, and a length line for every document a skill writes.

  - dev-implement carries the scope block (the approved brief and plan are the scope; extras become a Not done / limits note; tests sized like their neighbours, one per stated behaviour at the brief's seams; no feature flags or compat shims when the code can just change) and the dark-mode narration rule (no questions; every ledger checkpoint is also the chat update; headless runs use the issue as the only channel).
  - dev-review's axis briefs ask for every finding with confidence and severity and name the loop as the filter; dispatch prompts put the documents first and the ask last.
  - dev-architect's verify protocol names the name itself as the thing to verify; its agent-loop reference records the append-only-history and no-prefill facts with their verification date.
  - dev-intake's brief template gains a worked example of summarising an SOW in the agent's own words with the client's terms quoted.
  - No rule is weakened: every rewritten "never" keeps its scope in positive form. Bodies measured before and after, with a snapshot-versus-rewrite eval per skill, are in the issue's evidence.

- 2051b37: dev-setup now detects which agent harnesses are on the box and drafts a per-stage harness policy the rest of the workflow can read.

  - Two new dev.md knobs: `harnesses:` records each harness and its version (or `absent`), and `harness-policy:` carries one `<stage> <agent> <model> <effort>` entry for each of the six stages — intake, plan, implement, review, status, chronicle.
  - Only one harness on the box → dev-setup recommends `review: subagent` and says cross-agent is off until a second one exists; any harness the policy names but the box lacks is recorded in `## Environments` with the capability it gates.
  - dev-review's cross-agent invocation takes the reviewing agent's model and effort from that policy's `review` entry, passing them as flags in the exec arg array.
  - harness-facts.md gains the per-harness model, effort and concurrency controls (Claude Code's `--model`/`--effort` and the `CLAUDE_CODE_MAX_*` caps; Codex's `-c model=` / `-c model_reasoning_effort=` and `agents.max_concurrent_threads_per_session`) under three refresh sources, plus the reproducible `codex exec` skill-loading drill.
  - The shipped `harness-policy:` defaults name Claude models by the alias Claude Code accepts (`fable`, `sonnet`); the bare `fable-5-1` / `sonnet-5` forms were refused as unrecognized by `claude --model`.

- 0c16073: dev-setup's harness facts are current as of 02-09-2026 and now cover three harnesses and the GitHub CLI.

  - `references/harness-facts.md` gains Codex hooks (stable: the full event list, `hooks.json` locations, trust gating, `codex exec --dangerously-bypass-hook-trust`), Codex multi-agent (built-in `default`/`worker`/`explorer`, `.codex/agents/*.toml`, the concurrency cap), a Hermes section (`clarify`, `delegate_task`, `pre_tool_call` hooks), the Claude Code `claude_code` preset note, and a `## GitHub CLI` section stating the floors: gh 2.94.0 for native issue types, sub-issues and dependencies, gh 2.97.0 for name-based project field edits.
  - Five refresh sources (`CC-SDK-PRESET`, `CODEX-AGENTS-MULTI`, `HERMES-HOOKS`, `HERMES-TOOLS`, `GH-CLI`) join the registry with runner-seeded baselines; a test now holds the source markers and the registry in bijection.
  - dev-setup's Step 1 detects `gh --version` and which of `claude`, `codex`, `hermes` are installed, and its report names every gh feature the detected version lacks.
  - dev-implement and skillify's eval playbook no longer describe a harness without subagents; all three target harnesses spawn them.

- 86158a3: Require supported hook registration and current compiled policy in the actual prepared checkout before managed execution.

  - Reject unrelated hook mentions, unsupported command wrappers and stale policy without silently recompiling permission.
  - Disable native memory through managed-session controls while preserving hooks and project instructions.
  - Bound advisory hooks to sanitized local requests and distinguish configured, invoked and qualified behavior.

- 47bde99: Any organisation that installs the VegaFactory App can now get repository-scoped GitHub tokens from a hosted broker instead of holding a private key of its own.

  - A Cloudflare Worker at `packages/broker` exchanges a GitHub Actions OIDC token (audience `vegastack-factory`) for a one-repository installation token capped to `issues: write`, `metadata: read`, `organization_projects: write` — enforced in the request and again against the response's own permission echo.
  - The repository comes from the verified OIDC `repository` and `repository_owner` claims and from nothing the caller sends, so one organisation can never mint a token for another's repository.
  - Fails closed: 401 unverifiable token, 403 uninstalled repository, 429 rate limited, 503 rate limiter unavailable, 502 upstream failure, 500 on a widened permission echo with the token discarded. `GET /health` answers unauthenticated and reads no credential.
  - The App private key lives only in a Cloudflare Secrets Store secret; the broker declares no storage binding at all and persists no customer content — one audit record per request carries repository, owner, installation id, decision and status, never a token.
  - `github-app.md` gains the customer-facing `Hosted token broker` reference: status codes, tenancy, rotation runbook, uninstall kill switch, rate-limit honesty, and the support boundary. The `vegastack/factory-token` composite action source ships in `packages/broker/action/`.

- dfb99c8: vegafactory-setup ships a dispatcher-box provisioning checklist, and both workflows record the always-on runner group they will move to.

  - `onboarding/dispatcher-box.md` is the control room's third onboarding path: two macOS accounts on the box, so a CI job cannot read the dispatcher's tokens; the pinned toolchain (bun 1.3.14, Node 24, gh 2.97+, uv + SkillSpector); the sleep and auto-login rules; the runner registration block; the org-admin group grant; and a reboot drill that proves "always-on".
  - `ci.yml` and `release.yml` name the org runner group `vsk-runners-mac-mini` and the exact switch to it, but keep targeting the registered laptop runners: an ungranted or empty group queues a required check forever with `runner: null`, so the switch waits for the operator's org-admin grant.
  - Provenance stays off — moving to the mini does not restore it, because npm accepts a provenance bundle only from a GitHub-hosted runner (#57).
  - `onboarding/dispatcher-box.md` creates and grants the runner group before the runner registers into it, and the registration block runs without `gh`: the release is looked up over the public API and the registration token is minted by an org admin and pasted in, so the runner account never holds a credential.

- 0fb6466: dev-intake stamps the org's native issue type and its Priority and Effort issue fields on every issue it creates, and dev-setup detects both and records them as the issue-types: and issue-fields: knobs. A repo with no org types degrades to labels.
- fc69f93: Every branch now lives in its own worktree under `.vegastack/.worktrees/<n>-<slug>/`, and `vegafactory worktree` manages their whole lifecycle.

  - New `vegafactory worktree list|status|create|restore|remove|prune`. `remove` and `prune` are dry-run until `--write`; `create` and `restore` write by default. `worktree` is no longer a reserved verb.
  - The lifecycle is derived from git and GitHub on every read, never stored: `active`, `parked`, `merged`, `abandoned`, `orphan-dir`, `branch-only`.
  - A worktree is removed only when it is clean, pushed, merged into the default branch and unlocked. `remove` fetches the default branch first and counts a squash or rebase merge as merged by patch content, so the routine post-merge removal needs no `--force` under any `merge:` knob. `--force` lifts the not-merged check and nothing else — uncommitted, unpushed and locked work is never discarded. The local and remote branches are never touched.
  - `prune` removes only parked worktrees past `worktree-retention:` (default 14 days, measured from the later of the last commit and the last ledger edit), pushing an unpushed candidate first; the window stands in for the not-merged check there, and dirty, unpushed or locked work still keeps its worktree.
  - `create <issue>` and `restore <issue>` need no `--slug`: create names the worktree from the issue title (`<type>:` prefix as the branch type), restore from the branch that carries the number.
  - Two new dev.md knobs, written by dev-setup: `worktree-include:` (gitignored files copied into each new worktree) and `worktree-retention:`. `commands:` gains a `setup` field that each new worktree replays, and dev-setup adds `.vegastack/.worktrees/` to the project `.gitignore`.
  - `ship-gate.mjs` resolves the branch's worktree itself and runs its git calls, its dev.md read and the fresh check command there, so the old checkout-mismatch block no longer forces a branch switch in the main checkout. `--worktree <path>` overrides.
  - dev-implement claims, resumes and corrects inside one worktree; dev-ship removes it after the merge. The scenario matrix, the lifecycle states and the safe-to-remove test live in dev-implement's `references/worktrees.md`.

- 86158a3: Protect dispatcher ownership with atomic local claims and conditional shared task records.

  - Preserve unverifiable and legacy lock evidence, and release only the acquired owner token.
  - Add bounded shared-state transactions, immutable recovery receipts and explicit unmanaged-effect barriers.
  - Free child process capacity only after revalidating physical stop; retain resource and recovery ownership.
  - Keep typed telemetry delivery pending without blocking otherwise verified code completion or transfer.
  - Inspect retained active or completed private task records at one verified current head, preserving recovery and pending delivery references.
  - Reuse only the live caller’s verified immutable process identity to reduce claim overhead while retaining fresh foreign-process and ownership checks.
  - Link verified partial acceptance while retaining current ownership and all reservations; inspect immutable historical task facts from pinned receipts and exact original owner identities.
  - Treat in-progress local guard publication as bounded contention while preserving unknown or abandoned guard evidence.
  - Recover a committed handoff after response loss only from its exact receipt, original owner and revalidated transfer authority.
  - Inspect handoff receipts as verified predecessor and successor records without treating null handoff payloads as recovery evidence.
  - Reconcile a new session on the same machine against unchanged stopped task records before replacing handoff ownership.
  - Project sanitized current task ownership and checkpoint summaries with bounded, receipt-verified history; retain unknown provenance and explicit incomplete archive coverage without writing status pointers.
  - Transfer one exactly verified stopped parent/direct-child group in a single conditional commit, preserving every reservation and accepted/effect/history field while queuing unfinished children behind fresh capacity checks.
  - Keep completed and never-started declared groups outside that transfer through a closed evidence-bound classification.
  - Admit top-level fleet parallelism only from #135's current closed declaration and canonical selected-task file projection; every missing, invalid, stale or mismatched declaration remains repository-exclusive.
  - Preserve GitHub rate-limit timing and exact systemd executable, configuration and log-path values.

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

- 86158a3: The broker verifies signed repository identity and actual token reach before returning capped automation access.

  - Bound upstream reads and signing-key rotation, validate token expiry, and attempt disposable-token cleanup after refusal.
  - Preserve installed-repository workflow eligibility and disclose organization-wide project authority.
  - Expose the action's documented expiry output and keep credentials out of failure messages.

- 86158a3: Prepare the VegaFactory broker's canonical domains and require reviewed deployments for both environments sharing its App.

  - Keep the existing App identity and OIDC audience while moving caller defaults to vegafactory-token.vegastack.com.
  - Replace automatic preview deployment with protected dispatches tied to a reviewed merged commit and exact Worker digest; unresolved store IDs still block deployment.
  - Document preview and production readiness, caller migration, and compatible rollback prerequisites without claiming live acceptance.

- 140cbf0: Skill README file tables are generated from `packages/cli/packaging.json`, and the structure check enforces them.

  - New `node packages/cli/scripts/readme-sync.mjs [--write]` (`bun run readme:sync`) renders each skill README's "What's in this skill" table from the skill's packaging entry — packaging order, purposes preserved by path, a placeholder purpose on a newly packaged file, a fixed `tests/` row, and an `evals/` row when that directory exists. Dry run by default, atomic write, refuses symlinked READMEs, and stops without writing when a README carries a row it cannot classify.
  - `structure.mjs check` (a `bun run check` stage) now blocks when a skill README's table is not what `readme-sync` would render, and warns on any placeholder purpose left behind.
  - All twelve skill READMEs regenerated; skillify's README template ships in sync with the scaffolder's default packaging entry; skill-maintainer's operating rule 8 names the sync command.

- 86158a3: Run independent children through the CLI and join only verified execution results.

  - Bind child processes, acceptance checks and immutable commits to the original parent owner.
  - Derive separate exact execution and child-checkpoint requests from current consolidated parent authority without child-approval or parent-branch fallback.
  - Preserve original child provenance across verified group succession and start recovered children only after shared capacity readback.
  - Preserve interrupted and partial joins, refuse failed preparation, and retain parent worktrees used by serial children.

- 86158a3: Preserve private execution records and separate process outcomes from approved progress delivery.

  - Run an owned process wrapper with bounded cancellation and no ordinary task duration cutoff.
  - Inspect durable run status and validate complete committed history before an explicitly authorized checkpoint push.
  - Retain shared ownership and pending delivery when qualification, recovery or remote acknowledgment is unavailable.
  - Admit approved runs through registered runtime evidence and persist effect receipts for checkpoints, handback, and terminal capture.
  - Recognize subscription quota exhaustion, retain the original account and vendor session across waiting and restart, and retry only after current authority and availability checks.
  - Preserve verified physical-stop receipts when code delivery or effect coverage remains unresolved, with stable receipt payloads across retries.
  - Continue verified unfinished work with a fresh private attempt, immutable prior interruption records, and separate terminal measurement segments.
  - Recover standalone tasks on a verified receiving machine under the original run identity, preserving unavailable history and holding reporting until its original identity is available.

- c5bc33a: skill-maintainer and skillify are sharpened against each other: skill-maintainer owns the standards and the repo and release operations, skillify owns the procedure and cites those standards instead of restating them.

  - skill-maintainer's description is a calm "Use when working on this repository…" conditional with a "Not for" clause; operating rule 4 states the calm-description standard with its reason, rule 7 is worded positive, and rule 8 names `readme:sync --write` after a packaging change. The body is under 1,200 words: script-behaviour detail now points at the scripts' own dry-run and usage output, and the release workflow routes to dev.md's `## Ship` runbook instead of carrying a stale copy.
  - skill-maintainer's rename line and content-versioning bullet now follow dev.md and release-ops.md: a skill rename is MINOR unless the operator declares MAJOR (the body previously said MAJOR, contradicting both).
  - skillify's checklist item 1 adds "body ≤1,200 words, detail routed to references" and cites skill-maintainer's rules 2–6; the worked example and anti-patterns moved to `references/authoring.md`, which now cites skill-maintainer's Hard limits table instead of mirroring it; the eval playbook gains the colleague test and the remove-a-rule-before-rewriting-it rule.
  - Both trigger fixtures carry mirrored near-miss negatives against the other skill; skill-maintainer gains its fixture.
  - No normative rule is weakened: every rule that left one body is cited from its remaining home, and the hard limits are unchanged.

- 86bb75d: Agent runs and sessions are now counted: `vegafactory stats` records one line per run in the org's own control room and prints where the time and money went.

  - New `stats` verbs: `stats [--repo|--me|--org|skills] [--since MON-YYYY]` prints the tables, `stats push` copies the machine-local outbox into the control room (dry run until `--commit`, rebasing and retrying on a concurrent push, one push at a time per machine, and deferring rather than reporting success when any git step fails), `stats rollup` regenerates the per-repo, per-org and per-skill summaries, and `stats record --source <kind>` is what the capture hooks call.
  - `stats rollup` reads each touched issue's label timeline through `gh` and writes it beside the summary as `<MON-YYYY>.timeline.json`, which is where lead and cycle time come from; a rollup that cannot reach `gh` keeps the clone's last timeline file and exits 1 naming the reason. Rework rounds are read after each headless run from the issue's review, ledger and hand-back comments, counted once per issue, and reported as `null` — never `0` — for a month in which nothing measured them.
  - Capture is deterministic and has no model in the loop: the dispatcher parses each harness's own run output, three new dev-setup hooks cover interactive sessions and skill invocations, and every record is counts and identifiers only — never prompt text, assistant text, tool arguments, or file contents.
  - Whether anything is recorded is org policy — `stats:` and `stats-people:` in the control room's `org.md` or a department's `group.md`, with a repo opt-out only under `stats-override: allowed` — and there is no machine-level knob.

- 7cc6b48: skillify ships `scripts/trigger-check.mjs`, a deterministic family-level trigger guard that runs in `bun run check` as `validate:triggers`.

  - Walks every skill's `tests/fixtures/trigger-queries.json` and blocks when two skills both claim one normalised query as `should_trigger: true` without a mutual `ambiguous_with`.
  - Warns on fixture hygiene: neighbour names no skill here carries, one-sided references, missing or short fixtures; warnings fail only under `--strict`.

- d0e2b2f: `vegafactory dashboard` starts a local, read-only web view of the factory — throughput, cost, where human time goes, the board, and the dispatcher — over the control room's own statistics.

  - Six views: org overview, repo (the repo's lead time and cycle time per workflow state from `stats rollup`'s own summary, runs and cost per stage, rework and cost per issue), people, skills (invocations, trigger, outcome, cost per invocation), board, dispatcher. Filters by month, repo, group, harness and model, each one a URL you can bookmark or paste into an issue.
  - The control-room clone is the source of truth. On start the server builds a derived `bun:sqlite` index at `~/.vegastack/cache/stats.db`, rebuilt whenever a source file changes; the file is disposable and deleting it is always safe.
  - Live board data — open issues, pull requests, worktrees, dispatcher health — comes from your own `gh` token and `vegafactory status --json`. When either is unreachable the page still renders from the clone, behind a banner naming what failed and how old the clone is; one repo the board cannot read keeps every other repo's rows on the page.
  - People-level numbers stay behind the org's `stats-people` knob: you always see your own row, and anyone else's needs both that knob on and a `lead` role in `people.csv`.
  - The app ships as a second package, `@vegastack/vegafactory-dashboard`, fetched at the CLI's own version on first use into `~/.vegastack/dashboard/<version>/`, so the core install stays small. The server binds `127.0.0.1` only and the token never leaves it.

- ee7f3be: The dispatcher lands: `vegafactory dispatch` turns labels and 🚀 reactions on watched repos into headless runs in feature worktrees, `vegafactory service install` runs it as a launchd LaunchAgent or systemd user unit, and `vegafactory status` shows the board, the worktrees and the dispatcher's health.

  - `dispatch [--once] [--watch] [--dry-run] [--json] [--config PATH]` — `needs-plan` starts a planning run, unassigned `ready` an implementation run, and a 🚀 from an operator listed in `operators:` a corrections run; dry run unless `--once` or `--watch` is given.
  - Every for-operator issue is read on every tick — a reaction never moves an issue's `updated_at`, so no `updated:` window could find a 🚀 on an existing comment — and the handled list is what stops the repeats.
  - Runs finish out-of-band: a tick starts its runs and returns, the loop keeps its interval however long a run takes, `maxRuns` is the number of runs a repo may have in flight at once, an issue with a run in flight is refused by name, and `--once` waits for the runs it started before it exits.
  - A repo is refused, by name and with the reason, until its own `.vegastack/dev.md` says `dispatch: local` and its ship-guard hook is wired for the harness that would run — checked per harness the tick would launch, and again in the worktree the run starts in, since a harness reads its hooks from the directory it is started in and a fresh checkout carries tracked files only.
  - Runs are logged as JSONL under `~/.vegastack/factory/logs/`; a failed or timed-out run posts a hand-back comment with the redacted last 40 lines and sends the issue back to `needs-operator`.
  - `service install|uninstall|status` is dry-run until `--write`, and installs a user-level service that runs as the operator with their own `gh` and harness authentication.
  - New profile knob `dispatch: off|local`, and the reaction trigger is written into dev-implement's corrections loop.

- 3668ca0: A new `factory` group ships `vegafactory-setup`, the skill that bootstraps and maintains the org control room every repo's profile layers on.

  - The control room's files — `org.md`, `people.csv`, `decisions.md`, `groups/<g>/{group.md,people.csv,decisions.md}`, `repos.md`, `boards.md`, `rules/`, `onboarding/`, `templates/` — ship as seed templates with one reference documenting the layout, the precedence, and the read path.
  - dev-setup now detects org defaults first and states an inherited knob instead of asking for it; `.vegastack/dev.md` gains a `control-room:` knob.
  - `references/conventions.md` states the precedence in one line; the checkpoint-retention rule moved to dev-implement's `references/ledger-and-resume.md`, the skill that applies it.
  - `groups/<g>/group.md` carries its harness policy as the one `harness-policy:` line dev.md uses, so the dispatcher's parser layers the two files key by key (the six `harness:` lines it wrote before parsed as nothing), and it gains defaults for `ui-evidence:`, `worktree-retention:`, `skillspector-update:` and `sync-max-age:`; its promise is stated as every knob a group can decide, not every knob a dev.md can hold.

### Patch Changes

- 7b4a48b: `validate:skill` now rejects a description carrying `: ` (colon-space), the YAML mapping indicator that made skill-maintainer's frontmatter unparseable and its description invisible to every harness; the description itself is fixed. The shipped scripts, hooks and references no longer carry the two constructs that blinded SkillSpector's static analyzers — the `stdio` mode word beside its own quote, and template literals opening on their interpolation — so every skill but two now scans at full coverage, with the same bytes reaching every child process.
- 9cfa60a: The parallel-children scripts fail closed where they guessed, and the join acts on what the children reported.

  - `children.mjs join --results` now diffs and merges the `branch` each child reports, so a branch the harness named is found rather than re-derived from the issue title; a reported value that is not a branch name is refused before any git call. A `done` child whose diff cannot be read is not merged, is written up in the ledger as not merged, and holds every merge. `wrote` reports whether the parent branch moved, so a join that landed one child and then blocked on another no longer reports a write it made as no write.
  - `launch`, `join` and `remove` block when the issue lookup behind `--repo` fails, instead of creating or looking for branches named from the issue number alone; `plan` still previews with a warning.
  - A group naming two children is refused by `plan-lint` and by `children.mjs plan`: they would run at the same time on one file set, and a parallel group carries one child.
  - The Claude launch prompt names the harness-created worktree as the child's checkout, not a path nothing created.

- c52f65c: The parallel-children join now lands every child, not just the first, and the plan linter refuses a group it could never run.

  - `mergeArgs(child, index)` fast-forwards only the first child — whose base _is_ the parent HEAD, so a refusal there proves the parent moved — and merges every child behind it with `--no-ff --no-edit`. All children branch from the same commit, so the first merge advances the parent and every later child stops being a descendant; `--ff-only` for all of them landed one child and refused the rest. A merge that fails is aborted and the join stops rather than guessing past a conflict.
  - `plan-lint` blocks an independent group that declares a file nearly every change edits — `bun.lock`, `package.json`, `packages/cli/packaging.json`, `.vegastack/dev.md`, `.vegastack/chronicle.md`, `.vegastack/skillspector-baseline.json`, or any README — so a plan that cannot run in parallel says so while it is being written instead of at the join.
  - `references/parallel-children.md` documents how a half-done join resumes: the unmerged child keeps its branch and worktree, nothing merged is rebased, and the next session runs that child alone against the advanced tip.

- 3276063: dev-setup's `factory-board.yml.template` checks the profile out into its own `path: profile` instead of the runner's shared work directory: the sparse checkout of one file left git in sparse mode, and on a self-hosted runner the next job at that path started from an almost-empty tree. Re-run `dev-setup` to refresh a rendered board workflow.
- 3c0d2e8: A feature request typed in chat now routes to dev-intake, and a trivial fix stays on dev-implement's direct path, on Claude Code and Codex alike.

  - The AGENTS.md dev block gains a six-row routing table (request kind → skill), restates the ship rule as a reversibility principle with the concrete list of actions that wait for the operator's word (push to the default branch, merge, tag, publish, deploy, force-push, a hard reset, branch or worktree deletion, `--no-verify`), and adds a short harness-neutral "Agent conduct" paragraph. Installed projects pick it up on their next dev-setup re-run — the block between the `vsk-dev` markers is the only part of AGENTS.md the skill owns.
  - dev-implement, dev-intake, and dev-architect descriptions read as calm conditionals: intake claims "add support for X" phrasings, implement's chat clause is limited to a trivial one-or-two-file fix, and architect's "Consult it BEFORE" becomes "Use when proposing".
  - README quick start says how to load a skill by name (`/dev-intake` in Claude Code and Hermes, `$dev-intake` in Codex) when routing needs bypassing.

- 202e49f: Concurrent coordination readers now wait for a legitimate read-pointer update instead of failing the child gateway.

  - Retry only verified live contention within the existing bounded coordination window.
  - Preserve immediate refusal for malformed or abandoned ownership and retain monotonic-head validation.

- d561827: The three sentences every dev skill repeated — the conventions citation, the dev.md-missing rule, and the closing-summary line — now live in one place each: the AGENTS.md dev block (citation and missing-file rule; consumers pick it up on their next dev-setup re-run) and `references/conventions.md` (closing recap). conventions.md is rewritten to the current guidance without growing: verification audits each claim against a tool result from this session and reports failures and skipped steps as such; narration happens at three moments and leads with the outcome; a ledger checkpoint retains what a compaction summary must retain; delegation is for sizeable, independent, parallel work and never for verifying your own; `<path-to-this-skill>` is defined once.
- 86158a3: Correct scanner test fixtures to remove absent environment overrides while preserving explicit values and restoring the original environment.

## 0.18.0

### Minor Changes

- 5bd203e: The dev workflow now treats the ledger's edit time as a claim's heartbeat, flags a working issue as possibly-orphaned when it goes silent, and blocks a hand-back whose plan checkboxes lag the ledger.

  - dev-status measures ledger movement in hours, not whole days, and reports `possiblyOrphaned` for a working issue whose ledger has been silent past `--orphan-hours` (default 6) or was never written — the claim's heartbeat has stopped; a session that keeps checkpointing, even for days, never trips it.
  - The board's old "Stale" line becomes "Possibly orphaned", surfaced with the `reclaim.mjs` command inline; it stays a fact for the operator, never an automatic reset.
  - New `dev-implement/scripts/reclaim.mjs` releases an orphaned claim (`working` → `ready`, unassign) after a read-verify, and refuses a ledger still fresh under the orphan threshold unless `--force` — the operator runs it; a takeover still needs their explicit handover.
  - `evidence-check.mjs --issue <n>` now blocks hand-back when the ledger's completed tasks outnumber the plan comment's checked `[x]` boxes, so the operator's progress view can no longer silently lag the work.
  - dev-implement names the one-session-one-issue model and promotes ticking the plan checkbox from a parenthetical to a first-class checkpoint step (a second write, to the comment the operator reads).

## 0.17.0

### Minor Changes

- 4fd0c34: The skill-scan guard now finds the SkillSpector CLI through the channel that installed it, and keeps it up to date on its own.

  - A scanner installed via uv, brew, or pipx is located and run by absolute path, so it is no longer reported as missing when the agent's shell has a different `PATH` than the operator's.
  - New `skillspector-update:` knob in `.vegastack/dev.md` — `off | notify | auto`, defaulting to `auto`, which installs SkillSpector when absent and upgrades it before each scan.
  - Any install or upgrade failure falls back to the copy already installed and the scan continues; only a scanner that cannot be found at all still blocks.
  - An upgrade that changes the version or its dependencies is reported before the findings, so new findings read as the scanner having learned something rather than the change having broken something.
  - A baseline that pins `scanner_version` for fingerprint suppressions warns when a different version ran; the pin is never moved automatically.
  - `--no-provision` forces a single run to leave the machine untouched.

## 0.16.2

### Patch Changes

- 4dca22f: Documentation now recommends the global install: `add --group dev-skills --global` is the headline command in the root README, the installer README, and every dev-skill walkthrough.

  - Global installs once per machine and covers every project; it is also the only mode that can target all three runtimes, since Hermes has no project-level discovery. Project-local stays documented for repositories that should carry their own copy.
  - Both READMEs now state that a project-local copy does **not** override a global one in Claude Code — personal skills take precedence over project skills — so the two should not be installed together for the same skill.
  - `skill-maintainer` and `skillify` are named as the deliberate exception: they are repo-only, so a global copy would trigger everywhere.
  - The upgrade path is documented for the first time (`add … --global --force`, with why `--force` is needed), alongside `verify`, `remove`, and `doctor --global` — which skips the per-project `.vegastack/dev.md` check.
  - Every fenced command block is independently pasteable: alternatives no longer share a fence with the command you actually want, and the skill-scan invocation no longer hardcodes a project-local Claude Code path.
  - `skillify`'s scaffolded-README template follows: a new skill's install block is generated with `--global`, and the family-install alternative gets its own fence instead of sharing one with the single-skill command.
  - Root README gains npm/CI/Node/license badges, a table of contents, a scannable requirements table, a numbered quick start, and a contributing-and-support section; `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) is added and linked from `CONTRIBUTING.md`.

## 0.16.1

### Patch Changes

- 82bf062: Operator identity drops the word "operator": every workflow artifact now names the operator as `(<github-username>)` alone.

  - `conventions.md`'s `## Operator identity` is the one home for the rule; approval markers become `Approved by (<username>) on DD-MM-YYYY: "<their words>"` and register lines `- DD-MM-YYYY (<username>) — <decision>`.
  - The revision marker follows: `per (<username>) correction`.
  - `dev-chronicle`'s attribution line becomes `— approved by (<username>) · built by <agent> · branch <name>`.
  - `dev-setup`'s profile template seeds new projects with the short register format, and `dev-review`'s known-patterns template uses it for dismissal attribution.
  - Existing approval markers, chronicle entries and decision-register lines are append-only records and keep the form they were written in.

- 0259cdb: `skill-maintainer`'s release-ops reflects a branch-protected default branch: the version bump lands by PR, not by direct push.

  - The release flow's bump step commits on a `chore/release-<version>` branch and opens its PR; merging it is the operator's word, and the tag goes on the merged commit.
  - Rollback reverts through a PR too — protection applies to reverts, and a rollback is when that discipline matters most.

- 4e066b6: `skillify`'s scaffolder now refuses a repo it cannot wire, instead of creating the tree and reporting success.

  - A missing `README.md` or `packages/cli/packaging.json` is a pre-flight refusal that writes nothing and exits 1, naming the path and what it is needed for. Previously both degraded to a `skipped:` status with exit 0, leaving a skill that `structure.mjs check` immediately blocks.
  - The refusal applies to dry runs too, matching the existing Skills-table refusal.
  - `.changeset/` still degrades to `skipped:` — a missing changeset breaks no check — and `wireSkill` called on its own stays permissive, since it is a wiring primitive rather than a tree creator.

## 0.16.0

### Minor Changes

- 322ae75: The skill-scan baseline gains a `coverage` section, for files a scanner could not finish reading.

  - SkillSpector's own baseline suppresses findings only. It has no way to express "the scan of this file is incomplete", so a skill whose script the scanner cannot fully parse would block forever with no recourse. `coverage` entries accept that, named by `skill` and `file`, under the same discipline as a rule: a written reason carrying a "Still flag if:" clause, enforced by the guard.
  - An acceptance covers exactly the file it names. If a skill has a second unread file that is not accounted for, it still blocks — accepting a known cause must not silently cover an unknown one.
  - `AE1` findings are accepted through `coverage` too. Despite arriving as HIGH findings, they are completeness signals: the scanner's own text is "Referenced artifact was not completely inspected."
  - A degraded or partly-read scan no longer hides the findings it did produce. Only a failed execution short-circuits, where no field of the report can be trusted.
  - `skill-maintainer` documents the triage decision order — fix, rule, fingerprint, coverage, park — and the SkillSpector behaviours already traced on this repo, so future findings are adjudicated the same way rather than re-derived.

## 0.15.0

### Minor Changes

- 1407b93: Projects that author agent skills can now have them scanned for vulnerabilities as part of the workflow, before anything is pushed.

  - A new `skill-scan:` knob in `.vegastack/dev.md` names the directory holding the skills to scan; `none`, or no line at all, turns it off and the guard says it skipped rather than erroring.
  - `dev-review` ships `scripts/skill-scan.mjs`, which runs [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) over each skill and blocks on any unsuppressed HIGH or CRITICAL finding — never on the aggregate risk score, which a skills repo distorts by documenting the very mechanics being scanned.
  - `dev-implement` runs the guard at its Verify gate; `dev-review`'s Security axis triages what it surfaces into the normal review comment and fix loop, and treats every scanner hit as a candidate finding to trace, never a verdict.
  - Suppressions live in a JSON SkillSpector baseline whose every rule needs a reason carrying a "Still flag if:" clause — enforced by the guard, not trusted, and applied to fingerprint entries too so an auto-generated baseline cannot silence everything at once.
  - Baseline matchers must be **literal**: `*`, `?`, `[` and `]` are rejected. A single wildcard rule can silence every finding while the run still reports success, and rejecting wildcard spellings one at a time proved to be an arms race — naming the file is the only checkable form of "as narrow as its cause".
  - The guard refuses anything it cannot verify, not just findings: an unreadable profile or report, a report shape it does not recognise, an unrecognised severity, a scan that inspected zero files or left files partly read, an analyzer that did not finish, a crash, a profile giving `skill-scan` conflicting values, and any directory holding a `SKILL.md` that discovery did not reach — nested too deep, dot-prefixed, or behind a symlink. An unscanned skill nobody mentions looks exactly like a clean one.
  - Discovery reads two levels, so a grouped authored layout (`<root>/<group>/<skill>/`) scans instead of silently finding nothing.
  - `dev-setup` detects skills in a repo and drafts the knob, the Verify bullet, and a blocking pre-publish guard.
  - The scanner is contributor-installed; the guard refuses with the install command when it is missing rather than passing quietly, and it is deliberately not part of `bun run check`.

## 0.14.0

### Minor Changes

- 52cbf1b: Install a whole family of skills in one command: `add`, `verify`, and `remove` now take `--group <name>` or `--all` as well as a single skill name.

  - `npx @vegastack/skills add --group dev-skills` installs the ten dev-workflow skills; `--all` installs every skill worth having in a project.
  - Exactly one selector per invocation — a skill name, `--group`, or `--all`. Combining two is an error, not a merge.
  - A `--group` or `--all` install is one transaction: every skill is checked and staged before any is committed, so if one fails, none are installed and the destination is left as it was. `remove --group` runs every drift check before the first removal, for the same reason.
  - `--all` skips the repo-only skills (`skill-maintainer`, `skillify`), which operate on the vegastack-skills repository itself and do nothing useful elsewhere. Naming one explicitly still installs it.
  - `list` now groups its output and marks the repo-only skills.
  - The installed layout is unchanged: skills still land flat at `<surface>/<name>/`, so a group never appears in an install path.
  - The root README is rewritten around getting started, and `skill-maintainer` and `skillify` move into a `repo-tooling` group.

## 0.13.0

### Minor Changes

- 995571f: Authored skills may now be grouped one level deep under `skills/<group>/`, and the ten dev-workflow skills have moved into a `dev-skills` group.

  - Installed layout and install commands are unchanged: the packaged bundle stays flat, keyed by bare skill name, so `npx @vegastack/skills add dev-plan` is exactly what it was and existing installations are untouched.
  - `skillify`'s scaffolder gains `--group <name>`, which places a new skill in an existing group and writes its README row into that group's section. An unknown group is refused rather than created.
  - `skill-maintainer` gains the group rules and a create-or-maintain-a-group workflow, backed by a new repo-side structure check that blocks on illegal depth, name collisions, a malformed `GROUP.md`, missing skill meta files, packaging entries that disagree with the authored tree, and README rows that are absent, mispathed, or in the wrong section.
  - Ungrouped skills at `skills/<name>/` remain fully supported; `skill-maintainer` and `skillify` deliberately stay ungrouped.

### Patch Changes

- 05285a5: Every dev-family skill now cites `references/conventions.md` from its own SKILL.md, in one shape, and the register-line format is stated in one place instead of three.

  - dev-architect, dev-ship, dev-chronicle, and dev-debug shipped the packaged copy with no pointer to it from the agent entry point.
  - dev-architect, dev-ship, and dev-setup each spelled out their own variant of the register line; all three now point at conventions' Operator identity section.
  - dev-plan restated the approval marker and operator-identity format for an artifact it does not own, and told the reader to find the file "wherever dev-setup is installed" — wrong on a standalone install, which ships its own copy.
  - All ten citations now name the path the copy actually occupies, so they resolve on a single-skill install.

## 0.12.1

### Patch Changes

- 963b3d9: The release runbook's claim about the post-version install is corrected: it carries dependency changes into the lockfile, it does not update the workspace's own recorded version there.

  - dev-setup's npm playbook drafts the corrected step into every bootstrapped project.
  - Its version-identity note is package-manager-neutral: npm re-records a version-only bump on the next install, bun does not, so an older recorded version is a behavior to confirm rather than a defect — and never a hand-edit.
  - skill-maintainer's release ops records the observed bun behavior, including that `--frozen-lockfile` passes with the older record.

## 0.12.0

### Minor Changes

- f8dbacd: dev-status stops reporting already-recorded decisions as pending, and the workflow's shipped artifacts render correctly where they are actually read.

  - dev-status: a decision already in the register no longer stays "pending" forever when its gist carries a markdown link.
  - dev-status: `status.mjs` emits `titlePlain` and `gistPlain`, so the terminal board never prints raw link markup.
  - dev-review: the known-patterns template's four entry fields are list items, so a project's file renders one line per field; appended entries inherit the shape.
  - dev-implement: changeset entries carry a stated shape — one plain first sentence, detail as sub-bullets after a blank line.
  - dev-implement: the evidence tail's sha stays bare, with the reason on the record — GitHub auto-links it once the branch is pushed.
  - Docs: one-line rows in both README skills tables; legacy plan headers bulleted.

### Patch Changes

- 21ffb4b: dev-architect's pinned facts adopted to the refreshed baselines, live-verified 29-08-2026.

  - Better Auth 1.7 is stable; the 1.6.x hold is retired.
  - MCP support moved to `@better-auth/mcp`, with its renames.
  - SAML IdP-initiated flows are default-off.
  - `apiKey` corrected to the standalone `@better-auth/api-key` package.
  - `twoFactor`'s discriminated-method break noted, plus four further 1.7.0 breaks.
  - EVE at 0.47.3 — beta, multiple releases daily; pin behavior, not minor versions.

- 6c1db6b: dev-chronicle: the entry format now renders correctly in GitHub file views.

  - Fields are list items — single newlines otherwise soft-wrap into one paragraph.
  - Titles carry a full markdown link to the issue.
  - Bare `#N` references are banned from entries; file views never auto-link them.
  - The footer sits after a blank line as its own paragraph.

## 0.11.2

### Patch Changes

- 60dcd31: Refresh runner: verify-mode drift is now registry-anchored on the 200 path — a warm cache that already stored a drifted checksum can no longer mask registry drift on subsequent verify runs against servers without etag/last-modified support (the 304 path already caught this class). Drift items report `baseline: 'registry'` with a `cacheDisagrees` annotation when the cache also differs; accept mode and the 304 branch are unchanged.

## 0.11.1

### Patch Changes

- 13ed5ea: Refresh runner: an overdue manual-review source whose content is verifiably byte-identical to its reviewed baseline no longer deadlocks every accepting run. Under --accept-baselines, a verified-unchanged checksum (fresh hash, or a 304 against the cached etag) refreshes the review clock — scoped to manual-review sources only, so ordinary sources don't churn timestamp diffs into every weekly PR. Real content changes keep today's behavior exactly; read-only verification runs still write nothing to the registry and fail closed.

## 0.11.0

### Minor Changes

- 52ea6cd: New dev-chronicle skill: the project's narrative record. One story-language entry per behavior-changing branch in `.vegastack/chronicle.md` (outcome-named title, what/why/how-it-went/changed/decisions, operator-attributed, append-only newest-first), written by dev-implement at hand-back and presence-checked by ship-gate under the `chronicle: on` knob. "Catch me up on this project" renders the digest — story so far, recent chapters, open threads — from the chronicle and decision register only.
- 18e6d7f: New dev-debug skill: reproduce-first bug discipline in six phases with checkable completion criteria — the red-capable command gate (no red command, no theorizing; can't build one → handback trading tried ladder rungs for artifacts), shrink-to-load-bearing minimisation, 3–5 ranked falsifiable suspects posted to the ledger and proceeded on without pausing, one-variable-at-a-time probes tagged [DEBUG-<4hex>] (ship-gate blocks survivors), regression-test-before-fix at a correct seam with the missing-seam case recorded as a finding, and a cleanup phase that names the winning suspect in evidence and commit. Ships the eight-rung loop ladder reference.
- 09c698b: New dev-plan skill: the planning stage between intake and implementation. Full-plan issues get a fresh-grounded session — approaches/system-design/risk questionnaire with recommended answers, brief challenge, strict plan format (exact files, Interfaces blocks, failing-test-first steps, banned placeholders) — and the operator approves the plan before any code. Quick-build issues use its inline mode inside the intake conversation so one approval covers brief and plan. The one-way scope ratchet lives here — conventions.md now points at dev-plan as its single home.
- 60af6c8: New dev-review skill: independent review as a specified system. Parallel fresh-context reviewers per axis — spec (diff vs the current brief/plan, with a tests-are-real rubric), standards (project known-patterns + repo docs overriding a fixed 12-smell baseline), security (data-flow-traced, on risky work or security surfaces) — reported separately, never merged. One review comment per cycle with verdict, `Finding [N]` ids, CRITICAL/MUST-FIX/SHOULD-FIX/NIT severities, collapsed nitpicks, and a reviewed-SHA stamp. Bounded fix loop (3 rounds, scoped re-reviews, fresh implementer on round 3) ending in open adjudication; never-pre-judge rule; hard noise filters via a per-project review-known-patterns file whose entries require "Still flag if:" clauses; announced Codex↔Claude cross-agent mode with a defined REVIEW REQUEST handoff. dev-implement's review step now invokes this skill.
- 953c286: New dev-status skill: the operator's board. A deterministic, read-only script gathers open issues per state label (age, scope, risky), task progress from plan-comment checkboxes, ledger staleness for working issues, open PRs with check state, unrecorded decision proposals, and the last chronicle chapter; the skill renders the needs-you-first report with names-never-numbers and a single Next action. Cannot-verify states are reported, never guessed.
- a8c31f7: Workflow conventions v3: new `dev-setup/references/conventions.md` is the single spec for comment metadata markers (`<!-- vsk:v1 type=... -->`), operator identity (`operator (<username>)`), revision markers, scope classes (research / quick-build / full-plan) with the one-way ratchet, the expanded label vocabulary (`needs-plan` + scope + `epic`), title prefixes and native issue types, the ledger format with its resume protocol, the `.vegastack/.tmp/` workspace, and the verification-gate doctrine (facts block, heuristics warn). dev-setup detects native issue types and the Codex CLI, creates the new labels, and its profile template gains the `chronicle:` knob.
- 08bf66d: dev-implement v3: the ledger comment (created as the claim's first write, checkpointed per task/ruling/fix-round, plan checkboxes ticked in the same pass) with the strict resume protocol (brief → plan → ledger → git log, nothing else); red-before-green TDD at brief-named seams with the tests-are-real rubric applied pre-review; the verification gate function (identify → run fresh → read → claim); the scope ratchet as a named stop condition; chronicle entries branch-carried next to the changeset; the evidence comment gains Docs and surfaced-rulings lines with evidence-check enforced; the corrections loop moves code and docs together (revision markers, evidence sha bump, known-patterns appends); the direct chat path is bounded to trivial.
- 997f906: dev-intake v3: every issue gets an announced scope call (research / quick-build / full-plan, with the objective quick-build test) applied as a label; quick-build issues get brief + inline dev-plan plan in one conversation under a single approval; epics use the map body format (Destination / Decisions so far / Not clear yet / Out of scope) with native sub-issues; bug intake requires reproduction steps and routes fix: issues to dev-debug; seams are settled in the Tests section; approvals are recorded as vsk:v1 marker comments in the operator (username) format; pushback-on-vague with diagrams; brief template carries the marker, scope, and Reproduction section.
- 89a6863: dev-ship v3: Gate 1 leads with ship-gate.mjs (fresh check re-run, docs-match-reality, changelog + chronicle presence, review verdict, [DEBUG- grep — chronicle check new); standing merge instructions gain a staleness bound (behavior-touching rebase or >7 days → one-sentence re-confirm); decision recording uses the operator (username) register format; every ship closes with the retro question (the one dev.md line that would have prevented this issue's gotcha); the runbook maps ship-gate exit codes onto guard-line semantics.
- 38cdc19: Deterministic guard scripts across the workflow (facts block with exit 2, heuristics only warn, unverifiable state fails closed): dev-implement's `preflight.mjs` (approval marker, scope label, plan approval, Assumptions, blockers, assignee, repo match) and `evidence-check.mjs` (evidence-comment shape incl. the Docs line), dev-intake's `brief-lint.mjs` (per-scope required sections, grounded touch-point paths; vague-wording warnings), dev-plan's `plan-lint.mjs` (banned placeholders — its single home — task structure, checkboxes), and dev-ship's `ship-gate.mjs` (fresh check-command re-run, strict evidence-sha equality with head (the corrections loop, which always updates the evidence sha, is the only reconciliation path), changelog presence, review verdict/adjudication, `[DEBUG-` tag grep; rationalization-phrase warnings). All dependency-free Node with `--json`, unit-tested per branch, shipped via the packaging manifest, and wired into their skills' phase boundaries.
- 2f5ea63: v3 hardening from the drill and the epic-final adversarial sweep: ship-gate's adjudication detection no longer accepts routine surfaced rulings (parked/adjudicated phrasing required) and warns when dev.md has no check command; plan-lint blocks failing-test steps without fenced test code and Task lines missing their checkbox; preflight warns on a missing repo: line; brief-lint gains --fix (Reproduction required) and the Scope-line check; guard fail-closed paths are stub-tested and every guard header documents its exit codes; every dev-family install now ships its own copy of conventions.md (packaging supports @source shared entries — authored files stay single-homed); dev-implement routes fix: issues through dev-debug; the cross-agent handoff carries a resolvable conventions path and the agent=codex literal; the resume protocol re-names its exclusions; the plan template fence gains the Revisions slot; dev-ship names the Docs line, forbids patching docs from inside ship, and carries the drill-observed rationalization table ("a PR is just preparation" → the PR is a gate); READMEs list every shipped file; dev-status covers chronicle-parse, empty-board, and CLI fail-closed branches.
- 05e39d0: dev-architect: (inferred) directives gain a ratification mechanism — first-use confirmation proposes an operator register line and recording it drops the tag in the same change; the red-lines heading no longer hand-maintains a count. skillify's eval playbook gains the family-level trigger re-run rule (full installed set on any family change, ambiguous_with cases first) and the workflow-skill note (multi-turn gh-stateful skills get end-to-end proof from a sandbox drill; single-prompt evals cover prose and format).

### Patch Changes

- dd72d80: Description hygiene across the dev family: every SKILL.md description now carries triggers and boundaries only — process/content summaries stripped from dev-setup, dev-ship, and dev-architect, with dev-setup's lost trigger nouns (labels, changelog convention, release guards, architecture profile) restored as Use-when phrases. The family-level trigger eval ran across all twelve skills (149 queries): one fixture contradiction found (dev-status and dev-chronicle both claiming the same must-win query) and resolved. CONTRIBUTING, the AGENTS.md template, and the README rows share one family order.

## 0.10.0

### Minor Changes

- d829d2f: The `architect` skill is now `dev-architect`, the fifth member of the dev-skills family, rebuilt around one-rule-one-home references and a verify-before-you-recommend protocol (platform capability/version claims are checked against pinned facts, then live docs, before shaping a recommendation). The per-project `.vegastack/arch.md` profile is retired: architecture facts live in a `## Architecture` section of `.vegastack/dev.md` (written by dev-setup, which also migrates legacy arch.md files), and ADRs are retired in favor of the `.vegastack/decisions.md` register. dev-intake, dev-implement, and dev-setup now cross-reference dev-architect explicitly; `doctor` checks `.vegastack/dev.md` instead of arch.md. Migration: copies installed under the old `architect` name are orphaned — reinstall with `npx @vegastack/skills add dev-architect`; installer operations addressed to `architect` no longer resolve. Renaming a skill now ships minor by default (major is the operator's explicit call); removing a skill stays major.

## 0.9.1

### Patch Changes

- 0c92956: Restore a pinned `0.0.0` placeholder version on the workspace root: `npm sbom` purl generation requires every package to carry a version, so the 0.9.0 release pipeline failed at the SBOM step (after a successful npm publish — 0.9.0 has no GitHub release/SBOM as a result). The stack playbook's npm guidance now says to pin `0.0.0` instead of deleting the field. No package content changes.

## 0.9.0

### Minor Changes

- 022d1bf: Dev workflow v2 — ground-up overhaul of the dev skill family for any stack, greenfield included.

  - `.vegastack/dev.md` becomes each project's **single canonical process doc**: release runbook, changelog convention, versioning policy, and rollback fold in as `## Ship` bullets — no separate policy docs. New `authority:` line, `labels:` and `changelog:` knobs, `gates: 1` (direct-to-main for single-operator projects), and a `## Decisions` section carrying the qualification test. The decision register default moves to `.vegastack/decisions.md` with the format `- DD-MM-YYYY (github-username) — decision`; every entry needs the user's explicit yes.
  - **dev-setup**: new `references/stack-playbooks.md` maps detection signals to stack-native drafts (npm/changesets, Node app, Flutter, Python, Go, generic) — Ship runbook, changelog convention, version identity, guards, rollback line each. Greenfield repos are a supported path (intended-stack interview, git init / gh repo create on yes) instead of a hard stop. Round C can scaffold release-guard CI steps, the shared cross-project evidence repo (`<owner>/dev-review-evidence`, contents-API uploads, no clones), and an optional decision-capture Stop hook for both Claude Code and Codex (recipe + sourced hook facts in harness-facts.md).
  - **dev-implement**: changelog entry is a first-class step before hand-back (changesets written non-interactively as `.changeset/<slug>.md`); evidence comment gains `**Changelog:**` and `**Decision:**` lines; branch pattern reads solely from dev.md.
  - **dev-ship**: new `references/runbook.md` — `auto:`/`ask:`/`guard:` semantics (guards run locally, CI is the backstop), release batching, direct-to-main mechanics, bot PRs (merging one is shipping: green checks qualify, only the operator's word merges), roll-forward rollback. Gate 1 verifies the changelog entry; Gate 2 names pending decisions in the merge confirmation before recording them.
  - **AGENTS.md section**: hard consent rule — nothing ships without the operator's explicit instruction; the gates knob changes coverage, never the need for a word — plus portable ad-hoc decision capture on both harnesses.
  - **dev-intake**: brief template gains docs/changelog surfaces and a Version impact line; `Decision:` comments are gated by the dev.md test.

  This repo dogfoods the result: `docs/policies/` is folded into `.vegastack/dev.md` and deleted, the register moved to `.vegastack/decisions.md`, and the release workflow now leads its GitHub release notes with the changelog entry and fails if the entry is missing.

## 0.8.0

### Minor Changes

- 4656b81: dev.md becomes the project's self-maintained handbook: new Ship (post-merge runbook with auto/ask steps), Verify, Environments, and Design sections plus a release knob (per-merge | on-request); dev-setup detects release/deploy machinery and drafts them; dev-ship follows the Ship runbook after merge and stops at ask-lines and failures; dev-implement follows the Verify runbook for live evidence. The retro-fold rule lands in the shared AGENTS.md section: gotchas become one proposed dev.md line, folded into existing sections, never a log. Labels renamed for role clarity: needs-you → needs-operator, for-you → for-operator (re-run dev-setup to create them; old labels remain on historical issues). This repo now dogfoods the workflow with its own dev.md whose Ship runbook is the changesets release flow.

## 0.7.0

### Minor Changes

- 899bb5b: Add the dev-implement skill: implements an approved issue end to end without user input — fail-closed preflight (label plus recorded approval), claim by assignee and working label, dark execution bounded by the brief and the dev.md stop-list, tests, independent review, one in-place evidence comment, hand-back with for-you. Direct user requests in chat bypass the issue machinery on the user's own authority.
- 899bb5b: Add the dev-intake skill: turns brainstorms, feature requests, and SOWs into agent-ready GitHub issues — grilling-style rounds with recommended answers, vertical-slice briefs from a template, native dependencies/milestones, and quoted-approval recording that flips needs-you to ready.
- 899bb5b: Add the dev-setup skill: re-runnable project bootstrap for the issue-driven dev workflow — detect-first interview, `.vegastack/dev.md` profile with knobs, marked AGENTS.md section plus CLAUDE.md import, the five workflow labels, and the decision register; degrades to documented defaults marked TODO when no question tool is available.
- 899bb5b: Add the dev-ship skill: the last two gates, each spent only by the user's words — PR creation linked to the issue's evidence, then a separate merge instruction that re-verifies the reviewed head, squash-merges, and appends recorded decisions to the register.
- 3b989bb: skillify v2 — lean contract. The checklist shrinks from 13 to 8 items with stable additive numbering: unit tests are now required only for bundled scripts' deterministic branches (a prose-only skill's quality bar is the behavioral eval), the per-skill consistency test becomes a repo-wide relative-link check inside validate-skill.mjs, and the claim-classification taxonomy collapses to one volatile-facts rule with a one-line evergreen waiver default. New: a "sharp boundary" item requiring each skill to name its nearest-neighbor skill and the axis of difference; trigger-query fixtures become ~10 hard queries with `ambiguous_with`; authoring.md gains writing-style doctrine (prompt the positive, hunt no-ops and sediment, 50–150-line body budget). The scaffolder now performs repo wiring itself — packaging entry (moved from sync-skill.mjs code into packaging.json data), root README row, and changeset — idempotently, degrading to explicit skipped statuses outside the monorepo.

## 0.6.0

### Minor Changes

- 3beee21: Replace arch-guardian with architect — a from-scratch rebuild of the VegaStack architecture skill.

  The retired arch-guardian (106 rules, 18 reference files, profile/schema/refresh tooling, its own test corpus) is deleted. The new `architect` skill encodes the same intent — consistent, MK-grade architecture decisions from any team member's agent — as a lean advisory skill: an evidence-distilled decision-table stack reference, dated source-verified platform facts, lean-first principles with their reasoning, domain taste references (web, data, infra, AI/agents, security, mobile), and a per-project `.vegastack/arch.md` profile created by a first-run Q&A where the repository always wins over the stored file.

  Breaking for existing installs: `npx @vegastack/skills add architect` (the old skill name is gone; remove old arch-guardian installs manually or with `remove`). `doctor` now checks for `.vegastack/arch.md` instead of `architecture.json`. The repo-shared refresh runner moved from the skill to `tooling/refresh/`.

## 0.5.0

### Minor Changes

- 3a6c2da: skills.sh-style install UX: auto-detect installed agents (~/.claude, ~/.codex or ~/.agents, ~/.hermes) and target them without prompting; a simple numbered picker appears only when nothing is detected. The confusing "codex, claude, hermes, both, all" free-text question and the project/global question are gone — installs are project-local by default, `--global` and `--agent` still override.

## 0.4.0

### Minor Changes

- a0fa476: Housekeeping: standardize on Node 24 and current GitHub Actions

  - `engines.node` raised from `>=20.11` to `>=24` (Node 20 is EOL; Node 24 is LTS and what CI/release run on)
  - CI matrix collapsed to Node 24; deprecated actions bumped: `actions/checkout` v4→v7, `actions/setup-node` v4→v7, `softprops/action-gh-release` v2→v3

## 0.3.0

### Minor Changes

- 868f939: arch-guardian v2: advisory-only redesign (breaking content change under 0.x)

  - **Profile schema v4** (foundation 0.4.0): slim ~12-line profile — name, kind, **tier** (`prototype`/`production`/`enterprise`), tenancy, hosting, enabled capability list, notes. Versions come from lockfiles; exceptions removed. `profile-tool.mjs migrate` converts v3 profiles (exceptions become notes).
  - **Checker removed**: `architecture-check.mjs`, `control-catalog.json`, and the PASS/FAIL/EXCEPTED outcome and exception machinery are deleted. Reviews now follow the evidence-backed advisory report contract (`references/advisory-report.md`) with severities `critical`/`production-gate`/`enterprise-gate`/`consider`, per-area grades, and a stable JSON block for downstream automation.
  - **Tiers gate concerns, never tools**: rules carry tier floors; tool choices (OpenBao, pg-boss, EVE, Valkey) become defaults with named escalation triggers under the new minimum-viable-architecture principle. Rule `FOUND-002` retired (never reused).
  - **Freshness upgrades**: OSV.dev advisory watch for every pinned package (fail-closed on critical sources), `reviewBy` overdue warnings for foundation baselines, verified `llms.txt` URLs in the source registry, and proportionate freshness (full check only for design reviews leaning on critical pins).
  - CLI `doctor` validates v4 profiles and runs profile validation instead of the deleted checker.

## 0.2.0

### Minor Changes

- Rename vegastack-arch-guardian to arch-guardian (clean break); generalize the installer to N bundled skills with schemaVersion-2 integrity manifest and journal; add skill-maintainer and skillify skills; add Hermes install surface (~/.hermes/skills, global-only) and a list command; enforce the full cross-harness skill name grammar and six-field frontmatter ceiling.

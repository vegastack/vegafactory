# @vegastack/vegafactory

Installer for VegaStack Agent Skills — a family of self-contained skills for Claude Code, Codex, and Hermes, shipped in one integrity-checked package.

Install the whole dev workflow, once per machine:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

`--global` is the recommended install: the skills land in your home directory and are available in every project you open. Drop it for a project-local install when a repository should carry its own copy.

See what else is bundled:

```sh
npx @vegastack/vegafactory skills list
```

## Skills in this package

### `dev` — the issue-driven dev workflow

Install the family with `add --group dev --global`.

| Skill | What it does |
|---|---|
| `dev-setup` | Bootstraps any project, greenfield included, for the issue-driven dev workflow: stack-playbook-drafted profile, AGENTS.md section, labels, guards, decision register |
| `dev-intake` | Turns ideas, brainstorms, and SOWs into agent-ready GitHub issues with recorded user approval |
| `dev-plan` | Plans an approved issue before any code exists: fresh-grounded questionnaire, strict plan format with Interfaces blocks, the scope ratchet, quick-build inline mode |
| `dev-architect` | Architecture advisor: the locked stack, recorded rejections, and dated platform facts behind a verify-before-you-recommend protocol |
| `dev-implement` | Implements an approved issue end to end, dark: preflight, claim, build, test, review, evidence in the issue |
| `dev-debug` | Reproduce-first bug diagnosis: red command, ranked suspects, regression-test-before-fix |
| `dev-review` | Independent multi-axis review of finished work: spec/standards/security axes, bounded fix loop, cross-agent Codex mode |
| `dev-ship` | Opens the PR, merges, and runs the project's Ship runbook, each only on the user's explicit word |
| `dev-status` | The operator's board: whose move is it, from deterministic gh data |
| `dev-chronicle` | The project's narrative record: story entries per branch and the "catch me up" digest |

### `skills-tooling` — tools that work on skills themselves

Install the group with `add --group skills-tooling --global`.

| Skill | What it does |
|---|---|
| `skill-scan` | Scans agent skills with NVIDIA SkillSpector and holds the suppression baseline: the Verify-gate guard, and the answer to "is this downloaded skill safe to install" |

### `repo-tooling` — repo-only

These operate on the vegafactory repository itself and do nothing useful in another project, so **`--all` skips them**. Install one by name if you are contributing to that repo.

| Skill | What it does |
|---|---|
| `skill-maintainer` | Encodes the Agent Skills standards (Claude Code, Codex, Hermes, agentskills.io) for creating, updating, and releasing skills in a skills repo |
| `skillify` | Turns a feature or workflow into a complete skill conforming to the VegaStack skills contract, or audits an existing one |

## Commands

| Command | What it does |
|---|---|
| `list` | Show the bundled skills |
| `add <selection>` | Install (or upgrade) skills into the selected agent directories |
| `verify [selection]` | Check installed copies against the bundled checksum manifest (all bundled skills when nothing is selected) |
| `doctor` | Diagnose an install: integrity across all skills, dev profile (`.vegastack/dev.md`) presence, installed-vs-latest version |
| `remove <selection>` | Uninstall skills from the selected agent directories |
| `sync` | Refresh this machine's shallow control-room clone from the repo's `control-room:` knob |
| `dispatch` | Turn labels and 🚀 reactions on the watched repos into headless runs in feature worktrees |
| `service <install\|uninstall\|status>` | Install that dispatcher as a launchd LaunchAgent (macOS) or a systemd user unit (Linux) |
| `status` | The board, the worktrees, the last tick, the runs in flight, and the dispatcher's own health |
| `stats` | Where agent time and money went — record, push, roll up, and print the org's own numbers |
| `dashboard` | Start the local read-only dashboard over the control room's statistics and the live board |
| `guard sync [--check]` | Compile `.vegastack/dev.md`'s guard policy into `~/.vegastack/guard/<owner>__<repo>.json`, the one file the ship guard reads; `--check` exits 2 when it is stale |

### Selecting what to act on

`add`, `verify`, and `remove` each take **exactly one** selector. Combining two is an error, not a merge.

| Selector | Means |
|---|---|
| `<skill>` | That one skill. Works for every bundled skill, repo-only ones included |
| `--group <group>` | Every skill in that group |
| `--all` | Every bundled skill **except** the repo-only ones |

A `--group` or `--all` install is **one transaction**: every skill is checked and staged before any of them is committed, so if one fails, none are installed and the destination is left exactly as it was.

The ten dev-workflow skills:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

Everything worth installing outside this repo:

```sh
npx @vegastack/vegafactory skills add --all --global
```

Check the family against the manifest:

```sh
npx @vegastack/vegafactory skills verify --group dev --global
```

Uninstall it again:

```sh
npx @vegastack/vegafactory skills remove --group dev --global
```

### The dispatcher

`vegafactory dispatch` polls the repos this machine watches and starts headless runs in their feature worktrees: `needs-plan` → dev-plan, unassigned `ready` → dev-implement, and a 🚀 reaction from a listed operator on any comment of a `for-operator` issue → the corrections run. It runs as **you** — your `gh` token, your harness authentication, your machine — which is why installing it is the operator's own step and never an agent's.

Which repos, how often, and how many at a time is machine-local, in `~/.vegastack/factory.json` (the same file the control-room clone state lives in; keys it does not recognise are left untouched):

```json
{
  "repos": [{ "path": "~/code/app", "repo": "acme/app", "org": "acme" }],
  "interval": 120,
  "maxRuns": 1,
  "subagents": { "spawnDepth": 1, "concurrent": 3 }
}
```

Whether a repo may be dispatched at all is **not** machine-local — it is the repo's own `.vegastack/dev.md`:

```
dispatch: local             # off | local
```

Three refusals stand between a board and a dark build, and each one names itself in the output:

- `dispatch: off`, no `dispatch:` line, or any other value — opting in is explicit, and the default is off.
- The ship guard is not wired for the harness that would run: the guard script at `.vegastack/hooks/ship-guard.mjs`, the harness's hook config (`.claude/settings.json` or `.codex/hooks.json`) **and** the compiled policy at `~/.vegastack/guard/<owner>__<repo>.json` (written by `vegafactory guard sync`) must all be there — for each harness the tick would launch (a `plan` stage on Codex is checked against `.codex/hooks.json` even when `implement` runs on Claude), and again in the worktree the run starts in, because a harness reads its hooks from the directory it is started in and a fresh checkout carries tracked files only. A gitignored `.claude/settings.json` reaches the worktree through dev.md's `worktree-include:` knob. Dark builds run under bypassed permissions; the guard is what asks before a merge, tag, publish, deploy or force push. It is not a sandbox: it runs as you, so branch protection and a read-only token remain the walls, and it closes the path where a run edits its own worktree's dev.md into permission — the policy lives outside every worktree and touching it is itself an ask.
- Another run holds the repo's lock, the issue is assigned, or `maxRuns` is already committed.

Read the plan before anything ever runs — this is the default, and both `--once` and `--watch` are opt-ins:

```sh
vegafactory dispatch --once --dry-run --json    # exactly what would launch, and launch nothing
vegafactory dispatch --once                     # one tick, for real
vegafactory dispatch --watch                    # the loop the service runs
vegafactory status --json                       # what happened
```

Every run's stdout and stderr land in `~/.vegastack/factory/logs/<org>/<repo>/<issue>-<timestamp>.jsonl`. A run that fails or times out posts a hand-back comment carrying the last 40 log lines with token shapes redacted, moves the issue to `needs-operator` assigned to its operator, and leaves the worktree exactly as the run left it.

### Running it as a service

```sh
vegafactory service install                     # dry run: prints the unit file and the commands
vegafactory service install --write             # writes it and loads it
vegafactory service status
vegafactory service uninstall --write
```

macOS gets `~/Library/LaunchAgents/com.vegastack.factory.plist` with `RunAtLoad` and `KeepAlive`, bootstrapped into your GUI domain; Linux gets `~/.config/systemd/user/vegafactory.service` with `Restart=always`, `loginctl enable-linger` first so it survives logout. Both are user-level: nothing here needs or asks for root.

## Upgrading and health checks

Upgrade to the latest release. `--force` is required because `add` refuses to overwrite an installed copy that differs from the bundle rather than silently discarding local edits:

```sh
npx @vegastack/vegafactory@latest skills add --group dev --global --force
```

Diagnose an install — integrity across all skills, plus installed-vs-latest version:

```sh
npx @vegastack/vegafactory skills doctor --global
```

Run `doctor` without `--global` from inside a project to additionally check that project's `.vegastack/dev.md` profile; the global run skips that check, since the profile is per-project by design.

## Control-room sync

An organisation can keep its shared defaults — org policy, per-group knobs, people, decisions — in a **control room** repository. Every machine reads a shallow clone of it rather than the network, so a GitHub outage degrades to "last synced <time>" instead of failing.

```sh
vegafactory sync            # refresh if the last fetch is older than sync-max-age
vegafactory sync --force    # refresh regardless
vegafactory sync --json     # the machine-readable report (what hooks and the dispatcher read)
vegafactory sync --dry-run  # print the plan, write nothing
vegafactory sync --org acme # bootstrap: a repo whose profile has no control-room: knob yet
```

- The project's `.vegastack/dev.md` names the control room: `control-room: <org>/<repo>#<group>@<sha7>`, where the trailing sha is the clone commit the profile was drafted from. `control-room: none`, or no line at all, means the skill defaults apply and `sync` exits 0 doing nothing — unless `--org <org>` is passed, the bootstrap path dev-setup uses before the profile exists: the room is then `<org>/vegafactory-control-room` by convention, and an `--org` that disagrees with an existing knob is refused (exit 2).
- The clone lives at `~/.vegastack/control-room/<org>/` — one per org.
- The machine-local state document `~/.vegastack/factory.json` records, per org, the clone `path`, its `remote` and `branch`, and the timestamp of the **last successful fetch**. Freshness is measured from that timestamp, never from the directory's mtime. Editing `path`, `remote` or `branch` there points a repo at a different control room; nothing in the repository has to change — every refresh re-points the clone's `origin` at the configured `remote` and resets to what it fetched from the configured `branch`, so an edit takes effect on the next refresh (or `--force`) rather than only on a fresh clone.
- `sync-max-age: 30m` in `.vegastack/dev.md` (`<n>m` or `<n>h`) is how stale the clone may be before a session refreshes it. The SessionStart hook runs `sync` in the background past that age.
- Authentication is your existing `gh` credential over HTTPS, injected per invocation — no token reaches argv, the remote URL, or the clone's config, and no second credential is set up.
- `sync` never commits and never pushes: the clone is read-only to this verb.

Exit codes: **0** synced, already fresh, or the repo names no control room · **1** the fetch failed and the existing clone stands (the report says when it last synced) · **2** a refusal.

Two refusals are deliberate and fail closed:

- a clone with local modifications is never reset — `sync` refuses and names the path, because nobody should hand-edit the clone;
- a symlink on the clone path or its parent is refused before any git call.

An unreadable `~/.vegastack/factory.json` is also a refusal, never a silent reset: resetting it would drop every other org's clone record.

### Effective policy and migration

Runtime, stats and the standalone dev-setup compiler share `effective-policy.mjs`. Ordinary explicit values resolve org → group → repo, including individual harness stages. A repo alone opts into `dispatch: local`. Org locks and exact group/repo/value delegations live in one `vsk-policy` schema2 block in org.md; a group's legacy `stats-override: allowed` cannot unlock the organization. A refused override retains its effective value for diagnostics but stops capture/export and new launches.

`policy-schema: 2` opts into the documented typed contract. Legacy version1 ordinary knobs remain readable and are never silently rewritten. Use `vegafactory guard sync --dry-run --json` to inspect the proposed compiled values, source revisions and digest, then `--check` to compare the installed copy. Show original/effective/proposed policy differences and preserve originals before an explicit migration; obtain approval for an actual authority change. Unknown schemas, duplicate known keys and invalid values refuse without overwriting the existing copy. Unknown extension fields remain inert.

Configured rooms require `factory.json`'s `controlRooms[org].snapshots[canonicalCodeRepo]` binding. Each snapshot carries schemaVersion2, org, group, repository (the room), origin, full sourceCommit, policyDigest, validatedAt and contentPath. The digest is recomputed for that exact code repo's current profile and selected group, using canonical relative source paths; one org digest cannot stand for multiple code repos. The reader checks origin, commit, clean managed content and regular Git blobs. Missing bindings, changed local profile, wrong group/origin or expired validation refuse. Snapshot creation and atomic refresh are the sync transaction's responsibility; a legacy lastSyncedAt is not validation. Freshness never creates a cumulative task deadline.

Organization admins and explicitly delegated group admins are configured separately from descriptive people.csv roles and the task operators list. Only org admins appoint/remove admins. CLI people queries verify the requester through GitHub and filter exact allowed repository records before totals; chat/URL/display-role claims do not grant authority. The dashboard's canonical adapters fail closed until a caller supplies validated scope. Control-room Git readers can still read committed reports; application permissions do not make shared Git files group-confidential.

Registered-machine policy includes stable machine/installation identity, host binding, execution login, exact repositories and disabled initial enrollment. Org defaults → group defaults → machine overrides govern polling, capacity, checkpoint and verified-transfer recovery modes. Group edits require previous org delegation; bootstrap paths cannot enable or enlarge registration. No-fleet installations retain explicit legacy operation; shared machines require validated registration and shared ownership rather than local-lock fallback. Runtime activation, private house-policy migration and state-branch creation remain separate setup steps.

### Statistics

One JSONL record per headless run and per interactive session, spooled to a machine-local outbox and pushed into the org's control room at `stats/<owner>__<name>/<MON-YYYY>/<hostname>.jsonl`. One file per repo, per month, per machine, so two machines never conflict — a concurrent push is a non-fast-forward, which `pull --rebase` and a retry settles without a human.

```sh
vegafactory stats                       # this repo, this month
vegafactory stats --org --since SEP-2026
vegafactory stats --me                  # your own rows
vegafactory stats skills                # invocations per skill, by trigger and harness
vegafactory stats push                  # dry run: prints the plan and the commit it would make
vegafactory stats push --commit         # copies the outbox in, commits, pushes, rebases on rejection
vegafactory stats rollup --since SEP-2026   # regenerate the summaries; reads each touched issue's timeline through gh
vegafactory stats record --source <kind>    # called by the capture hooks, reads the payload on stdin
```

**A record is counts and identifiers only.** When the run happened, which repo, issue and stage, which harness, model and effort, how long it took, turns, tool calls, the four token counters, cost, how it ended, rework rounds — read after a headless run from the issue's own review, ledger and hand-back comments, by marker — and which skills it used. Never prompt text, assistant text, tool arguments, or file contents — the harness transcripts are read for usage totals and tool-call counts and nothing else. A field the capture could not fill is `null`, never a guess and never a zero.

**Whether anything is recorded is org/group/repo policy, never a machine bypass.** Ordinary `stats` and `stats-people` values inherit; explicit org locks require exact delegation. `stats-export: attributed` requires org authorization. Refusals stop capture and export. Per-person reads use verified own-data identity or explicit scoped administration; a descriptive `lead` role does not supply that grant. Committed summaries carry no per-person block, and the shared Git audience remains explicit.

`push` is a dry run until `--commit`, because it writes to a repository other people read.

The CLI verifies its requester through the GitHub API. `rollup` also reads issue history: lead and cycle time come from each touched issue's label timeline, fetched through `gh` and written beside the summary as `<MON-YYYY>.timeline.json`. When `gh` cannot answer, the summaries are still regenerated from the timeline file the clone already holds, the reason is printed, and the exit code is 1.

## Dashboard

`vegafactory dashboard` starts a local, read-only web view of the factory and prints its URL.

```bash
vegafactory dashboard              # fetch on first use, then serve on 127.0.0.1:7777
vegafactory dashboard --open       # …and open it in the browser
vegafactory dashboard --dry-run    # print what a real run would do, change nothing
```

| Flag | Means |
|---|---|
| `--port N` | First port to try; the next nine are tried in turn |
| `--open` | Open the URL in the browser once the server answers |
| `--dir PATH` | Launch an already-built package tree instead of the fetched one |
| `--dry-run` | Print the plan and change nothing |
| `--json` | Machine-readable result: `{command, ok, url, dir, entry, fetched, pid}` |

Exit **0** the server answered, or the dry-run plan printed · **1** the server exited or never
answered on its health route · **2** a usage error or a refusal (a symlink on the install path, no
control room recorded for this machine, `gh` unavailable).

The app is a second published package, `@vegastack/vegafactory-dashboard`, fetched at this CLI's own
version on first use into `~/.vegastack/dashboard/<version>/` — the core install stays small. The
derived index lives at `~/.vegastack/cache/stats.db`; it holds nothing the control room does not, so
**deleting it is always safe** and the next start rebuilds it.

The server binds `127.0.0.1` only, and your `gh` token is passed to that process and never leaves
it: the browser receives projected view models, not credentials.

Six views — org, repo, people, skills, board, dispatcher — read the control-room clone; the board and
dispatcher views also read live GitHub and `vegafactory status --json`. When the live half is
unreachable the page still renders from the clone, behind a banner naming what failed and how stale
the clone is.

## Flags

| Flag | Meaning |
|---|---|
| `--project` / `--global` | Install into the current project (default) or the user's home directory |
| `--group NAME` | Select every skill in a group (see `list` for the groups) |
| `--all` | Select every bundled skill except the repo-only ones |
| `--agent codex\|claude\|hermes\|both\|all` | Target agent runtime(s); `both` = codex+claude |
| `--dir PATH` | Operate on a different project directory; not valid with `--global` |
| `--dry-run` | Show what would change without writing |
| `--force` | Overwrite a modified installed copy; for `sync`, refresh regardless of `sync-max-age` |
| `--json` | Machine-readable output (`sync`) |
| `--non-interactive` | Skip prompts and use defaults: `--agent both`, project-local (for automation) |
| `--version` / `-v` | Print the installer version |
| `--help` / `-h` | Print usage |

`--all` and `--agent all` are different axes and are easy to confuse: `--all` chooses **which skills**, `--agent all` chooses **which agent runtimes**. `add --all --agent all --global` is valid and means every installable skill, on every runtime, in your home directory.

Agent targeting is automatic: the CLI detects which agents you have (`~/.claude`, `~/.codex`/`~/.agents`, `~/.hermes`) and targets them without asking — `--agent` overrides. A numbered picker appears only when nothing is detected.

## Agent surfaces

`--global` is the recommended install and the only one that can cover all three runtimes at once. `--project` is the flag default, so pass `--global` explicitly.

| Agent | Global install (recommended) | Project install |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |
| Hermes | `~/.hermes/skills/` | — (Hermes discovers skills globally only) |

`--agent hermes` therefore requires `--global`; `--agent all` on a project install covers codex+claude and prints a notice about hermes.

Prefer a project install when a repository should carry its own copy — so collaborators get the same skills from a checkout, or so one project can pin a version while the rest of the machine moves on. Pick one or the other per skill rather than both: in Claude Code a personal (global) skill takes precedence over a project one, so a project-local copy would not override a global install of the same skill.

## Integrity model

The package ships a checksum manifest that is verified at install and by `verify` — it proves the installed bytes match what was packed, not who published it. Publisher identity is attested separately by npm provenance, generated by the trusted-publishing release pipeline. Verify it with `npm audit signatures` or on the package's npm page.

## Network and telemetry

Zero telemetry, in the sense that matters: **nothing is ever sent to VegaStack or to any third party.**

The tool makes three kinds of network call, all to somewhere you already own:

- `doctor`'s single version check against registry.npmjs.org;
- `sync`'s shallow git fetch of the control room named by the project's `control-room:` knob;
- `stats push`'s git push of your statistics records into that same control room, and `stats rollup`'s reads of the touched issues' timelines from the GitHub API;
- `dashboard`'s first-use fetch of `@vegastack/vegafactory-dashboard` from registry.npmjs.org, and that server's own reads of the GitHub API for the live board.

All of them but the two registry calls use your existing `gh` credential, and the control-room calls reach only your organization's own repository. `add`, `verify`, and `remove` are fully offline. Statistics are recorded only while the org's `stats:` policy says so, and a record carries counts and identifiers only — never transcript text (see [Statistics](#statistics)).

## Requirements

- Node >= 24
- macOS or Linux. Windows is not yet supported (path handling; tracked in the repo issues).

## Docs

Skill content, freshness model, and policies: [github.com/vegastack/vegafactory](https://github.com/vegastack/vegafactory)

MIT license.

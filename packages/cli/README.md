# @vegastack/vegafactory

The VegaFactory command-line tool installs and verifies the VegaStack Agent Skills for Claude Code and Codex, and runs the local pieces of the dev workflow: machine setup, the agent-side issue cache, per-issue worktrees, headless agent runs, the control-room sync and the ship guard.

Set up a machine, once:

```sh
npx @vegastack/vegafactory@latest init
```

`init` checks Node, git, the GitHub CLI login, Claude Code or Codex, and Bun when the project uses it; installs the CLI and every skill globally; and turns on the repository's commit hook.

See everything bundled:

```sh
npx @vegastack/vegafactory skills list
```

## Commands

| Command | What it does |
|---|---|
| `init [--org ORG]` | Set up this machine and repository; exits 1 when a step fails |
| `skills list` | Show the bundled skills, by group |
| `skills update [selection]` | Bring installed skills up to date; keeps locally edited copies unless `--force` |
| `skills add <selection>` | Install skills into the agent directories |
| `skills verify [selection]` | Check installed copies against the bundled checksum manifest |
| `skills remove <selection>` | Uninstall skills; refuses a locally edited copy unless `--force`; asks first, or needs `--yes` |
| `skills doctor` | Check the install, the project's `.vegastack/dev.md` and the latest version |
| `worktree <list\|status\|create\|restore\|remove\|prune>` | One git worktree per issue under `.vegastack/.worktrees/` |
| `issue <verb> <n>` | Read and write an issue through the local cache — `sync`, `check`, `comment`, `edit-comment`, `body`, `label`, `ack`, `drop` (`vegafactory issue --help`) |
| `agent claude\|codex <args…>` | Start a headless run on the subscription; parent-app variables are dropped and API-key billing is refused |
| `sync` | Refresh this machine's copy of the org control room |
| `ship check <n>` | Exit 0 when issue n may merge: a "ship it" after the latest evidence, the branch pushed and clean, its PR green |
| `hook <event> --harness claude\|codex` | The harness hooks: ship guard, claim heartbeat, WIP checkpoint each turn |
| `stats <collect\|push\|show>` | Usage numbers from the Claude Code and Codex session logs on this machine: read new turns, share them with the org, print them |
| `dashboard` | Write one offline HTML page of operators, projects, issues, models, days and stages |

### Selecting skills

`add`, `verify` and `remove` take **exactly one** selector:

| Selector | Means |
|---|---|
| `<skill>` | That one skill, repo-only ones included |
| `--group <group>` | Every skill in that group |
| `--all` | Every bundled skill except the repo-only ones |

A `--group` or `--all` install is one transaction: if any skill fails, none are installed.

### Upgrading

`add` refuses to overwrite a copy that differs from the bundle, so an upgrade passes `--force`:

```sh
npx @vegastack/vegafactory@latest skills add --group dev --global --force
```

## Issue cache

Agents read issues from `.vegastack/.tmp/issues/<owner>__<repo>/<n>/` — `issue.md`, one file per comment, and `state.json` — and write back only through `vegafactory issue`, which sends the change to GitHub and then refreshes the copy. `issue sync <n> --since <cursor>` prints only what changed. Write verbs take `--dry-run`; `edit-comment`, `body` and `label` take `--since` and refuse when someone else changed the issue first.

## Control-room sync

An organisation keeps its shared defaults in a control-room repository. Each machine keeps a copy at `~/.vegastack/control-room/<org>/`, and skills read that copy instead of the network.

```sh
vegafactory sync            # refresh when the copy is older than sync-max-age
vegafactory sync --force    # refresh now
vegafactory sync --org acme # first run in a repo whose dev.md has no control-room: line yet
```

- `.vegastack/dev.md` names the control room: `control-room: <org>/<repo>#<group>@<sha7>`.
- `sync` uses your existing `gh` login, never commits and never pushes.
- Exit codes: **0** synced or already fresh · **1** the fetch failed and the old copy stands · **2** a refusal (a hand-edited copy, a symlinked path, an unreadable `~/.vegastack/factory.json`).

## Usage numbers

Both harnesses write a session log in your home directory. `stats collect` reads the new lines of
each log — from a saved byte offset, so a killed session is counted once, at the next run — and
keeps one record per assistant turn under `~/.vegastack/.tmp/stats/`: time, your `gh` login, the
machine, the repository, the issue, the harness, the exact model id, the skill the turn used, the
tokens, the duration and how the turn ended. Never a prompt, a file, tool arguments or which
subscription paid for the turn. The harness hooks run it in the background at each turn boundary.

```sh
vegafactory stats show --since 7d   # turns, tokens and time by operator, project, model and stage
vegafactory stats push              # append this machine's new turns to the org control room
vegafactory dashboard --open        # one offline HTML page, built from what you have
```

`push` appends to `stats/YYYY/MM/DD/<operator>-<machine>.jsonl` in the control-room clone `sync`
already keeps, then commits and pushes it with your own `gh` login — at most once an hour, and
never with credentials of its own. `show` and `dashboard` read this machine's records plus
everything other machines pushed into that clone; `--local` leaves the shared ones out.

## Flags

| Flag | Meaning |
|---|---|
| `--global` / `--project` | Install into your home directory or the current project |
| `--agent codex\|claude\|both` | Which agents to install for; detected automatically when omitted |
| `--dir PATH` | Act on another project directory; not valid with `--global` |
| `--dry-run` | Show what would change without writing |
| `--force` | Overwrite a modified installed copy; for `sync`, refresh now |
| `--json` | Machine-readable output |
| `--yes` / `--non-interactive` | Confirm without a prompt (for agents and scripts); without a terminal, destructive commands need it |
| `--version` / `--help` | Print the version or usage |

## Where skills are installed

| Agent | Global | Project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |

Install each skill globally or per project, not both: in Claude Code a personal (global) skill takes precedence over a project one.

## Integrity and network

The package ships a checksum manifest, checked at install and by `verify`. `add`, `verify` and `remove` work offline. Network calls: `doctor`'s version check and `init`'s `npm install -g` reach the npm registry; `issue` commands call the GitHub API through your `gh` login (conditional requests, so an unchanged issue costs almost nothing); `sync` fetches your own control room with git, and `stats push` commits usage counts to that same repository with your `gh` login. VegaFactory sends nothing anywhere else.

## Requirements

- Node 24 or newer
- macOS or Linux (Windows is not supported)

Docs, skills and policies: [github.com/vegastack/vegafactory](https://github.com/vegastack/vegafactory) · MIT license.

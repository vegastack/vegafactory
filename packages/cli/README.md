# @vegastack/vegafactory

The VegaFactory command-line tool installs and verifies the VegaStack Agent Skills for Claude Code and Codex, and runs the local pieces of the dev workflow: per-issue worktrees, the control-room sync and the ship guard.

Install the dev workflow, once per machine:

```sh
npx @vegastack/vegafactory@latest skills add --group dev --global
```

See everything bundled:

```sh
npx @vegastack/vegafactory skills list
```

## Commands

| Command | What it does |
|---|---|
| `skills list` | Show the bundled skills, by group |
| `skills add <selection>` | Install skills into the agent directories |
| `skills verify [selection]` | Check installed copies against the bundled checksum manifest |
| `skills remove <selection>` | Uninstall skills; refuses a locally edited copy unless `--force` |
| `skills doctor` | Check the install, the project's `.vegastack/dev.md` and the latest version |
| `worktree <list\|status\|create\|restore\|remove\|prune>` | One git worktree per issue under `.vegastack/.worktrees/` |
| `sync` | Refresh this machine's copy of the org control room |
| `guard sync [--check]` | Compile `.vegastack/dev.md`'s ship rules into `~/.vegastack/guard/<owner>__<repo>.json`, the file the ship guard reads |

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

## Flags

| Flag | Meaning |
|---|---|
| `--global` / `--project` | Install into your home directory or the current project |
| `--agent codex\|claude\|both` | Which agents to install for; detected automatically when omitted |
| `--dir PATH` | Act on another project directory; not valid with `--global` |
| `--dry-run` | Show what would change without writing |
| `--force` | Overwrite a modified installed copy; for `sync`, refresh now |
| `--json` | Machine-readable output |
| `--non-interactive` | Skip prompts (for automation) |
| `--version` / `--help` | Print the version or usage |

## Where skills are installed

| Agent | Global | Project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |

Install each skill globally or per project, not both: in Claude Code a personal (global) skill takes precedence over a project one.

## Integrity and network

The package ships a checksum manifest, checked at install and by `verify`. `add`, `verify` and `remove` work offline. The only network calls are `doctor`'s version check against the npm registry and `sync`'s git fetch of your own control room. VegaFactory sends no telemetry.

## Requirements

- Node 24 or newer
- macOS or Linux (Windows is not supported)

Docs, skills and policies: [github.com/vegastack/vegafactory](https://github.com/vegastack/vegafactory) · MIT license.

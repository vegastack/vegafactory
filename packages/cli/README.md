# @vegastack/vegafactory

The VegaFactory command-line tool installs and verifies the VegaStack Agent Skills for Claude Code and Codex, and runs the local pieces of the dev workflow: machine setup, the agent-side issue cache, per-issue worktrees, cross-tool review, headless agent runs, the control-room sync and the ship guard.

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
| `review <n>` | Cross-tool review: the other tool reads the issue's diff read-only and this command posts the one review comment (`vegafactory review --help`) |
| `agent claude\|codex <args…>` | Start a headless run on the subscription; parent-app variables are dropped and API-key billing is refused |
| `sync` | Refresh this machine's copy of the org control room; `sync profile` prints the resolved profile |
| `ship check <n>` | Exit 0 when issue n may merge: a "ship it" after the latest evidence, the branch pushed and clean, its PR green |
| `ship release <n>` | Tag the merged release on issue n's recorded "ship it" — issue n of the repository this checkout pushes to, so there is no `--repo`. It re-reads the word against the current evidence, checks the version and its changelog entry, then creates and pushes `v<version>`. It never publishes — the tag-triggered workflow does |
| `hook <event> --harness claude\|codex` | The harness hooks: ship guard, claim heartbeat, WIP checkpoint each turn, and the one lessons request per working session |
| `worker enable\|disable\|status\|run` | work a board with nobody at the keyboard — only on a machine whose `nodes.md` row says `worker: yes` |
| `learning <add\|list\|accept\|decline>` | The lessons a session left for `.vegastack/dev.md`; `add` reads them from a file or standard input, one per line, so no lesson text passes through a shell; accepting or declining drops one from the git-ignored queue, and the dev.md line is yours to write |
| `stats <collect\|push\|show>` | Usage numbers from the Claude Code and Codex session logs on this machine: read new turns, share them with the org, print them |

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

An organisation keeps its shared defaults in a control-room repository. Each machine keeps one copy per org at `~/.vegafactory/control-room/<org>/`, and skills read that copy instead of the network. A repo's profile layers on it: `org.md`, then `groups/<g>/group.md`, then the repo's own `.vegastack/dev.md`, nearest wins — except a line `org.md` marks `# locked`.

```sh
vegafactory sync              # refresh when the copy was last fetched more than 5 minutes ago
vegafactory sync --force      # refresh now
vegafactory sync --org acme   # first run in a repo whose dev.md has no control-room: line yet
vegafactory sync profile --json   # the resolved profile: values, sources, locked lines, blocks
```

- `.vegastack/dev.md` names the control room: `control-room: <org>/<repo>#<group>@<sha7>`.
- `sync profile` is the only supported way to read the room. It checks the copy is at this org's one path, on the recorded repository, branch, origin and commit, clean and holding its own Git metadata, and reads `org.md` and `group.md` out of that commit as regular blobs. Opening those files in the copy yourself skips all of it.
- `sync` is one shallow `git fetch` through your existing `gh` login. It never commits and never pushes.
- The copy mirrors the room's branch. A copy you have edited by hand refuses the refresh rather than being merged or discarded.
- `sync profile` exits **0** when the profile resolved cleanly and **1** when it carries blocks; the blocks are in the output either way.
- Exit codes: **0** fetched or already fresh · **2** a refusal (the fetch failed, a hand-edited copy, a wrong origin, a symlinked path, an unreadable `~/.vegafactory/factory.json`). A refusal leaves the old copy standing.

## Usage numbers

Both harnesses write a session log in your home directory. `stats collect` reads the new lines of
each log — from a saved byte offset, so a killed session is counted once, at the next run — and
keeps one record per assistant turn under `~/.vegafactory/stats/` — one collector at a time, so
two hooks never count the same turn twice: time, your `gh` login, the
machine, the repository, the issue, the harness, the exact model id, the skill the turn used, the
tokens, the duration, how the turn ended, and the workflow stage the issue was in **at that moment**
— written down as the CLI moves a state label, so a session collected days later still counts in the
stage it worked in, and turns nothing is known about carry no stage at all. Never a prompt, a file, tool arguments or which
subscription paid for the turn — a skill is named only when it resolves to one installed under
`~/.claude/skills`, `~/.agents/skills` or the bundle, so a tool argument that merely looks like a
skill name is dropped. The harness hooks run it in the background at each turn boundary.

```sh
vegafactory stats show --since 7d   # turns, tokens and time by operator, project, model and stage
vegafactory stats push              # append this machine's new turns to the org control room
vegafactory dashboard --open        # one offline HTML page, built from what you have
```

`push` appends each turn to `stats/YYYY/MM/DD/<operator>-<machine>.jsonl` — the operator and machine
the turn was recorded on, not whoever is logged in now — in the control-room clone `sync` already
keeps, then commits and pushes it with your own `gh` login, at most once an hour and never with
credentials of its own. A room only ever receives turns from the repositories bound to it: the repo
you are pushing from, the ones its `repos.md` registry lists, and other checkouts on this machine
whose profile names the same room. Turns from anywhere else stay on this machine, and each room
keeps its own cursor, so one org's push never marks another's turns as sent. The clone belongs to
`sync`, so a push refuses unless it is exactly as `sync` left it: the expected origin and branch, a
clean index and worktree, no local commits other than earlier stats pushes. Only the generated files
are staged, a failure puts them back, and a commit whose push was rejected is retried by the next
run. `show` and `dashboard` read this machine's records plus everything other machines pushed into
that clone; `--local` leaves the shared ones out.

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

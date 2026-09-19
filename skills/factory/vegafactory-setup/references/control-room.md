# The control room

The org's `vegafactory-control-room` repository: what each file holds, which file wins when two disagree, and how a run reads it. `vegafactory-setup` seeds every file here from `assets/control-room/*.template`; `dev-setup` reads them before it asks a repo anything.

## Layout

Seven things, and nothing else.

```
org.md                       what applies to everyone: the org name, the goals, the org-wide knobs
groups/<g>/group.md          department defaults: one line per knob a repo's dev.md can hold
repos.md                     registry: repo, group, board, owner
nodes.md               registry: the always-on machines, and which group's repos they serve
boards.md                    registry: project boards and the repos that mirror onto them
onboarding/                  the new-repo, new-teammate and worker-box checklists
stats/YYYY/MM/DD/<operator>-<machine>.jsonl   one record per assistant turn, appended by the CLI
```

A person is recorded once, on a group's `operators:` line. A decision register lives in the repo whose dev.md names it. A repo carries its own CODEOWNERS and its own workflow files. None of the three has a home here: a second copy of a fact is a second answer waiting to disagree with the first.

`groups/dev/` is the only department most orgs need; another department is a new `groups/<g>/group.md`.

## Precedence

Three layers of Markdown: `org.md`, then `groups/<g>/group.md`, then the repo's `.vegastack/dev.md`. **Nearest wins** — a repo's own line beats its group's, which beats the org's, which beats the skill defaults. A repo that answers nothing still resolves to a complete profile, because the layers under it answered.

The one exception is a **lock**. A knob line in `org.md` whose comment begins `locked` cannot be changed lower down:

```
provider-mode: subscription-only   # locked — runs bill to the operator's subscription
```

A group or a repo that sets a locked knob to a different value is refused, by name, and the org's value stands. Setting it to the same value is not a refusal — it is agreement. Only `org.md` may lock: the same marker in a group file or a dev.md is refused, so a lock nobody can grant is never silently ignored.

Two more rules that are not precedence:

- `dispatch: local` is a machine-local opt-in. A repo says it for itself; an org or a group saying it changes nothing.
- Harness stages inherit one at a time, so a repo may pin one stage and inherit the other five. The lock is the whole line or nothing: a locked `harness-policy:` must name all six stages and then holds all six. A locked line naming fewer is refused, and so is a lock on a single stage line — a partial lock reads as "the rest are yours" while leaving the stages the org never chose unanswerable by anyone.

An unreadable `control-room:` line is its own refusal. A bad value would otherwise leave the knob unset and read as "this repo names no control room", and a second line would quietly win over the first — both are how a profile ends up pointed at the wrong room, or at none, with nobody saying so.

## The knob line

A knob is a line at column zero: `key: value`, with an optional trailing `# comment`. Anything indented, and anything inside a fenced code block, is prose — so an example in this file never becomes policy. A key the resolver does not know stays an inert extension rather than a refusal, which is how a group file carries notes beside its knobs. A bad value for a key it does know is a refusal, never a default — and so is a key that was removed rather than never known, `workflow-labels:` and `gates:` among them, because inert is how a file keeps a retired mechanism without anyone noticing.

The workflow's labels are the one thing a group file lists rather than decides. The set is fixed — `waiting-on-operator planning queued in-progress ready-to-ship` plus `small medium large research risky epic` — and no knob renames them, so a `labels:` line that drops a state, repeats a name or still carries a superseded one refuses. A room whose repos are on the old names runs dev-setup's label migration, which moves every issue and board card onto the new name rather than deleting the old one.

`scripts/effective-policy.mjs` in dev-setup is the whole implementation: `parsePolicy(text, scope)` reads one layer, `resolvePolicy({org, group, repo})` returns `{ok, values, locked, sources, blocks}`. `sources` names the layer each value came from; `blocks` says in plain words why a refusal happened. Consumers check `ok` before acting — the resolved values are still useful to show even when an attempted override was refused.

Nothing reads the room by opening files in the copy. `vegafactory sync profile --json` is the one entry point: it runs every check in `## The read path` below and then resolves the three layers, so a reader that goes around it is a reader that goes around all of them.

## What each file may and may not carry

- `org.md` holds what applies to everyone: the org name, the goals in one paragraph, the org-wide knob lines, the automation identity by name, and the `## Unconfirmed` list.
- `org.md`'s `## Automation identity` block records the org's GitHub App by name, five lines and no more: `app:` the App name, `app-slug:` the slug the actor string and the install URL both follow, `app-install:` the installation id, `app-secrets:` the two secret **names**, and `app-permissions:` the granted set. The permission table, the mint recipe, rotation and the kill switch live in dev-setup's `references/github-app.md` and are never restated here.
- `groups/<g>/group.md` carries one default for every knob a group can decide, in the same line shape a dev.md uses — `harness-policy:` is one line, never six `harness:` lines. Per-repo facts (`repo:`, `skill-scan:`, `board:`, `control-room:`, detected types and fields) have no group default.
- `repos.md`, `nodes.md` and `boards.md` are registries, written when a repo is registered, a machine is enrolled or a board is linked — never hand-curated in parallel with them.
- `nodes.md` is the roster of every machine that runs vegafactory, one row each under a header that names the columns, `| node | owner | worker | repos | caps |`. A node is `<os-user>@<hostname>` — derived, never configured — so two people on one box are two nodes and one person with three boxes is three nodes and one owner. `owner` is who is responsible for the **machine**; that is not the owner on a statistics record, which is whoever did that piece of work. **`worker` is the gate and the only cell here that grants anything:** `yes` lets the machine work a board with nobody watching, and `no`, an empty cell, a word that is not an answer, a heading that only nearly says `worker`, and a roster with no such column all grant nothing. An empty `repos` cell authorises nothing either — `*` or `all` has to be said out loud. The `caps` cell sets what a worker may do — `runs 10 · step 72h · poll 1m · retry 15m · park 3`, every field optional, each field taking only the units it is measured in — and a cell that cannot be read refuses that machine by name rather than being guessed at. Cells are read by what their column is called, so a room may reorder or add columns and a notes column is never mistaken for caps; a table with no header holds no rows at all, because nothing in it says which cell is which. Caps are re-read every pass, so a change lands on the next poll rather than on a release. A machine that is not listed, or whose row is edited only in a local copy, refuses every worker verb. Run caps, retry deadlines and the seconds between reserving an issue and the run's own claim are per machine today (fleet-wide leases are tracked separately).
- **Nothing secret goes in any file — names of secrets only.** A control room is readable by everyone the org onboards, and a name (`NPM_TOKEN`, `CLOUDFLARE_API_TOKEN`) is all a runbook needs; the value lives in the secret store the name points at.
- Preserve a confirmed optional decline as declined: it goes under `## Unconfirmed` in `org.md`, so the next run asks again instead of assuming.

## `stats/`

`stats/` is the one tree automation writes, and its shape is the reason it can. One file per operator, per **machine**, per day means two machines never touch the same file, so a concurrent push is a non-fast-forward — solved by a rebase and a retry — and never a content conflict needing a human. Nothing here is summarised in the repository: a summary that accumulated would drift the first time a record arrived late from a machine that was offline, so totals are computed when they are read.

Each record is one assistant turn — time, operator, repo, issue, harness, model, skill, tokens, duration and outcome — and nothing else: never prompt text, assistant text, tool arguments, file contents, or which subscription paid for the turn. Machines write through the CLI, which appends what it has read from the harnesses' own session logs and pushes with the operator's own GitHub login, at most once an hour. Anyone with the copy can read the tree back offline, with `stats show` or as a local page from `vegafactory dashboard`.

## The read path

Each machine keeps one copy of the room per org, at `~/.vegafactory/control-room/<org>`, and every skill reads that copy instead of the network. `vegafactory sync` refreshes it: one shallow `git fetch` with the operator's own `gh` login, then the copy is set to the fetched commit. It refreshes when the copy was last fetched more than five minutes ago, and `--force` refreshes now.

The copy is a mirror, not a working branch. Before anything is fetched — and before the answer "already fresh" is given — the copy must be a repository of its own, still on the exact commit the last sync recorded, on the recorded branch and origin, with nothing changed. A local edit or a local commit refuses the refresh rather than being merged or discarded, because `checkout` would otherwise throw it away without a word, and the age window must not be able to hide it; a copy no run ever recorded a commit for is refused for the same reason, since there is nothing to hold it to. One run at a time holds the copy — the refresh and the statistics push share that lock, and both record where they leave it. If the record cannot be written the copy goes back to the commit it was on, and a first fetch that fails takes its half-made repository with it, so the checkout and the record never disagree.

Reading is just as careful, because everything `~/.vegafactory/factory.json` records is a claim rather than a fact. The path must be the one directory this org's copy may live at, canonical and free of symlinked components; the copy must hold its own Git metadata there, with its worktree where it stands, so a symlinked `.git`, a gitfile or a `core.worktree` redirect cannot move git's reads out of the store; the recorded repository, branch and origin must all be named and must all match; and the working tree must still be on the recorded commit, clean. `org.md` and `group.md` are then read out of that commit as regular blobs, with replacement objects off — a tracked symlink is a refusal rather than a redirect, and a hand-written `refs/replace` entry cannot hand back different policy than the commit holds. Another org's clone, a wrong-origin copy, the leftovers of a failed sync and a hand edit each fail one of those checks, and a copy that fails any of them is not policy.

A refusal is never an outage: the previous copy stands and the profile still resolves from what is left, with the reason and the age of the last successful fetch reported alongside. A repo whose dev.md names no control room resolves from its own lines and the skill defaults, and needs no sync at all.

## Boards

A board is created, field-configured and linked by the operator, never by an agent: **the operator runs these** commands, in this order — every one of them needs the `project` scope, which lives on a human token and never on an agent's:

1. `gh auth refresh -s project` — adds the scope to the operator's own `gh` login; without it every command below 403s.
2. `gh project create --owner <org> --title "<title>"` — note the number it prints; that number is the `board:` knob and the `number` column of `boards.md`.
3. `gh project field-list <n> --owner <org> --format json -q '.fields[] | select(.name=="Status") | .id'` — the id of the default Status field.
4. `gh project field-delete --id FIELD_ID` — use the field ID from step 3; the default Status options are not the workflow's states.
5. `gh project field-create <n> --owner <org> --name Status --data-type SINGLE_SELECT --single-select-options "waiting-on-operator,planning,queued,in-progress,ready-to-ship,Done"` — the five state labels plus Done, in that order.
6. `gh project link <n> --owner <org> --repo <owner/repo>` — one call per repo that mirrors onto this board.

Then, in the project's Workflows UI, switch on the four built-in automations, which have no CLI: auto-add `is:issue is:open`, item closed → Done, PR merged → Done, and auto-archive after 14 days.

The mirror itself is one way. `.github/workflows/factory-board.yml` (dev-setup's `assets/factory-board.yml.template`) writes Status from the issue's single state label with the App token; nothing reads the board back, so a card dragged by hand is cosmetic until the next label change.

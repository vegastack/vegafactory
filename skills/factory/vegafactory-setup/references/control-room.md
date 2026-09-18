# The control room

The org's `vegafactory-control-room` repository: what each file holds, which file wins when two disagree, and how a run reads it. `vegafactory-setup` seeds every file here from `assets/control-room/*.template`; `dev-setup` reads them before it asks a repo anything.

## Layout

Seven things, and nothing else.

```
org.md                       what applies to everyone: the org name, the goals, the org-wide knobs
groups/<g>/group.md          department defaults: one line per knob a repo's dev.md can hold
repos.md                     registry: repo, group, board, owner
dispatchers.md               registry: the always-on machines, and which group's repos they serve
boards.md                    registry: project boards and the repos that mirror onto them
onboarding/                  the new-repo, new-teammate and dispatcher-box checklists
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
- Harness stages inherit one at a time, so a repo may pin one stage and inherit the other five. A locked `harness-policy:` line holds all six.

## The knob line

A knob is a line at column zero: `key: value`, with an optional trailing `# comment`. Anything indented, and anything inside a fenced code block, is prose — so an example in this file never becomes policy. A key the resolver does not know stays an inert extension rather than a refusal, which is how a group file carries notes beside its knobs. A bad value for a key it does know is a refusal, never a default.

`scripts/effective-policy.mjs` in dev-setup is the whole implementation: `parsePolicy(text, scope)` reads one layer, `resolvePolicy({org, group, repo})` returns `{ok, values, locked, sources, blocks}`. `sources` names the layer each value came from; `blocks` says in plain words why a refusal happened. Consumers check `ok` before acting — the resolved values are still useful to show even when an attempted override was refused.

## What each file may and may not carry

- `org.md` holds what applies to everyone: the org name, the goals in one paragraph, the org-wide knob lines, the automation identity by name, and the `## Unconfirmed` list.
- `org.md`'s `## Automation identity` block records the org's GitHub App by name, five lines and no more: `app:` the App name, `app-slug:` the slug the actor string and the install URL both follow, `app-install:` the installation id, `app-secrets:` the two secret **names**, and `app-permissions:` the granted set. The permission table, the mint recipe, rotation and the kill switch live in dev-setup's `references/github-app.md` and are never restated here.
- `groups/<g>/group.md` carries one default for every knob a group can decide, in the same line shape a dev.md uses — `harness-policy:` is one line, never six `harness:` lines. Per-repo facts (`repo:`, `skill-scan:`, `board:`, `control-room:`, detected types and fields) have no group default.
- `repos.md`, `dispatchers.md` and `boards.md` are registries, written when a repo is registered, a machine is enrolled or a board is linked — never hand-curated in parallel with them.
- **Nothing secret goes in any file — names of secrets only.** A control room is readable by everyone the org onboards, and a name (`NPM_TOKEN`, `CLOUDFLARE_API_TOKEN`) is all a runbook needs; the value lives in the secret store the name points at.
- Preserve a confirmed optional decline as declined: it goes under `## Unconfirmed` in `org.md`, so the next run asks again instead of assuming.

## `stats/`

`stats/` is the one tree automation writes, and its shape is the reason it can. One file per operator, per **machine**, per day means two machines never touch the same file, so a concurrent push is a non-fast-forward — solved by a rebase and a retry — and never a content conflict needing a human. Nothing here is summarised in the repository: a summary that accumulated would drift the first time a record arrived late from a machine that was offline, so totals are computed when they are read.

Each record is one assistant turn — time, operator, repo, issue, harness, model, skill, tokens, duration and outcome — and nothing else: never prompt text, assistant text, tool arguments, file contents, or which subscription paid for the turn. Machines write through the CLI, which appends what it has read from the harnesses' own session logs and pushes with the operator's own GitHub login, at most once an hour. Anyone with the copy can read the tree back offline, with `stats show` or as a local page from `vegafactory dashboard`.

## The read path

Each machine keeps one copy of the room per org, at `~/.vegastack/control-room/<org>`, and every skill reads that copy instead of the network. `vegafactory sync` refreshes it: one shallow `git fetch` with the operator's own `gh` login, then the copy is set to the fetched commit. It refreshes when the copy was last fetched more than five minutes ago, and `--force` refreshes now.

The copy is a mirror, not a working branch. A copy with local changes refuses the refresh rather than being merged or discarded, and a copy whose origin is not the room the profile names is refused rather than rewritten. The path is fixed at one directory per org, checked to be canonical and free of symlinked components before anything reads or writes it — nothing in `~/.vegastack/factory.json` can move it somewhere those checks do not cover.

A refusal is never an outage: the previous copy stands and the profile still resolves from it, with the age of the last successful fetch reported alongside. A repo whose dev.md names no control room resolves from its own lines and the skill defaults, and needs no sync at all.

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

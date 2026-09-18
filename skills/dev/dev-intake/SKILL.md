---
name: dev-intake
description: Turn ideas, brainstorms, feature requests, bug reports, or SOW documents into GitHub issues an agent can act on without further questions. Use when the user asks for a new feature or capability ("add support for X", "I need Y", "can we make it do Z"), when asked to "turn this into issues", "create tasks from this SOW", "write up an issue for" a feature or bug, "users report X — make an issue", "plan this as issues", "slice this epic", or when the user gives approval on a drafted issue and it needs recording. Not for writing the implementation plan of an approved issue (dev-plan), implementing issues or a trivial one-or-two-file fix (dev-implement), creating PRs or merging (dev-ship), or project bootstrap (dev-setup).
---

# dev-intake

Write the issue: every question is asked here, because dark mode asks none.

Requirements come in as the operator's brainstorm, feature thought, bug report, or SOW; issues go out complete enough that a fresh agent needs nothing but the URL, because an under-specified issue becomes an interruption or a guess.

Nearest neighbors: `dev-plan` owns the how once a brief is approved; intake owns the what/why and the approval mechanics; `dev-implement` builds.

## Ground before you ask

Finding facts is your job, because a brief built on unverified facts is a confident mistake waiting for dark mode. Before the first question:

- **Read the file before speaking about it** — open the actual paths the work would change: current behavior, patterns to reuse, where it plugs in. The brief cites these real paths later, because a brief naming no files is a sign this step was skipped.
- Verify dependencies: any library, service, or API capability the approach leans on gets checked against current official docs, noted with the date; stack, schema, auth, and infra choices route through `dev-architect`'s verify protocol.
- Cross-check the request against product docs and current behavior; a contradiction is asked out loud — "you asked for X; the code does Y — which wins?" — because a silently resolved contradiction is a guess the operator did not make. Push back on cost the same way: when a simpler version covers most of the need, name it.
- Triage every unknown into three bins: *findable* → find it now, yourself; *only-the-operator-knows* → ask, with a recommendation; *only-running-code-can-tell* → a `research` issue or the issue's first spike step. Guessing is not a bin.

## Size the work — say it out loud

Every issue gets one size, announced with its reason, applied as a label, and recorded in the brief's `**Size:**` line; the operator can override it:

- **`small`** — a small change to a flow that already exists in the repo to read. Brief and plan are written together and one ack covers both.
- **`medium`** — one outcome with real design choices or new ground inside one issue. Brief ack, then a separate planning session, then a plan ack.
- **`large`** — several deliverables. Brief ack, then planning splits it into small/medium sub-issues and the parent becomes an `epic`.
- **`research`** — a question to answer, not code to keep. The brief is the question plus what "answered" looks like.

When the size is unclear, take the larger one; `dev-plan` may raise it later, and lowering it waits for the operator's yes.

## The interview

Ask in rounds by the ask route (`references/ask-route.md`): your harness's question tool when you have one and the asker is the issue's operator, otherwise one `questions` comment on the issue and `waiting-on-operator`, because a headless run that cannot ask is not a run that may guess. On that issue route, create the issue before the first round — `waiting-on-operator`, the operator assigned, the request as its body — so the round has a surface; the brief replaces that body once the round is answered. Each round covers the current frontier, every open decision that doesn't depend on another answer. Number the questions; give each a recommended answer with a one-line reason so the operator can reply "all recommended", and skip what the material or an earlier round settled, because a re-asked question reads as not having listened. A vague or self-contradicting answer gets pushback with concrete options — a mermaid or ASCII sketch when a picture beats prose — because a vague answer absorbed silently becomes a guess in dark mode. Stop when *a fresh agent could act on each issue without asking anything.*

The angles, in order — product (who, observable outcome, in/out of scope, slices, priority) → behavior (flows, rules, permissions, edge and failure cases; UI states and copy) → technical (only choices genuinely the operator's, each with a recommendation, checked against `dev-architect`; the version impact where the project versions releases) → quality and risk (what proves it works, what earns `risky`, what stops a dark run). Deep approach trade-offs beyond the operator's choices belong to `dev-plan`. Where dev.md's `issue-fields:` knob names org fields, two of the numbered questions are Priority and Effort, their options read once from `gh api orgs/<org>/issue-fields` and ordered by each option's `priority` key rather than guessed — recommend the option named `Medium` for Priority, or the middle option where the org names none, and for Effort the lowest option on `research` and `small`, the middle option on `medium`, the highest on `large` — so "all recommended" still answers both, and a knob at `none` skips them.

**Bug variant** (`fix:` issues): reproduction steps — or the artifacts needed to obtain them (logs, HAR, recording) — are a required brief section, the brief names `dev-debug` as the implement path, and a bug that can't be reproduced yet becomes a `research` issue first.

## Slicing and hierarchy

- One issue = one outcome that fits one agent session, sliced vertically; blockers use native dependencies, phases milestones, parents native sub-issues.
- Deliberately deferred work ("someday, not now") lives in the parent's out-of-scope section, because an icebox issue clutters the tracker; a tracking issue exists only on the operator's ask.
- **Epics:** a multi-deliverable feature gets a parent whose body is a map, because a parent that is also work gets claimed — `Destination` (the one or two lines every session orients to) · `Decisions so far` (one-line gists linking closed children) · `Not clear yet` (in-scope questions you cannot yet phrase sharply — the test is phrasing, not answering; don't pre-slice fog) · `Out of scope` (the tempting adjacent work, named). Each child is sized independently. Only children get `queued`, because the epic is the map.
- Titles carry the type prefix (dev.md's `branch:` type list, plus `research:` for an inquiry) and the native issue type where the org has them; issue and PR titles agree. A branch only ever uses a type the knob lists, so a `research:` issue that does write code takes a listed one — `worktree create` refuses rather than picking.

## The brief

The issue body follows [brief-template](references/brief-template.md), marker line included: inline over linked, concrete over abstract, evidence over confidence — touch points name real paths, dependency claims carry their check date, and anything unverifiable goes to **Assumptions — confirm or correct**, because an asserted guess binds the agent. Tests-and-acceptance names the seams — the public boundaries tests will live at — because dark mode can't ask later. A brief runs 300–600 words: a section the fresh agent would not need is cut, and one they would have to guess at is missing.

Small issues get their plan now: after the brief has consensus, invoke `dev-plan`'s inline mode in this conversation and post brief (body) + plan (comment) together, so the operator's single ack covers both.

Before posting any brief, run `node <path-to-this-skill>/scripts/brief-lint.mjs --file <draft> --scope <size> --json` (add `--fix` for fix:-type briefs — it requires the Reproduction section): structure gaps block (exit 2), quality smells warn; fix blocks before the operator sees the draft. Inline plans also pass `dev-plan`'s plan-lint.

## Labels and acks

- A new issue starts at `waiting-on-operator` plus its size label, and `risky` when it touches security, money, user data, or production. Create it with `--assignee <operator>` (the person who asked), so GitHub's own notification reaches them. After creating it, read and write it only through `vegafactory issue` (conventions' "Reading and writing issues").
- Set the native issue type where the org has them (dev.md `issue-types:`): `gh issue create --type <Name>`, then confirm it in the synced `issue.md`. Where `issue-fields:` names Priority and Effort, set both in one request (the PUT replaces every value it does not carry):

  ```sh
  gh api "orgs/$ORG/issue-fields" --jq '.[] | select(.name=="Priority" or .name=="Effort") | {id, name}'   # once per run
  printf '{"issue_field_values":[{"field_id":%s,"value":"%s"},{"field_id":%s,"value":"%s"}]}' \
    "$PRIORITY_ID" "$PRIORITY" "$EFFORT_ID" "$EFFORT" |
    gh api -X PUT "repos/$OWNER/$REPO/issues/$N/issue-field-values" --input -
  ```

  GitHub silently drops a value written without push access, so read the values back and report a mismatch. Both knobs at `none` means the issue carries labels only — say so in one sentence.
- An ack is the operator's explicit words — in the issue or in this session — from anyone with write access. Labels, silence and time are not acks. Anything else they say is input: apply it and ask again.
- Record each ack with `vegafactory issue ack <n> --stage brief|plan --by <login> --quote "<their words>" --source comment:<id>|session` (a small issue's single ack is `--stage plan`, covering brief and plan). A session ack is recorded with that person's own `gh` login.
- Then move the state with `vegafactory issue label <n> --state …`: `small` and `research` → `queued` (unassigned); `medium` and `large` → `planning` (the operator).
- An issue leaves `waiting-on-operator` only once every Assumptions entry is resolved (confirmed, corrected, or moved to a spike) and the section deleted.
- A directional decision this work settles (dev.md's Decisions test) is proposed as one register line on the operator's yes; `dev-ship` records it at merge.
- The operator edits a draft → apply it and summarize what changed since they last read it.

## After the ack

An acked issue that later needs a material change moves back to `waiting-on-operator` with one comment naming what changed. The edit invalidates the old ack by itself (it binds the brief's hash), so record the new ack the same way and bump the brief's revision marker. Ticking plan checkboxes never needs a new ack.

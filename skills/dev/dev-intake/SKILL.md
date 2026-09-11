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

## Scope the work — say it out loud

Every issue gets one scope call, announced with its reason, applied as a label, and recorded in the brief's `**Scope:**` line so the reasoning survives the conversation; the operator can override it:

- **`research`** — a question to answer, not code to keep. The brief is the question plus what "answered" looks like.
- **`quick-build`** — the objective test (conventions' wording): *a small change and the flow being changed already exists in the repo to read*. Missing either half means it is not quick-build; familiarity with the kind of app doesn't count.
- **`full-plan`** — big or new ground: a new subsystem, a restructuring, a brand-new flow.

When the two halves of the test disagree, or the class is unclear, take the heavier one, because the ratchet only ever goes up. Re-classification after this point belongs to `dev-plan`'s one-way ratchet, and a downgrade waits for the operator's yes.

## The interview

Ask in rounds by the ask route (`references/ask-route.md`): your harness's question tool when you have one and the asker is the issue's operator, otherwise one `questions` comment on the issue and `needs-operator`, because a headless run that cannot ask is not a run that may guess. On that issue route, create the issue before the first round — `needs-operator`, the operator assigned, the request as its body — so the round has a surface; the brief replaces that body once the round is answered. Each round covers the current frontier, every open decision that doesn't depend on another answer. Number the questions; give each a recommended answer with a one-line reason so the operator can reply "all recommended", and skip what the material or an earlier round settled, because a re-asked question reads as not having listened. A vague or self-contradicting answer gets pushback with concrete options — a mermaid or ASCII sketch when a picture beats prose — because a vague answer absorbed silently becomes a guess in dark mode. Stop when *a fresh agent could act on each issue without asking anything.*

The angles, in order — product (who, observable outcome, in/out of scope, slices, priority) → behavior (flows, rules, permissions, edge and failure cases; UI states and copy) → technical (only choices genuinely the operator's, each with a recommendation, checked against `dev-architect`; the version impact where the project versions releases) → quality and risk (what proves it works, what earns `risky`, what stops a dark run). Deep approach trade-offs beyond the operator's choices belong to `dev-plan`. Where dev.md's `issue-fields:` knob names org fields, two of the numbered questions are Priority and Effort, their options read once from `gh api orgs/<org>/issue-fields` and ordered by each option's `priority` key rather than guessed — recommend the option named `Medium` for Priority, or the middle option where the org names none, and for Effort the lowest option on `research` and `quick-build`, the middle option on `full-plan` — so "all recommended" still answers both, and a knob at `none` skips them.

**Bug variant** (`fix:` issues): reproduction steps — or the artifacts needed to obtain them (logs, HAR, recording) — are a required brief section, the brief names `dev-debug` as the implement path, and a bug that can't be reproduced yet becomes a `research` issue first.

## Slicing and hierarchy

- One issue = one outcome that fits one agent session, sliced vertically; blockers use native dependencies, phases milestones, parents native sub-issues.
- Deliberately deferred work ("someday, not now") lives in the parent's out-of-scope section, because an icebox issue clutters the tracker; a tracking issue exists only on the operator's ask.
- **Epics:** a multi-deliverable feature gets a parent whose body is a map, because a parent that is also work gets claimed — `Destination` (the one or two lines every session orients to) · `Decisions so far` (one-line gists linking closed children) · `Not clear yet` (in-scope questions you cannot yet phrase sharply — the test is phrasing, not answering; don't pre-slice fog) · `Out of scope` (the tempting adjacent work, named). Each child is classified independently. Only children get `ready`, because the epic is the map.
- Titles carry the type prefix (dev.md `branch:` type list + `research:`) and the native issue type where the org has them; issue, branch, and PR agree.

## The brief

The issue body follows [brief-template](references/brief-template.md), marker line included: inline over linked, concrete over abstract, evidence over confidence — touch points name real paths, dependency claims carry their check date, and anything unverifiable goes to **Assumptions — confirm or correct**, because an asserted guess binds the agent. Tests-and-acceptance names the seams — the public boundaries tests will live at — because dark mode can't ask later. A brief runs 300–600 words: a section the fresh agent would not need is cut, and one they would have to guess at is missing.

Quick-build issues get their plan now: after the brief has consensus, invoke `dev-plan`'s inline mode in this conversation and post brief (description) + plan (comment) together, so the operator's single approval covers both.

Before posting any brief, run `node <path-to-this-skill>/scripts/brief-lint.mjs --file <draft> --scope <class> --json` (add `--fix` for fix:-type briefs — it requires the Reproduction section): structure gaps block (exit 2), quality smells warn; fix blocks before the operator sees the draft. Inline plans also pass `dev-plan`'s plan-lint.

## Labels and approval

- A new issue starts at `needs-operator` plus its scope label, and `risky` when it touches security, money, user data, or production (names from dev.md's `labels:` knob); create it with `--assignee <operator>`, the login conventions' Labels table resolves from dev.md's `operators:` list, so GitHub's own notification reaches the human whose move it is. An `--assignee` GitHub rejects is reported and the issue stands unassigned, because guessing another login hands the work to the wrong person.
- Creation also stamps the native type where dev.md's `issue-types:` knob names one for the issue's title prefix — `gh issue create --type <Name>` at gh 2.94.0 and above, otherwise `gh api -X PATCH repos/{owner}/{repo}/issues/{n} -f type=<Name>` in the same breath as creation — and both fields where `issue-fields:` names them, in one request, because the PUT replaces every value it does not carry:

  ```sh
  gh api "orgs/$ORG/issue-fields" --jq '.[] | select(.name=="Priority" or .name=="Effort") | {id, name}'   # once per run
  printf '{"issue_field_values":[{"field_id":%s,"value":"%s"},{"field_id":%s,"value":"%s"}]}' \
    "$PRIORITY_ID" "$PRIORITY" "$EFFORT_ID" "$EFFORT" |
    gh api -X PUT "repos/$OWNER/$REPO/issues/$N/issue-field-values" --input -
  gh api "repos/$OWNER/$REPO/issues/$N" --jq .type.name                 # read the type back
  gh api "repos/$OWNER/$REPO/issues/$N/issue-field-values"              # read the values back
  ```

  GitHub drops a type or a field value written without push access and returns success, so the two readbacks decide the claim and a mismatch is reported rather than assumed away. Both knobs at `none` — a personal repo, or an org defining neither — means the issue carries its labels and nothing else; say that in one plain sentence instead of reporting a failure.
- Approval is the operator's explicit words tied to the issue, because labels, silence and time say nothing about consent.
- Record one schema-v2 approval event per conventions: `scope=brief`, or `scope=brief+plan` for brief plus plan comment. Use bundled `scripts/lib/approval.mjs`’s `artifactRef` on refreshed canonical artifacts; include actual operator words and artifact bindings. Session attestations require a policy-operator publisher; other recorders may only relay an independently verified identical scoped grant per conventions. Evaluate fresh complete history/current policy, preserving canonical `approvalBindings`. Preserve legacy records for scoped reconfirmation; a marker alone grants nothing.
- Then flip the state, carrying the assignee the Labels table names: `research` and `quick-build` → `ready` (unassigned); `full-plan` → `needs-plan` (the operator).
- An issue leaves `needs-operator` only once every Assumptions entry is resolved (confirmed, corrected, or moved to a spike) and the section deleted.
- A directional decision this work settles (dev.md's Decisions test) is proposed as one register line on the operator's yes; `dev-ship` records at merge.
- The operator edits a draft → apply it and summarize what changed since they last read it.

## After approval

An approved issue that later needs a material change flips back to `needs-operator` with one comment naming what changed; the new approval is recorded the same way and the brief's revision marker bumps. Only the canonicalizer’s specified progress fields preserve approval; every other scope-byte edit requires refreshed intent.

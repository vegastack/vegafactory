---
name: dev-ship
description: Land finished work, each step only on the operator's explicit word. Use when the user says "make the PR", "open a pull request" for an issue, "ship it", "merge it", "merge issue 12", "release", "release everything since the last tag", or asks to close out a reviewed ready-to-ship issue, merge a bot PR (Renovate, Dependabot), or roll back a bad release. Not for implementing issues (dev-implement), reviewing them (dev-review), or writing and approving them (dev-intake).
---

# dev-ship

Act on the operator's word only. Per issue the operator gives two words: an ack on the brief or plan (it authorized building) and **"ship it"**, which carries that issue's landing — PR, merge queue, merge, cleanup. Two words per issue, not one per step.

**It does not yet cover the release**: a generated release PR belongs to no issue, so its merge and the tag push still ask ([runbook](references/runbook.md)).

**"Ship it" is spent only by the operator's own words** — passing checks, PR permissions and the calendar say nothing about consent. Record the word before acting on it: `vegafactory issue ack <n> --stage ship --by <login> --quote "<their words>"`. It binds to the current brief and plan and counts only when it comes after the latest evidence comment, so new evidence needs a new "ship it". Words asking only for a PR ("make the PR") authorize the PR and nothing more.

Nearest neighbor: `dev-implement` produces the `ready-to-ship` issue with its evidence comment; ship packages and lands it. Corrections found here go back through implement's corrections loop.

## The PR

On "make the PR" or "ship it":

- Verify the issue is at `ready-to-ship` with the evidence comment present — including its `**Docs:**` line (brief/plan revisions in sync) — and the branch is pushed. Not there yet → say what's missing instead of creating a premature PR. Docs out of sync is corrections work through implement's loop, because a brief patched from here has no ledger line behind it.
- Verify the changelog state matches the evidence comment's `**Changelog:**` line: a behavior-changing branch carries its entry per dev.md's `changelog:` knob (changesets: a `.changeset/*.md` in the diff; keep-a-changelog: the diff adds lines to CHANGELOG.md) and, with `chronicle: on`, its chronicle entry, while `none` with a reason that holds up (docs-only, test-only) is fine. An unexplained miss → corrections loop, not a PR.
- `gh pr create` from the task branch: title from the issue, body is `Closes #<n>` plus a link to the evidence comment — the issue holds the report; the PR links it rather than duplicating it. No draft PRs unless the user asks for one.
- If required checks fail on the PR, that's implement work: hand the failures to the corrections loop, update the evidence comment, and tell the user. The new evidence comment means the operator says "ship it" again.
- A direct chat change (dev-implement's no-issue path) ships on the same words: the chat request stands in for the recorded ack, the PR body carries the evidence instead of linking an issue comment, and the changelog rule applies unchanged.
- User corrections left on the PR itself flow through the same corrections loop on the same branch — the PR updates with the push; nothing gets recreated.

| Excuse (observed) | Reality |
|---|---|
| "Opening a PR is preparation, not shipping — it pushes nothing… exactly the state the workflow wants finished work parked in." | The PR waits for the operator's word. Finished work parks on the pushed branch; a draft PR is still a PR nobody asked for. |

## The merge — one word, the whole sequence

On "ship it", run it through: PR → merge queue → merge → the Ship runbook → cleanup. Report each step as it lands; stop only on a failure or a fact the operator alone holds.

- Run `vegafactory ship check <n>` (`--json` for the reasons as data). It passes only when the issue passes `issue check --for ship` (a valid "ship it" after the latest evidence), the branch is clean and pushed, and its PR is open on that commit with every check green. Exit 2 stops: report its reasons and route them — code problems to implement's corrections loop, a missing word to the operator.
- The ship guard lets `gh pr merge` through only for a PR whose branch names an issue with that recorded "ship it"; every other merge, and `--admin`, still asks.
- Pending `Decision:` lines exist (issue comments, or the evidence comment's `**Decision:**` line) → name them before merging — "merging will record: …" — and act on the operator's confirmation, because the register is append-only and an inferred line cannot be taken back. On the word, append each to the register dev.md names (`decisions:` knob) in conventions' Operator identity format.
- A merge conflict with the default branch is corrections work: update the branch, run the checks the update touched, post fresh evidence, and ask for "ship it" again.
- Queue the PR where the repo has a merge queue, and merge it directly where it has none; the strategy is dev.md's `merge` knob. A queue rejection is a red check like any other — it routes to the corrections loop, and the new evidence needs a new "ship it". `Closes #<n>` closes the issue; confirm the merge and the close both happened.
- Then remove the merged branch's worktree — `vegafactory worktree remove <n> --json` — which takes the **directory only**. Deleting the local or remote branch is its own operator word.
- A bot PR (Renovate, Dependabot) has no issue or evidence comment and merging it is still shipping: green checks qualify it, only the operator's explicit word — per PR or per named batch — merges it; majors and security advisories get named before their word is acted on. The guard asks for it by hand.

## After the merge — the Ship runbook

Merge is not the end when dev.md has a `## Ship` section: follow its steps in order — `auto:` lines you just do under the same "ship it", `ask:` lines wait for the operator's own word (the guard asks for any command they name in backticks, read from the default branch's dev.md), `guard:` lines are deterministic checks you run locally at their position (their CI copies are the backstop). With `release: per-merge`, the runbook is part of shipping the issue; with `release: on-request`, it runs only when the operator says "release" (covering everything merged since the last one). Report each step's outcome; a failing step — guard included — stops the sequence and goes to the operator. Execution detail, the release exception, release batching, bot PRs, and rollback: [runbook](references/runbook.md).

Rollback rolls forward through the Ship section's rollback line, because a force-push erases the record the rollback needs. Gotchas surfaced here feed the Report's closing retro below.

## Report

One short confirmation per step, in plain language: what was created or merged, the link, decisions recorded, and anything that still needs the operator (failing check, failing guard, missing "ship it", evidence or changelog entry). When a condition isn't met, the answer is what's missing, because a step skipped to be helpful is no gate.

Close every ship with the retro: any bounce, gotcha, or instruction the operator had to repeat during this issue? Propose the one dev.md (or runbook) line that would have prevented it, folded into an existing line, because a log in dev.md is read by nobody; a directional gotcha becomes a register proposal instead. Each lands only on the operator's yes.

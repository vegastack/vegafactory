---
name: dev-ship
description: Land finished work, each step only on the operator's explicit word. Use when the user says "make the PR", "open a pull request" for an issue, "ship it", "merge it", "merge issue 12", "release", "release everything since the last tag", or asks to close out a reviewed for-operator issue, merge a bot PR (Renovate, Dependabot), or roll back a bad release. Not for implementing issues (dev-implement), reviewing them (dev-review), or writing and approving them (dev-intake).
---

# dev-ship

Act on the operator's word only: each gate is spent by their words asking for that step and nothing more.

**Gates are spent only by the operator's words** — their words asking for a PR authorize the PR and nothing more; their words asking to merge authorize the merge, because passing checks, PR permissions and the calendar say nothing about consent. The dev.md `gates` knob sets how many actions one word covers — `3` keeps PR and merge as separate words, `2` lets one "ship it" cover both, `1` is direct-to-main (the ship word merges locally and pushes; no PR object, everything else identical).

Nearest neighbor: `dev-implement` produces the `for-operator` issue with its evidence comment; ship packages and lands it. Corrections found here go back through implement's corrections loop.

## Gate 1 — the PR

On the user's PR instruction:

- Run `node <path-to-this-skill>/scripts/ship-gate.mjs --issue <n> --branch <name> --json` (optional `--repo <o/r> --dev-md <path> --worktree <path>`). It checks the exact committed checkout before/after the project command, full evidence/review/head equality, canonical plan scope/base binding, scoped operator exceptions, changelog/chronicle and debug tags. Missing check or dirty/moved candidate refuses; ignored build output is allowed. Exit 2 stops; warnings remain visible. Metadata and migration: [runbook](references/runbook.md).
- Verify the issue is at `for-operator` with the evidence comment present — including its `**Docs:**` line (brief/plan revisions in sync) — and the branch is pushed. Not there yet → say what's missing instead of creating a premature PR. Docs out of sync is corrections work through implement's loop, because a brief patched from here has no ledger line behind it.
- Verify the changelog state matches the evidence comment's `**Changelog:**` line: a behavior-changing branch carries its entry per dev.md's `changelog:` knob (changesets: a `.changeset/*.md` in the diff; keep-a-changelog: the diff adds lines to CHANGELOG.md), while `none` with a reason that holds up (docs-only, test-only) is fine. An unexplained miss → corrections loop, not a PR.
- `gh pr create` from the task branch: title from the issue, body is `Closes #<n>` plus a link to the evidence comment — the issue holds the report; the PR links it rather than duplicating it.
- No draft PRs unless the user asks for one.
- If required checks fail on the PR, that's implement work: hand the failures to the corrections loop, update the evidence comment, and tell the user. Under `gates: 2` the standing ship word holds once checks are green again — subject to Gate 2's staleness bound (behavior change or >7 days → one-sentence re-confirm).
- A direct chat change (dev-implement's no-issue path) ships on the same words: the chat request stands in for the recorded approval, the PR body carries the evidence instead of linking an issue comment, and the changelog rule applies unchanged.
- User corrections left on the PR itself flow through the same corrections loop on the same branch — the PR updates with the push; nothing gets recreated.

With `gates: 1` there is no PR: the same verifications run, then the ship word triggers the merge below directly ([runbook](references/runbook.md) has the mechanics).

| Excuse (observed) | Reality |
|---|---|
| "Opening a PR is preparation, not shipping — it pushes nothing… exactly the state the workflow wants finished work parked in." | Under `gates: 3` the PR is a gate spent only by the operator's word. Finished work parks on the pushed branch; a draft PR is still a PR nobody asked for. |

## Gate 2 — the merge

On the user's merge instruction:

- Re-run the gate and read back the remote PR head/base IDs and base repository/ref against the accepted candidate. Every new commit, including evidence/docs, invalidates review/checks. Renew exact full-candidate review before merge; keep evidence in comments to avoid self-reference commits.
- Pending `Decision:` lines exist (issue comments, or the evidence comment's `**Decision:**` line) → name them in the merge confirmation — "merging will record: …" — so the operator's word demonstrably covers them, because the register is append-only and an inferred line cannot be taken back. On the word, append each to the register dev.md names (`decisions:` knob) in conventions' Operator identity format; the register is append-only and this is its moment.
- A merge conflict with the default branch is corrections work: update the branch, run the checks the update touched, and the standing merge instruction holds once checks are green again — unless the update changed behavior, or more than 7 days have passed since the word; either way, re-confirm with one sentence rather than acting on a stale instruction.
- Merge per the dev.md `merge` knob (default `gh pr merge --squash`; `gates: 1` merges locally per the same knob and pushes). `Closes #<n>` closes the issue; confirm both happened.
- Then remove the merged branch's worktree — `node <path-to-dev-implement>/scripts/worktree.mjs remove --issue <n> --write --json` — which takes the **directory only**. Deleting the local branch and deleting the remote branch are each their own operator word, and an epic parent's worktree goes only when the parent PR merges. Child-into-parent merges and the one-PR-per-feature rule: [runbook](references/runbook.md).
- A bot PR (Renovate, Dependabot) has no issue or evidence comment and merging it is still shipping: green checks qualify it, only the operator's explicit word — per PR or per named batch — merges it; majors and security advisories get named before their word is acted on.

Final assembled parent review and postmerge `parentDelivery` proof follow the [runbook](references/runbook.md). One approved parent scope covers routine authorized child integration; final whole-parent review remains mandatory. Local child acceptance means implemented; only verified parent merge means delivered.

## After the merge — the Ship runbook

Merge is not the end when dev.md has a `## Ship` section: follow its steps in order — `auto:` lines you just do, `ask:` lines wait for the operator's word, `guard:` lines are deterministic checks you run locally at their position (their CI copies are the backstop). With `release: per-merge`, the runbook is part of shipping the issue; with `release: on-request`, it runs only when the operator says "release" (covering everything merged since the last one). Report each step's outcome; a failing step — guard included — stops the sequence and goes to the operator, because a skipped guard is a guard the runbook does not have. Execution detail, release batching, direct-to-main, bot PRs, and rollback: [runbook](references/runbook.md).

Rollback rolls forward through the Ship section's rollback line, because a force-push erases the record the rollback needs. Gotchas surfaced here feed the Report's closing retro below.

## Report

One short confirmation each gate, in plain language: what was created or merged, the link, decisions recorded, and anything that still needs the operator (failing check, failing guard, moved head, missing evidence or changelog entry). When a gate's condition isn't met, the answer is what's missing, because a gate skipped to be helpful is no gate.

Close every ship with the retro: any bounce, gotcha, or instruction the operator had to repeat during this issue? Propose the one dev.md (or runbook) line that would have prevented it, folded into an existing line, because a log in dev.md is read by nobody; a directional gotcha becomes a register proposal instead. Each lands only on the operator's yes.

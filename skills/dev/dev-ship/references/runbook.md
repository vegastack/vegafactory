# Runbook execution

How dev-ship runs a dev.md `## Ship` section and the ship situations the skill body doesn't spell out.

## Line prefixes

- `auto:` — do it, report the outcome. The release exception is below.
- `ask:` — stop and wait for the operator's word for that step; "ship it" does not cover an `ask:` line. The ship guard asks for every command such a line names in backticks, read from dev.md on the default branch, so editing dev.md in a branch cannot loosen it.
- `guard:` — a deterministic check. Run its command locally at this position in the runbook order; the CI copy of the same guard is the backstop and stays authoritative for anything that publishes. A failing guard stops the sequence exactly like a failing `auto:` step.

A failing step stops the runbook at that step: report what failed and what remains unrun, hand the failure to the operator (or to dev-implement's corrections loop when it's code), and never skip ahead. A gotcha — a step that surprised you or an instruction the operator had to repeat — is one proposed line folded into the runbook; if the gotcha is directional rather than operational, it's a decision-register candidate instead (on the user's yes, per dev.md `## Decisions`).

## The release exception to `auto:`

The issue's worktree is removed before the runbook starts, precisely because of this section: the runbook can stop here, and a cleanup queued behind a stop never happens.

An `auto:` line that opens or **merges** a release PR is the one `auto:` step that still waits. The recorded "ship it" binds to an issue and its branch, and the guard matches a merge to that branch; a generated release branch has no issue, so there is no recorded word for the guard to find and it asks. Run the runbook up to that point, report what landed, and hand the release PR's merge to the operator. That is the honest state, not a step skipped to be helpful.

The tag is not part of that exception: `vegafactory ship release <n>` re-reads issue n's own recorded "ship it", checks that the version and its changelog entry agree, requires the default branch checked out, clean and level with origin, and then creates and pushes `v<version>` itself. The guard allows that one verb, spelled plainly with the issue number, while raw `git tag` and tag pushes keep asking. It never publishes — the tag-triggered workflow does — and it refuses (exit 2) rather than tagging anything it cannot prove, so a refusal leaves the repository as it was.

## Release batching (`release: on-request`)

"Release" covers everything merged since the last release. Enumerate it: `git log <last-tag>..HEAD --oneline` (no tags yet → everything since the first commit). Before running the release steps, check completeness — every behavior-changing merge in that range has its changelog entry per the `changelog:` knob. A missing entry is corrections work on a fresh branch, not a reason to hand-write the release record.

## Bot PRs (Renovate, Dependabot, …)

A bot PR has no issue, no brief, no evidence comment — and merging it is still shipping. Green checks qualify it; only the operator's explicit word merges it, per PR or per an explicitly named batch ("merge this Renovate batch"). No standing approval exists: a knob, a schedule, or past practice never merges a bot PR. Red-flag updates (majors, security advisories) get named to the operator before their merge word is acted on.

## Rollback and hotfix

- Rollback is never a force-push or history rewrite. Follow the Ship section's rollback line — the shape is always roll-forward: revert or fix on the default branch through the normal flow, release/deploy the good state as a new version.
- A hotfix is a normal issue at higher priority: brief (short is fine), ack, implement, evidence, "ship it". Urgency compresses the words, never removes them.

## Guard failure at ship time

A local `guard:` failure (missing changelog entry, tag/version mismatch) means the branch or release prep is incomplete: route it to dev-implement's corrections loop, get the evidence comment updated, then resume at the failed step. Never edit release artifacts inline just to get past a guard. `vegafactory ship check <n>` speaks the same language: exit 0 pass (warnings printed, never blocking) · 2 blocked with its reasons printed — a 2 routes to corrections exactly like a failing `guard:` line, or to the operator when the missing fact is their "ship it".

## Worktrees at ship time

One feature, one worktree — the full scenario matrix lives in `dev-implement`'s `references/worktrees.md`; what ship owns is the end of it.

- **The check runs where the branch is.** Run `vegafactory ship check <n>` from the issue's worktree: it finds the branch from the current one (or the single `origin` branch naming the issue; `--branch` overrides) and refuses uncommitted changes there.
- **One PR per issue.** An epic's sub-issues are ordinary issues: each gets its own branch, worktree, evidence comment, "ship it" and PR. The epic itself holds the map and never carries a diff, so it never gets a PR — it closes when its last sub-issue merges.
- **After the merge, the directory goes and nothing else.** `vegafactory worktree remove <n>` fetches the default branch, then removes the checkout when it is clean, pushed, merged and unlocked — merged by ancestry or, after a squash or rebase merge, by content; it fails closed and reports which of those did not hold. The local branch and the remote branch are separate operator words, on the always-ask list.
- **Parked worktrees are pruned, not swept.** `vegafactory worktree prune --older-than <window>` pushes an unpushed candidate first, removes only `parked` worktrees past `worktree-retention:` (the window is what lifts the not-merged rule there), and keeps every branch. `--force` on `remove` and branch deletion always take the operator's word.

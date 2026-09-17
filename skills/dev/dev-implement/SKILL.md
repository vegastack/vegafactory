---
name: dev-implement
description: Implement an approved GitHub issue end to end without further user input. Use when given an issue to build — "do issue 12", "implement" plus an issue URL or number, "pick up the next ready issue", "go dark on" an issue — when resuming a dead or compacted session's working issue the operator hands over, when returning to apply corrections the user left on a ready-to-ship issue, or for a trivial fix asked directly in chat — one or two files, no new dependency. Not for a new feature or capability asked in chat, or writing or approving issues (dev-intake), planning them (dev-plan), reviewing finished work (dev-review), or creating PRs and merging (dev-ship).
---

# dev-implement

Act: implement approved work and return evidence in its issue.

One issue/session: check → claim → build → verify → review → evidence. The operator reads the result in the issue; PRs and merges are `dev-ship`'s, on the operator's word. The status-comment discipline lives in [ledger-and-resume](references/ledger-and-resume.md).

Nearest neighbors: `dev-plan` supplies the tasks; `dev-review` judges execution. Route unresolved decisions through `waiting-on-operator`; never guess. dev.md's knobs govern this skill; its `## Architecture` section governs stack-touching choices.

## Direct requests — trivial only, tightly bounded

When the operator asks in chat for a change, their words are the approval — build, verify, report; no issue needed. The bound is trivial: a behavior change beyond the asked words, a new dependency, or more than 1–2 files routes to `dev-intake` instead. Branch `<type>/<slug>`, in its own worktree like everything else ([worktrees](references/worktrees.md)); the changelog and chronicle rules apply when behavior changes; shipping still goes through dev-ship's words.

## Check — all must hold, or stop and say which failed

- Read the issue through the cache: `vegafactory issue sync <n>` and read the files it lists (keep the cursor; later syncs pass `--since <cursor>` and you re-read only what changed).
- Run the guard: `vegafactory issue check <n> --for implement --json` (add `--resume true` for a resume or corrections run). Exit 2 stops you with its reasons: wrong state or size label, open blockers, or no valid plan ack (a person with write access acked this exact brief and plan). Warnings go into the progress list.
- Then the judgment checks: read the brief's touch points in the current code, because they drift between the ack and the build — the version-impact line, volatile dependency claims per `dev-architect`'s verify protocol, and a medium issue's plan included. A material decision left open — even outside a formal Assumptions section — or reality contradicting brief or plan is a stop: one `handback` comment with the smallest question, `waiting-on-operator`.
- Resume unfinished work only within its original ack, using [ledger-and-resume](references/ledger-and-resume.md): brief → plan → status comment → `git log` on the issue branch. Restore a missing worktree with `vegafactory worktree restore <n>`. Another session's claim is taken back only on the operator's word: `vegafactory issue claim <n> --harness <h> --model <id> --take-back-by <their login>`.

## Claim

One session owns one issue. Cut the branch and its worktree with `vegafactory worktree create <n> --json` (the slug and type come off the title; the full matrix is [worktrees](references/worktrees.md)), then claim from inside the worktree: `vegafactory issue claim <n> --harness <claude|codex> --model <id>`. Exit 2 means another session holds it — stop and name the holder. A claim moves `queued` → `in-progress` and starts the heartbeat, which the hooks keep alive; after a take-back they stop file and shell tools in the old worktree. No dependencies are installed; run dev.md's `setup` command in the worktree when a step needs them. Then write the status comment with `vegafactory issue status <n>` as your first write. Record each task's base sha before starting it. A hand-back to `ready-to-ship` assigns the issue's operator and releases the claim (`vegafactory issue release <n> --reason "handed back"`), so the operator's notification is GitHub's own.

## Build — dark, test-first, checkpointed

No questions. Every progress checkpoint is also the chat update — one text, two destinations — and in a headless run the issue is the only channel. You never commit for safety: the Stop hook commits a dirty worktree as `wip: #<n> turn checkpoint` and pushes the branch at the end of every turn. A `fix:` issue's diagnosis runs under `dev-debug`, whose phases govern the investigation and whose winning suspect feeds the evidence comment. A spike the brief flagged runs first; its result opens the evidence comment. Then work the plan task by task:

- **Red before green**, because a test written after the code proves only that the code runs. Write the failing test first — at the seams the brief names, and only there, because a seam the brief did not name is one review cannot judge — watch it fail for the stated reason, implement the minimal code, watch it pass. One slice at a time. The tests-are-real rubric (implementation-coupled, tautological, horizontal-sliced — `dev-review` defines it) applies to your own tests before a reviewer sees them.
- **Checkpoint the status comment** after every task (`vegafactory issue status <n> --progress-file <file>`) and tick the matching `[x]` in the plan comment in the same pass — the reference says why both writes matter.
- **Tasks inside one issue run in order.** Parallel work happens only across sibling sub-issues of an epic whose briefs list non-overlapping files — each sibling is its own issue, branch and worktree, built by its own session.
- The scope ratchet is a stop condition: work revealed bigger than the issue's size (or plainly exceeding one session) → one `handback` comment proposing the upgrade or split (dev-plan's ratchet rules), `waiting-on-operator`, stop.

The acked brief and plan are the scope. Extras you notice go in the evidence comment's Not done / limits line as a follow-up note, not in the diff; an assumption you had to make is stated in the summary. Tests are sized like their neighbours — one focused test per behaviour the brief states, at the seams it names. When the code can just change, change it: no feature flag, compat shim or parallel path for a caller that does not exist, because each is a moving part nobody asked for. Decide routine things yourself and record the rulings in the progress list; a structural choice — a new dependency, table or service — checks `dev-architect`'s trigger discipline first, and a moving part with no named trigger is a stop condition. Hitting any stop condition — the brief's out-of-scope section, dev.md's stop-list, the scope ratchet — ends dark mode with one `handback` comment stating the smallest decision needed, your recommendation attached — and where that decision has options, the handback comment carries the round rendered by `scripts/questions.mjs`, so the operator's reply parses like any other (`references/ask-route.md`).

**Honesty over green**: a failing test gets fixed at the root or reported as failing, because weakening a test, an assertion, or acceptance to pass is a cover-up, and cover-ups surface at review with interest.

## Changelog and chronicle — before hand-back

Every behavior-changing branch carries its changelog entry per dev.md's `changelog:` knob and, when dev.md says `chronicle: on`, its story entry — both on the branch, landing atomically with the merge; the per-knob mechanics and the entry's first-line rule live in [changelog-and-chronicle](references/changelog-and-chronicle.md). Docs the brief names as affected get updated in the same branch.

## Verify — the gate function

Before claiming any status, run the proving command fresh and read its exit code (conventions' verification gate); a subagent's diff or report file is evidence, its say-so is not.

- Run what dev.md's `tests:` knob requires; a `risky` issue gets focused security, failure, and recovery checks on top; a `## Verify` runbook means run the app and smoke-check the flows it names. Post-release checks live in `## Ship` and belong to dev-ship.
- Run dev.md's `check` command (fast checks plus the tests your change reaches). The full suite and the skill scan run once, in the merge queue; a scan finding there comes back as a correction, and a new suppression needs the operator's word.
- UI changed and `ui-evidence: playwright` → capture screenshots of the key states and upload each with `node <path-to-this-skill>/scripts/evidence-upload.mjs --repo <o/r> --issue <n> --file <png> --write --json` — it reads dev.md's `evidence-repo:` knob and names the file `<this-repo-name>/<issue-number>/<timestamp>-<name>.png` (dry-run without `--write`; exit 2 says what it refused). Link them in the evidence comment as links, because private-repo images don't render inline. Evidence repo unreachable → name local paths and say so, and the hand-back proceeds, because evidence is a link, not a gate.
- dev.md's Ship or Verify section is an empty TODO next to visible machinery → finish normally, then suggest re-running dev-setup.

## Independent review — the other tool

Announce it, then run `vegafactory review <n>` from the worktree: the other tool (Codex↔Claude) reviews the diff read-only and the CLI posts the one review comment. Exit 0 is clean; exit 2 means fix the must-fix findings, commit, push and run it again — the same reviewer session picks up from the fix diff, three rounds at most. `dev-review` owns the axes, severities, comment format, the fix loop and the one fallback when the other tool is missing. Disagree with a finding → say so openly in the evidence comment with the reason, because a dropped finding is a decision made in secret. A hand-back from the command is never a pass: the issue goes to `waiting-on-operator` with its reason.

## The evidence comment — exactly one, edited in place

```markdown
<!-- vsk:v1 type=evidence rev=1 branch=<name> sha=<sha7> -->
## Result (v1)
**Done:** what changed, in behavior terms
**Tests:** <command> → <fresh result>
**Review:** <reviewer tool> round <n> — <verdict>; disagreements and deferred minors, in order made
**Changelog:** <entry added / none, with reason>
**Docs:** brief v<n>, plan v<n> — in sync | unchanged since the ack
**UI evidence:** <links>            (when applicable)
**Decision:** <register-format proposals>   (only choices passing dev.md's Decisions test)
**Not done / limits:** the honest list
Branch: <name> @ <sha7>
```

The tail's sha stays bare, because GitHub auto-links it once the branch is pushed while a hand-written `/commit/` link 404s until then. The `**Review:**` line is the one home of surfaced judgment calls: every progress `Ruling:` and every finding you did not fix appears there, in the order made. Run `node <path-to-this-skill>/scripts/evidence-check.mjs --file <draft> --issue <n> --json` before posting — it checks the draft's shape and, with `--issue`, that the plan comment's `[x]` boxes reflect the status comment's completed tasks; exit 2 means fix, don't post. The evidence comment is the operator's whole read: one line per field, the Not done / limits list complete, and the closing recap repeats it in under 150 words. Post it with `vegafactory issue comment` (later edits: `issue edit-comment … --since <cursor>`), run `vegafactory issue label <n> --state ready-to-ship` with the assignee moved to the operator, and stop; the recap repeats the evidence content rather than replacing it.

## Corrections loop — code and docs move together

A new comment from a person with write access on a `ready-to-ship` issue is the new frontier. If it says "ship it", that is dev-ship's (record it with `vegafactory issue ack <n> --stage ship --by <login> --quote …`). Anything else is a correction: the input is every such comment since the hand-back. Corrections reuse the same worktree, restored if gone, and claim the issue again. Applying a correction is one pass: the code change + the affected brief/plan sections edited to match (revision markers bumped, `Revisions:` line appended) + a progress line + the evidence comment updated in place — its `sha` to the new head and its `Docs:` line to the new revisions. Run the checks the correction touched. An operator dismissal of a review finding gets appended to `.vegastack/review-known-patterns.md` with its "Still flag if:" clause. Then back to `ready-to-ship`. A correction that changes scope goes back through `waiting-on-operator` and a fresh ack; any other lands without one.

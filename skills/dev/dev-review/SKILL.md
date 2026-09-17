---
name: dev-review
description: Independent cross-tool review of finished implementation work — a diff against its brief and plan, reviewed by the other tool. Use when dev-implement's review step runs, when asked to "review this branch/diff/issue", "give this a second pair of eyes", "check the finished work on issue N", or when review findings need a fix loop, re-review, or a hand-back. Not for reviewing an unbuilt plan (dev-plan's approval gate), architecture review (dev-architect), shipping gates (dev-ship), scanning skills for vulnerabilities (skill-scan), or generic PR review in repos outside this workflow.
---

# dev-review

Advise: report every verified finding with its severity, or the verified absence of findings — the fix loop downstream is the filter.

Review runs on the **other tool**: Codex reviews what Claude Code built, Claude Code reviews what Codex built. One command does it:

```sh
vegafactory review <issue-number>
```

Nearest neighbors: `dev-implement` runs this after its Verify gate and applies the findings; `dev-ship` cannot pass without it — `vegafactory ship check` requires a clean review on the exact commit that would merge; `dev-plan`'s approval gate reviews plans, this skill reviews built work.

## What the command does

Run it from the issue's worktree with nothing uncommitted — the packet describes a commit, and a file the reviewer can read but the diff does not carry is not reviewed at all.

1. Builds the packet: the brief's acceptance criteria, the plan's task list, `git diff --stat`, the changed files, and the diff with five lines of context against the base (default `origin/<default branch>`, `--base` to override).
2. Starts the other tool read-only in that worktree with the packet on stdin — no shell string, no read limit: the reviewer may read any file it needs. Model and effort come from dev.md's `harness-policy:` `review` entry when it names that tool; otherwise the tool's own default stands.
3. Takes back JSON — a verdict plus findings with id, axis, severity, file, line, issue and fix — and validates it. One malformed or stuck run is retried once, then the command hands back.
4. Posts the single review comment itself, binding the verdict to the commit *and* to the brief and plan the reviewer read. **The reviewer never writes to GitHub**, so what lands is exactly what it returned. Edit a requirement and the review is stale: the command runs again and the ship check refuses until it does.
5. Exits 0 clean · 2 needs-fixes or hand-back · 1 error.

Axes: spec (against the acceptance criteria and plan), bugs, security, and style only where a documented rule exists. Large or `risky` diffs split into two parallel reviewers and the findings merge; everything else is one run. Details and the full flag list: [flow](references/flow.md).

## The fix loop — 3 rounds, then the operator

Fix the must-fix findings, commit, push, then run the same command again. It resumes the **same reviewer session** on this machine and sends only the fix diff and the open finding ids, so a round costs a fraction of the first pass. On another machine the session is gone: a fresh reviewer starts with the previous findings JSON from the review comment.

- Only must-fix findings block. Should-fix and nit are fixed opportunistically or recorded as deferred minors in the evidence comment.
- Disagree with a finding → say so openly in the evidence comment with the reason and the cost if you are wrong; a finding dropped in silence is a decision made in secret. An operator dismissal is appended to `.vegastack/review-known-patterns.md` (seed: [template](assets/review-known-patterns.md.template)) so it stays dismissed.
- Three rounds is one **cycle**, not the end of the road. After round 3 the command hands back — but commit the fixes, or change the brief or plan, and the next run opens cycle 2 at round 1 with the open findings to re-check. Running it again with nothing changed hands back again, which is what the cap is for. **A review is never skipped** — a stuck or failing reviewer is a hand-back, not a pass, and the ship check refuses a commit with no clean review of its own.
- The operator's one way past open findings without another cycle, and only once the third round is spent, is their own comment on the issue with the acceptance on a line of its own — `accept review round 3 @ abc1234` — posted after that review. Never write it for them, any more than you would write "ship it"; a negated or quoted line, an earlier round, a `vsk:v1` marker or a bot author all count for nothing.

## The review comment

The command writes it; read it, never hand-write it. One comment per issue, edited each round, marker always current:

```markdown
<!-- vsk:v1 type=review round=2 sha=abc1234 agent=codex verdict=needs-fixes -->
## Review — round 2 @ abc1234

**Verdict: needs-fixes** — must-fix 1 · should-fix 0 · nit 2
```

Each finding renders as a bold **Finding [F1]** line carrying its severity, its path and line, and its axis, then the problem and the fix. Nits collapse into a `<details>` block, earlier rounds keep one summary line each, and a `Findings JSON` block at the bottom is what a fresh reviewer on another machine reads. Finding ids are `[F1]`, never `#1`, because `#1` auto-links to an issue.

## Noise controls

- Quiet by default: spec, bugs and security always; style only where a documented rule exists.
- `.vegastack/review-known-patterns.md` goes into every packet as project policy, read from the base commit — an edit on the branch under review is part of the diff, not a suppression. Each entry needs a **"Still flag if:"** clause; a suppression without one is a blind spot, not a calibration.
- A CI scanner finding (skill-scan in the merge queue) comes back as a correction on the issue, judged like any other finding: suppressed rather than fixed is itself a finding.

## When the other tool is missing — the fallback

Only when the other tool is not installed or not signed in (`vegafactory review` says so): run the same axes as fresh subagents in this session, label the result plainly as a **same-tool self-review** in the evidence comment, and tell the operator that cross-tool review is off until the other tool is installed. The command proves the gap first — it probes the other tool and refuses `--record` while that tool answers, unless the operator allowed a same-tool review for this head in a line of their own. Run the axes as fresh subagents and hand the findings back with `--record`, so the comment carries the same bindings, says `mode=same-tool`, and names why it was allowed: the axis briefs and the exact command are in [fallback](references/fallback.md), the security axis method in [security-axis](references/security-axis.md). Independence is the one thing this fallback lacks, so never call it cross-tool.

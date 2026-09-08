---
name: dev-review
description: Independent review of finished implementation work — a diff against its brief and plan. Use when dev-implement's review step runs, when asked to "review this branch/diff/issue", "give this a second pair of eyes", "check the finished work on issue N", when a cross-agent session (Claude or Codex) is handed a REVIEW REQUEST, or when review findings need a fix loop, re-review, or adjudication. Not for reviewing an unbuilt plan (dev-plan's approval gate), architecture review (dev-architect), shipping gates (dev-ship), scanning skills for vulnerabilities or vetting a skill you did not write (skill-scan), or generic PR review in repos outside this workflow.
---

# dev-review

Advise: report every finding with its confidence and severity, or the verified absence of findings — the loop downstream is the filter.

Fresh reviewers report findings or their verified absence, with bounded fix loops and recorded dismissals. Briefs: [dispatch-prompts](references/dispatch-prompts.md).

Nearest neighbors: `dev-implement` invokes this per dev.md's `review:` knob and applies the findings; `dev-ship` consumes the verdict marker; `dev-plan`'s approval gate reviews plans, this skill reviews built work.

## Inputs — files, not pasted context

Build the review package first — `git log --oneline <base>..<head>` + `git diff --stat` + `git diff -U10` — at `.vegastack/.tmp/<issue>-<slug>/review-<base7>..<head7>.diff`. Reviewers get paths — the brief (issue body), the plan comment, the package file, the project's `.vegastack/review-known-patterns.md` — plus the binding constraints copied verbatim, ordered data first and ask last, as the dispatch prompts show. **Read the file before judging it** — the full files where the diff needs context, because a diff-only read misses invariants. Reviewers write full reports to `.tmp` files and return short status, so a dead reviewer's findings survive on disk.

When dev.md names a `skill-scan:` root, the security dispatch also gets the scan report, at `.vegastack/.tmp/<issue>-<slug>/skill-scan.json`, produced by `node <path-to-skill-scan>/scripts/skill-scan.mjs --json` — the `skill-scan` skill owns running it, its knobs, and its baseline. The same guard already ran at `dev-implement`'s Verify gate; this axis triages what sits below the blocking bar and judges whether anything above it was suppressed rather than fixed.

## The axes — parallel, fresh, reported separately

| Axis | Runs | Judges |
|---|---|---|
| **Spec** | always | the diff vs the current brief + plan: missing, scope creep, implemented-but-wrong — quoting the brief line per finding; includes the tests-are-real rubric |
| **Standards** | always | project rules (known-patterns file + repo docs, which override) + the fixed smell baseline pasted in full into its prompt |
| **Security** | on `risky`, when touch points hit auth, money, user data, or external input, or when the diff touches a skill under dev.md's `skill-scan:` root | data-flow traces, exploitability before severity, and triage of the skill scan's findings — method in [security-axis](references/security-axis.md) |

Each axis uses a fresh subagent without implementation memory and reports separately. Report every finding with confidence/severity; the loop filters findings.

**Dispatch without pre-judgement** — a brief saying what not to flag ("do not flag…", "don't treat X as a defect", "at most minor") hides a false positive that belongs in the open adjudication below.

## The review comment — one per cycle, rounds appended, marker always current

One comment per cycle. Edit its top marker every round to the newest `round`/`sha`/`verdict`, because the first marker is the one consumers (ship-gate) read. Prior rounds stay as plain sections below, without markers or active JSON bindings. Publish one fenced JSON `reviewBinding` as defined in [conventions](references/conventions.md): full commit/base IDs, canonical plan scope digest, verdict and stable open/resolved finding IDs. Keep the marker and binding identical; legacy reviews need renewal.

```markdown
<!-- vsk:v1 type=review round=<n> sha=<full-head-sha> agent=<claude|codex> verdict=<clean|needs-fixes> -->
## Review — round <n> @ <sha7>

**Verdict: <clean|needs-fixes>** — spec: <counts> · standards: <counts> · security: <counts | n/a (no surface)>

### <Axis> axis
**Finding [N]: <title>** — **[SEVERITY]** (confidence: high|medium|low) `path/file.ts:42`
<issue> / <why it matters> / <fix, fenced snippet> / <quoted brief line, spec axis>

<details><summary>Nitpicks and low-confidence (N) — non-blocking</summary>…</details>

Reviewed: <sha7> · axes: <list> · reviewer: <mode>
```

Severities: `[CRITICAL]` (security axis: exploitable now — blocks) > `[MUST-FIX]` (wrong, broken, or contradicts the brief — blocks) > `[SHOULD-FIX]` (convention or quality, does not block) > `[NIT]`. Finding IDs are `Finding [N]`, because `#N` auto-links to an issue. Low-confidence findings and nitpicks go in the collapsed block, because low-confidence items in the main list dilute it. Group one recurring defect across files into one finding with a location list. Each finding appears once with issue, impact and fix; collapse nitpicks.

## The loop — 3 rounds max, then open adjudication

`[CRITICAL]` and `[MUST-FIX]` findings enter the loop; `[SHOULD-FIX]`/`[NIT]` are fixed opportunistically or recorded as deferred minors, keeping the loop bounded.

- **Rounds 1–2:** resume (or redispatch) the implementer with the open findings verbatim and the report-file path. It fixes, re-runs the covering tests, appends its fix report to the same file.
- **Round 3:** a fresh implementer — "a prior implementer attempted this; read the report file for what was tried" — because a loop surviving two resumes means the implementer can't see its own problem.
- **Every round:** the re-review is scoped to the fix diff (`FIX_BASE..HEAD`, a new package file); the re-reviewer verdicts each finding **ADDRESSED / NOT ADDRESSED** ("attempted" is not addressed), new breakage in the fix diff joins the open list, and out-of-scope observations become deferred minors.
- **At the cap:** fix forward or bring unresolved findings to the operator. Only their explicit same-review decision can accept risk; record the typed `adjudication` in evidence and surface its rulings in the Review line and ledger. Negative prose or an agent’s parked ruling grants no exception. Early adjudication never shortens the loop.

Risky work requires tests and independent review. Every commit renews full-candidate review. After qualification, review all assembled child/preparation scopes; child reviews bind only their parent base. Transformations/delivery: dev-ship’s runbook.

## Noise controls — hard filters, not politeness

- Default quiet profile: spec, bugs, and security always; style only where a documented rule exists.
- `.vegastack/review-known-patterns.md` (seed: [template](assets/review-known-patterns.md.template)) holds the project's never-flag patterns — each entry requires a **"Still flag if:"** exception clause; a suppression without one is a blind spot. dev-implement's corrections loop appends operator dismissals there, so a dismissed pattern stays dismissed.
- The skill scan's suppressions follow the same discipline in the baseline the `skill-scan` skill owns, and its guard enforces the clause — a rule scoped `id:` with no `path:` is a repo-wide blind spot. A finding suppressed rather than fixed is a review finding, not a settled matter.

## A scan with no issue attached

A `skill-scan` run outside an issue — a standalone check, or the pre-publish guard in dev.md's `## Ship` — has no review comment to land in, so its findings go to intake as a `risky` issue, because a comment posted somewhere convenient is a finding nobody owns. Offer the operator one `risky` issue whose brief body carries the findings, their locations, and what is known about each cause; intake's questions, scope call and approval follow.

## Cross-agent — the independence upgrade

The dev.md `review:` knob maps to exactly three states — `subagent` (fresh-subagent axes always, no cross-agent), `cross-agent-risky` (subagent axes normally; the other agent on `risky` — the recommended default where the CLI exists), `cross-agent` (the other agent always). On the other agent, follow [cross-agent](references/cross-agent.md): announce the invocation to the operator at trigger time, send the `REVIEW REQUEST (vsk cross-agent v1)` handoff (`codex exec` from Claude; `claude -p` from Codex), and summarize the outcome at the end. The reviewing agent posts its own review comment (`agent=codex`), so independence is verifiable. CLI absent → the manual relay, noting that dev-setup recommends installing it. Which model and effort the other agent runs at is dev.md's `harness-policy:` `review` entry (`<stage> <agent> <model> <effort>`); with no such line, the reviewing harness's own default stands — never a guessed model id.

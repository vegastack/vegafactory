# Cross-agent review

The independence upgrade: the review runs on the *other* agent — Codex when Claude built the code, Claude when Codex did — so the reviewer shares no model, no session, and no authorship with the implementer. Used on `risky` issues by default and whenever dev.md's `review:` knob says `cross-agent`.

## Announce, invoke, summarize — the operator is never blind

1. **At trigger time**, tell the operator in plain language: "invoking Codex for the cross-agent review of issue #N" — before the call, not after.
2. **Invoke** non-interactively with the handoff below passed as ONE argument through an exec arg array — `execFile('vegafactory', ['agent', 'codex', 'exec', '-c', 'model=<model>', '-c', 'model_reasoning_effort=<effort>', handoff])` from Claude, `execFile('vegafactory', ['agent', 'claude', '-p', '--model', '<model>', '--effort', '<effort>', handoff])` from Codex — `vegafactory agent` drops the parent app's variables and refuses API-key billing — never interpolated into a shell string (the exact pattern this skill's own known-patterns template says to still-flag). `<model>` and `<effort>` come from dev.md's `harness-policy:` `review` entry; with no such line, drop both flag pairs and let the reviewing harness use its own defaults rather than inventing a model id.
3. **At the end**, summarize: which agent reviewed, the verdict, where its comment is, and what's worth the operator double-checking.

## The handoff — exact format

```
REVIEW REQUEST (vsk cross-agent v1)
repo: <absolute path> · issue: <url> · branch: <name> · range: <base7>..<head7>
brief: the issue description (marker type=brief) · plan: the issue comment
marked type=plan · package: <path to the review package file> · known-patterns:
.vegastack/review-known-patterns.md · conventions: references/conventions.md inside ANY installed dev-family skill
(e.g. .claude/skills/dev-review/references/conventions.md — every dev skill ships a copy)
axes: spec, standards[, security]
output contract: post exactly ONE issue comment in the review-comment format
(marker: <!-- vsk:v1 type=review round=<n> sha=<head7> agent=codex verdict=... -->;
the reverse direction writes agent=claude);
on a re-review round, EDIT that same comment — update its single top marker to the
new round/sha/verdict and append the round section below (never a second marker,
never a second comment),
findings as Finding [N] with severities [CRITICAL|MUST-FIX|SHOULD-FIX|NIT] and
path:line evidence; nitpicks and low-confidence collapsed in <details>.
writes: first run `vegafactory issue sync <n>` and read the files it names; post the
comment with `vegafactory issue comment <n> --file <path>`; on a re-review round
edit it with `vegafactory issue edit-comment <n> <comment-id> --file <path> --since <cursor>`.
constraints: READ-ONLY — never commit, push, edit files, or change labels; your
only write is that review comment.
```

The reviewing agent posts its own comment with its own `agent=` key — independence stays verifiable in the record, never paraphrased by the author.

## Fallbacks and failure honesty

- The other agent's CLI is not installed → fall back to the manual relay (tell the operator which agent to point at the issue), and note that `dev-setup` records the gap and recommends installing it.
- The invocation fails or times out → say so plainly, fall back to a fresh-subagent review, and label the evidence comment's Review line accordingly — never silently substitute and call it cross-agent.
- The other agent's review misses the output contract (no marker, no severities) → treat its content as raw findings: post them yourself in the correct format with `agent=` credited, and note the reformatting.

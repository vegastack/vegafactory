# Behavioral eval playbook

How to prove a skill improves agent behavior before tests cement it. The tooling is your own subagents (Claude Code's Task tool, Codex's `.codex/agents` spawns) and, once its early-access gate lifts and it reads this case format, `claude plugin eval` (status in Model guidance); write cases, never harnesses, viewers or graders of your own — one format is what lets results compare across skills and releases.

## Why eval before tests

Tests lock in behavior; if the behavior is mediocre, tests lock in mediocrity. The eval proves the quality bar first, then unit tests cement it. If you didn't watch an agent fail *without* the skill, you don't know the skill teaches anything.

## The case file — evals/evals.json

Every skill carries its cases at `<skill>/evals/evals.json` in the agentskills.io format — the format this playbook's procedure reads and the one `claude plugin eval` is expected to read once verified; never packaged (like `tests/`), and `structure.mjs check` warns when it is missing or malformed.

```json
{
  "skill_name": "<the frontmatter name>",
  "evals": [
    {
      "id": 1,
      "prompt": "what the user would type — paths, backstory, the hardest documented case",
      "expected_output": "one human-readable description of success",
      "files": ["evals/files/input.md"],
      "assertions": ["the plan comment has an Interfaces block per task"]
    }
  ]
}
```

- `id` is an integer, unique in the file; `files` are paths relative to the skill root under `evals/files/`; `assertions` is an array, empty until the first run.
- 2–3 cases per skill: realistic (file paths, backstory), varied in formality, one boundary case the skill should route elsewhere or refuse.
- `expected_output` is a sentence a human reads; assertions are objective and countable ("every finding carries `path:line`"), never exact phrasing.
- Write prompts first, add assertions after the first run — the outputs show what "good" looks like. Retire an assertion that passes in both arms; it measures the model, not the skill.
- `tests/fixtures/trigger-queries.json` stays the description-level fixture (would the skill load?); `evals.json` is the body-level one (did it help once loaded?).

## Running on Claude Code — claude plugin eval

```sh
claude plugin eval <skill-dir> --ablation with-without --runs 3 --max-cost-usd 5 --threshold 0.7 --json --no-publish
```

`--ablation with-without` runs the baseline arm; `--runs 3` makes a stddev meaningful; `--max-cost-usd` aborts with exit 2 rather than overrunning; `--threshold 0.7` because a with-skill arm failing a third of its assertions is not earning its tokens, while `1.0` turns every grader wobble into a red run; `--no-publish` keeps the report local. Results land at `<skill>/evals/results/<timestamp>/aggregate-result.json`, gitignored; the aggregate JSON of the gating run is pasted into the evidence comment.

## Running anywhere — the subagent procedure

The same cases, run by hand on any harness:

1. **Launch both arms per case in the same turn.** One subagent told to read and follow the SKILL.md at its path; one baseline given the identical prompt with no mention of the skill (when improving a skill, the baseline is a snapshot of the old version). Each dispatch carries the skill path or none, the task, the case's `files`, and an output directory.
2. **Write to `.vegastack/.tmp/<issue>-<slug>/<skill>-workspace/iteration-<n>/eval-<id>/{with_skill,without_skill}/outputs/`**, never beside the skill directory: discovery treats every directory in a group as a skill, so a sibling workspace breaks `bun run check` even when gitignored.
3. **Compare against the skill's claimed value**, reading transcripts, not just final outputs, into the result files below.

## Result files

The agentskills.io vocabulary, so a hand run and a runner run read alike:

- `timing.json` per arm — `{ "total_tokens", "duration_ms" }` from the task-completion notification, saved at once (it is gone with the next message).
- `grading.json` per arm — `{ "assertion_results": [{ "text", "passed", "evidence" }], "summary": { "passed", "failed", "total", "pass_rate" } }`; a PASS needs quoted evidence from the output.
- `benchmark.json` at the iteration root — `{ "run_summary": { "with_skill": { "pass_rate": { "mean", "stddev" }, "time_seconds": {…}, "tokens": {…} }, "without_skill": {…}, "delta": {…} } }`; `aggregate-result.json` is the runner's equivalent.

## Pass criteria

The with-skill run must be *materially* better on the dimensions the skill exists for:

- Output has the contract shape the skill defines (sections, verdicts, file layout) where the baseline's does not.
- The with-skill agent uses bundled scripts/templates instead of reinventing them; a helper both arms wrote independently should become a bundled script.
- No contract violations the checklist would catch (frontmatter keys, name grammar, missing pieces).
- The transcript shows the skill's guidance being *used*, not just loaded — sections nobody used are bloat to cut.
- **Colleague test.** Hand the SKILL.md alone, with no conversation context, to a fresh subagent and ask what it would do first and where it would look for the answer to one realistic request; any confusion is a defect in the skill, not in the reader, because the model that runs it never attended the design conversation.

**Failure that matters most:** the baseline matches the with-skill output. Then the skill is not earning its tokens — cut it, narrow it, or fold it into a reference.

## Trigger-query eval (description level)

The body eval assumes the skill got loaded. Separately, walk `tests/fixtures/trigger-queries.json` and judge, per query, whether an agent seeing only the skill list (name + description) would load this skill. Near-miss negatives are the valuable half — a description that survives them draws a real boundary. Fix failures by editing the *description* (triggers, boundary clause), never by stuffing workflow summary into it.

**Family-level re-run:** whenever a skill is added, renamed, or removed, re-run the trigger eval across the FULL installed set: cross-skill collisions (two descriptions claiming one query) only appear at family level, and the `ambiguous_with` entries in every skill's fixtures are the cases to walk first.

## Workflow skills — the sandbox drill

A skill whose value lives in a multi-turn, external-state workflow (gh labels, comments, branches) — dev-implement, dev-review, dev-ship — gets only partial proof from single-prompt runs: its cases cover the prose half (evidence comment, review comment, ship report). Its end-to-end proof is a **sandbox drill** — a throwaway repo walked through the real flow with the real tools — run before release-level claims, not per edit. Single-prompt evals remain the per-change gate; the drill is the workflow-level one.

## Cycle protocol (at most 3)

```
CYCLE 1: run evals → list concrete improvements → apply them to the skill files
CYCLE 2: re-run the SAME prompts → compare before/after → apply what remains
CYCLE 3: re-run → pass, or ship with KNOWN_GAPS
```

Hard stop after 3 cycles: endless polishing is worse than an honest gap list. Fix the pattern that caused the failure, never one prompt's wording. When a rule is not landing, prefer removing it to rewriting it and let the eval prove the need: a rule the with-skill run never used is bloat, and rules written for earlier models are often too prescriptive for the current one.

## KNOWN_GAPS format

Ships as a `## Known gaps` section at the end of SKILL.md when the eval did not fully pass:

```markdown
## KNOWN_GAPS

- gap: baseline-quality section ordering under multi-file inputs
  evidence: eval cycle 3, prompt "draft release notes for the 0.4 tag"
  why unresolved: would require restructuring the routing table
  next: revisit when references/format.md is split by artifact type
```

One entry per gap: `gap` / `evidence` (cycle + prompt) / `why unresolved` / `next`. The eval summary (prompts, cycles, verdict per prompt) goes in the PR body, not the repo.

## Model guidance

<!-- volatile: everything in this section decays; keep model facts out of SKILL.md and update here only. -->

- Runner status, 03-09-2026, Claude Code 2.1.247: `claude plugin eval` prints "plugin eval is currently in early access" and exits 1 for `init --bare` and for a run; `--help` shows it reads `evals/**/case.yaml` or `prompt.md + graders/*.md`. Until the gate lifts and the invocation above is verified against a bare `skills/<group>/<name>/` directory, the subagent procedure is the Claude-side proof too; re-probe with `claude plugin eval init --bare probe` in a scratch directory and update this line's date.
- Run both arms of every comparison on the **same model** — otherwise you measure the model gap, not the skill.
- Use the model that will actually run the skill in production (typically the one powering the current session); a weaker grader cannot judge a stronger writer.
- If a separate grading pass is used, grade blind: give the grader both outputs unlabeled and ask which better satisfies the skill's stated contract.

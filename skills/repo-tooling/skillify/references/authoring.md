# Authoring reference

Rules for writing the parts of a skill that determine whether it triggers, how much it costs, and whether it stays true over time.

## Description engineering

The description is the primary triggering mechanism: it is always in context, and the agent decides from it alone whether to load the body.

- **Triggering conditions only — never the workflow.** A description that summarizes the process becomes a shortcut: agents follow the summary and skip the body. State when to load the skill, not what the skill will do step by step.
- **Calm conditionals.** Write the trigger as "Use when …" with the phrasings users type and one "Not for …" clause — the standard and its reason are skill-maintainer's operating rule 4; this file only shows the shape.
- **Third person.** The text is injected into a system prompt ("Creates and audits...", "Use when..."), never "I can help you...".
- **Front-load trigger words.** Harness skill lists truncate long descriptions; the first clause must carry the strongest triggers.
- **Cover the ways users actually ask.** Exact phrases in quotes, symptoms, file types, adjacent phrasings, casual variants. Include the situations where the skill competes with a neighbor and should win.
- **Name the boundary.** One clause on what the skill is NOT for prevents over-triggering ("Only for skills inside this repository...").
- **No angle brackets** — the repo validator rejects them.
- **No `#` after a space.** The description is an unquoted YAML scalar, and real harness parsers treat ` #` as a comment start — everything after it silently vanishes from the skill listing. Write "issue 12", never "issue #12"; the repo validator rejects it.

Bad: `Helps with skills.` (no triggers, no boundary)
Bad: `Audits a skill by scoring checklist items, then scaffolds, evals, and wires it.` (workflow summary — the body will be skipped)
Good: `Use when asked to "skillify this", "make this a skill", audit a skill's completeness, or decide whether a workflow should become a skill. Only for skills inside this repository.`

## Writing style

Rules for the prose itself — they exist because agents pay attention (and tokens) for every sentence, and because rule corpora rot in predictable ways:

- **Prompt the positive.** Steering by prohibition drags the forbidden behavior into context and invites a wall of NEVERs that only ever grows. State the rule you want followed, once, with the reason it matters. Reserve negation for genuinely dangerous acts.
- **Explain why, not ALL-CAPS what.** Modern models have good theory of mind; a rule with its reason generalizes, a bare MUST gets pattern-matched and misapplied. Reaching for caps or bold on every rule is a sign the rule needs a reason, not emphasis.
- **Hunt no-ops and sediment.** A no-op is an instruction the model already obeys by default — it pays load to say nothing. Sediment is case law: a clause added for one past failure that never gets removed. When a failure exposes a gap, rewrite the existing rule in place; do not append an exception. Prune by deleting whole sentences, not trimming words.
- **Budget the body.** Target 50–150 lines for a SKILL.md; treat 300 as the ceiling (the spec's 500 is a far bound, not a budget). One great example beats five mediocre ones. Anything only some invocations need goes behind a routed reference.
- **Name the nearest neighbor.** One sentence in the body stating which existing skill is closest and the axis of difference. It keeps trigger families sharp better than any linter, and forces the merge conversation before a near-duplicate ships.

## Numeric limits

The numbers — name and description limits, body ceiling, and the Claude Code and Codex listing budgets — live in one place: skill-maintainer's Hard limits table, mirrored from the marked sentences in its references/standards.md and refreshed through its registry. Cite them per skill-maintainer's standards; a second copy here drifted once and would again.

## Trigger query sets

Every skill ships `tests/fixtures/trigger-queries.json`: an array of `{"query": "...", "should_trigger": true|false}`, with an optional `"ambiguous_with": ["skill-name"]` on entries where a neighboring skill competes for the query.

- About 10 queries total: 5–6 should-trigger, 4–5 should-NOT-trigger. A small set of hard queries beats a long set of easy ones.
- Should-trigger: different phrasings of the same intent — formal, casual, typo-ridden; cases that never name the skill but clearly need it; at least one `ambiguous_with` case this skill should win against its nearest neighbor.
- Should-NOT-trigger: **near-misses only.** Queries sharing keywords or domain with the skill but needing something else — adjacent intents, ambiguous phrasing a naive keyword match would catch. "Write a fibonacci function" as a negative for a PDF skill tests nothing.
- Queries must be realistic: concrete detail, file paths, a little backstory — what a user would actually type, not abstract category labels.

The set is both a design artifact (it forces the description to draw a real boundary) and eval input (see the [eval playbook](eval-playbook.md)).

## Token economy

Three loading levels; spend accordingly:

1. **Metadata (name + description)** — in every conversation, always. ~100 tokens. Every word must earn its place.
2. **SKILL.md body** — loaded on every trigger. Keep the workflow, one excellent example, and a routing table; push everything else down a level. One great example beats five mediocre ones.
3. **references/ / scripts/ / assets/** — loaded or executed on demand; effectively unlimited, but give each reference a clear routing condition so agents read only what the task needs.

Cross-reference other skills by name (`skill-maintainer`) instead of restating their content. Don't document a script's flags in prose beyond what routing needs — the script's own `--help`/usage error is the source of truth.

## Scripts vs instructions

**Deterministic and repeated → script. Judgment → instructions.**

- If two invocations with the same input must produce the same bytes, that is a script.
- Watch eval/test transcripts for agents independently rewriting the same helper — three subagents each writing their own `parse_frontmatter` is a strong signal the skill should bundle that script once.
- Repo conventions for bundled scripts: dependency-free Node (`.mjs`), runnable from the skill dir with plain relative paths, `--json` for machine-readable output, documented exit codes (0 ok / 1 finding-or-refusal / 2 usage), atomic writes (stage then rename), symlink refusal, and an explicit `--write` gate for anything mutating — dry-run is the default.
- Do NOT script judgment: descriptions, verdicts, review prose. A script that fakes judgment produces confident garbage.

## Volatile facts

One rule: **version pins, model names, numeric limits, URLs, and anything with a date live in a references file — never inline in SKILL.md.** Each such line carries its checked date and an official source link, for example `(checked 17-09-2026 · https://…)`. A fact older than 60 days is re-checked against its link before a skill relies on it.

## Worked example: skillifying a "release-notes" workflow

```
Phase 0: yes — run at every release, ~80 lines of conventions, trigger "draft the release notes";
  nearest neighbor is skill-maintainer (release wiring) — different axis, proceed
Phase 1: 0/8 (new)
Phase 2: triggers "draft/write the release notes", NOT "write a changelog entry for this PR";
  output = CHANGELOG section + npm summary; volatile: none owned → evergreen waiver
Phase 3: scaffold-skill.mjs release-notes --dir . --write (wiring done by the scaffolder);
  description + 10 trigger queries incl. ambiguous_with skill-maintainer; body + references/format.md;
  no scripts (judgment-heavy, item 5 N/A)
Phase 4: eval cycle 1 — baseline subagent invents section headings, with-skill misses breaking-change
  callouts → add callout contract to SKILL.md; cycle 2 — with-skill clearly better, baseline still
  wrong shape → pass
Phase 5: trigger fixture locked; volatile facts dated; root README row description filled in
Phase 6: bun run check:fast and bun run test:affected green; 8/8 → properly skilled
```

## Anti-patterns

- Writing lock-in tests before the behavioral eval — locks in mediocrity.
- A description that summarizes the workflow — agents follow the description and skip the body.
- Skipping the baseline run because "the output looks fine" — that is not evidence.
- Eval without a fix cycle — vanity metrics.
- Obviously-irrelevant negatives in the trigger query set — near-misses or nothing.
- Version pins or model names in SKILL.md — volatile facts live in dated references files.
- Multi-intent skills spanning unrelated triggers — split them.
- Two skills answering the same trigger — merge or kill one.
- Steering by prohibition — a wall of NEVERs drags the forbidden behavior into context and grows forever; state the positive rule once and explain why it matters.
- Patching every observed agent failure with a new clause — that is sediment; rewrite the existing rule in place instead of appending case law.
- Unit tests for prose — a test asserting a markdown file contains a phrase proves nothing the eval didn't.
- Building eval tooling — the runner and the subagent procedure exist; write cases, not harnesses.

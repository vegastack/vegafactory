---
name: skillify
description: Repo-local skill factory and auditor for the vegafactory monorepo. Use when asked to "skillify this", "make this a skill", "turn this workflow into a skill", or scaffold a new skill under skills/; when asked to "audit this skill", "is this skill complete", "check skill completeness", or score a skill against the repo contract; when deciding whether a workflow, script, or prompt should become a skill at all; when a skill description under- or over-triggers and needs tuning; or when a skill in this repo is missing tests, a README, a refresh contract, behavioral eval evidence, or repo wiring. Only for skills inside this repository, not for authoring skills in other projects or installing third-party skills.
---

# Skillify

Turn a raw workflow into a properly-skilled unit of this monorepo, or audit an existing skill against the repo contract in CONTRIBUTING.md. skill-maintainer is the nearest neighbour: it owns the standards and the repo and release operations (what must be true); skillify owns the procedure (how a skill gets there) and cites those standards rather than restating them.

## The contract checklist

Score every item pass / fail / N/A; N/A without a one-line rationale is a fail, and a justified N/A counts as a pass in the `<passed>/8` score. "The evidence" below is the audit report or the issue's evidence comment. skill-maintainer lives at `skills/repo-tooling/skill-maintainer/`. Numbering is stable and additive, so other skills can cite "skillify item 6".

1. **SKILL.md spec-compliant** — frontmatter, name grammar, description limits, and body syntax per skill-maintainer's standards (operating rules 2–6); body ≤1,200 words with detail routed to references, or a named exception in the evidence; `node packages/cli/scripts/validate-skill.mjs <skill-dir>` (the check `bun run validate:skill` runs over every skill) agrees, and it also verifies every relative link in the skill's prose resolves. Body words: the text below the frontmatter, `wc -w`.
2. **Description triggers well** — states triggering conditions only (never the workflow), shaped per [authoring](references/authoring.md), the standard being skill-maintainer's rule 4; a query set of realistic positives and near-miss negatives at `tests/fixtures/trigger-queries.json`, `ambiguous_with` naming the competing skill. `scripts/trigger-check.mjs` (`validate:triggers` in `bun run check`) blocks when two fixtures claim one query without naming each other.
3. **Sharp boundary** — the SKILL.md body names its nearest-neighbor skill and the one-sentence axis of difference (or states it has none). Two skills answering the same trigger get merged, not shipped.
4. **References routed** — `references/` holds detail only some invocations need, behind a routing table; SKILL.md keeps the workflow, one excellent example, and the routes. N/A for a self-contained skill.
5. **Scripts deterministic and tested** — bundled scripts follow the conventions in [authoring](references/authoring.md) (dependency-free Node, `--json`, documented exit codes, dry-run default, atomic writes); unit tests cover every deterministic branch. N/A when the skill ships no scripts — its quality bar is item 6.
6. **Behavioral eval passed** — the cases in `evals/evals.json` run with-skill vs baseline per the [eval playbook](references/eval-playbook.md), at most 3 improve cycles; pass, or ship with a `## Known gaps` section at the end of SKILL.md.
7. **Freshness honest** — volatile facts (versions, model names, limits, dated claims) live in a references file, each with its checked date and official source link, never in SKILL.md.
8. **Wired and green** — `agents/openai.yaml`, packaging entry, root README row, and changeset in place; `bun run check:fast` and `bun run test:affected` pass.

**Verdict:** all pass → `properly skilled`. At most two misses, neither item 1 nor item 6 → `close — create: <missing items>`. Otherwise → `needs skillify — run skillify on <target>`.

## Phase 0 — Should this be a skill?

- Will it be invoked 2+ times?
- Is there more than ~20 lines of logic or judgment?
- Is there a trigger phrase a user would actually say?

Any no means a script or doc, not a skill: say why and stop.

Then search the existing skills: if one nearly covers the intent, merge into it — a neighbor splitting a trigger family makes both trigger worse.

**One skill = one capability = one coherent trigger family.** When the target spans intents users would invoke separately ("run the build", "roll back the deploy", "notify the team"), propose the split and ask which to skillify first.

## Phase 1 — Audit

For an existing skill, score the checklist against the tree and stop with the verdict:

```
Skill: <name>            Path: skills/<name>/ | skills/<group>/<name>/
Score: <passed>/8        Verdict: <verdict>
Missing: <item>: <one-line evidence> ...
```

A new skill is 0/8 — proceed. When the request was only an audit, deliver the verdict and the shortest path to `properly skilled`; editing waits for the ask.

## Phase 2 — Elicit requirements

Interview, skipping questions the conversation already answers:

- **Triggers:** what exact phrases should invoke this? What near-miss requests should NOT? Which existing skill is the nearest neighbor?
- **Output:** what does done look like: files, report shape, side effects?
- **Edge cases:** empty input, missing config, offline, partial state.
- **Existing behavior:** code or prose to absorb? What did its author correct over time?

Mark every volatile fact the skill will state — version pins, model names, numeric limits, dated claims; those go to a dated references file (item 7).

## Phase 3 — Scaffold and write

Scaffold (dry run by default; `--write` creates; `--json` for machines):

```sh
node <skill-dir>/scripts/scaffold-skill.mjs <name> --dir <repo-root> [--write]
```

The scaffolder validates the name, refuses existing directories and symlinks, stages then renames, and performs the repo wiring itself; its dry-run output lists every refusal and wiring action, so read that rather than this file. Then write, in order:

1. *Description + trigger query set* — the description per [authoring](references/authoring.md); the query set with near-miss negatives in `tests/fixtures/trigger-queries.json`.
2. *SKILL.md body* — workflow, one excellent example, the nearest-neighbour boundary line, routing table; limits per skill-maintainer's standards, style per [authoring](references/authoring.md).
3. *References* — detail only some invocations need.
4. *Scripts* — deterministic, repeated work only (criteria in [authoring](references/authoring.md)).

## Phase 4 — Behavioral eval — the quality gate

Cases live in `evals/evals.json` (agentskills.io format: 2–3 realistic prompts, one boundary case, assertions added after the first run). Run them per the [eval playbook](references/eval-playbook.md): on Claude Code, `claude plugin eval <skill-dir> --ablation with-without --runs 3 --max-cost-usd <n> --threshold <t> --json`, results under `<skill>/evals/results/<timestamp>/` (gitignored); on every harness, the with-skill vs baseline subagent procedure on the same cases, writing the same result files. Workflow skills add the sandbox drill as their end-to-end proof.

At most 3 cycles: eval → apply the top improvements → re-eval; pass, or ship with a KNOWN_GAPS section. If the baseline matches the with-skill output, the skill is not earning its tokens — cut or narrow it.

## Phase 5 — Lock in

1. Unit tests and fixtures for the deterministic branches of any bundled scripts; a prose-only skill keeps just its trigger-query fixture.
2. Put the volatile facts marked in Phase 2 in a references file, each with its checked date and official source link.
3. Finish `agents/openai.yaml` and the scaffolder's wiring TODOs (root README row, changeset per dev-implement's changelog rule).

## Phase 6 — Verify

```sh
node packages/cli/scripts/validate-skill.mjs <skill-dir>
bun test ./<skill-dir>
bun run check:fast
bun run test:affected
```

Re-score the checklist and report `<passed>/8` with the verdict; anything below `properly skilled` ships only with named gaps.

## Routing

| Need | Read |
|---|---|
| description engineering, writing style, token economy, scripts vs instructions, volatile facts | [authoring](references/authoring.md) |
| a walkthrough of one skillification | [authoring — worked example](references/authoring.md) |
| failure patterns to check a draft against | [authoring — anti-patterns](references/authoring.md) |
| eval method, pass criteria, trigger-query doctrine, workflow drills, cycles, KNOWN_GAPS, model guidance | [eval playbook](references/eval-playbook.md) |
| name, description, body limits; listing budgets; portability; release and rename mechanics | the `skill-maintainer` skill |
| the scaffolded starting points | `assets/templates/` |

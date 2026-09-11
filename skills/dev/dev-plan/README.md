# dev-plan

The planning stage of the dev workflow: an approved brief goes in, an operator-approved plan comes out, and only then does code exist. For `full-plan` issues it runs as its own fresh-grounded session (re-reads the current code, interviews the operator over approaches / system design / risk, challenges the brief where planning reveals gaps) and posts a strict-format plan comment — exact files, an Interfaces block per task, failing-test-first steps, no placeholders. For `quick-build` issues its inline mode runs inside the intake conversation so one approval covers brief and plan together. The scope ratchet lives here: work revealed bigger than its label stops and proposes the upgrade; downgrades need the operator's yes. The agent entry point is [SKILL.md](SKILL.md); everything else loads progressively from there.

## Install

```sh
npx @vegastack/vegafactory skills add dev-plan --global
```

Or the whole dev workflow at once:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

`--global` installs into your home directory, where the skill is available in every project; drop it for a project-local install. See the [installer README](../../../packages/cli/README.md) for all flags.

## What's in this skill

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent entry point |
| [agents/openai.yaml](agents/openai.yaml) | Codex interface metadata |
| references/conventions.md (installed copy) | The workflow artifact spec, duplicated into every dev-family install |
| scripts/questions.mjs (installed copy) | The ask round renderer, parser and route decision, duplicated in from dev-setup |
| references/ask-route.md (installed copy) | The ask route: tool or issue, the questions comment format, the reply grammar |
| scripts/lib/approval.mjs (installed copy) | Canonical scope and approval evaluator, copied from dev-implement for standalone authoring |
| [scripts/plan-lint.mjs](scripts/plan-lint.mjs) | Plan structure + banned-placeholder guard (blocks) |
| [references/plan-format.md](references/plan-format.md) | The plan comment template, banned placeholders, self-review, worked example |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Freshness contract (evergreen waiver) |
| [refresh/sources.json](refresh/sources.json) | Source registry for volatile claims |
| `tests/` | Bun tests and fixtures (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior

Picks up `needs-plan` issues (or intake's inline request), re-grounds against the current repo, runs the numbered questionnaire with recommended answers, and posts the plan per [plan-format](references/plan-format.md). Posting flips the issue to `needs-operator`; the operator's "plan approved" is recorded as a schema-v2 event bound to current plan scope; together with current brief intent it permits `ready`. Session attestations require a policy-operator publisher; other recorders may only relay a freshly verified identical scoped grant. Retain the evaluator’s canonical source `approvalBindings`, including through supersession or revocation. Preserve legacy records and obtain scoped reconfirmation before admission — building belongs to dev-implement. Guardrails: no plan re-proposes a recorded dev-architect rejection; a plan nearing GitHub's comment cap becomes an epic-split proposal; checkboxes are never pre-ticked; every run ends with a plain-language summary.

# dev-intake

Turns requirements — a brainstorm, a feature thought, an SOW — into GitHub issues complete enough that a fresh agent needs nothing but the URL. All questions happen here, in grilling-style rounds where every question ships with a recommended answer; once an issue is approved and `ready`, dark implementation needs no further input. Also records schema-v2 approval with the operator’s actual source quotation and current artifact bindings, preserves legacy records for scoped reconfirmation, and manages the `needs-operator` → `ready` labels. Session attestations need a current policy-operator publisher; an untrusted recorder may only relay an independently verified identical scoped grant. The evaluator returns its canonical source authority, with no new grant or lifecycle changes from the relay.

The agent entry point is [SKILL.md](SKILL.md).

## Install

```sh
npx @vegastack/vegafactory skills add dev-intake --global
```

Or the whole dev workflow at once:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

`--global` installs into your home directory, where the skill is available in every project; drop it for a project-local install. See the [installer README](../../../packages/cli/README.md) for all flags.

## What's in this skill

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent entry point: read-first rule, interview protocol, slicing, labels and approval recording |
| [agents/openai.yaml](agents/openai.yaml) | Codex interface metadata |
| references/conventions.md (installed copy) | The workflow artifact spec, duplicated into every dev-family install |
| scripts/questions.mjs (installed copy) | The ask round renderer, parser and route decision, duplicated in from dev-setup |
| references/ask-route.md (installed copy) | The ask route: tool or issue, the questions comment format, the reply grammar |
| scripts/lib/approval.mjs (installed copy) | Canonical scope and approval evaluator, copied from dev-implement for standalone authoring |
| [scripts/brief-lint.mjs](scripts/brief-lint.mjs) | Brief structure guard (blocks) with vague-wording warnings |
| [references/brief-template.md](references/brief-template.md) | The issue-body template every `ready` issue follows, with writing rules |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Evergreen waiver: this skill makes no volatile claims |
| [refresh/sources.json](refresh/sources.json) | Deliberately empty source registry behind the evergreen waiver |
| `tests/` | Bun tests and the trigger-query fixture (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior contract

Reads source material completely before asking anything — facts are the agent's job, decisions are the user's. Questions come in numbered rounds with recommended answers so "all recommended" is a valid reply. Issues are vertical slices sized for one agent session, wired with native dependencies/milestones/sub-issues; parent issues never get `ready`. Approval is only the user's explicit words, recorded once — labels and silence never create it. Issues are stamped with the org's native type and its Priority and Effort fields where dev.md's knobs name them, and both are read back because GitHub drops them silently without push access.

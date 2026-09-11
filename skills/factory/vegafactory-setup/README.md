# vegafactory-setup

The org's control room in one skill: `<org>/vegafactory-control-room` holds the org profile, the department groups, the people, the repo and board registries, the org-wide rules, the onboarding checklists, and the templates — and every repo's `.vegastack/dev.md` layers on top of it, so a second repo inherits the answers the first one gave. This skill bootstraps that repository from seed templates, registers repos into it, and onboards teammates. The agent entry point is [SKILL.md](SKILL.md); everything else loads progressively from there.

## Install

```sh
npx @vegastack/vegafactory skills add vegafactory-setup --global
```

Or the whole factory family at once:

```sh
npx @vegastack/vegafactory skills add --group factory --global
```

`--global` installs into your home directory, where the skill is available in every project; drop it for a project-local install.

## What's in this skill

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent entry point |
| [agents/openai.yaml](agents/openai.yaml) | Codex interface metadata |
| references/conventions.md (installed copy) | The workflow artifact spec, duplicated into every dev-family install |
| [references/control-room.md](references/control-room.md) | The control room's layout, precedence, read path, and file rules |
| `assets/control-room/` | The twelve seed templates every control-room file is rendered from, including `rules/stats-privacy.md.template` — the org's written promise about what a statistics record holds and who may read it |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Freshness contract |
| [refresh/sources.json](refresh/sources.json) | Source registry for volatile claims |
| `tests/` | Bun tests and fixtures (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior

Three procedures, one file layout.

- **Bootstrap** asks the `org.md` questionnaire — org name, goals, and what applies to everyone, including the three statistics lines — renders every template in `assets/control-room/` into a directory the operator can read, and then stops: creating the repository, granting access, and recording anyone's role are the operator's own account actions, named as exact commands and never attempted.
- **`register <repo>`** confirms the repo's group, runs `dev-setup` there (which reads the control room first, so an inherited knob is stated rather than asked), appends the `repos.md` row, and links the board when one exists.
- **`onboard <login>`** walks `onboarding/new-teammate.md` and adds the `people.csv` row. A person's `role` is descriptive and recorded only on the operator's word; people-level reads come from the resolved administration capability and repository scope, never from `lead`.

Guardrails: nothing secret goes in any control-room file — names of secrets only; department knobs never go in `org.md`; a declined step is written into `org.md`'s `## Unconfirmed` section so the next run asks again; and a control room that does not exist yet degrades to `dev-setup` asking the questions itself.

Precedence, in one line: ordinary delegated defaults use repo → group → org → skill, while an organization lock stays effective unless the organization grants the exact key/group/repository/value delegation; decision registers concatenate.

## Known gaps

- The current eight-case behavioral eval is pending the campaign's source-bound paired run. Until that result is recorded, deterministic tests do not substitute for skillify item 6.

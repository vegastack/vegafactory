# Contributing

By participating in this project you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md).

## Dev setup

Requirements: [Bun](https://bun.sh) 1.3.14 (pinned in `packageManager`) and Node >= 24.

```sh
bun install --frozen-lockfile
bun run check:fast     # validators + lint + typecheck (the commit-msg hook runs this)
bun run test:affected  # only the tests your change can reach
bun run check          # everything; the merge queue runs this
bun run build      # builds the CLI and syncs the skill copy into packages/cli
```

`bun install` enables the commit-msg hook, which runs `check:fast` on every commit and skips `wip:` checkpoints. Pull requests run the fast checks and affected tests; the merge queue runs the full suite and a packed-tarball smoke test once, on main plus your PR. Nothing reaches main except through the queue.

`npx @vegastack/vegafactory@latest init` sets up the rest of the machine — the CLI and skills for Claude Code and Codex, and this repository's hooks — if you have not run it already.

## How work moves here

This repository runs on the workflow it ships, so a change starts as an issue and ends as a queued PR.

- **Issues are the unit of work.** Agents read them from a local cache under `.vegastack/.tmp/issues/` and write back with `vegafactory issue`, never raw `gh` for issue content. One state label says whose move it is; the CLI keeps the ledger comment.
- **One issue, one worktree, one claim.** `vegafactory worktree` keeps the checkout under `.vegastack/.worktrees/`; a session claims the issue before building and the hook keeps the claim's heartbeat alive. `vegafactory hook <event> --harness claude|codex` is the one hook command for both harnesses.
- **The ship guard asks for what is hard to undo.** A fixed always-ask list plus the commands dev.md's `## Ship` section marks `ask:`, read from the default branch — pushing to main, merging, tagging, publishing, force-pushing, `--no-verify`. Green checks authorise none of it.
- **Review is cross-tool and it gates the merge.** `vegafactory review <n>` has the other tool read the diff read-only and posts the one review comment; `vegafactory ship check <n>` refuses a merge whose exact commit is not reviewed clean against the current brief and plan.
- **The loops that keep the docs honest.** `vegafactory learning` holds the lessons a session leaves until one becomes a dev.md line on the operator's yes; `vegafactory stats` and `vegafactory dashboard` count turns from the harnesses' own session logs; `skills-refresh` re-checks the dated facts the skills pin and files what changed as issues.

Everything above is described for users in the [README](README.md), command by command in the [installer README](packages/cli/README.md), and as this project's own policy in [.vegastack/dev.md](.vegastack/dev.md).

## Repo layout

| Path | What it is |
|---|---|
| `skills/` | Authored skill content — the single source of truth. Edit here. A skill sits at `skills/<name>/` or, inside a group, at `skills/<group>/<name>/` — one level, never deeper. |
| `skills/dev/` | The dev-workflow group (setup, intake, plan, architect, implement, debug, review, ship, status — which also holds the chronicle): a `GROUP.md` plus nine skills, each with `SKILL.md`, references, deterministic scripts where they earn them, tests. |
| `skills/factory/` | The org group: `vegafactory-setup`, which bootstraps and maintains the control room whose defaults every repo's dev profile layers on. |
| `skills/skills-tooling/` | The skills-about-skills group — currently `skills-refresh`, which re-verifies the dated facts the dev skills pin. |
| `skills/repo-tooling/` | The skills that only make sense inside this repository: `skillify`, the skill factory and auditor, and `skill-maintainer`, the standards and release operations. Both are repo-only, so `add --all` skips them. |
| `packages/cli/` | The `@vegastack/vegafactory` installer. `packages/cli/skill/` and `skill-integrity.json` are **generated at build** from `skills/` — never edit or commit them. |
| `packages/cli/repo-only.json` | The skills `add --all` skips because they only make sense inside this repository. Hand-maintained; validated by the build. |
| `.vegastack/` | The project's own instance of the workflow: `dev.md` (the canonical process doc — release runbook, versioning, rollback), `decisions.md` (the decision register), and `chronicle.md` (the append-only story). `.vegastack/.tmp/` and `.vegastack/.worktrees/` are working state and are gitignored. |

## Never commit generated files

`dist/`, `packages/cli/skill/`, `packages/cli/skill-integrity.json` and `work/` are build outputs. They are gitignored; the release builds them. PRs that add them will be rejected.

## Adding a new skill

Every skill lives at `skills/<name>/` or `skills/<group>/<name>/` and is self-contained:

| File/dir | Required | Purpose |
|---|---|---|
| `SKILL.md` | yes | Agent entry point — valid frontmatter (`name`, `description`), progressive routing to references |
| `references/` | if applicable | Normative content, loaded on demand (a self-contained skill may have none) |
| `scripts/` | if applicable | Deterministic, dependency-free Node scripts |
| `assets/` | if applicable | Templates, schemas, examples |
| `tests/` | yes | Bun tests and the trigger-query fixture (never packaged); unit tests are required for scripts' deterministic branches, not for prose |
| `evals/` | recommended | agentskills.io eval cases in `evals/evals.json` (never packaged; results gitignored) — the structure check warns when absent |
| `agents/openai.yaml` | for Codex | Codex interface metadata |

The skillify scaffolder creates this tree and performs the repo wiring itself: the per-skill packaging allowlist entry in `packages/cli/packaging.json` (the build fails loudly on authored files that are neither allowlisted nor deliberately unpackaged), the root README skills-table row, and the changeset. Files added to a skill after scaffolding must be appended to its `packaging.json` entry by hand.

One wiring file the scaffolder does **not** write: `packages/cli/repo-only.json` lists the skills that operate on this repository itself, so `add --all` skips them. Add a skill there by hand if it is useless in a consumer project; the build fails if the list names a skill that does not exist.

## Adding or modifying content

Skill content is advisory prose and decision tables, not a rule corpus — there are no rule IDs
and no machine-extracted rule format to follow.

- New reference files or reference sections, and new/changed recorded decisions (e.g. a new
  "use/not/why" row, a new red line) are MINOR content changes — see the content-semver bullet
  in [.vegastack/dev.md](.vegastack/dev.md) (detail in
  [skill-maintainer's release-ops](skills/repo-tooling/skill-maintainer/references/release-ops.md)).
- Factual refreshes and non-normative wording clarifications are PATCH.
- Removing a skill, or a breaking change to the per-project profile format, is MAJOR;
  renaming a skill ships MINOR by default — major only when the operator declares it.
- Keep volatile facts (version pins, vendor mechanism names) in `pinned-facts.md`-style dated
  entries with a checked date and official source link, so they can be re-checked against that source.

## Releases

Versioning and publishing are maintainer-driven via changesets and tag-triggered CI — the `## Ship` runbook in [.vegastack/dev.md](.vegastack/dev.md) is the release flow, rollback included. The tag itself is `vegafactory ship release <n>`, which re-reads the recorded "ship it", checks the version against its changelog entry and pushes the tag; publishing happens in the workflow that tag triggers, with npm provenance and no token. Contributors do not bump versions in PRs. Changeset entries follow the shape in the dev-implement skill's changelog rule ([skills/dev/dev-implement/SKILL.md](skills/dev/dev-implement/SKILL.md)) — the published changelog and the release notes reproduce them verbatim.

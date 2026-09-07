# Contributing

By participating in this project you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md).

## Dev setup

Requirements: [Bun](https://bun.sh) 1.3.14 (pinned in `packageManager`) and Node >= 24.

```sh
bun install --frozen-lockfile
bun run check      # validate:skill + test + lint + typecheck
bun run build      # builds the CLI and syncs the skill copy into packages/cli
```

`bun run check` must pass before every PR. CI runs it on Node 24 plus a packed-tarball install smoke test.

### Scanning the skills

Every skill this repo ships is scanned by [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) before a push, and again before a release. It is **not** part of `bun run check` — `check` must keep running on Bun and Node alone, while SkillSpector needs Python 3.12 and ~70 packages — so install it once:

```sh
uv tool install git+https://github.com/NVIDIA/skillspector.git
bun run build && node skills/skills-tooling/skill-scan/scripts/skill-scan.mjs --json
```

Run it from the repo root: with no `--root` it reads the `skill-scan:` knob from `.vegastack/dev.md` and applies `.vegastack/skillspector-baseline.json` by convention. A profile it cannot read is an error, not a skip — the guard refuses rather than quietly passing from the wrong directory.

The guard locates SkillSpector through whatever channel installed it (uv, brew, pipx) and runs it by absolute path, so it is found even when your shell's `PATH` does not have it. Under `.vegastack/dev.md`'s `skillspector-update: auto` it also installs it when absent and upgrades it before each scan, falling back to the installed copy on any failure — so the command above is a one-time convenience rather than a prerequisite. Set `skillspector-update: notify` to only be told what upstream published, or `off` to never touch the network; `--no-provision` leaves the machine alone for one run.

The guard still refuses (exit 2) when the binary cannot be found at all, rather than passing quietly. It blocks on any unsuppressed **HIGH or CRITICAL** finding, never on the aggregate risk score — a skills repo documents the mechanics the scanner matches on, so the score says more about our subject matter than our risk. Build first: the knob names `packages/cli/skill/`, because the authored tree's unpackaged `tests/` fixtures are deliberately adversarial.

Suppressions live in `.vegastack/skillspector-baseline.json`. Adding one is a security decision needing the maintainer's word, scoped as narrowly as its cause, with a `reason` carrying a **"Still flag if:"** clause the guard enforces. Widening a rule to make the guard green is the failure mode, not the fix.

## Repo layout

| Path | What it is |
|---|---|
| `skills/` | Authored skill content — the single source of truth. Edit here. A skill sits at `skills/<name>/` or, inside a group, at `skills/<group>/<name>/` — one level, never deeper. |
| `skills/dev/` | The dev-workflow group (setup, intake, plan, architect, implement, debug, review, ship, status, chronicle): a `GROUP.md` plus ten skills, each with `SKILL.md`, references, deterministic scripts where they earn them, tests. |
| `skills/skills-tooling/` | The skills-about-skills group — tools that operate on agent skills themselves; currently `skill-scan`, the SkillSpector guard and its suppression baseline. |
| `<skill>/refresh/` | Freshness contract: source registry and refresh instructions consumed by the weekly refresh automation. |
| `packages/cli/` | The `@vegastack/vegafactory` installer. `packages/cli/skill/` and `skill-integrity.json` are **generated at build** from `skills/` — never edit or commit them. |
| `packages/cli/repo-only.json` | The skills `add --all` skips because they only make sense inside this repository. Hand-maintained; validated by the build. |
| `.vegastack/` | The project's own dev workflow instance: `dev.md` (the canonical process doc — release runbook, versioning, rollback), `decisions.md` (the decision register), and `skillspector-baseline.json` (audited skill-scan suppressions). |

## Never commit generated files

`dist/`, `packages/cli/skill/`, `packages/cli/skill-integrity.json`, `work/`, and `.vegastack/evidence-*.json` are build or tooling outputs. They are gitignored; paired release preparation builds them, and CLI `prepack` validates the generated descriptor against the exact dashboard tarball instead of rebuilding. PRs that add them will be rejected.

## Adding a new skill

Every skill lives at `skills/<name>/` or `skills/<group>/<name>/` and is self-contained:

| File/dir | Required | Purpose |
|---|---|---|
| `SKILL.md` | yes | Agent entry point — valid frontmatter (`name`, `description`), progressive routing to references |
| `README.md` | yes | Human/agent walkthrough of the whole skill (repo-side only; not packaged) |
| `references/` | if applicable | Normative content, loaded on demand (a self-contained skill may have none) |
| `scripts/` | if applicable | Deterministic, dependency-free Node scripts |
| `assets/` | if applicable | Templates, schemas, examples |
| `tests/` | yes | Bun tests and the trigger-query fixture (never packaged); unit tests are required for scripts' deterministic branches, not for prose |
| `evals/` | recommended | agentskills.io eval cases in `evals/evals.json` (never packaged; results gitignored) — the structure check warns when absent |
| `refresh/sources.json` + `refresh/REFRESH.md` | yes | Freshness contract for the weekly refresh automation, or a one-line evergreen waiver |
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
  entries so the refresh system can track them.

## Refresh PRs

Branches named `refresh/**` are reserved for the automated freshness loop and are CI-restricted to refresh metadata at either legal depth. Human content changes go on normal branches.

## Releases

Versioning and publishing are maintainer-driven via changesets and tag-triggered CI — the `## Ship` runbook in [.vegastack/dev.md](.vegastack/dev.md) is the release flow, rollback included. Contributors do not bump versions in PRs. Changeset entries follow the shape in the dev-implement skill's changelog rule ([skills/dev/dev-implement/SKILL.md](skills/dev/dev-implement/SKILL.md)) — the published changelog and the release notes reproduce them verbatim.

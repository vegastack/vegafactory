---
name: skill-maintainer
description: Standards and release operations for the vegafactory repository itself. Use when working on this repository - editing an existing skill (SKILL.md, references, scripts, tests), renaming, deprecating, or removing a skill, creating or checking a skill group, cutting a release or rolling one back, adjudicating a skill-scan finding, or checking cross-harness portability across Claude Code, Codex and the agentskills.io standard. Not for scaffolding a new skill or scoring one against the contract (skillify), and not for skills that live in other projects.
---

# VegaStack Skill Maintainer

This skill states what must be true; skillify states how to get there. When a rule here disagrees with `CONTRIBUTING.md` or `.vegastack/dev.md`, those win — then fix this skill.

## Operating rules

1. Skill content lives only in the skill's own directory, at exactly two depths: `skills/<name>/` or `skills/<group>/<name>/`; deeper is a build error. A group is a directory of skills plus a `GROUP.md` (title, then a blurb line); group and skill names share one namespace and grammar. Wiring lives outside the skill — the `packages/cli/packaging.json` allowlist, keyed by **bare** skill name because the bundle is flat and an install carries no group; the root README row; the changeset (a `.changeset/<slug>.md` file whose frontmatter names the package and bump, shaped per dev-implement's changelog rule; changesets are compiled into `packages/cli/CHANGELOG.md` at release) — and the skillify scaffolder writes all three. "The operator" throughout is the human running the workflow, named by their GitHub username.
2. Frontmatter is exactly `name` and `description`; the spec's `license`, `compatibility`, and `metadata` are a policy exception needing maintainer sign-off.
3. `name` equals the directory name: a lowercase letter first, then `[a-z0-9-]`, no leading, trailing, or consecutive hyphens, at most 64 chars.
4. `description`: at most 1024 chars, third person, no angle brackets, no space-hash. It states what the skill does and when to load it as a calm "Use when …" conditional carrying the concrete phrasings users type, plus one "Not for …" clause naming the nearest neighbour, because harnesses quote descriptions verbatim in the skill list and emphatic wording (all-caps "must", "critical", "load this before") over-triggers there. Triggers go in the first sentence because listings truncate. The description never summarises the workflow: agents follow the summary and skip the body.
5. `SKILL.md` under 500 lines (target 150), roughly 5k tokens; detail in `references/`, executables in `scripts/`, templates in `assets/`; relative links stay one level deep inside the skill.
6. No Claude-only body syntax (token list in [standards](references/standards.md)); reference scripts as plain relative paths from the skill directory.
7. A volatile fact (version, mechanism name, limit, dated claim) lives in a references file with its checked date and official source link, and is re-checked against that source when older than 60 days.
8. Before finishing any change, from the repo root: `node packages/cli/scripts/validate-skill.mjs <skill-dir>`, `bun test ./<skill-dir>`, and `node packages/cli/scripts/structure.mjs check` must pass. `bun run check:fast` includes the structure check; `bun run test:affected` runs the tests the change reaches.

## Route progressively

| Need | Read |
|---|---|
| Claude Code and Codex standards: discovery paths, frontmatter, budgets, install surfaces, portability | [standards](references/standards.md) |
| skill-scan triage and the suppression baseline | [standards](references/standards.md) |
| a new skill: the should-it-exist gate, scaffolding, audit, evals | the `skillify` skill |
| repo shape, groups, the structure check | the group workflow below |
| release, rename, deprecate, rollback | [release ops](references/release-ops.md) |
| authoritative repo policy | `CONTRIBUTING.md` and `.vegastack/dev.md` |

## Workflow: create or maintain a group

Groups are this skill's; the tool is `packages/cli/scripts/structure.mjs` at the repo root.

1. **Create a group** — `node packages/cli/scripts/structure.mjs create-group <name> --title "<Display Title>" --blurb "<one line>"` prints the plan and each refusal before anything is written; `--write` applies it.
2. **Put skills in it** — skillify's scaffolder places a new skill with `--group <name>`, refusing an unknown or malformed group before writing. Moving a skill is a `git mv` plus its README row and its test's validator-import depth.
3. **Check the shape** — `node packages/cli/scripts/structure.mjs check` blocks on depth, name collisions, `GROUP.md`, README-section, packaging, and README-row faults; it warns on an empty group, a group of one, and placeholder text (`--strict`: warnings exit 1). Dot-prefixed files are ignored everywhere.

An installed skill is always `<surface>/<bare-name>/`; a group is a selection: `add`, `verify`, and `remove` take a name, `--group <name>`, or `--all`, one transaction per group. `packages/cli/repo-only.json` marks `skill-maintainer` and `skillify` repo-only, so `--all` skips them; the list is build-validated data, independent of grouping.

## Workflow: scaffold a new skill

Run skillify's `scripts/scaffold-skill.mjs` (`--group <name>` for a grouped skill), fill in the root README row and changeset placeholders it leaves, and add later packaged files to the packaging entry by hand because the build fails on unlisted files. Then rules 2–6 and 8; the authoring and eval discipline is skillify's.

## Workflow: update or maintain

- **Content versioning.** Per the content-semver bullet in `.vegastack/dev.md`: new rules, references, recorded decisions, and skill renames are MINOR; weakening a normative rule, removing a skill, or breaking a per-project profile format is MAJOR (recorded pre-1.0 exception aside); factual refreshes are PATCH.
- **Date volatile claims.** A sentence carrying a vendor version, mechanism name, or numeric budget carries its checked date and official source link; undated volatile facts rot silently.
- **Description budgets.** Keep triggers in the first sentence: both harness listings truncate, and the limits table below carries the numbers.
- **Packaged-file changes.** Adding, removing, or renaming a packaged file updates its packaging entry in the same PR.

## Workflow: rename, deprecate, or remove

Playbook in [release ops](references/release-ops.md): a rename changes the directory and the frontmatter `name` in the same commit, updates the packaging entry, root README row, changeset, and every cross-reference to the old name (sibling descriptions, fixtures, `ambiguous_with` entries, docs — `grep -rn <old-name>` finds them), and is MINOR unless the operator declares MAJOR; deprecation is announced in README and CHANGELOG first; removal deletes the tree, unwires it, and is MAJOR.

## Workflow: release

The `## Ship` runbook in `.vegastack/dev.md` is the release sequence and says which steps take the operator's word. One version identity covers the installer and every bundled skill, so a bump leaves every deployed per-project profile valid. Rollback is roll-forward plus `npm deprecate`. Details: [release ops](references/release-ops.md).

## Workflow: portability check

- [ ] Frontmatter keys and limits per rules 2–4; `name` equals the directory name.
- [ ] `SKILL.md` under 500 lines; relative links resolve inside the skill; no Claude-only body syntax.
- [ ] `agents/openai.yaml` present for Codex (other harnesses ignore extra files).
- [ ] Install surfaces: Claude Code `.claude/skills` or `~/.claude/skills`; Codex `.agents/skills` or `~/.agents/skills`.
- [ ] Rule 8's checks are clean.

## Hard limits

| Limit | Value |
|---|---|
| `name` | ≤ 64 chars, lowercase letter first, then `[a-z0-9-]`, no consecutive hyphens, equals directory name |
| `description` | 1–1024 chars, no angle brackets |
| `SKILL.md` | under 500 lines / ~5k tokens; target under 150 lines |
| Claude Code listing | name + description truncated at 1,536 chars per skill |
| Claude Code body | first 5,000 tokens persist across compaction; 25,000-token shared skills budget |
| Codex skill list | 2% of context window / 8,000 chars — descriptions shortened first |

These mirror marked sentences in [standards](references/standards.md); update both in one PR when a source changes.

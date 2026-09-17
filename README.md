# VegaFactory

[![npm](https://img.shields.io/npm/v/@vegastack/vegafactory?logo=npm&color=cb3837)](https://www.npmjs.com/package/@vegastack/vegafactory)
[![CI](https://github.com/vegastack/vegafactory/actions/workflows/ci.yml/badge.svg)](https://github.com/vegastack/vegafactory/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@vegastack/vegafactory?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

VegaFactory ships Agent Skills for [Claude Code](https://code.claude.com) and [Codex](https://developers.openai.com/codex). The `@vegastack/vegafactory` package is the command-line installer and local workflow tool, and it contains the integrity-checked skill bundle.

Each skill is self-contained: its own entry point, references, deterministic scripts, freshness contract, and walkthrough.

The headline set is **`dev`**: a ten-stage, issue-driven development workflow where every gate that matters is held by a person, not an agent.

- [Quick start](#quick-start)
- [Installing](#installing)
- [Working with an agent](#working-with-an-agent)
- [Skills](#skills)
- [Repository structure](#repository-structure)
- [How freshness works](#how-freshness-works)
- [Advisory reviews, user-held gates](#advisory-reviews-user-held-gates)
- [Develop](#develop)
- [Security](#security)
- [Contributing and support](#contributing-and-support)
- [License](#license)

## Quick start

### Requirements

| What | Why |
|---|---|
| Node >= 24 | Runs the installer |
| macOS or Linux | Windows is not yet supported (path handling) |
| `git` and an authenticated GitHub CLI — check with `gh auth status` | The dev workflow runs on GitHub issues |

Only Node is needed to install. `dev-setup` tells you if `git` or `gh` is missing when you first use the workflow, and handles a brand-new project with no remote.

### 1. Install the dev workflow

```sh
npx @vegastack/vegafactory@latest skills add --group dev --global
```

This is the **recommended** install: one command, once per machine, and the workflow is available in every project you open. The installer detects which agents you have (Claude Code, Codex) and targets them without asking.

Prefer a project-local install when a repository should carry its own copy — so collaborators get the same skills from a checkout, or so one project can pin a version while the rest of the machine moves on:

```sh
npx @vegastack/vegafactory@latest skills add --group dev
```

Pick one or the other per skill rather than installing both: in Claude Code, a personal (global) skill takes precedence over a project one, so a project-local copy would not override a global install of the same skill — it would just sit there unused.

### 2. Set up your project

In the project you want to work in, ask your agent to **set up the dev workflow** — that phrasing triggers the `dev-setup` skill.

`dev-setup` writes `.vegastack/dev.md`: your project's handbook — stack, commands, review mode, shipping gates. Everything else reads from it. It is per-project and lives in the repo, whether the skills themselves were installed globally or locally.

### 3. Work the loop

Work flows through GitHub issues:

**dev-intake** turns an idea into a brief you approve → **dev-plan** turns the brief into a plan you approve → **dev-implement** builds it and posts evidence → **dev-review** reviews it independently → **dev-ship** opens the PR and merges, each step only on your explicit word.

`/dev-intake` (Claude Code) and `$dev-intake` (Codex) load a skill by name and bypass routing — the same works for every dev skill when the agent picks the wrong one.

## Installing

### Selecting what to install

`add`, `verify`, and `remove` each take **exactly one** selector; `verify` takes at most one and checks everything installed when given none. Combining two selectors is an error, not a merge.

| Selector | Installs |
|---|---|
| `--group dev` | The ten dev-workflow skills |
| `--all` | Every bundled skill except the repo-only ones |
| `<skill-name>` | That one skill — works for every bundled skill, repo-only ones included |

```sh
npx @vegastack/vegafactory skills list
```

```sh
npx @vegastack/vegafactory skills add dev-plan --global
```

A `--group` or `--all` install is **one transaction**: every skill is staged before any is committed, so if one fails, none are installed and the destination is left exactly as it was.

`--all` deliberately skips the **repo-only** skills (`skill-maintainer`, `skillify`) — those operate on this repository itself and do nothing useful elsewhere. Name one explicitly if you are contributing here.

### Where skills install

`--global` targets your home directory; `--project` (the default) targets the current directory.

| Agent | Global (recommended) | Project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |

The installer targets detected agents automatically; `--agent codex|claude|both` overrides. `--all` chooses which skills; `--agent` chooses which agent runtimes. `add --all --agent both --global` means every installable skill, for both agents, in your home directory.

Skills always install **flat**, as `<surface>/<skill-name>/`. Groups are a way of selecting and organising skills — they never appear in an installed path, so `--group` changes what you get, never where it lands.

### Upgrading, checking, removing

Upgrade to the latest release. `--force` is required because the installer refuses to overwrite an installed copy that differs from the bundle, rather than silently discarding local edits:

```sh
npx @vegastack/vegafactory@latest skills add --group dev --global --force
```

Diagnose an install — integrity across all skills, and installed-vs-latest version:

```sh
npx @vegastack/vegafactory skills doctor --global
```

Run `doctor` without `--global` from inside a project to additionally check that project's `.vegastack/dev.md` profile.

Re-check installed bytes against the shipped checksum manifest:

```sh
npx @vegastack/vegafactory skills verify --group dev --global
```

Uninstall:

```sh
npx @vegastack/vegafactory skills remove --group dev --global
```

Every flag: [installer README](packages/cli/README.md).

The `add`, `verify`, and `remove` installer verbs are fully offline; `doctor` checks npmjs.org for a newer release. The control-room sync makes only the network calls documented in the [installer README](packages/cli/README.md). No telemetry.

## Working with an agent

If you are an agent reading this repository, or pointing a user at it:

- **Load a skill by name.** Each skill's `SKILL.md` is the entry point; its `description` states when to trigger. Detail lives in `references/` and loads only when the workflow routes to it.
- **`dev.md` outranks the skills.** A project's `.vegastack/dev.md` is its handbook, and where it disagrees with a skill's default, it wins.
- **Gates are human-held.** No skill authorises approving a brief or a plan, pushing to the default branch, merging, or releasing. Those need the operator's explicit words, every time.
- **The install layout is flat.** A skill is always at `<surface>/<name>/`. Never construct a path containing a group.

## Skills

Every skill currently belongs to a group; the table below is where an ungrouped one would be listed.

<!-- Ungrouped skills go in this table. skillify's scaffold-skill.mjs anchors new ungrouped rows
     on this header and refuses to scaffold without it, so do not delete it when it is empty. -->

| Skill | What it does | Docs |
|---|---|---|

### Dev workflow

The issue-driven development workflow: ten stages from project bootstrap to the shipped, chronicled change.

| Skill | What it does | Docs |
|---|---|---|
| [dev-setup](skills/dev/dev-setup/) | Bootstraps a project for the issue-driven workflow: `.vegastack/dev.md`, the AGENTS.md section, the workflow labels, and the decision register | [SKILL.md](skills/dev/dev-setup/SKILL.md) |
| [dev-intake](skills/dev/dev-intake/) | Turns brainstorms, requests, and SOWs into agent-ready issues, with quoted-approval recording that flips `waiting-on-operator` to `queued` | [SKILL.md](skills/dev/dev-intake/SKILL.md) |
| [dev-plan](skills/dev/dev-plan/) | The planning stage between intake and implementation: approaches, a no-placeholder plan with failing-test-first steps, and the scope ratchet | [SKILL.md](skills/dev/dev-plan/SKILL.md) |
| [dev-architect](skills/dev/dev-architect/) | VegaStack's architecture advisor: the locked stack, recorded rejections, and dated platform facts behind a verify-before-you-recommend protocol | [SKILL.md](skills/dev/dev-architect/SKILL.md) |
| [dev-implement](skills/dev/dev-implement/) | Implements an approved issue end to end without user input: issue check, claim, dark build, tests, independent review, evidence comment, hand-back | [SKILL.md](skills/dev/dev-implement/SKILL.md) |
| [dev-debug](skills/dev/dev-debug/) | Reproduce-first bug work: a red repro command before any theory, ranked falsifiable suspects, and the regression test before the fix | [SKILL.md](skills/dev/dev-debug/SKILL.md) |
| [dev-review](skills/dev/dev-review/) | Independent multi-axis review of finished work — spec, standards, security — with severity-tiered findings and a bounded fix loop | [SKILL.md](skills/dev/dev-review/SKILL.md) |
| [dev-ship](skills/dev/dev-ship/) | The shipping gates, each spent only by the operator's words: PR, merge per the `merge:` knob, then the project's `## Ship` runbook | [SKILL.md](skills/dev/dev-ship/SKILL.md) |
| [dev-status](skills/dev/dev-status/) | The operator's board: a deterministic gh-backed gather of state, progress, staleness, and PRs, rendered needs-you-first with one Next action | [SKILL.md](skills/dev/dev-status/SKILL.md) |
| [dev-chronicle](skills/dev/dev-chronicle/) | The project's narrative record — one story entry per behavior-changing branch — plus the "catch me up" digest read from it and the register | [SKILL.md](skills/dev/dev-chronicle/SKILL.md) |

### Factory

Org-level skills: the control room whose defaults every repo layers on, and the onboarding of repos and people into it.

| Skill | What it does | Docs |
|---|---|---|
| [vegafactory-setup](skills/factory/vegafactory-setup/) | Bootstraps and maintains the org control room — org, group, people, repos, boards, rules, and onboarding — that every repo's dev profile layers on | [SKILL.md](skills/factory/vegafactory-setup/SKILL.md) |

### Repo tooling

Skills that work on this repository itself: they are not installed by --all, and do nothing useful in another project.

| Skill | What it does | Docs |
|---|---|---|
| [skill-maintainer](skills/repo-tooling/skill-maintainer/) | The verified Agent Skills standards for Claude Code, Codex and agentskills.io — every update, rename, and release runs through it; skillify creates | [SKILL.md](skills/repo-tooling/skill-maintainer/SKILL.md) |
| [skillify](skills/repo-tooling/skillify/) | The repo-local skill factory: gates whether something should be a skill at all, scaffolds the contract with its repo wiring, and audits existing skills | [SKILL.md](skills/repo-tooling/skillify/SKILL.md) |

### Skills tooling

Tools that work on agent skills themselves: scanning them for vulnerabilities, vetting the ones you did not write, and the suppression discipline behind both.

| Skill | What it does | Docs |
|---|---|---|
| [skill-scan](skills/skills-tooling/skill-scan/) | Scans agent skills with NVIDIA SkillSpector and holds the suppression baseline: the Verify-gate guard, and the answer to "is this downloaded skill safe to install" | [SKILL.md](skills/skills-tooling/skill-scan/SKILL.md) |

## Repository structure

| Path | Purpose |
|---|---|
| `skills/<name>/`<br>`skills/<group>/<name>/` | Authored skill content — the source of truth. A skill sits at the top level or inside a group, one level deep and no deeper; both are fully supported. Every skill carries `SKILL.md` (agent entry), `agents/openai.yaml`, `tests/` and `evals/`, plus `references/`, `scripts/`, and `assets/` where the skill needs them. A group adds a `GROUP.md` (display title plus one blurb line) beside its skills; the packaged bundle is flat, so a group is a way of selecting and organising skills (`add --group <name>`) and never appears in an installed path |
| `packages/cli/` | The `@vegastack/vegafactory` installer. Its skill copy and checksum manifest are generated at build time and are never committed |
| `.vegastack/` | This repo's own dev workflow instance (dogfooding the dev skills): [dev.md](.vegastack/dev.md) — the canonical process doc with the release runbook, versioning, and rollback — and [decisions.md](.vegastack/decisions.md) |
| `.github/workflows/` | CI (pull requests and the merge queue), tag-driven release (npm trusted publishing), and the board mirror |

## How freshness works

Volatile facts in skill references (versions, limits, vendor mechanisms) carry their checked date and an official source link. A fact older than 60 days is re-checked against its source before anyone relies on it. `doctor` reports installed-vs-latest.

## Advisory reviews, user-held gates

Architecture review (`dev-architect`) is advisory by design: evidence-backed reports with honest severities (`critical` / `production-gate` / `consider`), unverified claims labeled rather than asserted, and deliberately accepted risk kept visible instead of suppressed. The dev workflow skills are the complement: their gates are real, and every one of them is held by the user — agents can never approve, ship, or merge on their own authority.

## Develop

```sh
bun install --frozen-lockfile
bun run check:fast     # validators + lint + typecheck (also the commit-msg hook)
bun run test:affected  # only the tests your change can reach
bun run check          # everything (the merge queue runs this)
bun run build
```

Pull requests run the fast checks and affected tests. The merge queue runs the full suite, a packed-tarball smoke test and the skill scan once, on main plus the PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for the scan's suppression rules.

See [CONTRIBUTING.md](CONTRIBUTING.md) for repo layout, content-versioning rules, the no-generated-files policy, the skill-scan suppression discipline, and how to add a new skill.

## Security

**These skills are scanned before they ship.** Every skill in this bundle is checked by [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) — 71 vulnerability patterns across prompt injection, data exfiltration, excessive agency, supply chain, and MCP-specific risks — in the merge queue, before any change reaches main, on the built bundle that npm actually serves. The gate blocks on any unsuppressed HIGH or CRITICAL finding. Suppressions are not a switch: each one is a reviewed entry in [`.vegastack/skillspector-baseline.json`](.vegastack/skillspector-baseline.json) whose written reason must say what would make the pattern a real finding again.

**You can scan any skill the same way — including one you're about to install from someone else.** Agent skills execute with your agent's authority, so "who wrote this and what does it actually do" is a fair question to ask of any of them, ours included.

Install the scanner:

```sh
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

Install the guard, which ships as the `skill-scan` skill:

```sh
npx @vegastack/vegafactory skills add skill-scan --global
```

Then scan any skill directory:

```sh
node ~/.claude/skills/skill-scan/scripts/skill-scan.mjs --root path/to/some-skill
```

That path is the guard's location for a global Claude Code install. Substitute your own surface from the [table above](#where-skills-install) — `~/.agents/skills/skill-scan/…` for a global Codex install, `.claude/skills/skill-scan/…` or `.agents/skills/skill-scan/…` for a project-local one. If the directory is not there at all, install it with the group's add command (`skills add --group skills-tooling`) or re-run `add` against `@vegastack/vegafactory@latest` with `--force`.

Point `--root` at a single skill directory, or at a directory of them — flat, or one group deep. Exit `0` is clean, `1` clean with warnings, `2` blocked — either by a finding, reported with its rule, severity and `file:line`, or because the scan could not be trusted at all: the scanner missing from PATH, an unreadable report or profile, a baseline that fails its own discipline, coverage the scanner says it never completed, or **a directory holding a `SKILL.md` that discovery did not reach** — buried too deep, dot-prefixed, or behind a symlink. That last one matters: an unscanned skill that nobody mentions is indistinguishable from a clean one, so the guard names it and refuses. Without `--root` it reads the `skill-scan:` knob from your project's `.vegastack/dev.md`, and a project with no skills (`skill-scan: none`) is told it was skipped rather than erroring. Add `--llm` for the semantic pass — it needs a provider, is non-deterministic, and is advisory: a run whose analyzer fails scores *higher* than a clean one, which is why the gate never uses it.

The judgement is still yours. A scanner hit is evidence, not a verdict — the `dev-review` skill's [security axis](skills/dev/dev-review/references/security-axis.md) sets out how to trace one before acting on it.

Report vulnerabilities in these skills via [GitHub Security Advisories](SECURITY.md) — not public issues.

## Contributing and support

| | |
|---|---|
| Contributing guide | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Security policy | [SECURITY.md](SECURITY.md) |
| Bugs and feature requests | [GitHub issues](https://github.com/vegastack/vegafactory/issues) |
| Installer package | [`@vegastack/vegafactory` on npm](https://www.npmjs.com/package/@vegastack/vegafactory) |

## License

[MIT](LICENSE)

# VegaFactory

[![npm](https://img.shields.io/npm/v/@vegastack/vegafactory?logo=npm&color=cb3837)](https://www.npmjs.com/package/@vegastack/vegafactory)
[![CI](https://github.com/vegastack/vegafactory/actions/workflows/ci.yml/badge.svg)](https://github.com/vegastack/vegafactory/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@vegastack/vegafactory?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

VegaFactory is a nine-stage, issue-driven development workflow for coding agents, and the tool that runs it. GitHub issues hold the work, agents build in their own worktrees, the other tool reviews the diff, and every gate that matters is held by a person.

It ships as Agent Skills for [Claude Code](https://code.claude.com) and [Codex](https://developers.openai.com/codex) plus one command-line tool, `@vegastack/vegafactory`, which carries the integrity-checked skill bundle.

- [Quick start](#quick-start) · [How the workflow runs](#how-the-workflow-runs) · [Glossary](#glossary) · [Skills](#skills)
- [Repository structure](#repository-structure) · [Security](#security) · [Develop](#develop)
- Every command and flag: [installer README](packages/cli/README.md)

## Quick start

You need Node 24 or newer on macOS or Linux, `git`, the [GitHub CLI](https://cli.github.com) signed in, and Claude Code or Codex installed.

### 1. Set up the machine, once

```sh
npx @vegastack/vegafactory@latest init
```

`init` checks those tools, installs the CLI and every skill globally for the agents you have, turns on the repository's commit hook, and links your org's control room when you pass `--org`. It exits non-zero and names the step that failed.

### 2. Set up the project

In the project you want to work in, ask your agent to **set up the dev workflow** — that phrasing loads `dev-setup`. It writes `.vegastack/dev.md`, the project's handbook: stack, commands, the model per stage, the labels, the shipping steps. Every skill reads it, and where it disagrees with a skill's default, it wins.

### 3. Work the loop

Say what you want. The agent routes it: an idea becomes a brief you ack, the brief becomes a plan you ack, the build runs dark and hands back evidence, the other tool reviews it, and "ship it" lands it.

```sh
npx @vegastack/vegafactory skills list   # everything bundled
```

`/dev-intake` (Claude Code) and `$dev-intake` (Codex) load a skill by name when the agent picks the wrong one.

An always-on machine can work that loop for you. `vegafactory dispatch enable` turns one on, but only where your org's control room lists that machine by name: it then reads the board every two minutes and takes each transition — a reply on a waiting issue, a plan to write, a queued issue to build and review, corrections, and your "ship it" — running at most three steps at once. Its writes to GitHub go out as the VegaFactory GitHub App; the agent runs stay on your own subscription. Your two words per issue still gate everything: an ack and a "ship it".

## How the workflow runs

**One issue is one unit of work.** A state label says whose move it is, a size label says how big it is, and the CLI keeps a **ledger** comment on the issue showing where it stands and how long each stage took. Agents read issues from a local cache under `.vegastack/.tmp/issues/` and write back only through `vegafactory issue`, which sends the change to GitHub and refreshes the copy — so a read costs nothing and a write is never a raw `gh` call.

**One issue is also one worktree.** `vegafactory worktree` keeps a checkout per issue under `.vegastack/.worktrees/`, so the main checkout stays on the default branch and parallel work never shares a tree. A session **claims** the issue before building; the claim has a heartbeat, so an abandoned one is visible and can be taken back by name.

**The harness hooks are one command.** `vegafactory hook <event> --harness claude|codex` runs them all: it tells a session which issue it is on, keeps the claim alive, commits a `wip:` checkpoint each turn, asks once at the end for the lessons the session learned, and holds the **ship guard** — a fixed always-ask list plus the commands your `## Ship` section marks `ask:`, read from dev.md on the default branch, so a branch cannot loosen its own policy.

**Review is cross-tool.** `vegafactory review <n>` builds the packet, starts the *other* tool read-only in the issue's worktree, validates the verdict it returns and posts the one review comment itself — the reviewer never writes to GitHub. Up to three rounds per cycle. `vegafactory ship check <n>` then refuses to let anything merge that is not reviewed clean on the exact commit that would merge.

**Two words per issue, and only yours.** An ack on the brief or plan authorises building; "ship it" authorises that issue's PR, merge and cleanup. Both are recorded against the artifacts they approve, so editing the brief, the plan or the evidence spends the word. `vegafactory ship release <n>` re-reads that word when the release is tagged; raw tagging and tag pushes still ask.

**The factory keeps its own numbers and its own lessons.** `vegafactory stats` reads the harnesses' session logs for counts — turns, tokens, time, model, stage; never prompts or code — and `vegafactory dashboard` renders them as one offline page. `vegafactory learning` holds what sessions learned until you turn each into a dev.md line. `skills-refresh` re-checks the dated platform facts the skills pin and files what changed as issues.

**Verification is three layers behind a merge queue.** The commit hook runs the fast checks, the build runs the tests a change can reach, and the merge queue runs everything once — full suite, packed-tarball smoke test and the skill scan — on main plus your PR.

## Glossary

| Term | What it means |
|---|---|
| `waiting-on-operator` | The issue is yours: a brief or plan wants your ack, or a question wants your answer |
| `planning` | Approved, and the plan is being written |
| `queued` | Planned and acked — ready for an agent to pick up |
| `in-progress` | An agent holds a claim on it and is building |
| `ready-to-ship` | Built, reviewed and evidenced; waiting for "ship it" |
| Size | `small`, `medium`, `large` or `research`, exactly one per issue; `risky` and `epic` are separate marks |
| **Ack** | Your first word, on the brief or the plan. It authorises building, and nothing else |
| **"Ship it"** | Your second word, on the finished work. It authorises that issue's PR, merge and cleanup |
| **Claim** | One session's hold on one issue, with a heartbeat. A silent heartbeat means a likely dead session, and the claim can be taken back |
| **Ledger** (status comment) | The one CLI-written comment per issue: where it is now, how long each stage took, what is done |
| **Round** | One pass of the cross-tool review: findings out, fixes in. At most three per cycle |
| **Cycle** | A review's run of rounds against one head. Committing fixes, or editing the brief or plan, opens the next cycle at round 1 with the open findings carried over |
| **Control room** | The org's repository of shared defaults — people, repos, rules — that each project's dev.md layers on. `vegafactory sync` keeps a local copy |
| **Dispatcher** | The operator-side runner that picks up queued issues and starts sessions on them, so work moves without you opening each one |

## Skills

Every skill currently belongs to a group; the table below is where an ungrouped one would be listed.

<!-- Ungrouped skills go in this table. skillify's scaffold-skill.mjs anchors new ungrouped rows
     on this header and refuses to scaffold without it, so do not delete it when it is empty. -->

| Skill | What it does | Docs |
|---|---|---|

### Dev workflow

The issue-driven development workflow: nine stages from project bootstrap to the shipped, chronicled change.

| Skill | What it does | Docs |
|---|---|---|
| [dev-setup](skills/dev/dev-setup/) | Bootstraps a project for the issue-driven workflow: `.vegastack/dev.md`, the AGENTS.md section, the workflow labels, and the decision register | [SKILL.md](skills/dev/dev-setup/SKILL.md) |
| [dev-intake](skills/dev/dev-intake/) | Turns brainstorms, requests, and SOWs into agent-ready issues, with quoted-approval recording that flips `waiting-on-operator` to `queued` | [SKILL.md](skills/dev/dev-intake/SKILL.md) |
| [dev-plan](skills/dev/dev-plan/) | The planning stage between intake and implementation: approaches, a no-placeholder plan with failing-test-first steps, and the scope ratchet | [SKILL.md](skills/dev/dev-plan/SKILL.md) |
| [dev-architect](skills/dev/dev-architect/) | VegaStack's architecture advisor: the locked stack, recorded rejections, and dated platform facts behind a verify-before-you-recommend protocol | [SKILL.md](skills/dev/dev-architect/SKILL.md) |
| [dev-implement](skills/dev/dev-implement/) | Implements an approved issue end to end without user input: issue check, claim, dark build, tests, independent review, evidence comment, hand-back | [SKILL.md](skills/dev/dev-implement/SKILL.md) |
| [dev-debug](skills/dev/dev-debug/) | Reproduce-first bug work: a red repro command before any theory, ranked falsifiable suspects, and the regression test before the fix | [SKILL.md](skills/dev/dev-debug/SKILL.md) |
| [dev-review](skills/dev/dev-review/) | Cross-tool review of finished work — the other tool (Codex ↔ Claude Code) reads the diff read-only and the CLI posts the findings, with a bounded fix loop | [SKILL.md](skills/dev/dev-review/SKILL.md) |
| [dev-ship](skills/dev/dev-ship/) | Lands finished work on one operator word: PR, merge queue, merge, the worktree cleanup and then the project's `## Ship` runbook | [SKILL.md](skills/dev/dev-ship/SKILL.md) |
| [dev-status](skills/dev/dev-status/) | The operator's board — a deterministic gh-backed gather of state, progress, staleness and PRs, rendered needs-you-first with one Next action — and the project's chronicle: one story entry per behavior-changing branch, plus the "catch me up" digest read from it and the register | [SKILL.md](skills/dev/dev-status/SKILL.md) |

### Factory

Org-level skills: the control room whose defaults every repo layers on, and the onboarding of repos, machines and people into it.

| Skill | What it does | Docs |
|---|---|---|
| [vegafactory-setup](skills/factory/vegafactory-setup/) | Bootstraps and maintains the org control room — org, group, repos, dispatchers, boards, onboarding and stats — that every repo's dev profile layers on | [SKILL.md](skills/factory/vegafactory-setup/SKILL.md) |

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
| [skills-refresh](skills/skills-tooling/skills-refresh/) | Re-verifies the dated platform and harness facts the dev skills pin: a watchlist, a 60-day sweep, one subagent per tool, and one issue per change — it never edits a skill itself | [SKILL.md](skills/skills-tooling/skills-refresh/SKILL.md) |

## Installing a few, or upgrading

`init` installs everything. To pick, `add`, `update`, `verify` and `remove` each take **exactly one** selector; combining two is an error, not a merge.

| Selector | Installs |
|---|---|
| `--group dev` | The nine dev-workflow skills |
| `--all` | Every bundled skill except the repo-only ones |
| `<skill-name>` | That one skill, repo-only ones included |

A `--group` or `--all` install is one transaction: every skill is staged before any is committed, so if one fails, none are installed.

```sh
npx @vegastack/vegafactory@latest skills add --group dev --global --force
```

`--force` is needed to replace a copy you have edited; without it the installer refuses rather than discarding your edits. Skills install flat, at `<surface>/<name>/` — a group selects skills, it never appears in a path. The [installer README](packages/cli/README.md) has every command, flag, exit code and the full list of network calls. There is no telemetry.

## Repository structure

| Path | Purpose |
|---|---|
| `skills/<group>/<name>/` | Authored skill content — the source of truth. Each skill carries `SKILL.md`, `agents/openai.yaml`, `tests/` and `evals/`, plus `references/`, `scripts/` and `assets/` where it needs them; each group carries a `GROUP.md`. The packaged bundle is flat |
| `packages/cli/` | The `@vegastack/vegafactory` installer and workflow tool. Its skill copy and checksum manifest are generated at build time and never committed |
| `.vegastack/` | This repo's own instance of the workflow it ships: [dev.md](.vegastack/dev.md) (the handbook and release runbook), [decisions.md](.vegastack/decisions.md) and the chronicle |
| `.github/workflows/` | CI on pull requests and the merge queue, the tag-triggered release with npm provenance, and the board mirror |

Volatile facts in skill references — versions, limits, vendor mechanisms — carry the date they were checked and an official source, and are re-checked when they pass 60 days.

## Security

**These skills are scanned before they ship.** Every skill in the bundle is checked by [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) — 71 vulnerability patterns across prompt injection, data exfiltration, excessive agency, supply chain, and MCP-specific risks — in the merge queue, before any change reaches main, on the built bundle npm actually serves. The gate blocks on any unsuppressed HIGH or CRITICAL finding, never on the aggregate score. Suppressions are not a switch: each is a reviewed entry in [`.vegastack/skillspector-baseline.json`](.vegastack/skillspector-baseline.json) whose reason must say what would make the pattern a real finding again.

**You can scan any skill the same way — including one you are about to install from someone else.** Agent skills execute with your agent's authority, so "who wrote this and what does it actually do" is a fair question to ask of any of them, ours included.

```sh
uv tool install git+https://github.com/NVIDIA/skillspector.git
npx @vegastack/vegafactory skills add skill-scan --global
node ~/.claude/skills/skill-scan/scripts/skill-scan.mjs --root path/to/some-skill
```

That path is the guard's location for a global Claude Code install; substitute your own surface (`~/.agents/skills/…` for Codex, `.claude/skills/…` or `.agents/skills/…` for a project-local copy). Point `--root` at one skill directory or at a directory of them, flat or one group deep. Exit `0` is clean, `1` clean with warnings, `2` blocked — either by a finding, reported with its rule, severity and `file:line`, or because the scan could not be trusted at all: the scanner missing, an unreadable report, a baseline that fails its own discipline, or **a `SKILL.md` discovery never reached** — buried too deep, dot-prefixed, or behind a symlink. That last one matters: an unscanned skill nobody mentions is indistinguishable from a clean one, so the guard names it and refuses. Without `--root` it reads the `skill-scan:` knob from your project's dev.md.

A scanner hit is evidence, not a verdict — `dev-review`'s [security axis](skills/dev/dev-review/references/security-axis.md) sets out how to trace one before acting on it. Report vulnerabilities in these skills through [GitHub Security Advisories](SECURITY.md), not public issues.

## Develop

```sh
bun install --frozen-lockfile
bun run check:fast     # validators + lint + typecheck (also the commit-msg hook)
bun run test:affected  # only the tests your change can reach
bun run check          # everything (the merge queue runs this)
bun run build
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the repo layout, how to add a skill, the content-versioning rules, the no-generated-files policy and the scan's suppression discipline.

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

# dev-setup

The bootstrap for the issue-driven dev workflow: one re-runnable skill that gives a project — existing or brand-new — its profile (`.vegastack/dev.md`, the project's single canonical process doc), a thin marked section in AGENTS.md that both Claude Code and Codex read (with the one-line CLAUDE.md import Claude needs), the workflow labels on the GitHub repo, and the decision register. It detects the stack against per-stack playbooks and drafts the native release runbook, changelog convention, guards, and the `## Architecture` section dev-architect reads (migrating any legacy `.vegastack/arch.md`); it also detects agent skills in the repo and drafts the `skill-scan:` knob that the skill-scan skill's guard reads (`none` when the project authors none). On the user's yes it scaffolds guard workflow steps, the shared evidence repo, and the four-hook package (ship guard, SessionStart context, Stop heartbeat, decision nudge). `dev-intake`, `dev-implement`, and `dev-ship` invoke it automatically when the profile is missing.

The agent entry point is [SKILL.md](SKILL.md); everything else loads progressively from there.

## Install

```sh
npx @vegastack/vegafactory skills add dev-setup --global
```

Or the whole dev workflow at once:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

`--global` installs into your home directory, where the skill is available in every project; drop it for a project-local install. See the [installer README](../../../packages/cli/README.md) for all flags.

## What's in this skill

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent entry point: detect-first discipline, the interview rounds, write targets, re-run rules |
| [agents/openai.yaml](agents/openai.yaml) | Codex interface metadata |
| [references/conventions.md](references/conventions.md) | The workflow artifact spec — authored here, duplicated into every dev-family install |
| [references/harness-facts.md](references/harness-facts.md) | Verified, refresh-tracked Claude Code, Codex and Hermes mechanics (AGENTS.md handling, skill discovery, question tools, hooks, subagents), the GitHub CLI floors, the per-harness model/effort/concurrency controls, and the four-hook package wiring for all three harnesses |
| [references/github-app.md](references/github-app.md) | The VegaFactory GitHub App contract: what the App is for, its exact permission set, the org variable and secret names, the token-minting recipe, rotation, the kill switch, and the acceptance drill |
| [references/ask-route.md](references/ask-route.md) | The ask route — tool or issue, the questions comment format, the reply grammar, re-asks |
| [references/stack-playbooks.md](references/stack-playbooks.md) | Per-stack detection → draft mapping (npm/changesets, Node app, Flutter, Python, Go, generic), the guard library, and the greenfield playbook |
| [scripts/questions.mjs](scripts/questions.mjs) | The ask round renderer, answer parser and route decision — authored here, duplicated into intake, plan and implement |
| [scripts/effective-policy.mjs](scripts/effective-policy.mjs) | Canonical Markdown policy, org delegation, administration/read scope and registered-machine resolution with source/freshness diagnostics |
| [scripts/ship-policy.mjs](scripts/ship-policy.mjs) | Compiles dev.md's Environments lines, gates knob and backticked Ship ask: commands into `~/.vegastack/guard/<owner>__<repo>.json`, the one file the ship guard reads; `--check` exits 2 when it is stale |
| [assets/dev-profile.md.template](assets/dev-profile.md.template) | The `.vegastack/dev.md` starting point |
| [assets/agents-section.md.template](assets/agents-section.md.template) | The marked AGENTS.md block this skill owns |
| [assets/factory-board.yml.template](assets/factory-board.yml.template) | The board-mirror workflow dev-setup writes when the project has a project board |
| [assets/hooks/ship-guard.mjs](assets/hooks/ship-guard.mjs) | PreToolUse ship guard: reads only the compiled policy outside the worktree, parses the command as a shell would, and asks on a merge, tag, publish, deploy, force push or anything in the shipping family it cannot classify |
| [assets/hooks/session-start.mjs](assets/hooks/session-start.mjs) | SessionStart context: the operator's queue and the worktree claim this checkout holds |
| [assets/hooks/stop-heartbeat.mjs](assets/hooks/stop-heartbeat.mjs) | Stop heartbeat: one nudge to checkpoint the ledger when a working claim's ledger is older than the session |
| [assets/hooks/decision-nudge.mjs](assets/hooks/decision-nudge.mjs) | Stop decision nudge: asks whether this session settled a directional choice |
| [assets/hooks/session-end.mjs](assets/hooks/session-end.mjs) | SessionEnd statistics capture: one record per interactive session, plus a throttled control-room push |
| [assets/hooks/skill-activated.mjs](assets/hooks/skill-activated.mjs) | Records which skills a Claude session used, and whether the model or a person chose them |
| [assets/hooks/prompt-skill-mention.mjs](assets/hooks/prompt-skill-mention.mjs) | Records `$name` skill mentions in a Codex prompt as a proxy, marked as one |
| assets/workflows/implement-children.js (installed copy) | The saved Claude Code workflow (authored in dev-implement) copied to `.claude/workflows/` on the operator's yes, so a parent can run its independent children at the same time |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Freshness contract tracking the official harness-doc sources |
| [refresh/sources.json](refresh/sources.json) | Source registry: the official Claude Code, Codex, Hermes and GitHub CLI pages harness-facts.md is pinned to |
| `tests/` | Bun tests and the trigger-query fixture (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior contract

Detect first, ask second: everything findable (repo, stack, commands, existing files, labels) is presented as findings to correct, never as questions. The interview is three short rounds with recommended defaults; only four knobs are real questions. Writes are idempotent — the marked AGENTS.md block is the only thing the skill owns there, hand edits to dev.md always win, and re-runs show diffs before changing anything. With no question tool available (headless runs), it writes documented defaults marked `# TODO confirm` and says so — it never invents preferences.

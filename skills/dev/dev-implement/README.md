# dev-implement

Takes an approved (`ready`) GitHub issue and builds it end to end without further user input: preflight, claim (assignee + `working` label, so two agents can't grab one issue), task branch, dark execution bounded by the brief and the `.vegastack/dev.md` stop-list, the changelog entry per the project's `changelog:` knob, tests, the skill-scan guard where the project's `skill-scan:` knob names a root, independent review (subagent by default, cross-agent by knob), and exactly one evidence comment in the issue before handing back with `for-operator`. Creates no PR and merges nothing — that is `dev-ship`, on the user's word.

The agent entry point is [SKILL.md](SKILL.md).

## Install

```sh
npx @vegastack/vegafactory skills add dev-implement --global
```

Or the whole dev workflow at once:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

`--global` installs into your home directory, where the skill is available in every project; drop it for a project-local install. See the [installer README](../../../packages/cli/README.md) for all flags.

## What's in this skill

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent entry point: preflight, claim, dark-mode bounds, verify, review modes, evidence contract, corrections loop |
| [agents/openai.yaml](agents/openai.yaml) | Codex interface metadata |
| references/conventions.md (installed copy) | The workflow artifact spec, duplicated into every dev-family install |
| scripts/questions.mjs (installed copy) | The ask round renderer, parser and route decision, duplicated in from dev-setup |
| references/ask-route.md (installed copy) | The ask route: tool or issue, the questions comment format, the reply grammar |
| [scripts/lib/gh.mjs](scripts/lib/gh.mjs) | Shared guard plumbing: gh invocation, marker parsing, result contract |
| [scripts/lib/approval.mjs](scripts/lib/approval.mjs) | Canonical scoped-intent parsing, current approval and consolidated selection validation |
| [scripts/preflight.mjs](scripts/preflight.mjs) | Deterministic preflight guard (exit 2 blocks) |
| [scripts/evidence-check.mjs](scripts/evidence-check.mjs) | Evidence-comment shape guard; with `--issue`, also blocks when plan checkboxes lag the ledger's completed tasks |
| [scripts/reclaim.mjs](scripts/reclaim.mjs) | Operator-run release of an orphaned claim (`working` → `ready`, unassign; refuses a still-fresh ledger unless `--force`) |
| [scripts/evidence-upload.mjs](scripts/evidence-upload.mjs) | Uploads one screenshot to the shared evidence repo through the contents API: dry-run by default, `--write` sends, payload on stdin and never printed, one retry on 409 |
| [scripts/worktree.mjs](scripts/worktree.mjs) | The one-feature-one-worktree lifecycle: `create\|restore\|remove\|list\|prune\|status`, state derived from git and GitHub, the safe-to-remove test, retention prune — dry-run until `--write` |
| [scripts/children.mjs](scripts/children.mjs) | The parallel-children planner, launcher and join: `plan\|launch\|join\|remove` over a `plan-lint --groups` report — parallel-or-sequential, the concurrency cap, the per-harness launch shape, the declared-file-set scope check and the join over the children's reported results — dry-run until `--write` |
| [assets/workflows/implement-children.js](assets/workflows/implement-children.js) | The saved Claude Code workflow that runs one agent per independent child, each isolated in its own worktree, and returns the per-child result the join consumes; dev-setup copies it to `.claude/workflows/` on the operator's yes |
| [references/ledger-and-resume.md](references/ledger-and-resume.md) | Ledger usage and the resume protocol |
| [references/parallel-children.md](references/parallel-children.md) | Running a parent's independent children at the same time: the `children.mjs` verbs, the Claude workflow and Codex `codex exec -C` paths, the fallback ladder, the concurrency caps, the join with its declared-file-set scope check, and the ledger and removal rules |
| [references/worktrees.md](references/worktrees.md) | The worktree scenario matrix (claim, epic child, resume, corrections, ship, research, release, abandoned), the six lifecycle states, the safe-to-remove test and retention, and the Claude Code and Codex facts a worktree run depends on |
| [references/changelog-and-chronicle.md](references/changelog-and-chronicle.md) | Per-knob changelog mechanics, the entry's first-line rule, and the chronicle hand-off |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Evergreen waiver: this skill makes no volatile claims |
| [refresh/sources.json](refresh/sources.json) | Deliberately empty source registry behind the evergreen waiver |
| `tests/` | Bun tests and the trigger-query fixture (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior contract

Preflight fails closed: missing or stale scoped intent, open blockers, another claimant, or a material open decision in the brief each stop the run with a named reason. Dark mode means no progress pings and no questions — routine choices are the implementer's, stop-list hits end dark mode with one `needs-operator` comment. Tests are never weakened to pass. The evidence comment is edited in place across correction rounds so the current truth is always in one place.

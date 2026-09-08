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
| [scripts/evidence-check.mjs](scripts/evidence-check.mjs) | Evidence-comment shape guard; with `--issue`, compares exact approved task IDs in both plan and ledger |
| [scripts/recovery.mjs](scripts/recovery.mjs) | Bounded recovery packet, exact task/source reconciliation, preparation contracts and shared recovery decisions |
| [scripts/learning.mjs](scripts/learning.mjs) | Source-bound reversible lesson validation and bounded relevant-context selection |
| [scripts/reclaim.mjs](scripts/reclaim.mjs) | Operator-run release of an orphaned claim (`working` → `ready`, unassign; refuses a still-fresh ledger unless `--force`) |
| [scripts/evidence-upload.mjs](scripts/evidence-upload.mjs) | Uploads one screenshot to the shared evidence repo through the contents API: dry-run by default, `--write` sends, payload on stdin and never printed, one retry on 409 |
| [scripts/worktree.mjs](scripts/worktree.mjs) | The one-feature-one-worktree lifecycle: `create\|restore\|remove\|list\|prune\|status`, state derived from git and GitHub, the safe-to-remove test, retention prune — dry-run until `--write` |
| [scripts/children.mjs](scripts/children.mjs) | Independent-group planner and strict run/result validator; execution and joins use `vegafactory children run` / `join` |
| [assets/workflows/implement-children.js](assets/workflows/implement-children.js) | Legacy compatibility entry that refuses before spawning and names the verified CLI owner |
| [references/ledger-and-resume.md](references/ledger-and-resume.md) | Ledger usage and the resume protocol |
| [references/parallel-children.md](references/parallel-children.md) | Registered child execution, canonical group authority, global process limits, source-bound acceptance, ordered integration and recovery |
| [references/worktrees.md](references/worktrees.md) | The worktree scenario matrix (claim, epic child, resume, corrections, ship, research, release, abandoned), the six lifecycle states, the safe-to-remove test and retention, and the Claude Code and Codex facts a worktree run depends on |
| [references/changelog-and-chronicle.md](references/changelog-and-chronicle.md) | Per-knob changelog mechanics, the entry's first-line rule, and the chronicle hand-off |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Evergreen waiver: this skill makes no volatile claims |
| [refresh/sources.json](refresh/sources.json) | Deliberately empty source registry behind the evergreen waiver |
| scripts/effective-policy.mjs (installed copy) | Canonical workflow label map and exclusive state resolution, copied from dev-setup |
| `tests/` | Bun tests and the trigger-query fixture (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior contract

Preflight fails closed: missing or stale scoped intent, open blockers, another claimant, or a material open decision in the brief each stop the run with a named reason. Session attestations require a current policy-operator publisher; verified identical grant relays retain canonical source authority and lifecycle. Launch results expose canonical `approvalBindings`, while consolidated `recordBinding` retains the requested record for audit. Missing or inconsistent source reads cannot be corrected into permission; recovery refreshes authority before another effect. Dark mode means no progress pings and no questions — routine choices are the implementer's, stop-list hits end dark mode with one `needs-operator` comment. Tests are never weakened to pass. The evidence comment is edited in place across correction rounds so the current truth is always in one place.

## Recovery and verified lessons

Recovery retains canonical approval sources and a separate requested-record audit pin. Complete fresh source reads, exact commit/evidence checks and current ownership precede resuming outstanding task IDs or retrying delivery. A stale heartbeat, equal task counts, successful exit or source branch alone cannot prove completion. Unsupported packets stay inspectable and require verified reconstruction. No cumulative task deadline applies.

`vegafactory learning checkpoint --run-id ID --json` flushes prepared observations in the owned recovery packet; `inspect` selects at most three verified lessons within 2 KiB. An ordinary failed check followed by a source-bound passing check and an exact reversible approved patch can qualify a small change. Reviews use exact clean opposite-harness review bindings retained from freshly read source; measurements use actual monotonic ordinary-check durations. Unsupported evidence formats remain unverified. Risky code still requires independent review; protected rules remain proposals. `revert --run-id ID --id ID --dry-run|--apply --json` checks the exact inverse patch and preserves unrelated edits. Hooks do no model/network work and never read Claude or Codex native memory. See [ledger and resume](references/ledger-and-resume.md) for identity, delivery and recovery barriers.

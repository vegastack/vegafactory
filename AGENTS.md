# vegafactory — agent guide

<!-- vsk-dev:start -->
## Dev workflow

Read `.vegastack/dev.md` (stack, commands, knobs); if missing, run dev-setup first. The stages are the dev-family skills: dev-setup (bootstrap) · dev-intake (ideas to briefs) · dev-plan (approved briefs to plans) · dev-architect (stack judgment) · dev-implement (dark builds) · dev-debug (reproduce-first fixes) · dev-review (independent review) · dev-ship (gated landing) · dev-status (the operator's board) · dev-chronicle (the project's story).

Work flows through GitHub issues, labeled per dev.md's `labels:` knob; read and write them with `vegafactory issue` (never raw `gh` for issue content); artifact formats follow dev-setup's `references/conventions.md`. Route each request by kind:

| Request | Skill |
|---|---|
| a new capability, feature, bug report, or SOW — in chat or as an unlabeled issue | dev-intake, which writes the issue and never builds |
| a reply on a `waiting-on-operator` issue (an ack or more input) | the skill that asked: dev-intake for a brief, dev-plan for a plan |
| a `planning` issue | dev-plan |
| a `queued` issue, a resume handover, or corrections on `ready-to-ship` | dev-implement |
| a trivial fix asked in chat — one or two files, no new dependency, no behaviour beyond the words | dev-implement's direct path |
| "ship it", "make the PR", "merge", "release" | dev-ship |
| "status", "catch me up" | dev-status, dev-chronicle |

**Local, reversible actions proceed; actions that are hard to reverse, affect shared systems, or are visible to others wait for the operator's word** — push to the default branch, merge, tag, publish, deploy, force-push, a hard reset, branch or worktree deletion, `--no-verify`; green checks, schedules, and standing approvals authorise none of them. Per issue the operator gives two words: an ack on the brief or plan (it authorizes building) and "ship it" (it authorizes that issue's PR, merge, release and cleanup); record both with `vegafactory issue ack`. Behavior changes carry their changelog entry (dev.md's `changelog:` knob) before hand-back; after merge, dev.md's `## Ship` runbook says which steps need the operator's word.

Agent conduct: say what you mean — when a literal phrase is available, use it. Lead with the outcome, for a reader who did not watch the work. Report progress only against a tool result from this session; say plainly what is unverified. Pause for the operator only for a destructive or irreversible action, a real scope change, or input only they can provide; then ask and end the turn instead of promising. The approved brief or plan is the scope; extras are a closing note. Edit files surgically rather than rewriting them whole.

Directional decisions (`## Decisions` in dev.md says what qualifies) get one dated line in the register dev.md names: when a session settles such a choice, propose the line and add it only on the user's yes.

dev.md is the project's self-maintained handbook: when a gotcha or repeated instruction surfaces, propose the one line that would have prevented it — folded into existing lines, never a log — and add it on the user's yes.
<!-- vsk-dev:end -->

## Repo specifics

This repo *is* the dev skills it ships, and it runs on them: `.vegastack/` is a live instance of the workflow described above, so the process docs here are also a worked example of the product.

- **Process authority:** CONTRIBUTING.md → `.vegastack/dev.md` → `skill-maintainer`'s release-ops.md → skill defaults. dev.md's `authority:` line is the one home for that order, and its `## Ship` runbook is the release flow.
- **`skills/` is the only source of truth.** `packages/cli/skill/` and `packages/cli/skill-integrity.json` are build output — written by `bun run build`, gitignored, never edited and never committed. A repo-wide search hits both trees and returns the same content twice; the copy under `packages/cli/skill/` is the stale one.
- **Layout is exactly two levels:** `skills/<group>/<name>/`, never deeper, with a `GROUP.md` per group — currently `dev`, `factory`, `skills-tooling` and `repo-tooling`. The published bundle is flat, so skill names are unique across the whole tree and install commands never carry a group.
- **Authoring and standards:** new or changed skills go through `skillify`, which scaffolds the tree and performs the repo wiring itself; repo, release and scan-triage standards live in `skill-maintainer`. Both are listed in `packages/cli/repo-only.json`, so `add --all` skips them.
- **Verification runs in three places, each once.** The commit-msg hook runs `bun run check:fast` (skipped for `wip:` checkpoints); while building run `bun run test:affected`; the merge queue runs the full `bun run check`. The SkillSpector scan runs only in the merge queue: it needs Python 3.12 and a pinned `skillspector`, and it reads the **built** bundle, because the authored tree's test fixtures are adversarial on purpose. Run it locally only to investigate a finding — invocation in dev.md's `## Verify`.
- **Agent-tool directories:** `.claude/` is gitignored, so installing skills there pollutes nothing. `.agents/` is **not** ignored — add the ignore line before installing into it.

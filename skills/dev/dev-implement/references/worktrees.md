# One feature, one worktree

The main checkout never leaves the default branch and never carries uncommitted work. Every branch — feature, epic parent, trivial chat fix, research spike, release — is checked out at `.vegastack/.worktrees/<n>-<slug>/` on `<type>/<n>-<slug>`, per `references/conventions.md`. All of it is decided by `scripts/worktree.mjs`, with `vegafactory worktree …` wrapping its create, restore, remove, list, prune, and `status --json` commands; anything destructive remains a dry run until `--write`, and every verb exits `0` pass · `1` warn · `2` blocked.

## Scenario matrix

| Scenario | What happens |
|---|---|
| New issue | `vegafactory worktree create <n>` — the slug and type come off the issue title (`<type>:` prefix, the rest slugified; `--slug`/`--type` override, and GitHub being unreachable blocks rather than guesses) — fetches `origin/<default>`, `git worktree add` on a new branch, copies dev.md's `worktree-include:` files, runs `commands: setup`, adds the Codex trust entry. The ledger's first line records the path. |
| Epic parent | A map only — no branch or worktree of its own. |
| Sub-issue of an epic | Its own branch and worktree cut from the default branch, like any issue, and its own PR. Siblings whose declared file sets do not overlap may run at the same time. |
| Resume | Same branch, same worktree, reused. The resume read-order — brief → plan → ledger → `git log` — runs *there*, and the ledger names which "there" that is. |
| Corrections / reclaim | Reuse the worktree. Directory gone but branch alive → `vegafactory worktree restore <n>`, which finds the branch carrying the number (`--slug` picks one when several do), re-adds the checkout and re-runs include-copy, setup and trust. `restore` never creates a branch: a missing branch means the work is elsewhere. |
| Ship, PR | `ship-gate.mjs` resolves the branch's worktree itself (`--worktree <path>` overrides) and runs its git calls, its dev.md read and the fresh check command there, so the checkout test passes by construction. |
| Ship, merge | After the merge: `vegafactory worktree remove <n>`. That removes the **directory only** — deleting the local branch and the remote branch are separate operator words. A parent's worktree goes only when the parent PR merges. |
| Rebase onto the default branch | Done inside the worktree; re-verify whatever the rebase touched. |
| Direct chat trivial fix | `<type>/<slug>` in its own worktree too — the main checkout stays clean even for a one-liner. |
| Research | `research/<n>-<slug>` worktree only when code is actually written; removed at hand-back, never merged. |
| Release | `chore/release-<version>` in its own worktree. |
| Cross-agent review | Read-only, in the same worktree; a reviewer never switches the branch under it. |
| Abandoned issue | Branch and worktree are removed only on the operator's word. |

## Lifecycle states

Derived from git plus GitHub on every read, never stored — a second source of truth is what drifts. Precedence is top to bottom:

| State | Derivation |
|---|---|
| `orphan-dir` | The directory exists, its branch does not. |
| `branch-only` | The branch exists, its directory does not — what `restore` fixes. |
| `active` | A session holds it: `git worktree lock`, or the dispatcher's lock. |
| `merged` | The branch is on the remote **and** on `origin/<default>` — by ancestry, or by content when a squash or rebase merge rewrote the commits: its whole diff against the merge base, or every one of its commits, has a patch-id already there. A never-pushed branch cannot have merged: the default branch is reached through a PR. |
| `abandoned` | The issue is closed and the branch never merged. |
| `parked` | The residue: issue open, no session. |

## Safe to remove — all must hold

1. `git status --porcelain` is empty.
2. `git rev-list <remote>/<branch>..<branch>` is empty, and the remote branch exists. Missing or behind → push first, then re-check (`--push` does exactly that).
3. Merged into `origin/<default>` — `remove` and `prune` fetch it first, because the merge lands on the server — **or** `--force` with the operator's word.
4. Not locked.

`--force` lifts only rule 3. Uncommitted, unpushed and locked are never lifted — those are the three ways real work disappears. Failing any rule keeps the worktree and reports which rule failed.

**Retention.** `worktree-retention:` (default `14d`) measured from the **later** of the last commit and the last ledger edit. `prune` proposes only `parked` worktrees past the window and is dry-run until `--write`. On `--write` it pushes an unpushed candidate's branch first — that half protects the work and happens whatever else is wrong — then re-runs the safe-to-remove test with the window standing in for rule 3 (parked means unmerged, and the pushed branch plus `restore` bring the checkout back), so a candidate that is still dirty, unpushed or locked keeps its worktree and says why. The branch always survives; branch deletion and `--force` on `remove` take the operator's word.

## Harness facts that bear on a worktree run

- **Claude Code hooks:** the `CLAUDE_PROJECT_DIR` variable (written with the usual shell-expansion sigils, omitted here because they trip SkillSpector's bounded parser) stays at the launch root, while the hook input's `cwd` follows the worktree — hooks that need to know where the work is read `cwd`.
- **Claude Code permissions:** an approval granted inside a worktree is written to the **main checkout's** `.claude/settings.local.json` and applies everywhere. Approving in one worktree approves for all of them.
- **`claude -p` runs never clean up worktrees.** Cleanup belongs to the factory (dev-ship after merge, `prune` after retention), not to the harness.
- **Codex:** an untrusted path skips `.codex/` hooks, rules and project config, so each worktree path is added to `~/.codex/config.toml` as `[projects."<abs path>"]` / `trust_level = "trusted"` at create and restore time. `codex` absent from `PATH` makes this a warning, not a block.
- **Claude Code's own `--worktree` / `EnterWorktree` is deliberately not used:** its location (`.claude/worktrees/<name>`) and branch (`worktree-<name>`) differ from ours, and it exists on one harness only. Plain `git worktree add` works for Claude and Codex alike.

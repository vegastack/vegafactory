# One feature, one worktree

The main checkout never leaves the default branch and never carries uncommitted work. Every branch — feature, epic parent, trivial chat fix, research spike, release — is checked out at `.vegastack/.worktrees/<n>-<slug>/` on `<type>/<n>-<slug>`, per `references/conventions.md`. All of it is decided by `scripts/worktree.mjs`, with `vegafactory worktree …` wrapping its create, restore, remove, list, prune, and `status --json` commands; anything destructive remains a dry run until `--write`, and every verb exits `0` pass · `1` warn · `2` blocked.

## Scenario matrix

| Scenario | What happens |
|---|---|
| New issue | `vegafactory worktree create <n>` — the slug and type come off the issue title (`<type>:` prefix, the rest slugified; `--slug`/`--type` override, and GitHub being unreachable blocks rather than guesses). The types are dev.md's `branch:` knob and nowhere else; a prefix outside that list is not a type, leaves the slug, and makes `create` refuse and name the ones this project has, rather than quietly becoming `feat`. Then it fetches `origin/<default>`, `git worktree add` on a new branch, copies dev.md's `worktree-include:` files, adds the Codex trust entry. Dependencies are **not** installed: a step that needs them runs dev.md's `setup` itself, so a docs-only issue costs a few megabytes rather than a full install. The ledger's first line records the path. |
| Epic parent | A map only — no branch or worktree of its own. |
| Sub-issue of an epic | Its own branch and worktree cut from the default branch, like any issue, and its own PR. The plan records which siblings' file sets do not overlap and so *may* run at the same time; the worker (#218) is what will run them, and until then they are worked one at a time. |
| Resume | Same branch, same worktree, reused. The resume read-order — brief → plan → ledger → `git log` — runs *there*, and the ledger names which "there" that is. |
| Corrections / take-back | Reuse the worktree. Directory gone but branch alive → `vegafactory worktree restore <n>`, which finds the branch carrying the number (`--slug` picks one when several do), re-adds the checkout and re-runs include-copy and trust. `restore` never creates a branch: a missing branch means the work is elsewhere. |
| Ship, PR | `vegafactory ship check <n>` runs in the issue's worktree: it reads the branch there and refuses uncommitted changes. |
| Ship, merge | After the merge: `vegafactory worktree remove <n>`. That removes the **directory only** — deleting the local branch and the remote branch are separate operator words. A parent's worktree goes only when the parent PR merges. |
| Rebase onto the default branch | Done inside the worktree; re-verify whatever the rebase touched. |
| Direct chat trivial fix | `<type>/<slug>` in its own worktree too — the main checkout stays clean even for a one-liner. |
| Research | A worktree only when code is actually written, on a type dev.md's `branch:` knob lists — `chore/<n>-<slug>` unless the project adds `research` to that knob; removed at hand-back, never merged. |
| Release | `chore/release-<version>` in its own worktree. |
| Cross-tool review | Read-only, in the same worktree; a reviewer never switches the branch under it. |
| Abandoned issue | Branch and worktree are removed only on the operator's word. |

## Lifecycle states

Derived from git plus GitHub on every read, never stored — a second source of truth is what drifts. Precedence is top to bottom:

| State | Derivation |
|---|---|
| `orphan-dir` | The directory exists, its branch does not. |
| `branch-only` | The branch exists, its directory does not — what `restore` fixes. |
| `active` | A session holds it: `git worktree lock`, or the worker's lock. |
| `merged` | The branch is on the remote **and** on `origin/<default>` — by ancestry, or by content when a squash or rebase merge rewrote the commits: its whole diff against the merge base, or every one of its commits, has a patch-id already there. A never-pushed branch cannot have merged: the default branch is reached through a PR. |
| `abandoned` | The issue is closed and the branch never merged. |
| `parked` | The residue: issue open, no session. |

## Safe to remove — all must hold

1. `git status --porcelain` is empty.
2. `git rev-list <remote>/<branch>..<branch>` is empty, and the remote branch exists. Missing or behind → push first, then re-check (`--push` does exactly that).
3. Merged into `origin/<default>` — `remove` and `prune` fetch it first, because the merge lands on the server — **or** `--force` with the operator's word.
4. Not locked.

`--force` lifts only rule 3. Uncommitted, unpushed and locked are never lifted — those are the three ways real work disappears. Failing any rule keeps the worktree and reports which rule failed.

**Retention.** `worktree-retention:` (default `14d`) measured from the **later** of the last commit and the last ledger edit. `prune` proposes only `parked`, `merged` or `abandoned` worktrees past the window. Like every other verb it **acts**, and `--dry-run` is what holds it back — `--write` says what is already true, and the ship guard asks before any prune that is not a dry run. On `--write` it pushes an unpushed candidate's branch first — that half protects the work and happens whatever else is wrong — then re-runs the safe-to-remove test with the window standing in for rule 3 (parked means unmerged, and the pushed branch plus `restore` bring the checkout back), so a candidate that is still dirty, unpushed or locked keeps its worktree and says why. The branch always survives; branch deletion and `--force` on `remove` take the operator's word.

**Dependencies go first.** `worktree-deps-retention:` (default `3d`, and never read as longer than `worktree-retention:`) drops a worktree's `node_modules` while it is idle, on the same conditions that protect the worktree itself: never while anything is uncommitted, never while it is locked, never while anything git tracks lives under `node_modules`. Only `node_modules` is removed, by name — the code, the branch and the history stay where they are, and a record of the drop lives beside the repository's worker state, so `worktree list`, `worktree status` and the next prune all say which `setup` command puts them back. Running it as part of the build that needs it is #275. A worktree that never had dependencies installs nothing, which is what keeps a docs-only issue cheap.

## Harness facts that bear on a worktree run

- **Claude Code hooks:** the `CLAUDE_PROJECT_DIR` variable (written with the usual shell-expansion sigils, omitted here because they trip SkillSpector's bounded parser) stays at the launch root, while the hook input's `cwd` follows the worktree — hooks that need to know where the work is read `cwd`.
- **Claude Code permissions:** an approval granted inside a worktree is written to the **main checkout's** `.claude/settings.local.json` and applies everywhere. Approving in one worktree approves for all of them.
- **`claude -p` runs never clean up worktrees.** Cleanup belongs to the factory (dev-ship after merge, `prune` after retention), not to the harness.
- **Codex:** an untrusted path skips `.codex/` hooks, rules and project config, so each worktree path is added to `~/.codex/config.toml` as `[projects."<abs path>"]` / `trust_level = "trusted"` at create and restore time. `codex` absent from `PATH` makes this a warning, not a block.
- **Claude Code's own `--worktree` / `EnterWorktree` is deliberately not used:** its location (`.claude/worktrees/<name>`) and branch (`worktree-<name>`) differ from ours, and it exists on one harness only. Plain `git worktree add` works for Claude and Codex alike.

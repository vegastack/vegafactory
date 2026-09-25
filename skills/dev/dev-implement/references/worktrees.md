# One feature, one worktree

The main checkout never leaves the default branch and never carries uncommitted work. An issue branch stays descriptive as `<type>/<n>-<slug>`, but its directory is keyed only by the stable issue number: `.vegastack/.worktrees/<n>/` in an attended repository and `~/.vegafactory/worker/repos/<owner>__<repo>/issues/<n>/` in a worker repository holder. A renamed title therefore changes neither checkout identity nor resume path. Direct-chat and release branches with no issue use their slug as the directory leaf; an issue-shaped digit-led slug is refused. `scripts/worktree.mjs` owns this contract, with `vegafactory worktree …` wrapping create, restore, remove, list, prune, prepare, and `status --json`; each exits `0` pass · `1` warn · `2` blocked.

## Scenario matrix

| Scenario | What happens |
|---|---|
| New issue | `vegafactory worktree create <n>` — the branch slug and type come off the issue title (`<type>:` prefix, the rest slugified; `--slug`/`--type` override, and GitHub being unreachable blocks rather than guesses), while the directory leaf is `<n>`. The types are dev.md's `branch:` knob and nowhere else; an unknown prefix is refused rather than quietly becoming `feat`. It fetches `origin/<default>`, adds the worktree, copies `worktree-include:` files and adds Codex trust. It does not install dependencies for a fresh checkout. |
| Epic parent | A map only — no branch or worktree of its own. |
| Sub-issue of an epic | Its own branch and worktree cut from the default branch, like any issue, and its own PR. The plan records which siblings' file sets do not overlap and so *may* run at the same time; the worker (#218) is what will run them, and until then they are worked one at a time. |
| Resume | Same branch, same worktree, reused. The resume read-order — brief → plan → ledger → `git log` — runs *there*, and the ledger names which "there" that is. |
| Corrections / take-back | Reuse the numeric worktree. Directory gone but branch alive → `vegafactory worktree restore <n>`, which accepts only the branch whose config records that issue identity and re-adds the checkout and include-copy/trust wiring. A reclaimed-dependencies marker in an existing checkout instead requires `vegafactory worktree prepare <n>` before work. `restore` never guesses from a digit-led branch name or creates a branch: a missing identity record leaves the work untouched. |
| Ship, PR | `vegafactory ship check <n>` runs in the issue's worktree: it reads the branch there and refuses uncommitted changes. |
| Ship, merge | After the merge: `vegafactory worktree remove <n>`. That removes the **directory only** — deleting the local branch and the remote branch are separate operator words. A parent's worktree goes only when the parent PR merges. |
| Rebase onto the default branch | Done inside the worktree; re-verify whatever the rebase touched. |
| Direct chat trivial fix | `<type>/<slug>` in its own worktree too — the main checkout stays clean even for a one-liner. |
| Research | A worktree only when code is actually written, on a type dev.md's `branch:` knob lists — `chore/<n>-<slug>` unless the project adds `research` to that knob; removed at hand-back, never merged. |
| Release | `chore/release-<version>` in its own worktree. |
| Legacy `<n>-<slug>` checkout | Listed and removable only by exact `--name`; quarantined from issue hooks, GitHub/ledger reads, `--issue` removal, restore, and status reconciliation because its leaf is indistinguishable from an old digit-led direct-chat slug. Inspect and preserve it, then explicitly remove or migrate it before creating the numeric issue checkout. |
| Cross-tool review | Read-only, in the same worktree; a reviewer never switches the branch under it. |
| Abandoned issue | A closed issue becomes a prune candidate immediately, but every dirty/unpushed/locked/detached safety rule still applies. |

## Lifecycle states

Derived from git plus GitHub on every read, never stored — a second source of truth is what drifts. Precedence is top to bottom:

| State | Derivation |
|---|---|
| `orphan-dir` | The directory exists without a branch. It is removable only when clean and its detached HEAD is reachable from another local or remote ref; a unique commit is kept by name. |
| `branch-only` | The branch exists, its directory does not — what `restore` fixes. |
| `active` | A session holds it: `git worktree lock`, or the worker's lock. |
| `merged` | The branch is on the remote **and** on `origin/<default>` — by ancestry, or by content when a squash or rebase merge rewrote the commits: its whole diff against the merge base, or every one of its commits, has a patch-id already there. A never-pushed branch cannot have merged: the default branch is reached through a PR. |
| `abandoned` | The issue is closed and the branch never merged. |
| `parked` | The residue: issue open, no session. |

## Safe to remove — all must hold

1. `git status --porcelain` is empty.
2. `git rev-list <remote>/<branch>..<branch>` is empty. A never-pushed or locally-ahead branch is kept. A remote branch deleted after merge is not recreated.
3. Merged into `origin/<default>` — `remove` and `prune` fetch it first, because the merge lands on the server — **or** `--force` with the operator's word.
4. Not locked.

`--force` lifts only rule 3. Uncommitted, unpushed and locked are never lifted — those are the three ways real work disappears. Failing any rule keeps the worktree and reports which rule failed.

**Reclamation.** Bare `vegafactory worktree prune` always previews; only `prune --write` mutates, and `--dry-run` wins in either flag order. Candidates are a merged branch, a closed issue, or a checkout past `worktree-retention:` (default `14d`), measured from the later of its last commit and ledger edit. Dirty work may be rescued only when its remote branch already exists, no staged selection would be disturbed, and the secret scan passes; every failed add/commit path restores the original index. Never-pushed, locally-ahead, locked, unsafe, or uniquely detached work stays put with every refusal named.

**Dependencies.** `worktree-deps-retention:` defaults to `3d` and is clamped to the worktree window. Between those windows, `prune --write` may remove only an untracked `node_modules` directory from a clean, pushed, unlocked checkout. It publishes a schema-checked `0600` marker first under an owner-controlled `0700` store; invalid or unreadable marker state blocks another dependency deletion. Every path component from the owned root through the checkout and dependency must be a current-UID ordinary directory that another UID cannot replace. The next attended session names `vegafactory worktree prepare <n>` and denies implementation tools until it succeeds; the worker runs the same repository-declared `commands: setup` before its agent, charging both to one step deadline. Failure, interruption, or an unsafe marker leaves the marker in place.

## Harness facts that bear on a worktree run

- **Claude Code hooks:** the `CLAUDE_PROJECT_DIR` variable stays at the launch root, while the hook input's `cwd` follows the worktree — hooks that need to know where the work is read `cwd`.
- **Claude Code permissions:** an approval granted inside a worktree is written to the **main checkout's** `.claude/settings.local.json` and applies everywhere. Approving in one worktree approves for all of them.
- **`claude -p` runs never clean up worktrees.** Cleanup belongs to the factory (dev-ship after merge, `prune` after retention), not to the harness.
- **Codex:** an untrusted path skips `.codex/` hooks, rules and project config, so each worktree path is added to `~/.codex/config.toml` as `[projects."<abs path>"]` / `trust_level = "trusted"` at create and restore time. `codex` absent from `PATH` makes this a warning, not a block.
- **Claude Code's own `--worktree` / `EnterWorktree` is deliberately not used:** its location (`.claude/worktrees/<name>`) and branch (`worktree-<name>`) differ from ours, and it exists on one harness only. Plain `git worktree add` works for Claude and Codex alike.

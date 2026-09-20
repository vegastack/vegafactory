---
"@vegastack/vegafactory": minor
---

Worktrees tidy themselves up, inside the pass the worker already makes.

- Dependencies go first and on a shorter window than the worktree itself, under the new `worktree-deps-retention` knob. They are the cost: on the machine that prompted this, 628 MB of a 638 MB worktree was `node_modules` and the checkout itself was 10 MB — so dropping them reclaims nearly everything while the code, the branch and the history stay exactly where they were.
- Nothing uncommitted, unpushed or locked ever loses anything, dependencies included, and a worktree a run is holding is skipped whole. The worker's pass is deliberately narrower than the `prune` a person runs: it never pushes a branch and never commits anything as `wip`, because a person asked and can be told "your work is on a branch" while a background pass has nobody to tell. What it will not touch is reported through the worker's own notes rather than silently skipped.
- Merged and abandoned worktrees are reclaimed too, not only parked ones.
- Restoring a worktree puts back exactly what was taken, and nothing else: a marker records that prune dropped the dependencies, and `setup` runs once to reinstall them. A fresh worktree still installs nothing, so a docs-only issue stays cheap.
- The tidy-up rides in the poll pass rather than on a schedule of its own, so there is one thing to reason about and one place it reports.
- A second run on an issue resumes the agent thread the first one started, and forks it once the branch has moved. Claude Code's `--session-id` is derived from the repository and the issue rather than remembered, so a resume needs nothing recorded; what is recorded is the commit the thread last saw. A rebase, a review round that rewrote the work, or a commit from another machine means the thread would be reasoning about code that no longer exists, so the next run is a new thread. `codex exec` takes no session id, so none is passed and nothing claims otherwise.

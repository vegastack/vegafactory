---
"@vegastack/vegafactory": minor
---

Worktrees tidy themselves up, inside the pass the worker already makes.

- Dependencies go first and on a shorter window than the worktree itself, under the new `worktree-deps-retention` knob. They are the cost: on the machine that prompted this, 628 MB of a 638 MB worktree was `node_modules` and the checkout itself was 10 MB — so dropping them reclaims nearly everything while the code, the branch and the history stay exactly where they were.
- Nothing uncommitted, unpushed or locked ever loses anything, dependencies included, and a worktree a run is holding is skipped whole. The worker's pass is deliberately narrower than the `prune` a person runs: it never pushes a branch and never commits anything as `wip`, because a person asked and can be told "your work is on a branch" while a background pass has nobody to tell. What it will not touch is reported through the worker's own notes rather than silently skipped.
- Merged and abandoned worktrees are reclaimed too, not only parked ones.
- Restoring a worktree puts back exactly what was taken, and nothing else: the drop is recorded beside the repository's worker state — outside the checkout it describes, which a deps-only prune leaves in place — and `setup` runs once to reinstall them. A fresh worktree still installs nothing, so a docs-only issue stays cheap.
- The tidy-up rides in the poll pass rather than on a schedule of its own, so there is one thing to reason about and one place it reports.
- A session holds its worktree with git's own lock while it works, and gives it back when it ends. Nothing else told the unattended pass that somebody was sitting in a checkout, and no timestamp finds them — a person reading and building all afternoon writes nothing git can see. The safe-to-remove test already refuses a locked worktree, so this is one signal rather than a second idea of what is safe.

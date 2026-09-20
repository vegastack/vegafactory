---
"@vegastack/vegafactory": minor
---

Worktrees tidy themselves up, inside the pass the worker already makes.

- Dependencies go first and on a shorter window than the worktree itself, under the new `worktree-deps-retention` knob. They are the cost: on the machine that prompted this, 628 MB of a 638 MB worktree was `node_modules` and the checkout itself was 10 MB — so dropping them reclaims nearly everything while the code, the branch and the history stay exactly where they were.
- Nothing uncommitted, unpushed or locked ever loses anything, dependencies included. What the safe-to-remove test refuses is reported through the worker's own notes rather than silently skipped.
- Restoring a worktree puts back exactly what was taken, and nothing else: a marker records that prune dropped the dependencies, and `setup` runs once to reinstall them. A fresh worktree still installs nothing, so a docs-only issue stays cheap.
- The tidy-up rides in the poll pass rather than on a schedule of its own, so there is one thing to reason about and one place it reports.

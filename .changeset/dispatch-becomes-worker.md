---
"@vegastack/vegafactory": minor
---

`vegafactory dispatch` is `vegafactory worker`. A machine that works a board with nobody watching is a worker, which is what its `nodes.md` row already calls it.

- The verb, the module, the service unit and the prose all move. `GhRunner` does not: "runner" there is the thing that shells out to `gh`, and `worker` was chosen over `runner` so that name — and the Actions runner the onboarding document describes — need not move at all.
- **`enable` boots out the retired service first.** `disable` finds its unit path from the platform alone, so after the rename it would take the new service away and leave the old one restarting forever on a verb this CLI no longer has. Had the old verb survived as an alias, both units would have run and the run lock would have silenced the new one — the rename looking successful while the worker never ran. The old label and unit name stay in the code as tombstones.
- **A claim the released version wrote is still a worker claim.** `kind=dispatch` is on live issues; an unrecognised kind falls back to `session`, whose claim goes stale after four hours instead of thirty minutes. Both spellings read as the same kind, and `--kind dispatch` still works for anything scripted against the released CLI.
- The paths under `.vegastack/.tmp/dispatch/` keep their name. Renaming them would strand the run records, the child list and the lock of a machine that upgrades mid-run, and nobody reads that path by hand.

---
"@vegastack/vegafactory": minor
---

One dispatcher now works every repository its roster row lists, with the caps that row sets.

- The `caps` cell — `runs 10 · step 72h · poll 1m · retry 15m · park 3` — replaces the built-in constants for that machine. Every field is optional, it is found by what it says rather than which column it sits in, and a cell that means to set a cap and cannot be read refuses the machine rather than running it on numbers nobody chose.
- Caps live on the machine's row because they belong to the machine and not to any project it works, and they are re-read from the refreshed roster every pass, so changing one is a control-room PR that lands on the next poll without a restart.
- A pass walks every listed board; one that cannot be read is reported and skipped rather than costing the others their pass.
- A run is now named by its repository and issue, so the same number on two boards is two runs, and a merge slot is per repository — two projects may land at once, two issues in one project may not.
- The step limit reaches the watchdog that enforces it, so a run may take as long as the caps allow instead of being stopped at twenty minutes.
- `dispatch status` prints the caps in force and the boards being watched.

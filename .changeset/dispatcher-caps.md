---
"@vegastack/vegafactory": minor
---

A dispatcher's limits now come from its roster row instead of being fixed in the code.

- `runs 10 · step 72h · poll 1m · retry 15m · park 3` in a `caps` cell on the machine's row: how many runs at once, how long one may take, how often the board is read, how long a failure waits, and how many failures park an issue for a person.
- Every field is optional and falls back to the shipped default, the cell is found by what it says rather than which column it sits in, and a cell that names a cap and cannot be read refuses that machine rather than running it on numbers nobody chose.
- The caps are re-read from the refreshed roster every pass, so changing one is a control-room PR that takes effect on the next poll without a restart or a release. A step limit longer than the hour an installation token lives is called out when the dispatcher starts.
- Two fixes found alongside: a failed or stopped run now goes back to the state it came from instead of staying `in-progress`, and the shipped roster template's header row is no longer read as a machine called `dispatcher`.

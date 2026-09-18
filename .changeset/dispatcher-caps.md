---
"@vegastack/vegafactory": minor
---

A dispatcher's limits now come from its roster row instead of being fixed in the code, and the roster is read by the names of its columns.

- `runs 10 · step 72h · poll 1m · retry 15m · park 3` in a `caps` cell on the machine's row: how many runs at once, how long one may take, how often the board is read, how long a failure waits, and how many failures park an issue for a person.
- Every field is optional and falls back to the shipped default. A cell that names a cap and cannot be read refuses that machine **by name**, saying what the shape is — the row is still read, so the operator is sent to the typo rather than to a row that looks missing.
- The roster's header row now says which column is which, so a room may reorder or add columns and the shipped template's own order is read correctly. Prose in a notes column is never mistaken for caps, whatever words it contains. A table with no header is read as the three columns every roster had before caps existed; a wider one with no header refuses and asks for its columns to be named, because no position is known to hold the caps and a gate does not guess.
- The caps are re-read from the refreshed roster every pass, so changing one is a control-room PR that takes effect on the next poll without a restart or a release. The roster is now verified **once** a pass and that one answer is acted on; before, a second verification could see this machine de-listed and be ignored.
- `--json` puts exactly one document on stdout and nothing beside it; the lines a human would read travel inside it. It reports one pass, so it needs `--once` and refuses without it — an always-on loop has no moment to answer at, and collecting its lines for one would hold every line the machine ever printed.
- A stop that was nothing to do with the issue — the machine de-listed, the service told to stop, a signal — no longer spends the issue's trigger. Before, `standDown` put the issue back as `queued` or `planning` while the record said the work had already run for that state, so no machine ever picked it up again.
- Two fixes found alongside: a failed or stopped run now goes back to the state it came from instead of staying `in-progress`, and the shipped roster template's header row is no longer read as a machine called `dispatcher`.

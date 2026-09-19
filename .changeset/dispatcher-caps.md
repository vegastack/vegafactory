---
"@vegastack/vegafactory": minor
---

A dispatcher's limits now come from its roster row instead of being fixed in the code, and the roster is read by the names of its columns.

- `runs 10 · step 72h · poll 1m · retry 15m · park 3` in a `caps` cell on the machine's row: how many runs at once, how long one may take, how often the board is read, how long a failure waits, and how many failures park an issue for a person.
- Every field is optional and falls back to the shipped default. A cell that names a cap and cannot be read refuses that machine **by name**, saying what the shape is — the row is still read, so the operator is sent to the typo rather than to a row that looks missing.
- The roster's header row now says which column is which, so a room may reorder or add columns and the shipped template's own order is read correctly. Prose in a notes column is never mistaken for caps, whatever words it contains. A table with no header is read as the three columns every roster had before caps existed; a wider one with no header refuses and asks for its columns to be named, because no position is known to hold the caps and a gate does not guess.
- The caps are re-read from the refreshed roster every pass, so changing one is a control-room PR that takes effect on the next poll without a restart or a release. The roster is now verified **once** a pass and that one answer is acted on; before, a second verification could see this machine de-listed and be ignored.
- `--json` puts exactly one document on stdout and nothing beside it; the lines a human would read travel inside it. It reports one pass, so it needs `--once` and refuses without it — an always-on loop has no moment to answer at, and collecting its lines for one would hold every line the machine ever printed.
- A machine's own stand-down comment gets its own marker, `type=standdown`, and only that is bookkeeping. `waiting-on-operator` looks for the operator's reply to be later than anything an agent wrote, so a machine that stood down and said so used to bury the very reply it was standing down without answering — and no machine picked the issue up again. A `handback` is the opposite and stays work: that is an agent stopping to *ask* something, and it is what the operator's reply answers.
- A stop that was nothing to do with the issue — the machine de-listed, the service told to stop, a signal — no longer spends the issue's trigger. Before, `standDown` put the issue back as `queued` or `planning` while the record said the work had already run for that state, so no machine ever picked it up again.
- Two fixes found alongside: a failed or stopped run now goes back to the state it came from instead of staying `in-progress`, and the shipped roster template's header row is no longer read as a machine called `dispatcher`.
- A separator with nothing beside it — `·`, `runs 10 ·`, `runs 10,,poll 1m` — is a half-typed cell and refuses, instead of reading as "and the rest are fine".
- A run that has spent its tries is parked rather than reported as waiting, and its hand-back says so instead of promising a retry the next poll would refuse. Every failure sets a retry deadline, so asking about the wait first meant `park 1` never parked anything.
- Caps read back in a unit their own field accepts, so what is printed can be pasted into the cell it came from: `step 1m` no longer prints as `0h`, and an hour of `poll` says `60m` rather than an `1h` the parser would refuse.
- The roster's shape is stated once and the template, the reference and the onboarding row all say the same thing.
- The duration formatter takes its field as a required argument, because a default is what let two call sites print a duration in another field's units.
- A roster row that does not reach a declared `caps` column is refused by name instead of silently receiving defaults; an empty caps cell or `-` still chooses the defaults explicitly.
- Standing down leaves the state label unchanged when another machine owns the live claim or claim ownership cannot be verified.
- Legacy stand-down notices written with a `handback` marker no longer bury the operator reply they did not answer.
- A stand-down re-reads the claim at the moment it moves the state label, not minutes earlier before the work was saved, pushed and the claim released — long enough for another machine to have taken the issue.
- A stand-down notice written by the released version is still read as bookkeeping, matched as a whole comment so a hand-back that quotes one while asking something new stays a question.
- The row an unlisted machine is told to add is spelled to fit the header the roster actually has, so pasting it in is not refused for a cell it never reached.

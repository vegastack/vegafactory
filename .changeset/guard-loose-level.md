---
"@vegastack/vegafactory": minor
---

New dev.md knob `guard: strict | loose`, for a repository whose contributors are all trusted and whose work is all recoverable.

- `strict` is the default and what every project gets without the knob: the whole always-ask list, unchanged.
- `loose` keeps only what nothing undoes — a force push and a hard reset — plus whatever the project named on its own `ask:` lines. Pushing to the default branch, merging, publishing, tagging, `gh api` writes and an unclassifiable command all go through.
- Like the rest of the policy it is read from the committed default branch, so a branch cannot loosen itself, and anything but the exact word `loose` reads as `strict`.

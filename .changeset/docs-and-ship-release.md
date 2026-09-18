---
"@vegastack/vegafactory": minor
---

New `vegafactory ship release <n>`: the tag step of a release, as one verb. It re-reads issue n's recorded "ship it", resolves the version from the package being released and refuses unless its changelog carries an entry for it, requires the default branch checked out, clean and level with origin, and refuses a version already tagged here or on origin. Only then does it create the annotated tag and push it — and it deletes the local tag again if the push fails, so a refusal or a failure leaves the repository exactly as it was. It never publishes: the workflow that tag triggers does, with provenance. The ship guard allows this one verb, spelled plainly with an issue number and only `--version`, `--repo`, `--dry-run` or `--json` on it, while raw `git tag` and tag pushes keep asking.

The README is rewritten for the factory as it is now: a one-command `init` quick start, how the loop runs — the issue cache, worktrees and claims, the one hook command and its ship guard, cross-tool review and the ship gate, stats, the dashboard and the learning loop — and a glossary of the vocabulary the workflow speaks: the five issue states and the sizes, the two operator words, claim, ledger, cycle and round, control room and dispatcher. Command-level detail stays in the installer README, which now lists `ship release` too.

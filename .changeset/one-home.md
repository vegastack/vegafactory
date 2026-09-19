---
"@vegastack/vegafactory": minor
---

Everything this product keeps about a machine now lives in one place it owns: `~/.vegafactory/`.

- `factory.json`, the control-room clones, the checkouts this machine knows about, the stats spool and the built page all move there, and the App key moves to `worker/app.pem` — `worker/` exists only on a machine that accepts unattended work, so the role is visible on disk.
- `~/.vegastack/` is shared with other VegaStack tooling, which is why this is a separate directory: a directory this product owns entirely is one it may also prune. `tools/`, `cache/`, `registry/` and `secrets/` are named rather than inferred, and are never mentioned.
- Two renames come with it: `worktree-roots.json` becomes `worktrees.json`, and the stats spool comes out of a hidden `.tmp/` — the directory anything tidying a machine empties first, which would have taken the read offsets and push cursors with it.
- **Nothing is moved for you.** A machine still holding its state in the old place is told so, given the exact `mv` lines for what it actually has, and refused until they are run. That directory holds the App key and the control-room clones; a move the operator can see is a move they can check. It matches the recorded decision that this release ships no migration paths, and it is the safer answer: a routine that moved it would have to reason about four lock protocols it does not own, symlinks at every path component, permissions, crossing devices, being interrupted part-way, and the absolute addresses the records inside contain.
- The lines include `rm -rf` for `~/.vegastack/guard/`, which nothing has read since the guard started reading its policy from git, and `vegafactory sync --force` afterwards, because `factory.json` still records where each control room used to sit.
- `VEGAFACTORY_HOME` points the whole product somewhere else, and must be an absolute path — a relative one would name a different directory from every working directory. Naming a home also stops the product looking at the machine's older one: a sandbox must not be refused because of a directory it was never asked about.
- A path is read with `lstat` at every component, so a symlink anywhere along it is never followed, and "this account cannot read it" is never mistaken for "nothing is there".
- The test suite now refuses an ambient `VEGAFACTORY_HOME` before its setup can write through helpers that obey the variable.
- A pending stats push from the older home now recovers against the exact moved control-room clone, preserving the journal until its commit, bytes and cursor prove whether the batch was consumed or undone.

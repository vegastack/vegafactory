---
"@vegastack/vegafactory": minor
---

Everything this product keeps about a machine now lives in one place it owns: `~/.vegafactory/`.

- `factory.json`, the control-room clones, the checkouts this machine knows about, the stats spool and the built page all live there, and the App key at `worker/app.pem` — `worker/` exists only on a machine that accepts unattended work, so the role is visible on disk.
- `~/.vegastack/` is shared with other VegaStack tooling, which is why this is a separate directory: one this product owns entirely is one it may also prune.
- Two things are named differently from the release before: `worktree-roots.json` is `worktrees.json`, and the stats spool is no longer inside a hidden `.tmp/` — the directory anything tidying a machine empties first, which would have taken the read offsets and push cursors with it.
- **Nothing migrates.** A machine that still has files under `~/.vegastack/` is moved by hand, once. There is one such machine, and this release ships no code to find or move them — which is what the register already said it would do.
- `VEGAFACTORY_HOME` points the whole product somewhere else, and must be an absolute path: a relative one would name a different directory from every working directory.

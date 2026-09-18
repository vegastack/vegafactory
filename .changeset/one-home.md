---
"@vegastack/vegafactory": minor
---

Everything this product keeps about a machine now lives in one place it owns: `~/.vegafactory/`.

- `factory.json`, the control-room clones, the checkouts this machine knows about, the stats spool and the built page all move there, and the App key moves to `worker/app.pem` — `worker/` exists only on a machine that accepts unattended work, so the role is visible on disk.
- `~/.vegastack/` is shared with other VegaStack tooling, which is why this is a separate directory: a directory this product owns entirely is one it may also prune. `tools/`, `cache/`, `registry/` and `secrets/` are named rather than inferred, and are never touched.
- The move happens once, on the first run, and says exactly what it moved. If both homes hold state it refuses and names what is in both, rather than reading one and writing the other — the same rule the rest of the product follows for anything ambiguous.
- Two renames come with it: `worktree-roots.json` becomes `worktrees.json`, and the stats spool comes out of a hidden `.tmp/` — the directory anything tidying a machine empties first, which would have taken the read offsets and push cursors with it.
- `~/.vegastack/guard/` is removed on the way past. Nothing has read it since the guard started reading its policy from git.
- `VEGAFACTORY_HOME` points the whole product somewhere else. There was no such override before, and one path — the worktree registry — could not be redirected at all, so a careless test could write to a real home.

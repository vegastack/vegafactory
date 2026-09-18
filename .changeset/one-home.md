---
"@vegastack/vegafactory": minor
---

Everything this product keeps about a machine now lives in one place it owns: `~/.vegafactory/`.

- `factory.json`, the control-room clones, the checkouts this machine knows about, the stats spool and the built page all move there, and the App key moves to `worker/app.pem` — `worker/` exists only on a machine that accepts unattended work, so the role is visible on disk.
- `~/.vegastack/` is shared with other VegaStack tooling, which is why this is a separate directory: a directory this product owns entirely is one it may also prune. `tools/`, `cache/`, `registry/` and `secrets/` are named rather than inferred, and are never touched.
- The move happens once, on the first run, and says exactly what it moved. If both homes hold state it refuses and names what is in both, rather than reading one and writing the other — the same rule the rest of the product follows for anything ambiguous.
- Two renames come with it: `worktree-roots.json` becomes `worktrees.json`, and the stats spool comes out of a hidden `.tmp/` — the directory anything tidying a machine empties first, which would have taken the read offsets and push cursors with it.
- `~/.vegastack/guard/` is removed on the way past — the one destructive step, by an explicit list and never by inference. Nothing has read it since the guard started reading its policy from git, and it goes whether or not anything else moves.
- An interrupted global skill install's journal moves with the rest; left behind it would never be recovered, and the next add would roll its backups forward and bring back skills somebody had removed. Locks are never moved: a machine with an install or a settings write in flight waits instead, because carrying a lock to a new address breaks the cleanup of whatever holds it.
- A symlinked home on either side refuses rather than moving state somewhere neither path names, and a home this account cannot read refuses rather than being read as empty. A cross-device home copies and only then removes, so a failure halfway leaves the original standing.
- Every reason to refuse is decided before anything is touched, so a refusal has changed nothing.
- `VEGAFACTORY_HOME` points the whole product somewhere else, and naming it moves **nothing** into it — an explicit home says where this product should live, never "and go and fetch the real machine's state into it". There was no such override before, and one path — the worktree registry — could not be redirected at all, so a careless test could write to a real home.

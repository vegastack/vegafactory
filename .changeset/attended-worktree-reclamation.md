---
"@vegastack/vegafactory": minor
---

Worktree reclamation is now an attended, preview-first operation with stable issue paths and safe dependency cleanup.

- Bare `vegafactory worktree prune` previews; only `prune --write` removes eligible checkouts or untracked `node_modules`.
- Issue checkouts use number-only directories, including repository-isolated worker `issues/<number>` paths.
- Detached work, staged selections, deleted remote branches, unsafe ancestors, and malformed dependency markers fail closed.

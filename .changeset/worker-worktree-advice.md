---
"@vegastack/vegafactory": minor
---

Workers now report bounded, preview-only worktree cleanup advice after each board pass.

- Advice uses the same candidate rules as attended `vegafactory worktree prune` and excludes work selected or running in that pass.
- Worker status and logs mark incomplete repository facts unavailable; only a person running `prune --write` can reclaim space.

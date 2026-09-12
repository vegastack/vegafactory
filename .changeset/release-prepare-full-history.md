---
"@vegastack/vegafactory": patch
---

Release preparation now fetches the Git history required by exact historical compatibility checks.

- Match the full-history checkout already used by required CI while retaining disabled checkout credentials and pinned actions.
- Keep the pre-amendment reader fixture intact so a release cannot silently lose backward-compatibility coverage.

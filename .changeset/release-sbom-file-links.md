---
"@vegastack/vegafactory": patch
---

Release preparation now skips executable links that resolve to files while inventorying build dependencies.

- Preserve directory-link traversal and package metadata collection.
- Prevent Bun-managed `.bin` file links from being opened as directories.
- Contain the expected stale-socket reset during the release smoke teardown.

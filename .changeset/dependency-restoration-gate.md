---
"@vegastack/vegafactory": minor
---

Reclaimed worktree dependencies now return through one explicit setup gate before attended or worker work begins.

- `vegafactory worktree prepare <issue>` runs only the repository's declared setup command and reports its outcome.
- Attended hooks block implementation tools while a dependency marker remains; worker setup shares the agent's step deadline and process-stop lifecycle.
- Failed, interrupted, timed-out, or unsafe restoration preserves the marker for recovery.

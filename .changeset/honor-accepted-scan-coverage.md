---
"@vegastack/vegafactory": patch
---

Release preparation now honors exact scanner coverage acceptances already validated by the built-skill guard.

- Match the existing baseline-accepted warning to the same skill before admitting degraded completeness.
- Keep missing, malformed, mismatched, blocked, skipped, and unaccepted partial scanner evidence as hard failures.

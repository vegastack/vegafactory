---
"@vegastack/vegafactory": minor
---

Unattended worker runs resume their verified issue conversation when the machine and branch head still match, and start a fresh conversation when either moves.

- Store only private session identifiers and branch metadata for each repository, issue, and harness.
- Retry a missing local session once within the original step limit.
- Keep review sessions, claims, approvals, and ship gates separate from worker conversation continuity.

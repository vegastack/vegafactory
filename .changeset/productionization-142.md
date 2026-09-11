---
"@vegastack/vegafactory": minor
"@vegastack/vegafactory-dashboard": minor
---

Board reads follow every bounded page and show incomplete repositories explicitly.

- Dispatch refuses incomplete issue, comment and dependency reads before claiming work.
- The dashboard retains available rows, names failed repositories and distinguishes missing data from an empty queue.
- GitHub reads have cancellation, output and time limits, bounded retries and a shared repository concurrency limit.

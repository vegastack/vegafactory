---
"@vegastack/vegafactory": patch
"@vegastack/vegafactory-dashboard": patch
---

Self-hosted CI and release preparation now queue instead of exhausting their shared runner volume.

- The heavy CI and prepare jobs share one retained job-level concurrency queue.
- Hosted publication, immutable-pair verification, and runtime disk-pressure safeguards are unchanged.

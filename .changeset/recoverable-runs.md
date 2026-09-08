---
"@vegastack/vegafactory": minor
"@vegastack/vegafactory-dashboard": minor
---

Preserve private execution records and separate process outcomes from approved progress delivery.

- Run an owned process wrapper with bounded cancellation and no ordinary task duration cutoff.
- Inspect durable run status and validate complete committed history before an explicitly authorized checkpoint push.
- Retain shared ownership and pending delivery when qualification, recovery or remote acknowledgment is unavailable.
- Admit approved runs through registered runtime evidence and persist effect receipts for checkpoints, handback, and terminal capture.
- Recognize subscription quota exhaustion, retain the original account and vendor session across waiting and restart, and retry only after current authority and availability checks.

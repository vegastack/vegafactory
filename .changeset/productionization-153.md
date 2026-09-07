---
"@vegastack/vegafactory": minor
"@vegastack/vegafactory-dashboard": minor
---

Prepare and verify one immutable CLI/dashboard release pair before publication, embed the dashboard identity in the CLI, and recover partial publication through verified registry readback before promotion.

- Retain the finalized pair before publication, guard failed-preparation retries, and reconcile per-package promotion under one release workflow.
- Bind build/runtime SBOM evidence, bound registry reads, and integrate descriptor-backed paired CI packing.

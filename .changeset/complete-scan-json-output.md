---
"@vegastack/vegafactory": patch
---

Machine-readable skill scans now flush their complete JSON evidence before exiting.

- Preserve full findings and suppression evidence when stdout is a pipe, including warning and blocking exits.
- Keep the JSON schema, newline termination, human output and verdict semantics unchanged.

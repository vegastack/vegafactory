---
"@vegastack/vegafactory": minor
---

Protect dispatcher ownership with atomic local claims and conditional shared task records.

- Preserve unverifiable and legacy lock evidence, and release only the acquired owner token.
- Add bounded shared-state transactions, immutable recovery receipts and explicit unmanaged-effect barriers.
- Free child process capacity only after revalidating physical stop; retain resource and recovery ownership.
- Keep typed telemetry delivery pending without blocking otherwise verified code completion or transfer.
- Inspect retained active or completed private task records at one verified current head, preserving recovery and pending delivery references.
- Reuse only the live caller’s verified immutable process identity to reduce claim overhead while retaining fresh foreign-process and ownership checks.

---
"@vegastack/vegafactory": patch
---

Concurrent coordination readers now wait for a legitimate read-pointer update instead of failing the child gateway.

- Retry only verified live contention within the existing bounded coordination window.
- Preserve immediate refusal for malformed or abandoned ownership and retain monotonic-head validation.

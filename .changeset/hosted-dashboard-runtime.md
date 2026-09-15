---
"@vegastack/vegafactory": patch
"@vegastack/vegafactory-dashboard": patch
---

Hosted paired releases now install the dashboard's pinned Bun runtime before first-use smoke and promotion.

- The hosted publisher uses Bun 1.3.14, matching immutable-pair preparation and the dashboard's declared `bun:sqlite` runtime.
- Registry publication, retained-byte verification, candidate/latest ordering, OIDC, and dashboard behavior are unchanged.

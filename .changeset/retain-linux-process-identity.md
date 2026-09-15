---
"@vegastack/vegafactory": patch
"@vegastack/vegafactory-dashboard": patch
---

Mac-built dashboard bundles now retain the Linux process-identity implementation used at runtime.

- Runtime platform selection no longer lets bundlers delete the other supported OS branch.
- Process ownership validation, cache claims, privacy filtering, and release smoke requirements are unchanged.

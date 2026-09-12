---
"@vegastack/vegafactory": patch
---

Release preparation now validates warning-only scanner output instead of rejecting it before inspection.

- Accept exit `1` only for the exact skill-scan call, then require the existing zero-block complete-coverage JSON contract.
- Keep every other command zero-only and preserve scanner exit `2`, malformed, blocked, or incomplete evidence as hard failures.

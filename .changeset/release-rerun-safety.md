---
"@vegastack/vegafactory": patch
"@vegastack/vegafactory-dashboard": patch
---

Wait through measured npm publication latency and reject destructive same-run release reruns.

- Observe each attempted publish for up to ten minutes without resubmitting immutable package bytes.
- Fail workflow attempts after the first before preparation and direct failed releases to a fresh patch and tag.

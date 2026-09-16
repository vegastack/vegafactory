---
"@vegastack/vegafactory": patch
"@vegastack/vegafactory-dashboard": patch
---

npm releases now publish both retained packages directly as latest through tokenless Trusted Publishing.

- The dashboard publishes before the public CLI entrypoint, with both exact bytes and latest tags read back.
- Unsupported dist-tag promotion and npm-token requirements are removed.
- Retained-pair qualification, at-most-once writes, backward-version refusal, registry first-use smoke, and roll-forward failure handling remain enforced.

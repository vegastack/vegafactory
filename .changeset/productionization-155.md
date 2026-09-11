---
"@vegastack/vegafactory": minor
---
Prepare the VegaFactory broker's canonical domains and require reviewed deployments for both environments sharing its App.

- Keep the existing App identity and OIDC audience while moving caller defaults to vegafactory-token.vegastack.com.
- Replace automatic preview deployment with protected dispatches tied to a reviewed merged commit and exact Worker digest; unresolved store IDs still block deployment.
- Document preview and production readiness, caller migration, and compatible rollback prerequisites without claiming live acceptance.

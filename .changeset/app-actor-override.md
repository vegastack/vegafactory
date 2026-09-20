---
"@vegastack/vegafactory": patch
---

A self-hosted factory now trusts the GitHub App identity that writes its coordination artifacts.

- `VEGAFACTORY_APP_ID` and `VEGAFACTORY_APP_ACTOR` select the App together; setting only one refuses `worker enable` and `worker run` by name instead of minting as one identity and trusting another.
- A worker's child runs inherit the two non-secret identity values while the private-key path remains stripped.
- A command that only *reads* what an App wrote — `hook`, `review`, `issue`, `ship check`, the status comment — mints nothing, so a half-set pair makes it trust no App rather than crash. One stray variable left in a shell used to throw uncaught, the hook included, and the hook is what carries the ship guard. Failing this way believes strictly less, never more.
- The shipped App guide distinguishes VegaStack's values from examples a company must replace.

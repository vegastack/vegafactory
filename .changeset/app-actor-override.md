---
"@vegastack/vegafactory": patch
---

A self-hosted factory now trusts the GitHub App identity that writes its coordination artifacts.

- `VEGAFACTORY_APP_ID` and `VEGAFACTORY_APP_ACTOR` select the App together; setting only one refuses the dispatcher instead of minting as one identity and trusting another.
- Dispatched runs inherit the two non-secret identity values while the private-key path remains stripped.
- The shipped App guide distinguishes VegaStack's values from examples a company must replace.

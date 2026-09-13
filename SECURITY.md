# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/vegastack/vegafactory/security/advisories/new) on this repository. Do not open a public issue for security problems.

We aim to acknowledge reports within 5 business days.

## Disclosure

We follow a 90-day coordinated disclosure window: unless we agree otherwise with the reporter, details may be published 90 days after the initial report, or earlier once a fix is released.

## Supported versions

Only the latest published minor of `@vegastack/vegafactory` receives security fixes.

| Version | Supported |
|---|---|
| latest minor (see [npm](https://www.npmjs.com/package/@vegastack/vegafactory)) | yes |
| older versions | no — upgrade |

## Scope notes

- After npm/npx has obtained the CLI package, `skills add`, `skills verify`, and `skills remove` make no network calls; `doctor` performs a version check against registry.npmjs.org. Anything contradicting that is a vulnerability — report it.
- The bundled checksum manifest proves package-internal consistency, not publisher identity. Versions carrying npm provenance add a verifiable source/workflow link; the direct `0.19.0` bootstrap and the current automated publisher explicitly omit that attestation. Missing or mismatched integrity/provenance claims are in scope.
- Fake credentials under any skill's `tests/fixtures/` are intentional test fixtures, not leaks (see `.gitleaks.toml`).

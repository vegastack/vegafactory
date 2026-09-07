# @vegastack/factory-token-broker

A Cloudflare Worker that exchanges a GitHub Actions OIDC token for a VegaFactory installation token with
issues/metadata access to one repository and **organization-wide project write authority**. Private to this monorepo — it is never published;
the only published package is `packages/cli`.

The customer-facing reference (endpoint, request and response shapes, status codes, rotation
runbook, kill switch, support boundary) is
[`skills/dev/dev-setup/references/github-app.md`](../../skills/dev/dev-setup/references/github-app.md),
under **Hosted token broker**. This file is the map for someone changing the code.

## What it does

`POST /token` with `Authorization: Bearer <OIDC JWT>`:

1. verifies GitHub RS256/issuer/audience and signed repository/owner names and numeric IDs;
2. requires future expiry and a bounded token lifetime, allowing at most 60s skew for issued/not-before times;
3. checks the repository's rate-limit binding and binds installation App/account IDs to configuration and signed owner identity;
4. requests `repository_ids: [repositoryId]` and exactly
   `{issues: write, metadata: read, organization_projects: write}`;
5. checks the permission echo, expiry and a separate repository enumeration authenticated with the minted token.

Every valid workflow/ref in an installed repository is eligible; there is no workflow, ref or
environment allowlist. A fork's signed repository identity needs its own installation. A privileged
PR workflow carrying the installed base repository identity remains eligible, even with fork input.
Installers must govern untrusted workflow execution in that repository. Repository selection does
not isolate one project: `organization_projects: write` reaches the organization's projects.

`GET /health` answers `{"status":"ok"}` unauthenticated, reads no credential, and is not audited. It is liveness only, never authenticated exchange readiness.

## Module map

| File | Job |
|---|---|
| `src/egress.ts` | The only outbound call site: exact-host allowlist, `https:` only, `redirect: 'error'` |
| `src/env.ts` | The two binding shapes (`SecretBinding`, `RateLimiter`) and `readSecret` |
| `src/oidc.ts` | JWT parse and verification, and the JWKS memo + edge cache |
| `src/github.ts` | App key import, App JWT, installation identity, capped mint, actual repository enumeration and rejected-token cleanup |
| `src/ratelimit.ts` | The rate-limit binding wrapper, and what its verdict does and does not mean |
| `src/index.ts` | Routing, status codes, the audit record, and the Worker's `fetch` export |
| `scripts/config-check.mjs` | The deploy guard the workflow runs before `wrangler deploy` |

## Bindings

Two, and no storage binding of any kind:

- `APP_PRIVATE_KEY` — a **Secrets Store** secret (`secrets_store_secrets`), read with
  `await env.APP_PRIVATE_KEY.get()`. One account-level secret serves both environments and rotates
  in one place. The key must be PKCS#8; the Worker refuses a PKCS#1 PEM with the conversion command.
- `TOKEN_LIMITER` — the GA rate-limit binding (`ratelimits`), `await env.TOKEN_LIMITER.limit({key})`.
  Its count is per Cloudflare location and `simple.period` accepts only 10 or 60 seconds, so it is
  eventually consistent abuse mitigation, never an exact global quota or an authorization decision. Sized at 30 requests per minute per repository
  in both environments (`wrangler.jsonc`), keyed `<owner>/<repository>` from the verified claims.

GitHub's public signing keys sit in a module-scope memo and the Cloudflare edge cache
(`cf: { cacheTtl: 3600, cacheEverything: true }` on the JWKS subrequest), which is why no KV
namespace exists.

Unknown signing keys trigger at most one single-flight origin refresh per minute per isolate,
bypassing both caches with `cache: 'no-store'` and no positive edge-cache overrides. Failed refresh
retains the old document and its original expiry. JWTs are capped at 16KiB and 600s lifetime; JWKS
reads at 256KiB/32 keys, and GitHub JSON reads at 64KiB, even without Content-Length. Every fetch and
body read has a 3s deadline inside a 15s exchange budget, including limiter/key waits and best-effort
cleanup. A rejected minted token gets a disposable-token revocation attempt within the remaining
budget (at most 3s); cleanup failure never makes a refused token usable by the caller.

These bounds are broker acceptance limits. Local signed fixtures are not live rollout evidence.
Use controlled upstream failures and disposable-token fixtures for denial/recovery; do not revoke
a shared App key or uninstall the shared App as a drill. Live allow/deny and organization-project
reach evidence require the separately authorized rollout.

## Working on it

```sh
bun test packages/broker                        # unit tests, no network
node packages/broker/scripts/config-check.mjs --json   # the deploy guard
```

`wrangler.jsonc` stays **comment-free JSON**: `config-check.mjs` parses it with `JSON.parse` so the
guard is deterministic, and a JSONC comment makes it block with that sentence.

Local development reads the App key from `.dev.vars` (see `.dev.vars.example`, and note `.dev.vars`
is gitignored) under the same binding name production reaches, so no call site changes.

Deploys run from `.github/workflows/broker-deploy.yml`: preview automatically on a merge to main,
production only by dispatch behind the `production` GitHub Environment's required reviewer.

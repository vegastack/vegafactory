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

## Protected rollout preparation

| Environment | Canonical domain | App ID | OIDC audience |
|---|---|---|---|
| Preview | `vegafactory-token.vegastack.dev` | `4812956` | `vegastack-factory` |
| Production | `vegafactory-token.vegastack.com` | `4812956` | `vegastack-factory` |

Both environments hold the same App authority. Preview needs the same deployment review and
secret controls as production. The public action repository remains `vegastack/factory-token`;
its release/mirror is a separate operation, and existing `@v1` callers do not change when this
source changes. Inventory each caller's action revision, endpoint, audience and installation before
rollout. Explicitly configured callers need their endpoint updated. Keep an existing endpoint until
that inventory proves migration and the operator authorizes retirement; this source adds no alias.

The committed empty store IDs are intentional unresolved prerequisites. `config-check.mjs` refuses
deployment until the actual configured IDs are provided through a separately authorized change.
It proves configuration shape, canonical domains, App/audience pairing and no storage; it cannot
prove account/zone access, secret availability, DNS/TLS, installation state or human availability.
Fixture IDs belong only in tests. Never copy them into deploy configuration.

The dispatch-only workflow requires `environment`, `reviewed_ref` (a full commit SHA merged to
main), and `reviewed_digest` (SHA-256 of the exact bundled `index.js`). Dispatch the workflow from
`main`. Both GitHub Environments must have required reviewers and exactly one custom deployment
branch policy: the branch `main`, with no tag policies. The workflow reads those settings and
refuses missing protection or unavailable readback. Configure environment-scoped Cloudflare
credentials before enabling either environment, disable administrator bypass, and verify that the
operator can actually approve under the configured reviewer/self-review rules. A reviewer entry
alone does not prove an eligible approver exists; an unavailable reviewer is a live blocker.

Prepare the exact artifact from a clean checkout of the reviewed SHA with frozen dependencies:

```sh
cd packages/broker
bun run wrangler deploy --env preview --dry-run --outdir <retained-artifact-directory>
shasum -a 256 <retained-artifact-directory>/index.js
```

Review the bundled bytes, action at that source SHA, and both environment config diffs. The
workflow repeats the dry-run, requires the reviewed digest, retains `index.js`, and deploys those
bytes with `--no-bundle`. Production must select the same source SHA and digest proven in preview;
a changed output refuses promotion and requires a new reviewed artifact. Retain the artifact
before workflow retention expires. A digest is byte identity, not proof of readiness.

Before seeking either deployment word, prepare the command/dispatch inputs and this sanitized
checklist. Unknown entries stay `unverified`; never replace them with assumed success:

```text
{environment, domain, appId, audience, artifactDigest,
 storeBindingPresent, reviewProtection, previousCompatibleDeployment}
```

Attach the exact Worker/action source SHA, previous compatible action revision and deployment ID,
route and binding names, config diff, reviewer/self-review readback, run ID and artifact download
reference. After deployment add the actual Worker version/deployment IDs and masked smoke results.
Store IDs are configuration identifiers; private keys, OIDC tokens and installation token values
never enter this inventory, logs, issue comments or retained artifacts.

## Live acceptance and recovery (separate authorization)

Preparation does not complete rollout. After merge and explicit preview authorization, verify
DNS/TLS, health liveness and a real Actions exchange within ten minutes. Confirm signed repository
identity, actual token repository reach, permission cap and expiry without logging tokens; include
an uninstalled caller refusal, controlled limiter/timeout failures and disposable-token revocation.
Preview is bounded to ten exchanges, fifteen seconds each. A preview failure stops production.
After separate production authorization, repeat at most six positive/negative exchanges for the
same artifact and verify existing callers. Local fixtures and `/health` alone cannot pass these gates.

Record a prior compatible Worker deployment, action revision, domains and unchanged audience as
one rollback pair. Prepare a deployment diff/dry-run and controlled failure rehearsal; an actual
rollback needs its own authorization. Do not change App identity or revoke its shared key to repair
a domain migration. Shared-App uninstall/key-loss failures are simulated in controlled transport;
real disruption is separately authorized maintenance.

Before live acceptance, the operator must name the operational owner and confirm they can locate
logs, deployment IDs and rollback evidence. Key rotation uses overlap: install the new key in the
Secrets Store, deploy/review a masked successful exchange, then retire the old key on authorization.
Emergency uninstall/revoke/disable actions belong to the named owner and affect shared workflows;
never use them as qualification drills.

Use GitHub notifications and dashboard attention for decisions and unrecoverable failures. Alert on
attempted-traffic 5xx/exchange-denial spikes and delivery failures; no-success for ten minutes is
actionable only with verified eligible attempts in that window. An idle pilot stays quiet. A missing
monitoring signal is a visible monitoring gap. Live qualification must demonstrate idle silence,
attempted-traffic failure, recovery and notification deduplication. No Slack/email integration or
synthetic traffic generator is introduced here. Owner, delivery and reviewer evidence remain live
prerequisites; this preparation does not provision a monitor or claim these checks passed.

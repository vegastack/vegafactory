# The VegaFactory GitHub App

The one identity every automated write uses. Facts verified 03-09-2026 against the live App and GitHub's docs; the three `GH-APP-*` entries in `refresh/sources.json` pin this whole file, which is why it carries no HTML comments.

## What the App is for

Humans own issues. A person approves a brief, a person says "ship it", and a person's name is on every state flip. The App is the identity for the writes no person is sitting behind: the board mirror that sets a project Status when a label changes, an Actions job that edits a label, and the hosted token broker that serves other organisations. It is **not** the dispatcher's identity — the dispatcher runs headless sessions as the operator's own `gh` login, and giving it the App's identity would hide which human a run belongs to.

The alternative worth naming is a credential belonging to a person: it stands for their whole account, outlives the job that used it, and dies when they leave the org. The App stands for a named permission set instead, its tokens live an hour, and uninstalling it revokes every one of them at once.

The App is public, so any account may install it. That is the point: one App, installed by any org that wants the factory, with a permission set each of them can read before consenting.

| Fact | Value |
|---|---|
| Name | VegaFactory |
| Slug | `vegafactory` |
| App ID | `4812956` |
| Public page | https://github.com/apps/vegafactory |
| Install URL | https://github.com/apps/vegafactory/installations/new |
| Actor a bot write shows | `vegafactory[bot]` |
| Webhook | off |

The slug is what GitHub derives from the name, and both the actor string and the install URL follow it — confirm it on the App's settings page rather than assuming it, because renaming the App changes the slug and every reference to it.

## Permissions

Exactly this set, and no others.

| Permission | Level | Why |
|---|---|---|
| Issues | Read and write | Edit labels and assignees on the issues the mirror reacts to |
| Metadata | Read-only | Mandatory for every App; repository name and visibility only |
| Projects (organization) | Read and write | The ProjectsV2 GraphQL surface reads and writes item fields |
| Pull requests | Read and write | Comment on and label the PR an issue's work lands through |
| Contents | Read-only | The token can read a workflow file but cannot push, tag, or publish — this is what the drill proves |

Workflows stays at No access and no webhook is configured, so nothing about this App can change a workflow file or receive an event. `Contents: read` is deliberately not `No access`: `actions/checkout` with an App token needs to read the repository, and read cannot write.

## Hosted token broker

VegaStack runs a hosted broker so an organisation can use the factory **without holding any private
key**: install the public App, and your Actions jobs exchange their own OIDC token for a
token for one repository’s issues/metadata and **organization-wide project writes**. Written here
for an org that is not `vegastack`. The broker contract below was checked against its source and
[GitHub installation APIs](https://docs.github.com/en/rest/apps/installations) on 07-09-2026; local
verification does not claim a deployed exchange is ready.

| Fact | Value |
|---|---|
| Endpoint | `POST https://factory-token.vegastack.com/token` |
| Preview endpoint | `POST https://factory-token.vegastack.dev/token` |
| Audience | `vegastack-factory` |
| Auth | `Authorization: Bearer <the job's OIDC token>` |
| Health probe | `GET https://factory-token.vegastack.com/health` → `{"status":"ok"}`, unauthenticated liveness only; never authenticated readiness |
| Token lifetime | GitHub's fixed 1 hour; the broker reports `expires_at`, it does not set it |

Request: no body. Identity comes from the verified bearer JWT, never unsigned repository parameters.
The action’s `audience` input must match the deployment’s `OIDC_AUDIENCE`; both default to
`vegastack-factory` in preview and production. A GitHub Environment claim does not change the
audience. An intentionally different deployment audience needs a matching caller configuration.

Response `200`:

```json
{
  "token": "ghs_…",
  "expires_at": "2026-09-03T12:00:00Z",
  "repository": "acme/widgets",
  "permissions": { "issues": "write", "metadata": "read", "organization_projects": "write" }
}
```

### Status codes

| Code | Meaning | What to do |
|---|---|---|
| 200 | Minted | Use the token; it expires in an hour |
| 401 | The OIDC token did not verify — the body's `reason` is one of `malformed` `alg` `kid` `signature` `issuer` `audience` `expired` `not_yet_valid` `claims` | Check the job has `permissions: id-token: write` and requests the audience `vegastack-factory` |
| 403 | The App is not installed on that repository | Install it, or accept the refusal — this is the kill switch working |
| 404 / 405 | No such route, or the wrong method | Only `POST /token` and `GET /health` answer |
| 429 | Rate limited for that repository | Retry after the `Retry-After` seconds |
| 502 | Upstream exchange timed out or returned unusable evidence | Retry; no token was returned. A minted but rejected token receives a best-effort revocation attempt |
| 503 | The rate limiter was unavailable | Retry; the broker fails closed rather than granting |
| 500 | The broker refused its own result — excess permissions/repository reach, or an unusable App key | Report it; no token is returned; rejected minted tokens receive a best-effort revocation attempt |

### The permission cap

Every returned token carries exactly `issues: write`, `metadata: read`, `organization_projects: write`.
The first two are scoped to one repository. **Organization project write authority remains
organization-wide**, retained for the existing board use case; repository selection cannot prove
one-project isolation. Installers consent to that reach when choosing this trust model.

The mint requests the signed numeric repository ID and exact permission cap. Before returning the
token, the broker independently calls `GET /installation/repositories` using that token and requires
exactly one matching repository ID/full name/owner ID, with no pagination. The permission echo
alone is insufficient. Expiry must be more than 30s and at most 1h+60s in the future. There is no
`contents: write` and no way for a caller to request it.

### Tenancy

The repository a caller receives a token for comes from the **verified** `repository` and
`repository_owner`, `repository_id` and `repository_owner_id` claims in its OIDC token. The
installation App ID must match configuration and its account ID must match the signed owner ID.
There is no unsigned repository parameter. One organisation cannot mint a token for another's repository, and the
installation lookup refuses any repository the App is not installed on.

Any valid workflow/ref in an installed repository is eligible, including a newly added workflow.
No protected-workflow/ref/environment allowlist is required or imposed. A fork's signed identity
needs an installation for that fork. A privileged PR workflow bearing the installed base repository's
identity remains eligible even when it processes fork input; operators govern untrusted workflow
execution on that repository.

### What is stored

Nothing of yours. The broker declares **no storage binding at all** — no KV, no D1, no R2, no
Durable Object. GitHub's public signing keys sit in an in-isolate memo and the Cloudflare edge
cache for an hour. An unknown kid triggers a single-flight origin refresh at most once/minute per
isolate, bypassing both caches with `cache: "no-store"` and no positive edge TTL override. Failure
retains the previous memo and its original expiry. Each request emits one audit record holding the repository, owner, installation
id, decision and status — never a token, never code, never repository content. `GET /health` writes
no record at all.

The broker caps JWTs at 16KiB and a 600s lifetime; expiry must remain after now, with up to 60s skew
only for issued/not-before times. JWKS is capped at 256KiB/32 keys and GitHub JSON at 64KiB, including
chunked bodies. Fetch plus body reads have 3s deadlines inside a 15s whole exchange deadline. A
rejected minted token is never returned or logged; `DELETE /installation/token` is attempted with
that disposable token within the remaining budget, at most 3s, and refusal survives cleanup failure.
These are broker limits, not issuer guarantees. [Cloudflare Request cache behavior](https://developers.cloudflare.com/workers/runtime-apis/request/)
and [GitHub token creation](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
are the upstream contracts.

### The rate limit

An abuse brake, not an exact global quota. [Cloudflare documents eventual consistency](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), so its counters are not exact accounting. The number, written down: **30 token requests
per minute per repository, per Cloudflare location** — Cloudflare's rate-limit binding counts per
location rather than globally, and its period accepts only 10 or 60 seconds. A burst can
degrade to a 429 and a retry; enforcement is permissive and eventually consistent. It is never an authorization
decision — the OIDC claims and the installation lookup are — and it is keyed by
`<owner>/<repository>` from the verified claims, so one organisation's traffic cannot spend
another's allowance.

### Rotating the private key

VegaStack operates this; the order matters, so no window exists with zero valid keys.

1. Generate a new private key in the App's settings.
2. `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem` — the
   Worker accepts PKCS#8 only and refuses a PKCS#1 PEM with this same command in the error.
3. `wrangler secrets-store secret update <STORE-ID> --secret-id <SECRET-ID> --remote` with the new value.
4. Redeploy the Worker.
5. Only then delete the old key in the App's settings.

### Kill switch

Uninstall the App. The next request for any of your repositories fails at the installation lookup
with 403, and every token already minted for you is invalidated by GitHub. No broker change, no
deploy, no ticket.

### Support boundary

VegaStack operates the Worker, the App, and the key. You operate your installation and your
workflows. The broker is offered **as is, with no uptime commitment**; its dependency chain is
GitHub's OIDC JWKS endpoint and `api.github.com`, and it fails closed with a plain reason when
either is unavailable. An organisation that wants its own availability guarantee registers its own
App and uses `actions/create-github-app-token` directly, as the sections above describe. Issues go
to `vegastack/vegafactory`.

### Abuse surface

Anyone who can run Actions in a repository where the App is installed can obtain a
token with issue/metadata access to that repository and **organization-wide project write access**.
The cap excludes `contents: write`, but a compromised installed-repository workflow can affect
organization projects beyond a single repository. Repository enumeration does not reduce that
project authority. Do not describe the whole token as repository-only.

## Creating the App

The operator's own browser flow. `gh` has no create-app command and the manifest flow needs a browser redirect, so no agent does this step.

1. Organization settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Name, homepage, and description in the operator's words.
3. **Where can this GitHub App be installed** → *Any account*.
4. **Webhook → Active** → unchecked.
5. Repository permissions: Issues = Read and write, Metadata = Read-only (preselected), Pull requests = Read and write, Contents = Read-only, Workflows = No access. Organization permissions: Projects = Read and write.
6. **Create GitHub App**, then **Generate a private key** on the App's settings page.

**Generating the private key is not automatable.** GitHub delivers the `.pem` once, as a browser download, to whoever pressed the button, and never shows it again. An automated browser session downloads it into its own profile directory where the operator never sees it — two such attempts on 03-09-2026 produced no file and registered no key. A setup skill's job is to open the page, name the button, and say where the file goes; never to press it.

## Where the secrets live

| Name | Kind | Value |
|---|---|---|
| `VEGAFACTORY_APP_ID` | organization variable | the numeric App ID |
| `VEGAFACTORY_APP_PRIVATE_KEY` | organization secret | the PEM, pasted whole |

The private key exists in exactly two places for its whole life: this organization secret, and the Cloudflare Secrets Store secret the hosted broker reads. Never on a workstation, never on the dispatcher box, never in a control-room file, never in an issue. Only the key's holder can mint installation tokens, which is the whole reason the broker has to exist for other organisations rather than handing each of them a copy.

Control-room files record these **names**. The values live in GitHub organization settings and nowhere a repository can read them.

Setting an organization secret needs `admin:org`. A `gh` token without it can write a repository secret but not an organization one, so this step reaches the operator even when everything around it is automated.

## Minting a token in a workflow

```yaml
permissions:
  contents: read
steps:
  - uses: actions/create-github-app-token@v3
    id: app-token
    with:
      app-id: ${{ vars.VEGAFACTORY_APP_ID }}
      private-key: ${{ secrets.VEGAFACTORY_APP_PRIVATE_KEY }}
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - run: gh issue edit "$NUMBER" --add-label ready
    env:
      GH_TOKEN: ${{ steps.app-token.outputs.token }}
      NUMBER: ${{ github.event.issue.number }}
```

- The action is at major `v3` (v3.2.0, released 12-05-2026). `app-id` is v3's retained legacy alias for `client-id`; either works.
- Its outputs are `token`, `installation-id`, and `app-slug`.
- The minted installation token **expires after one hour**, and the action revokes it in its post step unless `skip-token-revoke` is set.
- `permission-<name>` inputs narrow a token further — never wider than the installation already grants.
- `repositories:` narrows the token to the named repositories. With `owner:` alone the action mints for **every** repository the installation covers — on an org installed "all repositories, current and future", that is the whole org — so a job that touches one repository always names it; `owner:` stays, because it is what resolves the organization installation behind the Projects surface.
- The job's own `permissions:` block stays `contents: read`, so a push is refused twice over: once by the job's `GITHUB_TOKEN` scope and once by the App's own Contents level.

Rate limits are not a design constraint here. An installation token starts at 5,000 requests per hour, gains 50 per hour for each repository beyond 20 and 50 per hour for each user beyond 20, caps at 12,500, and gets 15,000 on a GitHub Enterprise Cloud organization. A workflow's built-in `GITHUB_TOKEN` gets 1,000 per hour per repository and cannot touch Projects at all, which is why the board mirror needs the App rather than the built-in token.

## Recording the installation

```sh
gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug == "vegafactory") | .id'
```

`GET /orgs/{org}/installations` answers organization owners only. A 403 is a fact to report — "this account is not an owner, so the installation could not be read" — not a failure and not evidence the App is missing.

The id goes in the control room's `org.md`, on its `app-install:` line, and nowhere else. On the `vegastack` organization it is `158664419`, installed on all repositories, current and future.

## Rotating the private key

In this order, because deleting first breaks every job already running:

1. Generate the new key on the App's settings page.
2. Update the organization secret `VEGAFACTORY_APP_PRIVATE_KEY` with it, and the broker's Secrets Store secret if the broker is deployed.
3. Confirm one workflow run mints a token with the new key.
4. Only then delete the old key in the App's settings.

A leaked key is the exception: delete it first and accept the broken jobs, then work back up the list.

## Kill switch

**Uninstalling the App from the organization revokes every installation token immediately** and makes the next mint fail closed. It needs no key handling and no coordination, so it is the fastest stop and the one to reach for first. Deleting the private key is the narrower alternative — it stops new tokens from being minted while leaving the installation in place, and any token already minted stays valid for the rest of its hour.

## Widening a permission

Adding a row to the permission table is a dated line in the register the `decisions:` knob names, on the operator's explicit yes. The App is public: its permission set is what every other organization consents to when they install it, and a widening re-asks that consent silently for every one of them. Narrowing needs no register line, only a check that nothing depended on what was removed.

## Acceptance drill

Live checks require a separately authorized rollout on a throwaway repository after installation
and credential setup. Local fixtures do not qualify a deployed broker, and a health HTTP 200 response
is only liveness. Keep current CI runners. Never delete a shared App key or uninstall the shared
App as a qualification drill. Four checks:

1. A job that mints a token and runs `gh issue edit --add-label` leaves an event whose actor is `vegafactory[bot]`, not a human.
2. A `git push` step in that same job, using the minted token, **fails** — the App has no Contents write.
3. Controlled installation HTTP 404, key-rotation, expiry and upstream-failure fixtures prove local refusal; disposable-token revocation fixtures prove cleanup. Real shared-App uninstall/key-revocation drills are excluded. Record actual live broker allow/deny and organization-project reach separately before rollout acceptance.
4. `gh issue comment` against an issue in a **second** repository of the same org, using the minted token, **fails** — the token is scoped by `repositories:` to the one repository the job runs in, not to the installation.

Check 2 is the one worth being stubborn about, and check 4 is its twin: level and scope are two different ways a token can be too wide. It is the difference between a token that can edit a label and a token that can rewrite the repository.

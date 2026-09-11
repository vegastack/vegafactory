# vegastack/factory-token

**This directory is the source of truth.** The public action lives at `vegastack/factory-token`;
that repository is a mirror of this directory, and a change lands here first.

Exchange a GitHub Actions OIDC token for a VegaFactory token — issues/metadata on one
repository, organization-wide project writes, one hour. No private key in your organisation.

## Use it

```yaml
jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # required — without it there is no OIDC token to exchange
      contents: read
    steps:
      - uses: vegastack/factory-token@v1
        id: factory
      - run: gh issue edit 12 --add-label ready
        env:
          GH_TOKEN: ${{ steps.factory.outputs.token }}
```

| Input | Default | What it is |
|---|---|---|
| `endpoint` | `https://vegafactory-token.vegastack.com/token` | The broker endpoint |
| `audience` | `vegastack-factory` | The OIDC audience the broker verifies |

| Output | What it is |
|---|---|
| `token` | The installation token, already masked with `core.setSecret` |
| `expires_at` | When it expires — GitHub's fixed one hour from minting |

## Before it works

Install the [VegaFactory App](https://github.com/apps/vegafactory) on the repository. Without an
installation the broker answers `403`. Uninstall is an operator incident action affecting shared
workflows, not an onboarding or qualification drill.

The token cannot push code. The cap is `issues: write`, `metadata: read`,
`organization_projects: write`. Repository access is independently enumerated with the minted
token and must match the signed repository/owner IDs. The project permission remains organization-wide;
a repository-selected token does not authorize only one project.

Full reference — status codes, tenancy, what is stored, the rate limit, rotation, and the support
boundary — is in `github-app.md` under **Hosted token broker** in
[`vegastack/vegafactory`](https://github.com/vegastack/vegafactory).

Any valid workflow/ref in the installed repository can request this token, including a previously
unseen workflow. A fork identity needs its own installation; a privileged PR workflow with signed
base-repository identity inherits the installed base repository's trust. Govern untrusted workflows
at the repository. The broker adds no workflow/ref/environment allowlist.

Keep `audience` equal to that deployment's `OIDC_AUDIENCE`; both default to `vegastack-factory`.
A GitHub Environment name is not an audience override. Configure the endpoint/audience pair
explicitly when a separate deployment uses another audience. Both outputs retain their names,
and the action masks the token before exposing it.

`/health` is only liveness, not proof an authenticated exchange works. The limiter provides
per-location abuse mitigation, not an exact global quota. Use controlled failures/disposable-token
fixtures for local verification; actual live allow/deny and project reach remain rollout gates.

## Canonical domain migration

The prepared production default is `https://vegafactory-token.vegastack.com/token`; preview is
`https://vegafactory-token.vegastack.dev/token`. Both keep App `4812956` and audience
`vegastack-factory`. Preview carries the same App authority and requires reviewed deployment.
This source edit does not publish the action mirror or qualify either endpoint. Before switching
callers, record the action revision and endpoint/audience pair, then verify a masked authenticated
exchange on the separately authorized rollout. Retain the previous compatible Worker/action pair
for recovery. Retiring an existing endpoint requires caller inventory and explicit authorization.

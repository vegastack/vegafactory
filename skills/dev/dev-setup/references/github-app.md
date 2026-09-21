# The VegaFactory GitHub App

The one identity every automated write uses. Facts checked 03-09-2026 against the live App and GitHub's docs ([GitHub Apps](https://docs.github.com/en/apps/creating-github-apps), [create-github-app-token](https://github.com/actions/create-github-app-token)); re-check them there when older than 60 days.

## What the App is for

Humans own issues. A person approves a brief, a person says "ship it", and a person's name is on every state flip. The App is the identity for the writes no person is sitting behind: the board mirror that sets a project Status when a label changes, an Actions job that edits a label, and a worker machine working the board with nobody at the keyboard. A worker's labels, status comments and claim releases go out as the App, while the agent runs it starts stay on the operator's own subscription — so the machine's writes are attributable to the factory and its reasoning is still paid for by a person.

The split inside a worker run is worth being exact about, because two identities are in play and they are not interchangeable:

| Written by | What it writes | As |
|---|---|---|
| the worker itself | the claim it takes before a run, its heartbeat and release, the hand-back comment, the relayed ack, the state label | that board's repository-scoped App token |
| the agent run it starts | everything the skill writes — the plan, the evidence, the status comment, the PR | that board's repository-scoped App token |

Both use the same short-lived identity for that board, but never a token shared between repositories. The machine separately mints an hour-long installation token for each explicit `OWNER/NAME`, narrowed by GitHub to that one repository; the board keeps its own token refresher, checkout, `dev.md` policy, issue cache, readiness result and push check. Only runs from that board receive its token as `GH_TOKEN`. A mint, checkout, policy or readiness failure therefore skips that repository without borrowing another board's identity or stopping a healthy board.

That separation is the point twice over. A run cannot reach another listed repository with its token, and its own output can never pass as a person's word, so a hostile file in a diff cannot talk the factory into stopping, correcting or shipping an issue by writing a sentence. The run is never told where the private key is — it holds a token that expires, not the thing that mints them.

Two consequences worth knowing before the first worker run:

- **A worker run pushes with the machine's own login, not with its board's token.** The App's Contents is read-only by design, and `gh auth git-credential` prefers the token in the environment over the login the machine already has, so a push carrying it fails. A run's git therefore asks for a credential with the App's token scrubbed out, and gets the machine's own back: an https remote pushes exactly as it does for the person at the keyboard, and an SSH remote never consulted a helper anyway. `worker enable` checks this separately in every worker-owned clone; a bad push path skips that board instead of letting its first run finish the work and fail at the push.
- **The token is an hour long and the key is not.** A child running under the same account can still read the key file through the filesystem, whatever its mode. The separate worker account in the control room's worker-box checklist is what closes that.

What the App may never do is stand in for a person's own words. It authors the factory's work and is trusted for exactly that: a claim, a release, the status comment, a plan, evidence, a review — each read through the shape it has to have. An ack, an acceptance of what a review left open, a correction and a "ship it" are read only from a human with write access, so a run can produce the work but never the word that approves it.

The alternative worth naming is a credential belonging to a person: it stands for their whole account, outlives the job that used it, and dies when they leave the org. The App stands for a named permission set instead, its tokens live an hour, and uninstalling it revokes every one of them at once.

The App is public, so any account may install it. That is the point: one App, installed by any org that wants the factory, with a permission set each of them can read before consenting. The values below describe VegaStack's published App; they are examples for a company that runs its own.

| Fact | VegaStack example |
|---|---|
| Name | VegaFactory |
| Slug | `vegafactory` |
| App ID | `4812956` |
| Public page | https://github.com/apps/vegafactory |
| Install URL | https://github.com/apps/vegafactory/installations/new |
| Actor a bot write shows | `vegafactory[bot]` |
| Webhook | off |

The slug is what GitHub derives from the name, and both the actor string and the install URL follow it — confirm it on the App's settings page rather than assuming it, because renaming the App changes the slug and every reference to it.

**Those values are VegaStack's own.** A company running its own App reads its two off that App's
own settings page — `https://github.com/organizations/<org>/settings/apps/<your-app-slug>`:

- **App ID** is printed on that page. It is `VEGAFACTORY_APP_ID`.
- **The slug** is the last part of that page's own URL. `VEGAFACTORY_APP_ACTOR` is that slug with
  `[bot]` after it, and it is worth confirming against a comment the App has actually posted.

Or read both at once, as an organization owner, from the installation the App already has:

```sh
gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug == "<your-app-slug>")
  | "VEGAFACTORY_APP_ID=\(.app_id)\nVEGAFACTORY_APP_ACTOR=\(.app_slug)[bot]"'
```

That is the same endpoint as `## Recording the installation` below, which is why it costs nothing
extra: the one call answers the App id, the slug and the installation id together. It needs an
owner's own `gh` login and no JWT — `GET /app` would answer these too, but only to a token signed
with the App's private key, which is a longer road to two values the settings page already shows.
A 403 means this account is not an owner; the settings page above still works.

Both variables are set together or neither is. Setting one makes every command refuse by name,
because a factory that mints as one identity and trusts another distrusts everything it writes.

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
| `VEGAFACTORY_APP_ACTOR` | dispatcher environment | the bot login GitHub derives from the App slug, including `[bot]` |
| `VEGAFACTORY_APP_PRIVATE_KEY` | organization secret | the PEM, pasted whole |

The private key lives in the organization secret, and — only on a machine whose `nodes.md` row says `worker: yes` — in one file on that machine. Being listed is not enough: `nodes.md` names every machine that runs vegafactory, most of which only report what they did, and possession of this key is by itself enough to mint installation tokens. Never on a workstation, never in a control-room file, never in an issue, never printed. Only the key's holder can mint installation tokens.

On a worker machine the file is `~/.vegafactory/worker/app.pem`, owned by the worker account and `chmod 600`, so a CI job running as the runner account cannot read it. `VEGAFACTORY_APP_PRIVATE_KEY_FILE` moves it. A company running its own App must set both `VEGAFACTORY_APP_ID` to that App's numeric id and `VEGAFACTORY_APP_ACTOR` to its bot login, such as `acmefactory[bot]`; setting only one refuses the worker, because it would mint as one App and distrust that App's own writes. `vegafactory worker` mints an hour-long installation token from the key, narrowed to the one repository, keeps it in memory and passes it to `gh` in that child's environment only. A missing key refuses the run with the path to fix — it never falls back to a person's token.

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
  - run: gh issue edit "$NUMBER" --add-label queued
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
gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug == "<your-app-slug>") | .id'
```

`GET /orgs/{org}/installations` answers organization owners only. A 403 is a fact to report — "this account is not an owner, so the installation could not be read" — not a failure and not evidence the App is missing.

The id goes in the control room's `org.md`, on its `app-install:` line, and nowhere else. On the `vegastack` organization it is `158664419`, installed on all repositories, current and future.

## Rotating the private key

In this order, because deleting first breaks every job already running:

1. Generate the new key on the App's settings page.
2. Update the organization secret `VEGAFACTORY_APP_PRIVATE_KEY` with it.
3. Confirm one workflow run mints a token with the new key.
4. Only then delete the old key in the App's settings.

A leaked key is the exception: delete it first and accept the broken jobs, then work back up the list.

## Kill switch

**Uninstalling the App from the organization revokes every installation token immediately** and makes the next mint fail closed. It needs no key handling and no coordination, so it is the fastest stop and the one to reach for first. Deleting the private key is the narrower alternative — it stops new tokens from being minted while leaving the installation in place, and any token already minted stays valid for the rest of its hour.

## Widening a permission

Adding a row to the permission table is a dated line in the register the `decisions:` knob names, on the operator's explicit yes. The App is public: its permission set is what every other organization consents to when they install it, and a widening re-asks that consent silently for every one of them. Narrowing needs no register line, only a check that nothing depended on what was removed.

## Acceptance drill

Run it on a throwaway repository after installation and credential setup, on the operator's word. Never delete a shared App key or uninstall the shared App as a drill. Three checks:

1. A job that mints a token and runs `gh issue edit --add-label` leaves an event whose actor is `vegafactory[bot]`, not a human.
2. A `git push` step in that same job, using the minted token, **fails** — the App has no Contents write.
3. `gh issue comment` against an issue in a **second** repository of the same org, using the minted token, **fails** — the token is scoped by `repositories:` to the one repository the job runs in, not to the installation.

Check 2 is the one worth being stubborn about, and check 3 is its twin: level and scope are two different ways a token can be too wide. It is the difference between a token that can edit a label and a token that can rewrite the repository.

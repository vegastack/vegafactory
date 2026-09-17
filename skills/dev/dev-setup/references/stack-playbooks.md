# Stack playbooks

Detection-to-draft mapping for Step 1 and Round C: match the signals, propose the matching draft for `.vegastack/dev.md`, confirm with the user. Every draft is a starting proposal — the user's edits win. Mechanism names here are long-stable; anything version- or vendor-volatile lives in [harness-facts](harness-facts.md) with its checked date and source. Non-GitHub hosting is out of scope for this workflow — the issue/label machinery is GitHub-native.

Each playbook fills the same six slots: **detect** (file signals) · **ship draft** (runbook lines) · **changelog** (the `changelog:` knob value and what dev-implement adds per change) · **version identity** (the one place a version lives) · **guards** (from the library below) · **rollback** (one line for `## Ship`).

## npm package (published)

- **Detect:** `.changeset/config.json`, or a publish workflow / `"private": false` package.json with a registry config.
- **Ship draft:**
  - `auto: apply pending changesets (changeset version), install so any dependency changes reach the lockfile, commit as chore: release <version>`
  - `ask: tag v<version> and push — the tag triggers the publish pipeline`
  - `guard: tag matches the package version` · `guard: changelog has an entry for the tagged version`
  - `auto: confirm the registry shows the new version; report old → new`
- **Changelog:** `changesets`. Per behavior-changing branch, dev-implement writes `.changeset/<slug>.md` **directly** — frontmatter `"<package-name>": <patch|minor|major>` (from the brief's version-impact line) plus the entry itself, shaped per dev-implement's changelog rule. `changeset add` (the bare `changeset` prompt) is interactive; never invoke it in a dark run — `changeset version` at release time is the only CLI use. The release changelog is changesets-written — never hand-edited.
- **Version identity:** `package.json` `version`, changesets-managed. Monorepos: identity is per-package; changesets handles multiple packages natively — the guard reads the released package's manifest. A private workspace root carries no *real* version — pin it at `0.0.0` (some tooling, e.g. `npm sbom` purl generation, requires every package to have one) and never bump it; deleting the field outright breaks such tooling. A lockfile is never the version identity, and package managers differ on whether a workspace's recorded version follows a version-only bump — npm re-records it on the next install, bun does not — so an older version inside a lockfile is a manager behavior to confirm before calling it a defect, and is never repaired by hand-editing the lockfile.
- **Guards:** changeset-presence (PR-time) · tag↔version · changelog-entry.
- **Rollback:** `Rollback is roll-forward: revert on main, release previous-good as a new patch, deprecate the bad version on the registry.`

## Node web app (deployed, not published — Next.js, Vite, Express, …)

- **Detect:** framework config (`next.config.*`, `vite.config.*`, …) with a deploy workflow, platform config (wrangler/Vercel/Netlify), or Dockerfile — and no publish machinery.
- **Ship draft:**
  - `auto: move the [Unreleased] changelog entries under a new dated version heading, commit`
  - `ask: deploy to production (<the project's deploy command or pipeline>)`
  - `guard: changelog has an entry for the version being released` (when the app versions releases; date-based releases skip the version guard)
  - `auto: smoke-check the deployed URL against the Verify flows; report`
- **Changelog:** `keep-a-changelog`. Per behavior-changing branch, dev-implement adds one bullet under `## [Unreleased]` (Added/Changed/Fixed/Removed subsection as fits).
- **Version identity:** `package.json` `version` + the changelog heading, when the project versions releases at all; many apps release by date/deploy — then the changelog heading is the identity and no manifest bump exists.
- **Guards:** changelog-entry; tag↔version only when the project tags releases.
- **Rollback:** `Rollback is redeploying the previous known-good build/revision via the platform; a code fix rolls forward through the normal flow.`

## Flutter app

- **Detect:** `pubspec.yaml` with a `flutter:` section.
- **Ship draft:**
  - `auto: bump pubspec version (semver + incremented build number), move [Unreleased] changelog entries under the new version, commit`
  - `ask: build and submit the store release / trigger the release pipeline`
  - `guard: tag matches the pubspec version` · `guard: changelog has an entry for the version`
  - `auto: report submitted version + build number`
- **Changelog:** `pubspec+changelog` — keep-a-changelog `CHANGELOG.md` (also the source for store release notes), with the version bump living in `pubspec.yaml`.
- **Version identity:** `pubspec.yaml` `version: x.y.z+build` — semver plus a build number the stores require to strictly increase.
- **Guards:** tag↔version (pubspec read) · changelog-entry.
- **Rollback:** `Stores do not roll back a released binary: halt the staged rollout if still in progress, then roll forward with a fixed build.`

## Python (package or app)

- **Detect:** `pyproject.toml`.
- **Ship draft:**
  - `auto: bump [project] version, move [Unreleased] changelog entries under it, commit`
  - `ask: tag v<version> and push — tag triggers the publish/deploy pipeline`
  - `guard: tag matches the pyproject version` · `guard: changelog has an entry for the version`
- **Changelog:** `keep-a-changelog`.
- **Version identity:** `pyproject.toml` `[project] version` (a project pinning it elsewhere names that place in dev.md instead — one place only).
- **Guards:** tag↔version (pyproject read) · changelog-entry.
- **Rollback:** `Roll forward: yank the bad release on the index if supported, publish previous-good as a new patch.`

## Go module

- **Detect:** `go.mod`.
- **Ship draft:**
  - `auto: move [Unreleased] changelog entries under the new version, commit`
  - `ask: tag v<version> and push — the tag IS the release for module consumers`
  - `guard: changelog has an entry for the tagged version`
- **Changelog:** `keep-a-changelog`.
- **Version identity:** the git tag `vX.Y.Z` — Go modules carry no manifest version, so no tag↔version guard exists or is needed.
- **Guards:** changelog-entry.
- **Rollback:** `Roll forward and add a retract directive for the bad version in go.mod, released as a new patch.`

## Generic / none of the above

- **Detect:** none of the signals matched.
- **Ship draft:** `Ship: merge only` — a valid runbook.
- **Changelog:** `keep-a-changelog` if the user wants a history; otherwise `none (<reason>)`. A project with an existing convention that matches no knob value records `none (<its convention>)` — the knob never silently mismatches reality.
- **Version identity / guards / rollback:** none until machinery appears; sections render their TODO line and the self-heal rule covers the rest.

## Guard library

Each guard is one small shell block with **two uses**: a `guard:` line in `## Ship` that dev-ship runs locally at its runbook position (fast feedback), and the same block as a CI step (the backstop that actually blocks a bad publish — order it **before** the publish step, and offer to write it on the user's yes). Render every `guard:` line in dev.md with its runnable command inline, variables bound (dev-ship reads dev.md, not this file — a guard without its command is an improvisation invitation). Adapt paths/commands per the stack; never offer a guard whose machinery the project lacks.

**changelog-entry** — fail when the changelog has no section for the version. Handles both heading styles (`## 1.2.3` changesets, `## [1.2.3]` keep-a-changelog):

```sh
awk -v ver="$VERSION" '
  $0 == "## " ver || index($0, "## [" ver "]") == 1 { inside = 1; next }
  inside && /^## / { exit }
  inside && /^\[.*\]:/ { next }
  inside { print }
' "$CHANGELOG" | grep -q '[^[:space:]]' \
  || { echo "no changelog entry for $VERSION in $CHANGELOG"; exit 1; }
```

(The `^\[.*\]:` skip keeps keep-a-changelog's trailing link-reference block from counting as entry content.)

**tag↔version** — fail when the tag disagrees with the manifest:

```sh
# VERSION per stack ($TAG is the tag being created locally, or $GITHUB_REF_NAME in CI):
#   npm:     node -p "require('./package.json').version"
#   Flutter: sed -n 's/^version:[[:space:]]*"\{0,1\}\([0-9][^+" ]*\).*/\1/p' pubspec.yaml
#   Python:  python3 -c "import tomllib; print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])"   # tomllib needs Python >= 3.11; older: tomli
[ "v$VERSION" = "$TAG" ] || { echo "tag $TAG != manifest version $VERSION"; exit 1; }
```

**changeset-presence** (npm stacks, PR-time) — fail when a behavior-changing branch carries no changeset:

```sh
npx changeset status --since "origin/$DEFAULT_BRANCH"   # or bunx, per the project's runner
```

Blind spot: `changeset status` sees changed **workspace packages** only — content outside any package (docs, repo tooling) is invisible to it, so the evidence comment's `**Changelog:**` line stays the human check.

## Greenfield playbook

No git repo or no origin remote is a greenfield run, not an error. Detection has nothing to read, so the interview supplies intent:

1. Ask the intended stack (offer the playbook list above) and whether the project will publish, deploy, or neither — this picks the draft conventions up front.
2. Offer, each on its own yes: `git init` (default branch `main`) · `gh repo create <owner>/<name> --private` + first push · a stack-appropriate `.gitignore`.
3. Scaffolding the app itself (create-next-app, flutter create, …) is **not** this skill's job — name the conventional command for the chosen stack and leave running it to the user (or `dev-architect` guidance).
4. Render dev.md from the chosen playbook's conventions; every section whose machinery doesn't exist yet gets its `TODO — re-run dev-setup when it appears` line. Declined remote → skip labels, record the TODO, and say what was skipped.

## Decision-capture hooks

The ship-guard hook, its wiring, and the hook API facts live in [harness-facts](harness-facts.md) — volatile vendor surface, dated and sourced there. Offer only the ship guard in Round C; the session hooks wait for #216. Write hook files only on the user's explicit yes.

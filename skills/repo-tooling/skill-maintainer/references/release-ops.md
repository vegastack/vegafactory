# Release, rename, and rollback operations

The expanded release/rename/rollback detail behind the `## Ship` runbook and content-semver bullet in `.vegastack/dev.md` at the repo root. dev.md is the canonical process doc and wins on any disagreement; this file only elaborates it and must never contradict it.

## Semver for skill content

Content is advisory prose and decision tables — no rule IDs, no machine-extracted rule format.

| Bump | Content change |
|---|---|
| MAJOR | Removing a skill. A breaking change to the per-project profile format (`.vegastack/dev.md`) that invalidates existing committed profiles — the operator may also declare any other change major. |
| MINOR | Renaming a skill (default — the operator declares major when the break warrants it). New reference file or reference section. New or changed recorded decision (e.g. a new "use/not/why" row, a new red line). New skill. |
| PATCH | Factual refreshes: pinned-fact updates, version pins, vendor mechanism names, URLs, registry checksums. Wording clarifications that don't change the recorded decision. Test/fixture-only changes. |

Installer/CLI changes follow ordinary semver on the same package version; a release takes the highest bump either side requires.

## One version identity

There is a single source of truth: the **package version** (`packages/cli/package.json`,
changesets-managed) — the npm release identity for the installer and every bundled skill's
content snapshot. No skill tracks a separate content-contract version, and no per-project
profile carries a schema version to validate against.

## Release flow (tag-driven)

1. Every PR that changes released behavior lands with a changeset — a `.changeset/<slug>.md` written directly, since the `changeset` add prompt is interactive (`bunx changeset version` at release time is the only CLI use) — whose bump follows the table above and whose shape follows dev-implement's changelog rule.
2. Maintainer, at release time: `bunx changeset version` (applies changesets to `packages/cli/package.json` and the changelog), then `bun install` so any dependency changes riding along reach the lockfile, commit on a `chore/release-<version>` branch and open its PR — main is branch-protected with no admin exemption, so the bump reaches main by merge and never by direct push. That install does **not** update the workspace's own version inside `bun.lock`: measured on the bun the root `packageManager` line pins, the recorded version is left unchanged by a plain install, by `--force`, and even by `--lockfile-only`, so it sits at an older number indefinitely. `bun install --frozen-lockfile`, which CI and the release workflow both run, passes with it, and nothing in this repo reads it: `packages/cli/package.json` is the single release identity. Never hand-edit the lockfile to "correct" it. The release record is `packages/cli/CHANGELOG.md`, changesets-written — never by hand; the root `CHANGELOG.md` is the frozen pre-0.3.0 record pointing there.
3. Merge the release PR on the operator's word, pull main, then tag that merged commit `v<version>` and push the tag. Tags are not branch-protected, so the tag push is unaffected.
4. The release workflow prepares one immutable CLI/dashboard pair before either package publishes. `scripts/release-artifacts.mjs prepare <evidence-dir> v<version>` requires clean source and records full source/tree identity, toolchains, check and built-skill scan evidence, build-graph and shipped-runtime SBOMs. It builds/assembles dashboard and CLI/skills, scans, packs dashboard with scripts disabled, derives its regular-file descriptor into generated CLI dist, then packs CLI with scripts disabled. Rebuilding CLI invalidates its descriptor. The final external manifest binds both exact tarballs; generated descriptors are never committed.
5. `scripts/release-publish.mjs <manifest> --publish --promote` is an explicit release operation on the operator's word. It uses retained tarballs with scripts disabled and the existing authentication arrangement; this work does not restore provenance or change runners. Stage dashboard before CLI under a non-latest candidate tag. Compare registry integrity and downloaded payload bytes separately from provenance; #156 owns actual registry/attestation evidence. Only a definite public/authenticated 404 means absent. Network, rate-limit and auth failures stop recovery; a timed-out publish is read back before any later attempt. Matching existing versions resume; conflicting bytes require an operator-selected new version.
6. The states are prepared → dashboard-present → pair-present → smoked → promoted. Smoke the downloaded pair in clean homes before changing either latest tag or claiming release success. Promotion is not atomic: failed second-tag promotion leaves a recorded partial state; rerun verifies the same immutable pair, repeats smoke, then converges both tags. Never retag historical releases or move latest backward. Retain tarballs, manifests, SBOMs and failure logs as CI artifacts and release assets; copy needed evidence before artifact retention expires. A platform is qualified only by results for this same descriptor-backed pair on that actual OS/architecture. Missing Linux guest execution remains unperformed; macOS or source engines cannot prove Ubuntu x64 compatibility.

Contributors do not bump versions in PRs; releases are maintainer-driven.

## Rollback

`npm unpublish` is limited to 72 hours and breaks pinned consumers — it is not the rollback mechanism.

1. **Roll forward:** revert the offending commits through a PR onto `main` (protection applies to reverts too), changeset, tag, release the previous known-good content as a **new patch version**.
2. **Deprecate the bad version:** `npm deprecate @vegastack/vegafactory@<bad> "Broken — use <new>"`.
3. Unpublish only if the bad version leaked secrets or is actively harmful, still within 72 hours, and always *in addition to* steps 1–2, never instead.

## Rename a skill

Skill names are consumer-facing identifiers — treat a rename as a stable-ID break:

1. Rename the directory and the frontmatter `name` in the same commit — they must always stay equal.
2. Update every wiring point in the same PR: the skill's entry in `packages/cli/packaging.json`, the root README skills table row, and any cross-skill or docs links.
3. Changeset: MINOR by default — major only when the operator declares it. Either way, note the migration in `CHANGELOG.md`: copies installed under the old name are orphaned, and installer operations addressed to the old name stop resolving once the shipped manifest no longer knows it.
4. Registry source IDs inside `refresh/sources.json` are skill-internal and unaffected, but every `affected` ref must still resolve to a real reference in the renamed tree.
5. Re-run `node packages/cli/scripts/validate-skill.mjs <new-skill-dir>`, the skill's tests, and `node packages/cli/scripts/structure.mjs check` — name/directory equality is validated, and the structure check catches a README row left pointing at the old path.

## Deprecate / remove a skill

1. Announce deprecation in the root README table and `CHANGELOG.md` at least one release before removal when practical.
2. Removal: delete the skill's directory, remove its allowlist entries and README row, MAJOR changeset with migration notes. Removing the last skill from a group also removes the group's `GROUP.md` and its README section.
3. Removing a skill in a new MAJOR does **not** deprecate previously published package versions — `npm deprecate` only versions that are themselves broken.

## Refresh branches

Branches named `refresh/**` are reserved for the automated freshness loop and are CI-restricted to refresh metadata at either legal depth (`skills/<name>/refresh/` and `skills/<group>/<name>/refresh/`). Human content changes go on normal branches. Never hand-edit checksums/versions/timestamps anywhere — CI re-fetches claimed baselines, so hand-edited values cannot merge.

# Dev profile — vegastack/vegafactory

This file is the project's handbook and its only process document: short directional bullets, not prose. Skills read the section they need. When reality disagrees with a line, fix the line; when a gotcha or repeated instruction surfaces, fold ONE line into the right section — never append a log. A section left as TODO because its machinery didn't exist yet: re-run dev-setup detection when the machinery appears.

repo: vegastack/vegafactory · default branch main
stack: Bun monorepo — authored skills under skills/<name>/ or skills/<group>/<name>/ (one level, GROUP.md per group; the packaged bundle stays flat), @vegastack/vegafactory installer under packages/cli (Node >= 24)
commands: test `bun test` · check `bun run check` · build `bun run build` · setup `bun install --frozen-lockfile`
authority: CONTRIBUTING.md → this file → skill-maintainer's release-ops.md (expanded release/rename detail) → skill defaults

## Knobs

review: cross-agent-risky   # subagent | cross-agent-risky | cross-agent — codex-cli 0.149.1 present (verified 29-08-2026)
harnesses: claude 2.1.247 · codex 0.149.1 · hermes absent   # detected 03-09-2026; a dev-setup re-run refreshes it
harness-policy: intake claude fable high · plan claude fable high · implement claude fable high · review codex gpt-5.6 xhigh · status claude sonnet medium · chronicle claude sonnet medium   # `<stage> <agent> <model> <effort>`; raise planning to xhigh for a risky full-plan issue. Model ids move — edit this line, never a skill; the flags each value becomes are in dev-setup's references/harness-facts.md
ui-evidence: none           # no UI in this repo
gates: 3                    # 3 = approve/PR/merge · 2 = approve + one "ship it" · 1 = direct-to-main, which main's branch protection makes unavailable here
tests: required             # scripts' deterministic branches; prose quality bar is the behavioral eval
skillspector-update: auto   # off | notify | auto — the CLI self-installs and self-upgrades through whatever channel holds it (uv here); a failed update falls back to the installed copy
skill-scan: packages/cli/skill   # the BUILT bundle — authored skills/ carries unpackaged tests/ fixtures that are deliberately adversarial and score higher than anything shipped; suppressions in .vegastack/skillspector-baseline.json
merge: rebase               # meaningful commits, linear history
branch: <type>/<slug>       # type: feat | fix | docs | chore | refactor — the only place this list lives
worktree-include: .claude/settings.json      # the Claude hook wiring is gitignored, so each worktree needs its own copy; .codex/hooks.json is tracked and needs none
worktree-retention: 14d     # a parked worktree survives this long with no session, measured from the later of its last commit and its last ledger edit
labels: needs-operator needs-plan ready working for-operator risky research quick-build full-plan epic   # epic label marks map parents (org has no native Epic issue type)
board: none                 # no project board yet; the operator's project commands are in vegafactory-setup's references/control-room.md
issue-types: Feature=feat · Bug=fix · Task=docs,chore,refactor,research   # no Epic type in this org — the epic label marks map parents
issue-fields: Priority=Urgent,High,Medium,Low default Medium · Effort=High,Medium,Low default quick-build→Low, full-plan→Medium   # detected 03-09-2026, options in .priority order
changelog: changesets
decisions: .vegastack/decisions.md
release: on-request         # only when the operator says "release" — covers everything merged since the last one (switched from per-merge for the v3 epic, operator 28-08-2026)
chronicle: on               # story entry per behavior-changing branch in .vegastack/chronicle.md
architect: kmanojkumar      # the architecture owner dev-architect speaks to — gh api user -q .login at setup, one edit to change
control-room: vegastack/vegafactory-control-room#dev@0000000   # org control room · group · the clone sha this profile was drafted from; the sha is recorded on the first real sync, once the control room exists (#112)
sync-max-age: 30m           # how stale the local control-room clone may be before a session refreshes it — <n>m or <n>h
operators: kmanojkumar      # csv of the humans who own issues here; every state flip assigns per conventions' Labels table
chronicle-style: plain      # plain | story | witty — the voice of chronicle entries (dev-chronicle's references/styles.md)
emoji: none                 # none | sparing

## Ship — what happens after merge, in order

Line prefixes: `auto:` (agent just does it) · `ask:` (operator's word first) · `guard:` (deterministic check run locally at this position; its release.yml copy is the backstop).

- auto: `bunx changeset version && bun install` → commit `chore: release @vegastack/vegafactory <version>` on a `chore/release-<version>` branch → open its PR — the install is there to carry dependency changes; main is branch-protected with no admin exemption, so the bump lands by merge and never by direct push
- ask: merge the release PR — the version bump is the last reviewable moment before the tag publishes, so it takes the operator's word of its own, not the release word
- guard: both packages carry the tag version — `V=$(node -p "require('./packages/cli/package.json').version"); test "$V" = "$(node -p "require('./packages/dashboard/package.json').version")"` — `vegafactory dashboard` fetches `@vegastack/vegafactory-dashboard` at the CLI's own version, so a mismatch ships a verb whose first-use fetch resolves nothing
- guard: changelog entry exists for the new version — `V=$(node -p "require('./packages/cli/package.json').version"); awk -v ver="$V" '$0=="## "ver{f=1;next} f&&/^## /{exit} f{print}' packages/cli/CHANGELOG.md | grep -q '[^[:space:]]'`
- guard: the release tag targets the clean reviewed merged bump commit; its workflow owns the one release pair and runs frozen install/check, build/assemble, complete built-bundle scan, dashboard-first packing with the CLI descriptor, and actual first-use smoke. Missing/expired scanner evidence blocks preparation; publication never rebuilds.
- auto: pull main, then tag and push exactly `v$(node -p "require('./packages/cli/package.json').version")` on the merged bump commit — covered by the operator's release word. The repository-wide serialized Release job prepares one finalized pair, retains its exact tarballs/manifest/checks/scan/SBOM hashes before any registry mutation, stages dashboard then CLI, verifies downloaded bytes, smokes first use, and promotes both tags with per-package readback; watch it to green.
- guard: recovery reruns that same serialized Release job using the retained pair. Only affirmative prior-attempt evidence that publication was skipped permits retrying a failed preparation without a finalized pair. Missing/expired retained bytes after possible publication refuse rebuilding; an outage is never absence. A partial promotion remains recorded and must reconcile both tags; latest never moves backward. Local live publication is refused, so recovery uses existing workflow authentication and no new local credentials.
- auto: inspect/download that workflow's exact retained pair and outcome (including per-package promotion), and verify with `node scripts/release-artifacts.mjs verify-release <downloaded-directory>/release-manifest.json`; inspect the release assets instead of preparing another pair. Actual registry/provenance qualification remains #156 and current runners stay.
- auto: confirm `npm view @vegastack/vegafactory version` matches (registry propagation can lag — retry briefly) and `npx @vegastack/vegafactory@latest skills list` shows the bundled skills; report old → new
- Publishing is tag-triggered trusted publishing (OIDC, token-free). **Provenance is currently OFF**: `release.yml` runs on `[self-hosted, vsk-runners-mac]` and passes `--no-provenance`, because npm refuses a provenance bundle built anywhere but a GitHub-hosted runner and those are billing-locked (#57) — 0.13.0, 0.16.0, 0.16.1 and 0.17.0 shipped without an attestation. Restore both together: drop the flag when `runs-on` returns to `ubuntu-latest`, never one without the other, and never pass `--provenance` explicitly (it conflicts with trusted-publishing config) — moving `runs-on` to the `vsk-runners-mac-mini` group does not change this, because npm accepts a provenance bundle only from a GitHub-hosted runner
- Rollback is roll-forward: revert the offending commits through a PR (main is protected — there is no direct revert push, and a rollback is exactly when that discipline matters most), release previous-good as a new patch, `npm deprecate` the bad version ("Broken — use <new>"); unpublish only for leaked secrets within 72h, in addition to roll-forward, never instead
- Content semver: new references/sections/recorded decisions/skill renames = minor · factual refreshes, wording, test-only = patch · removing a skill, weakening a normative rule, breaking the per-project profile format = major, and major is otherwise the operator's explicit call (pre-1.0 with zero deployed profile consumers, a profile-format break may ship minor — recorded decision 28-08-2026); installer changes follow ordinary semver on the same version, a release takes the higher bump — detail in skill-maintainer's release-ops.md

## Verify — how to see it working (pre-merge)

- `bun run check` is the whole local verification (validate + tests + lint + typecheck); CI adds a packed-tarball install smoke test
- `vegafactory worktree status` (or `node skills/dev/dev-implement/scripts/worktree.mjs status --json`) reconciles the worktrees against open issues before a hand-back: orphan directories, worktrees with no open issue, open issues with no checkout
- Skill scanning is separate from `check` because it needs Python 3.12 + SkillSpector, while `check` must stay Bun+Node only: `bun run build && node skills/skills-tooling/skill-scan/scripts/skill-scan.mjs --json` — build first, the knob names the built bundle and `.vegastack/skillspector-baseline.json` is picked up by convention. Exit 2 blocks the hand-back; a new suppression needs the operator's word, never a widened rule to reach green

## Environments

- npm registry via tag-triggered trusted publishing — no local npm credentials exist or are needed
- GitHub Actions runs CI, release, and the weekly refresh (refresh/** branches are CI-restricted to refresh metadata)
- Harnesses on this box (03-09-2026): `claude` 2.1.247 and `codex` 0.149.1; **no `hermes`**, which costs nothing because no `harness-policy:` stage names it — install it only if a stage ever does. Beware that `codex login status` prints "Logged in" on a revoked refresh token, so it is not an auth guard; only a real run is
- A brief whose acceptance needs a live `claude -p` or `codex exec` proof checks both CLIs are authenticated first (`claude -p 'say ok'`, `codex exec --sandbox read-only -a never 'say ok'`) — an expired session turns that acceptance into a parked finding, as it did on #94
- main is branch-protected: a PR is required, force-pushes and deletion are blocked, linear history and conversation resolution are enforced, and admins are NOT exempt — so every path to main, agent or human, goes through a PR. **`check (node 24)` is a required status check** (strict: a branch must be up to date with main before merging), enabled 02-09-2026 once `ci.yml` moved to `[self-hosted, vsk-runners-mac]` and started passing again (#87). CI and release still run on the two laptop runners (`vsk-runners-mac`), and they are the dependency: if both are offline, nothing merges — check `gh api repos/vegastack/vegafactory/actions/runners` before assuming a stuck PR is a code problem. The always-on Mac mini is the intended host and is **not registered yet** (#119): its org runner group is `vsk-runners-mac-mini`, its runner account is a different macOS user from the dispatcher account so a CI job cannot read the dispatcher's tokens, and provisioning is the control room's `onboarding/dispatcher-box.md`. Moving `runs-on` to that group waits on the operator's org-admin steps, because an empty, offline, or ungranted group queues jobs forever with `runner: null` rather than failing — read `gh api orgs/vegastack/actions/runner-groups` for the group id, then `gh api orgs/vegastack/actions/runner-groups/<id>/runners` (the org endpoint is the one that lists a group's runners; `repos/vegastack/vegafactory/actions/runners` lists repository-level runners). The two runners reuse one work directory job after job, so a workflow that sparse-checks-out (the board mirror reads only `dev.md`) must check out into its own `path:` — git stays in sparse mode otherwise and the next job at that path starts from an almost-empty tree (04-09-2026, #131)
- production: ask — git push origin v
- preview: auto — wrangler deploy --env preview
- preview: auto — bun run --cwd packages/broker deploy:preview
- production: ask — wrangler deploy --env production
- production: ask — bun run --cwd packages/broker deploy:production
- The `- <target>: <auto|ask> — <pattern>` lines above are ship-guard policy lines: this repo publishes by pushing the version tag, so that push is the production action, and the broker's two Worker environments are the other deployable targets — each named twice, once for `wrangler` directly and once for the package script that wraps it, because the guard matches the resolved command text it is handed. Every other bullet in this section is prose the guard ignores. The guard reads these lines only as compiled by `vegafactory guard sync` into `~/.vegastack/guard/vegastack__vegastack-skills.json` (keyed by the origin remote, not this `repo:` line) — run it once after cloning and after any edit here, or every guarded command asks
- The token broker (`packages/broker`, #117) deploys through `.github/workflows/broker-deploy.yml`: `factory-token.vegastack.dev` is preview and goes out automatically on a merge to main; `factory-token.vegastack.com` is production and only a `workflow_dispatch` reaches it, gated by the `production` GitHub Environment's required reviewer. Its credentials are the Secrets Store secret `vegafactory-app-private-key` in the account's one Secrets Store, `default_secrets_store` (Cloudflare allows a single store per account; bound as `APP_PRIVATE_KEY`) plus the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — names only; no value of any kind is ever written in this file

## Decisions

Record a decision only when it is directional — it steers work beyond this issue: a real alternative was rejected; it constrains work not yet written; and no dev.md line, lint rule, or guard can enforce it instead (if one can, write the rule). Feature requests, one-off fixes, and routine implementation choices never qualify. Every entry needs the user's explicit yes. One line in the register (`decisions:` knob), append-only, no other metadata:

- DD-MM-YYYY (github-username) — the decision

## Stop and ask

Pause for the operator only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input only they can provide — ask and end the turn rather than end on a promise. In this project that means: a change of scope or product behavior, a significant new dependency or runtime, spending money, anything destructive or touching production, or a blocker the brief cannot resolve. Nothing ships without the operator's explicit instruction — see the AGENTS.md dev section.

## Project rules

- Every behavior-changing PR carries its changeset, written directly as `.changeset/<slug>.md` (bump per the content-semver bullet in Ship); contributors never bump versions; a changeset names `@vegastack/vegafactory` (and `@vegastack/vegafactory-dashboard` when the dashboard itself changed), and `.changeset/config.json`'s `fixed` group moves both packages to the same version on every release, so the first-use fetch always resolves by construction rather than by every author remembering the second name
- The single version lives in `packages/cli/package.json` (changesets-managed); the workspace root package.json is pinned at `0.0.0` — a placeholder `npm sbom` requires (purls need a version), never bumped, never a release identity; neither is the version `bun.lock` records for the workspace, which does not follow a version bump and is never hand-edited (mechanics: skill-maintainer's release-ops.md)
- Every skill change goes through skillify's contract (8-item checklist, eval before tests)
- A repo-wide prose or format sweep must include `assets/*.template`: dev-setup's profile template and dev-review's known-patterns template carry normative format strings that a `--include="*.md"` grep silently misses
- Never commit generated files: dist/, packages/cli/skill/, skill-integrity.json
- Never hand-edit refresh checksums/versions/timestamps — runner only

# Dev profile — vegastack/vegafactory

This file is the project's handbook and its only process document: short directional bullets, not prose. Skills read the section they need. When reality disagrees with a line, fix the line; when a gotcha or repeated instruction surfaces, fold ONE line into the right section — never append a log. A section left as TODO because its machinery didn't exist yet: re-run dev-setup detection when the machinery appears.

repo: vegastack/vegafactory · default branch main
stack: Bun monorepo — authored skills under skills/<name>/ or skills/<group>/<name>/ (one level, GROUP.md per group; the packaged bundle stays flat), @vegastack/vegafactory installer under packages/cli (Node >= 24)
commands: test `bun run test:affected` · check `bun run check:fast && bun run test:affected` · full `bun run check` · build `bun run build` · setup `bun install --frozen-lockfile`
authority: CONTRIBUTING.md → this file → skill-maintainer's release-ops.md (expanded release/rename detail) → skill defaults

## Knobs

review: cross-agent-risky   # subagent | cross-agent-risky | cross-agent — codex-cli 0.149.1 present (verified 29-08-2026)
harnesses: claude 2.1.247 · codex 0.149.1   # detected 03-09-2026; a dev-setup re-run refreshes it
harness-policy: intake claude fable high · plan claude fable high · implement claude fable high · review codex gpt-5.6 xhigh · status claude sonnet medium · chronicle claude sonnet medium   # `<stage> <agent> <model> <effort>`; raise planning to xhigh for a risky medium issue. Model ids move — edit this line, never a skill; the flags each value becomes are in dev-setup's references/harness-facts.md
ui-evidence: none           # no UI in this repo
gates: 3                    # 3 = approve/PR/merge · 2 = approve + one "ship it" · 1 = direct-to-main, which main's branch protection makes unavailable here
tests: required             # scripts' deterministic branches; prose quality bar is the behavioral eval
skillspector-update: auto   # off | notify | auto — the CLI self-installs and self-upgrades through whatever channel holds it (uv here); a failed update falls back to the installed copy
skill-scan: packages/cli/skill   # the BUILT bundle — authored skills/ carries unpackaged tests/ fixtures that are deliberately adversarial and score higher than anything shipped; suppressions in .vegastack/skillspector-baseline.json
merge: rebase               # meaningful commits, linear history
branch: <type>/<slug>       # type: feat | fix | docs | chore | refactor — the only place this list lives
worktree-include: .claude/settings.json      # the Claude hook wiring is gitignored, so each worktree needs its own copy; .codex/hooks.json is tracked and needs none
worktree-retention: 14d     # a parked worktree survives this long with no session, measured from the later of its last commit and its last ledger edit
labels: waiting-on-operator planning queued in-progress ready-to-ship small medium large research risky epic   # one state label at a time; one size (or research); epic marks map parents
board: none                 # no project board yet; the operator's project commands are in vegafactory-setup's references/control-room.md
issue-types: Feature=feat · Bug=fix · Task=docs,chore,refactor,research   # no Epic type in this org — the epic label marks map parents
issue-fields: Priority=Urgent,High,Medium,Low default Medium · Effort=High,Medium,Low default small→Low, medium→Medium   # detected 03-09-2026, options in .priority order
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

## Ship — what "ship it" does after merge, in order

Line prefixes: `auto:` (agent just does it) · `ask:` (operator's word first) · `guard:` (deterministic check run locally at this position).

- auto: when merged changes carry changesets and a release is due, run `bunx changeset version && bun install` on `chore/release-<version>`, open its PR and add it to the merge queue — the operator's "ship it" covers this
- guard: the tag matches the version and the changelog has its entry — `node scripts/release.mjs check-tag v<version>`
- auto: pull main, then tag and push `v<version>` on the merged release commit — covered by "ship it" (the 0.20.0 clean-break release is the exception: it waits for the operator's own word)
- auto: watch the Release workflow to green; confirm `npm view @vegastack/vegafactory version` shows the new version and `npx @vegastack/vegafactory@latest skills list` works; report old → new
- Publishing is tag-triggered trusted publishing on GitHub-hosted runners with npm provenance — no tokens. The workflow packs, smokes the tarball, publishes, waits for the registry and smokes the published version
- A failed release is never re-run: fix forward with a new patch version
- Rollback is roll-forward: revert through a PR, release a new patch, and `npm deprecate` the bad version ("Broken — use <new>"); unpublish only for leaked secrets within 72h, in addition to the roll-forward
- Content semver: new references/sections/recorded decisions/skill renames = minor · factual refreshes, wording, test-only = patch · removing a skill, weakening a normative rule, breaking the per-project profile format = major, and major is otherwise the operator's explicit call (pre-1.0 with zero deployed profile consumers, a profile-format break may ship minor — recorded decision 28-08-2026); installer changes follow ordinary semver on the same version, a release takes the higher bump — detail in skill-maintainer's release-ops.md

## Verify — how to see it working (pre-merge)

- Checks run once each: the pre-commit hook runs `bun run check:fast` (validators + lint + typecheck, ~5 s); while building run `bun run test:affected` (only tests the change can reach); the merge queue runs the full `bun run check` plus build, pack smoke and skill scan. Use `./` paths with `bun test` — a bare word is a path filter
- `vegafactory worktree status` reconciles the worktrees against open issues before a hand-back: orphan directories, worktrees with no open issue, open issues with no checkout
- The skill scan runs in the merge queue on the built bundle. To investigate a finding locally (needs Python 3.12 + SkillSpector): `bun run build && node skills/skills-tooling/skill-scan/scripts/skill-scan.mjs --json`; `.vegastack/skillspector-baseline.json` is picked up by convention, and a new suppression needs the operator's word, never a widened rule

## Environments

- npm registry via tag-triggered trusted publishing — routine releases use hosted OIDC and no local credential; the one-time creation of the two renamed packages at `0.19.0` was an operator-authenticated local bootstrap
- GitHub Actions runs CI (pull requests and the merge queue), the tag-triggered release, and the board mirror
- Harnesses on this box (03-09-2026): `claude` 2.1.247 and `codex` 0.149.1. Beware that `codex login status` prints "Logged in" on a revoked refresh token, so it is not an auth guard; only a real run is
- A brief whose acceptance needs a live `claude -p` or `codex exec` proof checks both CLIs are authenticated first (`claude -p 'say ok'`, `codex exec --sandbox read-only -a never 'say ok'`) — an expired session turns that acceptance into a parked finding, as it did on #94
- main is protected: PRs only, squash merges only, no force-push or deletion, linear history, conversation resolution, admins included; required check `check (node 24)` (not strict — the merge queue tests main + the PR instead)
- CI runs on the Mac mini org runners (`vsk-runners-mac-mini`, macOS user `vegastack-runners`, separate from the operator account) for pull requests from this repository's own branches; fork PRs and merge-queue groups run on `ubuntu-latest`, and fork workflows need a maintainer's approval first. If both Mac mini runners are offline, own-branch PRs cannot pass — check `gh api orgs/vegastack/actions/runners` before treating a stuck job as a code problem
- Self-hosted runners reuse one work directory: a workflow that sparse-checks-out must check out into its own `path:`
- production: ask — git push origin v
- The `- <target>: <auto|ask> — <pattern>` line above is a ship-guard policy line: this repo publishes by pushing the version tag, so that push is the production action. The guard reads it only as compiled by `vegafactory guard sync` into `~/.vegastack/guard/<owner>__<repo>.json` — run it after cloning and after any edit here

## Decisions

Record a decision only when it is directional — it steers work beyond this issue: a real alternative was rejected; it constrains work not yet written; and no dev.md line, lint rule, or guard can enforce it instead (if one can, write the rule). Feature requests, one-off fixes, and routine implementation choices never qualify. Every entry needs the user's explicit yes. One line in the register (`decisions:` knob), append-only, no other metadata:

- DD-MM-YYYY (github-username) — the decision

## Stop and ask

Pause for the operator only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input only they can provide — ask and end the turn rather than end on a promise. In this project that means: a change of scope or product behavior, a significant new dependency or runtime, spending money, anything destructive or touching production, or a blocker the brief cannot resolve. Nothing ships without the operator's explicit instruction — see the AGENTS.md dev section.

## Project rules

- Every behavior-changing PR carries its changeset, written directly as `.changeset/<slug>.md` (bump per the content-semver bullet in Ship); contributors never bump versions; a changeset names `@vegastack/vegafactory`, the only published package
- The single version lives in `packages/cli/package.json` (changesets-managed); the workspace root package.json is pinned at `0.0.0`, never bumped, never a release identity; neither is the version `bun.lock` records for the workspace, which does not follow a version bump and is never hand-edited (mechanics: skill-maintainer's release-ops.md)
- Every skill change goes through skillify's contract (8-item checklist, eval before tests)
- A repo-wide prose or format sweep must include `assets/*.template`: dev-setup's profile template and dev-review's known-patterns template carry normative format strings that a `--include="*.md"` grep silently misses
- Never commit generated files: dist/, packages/cli/skill/, skill-integrity.json
- Never hand-edit refresh checksums/versions/timestamps — runner only

# Dev profile — vegastack/vegafactory

This file is the project's handbook and its only process document: short directional bullets, not prose. Skills read the section they need. When reality disagrees with a line, fix the line; when a gotcha or repeated instruction surfaces, fold ONE line into the right section — never append a log. A section left as TODO because its machinery didn't exist yet: re-run dev-setup detection when the machinery appears.

repo: vegastack/vegafactory · default branch main
stack: Bun monorepo — authored skills under skills/<name>/ or skills/<group>/<name>/ (one level, GROUP.md per group; the packaged bundle stays flat), @vegastack/vegafactory installer under packages/cli (Node >= 24)
commands: test `bun run test:affected` · check `bun run check:fast && bun run test:affected` · full `bun run check` · build `bun run build` · setup `bun install --frozen-lockfile`
authority: CONTRIBUTING.md → this file → skill-maintainer's release-ops.md (expanded release/rename detail) → skill defaults

## Knobs

harnesses: claude 2.1.263 · codex 0.153.4   # detected 18-09-2026; a dev-setup re-run refreshes it
harness-policy: intake claude default high · plan claude default high · implement claude default high · review codex default xhigh · status claude default medium · chronicle claude default medium   # `<stage> <agent> default|<model id> <effort>`; `default` pins no model (the tool's own); a pinned id must be one this account can actually use, or the run fails. Raise planning to xhigh for a risky medium issue. Edit this line, never a skill; the flags each value becomes are in dev-setup's references/harness-facts.md
ui-evidence: none           # no UI in this repo
tests: required             # scripts' deterministic branches; prose quality bar is the behavioral eval
vegafactory-update: auto    # off | notify | auto — session starts check npm; auto updates attended sessions in the background and idle dispatchers between passes, notify only reports, off makes no check
merge: squash               # one commit per issue on main, matching the branch protection
branch: <type>/<slug>       # type: feat | fix | docs | chore | refactor — the only place this list lives
worktree-include: .claude/settings.json      # the Claude hook wiring is gitignored, so each worktree needs its own copy; .codex/hooks.json is tracked and needs none
worktree-retention: 14d     # a parked worktree survives this long with no session, measured from the later of its last commit and its last ledger edit
labels: waiting-on-operator planning queued in-progress ready-to-ship small medium large research risky epic   # the fixed set, nothing renameable: one state label at a time, one size (or research); risky and epic are marks, and epic marks a map parent
board: none                 # no project board yet; the operator's project commands are in vegafactory-setup's references/control-room.md
issue-types: Feature=feat · Bug=fix · Task=docs,chore,refactor,research   # no Epic type in this org — the epic label marks map parents
issue-fields: Priority=Urgent,High,Medium,Low default Medium · Effort=High,Medium,Low default small→Low, medium→Medium   # detected 03-09-2026, options in .priority order
changelog: changesets
decisions: .vegastack/decisions.md
release: on-request         # only when the operator says "release" — covers everything merged since the last one (switched from per-merge for the v3 epic, operator 28-08-2026)
chronicle: on               # story entry per behavior-changing branch in .vegastack/chronicle.md
guard: loose                # strict | loose — loose asks only before a force push and a hard reset, plus this file's own `ask:` lines; everything else is internal work a trusted team can undo. Read from the default branch, so a branch cannot loosen itself
architect: kmanojkumar      # the architecture owner dev-architect speaks to — gh api user -q .login at setup, one edit to change
control-room: vegastack/vegafactory-control-room#dev@0000000   # org control room · group · the clone sha this profile was drafted from; the sha is recorded on the first real sync, once the control room exists (#112)
sync-max-age: 30m           # how stale the local control-room clone may be before a session refreshes it — <n>m or <n>h
operators: kmanojkumar      # csv of the humans who own issues here; every state flip assigns per conventions' Labels table
chronicle-style: plain      # plain | story | witty — the voice of chronicle entries (dev-status's references/styles.md)
emoji: none                 # none | sparing

## Ship — what "ship it" does after merge, in order

Line prefixes: `auto:` (agent just does it) · `ask:` (operator's word first) · `guard:` (deterministic check run locally at this position).

- guard: the issue may land at all — `vegafactory ship check <n>`: the recorded "ship it" after the latest evidence, the branch clean and pushed, a clean cross-tool review of the head that merges, its PR open and green against main
- auto: merge that PR through the queue, confirm `Closes #<n>` closed the issue, then take the directory only — `vegafactory worktree remove <n>`
- auto: when merged changes carry changesets and a release is due, run `bunx changeset version && bun install` on `chore/release-<version>`, open its PR and queue it
- ask: merging the release PR — it belongs to no issue, so no recorded word covers it and the guard asks
- auto: pull main, then tag the merged release commit — `vegafactory ship release <n>` re-reads issue n's word, checks the version against its changelog entry and pushes `v<version>` itself; raw `git tag` and tag pushes still ask
- auto: watch the Release workflow to green; confirm `npm view @vegastack/vegafactory version` shows the new version and `npx @vegastack/vegafactory@latest skills list` works; report old → new
- Publishing is tag-triggered trusted publishing on GitHub-hosted runners with npm provenance — no tokens. The workflow packs, smokes the tarball, publishes, waits for the registry and smokes the published version
- A failed release is never re-run: fix forward with a new patch version
- Rollback is roll-forward: revert through a PR, release a new patch, and `npm deprecate` the bad version ("Broken — use <new>"); unpublish only for leaked secrets within 72h, in addition to the roll-forward
- Content semver: new references/sections/recorded decisions/skill renames = minor · factual refreshes, wording, test-only = patch · removing a skill, weakening a normative rule, breaking the per-project profile format = major, and major is otherwise the operator's explicit call (pre-1.0 with zero deployed profile consumers, a profile-format break may ship minor — recorded decision 28-08-2026); installer changes follow ordinary semver on the same version, a release takes the higher bump — detail in skill-maintainer's release-ops.md

## Verify — how to see it working (pre-merge)

- Checks run once each: the commit-msg hook runs `bun run check:fast` (skipped for `wip:` checkpoints) (validators + lint + typecheck, ~5 s); while building run `bun run test:affected` (only tests the change can reach); the merge queue runs the full `bun run check` plus build and pack smoke. Use `./` paths with `bun test` — a bare word is a path filter
- `vegafactory worktree status` reconciles the worktrees against open issues before a hand-back: orphan directories, worktrees with no open issue, open issues with no checkout

## Environments

- Pull-request and merge-queue CI is one GitHub-hosted `ubuntu-latest` job, `check (node 24)`: fast checks and affected tests on a PR, and on the queue the full suite, the build and the pack smoke — everything once, on main plus the PR. Fork workflows need a maintainer's approval
- main is protected: PRs only, squash merges only, no force-push or deletion, linear history, conversation resolution, admins included; `check (node 24)` is the one required check, not strict, because the queue tests main + the PR instead
- The tag-triggered Release workflow is GitHub-hosted too: it packs, smokes the tarball, publishes to npm with trusted publishing and provenance — no token anywhere — waits for the registry, smokes the published version and writes the GitHub release. `vegafactory ship release <n>` creates the tag that starts it; raw `git tag` and tag pushes still ask
- The Mac mini org runners (`vsk-runners-mac-mini`) serve only trusted jobs — today the board mirror. Self-hosted runners reuse one work directory, so a workflow that sparse-checks-out must check out into its own `path:`
- Harnesses on this box (18-09-2026): `claude` 2.1.263 and `codex` 0.153.4. Beware that `codex login status` prints "Logged in" on a revoked refresh token, so it is not an auth guard; only a real run is
- A brief whose acceptance needs a live `claude -p` or `codex exec` proof checks both CLIs are authenticated first (`claude -p 'say ok'`, `codex exec --sandbox read-only -a never 'say ok'`) — an expired session turns that acceptance into a parked finding, as it did on #94

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

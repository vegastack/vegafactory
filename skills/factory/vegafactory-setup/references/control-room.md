# The control room

The org's `vegafactory-control-room` repository: what each file holds, which file wins when two disagree, and how a run reads it. `vegafactory-setup` seeds every file here from `assets/control-room/*.template`; `dev-setup` reads them before it asks a repo anything.

## Layout

```
org.md                       global only: org name, goals, what applies to everyone (questionnaire)
people.csv                   login,name,role,slack,timezone,groups
decisions.md                 org-level register (same line format as repos)
groups/<g>/group.md          department defaults: one line per knob a group can decide for a repo dev.md
groups/<g>/people.csv        group-level people (adds to / overrides org)
groups/<g>/decisions.md      group-level register
repos.md                     registry: repo, group, board, owner (maintained by this skill)
boards.md                    project boards and repo -> board mapping
rules/                       org-wide review known-patterns, security rules, CODEOWNERS pattern
onboarding/new-repo.md       checklist run by vegafactory-setup, then dev-setup
onboarding/new-teammate.md   gh auth, harness install, skills install, control-room access, Slack
templates/                   hook wiring snippets, board workflow, dev.md section overrides
stats/<owner>__<name>/<MON-YYYY>/<hostname>.jsonl   one record per run or session, written by automation
stats/<owner>__<name>/<MON-YYYY>.summary.json       regenerated per repo per month
stats/<owner>__<name>/<MON-YYYY>.timeline.json      regenerated: the month's issue label timelines, read through gh at rollup
stats/org/<MON-YYYY>.summary.json                   regenerated across every repo
stats/org/<MON-YYYY>.skills.json                    regenerated: invocations per skill
```

`stats/` is the one tree automation writes, and the shape is the reason it can. One file per repo, per month, per **machine** means two machines never touch the same file, so a concurrent push is a non-fast-forward — solved by `pull --rebase` and a retry — and never a content conflict needing a human. The repo segment is `<owner>__<name>` so a path stays two levels deep and a repo name can never be mistaken for a month directory. The three summaries are **regenerated**, never appended: a summary that accumulated would drift the first time a record arrived late from a machine that was offline. Records are counts and identifiers only — never prompt text, assistant text, tool arguments, or file contents — and `rules/stats-privacy.md` is where that promise is written down for everyone the org onboards.

`groups/dev/` is the only department seeded today; another department is a new `groups/<g>/` with the same three files.

## Effective policy

Resolve Markdown through dev-setup's `scripts/effective-policy.mjs`. Ordinary explicit values inherit org → group → repo; each harness stage inherits individually. Organization locks require exact organization delegation before a group or repo can change them. Repository `dispatch: local` remains an explicit local opt-in. Repository commands and Ship/Environments lines stay repository facts, not inherited executable instructions. Decision registers concatenate; a lesson or register entry grants no authority.

Use `policy-schema: 2` and one `vsk-policy` fenced JSON object in `org.md`. Its `schemaVersion` is2, with `locked` and `delegations` as shown in the org template. Lockable keys are `stats`, `stats-export`, `gates`, `tests`, `review`, `provider-mode`, `learning`, `learning-adoption`. A delegation names exact groups, canonical repositories and allowed values; wildcards and delegation chains refuse. Attributed reporting requires explicit org authorization. Unknown extension fields remain inert; duplicate keys, bad known values or an unknown schema refuse rather than overwrite.

Legacy version1 ordinary knobs remain readable. An org `stats-override: locked` locks its explicit `stats` value; without that value migration refuses. A group's `stats-override: allowed` is not org delegation. Inspect old/effective/proposed values and sources, retain original files, and approve the concrete authority-changing diff before migration. Other organizations confirm their own quality, reporting and supported subscription harness choices; templates do not select models for them.

## What each file may and may not carry

- `org.md` holds organization policy and stage defaults: the org name, the goals in one paragraph, and what applies to everyone — language, the date format, the "nothing ships without the operator's instruction" stance, and the statistics policy lines `stats:`, `stats-people:`, `stats-override:`. Groups may override ordinary org defaults; mandatory constraints and all administration assignments remain org-owned.
- `org.md`'s `## Automation identity` block records the org's GitHub App by name, five lines and no more: `app:` the App name, `app-slug:` the slug the actor string and the install URL both follow, `app-install:` the installation id from `gh api orgs/<org>/installations`, `app-secrets:` the two secret **names**, and `app-permissions:` the granted set. The permission table, the mint recipe, rotation and the kill switch live in dev-setup's `references/github-app.md` and are never restated here.
- `groups/<g>/group.md` carries one default for every knob a group can decide for a `.vegastack/dev.md`, in the same line shape dev.md uses (`harness-policy:` is one line, never six `harness:` lines — the dispatcher reads both files with one parser), so a repo that answers nothing else still gets a complete profile; per-repo facts (`repo:`, `skill-scan:`, `board:`, `control-room:`, detected types and fields) have no group default.
- `repos.md` and `boards.md` are registries, written when a repo is registered or a board is linked, never hand-curated in parallel with them.
- **Nothing secret goes in any file — names of secrets only.** A control room is readable by everyone the org onboards, and a name (`NPM_TOKEN`, `CLOUDFLARE_API_TOKEN`) is all a runbook needs; the value lives in the secret store the name points at.
- Preserve a confirmed optional decline as declined. Keep required unknown fields explicit and resume only those questions; show contradictions with a concrete example before writing. Agent-guided setup prepares a complete scoped diff, preserves unrelated fields and reads back the delivered files.

## The read path

Read a validated immutable control-room snapshot and retain its full source commit. A configured room whose mandatory policy is unavailable, malformed or expired blocks new tasks and external actions. The selected maximum age is an organization choice; a7200-second policy allows age7199 and refuses age7200. Failed fetches never renew validation time. An already-running job may finish reversible local work under pinned policy; pending external delivery revalidates authority. Optional knowledge may remain readable with a stale label and no privilege.

With no room configured, explicit local repository policy still works. Guided first setup may prepare missing answers while access is unavailable, but does not claim unattended readiness. Bootstrap records the verified room repository/remote/branch and local config path; local coordinates never appoint admins or enroll machines. Snapshot persistence, verified same-commit refresh and restore are the sync owner's contract.

## `people.csv`

The header line is exactly:

```
login,name,role,slack,timezone,groups
```

`login` is the GitHub username and the row's identity. A row in `groups/<g>/people.csv` with a `login` already present at org level **overrides** that row for that group; a `login` not present at org level **adds** a person to the group. `groups` on an org row is the comma-free list of the groups the person belongs to (use `;` between group names, since the file is comma-separated).

`role` is descriptive and recorded only on the operator's word. Neither a `lead` string nor a group row replacing an org row supplies admin authority. GitHub login keys are resolved against verified requester context and the current org admin map; execution-account identity stays separate.

## Boards

A board is created, field-configured and linked by the operator, never by an agent: **the operator runs these** commands, in this order — every one of them needs the `project` scope, which lives on a human token and never on an agent's:

1. `gh auth refresh -s project` — adds the scope to the operator's own `gh` login; without it every command below 403s.
2. `gh project create --owner <org> --title "<title>"` — note the number it prints; that number is the `board:` knob and the `number` column of `boards.md`.
3. `gh project field-list <n> --owner <org> --format json -q '.fields[] | select(.name=="Status") | .id'` — the id of the default Status field.
4. ``gh project field-delete --id FIELD_ID`` — use the field ID from step3; the default Status options are not the workflow's states.
5. `gh project field-create <n> --owner <org> --name Status --data-type SINGLE_SELECT --single-select-options "needs-operator,needs-plan,ready,working,for-operator,Done"` — the five state labels plus Done, in that order.
6. `gh project link <n> --owner <org> --repo <owner/repo>` — one call per repo that mirrors onto this board.

Then, in the project's Workflows UI, switch on the four built-in automations, which have no CLI: auto-add `is:issue is:open`, item closed → Done, PR merged → Done, and auto-archive after 14 days.

The mirror itself is one way. `.github/workflows/factory-board.yml` (dev-setup's `assets/factory-board.yml.template`) writes Status from the issue's single state label with the App token; nothing reads the board back, so a card dragged by hand is cosmetic until the next label change.

## Registers

`decisions.md` at every level uses the register line format defined in dev-setup's `references/conventions.md`, installed beside this file — one dated line per decision, append-only, no other metadata. This file does not restate the format; read it there.

## Administration and people visibility

The org policy object may carry `administration:{orgAdmins:string[],groupAdmins:Record<string,string[]>,groupAdminCapabilities:Record<string,GroupCapability[]>}`. At least one confirmed org admin is required when configured. Missing legacy administration remains unconfigured until reviewed migration; do not promote legacy leads. `GroupCapability` is `group.members.manage`, `group.repos.manage`, `group.defaults.manage` or `group.people.read`. Only org admins appoint/remove admins. Group admins act only inside assigned groups, on preauthorized repo registrations and permitted ordinary/delegated defaults. Membership edits do not grant GitHub access, operator status or shipping permission.

For chat requests, load the previous trusted config and verified human requester, prepare the exact target/diff, then use `authorizeAdministration` before applying configured Git review/delivery rules. A bot can execute an evidenced instruction but cannot supply the human grant. Refuse chat/URL identity claims, self-grants, cross-group targets, last-admin removal and stale authority. Dashboard remains read-only.

`resolveAdministration({orgLayer,peopleByScope,repoGroups})` reads only org assignments; `authorizeAdministration({actor,action,target,administration,policy})` returns allowed/reason. `actor` is `{login,verified:true}` from trusted GitHub context, optionally with separate execution-account evidence. Targets name the exact org/group/repo; proposed settings are `target.changes`, and admin replacement is `target.proposedAdministration`. These APIs are cooperative trusted-host checks, not a new authentication server.

`resolvePeopleReadScope({viewer,subject,requestedRepos,administration,policy,repoGroups})` returns allowedRepos/subject/refusal. Org admins read registered org repos; group admins need `group.people.read` in their assigned groups; people retain their own-data view. Filter records before totals, drill-downs or export. An empty allowedRepos array means no records. One person working in two groups does not let a group admin see the other group's records. Query filters may narrow but never expand scope. Control-room Git readers can still read committed report files; application scopes do not promise per-group storage secrecy.

## Registered machines

The org policy may carry `fleet:{schemaVersion:1,coordination,defaults,groupDefaults,groupDelegations,machines}`. Coordination names the verified private state repository node ID, canonical repository, branch, rootCommit and installation UUID. It is separate from the policy branch and source task branches. Organization admins own coordination identity and enrollment; setup preserves existing registrations and initially enrolls a machine disabled.

`FleetDefaults={pollSeconds,maxRuns,childConcurrent,checkpoints,recovery}`. Suggested selected defaults are120/1/3/task-branch/verified-transfer. Poll seconds must be an integer30–3600, maxRuns a positive safe integer, childConcurrent1–16 (also bounded by the installation's qualified child ceiling), checkpoints `off|task-branch`, recovery `original-host|verified-transfer`. Resolve org defaults → group defaults → explicit machine overrides. Polling is discovery timing; policy freshness and task duration are separate. Ordinary tasks have no cumulative elapsed-time limit.

Each machines key matches `[a-z0-9][a-z0-9-]{0,63}` and contains `{installationId,hostBindingDigest,executionLogin,group,repositories,enabled,overrides}`. Installation IDs are generated UUIDs, host bindings are digests, executionLogin is a confirmed GitHub login, and repositories are canonical registrations backed by verified GitHub node IDs. Credentials, raw host identifiers, shell commands and local paths stay outside this schema. A copied local config cannot match another host's binding or silently enroll it.

`groupDelegations` maps each group to `{fields,maxRunsMax?,childConcurrentMax?,pollSecondsMin?,pollSecondsMax?,checkpointValues?,recoveryValues?}`. Fields name permitted FleetDefaults keys; numeric limits remain inside schema bounds and enum subsets are valid/nonempty. No entry or field permission means org-admin-only. Group admins also need `group.defaults.manage`, and every edit uses the previous trusted delegation/current machine group. Changing repo/group scope, binding, enrollment, coordination or delegation is org-admin-only. Safety predicates cannot be delegated away.

`resolveMachinePolicy({policy,machineId,installationId,hostBindingDigest,executionLogin})` returns ok/machine/blocks. The effective machine includes coordination, resolved defaults, allowedRepositories, repositoryIds and policyDigest. Allowed work intersects registration, current policy/approval and verified GitHub access. A shared/enrolled machine never falls back to local-only locks on failure; no-fleet installations retain an explicit legacy mode.

Recovery `verified-transfer` still requires proof the original execution stopped, a verified checkpoint and task/scope/base/head, reconciled effects, safe shared ownership transfer and the same qualified harness/model/account/effort. A stale heartbeat is not stop proof. Task-branch checkpoints require the approved exact repo/ref/file scope and durable checked delivery intent; they grant no merge/release or arbitrary write authority. Runtime ownership/checkpoint machinery and actual service qualification are separate consumers of these settings.

## Resolver input and source contract

`resolvePolicy({org,group,repo,identity,freshness})` returns `{ok,policy,blocks}`; all three layers are Markdown strings. `identity` supplies `org`, canonical `repo`, `group`, full validated `roomSha`, optional per-layer `paths`, and confirmed `peopleByScope`, `repoGroups`, `repositoryIds`. People scopes map `org`/group IDs to `{login,groups:[]}` rows; repoGroups maps canonical repository to group; repositoryIds maps it to verified GitHub node ID. These are verified registry inputs, not fields a chat requester supplies.

`freshness` supplies configured/validatedAt/now/maxAgeSeconds. Effective schema2 includes resolved values, per-key scope/path/revision diagnostics, administration, fleet and policyDigest. Revisions are full Git SHAs for validated room sources or SHA256 of exact local text. The digest sorts resolved values/sources and authority/registry data and excludes observation time. Consumers must inspect `ok` or refusal before any effect: an effective locked value is useful diagnostic data even when an attempted override is denied.

Validated snapshot readers consume `factory.json` at `controlRooms[org].snapshots[canonicalCodeRepo]`. Each value keeps `{schemaVersion:2,org,group,repository,origin,sourceCommit,policyDigest,validatedAt,contentPath}`; repository is the control room, while the map key binds the code repo. Its digest is the full resolved policy for that repo/profile/group, with canonical relative paths. The reader checks exact origin/HEAD and clean content, reads regular blobs from the recorded Git commit, then recomputes the digest. Changed local policy needs renewed validation. The optional `repository-id` column in repos.md supplies confirmed GitHub node IDs required by fleet registrations. The snapshot owner verifies those IDs during publication; this parser does not turn authored strings into verified network identity.

## Local settings, refresh and recovery

`factory.json` is the single machine-local store. Its supported wire shape is `{schemaVersion:2,revision,controlRooms:{[org]:...},...extensions}`. The transaction API's `orgs` is a view of `controlRooms`, never a second file/map; an existing extension named `orgs` stays inert. Persist confirmed setup answers, optional declines, bootstrap and verified local checkout registrations through `updateSettings(root,mutate)` before attempting sync. `root` contains `factory.json`; services using a different absolute config path call `updateSettingsAtPath(path,mutate)` and pass that same path to readers and refresh. Neither API enrolls the machine or approves Git delivery.

Every mutation rereads under the canonical path's exclusive guard and increments revision. Schema1 converts only after successful mutation/validation, retaining its original bytes in `factory.json.schema1.bak`. Unknown versions, unreadable files and unsafe symlink paths refuse unchanged. An interrupted `.guard` directory is never stolen because its owner appears old; stop participating writers, verify their termination and inspect the owner record before offline recovery. A text editor bypassing this transaction cannot receive its concurrent lost-update guarantee.

`vegafactory sync --dry-run --json` describes refresh/migration without fetching or writing. A real sync verifies the configured connection, fetches a managed candidate (30 seconds per fetch, at most two attempts, 90 seconds for candidate work), validates every configured code-repository profile through the canonical resolver, then publishes all bindings together. Same-commit refresh renews `validatedAt` only after successful fetch and validation. A failed attempt retains last-good source identity and settings. Unconfigured first setup must complete a confirmed code-repository profile before it can publish authority; answers already persisted remain resumable.

Policy reader content lives under the settings directory's `policy-snapshots/<org>/snapshot-*`. The separate `controlRooms[org].path` is the telemetry writer checkout, initialized once from validated content; existing operator edits and unpushed commits are never reset or repointed. Do not write telemetry into `contentPath`. Canonical GitHub owner/name and repository node ID must match the verified connection; a rename needs explicit verified reconciliation. Enrolled machines additionally match the current host binding, installation, account, group and registry scope. Host bindings hash platform, non-root account UID and the platform machine identifier; copying factory.json to another host is not enrollment.

`status --json` exposes each repo's validation state, full source SHA, policy digest, timestamp, age and refusal. Machine configuration displayed by status is diagnostic, not verified execution-account authority. Dashboard policy reads the same manifest and local profiles; legacy fetch time or directory mtime cannot manufacture freshness. Optional old knowledge carries source/date and a warning; it grants no authority. At the selected two-hour bound, age7199 seconds is fresh and age7200 is stale. Dispatcher polling remains distinct from this bound; running reversible work retains its pinned rules and external actions revalidate.

The source APIs `inspectSnapshots({target,now})` and `restoreSnapshot({target,index,now,apply?})` verify supported schema, exact source/content identity and every backup's per-repo digest. Restore defaults to dry-run. Explicit `apply:true` selects inactive recovery content with its original timestamp and empties the authoritative snapshot map. A successful real sync is required before authority resumes, including when the selected backup was recently validated. Two prior valid pointer sets are retained; immutable directories are not automatically removed, so older active-run pins remain available. Failed candidate directories may remain for inspection.

Until a packaged recovery entrypoint is approved and integrated, these are source-only recovery APIs, not installed CLI subcommands. From the source checkout, inspect the exact configured path without writes:

```sh
VF_SETTINGS_PATH=/absolute/path/factory.json VF_REPO_PATH=/absolute/path/code-repo bun --eval '
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {readSettingsFile} from "./packages/cli/src/control-room.ts";
import {resolveTarget,inspectSnapshots} from "./packages/cli/src/sync.ts";
const settingsPath=process.env.VF_SETTINGS_PATH, repoPath=process.env.VF_REPO_PATH;
const config=await readSettingsFile(settingsPath);
const devMdText=await readFile(join(repoPath,".vegastack/dev.md"),"utf8");
const target=resolveTarget({config,devMdText,home:homedir(),settingsPath,repoPath});
if(!target) throw new Error("No configured control room");
console.log(JSON.stringify(await inspectSnapshots({target,now:Date.now()}),null,2));
'
```

For a reviewed restoration, use the same resolved target and call `restoreSnapshot({target,index:0,now:Date.now()})` first. Inspect that exact result before explicitly adding `apply:true`; never alter `validatedAt` to bypass the required fresh sync. Packaged recovery availability and final behavioral/provider qualification remain open integration gates.

# Workflow conventions

The artifact spec. Skills cite this single rule source.

Ordinary explicit knobs resolve repo → group → org. Organization locks require exact org delegation for an override; group permission cannot unlock them. Repository dispatch opt-in and executable repository facts are not inherited. Decision registers concatenate; neither registers nor remembered lessons grant authority.

## Policy sources and migration

Resolve policy through dev-setup's `scripts/effective-policy.mjs`; its sources/digest/freshness and explicit refusals govern consumers. The schema, capability matrix and migration walkthrough live in the control-room reference in vegafactory-setup. Inspect original/effective/proposed values, preserve originals and obtain concrete approval for authority changes; unknown schemas are not rewritten. Configured stale/missing policy blocks new tasks and external effects, while pinned reversible work may continue. Descriptive roles, machine bootstrap and remembered lessons grant no authority. Keep requester and execution identities separate, enforce previous trusted delegation, and filter people records before aggregation. Native vendor memory and cumulative task deadlines remain excluded.

## Comment metadata markers

Workflow comments open with a marker and heading:

```markdown
<!-- vsk:v1 type=<type> rev=<n> [key=value ...] -->
## <Human title> (v<n>)
```

| type | required keys | instances |
|---|---|---|
| `approval` | `scope=<brief\|brief+plan\|plan\|consolidated\|none>` and schema-v2 JSON | one per approval event |
| `questions` | `rev` | one per ask round; earlier rounds stay as record (dev-setup's `references/ask-route.md`) |
| `plan` | `rev` | one, edited in place |
| `ledger` | `branch` | one, edited in place |
| `evidence` | `rev branch sha` | one, edited in place |
| `review` | `round sha agent=<claude\|codex> verdict=<clean\|needs-fixes>` | one per review cycle, rounds appended inside |
| `decision` | — | one per decision proposal |
| `handback` | — | one per stop event |

`rev=<n>` and `(v<n>)` start at 1 on brief, plan, questions and evidence only. Approval, decision, handback and ledger have neither. Locate artifacts by marker, never heading; no legacy fallback.

## Operator identity

Human references use the operator’s GitHub username in parentheses, without titles:

- Approval: `Approved by (<username>) on DD-MM-YYYY: "<their words>"`
- Register line: `- DD-MM-YYYY (<username>) — <decision>`

Check the named operator against current policy. Agents may quote actual intent; authorship, labels and configured names cannot supply it. Session quotations are inspectable assertions, not cryptographic speech authentication.

## Scoped approval records

Use dev-implement’s `scripts/lib/approval.mjs` API and its embedded contract; no second parser. Refresh current policy and complete GitHub histories. `ArtifactRef={repo,issue,kind,artifactId,rev,digest}` binds brief issue-node or unique plan/protocol comment-node identity, revision and canonical SHA-256.

Approval marker scope must match one fenced JSON `ApprovalRecord={schemaVersion:2,id,operator,scope,source:{kind,ref,quote},artifacts,supersedes,revokes}`. Source kind is `session` or `github-comment`; record actual inspectable words. Scope is `brief`, `plan` or `brief+plan`: planning requires brief; implementation requires both; research execution additionally binds its protocol. Empty-artifact revocations remove exact earlier IDs. Conflicts require explicit supersedes; never newest-wins.

Preserve legacy comments. Inventory refusal reasons/current digests without writes; request scoped reconfirmation. A separately authorized `scope=none` correction has `{schemaVersion:2,kind:"correction",scope:"none",operator,source,targets:[{commentId,bodySha256}],supersedes:[],revokes:[]}`. It neutralizes exact malformed targets only and grants no scope. Changed/missing/self-referential targets refuse.

Consolidated parent events bind actual intent to frozen manifest bytes, canonical artifacts and exact task/action subsets. Locators are inline UTF-8 or immutable repository/commit/path plus blob hash; local paths are insufficient. Pin approval comment ID/body hash separately. Preparation requires exact accepted task-contract receipts; research requires protocol-derived limits, complete shared attempts and a clean-candidate/atomic reservation adapter. Missing adapters refuse. Failed/resumed/child starts count without refunds. Checkpoint export, private/live operations and shipping retain their separate gates; an intent result is not an effect grant.

Canonicalization normalizes CRLF only, except structural plan checkboxes and one validated JSON `{tasks:[{id,evidenceUrls}]}` block between `<!-- vsk:progress:start -->` / `<!-- vsk:progress:end -->`. IDs must exist; URLs are HTTP(S). Unknown fields/duplicates refuse. Stable task IDs/order, interfaces, actions, revisions and every other byte remain scope. Brief/protocol bodies have no mutable fields; fenced examples remain immutable and supply no authority.

## Revision markers

Scope edits increment marker/heading revisions and append `Revisions: v2 — DD-MM-YYYY: <change>, per (<username>) correction`; preserve earlier lines and obtain fresh approval. Validated progress changes need neither.

## Scope classes

Set and explain the scope label at intake; the operator may override:

- **`research`** — a question to answer; throwaway code allowed, never merged. No branch/PR/changelog; findings + recommendation are the evidence comment.
- **`quick-build`** — existing flow: draft brief+plan together, approve both, then `ready`.
- **`full-plan`** — new ground: approve brief, `needs-plan`, separate grounded planning session, `needs-operator`, approve plan, `ready`. Split multiple deliverables into independently classified epic children.

The scope ratchet lives in `dev-plan`.

## Labels

Exactly one state; every flip sets its assignee (colors: dev-setup):

| label | meaning | assignee |
|---|---|---|
| `needs-operator` | a question, a brief or plan to approve, a proposal | the operator |
| `needs-plan` | brief approved; awaiting the planning stage (full-plan only) | the operator |
| `ready` | approved — an agent may start | nobody |
| `working` | claimed; the ledger shows live progress | whoever started the run |
| `for-operator` | done — evidence posted, awaiting operator review | the operator |

Modifiers (may coexist with the state label): `risky` · scope `research` / `quick-build` / `full-plan` · `epic` (map parents, absent a native Epic type). Boards mirror state labels one way.

## Titles, types, hierarchy

- **Title prefixes** on issues, branches, and PRs identically: dev.md's `branch:` type list plus `research:`. PR title = issue title.
- **Native issue types and fields** where the org defines them: Feature (feat) · Bug (fix) · Task (docs/chore/refactor/research) · Epic for parents (else the label); intake sets Priority and Effort. Scope classes stay labels.
- **Hierarchy:** epic parent = map only (Destination · Decisions so far · Not clear yet · Out of scope), children as native sub-issues; issues = the unit of work (brief, approvals, branch, PR, evidence); tasks = checkboxes **in the plan comment only**. Blockers use dependencies; phases milestones. Only issues, never epics, get `ready`.

## The ledger

The implement session edits one ledger comment:

```markdown
<!-- vsk:v1 type=ledger branch=<branch> -->
## Ledger — <branch>
- Task <N>: complete (commits <base7>..<head7>[, review clean | K parked])
- Task <N>: fix round <R>/3 (<X> addressed, <Y> open — <one-liners>; commits <a>..<b>)
- Ruling: <what> — <why> — cost if wrong: <cost>
- Task <N>: parked — <finding> — Ruling: <why the code stands>
- Deferred minor: <one-liner>
```


**Resume protocol:** a fresh, compacted, or handed-over session reads, in order: brief → plan comment → ledger → `git log` — nothing else.

## `.vegastack/` workspaces

Drafts/reports live in `.vegastack/.tmp/<issue-number>-<title-slug>/` (before issue creation: `intake-<slug>`), with a self-ignoring `.gitignore` containing `*`. Branch checkouts live in root-ignored `.vegastack/.worktrees/<issue-number>-<title-slug>/`; main stays on its default branch. Keep both outside `.git/`. Subagents save full reports and return short status. `<path-to-this-skill>` means the directory containing SKILL.md.

## Verification gate

Prove claims with fresh command output and exit codes. Report failures and skipped steps honestly. Delegate only substantial independent parallel work, never verification of your own; keep spawn counts low. Guards block machine-verifiable failures (exit 2); heuristics warn. No AI inference inside guards; unverifiable state fails closed.

## Plain-language collaboration

Announce starting, meaningful findings/direction changes, and a self-contained outcome with paths and remaining checks. Prefer readable literal language over arrow chains or invented labels. Use Mermaid/ASCII where useful. Challenge vague or contradictory answers with concrete options; never silently guess.

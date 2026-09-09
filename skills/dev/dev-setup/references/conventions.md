# Workflow conventions

Artifact authority.

Defaults resolve repo, group, then org; locks require explicit org delegation. Repository dispatch/commands never inherit; registers concatenate. Policy/migration uses dev-setup's `scripts/effective-policy.mjs` and vegafactory-setup's control-room reference.

## Comment metadata markers

Comments open:

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

`rev=<n>` and `(v<n>)` start at 1 only on brief, plan, questions and evidence; other types have neither. Locate by marker, never heading/legacy fallback.

## Operator identity

Use parenthesized GitHub usernames:

- Approval: `Approved by (<username>) on DD-MM-YYYY: "<their words>"`
- Register line: `- DD-MM-YYYY (<username>) — <decision>`

Approval.mjs’s publisher/relay contract lets current-policy provider-envelope publishers attest listed operators’ session words. Other recorders may only relay independently read identical operator-published scoped grants within complete authority history, without lifecycle mutations. Relays inherit source authority/lifecycle; account attestation cannot authenticate off-platform speech.

## Scoped approval records

Use only dev-implement’s `scripts/lib/approval.mjs` and follow its contract. Refresh current policy and complete GitHub histories. `ArtifactRef={repo,issue,kind,artifactId,rev,digest}` binds brief issue-node or unique plan/protocol comment-node identity, revision and canonical SHA-256.

Post exactly one approval comment: matching scope marker, then one fenced JSON `ApprovalRecord={schemaVersion:2,id,operator,scope,source:{kind,ref,quote},artifacts,supersedes,revokes}`. Exclude outer Markdown fences, future alternatives and unresolved source locators; validate the whole body with approval.mjs's `parseApproval`. Source kind is `session` or `github-comment`, with inspectable words. Reuse valid current grants/relays; avoid counterfactual plan-only or redundant approvals. Scope is `brief`, `plan` or `brief+plan`; planning requires brief, implementation both, research execution also its protocol. Empty-artifact revocations remove exact earlier IDs. Conflicts explicitly supersede; newest never wins.

Preserve legacy comments. Without writes, inventory refusals/current digests and request reconfirmation. For duplicate canonical plans preserve both identities/bodies and request record-preserving reconciliation; never delete to clear ambiguity. Follow approval.mjs’s exact correction schema, operator-publisher and target checks. Only malformed or demonstrably invalid-source targets qualify, never valid authority or unavailable/inconsistent facts. Resolve source facts first; corrections grant no scope.

Consolidated parent events bind frozen manifests, canonical artifacts and exact task/action subsets. Use inline UTF-8 or immutable repository/commit/path plus blob hash, never local paths. Canonical `approvalBindings` authorize; requested `recordBinding` only audits. Follow approval.mjs’s preparation/research/recovery provenance, receipts, adapters, counted attempts and fresh admission; retain immutable history and unverified legacy records. Keep checkpoint/private/live/shipping gates separate.

Canonicalization normalizes CRLF; its only exceptions are structural plan checkboxes and one validated JSON `{tasks:[{id,evidenceUrls}]}` block between `<!-- vsk:progress:start -->` / `<!-- vsk:progress:end -->`. IDs must exist; URLs are HTTP(S); unknown fields/duplicates refuse. Stable task IDs/order, interfaces, actions, revisions and all other bytes remain scope. Brief/protocol bodies have no mutable fields; fenced examples stay immutable and grant no authority.

## Revision markers

Scope edits increment marker/heading revisions and append `Revisions: v2 — DD-MM-YYYY: <change>, per (<username>) correction`; preserve earlier lines and obtain fresh approval. Validated progress changes need neither.

## Scope classes

Intake explains scope; operator overrides:

- **`research`** — inquiry; throwaway code allowed, never merged. No branch/PR/changelog; evidence comment contains findings and recommendation.
- **`quick-build`** — existing flow: draft brief+plan together, approve both, then `ready`.
- **`full-plan`** — new ground: approve brief, `needs-plan`, separate grounded planning session, `needs-operator`, approve plan, `ready`. Split multiple deliverables into independently classified epic children.

Scope ratchet: `dev-plan`.

## Labels

One state; flips set assignees (colors: dev-setup):

| label | meaning | assignee |
|---|---|---|
| `needs-operator` | question, brief or plan approval, proposal | the operator |
| `needs-plan` | brief approved; awaiting planning (full-plan only) | the operator |
| `ready` | approved — an agent may start | nobody |
| `working` | claimed; ledger shows live progress | the runner |
| `for-operator` | done — evidence posted, awaiting operator review | the operator |

Modifiers coexist with state: `risky` · scope `research` / `quick-build` / `full-plan` · `epic` (map parents without a native Epic type). Boards mirror states one-way.

## Titles, types, hierarchy

- **Title prefixes:** issues, branches and PRs use dev.md's `branch:` types plus `research:`; PR title = issue title.
- **Native issue types/fields:** Feature (feat) · Bug (fix) · Task (docs/chore/refactor/research) · Epic for parents (else label); intake sets Priority/Effort. Scope classes stay labels.
- **Hierarchy:** epic parent = map only (Destination · Decisions so far · Not clear yet · Out of scope), with native child sub-issues. Issues are work units (brief, approvals, branch, PR, evidence); tasks are checkboxes **only in the plan comment**. Blockers use dependencies; phases use milestones. Only non-epic issues get `ready`.

## The ledger

One implementation ledger:

```markdown
<!-- vsk:v1 type=ledger branch=<branch> -->
## Ledger — <branch>
- <issue>-T<N>: complete (commits <base7>..<head7>[, review clean | K parked])
- <issue>-T<N>: fix round <R>/3 (<X> addressed, <Y> open — <one-liners>; commits <a>..<b>)
- Ruling: <what> — <why> — cost if wrong: <cost>
- <issue>-T<N>: parked — <finding> — Ruling: <why the code stands>
- Deferred minor: <one-liner>
```


**Resume protocol:** brief → plan comment → ledger → `git log`; then reconcile task IDs, canonical approval history, edited authority, source/evidence, ownership and delivery effects. Preserve completed work/provenance; stale heartbeat is not stop proof. Preparation never implies issue completion. Dev-implement's ledger reference owns recovery detail.

## `.vegastack/` workspaces

Drafts/reports: `.vegastack/.tmp/<issue-number>-<title-slug>/` (pre-issue: `intake-<slug>`), self-ignored by a `.gitignore` containing `*`. Branch checkouts: root-ignored `.vegastack/.worktrees/<issue-number>-<title-slug>/`; main stays on its default branch. Keep both outside `.git/`. Subagents save full reports and return short status. `<path-to-this-skill>` means SKILL.md’s directory.

## Verification gate

Prove claims with fresh command output and exit codes; report failures and skips. Delegate only substantial independent parallel work, never your own verification; keep spawn counts low. Guards block machine-verifiable failures (exit 2); heuristics warn. Guards contain no AI inference; unverifiable state fails closed.

## Review bindings

One fenced JSON each: `{"reviewBinding":{sha,baseSha,scopeDigest,verdict,findings:[{id,status}]}}` in review; `{"adjudication":{sha,reviewCommentId,operator,source:{kind,ref,quote},findings:[{id,disposition,reason}]}}` in evidence. Use full commit IDs and canonical-plan scopeDigest; status=open/resolved; disposition=accept-risk. Every open finding requires same-review operator acceptance. dev-ship’s README defines source checks. No prose exceptions.

Communicate starts/findings/direction plainly; self-contained outcomes include paths and remaining checks. Avoid invented labels/arrows; visualize usefully. Challenge ambiguity with options; never guess silently.

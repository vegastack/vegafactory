# Runbook execution

How dev-ship runs a dev.md `## Ship` section and the ship situations the gates themselves don't spell out.

## Line prefixes

- `auto:` — do it, report the outcome.
- `ask:` — stop and wait for the operator's word for that step; the word that opened the gate does not cover an `ask:` line.
- `guard:` — a deterministic check. Run its command locally at this position in the runbook order; the CI copy of the same guard is the backstop and stays authoritative for anything that publishes. A failing guard stops the sequence exactly like a failing `auto:` step.

A failing step stops the runbook at that step: report what failed and what remains unrun, hand the failure to the operator (or to dev-implement's corrections loop when it's code), and never skip ahead. A gotcha — a step that surprised you or an instruction the operator had to repeat — is one proposed line folded into the runbook; if the gotcha is directional rather than operational, it's a decision-register candidate instead (on the user's yes, per dev.md `## Decisions`).

## Release batching (`release: on-request`)

"Release" covers everything merged since the last release. Enumerate it: `git log <last-tag>..HEAD --oneline` (no tags yet → everything since the first commit). Before running the release steps, check completeness — every behavior-changing merge in that range has its changelog entry per the `changelog:` knob. A missing entry is corrections work on a fresh branch, not a reason to hand-write the release record.

## Direct-to-main (`gates: 1`)

The ship word authorizes: merge the task branch onto the default branch locally per the `merge:` knob, push, done — no PR object. Everything else is unchanged: the issue must be `for-operator` with its evidence comment, guards run, the changelog entry must exist. Closing the issue: with `merge: squash`, put `Closes #<n>` in the squash commit message; with any other merge style there is no new commit to carry it — after pushing, close explicitly with `gh issue close <n> --comment "merged to <default> as <sha>"`. Either way, confirm the issue actually closed. Branch protection that blocks direct pushes breaks this mode — dev-setup checks at setup time; if it bites later, tell the operator rather than working around it.

## Decisions under compressed gates

With `gates: 2` or `1`, the ship word arrives before decisions could be named. Pending `Decision:` lines still get their own naming: acknowledge the word, state "merging will record: …", and act on the operator's confirmation — a decision is never covered by a word that didn't name it. This costs one extra exchange only when decisions are pending. A PR closed without merging hands its pending `Decision:` lines back to the operator (they may stand independently of the implementation's fate) — they are never silently dropped.

## Bot PRs (Renovate, Dependabot, …)

A bot PR has no issue, no brief, no evidence comment — and merging it is still shipping. Green checks qualify it; only the operator's explicit word merges it, per PR or per an explicitly named batch ("merge this Renovate batch"). No standing approval exists: a knob, a schedule, or past practice never merges a bot PR. Red-flag updates (majors, security advisories) get named to the operator before their merge word is acted on.

## Rollback and hotfix

- Rollback is never a force-push or history rewrite. Follow the Ship section's rollback line — the shape is always roll-forward: revert or fix on the default branch through the normal flow, release/deploy the good state as a new version.
- A hotfix is a normal issue at higher priority: brief (short is fine), approval, implement, evidence, ship. Urgency compresses the words, never removes them.

## Guard failure at ship time

A local `guard:` failure (missing changelog entry, tag/version mismatch) means the branch or release prep is incomplete: route it to dev-implement's corrections loop, get the evidence comment updated, then resume at the failed step. Never edit release artifacts inline just to get past a guard. `ship-gate.mjs` speaks the same language: exit 0 pass · 1 pass-with-warnings (read them twice, they never block) · 2 blocked with its reasons printed — a 2 routes to corrections exactly like a failing `guard:` line.

## Worktrees at ship time

One feature, one worktree — the full scenario matrix lives in `dev-implement`'s `references/worktrees.md`; what ship owns is the end of it.

- **The gate runs where the branch is.** `ship-gate.mjs` reads `git worktree list --porcelain` and runs its git calls, its dev.md read and the fresh check command in the worktree holding the branch. `--worktree <path>` overrides. A branch no worktree holds and no matching checkout still blocks — that is the fact the old checkout-mismatch block was protecting, and it survives.
- **One PR per feature.** An epic’s children integrate into the **parent branch** under the final approval that pins their revisions, local integration scopes and preparation subsets; routine authorized integration needs no second approval. Otherwise obtain the scoped integration word. No child PR; delete nothing. Fully accepted code children may close as implemented in the feature branch. Prepared live children can join without closing; pending operations stay explicit. The final assembled parent gets one PR to the default branch after whole-parent acceptance.
- **After the merge, the directory goes and nothing else.** `worktree.mjs remove --issue <n> --write` fetches the default branch, then removes the checkout when it is clean, pushed, merged and unlocked — merged by ancestry or, after a squash or rebase merge, by content; it fails closed and reports which of those did not hold. The local branch and the remote branch are separate operator words, on the always-ask list.
- **A parent's worktree survives its children.** It is removed only when the parent's own PR merges. Ordinary removal refuses a serial child branch occupying that parent directory, even with `--force`. Independent-child integration consumes the CLI's exact run/source/parent receipts; branch existence, process exit zero and a source backup are not accepted delivery.
- **Parked worktrees are pruned, not swept.** `worktree.mjs prune --older-than <window> --write` pushes an unpushed candidate first, removes only `parked` worktrees past `worktree-retention:` (the window is what lifts the not-merged rule there), and keeps every branch. `--force` on `remove` and branch deletion always take the operator's word.

## Final parent candidate and transformations

The final plan approval covers its named child revisions, local scopes and preparation subsets. Material scope changes and unresolved findings return to the operator. Tests and independent review for risky changes cannot be disabled by project knobs. After the #158/#159 qualification equivalents, review the entire assembled candidate, including #155–#157 preparation. Child reviews prove only their recorded source/parent-base pair. A source-first checkpoint never satisfies final acceptance.

Record final evidence in the parent issue comment: full candidate SHA/base SHA, canonical approved ArtifactRefs and plan digests, check command/results/environment, #153 artifact manifest/tarball hashes, and the #144 `acceptedDeliveries` projection pinned by child source/parent integration/evidence identities and accepted task scope. Include a child acceptance versus pending-operations matrix: accepted code, partial scope, preparation and unperformed live work. Preserve partial/preparation rows; child closure, PR title and closing keywords prove no delivery. Any commit, even a documentation/evidence commit, changes identity and requires fresh checks and full-candidate review. Keep evidence in comments.

Immediately before an authorized merge, read the remote PR and compare its node/number, head, base repository/ref/SHA to that accepted evidence. A changed base or head blocks until renewed evidence. A local rebase changes identity: rerun checks, review the changed diff/base, then renew the whole-candidate review. After GitHub rebase/squash merge, fetch the exact merged commit, verify its commit range and final tree relationship to the reviewed candidate and run the project check on that clean exact merged SHA before release. Record the transformation; never call changed SHAs identical.

Only after GitHub PR readback and those Git/check proofs, append:

```ts
parentDelivery: {
  repo, parentIssue, pr, prNodeId, acceptedParentHead,
  baseRepo, baseRef, mergedAt, mergedCommit,
  transformation: null | {
    kind: "rebase" | "squash", reviewedHead, mergedHead, evidenceRef
  }
}
```

`evidenceRef` points to the exact reviewed-diff/merged-check evidence, never a title or inferred closing link. Map the complete pinned `acceptedDeliveries` scope projection to this delivery, so several children can share one PR without dropping partial or preparation scope. #148 discovers children through all-state enumeration and follows parent evidence even without a current-month execution. Nothing writes `parentDelivery` on child close or final review alone.

For deterministic readback validation, `ship-gate.mjs` exports `evaluateParentDelivery({parentDelivery,pr,expected,acceptedDeliveries,requiredDeliveries,scopeMatrix,requiredScopeMatrix,verification})`. `pr` is the actual GitHub PR REST object. `expected` pins repo/parentIssue/pr/prNodeId/acceptedParentHead/baseRepo/baseRef/baseSha from accepted parent evidence. `requiredDeliveries` is the exact #144 implemented-task projection from that same evidence, not a list reconstructed from closed issues. The separately pinned matrix has closed rows `{repo,issue,mode,taskIds,disposition,evidenceRefs}` and must retain `accepted-code`, `partial-code`, `prepared` and `unperformed-live`; only accepted-code tasks may equal the implemented projection. `verification` carries freshly resolved `reviewedHead,mergedHead,baseSha,acceptedTree,mergedTree,check:{sha,exit}`. For a normal merge supply actual `ancestorShas`; transformations additionally supply the inspected `rangeHead` and `evidenceRef`. Obtain trees with `git rev-parse <sha>^{tree}`, ancestry with `git rev-list <merged>`, inspect the complete base-to-merged range/diff and retain its evidence. Changed trees or missing exact-check evidence refuse. This helper validates supplied facts; the caller must gather them freshly, and an empty block list is not merge authority.

A release bump is a separate reviewed candidate. Even metadata-only changes rebuild different bytes and repeat packed smoke/checks. Runtime/policy changes additionally repeat affected qualification scenarios. Publication (#156) requires the source-to-artifact-to-registry evidence chain. Implemented, merged and released remain separate states; merge/publish/deploy retain their existing explicit operator gates.

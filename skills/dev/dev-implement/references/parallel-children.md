# Parallel children

A registered parent can run the exact independent groups in its current approved plan. Each group owns disjoint literal files and one child issue. Ordinary work stays sequential; overlap, ambiguous ownership or unavailable prerequisites refuse parallel admission.

## Commands

```text
plan-lint --file <approved-parent-plan> --groups --json > groups.json
vegafactory children run --parent <n> --groups groups.json --repo <o/r> --write --json
vegafactory children join --parent <n> --groups groups.json --repo <o/r> --write --json
```

Without `--write` the CLI previews. It compares the supplied group report with the canonical approved plan; a local JSON file is not approval. The command runs inside its registered parent process/session and preserves the original seven-field parent claim across retries. The standalone `children.mjs plan` remains a non-executing helper. Legacy launch/join entrypoints and the shipped compatibility workflow direct callers to the CLI and do not spawn a fallback executor. Existing user workflow copies are not overwritten and may still contain the older executor; those copies are not the supported CLI execution route.

## Execution

Both supported harness routes use the shared launch table and owned runtime. Child preparation reuses ordinary include-copy, setup and trust handling, with required setup/includes and effective managed hooks checked before spawn. Missing qualification or unsupported effective configuration remains a refusal; configuration fixtures do not qualify a real vendor. Every child retains the selected subscription account, harness, model and effort. No API fallback is used.

The approved parent limit is at most three active qualified child processes across machines, also bounded by host policy. Shared task/resource ownership is separate from process capacity: a stopped child does not become a completed issue. Unknown termination and unresolved ownership retain their reservations. Healthy approved work has no cumulative task timeout. Parent cancellation or owner loss cancels only owned child processes; restart resolves saved run IDs rather than launching duplicates.

## Acceptance and integration

The child result binds schema version, run ID, issue/repository, original base, exact head and branch, scope digest, terminal cause, machine/session/shared generation and checkpoint identity. Its acceptance command comes from the recorded parent source and actually executes at that head. A printed command, existing branch, exit zero or source backup alone is not a result. No-change needs positive acceptance too.

The CLI checks clean source, immutable commits, original base and all changed paths before each declared-order integration. It requires current explicit integration action authority and the original parent owner. A failed child keeps its source while independent verified siblings may join. Conflict or failed assembled-parent acceptance preserves prior successes and stops subsequent integration.

Before changing Git, the controller persists source-bound child acceptance and a prepared join receipt. The private run ledger records child run/generation, original source SHA, parent before/after and acceptance. Published child history is never rewritten. After a crash, exact Git ancestry and receipts are reconciled before another join or check.

Typed remote child acceptance requires the actual immutable child checkpoint. Remote accepted joins also require the resulting parent checkpoint. Unavailable source or delivery remains prepared/partial evidence; it is never relabeled completed. The recovery controller must reconstruct original approval/run/launch context before cross-host consumption. Whole-parent review and remote merge/release permission remain separate.

## Retention

Child and parent branches survive failures and interrupted joins. Cleanup needs its own operator instruction. Ordinary removal cannot delete a parent checkout while a serial child occupies it; the parent directory remains until its own PR merges. See [worktrees](worktrees.md) for preparation, integration and removal details.

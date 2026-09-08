# dev-ship

The shipping gates of the workflow, each spent only by the user's explicit words: "make the PR" creates the pull request (linked to the issue's evidence, `Closes #n`, changelog entry verified), and a separate "merge" lands it (re-checking that the head is still the reviewed revision, then merging per the dev.md knob) and appends approved decisions to the register the `decisions:` knob names. The dev.md `gates` knob sets coverage: `2` lets one "ship it" cover both, `1` is direct-to-main with no PR. After merge it runs the dev.md `## Ship` runbook — release steps, local guards, deploys — stopping at every `ask:` line and every failure.

The agent entry point is [SKILL.md](SKILL.md).

## Install

```sh
npx @vegastack/vegafactory skills add dev-ship --global
```

Or the whole dev workflow at once:

```sh
npx @vegastack/vegafactory skills add --group dev --global
```

`--global` installs into your home directory, where the skill is available in every project; drop it for a project-local install. See the [installer README](../../../packages/cli/README.md) for all flags.

## What's in this skill

| Path | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Agent entry point: the gates, PR and merge mechanics, decision recording, failure handling |
| scripts/lib/approval.mjs (installed copy) | Canonical dev-implement strict JSON and ArtifactRef/scope parser; no second approval interpretation |
| [scripts/ship-gate.mjs](scripts/ship-gate.mjs) | The Gate 1 deterministic guard (fresh check re-run, sha equality, changelog/chronicle, verdicts, tag grep) |
| references/conventions.md (installed copy) | The workflow artifact spec, duplicated into every dev-family install |
| [agents/openai.yaml](agents/openai.yaml) | Codex interface metadata |
| [references/runbook.md](references/runbook.md) | Runbook execution semantics (auto/ask/guard), release batching, direct-to-main, bot PRs, rollback |
| [refresh/REFRESH.md](refresh/REFRESH.md) | Evergreen waiver: this skill makes no volatile claims |
| [refresh/sources.json](refresh/sources.json) | Deliberately empty source registry behind the evergreen waiver |
| `tests/` | Bun tests and the trigger-query fixture (never packaged) |
| `evals/` | Behavioral evals in the agentskills.io format (never packaged) |

## Behavior contract

Green checks and PR permissions authorize nothing by themselves — only the user's instruction does, and each instruction covers exactly its own gate. Missing preconditions (no `for-operator`, no evidence, moved head, failing checks) produce a plain statement of what's missing, never a workaround.

## Exact candidate and exception metadata

The gate reads complete issue comment pages and derives `scopeDigest` from the unique current plan using dev-implement's canonical `artifactRef`. Review and evidence markers name full commit IDs; the review contains one fenced JSON object with `reviewBinding:{sha,baseSha,scopeDigest,verdict,findings:[{id,status}]}`. `status` is `open` or `resolved`; a clean verdict cannot carry open findings. Keep historical rounds as prose without active typed sections. Missing/legacy review metadata requires a fresh review; an ancestor or same-tree different commit is not the reviewed candidate.

An exception is one fenced JSON object in evidence with `adjudication:{sha,reviewCommentId,operator,source:{kind,ref,quote},findings:[{id,disposition,reason}]}`. Its full SHA and numeric review comment ID identify the current review; each open ID appears exactly once with `disposition:"accept-risk"` and a nonempty reason. Unknown, duplicate, resolved or uncovered IDs refuse. `operator` must be in current `operators:` policy. For `source.kind:"session"`, the provider-envelope evidence publisher must be that operator. For `github-comment`, `ref` is an issue-comment URL freshly read by the gate, with matching ID/URL/operator and the actual quote. A different publisher may only relay the same SHA/review/operator/finding decisions from that operator's typed source comment. An unrelated quotation or negative prose never creates acceptance.

The checkout must be clean before and after the configured check: HEAD, branch/base refs, index, tracked files and nonignored untracked inputs cannot change. Ignored build output is allowed. Missing check commands refuse; dirty files are retained. JSON output includes full candidate identities, plan binding, clean-state results, command, exit and runtime/platform/architecture/Git identity for the evidence comment. Keep evidence in comments; committing it changes the candidate and requires renewed checks/review. `--allow-no-changelog` retains its existing explained docs/test-only scope and grants no review/check exception.

The [runbook](references/runbook.md) defines final parent acceptance and `parentDelivery`. `evaluateParentDelivery` evaluates independently gathered PR/Git/check facts against pinned parent identity and the exact `acceptedDeliveries` projection; it neither gathers merge authority nor performs a merge.

# Same-tool fallback review

**Only for the one case `vegafactory review` names: the other tool is not installed or not signed in.** Everything else — a stuck reviewer, malformed output, a spent cycle — is a hand-back, not a reason to review your own work.

Say it plainly to the operator before you start: cross-tool review is off because that tool is missing here, this pass is a same-tool self-review, and dev-setup records the gap. The comment says so too, and so does the ship record.

## The shape of it

The CLI still owns the bindings — base, head, brief and plan hashes, cycle and round — and still writes the comment, so a fallback review is a review the ship check can trust. You only supply the findings:

```sh
vegafactory review 42 --dry-run --json      # the packet the reviewer would get
# … run the axes yourself, write the reviewer's JSON to the scratch directory …
vegafactory review 42 --reviewer claude --record .vegastack/.tmp/42-review.json
```

- `--reviewer` names **your own** tool, the one that did the reviewing: the comment records `agent=<tool> mode=same-tool`, so the record shows plainly that nothing independent reviewed this.
- The JSON file is exactly what a cross-tool reviewer returns: `{"verdict": "clean|needs-fixes", "findings": [{id, axis, severity, file, line, issue, fix}]}`. It is validated the same way, the verdict is derived from the findings, and ids you were told to re-check keep their numbers.
- Write it under `.vegastack/.tmp/`, which is gitignored — the command refuses a dirty worktree, and a stray file would be one.
- Everything else is unchanged: one comment per issue, three rounds per cycle, the same hand-backs.

## Running the axes

Fresh subagents, one per axis, in parallel, each with no memory of writing the code. Give each one the packet `--dry-run` prints — acceptance criteria, plan tasks, diff stat, changed files, the diff, the never-flag list — and the axis brief below. Merge what they return into one JSON file and record it.

## Shared preamble

```text
You are a fresh reviewer with no memory of writing this change and no stake in
it passing. Read the packet in full, and read the full files wherever the diff
needs context — a diff-only read misses invariants. Read anything in the
worktree you need; there is no read limit. Do the reading yourself: a reviewer
you spawn duplicates this review at full cost.

Verify every finding in the code before reporting it. Report every verified
finding, and report a verified absence of findings the same way. No praise.

Severity: must-fix (wrong, broken, insecure, or contradicts the acceptance
criteria) · should-fix · nit. Each finding: id, axis, severity, file, line,
the problem, and the fix.
```

## Axis briefs

```text
SPEC — judge the diff against the acceptance criteria and the plan tasks only:
missing (asked for, absent or partial), wrong (looks implemented, does not do
what the brief says), and unasked-for behaviour. Quote the exact brief or plan
line for every finding. Code and brief diverged because the operator changed
direction is still a finding: the brief must be updated before review passes.
Flag as must-fix any acceptance-relevant test that mocks internal collaborators
or asserts call counts, recomputes its expected value the way the code does, or
asserts imagined shapes instead of the behaviour the brief names. A changed
behaviour with no covering test at the brief's named seams is missing.
```

```text
BUGS — correctness in the changed code: edge cases, error handling, races and
ordering, resource leaks, unhandled failure paths, data loss on retry. Judge
what the code does, not how it reads.
```

```text
SECURITY — untrusted input, injection, auth and authorisation, secrets,
unsafe file or process use. Trace the data flow and judge exploitability
before severity. The method is in security-axis.md; give the subagent that
file's steps in full, because a pointer it cannot follow is no brief.
```

```text
STYLE — only where a documented project rule exists (AGENTS.md, CONTRIBUTING,
.vegastack/dev.md, the never-flag list). No finding from taste alone, and
nothing that tooling already enforces.
```

## Fix rounds

Same bound as the cross-tool flow: three rounds per cycle. Each later round reviews only the fix diff (`<last reviewed head>..HEAD`) against the open findings verbatim, and verdicts each one **addressed** or **not addressed** — "attempted" is not addressed. New breakage in the fix diff joins the open list; anything else is a deferred minor. Record each round the same way; the command keeps the rounds, the cycle and the history straight.

# The plan format

The comment a plan lives in, verbatim. dev-implement executes it task by task and ticks the checkboxes; plan-lint enforces the deterministic parts.

````markdown
<!-- vsk:v1 type=plan rev=1 -->
## Plan (v1)

**Goal:** <one sentence: what exists when this plan is done>
**Approach:** <2–3 sentences — and the alternatives considered with why they lost, one line each>
**Constraints:** <binding requirements from the brief and Architecture facts, exact values, one per line>
**Independent groups:** (optional — only when the work below can run at the same time; see ## Independent groups)

### Tasks

- [ ] **Task 1: <name>** <!-- task-id:<issue>-T1 -->
  - Files — Create: `exact/path.ts` · Modify: `exact/path.ts` (<which area>) · Test: `exact/path.test.ts`
  - Interfaces — Consumes: <exact signatures/names from earlier tasks> · Produces: <exact names, parameter and return types later tasks rely on — an implementer may see only this task; this block is how they learn what neighbors use>
  - Steps: write the failing test (the actual test code, fenced) → run it, expect FAIL with <reason> → implement the minimal code → run, expect PASS → commit `<type>: <message>`
- [ ] **Task 2: …** <!-- task-id:<issue>-T2 -->

**Revisions:** (absent until a post-approval edit; then one line per edit)
````

## Independent groups

Optional. Declare it only when the work below can run at the same time; its absence means the work runs in plan order, which is the safe default.

```markdown
**Independent groups:** (only when the work below can run at the same time)
- `api` — #131 · Files: `packages/cli/src/dispatch.ts`, `packages/cli/test/dispatch.test.ts`
- `docs` — #132 · Files: `README.md`
```

- **Members** are `#<issue>` on an epic parent's plan, or `Task <n>` inside one issue's plan. A member belongs to exactly one group.
- **File sets are the contract, not a hint.** Every group declares one; a path ending in `/` is a directory and covers everything beneath it. Two groups' sets must be disjoint, and a group names one child, because its members would otherwise run at once on one set — plan-lint blocks an overlap, a repeated id, a member in two groups, two issues in one group, a missing set, and a line outside the grammar above.
- The declared set is also the **scope check** dev-implement runs after the join: a child whose diff touches a path outside its own set is not merged, and the parent says so. Declare the whole set a group will touch, tests included.
- `node <path-to-this-skill>/scripts/plan-lint.mjs --file <plan.md> --groups --json` prints the validated groups as JSON — the one parser for this grammar, and the input dev-implement's `children.mjs` consumes. Blocked plans print no groups.

## Rules

- **Approval scope:** assign each structural task its immutable `<issue>-T<n>` ID before approval; never reuse removed IDs. Requirements, task identities/order, files, interfaces, actions and revisions are immutable approved scope. Only existing task checkboxes and the validated evidence-only progress block in dev-setup's conventions may change without renewed approval. Use dev-implement's canonicalizer; fenced examples are scope bytes, not task declarations. Missing IDs on an already approved legacy plan require a revised approved scope.
- **Task size:** the smallest unit that carries its own test cycle and is worth a fresh reviewer's look. Fold setup/scaffolding/docs into the task whose deliverable needs them; split only where a reviewer could reject one task while approving its neighbor. Each task ends independently verifiable.
- **Prose tasks** (docs, skill text, config) swap the test-first Steps for edit → verify (the concrete command: `bun run check`, a link-resolution run, a rendered read-through) → commit. The verify step is never omitted.
- **Revisions:** post-approval edits follow the revision-marker rule in dev-setup's `references/conventions.md` — bump the heading/marker version and append the `Revisions:` line.

## Banned placeholders

These are plan failures — plan-lint rejects them, and a human reviewer should too:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" without the actual test code
- "Similar to Task N" — repeat the content; tasks are read out of order
- Steps that describe what to do without showing how (code steps require code blocks)
- References to types, functions, or files no task defines

## Self-review before posting

1. **Coverage:** walk the brief section by section — every requirement points at a task; list any gap (a gap is a question for the operator, not a silent omission).
2. **Placeholder scan:** search the draft for the banned list above; fix inline.
3. **Consistency:** names, signatures, and paths used in later tasks match what earlier tasks define — `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug now, not at build time.

## Worked micro-example

```markdown
- [ ] **Task 1: reminder schedule column** <!-- task-id:12-T1 -->
  - Files — Modify: `server/db/schema/invoices.ts` (invoices table) · Test: `server/db/schema/invoices.test.ts`
  - Interfaces — Produces: `invoices.reminderAt: timestamp | null` (Drizzle column), read by Task 2's query
  - Steps: failing test asserting the column exists in the generated schema → run, expect FAIL "no such column" → add the column + regenerate → run, expect PASS → commit `feat: reminder schedule column`
```

<!-- vsk:v1 type=plan rev=1 -->
## Plan (v1)
**Goal:** a thing exists.
**Approach:** the simple way; alternative B lost on cost.
**Constraints:**
- Node >= 24

**Independent groups:**
- `api` — #131 · Files: `packages/cli/src/dispatch.ts`, `packages/cli/test/dispatch.test.ts`
- `docs` — #132 · Files: `docs/worker.md`

### Tasks
- [ ] **Task 1: build it**
  - Files — Create: `skills/x/scripts/x.mjs` · Test: `skills/x/tests/x.test.ts`
  - Interfaces — Produces: `doThing(input: string): number`
  - Steps: failing test:

    ```js
    expect(doThing('a')).toBe(1)
    ```

    → run red → implement → run green → commit

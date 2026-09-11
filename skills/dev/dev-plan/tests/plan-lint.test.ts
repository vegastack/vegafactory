import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { bannedPlaceholders, lintPlan, parseFleetParallelDeclaration, parseIndependentGroups } from '../scripts/plan-lint.mjs'

const goodPlan = `<!-- vsk:v1 type=plan rev=1 -->
## Plan (v1)
**Goal:** a thing exists.
**Approach:** the simple way; alternative B lost on cost.
**Constraints:**
- Node >= 24

### Tasks
- [ ] **Task 1: build it**
  - Files — Create: \`skills/x/scripts/x.mjs\` · Test: \`skills/x/tests/x.test.ts\`
  - Interfaces — Produces: \`doThing(input: string): number\`
  - Steps: failing test:

    \`\`\`js
    expect(doThing('a')).toBe(1)
    \`\`\`

    → run red → implement → run green → commit
`

describe('plan-lint', () => {
  test('a complete plan passes', () => {
    expect(lintPlan(goodPlan).blocks).toEqual([])
  })
  test('blocks on missing marker', () => {
    const r = lintPlan(goodPlan.replace(/<!--[^>]*-->\n/, ''))
    expect(r.blocks.some((b) => b.includes('marker'))).toBe(true)
  })
  test('blocks every banned placeholder — one realistic phrase per pattern', () => {
    const phrases = [
      'TBD', 'TODO', 'we can implement later', 'fill in details here',
      'add appropriate error handling', 'then add validation', 'we will handle edge cases',
      'write tests for the above', 'similar to Task 2',
    ]
    expect(phrases.length).toBe(bannedPlaceholders.length)
    for (const phrase of phrases) {
      const r = lintPlan(goodPlan.replace('the simple way', phrase))
      expect(r.blocks.some((b) => b.includes('banned placeholder'))).toBe(true)
    }
  })
  test('blocks a plan with no checkbox tasks', () => {
    const r = lintPlan(goodPlan.replace('- [ ] **Task 1: build it**', '**Task 1: build it**'))
    expect(r.blocks.some((b) => b.includes('no checkbox tasks'))).toBe(true)
  })
  test('blocks tasks missing Files, Interfaces, or Steps', () => {
    for (const cut of ['Files —', 'Interfaces —', 'Steps:']) {
      const r = lintPlan(goodPlan.replace(cut, 'X —'))
      expect(r.blocks.length).toBeGreaterThan(0)
    }
  })
  test('a failing-test Steps task without a fenced block is blocked; the fenced fixture passes', () => {
    const unfenced = goodPlan.replace(/  - Steps: failing test:[\s\S]*?→ run red/, '  - Steps: write the failing test → run red')
    expect(unfenced.includes('```')).toBe(false)
    expect(lintPlan(unfenced).blocks.some((b) => b.includes('fenced'))).toBe(true)
    expect(lintPlan(goodPlan).blocks).toEqual([])
  })
  test('mid-line Task references never false-block', () => {
    const withRefs = goodPlan.replace('**Constraints:**', '**Constraints:**\n- consumes Task 1 output; see **Task 1:** interfaces above')
    expect(lintPlan(withRefs).blocks.filter((b) => b.includes('without a checkbox'))).toEqual([])
  })
  test('a Task line missing its checkbox is detected, not absorbed', () => {
    const bad = goodPlan + '\n**Task 2: sneaky no-checkbox task**\n  - Files — Modify: `x.ts`\n  - Interfaces — Produces: nothing\n  - Steps: edit → verify → commit\n'
    expect(lintPlan(bad).blocks.some((b) => b.includes('without a checkbox'))).toBe(true)
  })
  test('ticked checkboxes still count as tasks', () => {
    expect(lintPlan(goodPlan.replace('- [ ]', '- [x]')).blocks).toEqual([])
  })
})

const groupPlan = goodPlan.replace('### Tasks', `**Independent groups:**
- \`api\` — #131 · Files: \`packages/cli/src/dispatch.ts\`, \`packages/cli/test/dispatch.test.ts\`
- \`docs\` — #132 · Files: \`docs/dispatcher.md\`

### Tasks`)

describe('independent groups', () => {
  test('disjoint groups pass and parse into ids, members and files', () => {
    expect(lintPlan(groupPlan).blocks).toEqual([])
    const groups = parseIndependentGroups(groupPlan)
    expect(groups.map((g) => g.id)).toEqual(['api', 'docs'])
    expect(groups[0].members).toEqual(['#131'])
    expect(groups[0].files).toEqual(['packages/cli/src/dispatch.ts', 'packages/cli/test/dispatch.test.ts'])
    expect(groups[1].files).toEqual(['docs/dispatcher.md'])
  })
  test('a plan with no groups block passes and parses to nothing', () => {
    expect(lintPlan(goodPlan).blocks).toEqual([])
    expect(parseIndependentGroups(goodPlan)).toEqual([])
  })
  test('a group without a file set blocks', () => {
    const r = lintPlan(groupPlan.replace(' · Files: `docs/dispatcher.md`', ''))
    expect(r.blocks.some((b) => b.includes('no file set'))).toBe(true)
  })
  test('exact and directory-prefix overlaps block, naming both groups and the path', () => {
    const exact = lintPlan(groupPlan.replace('`docs/dispatcher.md`', '`packages/cli/src/dispatch.ts`'))
    expect(exact.blocks.some((b) => b.includes('overlap') && b.includes('api') && b.includes('docs'))).toBe(true)
    const prefix = lintPlan(groupPlan.replace('`docs/dispatcher.md`', '`packages/cli/`'))
    expect(prefix.blocks.some((b) => b.includes('overlap') && b.includes('packages/cli/'))).toBe(true)
  })
  test('a repeated id and a member in two groups each block', () => {
    expect(lintPlan(groupPlan.replace('- `docs` — #132', '- `api` — #132')).blocks.some((b) => b.includes('appears twice'))).toBe(true)
    expect(lintPlan(groupPlan.replace('- `docs` — #132', '- `docs` — #131')).blocks.some((b) => b.includes('#131') && b.includes('more than one'))).toBe(true)
  })
  test('a group naming two children blocks: they would run at once on one file set', () => {
    const r = lintPlan(groupPlan.replace('- `api` — #131', '- `api` — #131, #133'))
    expect(r.blocks.some((b) => b.includes('"api"') && b.includes('#131, #133') && b.includes('one child'))).toBe(true)
  })
  test('a file every child edits blocks, naming the group and the file', () => {
    for (const shared of ['bun.lock', 'packages/cli/packaging.json', '.vegastack/dev.md', 'skills/dev/dev-plan/README.md']) {
      const r = lintPlan(groupPlan.replace('`docs/dispatcher.md`', '`' + shared + '`'))
      expect(r.blocks.some((b) => b.includes(shared) && b.includes('run in sequence'))).toBe(true)
    }
  })
  test('a malformed group line is reported, never silently skipped', () => {
    const r = lintPlan(groupPlan.replace('- `docs` — #132 · Files: `docs/dispatcher.md`', '- docs: whatever'))
    expect(r.blocks.some((b) => b.includes('independent group line'))).toBe(true)
  })
})

describe('fleet parallel declaration', () => {
  const fleetPlan = goodPlan
    .replace('**Constraints:**', '**Constraints:**\n**Fleet parallel:** {"schemaVersion":1,"eligible":true,"taskIds":["1-T1"],"resources":["fixture:one"]}')
    .replace('**Task 1: build it**', '**Task 1: build it** <!-- task-id:1-T1 -->')
  const withDeclaration = (declaration: string) => fleetPlan.replace(/^\*\*Fleet parallel:\*\* .*$/m, '**Fleet parallel:** ' + declaration)

  test('projects exact selected tasks, canonical task files and bounded resources', () => {
    expect(parseFleetParallelDeclaration(fleetPlan, ['1-T1'])).toEqual({
      eligible: true,
      independent: true,
      taskIds: ['1-T1'],
      paths: ['skills/x/scripts/x.mjs', 'skills/x/tests/x.test.ts'],
      resources: ['fixture:one'],
      reason: null,
    })
  })

  test('missing or malformed declarations stay repository-exclusive', () => {
    expect(parseFleetParallelDeclaration(goodPlan, ['1-T1']).independent).toBe(false)
    expect(parseFleetParallelDeclaration(fleetPlan.replace('"eligible":true', '"eligible":false'), ['1-T1']).independent).toBe(false)
    expect(parseFleetParallelDeclaration(fleetPlan, ['1-T2']).independent).toBe(false)
  })

  test('only one declaration at the defined structural location is eligible; fenced examples grant nothing', () => {
    const line = fleetPlan.split('\n').find((value) => value.startsWith('**Fleet parallel:**'))!
    expect(parseFleetParallelDeclaration(fleetPlan + '\n' + line, ['1-T1']).independent).toBe(false)
    expect(parseFleetParallelDeclaration(fleetPlan.replace(line, '').replace('### Tasks', '### Tasks\n' + line), ['1-T1']).independent).toBe(false)
    const fencedOnly = goodPlan.replace('### Tasks', '```md\n' + line + '\n```\n### Tasks')
    expect(parseFleetParallelDeclaration(fencedOnly, ['1-T1']).independent).toBe(false)
    expect(lintPlan(fencedOnly).blocks).toEqual([])
  })

  test('closed JSON rejects unknown, duplicate, wrong-version and path-bearing fields', () => {
    for (const declaration of [
      '{"schemaVersion":1,"eligible":true,"taskIds":["1-T1"],"resources":[],"paths":["skills/x/scripts/x.mjs"]}',
      '{"schemaVersion":2,"eligible":true,"taskIds":["1-T1"],"resources":[]}',
      '{"schemaVersion":1,"eligible":true,"eligible":true,"taskIds":["1-T1"],"resources":[]}',
      '{"schemaVersion":1,"eligible":1,"taskIds":["1-T1"],"resources":[]}',
    ]) {
      const changed = withDeclaration(declaration)
      expect(parseFleetParallelDeclaration(changed, ['1-T1']).independent).toBe(false)
      expect(lintPlan(changed).blocks.some((block) => block.includes('fleet declaration'))).toBe(true)
    }
  })

  test('task and resource members are canonical, unique and capped at 64', () => {
    const replace = (taskIds: string[], resources: string[]) => withDeclaration(JSON.stringify({ schemaVersion: 1, eligible: true, taskIds, resources }))
    for (const changed of [
      replace(['1-T1', '1-T1'], []),
      replace(['task-one'], []),
      replace(Array.from({ length: 65 }, (_, i) => `1-T${i + 1}`), []),
      replace(['1-T1'], ['fixture:one', 'fixture:one']),
      replace(['1-T1'], ['Fixture']),
      replace(['1-T1'], ['x'.repeat(129)]),
      replace(['1-T1'], Array.from({ length: 65 }, (_, i) => `resource:${i}`)),
    ]) expect(parseFleetParallelDeclaration(changed, ['1-T1']).independent).toBe(false)
  })

  test('derived task paths must be nonempty, literal, normalized and non-shared', () => {
    for (const path of ['', '../escape.ts', './relative.ts', '/absolute.ts', 'C:\\source\\a.ts', 'src/*.ts', 'src//a.ts', 'README.md']) {
      const changed = fleetPlan.replace('skills/x/scripts/x.mjs', path).replace('skills/x/tests/x.test.ts', path)
      expect(parseFleetParallelDeclaration(changed, ['1-T1']).independent).toBe(false)
    }
    const twice = fleetPlan.replace('  - Interfaces —', '  - Files — Modify: `skills/x/second.ts`\n  - Interfaces —')
    expect(parseFleetParallelDeclaration(twice, ['1-T1']).independent).toBe(false)
  })

  test('a declaration above 8 KiB refuses instead of truncating', () => {
    const resources = Array.from({ length: 64 }, (_, i) => `r${i}:${'x'.repeat(123)}`)
    const changed = withDeclaration(JSON.stringify({ schemaVersion: 1, eligible: true, taskIds: ['1-T1'], resources }))
    expect(Buffer.byteLength(changed.split('**Fleet parallel:** ')[1]!.split('\n')[0]!, 'utf8')).toBeGreaterThan(8192)
    expect(parseFleetParallelDeclaration(changed, ['1-T1']).independent).toBe(false)
  })
})

describe('--groups output', () => {
  const script = join(import.meta.dir, '../scripts/plan-lint.mjs')
  const run = (fixture: string, ...flags: string[]) =>
    Bun.spawnSync(['node', script, '--file', join(import.meta.dir, 'fixtures', fixture), ...flags])

  test('a clean plan prints its groups and exits 0', () => {
    const r = run('plan-with-groups.md', '--groups', '--json')
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout.toString())
    expect(out.guard).toBe('plan-lint')
    expect(out.ok).toBe(true)
    expect(out.groups.map((g: { id: string }) => g.id)).toEqual(['api', 'docs'])
    expect(out.groups[1].files).toEqual(['docs/dispatcher.md'])
  })
  test('an overlapping plan prints no groups and exits 2', () => {
    const r = run('plan-overlapping-groups.md', '--groups', '--json')
    expect(r.exitCode).toBe(2)
    const out = JSON.parse(r.stdout.toString())
    expect(out.groups).toEqual([])
    expect(out.blocks.some((b: string) => b.includes('overlap'))).toBe(true)
  })
  test('without --groups the JSON shape is unchanged', () => {
    const out = JSON.parse(run('plan-with-groups.md', '--json').stdout.toString())
    expect(Object.keys(out).sort()).toEqual(['blocks', 'guard', 'ok', 'warns'])
  })
})

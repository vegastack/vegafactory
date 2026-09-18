import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LABEL_SPECS, STATES } from '../src/labels.ts'

const root = join(import.meta.dir, '../../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

// Every shipped place that spells out the state machine must match the CLI's labels.
test('templates list exactly the CLI state labels, in order', () => {
  for (const path of ['skills/dev/dev-setup/assets/dev-profile.md.template', 'skills/factory/vegafactory-setup/assets/control-room/group.md.template', '.vegastack/dev.md']) {
    const line = /^labels:\s*([^#\n]+)/m.exec(read(path))?.[1]?.trim().split(/\s+/) ?? []
    expect(line.slice(0, STATES.length), path).toEqual([...STATES])
  }
  expect(read('skills/factory/vegafactory-setup/assets/control-room/boards.md.template')).toContain(STATES.join(' · '))
  expect(read('skills/factory/vegafactory-setup/references/control-room.md')).toContain(`"${STATES.join(',')},Done"`)
})

// The skill-side resolver and the CLI are two spellings of one state machine; a drift between
// them shows up as a board option nobody can reach.
test('the skill-side policy resolver names the same states as the CLI', async () => {
  const { WORKFLOW_STATES, WORKFLOW_LABELS } = await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  expect(WORKFLOW_STATES).toEqual([...STATES])
  expect([...WORKFLOW_LABELS].sort()).toEqual(LABEL_SPECS.map((spec) => spec.name).sort())
})

test('dev-setup creates every workflow label with the CLI colors', () => {
  const row = read('skills/dev/dev-setup/SKILL.md').split('\n').find((line) => line.startsWith('| labels |'))!
  for (const spec of LABEL_SPECS) expect(row, spec.name).toContain(`\`${spec.name}\` ${spec.color}`)
})

test('no shipped skill description still names the old state labels', () => {
  for (const path of ['skills/dev/dev-status/SKILL.md', 'skills/dev/dev-implement/SKILL.md', 'skills/dev/dev-plan/SKILL.md', 'skills/dev/dev-intake/SKILL.md', 'skills/dev/dev-ship/SKILL.md']) {
    const description = /^description:\s*(.*)$/m.exec(read(path))?.[1] ?? ''
    expect(description, path).not.toMatch(/\b(needs-plan|needs-operator|for-operator)\b|\/ ready \/|\/ working \//)
  }
})

// Counts and inventories in the docs go stale the moment a skill is added or retired, and the
// staleness is invisible — the sentence still reads fine. Tie each to the built bundle instead.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

test('every documented group count and inventory matches the bundle', async () => {
  const { discoverSkills } = await import('../scripts/lib/skills.mjs')
  const skills = discoverSkills(join(root, 'skills')) as Map<string, { group: string | null }>
  const members = (group: string) => [...skills.values()].filter((skill) => skill.group === group).length
  const names = (group: string) => [...skills.entries()].filter(([, skill]) => skill.group === group).map(([name]) => name).sort()

  // README's selector table and its intro both spell the dev count out in words.
  const readme = read('README.md')
  expect(readme, 'README selector table').toContain(`| \`--group dev\` | The ${NUMBER_WORDS[members('dev')]} dev-workflow skills |`)
  expect(readme, 'README intro').toContain(`a ${NUMBER_WORDS[members('dev')]}-stage, issue-driven development workflow`)

  // CONTRIBUTING names the dev count and lists skills-tooling's members by name.
  const contributing = read('CONTRIBUTING.md')
  expect(contributing, 'CONTRIBUTING dev row').toContain(`a \`GROUP.md\` plus ${NUMBER_WORDS[members('dev')]} skills`)
  const toolingRow = contributing.split('\n').find((line) => line.startsWith('| `skills/skills-tooling/` |'))!
  for (const name of names('skills-tooling')) expect(toolingRow, name).toContain(`\`${name}\``)

  // The group blurbs share one sentence with README's section text.
  expect(read('skills/dev/GROUP.md')).toContain(`${NUMBER_WORDS[members('dev')]} stages`)
  expect(readme).toContain(`The issue-driven development workflow: ${NUMBER_WORDS[members('dev')]} stages`)
})

// A retirement that drops the skill but not its tombstone leaves an installed copy behind.
test('a name that left the bundle has a tombstone, and a tombstone names no live skill', async () => {
  const retired = JSON.parse(read('packages/cli/retired.json')) as Record<string, { group: string; replacedBy: string }>
  const { discoverSkills } = await import('../scripts/lib/skills.mjs')
  const skills = discoverSkills(join(root, 'skills')) as Map<string, unknown>
  for (const [name, entry] of Object.entries(retired)) {
    expect(skills.has(name), `${name} is retired but still authored`).toBe(false)
    expect(skills.has(entry.replacedBy) || entry.replacedBy === 'none', `${name} names an unknown replacement`).toBe(true)
  }
  expect(retired['dev-chronicle']?.replacedBy).toBe('dev-status')
})

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

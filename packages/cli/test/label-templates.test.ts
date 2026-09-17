import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATES } from '../src/labels.ts'

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
  for (const path of ['skills/dev/dev-setup/assets/dev-profile.md.template', 'skills/factory/vegafactory-setup/assets/control-room/group.md.template']) {
    const mapping = JSON.parse(/^workflow-labels:\s*(\{[^}]*\})/m.exec(read(path))![1]!)
    expect(Object.values(mapping), path).toEqual([...STATES])
  }
})

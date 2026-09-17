import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skillRoot = join(import.meta.dir, '..')
const reference = readFileSync(join(skillRoot, 'references/control-room.md'), 'utf8')
const boards = readFileSync(join(skillRoot, 'assets/control-room/boards.md.template'), 'utf8')

describe('vegafactory-setup — boards', () => {
  test('the reference carries every operator command, none of them agent-run', () => {
    const section = reference.split('## Boards')[1].split('\n## ')[0]
    for (const command of [
      'gh auth refresh -s project',
      'gh project create --owner',
      'gh project field-list',
      'gh project field-delete --id',
      'gh project field-create',
      'gh project link',
    ]) expect(section).toContain(command)
    expect(section).toContain('waiting-on-operator,planning,queued,in-progress,ready-to-ship,Done')
    expect(section).toContain('by the operator, never by an agent: **the operator runs these** commands')
  })

  test('boards.md.template states the one-way rule, the option order and the auto-add cap', () => {
    expect(boards).toContain('| board | number | repos | notes |')
    expect(boards).toContain('waiting-on-operator · planning · queued · in-progress · ready-to-ship · Done')
    expect(boards).toContain('cosmetic until the next label change')
    expect(boards).toContain('auto-add')
    expect(boards).toContain('recorded here')
  })

  test('the skill routes the board round through the operator', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('boards.md')
    expect(skill).toContain('references/control-room.md')
    expect(skill).toMatch(/board[^\n]*operator's yes/i)
  })
})

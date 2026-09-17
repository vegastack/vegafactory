import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Setup writes the project's .gitignore, and both .vegastack paths have to be on it: the turn
// checkpoint commits and pushes whatever is left untracked, and .vegastack/.tmp holds the issue
// cache and the lessons queue — machine-local notes that must never leave the machine.
const skillRoot = join(import.meta.dir, '..')
const repoRoot = join(import.meta.dir, '../../../..')
const IGNORED = ['.vegastack/.tmp/', '.vegastack/.worktrees/']

describe('the .gitignore lines setup writes', () => {
  const row = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    .split('\n')
    .find((line) => line.includes('project `.gitignore`'))

  test('the setup row names both paths', () => {
    expect(row).toBeDefined()
    for (const path of IGNORED) expect(row).toContain(path)
  })

  test('conventions says the same', () => {
    const conventions = readFileSync(join(skillRoot, 'references', 'conventions.md'), 'utf8')
    for (const path of IGNORED) expect(conventions).toContain(path.replace(/\/$/, '/'))
  })

  test('this repository, which runs on the workflow, ignores both itself', () => {
    const lines = readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n').map((line) => line.trim())
    for (const path of IGNORED) expect(lines).toContain(path)
  })
})

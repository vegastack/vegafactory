import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp, selectTests } from './test-affected.mjs'

const map = JSON.parse(readFileSync(join(import.meta.dir, 'test-map.json'), 'utf8'))

describe('globToRegExp', () => {
  test('* stays inside one folder, ** crosses folders', () => {
    expect(globToRegExp('skills/*/SKILL.md').test('skills/dev/SKILL.md')).toBe(true)
    expect(globToRegExp('skills/*/SKILL.md').test('skills/dev/x/SKILL.md')).toBe(false)
    expect(globToRegExp('skills/**/SKILL.md').test('skills/dev/dev-plan/SKILL.md')).toBe(true)
    expect(globToRegExp('skills/**/SKILL.md').test('skills/SKILL.md')).toBe(true)
    expect(globToRegExp('tsconfig*.json').test('tsconfig.base.json')).toBe(true)
  })
})

describe('selectTests', () => {
  test('a root manifest change runs everything', () => {
    expect(selectTests(['package.json'], map).full).toBe(true)
    expect(selectTests(['packages/cli/package.json'], map).full).toBe(true)
  })

  test('a skill file pulls in that skill\'s own tests', () => {
    const { full, tests } = selectTests(['skills/dev/dev-plan/references/plan-format.md'], map)
    expect(full).toBe(false)
    expect(tests).toContain('skills/dev/dev-plan/tests')
  })

  test('a SKILL.md change also runs the packaging tests', () => {
    const { tests } = selectTests(['skills/dev/dev-ship/SKILL.md'], map)
    expect(tests).toEqual(expect.arrayContaining(['skills/dev/dev-ship/tests', 'packages/cli/test/installer.test.ts']))
  })

  test('a spawned skill script pulls in the CLI tests that start it', () => {
    expect(selectTests(['skills/dev/dev-implement/scripts/worktree.mjs'], map).tests).toContain('packages/cli/test')
  })

  test('plain source changes add nothing: the import graph covers them', () => {
    expect(selectTests(['packages/cli/src/gh.ts'], map)).toEqual({ full: false, tests: [] })
  })
})

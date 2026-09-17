import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandTests, globToRegExp, junitFiles, selectTests } from './test-affected.mjs'

const repoRoot = join(import.meta.dir, '..')
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

  test('a deleted code file runs everything; a deleted test file does not', () => {
    expect(selectTests(['packages/cli/src/gh.ts'], map, ['packages/cli/src/gh.ts'])).toMatchObject({ full: true, reason: 'packages/cli/src/gh.ts was deleted' })
    expect(selectTests(['packages/cli/test/gh.test.ts'], map, ['packages/cli/test/gh.test.ts']).full).toBe(false)
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

  test('files read as text select the tests that read them', () => {
    expect(selectTests(['.vegastack/dev.md'], map).tests).toContain('skills/dev/dev-setup/tests')
    expect(selectTests(['.github/workflows/factory-board.yml'], map).tests).toContain('skills/dev/dev-setup/tests/factory-board.test.ts')
    expect(selectTests(['packages/cli/packaging.json'], map).tests).toContain('packages/cli/test/packaging-links.test.ts')
  })

  test('plain source changes add nothing: the import graph covers them', () => {
    expect(selectTests(['packages/cli/src/worktree.ts'], map)).toEqual({ full: false, reason: null, tests: [] })
  })

  test('every map target exists, so a moved test cannot silently drop out', () => {
    const targets = map.rules.flatMap((rule: { tests: string[] }) => rule.tests).filter((target: string) => !target.includes('{skill}'))
    for (const target of targets) expect(existsSync(join(repoRoot, target)), target).toBe(true)
  })
})

describe('de-duplication helpers', () => {
  test('expandTests lists test files under folders and keeps named files', () => {
    const base = mkdtempSync(join(tmpdir(), 'expand-'))
    mkdirSync(join(base, 'a/nested'), { recursive: true })
    mkdirSync(join(base, 'a/node_modules'), { recursive: true })
    for (const file of ['a/one.test.ts', 'a/helper.ts', 'a/nested/two.test.mjs', 'a/node_modules/x.test.ts', 'b.test.ts']) writeFileSync(join(base, file), '')
    expect(expandTests(['a', 'b.test.ts', 'missing'], base)).toEqual(['a/nested/two.test.mjs', 'a/one.test.ts', 'b.test.ts'])
  })

  test('junitFiles reads the files a bun report ran, once each', () => {
    const xml = '<testsuites><testsuite name="x.test.ts" file="x.test.ts"><testsuite name="inner" file="x.test.ts"/></testsuite><testsuite name="y" file="dir/y.test.ts"/></testsuites>'
    expect(junitFiles(xml)).toEqual(['x.test.ts', 'dir/y.test.ts'])
  })
})

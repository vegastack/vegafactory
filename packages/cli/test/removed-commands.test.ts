import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Commands the lean rebuild removed. Skills and docs must not tell an agent to run them.
const REMOVED = ['children', 'dispatch', 'service', 'runs', 'run-wrapper', 'learning', 'stats', 'status', 'launch', 'claims', 'checkpoints', 'dashboard', 'config']
const root = join(import.meta.dir, '../../..')

test('no skill, doc or hook asset calls a removed CLI command', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'skills', '*.md', '.vegastack/hooks'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((file) => file && !/(^|\/)(CHANGELOG|chronicle)\.md$/.test(file) && !file.includes('/tests/'))
  const verbs = REMOVED.join('|')
  const prose = new RegExp(`\\bvegafactory (${verbs})\\b`)
  const argv = new RegExp(`\\[\\s*'(${verbs})'\\s*,`)
  const hits = files.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    const hookAsset = file.includes('/hooks/')
    return text.split('\n').flatMap((line, index) =>
      prose.test(line) || (hookAsset && argv.test(line)) ? [`${file}:${index + 1}`] : [])
  })
  expect(hits).toEqual([])
})

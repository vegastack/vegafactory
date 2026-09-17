import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Commands the lean rebuild removed. Skills and docs must not tell an agent to run them.
const REMOVED = ['children', 'dispatch', 'service', 'runs', 'run-wrapper', 'learning', 'stats', 'status', 'launch', 'claims', 'checkpoint', 'checkpoints', 'dashboard', 'config']
// Subcommands that only the removed commands had, written bare in backticks (`stats export`).
const BARE = ['learning (checkpoint|inspect|revert|record)', 'stats (record|rollup|activity|privacy|export|cleanup)', 'children (run|join|plan|launch)', 'service (install|uninstall)']
// Scripts and assets that no longer exist.
const DELETED = ['children.mjs', 'implement-children.js', 'release-artifacts.mjs', 'release-publish.mjs', 'readme-sync', 'refresh/sources.json', 'parallel-children.md']
const root = join(import.meta.dir, '../../..')

test('no skill, doc or hook asset calls a removed CLI command', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'skills', '*.md', '.vegastack/hooks'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((file) => file && !/(^|\/)(CHANGELOG|chronicle)\.md$/.test(file) && !file.includes('/tests/'))
  const verbs = REMOVED.join('|')
  const prose = new RegExp(`\\bvegafactory (${verbs})\\b`)
  const argv = new RegExp(`\\[\\s*'(${verbs})'\\s*,`)
  const bare = new RegExp(`\`(${BARE.join('|')})\\b`)
  const deleted = new RegExp(DELETED.map((name) => name.replace(/[.\/]/g, '\\$&')).join('|'))
  const hits = files.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    const hookAsset = file.includes('/hooks/')
    return text.split('\n').flatMap((line, index) =>
      prose.test(line) || bare.test(line) || deleted.test(line) || (hookAsset && argv.test(line)) ? [`${file}:${index + 1}`] : [])
  })
  expect(hits).toEqual([])
})

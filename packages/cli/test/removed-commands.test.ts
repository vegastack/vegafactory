import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Commands the lean rebuild removed. Skills and docs must not tell an agent to run them.
const REMOVED = ['children', 'dispatch', 'service', 'runs', 'run-wrapper', 'learning', 'stats', 'status', 'launch', 'claims', 'checkpoints', 'dashboard', 'config', 'guard']
// Scripts and hook files the lean rebuild deleted; `vegafactory hook`, `ship check` and `issue claim` replace them.
const DELETED = ['ship-gate.mjs', 'ship-policy.mjs', 'ship-guard.mjs', 'reclaim.mjs', 'approval.mjs', 'session-start.mjs', 'stop-heartbeat.mjs', 'session-end.mjs', 'decision-nudge.mjs', '.vegastack/hooks/', 'guard sync']
const root = join(import.meta.dir, '../../..')

test('no skill, doc or hook wiring calls a removed CLI command or a deleted script', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'skills', '*.md', '.codex', 'packages/cli/packaging.json'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((file) => file && !/(^|\/)(CHANGELOG|chronicle|decisions)\.md$/.test(file) && !file.includes('/tests/'))
  const verbs = REMOVED.join('|')
  const prose = new RegExp(`\\bvegafactory (${verbs})\\b`)
  const hits = files.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    return text.split('\n').flatMap((line, index) =>
      prose.test(line) || DELETED.some((name) => line.includes(name)) ? [`${file}:${index + 1}`] : [])
  })
  expect(hits).toEqual([])
})

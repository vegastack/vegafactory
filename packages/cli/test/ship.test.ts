import { beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhRunner } from '../src/gh.ts'
import { ackBody, artifactHash } from '../src/issue.ts'
import { runShip } from '../src/ship.ts'
import { FakeGitHub } from './fake-github.ts'

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout.trim()

let gh: FakeGitHub
let root: string
let pr: Record<string, unknown> | null
let checks: Array<{ name: string; bucket: string }>

const runner: GhRunner = (args, input) => {
  if (args[0] === 'pr' && args[1] === 'view') return pr ? { code: 0, stdout: JSON.stringify(pr), stderr: '' } : { code: 1, stdout: '', stderr: 'no pull requests found' }
  if (args[0] === 'pr' && args[1] === 'checks') return { code: checks.every((c) => c.bucket === 'pass') ? 0 : 8, stdout: JSON.stringify(checks), stderr: '' }
  return gh.runner(args, input)
}
const run = () => {
  const lines: string[] = []
  const code = runShip(['check', '7', '--json'], { runner, cwd: root, out: (line) => lines.push(line) })
  return { code, ...JSON.parse(lines.join('\n')) as { blocks: string[]; ok: boolean } }
}

beforeEach(() => {
  gh = new FakeGitHub()
  gh.permissions.set('mk', 'admin')
  gh.addIssue({ number: 7, body: 'Export CSV', labels: ['ready-to-ship', 'small'] })
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ship-')))
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'origin.git'))
  root = join(base, 'repo')
  git(base, 'clone', '-q', join(base, 'origin.git'), root)
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\n')
  writeFileSync(join(root, '.gitignore'), '.vegastack/.tmp/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', '--auto')
  git(root, 'switch', '-q', '-c', 'feat/7-export')
  writeFileSync(join(root, 'feature.ts'), 'export {}\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'work')
  git(root, 'push', '-q', '-u', 'origin', 'feat/7-export')
  pr = { number: 12, state: 'OPEN', headRefOid: git(root, 'rev-parse', 'HEAD'), url: 'u' }
  checks = [{ name: 'check', bucket: 'pass' }]
})

test('passes with a ship it after the evidence, a pushed clean branch and a green PR', () => {
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${git(root, 'rev-parse', '--short', 'HEAD')} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })

  // Evidence for another commit does not ship this one.
  git(root, 'commit', '-q', '--allow-empty', '-m', 'more')
  git(root, 'push', '-q')
  pr = { ...pr, headRefOid: git(root, 'rev-parse', 'HEAD') }
  const stale = expect.stringMatching(/^the evidence is for [0-9a-f]+, but origin\/feat\/7-export is at/)
  expect(run().blocks).toEqual([stale])

  writeFileSync(join(root, 'dirty.txt'), 'x')
  checks = [{ name: 'check', bucket: 'fail' }, { name: 'e2e', bucket: 'pending' }]
  const blocked = run()
  expect(blocked.code).toBe(2)
  expect(blocked.blocks).toEqual(['feat/7-export has uncommitted changes', stale, 'failing checks: check', 'checks still running: e2e'])
})

test('blocks without a ship it, an unpushed commit, a PR, or with a debug tag left in', () => {
  writeFileSync(join(root, 'app.ts'), 'console.log("[DEBUG-a1f3] here")\n')
  git(root, 'add', 'app.ts')
  git(root, 'commit', '-q', '-m', 'debug')
  git(root, 'push', '-q')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'more')
  pr = null
  const result = run()
  expect(result.code).toBe(2)
  expect(result.blocks).toEqual([
    'no evidence comment yet',
    'no "ship it": no ship ack yet',
    'feat/7-export differs from origin/feat/7-export — push it',
    '1 added line(s) still carry a [DEBUG-…] tag',
    'no PR for feat/7-export',
  ])
})

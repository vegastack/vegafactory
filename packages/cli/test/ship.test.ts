import { beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhRunner } from '../src/gh.ts'
import { ackBody, artifactHash } from '../src/issue.ts'
import { renderComment, type CommentData } from '../src/review.ts'
import { runShip } from '../src/ship.ts'
import { FakeGitHub } from './fake-github.ts'

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout.trim()

let gh: FakeGitHub
let root: string
let pr: Record<string, unknown> | null
let checks: unknown
let checksOut: string | null

const runner: GhRunner = (args, input) => {
  if (args[0] === 'pr' && args[1] === 'view') return pr ? { code: 0, stdout: JSON.stringify(pr), stderr: '' } : { code: 1, stdout: '', stderr: 'no pull requests found' }
  if (args[0] === 'pr' && args[1] === 'checks') return checksOut !== null ? { code: 1, stdout: checksOut, stderr: 'no checks reported' } : { code: 0, stdout: JSON.stringify(checks), stderr: '' }
  return gh.runner(args, input)
}
// The review the ship gate requires: clean, on the pushed head, from someone with write access.
const reviewed = (over: Partial<CommentData> = {}, login = 'mk', type = 'User') => gh.addComment(7, renderComment({
  round: 1, sha: git(root, 'rev-parse', 'HEAD'), base: git(root, 'rev-parse', 'origin/main'),
  reviewer: 'codex', verdict: 'clean', findings: [], ...over,
} as CommentData, []), login, type)

const run = (...extra: string[]) => {
  const lines: string[] = []
  const code = runShip(['check', '7', '--json', ...extra], { runner, cwd: root, out: (line) => lines.push(line) })
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
  pr = { number: 12, state: 'OPEN', headRefOid: git(root, 'rev-parse', 'HEAD'), baseRefName: 'main', url: 'u' }
  checks = [{ name: 'check', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }]
  checksOut = null
})

test('passes with a ship it after the evidence, a pushed clean branch and a green PR', () => {
  reviewed()
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${git(root, 'rev-parse', '--short', 'HEAD')} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })

  // Evidence for another commit does not ship this one.
  git(root, 'commit', '-q', '--allow-empty', '-m', 'more')
  git(root, 'push', '-q')
  pr = { ...pr, headRefOid: git(root, 'rev-parse', 'HEAD') }
  const stale = expect.stringMatching(/^the evidence is for [0-9a-f]+, but origin\/feat\/7-export is at/)
  const staleReview = expect.stringMatching(/^the review is for [0-9a-f]+, but origin\/feat\/7-export is at/)
  expect(run().blocks).toEqual([stale, staleReview])

  writeFileSync(join(root, 'dirty.txt'), 'x')
  checks = [{ name: 'check', bucket: 'fail' }, { name: 'e2e', bucket: 'pending' }]
  const blocked = run()
  expect(blocked.code).toBe(2)
  expect(blocked.blocks).toEqual(['feat/7-export has uncommitted changes', stale, staleReview, 'failing checks: check', 'checks still running: e2e'])
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
    'no review comment from a reviewer with write access — run vegafactory review',
    '1 added line(s) still carry a [DEBUG-…] tag',
    'no PR for feat/7-export',
  ])
})

test('the PR must target the default branch, and only passed or skipped checks pass', () => {
  reviewed()
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${git(root, 'rev-parse', '--short', 'HEAD')} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  expect(run().ok).toBe(true)
  pr = { ...pr, baseRefName: 'release' }
  expect(run().blocks).toEqual(['PR #12 targets release, not the default branch main'])
  pr = { ...pr, baseRefName: 'main' }
  gh.defaultBranch = null
  expect(run().blocks).toEqual(['cannot read the default branch of o/r'])
  gh.defaultBranch = 'main'
  const cases: Array<[unknown, string]> = [
    [[{ name: 'lint', bucket: 'pending' }], 'checks still running: lint'],
    [[{ name: 'lint', bucket: 'cancel' }], 'failing checks: lint'],
    [[{ name: 'lint', bucket: 'weird' }], 'checks in an unknown state: lint (weird)'],
    [[{ name: 'lint' }], 'the checks of PR #12 could not be read'],
    [{ name: 'lint', bucket: 'pass' }, 'the checks of PR #12 could not be read'],
  ]
  for (const [value, block] of cases) {
    checks = value
    expect(run().blocks, block).toEqual([block])
  }
  checksOut = ''
  expect(run().blocks).toEqual(['the checks of PR #12 could not be read (no checks reported)'])
})

test('the branch, the evidence branch and the evidence sha must all name this issue and its pushed head', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  reviewed()
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'x' }))
  expect(run('--branch', 'feat/8-other').blocks.at(-1)).toBe('feat/8-other does not name #7 (<type>/7-…)')
  expect(run('--branch', 'main').blocks.at(-1)).toBe('main does not name #7 (<type>/7-…)')
  const evidence = (keys: string) => {
    gh.addComment(7, `<!-- vsk:v1 type=evidence ${keys} -->\nit works`)
    gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
    return run().blocks
  }
  expect(evidence(`branch=feat/7-other sha=${head}`)).toEqual(['the evidence is for branch feat/7-other, not feat/7-export'])
  expect(evidence(`sha=${head.slice(0, 6)}`)).toEqual([`the evidence sha=${head.slice(0, 6)} is not a commit id of at least 7 hex characters`])
  expect(evidence('sha=zzzzzzzz')).toEqual(['the evidence sha=zzzzzzzz is not a commit id of at least 7 hex characters'])
  expect(evidence(`sha=${head.slice(0, 7)}`)).toEqual([])
  expect(evidence(`branch=feat/7-export sha=${head}`)).toEqual([])
  checks = []
  expect(run().blocks).toEqual(['PR #12 reports no checks'])
})

// An ambiguous prefix makes `git rev-parse --verify` fail, which blocks the same way; a real
// 7-character collision is too slow to build in a test.
test('a short sha of an older commit does not pass', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  git(root, 'commit', '-q', '--allow-empty', '-m', 'next')
  git(root, 'push', '-q')
  pr = { ...pr, headRefOid: git(root, 'rev-parse', 'HEAD') }
  expect(run().blocks[0]).toMatch(/^the evidence is for [0-9a-f]{7}, but origin\/feat\/7-export is at/)
})

test('review is never skipped: the head that merges carries a clean review, or the operator accepts it', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  const shippable = () => {
    gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
    gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  }
  shippable()
  // No review at all.
  expect(run().blocks).toEqual(['no review comment from a reviewer with write access — run vegafactory review'])

  // A review someone without write access posted is no review.
  const forged = reviewed({}, 'stranger')
  expect(run().blocks).toEqual(['no review comment from a reviewer with write access — run vegafactory review'])
  gh.deleteComment(forged.id)

  // A review of an older commit is no review of this one.
  const stale = reviewed({ sha: 'c'.repeat(40) })
  expect(run().blocks).toEqual([`the review is for ccccccc, but origin/feat/7-export is at ${head.slice(0, 12)} — review the head that would merge`])
  gh.deleteComment(stale.id)

  // Findings still open block, and name the words that would accept them.
  const open = reviewed({ round: 3, verdict: 'needs-fixes', findings: [{ id: 'F1', axis: 'bugs', severity: 'must-fix', file: 'a.ts', line: 1, issue: 'x', fix: 'y' }] })
  expect(run().blocks).toEqual([`review round 3 is needs-fixes (F1) — fix and re-review, or the operator accepts them in their own comment: "accept review round 3 @ ${head.slice(0, 7)}"`])

  // The operator's own words, naming the round and the head, are the one way past it.
  gh.addComment(7, `I looked at F1 myself — accept review round 3 @ ${head.slice(0, 7)}`, 'mk')
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
  gh.deleteComment(open.id)

  // A clean review on this head needs no acceptance.
  reviewed()
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
})

test('an acceptance counts only from a person with write access, for that round and head', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  reviewed({ round: 2, verdict: 'needs-fixes', findings: [{ id: 'F1', axis: 'bugs', severity: 'must-fix', file: 'a.ts', line: 1, issue: 'x', fix: 'y' }] })
  const blocked = run().blocks
  expect(blocked).toHaveLength(1)

  gh.addComment(7, `accept review round 2 @ ${head.slice(0, 7)}`, 'stranger')          // no write access
  gh.addComment(7, `accept review round 1 @ ${head.slice(0, 7)}`, 'mk')                // wrong round
  gh.addComment(7, 'accept review round 2 @ deadbee', 'mk')                            // wrong head
  gh.addComment(7, `<!-- vsk:v1 type=note -->\naccept review round 2 @ ${head.slice(0, 7)}`, 'mk')      // an agent artifact, not the person's words
  gh.permissions.set('robot[bot]', 'write')
  gh.addComment(7, `accept review round 2 @ ${head.slice(0, 7)}`, 'robot[bot]', 'Bot') // a bot never accepts
  expect(run().blocks).toEqual(blocked)

  gh.addComment(7, `accept review round 2 @ ${head.slice(0, 7)}`, 'mk')
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
})

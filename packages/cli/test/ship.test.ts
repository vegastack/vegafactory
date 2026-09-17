import { beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhRunner } from '../src/gh.ts'
import { ackBody, artifactHash } from '../src/issue.ts'
import { cacheDir, syncIssue } from '../src/issue-cache.ts'
import { renderComment, type CommentData, type Finding } from '../src/review.ts'
import { runReview } from '../src/review.ts'
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
const hashes = () => {
  const dir = cacheDir(root, 'o/r', 7)
  syncIssue({ root, repo: 'o/r', number: 7, runner })
  const plan = gh.issues.get(7)!.comments.find((c) => c.body.startsWith('<!-- vsk:v1 type=plan'))
  return { brief: artifactHash(readFileSync(join(dir, 'issue.md'), 'utf8').split('\n---\n')[1] ?? ''), plan: plan ? artifactHash(plan.body) : null }
}
const reviewed = (over: Partial<CommentData> = {}, login = 'mk', type = 'User') => gh.addComment(7, renderComment({
  cycle: 1, round: 1, sha: git(root, 'rev-parse', 'HEAD'), base: git(root, 'rev-parse', 'origin/main'),
  ...hashes(), reviewer: 'codex', mode: 'cross-tool', verdict: 'clean', findings: [], ...over,
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
  expect(run().blocks).toEqual([`review round 3 is needs-fixes (F1) — fix and re-review or, now the loop is spent, the operator accepts them in a line of their own: "accept review round 3 @ ${head.slice(0, 7)}"`])

  // The operator's own words, on their own line, naming the round and the head.
  gh.addComment(7, `I looked at F1 myself and it is fine for now.
accept review round 3 @ ${head.slice(0, 7)}`, 'mk')
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
  gh.deleteComment(open.id)

  // A clean review on this head needs no acceptance.
  reviewed()
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
})

test('an acceptance is a line of its own, from a person with write access, at the capped round', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  const sha7 = head.slice(0, 7)
  const open: Finding[] = [{ id: 'F1', axis: 'bugs', severity: 'must-fix', file: 'a.ts', line: 1, issue: 'x', fix: 'y' }]
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${sha7} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))

  // Rounds 1 and 2 are still the loop's: no acceptance ends them early.
  for (const round of [1, 2]) {
    const early = reviewed({ round, verdict: 'needs-fixes', findings: open })
    gh.addComment(7, `accept review round ${round} @ ${sha7}`, 'mk')
    expect(run().blocks).toEqual([`review round ${round} is needs-fixes (F1) — fix and re-review`])
    gh.deleteComment(early.id)
  }

  reviewed({ round: 3, verdict: 'needs-fixes', findings: open })
  const blocked = run().blocks
  expect(blocked).toHaveLength(1)

  const decoys = [
    [`do not accept review round 3 @ ${sha7}`, 'mk', 'User'],                       // negated
    [`> accept review round 3 @ ${sha7}`, 'mk', 'User'],                            // quoting someone else
    [`should we accept review round 3 @ ${sha7}?`, 'mk', 'User'],                   // a question
    [`accept review round 3 @ ${sha7}`, 'stranger', 'User'],                        // no write access
    [`accept review round 2 @ ${sha7}`, 'mk', 'User'],                              // another round
    ['accept review round 3 @ deadbee', 'mk', 'User'],                              // another head
    [`<!-- vsk:v1 type=note -->\naccept review round 3 @ ${sha7}`, 'mk', 'User'],    // an agent artifact
    [`accept review round 3 @ ${sha7}`, 'robot[bot]', 'Bot'],                       // a bot
  ] as const
  gh.permissions.set('robot[bot]', 'write')
  for (const [body, login, type] of decoys) gh.addComment(7, body, login, type)
  expect(run().blocks).toEqual(blocked)

  gh.addComment(7, `I read F1 and accept the risk.\naccept review round 3 @ ${sha7}`, 'mk')
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
})

test('a review of a narrow base does not ship the whole candidate', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  writeFileSync(join(root, 'second.ts'), 'export {}\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'second')
  git(root, 'push', '-q')
  const top = git(root, 'rev-parse', 'HEAD')
  pr = { ...pr, headRefOid: top }
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=2 branch=feat/7-export sha=${top.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))

  // A clean review of the last commit only: its base is on the branch, not in origin/main.
  const narrow = reviewed({ sha: top, base: head })
  expect(run().blocks).toEqual([`the review's base ${head.slice(0, 7)} is not in origin/main, so it covered only part of what would merge — re-run the review against the default branch`])
  gh.deleteComment(narrow.id)

  reviewed({ sha: top, base: git(root, 'rev-parse', 'origin/main') })
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
})

test('two trusted reviews that disagree at the same round stop the ship and name both', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  const open: Finding[] = [{ id: 'F1', axis: 'bugs', severity: 'must-fix', file: 'a.ts', line: 1, issue: 'x', fix: 'y' }]

  // An earlier round 3 with findings open, then a later round 1 calling it clean: the higher
  // round stands, so the later comment cannot wave the findings through.
  const late = reviewed({ round: 3, verdict: 'needs-fixes', findings: open })
  reviewed({ round: 1, verdict: 'clean' })
  expect(run().blocks[0]).toContain('review round 3 is needs-fixes (F1)')
  gh.deleteComment(late.id)

  // Two at the same round that disagree are not reconciled at all.
  reviewed({ round: 1, verdict: 'needs-fixes', findings: open })
  const blocks = run().blocks
  expect(blocks[0]).toContain('two review comments disagree at cycle 1 round 1')
  expect(blocks[0]).toContain('needs-fixes')
  expect(blocks[0]).toContain('clean')
  expect(blocks).toHaveLength(1)
})

test('the ship gate needs the default branch it can read, and its remote ref', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  reviewed()

  // The repository's default branch is trunk, and this checkout has no origin/trunk: the review's
  // base cannot be proved to be in it, so the gate blocks instead of passing on a local guess.
  spawnSync('git', ['remote', 'set-head', 'origin', '--delete'], { cwd: root })
  gh.defaultBranch = 'trunk'
  const blocks = run().blocks
  expect(blocks).toContain('origin/trunk is not in this checkout — fetch it, so the review\'s base can be checked against it')
  expect(run().ok).toBe(false)

  // A review whose base is not an object in this checkout blocks too.
  gh.defaultBranch = 'main'
  spawnSync('git', ['remote', 'set-head', 'origin', 'main'], { cwd: root })
  gh.deleteComment(gh.issues.get(7)!.comments.filter((c) => c.body.startsWith('<!-- vsk:v1 type=review'))[0]!.id)
  reviewed({ base: 'd'.repeat(40) })
  expect(run().blocks).toEqual([`the review's base ddddddd is not a commit in this checkout — fetch the branch it was reviewed from`])
})

test('a review of an older brief or plan does not ship', () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  const stale = reviewed()
  expect(run()).toMatchObject({ ok: true, blocks: [] })

  // The brief moves on without a new commit: the reviewer never saw this text.
  gh.editBody(7, 'Export CSV and JSON')
  // (the ack binds to the brief too, so it is void as well — the review block is the one under test)
  expect(run().blocks).toContain('the brief changed after review round 1 — re-run the review')
  gh.deleteComment(stale.id)
  const fresh = reviewed()
  // The evidence ack binds to the brief too, so record the operator's word against the new text.
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV and JSON'), plan: null, source: 'session', quote: 'ship it' }))
  expect(run()).toMatchObject({ ok: true, blocks: [] })

  // A plan comment appearing after the review is a plan the reviewer never read.
  const plan = gh.addComment(7, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan (v1)\n\n### Tasks\n\n- [ ] **Task 1** <!-- task-id:7-T1 -->')
  expect(run().blocks).toContain('the plan changed after review round 1 — re-run the review')
  gh.deleteComment(fresh.id)
  reviewed()
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV and JSON'), plan: artifactHash(plan.body), source: 'session', quote: 'ship it' }))
  expect(run()).toMatchObject({ ok: true, blocks: [] })

  // Ticking a plan checkbox changes neither the plan's hash nor the review's standing.
  gh.editComment(plan.id, plan.body.replace('- [ ]', '- [x]'))
  expect(run()).toMatchObject({ ok: true, blocks: [] })
})

test('a same-tool fallback review, recorded through the CLI, is trusted and ships', async () => {
  const head = git(root, 'rev-parse', 'HEAD')
  gh.addComment(7, `<!-- vsk:v1 type=evidence rev=1 branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
  gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
  expect(run().blocks).toEqual(['no review comment from a reviewer with write access — run vegafactory review'])

  // The other tool is missing, so this session reviewed the diff itself and hands the JSON over.
  mkdirSync(join(root, '.vegastack/.tmp'), { recursive: true })
  writeFileSync(join(root, '.vegastack/.tmp/fallback.json'), JSON.stringify({ verdict: 'clean', findings: [] }))
  const code = await runReview(['7', '--reviewer', 'claude', '--record', '.vegastack/.tmp/fallback.json'], {
    runner, cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, out: () => {},
  })
  expect(code).toBe(0)
  const comment = gh.issues.get(7)!.comments.find((c) => c.body.startsWith('<!-- vsk:v1 type=review'))!
  expect(comment.body).toContain('mode=same-tool')
  expect(run()).toMatchObject({ code: 0, ok: true, blocks: [] })
})

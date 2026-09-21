import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheDir, commentType, readState, syncIssue, takeOver, withLock } from '../src/issue-cache.ts'
import { defaultRunner } from '../src/gh.ts'
import { ackBody, artifactHash, runIssue } from '../src/issue.ts'
import { stageLogPath } from '../src/stages.ts'
import { FakeGitHub } from './fake-github.ts'

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'issue-cache-')))
  spawnSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\n')
  return root
}

let gh: FakeGitHub
let root: string
const run = (...argv: string[]) => {
  const lines: string[] = []
  const code = runIssue(argv, { runner: gh.runner, cwd: root, out: (line) => lines.push(line) })
  return { code, text: lines.join('\n'), json: () => JSON.parse(lines.join('\n')) }
}
const sync = (number: number, since = 0) => syncIssue({ root, repo: 'o/r', number, since, runner: gh.runner })

beforeEach(() => {
  gh = new FakeGitHub()
  root = repo()
})

describe('sync', () => {
  test('a first sync writes the issue and each comment as typed files', () => {
    gh.addIssue({ number: 7, labels: ['queued', 'small'], subIssues: [8], blockedBy: [{ number: 3, state: 'open' }, { number: 4, state: 'closed' }] })
    gh.addComment(7, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan')
    gh.addComment(7, 'looks good')
    const result = sync(7)
    const dir = cacheDir(root, 'o/r', 7)
    expect(result.changes.map((c) => c.file)).toEqual(['issue.md', expect.stringMatching(/-plan-1000\.md$/), expect.stringMatching(/-human-1001\.md$/)])
    expect(readFileSync(join(dir, 'issue.md'), 'utf8')).toContain('Brief body')
    const state = readState(dir)!
    expect(state.issue!.subIssues).toEqual([8])
    expect(state.issue!.blockedBy).toEqual([3])
    expect(readdirSync(join(dir, 'comments'))).toHaveLength(2)
  })

  test('an unchanged issue costs two conditional requests and reports nothing', () => {
    gh.addIssue({ number: 7 })
    const first = sync(7)
    gh.calls = []
    const second = sync(7, first.cursor)
    expect(second.changes).toEqual([])
    expect(second.requests).toBe(2)
    expect(gh.calls).toHaveLength(2)
  })

  test('only new and edited comments are reported after the cursor', () => {
    gh.addIssue({ number: 7 })
    const old = gh.addComment(7, 'first')
    const first = sync(7)
    gh.addComment(7, 'second')
    gh.editComment(old.id, 'first, edited')
    const next = sync(7, first.cursor)
    expect(next.changes.map((c) => c.id)).toEqual([old.id, old.id + 1])
  })

  test('a heartbeat-only edit rewrites the file but is not reported', () => {
    gh.addIssue({ number: 7 })
    const ledger = gh.addComment(7, '<!-- vsk:v1 type=ledger -->\n<!-- vsk:claim owner=mini heartbeat=1 -->\n### Status')
    const first = sync(7)
    gh.editComment(ledger.id, '<!-- vsk:v1 type=ledger -->\n<!-- vsk:claim owner=mini heartbeat=2 -->\n### Status')
    const next = sync(7, first.cursor)
    expect(next.changes).toEqual([])
    const file = readState(next.dir)!.comments[String(ledger.id)]!.file
    expect(readFileSync(join(next.dir, file), 'utf8')).toContain('heartbeat=2')
  })

  test('a comment deleted on GitHub is removed and reported', () => {
    gh.addIssue({ number: 7 })
    const gone = gh.addComment(7, 'to delete')
    const first = sync(7)
    const file = readState(first.dir)!.comments[String(gone.id)]!.file
    gh.deleteComment(gone.id)
    const next = sync(7, first.cursor)
    expect(next.changes).toEqual([{ kind: 'removed', file, rev: next.cursor, id: gone.id }])
    expect(existsSync(join(next.dir, file))).toBe(false)
  })

  test('more than 100 comments are all read', () => {
    gh.addIssue({ number: 7 })
    for (let i = 0; i < 205; i++) gh.addComment(7, `comment ${i}`)
    const result = sync(7)
    expect(Object.keys(readState(result.dir)!.comments)).toHaveLength(205)
  })

  test('a comment count that disagrees with the issue refuses rather than caching a partial list', () => {
    gh.addIssue({ number: 7 })
    gh.addComment(7, 'one')
    const original = gh.runner
    gh.runner = (args, input) => {
      const result = original(args, input)
      if (args.at(-1) === 'repos/o/r/issues/7') return { ...result, stdout: result.stdout.replace('"comments":1', '"comments":2') }
      return result
    }
    expect(() => sync(7)).toThrow('reports 2 comments but 1 were read')
  })

  test('comment types come from the marker line, never from prose', () => {
    expect(commentType('<!-- vsk:v1 type=review round=1 -->\nbody')).toBe('review')
    expect(commentType('please see <!-- vsk:v1 type=plan -->')).toBe('human')
    expect(commentType('')).toBe('human')
  })

  test('a held lock times out with a clear message', () => {
    const dir = cacheDir(root, 'o/r', 9)
    mkdirSync(join(dir, '.lock'), { recursive: true })
    expect(() => withLock(dir, () => 1, { timeoutMs: 100 })).toThrow('is locked by')
  })

  test('a lock held by a live process is never taken over, however old', () => {
    const dir = cacheDir(root, 'o/r', 9)
    mkdirSync(join(dir, '.lock'), { recursive: true })
    writeFileSync(join(dir, '.lock/owner.json'), JSON.stringify({ token: 't', pid: process.pid, host: hostname(), at: 0 }))
    expect(() => withLock(dir, () => 1, { timeoutMs: 100, staleMs: 1 })).toThrow('is locked by pid')
  })

  test('a reused pid with a different process start is taken over', () => {
    const dir = cacheDir(root, 'o/r', 9)
    mkdirSync(join(dir, '.lock'), { recursive: true })
    writeFileSync(join(dir, '.lock/owner.json'), JSON.stringify({
      token: 'former-process', pid: process.pid, host: hostname(), at: Date.now(), start: 'not-this-process-start',
    }))
    expect(withLock(dir, () => 42, { timeoutMs: 1000 })).toBe(42)
    expect(existsSync(join(dir, '.lock'))).toBe(false)
  })

  test('a lock left by a dead process is taken over', () => {
    const dir = cacheDir(root, 'o/r', 9)
    const dead = spawnSync('true').pid!
    mkdirSync(join(dir, '.lock'), { recursive: true })
    writeFileSync(join(dir, '.lock/owner.json'), JSON.stringify({ token: 't', pid: dead, host: hostname(), at: Date.now() }))
    expect(withLock(dir, () => 42, { timeoutMs: 1000 })).toBe(42)
    expect(existsSync(join(dir, '.lock'))).toBe(false)
  })

  test('a holder whose lock was replaced does not remove the new owner\'s lock', () => {
    const dir = cacheDir(root, 'o/r', 9)
    withLock(dir, () => {
      writeFileSync(join(dir, '.lock/owner.json'), JSON.stringify({ token: 'someone-else', pid: process.pid, host: hostname(), at: Date.now() }))
    })
    expect(existsSync(join(dir, '.lock/owner.json'))).toBe(true)
  })

  test('the lock is re-entrant inside one process', () => {
    const dir = cacheDir(root, 'o/r', 9)
    expect(withLock(dir, () => withLock(dir, () => 'inner'))).toBe('inner')
  })

  test('an edit or delete on page 2 is seen even when page 1 and the issue are unchanged', () => {
    gh.addIssue({ number: 7 })
    const ids = Array.from({ length: 150 }, (_, i) => gh.addComment(7, `comment ${i}`).id)
    const first = sync(7)
    gh.editComment(ids[120]!, 'edited on page two', { touchIssue: false })
    const edited = sync(7, first.cursor)
    expect(edited.changes.map((c) => c.id)).toEqual([ids[120]])
    const unchanged = sync(7, edited.cursor)
    expect(unchanged.changes).toEqual([])
    expect(unchanged.requests).toBe(3)
    gh.deleteComment(ids[140]!)
    gh.issues.get(7)!.updated_at = gh.tick()
    const removed = sync(7, edited.cursor)
    expect(removed.changes.map((c) => [c.kind, c.id])).toEqual([['removed', ids[140]]])
  })

  test('a malformed --repo is refused before any request', () => {
    for (const repo of ['o/r?x=1', 'o/r/extra', '../r', 'o/..']) {
      expect(() => run('comment', '7', '--repo', repo, '--file', 'x.md')).toThrow('invalid repository')
    }
    expect(gh.calls).toEqual([])
  })

  test('--dry-run writes nothing and drop needs --yes', () => {
    gh.addIssue({ number: 7 })
    expect(run('label', '7', '--add', 'risky', '--dry-run').text).toContain('dry run: would set labels')
    expect(gh.calls).toEqual([])
    sync(7)
    expect(() => run('drop', '7')).toThrow('pass --yes')
    expect(run('drop', '7', '--yes').code).toBe(0)
    expect(existsSync(cacheDir(root, 'o/r', 7))).toBe(false)
  })

  test('a dry run still refuses what the real run would refuse', () => {
    gh.addIssue({ number: 7 })
    expect(() => run('comment', '7', '--dry-run')).toThrow('--file is required')
    expect(() => run('ack', '7', '--dry-run')).toThrow('--stage must be')
    expect(() => run('label', '7', '--state', 'nope', '--dry-run')).toThrow('--state must be one of')
    expect(() => run('edit-comment', '7', '5', '--file', 'missing.md', '--since', '0', '--dry-run')).toThrow()
    expect(gh.calls).toEqual([])
  })

  test('an issue never ends up with two state labels', () => {
    gh.addIssue({ number: 7, labels: ['planning', 'medium'] })
    expect(() => run('label', '7', '--add', 'queued')).toThrow('state labels change only through --state')
    expect(run('label', '7', '--state', 'queued', '--add', 'risky').code).toBe(0)
    expect(gh.issues.get(7)!.labels.sort()).toEqual(['medium', 'queued', 'risky'])
    expect(gh.calls.filter((call) => call.startsWith('PUT'))).toHaveLength(1)
  })

  // A state change is written down as it is made, so usage numbers can say which stage a turn
  // belonged to long after the issue has moved on.
  test('moving an issue records the stage and its time', () => {
    gh.addIssue({ number: 7, labels: ['planning', 'medium'] })
    const before = Date.now()
    expect(run('label', '7', '--state', 'queued').code).toBe(0)
    expect(run('label', '7', '--state', 'in-progress').code).toBe(0)
    // A label that is not a state writes nothing.
    expect(run('label', '7', '--add', 'risky').code).toBe(0)
    const lines = readFileSync(stageLogPath(root, 'o/r'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => [line.issue, line.state])).toEqual([[7, 'queued'], [7, 'in-progress'], [7, 'in-progress']])
    for (const line of lines) expect(Date.parse(line.at)).toBeGreaterThanOrEqual(before)
  })

  test('a label edit against a stale cursor is refused', () => {
    gh.addIssue({ number: 7, labels: ['planning', 'medium'] })
    const cursor = sync(7).cursor
    gh.editBody(7, 'changed by someone else')
    expect(() => run('label', '7', '--add', 'risky', '--since', String(cursor))).toThrow('conflict')
    expect(gh.issues.get(7)!.labels).not.toContain('risky')
  })

  test('two waiters racing a dead lock never remove the lock a live process took', () => {
    const dir = cacheDir(root, 'o/r', 9)
    const lock = join(dir, '.lock')
    const dead = spawnSync('true').pid!
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: dead, host: hostname(), at: Date.now() }))
    // A second waiter already replaced the dead lock and a live process now holds it.
    rmSync(lock, { recursive: true })
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'live', pid: process.pid, host: hostname(), at: Date.now() }))
    // The first waiter resumes with its stale judgement: the takeover must re-read and back off.
    takeOver(lock, 'dead', 60_000)
    expect(existsSync(join(lock, 'owner.json'))).toBe(true)
    expect(existsSync(`${lock}.steal`)).toBe(false)
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token).toBe('live')
  })

  test('a live stealer blocks takeover, and waiting still times out', () => {
    const dir = cacheDir(root, 'o/r', 9)
    const lock = join(dir, '.lock')
    const dead = spawnSync('true').pid!
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: dead, host: hostname(), at: Date.now() }))
    mkdirSync(`${lock}.steal`)
    writeFileSync(join(`${lock}.steal`, 'owner.json'), JSON.stringify({ token: 'stealer', pid: process.pid, host: hostname(), at: 0 }))
    const started = Date.now()
    expect(() => withLock(dir, () => 1, { timeoutMs: 200 })).toThrow('is locked by pid')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(existsSync(`${lock}.steal`)).toBe(true)
    expect(takeOver(lock, 'dead', 60_000)).toBe(false)
  })

  test('a dead stealer is reported with the recovery command, never removed automatically', () => {
    const dir = cacheDir(root, 'o/r', 9)
    const lock = join(dir, '.lock')
    const dead = spawnSync('true').pid!
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: dead, host: hostname(), at: Date.now() }))
    mkdirSync(`${lock}.steal`)
    writeFileSync(join(`${lock}.steal`, 'owner.json'), JSON.stringify({ token: 'gone', pid: dead, host: hostname(), at: Date.now() }))
    expect(() => withLock(dir, () => 7, { timeoutMs: 2000 })).toThrow(`delete this directory: ${JSON.stringify(`${lock}.steal`)}`)
    expect(existsSync(`${lock}.steal`)).toBe(true)
    rmSync(`${lock}.steal`, { recursive: true })
    expect(withLock(dir, () => 7, { timeoutMs: 2000 })).toBe(7)
  })

  test('a stealer that finds a replacement owner leaves it alone', () => {
    const dir = cacheDir(root, 'o/r', 9)
    const lock = join(dir, '.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'live', pid: process.pid, host: hostname(), at: Date.now() }))
    expect(takeOver(lock, 'dead', 60_000)).toBe(false)
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token).toBe('live')
  })

  test('a write holds the lock from its conflict check through its refresh', () => {
    gh.addIssue({ number: 7 })
    const comment = gh.addComment(7, 'v1')
    const cursor = sync(7).cursor
    const dir = cacheDir(root, 'o/r', 7)
    const original = gh.runner
    let lockedDuringWrite = false
    gh.runner = (args, input) => {
      if (args.includes('PATCH')) lockedDuringWrite = existsSync(join(dir, '.lock/owner.json'))
      return original(args, input)
    }
    const file = join(root, 'edit.md')
    writeFileSync(file, 'v2')
    expect(run('edit-comment', '7', String(comment.id), '--file', file, '--since', String(cursor)).code).toBe(0)
    expect(lockedDuringWrite).toBe(true)
  })
})

describe('acks and checks', () => {
  const brief = '## Goal\nExport CSV'
  const plan = '<!-- vsk:v1 type=plan rev=1 -->\n## Plan\n- [ ] Task 1'

  function acked(stage: 'brief' | 'plan' | 'ship', by = 'mk', source = 'session', login = by, type = 'User', quote = 'ok') {
    const dir = sync(7).dir
    const state = readState(dir)!
    const planEntry = Object.values(state.comments).find((c) => c.type === 'plan')
    const planHash = planEntry ? artifactHash(readFileSync(join(dir, planEntry.file), 'utf8').split('\n---\n').slice(1).join('\n---\n')) : null
    gh.addComment(7, ackBody({ stage, by, brief: artifactHash(brief), plan: stage === 'brief' ? null : planHash, source, quote }), login, type)
  }

  beforeEach(() => {
    gh.permissions.set('mk', 'admin')
    gh.addIssue({ number: 7, body: brief, labels: ['queued', 'medium'] })
    gh.addComment(7, plan)
  })

  test('a plan ack from a person with write access lets implementation start', () => {
    acked('plan')
    expect(run('check', '7', '--for', 'implement').code).toBe(0)
  })

  test('no ack blocks with the reason', () => {
    const result = run('check', '7', '--for', 'implement', '--json')
    expect(result.code).toBe(2)
    expect(result.json().blocks).toContain('plan not acked: no plan ack yet')
  })

  test('editing the brief after the ack invalidates it', () => {
    acked('plan')
    gh.editBody(7, '## Goal\nExport CSV and PDF')
    expect(run('check', '7', '--for', 'implement', '--json').json().blocks).toContain('plan not acked: the brief changed after the plan ack')
  })

  test('ticking plan checkboxes keeps the ack valid', () => {
    acked('plan')
    const planComment = gh.issues.get(7)!.comments[0]!
    gh.editComment(planComment.id, plan.replace('- [ ] Task 1', '- [x] Task 1'))
    expect(run('check', '7', '--for', 'implement').code).toBe(0)
  })

  test('an ack from someone without write access does not count', () => {
    gh.permissions.set('visitor', 'read')
    acked('plan', 'visitor')
    expect(run('check', '7', '--for', 'implement', '--json').json().blocks).toContain('plan not acked: @visitor has no write access')
  })

  test('an app may relay an ack only by citing the person\'s own comment', () => {
    const reply = gh.addComment(7, 'approved, go', 'mk')
    acked('plan', 'mk', `comment:${reply.id}`, 'vegafactory[bot]', 'Bot', 'approved, go')
    expect(run('check', '7', '--for', 'implement').code).toBe(0)
  })

  test('ticking a plan box does not age out a relayed ack', () => {
    const reply = gh.addComment(7, 'approved, go', 'mk')
    acked('plan', 'mk', `comment:${reply.id}`, 'vegafactory[bot]', 'Bot', 'approved, go')
    const planComment = gh.issues.get(7)!.comments[0]!
    gh.editComment(planComment.id, planComment.body.replace('- [ ] Task 1', '- [x] Task 1'))
    expect(run('check', '7', '--for', 'implement', '--resume', 'true').code).toBe(0)
  })

  test('a relayed ack must quote the cited words', () => {
    const reply = gh.addComment(7, 'not yet, change the export format', 'mk')
    acked('plan', 'mk', `comment:${reply.id}`, 'vegafactory[bot]', 'Bot', 'approved')
    expect(run('check', '7', '--for', 'implement', '--json').json().blocks).toContain('plan not acked: the cited comment does not contain the quoted words')
  })

  test('a relayed ack cannot cite words written before the current plan', () => {
    const early = gh.addComment(7, 'approved', 'mk')
    const planComment = gh.issues.get(7)!.comments[0]!
    gh.editComment(planComment.id, planComment.body + '\n- [ ] Task 2')
    acked('plan', 'mk', `comment:${early.id}`, 'vegafactory[bot]', 'Bot', 'approved')
    expect(run('check', '7', '--for', 'implement', '--json').json().blocks).toContain('plan not acked: the cited comment predates the current brief or plan')
  })

  test('a relayed ack is void if the cited comment is edited afterwards', () => {
    const reply = gh.addComment(7, 'approved', 'mk')
    acked('plan', 'mk', `comment:${reply.id}`, 'vegafactory[bot]', 'Bot', 'approved')
    gh.editComment(reply.id, 'approved — actually wait')
    expect(run('check', '7', '--for', 'implement', '--json').json().blocks).toContain('plan not acked: the cited comment was edited after the ack')
  })

  test('editing the evidence after "ship it" voids it', () => {
    const issue = gh.issues.get(7)!
    issue.labels = ['ready-to-ship', 'medium']
    const evidence = gh.addComment(7, '<!-- vsk:v1 type=evidence -->\nAll green')
    acked('ship')
    expect(run('check', '7', '--for', 'ship').code).toBe(0)
    gh.editComment(evidence.id, '<!-- vsk:v1 type=evidence -->\nAll green, plus a late change')
    expect(run('check', '7', '--for', 'ship', '--json').json().blocks).toContain('no "ship it": the ship ack predates the latest evidence')
  })

  test('an app cannot claim a session ack on someone\'s behalf', () => {
    acked('plan', 'mk', 'session', 'vegafactory[bot]', 'Bot')
    expect(run('check', '7', '--for', 'implement', '--json').json().blocks).toContain('plan not acked: a session ack must be posted by the person themselves')
  })

  test('the wrong state, a missing size and open blockers each block', () => {
    acked('plan')
    const issue = gh.issues.get(7)!
    issue.labels = ['planning']
    issue.blockedBy = [{ number: 3, state: 'open' }]
    const blocks = run('check', '7', '--for', 'implement', '--json').json().blocks
    expect(blocks).toContain('issue is planning, expected queued')
    expect(blocks).toContain('needs exactly one size label: small, medium, large or research')
  })

  test('ship needs a "ship it" newer than the latest evidence', () => {
    acked('plan')
    gh.issues.get(7)!.labels = ['ready-to-ship', 'medium']
    acked('ship')
    gh.addComment(7, '<!-- vsk:v1 type=evidence -->\nTests pass')
    expect(run('check', '7', '--for', 'ship', '--json').json().blocks).toContain('no "ship it": the ship ack predates the latest evidence')
    acked('ship')
    expect(run('check', '7', '--for', 'ship').code).toBe(0)
  })

  test('the ack command records the current hashes', () => {
    const result = run('ack', '7', '--stage', 'plan', '--by', '@mk', '--quote', 'looks right')
    expect(result.code).toBe(0)
    const posted = gh.issues.get(7)!.comments.at(-1)!.body
    expect(posted).toContain(`brief=${artifactHash(brief)}`)
    expect(posted).toContain(`plan=${artifactHash(plan)}`)
    expect(run('check', '7', '--for', 'implement').code).toBe(0)
  })
})

describe('writes', () => {
  beforeEach(() => {
    gh.addIssue({ number: 7, labels: ['planning', 'medium'] })
  })

  test('a state change drops the old state label', () => {
    const result = run('label', '7', '--state', 'queued', '--json')
    expect(result.json().labels).toEqual(['medium', 'queued'])
  })

  test('editing a comment that changed after your cursor is refused', () => {
    const comment = gh.addComment(7, 'v1')
    const cursor = sync(7).cursor
    gh.editComment(comment.id, 'v2 by someone else')
    const file = join(root, 'edit.md')
    writeFileSync(file, 'my edit')
    expect(() => run('edit-comment', '7', String(comment.id), '--file', file, '--since', String(cursor))).toThrow('conflict')
    const fresh = sync(7).cursor
    expect(run('edit-comment', '7', String(comment.id), '--file', file, '--since', String(fresh)).code).toBe(0)
    expect(gh.issues.get(7)!.comments[0]!.body).toBe('my edit')
  })

  test('posting a comment updates the local copy and prints the new cursor', () => {
    const file = join(root, 'c.md')
    writeFileSync(file, '<!-- vsk:v1 type=handback -->\nNeed a decision')
    const result = run('comment', '7', '--file', file, '--json')
    const state = readState(cacheDir(root, 'o/r', 7))!
    expect(Object.values(state.comments).map((c) => c.type)).toEqual(['handback'])
    expect(result.json().cursor).toBe(state.rev)
  })

  test('comment, edit-comment and body refuse text that starts with an ack, claim or release marker', () => {
    const comment = gh.addComment(7, 'v1')
    const cursor = sync(7).cursor
    const file = join(root, 'forged.md')
    for (const marker of [ackBody({ stage: 'ship', by: 'mk', brief: 'x', plan: null, source: 'session', quote: 'ship it' }), '<!-- vsk:v1 type=claim owner=a:1 -->\n', '\n<!-- vsk:v1 type=release owner=a:1 -->']) {
      writeFileSync(file, marker)
      expect(() => run('comment', '7', '--file', file), marker).toThrow('only `vegafactory issue')
      expect(() => run('edit-comment', '7', String(comment.id), '--file', file, '--since', String(cursor)), marker).toThrow('type=')
      expect(() => run('body', '7', '--file', file, '--since', String(cursor)), marker).toThrow('type=')
    }
    expect(gh.calls.filter((call) => !call.startsWith('GET') && call !== 'POST graphql')).toEqual([])
    // A marker quoted further down is only text.
    writeFileSync(file, 'see the ack:\n<!-- vsk:v1 type=ack stage=ship -->')
    expect(run('comment', '7', '--file', file).code).toBe(0)
  })

  test('usage errors name the fix', () => {
    expect(() => run('sync')).toThrow('needs an issue number')
    expect(() => run('comment', '7')).toThrow('--file is required')
    expect(() => run('label', '7', '--state', 'ready')).toThrow('--state must be one of')
  })
})

describe('gh', () => {
  test('a hung gh is killed after the timeout', () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'gh-slow-')))
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nsleep 10\n', { mode: 0o755 })
    const saved = { gh: process.env.VEGAFACTORY_GH, timeout: process.env.VEGAFACTORY_GH_TIMEOUT_MS }
    process.env.VEGAFACTORY_GH = join(bin, 'gh')
    process.env.VEGAFACTORY_GH_TIMEOUT_MS = '200'
    const started = Date.now()
    try {
      expect(() => defaultRunner(['api', 'x'])).toThrow('timed out after 200 ms')
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      for (const [key, value] of [['VEGAFACTORY_GH', saved.gh], ['VEGAFACTORY_GH_TIMEOUT_MS', saved.timeout]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

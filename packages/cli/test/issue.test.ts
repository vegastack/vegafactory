import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheDir, commentType, readState, syncIssue, withLock } from '../src/issue-cache.ts'
import { ackBody, artifactHash, runIssue } from '../src/issue.ts'
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
    expect(() => withLock(dir, () => 1, { timeoutMs: 100 })).toThrow('locked by another process')
  })
})

describe('acks and checks', () => {
  const brief = '## Goal\nExport CSV'
  const plan = '<!-- vsk:v1 type=plan rev=1 -->\n## Plan\n- [ ] Task 1'

  function acked(stage: 'brief' | 'plan' | 'ship', by = 'mk', source = 'session', login = by, type = 'User') {
    const dir = sync(7).dir
    const state = readState(dir)!
    const planEntry = Object.values(state.comments).find((c) => c.type === 'plan')
    const planHash = planEntry ? artifactHash(readFileSync(join(dir, planEntry.file), 'utf8').split('\n---\n').slice(1).join('\n---\n')) : null
    gh.addComment(7, ackBody({ stage, by, brief: artifactHash(brief), plan: stage === 'brief' ? null : planHash, source, quote: 'ok' }), login, type)
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
    gh.issues.get(7)!.body = '## Goal\nExport CSV and PDF'
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
    acked('plan', 'mk', `comment:${reply.id}`, 'vegafactory[bot]', 'Bot')
    expect(run('check', '7', '--for', 'implement').code).toBe(0)
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

  test('usage errors name the fix', () => {
    expect(() => run('sync')).toThrow('needs an issue number')
    expect(() => run('comment', '7')).toThrow('--file is required')
    expect(() => run('label', '7', '--state', 'ready')).toThrow('--state must be one of')
  })
})

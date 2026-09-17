import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, heartbeat, release, type ClaimContext } from '../src/claim.ts'
import { artifactHash, runIssue } from '../src/issue.ts'
import { duration, stageSpans, writeStatus } from '../src/status-comment.ts'
import { FakeGitHub } from './fake-github.ts'

const ev = (event: string, name: string, at: string) => ({ event, label: { name }, created_at: `2026-09-17T${at}:00Z` })

describe('stageSpans', () => {
  test('each state label opens a span and the next one closes it', () => {
    const spans = stageSpans([
      ev('labeled', 'waiting-on-operator', '09:00'),
      ev('labeled', 'small', '09:00'),
      ev('unlabeled', 'waiting-on-operator', '09:30'),
      ev('labeled', 'queued', '09:30'),
      ev('labeled', 'in-progress', '10:00'),
      ev('unlabeled', 'queued', '10:00'),
    ])
    expect(spans).toEqual([
      { stage: 'waiting-on-operator', start: '2026-09-17T09:00:00Z', end: '2026-09-17T09:30:00Z' },
      { stage: 'queued', start: '2026-09-17T09:30:00Z', end: '2026-09-17T10:00:00Z' },
      { stage: 'in-progress', start: '2026-09-17T10:00:00Z', end: null },
    ])
  })
  test('a state label removed with nothing added closes the span', () => {
    expect(stageSpans([ev('labeled', 'queued', '09:00'), ev('unlabeled', 'queued', '09:10')])[0]!.end).toBe('2026-09-17T09:10:00Z')
  })
  test('durations read like a person would say them', () => {
    expect(duration(5 * 60_000)).toBe('5m')
    expect(duration(125 * 60_000)).toBe('2h 5m')
    expect(duration(50 * 3_600_000)).toBe('2d 2h')
  })
})

describe('the status comment', () => {
  let gh: FakeGitHub
  let ctx: ClaimContext
  const ledger = () => gh.issues.get(7)!.comments.find((c) => c.body.includes('type=ledger'))!.body

  beforeEach(() => {
    gh = new FakeGitHub()
    gh.permissions.set('mk', 'admin')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'status-')))
    spawnSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, '.vegastack'))
    writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\n')
    ctx = { root, repo: 'o/r', number: 7, runner: gh.runner }
    gh.addIssue({ number: 7, labels: ['queued', 'small'] })
  })

  test('shows the holder, the branch and a timeline row per stage', () => {
    claim(ctx, { owner: 'mini:7-x', kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    writeStatus(ctx, { cwd: ctx.root, branch: 'feat/7-x', now: gh.clock + 10 * 60_000 })
    const body = ledger()
    expect(body).toContain('**in-progress** · held by `mini:7-x` (claude · opus)')
    expect(body).toContain('Branch `feat/7-x` · last push —')
    expect(body).toMatch(/\| queued \| — \| — \| 2026-09-17 10:00 UTC \| 2026-09-17 10:00 UTC \| 0m \|/)
    expect(body).toMatch(/\| in-progress \| `mini:7-x` \| claude · opus \| .* \| now \| 10m \|/)
    expect(body).not.toContain('vsk:claim')
  })

  test('reads the active time from the holder’s claim comment', () => {
    claim(ctx, { owner: 'mini:7-x', kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    heartbeat(ctx, 'mini:7-x', 95, gh.clock)
    writeStatus(ctx, { cwd: ctx.root, branch: 'feat/7-x', now: gh.clock })
    expect(ledger()).toContain('· 1h 35m active')
  })

  test('a progress list is kept across rewrites and does not change the plan hash', () => {
    claim(ctx, { owner: 'mini:7-x', kind: 'session', harness: 'codex', model: 'gpt' }, gh.clock)
    writeStatus(ctx, { cwd: ctx.root, branch: 'feat/7-x', progress: '- [x] 7-T1 cache\n- [ ] 7-T2 claims', now: gh.clock })
    const first = ledger()
    writeStatus(ctx, { cwd: ctx.root, branch: 'feat/7-x', now: gh.clock })
    expect(ledger()).toContain('- [x] 7-T1 cache')
    expect(artifactHash(ledger())).toBe(artifactHash(first.replace(/- \[x\] 7-T1 cache\n- \[ \] 7-T2 claims\n/, '')))
  })

  test('only the earliest status comment from a writer is the status comment', () => {
    gh.permissions.set('visitor', 'read')
    const forged = gh.addComment(7, '<!-- vsk:v1 type=ledger -->\nforged', 'visitor')
    const bot = gh.addComment(7, '<!-- vsk:v1 type=ledger -->\nbot', 'helper[bot]', 'Bot')
    writeStatus(ctx, { cwd: ctx.root, branch: 'feat/7-x', progress: '- [ ] 7-T1', now: gh.clock })
    const ledgers = gh.issues.get(7)!.comments.filter((c) => c.body.includes('type=ledger'))
    expect(ledgers).toHaveLength(3)
    const real = ledgers.at(-1)!
    expect(forged.body).toBe('<!-- vsk:v1 type=ledger -->\nforged')
    expect(bot.body).toBe('<!-- vsk:v1 type=ledger -->\nbot')
    gh.addComment(7, '<!-- vsk:v1 type=ledger -->\nlater copy', 'mk')
    writeStatus(ctx, { cwd: ctx.root, branch: 'feat/7-y', now: gh.clock })
    expect(real.body).toContain('Branch `feat/7-y`')
    expect(real.body).toContain('- [ ] 7-T1')
    expect(gh.issues.get(7)!.comments.at(-1)!.body).toBe('<!-- vsk:v1 type=ledger -->\nlater copy')
  })

  test('waiting on the operator says so', () => {
    gh.addIssue({ number: 8, labels: ['waiting-on-operator', 'medium'] })
    writeStatus({ ...ctx, number: 8 }, { cwd: ctx.root, branch: 'feat/8-y', now: gh.clock })
    const body = gh.issues.get(8)!.comments[0]!.body
    expect(body).toContain('**waiting-on-operator** · waiting on you · nobody holds it')
    expect(body).toContain('| waiting-on-operator | you | — |')
  })

  test('the status verb writes the comment once and leaves an unchanged one alone', () => {
    const run = (...argv: string[]) => runIssue(argv, { runner: gh.runner, cwd: ctx.root, out: () => {} })
    expect(run('status', '7', '--branch', 'feat/7-x')).toBe(0)
    const patches = () => gh.calls.filter((call) => call.startsWith('PATCH')).length
    const before = patches()
    expect(run('status', '7', '--branch', 'feat/7-x')).toBe(0)
    expect(patches()).toBe(before)
    expect(gh.issues.get(7)!.comments.filter((c) => c.body.includes('type=ledger')).length).toBe(1)
  })
})

describe('timeline credit', () => {
  test('a finished stage keeps the name of a claim that was later released', () => {
    const gh = new FakeGitHub()
    gh.permissions.set('mk', 'admin')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'status-')))
    spawnSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, '.vegastack'))
    writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\n')
    const ctx = { root, repo: 'o/r', number: 7, runner: gh.runner }
    gh.addIssue({ number: 7, labels: ['queued', 'small'] })
    claim(ctx, { owner: 'mini:7-x', kind: 'session', harness: 'codex', model: 'gpt' }, gh.clock)
    runIssue(['label', '7', '--state', 'ready-to-ship'], { runner: gh.runner, cwd: root, out: () => {} })
    release(ctx, 'mini:7-x', 'mini:7-x', 'done')
    writeStatus(ctx, { cwd: root, branch: 'feat/7-x', now: gh.clock })
    const body = gh.issues.get(7)!.comments.find((c) => c.body.includes('type=ledger'))!.body
    expect(body).toMatch(/\| in-progress \| `mini:7-x` \| codex · gpt \|/)
    expect(body).toContain('**ready-to-ship** · nobody holds it')
  })
})

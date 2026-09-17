import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, claimBody, heartbeat, heartbeatOf, holderOf, keepClaimRows, machineName, ownerId, release, type ClaimContext } from '../src/claim.ts'
import { cacheDir, readBody, readState, syncIssue } from '../src/issue-cache.ts'
import { runIssue } from '../src/issue.ts'
import { FakeGitHub } from './fake-github.ts'

let gh: FakeGitHub
let ctx: ClaimContext
const now = () => gh.clock
const request = (owner: string, extra = {}) => ({ owner, kind: 'session' as const, harness: 'claude', model: 'opus', ...extra })
const holder = () => {
  const { dir } = syncIssue({ ...ctx })
  const state = readState(dir)!
  return holderOf(state, (entry) => readBody(dir, entry.file), now())
}
const ledger = () => gh.issues.get(7)!.comments.find((c) => c.body.includes('type=ledger'))

beforeEach(() => {
  gh = new FakeGitHub()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claim-')))
  spawnSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\n')
  ctx = { root, repo: 'o/r', number: 7, runner: gh.runner }
  gh.addIssue({ number: 7, labels: ['queued', 'small'] })
})

describe('owner ids', () => {
  test('machine plus worktree folder, in a safe form', () => {
    expect(machineName('MK-Mac-mini.local')).toBe('mk-mac-mini')
    expect(ownerId('216-coordination', 'Build Box')).toBe('build-box:216-coordination')
  })
})

describe('claim', () => {
  test('the first claim wins, moves the issue to in-progress and starts a heartbeat', () => {
    const outcome = claim(ctx, request('a:1'), now())
    expect(outcome.ok).toBe(true)
    expect(gh.issues.get(7)!.labels).toEqual(['small', 'in-progress'])
    expect(heartbeatOf(ledger()!.body, 'a:1')).not.toBeNull()
    expect(holder().holder?.owner).toBe('a:1')
  })

  test('claiming again as the holder is a no-op', () => {
    claim(ctx, request('a:1'), now())
    const count = gh.issues.get(7)!.comments.length
    expect(claim(ctx, request('a:1'), now()).ok).toBe(true)
    expect(gh.issues.get(7)!.comments.length).toBe(count)
  })

  test('a live holder blocks another session and names itself', () => {
    claim(ctx, request('a:1'), now())
    const outcome = claim(ctx, request('b:2', { harness: 'codex', model: 'gpt' }), now())
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('held by a:1 (claude · opus)')
    expect(outcome.message).toContain('--take-back-by')
  })

  test('a stale holder is released and the new claim takes over without waiting', () => {
    claim(ctx, request('a:1'), now())
    gh.clock += 5 * 60 * 60_000
    const outcome = claim(ctx, request('b:2'), now())
    expect(outcome).toMatchObject({ ok: true, waitMs: 0 })
    expect(gh.issues.get(7)!.comments.some((c) => c.body.includes('type=release owner=a:1') && c.body.includes('no heartbeat since'))).toBe(true)
    expect(heartbeatOf(ledger()!.body, 'a:1')).toBeNull()
    expect(holder().holder?.owner).toBe('b:2')
  })

  test('a dispatched run goes stale after 30 minutes, a session only after 4 hours', () => {
    claim(ctx, request('a:1', { kind: 'dispatch' }), now())
    gh.clock += 31 * 60_000
    expect(holder().holder).toBeNull()
    expect(holder().stale[0]?.owner).toBe('a:1')
  })

  test('a heartbeat keeps a claim alive past its timeout', () => {
    claim(ctx, request('a:1'), now())
    gh.clock += 3 * 60 * 60_000
    heartbeat(ctx, 'a:1', 42, now())
    gh.clock += 2 * 60 * 60_000
    expect(holder().holder?.owner).toBe('a:1')
    expect(heartbeatOf(ledger()!.body, 'a:1')?.active).toBe(42)
  })

  test('take back from a live holder records who took it and asks to wait for the last push', () => {
    claim(ctx, request('a:1'), now())
    const outcome = claim(ctx, request('b:2', { takeBackBy: 'mk' }), now())
    expect(outcome).toMatchObject({ ok: true, waitMs: 120_000 })
    const bodies = gh.issues.get(7)!.comments.map((c) => c.body)
    expect(bodies.some((b) => b.includes('type=release owner=a:1 by=mk') && b.includes('taken back by @mk'))).toBe(true)
    expect(holder().holder?.owner).toBe('b:2')
  })

  test('two sessions claiming at once: the earlier claim wins and the later one backs off', () => {
    gh.afterPost = (body) => {
      if (!body.includes('owner=b:2') || !body.includes('type=claim')) return
      gh.afterPost = undefined
      // a:1's claim lands first on GitHub while b:2 is writing.
      const b = gh.issues.get(7)!.comments.pop()!
      gh.addComment(7, claimBody(request('a:1')))
      gh.issues.get(7)!.comments.push({ ...b, created_at: gh.tick() })
    }
    const outcome = claim(ctx, request('b:2'), now())
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('lost the race to a:1')
    expect(holder().holder?.owner).toBe('a:1')
  })

  test('release gives the issue up and removes the heartbeat row', () => {
    claim(ctx, request('a:1'), now())
    release(ctx, 'a:1', 'a:1', 'done')
    expect(holder().holder).toBeNull()
    expect(heartbeatOf(ledger()!.body, 'a:1')).toBeNull()
    expect(claim(ctx, request('b:2'), now()).ok).toBe(true)
  })

  test('a heartbeat without a claim is refused', () => {
    expect(() => heartbeat(ctx, 'z:9', 0, now())).toThrow('holds no claim')
  })
})

describe('status comment edits', () => {
  test('an edit keeps the current heartbeat rows, not the editor’s stale copy', () => {
    const current = '<!-- vsk:v1 type=ledger -->\n<!-- vsk:claim owner=a:1 heartbeat=NEW active=5 -->\n## Status\nold'
    const edited = '<!-- vsk:v1 type=ledger -->\n<!-- vsk:claim owner=a:1 heartbeat=OLD active=1 -->\n## Status\nnew'
    expect(keepClaimRows(current, edited)).toBe('<!-- vsk:v1 type=ledger -->\n<!-- vsk:claim owner=a:1 heartbeat=NEW active=5 -->\n## Status\nnew')
  })

  test('heartbeats do not move the cursor an agent edits against', () => {
    claim(ctx, request('a:1'), now())
    const cursor = syncIssue({ ...ctx }).cursor
    heartbeat(ctx, 'a:1', 3, now())
    expect(syncIssue({ ...ctx, since: cursor }).changes).toEqual([])
  })
})

describe('the claim verbs', () => {
  // The command line uses the real clock.
  beforeEach(() => { gh.clock = Date.now() })
  const run = (...argv: string[]) => {
    const lines: string[] = []
    const code = runIssue(argv, { runner: gh.runner, cwd: ctx.root, out: (line) => lines.push(line) })
    return { code, text: lines.join('\n') }
  }

  test('claim, holder and release from the command line', () => {
    expect(run('claim', '7', '--owner', 'a:1', '--harness', 'codex', '--model', 'gpt-5.5').code).toBe(0)
    expect(run('holder', '7').text).toContain('a:1 (codex · gpt-5.5)')
    expect(run('claim', '7', '--owner', 'b:2', '--harness', 'claude', '--model', 'opus').code).toBe(2)
    expect(run('release', '7', '--owner', 'a:1').code).toBe(0)
    expect(run('holder', '7').text).toBe('nobody')
  })

  test('claim needs the harness and model', () => {
    expect(() => run('claim', '7', '--owner', 'a:1')).toThrow('--harness and --model are required')
  })

  test('the default owner is this machine and the worktree folder', () => {
    run('claim', '7', '--harness', 'codex', '--model', 'm')
    const dir = cacheDir(ctx.root, 'o/r', 7)
    expect(Object.keys(readState(dir)!.comments).length).toBeGreaterThan(0)
    expect(run('holder', '7').text).toContain(ownerId(ctx.root.split('/').at(-1)!))
  })
})

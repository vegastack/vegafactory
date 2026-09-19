import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, claimBody, heartbeat, heartbeatOf, holderOf, machineName, nodeId, ownerId, release, releaseBody, trustedAuthors, type ClaimContext } from '../src/claim.ts'
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
  return holderOf(state, (entry) => readBody(dir, entry.file), now(), trustedAuthors(ctx))
}
// The owner's own claim comment, which carries its heartbeat row.
const claimOf = (owner: string) => gh.issues.get(7)!.comments.filter((c) => c.body.includes(`type=claim owner=${owner} `)).at(-1)

beforeEach(() => {
  gh = new FakeGitHub()
  gh.permissions.set('mk', 'admin')
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


describe('the name a node answers to', () => {
  test('it is the person and the machine, and the machine is its first label', () => {
    // `os.hostname()` answers `patrick-mac-mini.local` here and a full domain name on many Linux
    // hosts. Neither belongs in an identity somebody has to recognise in a table.
    expect(nodeId('mk', 'patrick-mac-mini.local')).toBe('mk@patrick-mac-mini')
    expect(nodeId('mk', 'build-box.internal.example.com')).toBe('mk@build-box')
    expect(nodeId('mk', 'patrick-mac-mini')).toBe('mk@patrick-mac-mini')
  })

  test('two people on one machine are two nodes, and one person on three is one owner', () => {
    expect(nodeId('mk', 'box')).not.toBe(nodeId('sam', 'box'))
    expect(nodeId('mk', 'box-a').split('@')[0]).toBe(nodeId('mk', 'box-b').split('@')[0])
  })

  test('both halves are normalised by one rule, so an id cannot be half-tidied', () => {
    expect(nodeId('K Manoj Kumar', 'Build Box.local')).toBe('k-manoj-kumar@build-box')
    expect(nodeId('mk', '--weird--')).toBe('mk@weird')
  })

  test('a name that normalises to nothing still leaves a readable id', () => {
    expect(nodeId('', '')).toBe('someone@machine')
    expect(nodeId('!!!', '???')).toBe('someone@machine')
  })

  // `machineName` maps every non-alphanumeric to a dash, so it would turn this into
  // `mk-patrick-mac-mini` — and it is what `ownerId` stamps on every session claim that exists
  // right now, so it must not change underneath them.
  test('the claim owner is untouched by any of this', () => {
    expect(machineName('MK-Mac-mini.local')).toBe('mk-mac-mini')
    expect(ownerId('216-coordination', 'Build Box')).toBe('build-box:216-coordination')
    expect(machineName('patrick-mac-mini.local')).not.toContain('@')
  })
})
})

describe('claim', () => {
  test('the first claim wins, moves the issue to in-progress and starts a heartbeat', () => {
    const outcome = claim(ctx, request('a:1'), now())
    expect(outcome.ok).toBe(true)
    expect(gh.issues.get(7)!.labels).toEqual(['small', 'in-progress'])
    expect(heartbeatOf(claimOf('a:1')!.body, 'a:1')).not.toBeNull()
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
    expect(heartbeatOf(claimOf('a:1')!.body, 'a:1')?.active).toBe(42)
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

  test('release gives the issue up', () => {
    claim(ctx, request('a:1'), now())
    release(ctx, 'a:1', 'a:1', 'done')
    expect(holder().holder).toBeNull()
    expect(claim(ctx, request('b:2'), now()).ok).toBe(true)
  })

  test('a heartbeat without a claim is refused', () => {
    expect(() => heartbeat(ctx, 'z:9', 0, now())).toThrow('holds no claim')
  })
})

describe('heartbeats', () => {
  test('each heartbeat edits only the owner’s own claim comment, never the status comment', () => {
    claim(ctx, request('a:1'), now())
    gh.addComment(7, '<!-- vsk:v1 type=ledger -->\n## Status\nwritten by someone else')
    const status = gh.issues.get(7)!.comments.at(-1)!
    const patches = () => gh.calls.filter((call) => call.startsWith('PATCH'))
    const before = patches().length
    heartbeat(ctx, 'a:1', 7, now())
    expect(patches().slice(before)).toEqual([`PATCH repos/o/r/issues/comments/${claimOf('a:1')!.id}`])
    expect(status.body).toBe('<!-- vsk:v1 type=ledger -->\n## Status\nwritten by someone else')
    expect(claimOf('a:1')!.body.split('\n').filter((row) => row.includes('vsk:claim'))).toHaveLength(1)
    expect(heartbeatOf(claimOf('a:1')!.body, 'a:1')?.active).toBe(7)
  })

  test('heartbeats do not move the cursor an agent edits against', () => {
    claim(ctx, request('a:1'), now())
    const cursor = syncIssue({ ...ctx }).cursor
    heartbeat(ctx, 'a:1', 3, now())
    expect(syncIssue({ ...ctx, since: cursor }).changes).toEqual([])
  })
})

describe('who may claim', () => {
  test('claims and releases count only from people with write access, never from a bot', () => {
    gh.permissions.set('visitor', 'read')
    gh.permissions.set('helper[bot]', 'write')
    gh.addComment(7, claimBody(request('v:1')), 'visitor')
    gh.addComment(7, claimBody(request('bot:1')), 'helper[bot]', 'Bot')
    expect(holder().holder).toBeNull()
    claim(ctx, request('a:1'), now())
    gh.addComment(7, releaseBody({ owner: 'a:1', by: 'visitor', reason: 'x' }), 'visitor')
    gh.addComment(7, releaseBody({ owner: 'a:1', by: 'bot', reason: 'x' }), 'helper[bot]', 'Bot')
    expect(holder().holder?.owner).toBe('a:1')
  })

  test('a take-back must name someone with write access', () => {
    gh.permissions.set('visitor', 'read')
    claim(ctx, request('a:1'), now())
    const outcome = claim(ctx, request('b:2', { takeBackBy: 'visitor' }), now())
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.message).toContain('@visitor has no write access')
    expect(holder().holder?.owner).toBe('a:1')
    expect(claim(ctx, request('b:2', { takeBackBy: 'nobody-known' }), now()).ok).toBe(false)
  })

  test('permissions are asked once and kept on disk for ten minutes', () => {
    claim(ctx, request('a:1'), now())
    const asks = () => gh.calls.filter((call) => call.includes('/permission')).length
    const first = asks()
    holder()
    holder()
    expect(asks()).toBe(first)
  })
})

describe('the claim verbs', () => {
  // The command line uses the real clock.
  beforeEach(() => { gh.clock = Date.now() })
  const runIn = (cwd: string, ...argv: string[]) => {
    const lines: string[] = []
    const code = runIssue(argv, { runner: gh.runner, cwd, out: (line) => lines.push(line) })
    return { code, text: lines.join('\n') }
  }
  const run = (...argv: string[]) => runIn(ctx.root, ...argv)
  // A second checkout of the same repository, so a second owner.
  const other = () => {
    const tree = join(ctx.root, '.vegastack', '.worktrees', '7-other')
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: ctx.root })
    spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat/7-other', tree], { cwd: ctx.root })
    return tree
  }
  const me = () => ownerId(ctx.root.split('/').at(-1)!)

  test('claim, holder and release from the command line', () => {
    expect(run('claim', '7', '--harness', 'codex', '--model', 'gpt-5.5').code).toBe(0)
    expect(run('holder', '7').text).toContain(`${me()} (codex · gpt-5.5)`)
    const tree = other()
    expect(runIn(tree, 'claim', '7', '--harness', 'claude', '--model', 'opus').code).toBe(2)
    // Another checkout's release or heartbeat does not touch this holder.
    expect(() => runIn(tree, 'heartbeat', '7')).toThrow('holds no claim')
    runIn(tree, 'release', '7')
    expect(run('holder', '7').text).toContain(me())
    expect(run('release', '7').code).toBe(0)
    expect(run('holder', '7').text).toBe('nobody')
  })

  test('--owner is refused, so a session cannot act as another holder', () => {
    run('claim', '7', '--harness', 'codex', '--model', 'm')
    for (const verb of [['release', '7'], ['heartbeat', '7'], ['claim', '7', '--harness', 'codex', '--model', 'm']]) {
      expect(() => runIn(other(), ...verb, '--owner', me()), verb[0]).toThrow('--owner is not accepted')
    }
    expect(run('holder', '7').text).toContain(me())
  })

  test('claim needs the harness and model', () => {
    expect(() => run('claim', '7')).toThrow('--harness and --model are required')
  })

  test('the default owner is this machine and the worktree folder', () => {
    run('claim', '7', '--harness', 'codex', '--model', 'm')
    const dir = cacheDir(ctx.root, 'o/r', 7)
    expect(Object.keys(readState(dir)!.comments).length).toBeGreaterThan(0)
    expect(run('holder', '7').text).toContain(ownerId(ctx.root.split('/').at(-1)!))
  })
})

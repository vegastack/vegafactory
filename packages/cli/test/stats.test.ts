import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhRunner } from '../src/gh.ts'
import {
  collectStats, defaultSite, loadEvents, parseClaude, parseCodex, parseSince, pushStats, resolveOperator,
  runStats, statsDir, summarize, type ParseContext, type StatsEvent,
} from '../src/stats.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/stats', name), 'utf8')
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

const site = () => defaultSite()
const context = (): ParseContext => ({ operator: 'mk', machine: 'box', carry: {}, site: site() })

let home: string
let base: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stats-')))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
})

// The logs live in the operator's home; every test points HOME at a temporary one.
function plantClaude(text: string, name = 'session.jsonl') {
  const dir = join(home, '.claude', 'projects', 'work-demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  return join(dir, name)
}

function plantCodex(text: string, name = 'rollout-2026-09-17T11-00-00-c-1.jsonl') {
  const dir = join(home, '.codex', 'sessions', '2026', '09', '17')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  return join(dir, name)
}

describe('collectors', () => {
  test('a Claude session yields one event per assistant turn, and no prompt text', () => {
    const { events, consumed } = parseClaude(fixture('claude-session.jsonl'), context())
    expect(consumed).toBe(Buffer.byteLength(fixture('claude-session.jsonl')))
    // Two real turns: one message id split over two lines, and the synthetic message skipped.
    expect(events.map((event) => event.outcome)).toEqual(['tool_use', 'end_turn'])
    expect(events[0]).toMatchObject({
      operator: 'mk', machine: 'box', harness: 'claude', model: 'claude-opus-5', issue: 42, skill: 'dev-implement',
      tokens: { input: 12, output: 200, cacheRead: 1000, cacheWrite: 5000 },
      durationMs: 30_000,
    })
    expect(events[1]).toMatchObject({ skill: null, durationMs: 60_000, tokens: { input: 4, output: 90, cacheRead: 42_000, cacheWrite: 0 } })
    expect(new Set(events.map((event) => event.id)).size).toBe(2)
    expect(JSON.stringify(events)).not.toContain('redacted')
  })

  test('a Codex rollout yields one event per response, with the model, skill and repository', () => {
    const { events } = parseCodex(fixture('codex-rollout.jsonl'), context())
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      harness: 'codex', model: 'gpt-5.6-sol', repo: 'acme/demo', issue: 43, skill: 'dev-review', outcome: 'tool_use',
      // Timed from the turn's start, not from the tool call the record is written beside.
      durationMs: 20_000,
      // Codex counts cached tokens inside input_tokens; the event splits them out.
      tokens: { input: 20_228, output: 262, cacheRead: 2000, cacheWrite: 300 },
    })
    // task_complete names how the turn ended, on the turn's last response.
    // The second response is timed from the tool output that preceded it.
    expect(events[1]).toMatchObject({ skill: null, outcome: 'end_turn', durationMs: 38_000, tokens: { input: 10_000, cacheRead: 20_000 } })
    expect(JSON.stringify(events)).not.toContain('redacted')
  })

  test('a half-written last line is left for the next run', () => {
    const text = fixture('claude-session.jsonl')
    const cut = text.slice(0, text.length - 40)
    const { events, consumed } = parseClaude(cut, context())
    expect(consumed).toBeLessThan(Buffer.byteLength(cut))
    expect(events).toHaveLength(2)
  })

  test('the repository, issue and stage come from the checkout, the worktree path and the local issue copy', () => {
    const root = join(base, 'demo')
    mkdirSync(root)
    git(root, 'init', '-q', '-b', 'main', root)
    git(root, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git')
    const tree = join(root, '.vegastack', '.worktrees', '42-demo')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, '.git'), `gitdir: ${join(root, '.git', 'worktrees', '42-demo')}\n`)
    const cache = join(root, '.vegastack', '.tmp', 'issues', 'acme__demo', '42')
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'state.json'), JSON.stringify({ schema: 1, commentPages: [], issue: { labels: ['in-progress', 'small'] } }))
    expect(site()(tree, 'feat/42-demo')).toEqual({ repo: 'acme/demo', issue: 42, state: 'in-progress' })
  })
})

describe('offsets', () => {
  const collect = () => collectStats({ home, operator: 'mk', machine: 'box', site: site() })
  const events = () => loadEvents(home, { shared: false })

  test('a killed session is counted at the next run, exactly once', () => {
    const path = plantClaude(fixture('claude-session.jsonl'))
    plantCodex(fixture('codex-rollout.jsonl'))
    expect(collect().events).toBe(4)
    // Nothing new: the same logs must not be counted twice.
    expect(collect().events).toBe(0)
    // The session was killed after one more turn; it is picked up at the next run.
    appendFileSync(path, fixture('claude-session-more.jsonl'))
    expect(collect().events).toBe(1)
    expect(collect().events).toBe(0)
    const all = events()
    expect(all).toHaveLength(5)
    expect(new Set(all.map((event) => event.id)).size).toBe(5)
    expect(JSON.parse(readFileSync(join(statsDir(home), 'offsets.json'), 'utf8')).files[path].offset)
      .toBe(Buffer.byteLength(fixture('claude-session.jsonl') + fixture('claude-session-more.jsonl')))
  })

  test('a turn split across two runs is counted once', () => {
    const text = fixture('claude-session.jsonl')
    const lines = text.split('\n').filter(Boolean)
    // Stop between the two lines that share one message id.
    const path = plantClaude(lines.slice(0, 2).join('\n') + '\n')
    expect(collect().events).toBe(1)
    writeFileSync(path, text)
    collect()
    expect(events()).toHaveLength(2)
  })

  test('a file replaced at the same path is read from the start', () => {
    const path = plantClaude(fixture('claude-session.jsonl'))
    expect(collect().events).toBe(2)
    writeFileSync(path, fixture('claude-session-more.jsonl'))
    expect(collect().events).toBe(1)
  })

  test('no session logs at all is not an error', () => {
    expect(collect()).toEqual({ files: 0, events: 0, bytes: 0 })
  })
})

describe('the operator', () => {
  test('the gh login is asked for once and kept', () => {
    const calls: string[][] = []
    const runner: GhRunner = (args) => {
      calls.push(args)
      return { code: 0, stdout: 'HTTP/2 200\r\n\r\n{"login":"mk"}', stderr: '' }
    }
    expect(resolveOperator(home, runner, 1000)).toBe('mk')
    expect(resolveOperator(home, runner, 2000)).toBe('mk')
    expect(calls).toHaveLength(1)
    // A logged-out or offline machine still collects, under the last known login.
    const broken: GhRunner = () => ({ code: 1, stdout: '', stderr: 'not logged in' })
    expect(resolveOperator(home, broken, 3000)).toBe('mk')
    expect(resolveOperator(join(base, 'other'), broken, 3000)).toBe('unknown')
  })
})

describe('stats show', () => {
  const NOW = Date.parse('2026-09-18T00:00:00Z')
  const out: string[] = []
  beforeEach(() => {
    out.length = 0
    plantClaude(fixture('claude-session.jsonl'))
    plantCodex(fixture('codex-rollout.jsonl'))
    mkdirSync(statsDir(home), { recursive: true })
    // With the login already known, collecting never reaches for gh.
    writeFileSync(join(statsDir(home), 'identity.json'), JSON.stringify({ login: 'mk', at: NOW }))
  })
  const run = (argv: string[]) => runStats(argv, { home, now: () => NOW, out: (text) => out.push(text) })

  test('collect then show prints turns, tokens and stages', () => {
    expect(run(['collect'])).toBe(0)
    expect(out.join('\n')).toContain('collected 4 turns')
    out.length = 0
    expect(run(['show'])).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('4 turns')
    expect(text).toContain('claude · claude-opus-5')
    expect(text).toContain('codex · gpt-5.6-sol')
    expect(text).toContain('acme/demo')
  })

  test('show --json gives the summary, and --since narrows it', () => {
    run(['collect'])
    out.length = 0
    run(['show', '--json'])
    const summary = JSON.parse(out.join('\n'))
    expect(summary.turns).toBe(4)
    expect(summary.tokens).toEqual({ input: 30_244, output: 952, cacheRead: 65_000, cacheWrite: 5300 })
    expect(summary.operators[0].key).toBe('mk')
    expect(summary.skills.map((row: { key: string }) => row.key).sort()).toEqual(['dev-implement', 'dev-review'])
    out.length = 0
    run(['show', '--json', '--since', '1h'])
    expect(JSON.parse(out.join('\n')).turns).toBe(0)
  })

  test('collect never throws at a session', () => {
    writeFileSync(join(statsDir(home), 'offsets.json'), '{ not json')
    expect(run(['collect'])).toBe(0)
  })

  test('--since takes spans and dates', () => {
    expect(parseSince('2d', 10 * 86_400_000)).toBe(8 * 86_400_000)
    expect(parseSince('2026-09-17', 0)).toBe(Date.parse('2026-09-17'))
    expect(() => parseSince('soon', 0)).toThrow('--since')
  })
})

describe('stats push', () => {
  let clone: string
  let repo: string

  beforeEach(() => {
    const origin = join(base, 'room.git')
    git(base, 'init', '-q', '--bare', '-b', 'main', origin)
    clone = join(home, '.vegastack', 'control-room', 'acme')
    git(base, 'clone', '-q', origin, clone)
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'seed')
    git(clone, 'push', '-q', 'origin', 'main')
    spawnSync('git', ['-C', clone, 'config', 'user.name', 't'])
    spawnSync('git', ['-C', clone, 'config', 'user.email', 't@t'])
    writeFileSync(join(home, '.vegastack', 'factory.json'), JSON.stringify({
      schemaVersion: 1,
      controlRooms: { acme: { repo: 'acme/room', path: clone, branch: 'main', remote: origin, lastSyncedAt: null, sha: null } },
    }))
    repo = join(base, 'app')
    mkdirSync(join(repo, '.vegastack'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main', repo)
    writeFileSync(join(repo, '.vegastack', 'dev.md'), 'repo: acme/app\ncontrol-room: acme/room#dev\n')
    mkdirSync(statsDir(home), { recursive: true })
    writeFileSync(join(statsDir(home), 'identity.json'), JSON.stringify({ login: 'mk', at: 1 }))
  })

  const event = (id: string, at: string): StatsEvent => ({
    id, at, operator: 'mk', machine: 'box', harness: 'claude', model: 'claude-opus-5', repo: 'acme/app', issue: 42,
    state: 'in-progress', skill: null, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, durationMs: 1000, outcome: 'end_turn',
  })
  const write = (...events: StatsEvent[]) =>
    appendFileSync(join(statsDir(home), 'events.jsonl'), events.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const push = (now: number, force = false) => pushStats({ home, cwd: repo, machine: 'box', now: () => now, force })

  test('turns land in the control room as one file per operator, machine and day', () => {
    write(event('a', '2026-09-17T10:00:00.000Z'), event('b', '2026-09-18T11:00:00.000Z'))
    const result = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(result).toMatchObject({ ok: true, action: 'pushed', events: 2 })
    expect(readdirSync(join(clone, 'stats', '2026', '09', '17'))).toEqual(['mk-box.jsonl'])
    expect(readFileSync(join(clone, 'stats', '2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    // The clone must stay clean, or the next `vegafactory sync` refuses to refresh it.
    expect(git(clone, 'status', '--porcelain')).toBe('')
    expect(git(clone, 'log', 'origin/main', '-1', '--format=%s')).toContain('stats: mk on box')
    // The events are also readable back as org data.
    expect(loadEvents(home, { local: false }).map((row) => row.id).sort()).toEqual(['a', 'b'])
  })

  test('a push runs at most once an hour, and only for what is new', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    expect(push(Date.parse('2026-09-18T12:00:00Z')).action).toBe('pushed')
    write(event('b', '2026-09-18T12:10:00.000Z'))
    expect(push(Date.parse('2026-09-18T12:30:00Z')).action).toBe('skipped')
    const later = push(Date.parse('2026-09-18T13:05:00Z'))
    expect(later).toMatchObject({ action: 'pushed', events: 1 })
    expect(readFileSync(join(clone, 'stats', '2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(push(Date.parse('2026-09-18T14:10:00Z')).action).toBe('none')
  })

  test('without a linked control room nothing is pushed and nothing fails', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    writeFileSync(join(repo, '.vegastack', 'dev.md'), 'repo: acme/app\n')
    expect(push(Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ ok: true, action: 'none' })
    rmSync(join(home, '.vegastack', 'factory.json'))
    writeFileSync(join(repo, '.vegastack', 'dev.md'), 'repo: acme/app\ncontrol-room: acme/room#dev\n')
    expect(push(Date.parse('2026-09-18T12:00:00Z')).ok).toBe(true)
  })

  test('a rejected push keeps the commit and does not resend those turns', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    // Another machine moved the branch, and the clone cannot rebase onto a missing remote.
    rmSync(join(base, 'room.git'), { recursive: true })
    const result = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(result).toMatchObject({ ok: false, action: 'committed' })
    expect(git(clone, 'log', '-1', '--format=%s')).toContain('stats: mk on box')
    expect(push(Date.parse('2026-09-18T14:00:00Z')).action).toBe('none')
  })
})

describe('summaries', () => {
  test('buckets carry turns, tokens, time and who used them', () => {
    const rows: StatsEvent[] = [
      { id: '1', at: '2026-09-17T10:00:00.000Z', operator: 'mk', machine: 'box', harness: 'claude', model: 'opus', repo: 'acme/app', issue: 1, state: 'in-progress', skill: 'dev-plan', tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }, durationMs: 60_000, outcome: 'end_turn' },
      { id: '2', at: '2026-09-18T10:00:00.000Z', operator: 'sam', machine: 'box', harness: 'codex', model: 'gpt', repo: 'acme/app', issue: 1, state: 'ready-to-ship', skill: null, tokens: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 }, durationMs: 120_000, outcome: 'tool_use' },
    ]
    const summary = summarize(rows)
    expect(summary.turns).toBe(2)
    expect(summary.operators.map((row) => row.key).sort()).toEqual(['mk', 'sam'])
    expect(summary.projects[0]).toMatchObject({ key: 'acme/app', turns: 2, operators: ['mk', 'sam'] })
    // The issue keeps the state of its latest turn.
    expect(summary.issues[0]).toMatchObject({ key: 'acme/app#1', state: 'ready-to-ship' })
    expect(summary.days.map((row) => row.key)).toEqual(['2026-09-17', '2026-09-18'])
    expect(summary.stages.map((row) => row.key).sort()).toEqual(['in-progress', 'ready-to-ship'])
  })
})

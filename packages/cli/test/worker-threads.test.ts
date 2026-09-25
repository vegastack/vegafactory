import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerRecordError, defaultRunStep, readThreads, threadDecision, threadKey, updateThread, type ThreadRecord } from '../src/worker.ts'

const ID_A = '019a0b08-3326-72c3-a5fe-ec02067cf714'
const ID_B = '019a0b08-3326-72c3-a5fe-ec02067cf715'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const NOW = '2026-09-25T00:00:00.000Z'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'worker-threads-')))
  const stateRoot = join(home, '.vegafactory', 'worker')
  return { home, stateRoot, file: join(stateRoot, 'threads.json') }
}

const row = (repo: string, issue: number, harness: 'codex' | 'claude', sessionId = ID_A): ThreadRecord =>
  ({ repo, issue, harness, sessionId, node: 'vf@mini', lastSeenHead: HEAD_A, updatedAt: NOW })

function git(cwd: string, ...args: string[]) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(run.stderr)
  return run.stdout.trim()
}

function checkout() {
  const { home, stateRoot } = fixture()
  const holder = join(home, 'holder')
  const root = join(holder, 'repo')
  const issue = join(holder, 'issues', '7')
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'initial\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  mkdirSync(join(holder, 'issues'), { recursive: true })
  git(root, 'worktree', 'add', '-q', '-b', 'feat/7-thread', issue)
  return { root, issue, stateRoot }
}

const codexEvents = (id: string) => [JSON.stringify({ type: 'thread.started', thread_id: id }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })].join('\n') + '\n'

describe('private worker issue threads', () => {
  test('canonical repository, issue and harness form separate identities', () => {
    const { stateRoot, file } = fixture()
    expect(readThreads(stateRoot)).toEqual({})
    updateThread(stateRoot, null, row('o/a', 7, 'codex'))
    updateThread(stateRoot, null, row('o/b', 7, 'codex', ID_B))
    updateThread(stateRoot, null, row('o/a', 7, 'claude', ID_B))
    expect(readThreads(stateRoot)[threadKey({ repo: 'O/A', issue: 7, harness: 'codex' })]!.sessionId).toBe(ID_A)
    expect(Object.keys(readThreads(stateRoot))).toHaveLength(3)
    expect(lstatSync(stateRoot).mode & 0o777).toBe(0o700)
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
  })

  test('malformed, partial, unknown-field and noncanonical rows preserve every byte', () => {
    for (const bad of ['[]', '{', JSON.stringify({ 'O/A#7#codex': row('o/a', 7, 'codex') }),
      JSON.stringify({ 'o/a#7#codex': { ...row('o/a', 7, 'codex'), prompt: 'private text' } })]) {
      const { stateRoot, file } = fixture()
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
      writeFileSync(file, bad, { mode: 0o600 })
      expect(() => readThreads(stateRoot)).toThrow(WorkerRecordError)
      expect(() => updateThread(stateRoot, null, row('o/b', 8, 'codex'))).toThrow(WorkerRecordError)
      expect(readFileSync(file, 'utf8')).toBe(bad)
    }
  })

  test('unsafe root and leaf refuse without following a linked target', () => {
    const { home, stateRoot, file } = fixture()
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    const outside = join(home, 'outside.json')
    symlinkSync(outside, file)
    expect(() => updateThread(stateRoot, null, row('o/a', 7, 'codex'))).toThrow(WorkerRecordError)
    expect(existsSync(outside)).toBe(false)
    const other = fixture()
    mkdirSync(other.stateRoot, { recursive: true, mode: 0o700 })
    writeFileSync(other.file, '{}', { mode: 0o600 })
    chmodSync(other.file, 0o644)
    expect(() => readThreads(other.stateRoot)).toThrow(WorkerRecordError)
  })

  test('compare-and-set leaves a newer conversation intact', () => {
    const { stateRoot, file } = fixture()
    const first = row('o/a', 7, 'codex')
    updateThread(stateRoot, null, first)
    const next = { ...first, sessionId: ID_B, lastSeenHead: HEAD_B }
    updateThread(stateRoot, first, next)
    const bytes = readFileSync(file, 'utf8')
    expect(() => updateThread(stateRoot, first, row('o/a', 7, 'codex'))).toThrow(/changed|stale/i)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
  })

  test('resume requires the same node and last-seen head', () => {
    const saved = row('o/a', 7, 'codex')
    const input = { saved, repo: 'O/A', issue: 7, harness: 'codex' as const, node: 'vf@mini', head: HEAD_A }
    expect(threadDecision(input)).toMatchObject({ mode: 'resume', sessionId: ID_A })
    expect(threadDecision({ ...input, head: HEAD_B })).toMatchObject({ mode: 'fresh', sessionId: null })
    expect(threadDecision({ ...input, node: 'vf@other' })).toMatchObject({ mode: 'fresh', sessionId: null })
    expect(threadDecision({ ...input, saved: null })).toMatchObject({ mode: 'fresh', sessionId: null })
  })
})

describe('worker conversation continuation', () => {
  const step = { action: 'implement' as const, number: 7, repo: 'o/a', split: false, by: null }
  const devMd = 'harness-policy: implement codex default high'

  test('a run records its own post-commit head, resumes there, and forks after an external branch move', async () => {
    const { root, issue, stateRoot } = checkout()
    const calls: string[][] = []
    const ids = [ID_A, ID_A, ID_B]
    const exec = async (_tool: string, args: string[], options: { cwd: string; onStart?: (pid: number, command: string) => void }) => {
      calls.push(args)
      options.onStart?.(5000 + calls.length, 'codex')
      if (calls.length === 1) {
        writeFileSync(join(options.cwd, 'agent.txt'), 'agent commit\n')
        git(options.cwd, 'add', '.')
        git(options.cwd, 'commit', '-qm', 'agent commit')
      }
      return { code: 0, stdout: codexEvents(ids[calls.length - 1]!), stderr: '', timedOut: false }
    }
    const run = defaultRunStep({}, { exec })
    const context = { root, devMd, token: null, stateRoot, node: 'vf@mini', onStart: () => {} }
    expect((await run(step, context)).outcome).toBe('done')
    const afterAgent = git(issue, 'rev-parse', 'HEAD')
    expect(readThreads(stateRoot)[threadKey({ repo: 'o/a', issue: 7, harness: 'codex' })]!.lastSeenHead).toBe(afterAgent)
    expect((await run(step, context)).outcome).toBe('done')
    expect(calls[1]!.slice(0, 2)).toEqual(['exec', 'resume'])
    writeFileSync(join(issue, 'outside.txt'), 'external move\n')
    git(issue, 'add', '.')
    git(issue, 'commit', '-qm', 'external move')
    expect((await run(step, context)).outcome).toBe('done')
    expect(calls[2]!.slice(0, 2)).toEqual(['exec', '--json'])
    expect(readThreads(stateRoot)[threadKey({ repo: 'o/a', issue: 7, harness: 'codex' })]!.sessionId).toBe(ID_B)
  })

  test('a missing resumed session retries fresh once within the remaining step budget', async () => {
    const { root, issue, stateRoot } = checkout()
    const head = git(issue, 'rev-parse', 'HEAD')
    updateThread(stateRoot, null, { ...row('o/a', 7, 'codex'), lastSeenHead: head })
    let now = 1_000
    const calls: Array<{ args: string[]; timeoutMs: number }> = []
    const exec = async (_tool: string, args: string[], options: { timeoutMs: number; onStart?: (pid: number, command: string) => void }) => {
      calls.push({ args, timeoutMs: options.timeoutMs })
      options.onStart?.(6000 + calls.length, 'codex')
      if (calls.length === 1) {
        now += 200
        return { code: 1, stdout: '', stderr: `No saved session found with id ${ID_A}`, timedOut: false }
      }
      return { code: 0, stdout: codexEvents(ID_B), stderr: '', timedOut: false }
    }
    const run = defaultRunStep({}, { exec, now: () => now })
    const result = await run(step, { root, devMd, token: null, stateRoot, node: 'vf@mini', timeoutMs: 1_000, onStart: () => {} })
    expect(result.outcome).toBe('done')
    expect(calls.map(call => call.args.slice(0, 2))).toEqual([['exec', 'resume'], ['exec', '--json']])
    expect(calls.map(call => call.timeoutMs)).toEqual([1_000, 800])
    expect(readThreads(stateRoot)[threadKey({ repo: 'o/a', issue: 7, harness: 'codex' })]!.sessionId).toBe(ID_B)
  })

  test('an ordinary resume error and a failed fresh start preserve the last usable row', async () => {
    const { root, issue, stateRoot } = checkout()
    const head = git(issue, 'rev-parse', 'HEAD')
    const saved = { ...row('o/a', 7, 'codex'), lastSeenHead: head }
    updateThread(stateRoot, null, saved)
    let calls = 0
    const ordinary = defaultRunStep({}, { exec: async () => { calls++; return { code: 1, stdout: '', stderr: 'model request failed', timedOut: false } } })
    expect((await ordinary(step, { root, devMd, token: null, stateRoot, node: 'vf@mini' })).outcome).toBe('failed')
    expect(calls).toBe(1)
    writeFileSync(join(issue, 'moved.txt'), 'new head\n')
    git(issue, 'add', '.')
    git(issue, 'commit', '-qm', 'moved')
    const failedStart = defaultRunStep({}, { exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, error: 'ENOENT' }) })
    expect((await failedStart(step, { root, devMd, token: null, stateRoot, node: 'vf@mini' })).outcome).toBe('failed')
    expect(readThreads(stateRoot)[threadKey({ repo: 'o/a', issue: 7, harness: 'codex' })]).toEqual(saved)
  })

  test('a resumed command must report the same supported session ID before its head advances', async () => {
    const { root, issue, stateRoot } = checkout()
    const saved = { ...row('o/a', 7, 'codex'), lastSeenHead: git(issue, 'rev-parse', 'HEAD') }
    updateThread(stateRoot, null, saved)
    const run = defaultRunStep({}, { exec: async (_tool, _args, options) => {
      options.onStart?.(8001, 'codex')
      return { code: 0, stdout: codexEvents(ID_B), stderr: '', timedOut: false }
    } })
    expect((await run(step, { root, devMd, token: null, stateRoot, node: 'vf@mini', onStart: () => {} })).outcome).toBe('failed')
    expect(readThreads(stateRoot)[threadKey({ repo: 'o/a', issue: 7, harness: 'codex' })]).toEqual(saved)
  })
})

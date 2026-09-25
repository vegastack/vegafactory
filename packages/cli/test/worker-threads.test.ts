import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerRecordError, readThreads, threadDecision, threadKey, updateThread, type ThreadRecord } from '../src/worker.ts'

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

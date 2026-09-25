import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteDroppedDeps, readDroppedDeps, restoreDroppedDependencies, parseSetupCommand, worktreePath } from '../scripts/worktree.mjs'

const devMd = 'commands: test `bun test` · setup `bun install --frozen-lockfile`\n'

function markedCheckout() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'vf-prepare-'))
  const name = '275'
  const path = worktreePath(repoRoot, name)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  noteDroppedDeps({ repoRoot, name, path, droppedAt: new Date().toISOString() })
  return { repoRoot, name, path }
}

describe('dependency restoration', () => {
  test('only one non-empty backticked setup field is accepted', () => {
    expect(parseSetupCommand(devMd)).toEqual({ ok: true, command: 'bun install --frozen-lockfile' })
    expect(parseSetupCommand('commands: test `true`\n').ok).toBe(false)
    expect(parseSetupCommand('commands: setup ``\n').ok).toBe(false)
    expect(parseSetupCommand('commands: setup `one` · setup `two`\n').ok).toBe(false)
  })

  test('successful setup clears only its marker; absent marker runs nothing', async () => {
    const input = markedCheckout()
    let calls = 0
    const execute = async (command: string) => {
      expect(command).toBe('bun install --frozen-lockfile')
      calls += 1
      return { code: 0, signal: null, timedOut: false, output: 'installed' }
    }
    const result = await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 2_000, execute })
    expect(result).toMatchObject({ ok: true, restored: true, command: 'bun install --frozen-lockfile' })
    expect(readDroppedDeps({ repoRoot: input.repoRoot }).records.has(input.name)).toBe(false)
    expect(await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 2_000, execute })).toMatchObject({ ok: true, restored: false })
    expect(calls).toBe(1)
  })

  test('a failed setup preserves the marker', async () => {
    const input = markedCheckout()
    const result = await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 2_000,
      execute: async () => ({ code: 1, signal: null, timedOut: false, output: 'failed' }) })
    expect(result.ok).toBe(false)
    expect(readDroppedDeps({ repoRoot: input.repoRoot }).records.has(input.name)).toBe(true)
  })

  test('two entrants observing one live owner run setup once', async () => {
    const input = markedCheckout()
    let release!: () => void
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const execute = async () => {
      calls += 1
      started()
      await barrier
      return { code: 0, signal: null, timedOut: false, output: '' }
    }
    const first = restoreDroppedDependencies({ ...input, devMd, timeoutMs: 5_000, execute })
    await running
    const second = restoreDroppedDependencies({ ...input, devMd, timeoutMs: 5_000, execute })
    release()
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true, restored: true }),
      expect.objectContaining({ ok: true, restored: true }),
    ])
    expect(calls).toBe(1)
  })
})

import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

  test('malformed or unsafe marker state blocks without executing setup', async () => {
    const input = markedCheckout()
    const marker = join(input.repoRoot, '.vegastack', '.tmp', 'deps-dropped', '275.json')
    writeFileSync(marker, '{bad json\n')
    let calls = 0
    const execute = async () => { calls += 1; return { code: 0, signal: null, timedOut: false, output: '' } }
    expect((await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 1_000, execute })).ok).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe('{bad json\n')
    expect(calls).toBe(0)

    const other = markedCheckout()
    const root = join(other.repoRoot, '.vegastack', '.tmp', 'deps-dropped')
    const preserved = root + '-preserved'
    renameSync(root, preserved)
    symlinkSync(join(other.repoRoot, 'missing-marker-root'), root)
    expect((await restoreDroppedDependencies({ ...other, devMd, timeoutMs: 1_000, execute })).ok).toBe(false)
    expect(lstatSync(root).isSymbolicLink()).toBe(true)
    expect(calls).toBe(0)
  })

  test('missing setup, abort and timeout preserve the marker', async () => {
    const input = markedCheckout()
    let calls = 0
    const execute = async () => { calls += 1; return { code: 0, signal: null, timedOut: false, output: '' } }
    expect((await restoreDroppedDependencies({ ...input, devMd: 'commands: test `true`\n', timeoutMs: 1_000, execute })).reason).toContain('commands: setup')
    const abort = new AbortController()
    abort.abort()
    expect((await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 1_000, signal: abort.signal, execute })).ok).toBe(false)
    expect((await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 1_000,
      execute: async () => ({ code: null, signal: null, timedOut: true, output: '' }) })).reason).toContain('timed out')
    expect(readDroppedDeps({ repoRoot: input.repoRoot }).records.has(input.name)).toBe(true)
    expect(calls).toBe(0)
  })

  test('a result publication failure leaves the marker and unsafe result path untouched', async () => {
    const input = markedCheckout()
    const root = join(input.repoRoot, '.vegastack', '.tmp', 'deps-prepare')
    let resultPath = ''
    const result = await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 1_000, execute: async () => {
      const owner = JSON.parse(readFileSync(join(root, '275.lock', 'owner.json'), 'utf8')) as { nonce: string }
      resultPath = join(root, `275.${owner.nonce}.result.json`)
      mkdirSync(resultPath)
      return { code: 0, signal: null, timedOut: false, output: '' }
    } })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('result could not be saved')
    expect(lstatSync(resultPath).isDirectory()).toBe(true)
    expect(readDroppedDeps({ repoRoot: input.repoRoot }).records.has(input.name)).toBe(true)
  })

  test('a crashed owner lock is preserved and a later attempt may retry', async () => {
    const input = markedCheckout()
    const root = join(input.repoRoot, '.vegastack', '.tmp', 'deps-prepare')
    const lock = join(root, '275.lock')
    mkdirSync(lock, { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ schema: 1, name: '275', nonce, pid: 999_999_999, startedAt: 'gone' }), { mode: 0o600 })
    const result = await restoreDroppedDependencies({ ...input, devMd, timeoutMs: 2_000,
      execute: async () => ({ code: 0, signal: null, timedOut: false, output: '' }) })
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, `.275.${nonce}.stale`))).toBe(true)
    expect(readDroppedDeps({ repoRoot: input.repoRoot }).records.has(input.name)).toBe(false)
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

  test('two separate prepare processes consume one owner result and run setup once', async () => {
    const input = markedCheckout()
    const counter = join(input.repoRoot, 'setup-count.txt')
    const release = join(input.repoRoot, 'release-setup')
    const setupScript = join(input.repoRoot, 'setup.mjs')
    writeFileSync(setupScript, [
      "import { appendFileSync, existsSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(counter)}, '1')`,
      `while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20))`,
    ].join('\n') + '\n')
    writeFileSync(join(input.repoRoot, '.vegastack', 'dev.md'), `commands: setup \`"${process.execPath}" "${setupScript}"\`\n`)
    const script = join(import.meta.dir, '../scripts/worktree.mjs')
    const children: ReturnType<typeof spawn>[] = []
    const launch = () => {
      const child = spawn(process.execPath, [script, 'prepare', '--issue', input.name, '--repo-root', input.repoRoot, '--write', '--json'],
        { cwd: input.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      return new Promise<{ code: number | null; document: { ok: boolean; preparation: { restored: boolean } }; stderr: string }>((resolve) => {
        child.on('close', (code) => resolve({ code, document: JSON.parse(stdout), stderr }))
      })
    }
    try {
      const first = launch()
      for (let attempt = 0; attempt < 100 && !existsSync(counter); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
      expect(existsSync(counter)).toBe(true)
      const second = launch()
      await new Promise((resolve) => setTimeout(resolve, 100))
      writeFileSync(release, 'go')
      const completed = await Promise.all([first, second])
      expect(completed.map((one) => one.code)).toEqual([0, 0])
      expect(completed.map((one) => one.document.preparation.restored)).toEqual([true, true])
      expect(readFileSync(counter, 'utf8')).toBe('1')
    } finally {
      writeFileSync(release, 'go')
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    }
  }, 10_000)
})

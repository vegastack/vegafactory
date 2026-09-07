import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GhUnavailable, ghJson, ghText } from '../src/gh.ts'

// The stub lives in a temp directory rather than under test/fixtures/: every test here rewrites
// it, and a fixture the suite overwrites would leave the working tree dirty on every run.
const stub = join(mkdtempSync(join(tmpdir(), 'vsk-gh-')), 'gh-stub.sh')

function writeStub(body: string): void {
  writeFileSync(stub, body)
  chmodSync(stub, 0o755)
}

const passing = '#!/bin/sh\nif [ "$1" = "boom" ]; then echo "HTTP 403: Forbidden" >&2; exit 1; fi\nprintf \'{"args":"%s"}\' "$*"\n'

describe('ghJson', () => {
  test('passes argv through untouched and parses stdout as JSON', async () => {
    writeStub(passing)
    const out = await ghJson<{ args: string }>(['api', 'user'], { gh: stub })
    expect(out.args).toBe('api user')
  })

  test('a failing gh is GhUnavailable carrying the parsed HTTP status', async () => {
    writeStub(passing)
    await expect(ghJson(['boom'], { gh: stub })).rejects.toBeInstanceOf(GhUnavailable)
    await expect(ghJson(['boom'], { gh: stub })).rejects.toMatchObject({ httpStatus: 403 })
  })

  test('unparseable stdout is GhUnavailable, never an empty result', async () => {
    writeStub('#!/bin/sh\nprintf \'not json\'\n')
    await expect(ghJson(['api', 'user'], { gh: stub })).rejects.toBeInstanceOf(GhUnavailable)
  })

  test('stdin is fed only when input is a string', async () => {
    writeStub('#!/bin/sh\ncat > /dev/null\nprintf \'{"args":"%s"}\' "$*"\n')
    expect((await ghJson<{ args: string }>(['api', 'x'], { gh: stub, input: '{}' })).args).toBe('api x')
  })

  test('a missing gh binary is GhUnavailable with a null status, never a crash', async () => {
    await expect(ghJson(['api', 'user'], { gh: '/nonexistent/gh' })).rejects.toMatchObject({ httpStatus: null })
  })
})

describe('ghText', () => {
  test('returns stdout verbatim, without parsing it', async () => {
    writeStub('#!/bin/sh\nprintf \'plain text\'\n')
    expect(await ghText(['api', 'user'], { gh: stub })).toBe('plain text')
  })
})

test('142 reproduction: deadline rejects a real child before its successful delayed exit', async () => {
  writeStub('#!/usr/bin/env node\nsetTimeout(()=>process.exit(0),500)\n')
  await expect(ghText(['api', 'user'], { gh: stub, timeoutMs: 40 })).rejects.toBeInstanceOf(GhUnavailable)
})

describe('142 bounded reads', () => {
  test('cancellation and both output streams terminate real child processes', async () => {
    const { readFileSync } = await import('node:fs')
    for (const mode of ['abort', 'stdout', 'stderr']) {
      const pidFile = join(mkdtempSync(join(tmpdir(), 'vsk-gh-pid-')), 'pid')
      writeStub(`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\n${mode === 'abort' ? '' : `process.${mode}.write('x'.repeat(8192));`}\nsetInterval(()=>{},1000)\n`)
      const controller = new AbortController()
      const promise = ghText(['api', 'user'], { gh: stub, signal: controller.signal, maxOutputBytes: 1024 })
      if (mode === 'abort') {
        for (let n = 0; n < 100; n++) {
          try { readFileSync(pidFile); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
        }
        controller.abort()
      }
      await expect(promise).rejects.toThrow(mode === 'abort' ? 'cancelled' : 'output limit')
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }
    const controller = new AbortController(); controller.abort()
    await expect(ghText(['api', 'user'], { gh: '/must-not-start', signal: controller.signal })).rejects.toThrow('cancelled')
  })

  test('remaining raw search readers explicitly refuse truncated and capped data', async () => {
    for (const value of [{ items: [], total_count: 31, incomplete_results: false }, { items: [], total_count: 1001, incomplete_results: false }, { items: [], total_count: 0, incomplete_results: true }]) {
      writeStub(`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(value))})\n`)
      await expect(ghText(['api', 'search/issues'], { gh: stub })).rejects.toThrow('search is incomplete')
    }
    writeStub('#!/usr/bin/env node\nconsole.log(JSON.stringify({items:[],total_count:0,incomplete_results:false}))\n')
    expect(await ghJson<{ items: unknown[]; total_count: number; incomplete_results: boolean }>(['api', 'search/issues'], { gh: stub })).toEqual({ items: [], total_count: 0, incomplete_results: false })
  })
})

test('142 cancellation ends a helper that inherited a real gh process pipe', async () => {
  if (process.platform === 'win32') return
  const { readFileSync } = await import('node:fs')
  const childPid = join(mkdtempSync(join(tmpdir(), 'vsk-gh-helper-')), 'pid')
  writeStub(`#!/usr/bin/env node\nrequire('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); setInterval(()=>{},1000)`)}],{stdio:'inherit'}); setInterval(()=>{},1000)\n`)
  const controller = new AbortController()
  const promise = ghText(['api', 'user'], { gh: stub, signal: controller.signal })
  for (let count = 0; count < 100; count++) {
    try { readFileSync(childPid); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  controller.abort()
  await expect(promise).rejects.toThrow('cancelled')
  const pid = Number(readFileSync(childPid, 'utf8'))
  for (let count = 0; count < 100; count++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 10)) } catch { break }
  }
  expect(() => process.kill(pid, 0)).toThrow()
})

test('142 CLI rate limits have two retries, over-budget delay refuses, and mutation calls are not replayed', async () => {
  const { fetchGhPages, readBudget } = await import('../src/gh.ts')
  let calls = 0
  const out = await fetchGhPages(async () => { calls++; throw new GhUnavailable('rate limited', 429, new Headers({ 'retry-after': '0' })) }, 'repos/a/b/issues')
  expect(out.reason).toContain('HTTP 429'); expect(calls).toBe(3)
  calls = 0
  const long = await fetchGhPages(async () => { calls++; throw new GhUnavailable('rate limited', 403, new Headers({ 'retry-after': '120' })) }, 'repos/a/b/issues')
  expect(long.reason).toContain('retry delay'); expect(calls).toBe(1)
  const timed = await fetchGhPages(async () => new Promise(() => {}), 'repos/a/b/issues', readBudget(undefined, 20))
  expect(timed.reason).toContain('deadline')
  const { readFileSync } = await import('node:fs')
  const countFile = join(mkdtempSync(join(tmpdir(), 'vsk-gh-mutation-')), 'calls')
  writeStub(`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(countFile)},'x'); console.error('HTTP 503 unavailable'); process.exit(1)\n`)
  await expect(ghText(['api', 'repos/a/b/issues/1/comments', '--method', 'POST'], { gh: stub })).rejects.toBeInstanceOf(GhUnavailable)
  expect(readFileSync(countFile, 'utf8')).toBe('x')
})

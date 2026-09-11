import { describe, expect, test } from 'bun:test'
import { checkCompiledGuard, parseGuardArgs, runGuardCli, scriptArgs } from '../src/guard.ts'

describe('parseGuardArgs', () => {
  test('sync writes by default; --check and --dry-run do not', () => {
    expect(parseGuardArgs(['sync'])).toMatchObject({ verb: 'sync', check: false, write: true, json: false })
    expect(parseGuardArgs(['sync', '--check', '--json'])).toMatchObject({ check: true, write: false, json: true })
    expect(parseGuardArgs(['sync', '--dry-run'])).toMatchObject({ write: false })
    expect(parseGuardArgs(['sync', '--dev-md', 'x/dev.md'])).toMatchObject({ devMd: 'x/dev.md' })
  })

  test('an unknown verb or option is a usage error naming the surface', () => {
    expect(() => parseGuardArgs(['reload'])).toThrow(/sync/)
    expect(() => parseGuardArgs(['sync', '--force'])).toThrow(/--force/)
    expect(() => parseGuardArgs(['sync', '--check', '--write'])).toThrow(/--check/)
  })

  test('the script argv carries exactly the mode it was asked for', () => {
    expect(scriptArgs(parseGuardArgs(['sync']))).toEqual(['--json', '--write'])
    expect(scriptArgs(parseGuardArgs(['sync', '--check']))).toEqual(['--json', '--check'])
    expect(scriptArgs(parseGuardArgs(['sync', '--dry-run', '--dev-md', 'd.md']))).toEqual(['--json', '--dev-md', 'd.md'])
  })
})

describe('runGuardCli', () => {
  test('a stale check is exit 2 and the reason reaches the user', async () => {
    const calls: string[][] = []
    const spawn = (args: string[]) => {
      calls.push(args)
      return { status: 2, stdout: JSON.stringify({ guard: 'ship-policy', ok: false, stale: true, reason: 'production moved from ask to auto', path: '/h/.vegastack/guard/acme__app.json', blocks: [], warns: [] }) }
    }
    const lines: string[] = []
    expect(await runGuardCli(['sync', '--check'], { spawn, print: (line) => lines.push(line) })).toBe(2)
    expect(calls[0]).toEqual(['--json', '--check'])
    expect(lines.join('\n')).toContain('production moved from ask to auto')
  })

  test('a write reports the path it wrote', async () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ guard: 'ship-policy', ok: true, written: true, stale: false, path: '/h/.vegastack/guard/acme__app.json', blocks: [], warns: [] }) })
    const lines: string[] = []
    expect(await runGuardCli(['sync'], { spawn, print: (line) => lines.push(line) })).toBe(0)
    expect(lines.join('\n')).toContain('/h/.vegastack/guard/acme__app.json')
  })

  test('unreadable script output is a block, never a silent success', async () => {
    const spawn = () => ({ status: 0, stdout: 'garbage' })
    const lines: string[] = []
    expect(await runGuardCli(['sync', '--json'], { spawn, print: (line) => lines.push(line) })).toBe(2)
    expect(lines.join('\n')).toContain('unreadable')
  })
})

test('standalone compiler shares org authority, provenance and refuses a group self-unlock', async () => {
  const { compilePolicy, staleness } = await import('../../../skills/dev/dev-setup/scripts/ship-policy.mjs')
  const input = { repo: 'acme/app', org: 'gates: 3\nstats: on\nstats-override: locked' }
  const policy = compilePolicy('dispatch: local', input)
  expect(policy.schemaVersion).toBe(2)
  expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(policy.sources.gates.scope).toBe('org')
  expect(() => compilePolicy('stats: off', { ...input, group: 'stats-override: allowed' })).toThrow(/delegation/)
  expect(staleness(JSON.stringify({ ...policy, policyDigest: 'b'.repeat(64) }), policy).stale).toBe(true)
})


describe('prepared compiler result contract', () => {
  const input = { checkout: '/prepared', home: '/isolated', repo: 'acme/app', policyDigest: 'a'.repeat(64) }
  const valid = { guard: 'ship-policy', ok: true, check: true, written: false, stale: false, blocks: [], policy: { schemaVersion: 2, repo: 'acme/app', policyDigest: 'a'.repeat(64), sources: {} } }
  const run = (value: unknown, status = 0) => ({ status, stdout: JSON.stringify(value), stderr: '', signal: null, pid: 1, output: [null, '', ''] })
  test('valid compiler comparison binds actual checkout argv and selected policy digest', () => {
    let called: string[] = []
    const result = checkCompiledGuard(input, (_script, args) => { called = args; return run(valid) })
    expect(result.wired).toBe(true)
    expect(result.policyDigest).toBe(input.policyDigest)
    expect(called).toEqual(['--check', '--json', '--dev-md', '/prepared/.vegastack/dev.md'])
    expect(called).not.toContain('--write')
    expect(called).not.toContain('--repo')
  })
  test('unknown/stale/wrong-source compiler envelopes never become permission', () => {
    for (const value of [null, [], {}, { ...valid, check: false }, { ...valid, written: true }, { ...valid, stale: true },
      { ...valid, policy: { ...valid.policy, schemaVersion: 1 } },
      { ...valid, policy: { ...valid.policy, repo: 'other/repo' } },
      { ...valid, policy: { ...valid.policy, policyDigest: 'b'.repeat(64) } },
      { ...valid, blocks: ['refused'] }, { ...valid, policy: { ...valid.policy, sources: null } },
    ]) expect(checkCompiledGuard(input, () => run(value)).wired, JSON.stringify(value)).toBe(false)
    expect(checkCompiledGuard(input, () => run(valid, 2)).wired).toBe(false)
    expect(checkCompiledGuard(input, () => ({ ...run(valid), stdout: 'not json' })).detail).toContain('unreadable')
    expect(checkCompiledGuard(input, () => ({ ...run(valid), signal: 'SIGKILL' as const })).detail).toContain('deadline')
  })
})


test('the real compiler process is killed at the ten-second deadline', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vf-compiler-deadline-'))
  const script = join(root, 'compiler.mjs'), pidFile = join(root, 'pid')
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)
  const previous = process.env.VSK_SHIP_POLICY_SCRIPT
  try {
    process.env.VSK_SHIP_POLICY_SCRIPT = script
    const start = Date.now()
    const result = checkCompiledGuard({ checkout: root, home: root, repo: 'acme/app' })
    expect(result.wired).toBe(false)
    expect(result.detail).toContain('deadline')
    expect(Date.now() - start).toBeGreaterThanOrEqual(9000)
    expect(Date.now() - start).toBeLessThan(13000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    if (previous === undefined) delete process.env.VSK_SHIP_POLICY_SCRIPT
    else process.env.VSK_SHIP_POLICY_SCRIPT = previous
  }
}, 15000)

import { describe, expect, test } from 'bun:test'
import { parseGuardArgs, runGuardCli, scriptArgs } from '../src/guard.ts'

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

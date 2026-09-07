import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compilePolicy, staleness } from '../scripts/ship-policy.mjs'
import { classifyCommand, readPolicyFile } from '../assets/hooks/ship-guard.mjs'

const DEV_MD = [
  'repo: acme/app · default branch trunk',
  '',
  '## Knobs',
  'gates: 2                    # 2 = approve + one "ship it"',
  '',
  '## Ship — what happens after merge, in order',
  '- auto: bunx changeset version && bun install',
  '- ask: merge the release PR — the version bump is the last reviewable moment',
  '- ask: publish the docs site with `bun run docs:publish` once the tag is out',
  '',
  '## Environments',
  '- preview: auto — wrangler deploy --env preview',
  '- production: ask — wrangler deploy --env production',
  '- npm registry via tag-triggered trusted publishing',
].join('\n')

const script = join(import.meta.dir, '..', 'scripts/ship-policy.mjs')

describe('ship-policy compiler', () => {
  test('compiles the branch, the gates knob, the grammar-shaped Environments lines and the backticked ask: commands', () => {
    const policy = compilePolicy(DEV_MD, { repo: 'acme/app' })
    expect(policy.schemaVersion).toBe(2)
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.sources['layer.repo']).toMatchObject({ scope: 'repo', path: '.vegastack/dev.md', revisionKind: 'sha256', revision: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(policy.repo).toBe('acme/app')
    expect(policy.defaultBranch).toBe('trunk')
    expect(policy.gates).toBe(2)
    expect(policy.environments).toEqual([
      { target: 'preview', policy: 'auto', pattern: 'wrangler deploy --env preview' },
      { target: 'production', policy: 'ask', pattern: 'wrangler deploy --env production' },
    ])
    // A prose ask: step is a runbook instruction, not a command pattern; only a backticked command guards.
    expect(policy.shipAsk).toEqual(['bun run docs:publish'])
  })

  test('the guard consumes compiled local and Git-backed sources without changing action gates', () => {
    for (const layers of [
      {},
      { org: 'gates: 3', group: 'tests: required', identity: { group: 'dev', roomSha: 'c'.repeat(40) } },
    ]) {
      const compiled = compilePolicy(DEV_MD, { repo: 'acme/app', ...layers })
      const read = readPolicyFile(JSON.stringify(compiled), 'acme/app')
      expect(read.missing).toBeUndefined()
      expect(read).toMatchObject({ defaultBranch: 'trunk', gates: 2, environments: compiled.environments, shipAsk: compiled.shipAsk })
      expect(classifyCommand('wrangler deploy --env preview', read).decision).toBe('allow')
      for (const command of ['wrangler deploy --env production', 'git push origin trunk', 'bun run docs:publish']) {
        expect(classifyCommand(command, read).decision, command).toBe('ask')
      }
      if (layers.org) {
        expect(compiled.sources['layer.org']).toMatchObject({ scope: 'org', revisionKind: 'git', revision: 'c'.repeat(40) })
        expect(compiled.sources['layer.group']).toMatchObject({ scope: 'group', revisionKind: 'git', revision: 'c'.repeat(40) })
      }
    }
    const empty = compilePolicy('', { repo: 'acme/app' })
    expect(empty.sources).toEqual({})
    expect(readPolicyFile(JSON.stringify(empty), 'acme/app')).toMatchObject({ gates: 3, environments: [], shipAsk: [] })
  })

  test('an empty or branch-less profile compiles to the strictest defaults', () => {
    const policy = compilePolicy('', { repo: 'acme/app' })
    expect(policy.defaultBranch).toBe('main')
    expect(policy.gates).toBe(3)
    expect(policy.environments).toEqual([])
    expect(policy.shipAsk).toEqual([])
  })

  test('staleness compares the policy fields only, so a re-compile timestamp never counts as drift', () => {
    const compiled = compilePolicy(DEV_MD, { repo: 'acme/app' })
    const fresh = JSON.stringify({ ...compiled, source: { devMd: '/x', compiledAt: '2020-01-01T00:00:00Z' } })
    expect(staleness(fresh, compiled).stale).toBe(false)
    expect(staleness(null, compiled)).toMatchObject({ stale: true, reason: expect.stringContaining('missing') })
    expect(staleness('{ nope', compiled).stale).toBe(true)
    const edited = compilePolicy(DEV_MD.replace('production: ask', 'production: auto'), { repo: 'acme/app' })
    expect(staleness(fresh, edited)).toMatchObject({ stale: true, reason: expect.stringContaining('production') })
    const otherRepo = JSON.stringify({ ...compiled, repo: 'acme/other' })
    expect(staleness(otherRepo, compiled).stale).toBe(true)
    const changedDigest = JSON.stringify({ ...compiled, policyDigest: 'a'.repeat(64) })
    expect(staleness(changedDigest, compiled)).toMatchObject({ stale: true, reason: expect.stringContaining('digest') })
    const changedSource = JSON.stringify({ ...compiled, sources: { ...compiled.sources, gates: { ...compiled.sources.gates, revision: 'b'.repeat(64) } } })
    expect(staleness(changedSource, compiled)).toMatchObject({ stale: true, reason: expect.stringContaining('sources') })
  })

  test('the script is dry-run until --write, and --check exits 2 while the file is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsk-ship-policy-'))
    const devMd = join(dir, 'dev.md')
    const policyFile = join(dir, 'guard', 'acme__app.json')
    writeFileSync(devMd, DEV_MD)
    const args = ['--dev-md', devMd, '--repo', 'acme/app', '--policy', policyFile, '--json']
    const dry = Bun.spawnSync(['node', script, ...args])
    expect(dry.exitCode).toBe(0)
    expect(JSON.parse(dry.stdout.toString())).toMatchObject({ guard: 'ship-policy', written: false, path: policyFile })
    expect(existsSync(policyFile)).toBe(false)
    const check = Bun.spawnSync(['node', script, ...args, '--check'])
    expect(check.exitCode).toBe(2)
    expect(JSON.parse(check.stdout.toString())).toMatchObject({ ok: false, stale: true })
    const write = Bun.spawnSync(['node', script, ...args, '--write'])
    expect(write.exitCode).toBe(0)
    const stored = JSON.parse(readFileSync(policyFile, 'utf8'))
    expect(stored.repo).toBe('acme/app')
    expect(stored.defaultBranch).toBe('trunk')
    expect(stored.source.devMd).toBe(devMd)
    const fresh = Bun.spawnSync(['node', script, ...args, '--check'])
    expect(fresh.exitCode).toBe(0)
    writeFileSync(devMd, DEV_MD.replace('production: ask', 'production: auto'))
    const drifted = Bun.spawnSync(['node', script, ...args, '--check'])
    expect(drifted.exitCode).toBe(2)
    expect(JSON.parse(drifted.stdout.toString()).reason).toContain('production')
  })

  test('with no dev.md the script refuses rather than compiling an empty policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsk-ship-policy-'))
    const run = Bun.spawnSync(['node', script, '--dev-md', join(dir, 'absent.md'), '--repo', 'acme/app', '--policy', join(dir, 'p.json'), '--write', '--json'])
    expect(run.exitCode).toBe(2)
    expect(JSON.parse(run.stdout.toString()).blocks.join(' ')).toContain('absent.md')
    expect(existsSync(join(dir, 'p.json'))).toBe(false)
  })
})

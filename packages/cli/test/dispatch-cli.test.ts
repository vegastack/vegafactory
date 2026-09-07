import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '../src/index.ts')
const COMPILER = join(import.meta.dir, '../../../skills/dev/dev-setup/scripts/ship-policy.mjs')
const GUARD = join(import.meta.dir, '../../../skills/dev/dev-setup/assets/hooks/ship-guard.mjs')

function fixture({ dispatch = 'local', assignees = '[]' }: { dispatch?: string; assignees?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'factory-'))
  const repo = join(home, 'app')
  mkdirSync(join(repo, '.vegastack/hooks'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.vegastack/hooks/ship-guard.mjs'), readFileSync(GUARD))
  mkdirSync(join(home, '.vegastack/guard'), { recursive: true })
  writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness claude' }] }] } }))
  writeFileSync(join(repo, '.vegastack/dev.md'), `## Knobs\n\ndispatch: ${dispatch}\noperators: mk\nplan: claude fable-5-1 high\nimplement: claude fable-5-1 high\n`)
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)
  expect(Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']).exitCode).toBe(0)
  const compiled = Bun.spawnSync(['node', COMPILER, '--write', '--json'], { cwd: repo, env: { ...process.env, HOME: home } })
  expect(compiled.exitCode, compiled.stdout.toString()).toBe(0)
  const config = join(home, 'factory.json')
  writeFileSync(config, JSON.stringify({ repos: [{ path: repo, repo: 'acme/app', org: 'acme' }] }))
  const gh = join(home, 'gh-board-stub.sh')
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'issue' && args.includes('body')) { console.log(JSON.stringify({body:'Fixture outcome.'})); process.exit(0); }
const rows = args[1]?.includes('/issues?') ? [{id:7,node_id:'I7',number:7,title:'feat: a',labels:[{name:'needs-plan'}],assignees:${assignees},updated_at:'2026-09-03T10:00:00Z'}] : [];
process.stdout.write('HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n' + JSON.stringify(rows));
`)
  chmodSync(gh, 0o755)
  return { home, repo, config, gh }
}

function run(args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync(['bun', CLI, ...args], { env: { ...process.env, VSK_SHIP_POLICY_SCRIPT: COMPILER, ...env } })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe('vegafactory dispatch', () => {
  test('--once --dry-run prints the launch plan and launches nothing', () => {
    const { home, config, gh } = fixture()
    const result = run(['dispatch', '--once', '--dry-run', '--json', '--config', config], { HOME: home, VSK_GH: gh })
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.runs).toHaveLength(1)
    expect(out.runs[0].issue).toBe(7)
    expect(out.runs[0].stage).toBe('plan')
    expect(out.runs[0].launch.command).toBe('claude')
    expect(out.runs[0].launch.args).toContain('bypassPermissions')
    expect(out.runs[0].launched).toBe(false)
  })

  test('a repo with dispatch: off is refused and the exit code says nothing ran', () => {
    const { home, config, gh } = fixture({ dispatch: 'off' })
    const result = run(['dispatch', '--once', '--dry-run', '--json', '--config', config], { HOME: home, VSK_GH: gh })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).refusals[0].reason).toContain('dispatch: off')
  })

  test('an assigned ready issue is refused by name, even though the query excluded it', () => {
    const { home, config, gh } = fixture({ assignees: '[{"login":"ada"}]' })
    const result = run(['dispatch', '--once', '--dry-run', '--json', '--config', config], { HOME: home, VSK_GH: gh })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).refusals[0].reason).toContain('assigned to ada')
  })

  test('a repo whose compiled ship-guard policy is missing is refused with the sync command', () => {
    const { home, config, gh } = fixture()
    rmSync(join(home, '.vegastack/guard/acme__app.json'))
    const result = run(['dispatch', '--once', '--dry-run', '--json', '--config', config], { HOME: home, VSK_GH: gh })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).refusals[0].reason).toContain('vegafactory guard sync')
  })

  test('--once and --watch together is a usage error', () => {
    const { home, config, gh } = fixture()
    const result = run(['dispatch', '--once', '--watch', '--config', config], { HOME: home, VSK_GH: gh })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--once')
  })

  test('an unreadable config is exit 2 and names the file, never an empty tick', () => {
    const { home, gh } = fixture()
    const result = run(['dispatch', '--once', '--dry-run', '--json', '--config', join(home, 'absent.json')], { HOME: home, VSK_GH: gh })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('factory.json')
  })

  test('dry run is the default: neither --once nor --watch launches anything', () => {
    const { home, config, gh } = fixture()
    const result = run(['dispatch', '--json', '--config', config], { HOME: home, VSK_GH: gh })
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.dryRun).toBe(true)
    expect(out.runs[0].launched).toBe(false)
  })

  test('a gh that cannot answer is a refusal naming the repo, not a crash', () => {
    const { home, config } = fixture()
    const broken = join(home, 'gh-broken.sh')
    writeFileSync(broken, '#!/bin/sh\necho "HTTP 403: rate limit" >&2\nexit 1\n')
    chmodSync(broken, 0o755)
    const result = run(['dispatch', '--once', '--dry-run', '--json', '--config', config], { HOME: home, VSK_GH: broken })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).refusals[0].reason).toContain('acme/app')
  })
})


test('an unrelated echo registration cannot produce a dispatch plan', () => {
  const { home, repo, config, gh } = fixture()
  writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify({ unrelated: { command: 'echo ship-guard.mjs' } }))
  const result = run(['dispatch', '--dry-run', '--json', '--config', config], { HOME: home, VSK_GH: gh })
  expect(result.exitCode).toBe(1)
  expect(JSON.parse(result.stdout).runs).toEqual([])
  expect(JSON.parse(result.stdout).refusals[0].reason).toContain('PreToolUse')
})

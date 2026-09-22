import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSupportedPlatform, billingVariables, childEnvironment } from '../src/env.ts'
import { checkTools, enableRepoHooks, ensureGlobalCli, nodeMajor, proposeNodeRow, usesBun, type Probe } from '../src/init.ts'

describe('subscription-only child environment', () => {
  test('parent Claude Code variables are dropped, including the desktop proxy URL', () => {
    const env = childEnvironment({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
    expect(env).toEqual({ PATH: '/bin' })
  })

  test('a Codex parent\'s session markers are dropped too, whichever tool the child is', () => {
    const env = childEnvironment({ PATH: '/bin', CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt', CODEX_HOME: '/home/.codex' })
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/home/.codex' })
  })

  test('a billing variable is never dropped as a parent\'s: it is refused by name', () => {
    expect(() => childEnvironment({ PATH: '/bin', CODEX_API_KEY: 'sk-x', CODEX_THREAD_ID: 't' })).toThrow('CODEX_API_KEY is set')
  })

  test('an API key refuses and names the variable to unset', () => {
    expect(() => childEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'sk-x' })).toThrow('OPENAI_API_KEY is set')
    expect(() => childEnvironment({ ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_USE_BEDROCK: '1' }, { insideClaudeCode: false })).toThrow('ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK are set')
  })

  test('outside Claude Code a base URL is the operator\'s own setting and refuses', () => {
    expect(() => childEnvironment({ ANTHROPIC_BASE_URL: 'https://proxy' })).toThrow('ANTHROPIC_BASE_URL is set')
  })

  test('empty or zero values are not set', () => {
    expect(billingVariables({ OPENAI_API_KEY: '', CLAUDE_CODE_USE_VERTEX: '0' })).toEqual([])
  })

  test('Windows is refused with the WSL hint', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow('WSL')
    expect(() => assertSupportedPlatform('darwin')).not.toThrow()
  })
})

function fakeProbe(results: Record<string, { code: number; stdout?: string; stderr?: string }>): { probe: Probe; calls: string[] } {
  const calls: string[] = []
  const probe: Probe = (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    calls.push(key)
    const hit = results[key] ?? { code: 127 }
    return { code: hit.code, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
  }
  return { probe, calls }
}

describe('init', () => {
  const healthy = {
    'git --version': { code: 0, stdout: 'git version 2.50' },
    'gh --version': { code: 0, stdout: 'gh 2.80' },
    'gh auth status': { code: 0 },
    'claude --version': { code: 0, stdout: '2.1.263' },
    'codex --version': { code: 1 },
    'bun --version': { code: 0, stdout: '1.3.14' },
  }

  test('a healthy machine passes every tool check', () => {
    const steps = checkTools(fakeProbe(healthy).probe, '24.3.0')
    expect(steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  test('each missing tool fails with the fix', () => {
    const steps = checkTools(fakeProbe({ ...healthy, 'gh auth status': { code: 1 }, 'claude --version': { code: 1 }, 'bun --version': { code: 127 } }).probe, '22.1.0')
    const byName = Object.fromEntries(steps.map((step) => [step.name, step]))
    expect(byName.node!.detail).toContain('install Node 24')
    expect(byName.gh!.detail).toContain('gh auth login')
    expect(byName.agents!.status).toBe('fail')
    expect(byName.bun!.status).toBe('warn')
    expect(nodeMajor('24.0.0')).toBe(24)
  })

  test('missing Bun fails only in a project that uses Bun', () => {
    const noBun = fakeProbe({ ...healthy, 'bun --version': { code: 127 } }).probe
    const bunProject = mkdtempSync(join(tmpdir(), 'init-bun-'))
    writeFileSync(join(bunProject, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.14' }))
    const lockProject = mkdtempSync(join(tmpdir(), 'init-lock-'))
    writeFileSync(join(lockProject, 'bun.lock'), '')
    const npmProject = mkdtempSync(join(tmpdir(), 'init-npm-'))
    writeFileSync(join(npmProject, 'package.json'), JSON.stringify({ packageManager: 'npm@11.0.0' }))
    const bunStep = (dir: string | null) => checkTools(noBun, '24.3.0', dir).find((step) => step.name === 'bun')!
    expect(bunStep(bunProject).status).toBe('fail')
    expect(bunStep(lockProject).status).toBe('fail')
    expect(bunStep(npmProject).status).toBe('warn')
    expect(bunStep(null).status).toBe('warn')
    expect(usesBun(bunProject)).toBe(true)
  })

  test('the global CLI is installed only when the right version is missing', () => {
    const present = fakeProbe({ 'vegafactory --version': { code: 0, stdout: '0.20.0' } })
    expect(ensureGlobalCli(present.probe, '0.20.0', false).status).toBe('ok')
    const stale = fakeProbe({ 'vegafactory --version': { code: 0, stdout: '0.19.9' }, 'npm install -g @vegastack/vegafactory@0.20.0': { code: 0 } })
    expect(ensureGlobalCli(stale.probe, '0.20.0', false).status).toBe('done')
    expect(stale.calls).toContain('npm install -g @vegastack/vegafactory@0.20.0')
    expect(ensureGlobalCli(fakeProbe({}).probe, '0.20.0', true).status).toBe('skipped')
  })

  test('the commit hook is enabled only in a repository that ships one', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'init-hooks-')))
    mkdirSync(join(repo, '.githooks'))
    const { probe, calls } = fakeProbe({
      'git rev-parse --show-toplevel': { code: 0, stdout: repo },
      'git config --get core.hooksPath': { code: 1 },
      'git config core.hooksPath .githooks': { code: 0 },
    })
    expect(enableRepoHooks(probe, repo, false).status).toBe('done')
    expect(calls).toContain('git config core.hooksPath .githooks')
    const outside = fakeProbe({ 'git rev-parse --show-toplevel': { code: 128 } })
    expect(enableRepoHooks(outside.probe, repo, false).status).toBe('skipped')
  })

  test('proposes one canonical non-worker row and mutates nothing', () => {
    const { probe, calls } = fakeProbe({ 'gh api user -q .login': { code: 0, stdout: 'kmanojkumar' } })
    expect(proposeNodeRow(probe, 'MK', 'Desk.local')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('| mk@desk | kmanojkumar | no | | | |'),
    })
    expect(calls).toEqual(['gh api user -q .login'])

    const unavailable = fakeProbe({ 'gh api user -q .login': { code: 1, stderr: 'offline' } })
    expect(proposeNodeRow(unavailable.probe, 'mk', 'desk').detail).toContain('could not read the GitHub login')
    expect(unavailable.calls).toEqual(['gh api user -q .login'])
  })
})

describe('vegafactory agent', () => {
  test('starts the tool with the child environment and returns its exit code', async () => {
    const { runAgent } = await import('../src/env.ts')
    const seen: Array<{ tool: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const spawn = ((tool: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      seen.push({ tool, args, env: options.env })
      return { status: 3 }
    }) as never
    const env = { PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'http://proxy' }
    expect(runAgent(['codex', 'exec', 'review this'], { env, spawn })).toBe(3)
    expect(seen[0]!.tool).toBe('codex')
    expect(seen[0]!.args).toEqual(['exec', 'review this'])
    expect(seen[0]!.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(seen[0]!.env.CLAUDECODE).toBeUndefined()
  })

  test('refuses an API key before starting anything', async () => {
    const { runAgent } = await import('../src/env.ts')
    let started = false
    const spawn = (() => { started = true; return { status: 0 } }) as never
    expect(() => runAgent(['claude', '-p', 'x'], { env: { OPENAI_API_KEY: 'k' }, spawn })).toThrow('OPENAI_API_KEY')
    expect(started).toBe(false)
  })

  test('only claude and codex can be started', async () => {
    const { runAgent } = await import('../src/env.ts')
    expect(() => runAgent(['bash', '-c', 'x'])).toThrow('usage: vegafactory agent claude|codex')
  })
})

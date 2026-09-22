// `vegafactory init` — one command from a fresh machine to a working setup.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { nodeId } from './claim.ts'

export interface InitStep { name: string; status: 'ok' | 'warn' | 'fail' | 'done' | 'skipped'; detail: string }
export type Probe = (cmd: string, args: string[], cwd?: string) => { code: number; stdout: string; stderr: string }

export const probe: Probe = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message }
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

export function nodeMajor(version = process.versions.node): number {
  return Number(version.split('.')[0])
}

// The tool checks, in the order a person fixes them.
// A project needs Bun when it pins it as its package manager or carries a Bun lockfile.
export function usesBun(dir: string): boolean {
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return true
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { packageManager?: string }
    return typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('bun@')
  } catch {
    return false
  }
}

export function checkTools(run: Probe, nodeVersion = process.versions.node, projectDir: string | null = null): InitStep[] {
  const steps: InitStep[] = []
  steps.push(nodeMajor(nodeVersion) >= 24
    ? { name: 'node', status: 'ok', detail: `Node ${nodeVersion}` }
    : { name: 'node', status: 'fail', detail: `Node ${nodeVersion} is too old — install Node 24 or newer` })
  const git = run('git', ['--version'])
  steps.push(git.code === 0 ? { name: 'git', status: 'ok', detail: git.stdout } : { name: 'git', status: 'fail', detail: 'git is missing — install it first' })
  const gh = run('gh', ['--version'])
  if (gh.code !== 0) steps.push({ name: 'gh', status: 'fail', detail: 'the GitHub CLI is missing — install it from https://cli.github.com' })
  else {
    const auth = run('gh', ['auth', 'status'])
    steps.push(auth.code === 0
      ? { name: 'gh', status: 'ok', detail: 'GitHub CLI signed in' }
      : { name: 'gh', status: 'fail', detail: 'the GitHub CLI is not signed in — run: gh auth login' })
  }
  const claude = run('claude', ['--version'])
  const codex = run('codex', ['--version'])
  if (claude.code !== 0 && codex.code !== 0) steps.push({ name: 'agents', status: 'fail', detail: 'neither Claude Code nor Codex is installed — install at least one' })
  else steps.push({ name: 'agents', status: 'ok', detail: [claude.code === 0 && `Claude Code ${claude.stdout}`, codex.code === 0 && codex.stdout].filter(Boolean).join(' · ') })
  const bun = run('bun', ['--version'])
  if (bun.code === 0) steps.push({ name: 'bun', status: 'ok', detail: `Bun ${bun.stdout}` })
  else if (projectDir && usesBun(projectDir)) steps.push({ name: 'bun', status: 'fail', detail: 'this project uses Bun and Bun is not installed — install it from https://bun.sh' })
  else steps.push({ name: 'bun', status: 'warn', detail: 'Bun is not installed — only needed to work on Bun projects' })
  return steps
}

// Installs the CLI globally when it is not already on PATH at this version.
export function ensureGlobalCli(run: Probe, version: string, dryRun: boolean): InitStep {
  const current = run('vegafactory', ['--version'])
  if (current.code === 0 && current.stdout === version) return { name: 'cli', status: 'ok', detail: `vegafactory ${version} on PATH` }
  if (dryRun) return { name: 'cli', status: 'skipped', detail: `would run: npm install -g @vegastack/vegafactory@${version}` }
  const installed = run('npm', ['install', '-g', `@vegastack/vegafactory@${version}`])
  return installed.code === 0
    ? { name: 'cli', status: 'done', detail: `installed vegafactory ${version} globally` }
    : { name: 'cli', status: 'fail', detail: `npm install -g failed: ${installed.stderr.split('\n').at(-1) ?? ''} — install it by hand: npm install -g @vegastack/vegafactory` }
}

// Turns on the repository's commit hook when the repository ships one.
export function enableRepoHooks(run: Probe, cwd: string, dryRun: boolean): InitStep {
  const top = run('git', ['rev-parse', '--show-toplevel'], cwd)
  if (top.code !== 0) return { name: 'hooks', status: 'skipped', detail: 'not inside a git repository' }
  if (!existsSync(join(top.stdout, '.githooks'))) return { name: 'hooks', status: 'skipped', detail: 'this repository has no .githooks folder' }
  const current = run('git', ['config', '--get', 'core.hooksPath'], top.stdout)
  if (current.stdout === '.githooks') return { name: 'hooks', status: 'ok', detail: 'commit hook already enabled' }
  if (dryRun) return { name: 'hooks', status: 'skipped', detail: 'would run: git config core.hooksPath .githooks' }
  const set = run('git', ['config', 'core.hooksPath', '.githooks'], top.stdout)
  return set.code === 0 ? { name: 'hooks', status: 'done', detail: 'enabled the commit hook' } : { name: 'hooks', status: 'fail', detail: set.stderr }
}

// Enrolment stays an operator-owned control-room PR. Init contributes the two facts this machine
// can prove — its derived node id and the signed-in GitHub login — and grants nothing (`worker:
// no`). It prints the row and has no write path of its own.
export function proposeNodeRow(run: Probe, user = userInfo().username, host = hostname()): InitStep {
  const node = nodeId(user, host)
  const login = run('gh', ['api', 'user', '-q', '.login'])
  if (login.code !== 0 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login.stdout.trim())) {
    return { name: 'node', status: 'warn', detail: `could not read the GitHub login for ${node} — rerun after \`gh auth login\`, then add its worker: no row through an operator-owned control-room PR` }
  }
  const row = `| ${node} | ${login.stdout.trim()} | no | | | |`
  return { name: 'node', status: 'warn', detail: `proposed nodes.md row (copy into an operator-owned control-room PR): ${row}` }
}

export function renderSteps(steps: InitStep[]): string {
  const mark: Record<InitStep['status'], string> = { ok: 'ok  ', done: 'done', warn: 'warn', fail: 'FAIL', skipped: 'skip' }
  return steps.map((step) => `${mark[step.status]}  ${step.name.padEnd(7)} ${step.detail}`).join('\n')
}

export const NEXT_STEP = 'Next: open your project in Claude Code or Codex and say "set up the dev workflow".'

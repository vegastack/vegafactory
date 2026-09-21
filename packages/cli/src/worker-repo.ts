import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { repositoryReason } from './control-room.ts'
import { ensureHarnessHooks, verifyHarnessHooks } from './harness-hooks.ts'
import type { HomeOptions } from './home.ts'
import { factoryHome, workerRepositoriesDirectory } from './home.ts'
import { assertRepo } from './issue-cache.ts'
import { withLock } from './issue-cache.ts'

export type RepoCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => { code: number; stdout: string; stderr: string }

export type CheckoutResult =
  | { ok: true; repo: string; root: string; created: boolean }
  | { ok: false; repo: string; reason: string }

// GitHub repository identity is case-insensitive. Validate before canonicalizing so wildcard and
// path-like values can never become worker-owned filesystem paths.
export function canonicalRepository(repo: string): string {
  return assertRepo(repo).toLowerCase()
}

export function workerRepositoryDirectory(repo: string, options: HomeOptions = {}): string {
  return join(workerRepositoriesDirectory(options), canonicalRepository(repo).replace('/', '__'))
}

export function workerCheckoutDirectory(repo: string, options: HomeOptions = {}): string {
  return join(workerRepositoryDirectory(repo, options), 'repo')
}

const defaultRun: RepoCommand = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message }
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function safeEnvironment(token: string | null, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('GIT_CONFIG_') || name === 'GH_TOKEN' || name === 'GITHUB_TOKEN') continue
    env[name] = value
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  })
  if (token !== null) Object.assign(env, {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
  })
  return env
}

function sanitize(reason: unknown, token: string): string {
  let text = reason instanceof Error ? reason.message : String(reason)
  if (token) text = text.split(token).join('[redacted]')
  text = text.replace(/https:\/\/[^/@\s]+@github\.com/gi, 'https://[redacted]@github.com')
  return text.replace(/[\r\n]+/g, ' ').slice(0, 300)
}

function ensureOwnedDirectories(stateRoot: string, repositoryDirectory: string): void {
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) throw new Error('the worker state path must be absolute and canonical')
  if (!repositoryDirectory.startsWith(stateRoot + sep)) throw new Error('the worker repository path is outside the worker state directory')
  const stateExisted = existsSync(stateRoot)
  let cursor = parse(stateRoot).root
  for (const part of stateRoot.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 })
    const info = lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`refusing an unsafe worker state path at ${cursor}`)
  }
  const state = lstatSync(stateRoot)
  const uid = process.getuid?.()
  if (uid !== undefined && state.uid !== uid) throw new Error(`refusing a worker state path owned by uid ${state.uid}: ${stateRoot}`)
  if ((state.mode & 0o777) !== 0o700) {
    if (stateExisted) throw new Error(`refusing a pre-existing worker state path that is not owner-only: ${stateRoot}`)
    chmodSync(stateRoot, 0o700)
  }
  for (const part of repositoryDirectory.slice(stateRoot.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 })
    const info = lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`refusing an unsafe worker path at ${cursor}`)
    if (uid !== undefined && info.uid !== uid) throw new Error(`refusing a worker path owned by uid ${info.uid}: ${cursor}`)
    if ((info.mode & 0o777) !== 0o700) chmodSync(cursor, 0o700)
  }
}

function pathReason(stateRoot: string, path: string): string | null {
  let cursor = stateRoot
  if (!existsSync(cursor)) return `nothing at ${cursor}`
  const state = lstatSync(cursor)
  if (!state.isDirectory() || state.isSymbolicLink()) return `refusing a symlinked path at ${cursor}`
  for (const part of path.slice(stateRoot.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) return `nothing at ${cursor}`
    const info = lstatSync(cursor)
    if (info.isSymbolicLink()) return `refusing a symlinked path at ${cursor}`
  }
  return null
}

function exactCheckout(
  stateRoot: string,
  root: string,
  expectedRemote: string,
  run: RepoCommand,
  env: NodeJS.ProcessEnv,
): string | null {
  const unsafe = pathReason(stateRoot, root)
  if (unsafe) return unsafe
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) return `${root} is not an ordinary directory`
  const uid = process.getuid?.()
  if (uid !== undefined && info.uid !== uid) return `refusing a worker checkout owned by uid ${info.uid}`
  const shape = repositoryReason(root)
  if (shape) return shape
  const origin = run('git', ['--no-replace-objects', '-C', root, 'remote', 'get-url', '--all', 'origin'], { env: safeEnvironment(null, env) })
  const fetchUrls = origin.stdout.trim().split('\n').filter(Boolean)
  if (origin.code !== 0 || fetchUrls.length !== 1 || fetchUrls.some(url => url !== expectedRemote)) return `the worker checkout origin is not exactly ${expectedRemote}`
  const push = run('git', ['--no-replace-objects', '-C', root, 'remote', 'get-url', '--push', '--all', 'origin'], { env: safeEnvironment(null, env) })
  const pushUrls = push.stdout.trim().split('\n').filter(Boolean)
  if (push.code !== 0 || pushUrls.length !== 1 || pushUrls.some(url => url !== expectedRemote)) return `the worker checkout push origin is not exactly ${expectedRemote}`
  const head = run('git', ['--no-replace-objects', '-C', root, 'rev-parse', '--verify', 'HEAD'], { env: safeEnvironment(null, env) })
  if (head.code !== 0 || !/^[a-f0-9]{40}$/i.test(head.stdout.trim())) return 'the worker checkout has no readable HEAD'
  return null
}

export async function ensureWorkerCheckout(input: {
  repo: string
  home: string
  token: string
  env?: NodeJS.ProcessEnv
  run?: RepoCommand
  lock?: { timeoutMs?: number; staleMs?: number }
}): Promise<CheckoutResult> {
  let repo: string
  try { repo = canonicalRepository(input.repo) }
  catch (error) { return { ok: false, repo: input.repo.toLowerCase(), reason: sanitize(error, input.token) } }
  const run = input.run ?? defaultRun
  const env = input.env ?? process.env
  let temporary: string | null = null
  try {
    const homeOptions = { home: input.home, env }
    const stateRoot = factoryHome(homeOptions)
    const repositoryDirectory = workerRepositoryDirectory(repo, homeOptions)
    const root = workerCheckoutDirectory(repo, homeOptions)
    const expectedRemote = `https://github.com/${repo}.git`
    if (!input.token) throw new Error('repository provisioning requires an installation token')
    ensureOwnedDirectories(stateRoot, repositoryDirectory)
    return withLock(repositoryDirectory, () => {
      if (existsSync(root)) {
        const reason = exactCheckout(stateRoot, root, expectedRemote, run, env)
        if (reason) throw new Error(reason)
        chmodSync(root, 0o700)
        ensureHarnessHooks(root)
        const hooks = verifyHarnessHooks(root)
        if (!hooks.ok) throw new Error(hooks.reason)
        return { ok: true, repo, root, created: false } as CheckoutResult
      }

      temporary = join(repositoryDirectory, `.repo.tmp-${randomUUID()}`)
      mkdirSync(temporary, { mode: 0o700 })
      const cloned = run('git', ['--no-replace-objects', 'clone', '--no-checkout', '--origin', 'origin', expectedRemote, temporary], {
        env: safeEnvironment(input.token, env),
      })
      if (cloned.code !== 0) throw new Error(`git clone failed (exit ${cloned.code})`)
      const beforeCheckout = exactCheckout(stateRoot, temporary, expectedRemote, run, env)
      // A no-checkout clone has a resolvable HEAD even before its worktree is populated.
      if (beforeCheckout) throw new Error(beforeCheckout)
      const checkedOut = run('git', ['--no-replace-objects', '-C', temporary, 'checkout', '--quiet', '--detach', 'HEAD'], {
        env: safeEnvironment(null, env),
      })
      if (checkedOut.code !== 0) throw new Error(`git checkout failed (exit ${checkedOut.code})`)
      const reason = exactCheckout(stateRoot, temporary, expectedRemote, run, env)
      if (reason) throw new Error(reason)
      ensureHarnessHooks(temporary)
      const hooks = verifyHarnessHooks(temporary)
      if (!hooks.ok) throw new Error(hooks.reason)
      if (existsSync(root)) {
        const winner = exactCheckout(stateRoot, root, expectedRemote, run, env)
        if (winner) throw new Error(`another provisioner left an unusable checkout: ${winner}`)
        chmodSync(root, 0o700)
        ensureHarnessHooks(root)
        return { ok: true, repo, root, created: false } as CheckoutResult
      }
      renameSync(temporary, root)
      temporary = null
      return { ok: true, repo, root, created: true } as CheckoutResult
    }, { timeoutMs: input.lock?.timeoutMs ?? 120_000, staleMs: input.lock?.staleMs, what: 'worker checkout provisioning' })
  } catch (error) {
    return { ok: false, repo, reason: sanitize(error, input.token) }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}

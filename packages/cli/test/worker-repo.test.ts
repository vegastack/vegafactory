import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerBoardsPath } from '../src/home.ts'
import { ensureHarnessHooks, verifyHarnessHooks } from '../src/harness-hooks.ts'
import {
  canonicalRepository,
  ensureWorkerCheckout,
  type RepoCommand,
  workerCheckoutDirectory,
  workerRepositoryDirectory,
} from '../src/worker-repo.ts'

const homes: string[] = []
const temporaryHome = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'worker-repo-')))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const git = (args: string[], cwd?: string) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  if (result.status !== 0) throw new Error(result.stderr)
  return (result.stdout ?? '').trim()
}

const safeDefaultState = (home: string) => mkdirSync(join(home, '.vegafactory'), { mode: 0o700 })

function repositoryAt(path: string, origin = 'https://github.com/o/r.git') {
  mkdirSync(path, { recursive: true })
  git(['init', '--quiet', path])
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(['add', 'README.md'], path)
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '-m', 'fixture'], path)
  git(['remote', 'add', 'origin', origin], path)
}

function cloningRunner(calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []): RepoCommand {
  return (command, args, options) => {
    calls.push({ command, args: [...args], env: { ...(options.env ?? {}) } })
    if (args.includes('clone')) {
      const target = args.at(-1)!
      repositoryAt(target, args.at(-2))
      const claude = '{\n  "unrelated" : { "spacing": true },\n  "hooks": {"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"keep me"}]}]}\n}\n'
      const codex = '{"theme":"dark","hooks":{}}\n'
      mkdirSync(join(target, '.claude'), { recursive: true })
      mkdirSync(join(target, '.codex'), { recursive: true })
      writeFileSync(join(target, '.claude', 'settings.json'), claude)
      writeFileSync(join(target, '.codex', 'hooks.json'), codex)
      return { code: 0, stdout: options.env?.GH_TOKEN ?? '', stderr: '' }
    }
    const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

test('case variants name one owned checkout and machine state is repo-independent', () => {
  const options = { env: {}, home: '/home/worker' }
  const repositoryDirectory = join('/home/worker', '.vegafactory', 'worker', 'repos', 'org__repo')

  expect(canonicalRepository('Org/Repo')).toBe('org/repo')
  expect(workerRepositoryDirectory('Org/Repo', options)).toBe(repositoryDirectory)
  expect(workerCheckoutDirectory('Org/Repo', options)).toBe(join(repositoryDirectory, 'repo'))
  expect(workerCheckoutDirectory('org/repo', options)).toBe(workerCheckoutDirectory('Org/Repo', options))
  expect(workerBoardsPath(options)).toBe(join('/home/worker', '.vegafactory', 'worker', 'boards.json'))
})

test('invalid and wildcard repository names never become owned paths', () => {
  const options = { env: {}, home: '/home/worker' }

  for (const repo of ['*', 'all', 'owner', '../repo', 'owner/..', 'owner/repo/extra']) {
    expect(() => workerCheckoutDirectory(repo, options)).toThrow('invalid repository')
  }
})

test('hook wiring merges all seven events while preserving every byte outside hooks', () => {
  const root = temporaryHome()
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, '.codex'))
  const claude = '{\n  "unrelated" : { "spacing": true },\n  "hooks": {"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"keep me"}]}]},\n  "tail" : [ 1, 2 ]\n}\n'
  const codex = '{ "unrelated":true }\n'
  writeFileSync(join(root, '.claude/settings.json'), claude)
  writeFileSync(join(root, '.codex/hooks.json'), codex)

  const outsideHooks = (source: string) => source.replace(/"hooks"\s*:\s*\{.*\}(?=,\n  "tail")/s, '"hooks":<merged>')
  const result = ensureHarnessHooks(root)
  const updated = readFileSync(join(root, '.claude/settings.json'), 'utf8')

  expect(result.changed.sort()).toEqual(['.claude/settings.json', '.codex/hooks.json'])
  expect(outsideHooks(updated)).toBe(outsideHooks(claude))
  expect(updated).toContain('keep me')
  expect(JSON.parse(updated).unrelated).toEqual({ spacing: true })
  expect(JSON.parse(updated).tail).toEqual([1, 2])
  expect(verifyHarnessHooks(root)).toEqual({ ok: true })
  expect(ensureHarnessHooks(root).changed).toEqual([])
})

test('hook merge replaces source and binary invocations while preserving prefix lookalikes', () => {
  const root = temporaryHome()
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, '.codex'))
  const lookalike = 'echo vegafactory hook stop --harness claude'
  const source = 'bun /repo/packages/cli/src/index.ts hook stop --harness claude'
  const absolute = '/usr/local/bin/vegafactory hook stop --harness claude'
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: 'command', command: lookalike }, { type: 'command', command: source }, { type: 'command', command: absolute },
  ] }] } }))
  writeFileSync(join(root, '.codex/hooks.json'), '{}')
  ensureHarnessHooks(root)
  const serialized = JSON.stringify(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks.Stop)
  expect(serialized).toContain(lookalike)
  expect(serialized).not.toContain(source)
  expect(serialized).not.toContain(absolute)
  expect(serialized.match(/vegafactory hook stop --harness claude/g)).toHaveLength(2) // echo lookalike + one managed command
})

test('escaped hooks spelling is preserved and duplicate semantic keys are refused without a write', () => {
  const escaped = temporaryHome()
  mkdirSync(join(escaped, '.claude'))
  mkdirSync(join(escaped, '.codex'))
  writeFileSync(join(escaped, '.claude/settings.json'), '{"\\u0068ooks":{},"x":2}\n')
  writeFileSync(join(escaped, '.codex/hooks.json'), '{}\n')

  ensureHarnessHooks(escaped)
  expect(readFileSync(join(escaped, '.claude/settings.json'), 'utf8').startsWith('{"\\u0068ooks":')).toBe(true)

  const duplicate = temporaryHome()
  mkdirSync(join(duplicate, '.claude'))
  mkdirSync(join(duplicate, '.codex'))
  const before = '{"hooks":{},"\\u0068ooks":{},"sentinel":true}\n'
  writeFileSync(join(duplicate, '.claude/settings.json'), before)
  writeFileSync(join(duplicate, '.codex/hooks.json'), '{}\n')

  expect(() => ensureHarnessHooks(duplicate)).toThrow('duplicate top-level hooks keys')
  expect(readFileSync(join(duplicate, '.claude/settings.json'), 'utf8')).toBe(before)
  expect(readFileSync(join(duplicate, '.codex/hooks.json'), 'utf8')).toBe('{}\n')
})

test('malformed, non-object, and symlinked hook configuration is refused without touching its target', () => {
  for (const source of ['{"hooks":', '[]']) {
    const root = temporaryHome()
    mkdirSync(join(root, '.claude'))
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.claude/settings.json'), source)
    writeFileSync(join(root, '.codex/hooks.json'), '{}\n')
    expect(() => ensureHarnessHooks(root)).toThrow()
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(source)
    expect(readFileSync(join(root, '.codex/hooks.json'), 'utf8')).toBe('{}\n')
  }

  const root = temporaryHome()
  const target = join(root, 'outside.json')
  writeFileSync(target, '{"outside":true}\n')
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, '.codex'))
  symlinkSync(target, join(root, '.claude/settings.json'))
  writeFileSync(join(root, '.codex/hooks.json'), '{}\n')
  expect(() => ensureHarnessHooks(root)).toThrow('safe regular file')
  expect(readFileSync(target, 'utf8')).toBe('{"outside":true}\n')
})

test('an interrupted two-file hook merge stays monotonic and retry preserves a concurrent edit', () => {
  const root = temporaryHome()
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, '.codex'))
  const claude = '{"owner":"claude","hooks":{}}\n'
  const codex = '{"owner":"codex","hooks":{}}\n'
  writeFileSync(join(root, '.claude/settings.json'), claude)
  writeFileSync(join(root, '.codex/hooks.json'), codex)

  expect(() => ensureHarnessHooks(root, 'vegafactory', {
    beforePublish: path => { if (path === '.codex/hooks.json') throw new Error('injected stop') },
  })).toThrow('injected stop')
  expect(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).owner).toBe('claude')
  expect(readFileSync(join(root, '.codex/hooks.json'), 'utf8')).toBe(codex)

  writeFileSync(join(root, '.codex/hooks.json'), '{ "owner" : "independent edit", "hooks" : {} }\n')
  ensureHarnessHooks(root)
  expect(JSON.parse(readFileSync(join(root, '.codex/hooks.json'), 'utf8')).owner).toBe('independent edit')
  expect(verifyHarnessHooks(root)).toEqual({ ok: true })
})

test('clone is accepted atomically without disclosing its token and hooks are merged', async () => {
  const home = temporaryHome()
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const trace = join(home, 'git-trace.log')
  const result = await ensureWorkerCheckout({
    repo: 'O/R', home, token: 'ghs_secret', run: cloningRunner(calls),
    env: {
      ...process.env,
      GIT_TRACE: trace, GIT_TRACE2_EVENT: trace, GIT_CURL_VERBOSE: '1',
      GIT_CONFIG_PARAMETERS: "'credential.helper'='!human-helper'", GIT_ASKPASS: '/tmp/human-askpass',
      SSH_AUTH_SOCK: '/tmp/human-agent', GIT_SSH_COMMAND: 'ssh -i /keys/human',
      GH_CONFIG_DIR: '/home/human/.config/gh', GH_ENTERPRISE_TOKEN: 'human-enterprise',
    },
  })

  expect(result).toEqual({
    ok: true,
    repo: 'o/r',
    root: join(home, '.vegafactory', 'worker', 'repos', 'o__r', 'repo'),
    created: true,
  })
  if (!result.ok) throw new Error(result.reason)
  expect(calls.flatMap(call => call.args).join(' ')).not.toContain('ghs_secret')
  expect(calls.filter(call => call.env.GH_TOKEN === 'ghs_secret')).toHaveLength(1)
  expect(calls.filter(call => call.env.GITHUB_TOKEN === 'ghs_secret')).toHaveLength(1)
  expect(calls.some(call => call.env.GIT_TRACE || call.env.GIT_TRACE2_EVENT || call.env.GIT_CURL_VERBOSE)).toBe(false)
  for (const name of ['GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR', 'GH_ENTERPRISE_TOKEN']) {
    expect(calls.some(call => call.env[name]), name).toBe(false)
  }
  expect(existsSync(trace)).toBe(false)
  expect(readFileSync(join(result.root, '.git/config'), 'utf8')).not.toContain('ghs_secret')
  expect(readFileSync(join(result.root, '.claude/settings.json'), 'utf8')).not.toContain('ghs_secret')
  expect(JSON.parse(readFileSync(join(result.root, '.claude/settings.json'), 'utf8')).unrelated).toEqual({ spacing: true })
  expect(verifyHarnessHooks(result.root)).toEqual({ ok: true })
  expect(readdirSync(workerRepositoryDirectory('o/r', { home, env: {} })).filter(name => name.includes('.tmp-'))).toEqual([])
})

test('an existing exact checkout is verified, wired, and never recloned', async () => {
  const home = temporaryHome()
  safeDefaultState(home)
  const root = workerCheckoutDirectory('o/r', { home, env: {} })
  repositoryAt(root)
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []

  expect(await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner(calls) })).toEqual({
    ok: true, repo: 'o/r', root, created: false,
  })
  expect(calls.some(call => call.args[0] === 'clone')).toBe(false)
  expect(verifyHarnessHooks(root)).toEqual({ ok: true })
})

test('dry-run previews missing and existing checkouts without creating or wiring anything', async () => {
  const missingHome = temporaryHome()
  expect(await ensureWorkerCheckout({ repo: 'o/r', home: missingHome, token: 'secret', run: cloningRunner(), dryRun: true })).toMatchObject({ ok: true, created: true })
  expect(existsSync(join(missingHome, '.vegafactory'))).toBe(false)

  const home = temporaryHome()
  safeDefaultState(home)
  const root = workerCheckoutDirectory('o/r', { home, env: {} })
  repositoryAt(root)
  const before = {
    config: readFileSync(join(root, '.git/config'), 'utf8'),
    readme: readFileSync(join(root, 'README.md'), 'utf8'),
    names: readdirSync(root).sort(),
  }
  expect(await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner(), dryRun: true })).toEqual({
    ok: true, repo: 'o/r', root, created: false, plannedHooks: ['.claude/settings.json', '.codex/hooks.json'],
  })
  expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(before.config)
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(before.readme)
  expect(readdirSync(root).sort()).toEqual(before.names)
  expect(existsSync(join(root, '.claude'))).toBe(false)
  expect(existsSync(join(root, '.codex'))).toBe(false)
})

test('dry-run and real provisioning refuse malformed and symlinked hook files without changing bytes', async () => {
  for (const dryRun of [true, false]) {
    const home = temporaryHome()
    safeDefaultState(home)
    const root = workerCheckoutDirectory('o/r', { home, env: {} })
    repositoryAt(root)
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude/settings.json'), '{broken')
    const before = readFileSync(join(root, '.claude/settings.json'), 'utf8')
    const malformed = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner(), dryRun })
    expect(malformed.ok).toBe(false)
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(before)
  }

  for (const dryRun of [true, false]) {
    const home = temporaryHome()
    safeDefaultState(home)
    const root = workerCheckoutDirectory('o/r', { home, env: {} })
    repositoryAt(root)
    mkdirSync(join(root, '.claude'))
    const outside = join(home, `outside-${dryRun}.json`)
    writeFileSync(outside, '{"kept":true}')
    symlinkSync(outside, join(root, '.claude/settings.json'))
    const linked = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner(), dryRun })
    expect(linked.ok).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('{"kept":true}')
  }
})

test('an extra origin push URL is refused without mutating the checkout', async () => {
  const home = temporaryHome()
  safeDefaultState(home)
  const root = workerCheckoutDirectory('o/r', { home, env: {} })
  repositoryAt(root)
  git(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/o/r.git'], root)
  git(['remote', 'set-url', '--add', '--push', 'origin', 'https://attacker.invalid/o/r.git'], root)
  const before = readFileSync(join(root, '.git/config'), 'utf8')
  const beforeMode = lstatSync(root).mode & 0o777

  const result = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner() })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected refusal')
  expect(result.reason).toContain('push origin is not exactly')
  expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(before)
  expect(lstatSync(root).mode & 0o777).toBe(beforeMode)
  expect(existsSync(join(root, '.claude'))).toBe(false)
})

test.each(['symlink', 'wrong-origin', 'partial-repository'] as const)('%s final path is left untouched', async kind => {
  const home = temporaryHome()
  safeDefaultState(home)
  const root = workerCheckoutDirectory('o/r', { home, env: {} })
  mkdirSync(workerRepositoryDirectory('o/r', { home, env: {} }), { recursive: true })
  if (kind === 'symlink') {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, root, 'dir')
  } else if (kind === 'wrong-origin') repositoryAt(root, 'https://github.com/o/other.git')
  else {
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'sentinel'), 'partial')
  }
  const before = kind === 'symlink' ? readlinkSync(root) : readFileSync(join(root, kind === 'wrong-origin' ? '.git/config' : 'sentinel'), 'utf8')
  const result = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'ghs_secret', run: cloningRunner() })

  expect(result.ok).toBe(false)
  expect(lstatSync(root).isSymbolicLink()).toBe(kind === 'symlink')
  expect(kind === 'symlink' ? readlinkSync(root) : readFileSync(join(root, kind === 'wrong-origin' ? '.git/config' : 'sentinel'), 'utf8')).toBe(before)
})

test('a symlinked worker ancestor is refused without writing through it', async () => {
  const home = temporaryHome()
  safeDefaultState(home)
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(join(home, '.vegafactory', 'worker'), { recursive: true })
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(home, '.vegafactory', 'worker', 'repos'), 'dir')

  const result = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner() })

  expect(result.ok).toBe(false)
  expect(readdirSync(elsewhere)).toEqual([])
})

test('failed provisioning removes only its attempt and a retry succeeds without leaking diagnostics', async () => {
  const home = temporaryHome()
  const failed: RepoCommand = (_command, _args, options) => ({ code: 1, stdout: '', stderr: `remote said ${options.env?.GH_TOKEN}` })
  const first = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'token.[secret]', run: failed })

  expect(first.ok).toBe(false)
  if (first.ok) throw new Error('expected failure')
  expect(first.reason).not.toContain('token.[secret]')
  expect(existsSync(workerCheckoutDirectory('o/r', { home, env: {} }))).toBe(false)
  expect(await ensureWorkerCheckout({ repo: 'o/r', home, token: 'token.[secret]', run: cloningRunner() })).toMatchObject({ ok: true, created: true })
})

test('a dead provision owner is recovered and a live owner is never stolen', async () => {
  const recoveredHome = temporaryHome()
  safeDefaultState(recoveredHome)
  const recoveredDirectory = workerRepositoryDirectory('o/r', { home: recoveredHome, env: {} })
  const dead = spawnSync('true').pid!
  mkdirSync(join(recoveredDirectory, '.lock'), { recursive: true })
  writeFileSync(join(recoveredDirectory, '.lock', 'owner.json'), JSON.stringify({ token: 'dead', pid: dead, host: hostname(), at: Date.now() }))

  expect(await ensureWorkerCheckout({
    repo: 'o/r', home: recoveredHome, token: 'secret', run: cloningRunner(), lock: { timeoutMs: 1000, staleMs: 1 },
  })).toMatchObject({ ok: true, created: true })
  expect(existsSync(join(recoveredDirectory, '.lock'))).toBe(false)

  const liveHome = temporaryHome()
  safeDefaultState(liveHome)
  const liveDirectory = workerRepositoryDirectory('o/r', { home: liveHome, env: {} })
  mkdirSync(join(liveDirectory, '.lock'), { recursive: true })
  writeFileSync(join(liveDirectory, '.lock', 'owner.json'), JSON.stringify({ token: 'live', pid: process.pid, host: hostname(), at: 0 }))
  const blocked = await ensureWorkerCheckout({
    repo: 'o/r', home: liveHome, token: 'secret', run: cloningRunner(), lock: { timeoutMs: 100, staleMs: 1 },
  })
  expect(blocked.ok).toBe(false)
  expect(JSON.parse(readFileSync(join(liveDirectory, '.lock', 'owner.json'), 'utf8')).token).toBe('live')
})

test('a provisioner releases only the lock nonce it acquired', async () => {
  const home = temporaryHome()
  const repositoryDirectory = workerRepositoryDirectory('o/r', { home, env: {} })
  const base = cloningRunner()
  const run: RepoCommand = (command, args, options) => {
    const result = base(command, args, options)
    if (args.includes('clone')) {
      writeFileSync(join(repositoryDirectory, '.lock', 'owner.json'), JSON.stringify({
        token: 'replacement', pid: process.pid, host: hostname(), at: Date.now(),
      }))
    }
    return result
  }

  expect(await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run })).toMatchObject({ ok: true, created: true })
  expect(JSON.parse(readFileSync(join(repositoryDirectory, '.lock', 'owner.json'), 'utf8')).token).toBe('replacement')
})

test('worker-owned repository directories and an accepted checkout are owner-only', async () => {
  const home = temporaryHome()
  mkdirSync(join(home, '.vegafactory', 'worker'), { recursive: true, mode: 0o700 })
  chmodSync(join(home, '.vegafactory'), 0o700)
  chmodSync(join(home, '.vegafactory', 'worker'), 0o755)

  const result = await ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run: cloningRunner() })

  expect(result.ok).toBe(true)
  for (const path of [
    join(home, '.vegafactory'),
    join(home, '.vegafactory', 'worker'),
    join(home, '.vegafactory', 'worker', 'repos'),
    workerRepositoryDirectory('o/r', { home, env: {} }),
    workerCheckoutDirectory('o/r', { home, env: {} }),
  ]) expect(lstatSync(path).mode & 0o777).toBe(0o700)
})

test('VEGAFACTORY_HOME is the only state root used for provisioning', async () => {
  const defaultHome = temporaryHome()
  const alternateParent = temporaryHome()
  const stateRoot = join(alternateParent, 'factory-state')
  const env = { ...process.env, VEGAFACTORY_HOME: stateRoot }

  const result = await ensureWorkerCheckout({ repo: 'o/r', home: defaultHome, env, token: 'secret', run: cloningRunner() })

  expect(result).toEqual({
    ok: true,
    repo: 'o/r',
    root: join(stateRoot, 'worker', 'repos', 'o__r', 'repo'),
    created: true,
  })
  expect(existsSync(join(defaultHome, '.vegafactory'))).toBe(false)
  expect(existsSync(join(stateRoot, 'worker', 'repos', 'o__r', 'repo'))).toBe(true)
})

test('an invalid VEGAFACTORY_HOME is returned as a checkout refusal', async () => {
  const home = temporaryHome()
  const result = await ensureWorkerCheckout({
    repo: 'o/r', home, env: { ...process.env, VEGAFACTORY_HOME: 'relative-state' }, token: 'secret', run: cloningRunner(),
  })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected refusal')
  expect(result.reason).toContain('VEGAFACTORY_HOME must be an absolute path')
  expect(existsSync(join(home, '.vegafactory'))).toBe(false)
})

test('an unsafe pre-existing custom state root is refused without changing its mode', async () => {
  const home = temporaryHome()
  const alternateParent = temporaryHome()
  const stateRoot = join(alternateParent, 'custom-state')
  mkdirSync(stateRoot, { mode: 0o755 })
  chmodSync(stateRoot, 0o755)

  const result = await ensureWorkerCheckout({
    repo: 'o/r', home, env: { ...process.env, VEGAFACTORY_HOME: stateRoot }, token: 'secret', run: cloningRunner(),
  })

  expect(result.ok).toBe(false)
  expect(lstatSync(stateRoot).mode & 0o777).toBe(0o755)
  expect(existsSync(join(stateRoot, 'worker'))).toBe(false)

  const preview = await ensureWorkerCheckout({
    repo: 'o/r', home, env: { ...process.env, VEGAFACTORY_HOME: stateRoot }, token: 'secret', run: cloningRunner(), dryRun: true,
  })
  expect(preview.ok).toBe(false)
  expect(lstatSync(stateRoot).mode & 0o777).toBe(0o755)
})

test('concurrent provisioning accepts one created checkout and independently verifies the winner', async () => {
  const home = temporaryHome()
  const run = cloningRunner()
  const results = await Promise.all([
    ensureWorkerCheckout({ repo: 'o/r', home, token: 'secret', run }),
    ensureWorkerCheckout({ repo: 'O/R', home, token: 'secret', run }),
  ])

  expect(results.filter(result => result.ok && result.created)).toHaveLength(1)
  expect(results.filter(result => result.ok && !result.created)).toHaveLength(1)
  expect(verifyHarnessHooks(workerCheckoutDirectory('o/r', { home, env: {} }))).toEqual({ ok: true })
})

test('two processes contend on one provision lock and only one clones', async () => {
  const home = temporaryHome()
  const barrier = temporaryHome()
  const fixture = join(import.meta.dir, 'fixtures', 'worker-repo-provision-child.ts')
  const spawnChild = () => Bun.spawn([process.execPath, fixture, home, barrier], { stdout: 'pipe' as const, stderr: 'pipe' as const })
  const children: Array<ReturnType<typeof spawnChild>> = []
  const markers = (prefix: string) => readdirSync(barrier).filter(name => name.startsWith(prefix))
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for provision fixture')
      await Bun.sleep(20)
    }
  }

  children.push(spawnChild())
  await waitFor(() => markers('entered-').length === 1)
  children.push(spawnChild())
  await waitFor(() => markers('started-').length === 2)
  await Bun.sleep(150)
  expect(markers('entered-')).toHaveLength(1)
  writeFileSync(join(barrier, 'release'), '')

  const output = await Promise.all(children.map(async child => {
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const code = await child.exited
    if (code !== 0) throw new Error(stderr || stdout)
    return JSON.parse(stdout) as { result: { ok: boolean; created: boolean }; entered: boolean }
  }))
  expect(output.filter(row => row.result.ok && row.result.created)).toHaveLength(1)
  expect(output.filter(row => row.result.ok && !row.result.created)).toHaveLength(1)
  expect(output.filter(row => row.entered)).toHaveLength(1)
})

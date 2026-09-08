import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const packageRoot = resolve(import.meta.dir, '..')
const sourceMode = process.env.VF_SYNC_SOURCE_TEST === '1'
const executable = sourceMode ? process.execPath : 'node'
const assembledCli = process.env.VF_SYNC_CLI_PATH
const cli = assembledCli ?? join(packageRoot, sourceMode ? 'src/index.ts' : 'dist/index.js')
let root = '', origin = ''
function git(args: string[], cwd: string) {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const run = (home: string, cwd: string, args: string[]) => Bun.spawnSync([executable, cli, ...args], { cwd, env: { ...process.env, HOME: home } })
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sync-cli-147-')))
  if (!sourceMode && !assembledCli) {
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: packageRoot })
    if (build.exitCode) throw new Error(build.stderr.toString())
  }
  const source = join(root, 'source'); origin = join(root, 'origin.git')
  await mkdir(join(source, 'groups/dev'), { recursive: true })
  await writeFile(join(source, 'org.md'), 'stats: on\nsync-max-age: 2h\n')
  await writeFile(join(source, 'groups/dev/group.md'), 'review: subagent\n')
  await writeFile(join(source, 'repos.md'), '| repo | group | board | owner |\n|---|---|---|---|\n| acme/app | dev | | owner |\n')
  git(['init', '-b', 'main'], source); git(['add', '.'], source); git(['commit', '-m', 'seed'], source); git(['clone', '--bare', source, origin], root)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
async function project(name: string, profile = 'repo: acme/app\ncontrol-room: acme/room#dev\nsync-max-age: 2h\n') {
  const home = join(root, name), repo = join(home, 'repo')
  await mkdir(join(repo, '.vegastack'), { recursive: true }); await mkdir(join(home, '.vegastack'), { recursive: true })
  await writeFile(join(repo, '.vegastack/dev.md'), profile)
  git(['init', '-b', 'main'], repo); git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], repo)
  await writeFile(join(home, '.vegastack/factory.json'), JSON.stringify({ schemaVersion: 1, marker: 'preserved', repos: [{ repo: 'acme/app', org: 'acme', path: repo }], controlRooms: { acme: { repo: 'acme/room', remote: origin, path: join(home, 'operator-room'), branch: 'main', sha: null, lastSyncedAt: null } } }))
  return { home, repo, settingsPath: join(home, '.vegastack/factory.json') }
}
test('actual CLI owns exactly one publication and no-op/dry-run write nothing', async () => {
  const f = await project('basic')
  const dryBefore = await readFile(f.settingsPath, 'utf8')
  expect(run(f.home, f.repo, ['sync', '--dry-run', '--json']).exitCode).toBe(0)
  expect(await readFile(f.settingsPath, 'utf8')).toBe(dryBefore)
  const first = run(f.home, f.repo, ['sync', '--json'])
  expect(first.exitCode).toBe(0)
  const payload = JSON.parse(first.stdout.toString())
  expect(payload.sha).toMatch(/^[a-f0-9]{40}$/)
  let wire = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(wire).toMatchObject({ schemaVersion: 2, revision: 1, marker: 'preserved' })
  expect(wire.controlRooms.acme.snapshots['acme/app'].sourceCommit).toBe(payload.sha)
  const saved = await readFile(f.settingsPath, 'utf8')
  expect(JSON.parse(run(f.home, f.repo, ['sync', '--json']).stdout.toString()).action).toBe('fresh')
  expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  expect(run(f.home, f.repo, ['sync', '--force', '--json']).exitCode).toBe(0)
  wire = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(wire.revision).toBe(2)
  expect(wire.controlRooms.acme.snapshots['acme/app'].sourceCommit).toBe(payload.sha)
})
test('missing target, malformed/unknown schema and interrupted first setup preserve settings', async () => {
  const f = await project('no-target', 'review: subagent\n')
  const saved = await readFile(f.settingsPath, 'utf8')
  expect(JSON.parse(run(f.home, f.repo, ['sync', '--json']).stdout.toString()).action).toBe('none')
  expect(run(f.home, f.repo, ['sync', '--org', 'acme', '--json']).exitCode).toBe(2)
  expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  for (const text of ['{bad', '{"schemaVersion":99,"operator":"retained"}']) {
    await writeFile(f.settingsPath, text)
    expect(run(f.home, f.repo, ['sync', '--json']).exitCode).toBe(2)
    expect(await readFile(f.settingsPath, 'utf8')).toBe(text)
  }
})
test('two actual CLI processes and a transaction editor retain every completed publication', async () => {
  const f = await project('concurrent')
  const children = [1, 2].map(() => Bun.spawn([executable, cli, 'sync', '--json'], { cwd: f.repo, env: { ...process.env, HOME: f.home }, stdout: 'pipe', stderr: 'pipe' }))
  const { updateSettings } = await import('../src/control-room.ts')
  await updateSettings(join(f.home, '.vegastack'), s => ({ ...s, settings: { ...s.settings, concurrentMachineSetting: 42 } }))
  const codes = await Promise.all(children.map(child => child.exited))
  expect(codes).toContain(0)
  const wire = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(wire.concurrentMachineSetting).toBe(42)
  expect(wire.revision).toBeGreaterThanOrEqual(2)
  expect(wire.controlRooms.acme.snapshots['acme/app'].policyDigest).toMatch(/^[a-f0-9]{64}$/)
})

test('actual CLI inspects backups, previews without mutation and applies without renewing authority', async () => {
  const f = await project('recovery')
  expect(run(f.home, f.repo, ['sync', '--json']).exitCode).toBe(0)
  expect(run(f.home, f.repo, ['sync', '--force', '--json']).exitCode).toBe(0)
  const saved = await readFile(f.settingsPath, 'utf8')
  const wire = JSON.parse(saved)
  const backup = wire.controlRooms.acme.history[0]
  const inspected = run(f.home, f.repo, ['sync', 'inspect', '--json'])
  expect(inspected.exitCode).toBe(0)
  expect(JSON.parse(inspected.stdout.toString())).toMatchObject({ current: { ok: true }, history: [{ ok: true, snapshots: backup }] })
  for (const flags of [[], ['--dry-run'], ['--backup', '0']]) {
    const preview = run(f.home, f.repo, ['sync', 'restore', ...flags, '--json'])
    expect(preview.exitCode).toBe(0)
    expect(JSON.parse(preview.stdout.toString())).toMatchObject({ applied: false, snapshots: backup })
    expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  }
  const applied = run(f.home, f.repo, ['sync', 'restore', '--backup', '0', '--apply', '--json'])
  expect(applied.exitCode).toBe(0)
  expect(JSON.parse(applied.stdout.toString())).toMatchObject({ applied: true, snapshots: backup })
  const restored = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(restored.revision).toBe(wire.revision + 1)
  expect(restored.controlRooms.acme.snapshots).toEqual({})
  expect(restored.controlRooms.acme.recovery).toMatchObject({ snapshots: backup, requiresFetch: true })
  const refreshed = run(f.home, f.repo, ['sync', '--json'])
  expect(refreshed.exitCode).toBe(0)
  expect(JSON.parse(refreshed.stdout.toString()).action).not.toBe('fresh')
  const fresh = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(fresh.controlRooms.acme.snapshots['acme/app'].sourceCommit).toBe(backup['acme/app'].sourceCommit)
  expect(fresh.controlRooms.acme.recovery).toBeUndefined()
})
test('actual CLI refuses invalid recovery combinations before no-target success', async () => {
  const f = await project('recovery-no-target', 'review: subagent\n')
  const saved = await readFile(f.settingsPath, 'utf8')
  const cases: [string[], string][] = [
    [['unknown'], 'sync accepts inspect or restore'],
    [['--apply'], '--apply requires sync restore'],
    [['inspect', '--apply'], '--apply requires sync restore'],
    [['restore', '--apply', '--dry-run'], '--apply requires sync restore'],
    [['--backup', '0'], '--backup requires sync restore'],
    [['inspect', '--backup', '0'], '--backup requires sync restore'],
    ...['-1', '1.5', 'NaN', '9007199254740992', ''].map(value => [['restore', '--backup', value], '--backup requires a non-negative integer'] as [string[], string]),
    [['restore', '--backup'], '--backup requires a non-negative integer'],
  ]
  for (const [flags, message] of cases) {
    const result = run(f.home, f.repo, ['sync', ...flags])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(message)
    expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  }
})
test('actual CLI refuses a backup with a malformed digest without changing settings', async () => {
  const f = await project('recovery-malformed')
  expect(run(f.home, f.repo, ['sync', '--json']).exitCode).toBe(0)
  expect(run(f.home, f.repo, ['sync', '--force', '--json']).exitCode).toBe(0)
  const wire = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  wire.controlRooms.acme.history[0]['acme/app'].policyDigest = '0'.repeat(64)
  await writeFile(f.settingsPath, JSON.stringify(wire))
  const saved = await readFile(f.settingsPath, 'utf8')
  for (const flags of [[], ['--apply']]) {
    const result = run(f.home, f.repo, ['sync', 'restore', ...flags, '--json'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('digest')
    expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  }
})

test('actual CLI help explains explicit recovery and fresh-fetch requirements', () => {
  const result = run(root, root, ['--help'])
  expect(result.exitCode).toBe(0)
  const help = result.stdout.toString()
  expect(help).toContain('vegafactory sync inspect')
  expect(help).toContain('vegafactory sync restore [--backup N] [--apply]')
  expect(help).toContain('Recovery previews by default')
  expect(help).toContain('successful fetch before authority resumes')
  expect(help).toContain('1 a command error')
})

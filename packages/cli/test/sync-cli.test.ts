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
  root = await realpath(await mkdtemp(join(tmpdir(), 'sync-cli-221-')))
  if (!sourceMode && !assembledCli) {
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: packageRoot })
    if (build.exitCode) throw new Error(build.stderr.toString())
  }
  const source = join(root, 'source'); origin = join(root, 'origin.git')
  await mkdir(join(source, 'groups/dev'), { recursive: true })
  await writeFile(join(source, 'org.md'), 'stats: on\ntests: required   # locked\n')
  await writeFile(join(source, 'groups/dev/group.md'), 'merge: rebase\n')
  await writeFile(join(source, 'repos.md'), '| repo | group | board | owner |\n|---|---|---|---|\n| acme/app | dev | none | owner |\n')
  git(['init', '-b', 'main'], source); git(['add', '.'], source); git(['commit', '-m', 'seed'], source); git(['clone', '--bare', source, origin], root)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
async function project(name: string, profile = 'repo: acme/app\ncontrol-room: acme/room#dev\n') {
  const home = join(root, name), repo = join(home, 'repo')
  await mkdir(join(repo, '.vegastack'), { recursive: true }); await mkdir(join(home, '.vegafactory'), { recursive: true })
  await writeFile(join(repo, '.vegastack/dev.md'), profile)
  git(['init', '-b', 'main'], repo); git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], repo)
  await writeFile(join(home, '.vegafactory/factory.json'), JSON.stringify({ schemaVersion: 1, marker: 'preserved', controlRooms: { acme: { repo: 'acme/room', remote: origin, path: join(home, '.vegafactory/control-room/acme'), branch: 'main', sha: null, lastSyncedAt: null } } }))
  return { home, repo, settingsPath: join(home, '.vegafactory/factory.json'), clonePath: join(home, '.vegafactory/control-room/acme') }
}
test('the CLI fetches once, leaves a fresh copy alone, and a dry run writes nothing', async () => {
  const f = await project('basic')
  const dryBefore = await readFile(f.settingsPath, 'utf8')
  expect(run(f.home, f.repo, ['sync', '--dry-run', '--json']).exitCode).toBe(0)
  expect(await readFile(f.settingsPath, 'utf8')).toBe(dryBefore)

  const first = run(f.home, f.repo, ['sync', '--json'])
  expect(first.exitCode).toBe(0)
  const payload = JSON.parse(first.stdout.toString())
  expect(payload.action).toBe('clone')
  expect(payload.sha).toMatch(/^[a-f0-9]{40}$/)
  expect(payload.path).toBe(f.clonePath)
  expect(await readFile(join(f.clonePath, 'org.md'), 'utf8')).toContain('stats: on')

  const wire = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(wire).toMatchObject({ schemaVersion: 2, revision: 1, marker: 'preserved' })
  expect(wire.controlRooms.acme.sha).toBe(payload.sha)

  const saved = await readFile(f.settingsPath, 'utf8')
  expect(JSON.parse(run(f.home, f.repo, ['sync', '--json']).stdout.toString()).action).toBe('fresh')
  expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  expect(run(f.home, f.repo, ['sync', '--force', '--json']).exitCode).toBe(0)
  expect(JSON.parse(await readFile(f.settingsPath, 'utf8')).revision).toBe(2)
})
test('missing target, malformed settings and an unknown subcommand preserve settings', async () => {
  const f = await project('no-target', 'tests: required\n')
  const saved = await readFile(f.settingsPath, 'utf8')
  expect(JSON.parse(run(f.home, f.repo, ['sync', '--json']).stdout.toString()).action).toBe('none')
  expect(run(f.home, f.repo, ['sync', '--org', 'acme', '--json']).exitCode).toBe(2)
  const unknown = run(f.home, f.repo, ['sync', 'inspect'])
  expect(unknown.exitCode).toBe(1)
  expect(unknown.stderr.toString()).toContain('sync takes no subcommand except profile')
  expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  for (const text of ['{bad', '{"schemaVersion":99,"operator":"retained"}']) {
    await writeFile(f.settingsPath, text)
    expect(run(f.home, f.repo, ['sync', '--json']).exitCode).toBe(2)
    expect(await readFile(f.settingsPath, 'utf8')).toBe(text)
  }
})
// The one supported way to read the room. Every check the reader makes runs behind it, which is
// the point: a skill that opens org.md in the copy instead goes around all of them.
test('sync profile prints the resolved profile, its sources and its refusals', async () => {
  const f = await project('profile')
  const bare = run(f.home, f.repo, ['sync', 'profile', '--json'])
  expect(bare.exitCode).toBe(1)
  expect(JSON.parse(bare.stdout.toString()).blocks.join(' ')).toMatch(/no validated commit — run: vegafactory sync/)

  expect(run(f.home, f.repo, ['sync', '--json']).exitCode).toBe(0)
  const result = run(f.home, f.repo, ['sync', 'profile', '--json'])
  expect(result.exitCode).toBe(0)
  const profile = JSON.parse(result.stdout.toString())
  expect(profile.blocks).toEqual([])
  expect(profile.ok).toBe(true)
  expect(profile.room).toMatchObject({ org: 'acme', repo: 'acme/room', group: 'dev' })
  expect(profile.sha).toMatch(/^[a-f0-9]{40}$/)
  expect(profile.values).toMatchObject({ tests: 'required', merge: 'rebase' })
  expect(profile.sources).toMatchObject({ tests: 'org', merge: 'group' })
  expect(profile.locked).toEqual(['tests'])

  // Plain output names the layer each value came from.
  const plain = run(f.home, f.repo, ['sync', 'profile'])
  expect(plain.exitCode).toBe(0)
  expect(plain.stdout.toString()).toMatch(/merge: rebase\s+# group/)

  // A repo that tries to answer a locked line is told, and the command exits non-zero.
  await writeFile(join(f.repo, '.vegastack/dev.md'), 'repo: acme/app\ncontrol-room: acme/room#dev\ntests: none\n')
  const refused = run(f.home, f.repo, ['sync', 'profile', '--json'])
  expect(refused.exitCode).toBe(1)
  const blocked = JSON.parse(refused.stdout.toString())
  expect(blocked.ok).toBe(false)
  expect(blocked.blocks.join(' ')).toMatch(/tests is locked in org\.md/)
  expect(blocked.values.tests).toBe('required')
})

// A control-room line that cannot be read must stop the CLI, not resolve to "no control room".
test('a malformed or duplicated control-room line refuses at the CLI', async () => {
  for (const [name, profile, pattern] of [
    ['bad-value', 'repo: acme/app\ncontrol-room: not a room\n', /invalid control-room value/],
    ['duplicate', 'repo: acme/app\ncontrol-room: acme/room#dev\ncontrol-room: other/room#dev\n', /duplicate policy key: control-room/],
  ] as const) {
    const f = await project(name, profile)
    const saved = await readFile(f.settingsPath, 'utf8')
    const result = run(f.home, f.repo, ['sync', '--json'])
    expect(result.exitCode, name).toBe(2)
    expect(JSON.parse(result.stdout.toString()).message).toMatch(pattern)
    expect(await readFile(f.settingsPath, 'utf8')).toBe(saved)
  }
})

test('two CLI processes and a transaction editor retain every completed publication', async () => {
  const f = await project('concurrent')
  const children = [1, 2].map(() => Bun.spawn([executable, cli, 'sync', '--json'], { cwd: f.repo, env: { ...process.env, HOME: f.home }, stdout: 'pipe', stderr: 'pipe' }))
  const { updateSettings } = await import('../src/control-room.ts')
  await updateSettings(join(f.home, '.vegafactory'), s => ({ ...s, settings: { ...s.settings, concurrentMachineSetting: 42 } }))
  const codes = await Promise.all(children.map(child => child.exited))
  expect(codes).toContain(0)
  const wire = JSON.parse(await readFile(f.settingsPath, 'utf8'))
  expect(wire.concurrentMachineSetting).toBe(42)
  expect(wire.controlRooms.acme.sha).toMatch(/^[a-f0-9]{40}$/)
})

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFactoryConfig, serializeFactoryConfig, updateSettings, getPolicySnapshot } from '../src/control-room.ts'
import { resolveTarget, syncControlRoom, inspectSnapshots, restoreSnapshot } from '../src/sync.ts'
let root = '', origin = '', source = ''
const NOW = Date.parse('2026-09-06T07:00:00Z')
const DEV_MD = 'repo: acme/app\ncontrol-room: acme/room#dev\nsync-max-age: 2h\n'
function git(args: string[], cwd: string) {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sync-147-')))
  source = join(root, 'source'); origin = join(root, 'origin.git')
  await mkdir(join(source, 'groups/dev'), { recursive: true })
  await writeFile(join(source, 'org.md'), 'stats: on\nsync-max-age: 2h\n')
  await writeFile(join(source, 'groups/dev/group.md'), 'review: subagent\n')
  await writeFile(join(source, 'repos.md'), '| repo | group | board | owner |\n|---|---|---|---|\n| acme/app | dev | | owner |\n| acme/other | dev | | owner |\n')
  git(['init', '-b', 'main'], source); git(['add', '.'], source); git(['commit', '-m', 'seed'], source)
  git(['clone', '--bare', source, origin], root)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
async function fixture(name: string) {
  const home = join(root, name), settings = join(home, '.vegastack')
  await mkdir(settings, { recursive: true })
  const config = readFactoryConfig(JSON.stringify({ schemaVersion: 1, extension: 'kept', controlRooms: { acme: { repo: 'acme/room', remote: origin, path: join(home, 'operator-room'), branch: 'main', sha: null, lastSyncedAt: null } } }))
  await writeFile(join(settings, 'factory.json'), JSON.stringify(serializeFactoryConfig(config)))
  const target = resolveTarget({ devMdText: DEV_MD, config, home })!
  return { home, settings, config, target }
}
test('validated per-repo snapshot is published once; unchanged commit refresh renews only validation', async () => {
  const f = await fixture('same')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  expect(first.sha).toMatch(/^[a-f0-9]{40}$/)
  const saved = JSON.stringify(first.config)
  expect(first.config.revision).toBe(1)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toContain('stats: on')
  const noOp = await syncControlRoom({ ...f, config: first.config, now: NOW + 1000 })
  expect(noOp.action).toBe('fresh')
  const second = await syncControlRoom({ ...f, config: first.config, now: NOW + 7200000, force: true })
  expect(second.ok).toBe(true)
  expect(second.sha).toBe(first.sha)
  expect(second.config.revision).toBe(2)
  expect(second.lastSyncedAt).not.toBe(first.lastSyncedAt)
  expect(JSON.stringify(first.config)).toBe(saved)
  const snapshot = await getPolicySnapshot('acme', 'acme/app', NOW + 14400000, { settingsPath: f.target.settingsPath, devMd: DEV_MD })
  expect(snapshot.state).toBe('stale')
  expect(snapshot.snapshot?.policyDigest).toBe(first.config.controlRooms.acme!.snapshots!['acme/app']!.policyDigest)
})
test('malformed fetched policy preserves exact settings and immutable old content', async () => {
  const f = await fixture('invalid')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  const saved = await readFile(f.target.settingsPath, 'utf8')
  await writeFile(join(source, 'org.md'), 'stats: nonsense\n')
  git(['add', '.'], source); git(['commit', '-m', 'malformed'], source); git(['push', origin, 'main'], source)
  const next = await syncControlRoom({ ...f, config: first.config, now: NOW + 1000, force: true })
  expect(next.ok).toBe(false)
  expect(next.message).toContain(first.sha!)
  expect(await readFile(f.target.settingsPath, 'utf8')).toBe(saved)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toContain('stats: on')
  git(['revert', '--no-edit', 'HEAD'], source); git(['push', origin, 'main'], source)
})
test('wrong origin, dirty source and conflicting bootstrap never change last good state', async () => {
  const f = await fixture('refuse')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  const saved = await readFile(f.target.settingsPath, 'utf8')
  const wrong = await syncControlRoom({ ...f, config: first.config, target: { ...f.target, remote: '/wrong' }, now: NOW, force: true })
  expect(wrong.ok).toBe(false)
  await writeFile(join(first.path, 'org.md'), 'operator edit\n')
  const dirty = await syncControlRoom({ ...f, config: first.config, now: NOW, force: true })
  expect(dirty.ok).toBe(false)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toBe('operator edit\n')
  expect(await readFile(f.target.settingsPath, 'utf8')).toBe(saved)
  expect(() => resolveTarget({ ...f, devMdText: DEV_MD, config: { ...f.config, settings: { machine: { group: 'other', controlRoom: { repo: 'acme/room' } } } } })).toThrow(/bootstrap/)
})
test('two syncs and an unrelated settings editor preserve committed updates', async () => {
  const f = await fixture('concurrent')
  const module = new URL('../src/sync.ts', import.meta.url).pathname
  const children = [1, 2].map(() => Bun.spawn([process.execPath, '-e', `import {syncControlRoom} from ${JSON.stringify(module)}; const r=await syncControlRoom(${JSON.stringify({ target: f.target, config: f.config, now: NOW })}); console.log(JSON.stringify(r));`], { stdout: 'pipe', stderr: 'pipe' }))
  await updateSettings(f.settings, s => ({ ...s, settings: { ...s.settings, editor: 'preserved' } }))
  const results = await Promise.all(children.map(async child => { expect(await child.exited).toBe(0); return JSON.parse(await new Response(child.stdout).text()) }))
  expect(results.some(r => r.ok)).toBe(true)
  const wire = JSON.parse(await readFile(f.target.settingsPath, 'utf8'))
  expect(wire.editor).toBe('preserved')
  expect(wire.controlRooms.acme.snapshots['acme/app'].sourceCommit).toMatch(/^[a-f0-9]{40}$/)
  expect(wire.revision).toBeGreaterThanOrEqual(2)
})
test('dry run and interrupted candidate publication do not migrate settings', async () => {
  const f = await fixture('interrupted')
  const before = await readFile(f.target.settingsPath, 'utf8')
  expect((await syncControlRoom({ ...f, now: NOW, dryRun: true })).ok).toBe(true)
  expect(await readFile(f.target.settingsPath, 'utf8')).toBe(before)
  await mkdir(f.target.settingsPath + '.guard')
  const result = await syncControlRoom({ ...f, now: NOW })
  expect(result.ok).toBe(false)
  expect(await readFile(f.target.settingsPath, 'utf8')).toBe(before)
})
test('inspect and restore verify provenance, retain old validation time, and default to dry run', async () => {
  const f = await fixture('restore')
  const first = await syncControlRoom({ ...f, now: NOW })
  const second = await syncControlRoom({ ...f, config: first.config, now: NOW + 1000, force: true })
  expect(second.ok).toBe(true)
  const codeRepo = join(f.home, 'code-repo')
  await mkdir(join(codeRepo, '.vegastack'), { recursive: true })
  await writeFile(join(codeRepo, '.vegastack/dev.md'), DEV_MD)
  git(['init', '-b', 'main'], codeRepo); git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], codeRepo)
  const sourceRoot = new URL('../../../', import.meta.url).pathname
  const runbook = await readFile(join(sourceRoot, 'skills/factory/vegafactory-setup/references/control-room.md'), 'utf8')
  const script = /bun --eval '\n([\s\S]*?)\n'\n/.exec(runbook)![1]!
  const inspected = Bun.spawnSync([process.execPath, '--eval', script], { cwd: sourceRoot, env: { ...process.env, VF_SETTINGS_PATH: f.target.settingsPath, VF_REPO_PATH: codeRepo } })
  expect(inspected.exitCode).toBe(0)
  expect(JSON.parse(inspected.stdout.toString()).history[0].ok).toBe(true)
  const inspection = await inspectSnapshots({ target: f.target, now: NOW + 7200000 })
  expect(inspection.history[0]?.ok).toBe(true)
  const before = await readFile(f.target.settingsPath, 'utf8')
  expect((await restoreSnapshot({ target: f.target, index: 0, now: NOW + 7200000 })).applied).toBe(false)
  expect(await readFile(f.target.settingsPath, 'utf8')).toBe(before)
  expect((await restoreSnapshot({ target: f.target, index: 0, now: NOW + 7200000, apply: true })).applied).toBe(true)
  const restored = await getPolicySnapshot('acme', 'acme/app', NOW + 7200000, { settingsPath: f.target.settingsPath, devMd: DEV_MD })
  expect(restored.state).toBe('unavailable')
  const wire = JSON.parse(await readFile(f.target.settingsPath, 'utf8'))
  expect(wire.controlRooms.acme.recovery.snapshots['acme/app'].validatedAt).toBe(first.lastSyncedAt)
})

test('enrollment publication verifies repository ID, host, installation, account and enabled registry from one snapshot', async () => {
  const { chmod } = await import('node:fs/promises')
  const { readHostBinding } = await import('../src/machine-identity.ts')
  const f = await fixture('enrolled')
  const room = join(f.home, 'room-source'), remote = join(f.home, 'room.git'), bin = join(f.home, 'bin')
  await mkdir(join(room, 'groups/dev'), { recursive: true }); await mkdir(bin)
  // Enrollment is produced by the canonical identity owner, independently of sync.
  const { digest: hostBindingDigest } = await readHostBinding()
  const installationId = '12345678-1234-4123-8123-123456789013'
  const fleet = { schemaVersion: 1, coordination: { repositoryId: 'R_room', repository: 'acme/room', branch: 'factory-state', rootCommit: 'b'.repeat(40), installationId: '12345678-1234-4123-8123-123456789012' }, defaults: { pollSeconds: 120, maxRuns: 1, childConcurrent: 3, checkpoints: 'task-branch', recovery: 'verified-transfer' }, groupDefaults: {}, machines: {
    'dev-box': { installationId, hostBindingDigest, executionLogin: 'owner', group: 'dev', repositories: ['acme/app'], enabled: true, overrides: {} },
    'other-box': { installationId: '12345678-1234-4123-8123-123456789014', hostBindingDigest: 'd'.repeat(64), executionLogin: 'owner', group: 'dev', repositories: ['acme/app'], enabled: true, overrides: {} },
  } }
  const org = () => 'sync-max-age: 2h\npolicy-schema: 2\n```vsk-policy\n' + JSON.stringify({ schemaVersion: 2, fleet }) + '\n```\n'
  await writeFile(join(room, 'org.md'), org())
  await writeFile(join(room, 'groups/dev/group.md'), 'review: subagent\n')
  await writeFile(join(room, 'people.csv'), 'login,name,role,slack,timezone,groups\nowner,Owner,lead,,UTC,dev\n')
  await writeFile(join(room, 'repos.md'), '| repo | group | board | owner | repository-id |\n|---|---|---|---|---|\n| acme/app | dev | | owner | R_app |\n')
  git(['init', '-b', 'main'], room); git(['add', '.'], room); git(['commit', '-m', 'enrollment'], room); git(['clone', '--bare', room, remote], root)
  const actualGit = Bun.which('git')!
  // A deterministic local provider fixture: Git object reads remain real; only the remote
  // fetch transport and read-only GitHub identity responses are replaced. No live qualification.
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process'; let a=process.argv.slice(2); const f=a.indexOf('fetch'); if(f>=0) { const o=a.indexOf('origin',f); if(o>=0) a[o]=${JSON.stringify(remote)}; } const r=spawnSync(${JSON.stringify(actualGit)},a,{stdio:'inherit'}); process.exit(r.status??1);\n`)
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nconst endpoint=process.argv[3]; console.log(JSON.stringify(endpoint==='user'?{login:'owner'}:{node_id:endpoint==='repos/acme/room'?'R_room':'R_app',full_name:endpoint.slice(6),permissions:{pull:true}}));\n`)
  await chmod(join(bin, 'git'), 0o755); await chmod(join(bin, 'gh'), 0o755)
  const machine = { id: 'dev-box', installationId, hostBindingDigest, group: 'dev', controlRoom: { repositoryId: 'R_room', repo: 'acme/room', remote: 'https://github.com/acme/room.git', branch: 'main' } }
  await updateSettings(f.settings, s => { s.orgs.acme!.remote = machine.controlRoom.remote; s.settings.machine = machine; return s })
  const config = readFactoryConfig(await readFile(f.target.settingsPath, 'utf8'))
  const target = resolveTarget({ devMdText: DEV_MD, config, home: f.home })!
  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath}`
  try {
    const first = await syncControlRoom({ target, config, now: NOW })
    expect(first.ok).toBe(true)
    const saved = await readFile(target.settingsPath, 'utf8')
    expect(first.config.controlRooms.acme!.repositoryId).toBe('R_room')
    await updateSettings(f.settings, s => { s.settings.machine = { ...machine, hostBindingDigest: '0'.repeat(64) }; return s })
    const copiedSettings = await readFile(target.settingsPath, 'utf8')
    const copiedConfig = readFactoryConfig(copiedSettings)
    const copied = await syncControlRoom({ target, config: copiedConfig, now: NOW + 1000 })
    expect(copied.ok).toBe(false)
    expect(copied.message).toContain('host binding mismatch')
    expect(await readFile(target.settingsPath, 'utf8')).toBe(copiedSettings)
    await writeFile(target.settingsPath, saved)
    fleet.machines['dev-box'].enabled = false
    await writeFile(join(room, 'org.md'), org()); git(['add', '.'], room); git(['commit', '-m', 'disable'], room); git(['push', remote, 'main'], room)
    const disabled = await syncControlRoom({ target, config: first.config, now: NOW + 2000, force: true })
    expect(disabled.ok).toBe(false)
    expect(disabled.message).toContain('disabled')
    expect(await readFile(target.settingsPath, 'utf8')).toBe(saved)
  } finally { process.env.PATH = oldPath }
}, 20000)

test('multiple repo bindings publish together, swapped rows deny, and older active content survives backup retention', async () => {
  const f = await fixture('bindings')
  for (const name of ['app', 'other']) {
    const path = join(f.home, name)
    await mkdir(join(path, '.vegastack'), { recursive: true })
    await writeFile(join(path, '.vegastack/dev.md'), DEV_MD.replace('acme/app', `acme/${name}`))
    git(['init', '-b', 'main'], path); git(['remote', 'add', 'origin', `https://github.com/acme/${name}.git`], path)
  }
  await updateSettings(f.settings, s => ({ ...s, settings: { ...s.settings, repos: ['app', 'other'].map(name => ({ repo: `acme/${name}`, org: 'acme', path: join(f.home, name) })) } }))
  let config = readFactoryConfig(await readFile(f.target.settingsPath, 'utf8'))
  const first = await syncControlRoom({ ...f, config, now: NOW })
  expect(first.ok).toBe(true)
  expect(Object.keys(first.config.controlRooms.acme!.snapshots!).sort()).toEqual(['acme/app', 'acme/other'])
  const rows = first.config.controlRooms.acme!.snapshots!
  expect(rows['acme/app']!.policyDigest).not.toBe(rows['acme/other']!.policyDigest)
  await updateSettings(f.settings, s => { const snapshots = s.orgs.acme!.snapshots!; [snapshots['acme/app'], snapshots['acme/other']] = [snapshots['acme/other']!, snapshots['acme/app']!]; return s })
  expect((await getPolicySnapshot('acme', 'acme/app', NOW, { settingsPath: f.target.settingsPath, devMd: DEV_MD })).state).toBe('unavailable')
  // Restore fixture pointer order through the same transaction before exercising retention.
  await updateSettings(f.settings, s => { s.orgs.acme!.snapshots = rows; return s })
  config = readFactoryConfig(await readFile(f.target.settingsPath, 'utf8'))
  for (let index = 1; index <= 3; index++) {
    const next = await syncControlRoom({ ...f, config, now: NOW + index * 1000, force: true })
    expect(next.ok).toBe(true); config = next.config
  }
  expect(config.controlRooms.acme!.history).toHaveLength(2)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toContain('stats: on')
  expect(config.controlRooms.acme!.path).not.toBe(Object.values(config.controlRooms.acme!.snapshots!)[0]!.contentPath)
}, 20000)

test('discovery spreads polling and backs off network failures without changing policy expiry', async () => {
  const { discoveryDelayMs } = await import('../src/dispatch.ts')
  expect(discoveryDelayMs(120, 0, 0)).toBe(120000)
  expect(discoveryDelayMs(120, 0, 1)).toBe(132000)
  expect(discoveryDelayMs(120, 1, 0)).toBe(240000)
  expect(discoveryDelayMs(120, 10, 0)).toBe(300000)
})

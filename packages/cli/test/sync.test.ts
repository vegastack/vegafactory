import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, readFactoryConfig, serializeFactoryConfig, updateSettings } from '../src/control-room.ts'
import { planSync, resolveTarget, syncControlRoom } from '../src/sync.ts'

let root = '', origin = '', source = ''
const NOW = Date.parse('2026-09-06T07:00:00Z')
const DEV_MD = 'repo: acme/app\ncontrol-room: acme/room#dev\n'

function git(args: string[], cwd: string) {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sync-221-')))
  source = join(root, 'source'); origin = join(root, 'origin.git')
  await mkdir(join(source, 'groups/dev'), { recursive: true })
  await writeFile(join(source, 'org.md'), 'stats: on\ntests: required   # locked\n')
  await writeFile(join(source, 'groups/dev/group.md'), 'merge: rebase\ngates: 3\n')
  await writeFile(join(source, 'repos.md'), '| repo | group | board | owner |\n|---|---|---|---|\n| acme/app | dev | none | owner |\n')
  git(['init', '-b', 'main'], source); git(['add', '.'], source); git(['commit', '-m', 'seed'], source)
  git(['clone', '--bare', source, origin], root)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(name: string) {
  const home = join(root, name), settings = join(home, '.vegastack')
  await mkdir(settings, { recursive: true })
  const config = readFactoryConfig(JSON.stringify({
    schemaVersion: 1, extension: 'kept',
    controlRooms: { acme: { repo: 'acme/room', remote: origin, path: join(home, '.vegastack/control-room/acme'), branch: 'main', sha: null, lastSyncedAt: null } },
  }))
  await writeFile(join(settings, 'factory.json'), JSON.stringify(serializeFactoryConfig(config)))
  const target = resolveTarget({ devMdText: DEV_MD, config, home })!
  return { home, settings, config, target }
}

test('the copy lands where every skill reads it, and a repo with no lines gets the whole profile', async () => {
  const f = await fixture('first')
  expect(f.target.clonePath).toBe(join(f.home, '.vegastack/control-room/acme'))
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  expect(first.action).toBe('clone')
  expect(first.sha).toMatch(/^[a-f0-9]{40}$/)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toContain('stats: on')
  const profile = loadProfile({ home: f.home, devMd: DEV_MD, now: NOW })
  expect(profile.blocks).toEqual([])
  expect(profile.values).toMatchObject({ tests: 'required', merge: 'rebase', gates: 3, stats: 'on' })
  expect(profile.locked).toEqual(['tests'])
  expect(loadProfile({ home: f.home, devMd: DEV_MD + 'tests: none\n', now: NOW }).ok).toBe(false)
})

test('a copy fetched inside five minutes is left alone; older than that it refreshes', async () => {
  const f = await fixture('age')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  const soon = await syncControlRoom({ ...f, config: first.config, now: NOW + 4 * 60_000 })
  expect(soon.action).toBe('fresh')
  expect(soon.config.revision).toBe(first.config.revision)
  const later = await syncControlRoom({ ...f, config: first.config, now: NOW + 6 * 60_000 })
  expect(later.action).toBe('refresh')
  expect(later.sha).toBe(first.sha)
  expect(later.lastSyncedAt).not.toBe(first.lastSyncedAt)
  expect(planSync({ cloneExists: true, lastSyncedAt: null, now: NOW, force: false }).action).toBe('refresh')
  expect(planSync({ cloneExists: false, lastSyncedAt: new Date(NOW).toISOString(), now: NOW, force: false }).action).toBe('clone')
})

test('a hand-edited copy, a wrong origin and a dry run all leave the copy and the record alone', async () => {
  const f = await fixture('refuse')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  const saved = await readFile(join(f.settings, 'factory.json'), 'utf8')

  const preview = await syncControlRoom({ ...f, config: first.config, now: NOW, force: true, dryRun: true })
  expect(preview.ok).toBe(true)
  expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).toBe(saved)

  const wrong = await syncControlRoom({ ...f, config: first.config, target: { ...f.target, remote: join(root, 'elsewhere.git') }, now: NOW, force: true })
  expect(wrong.ok).toBe(false)
  expect(wrong.message).toMatch(/origin does not match/)

  await writeFile(join(first.path, 'org.md'), 'operator edit\n')
  const dirty = await syncControlRoom({ ...f, config: first.config, now: NOW, force: true })
  expect(dirty.ok).toBe(false)
  expect(dirty.message).toMatch(/local changes/)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toBe('operator edit\n')
  expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).toBe(saved)
})

test('a new commit in the room arrives on the next refresh', async () => {
  const f = await fixture('moving')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  await writeFile(join(source, 'groups/dev/group.md'), 'merge: squash\ngates: 3\n')
  git(['add', '.'], source); git(['commit', '-m', 'group change'], source); git(['push', origin, 'main'], source)
  try {
    const next = await syncControlRoom({ ...f, config: first.config, now: NOW + 10 * 60_000 })
    expect(next.ok).toBe(true)
    expect(next.sha).not.toBe(first.sha)
    expect(loadProfile({ home: f.home, devMd: DEV_MD, now: NOW + 10 * 60_000 }).values.merge).toBe('squash')
  } finally {
    git(['revert', '--no-edit', 'HEAD'], source); git(['push', origin, 'main'], source)
  }
})

test('two syncs and an unrelated settings editor preserve committed updates', async () => {
  const f = await fixture('concurrent')
  const module = new URL('../src/sync.ts', import.meta.url).pathname
  const children = [1, 2].map(() => Bun.spawn([process.execPath, '-e', `import {syncControlRoom} from ${JSON.stringify(module)}; const r=await syncControlRoom(${JSON.stringify({ target: f.target, config: f.config, now: NOW })}); console.log(JSON.stringify(r));`], { stdout: 'pipe', stderr: 'pipe' }))
  await updateSettings(f.settings, s => ({ ...s, settings: { ...s.settings, editor: 'preserved' } }))
  const results = await Promise.all(children.map(async child => { expect(await child.exited).toBe(0); return JSON.parse(await new Response(child.stdout).text()) }))
  expect(results.some(r => r.ok)).toBe(true)
  const wire = JSON.parse(await readFile(join(f.settings, 'factory.json'), 'utf8'))
  expect(wire.editor).toBe('preserved')
  expect(wire.controlRooms.acme.sha).toMatch(/^[a-f0-9]{40}$/)
})

test('an interrupted settings transaction refuses without touching the record', async () => {
  const f = await fixture('interrupted')
  const before = await readFile(join(f.settings, 'factory.json'), 'utf8')
  await mkdir(join(f.settings, 'factory.json.guard'))
  const result = await syncControlRoom({ ...f, now: NOW })
  expect(result.ok).toBe(false)
  expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).toBe(before)
})

test('a repo that names no room needs no sync, and a mismatched --org refuses', async () => {
  const f = await fixture('none')
  expect(resolveTarget({ devMdText: 'tests: required\n', config: f.config, home: f.home })).toBeNull()
  expect(() => resolveTarget({ devMdText: DEV_MD, config: f.config, home: f.home, org: 'other' })).toThrow(/disagrees/)
  expect(resolveTarget({ devMdText: 'tests: required\n', config: { schemaVersion: 1, controlRooms: {}, settings: {} }, home: f.home, org: 'acme' })!.repo)
    .toBe('acme/vegafactory-control-room')
})

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, readFactoryConfig, serializeFactoryConfig, updateSettings } from '../src/control-room.ts'
import { planSync, resolveTarget, syncControlRoom } from '../src/sync.ts'
import { refuseAmbientHome } from './no-ambient-home.ts'

refuseAmbientHome()

const exists = (path: string) => lstat(path).then(() => true).catch(() => false)

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
  await writeFile(join(source, 'groups/dev/group.md'), 'merge: rebase\nchangelog: changesets\n')
  await writeFile(join(source, 'repos.md'), '| repo | group | board | owner |\n|---|---|---|---|\n| acme/app | dev | none | owner |\n')
  git(['init', '-b', 'main'], source); git(['add', '.'], source); git(['commit', '-m', 'seed'], source)
  git(['clone', '--bare', source, origin], root)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(name: string) {
  const home = join(root, name), settings = join(home, '.vegafactory')
  await mkdir(settings, { recursive: true })
  const config = readFactoryConfig(JSON.stringify({
    schemaVersion: 1, extension: 'kept',
    controlRooms: { acme: { repo: 'acme/room', remote: origin, path: join(home, '.vegafactory/control-room/acme'), branch: 'main', sha: null, lastSyncedAt: null } },
  }))
  await writeFile(join(settings, 'factory.json'), JSON.stringify(serializeFactoryConfig(config)))
  const target = resolveTarget({ devMdText: DEV_MD, config, home })!
  return { home, settings, config, target }
}

test('the copy lands where every skill reads it, and a repo with no lines gets the whole profile', async () => {
  const f = await fixture('first')
  expect(f.target.clonePath).toBe(join(f.home, '.vegafactory/control-room/acme'))
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  expect(first.action).toBe('clone')
  expect(first.sha).toMatch(/^[a-f0-9]{40}$/)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toContain('stats: on')
  const profile = loadProfile({ home: f.home, devMd: DEV_MD, now: NOW })
  expect(profile.blocks).toEqual([])
  expect(profile.values).toMatchObject({ tests: 'required', merge: 'rebase', changelog: 'changesets', stats: 'on' })
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

// The fresh answer is "the room's policy is what this machine is running on". A copy that is
// edited or a commit ahead is not that, so the age window must not be able to hide it.
test('an edit or a local commit refuses inside the fresh window as well as outside it', async () => {
  const f = await fixture('fresh-window')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  const saved = await readFile(join(f.settings, 'factory.json'), 'utf8')

  await writeFile(join(first.path, 'org.md'), 'operator edit\n')
  for (const [when, label] of [[NOW + 60_000, 'inside the window'], [NOW + 10 * 60_000, 'outside it']] as const) {
    const result = await syncControlRoom({ ...f, config: first.config, now: when })
    expect(result.action, label).toBe('refused')
    expect(result.message).toMatch(/local changes/)
  }
  expect((await syncControlRoom({ ...f, config: first.config, now: NOW + 60_000, dryRun: true })).ok).toBe(false)

  // A committed edit is clean to git, so the recorded commit is what catches it — and the commit
  // must survive, because `checkout -B` would have thrown it away without a word.
  git(['commit', '-aqm', 'operator commit'], first.path)
  const local = git(['rev-parse', 'HEAD'], first.path)
  expect(local).not.toBe(first.sha)
  for (const now of [NOW + 60_000, NOW + 10 * 60_000]) {
    const result = await syncControlRoom({ ...f, config: first.config, now, force: true })
    expect(result.action).toBe('refused')
    expect(result.message).toMatch(/not the .* sync recorded/)
  }
  expect(git(['rev-parse', 'HEAD'], first.path)).toBe(local)
  expect(await readFile(join(first.path, 'org.md'), 'utf8')).toBe('operator edit\n')
  expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).toBe(saved)
})

// The checkout and the record have to end up agreeing: a refusal that says the previous copy
// stands while the new one sits on disk is a lie the next session acts on.
test('a settings failure after the checkout puts the copy back', async () => {
  const f = await fixture('incoherent')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  const saved = await readFile(join(f.settings, 'factory.json'), 'utf8')

  await writeFile(join(source, 'groups/dev/group.md'), 'merge: squash\nchangelog: changesets\n')
  git(['add', '.'], source); git(['commit', '-m', 'moved on'], source); git(['push', origin, 'main'], source)
  try {
    await mkdir(join(f.settings, 'factory.json.guard'))
    const result = await syncControlRoom({ ...f, config: first.config, now: NOW + 10 * 60_000 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(first.sha!.slice(0, 7))
    expect(git(['rev-parse', 'HEAD'], first.path)).toBe(first.sha!)
    expect(await readFile(join(first.path, 'groups/dev/group.md'), 'utf8')).toContain('merge: rebase')
    expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).toBe(saved)
    // And the profile the copy resolves to is still the one the record describes.
    expect(loadProfile({ home: f.home, devMd: DEV_MD, now: NOW }).values.merge).toBe('rebase')
  } finally {
    await rm(join(f.settings, 'factory.json.guard'), { recursive: true, force: true })
    git(['revert', '--no-edit', 'HEAD'], source); git(['push', origin, 'main'], source)
  }
})

// F14: without a recorded commit there is nothing to hold the copy to, so `checkout -B` would
// take a local commit over the side without a word.
test('an existing copy with no recorded commit is refused before anything is fetched', async () => {
  const f = await fixture('unrecorded')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  git(['commit', '-qm', 'local work', '--allow-empty'], first.path)
  const local = git(['rev-parse', 'HEAD'], first.path)

  for (const sha of [null, undefined, 'not-a-sha']) {
    const entry = { ...first.config.controlRooms.acme!, sha } as Record<string, unknown>
    const config = { ...first.config, controlRooms: { ...first.config.controlRooms, acme: entry } }
    await writeFile(join(f.settings, 'factory.json'), JSON.stringify(serializeFactoryConfig(config as never)))
    const result = await syncControlRoom({ ...f, config: config as never, now: NOW + 10 * 60_000, force: true })
    expect(result.action, String(sha)).toBe('refused')
    expect(result.message).toMatch(/no sync recorded its commit/)
    expect(git(['rev-parse', 'HEAD'], first.path)).toBe(local)
  }
})

// F15: a half-made repository left by a failed first fetch would be "an existing clone" to the
// next run, which would then refuse it for having no recorded commit — a dead end on disk.
test('a failed first fetch leaves nothing behind, and the retry clones', async () => {
  const f = await fixture('failed-clone')
  const missing = await syncControlRoom({ ...f, target: { ...f.target, branch: 'no-such-branch' }, now: NOW })
  expect(missing.ok).toBe(false)
  expect(await exists(f.target.clonePath)).toBe(false)
  expect(await exists(f.target.clonePath + '.lock')).toBe(false)
  expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).not.toContain('"sha": "')

  const retry = await syncControlRoom({ ...f, now: NOW })
  expect(retry.ok).toBe(true)
  expect(retry.action).toBe('clone')
  expect(loadProfile({ home: f.home, devMd: DEV_MD, now: NOW }).ok).toBe(true)
})

// One sync at a time per org: the second waits for the lock, then finds the first's work already
// recorded rather than fetching over the same checkout.
test('a second sync waits for the first and then finds the copy fresh', async () => {
  const f = await fixture('serial')
  const module = new URL('../src/sync.ts', import.meta.url).pathname
  const call = JSON.stringify({ target: f.target, config: f.config, now: NOW })
  const children = [1, 2].map(() => Bun.spawn([process.execPath, '-e', `import {syncControlRoom} from ${JSON.stringify(module)}; console.log(JSON.stringify(await syncControlRoom(${call})));`], { stdout: 'pipe', stderr: 'pipe' }))
  const results = await Promise.all(children.map(async child => { expect(await child.exited).toBe(0); return JSON.parse(await new Response(child.stdout).text()) }))
  expect(results.every(r => r.ok)).toBe(true)
  expect(results.map(r => r.action).sort()).toEqual(['clone', 'fresh'])
  const wire = JSON.parse(await readFile(join(f.settings, 'factory.json'), 'utf8'))
  expect(wire.revision).toBe(1)
  expect(wire.controlRooms.acme.sha).toMatch(/^[a-f0-9]{40}$/)
  expect(await exists(f.target.clonePath + '.lock')).toBe(false)
})

// A caller holding settings from before someone re-pointed the org's copy must not publish over
// it from its stale target. The same comparison guards the settings transaction itself.
test('a connection that changed under the caller is refused rather than overwritten', async () => {
  const f = await fixture('raced')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  await updateSettings(f.settings, state => { state.orgs.acme!.branch = 'other'; return state })
  const stale = await syncControlRoom({ ...f, config: first.config, now: NOW + 10 * 60_000, force: true })
  expect(stale.ok).toBe(false)
  expect(stale.message).toMatch(/connection changed/)
  const wire = JSON.parse(await readFile(join(f.settings, 'factory.json'), 'utf8'))
  expect(wire.controlRooms.acme.sha).toBe(first.sha)
  expect(wire.controlRooms.acme.branch).toBe('other')
})

test('a new commit in the room arrives on the next refresh', async () => {
  const f = await fixture('moving')
  const first = await syncControlRoom({ ...f, now: NOW })
  expect(first.ok).toBe(true)
  await writeFile(join(source, 'groups/dev/group.md'), 'merge: squash\nchangelog: changesets\n')
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

test('an interrupted settings transaction refuses and leaves no half-made copy', async () => {
  const f = await fixture('interrupted')
  const before = await readFile(join(f.settings, 'factory.json'), 'utf8')
  await mkdir(join(f.settings, 'factory.json.guard'))
  const result = await syncControlRoom({ ...f, now: NOW })
  expect(result.ok).toBe(false)
  expect(await readFile(join(f.settings, 'factory.json'), 'utf8')).toBe(before)
  expect(await exists(f.target.clonePath)).toBe(false)
  expect(await exists(f.target.clonePath + '.lock')).toBe(false)
})

test('a repo that names no room needs no sync, and a mismatched --org refuses', async () => {
  const f = await fixture('none')
  expect(resolveTarget({ devMdText: 'tests: required\n', config: f.config, home: f.home })).toBeNull()
  expect(() => resolveTarget({ devMdText: DEV_MD, config: f.config, home: f.home, org: 'other' })).toThrow(/disagrees/)
  expect(resolveTarget({ devMdText: 'tests: required\n', config: { schemaVersion: 1, controlRooms: {}, settings: {} }, home: f.home, org: 'acme' })!.repo)
    .toBe('acme/vegafactory-control-room')
})

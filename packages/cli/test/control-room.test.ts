import { describe, expect, test } from 'bun:test'
import {
  MAX_AGE_MINUTES, ageMinutes, defaultClonePath, factoryConfigPath, isStale,
  loadProfile, parseControlRoomKnob, readFactoryConfig, safeClonePath, serializeFactoryConfig, withSyncResult,
} from '../src/control-room.ts'

const DEV_MD = [
  'repo: vegastack/billing · default branch main',
  '',
  '## Knobs',
  'control-room: vegastack/vegafactory-control-room#dev@a1b2c3d   # org control room · group · drafted-from sha',
  'merge: squash',
].join('\n')

describe('control-room knob and machine state', () => {
  test('the knob carries org, repo, group and the recorded sha', () => {
    expect(parseControlRoomKnob(DEV_MD)).toEqual({
      org: 'vegastack', repo: 'vegastack/vegafactory-control-room', group: 'dev', sha: 'a1b2c3d',
    })
  })

  test('no knob, or a knob set to none, resolves to null — skill defaults apply', () => {
    expect(parseControlRoomKnob('## Knobs\ntests: required\n')).toBeNull()
    expect(parseControlRoomKnob('## Knobs\ncontrol-room: none\n')).toBeNull()
  })

  // The `review:` knob is retired: an old profile keeps resolving, so a session never blocks on it.
  test('a profile that still carries a review knob resolves with no blocks', () => {
    const profile = loadProfile({ home: '/nonexistent', devMd: 'review: cross-agent-risky\ntests: required\n' })
    expect(profile.blocks).toEqual([])
    expect(profile.ok).toBe(true)
    expect(profile.room).toBeNull()
    expect(profile.values.review).toBeUndefined()
    expect(profile.values.tests).toBe('required')
  })

  test('a knob a profile has never synced parses with a null sha', () => {
    expect(parseControlRoomKnob('control-room: acme/acme-control-room#platform')).toEqual({
      org: 'acme', repo: 'acme/acme-control-room', group: 'platform', sha: null,
    })
  })

  test('one copy per org under the machine root, refreshed at five minutes', () => {
    expect(defaultClonePath('vegastack', '/home/mk')).toBe('/home/mk/.vegafactory/control-room/vegastack')
    expect(factoryConfigPath('/home/mk')).toBe('/home/mk/.vegafactory/factory.json')
    expect(MAX_AGE_MINUTES).toBe(5)
  })

  test('a missing state file is an empty config; an unreadable one is a refusal, never a silent reset', () => {
    expect(readFactoryConfig(null)).toEqual({ schemaVersion: 1, controlRooms: {}, settings: {} })
    expect(() => readFactoryConfig('{ not json')).toThrow(/not valid JSON/)
  })

  test('age is measured from the last successful fetch; never fetched is always stale', () => {
    const now = Date.parse('2026-09-03T12:00:00Z')
    expect(ageMinutes('2026-09-03T11:15:00Z', now)).toBe(45)
    expect(ageMinutes(null, now)).toBeNull()
    expect(isStale('2026-09-03T11:53:00Z', now, MAX_AGE_MINUTES)).toBe(true)
    expect(isStale('2026-09-03T11:56:00Z', now, MAX_AGE_MINUTES)).toBe(false)
    expect(isStale(null, now, MAX_AGE_MINUTES)).toBe(true)
  })

  test('a copy outside the machine store is refused rather than read', () => {
    expect(safeClonePath('/home/mk', '/elsewhere/acme')).toMatch(/outside/)
    expect(safeClonePath('/home/mk', 'relative/acme')).toMatch(/absolute and canonical/)
    expect(safeClonePath('/home/mk', '/home/mk/.vegafactory/control-room/../../etc')).toMatch(/absolute and canonical/)
  })

  test('recording one org never drops another, and never mutates the input', () => {
    const before = readFactoryConfig(JSON.stringify({
      schemaVersion: 1,
      controlRooms: { acme: { repo: 'acme/cr', path: '/x', branch: 'main', lastSyncedAt: '2026-09-01T00:00:00Z', sha: '0000000' } },
    }))
    const after = withSyncResult(before, 'vegastack', {
      repo: 'vegastack/vegafactory-control-room',
      path: '/home/mk/.vegafactory/control-room/vegastack',
      branch: 'main', lastSyncedAt: '2026-09-03T12:00:00Z', sha: 'a1b2c3d',
    })
    expect(Object.keys(after.controlRooms).sort()).toEqual(['acme', 'vegastack'])
    expect(after.controlRooms.vegastack!.sha).toBe('a1b2c3d')
    expect(before.controlRooms.vegastack).toBeUndefined()
  })

  test('the dispatcher settings sharing this file survive a sync write, never clobbered', () => {
    const before = readFactoryConfig(JSON.stringify({
      schemaVersion: 1,
      repos: [{ path: '~/code/app', repo: 'acme/app', org: 'acme' }],
      interval: 300,
      controlRooms: {},
    }))
    const after = withSyncResult(before, 'acme', {
      repo: 'acme/cr', path: '/x', branch: 'main', lastSyncedAt: '2026-09-03T12:00:00Z', sha: 'a1b2c3d',
    })
    expect(after.settings).toEqual({ repos: [{ path: '~/code/app', repo: 'acme/app', org: 'acme' }], interval: 300 })
    expect(after.controlRooms.acme!.sha).toBe('a1b2c3d')
    const written = serializeFactoryConfig(after)
    expect(written.interval).toBe(300)
    expect(written.repos).toEqual([{ path: '~/code/app', repo: 'acme/app', org: 'acme' }])
    expect(Object.keys(written)).not.toContain('settings')
  })
})

import { mkdtemp, realpath, readFile, rename, writeFile, mkdir, rm, symlink } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishedAlready, updateSettings, updateSettingsAtPath } from '../src/control-room.ts'
import { refuseAmbientHome } from './no-ambient-home.ts'

refuseAmbientHome()

function git(args: string[], cwd: string) {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

// A machine with one verified copy of acme's room, exactly as a successful sync leaves it.
async function machine(name: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), `profile-221-${name}-`)))
  const room = join(home, '.vegafactory/control-room/acme')
  const origin = join(home, 'origin.git')
  await mkdir(join(room, 'groups/dev'), { recursive: true })
  await writeFile(join(room, 'org.md'), 'tests: required   # locked\nstats-people: off\n')
  await writeFile(join(room, 'groups/dev/group.md'), 'merge: rebase\nchangelog: changesets\n')
  git(['init', '-q', '-b', 'main'], room)
  git(['remote', 'add', 'origin', origin], room)
  git(['add', '.'], room); git(['commit', '-qm', 'seed'], room)
  const sha = git(['rev-parse', 'HEAD'], room)
  const record = { repo: 'acme/room', path: room, branch: 'main', remote: origin, sha, lastSyncedAt: new Date().toISOString() }
  const write = async (entry: Record<string, unknown>) =>
    writeFile(join(home, '.vegafactory/factory.json'), JSON.stringify({ schemaVersion: 1, controlRooms: { acme: entry } }))
  await write(record)
  return { home, room, origin, sha, record, write, devMd: 'control-room: acme/room#dev\n' }
}

test('a repo with no lines of its own inherits a complete profile from the verified copy', async () => {
  const m = await machine('inherit')
  try {
    const profile = loadProfile({ home: m.home, devMd: m.devMd })
    expect(profile.blocks).toEqual([])
    expect(profile.ok).toBe(true)
    expect(profile.stale).toBe(false)
    expect(profile.sha).toBe(m.sha)
    expect(profile.values).toMatchObject({ tests: 'required', merge: 'rebase', changelog: 'changesets' })
    expect(profile.locked).toEqual(['tests'])
    expect(profile.sources.merge).toBe('group')
    // The org's locked line stands whatever the repo says, and the repo is told why.
    const overridden = loadProfile({ home: m.home, devMd: m.devMd + 'tests: none\n' })
    expect(overridden.ok).toBe(false)
    expect(overridden.blocks.join(' ')).toMatch(/tests is locked in org\.md/)
    expect(overridden.values.tests).toBe('required')
    // A copy that was never fetched still resolves, and says it is stale.
    const never = loadProfile({ home: m.home, devMd: 'control-room: other/room#dev\n' })
    expect(never.stale).toBe(true)
    expect(never.blocks.join(' ')).toMatch(/vegafactory sync/)
  } finally { await rm(m.home, { recursive: true, force: true }) }
})

// Everything factory.json records is a claim. A copy that fails any check is not policy: it is
// another org's clone, a wrong-origin copy, the leftovers of a failed sync, or a hand edit.
test('an unverified copy is refused rather than read as the org\'s policy', async () => {
  const m = await machine('verify')
  try {
    const refusal = async (entry: Record<string, unknown>, pattern: RegExp) => {
      await m.write(entry)
      const profile = loadProfile({ home: m.home, devMd: m.devMd })
      expect(profile.ok).toBe(false)
      expect(profile.blocks.join(' ')).toMatch(pattern)
      // Nothing of the room's is used, so the repo falls back to its own lines and the defaults.
      expect(profile.values.tests).toBeUndefined()
      expect(profile.clonePath).toBeNull()
    }
    await refusal({ ...m.record, path: join(m.home, 'elsewhere') }, /not at .*control-room\/acme/)
    await refusal({ ...m.record, repo: 'other/room' }, /the recorded copy is other\/room/)
    await refusal({ ...m.record, sha: null }, /no validated commit/)
    await refusal({ ...m.record, sha: 'b'.repeat(40) }, /moved off the commit sync recorded/)
    await refusal({ ...m.record, branch: 'other' }, /not on other/)
    await refusal({ ...m.record, remote: join(m.home, 'foreign.git') }, /different origin/)

    await m.write(m.record)
    await writeFile(join(m.room, 'org.md'), 'tests: none\n')
    await refusal(m.record, /local changes/)
    git(['checkout', '--', 'org.md'], m.room)

    // A local commit is not a local change to git, so HEAD is what catches it.
    await writeFile(join(m.room, 'org.md'), 'tests: none\n')
    git(['commit', '-aqm', 'hand edit'], m.room)
    await refusal(m.record, /moved off the commit sync recorded/)
  } finally { await rm(m.home, { recursive: true, force: true }) }
})

// The copy is read out of the recorded commit, so a tracked symlink is a refusal rather than a
// redirect to whatever it points at on this machine.
test('a symlinked policy file in the copy is refused, not followed', async () => {
  const m = await machine('symlink')
  try {
    await writeFile(join(m.home, 'secret.md'), 'tests: none\n')
    await rm(join(m.room, 'org.md'))
    await symlink(join(m.home, 'secret.md'), join(m.room, 'org.md'))
    git(['add', '-A'], m.room); git(['commit', '-qm', 'symlink'], m.room)
    await m.write({ ...m.record, sha: git(['rev-parse', 'HEAD'], m.room) })
    const profile = loadProfile({ home: m.home, devMd: m.devMd })
    expect(profile.ok).toBe(false)
    expect(profile.blocks.join(' ')).toMatch(/org\.md is not a regular file in the control room/)
    expect(profile.values.tests).toBeUndefined()
  } finally { await rm(m.home, { recursive: true, force: true }) }
})

// F16: the schema still allows an entry with no remote, and nothing can hold an origin to nothing.
test('a recorded entry with no origin or no branch is unverifiable, not merely unverified', async () => {
  const m = await machine('remote')
  try {
    for (const [field, pattern] of [['remote', /names no origin/], ['branch', /names no branch/]] as const) {
      const entry: Record<string, unknown> = { ...m.record }
      delete entry[field]
      await m.write(entry)
      const profile = loadProfile({ home: m.home, devMd: m.devMd })
      expect(profile.ok, field).toBe(false)
      expect(profile.blocks.join(' ')).toMatch(pattern)
      await m.write({ ...m.record, [field]: '' })
      expect(loadProfile({ home: m.home, devMd: m.devMd }).blocks.join(' ')).toMatch(pattern)
    }
  } finally { await rm(m.home, { recursive: true, force: true }) }
})

// F17: git metadata is as much a part of the copy as the files are. A symlinked `.git`, a gitfile
// or a `core.worktree` redirect all move git's reads outside everything the other checks cover.
test('a copy whose Git metadata or worktree lives elsewhere is refused', async () => {
  const m = await machine('metadata')
  try {
    const moved = join(m.home, 'outside.git')
    await rename(join(m.room, '.git'), moved)

    await writeFile(join(m.room, '.git'), `gitdir: ${moved}\n`)
    expect(loadProfile({ home: m.home, devMd: m.devMd }).blocks.join(' ')).toMatch(/refusing a \.git file/)

    await rm(join(m.room, '.git'))
    await symlink(moved, join(m.room, '.git'))
    expect(loadProfile({ home: m.home, devMd: m.devMd }).blocks.join(' ')).toMatch(/refusing a symlinked \.git/)

    await rm(join(m.room, '.git'))
    await rename(moved, join(m.room, '.git'))
    expect(loadProfile({ home: m.home, devMd: m.devMd }).ok).toBe(true)

    // A worktree redirect keeps the metadata in place but reads the files from somewhere else.
    git(['config', 'core.worktree', join(m.home, 'elsewhere')], m.room)
    expect(loadProfile({ home: m.home, devMd: m.devMd }).blocks.join(' ')).toMatch(/worktree is not/)
  } finally { await rm(m.home, { recursive: true, force: true }) }
})

// F18: one hand-written entry under refs/replace makes cat-file hand back different bytes while
// every identity check still passes, so replacement is off for every read.
test('a replacement object cannot substitute the policy the recorded commit holds', async () => {
  const m = await machine('replace')
  try {
    expect(loadProfile({ home: m.home, devMd: m.devMd }).values.tests).toBe('required')
    const real = git(['rev-parse', `${m.sha}:org.md`], m.room)
    const fake = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin'], { cwd: m.room, stdin: Buffer.from('tests: none\n') }).stdout.toString().trim()
    git(['update-ref', `refs/replace/${real}`, fake], m.room)
    // Proof the substitution is live for an ordinary reader.
    expect(git(['cat-file', 'blob', real], m.room)).toBe('tests: none')
    const profile = loadProfile({ home: m.home, devMd: m.devMd })
    expect(profile.ok).toBe(true)
    expect(profile.values.tests).toBe('required')
  } finally { await rm(m.home, { recursive: true, force: true }) }
})

// F19: a caller that rolls its own work back on a failure has to know whether the new settings
// were already renamed into place, or the rollback recreates the split it exists to prevent.
test('the settings transaction says whether it published before it failed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'published-221-')))
  try {
    await writeFile(join(root, 'factory.json'), JSON.stringify({ schemaVersion: 1, controlRooms: {} }))
    const before = await updateSettingsAtPath(join(root, 'factory.json'), state => state)
    expect(before.revision).toBe(1)

    // A failure raised by the callback happens before the rename.
    const early = await updateSettingsAtPath(join(root, 'factory.json'), () => { throw new Error('no') }).catch(error => error)
    expect(publishedAlready(early)).toBe(false)

    // Removing the guard from inside the callback makes the release step fail after the rename.
    const late = await updateSettingsAtPath(join(root, 'factory.json'), state => {
      rmSync(join(root, 'factory.json.guard'), { recursive: true, force: true })
      state.settings.marker = 'published'
      return state
    }).catch(error => error)
    expect(late).toBeInstanceOf(Error)
    expect(publishedAlready(late)).toBe(true)
    // And the file really is the new one, which is why the caller must not roll back.
    expect(JSON.parse(await readFile(join(root, 'factory.json'), 'utf8')).marker).toBe('published')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an unreadable control-room line refuses instead of resolving without the room', () => {
  const profile = loadProfile({ home: '/nonexistent', devMd: 'control-room: acme/room#dev\ncontrol-room: other/room#dev\n' })
  expect(profile.ok).toBe(false)
  expect(profile.room).toBeNull()
  expect(profile.blocks.join(' ')).toMatch(/duplicate policy key: control-room/)
})

test('settings transactions preserve two process updates and inert extension collisions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-147-')))
  try {
    await writeFile(join(root, 'factory.json'), JSON.stringify({ schemaVersion: 1, orgs: { inert: true }, custom: 9, controlRooms: {} }))
    const module = new URL('../src/control-room.ts', import.meta.url).pathname
    const children = ['alpha', 'beta'].map(org => Bun.spawn([process.execPath, '-e', `import {updateSettings} from ${JSON.stringify(module)}; await updateSettings(${JSON.stringify(root)}, s => ({...s,orgs:{...s.orgs,${org}:{repo:'${org}/room'}}}));`], { stdout: 'pipe', stderr: 'pipe' }))
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0])
    const wire = JSON.parse(await readFile(join(root, 'factory.json'), 'utf8'))
    expect(wire).toMatchObject({ schemaVersion: 2, revision: 2, orgs: { inert: true }, custom: 9 })
    expect(Object.keys(wire.controlRooms).sort()).toEqual(['alpha', 'beta'])
    expect(JSON.parse(await readFile(join(root, 'factory.json.schema1.bak'), 'utf8')).schemaVersion).toBe(1)
    await writeFile(join(root, 'factory.json'), '{"schemaVersion":99,"controlRooms":{}}')
    await expect(updateSettings(root, s => s)).rejects.toThrow(/schema/)
    expect(await readFile(join(root, 'factory.json'), 'utf8')).toBe('{"schemaVersion":99,"controlRooms":{}}')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('incomplete transaction ownership refuses without changing settings', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-147-')))
  try {
    await mkdir(join(root, 'factory.json.guard'))
    await expect(updateSettings(root, s => s)).rejects.toThrow(/guard/)
    expect(await readFile(join(root, 'factory.json'), 'utf8').catch(e => e.code)).toBe('ENOENT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unreadable settings and symlink aliases refuse without migration or backup loss', async () => {
  const { chmod, symlink } = await import('node:fs/promises')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-permissions-147-')))
  const path = join(root, 'factory.json'), original = '{"schemaVersion":1,"controlRooms":{},"operator":"kept"}'
  try {
    await writeFile(path, original)
    await chmod(path, 0)
    await expect(updateSettings(root, s => s)).rejects.toThrow(/EACCES/)
    await chmod(path, 0o600)
    expect(await readFile(path, 'utf8')).toBe(original)
    await symlink(root, join(root, 'alias'))
    await expect(updateSettings(join(root, 'alias'), s => s)).rejects.toThrow(/symlink/)
    expect(await readFile(path + '.schema1.bak', 'utf8').catch(error => error.code)).toBe('ENOENT')
  } finally { await chmod(path, 0o600); await rm(root, { recursive: true, force: true }) }
})

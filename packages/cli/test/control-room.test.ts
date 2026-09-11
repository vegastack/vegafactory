import { describe, expect, test } from 'bun:test'
import {
  ageMinutes, defaultClonePath, factoryConfigPath, isStale,
  parseControlRoomKnob, parseSyncMaxAge, readFactoryConfig, serializeFactoryConfig, withSyncResult,
} from '../src/control-room.ts'

const DEV_MD = [
  'repo: vegastack/billing · default branch main',
  '',
  '## Knobs',
  'architect: kmanojkumar',
  'control-room: vegastack/vegafactory-control-room#dev@a1b2c3d   # org control room · group · drafted-from sha',
  'sync-max-age: 30m           # how stale the clone may be before a session refreshes it',
].join('\n')

describe('control-room knob and machine state', () => {
  test('the knob carries org, repo, group and the recorded sha', () => {
    expect(parseControlRoomKnob(DEV_MD)).toEqual({
      org: 'vegastack', repo: 'vegastack/vegafactory-control-room', group: 'dev', sha: 'a1b2c3d',
    })
  })

  test('no knob, or a knob set to none, resolves to null — skill defaults apply', () => {
    expect(parseControlRoomKnob('## Knobs\nreview: subagent\n')).toBeNull()
    expect(parseControlRoomKnob('## Knobs\ncontrol-room: none\n')).toBeNull()
  })

  test('a knob a profile has never synced parses with a null sha', () => {
    expect(parseControlRoomKnob('control-room: acme/acme-control-room#platform')).toEqual({
      org: 'acme', repo: 'acme/acme-control-room', group: 'platform', sha: null,
    })
  })

  test('sync-max-age reads minutes and hours and falls back to 30 minutes', () => {
    expect(parseSyncMaxAge(DEV_MD)).toBe(30)
    expect(parseSyncMaxAge('sync-max-age: 2h')).toBe(120)
    expect(parseSyncMaxAge('## Knobs\n')).toBe(30)
    expect(parseSyncMaxAge('sync-max-age: whenever')).toBe(30)
  })

  test('one clone directory per org under the machine root', () => {
    expect(defaultClonePath('vegastack', '/home/mk')).toBe('/home/mk/.vegastack/control-room/vegastack')
    expect(factoryConfigPath('/home/mk')).toBe('/home/mk/.vegastack/factory.json')
  })

  test('a missing state file is an empty config; an unreadable one is a refusal, never a silent reset', () => {
    expect(readFactoryConfig(null)).toEqual({ schemaVersion: 1, controlRooms: {}, settings: {} })
    expect(() => readFactoryConfig('{ not json')).toThrow(/not valid JSON/)
  })

  test('age is measured from the last successful fetch; never fetched is always stale', () => {
    const now = Date.parse('2026-09-03T12:00:00Z')
    expect(ageMinutes('2026-09-03T11:15:00Z', now)).toBe(45)
    expect(ageMinutes(null, now)).toBeNull()
    expect(isStale('2026-09-03T11:15:00Z', now, 30)).toBe(true)
    expect(isStale('2026-09-03T11:45:00Z', now, 30)).toBe(false)
    expect(isStale(null, now, 30)).toBe(true)
  })

  test('recording one org never drops another, and never mutates the input', () => {
    const before = readFactoryConfig(JSON.stringify({
      schemaVersion: 1,
      controlRooms: { acme: { repo: 'acme/cr', path: '/x', branch: 'main', lastSyncedAt: '2026-09-01T00:00:00Z', sha: '0000000' } },
    }))
    const after = withSyncResult(before, 'vegastack', {
      repo: 'vegastack/vegafactory-control-room',
      path: '/home/mk/.vegastack/control-room/vegastack',
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

import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateSettings, snapshotFreshness } from '../src/control-room.ts'

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

test('freshness expires exactly at the selected bound and rejects future clocks', () => {
  const now = Date.parse('2026-09-06T12:00:00Z')
  for (const [age, state] of [[7199, 'fresh'], [7200, 'stale'], [7201, 'stale'], [-1, 'unavailable']] as const) {
    expect(snapshotFreshness(new Date(now - age * 1000).toISOString(), now, 7200)).toBe(state)
  }
  expect(snapshotFreshness('bad', now, 7200)).toBe('unavailable')
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

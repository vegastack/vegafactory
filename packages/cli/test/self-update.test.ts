import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maintainSelfUpdate, readUpdateNote, selfUpdateMode, SELF_UPDATE_LIMIT_S, UPDATE_CHECK_EVERY_MS, type UpdateRunner } from '../src/self-update.ts'

describe('the VegaFactory updater', () => {
  test('the explicit update is version-guarded, runs plain npm, and always returns a usable result', async () => {
    const calls: Array<[string, string[], number]> = []
    const run: UpdateRunner = (command, args, timeout) => {
      calls.push([command, args, timeout])
      return command === 'npm'
        ? { code: 0, stdout: 'changed 1 package', stderr: '' }
        : { code: 0, stdout: '0.21.0\n', stderr: '' }
    }
    const updated = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(updated).toMatchObject({ action: 'updated', before: '0.20.1', after: '0.21.0', latest: '0.21.0' })
    expect(updated.message).toBe('updated vegafactory 0.20.1 → 0.21.0')
    expect(calls[0]).toEqual(['npm', ['install', '-g', '@vegastack/vegafactory@latest'], SELF_UPDATE_LIMIT_S * 1000])

    calls.length = 0
    const current = await maintainSelfUpdate({ mode: 'auto', before: '0.21.0', latest: async () => '0.21.0', run })
    expect(current.message).toBe('vegafactory 0.21.0 is already current')
    expect(calls).toEqual([])

    const failed = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run: () => { throw new Error('read-only prefix') } })
    expect(failed).toMatchObject({ action: 'failed', before: '0.20.1', after: '0.20.1' })
    expect(failed.message).toContain('continuing with vegafactory 0.20.1')
  })

  test('the profile knob has one safe three-state reading', () => {
    expect(selfUpdateMode('')).toBe('auto')
    expect(selfUpdateMode('vegafactory-update: off\n')).toBe('off')
    expect(selfUpdateMode('vegafactory-update: notify   # report only\n')).toBe('notify')
    expect(selfUpdateMode('vegafactory-update: auto\nvegafactory-update: off\n')).toBe('off')
    expect(selfUpdateMode('vegafactory-update: yes\n')).toBe('off')
  })
})


describe('what one machine remembers between runs', () => {
  const homeDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-note-')))

  // An idle worker polls every couple of minutes; npm publishes every week or two. Asking each
  // pass is hundreds of calls a day for an answer that did not change.
  test('the registry is asked at most once an hour, and a failure is never remembered', async () => {
    const home = homeDir()
    let asks = 0
    const latest = async () => { asks += 1; return '9.0.0' }
    const at = Date.parse('2026-09-20T09:00:00Z')

    const first = await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest, home: { home }, now: at })
    expect(first).toMatchObject({ action: 'available', latest: '9.0.0' })
    expect(asks).toBe(1)

    // Inside the hour the remembered answer is used and npm is not called at all.
    const again = await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest, home: { home }, now: at + UPDATE_CHECK_EVERY_MS - 1 })
    expect(again).toMatchObject({ action: 'available', latest: '9.0.0' })
    expect(asks).toBe(1)

    // On the hour it asks again.
    await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest, home: { home }, now: at + UPDATE_CHECK_EVERY_MS })
    expect(asks).toBe(2)

    // A registry that cannot be reached is not remembered: a minute of npm being down must not
    // hold this machine on a stale version for the rest of the hour.
    const down = homeDir()
    const unreachable = await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest: async () => null, home: { home: down }, now: at })
    expect(unreachable.action).toBe('unavailable')
    expect(readUpdateNote({ home: down }).latest ?? null).toBeNull()
  })

  test('without a home nothing is remembered, so the registry is asked every time', async () => {
    let asks = 0
    const latest = async () => { asks += 1; return '9.0.0' }
    await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest })
    await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest })
    expect(asks).toBe(2)
  })

  test('an unreadable note is nothing known, not a refusal', async () => {
    const home = homeDir()
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    writeFileSync(join(home, '.vegafactory', 'update.json'), '{ not json')
    expect(readUpdateNote({ home })).toEqual({})
    let asks = 0
    const result = await maintainSelfUpdate({ mode: 'notify', before: '0.21.0', latest: async () => { asks += 1; return '9.0.0' }, home: { home }, now: Date.now() })
    expect(result.action).toBe('available')
    expect(asks).toBe(1)
  })
})

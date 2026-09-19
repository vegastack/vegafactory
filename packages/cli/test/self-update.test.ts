import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateCli } from '../src/index.ts'
import { maintainSelfUpdate, packageVersion, readUpdateNote, selfUpdateMode, semverLess, SELF_UPDATE_LIMIT_S, UPDATE_CHECK_EVERY_MS, writeUpdateNote, type UpdateRunner } from '../src/self-update.ts'

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


describe('release order', () => {
  // A prerelease comes before the stable release of the same number. Comparing only the numbers
  // made them equal, so a machine on `1.0.0-rc.1` was told it was current and stayed there.
  test('a prerelease is behind the release it precedes', () => {
    expect(semverLess('1.0.0-rc.1', '1.0.0')).toBe(true)
    expect(semverLess('1.0.0', '1.0.0-rc.1')).toBe(false)
    expect(semverLess('1.0.0-rc.1', '1.0.0-rc.2')).toBe(true)
    expect(semverLess('1.0.0-rc.2', '1.0.0-rc.10')).toBe(true)
    expect(semverLess('1.0.0-alpha', '1.0.0-beta')).toBe(true)
    // A numeric identifier ranks below an alphanumeric one.
    expect(semverLess('1.0.0-1', '1.0.0-alpha')).toBe(true)
    // More identifiers rank above fewer when the shared ones are equal.
    expect(semverLess('1.0.0-rc', '1.0.0-rc.1')).toBe(true)
    // Build metadata is not part of the order.
    expect(semverLess('1.0.0+build.9', '1.0.0')).toBe(false)
    // And the ordinary cases still hold.
    expect(semverLess('0.20.1', '0.21.0')).toBe(true)
    expect(semverLess('0.21.0', '0.21.0')).toBe(false)
    expect(semverLess('1.0.0', '0.21.0')).toBe(false)
  })
})

describe('what the install reports afterwards', () => {
  // npm said it worked; the check afterwards is what the machine actually has. When that check
  // cannot answer, the registry's version is the honest best guess — but it must never be taken
  // over an answer that did come back, and a broken check must not fail the update.
  test('a post-install check that cannot answer falls back to the published version', async () => {
    const answers: Record<string, () => { code: number; stdout: string; stderr: string }> = {
      missing: () => ({ code: 127, stdout: '', stderr: 'command not found' }),
      rubbish: () => ({ code: 0, stdout: 'not a version at all', stderr: '' }),
      empty: () => ({ code: 0, stdout: '', stderr: '' }),
    }
    for (const [name, answer] of Object.entries(answers)) {
      const run: UpdateRunner = (command) => (command === 'npm' ? { code: 0, stdout: '', stderr: '' } : answer())
      const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
      expect(result).toMatchObject({ action: 'updated', after: '0.21.0' })
      expect(result.message).toBe(`updated vegafactory 0.20.1 → 0.21.0`)
      expect(name).toBeTruthy()
    }
  })

  test('a post-install check that answers is believed over the registry', async () => {
    // npm resolved `@latest` to something other than what the registry said a moment earlier.
    const run: UpdateRunner = (command) => (command === 'npm' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '0.21.1\n', stderr: '' })
    const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(result).toMatchObject({ action: 'updated', after: '0.21.1', latest: '0.21.0' })
  })

  test('a check that throws does not turn a finished install into a failure', async () => {
    const run: UpdateRunner = (command) => {
      if (command === 'npm') return { code: 0, stdout: '', stderr: '' }
      throw new Error('spawn blew up')
    }
    const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(result.action).toBe('updated')
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

describe('the update command a person types', () => {
  // The command itself, not the function under it: this is where `--dry-run` either holds or does
  // not, and where an explicit ask must reach npm rather than reuse an automatic hourly check.
  test('a dry run says what it would do, installs nothing and remembers nothing', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-cli-')))
    const ran: string[][] = []
    const said: string[] = []
    const run: UpdateRunner = (command, args) => { ran.push([command, ...args]); return { code: 0, stdout: '', stderr: '' } }

    await updateCli(true, async () => '99.0.0', run, (text) => said.push(text))
    expect(said.join('\n')).toContain('dry run: would run npm install -g @vegastack/vegafactory@latest')
    expect(said.join('\n')).toContain('99.0.0')
    expect(ran).toEqual([])
    // Nothing is remembered either: a dry run that wrote the hourly note would change what the
    // next real check decides.
    expect(existsSync(join(home, '.vegafactory', 'update.json'))).toBe(false)

    said.length = 0
    await updateCli(false, async () => '99.0.0', run, (text) => said.push(text))
    expect(ran[0]).toEqual(['npm', 'install', '-g', '@vegastack/vegafactory@latest'])
    expect(said.join('\n')).toContain('updated vegafactory')
  })

  // Typing the command is asking for the current answer. Reusing a check made up to an hour ago
  // would answer "already current" about a release published since.
  test('an explicit update always asks npm, never the remembered answer', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-fresh-')))
    writeUpdateNote({ checkedAt: Date.now(), latest: packageVersion }, { home })
    let asked = 0
    const run: UpdateRunner = () => ({ code: 0, stdout: '', stderr: '' })
    await updateCli(true, async () => { asked += 1; return '99.0.0' }, run, () => {})
    expect(asked).toBe(1)
  })
})

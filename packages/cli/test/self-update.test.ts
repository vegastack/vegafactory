import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { refuseAmbientHome } from './no-ambient-home.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveUpdateMode, installArgs, maintainSelfUpdate, packageVersion, runUpdateCommand, readUpdateNote, selfUpdateMode, semverLess, SELF_UPDATE_LIMIT_S, UPDATE_CHECK_EVERY_MS, writeUpdateNote, type UpdateRunner } from '../src/self-update.ts'

refuseAmbientHome()

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
    // Plain npm, as the brief asks: this machine's own npm configuration decides where it resolves.
    expect(calls[0]).toEqual(['npm', installArgs(), SELF_UPDATE_LIMIT_S * 1000])
    expect(installArgs()).toEqual(['install', '-g', '@vegastack/vegafactory@latest'])

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
  test('an install nobody could confirm is reported as unconfirmed, not as success', async () => {
    // npm exiting zero says the command ran. What this machine now reports is the only evidence
    // that it took, so an answer nobody could get is neither a success nor a failure.
    for (const answer of [
      () => ({ code: 127, stdout: '', stderr: 'command not found' }),
      () => ({ code: 0, stdout: 'not a version at all', stderr: '' }),
      () => ({ code: 0, stdout: '', stderr: '' }),
    ]) {
      const run: UpdateRunner = (command) => (command === 'npm' ? { code: 0, stdout: '', stderr: '' } : answer())
      const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
      expect(result.action).toBe('unverified')
      expect(result.after).toBe('0.20.1')
      expect(result.message).toContain('could not confirm')
    }
  })

  test('an install that npm reported as fine but did not take is a failure', async () => {
    const run: UpdateRunner = (command) => (command === 'npm' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '0.20.1\n', stderr: '' })
    const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(result.action).toBe('failed')
    expect(result.message).toContain('still reports vegafactory 0.20.1')
  })

  test('a post-install check that answers is believed over the registry', async () => {
    // npm resolved `@latest` to something other than what the registry said a moment earlier.
    const run: UpdateRunner = (command) => (command === 'npm' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '0.21.1\n', stderr: '' })
    const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(result).toMatchObject({ action: 'updated', after: '0.21.1', latest: '0.21.0' })
  })

  test('a check that throws is unconfirmed rather than either answer', async () => {
    const run: UpdateRunner = (command) => {
      if (command === 'npm') return { code: 0, stdout: '', stderr: '' }
      throw new Error('spawn blew up')
    }
    const result = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run })
    expect(result.action).toBe('unverified')
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

  // The hour covers the attempt, not the answer. Remembering only successes meant an unreachable
  // registry was asked again on every pass — and, worse, a failed install of a version already
  // remembered was retried every pass, each try holding the loop for its own five-minute bound.
  test('a registry that is down costs one attempt an hour, not one a pass', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-down-')))
    let asks = 0
    const latest = async () => { asks += 1; return null }
    const at = Date.parse('2026-09-20T09:00:00Z')

    expect(await maintainSelfUpdate({ mode: 'auto', before: '0.21.0', latest, home: { home }, now: at })).toMatchObject({ action: 'unavailable' })
    expect(asks).toBe(1)
    // Every pass for the next hour asks nothing at all.
    for (const minute of [2, 4, 30, 59]) {
      await maintainSelfUpdate({ mode: 'auto', before: '0.21.0', latest, home: { home }, now: at + minute * 60_000 })
    }
    expect(asks).toBe(1)
    await maintainSelfUpdate({ mode: 'auto', before: '0.21.0', latest, home: { home }, now: at + UPDATE_CHECK_EVERY_MS })
    expect(asks).toBe(2)
  })

  // Asking npm and installing are different costs with different hours. Sharing one stamp got
  // both wrong: a `notify` session's cached answer stopped an `auto` worker installing it at all.
  test('a notify session does not stop an auto worker installing what it found', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-modes-')))
    const at = Date.parse('2026-09-20T09:00:00Z')
    let installs = 0
    const run: UpdateRunner = (command) => {
      if (command === 'npm') { installs += 1; return { code: 0, stdout: '', stderr: '' } }
      return { code: 0, stdout: '0.21.0\n', stderr: '' }
    }
    // A session only reporting: it caches what npm said and installs nothing.
    const told = await maintainSelfUpdate({ mode: 'notify', before: '0.20.1', latest: async () => '0.21.0', run, home: { home }, now: at })
    expect(told.action).toBe('available')
    expect(installs).toBe(0)

    // A worker a minute later, on the same cached answer, still installs it.
    const did = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run, home: { home }, now: at + 60_000 })
    expect(did.action).toBe('updated')
    expect(installs).toBe(1)
  })

  test('an install that failed is not retried on the next pass', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-retry-')))
    let installs = 0
    const run: UpdateRunner = (command) => {
      if (command === 'npm') { installs += 1; return { code: 1, stdout: '', stderr: 'EACCES' } }
      return { code: 0, stdout: '0.20.1\n', stderr: '' }
    }
    const at = Date.parse('2026-09-20T09:00:00Z')
    const first = await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run, home: { home }, now: at })
    expect(first.action).toBe('failed')
    expect(installs).toBe(1)
    // The next pass is two minutes later. It must not try again.
    await maintainSelfUpdate({ mode: 'auto', before: '0.20.1', latest: async () => '0.21.0', run, home: { home }, now: at + 2 * 60_000 })
    expect(installs).toBe(1)
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
    const ran: string[][] = []
    const said: string[] = []
    const run: UpdateRunner = (command, args) => { ran.push([command, ...args]); return { code: 0, stdout: '', stderr: '' } }

    await runUpdateCommand(true, { latest: async () => '99.0.0', run, say: (text: string) => said.push(text) })
    expect(said.join('\n')).toContain('dry run: would run npm install -g @vegastack/vegafactory@latest')
    expect(said.join('\n')).toContain('99.0.0')
    expect(ran).toEqual([])
    // Nothing is remembered either, and that is structural rather than asserted: the command
    // takes no home, so there is nowhere for it to write the hourly note.

    said.length = 0
    await runUpdateCommand(false, { latest: async () => '99.0.0', run, say: (text: string) => said.push(text) })
    expect(ran[0]).toEqual(['npm', ...installArgs()])
  })

  // Typing the command is asking for the current answer. Reusing a check made up to an hour ago
  // would answer "already current" about a release published since.
  test('an explicit update always asks npm, never the remembered answer', async () => {
    // A remembered answer exists for the automatic paths; the explicit command must ignore it.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vf-update-fresh-')))
    writeUpdateNote({ checkedAt: Date.now(), latest: packageVersion }, { home })
    let asked = 0
    const run: UpdateRunner = () => ({ code: 0, stdout: '', stderr: '' })
    await runUpdateCommand(true, { latest: async () => { asked += 1; return '99.0.0' }, run, say: () => {} })
    expect(asked).toBe(1)
  })
})

describe('which value actually applies', () => {
  const resolved = (values: Record<string, unknown>, ok = true) => () => ({ ok, values })

  // The control room exists so an org can decide once. Reading only the repo's own file made an
  // inherited value look like a missing one, which means the shipped `auto` — the opposite of a
  // locked `off`.
  test('an inherited value is the value, not a missing one', () => {
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: resolved({ 'vegafactory-update': 'off' }) })).toBe('off')
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: resolved({ 'vegafactory-update': 'notify' }) })).toBe('notify')
    // A repo that answers it itself still wins; that is the resolver's job, and this reads what it returns.
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: resolved({ 'vegafactory-update': 'auto' }) })).toBe('auto')
  })

  // What is being decided is whether to fetch and run executable code with nobody watching.
  test('a profile that cannot be resolved refuses rather than defaulting', () => {
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: resolved({ 'vegafactory-update': 'auto' }, false) })).toBe('off')
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: () => { throw new Error('no control room') } })).toBe('off')
    // A value nobody recognises is not an answer either.
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: resolved({ 'vegafactory-update': 'sometimes' }) })).toBe('off')
  })

  test('no profile at all is a project older than the knob, and gets the default', () => {
    expect(effectiveUpdateMode({ home: '/h', devMd: null })).toBe('auto')
    // A resolved profile that simply does not mention the knob is the same case.
    expect(effectiveUpdateMode({ home: '/h', devMd: 'repo: o/r\n', resolve: resolved({}) })).toBe('auto')
  })
})

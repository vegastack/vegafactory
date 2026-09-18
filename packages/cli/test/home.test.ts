import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  appKeyPath, controlRoomClonePath, controlRoomStore, DEAD_ENTRIES, factoryConfigPath, factoryHome,
  FOREIGN_ENTRIES, HOME_VARIABLE, legacyHome, migrateHome, statsDirectory, statsHtmlPath,
  workerDirectory, worktreesPath,
} from '../src/home.ts'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
})

describe('where the home is', () => {
  test('the env var names the directory itself, and wins over the home', () => {
    const named = join(home, 'elsewhere')
    expect(factoryHome({ env: { [HOME_VARIABLE]: named }, home })).toBe(named)
    expect(factoryHome({ env: {}, home })).toBe(join(home, '.vegafactory'))
  })

  test('an empty or blank value is no value', () => {
    for (const blank of ['', '   ', '\t']) {
      expect(factoryHome({ env: { [HOME_VARIABLE]: blank }, home })).toBe(join(home, '.vegafactory'))
    }
  })

  // The pair that used to be written out separately in two functions. A skew between them failed
  // every control-room read closed, so the test is that one contains the other by construction.
  test('every clone path sits inside the store that guards it', () => {
    const env = {}
    const store = controlRoomStore({ env, home })
    for (const org of ['acme', 'vegastack', 'a.b-c']) {
      expect(controlRoomClonePath(org, { env, home }).startsWith(store + sep)).toBe(true)
    }
  })

  test('everything this product stores hangs off the one home', () => {
    const env = {}
    const root = factoryHome({ env, home })
    for (const path of [
      factoryConfigPath({ env, home }), controlRoomStore({ env, home }), worktreesPath({ env, home }),
      statsDirectory({ env, home }), statsHtmlPath({ env, home }), workerDirectory({ env, home }),
      appKeyPath({ env, home }),
    ]) expect(path.startsWith(root + sep)).toBe(true)
  })

  test('the stats spool is no longer inside a directory called tmp', () => {
    // It held the read offsets and the push cursors under a hidden `.tmp/`, which is the first
    // thing anything tidying a machine empties — and losing them re-reads logs and duplicates pushes.
    expect(statsDirectory({ env: {}, home })).not.toContain(`${sep}.tmp${sep}`)
  })

  test('the App key still moves with its own variable', () => {
    expect(appKeyPath({ env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: '/keys/app.pem' }, home })).toBe('/keys/app.pem')
    expect(appKeyPath({ env: {}, home })).toBe(join(home, '.vegafactory', 'worker', 'app.pem'))
  })
})

describe('moving off the older home', () => {
  const real = () => ({
    env: {} as NodeJS.ProcessEnv,
    home,
    exists: (path: string) => existsSync(path),
    move: (from: string, to: string) => { require('node:fs').renameSync(from, to) },
    mkdir: (path: string) => { mkdirSync(path, { recursive: true }) },
    remove: (path: string) => { require('node:fs').rmSync(path, { recursive: true, force: true }) },
  })
  const old = () => legacyHome({ env: {}, home })
  const now = () => factoryHome({ env: {}, home })
  const seedOld = (relative: string, body = 'x') => {
    const path = join(old(), relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }

  test('no older home is nothing to do', () => {
    expect(migrateHome(real()).action).toBe('none')
  })

  test('an older home holding only other tooling is left entirely alone', () => {
    for (const foreign of FOREIGN_ENTRIES) mkdirSync(join(old(), foreign), { recursive: true })
    expect(migrateHome(real()).action).toBe('none')
    for (const foreign of FOREIGN_ENTRIES) expect(existsSync(join(old(), foreign))).toBe(true)
  })

  test('what moves is renamed on the way, and other tooling stays put', () => {
    seedOld('factory.json', '{"schemaVersion":2}')
    seedOld('worktree-roots.json', '["/a"]')
    seedOld(join('.tmp', 'stats', 'events.jsonl'), '{}\n')
    seedOld('vegafactory-app.pem', 'KEY')
    mkdirSync(join(old(), 'control-room', 'acme'), { recursive: true })
    for (const foreign of FOREIGN_ENTRIES) mkdirSync(join(old(), foreign), { recursive: true })

    const result = migrateHome(real())
    expect(result.action).toBe('moved')
    expect(readFileSync(join(now(), 'factory.json'), 'utf8')).toBe('{"schemaVersion":2}')
    expect(readFileSync(join(now(), 'worktrees.json'), 'utf8')).toBe('["/a"]')
    expect(readFileSync(join(now(), 'stats', 'events.jsonl'), 'utf8')).toBe('{}\n')
    expect(readFileSync(join(now(), 'worker', 'app.pem'), 'utf8')).toBe('KEY')
    expect(existsSync(join(now(), 'control-room', 'acme'))).toBe(true)
    // Nothing that is not ours is touched, by name and not by inference: a migration that moved
    // what it did not recognise could take a colleague's credentials with it.
    for (const foreign of FOREIGN_ENTRIES) expect(existsSync(join(old(), foreign))).toBe(true)
  })

  test('directories nothing reads any more go with the move', () => {
    seedOld('factory.json', '{}')
    for (const dead of DEAD_ENTRIES) mkdirSync(join(old(), dead), { recursive: true })
    const result = migrateHome(real())
    expect(result.action).toBe('moved')
    for (const dead of DEAD_ENTRIES) expect(existsSync(join(old(), dead))).toBe(false)
    expect(result.moved.join('\n')).toContain('nothing reads it')
  })

  // The house rule everywhere else in this product: an ambiguous state refuses and says what to
  // delete. A machine whose memory is in two places is exactly that.
  test('both homes holding state refuses, and names what is in both', () => {
    seedOld('factory.json', 'old')
    mkdirSync(now(), { recursive: true })
    writeFileSync(join(now(), 'factory.json'), 'new')
    const result = migrateHome(real())
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('factory.json')
    expect(result.moved).toEqual([])
    // Neither side is touched by a refusal.
    expect(readFileSync(join(old(), 'factory.json'), 'utf8')).toBe('old')
    expect(readFileSync(join(now(), 'factory.json'), 'utf8')).toBe('new')
  })

  test('running twice is not running twice', () => {
    seedOld('factory.json', '{}')
    expect(migrateHome(real()).action).toBe('moved')
    expect(migrateHome(real()).action).toBe('none')
  })
})

// A blanket rename of `.vegastack` would have broken this product: about fifty of the strings in
// `packages/cli/src` are repo-relative — `dev.md`, `.tmp/issues`, `.tmp/claims`, `.worktrees` —
// and must not move. So this check is deliberately narrow: it looks only for a join whose first
// argument is a home, which is exactly the shape every moved site had.
describe('the older home stays moved', () => {
  const sources = () => {
    const roots = [join(import.meta.dir, '..', 'src'), join(import.meta.dir, '..', '..', '..', 'skills')]
    const found: string[] = []
    const walk = (directory: string, depth = 0) => {
      if (depth > 6) return
      for (const entry of require('node:fs').readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path, depth + 1); continue }
        if (/\.(ts|mjs)$/.test(entry.name)) found.push(path)
      }
    }
    for (const root of roots) if (existsSync(root)) walk(root)
    return found
  }

  test('nothing builds a path under the home this product used to use', () => {
    const HOME_JOIN = /join\(\s*(?:[A-Za-z_$][\w.$]*\.)?(?:home|homedir\(\)|HOME)[\w.$]*\s*,\s*['"`]\.vegastack/
    // Comments are stripped first: this module's own header quotes the shape it replaced, and a
    // check that counted prose would be a check nobody could keep green.
    const code = (path: string) => readFileSync(path, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    const offenders = sources()
      .filter((path) => HOME_JOIN.test(code(path)))
      .map((path) => path.split(`${sep}vegafactory${sep}`).at(-1) ?? path)
    expect(offenders).toEqual([])
  })

  test('the check would catch a regression', () => {
    // Proving the pattern bites, so an empty result above means "clean" and not "never looked".
    const HOME_JOIN = /join\(\s*(?:[A-Za-z_$][\w.$]*\.)?(?:home|homedir\(\)|HOME)[\w.$]*\s*,\s*['"`]\.vegastack/
    for (const bad of ["join(home, '.vegastack', 'factory.json')", "join(homedir(), '.vegastack/control-room')", "join(options.home, '.vegastack', 'x')"]) {
      expect(HOME_JOIN.test(bad)).toBe(true)
    }
    // And that it leaves the repo-relative ones alone.
    for (const fine of ["join(root, '.vegastack', '.tmp', 'issues')", "join(where.top, '.vegastack', 'dev.md')"]) {
      expect(HOME_JOIN.test(fine)).toBe(false)
    }
  })
})

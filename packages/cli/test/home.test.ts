import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  appKeyPath, controlRoomClonePath, controlRoomStore, DEAD_ENTRIES, factoryConfigPath, factoryHome,
  movePath, pathKind, rebasePaths,
  FOREIGN_ENTRIES, HOME_VARIABLE, legacyHome, migrateHome, statsDirectory, statsHtmlPath,
  workerDirectory, worktreesPath,
} from '../src/home.ts'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
})

describe('where the home is', () => {
  test('the env var names the directory itself, and a different home named outright wins over it', () => {
    const named = join(home, 'elsewhere')
    // Nothing was passed, so the variable answers.
    expect(factoryHome({ env: { [HOME_VARIABLE]: named } })).toBe(named)
    // A home that is some other directory has been named outright, so it wins: an ambient setting
    // must not reach past a caller that said where to look.
    expect(factoryHome({ env: { [HOME_VARIABLE]: named }, home })).toBe(join(home, '.vegafactory'))
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
    kind: pathKind,
    list: (path: string) => { try { return require('node:fs').readdirSync(path) as string[] } catch { return [] } },
    readable: () => true,
    rebase: () => 0,
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


describe('the move cannot be aimed somewhere it was not asked to go', () => {
  const deps = (env: NodeJS.ProcessEnv) => ({
    env, home,
    kind: pathKind,
    list: (path: string) => { try { return require('node:fs').readdirSync(path) as string[] } catch { return [] } },
    readable: () => true,
    rebase: () => 0,
    move: (from: string, to: string) => { require('node:fs').renameSync(from, to) },
    mkdir: (path: string) => { mkdirSync(path, { recursive: true }) },
    remove: (path: string) => { require('node:fs').rmSync(path, { recursive: true, force: true }) },
  })

  // The dangerous shape: the override moved where things were going, but not where they came
  // from. A sandboxed run would have pulled the operator's real control room, config and App key
  // into a temporary directory, and whatever deleted that directory afterwards took them along.
  test('naming the home moves nothing into it', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'factory.json'), 'real')
    const elsewhere = join(home, 'sandbox')
    const result = migrateHome(deps({ [HOME_VARIABLE]: elsewhere }))
    expect(result.action).toBe('none')
    expect(readFileSync(join(legacy, 'factory.json'), 'utf8')).toBe('real')
    expect(existsSync(join(elsewhere, 'factory.json'))).toBe(false)
  })

  test('a symlinked home either side refuses instead of moving through it', () => {
    const real = join(home, 'real-state')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'factory.json'), 'real')
    require('node:fs').symlinkSync(real, join(home, '.vegastack'))
    const result = migrateHome(deps({}))
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('not an ordinary directory')
    expect(readFileSync(join(real, 'factory.json'), 'utf8')).toBe('real')
  })

  // Otherwise the machine with nothing else left is exactly the one that keeps it forever.
  test('the dead guard directory goes even when it is all that is left', () => {
    mkdirSync(join(home, '.vegastack', 'guard'), { recursive: true })
    const result = migrateHome(deps({}))
    expect(result.action).toBe('moved')
    expect(existsSync(join(home, '.vegastack', 'guard'))).toBe(false)
  })

  test('an interrupted global install moves its journal, so the next add can recover it', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '.skills-install-transaction.json'), '{"schemaVersion":2}')
    writeFileSync(join(legacy, 'factory.json.schema1.bak'), 'pre-image')
    const result = migrateHome(deps({}))
    expect(result.action).toBe('moved')
    const now = join(home, '.vegafactory')
    expect(readFileSync(join(now, '.skills-install-transaction.json'), 'utf8')).toBe('{"schemaVersion":2}')
    expect(readFileSync(join(now, 'factory.json.schema1.bak'), 'utf8')).toBe('pre-image')
  })
})

// The source scan above proves no site is spelled the old way. This one proves the product
// behaves that way: a real command, a real home, and nothing of ours left behind in the old one.
describe('a real run writes only where it should', () => {
  const cli = join(import.meta.dir, '..', 'src', 'index.ts')

  test('a command with the home named touches neither the real home nor the older one', () => {
    const named = join(home, 'named-home')
    const run = Bun.spawnSync([process.execPath, cli, 'version'], {
      cwd: home,
      env: { ...process.env, HOME: home, VEGAFACTORY_HOME: named },
    })
    expect(run.exitCode).toBe(0)
    // Nothing was created beside the named home, under either name.
    expect(existsSync(join(home, '.vegastack'))).toBe(false)
    expect(existsSync(join(home, '.vegafactory'))).toBe(false)
  })

  test('an older home is moved, and what is not ours is left exactly where it was', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(join(legacy, 'control-room', 'acme'), { recursive: true })
    mkdirSync(join(legacy, 'secrets'), { recursive: true })
    mkdirSync(join(legacy, 'guard'), { recursive: true })
    writeFileSync(join(legacy, 'factory.json'), '{"schemaVersion":2,"controlRooms":{}}')
    writeFileSync(join(legacy, 'secrets', 'keep.txt'), 'not ours')

    const run = Bun.spawnSync([process.execPath, cli, 'version'], { cwd: home, env: { ...process.env, HOME: home, VEGAFACTORY_HOME: '' } })
    expect(run.exitCode).toBe(0)
    // The answer is the only thing on stdout: a `--json` caller must never have to step over this.
    expect(run.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(run.stderr.toString()).toContain('moved this machine')

    expect(readFileSync(join(home, '.vegafactory', 'factory.json'), 'utf8')).toContain('schemaVersion')
    expect(existsSync(join(home, '.vegafactory', 'control-room', 'acme'))).toBe(true)
    expect(existsSync(join(legacy, 'factory.json'))).toBe(false)
    expect(existsSync(join(legacy, 'guard'))).toBe(false)
    // Another tool's directory, untouched.
    expect(readFileSync(join(legacy, 'secrets', 'keep.txt'), 'utf8')).toBe('not ours')
  })

  test('state in both homes stops the command instead of splitting it', () => {
    mkdirSync(join(home, '.vegastack'), { recursive: true })
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    writeFileSync(join(home, '.vegastack', 'factory.json'), 'older')
    writeFileSync(join(home, '.vegafactory', 'factory.json'), 'newer')
    const run = Bun.spawnSync([process.execPath, cli, 'version'], { cwd: home, env: { ...process.env, HOME: home, VEGAFACTORY_HOME: '' } })
    expect(run.exitCode).toBe(2)
    expect(run.stderr.toString()).toContain('both hold this product')
    expect(readFileSync(join(home, '.vegastack', 'factory.json'), 'utf8')).toBe('older')
    expect(readFileSync(join(home, '.vegafactory', 'factory.json'), 'utf8')).toBe('newer')
  })
})


describe('what a path is, told apart properly', () => {
  test('absent, a directory, a file and a symlink are four different answers', () => {
    expect(pathKind(join(home, 'nothing'))).toBe('absent')
    mkdirSync(join(home, 'dir'), { recursive: true })
    expect(pathKind(join(home, 'dir'))).toBe('directory')
    writeFileSync(join(home, 'file'), 'x')
    expect(pathKind(join(home, 'file'))).toBe('file')
    require('node:fs').symlinkSync(join(home, 'dir'), join(home, 'link'))
    // Never followed: either end of the move could otherwise land somewhere neither path names.
    expect(pathKind(join(home, 'link'))).toBe('other')
    // And a symlink pointing nowhere is still a symlink, not an absence.
    require('node:fs').symlinkSync(join(home, 'nothing'), join(home, 'dangling'))
    expect(pathKind(join(home, 'dangling'))).toBe('other')
  })
})

describe('a home on another device', () => {
  test('a rename that cannot cross the device copies, and only then removes', () => {
    const order: string[] = []
    movePath('/a', '/b', {
      rename: () => { const error = new Error('cross-device link') as NodeJS.ErrnoException; error.code = 'EXDEV'; throw error },
      copy: () => order.push('copy'),
      remove: () => order.push('remove'),
    })
    // The original stays until the copy is whole, so a failure halfway leaves something behind.
    expect(order).toEqual(['copy', 'remove'])
  })

  test('any other rename failure is not swallowed', () => {
    expect(() => movePath('/a', '/b', {
      rename: () => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error },
      copy: () => { throw new Error('must not copy') },
      remove: () => { throw new Error('must not remove') },
    })).toThrow('denied')
  })
})

describe('work in flight is waited for, never judged', () => {
  const base = () => ({
    env: {} as NodeJS.ProcessEnv, home,
    kind: pathKind,
    list: (path: string) => { try { return require('node:fs').readdirSync(path) as string[] } catch { return [] } },
    readable: () => true,
    rebase: () => 0,
    move: (from: string, to: string) => { require('node:fs').renameSync(from, to) },
    mkdir: (path: string) => { mkdirSync(path, { recursive: true }) },
    remove: (path: string) => { require('node:fs').rmSync(path, { recursive: true, force: true }) },
  })
  const seedLegacy = () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'factory.json'), 'state')
    return legacy
  }

  // Every place a lock can sit, including inside the directories this move renames. Nothing here
  // decides a lock is dead: three of these four are never stolen even by the code that owns them,
  // and all of them are taken before anything is written inside.
  test.each([
    ['.skills-install.lock'],
    ['factory.json.guard'],
    [join('.tmp', 'stats', '.lock')],
    [join('.tmp', 'stats', 'push', '.lock')],
    [join('control-room', 'acme.lock')],
  ])('a lock at %s stops the move and is left alone', (lock) => {
    const legacy = seedLegacy()
    const path = join(legacy, lock)
    mkdirSync(join(path, '..'), { recursive: true })
    if (lock === '.skills-install.lock') writeFileSync(path, '')
    else mkdirSync(path, { recursive: true })

    const result = migrateHome(base())
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('a lock is held there')
    expect(result.reason).toContain('remove that path and run again')
    expect(result.moved).toEqual([])
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(join(legacy, 'factory.json'), 'utf8')).toBe('state')
  })

  test('a lock in the destination stops it just as firmly', () => {
    seedLegacy()
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    writeFileSync(join(home, '.vegafactory', '.skills-install.lock'), '')
    expect(migrateHome(base()).action).toBe('refused')
  })

  test('anything at all in the destination counts as state, not just names this table knows', () => {
    seedLegacy()
    mkdirSync(join(home, '.vegafactory', 'something-newer'), { recursive: true })
    const result = migrateHome(base())
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('something-newer')
    expect(result.moved).toEqual([])
  })

  // "Cannot be listed" is not "empty": moving state in beside unknown state is the same split.
  test('a destination that cannot be listed refuses rather than being read as empty', () => {
    seedLegacy()
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    const result = migrateHome({ ...base(), list: (path: string) => (path.endsWith('.vegafactory') ? null : []) })
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('cannot be listed')
  })

  // Present and the right shape is not enough: a mode-000 file moves across perfectly well and is
  // unreadable at the far end.
  test('an entry this account cannot read refuses instead of being carried', () => {
    seedLegacy()
    const result = migrateHome({ ...base(), readable: () => false })
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('cannot be read by this account')
  })

  test('a refusal over split state deletes nothing first', () => {
    const legacy = seedLegacy()
    mkdirSync(join(legacy, 'guard'), { recursive: true })
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    writeFileSync(join(home, '.vegafactory', 'factory.json'), 'newer')
    expect(migrateHome(base()).action).toBe('refused')
    expect(existsSync(join(legacy, 'guard'))).toBe(true)
  })

  test('a regular file named guard is left exactly where it is', () => {
    const legacy = seedLegacy()
    writeFileSync(join(legacy, 'guard'), 'somebody put this here')
    const result = migrateHome(base())
    expect(result.action).toBe('moved')
    expect(readFileSync(join(legacy, 'guard'), 'utf8')).toBe('somebody put this here')
  })

  test('a symlink, or the wrong shape entirely, refuses rather than being carried', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(home, 'somewhere-else.json'), 'not mine')
    require('node:fs').symlinkSync(join(home, 'somewhere-else.json'), join(legacy, 'factory.json'))
    expect(migrateHome(base()).reason).toContain('not a file')

    require('node:fs').rmSync(join(legacy, 'factory.json'))
    mkdirSync(join(legacy, 'factory.json'), { recursive: true })
    const result = migrateHome(base())
    expect(result.action).toBe('refused')
    expect(result.reason).toContain('not a file')
    expect(existsSync(join(home, '.vegafactory', 'factory.json'))).toBe(false)
  })
})

describe('a failed copy leaves the original standing', () => {
  test('the source is only removed once the copy is whole', () => {
    let removed = false
    expect(() => movePath('/a', '/b', {
      rename: () => { const error = new Error('cross-device link') as NodeJS.ErrnoException; error.code = 'EXDEV'; throw error },
      copy: () => { throw new Error('disk full') },
      remove: () => { removed = true },
    })).toThrow('disk full')
    expect(removed).toBe(false)
  })
})

// `factory.json` records where each control room was cloned, as an absolute path, and
// `safeClonePath` insists that path is inside the store. Move the files and leave the record
// alone and every control-room read fails closed — the exact skew this module exists to prevent.
describe('the record moves with the files', () => {
  test('every recorded path under the older home is rebased onto the new one', () => {
    const before = {
      schemaVersion: 2,
      controlRooms: {
        acme: {
          path: '/home/mk/.vegastack/control-room/acme',
          remote: 'https://github.com/acme/room.git',
          snapshots: { 'acme/app': { contentPath: '/home/mk/.vegastack/policy-snapshots/acme/snap-1' } },
        },
      },
      elsewhere: '/home/mk/other/thing',
    }
    const { value, changed } = rebasePaths(before, '/home/mk/.vegastack', '/home/mk/.vegafactory')
    expect(changed).toBe(2)
    const after = value as typeof before
    expect(after.controlRooms.acme.path).toBe('/home/mk/.vegafactory/control-room/acme')
    expect(after.controlRooms.acme.snapshots['acme/app']!.contentPath).toBe('/home/mk/.vegafactory/policy-snapshots/acme/snap-1')
    // Everything else is left exactly as it was, including a remote that is not a path at all.
    expect(after.controlRooms.acme.remote).toBe('https://github.com/acme/room.git')
    expect(after.elsewhere).toBe('/home/mk/other/thing')
  })

  test('a path that merely starts with the same letters is not a path under the home', () => {
    const { changed } = rebasePaths({ a: '/home/mk/.vegastack-backup/x' }, '/home/mk/.vegastack', '/home/mk/.vegafactory')
    expect(changed).toBe(0)
  })

  test('the record is rebased as part of the move, and the clone is where it says', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(join(legacy, 'control-room', 'acme'), { recursive: true })
    writeFileSync(join(legacy, 'factory.json'), JSON.stringify({
      schemaVersion: 2,
      controlRooms: { acme: { path: join(legacy, 'control-room', 'acme'), branch: 'main' } },
    }))
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'src', 'index.ts'), 'version'], {
      cwd: home, env: { ...process.env, HOME: home, VEGAFACTORY_HOME: '' },
    })
    expect(run.exitCode).toBe(0)
    const recorded = JSON.parse(readFileSync(join(home, '.vegafactory', 'factory.json'), 'utf8')) as { controlRooms: Record<string, { path: string }> }
    expect(recorded.controlRooms.acme!.path).toBe(join(home, '.vegafactory', 'control-room', 'acme'))
    expect(existsSync(recorded.controlRooms.acme!.path)).toBe(true)
    expect(run.stderr.toString()).toContain('recorded path')
  })
})

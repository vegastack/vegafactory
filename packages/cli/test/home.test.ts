import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  AFTER_THE_MOVE, appKeyPath, controlRoomClonePath, controlRoomStore, DEAD_ENTRIES, factoryConfigPath,
  factoryHome, FOREIGN_ENTRIES, HOME_VARIABLE, legacyHome, olderHome, pathKind, statsDirectory,
  statsHtmlPath, workerDirectory, worktreesPath,
} from '../src/home.ts'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
})

describe('where the home is', () => {
  test('the env var names the directory itself, and wins outright when it is set', () => {
    const named = join(home, 'elsewhere')
    expect(factoryHome({ env: { [HOME_VARIABLE]: named } })).toBe(named)
    // It is the whole home, not a base to build one from, so a home passed alongside it loses.
    expect(factoryHome({ env: { [HOME_VARIABLE]: named }, home })).toBe(named)
    expect(factoryHome({ env: {}, home })).toBe(join(home, '.vegafactory'))
  })

  test('a home that is not an absolute path is refused, not resolved against the moment', () => {
    // A relative home names a different directory from every working directory: one machine's
    // state split across as many places as it has repositories.
    expect(() => factoryHome({ env: { [HOME_VARIABLE]: 'state' } })).toThrow('absolute path')
    expect(() => factoryHome({ env: { [HOME_VARIABLE]: './state' } })).toThrow('absolute path')
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


describe('the older home is found and described, never moved', () => {
  const deps = () => ({
    env: {} as NodeJS.ProcessEnv, home,
    kind: pathKind,
    list: (path: string) => { try { return require('node:fs').readdirSync(path) as string[] } catch { return [] } },
  })
  const old = () => legacyHome({ env: {}, home })
  const seed = (relative: string, body = 'x') => {
    const path = join(old(), relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }

  test('no older home is nothing to say', () => {
    expect(olderHome(deps()).found).toBe(false)
  })

  test('an older home holding only other tooling is nothing to say either', () => {
    for (const foreign of FOREIGN_ENTRIES) mkdirSync(join(old(), foreign), { recursive: true })
    expect(olderHome(deps()).found).toBe(false)
  })

  // The whole point: it says what to run, and runs none of it.
  test('it names every move, with the two that change name as well as address', () => {
    seed('factory.json')
    seed('worktree-roots.json')
    seed(join('.tmp', 'stats', 'events.jsonl'))
    seed('vegafactory-app.pem')
    mkdirSync(join(old(), 'control-room', 'acme'), { recursive: true })
    mkdirSync(join(old(), 'guard'), { recursive: true })

    const found = olderHome(deps())
    expect(found.found).toBe(true)
    const script = found.commands.join('\n')
    expect(script).toContain(`mv ${join(old(), 'worktree-roots.json')} ${join(home, '.vegafactory', 'worktrees.json')}`)
    expect(script).toContain(`mv ${join(old(), '.tmp', 'stats')} ${join(home, '.vegafactory', 'stats')}`)
    expect(script).toContain(`mv ${join(old(), 'vegafactory-app.pem')} ${join(home, '.vegafactory', 'worker', 'app.pem')}`)
    expect(script).toContain(`rm -rf ${join(old(), 'guard')}`)
    // The directory the App key lands in is created first, or the `mv` would rename onto a name.
    expect(found.commands[0]).toContain(join(home, '.vegafactory', 'worker'))
    // And nothing has happened: every file is exactly where it was.
    expect(existsSync(join(old(), 'factory.json'))).toBe(true)
    expect(existsSync(join(old(), 'guard'))).toBe(true)
    expect(existsSync(join(home, '.vegafactory'))).toBe(false)
  })

  test('it says nothing about other tooling, by name and not by inference', () => {
    seed('factory.json')
    for (const foreign of FOREIGN_ENTRIES) mkdirSync(join(old(), foreign), { recursive: true })
    const script = olderHome(deps()).commands.join('\n')
    for (const foreign of FOREIGN_ENTRIES) expect(script).not.toContain(join(old(), foreign))
  })

  // Once this machine has moved, what is left behind is the operator's to tidy.
  test('it goes quiet as soon as the new home holds anything', () => {
    seed('factory.json')
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    writeFileSync(join(home, '.vegafactory', 'factory.json'), 'moved')
    expect(olderHome(deps()).found).toBe(false)
  })

  test('a new home that cannot be listed is not read as an empty one', () => {
    seed('factory.json')
    mkdirSync(join(home, '.vegafactory'), { recursive: true })
    const found = olderHome({ ...deps(), list: (path: string) => (path.endsWith('.vegafactory') ? null : []) })
    expect(found.found).toBe(false)
  })

  test('a path with a space in it is quoted so the lines can be pasted as they are', () => {
    const spaced = realpathSync(mkdtempSync(join(tmpdir(), 'home with space ')))
    mkdirSync(join(spaced, '.vegastack'), { recursive: true })
    writeFileSync(join(spaced, '.vegastack', 'factory.json'), 'x')
    const script = olderHome({ env: {}, home: spaced, kind: pathKind, list: () => [] }).commands.join('\n')
    expect(script).toContain("'")
    expect(script).toContain('factory.json')
  })
})

describe('a real run says what to do and does nothing', () => {
  const cli = join(import.meta.dir, '..', 'src', 'index.ts')

  test('a command with the home named touches neither home', () => {
    const named = join(home, 'named-home')
    const run = Bun.spawnSync([process.execPath, cli, 'version'], { cwd: home, env: { ...process.env, HOME: home, VEGAFACTORY_HOME: named } })
    expect(run.exitCode).toBe(0)
    expect(existsSync(join(home, '.vegastack'))).toBe(false)
    expect(existsSync(join(home, '.vegafactory'))).toBe(false)
  })

  test('an older home stops the command, prints the lines, and moves nothing', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(join(legacy, 'control-room', 'acme'), { recursive: true })
    mkdirSync(join(legacy, 'secrets'), { recursive: true })
    writeFileSync(join(legacy, 'factory.json'), '{"schemaVersion":2}')
    writeFileSync(join(legacy, 'secrets', 'keep.txt'), 'not ours')

    const run = Bun.spawnSync([process.execPath, cli, 'version'], { cwd: home, env: { ...process.env, HOME: home, VEGAFACTORY_HOME: '' } })
    expect(run.exitCode).toBe(2)
    // Nothing on stdout: a `--json` caller must still get exactly one document.
    expect(run.stdout.toString().trim()).toBe('')
    const said = run.stderr.toString()
    expect(said).toContain('mv ')
    expect(said).toContain(AFTER_THE_MOVE)
    // And it did none of it.
    expect(readFileSync(join(legacy, 'factory.json'), 'utf8')).toBe('{"schemaVersion":2}')
    expect(existsSync(join(home, '.vegafactory'))).toBe(false)
    expect(readFileSync(join(legacy, 'secrets', 'keep.txt'), 'utf8')).toBe('not ours')
  })

  test('the lines it prints actually do the job', () => {
    const legacy = join(home, '.vegastack')
    mkdirSync(join(legacy, 'control-room', 'acme'), { recursive: true })
    mkdirSync(join(legacy, '.tmp', 'stats'), { recursive: true })
    writeFileSync(join(legacy, '.tmp', 'stats', 'events.jsonl'), '{}\n')
    writeFileSync(join(legacy, 'factory.json'), '{}')
    writeFileSync(join(legacy, 'vegafactory-app.pem'), 'KEY')
    mkdirSync(join(legacy, 'guard'), { recursive: true })

    const script = olderHome({ env: {}, home, kind: pathKind, list: () => [] }).commands.join('\n')
    const ran = Bun.spawnSync(['sh', '-ec', script], { cwd: home })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)

    const now = join(home, '.vegafactory')
    expect(readFileSync(join(now, 'worker', 'app.pem'), 'utf8')).toBe('KEY')
    expect(readFileSync(join(now, 'stats', 'events.jsonl'), 'utf8')).toBe('{}\n')
    expect(existsSync(join(now, 'control-room', 'acme'))).toBe(true)
    expect(existsSync(join(legacy, 'guard'))).toBe(false)

    // And afterwards the command runs, because the new home now holds something.
    const run = Bun.spawnSync([process.execPath, cli, 'version'], { cwd: home, env: { ...process.env, HOME: home, VEGAFACTORY_HOME: '' } })
    expect(run.exitCode).toBe(0)
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

describe('no test can settle a real machine', () => {
  // The call and whatever follows it, because the options object can run over several lines and
  // can contain brackets of its own.
  // An argument array that carries this CLI's entry point, however the call is spelled:
  // `[CLI, …]`, `['node', cli, …]`, `[executable, cli, …]`.
  const LAUNCHES_CLI = /\[[^\]]*(?<![\w/.'"-])(?:CLI|cli)(?![\w/.'"-])/g
  const WINDOW = 420

  const settles = (text: string): string[] => {
    const found: string[] = []
    for (const match of text.matchAll(LAUNCHES_CLI)) {
      const after = text.slice(match.index ?? 0, (match.index ?? 0) + WINDOW)
      if (!after.includes('VEGAFACTORY_HOME')) found.push(after.replace(/\s+/g, ' ').slice(0, 100))
    }
    return found
  }

  test('every test that launches the CLI names a home for it', () => {
    const offenders: string[] = []
    const roots = [join(import.meta.dir), join(import.meta.dir, '..', '..', '..', 'skills')]
    const walk = (directory: string, depth = 0) => {
      if (depth > 6) return
      for (const entry of require('node:fs').readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path, depth + 1); continue }
        // This file's own examples below are strings about the rule, not uses of it.
        if (!/\.test\.(ts|mjs)$/.test(entry.name) || entry.name === 'home.test.ts') continue
        for (const call of settles(readFileSync(path, 'utf8'))) offenders.push(`${entry.name}: ${call}`)
      }
    }
    for (const root of roots) if (existsSync(root)) walk(root)
    expect(offenders).toEqual([])
  })

  test('the check would catch a regression', () => {
    // So an empty result above means "clean" and not "never looked".
    expect(settles("spawnSync(process.execPath, [CLI, 'version'], { cwd: root })")).toHaveLength(1)
    expect(settles("spawnSync(process.execPath, [CLI, 'x'], { env: { VEGAFACTORY_HOME: h } })")).toHaveLength(0)
    // And that it is not fooled by brackets inside the options.
    expect(settles("spawnSync(process.execPath, [CLI, 'x'], { input: N(m), env: { VEGAFACTORY_HOME: h } })")).toHaveLength(0)
    expect(settles("spawnSync('git', ['status'], { cwd: root })")).toHaveLength(0)
    // A path that merely contains the letters is not this CLI.
    expect(settles("expect(files).toEqual(['packages/cli/src/issue.ts', 'packages/cli/package.json'])")).toHaveLength(0)
  })
})

// The push journals live inside the spool that has just moved, and each names the clone it was
// written for. `recoverPush` refuses one whose room is not where it says it is.
test('the suite runs with no ambient home named, because the helpers would obey it', () => {
  expect(process.env[HOME_VARIABLE] ?? '').toBe('')
})

// A named home is a caller saying where this product lives. Looking at the machine's real older
// home from there would refuse a sandbox because of a directory it was never asked about — which
// is what stopped two unrelated tests dead.
test('a named home does not go looking at the real machine for an older one', () => {
  const legacy = join(home, '.vegastack')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'factory.json'), 'real')
  const found = olderHome({ env: { [HOME_VARIABLE]: join(home, 'sandbox') }, home, kind: pathKind, list: () => [] })
  expect(found.found).toBe(false)
})

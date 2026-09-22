import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  appKeyPath, controlRoomClonePath, controlRoomStore, factoryConfigPath, factoryHome,
  HOME_VARIABLE, makeFactoryHome, statsDirectory, statsHtmlPath, workerBoardsPath, workerDirectory,
  workerRepositoriesDirectory, worktreesPath,
} from '../src/home.ts'
import { refuseAmbientHome } from './no-ambient-home.ts'

let home: string

refuseAmbientHome()

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
      workerRepositoriesDirectory({ env, home }), workerBoardsPath({ env, home }), appKeyPath({ env, home }),
    ]) expect(path.startsWith(root + sep)).toBe(true)
  })

  test('worker repositories and board state share the machine worker directory', () => {
    const options = { env: {}, home }
    expect(workerRepositoriesDirectory(options)).toBe(join(home, '.vegafactory', 'worker', 'repos'))
    expect(workerBoardsPath(options)).toBe(join(home, '.vegafactory', 'worker', 'boards.json'))
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

// The home holds the App key and the control-room clones. A umask of 022 would leave every one of
// them readable by anybody else on the machine.
test('the home this product creates is owner-only', () => {
  const made = makeFactoryHome({ env: {}, home })
  expect(require('node:fs').statSync(made).mode & 0o777).toBe(0o700)
})

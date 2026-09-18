// Where this product keeps what it knows about one machine.
//
// One module, because the alternative is what this replaced: thirteen `join(home, '.vegastack',
// …)` spelled out across seven files and two languages, with the containment check for one of
// them written separately from the path it guards. A single accessor per thing means a move is
// one edit and a test can point the whole product somewhere harmless.
//
// The name is `.vegafactory` and not `.vegastack` because `~/.vegastack/` is shared: other
// VegaStack tooling keeps `tools/`, `cache/`, `registry/` and `secrets/` there, none of which this
// repository references. A directory this product owns entirely is one it may also prune.

import { lstatSync, readdirSync } from 'node:fs'

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// The one escape hatch, and the reason the tests can run at all: `worktree.ts` used to call
// `homedir()` with no way to pass anything else, so a careless test wrote to the real home.
export const HOME_VARIABLE = 'VEGAFACTORY_HOME'

export const FACTORY_DIRECTORY = '.vegafactory'

// The home the previous releases used, kept only so a machine upgrading from one can be moved off
// it and told so. Nothing reads from here after the move.
export const LEGACY_DIRECTORY = '.vegastack'

// What lives directly under the home. Everything else hangs off one of these, so the migration and
// the "is this ours?" question both have exactly one list to consult.
export const OWNED_ENTRIES = ['factory.json', 'control-room', 'worktrees.json', 'stats', 'stats.html', 'worker'] as const

// Entries under the legacy home that belong to other VegaStack tooling. They are named rather than
// inferred: a migration that moved something it did not recognise would be a migration that can
// take a colleague's credentials with it.
export const FOREIGN_ENTRIES = ['tools', 'cache', 'registry', 'secrets'] as const

export interface HomeOptions { env?: NodeJS.ProcessEnv; home?: string }

// `VEGAFACTORY_HOME` names the directory itself, not the parent: point it at a temporary directory
// and everything below follows. An empty or whitespace value is no value.
//
// The variable wins outright when it is set: it is the whole home, not a base to build one from.
// A caller that must not be reached by an ambient setting passes its own `env`.
export function factoryHome(options: HomeOptions = {}): string {
  const named = (options.env ?? process.env)[HOME_VARIABLE]?.trim()
  if (!named) return join(options.home ?? homedir(), FACTORY_DIRECTORY)
  // A relative home names a different directory from every working directory, which is one
  // machine's state split across as many places as it has repositories.
  if (!isAbsolute(named)) throw new Error(`${HOME_VARIABLE} must be an absolute path; it is ${named}`)
  return resolve(named)
}

// The home this machine used before, so a first run can find what to move.
export function legacyHome(options: HomeOptions = {}): string {
  return join(options.home ?? homedir(), LEGACY_DIRECTORY)
}


// Control rooms, compiled policy, and the recorded commit each was verified at.
export const factoryConfigPath = (options: HomeOptions = {}): string => join(factoryHome(options), 'factory.json')

// The directory every control-room clone must sit inside. `controlRoomClonePath` produces a path
// and this contains it; they are derived from one expression so they cannot drift apart, which is
// what made the old pair dangerous — a skew here fails every control-room read closed.
export const controlRoomStore = (options: HomeOptions = {}): string => join(factoryHome(options), 'control-room')

export const controlRoomClonePath = (org: string, options: HomeOptions = {}): string => join(controlRoomStore(options), org)

// The checkouts this node knows about. Renamed from `worktree-roots.json`: the old file is a bare
// array of paths and a reader that finds anything else silently resets it, so the rename is what
// protects the old file from a future schema change, not a version field.
export const worktreesPath = (options: HomeOptions = {}): string => join(factoryHome(options), 'worktrees.json')

// The local spool: events, read offsets, push cursors, the cached login. It sat under a hidden
// `.tmp/` before, which is a directory anything tidying a machine would empty — taking with it the
// offsets that stop a log being read twice and the cursors that stop a push duplicating.
export const statsDirectory = (options: HomeOptions = {}): string => join(factoryHome(options), 'stats')

export const statsHtmlPath = (options: HomeOptions = {}): string => join(factoryHome(options), 'stats.html')

// Present only on a machine that accepts unattended work, so the role is visible on disk.
export const workerDirectory = (options: HomeOptions = {}): string => join(factoryHome(options), 'worker')

// The App key. `VEGAFACTORY_APP_PRIVATE_KEY_FILE` still moves it, because a machine may keep its
// keys somewhere this product does not own.
export function appKeyPath(options: HomeOptions = {}): string {
  const named = (options.env ?? process.env).VEGAFACTORY_APP_PRIVATE_KEY_FILE?.trim()
  return named || join(workerDirectory(options), 'app.pem')
}

// ---------------------------------------------------------------------------------------------
// The older home

// This release does not move a machine's state for it, and that is deliberate. The register
// records it: "VegaFactory 0.20.0 is a clean break: the lean rebuild ships with no compatibility
// shims, migration paths or deprecated aliases" (18-09-2026).
//
// It is also the safer answer by some distance. A routine that moves this directory has to reason
// about four lock protocols it does not own, about symlinks at either end and at every path
// component, about permissions, about crossing devices, about being interrupted part-way, and
// about the absolute addresses the records inside it contain — and get all of it right while
// holding the operator's App key and their control-room clones. The same operator runs a handful
// of `mv` lines instead, once per machine, and can see exactly what moved.
//
// So: find it, say precisely what to run, and refuse until it is gone.

export interface OlderHome { found: boolean; reason: string; commands: string[] }

// What the old home called each thing, and what the new one calls it. Two change name as well as
// address, which is why this is a table rather than one `mv`.
const RENAMES: { from: string; to: string }[] = [
  { from: 'factory.json', to: 'factory.json' },
  { from: 'control-room', to: 'control-room' },
  { from: 'worktree-roots.json', to: 'worktrees.json' },
  { from: '.tmp/stats', to: 'stats' },
  { from: 'stats.html', to: 'stats.html' },
  { from: 'vegafactory-app.pem', to: 'worker/app.pem' },
  { from: '.skills-install-transaction.json', to: '.skills-install-transaction.json' },
]

// Directories the old home carried that nothing reads any more: the guard compiled a policy file
// there until it started reading its policy from git.
export const DEAD_ENTRIES = ['guard'] as const

const quoted = (path: string) => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.split("'").join(`'\\''`)}'`)

// Answers only while the new home holds nothing of ours. Once this machine has moved, whatever is
// left behind is the operator's to tidy and no concern of any command that runs afterwards.
export function olderHome(deps: {
  kind: (path: string) => Kind
  list: (path: string) => string[] | null
} & HomeOptions): OlderHome {
  const quiet: OlderHome = { found: false, reason: '', commands: [] }
  // A named home is a caller saying where this product lives — a test, a sandbox, a second
  // checkout. It must not also mean "and go looking at the real machine's older home", whose
  // contents have nothing to do with the directory that was asked about.
  if ((deps.env ?? process.env)[HOME_VARIABLE]?.trim()) return quiet
  const to = factoryHome(deps)
  const from = legacyHome(deps)
  const fromKind = deps.kind(from)
  if (fromKind === 'absent') return quiet
  // Silence here would be fail-open: a symlinked or unreadable older home is not an older home
  // that holds nothing, it is one nobody can answer about.
  if (fromKind !== 'directory') {
    return { found: true, reason: `${from} is not an ordinary directory this account can read, so what this machine keeps there cannot be established — inspect it by hand`, commands: [] }
  }
  const toKind = deps.kind(to)
  if (toKind !== 'absent' && toKind !== 'directory') {
    return { found: true, reason: `${to} is not an ordinary directory, so this release has nowhere it can trust to read — inspect it by hand`, commands: [] }
  }

  const settled = toKind === 'absent' ? [] : deps.list(to)
  // "Cannot be listed" is not "empty", but either way something is there and this machine has
  // already moved; what is left behind is the operator's to tidy.
  if (settled === null || settled.length > 0) return quiet

  const shapes = RENAMES.map((entry) => ({ entry, kind: deps.kind(join(from, ...entry.from.split('/'))) }))
  const strange = shapes.filter((row) => row.kind === 'other' || row.kind === 'unreadable')
  if (strange.length > 0) {
    return {
      found: true,
      reason: `${strange.map((row) => join(from, ...row.entry.from.split('/'))).join(', ')} is not an ordinary file or directory, so it cannot be moved by a line anybody can check — inspect it by hand`,
      commands: [],
    }
  }
  const waiting = shapes.filter((row) => row.kind !== 'absent').map((row) => row.entry)
  const dead = DEAD_ENTRIES.filter((entry) => deps.kind(join(from, entry)) === 'directory')
  if (waiting.length === 0 && dead.length === 0) return quiet

  const needsWorker = waiting.some((entry) => entry.to.includes('/'))
  // Owner-only: this directory holds the App key and the control-room clones, and a umask of 022
  // would otherwise leave it readable by everybody on a shared machine.
  const commands = [`mkdir -m 700 -p ${quoted(to)}${needsWorker ? ` ${quoted(join(to, 'worker'))}` : ''}`]
  for (const entry of waiting) commands.push(`mv ${quoted(join(from, ...entry.from.split('/')))} ${quoted(join(to, ...entry.to.split('/')))}`)
  for (const entry of dead) commands.push(`rm -rf ${quoted(join(from, entry))}`)

  return {
    found: true,
    reason: `this machine keeps its state in ${from}, and this release reads ${to}. Nothing is moved for you: that directory holds the App key and the control-room clones, and a move you can see is a move you can check. With nothing else of this product running, run:`,
    commands,
  }
}

// `factory.json` records where each control room was cloned, as an absolute path, so after the
// move those records still name the old address. `vegafactory sync` already refuses a clone that
// is not where it is recorded, and `--force` re-records it, which is the documented way back.
export const AFTER_THE_MOVE = 'Then, once: vegafactory sync --force — the records still name where each control room used to sit.'

// The one chokepoint: every command passes through here before it reads or writes anything.
export function settleHome(report: (line: string) => void = console.error): OlderHome {
  const result = olderHome({
    kind: pathKind,
    list: (path) => {
      try { return readdirSync(path) } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
      }
    },
  })
  // On stderr, not stdout: a `--json` caller must still get exactly one document.
  if (result.found) {
    report(`vegafactory: ${result.reason}`)
    for (const line of result.commands) report(`vegafactory:   ${line}`)
    report(`vegafactory: ${AFTER_THE_MOVE}`)
  }
  return result
}

// What a path is, told apart properly: "absent" and "this account cannot read it" are different
// answers, and a check that collapses them lets a command carry on believing a directory is empty.
export type Kind = 'absent' | 'directory' | 'file' | 'other' | 'unreadable'

// Every component is checked, not just the last: an intermediate symlink redirects the read just
// as surely as a symlinked leaf, and `ENOTDIR` on the way down means an ancestor is a file —
// which is "something is wrong here", not "nothing is here".
export function pathKind(path: string): Kind {
  const parent = dirname(path)
  if (parent !== path) {
    const above = lstatKind(parent)
    if (above === 'absent') return 'absent'
    if (above !== 'directory') return above === 'unreadable' ? 'unreadable' : 'other'
  }
  return lstatKind(path)
}

function lstatKind(path: string): Kind {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'other'
    if (stat.isDirectory()) return 'directory'
    return stat.isFile() ? 'file' : 'other'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'absent'
    return code === 'ENOTDIR' ? 'other' : 'unreadable'
  }
}

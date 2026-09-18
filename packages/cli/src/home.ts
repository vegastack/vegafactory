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

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

// Directories the old home carried that nothing reads any more. `guard/` went when `guard.ts` did
// — the guard reads its policy from git now — and leaving it behind strands a file that still
// looks authoritative.
export const DEAD_ENTRIES = ['guard', 'policy-snapshots'] as const

export interface HomeOptions { env?: NodeJS.ProcessEnv; home?: string }

// `VEGAFACTORY_HOME` names the directory itself, not the parent: a test points it at a temporary
// directory and everything below follows. An empty or whitespace value is no value.
export function factoryHome(options: HomeOptions = {}): string {
  const named = (options.env ?? process.env)[HOME_VARIABLE]?.trim()
  if (named) return named
  return join(options.home ?? homedir(), FACTORY_DIRECTORY)
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
// Moving off the old home

// What the old home called each thing, and what the new one calls it. The two lists differ, which
// is why the move is a table rather than a copy: `worktree-roots.json` became `worktrees.json`,
// the stats spool came out of a hidden `.tmp/`, and the App key moved under `worker/` where the
// rest of an unattended machine's state lives.
const MOVES: { from: string[]; to: string[] }[] = [
  { from: ['factory.json'], to: ['factory.json'] },
  { from: ['control-room'], to: ['control-room'] },
  { from: ['worktree-roots.json'], to: ['worktrees.json'] },
  { from: ['.tmp', 'stats'], to: ['stats'] },
  { from: ['stats.html'], to: ['stats.html'] },
  { from: ['vegafactory-app.pem'], to: ['worker', 'app.pem'] },
]

export interface Migration { action: 'none' | 'moved' | 'refused'; reason: string; moved: string[] }

// Moved once, loudly, and never straddling both. Everywhere else in this product an unreadable or
// ambiguous state refuses and says what to delete rather than guessing — `factory.json` will not
// migrate its own schema, the stats offsets say "delete it", the installer journal refuses an
// unknown version — and a home in two places is exactly that kind of ambiguity: a run that read
// one and wrote the other would split a machine's memory of itself in half.
export function migrateHome(deps: {
  exists: (path: string) => boolean
  move: (from: string, to: string) => void
  mkdir: (path: string) => void
  remove: (path: string) => void
} & HomeOptions): Migration {
  const to = factoryHome(deps)
  const from = legacyHome(deps)
  if (!deps.exists(from)) return { action: 'none', reason: 'there is no older home to move', moved: [] }

  const waiting = MOVES.filter((entry) => deps.exists(join(from, ...entry.from)))
  const already = MOVES.filter((entry) => deps.exists(join(to, ...entry.to)))
  if (waiting.length === 0) return { action: 'none', reason: 'the older home holds nothing of ours', moved: [] }
  if (already.length > 0) {
    const both = already.map((entry) => entry.to.join('/')).join(', ')
    return {
      action: 'refused',
      reason: `${to} and ${from} both hold this product's state (${both}) — a run that read one and wrote the other would split this machine's memory in half. Keep the one that is current, delete the other, and run again`,
      moved: [],
    }
  }

  const moved: string[] = []
  deps.mkdir(to)
  for (const entry of waiting) {
    const target = join(to, ...entry.to)
    if (entry.to.length > 1) deps.mkdir(join(to, ...entry.to.slice(0, -1)))
    deps.move(join(from, ...entry.from), target)
    moved.push(`${entry.from.join('/')} → ${entry.to.join('/')}`)
  }
  // Gone with the code that read them: the guard compiled a policy file here until it started
  // reading policy from git, and the snapshots went with the model that needed them.
  for (const dead of DEAD_ENTRIES) {
    const path = join(from, dead)
    if (deps.exists(path)) { deps.remove(path); moved.push(`${dead} → removed, nothing reads it`) }
  }
  return { action: 'moved', reason: `moved this machine's state from ${from} to ${to}`, moved }
}

// The one chokepoint. Nothing used to create the home — four writers made it lazily, each in its
// own way — so there was nowhere to hang a move. Every command passes through here first.
export function settleHome(report: (line: string) => void = console.error): Migration {
  const result = migrateHome({
    exists: (path) => existsSync(path),
    move: (from, to) => renameSync(from, to),
    mkdir: (path) => { mkdirSync(path, { recursive: true }) },
    remove: (path) => { rmSync(path, { recursive: true, force: true }) },
  })
  // On stderr, not stdout: a `--json` caller must still get one document, and this speaks once in
  // the life of a machine.
  if (result.action === 'moved') {
    report(`vegafactory: ${result.reason}`)
    for (const line of result.moved) report(`vegafactory:   ${line}`)
  }
  if (result.action === 'refused') report(`vegafactory: ${result.reason}`)
  return result
}

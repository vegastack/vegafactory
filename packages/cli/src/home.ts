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

import { accessSync, constants, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'

import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

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
// looks authoritative. Only what the plan named is removed: this is the one destructive step in
// the move, so it deletes by an explicit list and never by inference.
export const DEAD_ENTRIES = ['guard'] as const

export interface HomeOptions { env?: NodeJS.ProcessEnv; home?: string }

// `VEGAFACTORY_HOME` names the directory itself, not the parent: point it at a temporary directory
// and everything below follows. An empty or whitespace value is no value.
//
// The variable wins outright when it is set: it is the whole home, not a base to build one from.
// A caller that must not be reached by an ambient setting passes its own `env`.
export function factoryHome(options: HomeOptions = {}): string {
  const named = (options.env ?? process.env)[HOME_VARIABLE]?.trim()
  return named || join(options.home ?? homedir(), FACTORY_DIRECTORY)
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
// Records that name absolute paths inside the home, and so cannot simply be carried.
const RECORDS_PATHS = new Set(['factory.json'])

const MOVES: { from: string[]; to: string[]; shape: Kind }[] = [
  { from: ['factory.json'], to: ['factory.json'], shape: 'file' },
  // The settings writer's pre-image. A machine that moved without it would take the file and
  // leave the evidence of a half-finished edit where nothing will ever look again.
  { from: ['factory.json.schema1.bak'], to: ['factory.json.schema1.bak'], shape: 'file' },
  { from: ['control-room'], to: ['control-room'], shape: 'directory' },
  { from: ['worktree-roots.json'], to: ['worktrees.json'], shape: 'file' },
  { from: ['.tmp', 'stats'], to: ['stats'], shape: 'directory' },
  { from: ['stats.html'], to: ['stats.html'], shape: 'file' },
  { from: ['vegafactory-app.pem'], to: ['worker', 'app.pem'], shape: 'file' },
  // A global skill install keeps its journal here. Leaving it means an interrupted install is
  // never recovered — the next add rolls its backups forward and brings back skills somebody
  // removed.
  { from: ['.skills-install-transaction.json'], to: ['.skills-install-transaction.json'], shape: 'file' },
]

// A lock means a process may be writing inside a directory this move would rename out from under
// it. Any lock stops the move, and none is ever removed by it.
//
// Nothing here tries to work out whether a lock is dead. Three of the four protocols say not to:
// `factory.json.guard` is explicitly never stolen, `lockOrg`'s `<org>.lock` is never stolen and
// carries no owner file at all, and both are taken before anything is written inside them — so an
// ownerless lock is as likely to be a live process one line earlier as it is to be litter. Only
// the installer's lock documents a steal, and having one rule here beats having four. Guessing
// wrong renames a directory out from under a live writer; guessing right saves an operator one
// `rm` of a path this message names, once in the life of a machine.
// Everywhere a lock can sit under either home, including inside the directories this move renames.
function lockPaths(home: string, list: (path: string) => string[] | null): string[] {
  const rooms = (list(join(home, 'control-room')) ?? []).filter((entry) => entry.endsWith('.lock') || entry.endsWith('.lock.steal'))
  return [
    join(home, '.skills-install.lock'),
    join(home, 'factory.json.guard'),
    // `.lock.steal` is the takeover mutex: during a steal the ordinary `.lock` is gone for an
    // instant while this one is held, and a scan that watched only `.lock` would see a quiet
    // directory and rename it out from under the process doing the stealing.
    ...['stats', join('.tmp', 'stats')].flatMap((spool) => [
      join(home, spool, '.lock'), join(home, spool, '.lock.steal'),
      join(home, spool, 'push', '.lock'), join(home, spool, 'push', '.lock.steal'),
    ]),
    ...rooms.flatMap((entry) => [join(home, 'control-room', entry), join(home, 'control-room', `${entry}.steal`)]),
  ]
}

export interface Migration { action: 'none' | 'moved' | 'refused'; reason: string; moved: string[] }

// Moved once, loudly, and never straddling both. Everywhere else in this product an unreadable or
// ambiguous state refuses and says what to delete rather than guessing — `factory.json` will not
// migrate its own schema, the stats offsets say "delete it", the installer journal refuses an
// unknown version — and a home in two places is exactly that kind of ambiguity: a run that read
// one and wrote the other would split a machine's memory of itself in half.
// What a path is, told apart properly: "absent" and "this account cannot read it" are different
// answers, and a check that collapses them lets a run carry on with its memory split across two
// homes. A symlink is never followed — either end of this move could otherwise land somewhere
// neither path names.
export type Kind = 'absent' | 'directory' | 'file' | 'other' | 'unreadable'

export function migrateHome(deps: {
  kind: (path: string) => Kind
  // null when the directory is there but cannot be listed: "unknown" must never read as "empty".
  list: (path: string) => string[] | null
  readable: (path: string, shape: Kind) => boolean
  // Copies a record across, rewriting every path under the older home as it goes, and removes the
  // original. Returns how many paths it rewrote.
  rebaseInto: (source: string, target: string, from: string, to: string) => number
  // The same, in place, for every JSON file directly inside a directory.
  rebaseUnder: (directory: string, from: string, to: string) => number
  move: (from: string, to: string) => void
  mkdir: (path: string) => void
  remove: (path: string) => void
} & HomeOptions): Migration {
  // An explicit home is a caller saying where it wants this product to live — a test, a sandbox, a
  // second checkout. It must never also mean "and go and fetch the real machine's state into it":
  // the source would still be the operator's own `~/.vegastack`, and a temporary override that is
  // deleted afterwards would take their control room, their config and their App key with it.
  if ((deps.env ?? process.env)[HOME_VARIABLE]?.trim()) {
    return { action: 'none', reason: `${HOME_VARIABLE} names the home, so nothing is moved into it`, moved: [] }
  }
  const to = factoryHome(deps)
  const from = legacyHome(deps)
  // Movable means an ordinary file or directory. A symlink, a device node or a path this account
  // cannot read is none of those, and following one would move state out of, or into, somewhere
  // neither home names.
  const MOVABLE: Kind[] = ['file', 'directory']
  const there = (path: string) => MOVABLE.includes(deps.kind(path))
  const odd = (path: string) => { const kind = deps.kind(path); return kind !== 'absent' && !MOVABLE.includes(kind) }

  // Both ends must be ordinary directories this account can read, or not be there at all.
  for (const [path, which] of [[from, 'older'], [to, 'new']] as const) {
    const kind = deps.kind(path)
    if (kind === 'absent' || kind === 'directory') continue
    return {
      action: 'refused',
      reason: kind === 'unreadable'
        ? `${path} cannot be read by this account, so whether the ${which} home holds anything is unknown — fix its permissions and run again`
        : `${path} is not an ordinary directory, so the ${which} home cannot be moved safely — inspect it by hand`,
      moved: [],
    }
  }
  if (deps.kind(from) === 'absent') return { action: 'none', reason: 'there is no older home to move', moved: [] }

  // Everything that could refuse is decided before anything is touched. A refusal that had already
  // deleted something would be a refusal the operator cannot trust the word of.
  //
  // Both homes are checked: a live lock in the destination means something is writing there now,
  // and moving a file on top of it would clobber a journal mid-write or split the settings.
  const held = [from, to].flatMap((home) => lockPaths(home, deps.list)).filter((path) => deps.kind(path) !== 'absent')
  if (held.length > 0) {
    return {
      action: 'refused',
      reason: `a lock is held there (${held.join(', ')}) — this move would rename a directory out from under whatever took it, and three of these four locks are never stolen even by the code that owns them. Run again once the work has finished; if you know nothing holds it, remove that path and run again`,
      moved: [],
    }
  }

  // Each entry must be the shape it is supposed to be. A symlinked `factory.json` moved across and
  // then followed reads whatever it points at as this machine's own configuration; a *directory*
  // named `factory.json` is not this product's file at all.
  const strange: string[] = []
  for (const entry of MOVES) {
    for (const path of [join(from, ...entry.from), join(to, ...entry.to)]) {
      const kind = deps.kind(path)
      if (kind === 'absent') continue
      if (kind !== entry.shape) { strange.push(`${path} is ${kind === 'unreadable' ? 'unreadable' : `not a ${entry.shape}`}`); continue }
      // Present and the right shape is not enough: a mode-000 file or a directory this account
      // cannot list moves across perfectly well and is unreadable at the far end.
      if (!deps.readable(path, entry.shape)) strange.push(`${path} cannot be read by this account`)
    }
  }
  if (strange.length > 0) {
    return { action: 'refused', reason: `${strange.join('; ')}, so it cannot be moved safely — inspect it by hand`, moved: [] }
  }

  const waiting = MOVES.filter((entry) => there(join(from, ...entry.from)))
  // Anything at all in the destination, not merely a name this table knows. A newer release may
  // keep things here that this one has never heard of, and moving an older copy in beside them is
  // the same split by another route.
  const already = deps.list(to)
  if (already === null) {
    return { action: 'refused', reason: `${to} is there but cannot be listed by this account, so whether it already holds state is unknown — fix its permissions and run again`, moved: [] }
  }
  if (already.length > 0 && waiting.length > 0) {
    return {
      action: 'refused',
      reason: `${to} and ${from} both hold this product's state (${already.slice(0, 6).join(', ')}) — a run that read one and wrote the other would split this machine's memory in half. Keep the one that is current, delete the other, and run again`,
      moved: [],
    }
  }

  const moved: string[] = []
  // Removed whether or not anything else moves: a machine whose only leftover is the dead guard
  // directory is exactly the machine that would otherwise keep it forever.
  for (const dead of DEAD_ENTRIES) {
    const path = join(from, dead)
    // The directory is what nothing reads. A regular file of the same name is something else
    // somebody put there, and deleting it would be this move inventing a reason to.
    if (deps.kind(path) === 'directory') { deps.remove(path); moved.push(`${dead} → removed, nothing reads it`) }
  }
  if (waiting.length === 0) {
    return moved.length
      ? { action: 'moved', reason: `removed what nothing reads from ${from}`, moved }
      : { action: 'none', reason: 'the older home holds nothing of ours', moved: [] }
  }

  deps.mkdir(to)
  let rebased = 0
  for (const entry of waiting) {
    const target = join(to, ...entry.to)
    if (entry.to.length > 1) deps.mkdir(join(to, ...entry.to.slice(0, -1)))
    // A record that names absolute paths is rewritten on the way across rather than moved and then
    // edited: there must be no instant in which the destination holds the old addresses, because
    // another command can start in it the moment the last legacy entry is gone.
    if (RECORDS_PATHS.has(entry.to.join('/'))) rebased += deps.rebaseInto(join(from, ...entry.from), target, from, to)
    else deps.move(join(from, ...entry.from), target)
    moved.push(`${entry.from.join('/')} → ${entry.to.join('/')}`)
  }
  // The push journals live inside the spool that has just moved, and each names the clone it was
  // written for. `recoverPush` refuses one whose room is not where it says.
  rebased += deps.rebaseUnder(join(to, 'stats', 'push-pending'), from, to)
  if (rebased > 0) moved.push(`${rebased} recorded path${rebased === 1 ? '' : 's'} rebased onto ${to}`)
  return { action: 'moved', reason: `moved this machine's state from ${from} to ${to}`, moved }
}

// Every string anywhere in the record that begins with the older home, moved to the new one. It
// walks the whole document rather than named fields: the snapshot entries nest, and a path this
// release has not heard of is still a path that will be wrong tomorrow.
export function rebasePaths(value: unknown, from: string, to: string): { value: unknown; changed: number } {
  let changed = 0
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node !== from && !node.startsWith(from + sep)) return node
      changed += 1
      return to + node.slice(from.length)
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]))
    }
    return node
  }
  return { value: walk(value), changed }
}

// `rename` cannot cross a device, and a home can be mounted separately from the directory it sits
// in. Copy first and remove only once the copy is whole, so a failure leaves the original.
export function movePath(from: string, to: string, deps: {
  rename: (from: string, to: string) => void
  copy: (from: string, to: string) => void
  remove: (path: string) => void
}): void {
  try { deps.rename(from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    deps.copy(from, to)
    deps.remove(from)
  }
}

// Every component is checked, not just the last: an intermediate symlink would redirect the read
// just as surely as a symlinked leaf, and `ENOTDIR` on the way down means an ancestor is a file —
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

// The one chokepoint. Nothing used to create the home — four writers made it lazily, each in its
// own way — so there was nowhere to hang a move. Every command passes through here first.
export function settleHome(report: (line: string) => void = console.error): Migration {
  const result = migrateHome({
    kind: pathKind,
    list: (path) => {
      try { return readdirSync(path) } catch (error) {
        // Absent is empty; anything else is unknown, and unknown must not read as empty.
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
      }
    },
    rebaseInto: (source, target, from, to) => {
      const text = readFileSync(source, 'utf8')
      let changed = 0
      let output = text
      try {
        const rebasedValue = rebasePaths(JSON.parse(text), from, to)
        changed = rebasedValue.changed
        if (changed > 0) output = `${JSON.stringify(rebasedValue.value, null, 2)}\n`
      } catch { /* not JSON this release understands: carried across exactly as it is */ }
      writeFileSync(target, output)
      rmSync(source, { force: true })
      return changed
    },
    rebaseUnder: (directory, from, to) => {
      let changed = 0
      for (const name of (() => { try { return readdirSync(directory) } catch { return [] } })()) {
        if (!name.endsWith('.json')) continue
        const path = join(directory, name)
        try {
          const rebasedValue = rebasePaths(JSON.parse(readFileSync(path, 'utf8')), from, to)
          if (rebasedValue.changed > 0) { writeFileSync(path, `${JSON.stringify(rebasedValue.value, null, 2)}\n`); changed += rebasedValue.changed }
        } catch { /* leave anything unreadable exactly as it is */ }
      }
      return changed
    },
    readable: (path, shape) => {
      try {
        // A directory needs search as well as read: one that lists but cannot be entered moves
        // across perfectly well and nothing inside it can be opened at the far end.
        if (shape === 'directory') { accessSync(path, constants.R_OK | constants.X_OK); readdirSync(path) }
        else accessSync(path, constants.R_OK)
        return true
      } catch { return false }
    },
    move: (from, to) => movePath(from, to, {
      rename: renameSync,
      copy: (a, b) => { cpSync(a, b, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }) },
      remove: (path) => { rmSync(path, { recursive: true, force: true }) },
    }),
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

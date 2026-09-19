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


import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

// The one escape hatch, and the reason the tests can run at all: `worktree.ts` used to call
// `homedir()` with no way to pass anything else, so a careless test wrote to the real home.
export const HOME_VARIABLE = 'VEGAFACTORY_HOME'

export const FACTORY_DIRECTORY = '.vegafactory'

// What lives directly under the home. Everything else hangs off one of these, so there is exactly
// one list to consult when the question is "is this ours?".
export const OWNED_ENTRIES = ['factory.json', 'control-room', 'worktrees.json', 'stats', 'stats.html', 'worker'] as const

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

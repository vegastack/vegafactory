// `vegafactory worker …` — the listed machine that works the board on its own.
//
// It refuses to run at all unless this machine is named in the control room's `nodes.md`,
// refreshed and verified before every pass: the roster is the enrolment, and removing a row is how
// a machine is stood down.
//
// Every write reaching GitHub from this machine — the worker's own bookkeeping and everything
// the agent runs it starts post — goes out as the VegaFactory GitHub App, on an hour-long
// installation token minted here from the private key. The agent still *thinks* on the operator's
// own subscription, so an API key in the environment refuses the whole command. Nothing the App
// writes is ever an approval: an ack, a stop, a correction and a "ship it" need a person with
// write access, which is what keeps a run from consenting to its own work.
//
// Three things this does not cover, each needing the fleet-wide lease tracked separately:
//
// - **The run caps are per machine.** Two machines listed for one repository can each run three
//   steps at once, and each can merge one at a time.
// - **The hand-over window.** An implement run releases this machine's claim just before the agent
//   claims for itself; in those seconds a second machine's poll sees a free issue.
// - **Retry and reset deadlines are local.** `acted.json` is this machine's memory, so a backoff
//   or a subscription-reset wait binds this machine only: another machine can start that work
//   before the deadline this one is keeping.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createSign, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join, parse, posix, resolve, sep } from 'node:path'
import { APP_ACTOR, APP_ID, HEARTBEAT_EVERY_MS, appIdentityConfig, claim, heartbeat, holderOf, machineName, nodeId, release, trustedFactory } from './claim.ts'
import { defaultClonePath, factoryConfigPath, parseControlRoomKnob, readFactoryConfig, updateSettingsAtPath } from './control-room.ts'
import { billingVariables, childEnvironment } from './env.ts'
import { GhError, ghList, type GhResult, type GhRunner } from './gh.ts'
import { assertRepo, cacheDir, readState, replaceFile, syncIssue, withLock, type CommentEntry, type GhIssue, type IssueEntry } from './issue-cache.ts'
import {
  ackBody, artifactHash, currentHashes, detectRepo, evidenceChangedAt, findValidAck, locked, markerKeys, nextLabels, permissionLookup,
  postComment, repoRoot, setLabels, snapshot, type PermissionLookup, type Snapshot,
} from './issue.ts'
import { issueFromBranch } from './hook.ts'
import { defaultBranch } from './guard-rules.ts'
import { stateOf, type State } from './labels.ts'
import { effectiveUpdateMode, maintainSelfUpdate, type UpdateMode, type UpdateResult } from './self-update.ts'
import { lintPlan, normalizeGroupPath, parseIndependentGroups, sharedByEveryChild } from '../../../skills/dev/dev-plan/scripts/plan-lint.mjs'
import { appKeyPath as workerAppKey, factoryHome, workerBoardsPath, workerDirectory, type HomeOptions } from './home.ts'
import { canonicalRepository, ensureWorkerCheckout } from './worker-repo.ts'

// How often the board is read, how many steps run at once, and how long one step may take.
export const POLL_MS = 2 * 60_000
export const MAX_RUNS = 3
export const STEP_TIMEOUT_MS = 20 * 60_000
// A failed step waits this long before the next try, doubling each time, and is parked after three.
export const RETRY_MS = 15 * 60_000
export const MAX_FAILURES = 3
// What a run's own output contributes to its record; the output never reaches the issue.
export const MAX_NOTE = 400

export const SERVICE_NAME = 'com.vegastack.vegafactory.worker'

// ---------------------------------------------------------------------------------------------
// The roster: the control room's nodes.md

// What one machine may do at once, and for how long. These belong to the machine — its processor,
// its subscription — and not to any project it works, so they live on its roster row rather than in
// a repository's dev.md, and they are re-read from the refreshed roster every pass: changing one is
// a control-room PR that takes effect on the next poll rather than a release.
export interface Caps { runs: number; stepMs: number; pollMs: number; retryMs: number; failures: number }

// Node's timers are a signed 32-bit count of milliseconds: a longer delay overflows and fires at
// once, which would be the opposite of the limit asked for. About 24.8 days.
export const MAX_TIMER_MS = 2 ** 31 - 1

export const DEFAULT_CAPS: Caps = { runs: MAX_RUNS, stepMs: STEP_TIMEOUT_MS, pollMs: POLL_MS, retryMs: RETRY_MS, failures: MAX_FAILURES }

// `runs 10 · step 72h · poll 1m · retry 15m · park 3`, in any order, separated by `·` or a comma.
// Every field is optional and falls back to the shipped default. A field that is present and
// unreadable returns null and the caller drops that machine: guessing a cap would be choosing a
// number on the operator's behalf, and a cap nobody can read is not a cap.
// A duration written the way that field accepts it, so what is printed can be pasted back into
// the cell it came from. `poll 60m` must not read back as `poll 1h`, which `parseCaps` refuses.
const FIELD_UNITS: Record<'step' | 'poll' | 'retry', ('h' | 'm' | 's')[]> = { step: ['h', 'm'], poll: ['m', 's'], retry: ['m'] }

// The field is required rather than defaulted: a default is what makes a dropped argument silent,
// and the two bugs this fixed were both a call site printing a duration in the wrong field's units.
export function sayDuration(ms: number, field: 'step' | 'poll' | 'retry'): string {
  const size = { h: 3_600_000, m: 60_000, s: 1000 }
  for (const unit of FIELD_UNITS[field]) if (ms % size[unit] === 0) return `${ms / size[unit]}${unit}`
  // Not a whole number of any unit the field takes — say the smallest one it does, rounded up, so
  // the number stays a limit rather than becoming zero.
  const smallest = FIELD_UNITS[field].at(-1)!
  return `${Math.max(1, Math.ceil(ms / size[smallest]))}${smallest}`
}

export function parseCaps(cell: string): Caps | null {
  const caps = { ...DEFAULT_CAPS }
  const text = String(cell ?? '').trim()
  if (!text) return caps
  // What each field takes: a plain count, or a duration in the units that field is measured in.
  // `poll 2h` and `step 10s` are refused because neither is a limit anybody means.
  const UNITS: Record<string, string[]> = { runs: [], park: [], step: ['m', 'h'], poll: ['s', 'm'], retry: ['m'] }
  // An empty segment is a separator with nothing beside it — `·`, `runs 10 ·`, `runs 10,,poll 1m`.
  // Dropping those would read a half-typed cell as the defaults, and a gate does not do that.
  for (const field of text.split(/[·,]/).map((part) => part.trim())) {
    const match = /^(runs|step|poll|retry|park)\s+(\d+)\s*([hms]?)$/i.exec(field)
    if (!match) return null
    const name = match[1]!.toLowerCase()
    const value = Number(match[2])
    const unit = match[3]!.toLowerCase()
    if (!Number.isFinite(value) || value <= 0) return null
    const allowed = UNITS[name]!
    if (allowed.length === 0) {
      if (unit) return null
      if (name === 'runs') caps.runs = value
      else caps.failures = value
      continue
    }
    if (!allowed.includes(unit)) return null
    const ms = value * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000)
    if (ms > MAX_TIMER_MS) return null
    if (name === 'step') caps.stepMs = ms
    else if (name === 'poll') caps.pollMs = ms
    else caps.retryMs = ms
  }
  return caps
}

// `caps` is null when this row's limits cannot be established, and `problem` says why. The row
// survives so the machine it names is refused by name — a roster that silently dropped the row
// would refuse it as "not listed", which sends the operator looking for a missing row rather than
// at the thing that is actually wrong.
// `worker` is the gate. Every machine has a row once a control room lists its nodes, so being in
// the file authorises nothing; only `worker: yes` does. A row from a roster with no worker column
// at all is one written before the column existed, and is read the way it was written.
export interface Node { machine: string; operator: string | null; repos: string[]; caps: Caps | null; worker: boolean; problem: string | null }

// What a roster may call each column. A header maps a name to a position, so a row is read by what
// its columns are called rather than by where they happen to sit: a room may add, drop or reorder
// columns, and a notes column is never mistaken for caps.
const COLUMN_NAMES = {
  machine: ['node', 'machine'],
  operator: ['operator', 'owner'],
  repos: ['repos', 'repositories'],
  caps: ['caps'],
  worker: ['worker'],
} as const

interface Layout { machine: number; operator: number | null; repos: number; caps: number | null; worker: number | null; misnamed: boolean }

// A table is read by its header or not at all. There is no position a cell is known to sit in, so
// a row before any header names nothing and grants nothing — it is reported as the missing header
// rather than guessed at by counting cells.
const UNREADABLE_CAPS = 'the caps cell cannot be read — the shape is `runs 10 · step 72h · poll 1m · retry 15m · park 3`, every field optional'
const MISSING_CAPS = 'the row does not reach its declared caps column — add an empty cell or `-` when the defaults are fine'
const UNREADABLE_WORKER = 'the worker cell says something this file does not read as an answer — it takes `yes` or `no`, and anything else is refused rather than guessed at'
const MISNAMED_WORKER = 'the gate column is not named `worker`, so nothing here grants unattended work — rename the heading'
const NO_GATE = 'the roster has no `worker` column, so nothing in it grants unattended work — add one, and `yes` on the rows that should have it'

// A header is the row that names at least the machine column and the repos column. Anything less
// is not a header, and reading it as one would silently move every column.
// A heading that is trying to be the gate and missing it — `workers`, `worker?`, `Worker (y/n)`.
// Read as "no worker column at all" it would grant every row, which is the opposite of what
// somebody writing that heading meant.
const NEARLY_WORKER = /worker/i

function layoutOf(row: string[]): Layout | null {
  const at = (names: readonly string[]) => {
    const found = row.findIndex((cell) => names.includes(cell.toLowerCase()))
    return found === -1 ? null : found
  }
  const machine = at(COLUMN_NAMES.machine)
  const repos = at(COLUMN_NAMES.repos)
  if (machine === null || repos === null) return null
  const worker = at(COLUMN_NAMES.worker)
  const nearly = row.findIndex((cell) => NEARLY_WORKER.test(cell))
  return { machine, operator: at(COLUMN_NAMES.operator), repos, caps: at(COLUMN_NAMES.caps), worker: worker ?? (nearly === -1 ? null : nearly), misnamed: worker === null && nearly !== -1 }
}

const cells = (line: string) => line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())

// The header this roster actually has, so advice about adding a row can match the table rather
// than the shape this code would have chosen.
function headerOf(text: string): string[] | null {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const row = cells(line)
    if (!row.some(separator) && layoutOf(row)) return row
  }
  return null
}

// What to put under each column of that header. A cap this code invented would be a number the
// operator never chose, so the caps cell is left empty, which is how a row says the defaults are fine.
function suggestedCell(column: string, machine: string, repo: string): string {
  const name = column.toLowerCase()
  if (COLUMN_NAMES.machine.includes(name as (typeof COLUMN_NAMES.machine)[number])) return machine
  if (COLUMN_NAMES.repos.includes(name as (typeof COLUMN_NAMES.repos)[number])) return repo
  if (COLUMN_NAMES.operator.includes(name as (typeof COLUMN_NAMES.operator)[number])) return '<operator>'
  // The gate is filled in, because a row pasted from here is a row somebody is adding so this
  // machine can work a board — and left blank it would be refused by the very next check.
  if (COLUMN_NAMES.worker.includes(name as (typeof COLUMN_NAMES.worker)[number])) return 'yes'
  return ''
}
const separator = (cell: string) => /^:?-{2,}:?$/.test(cell)

// How a roster cell and this machine are spelled so they can be compared. A node id is normalised
// on each side of its `@`; anything else is a bare hostname from a roster written before them.
export function rosterName(value: string): string {
  const text = String(value ?? '').trim()
  if (!text.includes('@')) return machineName(text)
  // Exactly one `@`, and something on both sides of it. `mk@box@anything` would otherwise be cut
  // down to `mk@box` and authorise the real node, and an empty half would fall back to the
  // stand-in names and let `@box` or `mk@` match a machine nobody wrote down.
  const halves = text.split('@')
  // Both halves must survive normalising to something. `nodeId` substitutes `someone` and
  // `machine` for a half that comes out empty, so `!!!@???` would otherwise become the very name a
  // machine falls back to when it cannot read its own identity — and authorise it.
  if (halves.length !== 2 || !halves.every((half) => /[a-z0-9]/i.test(half))) return ''
  return nodeId(halves[0]!, halves[1]!)
}

// One row per machine. A table names its columns in a header row, and a bullet is
// `- node — repos`. `*` or `all` means every repository of the org; an empty cell means none.
export function parseNodes(text: string): Node[] {
  const found: Node[] = []
  let layout: Layout | null = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    let machine = ''
    let operator: string | null = null
    let repos = ''
    let capsCell = ''
    let named = false
    let problem: string | null = null
    // No worker column, no worker. There are no rosters in the wild written before the gate — the
    // only control room that exists is being written now — so a file that does not say `yes`
    // grants nothing, and there is no older shape to be compatible with and get wrong.
    let worker = false
    if (line.startsWith('|')) {
      const row = cells(line)
      // Only a row that is *entirely* separators is the line under a header. A notes cell holding
      // `--` would otherwise drop the whole row, and a row that vanishes is a machine that looks
      // unlisted rather than one whose notes column has a dash in it.
      if (row.every(separator)) continue
      const header = layoutOf(row)
      if (header) { layout = header; continue }
      // A row before any header. Nothing says which cell is the machine, so counting them would be
      // a guess, and a gate does not guess: the table contributes no rows and `listedHere` reports
      // the missing header, which is the one thing that would fix it.
      if (!layout) continue
      // A row the header does not reach is a shape nobody wrote on purpose. The roster is a gate,
      // so it refuses rather than widens — a truncated row must not read as "every repository".
      if (row.length <= Math.max(layout.machine, layout.repos)) continue
      machine = row[layout.machine] ?? ''
      operator = layout.operator === null ? null : row[layout.operator] ?? null
      repos = row[layout.repos] ?? ''
      capsCell = layout.caps === null ? '' : row[layout.caps] ?? ''
      named = layout.caps !== null
      if (layout.caps !== null && row.length <= layout.caps) problem = MISSING_CAPS
      if (layout.worker !== null) {
        const said = (row[layout.worker] ?? '').trim().toLowerCase()
        if (said === 'yes') worker = true
        else if (said === 'no' || said === '' || said === '-') worker = false
        // Not an answer: `y`, `true`, `TODO confirm`. A gate does not read a shape nobody wrote on
        // purpose as consent, so the row is kept and its machine refused by name.
        else { worker = false; problem ??= UNREADABLE_WORKER }
        if (row.length <= layout.worker) { worker = false; problem ??= UNREADABLE_WORKER }
        if (layout.misnamed) { worker = false; problem ??= MISNAMED_WORKER }
      } else {
        // Nothing to say per row: a roster with no gate is a fault in the file, not in any of its
        // rows, and `listedHere` reports it where the refusal is made.
      }
    } else {
      const match = /^-\s+`?([A-Za-z0-9][\w.-]*)`?\s*(?:—|--)\s*(.*)$/.exec(line)
      if (!match) continue
      machine = match[1]!
      repos = match[2] ?? ''
    }
    // A node is `<os-user>@<hostname>`, and `machineName` maps every non-alphanumeric to a dash —
    // it would turn `mk@patrick-mac-mini` into `mk-patrick-mac-mini` and no row would ever match.
    // A cell with no `@` is a hostname written before node ids existed, and keeps its old spelling.
    const name = rosterName(machine.replace(/`/g, ''))
    if (!machine.trim() || COLUMN_NAMES.machine.includes(name as (typeof COLUMN_NAMES.machine)[number])) continue
    // A declared caps column is read whatever it holds: guessing a cap would be choosing a number
    // on the operator's behalf. `-` and an empty cell are how a row says "the defaults are fine".
    let caps: Caps | null = null
    if (problem) caps = null
    else if (named && capsCell !== '-' && capsCell !== '') {
      caps = parseCaps(capsCell)
      if (!caps) problem = UNREADABLE_CAPS
    } else caps = { ...DEFAULT_CAPS }
    found.push({
      machine: name,
      operator: operator && operator !== '-' ? operator.replace(/^@/, '') : null,
      repos: repos.split(/[,\s]+/).map((repo) => repo.replace(/`/g, '').trim()).filter((repo) => repo && repo !== '-'),
      caps,
      worker,
      problem,
    })
  }
  return found
}

export const nodesPath = (clone: string) => join(clone, 'nodes.md')

// Where this machine's copy of the org control room lives: the path the last sync recorded, else
// the default clone path for the org this repository's dev.md names.
type WorkerHomeInput = string | HomeOptions
const workerHomeOptions = (input: WorkerHomeInput = {}): HomeOptions => typeof input === 'string' ? { home: input } : input

export function controlRoomClone(root: string, input: WorkerHomeInput = {}): { org: string; repo: string; clone: string } | null {
  const options = workerHomeOptions(input)
  const devMd = join(root, '.vegastack', 'dev.md')
  const knob = existsSync(devMd) ? parseControlRoomKnob(readFileSync(devMd, 'utf8')) : null
  if (!knob) return null
  let path: string | null = null
  try { path = readFactoryConfig(readFileSync(factoryConfigPath(options), 'utf8')).controlRooms[knob.org]?.path ?? null } catch { path = null }
  return { org: knob.org, repo: knob.repo, clone: path ?? defaultClonePath(knob.org, options) }
}

export type GitRun = (args: string[]) => { status: number | null; out: string }

export const gitIn = (dir: string, env: NodeJS.ProcessEnv = process.env): GitRun => (args) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

export interface Refresh { ok: boolean; reason: string; sha: string | null }

// The roster on disk is only as good as its last fetch. A machine de-listed in a control-room PR
// has to stop, and a file edited on the machine itself must never be the thing that authorises it,
// so the copy is fast-forwarded from its remote and refused if it is not exactly what is committed
// there. Every failure is a refusal: an out-of-date gate is not a gate.
//
// TODO(#221): the control room lands `verifiedRoom`/`loadProfile`, which verify the whole room
// against its recorded commit. Use them here once they are on main and drop this local check.
export function refreshRoster(clone: string, git: GitRun = gitIn(clone)): Refresh {
  if (git(['rev-parse', '--git-dir']).status !== 0) return { ok: false, reason: `${clone} is not a git clone of the control room — remove it and run \`vegafactory sync\``, sha: null }
  if (git(['ls-files', '--error-unmatch', 'nodes.md']).status !== 0) return { ok: false, reason: 'nodes.md is not committed in the control room, so nothing vouches for it', sha: null }
  const dirty = git(['status', '--porcelain', '--', 'nodes.md'])
  if (dirty.status !== 0 || dirty.out) return { ok: false, reason: 'nodes.md has uncommitted local changes — a roster edited on the machine authorises nothing; reset it and enrol through a control-room PR', sha: null }
  const fetched = git(['fetch', '--quiet', 'origin'])
  if (fetched.status !== 0) return { ok: false, reason: `the control room could not be refreshed (${fetched.out.split('\n')[0] || 'fetch failed'}), so this machine cannot prove it is still listed`, sha: null }
  const upstream = git(['rev-parse', '--verify', '--quiet', '@{u}'])
  if (upstream.status !== 0) return { ok: false, reason: 'the control-room clone tracks no upstream branch, so there is nothing to refresh it from', sha: null }
  const merged = git(['merge', '--ff-only', '@{u}'])
  if (merged.status !== 0) return { ok: false, reason: `the control-room clone has diverged from its remote (${merged.out.split('\n')[0] || 'no fast-forward'}) — fix it by hand`, sha: null }
  // Only a real commit is a commit. `git` answers a failure on the same channel this reads, so
  // without the shape check an error string could be recorded as the clone's position — and every
  // later profile read would reject the clone for being somewhere it never was.
  const head = git(['rev-parse', 'HEAD'])
  const sha = head.status === 0 && /^[0-9a-f]{40}$/.test(head.out.trim()) ? head.out.trim() : null
  // The merge above may have moved the clone. If where it landed cannot be read, the refresh is
  // not a success with a detail missing: nothing can record the new position, so every later
  // profile read would reject the clone as moved while this said it was refreshed.
  if (!sha) return { ok: false, reason: `the control-room clone was refreshed but its commit could not be read (${head.out.split('\n')[0] || `exit ${head.status}`})`, sha: null }
  return { ok: true, reason: 'refreshed from the control room', sha }
}

export interface Listing { ok: boolean; reason: string; entry: Node | null; file: string | null; sha?: string | null }

// `--repo` locates the control room and may later disappear from an otherwise valid explicit
// board list. That one mismatch is tolerated; wildcard rows and every other refusal remain a
// refusal at startup and on every refreshed pass.
const workerListingAllowed = (listing: Listing, bootstrapRepo: string): boolean => listing.ok
  || (listing.entry?.worker === true && listing.entry.caps !== null
    && normalizeWorkerRepos(listing.entry.repos).repos.length > 0
    && listing.reason.endsWith(`, not ${bootstrapRepo}`))

// `listedHere`, but only after the roster has been refreshed and verified. This is what a run
// asks each pass; a read-only view may ask `listedHere` alone and show what it has.
// The refresh moves the clone forward; this records where it moved to. `loadProfile` verifies the
// working tree against the commit `factory.json` remembers, so a clone that has moved on without
// the record being updated is read as tampered-with — every policy question then answers "cannot
// tell", which for the update knob means `off`. The record is a cache of a local fact, so a write
// that fails changes nothing but the next pass's work.
export async function recordRoomSha(root: string, input: WorkerHomeInput, sha: string): Promise<void> {
  const options = workerHomeOptions(input)
  if (!/^[0-9a-f]{40}$/.test(sha)) return
  const room = controlRoomClone(root, options)
  if (!room) return
  // Nothing moved, so there is nothing to record. Writing anyway would take the settings lock and
  // bump the file's revision on every poll, which is a transaction bought for no fact.
  try {
    const recorded = readFactoryConfig(readFileSync(factoryConfigPath(options), 'utf8')).controlRooms[room.org]
    if (!recorded || recorded.sha === sha) return
  } catch { return }
  try {
    await updateSettingsAtPath(factoryConfigPath(options), (state) => {
      const current = state.orgs[room.org]
      if (!current || current.sha === sha) return state
      state.orgs[room.org] = { ...current, sha, lastSyncedAt: new Date().toISOString() }
      return state
    })
  } catch { /* a cache nobody could write is just a cache nobody could write */ }
}

export function verifiedListing(root: string, options: { repo: string; host?: string; home?: string; env?: NodeJS.ProcessEnv; git?: (clone: string) => GitRun }): Listing {
  const room = controlRoomClone(root, options)
  if (!room) return listedHere(root, options)
  const refresh = refreshRoster(room.clone, (options.git ?? gitIn)(room.clone))
  if (!refresh.ok) return { ok: false, reason: refresh.reason, entry: null, file: nodesPath(room.clone), sha: null }
  // The sha rides along on the refusal too: the clone moved, and the record has to follow it
  // whatever the roster then says about this machine.
  return { ...listedHere(root, options), sha: refresh.sha }
}

// The gate every verb passes. A missing or unreadable roster refuses, never defaults: a machine
// nobody listed must not start working the board because a file was late.
// The update policy for this checkout. No profile at all is a project older than the knob and
// gets the shipped default. A profile that exists and cannot be read is not the same thing: it
// may be the one saying `off`, and reading it as `auto` would start a networked global install
// of executable code that the operator had refused.
export function updateModeFor(root: string, home: string): UpdateMode {
  let devMd: string | null = null
  try {
    devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'off'
  }
  return effectiveUpdateMode({ home, devMd })
}

export function listedHere(root: string, options: { repo: string; host?: string; home?: string; env?: NodeJS.ProcessEnv }): Listing {
  // One spelling, and only one: a node is `<os-user>@<hostname>`. Accepting a bare hostname as
  // well would mean two rows could name this machine and a roster could grant through either.
  const machine = nodeId(undefined, options.host ?? hostname())
  const room = controlRoomClone(root, options)
  if (!room) return { ok: false, reason: `this repository names no control room (dev.md's control-room: knob), so no machine is listed as a worker for it`, entry: null, file: null }
  const file = nodesPath(room.clone)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: `${file} is not on this machine — run \`vegafactory sync\` to refresh the ${room.org} control room, and add ${machine} to nodes.md in a control-room PR`, entry: null, file }
  }
  const entry = parseNodes(text).find((row) => row.machine === machine) ?? null
  if (!entry) {
    // The row is spelled to fit the table that is actually there: a row shorter than the header
    // is refused for the cell it never reached, so advice that ignored the header would send the
    // operator straight from one refusal into the next.
    const header = headerOf(text)
    const gated = header?.some((column) => COLUMN_NAMES.worker.includes(column.toLowerCase() as (typeof COLUMN_NAMES.worker)[number])) ?? false
    // A row pasted under a header with no gate would be refused by the very next check, so the
    // advice says what is actually missing: the column, before any row can grant anything.
    // Either there is no header or it has no gate. A row pasted under a headerless table is read
    // as the legacy three cells, and a fourth would make it unreadable — so in both cases what is
    // missing is the header itself, and saying "add this row" would send the operator in a circle.
    if (!header || !gated) {
      return { ok: false, entry: null, file, reason: `${machine} is not listed in ${file}, and ${NO_GATE} — do both in one control-room PR, with the header \`| node | owner | worker | repos | caps |\`` }
    }
    const cells = header.map((column) => suggestedCell(column, machine, options.repo))
    return { ok: false, entry: null, file, reason: `${machine} is not listed in ${file} — add the row \`| ${cells.join(' | ')} |\` in a control-room PR before this machine works a board on its own` }
  }
  // A cap nobody can read is not a cap, and the machine it belongs to is named rather than left
  // to look like a missing row: the operator is sent to the thing that is wrong, not to the roster.
  if (!entry.caps) {
    return { ok: false, entry, file, reason: `${machine}'s row in ${file} does not say what its limits are: ${entry.problem} — fix it in a control-room PR` }
  }
  // The gate. Every machine has a row once a control room lists its nodes, so being in the file
  // says only that somebody wrote this machine down — which is what stats wants and what work
  // nobody is watching must not get from the same line.
  if (!entry.worker) {
    const why = entry.problem ?? (headerOf(text)?.some((column) => COLUMN_NAMES.worker.includes(column.toLowerCase() as (typeof COLUMN_NAMES.worker)[number]))
      ? 'its worker cell does not say `yes`'
      : NO_GATE)
    return { ok: false, entry, file, reason: `${machine} is listed in ${file} but not as a worker: ${why} — change it in a control-room PR before this machine works a board on its own` }
  }
  // An empty cell authorises nothing. Everything has to be said out loud, because the commonest
  // row on a roster of every machine is one with nothing in this cell.
  const every = entry.repos.some((repo) => repo === '*' || repo.toLowerCase() === 'all')
  const requested = canonicalRepository(options.repo)
  const namedRepos = entry.repos.flatMap((repo) => {
    try { return [canonicalRepository(repo)] } catch { return [] }
  })
  if (!namedRepos.includes(requested)) {
    if (every && namedRepos.length === 0) {
      return { ok: false, reason: `${machine}'s row in ${file} contains only * or all — unattended workers require at least one explicit OWNER/NAME repository`, entry, file }
    }
    const named = entry.repos.length ? `for ${entry.repos.join(', ')}` : 'for no repository — its repos cell is empty'
    return { ok: false, reason: `${machine} is listed in ${file} ${named}, not ${options.repo}`, entry, file }
  }
  return { ok: true, reason: `${machine} is listed in ${file}`, entry, file }
}

// ---------------------------------------------------------------------------------------------
// Identity: the VegaFactory GitHub App

export { APP_ACTOR, APP_ID }

export function appKeyPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const named = env.VEGAFACTORY_APP_PRIVATE_KEY_FILE?.trim()
  return named || workerAppKey({ env, home })
}

export function missingKeyMessage(path: string): string {
  return `the VegaFactory App private key is not readable at ${path} — put the .pem there (chmod 600) or set VEGAFACTORY_APP_PRIVATE_KEY_FILE to where it is; the worker writes as the App and never falls back to a person's token`
}

const base64url = (value: string) => Buffer.from(value).toString('base64url')

// A nine-minute App JWT. GitHub allows at most ten and a minute of clock drift.
export function appJwt(pem: string, appId: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  return `${header}.${claims}.${signer.sign(pem, 'base64url')}`
}

export interface FetchReply { ok: boolean; status: number; json: () => Promise<unknown> }
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchReply>

export interface AppToken { token: string; expiresAt: number }

export interface KeyFacts { isFile: () => boolean; isSymbolicLink: () => boolean; uid: number; mode: number }
export type KeyStat = (path: string) => KeyFacts

// The App key is the factory's one long-lived secret, so the file itself is part of the check: a
// real file this account owns, readable by nobody else. A link is refused outright — what it
// points at can be swapped after the check — and so is a mode any other account could read.
//
// What this does not cover: a worker run is a child of this process and runs as the same user,
// so the filesystem lets it read this file however tight the mode is. The child is never told
// where the key is and is given an hour-long token instead, but that is a smaller door, not a shut
// one. The dedicated worker account is the deployment boundary from every human identity; agent
// children sharing that account can still read the App key, which is an accepted property of that
// App-only account and the reason nothing else runs under it.
export function assertKeyFile(path: string, { stat = lstatSync as unknown as KeyStat, uid = process.getuid?.() ?? -1 } = {}) {
  let facts: KeyFacts
  try { facts = stat(path) } catch { throw new Error(missingKeyMessage(path)) }
  if (facts.isSymbolicLink()) throw new Error(`${path} is a symbolic link — the App key must be a real file, so what it points at cannot be swapped after this check`)
  if (!facts.isFile()) throw new Error(`${path} is not a regular file — the App key must be a real file`)
  if (uid >= 0 && facts.uid !== uid) throw new Error(`${path} is owned by uid ${facts.uid}, not the account running this (uid ${uid}) — the App key belongs to the worker's account`)
  if (facts.mode & 0o077) throw new Error(`${path} is mode ${(facts.mode & 0o777).toString(8)}, so another account on this machine can read the App key — chmod 600 it`)
}

// An installation token for this one repository: a JWT names the App, the installation is read
// from the repository itself, and the token is narrowed to that repository. It lives an hour and
// stays in memory — never written down, never printed, never put on a command line.
export async function mintToken(input: { repo: string; keyPath: string; appId: string; fetch?: Fetch; now?: number; stat?: KeyStat; uid?: number }): Promise<AppToken> {
  const { repo, keyPath, appId, fetch: call = globalThis.fetch as unknown as Fetch, now = Date.now() } = input
  assertRepo(repo)
  // Re-checked on every mint, not once at startup: a key that becomes group-readable or is
  // replaced by a link to someone else's file stops minting from the next token on.
  assertKeyFile(keyPath, { stat: input.stat, uid: input.uid })
  let pem: string
  try { pem = readFileSync(keyPath, 'utf8') } catch { throw new Error(missingKeyMessage(keyPath)) }
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(pem)) throw new Error(`${keyPath} is not a PEM private key — download the App's key again`)
  let jwt: string
  try { jwt = appJwt(pem, appId, now) } catch (error) { throw new Error(`the App key at ${keyPath} could not sign: ${(error as Error).message}`) }
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vegafactory-worker' }
  const install = await call(`https://api.github.com/repos/${repo}/installation`, { method: 'GET', headers })
  if (!install.ok) throw new Error(`the VegaFactory App is not installed on ${repo} (GitHub answered ${install.status}) — install it, or check VEGAFACTORY_APP_ID`)
  const id = (await install.json() as { id?: number }).id
  if (!Number.isSafeInteger(id)) throw new Error(`GitHub returned no installation id for ${repo}`)
  const name = repo.split('/')[1]!
  const minted = await call(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ repositories: [name] }),
  })
  if (!minted.ok) throw new Error(`minting an installation token for ${repo} failed (GitHub answered ${minted.status})`)
  const body = await minted.json() as { token?: string; expires_at?: string }
  if (typeof body.token !== 'string' || !body.token) throw new Error('GitHub returned no installation token')
  return { token: body.token, expiresAt: Date.parse(body.expires_at ?? '') || now + 55 * 60_000 }
}

// `gh` run as the App. The token reaches the child through its environment and nowhere else.
// `token()` is asked for one on every call, so an expiring token is replaced rather than carried:
// an installation token lives an hour and the worker lives for months.
export function tokenRunner(token: () => string, timeoutMs = 30_000): GhRunner {
  return (args, input): GhResult => {
    const result = spawnSync(process.env.VEGAFACTORY_GH || 'gh', args, {
      encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_TOKEN: token(), GITHUB_TOKEN: token() },
    })
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new GhError(`gh ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`)
    if (result.error) throw new GhError(`gh could not start: ${result.error.message}`)
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

// Re-minted a few minutes before it expires. `gh` is spawned synchronously, so the token has to be
// ready before the call: the refresh runs between passes, from `freshen`, and never mid-request.
export const TOKEN_MARGIN_MS = 5 * 60_000

// An installation token lives an hour and a child is handed one when it starts — nothing can put a
// fresh one into a process already running. A run allowed to last longer keeps working and stops
// being able to write to GitHub partway through, which is worse than being stopped: the work
// exists and the evidence for it never lands. The caps may say so, and the worker says it out
// loud. Closing it properly is the credential broker in #239.
export const TOKEN_LIFE_MS = 55 * 60_000

export interface AppIdentity { runner: GhRunner; freshen: (now?: number) => Promise<void>; token: () => string | null }

export function appIdentity(input: { repo: string; keyPath: string; appId: string; fetch?: Fetch }): AppIdentity {
  let held: AppToken | null = null
  return {
    runner: tokenRunner(() => {
      if (!held) throw new GhError('the worker has no installation token yet')
      return held.token
    }),
    // What a worker run is given so its own writes are the App's too. It is a value, never a
    // path to the key: a child that could read the key could mint whatever it liked.
    token: () => held?.token ?? null,
    freshen: async (now = Date.now()) => {
      if (held && held.expiresAt - now > TOKEN_MARGIN_MS) return
      held = await mintToken({ ...input, now })
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Readiness and the service unit

export interface Check { name: string; ok: boolean; detail: string }
export type Probe = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => { code: number; stdout: string; stderr: string }

export const probe: Probe = (command, args, options) => {
  // stdin is closed, not inherited. Both harnesses read a prompt from stdin when one is open, so
  // an inherited terminal turns a readiness probe into a wait for input nobody is there to give.
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: options?.env })
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message }
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

// Whether this repository's harness hooks call the CLI. Both files are checked: a machine that
// starts Claude Code and Codex runs needs the guard and the heartbeat on both.
// The CLI's hook command, however this machine spells the CLI: the published `vegafactory`, a
// `bun …/src/index.ts` while working on it, a wrapper script. What identifies it is the verb and
// the harness it names, not the word in front — matching only `vegafactory hook` called a machine
// unwired for running the very code it was checking.
const CALLS_HOOK = /\bhook\s+[a-z-]+\s+--harness\s+(claude|codex)\b/

export function hooksWired(root: string): Check {
  const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
  const claude = CALLS_HOOK.test(read(join(root, '.claude', 'settings.json')))
  const codex = CALLS_HOOK.test(read(join(root, '.codex', 'hooks.json')))
  if (claude && codex) return { name: 'hooks', ok: true, detail: 'both harnesses call vegafactory hook' }
  if (claude || codex) return { name: 'hooks', ok: false, detail: `only ${claude ? 'Claude Code' : 'Codex'} calls vegafactory hook — wire the other too` }
  return { name: 'hooks', ok: false, detail: 'no harness hook calls vegafactory hook — run vegafactory init in this repository' }
}

// A real turn from each tool, never a status command: Codex prints "Logged in" on a revoked token.
export function harnessAnswers(run: Probe): Check[] {
  const checks: Check[] = []
  for (const [name, command, args] of [
    ['claude', 'claude', ['-p', 'say ok']],
    // `codex exec` takes --sandbox and has no approval flag of its own; `-a never` was a usage
    // error, so this check could never pass and `worker enable` refused every machine.
    ['codex', 'codex', ['exec', '--sandbox', 'read-only', 'say ok']],
  ] as Array<[string, string, string[]]>) {
    const result = run(command, args)
    const ok = result.code === 0 && /\bok\b/i.test(result.stdout)
    checks.push({
      name, ok,
      detail: ok ? `${command} answers on its subscription` : `${command} did not answer ok: ${(result.stderr || result.stdout).split('\n').at(-1)?.slice(0, 160) || `exit ${result.code}`}`,
    })
  }
  return checks
}

const AMBIENT_GIT_IDENTITY = /^(?:GIT_CONFIG_(?:COUNT|KEY_|VALUE_|GLOBAL$|SYSTEM$|NOSYSTEM$|PARAMETERS$)|GIT_ASKPASS$|SSH_ASKPASS$|GIT_SSH$|GIT_SSH_COMMAND$|SSH_AUTH_SOCK$|GH_CONFIG_DIR$|GH_HOST$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$)/

function appGitEnvironment(source: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of Object.keys(env)) if (AMBIENT_GIT_IDENTITY.test(name)) delete env[name]
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  Object.assign(env, {
    GIT_CONFIG_COUNT: token ? '2' : '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  })
  if (token) Object.assign(env, {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
  })
  return env
}

const gitDiagnostic = (result: { stdout: string; stderr: string }, token: string) =>
  (result.stderr || result.stdout || 'the remote refused the dry-run push').replaceAll(token, '[redacted]').split('\n').at(-1)!.slice(0, 160)

// The dedicated worker account has no human Git or SSH identity. Its selected repository's
// installation token is therefore both the API principal and the HTTPS Git principal. A dry-run
// push to a nonce ref proves write authority without creating the ref; a login/status check would
// prove only that some credential exists, not that this App token can push.
export function pushPath(root: string, run: Probe, token: string | null): Check {
  const result = run('git', ['-C', root, 'remote', 'get-url', '--push', 'origin'])
  const url = result.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  if (result.code !== 0 || !url) return { name: 'push', ok: false, detail: `cannot read the push URL of origin in ${root}: ${(result.stderr || result.stdout).split('\n').at(-1)?.slice(0, 160) ?? `exit ${result.code}`}` }
  if (/^(git@|ssh:\/\/)/.test(url)) return { name: 'push', ok: false, detail: `origin pushes over SSH (${url}), but this dedicated worker has no human or SSH identity — use HTTPS: https://github.com/OWNER/REPO.git` }

  // Only an https remote uses the credential helper a run's Git is given. Anything else — http,
  // git://, a local path, a host alias — would not, so proving a credential proves nothing about
  // it, and a readiness check that passed would be a check that lied.
  const https = /^https:\/\/([^/]+)\//.exec(url)
  if (!https) {
    return { name: 'push', ok: false, detail: `origin pushes over ${url.split(':')[0] || 'an unknown transport'} (${url}), which this App-only worker has no credential path for — use an https://github.com/OWNER/REPO.git push URL` }
  }
  // The App token and helper are intentionally GitHub-only. Another host would be a second
  // credential model, which this dedicated account does not have.
  const host = https[1]!
  if (host !== 'github.com') {
    return { name: 'push', ok: false, detail: `origin pushes to ${host} over HTTPS, but a worker run is only given the VegaFactory App credential for github.com` }
  }
  if (!token) return { name: 'push', ok: false, detail: `origin pushes over HTTPS (${url}), but no repository installation token was minted` }
  const ref = `HEAD:refs/heads/vegafactory-readiness-${randomUUID()}`
  const pushed = run('git', [
    '-C', root,
    '-c', 'credential.helper=',
    '-c', 'credential.https://github.com.helper=!gh auth git-credential',
    'push', '--dry-run', 'origin', ref,
  ], { env: appGitEnvironment(process.env, token) })
  if (pushed.code === 0) return { name: 'push', ok: true, detail: 'origin accepts a dry-run HTTPS push from the VegaFactory App installation token' }
  return { name: 'push', ok: false, detail: `the VegaFactory App installation token cannot push to ${url}: ${gitDiagnostic(pushed, token)}` }
}

export interface ReadyInput { root: string; listing: Listing; run: Probe; token: string | null; keyOk: boolean; keyDetail: string; env: NodeJS.ProcessEnv }

export function readiness(input: ReadyInput): Check[] {
  const billing = billingVariables(input.env)
  return [
    { name: 'listed', ok: input.listing.ok, detail: input.listing.reason },
    { name: 'billing', ok: billing.length === 0, detail: billing.length ? `${billing.join(', ')} set — a worker runs on subscriptions only; unset them` : 'no API-key variable is set' },
    hooksWired(input.root),
    pushPath(input.root, input.run, input.token),
    ...harnessAnswers(input.run),
    { name: 'app-key', ok: input.keyOk, detail: input.keyDetail },
  ]
}

export const renderChecks = (checks: Check[]) => checks.map((check) => `${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(8)} ${check.detail}`).join('\n')

export function unitPath(platform: NodeJS.Platform, home = homedir()): string {
  return platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`)
    : join(home, '.config', 'systemd', 'user', 'vegafactory-worker.service')
}

// The unit runs one command: this CLI's own `worker run`, in the repository, restarted when it
// stops. Nothing in it carries a token; the repository and the log path are all it knows.
// A value a unit file cannot hold. A newline is legal in a Linux filename and passes every check
// a run makes, then becomes a second physical line inside the unit — read by systemd as a
// different directive, or as nothing. Refused at `enable` by name, because the alternative is a
// service that starts without the setting the operator just proved.
// eslint-disable-next-line no-control-regex
const UNWRITABLE = /[\u0000-\u001f\u007f]/
// Whether this account's services already outlive its logins. Reading the property needs no
// privilege, so it is safe to ask before trying to set it.
export function alreadyLingering(run: Probe, uid: number): boolean {
  try {
    const answer = run('loginctl', ['show-user', String(uid), '--property=Linger'])
    return answer.code === 0 && /Linger=yes/i.test(answer.stdout)
  } catch { return false }
}

export function unwritableForUnit(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['VEGAFACTORY_HOME', 'VEGAFACTORY_APP_ID', 'VEGAFACTORY_APP_ACTOR', 'VEGAFACTORY_APP_PRIVATE_KEY_FILE']) {
    const value = env[name]?.trim()
    if (value && UNWRITABLE.test(value)) return `${name} contains a control character, so it cannot be written into a service unit — move the file or rename it`
  }
  return null
}

export function unitText(platform: NodeJS.Platform, input: { cli: string[]; root: string; repo: string; logDir: string; factoryHome?: string; env?: NodeJS.ProcessEnv }): string {
  const argv = [...input.cli, 'worker', 'run', '--repo', input.repo]
  // A user service inherits nothing from the shell that installed it, so everything `enable` was
  // run with has to be written into the unit — or the worker restarts as VegaStack's own App,
  // against a key it then cannot find, while `enable` reported success.
  //
  // All three are *names*: two identifiers and a path. The secret is the key file itself, which
  // stays owned by this account and mode 600; writing where it lives tells a reader of the unit
  // nothing they could not get from `ls`.
  const from = input.env ?? process.env
  const identity: Array<[string, string]> = []
  if (input.factoryHome && !UNWRITABLE.test(input.factoryHome)) identity.push(['VEGAFACTORY_HOME', input.factoryHome])
  for (const name of ['VEGAFACTORY_APP_ID', 'VEGAFACTORY_APP_ACTOR', 'VEGAFACTORY_APP_PRIVATE_KEY_FILE']) {
    const value = from[name]?.trim()
    // `enable` has already refused these by name; this is the second line of that defence.
    if (value && !UNWRITABLE.test(value)) identity.push([name, value])
  }
  if (platform === 'darwin') {
    const escaped = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">', '<dict>',
      `  <key>Label</key><string>${SERVICE_NAME}</string>`,
      '  <key>ProgramArguments</key>', '  <array>',
      ...argv.map((arg) => `    <string>${escaped(arg)}</string>`),
      '  </array>',
      `  <key>WorkingDirectory</key><string>${escaped(input.root)}</string>`,
      '  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>',
      `  <key>StandardOutPath</key><string>${escaped(join(input.logDir, 'worker.log'))}</string>`,
      `  <key>StandardErrorPath</key><string>${escaped(join(input.logDir, 'worker.err.log'))}</string>`,
      ...(identity.length
        ? ['  <key>EnvironmentVariables</key>', '  <dict>',
          ...identity.map(([name, value]) => `    <key>${escaped(name)}</key><string>${escaped(value)}</string>`),
          '  </dict>']
        : []),
      '</dict>', '</plist>', '',
    ].join('\n')
  }
  return [
    '[Unit]', 'Description=VegaFactory worker', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${input.root}`,
    `ExecStart=${argv.map((arg) => JSON.stringify(arg)).join(' ')}`,
    // The same two files the plist writes, so a person reading the logs finds them in one place on
    // either platform. `logDir` was already being passed here and dropped, so on Linux the log
    // this product tells people to read never appeared at all.
    //
    // `append:` redirects the streams rather than copying them, so these lines do *not* reach the
    // journal — `journalctl -u vegafactory-worker.service` shows systemd's own messages about the
    // unit and nothing the worker printed. That is the trade for parity, and the onboarding
    // checklist says so rather than sending anyone to the journal for output that is not there.
    // It appends rather than truncating, which matters for a service whose whole job is to be
    // restarted.
    `StandardOutput=append:${join(input.logDir, 'worker.log')}`,
    `StandardError=append:${join(input.logDir, 'worker.err.log')}`,
    // systemd quotes a whole item, so the quotes go around `NAME=value` and not around the value:
    // `Environment=NAME="a b"` puts an opening quote after non-whitespace, which is not the
    // documented form. `%` is doubled because specifiers expand, and a backslash or a quote is
    // escaped because the item is read as a C-style string.
    ...identity.map(([name, value]) => `Environment="${name}=${value.replace(/([\\"])/g, '\\$1').replace(/%/g, '%%')}"`),
    'Restart=always', 'RestartSec=30', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')
}

export function serviceCommands(platform: NodeJS.Platform, path: string, verb: 'enable' | 'disable', uid = userInfo().uid, lingering = false): string[][] {
  if (platform === 'darwin') {
    const target = `gui/${uid}`
    // Unloading first is what makes a re-enable pick up the file that was just written. launchd
    // keeps the job definition it was bootstrapped with: `bootstrap` is a no-op once the label is
    // loaded, `enable` does not re-read the plist, and `kickstart` restarts the definition already
    // in memory — so the worker would carry its old identity while `enable` reported success.
    // The first command is expected to fail on a machine that has never enabled, and the caller
    // tolerates that.
    return verb === 'enable'
      ? [['launchctl', 'bootout', `${target}/${SERVICE_NAME}`], ['launchctl', 'bootstrap', target, path], ['launchctl', 'enable', `${target}/${SERVICE_NAME}`]]
      : [['launchctl', 'bootout', `${target}/${SERVICE_NAME}`]]
  }
  // Linger first, and checked rather than assumed. A `--user` service runs inside a login session
  // and systemd ends that session when the last login closes, so without linger an always-on
  // worker dies the moment the operator logs out — quietly, and hours later. It is a per-user
  // setting gated by polkit, so the account may not be able to grant it to itself; the command
  // loop stops at the first failure and names it, which is the whole point of doing it here
  // instead of hoping.
  //
  // Same reason as darwin for the restart: `daemon-reload` reparses the unit but `enable --now`
  // leaves an already-active service running the version it started with.
  return verb === 'enable'
    ? [
      // Setting it is gated by polkit; reading it is not. An administrator who has already run
      // `loginctl enable-linger` for this account has done the one thing this needs, and asking
      // again would fail on exactly the box where that recovery was required — which would make
      // the documented way out of the refusal no way out at all.
      ...(lingering ? [] : [['loginctl', 'enable-linger', String(uid)]]),
      ['systemctl', '--user', 'stop', 'vegafactory-worker.service'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'vegafactory-worker.service'],
      ['systemctl', '--user', 'restart', 'vegafactory-worker.service'],
    ]
    : [['systemctl', '--user', 'disable', '--now', 'vegafactory-worker.service']]
}

// ---------------------------------------------------------------------------------------------
// What the worker writes down: the runs it made and what it has already acted on

export type Action = 'follow-up' | 'plan' | 'implement' | 'corrections' | 'ship' | 'stop' | 'none'
export type Outcome = 'done' | 'blocked' | 'failed' | 'killed' | 'limit' | 'stopped'

export interface RunRecord { at: string; repo: string; issue: number; action: Action; outcome: Outcome; ms: number; machine: string; note: string }
export interface Acted { at: number; action: Action; outcome: Outcome; trigger: number | null; failures: number; retryAt: number | null }

export class WorkerRecordError extends Error {
  constructor(public kind: 'unsafe' | 'unreadable' | 'malformed', message: string) { super(message) }
}

const RECORD_ACTIONS = new Set<Action>(['follow-up', 'plan', 'implement', 'corrections', 'ship', 'stop', 'none'])
const RECORD_OUTCOMES = new Set<Outcome>(['done', 'blocked', 'failed', 'killed', 'limit', 'stopped'])
const RECORD_STATES = new Set<State>(['waiting-on-operator', 'planning', 'queued', 'in-progress', 'ready-to-ship'])

export const workerDir = (root: string) => join(root, '.vegastack', '.tmp', 'worker')
export const childrenPath = (stateRoot: string) => join(stateRoot, 'children.json')
const runsPath = (stateRoot: string) => join(stateRoot, 'runs.jsonl')
const actedPath = (stateRoot: string) => join(stateRoot, 'acted.json')

// The record is a working note on an always-on machine, so it is trimmed to the last RUNS_KEPT
// rather than grown forever; the control room's statistics are where runs are kept for good.
export const RUNS_KEPT = 500

function ensurePrivateRecordRoot(stateRoot: string, create: boolean): boolean {
  if (resolve(stateRoot) !== stateRoot) throw new WorkerRecordError('unsafe', `the worker record root is not absolute and canonical: ${stateRoot}`)
  const uid = process.getuid?.()
  const root = parse(stateRoot).root
  let cursor = root
  let owned = false
  for (const part of stateRoot.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    owned ||= cursor === stateRoot
    try {
      const info = lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkerRecordError('unsafe', `${cursor} is not an ordinary directory`)
      if (info.uid !== 0 && uid !== undefined && info.uid !== uid) throw new WorkerRecordError('unsafe', `${cursor} is owned by untrusted uid ${info.uid}`)
      if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) throw new WorkerRecordError('unsafe', `${cursor} is writable by another user`)
      if (owned && (info.mode & 0o777) !== 0o700) {
        if (!create) throw new WorkerRecordError('unsafe', `${cursor} is not owner-only 0700`)
        chmodSync(cursor, 0o700)
      }
    } catch (error) {
      if (error instanceof WorkerRecordError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WorkerRecordError('unreadable', `${cursor} cannot be inspected: ${(error as Error).message}`)
      if (!create) return false
      mkdirSync(cursor, { mode: 0o700 })
      owned = true
    }
  }
  return true
}

function readPrivateRecord(stateRoot: string, path: string): string | null {
  if (!ensurePrivateRecordRoot(stateRoot, false)) return null
  try {
    const info = lstatSync(path)
    const uid = process.getuid?.()
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkerRecordError('unsafe', `${path} is not an ordinary record file`)
    if (uid !== undefined && info.uid !== uid) throw new WorkerRecordError('unsafe', `${path} is owned by uid ${info.uid}`)
    if ((info.mode & 0o400) === 0) throw new WorkerRecordError('unreadable', `${path} is not readable by its owner`)
    if ((info.mode & 0o777) !== 0o600) throw new WorkerRecordError('unsafe', `${path} is not private 0600`)
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof WorkerRecordError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new WorkerRecordError('unreadable', `${path} cannot be read: ${(error as Error).message}`)
  }
}

function replacePrivateRecord(stateRoot: string, path: string, text: string): void {
  ensurePrivateRecordRoot(stateRoot, true)
  if (existsSync(path)) readPrivateRecord(stateRoot, path)
  replaceFile(path, text)
  chmodSync(path, 0o600)
}

function validActed(value: unknown): value is Record<string, Acted> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const [key, raw] of Object.entries(value)) {
    const match = /^(.*)#([1-9]\d*)$/.exec(key)
    const row = raw as Partial<Acted> | null
    let canonical = ''
    try { canonical = match ? canonicalRepository(match[1]!) : '' } catch { return false }
    if (!match || canonical !== match[1] || !row || typeof row !== 'object'
      || !Number.isFinite(row.at) || !RECORD_ACTIONS.has(row.action as Action) || !RECORD_OUTCOMES.has(row.outcome as Outcome)
      || !(row.trigger === null || Number.isSafeInteger(row.trigger)) || !Number.isSafeInteger(row.failures) || Number(row.failures) < 0
      || !(row.retryAt === null || Number.isFinite(row.retryAt))) return false
  }
  return true
}

function validRun(raw: unknown, fallback: string | null = null): raw is RunRecord {
  const row = raw as Partial<RunRecord> | null
  if (!row || typeof row !== 'object') return false
  let repo: string
  try { repo = canonicalRepository(typeof row.repo === 'string' ? row.repo : fallback ?? '') } catch { return false }
  return repo === (row.repo ?? fallback) && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    && Number.isSafeInteger(row.issue) && Number(row.issue) > 0 && RECORD_ACTIONS.has(row.action as Action)
    && RECORD_OUTCOMES.has(row.outcome as Outcome) && Number.isFinite(row.ms)
    && typeof row.machine === 'string' && typeof row.note === 'string'
}

export function recordRun(stateRoot: string, record: RunRecord) {
  if (!validRun(record)) throw new WorkerRecordError('malformed', 'the run record is invalid')
  ensurePrivateRecordRoot(stateRoot, true)
  withLock(stateRoot, () => {
    const path = runsPath(stateRoot)
    if (existsSync(path)) readRuns(stateRoot, Number.MAX_SAFE_INTEGER)
    appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    if (lines.length > RUNS_KEPT * 2) replacePrivateRecord(stateRoot, path, lines.slice(-RUNS_KEPT).join('\n') + '\n')
  }, { what: 'the worker\'s run history' })
}

export function readRuns(stateRoot: string, limit = 20): RunRecord[] {
  const text = readPrivateRecord(stateRoot, runsPath(stateRoot))
  if (text === null) return []
  const rows: RunRecord[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { throw new WorkerRecordError('malformed', `${runsPath(stateRoot)} has invalid JSON on line ${index + 1}`) }
    if (!validRun(raw)) throw new WorkerRecordError('malformed', `${runsPath(stateRoot)} has an invalid run on line ${index + 1}`)
    rows.push(raw)
  }
  return rows.slice(-limit)
}

export function readActed(stateRoot: string): Record<string, Acted> {
  const text = readPrivateRecord(stateRoot, actedPath(stateRoot))
  if (text === null) return {}
  let saved: unknown
  try { saved = JSON.parse(text) } catch { throw new WorkerRecordError('malformed', `${actedPath(stateRoot)} is not valid JSON`) }
  if (!validActed(saved)) throw new WorkerRecordError('malformed', `${actedPath(stateRoot)} has an invalid acted schema`)
  return saved
}

export function writeActed(stateRoot: string, acted: Record<string, Acted>) {
  if (!validActed(acted)) throw new WorkerRecordError('malformed', 'refusing to write an invalid acted record')
  replacePrivateRecord(stateRoot, actedPath(stateRoot), JSON.stringify(acted, null, 2) + '\n')
}

// A pid on its own is not an identity: pids are reused, and a record left behind by a crash would
// have a later, unrelated process signalled in its place. The pair (pid, start time) is an
// identity, and the start time is what the operating system says, not what we remember.
export type ProcessStart = (pid: number) => string | null
export type ProcessAlive = (pid: number) => boolean | null
export type ProcessIdentity = 'matching' | 'gone' | 'unknown'

export const processStart: ProcessStart = (pid) => {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10_000 })
  const line = (result.stdout ?? '').trim()
  return result.status === 0 && line ? line : null
}

export const processAlive: ProcessAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return null
  }
}

export function processIdentity(record: { pid: number; startedAt: string }, start: ProcessStart = processStart, alive: ProcessAlive = processAlive): ProcessIdentity {
  const observed = start(record.pid)
  if (observed !== null) return observed === record.startedAt ? 'matching' : 'gone'
  return alive(record.pid) === false ? 'gone' : 'unknown'
}

// The runs this machine has started, and enough about each to prove it is still that run and to
// clean up after it. It is on disk because `worker disable` is a different process from the
// service it takes down: without this, the service's agents would keep running and keep writing to
// GitHub after the unit is gone.
export interface ChildRecord {
  repo: string
  pid: number
  // What `ps` said when the child started. Together with the pid this is the child's identity.
  startedAt: string
  command: string
  issue: number
  action: Action
  // The claim this run holds, and the state to put the issue back to, so whoever cleans up can.
  owner: string | null
  from: State
}

const isRecord = (value: unknown): value is ChildRecord => {
  const row = value as ChildRecord | null
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.pid) || row.pid <= 1 || typeof row.repo !== 'string') return false
  try { if (canonicalRepository(row.repo) !== row.repo) return false } catch { return false }
  return typeof row.startedAt === 'string' && !!row.startedAt && typeof row.command === 'string' && !!row.command
    && Number.isSafeInteger(row.issue) && row.issue > 0 && RECORD_ACTIONS.has(row.action)
    && (row.owner === null || typeof row.owner === 'string') && RECORD_STATES.has(row.from)
}

export function readChildren(stateRoot: string): ChildRecord[] {
  const text = readPrivateRecord(stateRoot, childrenPath(stateRoot))
  if (text === null) return []
  let saved: unknown
  try { saved = JSON.parse(text) } catch { throw new WorkerRecordError('malformed', `${childrenPath(stateRoot)} is not valid JSON`) }
  if (!Array.isArray(saved) || !saved.every(isRecord)) throw new WorkerRecordError('malformed', `${childrenPath(stateRoot)} has an invalid child schema`)
  return saved
}

function writeChildren(stateRoot: string, change: (rows: ChildRecord[]) => ChildRecord[]) {
  ensurePrivateRecordRoot(stateRoot, true)
  withLock(stateRoot, () => {
    const next = change(readChildren(stateRoot))
    if (!next.every(isRecord)) throw new WorkerRecordError('malformed', 'refusing to write invalid child records')
    replacePrivateRecord(stateRoot, childrenPath(stateRoot), JSON.stringify(next, null, 2) + '\n')
  }, { what: 'the worker\'s children' })
}

export function noteChild(stateRoot: string, record: ChildRecord) {
  writeChildren(stateRoot, (rows) => [...rows.filter((row) => row.pid !== record.pid), record])
}

// Removed when the run ends, so the file is the live set and not a history.
export function forgetChild(stateRoot: string, pid: number) {
  writeChildren(stateRoot, (rows) => rows.filter((row) => row.pid !== pid))
}

// Whether the process this record named is still that process.
export function stillTheChild(record: ChildRecord, start: ProcessStart = processStart, alive: ProcessAlive = processAlive): boolean {
  return processIdentity(record, start, alive) === 'matching'
}

// Stops a run and everything it started. The group is signalled, not the one process: an agent
// spawns its own tools, and leaving those behind is how a "stopped" worker keeps working.
export function stopGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try { process.kill(pid, signal); return true } catch { return false }
  }
}

// Signals a recorded run only while it is provably still that run. A stale record is dropped, not
// signalled: after a pid is reused, the number alone would name somebody else's process.
export function stopChild(stateRoot: string, record: ChildRecord, deps: { stop?: (pid: number, signal: NodeJS.Signals) => boolean; start?: ProcessStart; alive?: ProcessAlive } = {}): boolean {
  const identity = processIdentity(record, deps.start ?? processStart, deps.alive ?? processAlive)
  if (identity === 'unknown') return false
  if (identity === 'gone') {
    forgetChild(stateRoot, record.pid)
    return false
  }
  const stopped = (deps.stop ?? stopGroup)(record.pid, 'SIGTERM')
  // A successful signal is not a process exit. The child record is the restart recovery handle
  // and stays until runOne observes close, or a later process proves the pid identity is gone.
  return stopped
}

// Two steps finish at once, and an operator may run a pass by hand beside the service: the
// read-modify-write takes the same lock the issue cache uses, so neither loses the other's entry.
export function updateActed(stateRoot: string, change: (acted: Record<string, Acted>) => void) {
  ensurePrivateRecordRoot(stateRoot, true)
  withLock(stateRoot, () => {
    const acted = readActed(stateRoot)
    change(acted)
    writeActed(stateRoot, acted)
  }, { what: 'the worker\'s record' })
}

// One worker per machine. Two are not twice the work: they double every poll, race for every
// claim and split the run budget in ways neither can see. The lock records the process that holds
// it the same way a child record does, so a crashed worker's lock is taken over rather than
// blocking the box for ever.
export const runLockPath = (stateRoot: string) => join(stateRoot, 'run.lock')

export interface RunLock { pid: number; startedAt: string; runId: string; at: string }

function readRunLock(stateRoot: string): RunLock | null {
  const text = readPrivateRecord(stateRoot, runLockPath(stateRoot))
  if (text === null) return null
  let row: Partial<RunLock>
  try { row = JSON.parse(text) as Partial<RunLock> }
  catch { throw new WorkerRecordError('malformed', `${runLockPath(stateRoot)} is not valid JSON`) }
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 1
    || typeof row.startedAt !== 'string' || typeof row.runId !== 'string' || typeof row.at !== 'string') {
    throw new WorkerRecordError('malformed', `${runLockPath(stateRoot)} has an invalid lock schema`)
  }
  return row as RunLock
}

export function takeRunLock(stateRoot: string, runId: string, start: ProcessStart = processStart, alive: ProcessAlive = processAlive): { ok: boolean; reason: string; held: RunLock | null } {
  ensurePrivateRecordRoot(stateRoot, true)
  return withLock(stateRoot, () => {
    let held: RunLock | null = null
    const path = runLockPath(stateRoot)
    try { held = readRunLock(stateRoot) }
    catch { return { ok: false, held: null, reason: `the existing worker lock cannot be identified safely: ${path}` } }
    if (held && Number.isSafeInteger(held.pid) && typeof held.startedAt === 'string') {
      const identity = processIdentity(held, start, alive)
      if (identity === 'unknown') return { ok: false, held, reason: `the worker lock belongs to pid ${held.pid}, whose identity cannot be proved — leave it in place and check that process` }
      if (identity === 'matching' && held.pid !== process.pid) {
        return { ok: false, held, reason: `another worker is already running on this machine (pid ${held.pid}, since ${held.at}) — stop it, or let it work` }
      }
    } else if (held) return { ok: false, held, reason: `the existing worker lock cannot be identified safely: ${path}` }
    const mine: RunLock = { pid: process.pid, startedAt: start(process.pid) ?? '', runId, at: new Date().toISOString() }
    replacePrivateRecord(stateRoot, runLockPath(stateRoot), JSON.stringify(mine, null, 2) + '\n')
    return { ok: true, held: mine, reason: 'this machine\'s worker' }
  }, { what: 'the worker lock' })
}

export function releaseRunLock(stateRoot: string, runId: string) {
  try {
    const held = readRunLock(stateRoot)
    if (held?.runId === runId) rmSync(runLockPath(stateRoot), { force: true })
  } catch (error) {
    if (error instanceof WorkerRecordError) throw error
  }
}

export interface LegacyMigrationResult { ok: boolean; migrated: boolean; reason: string }

function safeLegacyStateRoot(root: string, stateRoot: string): { ok: boolean; exists: boolean; reason: string } {
  const expected = join(root, '.vegastack', '.tmp', 'worker')
  if (resolve(root) !== root || stateRoot !== expected) return { ok: false, exists: false, reason: `the legacy worker path is not canonical: ${stateRoot}` }
  const uid = process.getuid?.()
  const filesystemRoot = parse(expected).root
  let cursor = filesystemRoot
  let productOwned = false
  for (const part of expected.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    productOwned ||= cursor === root
    try {
      const info = lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) return { ok: false, exists: true, reason: `refusing an unsafe legacy worker directory at ${cursor}` }
      if (uid !== undefined && (productOwned ? info.uid !== uid : info.uid !== 0 && info.uid !== uid)) {
        return { ok: false, exists: true, reason: `refusing a legacy worker ancestor owned by uid ${info.uid}: ${cursor}` }
      }
      if ((info.mode & 0o022) !== 0 && (productOwned || (info.mode & 0o1000) === 0)) {
        return { ok: false, exists: true, reason: `refusing a legacy worker ancestor another user can replace: ${cursor}` }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && productOwned) return { ok: true, exists: false, reason: 'no legacy worker state' }
      return { ok: false, exists: true, reason: `the legacy worker directory cannot be inspected at ${cursor}: ${(error as Error).message}` }
    }
  }
  return { ok: true, exists: true, reason: 'safe legacy worker directory' }
}

function safeGlobalStateRoot(factoryRoot: string, stateRoot: string, create: boolean): { ok: boolean; reason: string } {
  if (resolve(factoryRoot) !== factoryRoot || resolve(stateRoot) !== stateRoot || stateRoot !== join(factoryRoot, 'worker')) {
    return { ok: false, reason: `the global worker path is outside its canonical factory home: ${stateRoot}` }
  }
  const uid = process.getuid?.()
  const root = parse(stateRoot).root
  let cursor = root
  let productOwned = false
  for (const part of stateRoot.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    productOwned ||= cursor === factoryRoot
    try {
      const info = lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) return { ok: false, reason: `refusing an unsafe global worker directory at ${cursor}` }
      if (productOwned && uid !== undefined && info.uid !== uid) return { ok: false, reason: `refusing a global worker directory owned by uid ${info.uid}: ${cursor}` }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: `the global worker directory cannot be inspected at ${cursor}: ${(error as Error).message}` }
      if (!create) return { ok: false, reason: `the global worker directory disappeared during migration: ${cursor}` }
      try { mkdirSync(cursor, { mode: 0o700 }) } catch (failure) { return { ok: false, reason: `the global worker directory cannot be created at ${cursor}: ${(failure as Error).message}` } }
      productOwned = true
      const made = lstatSync(cursor)
      if (!made.isDirectory() || made.isSymbolicLink() || (uid !== undefined && made.uid !== uid)) return { ok: false, reason: `the created global worker directory is unsafe: ${cursor}` }
    }
  }
  return { ok: true, reason: 'safe global worker directory' }
}

type InspectedRecord<T> = { exists: boolean; value: T | null; error: string | null }

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function trustedRecordOwner(owner: number, uid: number | undefined = process.getuid?.()): boolean {
  return uid === undefined || owner === uid
}

export function inspectWorkerRecord(path: string, uid: number | undefined = process.getuid?.()): InspectedRecord<string> {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return { exists: true, value: null, error: `${path} is not a regular file` }
    if (!trustedRecordOwner(info.uid, uid)) return { exists: true, value: null, error: `${path} is owned by untrusted uid ${info.uid}` }
    if ((info.mode & 0o022) !== 0) return { exists: true, value: null, error: `${path} is writable by another user` }
    return { exists: true, value: readFileSync(path, 'utf8'), error: null }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { exists: false, value: null, error: null }
      : { exists: true, value: null, error: `${path} cannot be read: ${(error as Error).message}` }
  }
}

function inspectLegacyActed(path: string, fallback: string | null): InspectedRecord<Record<string, Acted>> {
  const file = inspectWorkerRecord(path)
  if (!file.exists || file.error) return { exists: file.exists, value: null, error: file.error }
  try {
    const raw: unknown = JSON.parse(file.value!)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level is not an object')
    for (const [key, value] of Object.entries(raw)) {
      const row = value as Partial<Acted> | null
      const match = /^(.*)#([1-9]\d*)$/.exec(key)
      if (!match || !row || typeof row !== 'object' || !Number.isFinite(row.at)
        || !RECORD_ACTIONS.has(row.action as Action) || !RECORD_OUTCOMES.has(row.outcome as Outcome)
        || !(row.trigger === null || Number.isSafeInteger(row.trigger)) || !Number.isSafeInteger(row.failures) || Number(row.failures) < 0
        || !(row.retryAt === null || Number.isFinite(row.retryAt))) throw new Error(`invalid acted row ${JSON.stringify(key)}`)
      const repo = canonicalRepository(match[1]!)
      if (fallback === null && repo !== match[1]) throw new Error(`noncanonical acted row ${JSON.stringify(key)}`)
    }
    return { exists: true, value: raw as Record<string, Acted>, error: null }
  } catch (error) { return { exists: true, value: null, error: `${path} is malformed: ${(error as Error).message}` } }
}

function inspectLegacyRuns(path: string, fallback: string | null): InspectedRecord<RunRecord[]> {
  const file = inspectWorkerRecord(path)
  if (!file.exists || file.error) return { exists: file.exists, value: null, error: file.error }
  const rows: RunRecord[] = []
  try {
    for (const [index, line] of file.value!.split('\n').entries()) {
      if (!line.trim()) continue
      const raw = JSON.parse(line) as Partial<RunRecord>
      const recordRepo = canonicalRepository(typeof raw.repo === 'string' ? raw.repo : fallback ?? '')
      if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at)) || !Number.isSafeInteger(raw.issue) || Number(raw.issue) < 1
        || !RECORD_ACTIONS.has(raw.action as Action) || !RECORD_OUTCOMES.has(raw.outcome as Outcome) || !Number.isFinite(raw.ms)
        || typeof raw.machine !== 'string' || typeof raw.note !== 'string') throw new Error(`invalid run row ${index + 1}`)
      if (fallback === null && raw.repo !== recordRepo) throw new Error(`noncanonical run row ${index + 1}`)
      rows.push({ ...raw, repo: recordRepo } as RunRecord)
    }
    return { exists: true, value: rows, error: null }
  } catch (error) { return { exists: true, value: null, error: `${path} is malformed: ${(error as Error).message}` } }
}

function inspectLegacyChildren(path: string, fallback: string | null): InspectedRecord<ChildRecord[]> {
  const file = inspectWorkerRecord(path)
  if (!file.exists || file.error) return { exists: file.exists, value: null, error: file.error }
  try {
    const raw: unknown = JSON.parse(file.value!)
    if (!Array.isArray(raw)) throw new Error('top level is not an array')
    const rows = raw.map((value, index) => {
      const row = value as Partial<ChildRecord>
      const repo = canonicalRepository(typeof row.repo === 'string' ? row.repo : fallback ?? '')
      if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 1
        || typeof row.startedAt !== 'string' || !row.startedAt || typeof row.command !== 'string' || !row.command
        || !Number.isSafeInteger(row.issue) || Number(row.issue) < 1 || !RECORD_ACTIONS.has(row.action as Action)
        || !(row.owner === null || typeof row.owner === 'string') || !RECORD_STATES.has(row.from as State)) {
        throw new Error(`invalid child row ${index + 1}`)
      }
      if (fallback === null && row.repo !== repo) throw new Error(`noncanonical child row ${index + 1}`)
      return { ...row, repo } as ChildRecord
    })
    return { exists: true, value: rows, error: null }
  } catch (error) { return { exists: true, value: null, error: `${path} is malformed: ${(error as Error).message}` } }
}

function inspectLegacyLock(path: string): InspectedRecord<RunLock> {
  const file = inspectWorkerRecord(path)
  if (!file.exists || file.error) return { exists: file.exists, value: null, error: file.error }
  try {
    const row = JSON.parse(file.value!) as Partial<RunLock>
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 1
      || typeof row.startedAt !== 'string' || typeof row.runId !== 'string' || typeof row.at !== 'string') throw new Error('invalid lock row')
    return { exists: true, value: row as RunLock, error: null }
  } catch (error) { return { exists: true, value: null, error: `${path} is malformed: ${(error as Error).message}` } }
}

function inspectLegacyFiles(root: string, fallback: string | null) {
  return {
    acted: inspectLegacyActed(actedPath(root), fallback),
    runs: inspectLegacyRuns(runsPath(root), fallback),
    children: inspectLegacyChildren(childrenPath(root), fallback),
    lock: inspectLegacyLock(runLockPath(root)),
  }
}

export interface WorkerStateInspection { ok: boolean; reason: string; children: ChildRecord[]; migrationNeeded: boolean }

// Read-only by design: disable uses this while the service is still loaded, so corrupt authority
// cannot be converted into permission to unload, rewrite, signal, or delete anything.
export function inspectLegacyWorkerState(input: { root: string; stateRoot: string; factoryRoot?: string; repo: string }): WorkerStateInspection {
  const factoryRoot = input.factoryRoot ?? dirname(input.stateRoot)
  const globalPath = safeGlobalStateRoot(factoryRoot, input.stateRoot, false)
  if (!globalPath.ok && existsSync(input.stateRoot)) return { ok: false, reason: globalPath.reason, children: [], migrationNeeded: false }
  let globalChildren: ChildRecord[] = []
  try {
    readActed(input.stateRoot)
    readRuns(input.stateRoot, Number.MAX_SAFE_INTEGER)
    globalChildren = readChildren(input.stateRoot)
    readRunLock(input.stateRoot)
  } catch (error) {
    const reason = error instanceof WorkerRecordError && error.kind === 'unsafe'
      ? `refusing an unsafe global worker directory: ${error.message}`
      : (error as Error).message
    return { ok: false, reason, children: [], migrationNeeded: false }
  }

  const legacyRoot = workerDir(input.root)
  const legacyPath = safeLegacyStateRoot(input.root, legacyRoot)
  if (!legacyPath.ok) return { ok: false, reason: legacyPath.reason, children: [], migrationNeeded: false }
  if (!legacyPath.exists || legacyRoot === input.stateRoot) return { ok: true, reason: 'worker records are valid', children: globalChildren, migrationNeeded: false }
  const legacy = inspectLegacyFiles(legacyRoot, canonicalRepository(input.repo))
  const failed = Object.values(legacy).find((record) => record.error)
  if (failed) return { ok: false, reason: failed.error!, children: [], migrationNeeded: false }
  const legacyLogs = ['worker.log', 'worker.err.log'].map((name) => readAppendArtifact(join(legacyRoot, name)))
  const failedLog = legacyLogs.find((record) => record.error)
  if (failedLog) return { ok: false, reason: failedLog.error!, children: [], migrationNeeded: false }
  const children = [...globalChildren, ...(legacy.children.value ?? [])]
  const migrationNeeded = Object.values(legacy).some((record) => record.exists) || legacyLogs.some((record) => record.exists)
  return { ok: true, reason: 'worker records are valid', children: [...new Map(children.map((row) => [`${row.repo}#${row.issue}:${row.pid}:${row.startedAt}`, row])).values()], migrationNeeded }
}

// Task 3 moved worker state from each checkout to one machine directory. Move only the four old
// state files; logs deliberately stay where the old service wrote them. The merge is repeatable:
// every global file lands atomically before any legacy source is removed, and a retry deduplicates
// anything a crash already copied.
export function migrateLegacyWorkerState(input: {
  root: string
  stateRoot: string
  factoryRoot?: string
  repo: string
  start?: ProcessStart
  alive?: ProcessAlive
  afterWrite?: () => void
  afterBoundary?: (boundary: string) => void
}): LegacyMigrationResult {
  const legacyRoot = workerDir(input.root)
  const factoryRoot = input.factoryRoot ?? dirname(input.stateRoot)
  const globalPreflight = safeGlobalStateRoot(factoryRoot, input.stateRoot, true)
  if (!globalPreflight.ok) return { ok: false, migrated: false, reason: globalPreflight.reason }
  const legacyPreflight = safeLegacyStateRoot(input.root, legacyRoot)
  if (!legacyPreflight.ok) return { ok: false, migrated: false, reason: legacyPreflight.reason }
  if (legacyRoot === input.stateRoot) return { ok: true, migrated: false, reason: 'worker state is already global' }
  if (!legacyPreflight.exists) return { ok: true, migrated: false, reason: legacyPreflight.reason }
  const names = ['acted.json', 'runs.jsonl', 'children.json', 'run.lock'] as const
  const namedExists = (path: string) => {
    try { lstatSync(path); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  if (!names.some((name) => namedExists(join(legacyRoot, name)))) return { ok: true, migrated: false, reason: 'no legacy worker state' }
  const repo = canonicalRepository(input.repo)
  const start = input.start ?? processStart
  const alive = input.alive ?? processAlive
  const ordered = [legacyRoot, input.stateRoot].sort()

  return withLock(ordered[0]!, () => withLock(ordered[1]!, () => {
    const legacyLocked = safeLegacyStateRoot(input.root, legacyRoot)
    if (!legacyLocked.ok || !legacyLocked.exists) return { ok: false, migrated: false, reason: legacyLocked.reason }
    const globalLocked = safeGlobalStateRoot(factoryRoot, input.stateRoot, false)
    if (!globalLocked.ok) return { ok: false, migrated: false, reason: globalLocked.reason }
    const legacy = inspectLegacyFiles(legacyRoot, repo)
    const global = inspectLegacyFiles(input.stateRoot, null)
    const failed = [...Object.values(legacy), ...Object.values(global)].find((read) => read.error)
    if (failed) return { ok: false, migrated: false, reason: failed.error! }

    if (legacy.lock.value) {
      const identity = processIdentity(legacy.lock.value, start, alive)
      if (identity !== 'gone') return {
        ok: false, migrated: false,
        reason: identity === 'matching'
          ? `a legacy worker is still running (pid ${legacy.lock.value.pid}, since ${legacy.lock.value.at}) — stop it before moving worker state`
          : `the legacy worker lock belongs to pid ${legacy.lock.value.pid}, whose identity cannot be proved — leave it in place and check that process`,
      }
    }
    if (global.lock.value && global.lock.value.pid !== process.pid) {
      const identity = processIdentity(global.lock.value, start, alive)
      if (identity !== 'gone') return { ok: false, migrated: false, reason: `the global worker lock belongs to pid ${global.lock.value.pid}, whose identity cannot be proved safe for migration` }
    }

    const canonicalActed = (saved: Record<string, Acted>): Record<string, Acted> => {
      const result: Record<string, Acted> = {}
      for (const [key, value] of Object.entries(saved)) {
        const match = /^(.*)#(\d+)$/.exec(key)!
        const normalized = runKey({ repo: match[1]!, number: Number(match[2]) })
        if (!result[normalized] || value.at > result[normalized]!.at) result[normalized] = value
      }
      return result
    }
    const globalActed = canonicalActed(global.acted.value ?? {})
    for (const [key, value] of Object.entries(canonicalActed(legacy.acted.value ?? {}))) {
      if (!globalActed[key] || value.at > globalActed[key]!.at) globalActed[key] = value
    }
    const runRows = [...(global.runs.value ?? []), ...(legacy.runs.value ?? [])]
    const uniqueRuns = [...new Map(runRows.map((row) => [JSON.stringify(row), row])).values()].slice(-RUNS_KEPT)
    const childRows = [...(global.children.value ?? []), ...(legacy.children.value ?? [])]
    const uniqueChildren = [...new Map(childRows.map((row) => [`${row.repo}#${row.issue}:${row.pid}:${row.startedAt}`, row])).values()]

    mkdirSync(input.stateRoot, { recursive: true })
    if (legacy.acted.exists) { replaceFile(actedPath(input.stateRoot), JSON.stringify(globalActed, null, 2) + '\n'); chmodSync(actedPath(input.stateRoot), 0o600); input.afterBoundary?.('publish:acted.json') }
    if (legacy.runs.exists) { replaceFile(runsPath(input.stateRoot), uniqueRuns.map((row) => JSON.stringify(row)).join('\n') + (uniqueRuns.length ? '\n' : '')); chmodSync(runsPath(input.stateRoot), 0o600); input.afterBoundary?.('publish:runs.jsonl') }
    if (legacy.children.exists) { replaceFile(childrenPath(input.stateRoot), JSON.stringify(uniqueChildren, null, 2) + '\n'); chmodSync(childrenPath(input.stateRoot), 0o600); input.afterBoundary?.('publish:children.json') }
    input.afterWrite?.()
    for (const name of names) if (existsSync(join(legacyRoot, name))) { rmSync(join(legacyRoot, name), { force: true }); input.afterBoundary?.(`remove:${name}`) }
    return { ok: true, migrated: true, reason: `migrated legacy worker state for ${repo}` }
  }, { what: 'the global worker state migration' }), { what: 'the legacy worker state migration' })
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readAppendArtifact(path: string): { exists: boolean; text: string; error: string | null } {
  try {
    const info = lstatSync(path)
    const uid = process.getuid?.()
    if (!info.isFile() || info.isSymbolicLink()) return { exists: true, text: '', error: `${path} is not a regular append file` }
    if (uid !== undefined && info.uid !== uid) return { exists: true, text: '', error: `${path} is owned by uid ${info.uid}` }
    if ((info.mode & 0o022) !== 0) return { exists: true, text: '', error: `${path} is writable by another user` }
    return { exists: true, text: readFileSync(path, 'utf8'), error: null }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { exists: false, text: '', error: null }
      : { exists: true, text: '', error: `${path} cannot be read: ${(error as Error).message}` }
  }
}

// Replacing the name, rather than chmodding the old file, is the descriptor boundary: a process
// that still holds the old inode can consume its remaining bytes but can never observe a later
// append made through this path.
export function rotatePrivateAppend(path: string, preserved: string): void {
  const root = dirname(path)
  ensurePrivateRecordRoot(root, true)
  const current = readAppendArtifact(path)
  if (current.error) throw new WorkerRecordError('unsafe', current.error)
  const temporary = join(root, `.${parse(path).base}.${randomUUID()}.rotate`)
  try {
    writeFileSync(temporary, preserved, { flag: 'wx', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

interface AppendMigrationJournal {
  schema: 1
  name: string
  source: string
  sourceDigest: string
  beforeDigest: string
  mergedDigest: string
}

function appendJournalPath(stateRoot: string, name: string): string {
  return join(stateRoot, `.migrate-${name}.json`)
}

function readAppendJournal(stateRoot: string, name: string): AppendMigrationJournal | null {
  const path = appendJournalPath(stateRoot, name)
  const text = readPrivateRecord(stateRoot, path)
  if (text === null) return null
  try {
    const row = JSON.parse(text) as Partial<AppendMigrationJournal>
    if (row.schema !== 1 || row.name !== name || typeof row.source !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.sourceDigest ?? '') || !/^[0-9a-f]{64}$/.test(row.beforeDigest ?? '')
      || !/^[0-9a-f]{64}$/.test(row.mergedDigest ?? '')) throw new Error('invalid journal schema')
    return row as AppendMigrationJournal
  } catch (error) { throw new WorkerRecordError('malformed', `${path} is malformed: ${(error as Error).message}`) }
}

function migrateAppendTarget(input: {
  stateRoot: string
  legacyRoot: string
  name: string
  afterBoundary?: (boundary: string) => void
}): void {
  const target = join(input.stateRoot, input.name)
  const source = join(input.legacyRoot, input.name)
  const current = readAppendArtifact(target)
  if (current.error) throw new WorkerRecordError('unsafe', current.error)
  if (source === target) { rotatePrivateAppend(target, current.text); return }
  const legacy = readAppendArtifact(source)
  if (legacy.error) throw new WorkerRecordError('unsafe', legacy.error)
  const journalPath = appendJournalPath(input.stateRoot, input.name)
  let journal = readAppendJournal(input.stateRoot, input.name)
  if (!journal && !legacy.exists) { rotatePrivateAppend(target, current.text); return }
  if (!journal) {
    const merged = current.text + legacy.text
    journal = {
      schema: 1, name: input.name, source,
      sourceDigest: digest(legacy.text), beforeDigest: digest(current.text), mergedDigest: digest(merged),
    }
    replacePrivateRecord(input.stateRoot, journalPath, JSON.stringify(journal, null, 2) + '\n')
    input.afterBoundary?.(`journal:${input.name}`)
  }
  if (journal.source !== source) throw new WorkerRecordError('malformed', `${journalPath} names an unexpected source`)
  const latestTarget = readAppendArtifact(target)
  const latestSource = readAppendArtifact(source)
  if (latestTarget.error || latestSource.error) throw new WorkerRecordError('unsafe', latestTarget.error ?? latestSource.error!)
  const targetDigest = digest(latestTarget.text)
  if (targetDigest === journal.beforeDigest) {
    if (!latestSource.exists || digest(latestSource.text) !== journal.sourceDigest) throw new WorkerRecordError('malformed', `${source} changed during append migration`)
    const merged = latestTarget.text + latestSource.text
    if (digest(merged) !== journal.mergedDigest) throw new WorkerRecordError('malformed', `${journalPath} does not describe the append migration`)
    rotatePrivateAppend(target, merged)
    input.afterBoundary?.(`publish:${input.name}`)
  } else if (targetDigest !== journal.mergedDigest) {
    throw new WorkerRecordError('malformed', `${target} changed during append migration`)
  }
  const sourceAfter = readAppendArtifact(source)
  if (sourceAfter.error) throw new WorkerRecordError('unsafe', sourceAfter.error)
  if (sourceAfter.exists) {
    if (digest(sourceAfter.text) !== journal.sourceDigest) throw new WorkerRecordError('malformed', `${source} changed before removal`)
    rmSync(source)
    input.afterBoundary?.(`remove:${input.name}`)
  }
  rmSync(journalPath, { force: true })
  input.afterBoundary?.(`clear-journal:${input.name}`)
}

interface QuarantineJournal { schema: 1; name: string; source: string; target: string; reason: string }

function quarantineJournalPath(stateRoot: string): string { return join(stateRoot, '.quarantine.json') }

function readQuarantineJournal(stateRoot: string): QuarantineJournal | null {
  const path = quarantineJournalPath(stateRoot)
  const text = readPrivateRecord(stateRoot, path)
  if (text === null) return null
  try {
    const row = JSON.parse(text) as Partial<QuarantineJournal>
    if (row.schema !== 1 || typeof row.name !== 'string' || typeof row.source !== 'string'
      || typeof row.target !== 'string' || typeof row.reason !== 'string' || !row.reason) throw new Error('invalid journal schema')
    return row as QuarantineJournal
  } catch (error) { throw new WorkerRecordError('malformed', `${path} is malformed: ${(error as Error).message}`) }
}

function quarantineMalformedLegacy(input: { root: string; stateRoot: string; repo: string; afterBoundary?: (boundary: string) => void }): string | null {
  const legacyRoot = workerDir(input.root)
  const safe = safeLegacyStateRoot(input.root, legacyRoot)
  if (!safe.ok || legacyRoot === input.stateRoot) return null
  const quarantine = join(input.stateRoot, 'quarantine')
  ensurePrivateRecordRoot(input.stateRoot, true)
  ensurePrivateRecordRoot(quarantine, true)
  const journalPath = quarantineJournalPath(input.stateRoot)
  let journal = readQuarantineJournal(input.stateRoot)
  if (!journal) {
    if (!safe.exists) return null
    const inspected = inspectLegacyFiles(legacyRoot, canonicalRepository(input.repo))
    const entries = [
      ['acted.json', inspected.acted], ['runs.jsonl', inspected.runs],
      ['children.json', inspected.children], ['run.lock', inspected.lock],
      ['worker.log', readAppendArtifact(join(legacyRoot, 'worker.log'))],
      ['worker.err.log', readAppendArtifact(join(legacyRoot, 'worker.err.log'))],
    ] as const
    const failed = entries.find(([, result]) => result.error)
    if (!failed) return null
    const [name, result] = failed
    journal = { schema: 1, name, source: join(legacyRoot, name), target: join(quarantine, `${name}.${randomUUID()}.preserved`), reason: result.error! }
    replacePrivateRecord(input.stateRoot, journalPath, JSON.stringify(journal, null, 2) + '\n')
    input.afterBoundary?.(`quarantine-journal:${name}`)
  }
  const names = new Set(['acted.json', 'runs.jsonl', 'children.json', 'run.lock', 'worker.log', 'worker.err.log'])
  if (!names.has(journal.name) || journal.source !== join(legacyRoot, journal.name) || dirname(journal.target) !== quarantine) {
    throw new WorkerRecordError('malformed', `${journalPath} names a path outside the legacy quarantine transaction`)
  }
  const sourceExists = pathEntryExists(journal.source)
  const targetExists = pathEntryExists(journal.target)
  if (sourceExists && targetExists) throw new WorkerRecordError('unsafe', `${journalPath} found both source and quarantine target`)
  if (sourceExists) {
    const locked = safeLegacyStateRoot(input.root, legacyRoot)
    if (!locked.ok || !locked.exists) throw new WorkerRecordError('unsafe', locked.reason)
    try { renameSync(journal.source, journal.target) }
    catch (error) { throw new WorkerRecordError('unreadable', `${journal.reason}; it could not be quarantined: ${(error as Error).message}`) }
    input.afterBoundary?.(`quarantine-rename:${journal.name}`)
  }
  if (!pathEntryExists(journal.target)) throw new WorkerRecordError('unreadable', `${journal.reason}; neither source nor quarantine target exists`)
  const quarantined = lstatSync(journal.target)
  if (quarantined.isFile() && !quarantined.isSymbolicLink()) {
    const bytes = readFileSync(journal.target)
    const privateCopy = join(quarantine, `.${journal.name}.${randomUUID()}.private`)
    try {
      writeFileSync(privateCopy, bytes, { flag: 'wx', mode: 0o600 })
      chmodSync(privateCopy, 0o600)
      renameSync(privateCopy, journal.target)
      input.afterBoundary?.(`quarantine-private:${journal.name}`)
    } catch (error) {
      rmSync(privateCopy, { force: true })
      throw new WorkerRecordError('unreadable', `${journal.reason}; evidence moved to ${journal.target}, but its private snapshot failed: ${(error as Error).message}`)
    }
  }
  rmSync(journalPath, { force: true })
  input.afterBoundary?.(`quarantine-clear:${journal.name}`)
  return `${journal.reason}; preserved at ${journal.target}`
}

function privatizeGlobalRecords(input: { stateRoot: string; start?: ProcessStart; alive?: ProcessAlive; afterBoundary?: (boundary: string) => void }): void {
  const records = inspectLegacyFiles(input.stateRoot, null)
  const failed = Object.values(records).find((record) => record.error)
  if (failed) throw new WorkerRecordError('malformed', failed.error!)
  if (records.lock.value && records.lock.value.pid !== process.pid) {
    const identity = processIdentity(records.lock.value, input.start ?? processStart, input.alive ?? processAlive)
    if (identity !== 'gone') throw new WorkerRecordError('unsafe', identity === 'matching'
      ? `the worker service still owns pid ${records.lock.value.pid}; storage rotation requires it to be stopped`
      : `the worker lock belongs to pid ${records.lock.value.pid}, whose identity cannot be proved after service stop`)
  }
  if (records.acted.exists) {
    const normalized: Record<string, Acted> = {}
    for (const [key, value] of Object.entries(records.acted.value ?? {})) {
      const match = /^(.*)#([1-9]\d*)$/.exec(key)!
      const canonical = runKey({ repo: match[1]!, number: Number(match[2]) })
      if (!normalized[canonical] || value.at > normalized[canonical]!.at) normalized[canonical] = value
    }
    rotatePrivateAppend(actedPath(input.stateRoot), JSON.stringify(normalized, null, 2) + '\n')
    input.afterBoundary?.('privatize:acted.json')
  }
  if (records.children.exists) { rotatePrivateAppend(childrenPath(input.stateRoot), JSON.stringify(records.children.value ?? [], null, 2) + '\n'); input.afterBoundary?.('privatize:children.json') }
  if (records.lock.exists) { rotatePrivateAppend(runLockPath(input.stateRoot), JSON.stringify(records.lock.value, null, 2) + '\n'); input.afterBoundary?.('privatize:run.lock') }
}

export function prepareWorkerStorage(input: {
  root: string
  stateRoot: string
  factoryRoot?: string
  repo: string
  serviceStopped: boolean
  start?: ProcessStart
  alive?: ProcessAlive
  afterBoundary?: (boundary: string) => void
}): LegacyMigrationResult {
  if (!input.serviceStopped) return { ok: false, migrated: false, reason: 'worker storage cannot rotate until the service is confirmed stopped' }
  const factoryRoot = input.factoryRoot ?? dirname(input.stateRoot)
  const legacyPreflight = safeLegacyStateRoot(input.root, workerDir(input.root))
  if (!legacyPreflight.ok) return { ok: false, migrated: false, reason: legacyPreflight.reason }
  try { ensurePrivateRecordRoot(input.stateRoot, true) }
  catch (error) { return { ok: false, migrated: false, reason: (error as Error).message } }
  try {
    return withLock(join(input.stateRoot, '.storage-preparation'), () => {
      try {
        const quarantined = quarantineMalformedLegacy(input)
        if (quarantined) return { ok: false, migrated: false, reason: `${quarantined}; retry enable after inspecting the preserved evidence` }
      } catch (error) { return { ok: false, migrated: false, reason: (error as Error).message } }
      const migration = migrateLegacyWorkerState({ ...input, factoryRoot, afterBoundary: input.afterBoundary })
      if (!migration.ok) {
        try {
          const quarantined = quarantineMalformedLegacy(input)
          if (quarantined) return { ok: false, migrated: false, reason: `${quarantined}; retry enable after inspecting the preserved evidence` }
        } catch (error) { return { ok: false, migrated: false, reason: (error as Error).message } }
        return migration
      }
      try {
        privatizeGlobalRecords(input)
        const runs = inspectLegacyRuns(runsPath(input.stateRoot), null)
        if (runs.error) throw new WorkerRecordError('malformed', runs.error)
        const runBytes = inspectWorkerRecord(runsPath(input.stateRoot))
        if (runBytes.error) throw new WorkerRecordError('unsafe', runBytes.error)
        rotatePrivateAppend(runsPath(input.stateRoot), runBytes.value ?? '')
        input.afterBoundary?.('privatize:runs.jsonl')
        const legacyRoot = workerDir(input.root)
        for (const name of ['worker.log', 'worker.err.log']) migrateAppendTarget({ stateRoot: input.stateRoot, legacyRoot, name, afterBoundary: input.afterBoundary })
        return { ok: true, migrated: migration.migrated, reason: migration.migrated ? migration.reason : 'worker storage is private and append targets use fresh inodes' }
      } catch (error) {
        try {
          const quarantined = quarantineMalformedLegacy(input)
          if (quarantined) return { ok: false, migrated: migration.migrated, reason: `${quarantined}; retry enable after inspecting the preserved evidence` }
        } catch (quarantineError) { return { ok: false, migrated: migration.migrated, reason: (quarantineError as Error).message } }
        return { ok: false, migrated: migration.migrated, reason: (error as Error).message }
      }
    }, { what: 'worker storage preparation' })
  } catch (error) { return { ok: false, migrated: false, reason: (error as Error).message } }
}

// ---------------------------------------------------------------------------------------------
// The transitions

export interface Decision { action: Action; reason: string; trigger: number | null; by: string | null; split: boolean; quote: string | null }

const nothing = (reason: string): Decision => ({ action: 'none', reason, trigger: null, by: null, split: false, quote: null })

// A line whose whole point is "ship it". "do not ship it", "ship it after fixing X", "never: ship
// it" and "I refuse; ship it" are all corrections that happen to contain the words, and a gate
// that read any of them as consent would merge on a sentence saying the opposite.
//
// So the *whole line* has to be an affirmative: an optional approving lead-in from this list, then
// the instruction, then nothing. Anything else — a word before it that is not on the list, a
// condition after it — is a correction. An operator who wants no argument writes "ship it".
const APPROVING = ['ok', 'okay', 'yes', 'yep', 'yup', 'sure', 'lgtm', 'looks good', 'looks great', 'nice', 'nice work', 'great', 'perfect', 'approved', 'agreed', 'all good']
// Longest first, so "nice work" is one lead-in rather than "nice" followed by a word that is not.
const SHIP_LINE = new RegExp(`^(?:(?:${[...APPROVING].sort((a, b) => b.length - a.length).join('|')})[\\s,;:!.\\u2014\\u2013-]+)*ship(?:\\s+it|\\s+this)?$`, 'iu')

export function shipWord(body: string): string | null {
  for (const raw of String(body ?? '').split('\n')) {
    // A quoted reply is someone else's words being repeated, not this person's instruction.
    const line = raw.trim()
    if (!line || line.startsWith('>')) continue
    const bare = line.replace(/^[*\-\s]+/, '').replace(/[^\p{L}\s]+$/u, '').trim()
    if (SHIP_LINE.test(bare)) return line
  }
  return null
}
// "stop", "stop.", "@vegafactory stop — I need to rethink this". Not "stop using the old API",
// which is a correction about the work and not an instruction to put the issue down.
const STOP = /^\s*(?:@?[\w-]+[,:]?\s+)?stop\s*(?:$|[\n—–:,.!?])/i
const WRITE = new Set(['admin', 'maintain', 'write'])

// Two different questions, and the difference is the whole trust model.
//
// *Who may approve* — an ack, a correction, a stop, a "ship it" — is always a person with write
// access. No bot, and no App, stands in for a human's word.
//
// *Who may write the work* is wider: a plan, an evidence comment or the status comment may come
// from a person with write access or from the factory's own App, because a worker run's
// artifacts are posted by the machine, not by a person sitting behind it.
const fromPerson = (permission: PermissionLookup) => (entry: CommentEntry) =>
  entry.authorType !== 'Bot' && !!entry.author && WRITE.has(permission(entry.author))
const fromFactory = (permission: PermissionLookup, appActor = appIdentityConfig().appActor) => (entry: CommentEntry) =>
  entry.author === appActor || fromPerson(permission)(entry)

// The operator's own comments: a person with write access, in the order they were written.
function operatorComments(snap: Snapshot, permission: PermissionLookup) {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'human' && fromPerson(permission)(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

// The newest work artifact of a type: written by a person with write access, or by the App on a
// worker run's behalf. An outsider's comment is text on a page and never either.
export function latestArtifact(snap: Snapshot, type: string, permission: PermissionLookup, appActor?: string): CommentEntry | null {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === type && fromFactory(permission, appActor)(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1) ?? null
}

// Comments that are bookkeeping, not an answer or a piece of work: they must not move the line an
// operator's reply has to beat, or a session claiming an issue would swallow the reply forever.
// Comments a machine writes about itself rather than about the work. They must not count as work
// done on the issue: `waiting-on-operator` looks for the operator's reply to be *later* than
// anything an agent wrote, so a machine that stood down and said so would otherwise bury the very
// reply it was standing down without answering, and no machine would ever pick the issue up.
// Comments a machine writes about itself rather than about the work, so they must not count as
// work done on the issue: `waiting-on-operator` looks for the operator's reply to be *later* than
// anything an agent wrote, and a machine that stood down and said so would otherwise bury the very
// reply it was standing down without answering.
//
// A `handback` is emphatically not one of these. That is an agent stopping to *ask* something —
// the smallest question, a missing artifact, a scope ratchet — and it is the thing the operator's
// reply answers. Counting it as bookkeeping would let a comment written before the question was
// asked read as the answer to it.
const BOOKKEEPING = new Set(['claim', 'release', 'ledger', 'ack', 'standdown'])
const isBookkeeping = (_snap: Snapshot, entry: CommentEntry) => BOOKKEEPING.has(entry.type)

// The action this issue is waiting for, and the comment that asks for it. `trigger` is what makes
// a run happen once: a comment already acted on asks for nothing more, and a state label already
// worked is not worked again until the issue moves.
export function decide(snap: Snapshot, permission: PermissionLookup, options: { acted?: Acted | null; now?: number; held?: boolean; failures?: number; appActor?: string } = {}): Decision {
  const issue = snap.state.issue!
  const { acted = null, now = Date.now(), held = false } = options
  if (issue.state !== 'open') return nothing('the issue is closed')
  if (issue.labels.includes('epic')) return nothing('an epic is a map; its sub-issues carry the work')
  const { state } = stateOf(issue.labels)
  if (!state) return nothing('no state label')
  const comments = operatorComments(snap, permission)
  const decided = transitionOf(snap, issue, state, comments, permission, { acted, held, appActor: options.appActor })
  if (decided.action === 'none') return decided

  // A trigger is spent once a run of the same action has settled on it, whatever it settled as —
  // only a failure and a subscription limit come back, and each has its own wait.
  if (acted && acted.action === decided.action) {
    // Parked before waiting: every failure sets a retry deadline, so asking about the wait first
    // would report a run that has spent its last try as merely due again later, and `park 1` would
    // never park anything.
    if (acted.failures >= (options.failures ?? MAX_FAILURES) && acted.trigger === decided.trigger) return nothing(`${decided.action} failed ${acted.failures} times — this issue needs a person`)
    if (acted.retryAt !== null && now < acted.retryAt) return nothing(`${decided.action} is waiting until ${new Date(acted.retryAt).toISOString()}`)
    if (acted.retryAt === null && acted.trigger === decided.trigger) {
      return nothing(`already ran ${decided.action} for this ${decided.trigger === null ? 'state' : 'comment'}`)
    }
  }
  return decided
}

type Comments = ReturnType<typeof operatorComments>
type IssueFacts = IssueEntry

function transitionOf(snap: Snapshot, issue: IssueFacts, state: State, comments: Comments, permission: PermissionLookup,
  run: { acted: Acted | null; held: boolean; appActor?: string }): Decision {
  const labels = issue.labels
  const last = comments.at(-1) ?? null
  if (last && STOP.test(snap.body(last))) return { action: 'stop', reason: `@${last.author} said stop`, trigger: last.id, by: last.author, split: false, quote: null }
  if (state === 'planning') return { action: 'plan', reason: 'the brief is acked and the plan is not written', trigger: null, by: null, split: labels.includes('large'), quote: null }
  if (state === 'queued') {
    // The same fact `issue check --for implement` blocks on: building on an open blocker wastes
    // the run and, worse, lands work on a base that is still moving.
    if (issue.blockedBy.length) return nothing(`blocked by ${issue.blockedBy.map((number) => `#${number}`).join(', ')}`)
    return { action: 'implement', reason: 'the plan is acked and nobody has built it', trigger: null, by: null, split: false, quote: null }
  }
  if (state === 'waiting-on-operator') {
    // The reply the issue was waiting for: an operator comment later than the last thing an agent
    // wrote and later than the brief's own last edit. Claims, releases, acks and the status
    // comment are bookkeeping and move nothing.
    const work = Object.values(snap.state.comments).filter((entry) => entry.type !== 'human' && !isBookkeeping(snap, entry)).map((entry) => entry.createdAt)
    const after = [issue.bodyChangedAt, ...work].sort().at(-1) ?? ''
    const reply = comments.filter((entry) => entry.createdAt > after).at(-1)
    return reply
      ? { action: 'follow-up', reason: `@${reply.author} replied on a waiting-on-operator issue`, trigger: reply.id, by: reply.author, split: false, quote: null }
      : nothing('waiting on the operator')
  }
  if (state === 'in-progress') {
    // A run that claimed moved the issue here. While a claim is alive it is someone's; once the
    // claim is gone the run is over and did not finish, so this machine picks its own work back
    // up rather than leaving the issue where no state label will ever move it again.
    if (run.held) return nothing('a live claim holds it')
    const resume = run.acted && run.acted.outcome !== 'done' ? run.acted.action : 'implement'
    if (resume === 'none' || resume === 'stop') return nothing('in-progress with nothing to resume')
    return { action: resume, reason: 'an interrupted run left it in-progress with no holder', trigger: run.acted?.trigger ?? null, by: null, split: false, quote: null }
  }
  if (state === 'ready-to-ship') {
    const evidence = latestArtifact(snap, 'evidence', permission, run.appActor)
    if (!evidence) return nothing('ready-to-ship with no evidence comment')
    const word = comments.filter((entry) => entry.createdAt > (evidence.changedAt || evidence.updatedAt)).at(-1)
    if (!word) return nothing('waiting for the operator to read the evidence')
    // A candidate only: the word is not consent until it has been recorded as an ack and read
    // back by the same check `issue check --for ship` runs. `confirmShip` does that.
    const quote = shipWord(snap.body(word))
    return quote
      ? { action: 'ship', reason: `@${word.author} said ship it`, trigger: word.id, by: word.author, split: false, quote }
      : { action: 'corrections', reason: `@${word.author} left corrections on a ready-to-ship issue`, trigger: word.id, by: word.author, split: false, quote: null }
  }
  return nothing(`nothing to do while the issue is ${state}`)
}

// ---------------------------------------------------------------------------------------------
// Safety: which of the wanted steps may run at the same time

// Paths no two runs may share, whatever a plan claims: what nearly every change touches
// (plan-lint's own list), generated output, migrations and lockfiles. A join on one of these is
// the worst place to find out two agents were in the same file.
const UNSAFE = [/(^|\/)(dist|build|out|generated)\//, /(^|\/)migrations?\//, /\.lock$/, /(^|\/)package(-lock)?\.json$/, /(^|\/)skill-integrity\.json$/, /\.generated\.\w+$/]

export function unsafeForParallel(path: string): boolean {
  const normalized = String(path).replace(/^\.\//, '')
  return sharedByEveryChild(normalized) || UNSAFE.some((pattern) => pattern.test(normalized))
}

// A path ending in `/` is a directory and covers everything under it (the plan grammar's rule).
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('/') && b.startsWith(a)) return true
  return b.endsWith('/') && a.startsWith(b)
}

export interface Candidate { repo: string; number: number; action: Action; parent: number | null; files: string[]; from: State }

export function runKey(value: { repo: string; number: number }): string {
  return `${canonicalRepository(value.repo)}#${value.number}`
}

const CODE: Action[] = ['implement', 'corrections']
const sameRepository = (a: Candidate, b: Candidate) => canonicalRepository(a.repo) === canonicalRepository(b.repo)

// The steps that may start now, in board order. One run per issue; at most `max` at once; one
// merge at a time, because merges go through the queue one by one; and two code runs together
// only when they are sibling sub-issues whose declared file sets are disjoint and safe.
export function schedule(candidates: Candidate[], running: Candidate[] = [], max = MAX_RUNS): Candidate[] {
  const picked: Candidate[] = [...running]
  const chosen: Candidate[] = []
  for (const candidate of candidates) {
    if (picked.length >= max) break
    if (picked.some((other) => runKey(other) === runKey(candidate))) continue
    if (candidate.action === 'ship' && picked.some((other) => sameRepository(other, candidate) && other.action === 'ship')) continue
    if (CODE.includes(candidate.action) && !picked.filter((other) => sameRepository(other, candidate) && CODE.includes(other.action)).every((other) => disjointSiblings(candidate, other))) continue
    picked.push(candidate)
    chosen.push(candidate)
  }
  return chosen
}

export function disjointSiblings(a: Candidate, b: Candidate): boolean {
  if (a.parent === null || a.parent !== b.parent) return false
  if (!a.files.length || !b.files.length) return false
  if (a.files.some(unsafeForParallel) || b.files.some(unsafeForParallel)) return false
  return !a.files.some((file) => b.files.some((their) => overlaps(file, their)))
}

// A declared path, as one canonical repository-relative spelling — or nothing. `src/../src/x` and
// `src/x` are the same file, and a set that did not say so would read as disjoint; a glob, an
// absolute path or one that climbs out of the repository is not a file set anyone can check.
export function canonicalPath(path: string): string | null {
  const raw = String(path ?? '').trim()
  if (!raw || /[*?[\]{}]/.test(raw) || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) return null
  const directory = raw.endsWith('/')
  const normalized = posix.normalize(normalizeGroupPath(raw))
  if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.startsWith('/')) return null
  return directory && !normalized.endsWith('/') ? `${normalized}/` : normalized
}

// The file set a sub-issue declared, from its parent epic's plan `**Independent groups:**` block.
// No declaration means no parallel run, and neither does one path this cannot canonicalize: one
// at a time is the safe default, and a set that is only partly checkable is not a set.
export function filesFromParent(parentPlan: string | null, number: number): string[] {
  if (!parentPlan) return []
  const groups = parseIndependentGroups(parentPlan) as Array<{ id: string | null; members: string[]; files: string[] }>
  const declared = groups.find((group) => group.id && group.members.includes(`#${number}`))?.files ?? []
  const canonical = declared.map(canonicalPath)
  return canonical.every((path): path is string => path !== null) ? canonical : []
}

// ---------------------------------------------------------------------------------------------
// Running one step

export interface Step { action: Action; number: number; repo: string; split: boolean; by: string | null }
export interface StepResult { outcome: Outcome; note: string; ms: number }
export type RunStep = (step: Step, context: { root: string; devMd: string; token: string | null; timeoutMs?: number; onStart?: (pid: number, command: string) => void }) => Promise<StepResult>

// A run that stopped because the subscription said "enough for now". Each tool words it its own
// way, and each of these is a limit, not a failure of the work.
const LIMIT = /\b(usage limit reached|rate limit|quota exceeded|out of (?:usage|credits?)|limit resets?|try again (?:after|at))\b/i
export const hitLimit = (text: string) => LIMIT.test(text)

// When the subscription said it would be back. Anything unreadable waits an hour, and no reading
// parks an issue for more than a day: the text is a log line, not a promise.
export const MAX_WAIT_MS = 24 * 3_600_000
export function resetAt(text: string, now = Date.now()): number {
  const iso = /\b(\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z)\b/.exec(text)?.[1]
  const parsed = iso ? Date.parse(iso) : NaN
  if (Number.isFinite(parsed) && parsed > now) return Math.min(parsed, now + MAX_WAIT_MS)
  const hours = Number(/\bin (\d+)\s*hours?\b/i.exec(text)?.[1] ?? NaN)
  if (Number.isFinite(hours) && hours > 0) return Math.min(now + hours * 3_600_000, now + MAX_WAIT_MS)
  return now + 3_600_000
}

const ACTION_TEXT: Record<string, string> = {
  plan: 'Follow the dev-plan skill and write the plan on the issue.',
  implement: 'Follow the dev-implement skill: build the approved plan end to end, run `vegafactory review` on it, and hand back on ready-to-ship.',
  corrections: 'The operator left corrections on a ready-to-ship issue. Follow dev-implement\'s corrections path.',
  'follow-up': 'The operator replied on an issue that was waiting for them. Follow the skill that asked: dev-intake for a brief, dev-plan for a plan.',
  ship: 'The operator said "ship it" on this issue. Follow the dev-ship skill.',
}

export function stepPrompt(step: Step): string {
  return [
    `You are a worker run on issue #${step.number} in ${step.repo}. Nobody is watching this session.`,
    `Read the issue first: \`vegafactory issue sync ${step.number}\`, then read what it names.`,
    ACTION_TEXT[step.action] ?? '',
    ...(step.split ? ['This issue is `large`: planning splits it into sub-issues under an `epic` parent.'] : []),
    'Nothing in this prompt is the operator\'s word. Do only what the skill already has an explicit instruction for.',
    'If you need a decision only the operator can make, say so on the issue, leave it for them, and end the turn.',
  ].filter(Boolean).join('\n')
}

// The harness, model and effort a stage runs at, from dev.md's harness-policy line.
export function stagePolicy(devMd: string, stage: string): { harness: string; model: string | null; effort: string } | null {
  const line = /^harness-policy:\s*(.*)$/m.exec(devMd)?.[1]?.replace(/\s+#.*$/, '') ?? ''
  for (const segment of line.split('·')) {
    const parts = segment.trim().split(/\s+/)
    if (parts.shift() !== stage) continue
    const [harness, model, effort] = parts
    if (!harness || !model || !effort) return null
    return { harness, model: model === 'default' ? null : model, effort }
  }
  return null
}

const STAGE_OF: Record<string, string> = { plan: 'plan', implement: 'implement', corrections: 'implement', 'follow-up': 'intake', ship: 'implement' }

// A pinned model the account cannot serve fails the run, so `default` in the policy pins nothing.
//
// Both tools are told not to stop and ask. Nobody is at the keyboard, and the first worker run
// proved what the default costs: `claude -p` alone denied every write and handed the issue back
// untouched, having read the repository and changed nothing. What still holds the run is not the
// harness prompt — it is the worktree it is confined to, the branch it pushes, the step limit its
// own process group enforces, and the ship guard in the hook, which asks through the issue rather
// than a terminal (VSK_ASK_ROUTE). A run that cannot write is not unattended, it is stuck.
export function agentArgs(policy: { harness: string; model: string | null; effort: string } | null, prompt: string): { tool: string; args: string[] } {
  if (policy?.harness === 'codex') {
    return { tool: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', ...(policy.model ? ['-c', `model=${policy.model}`] : []), '-c', `model_reasoning_effort=${policy.effort}`, prompt] }
  }
  return { tool: 'claude', args: ['-p', '--dangerously-skip-permissions', ...(policy?.model ? ['--model', policy.model] : []), ...(policy ? ['--effort', policy.effort] : []), prompt] }
}

interface Exec { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

// The limit is enforced inside the child's own process group, so it holds even if the worker
// dies: an agent orphaned by a crash or a `launchctl bootout` still stops on its own rather than
// writing to GitHub unsupervised for hours.
// The backstop sleeps with its own stdio, detached from the job's pipes, and is killed by name
// rather than through the subshell that started it. Both halves are load-bearing: killing a
// subshell leaves the `sleep` inside it running, and an orphan sleep holding the job's stdout means
// the reader never sees end-of-file. The first worker run finished its work in twelve seconds
// and held its slot for the full twenty-minute limit, because of exactly that.
const WATCHDOG = '"$@" & job=$!; { sleep "$VF_LIMIT" & dog=$!; wait "$dog"; kill -KILL 0; } </dev/null >/dev/null 2>&1 & guard=$!;'
  + ' wait "$job"; code=$?; pkill -P "$guard" 2>/dev/null; kill "$guard" 2>/dev/null; exit "$code"'

// One child, in its own process group so a stuck step is killed with everything it started. Only
// the tail of its output is kept: the record is bounded and the output never reaches the issue.
function execTool(tool: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onStart?: (pid: number, command: string) => void }): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', WATCHDOG, 'vegafactory-worker', tool, ...args], {
      // Half a minute behind this process's own timer, so the backstop only ever fires for an
      // orphan and a killed step is reported as killed rather than as an exit code.
      cwd: options.cwd, env: { ...options.env, VF_LIMIT: String(Math.ceil(options.timeoutMs / 1000) + 30) },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    if (child.pid) options.onStart?.(child.pid, tool)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, options.timeoutMs)
    const keep = (text: string, chunk: unknown) => (text + String(chunk)).slice(-8192)
    child.stdout.on('data', (chunk) => { stdout = keep(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = keep(stderr, chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, error: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}

export const tail = (text: string, max = MAX_NOTE) => text.trim().split('\n').slice(-3).join(' ').slice(-max)

// The issue's worktree when one exists; a step that needs a branch makes its own.
export function workingDir(root: string, number: number): string | null {
  const issue = join(dirname(root), 'issues', String(number))
  try {
    if (statSync(issue).isDirectory()) return issue
  } catch { /* a step that needs a branch creates it */ }
  const base = join(root, '.vegastack', '.worktrees')
  try {
    const match = readdirSync(base).find((name) => name.startsWith(`${number}-`))
    return match && statSync(join(base, match)).isDirectory() ? join(base, match) : null
  } catch { return null }
}

// The real step: a headless agent run on the operator's subscription, in the issue's worktree,
// killed after the step limit. `childEnvironment` is what refuses an API key in the environment.
// The environment a worker run gets. Three things are true of it and each one matters:
//
// - it runs on the operator's subscription, which is what `childEnvironment` proves;
// - it writes to GitHub as the configured App, on the short-lived installation token this machine
//   minted, so nothing it writes can pass as a person's stop, correction or "ship it";
// - it is never told where the App's private key is. The token expires in an hour; the key does
//   not. A child under this dedicated App-only account can still read the key through the
//   filesystem; that is an accepted deployment property, not a claimed same-user boundary.
export function childRunEnvironment(env: NodeJS.ProcessEnv, token: string | null, workerLayout = false): NodeJS.ProcessEnv {
  let child: NodeJS.ProcessEnv = { ...childEnvironment(env), VSK_ASK_ROUTE: 'issue' }
  for (const name of Object.keys(child)) if (name.startsWith('VEGAFACTORY_')) delete child[name]
  if (env.VEGAFACTORY_APP_ID?.trim() || env.VEGAFACTORY_APP_ACTOR?.trim()) {
    const identity = appIdentityConfig(env)
    child.VEGAFACTORY_APP_ID = identity.appId
    child.VEGAFACTORY_APP_ACTOR = identity.appActor
  }
  // This OS account deliberately has no person's GitHub or SSH identity. Reset every inherited
  // Git/SSH credential path, then install exactly the selected repository's App token. The same
  // token backs API calls and HTTPS Git through gh's credential helper; there is no fallback.
  child = appGitEnvironment(child, token)
  if (workerLayout) child.VSK_WORKTREE_LAYOUT = 'worker'
  return child
}

export function defaultRunStep(env: NodeJS.ProcessEnv, { exec = execTool, timeoutMs = STEP_TIMEOUT_MS } = {}): RunStep {
  return async (step, context) => {
    const started = Date.now()
    const policy = stagePolicy(context.devMd, STAGE_OF[step.action] ?? 'implement')
    const { tool, args } = agentArgs(policy, stepPrompt(step))
    const cwd = workingDir(context.root, step.number) ?? context.root
    // Nobody is at the keyboard, so a round of questions goes to the issue and waits there for the
    // operator — dev-setup's references/ask-route.md, where VSK_ASK_ROUTE is the first step.
    // The limit arrives with the run rather than with the step function, so a roster change lands
    // on the next run instead of the next restart.
    const limit = context.timeoutMs ?? timeoutMs
    const child = await exec(tool, args, { cwd, env: childRunEnvironment(env, context.token, true), timeoutMs: limit, onStart: context.onStart })
    const ms = Date.now() - started
    const text = `${child.stderr}\n${child.stdout}`
    if (child.timedOut) return { outcome: 'killed', note: `${tool} ran past the ${limit / 60_000}-minute step limit and was stopped`, ms }
    if (child.error) return { outcome: 'failed', note: `could not start ${tool}: ${child.error}`, ms }
    // A limit is why a run stopped early, never a phrase in the work of a run that finished: the
    // diff of a retry helper says "rate limit" all day.
    if (child.code !== 0 && hitLimit(text)) return { outcome: 'limit', note: tail(text), ms }
    if (child.code !== 0) return { outcome: 'failed', note: `${tool} exited ${child.code}: ${tail(text)}`, ms }
    return { outcome: 'done', note: tail(child.stdout), ms }
  }
}

// ---------------------------------------------------------------------------------------------
// The poll

// Every open issue carrying a state label. One list request per poll; the per-issue reads that
// follow are conditional, so an unchanged issue costs almost nothing.
export function board(repo: string, runner: GhRunner): GhIssue[] {
  const issues = ghList<GhIssue & { pull_request?: unknown }>(`repos/${repo}/issues?state=open&sort=updated&direction=desc`, runner)
  return issues.filter((issue) => !issue.pull_request && stateOf(issue.labels.map((label) => (typeof label === 'string' ? label : label.name))).state !== null)
}

export interface BoardContext {
  key: string
  repo: string
  root: string
  identity: AppIdentity
  runner: GhRunner
  devMd: string
}

export interface PendingHandBack { issue: number; from: State; reason: string }
export interface BoardRecord {
  repo: string
  state: 'active' | 'dropping'
  pending?: PendingHandBack[]
}
export interface WorkerState {
  schema: 1
  revision: number
  boards: Record<string, BoardRecord>
  // Error fingerprints survive service restarts. A successful pass removes its fingerprint, so
  // the same failure is reported again if it returns after a recovery.
  reports?: Record<string, string>
}

export interface HandBackResult { ok: boolean; note: string }
export type StrictHandBack = (
  repo: string,
  number: number,
  reason: string,
  restoreTo: State,
  interrupt: Interrupt,
) => Promise<HandBackResult> | HandBackResult

export interface ReconcileResult {
  active: BoardContext[]
  removed: string[]
  unavailable: Array<{ repo: string; reason: string }>
}

const emptyWorkerState = (): WorkerState => ({ schema: 1, revision: 0, boards: {}, reports: {} })

const workerStates = new Set<State>(['waiting-on-operator', 'planning', 'queued', 'in-progress', 'ready-to-ship'])

function parseWorkerState(text: string, path: string): WorkerState {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top level is not an object')
    const raw = value as Record<string, unknown>
    if (Object.keys(raw).some((key) => !['schema', 'revision', 'boards', 'reports'].includes(key))) throw new Error('top level has an unknown field')
    if (raw.schema !== 1) throw new Error('schema is not 1')
    if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new Error('revision is not a non-negative integer')
    if (!raw.boards || typeof raw.boards !== 'object' || Array.isArray(raw.boards)) throw new Error('boards is not an object')
    if (!(raw.reports === undefined || (raw.reports && typeof raw.reports === 'object' && !Array.isArray(raw.reports)))) throw new Error('reports is not an object')
    for (const [key, value] of Object.entries(raw.boards as Record<string, unknown>)) {
      if (canonicalRepository(key) !== key) throw new Error(`board key is not canonical: ${JSON.stringify(key)}`)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`board ${key} is not an object`)
      const board = value as Partial<BoardRecord>
      if (Object.keys(value).some((field) => !['repo', 'state', 'pending'].includes(field))) throw new Error(`board ${key} has an unknown field`)
      if (board.repo !== key) throw new Error(`board ${key} has a different repository`)
      if (board.state !== 'active' && board.state !== 'dropping') throw new Error(`board ${key} has an invalid state`)
      if (!(board.pending === undefined || Array.isArray(board.pending))) throw new Error(`board ${key} pending is not an array`)
      const issues = new Set<number>()
      for (const pending of board.pending ?? []) {
        if (!pending || typeof pending !== 'object' || !Number.isSafeInteger(pending.issue) || pending.issue < 1
          || !workerStates.has(pending.from) || typeof pending.reason !== 'string' || !pending.reason.trim()) {
          throw new Error(`board ${key} has an invalid pending hand-back`)
        }
        if (Object.keys(pending).some((field) => !['issue', 'from', 'reason'].includes(field))) throw new Error(`board ${key} has an invalid pending hand-back field`)
        if (issues.has(pending.issue)) throw new Error(`board ${key} repeats pending issue ${pending.issue}`)
        issues.add(pending.issue)
      }
    }
    for (const [key, report] of Object.entries((raw.reports ?? {}) as Record<string, unknown>)) {
      if (!key || typeof report !== 'string') throw new Error(`report ${JSON.stringify(key)} is not a string`)
    }
    return raw as unknown as WorkerState
  } catch (error) {
    throw new Error(`${path} is malformed: ${(error as Error).message}`)
  }
}

function boardStatePaths(options: HomeOptions, create: boolean): { stateRoot: string; path: string } {
  const factoryRoot = factoryHome(options)
  const stateRoot = workerDirectory(options)
  const safe = safeGlobalStateRoot(factoryRoot, stateRoot, create)
  if (!safe.ok) throw new Error(safe.reason)
  return { stateRoot, path: workerBoardsPath(options) }
}

function readBoardStateFile(path: string): WorkerState {
  try {
    const info = lstatSync(path)
    const uid = process.getuid?.()
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is not a regular file`)
    if (uid !== undefined && info.uid !== uid) throw new Error(`${path} is owned by uid ${info.uid}`)
    return parseWorkerState(readFileSync(path, 'utf8'), path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorkerState()
    throw error
  }
}

export function readWorkerState(options: HomeOptions = {}): WorkerState {
  const factoryRoot = factoryHome(options)
  const stateRoot = workerDirectory(options)
  const safe = safeGlobalStateRoot(factoryRoot, stateRoot, false)
  if (!safe.ok) {
    // An absent store is an empty state, and observing it must not create either the store or a
    // lock. Unsafe existing ancestors remain refusals.
    if (safe.reason.includes('disappeared during migration')) return emptyWorkerState()
    throw new Error(safe.reason)
  }
  return readBoardStateFile(workerBoardsPath(options))
}

function writeWorkerState(options: HomeOptions, state: WorkerState, expectedRevision: number): WorkerState {
  // Validate the value before opening the state directory for mutation. This catches programming
  // errors with the same strict parser used on disk.
  parseWorkerState(JSON.stringify(state), workerBoardsPath(options))
  const paths = boardStatePaths(options, true)
  return withLock(paths.stateRoot, () => {
    boardStatePaths(options, false)
    try {
      const leaf = lstatSync(paths.path)
      const uid = process.getuid?.()
      if (!leaf.isFile() || leaf.isSymbolicLink()) throw new Error(`${paths.path} is not a regular file`)
      if (uid !== undefined && leaf.uid !== uid) throw new Error(`${paths.path} is owned by uid ${leaf.uid}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const current = readBoardStateFile(paths.path)
    if (current.revision !== expectedRevision) {
      throw new Error(`the worker board state changed concurrently (expected revision ${expectedRevision}, found ${current.revision})`)
    }
    const next = { ...state, revision: expectedRevision + 1 }
    replaceFile(paths.path, JSON.stringify(next, null, 2) + '\n')
    return next
  }, { what: 'the worker board state' })
}

export interface WorkerProblemReporter {
  report: (key: string, fingerprint: string, line: string) => void
  clear: (key: string) => void
}

// Polling is independent of roster reconciliation, but both mutate one machine record. Each
// report update therefore reads and writes under the shared lock and advances the same revision;
// a reconciliation holding a stale snapshot fails its CAS instead of erasing the newer report.
export function workerProblemReporter(options: HomeOptions, out: (text: string) => void): WorkerProblemReporter {
  const mutate = (change: (state: WorkerState) => boolean) => {
    const paths = boardStatePaths(options, true)
    withLock(paths.stateRoot, () => {
      boardStatePaths(options, false)
      const state = readBoardStateFile(paths.path)
      state.reports ??= {}
      if (!change(state)) return
      const next = { ...state, revision: state.revision + 1 }
      replaceFile(paths.path, JSON.stringify(next, null, 2) + '\n')
    }, { what: 'the worker board state' })
  }
  return {
    report: (key, fingerprint, line) => mutate((state) => {
      if (state.reports![key] === fingerprint) return false
      state.reports![key] = fingerprint
      out(line)
      return true
    }),
    clear: (key) => mutate((state) => {
      if (!(key in state.reports!)) return false
      delete state.reports![key]
      return true
    }),
  }
}

// Unattended work accepts repository identities, never organization-wide expansion. Canonical
// identity is also the stable-deduplication key, so case-only roster edits do not create a board.
export function normalizeWorkerRepos(values: string[]): { repos: string[]; refused: string[] } {
  const repos: string[] = []
  const refused: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const display = String(value ?? '').trim()
    let repo: string
    try {
      if (display === '*' || display.toLowerCase() === 'all') throw new Error('wildcards are not repositories')
      repo = canonicalRepository(display)
    } catch {
      refused.push(display)
      continue
    }
    if (seen.has(repo)) continue
    seen.add(repo)
    repos.push(repo)
  }
  return { repos, refused }
}

function pendingFor(record: BoardRecord, repo: string, inflight: Map<string, Inflight>, children: ChildRecord[]): PendingHandBack[] {
  const pending = new Map<number, PendingHandBack>()
  for (const item of record.pending ?? []) pending.set(item.issue, item)
  for (const run of inflight.values()) {
    if (canonicalRepository(run.candidate.repo) !== repo || run.settled) continue
    pending.set(run.candidate.number, {
      issue: run.candidate.number,
      from: run.candidate.from,
      reason: 'this repository was removed from the worker roster',
    })
  }
  for (const child of children) {
    if (canonicalRepository(child.repo) !== repo) continue
    pending.set(child.issue, {
      issue: child.issue,
      from: child.from,
      reason: 'this repository was removed from the worker roster',
    })
  }
  return [...pending.values()].sort((a, b) => a.issue - b.issue)
}

function forgetIssueChildren(stateRoot: string, repo: string, issue: number): void {
  writeChildren(stateRoot, (rows) => rows.filter((row) => canonicalRepository(row.repo) !== repo || row.issue !== issue))
}

// Refresh one roster without coupling board lifecycles. The state transition to `dropping`, and
// all pending issue metadata, land atomically before any child is signalled. That is the recovery
// boundary: after a crash the next process can retry the exact non-consuming hand-back.
export async function reconcileBoards(input: {
  home?: string
  env?: NodeJS.ProcessEnv
  listed: string[]
  previous: WorkerState
  contexts: Map<string, BoardContext>
  inflight: Map<string, Inflight>
  provision: (repo: string) => Promise<BoardContext>
  handBack: StrictHandBack
  out: (text: string) => void
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
  start?: ProcessStart
  alive?: ProcessAlive
}): Promise<ReconcileResult> {
  const homeOptions: HomeOptions = { home: input.home, env: input.env }
  // Refuse an unsafe global root before even reading children. Reconciliation may eventually
  // signal a child or remove its durable row, so a symlinked/foreign root cannot be observational.
  boardStatePaths(homeOptions, true)
  const normalized = normalizeWorkerRepos(input.listed)
  const wanted = new Set(normalized.repos)
  let state: WorkerState = JSON.parse(JSON.stringify(input.previous?.schema === 1 ? input.previous : emptyWorkerState()))
  state.boards ??= {}
  state.reports ??= {}
  const active: BoardContext[] = []
  const removed: string[] = []
  const unavailable: Array<{ repo: string; reason: string }> = []
  const stateRoot = workerDirectory(homeOptions)
  const children = readChildren(stateRoot)
  const currentReports = new Set<string>()
  const persist = () => { state = writeWorkerState(homeOptions, state, state.revision) }
  const report = (key: string, fingerprint: string, line: string) => {
    currentReports.add(key)
    if (state.reports![key] !== fingerprint) input.out(line)
    state.reports![key] = fingerprint
  }

  for (const refused of normalized.refused) {
    const key = `refused:${refused.toLowerCase()}`
    report(key, refused, `${refused}: refused (unattended workers require an explicit OWNER/NAME repository)`)
  }

  for (const repo of normalized.repos) {
    const existing = state.boards[repo]
    if (!existing) state.boards[repo] = { repo, state: 'active' }
  }
  for (const [repo, record] of Object.entries(state.boards)) {
    if (!wanted.has(repo) && record.state === 'active') {
      record.state = 'dropping'
      record.pending = pendingFor(record, repo, input.inflight, children)
    } else if (record.state === 'dropping') {
      record.pending = pendingFor(record, repo, input.inflight, children)
    }
  }
  // This write is deliberately before `stop()`: no signal may make the only hand-back metadata
  // transient.
  persist()

  for (const [repo, record] of Object.entries(state.boards)) {
    if (record.state !== 'dropping') continue
    const matching = [...input.inflight.values()].filter((run) => canonicalRepository(run.candidate.repo) === repo && !run.settled)
    for (const run of matching) {
      run.interrupt = {
        reason: 'this repository was removed from the worker roster', action: 'stop', trigger: null, consumes: false, deferHandBack: true,
      }
      run.stop()
    }

    if ((record.pending ?? []).length === 0) {
      if (wanted.has(repo)) state.boards[repo] = { repo, state: 'active' }
      else { delete state.boards[repo]; removed.push(repo) }
      continue
    }

    // Process identity is local evidence and needs no repository credential. Signal every child
    // that is still provably ours before provisioning: a removed board whose token or checkout is
    // broken must not leave its agent running simply because hand-back cannot start yet.
    const ready: PendingHandBack[] = []
    for (const pending of [...(record.pending ?? [])]) {
      if (matching.some((run) => run.candidate.number === pending.issue)) continue
      let processPending = false
      for (const child of children.filter((row) => canonicalRepository(row.repo) === repo && row.issue === pending.issue)) {
        const identity = processIdentity(child, input.start ?? processStart, input.alive ?? processAlive)
        if (identity === 'matching') { (input.stop ?? stopGroup)(child.pid, 'SIGTERM'); processPending = true }
        else if (identity === 'unknown') processPending = true
      }
      if (!processPending) ready.push(pending)
    }
    if (ready.length === 0) continue

    // Recreate the removed board's isolated credentials/policy only for rows now safe to hand
    // back. A failure retains both the board and its pending rows; healthy boards still proceed.
    try {
      if (!input.contexts.has(repo)) input.contexts.set(repo, await input.provision(repo))
      await input.contexts.get(repo)!.identity.freshen()
    } catch (error) {
      const reason = (error as Error).message
      unavailable.push({ repo, reason })
      report(`repo:${repo}`, reason, `${repo}: unavailable (${reason})`)
      continue
    }

    for (const pending of ready) {
      const interrupt: Interrupt = { reason: pending.reason, action: 'stop', trigger: null, consumes: false, deferHandBack: true }
      let result: HandBackResult
      try { result = await input.handBack(repo, pending.issue, pending.reason, pending.from, interrupt) }
      catch (error) { result = { ok: false, note: (error as Error).message } }
      if (!result.ok) {
        report(`handback:${repo}#${pending.issue}`, result.note, `${repo}#${pending.issue}: hand-back failed (${result.note})`)
        continue
      }
      record.pending = (record.pending ?? []).filter((item) => item.issue !== pending.issue)
      forgetIssueChildren(stateRoot, repo, pending.issue)
      delete state.reports![`handback:${repo}#${pending.issue}`]
      persist()
    }
    if ((record.pending ?? []).length) continue
    if (wanted.has(repo)) state.boards[repo] = { repo, state: 'active' }
    else {
      delete state.boards[repo]
      removed.push(repo)
    }
  }

  for (const repo of normalized.repos) {
    const record = state.boards[repo]
    if (!record || record.state !== 'active') continue
    try {
      const board = input.contexts.get(repo) ?? await input.provision(repo)
      input.contexts.set(repo, board)
      active.push(board)
      delete state.reports![`repo:${repo}`]
    } catch (error) {
      const reason = (error as Error).message
      unavailable.push({ repo, reason })
      report(`repo:${repo}`, reason, `${repo}: unavailable (${reason})`)
    }
  }
  for (const key of Object.keys(state.reports)) {
    if ((key.startsWith('repo:') || key.startsWith('refused:')) && !currentReports.has(key)) delete state.reports[key]
  }
  persist()
  return { active, removed, unavailable }
}

export interface PollDeps {
  stateRoot: string
  boards: BoardContext[]
  // This worker process, so its claims are its own and no other process reads them as such.
  runId: string
  // The machine's own limits, from its roster row, re-read every pass.
  caps?: Caps
  now: () => number
  runStep: RunStep
  out: (text: string) => void
  machine: string
  appActor?: string
  // Saves, pushes, releases and hands an issue back: the reason goes on the issue, and the state
  // label goes back to where the run picked it up.
  standDown: (repo: string, number: number, reason: string, restoreTo?: State) => string
  // How a started run is ended: its whole process group, so the tools it spawned go with it.
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
  // What the operating system says about a pid, which is half of a child's identity.
  start?: ProcessStart
  // Whether a pid exists when its start time cannot be read; null means the identity is unknown.
  alive?: ProcessAlive
  // An issue this pass knew had work and did not start: unreadable, or wanted but not reserved.
  // Those are deliberately swallowed so one bad issue does not cost the board its pass — but a
  // pass that left work behind has not shown the board is idle, and idle is the only state a
  // five-minute install may run in.
  onWaiting?: (repo: string, number: number, reason: string) => void
  // A board or issue could not be read. Kept separate from ordinary waiting (claim/no slot), so
  // JSON can report a degraded board without calling healthy scheduling pressure a failure.
  onUnreadable?: (repo: string, number: number, reason: string) => void
  // Persisted problem suppression. Task 5 wires this to `workerProblemReporter`; tests may inject
  // the same seam directly. Recovery clears the fingerprint so a later recurrence is reportable.
  reportProblem?: WorkerProblemReporter['report']
  clearProblem?: WorkerProblemReporter['clear']
}

// The steps this machine has started. It lives across polls, so the next pass two minutes later
// sees them, keeps their slots and can still act on the rest of the board. A finished run stays in
// the map until the next pass sweeps it, so nothing can disappear between starting and being read.
// `consumes` says whether the stop spends the trigger the run was working on. An operator's stop
// does: they asked for this, and it is their comment the record points at. An administrative stop
// — the machine de-listed, the service told to stop, a signal — does not: nothing about the issue
// changed, so the work has to look unstarted again or no machine ever picks it up.
export interface Interrupt { reason: string; action: Action; trigger: number | null; consumes: boolean; deferHandBack?: boolean }

export interface Inflight {
  candidate: Candidate
  started: number
  settled: boolean
  done: Promise<RunRecord>
  stop: () => void
  // Set before the run is stopped, so the record and the hand-back say why it ended rather than
  // reporting the kill as a failure of the work.
  interrupt: Interrupt | null
}
export const drain = (inflight: Map<string, Inflight>) => Promise.all([...inflight.values()].map((run) => run.done))

// One pass over the board: read what changed, decide, and start what is safe to start now. The
// steps run to their own end; this returns as soon as they are under way.
export async function poll(deps: PollDeps, inflight: Map<string, Inflight> = new Map()): Promise<Candidate[]> {
  const { now } = deps
  // Last pass's finished runs, whose outcomes are now in `acted`: their slots and issues are free.
  for (const [key, run] of inflight) if (run.settled) inflight.delete(key)
  const acted = readActed(deps.stateRoot)
  const wanted: Array<{ board: BoardContext; candidate: Candidate; decision: Decision; key: string }> = []
  for (const selected of deps.boards) {
    const { root, runner } = selected
    const repo = canonicalRepository(selected.key)
    if (canonicalRepository(selected.repo) !== repo) {
      deps.out(`${repo}: board context repository does not match its canonical key`)
      deps.onWaiting?.(repo, 0, 'board context repository does not match its canonical key')
      deps.onUnreadable?.(repo, 0, 'board context repository does not match its canonical key')
      continue
    }
    const permission = permissionLookup(repo, runner, { root })
    const trusted = trustedFactory({ repo, runner, root, appActor: deps.appActor })
    const plans = new Map<number, string | null>()
    let issues: GhIssue[]
    try {
      issues = board(repo, runner)
      deps.clearProblem?.(`board:${repo}`)
    } catch (error) {
      const reason = (error as Error).message
      const line = `${repo}: board could not be read (${reason})`
      if (deps.reportProblem) deps.reportProblem(`board:${repo}`, reason, line)
      else deps.out(line)
      deps.onWaiting?.(repo, 0, (error as Error).message)
      deps.onUnreadable?.(repo, 0, reason)
      continue
    }
    // One issue nobody can read must not cost its board or any sibling board the pass.
    for (const issue of issues) {
      try {
        syncIssue({ root, repo, number: issue.number, runner })
        const snap = snapshot(cacheDir(root, repo, issue.number))
        deps.clearProblem?.(`issue:${repo}#${issue.number}`)
        const key = runKey({ repo, number: issue.number })
        const held = !!holderOf(snap.state, snap.body, now(), trusted).holder
        const decision = decide(snap, permission, { acted: acted[key] ?? null, now: now(), held, failures: deps.caps?.failures, appActor: deps.appActor })
        if (decision.action === 'none') continue
        if (decision.action !== 'stop' && held) {
          deps.out(`${key}: skipped, a fresh claim holds it`)
          continue
        }
        if (decision.action === 'ship') {
          const confirmed = confirmShip({ root, repo, number: issue.number, runner, appActor: deps.appActor }, permission, { id: decision.trigger!, by: decision.by!, quote: decision.quote! })
          if (!confirmed.ok) {
            deps.out(`${key}: not shipping — ${confirmed.reason}`)
            recordRun(deps.stateRoot, { at: new Date(now()).toISOString(), repo, issue: issue.number, action: 'ship', outcome: 'blocked', ms: 0, machine: deps.machine, note: tail(confirmed.reason) })
            updateActed(deps.stateRoot, (saved) => { saved[key] = { at: now(), action: 'ship', outcome: 'blocked', trigger: decision.trigger, failures: 0, retryAt: null } })
            continue
          }
        }
        const parent = snap.state.issue!.parent
        if (parent !== null && !plans.has(parent)) plans.set(parent, parentPlan(root, repo, parent, runner, permission, deps.appActor))
        const files = parent === null ? [] : filesFromParent(plans.get(parent) ?? null, issue.number)
        wanted.push({ board: selected, key, decision, candidate: { repo, number: issue.number, action: decision.action, parent, files, from: stateOf(snap.state.issue!.labels).state! } })
      } catch (error) {
        const reason = (error as Error).message
        const line = `${repo}#${issue.number}: could not be read (${reason})`
        if (deps.reportProblem) deps.reportProblem(`issue:${repo}#${issue.number}`, reason, line)
        else deps.out(line)
        deps.onWaiting?.(repo, issue.number, reason)
        deps.onUnreadable?.(repo, issue.number, reason)
      }
    }
  }

  // An operator's stop for a run that is already going cannot wait for a slot: scheduling would
  // skip the issue because it is running, and no other machine may release the claim this one
  // holds. So it is handled first — the run is ended, and its own settle hands the issue back.
  const interrupted = new Set<string>()
  for (const item of wanted) {
    const key = runKey(item.candidate)
    const run = inflight.get(key)
    if (item.decision.action !== 'stop' || !run || run.settled) continue
    deps.out(`${key}: ${item.decision.reason} — stopping the ${run.candidate.action} run`)
    run.interrupt = { reason: item.decision.reason, action: 'stop', trigger: item.decision.trigger, consumes: true }
    run.stop()
    await run.done
    inflight.delete(key)
    interrupted.add(key)
  }

  const started: Candidate[] = []
  const queue = wanted.filter((item) => !interrupted.has(runKey(item.candidate)))
  for (const candidate of schedule(queue.map((item) => item.candidate), [...inflight.values()].map((run) => run.candidate), deps.caps?.runs ?? MAX_RUNS)) {
    const key = runKey(candidate)
    const item = queue.find((entry) => runKey(entry.candidate) === key)!
    const selected = item.board
    const at = now()
    // Taken before the slot, so a second machine on the same board sees the work is taken. Losing
    // the race is not a failure: the issue is simply someone else's this pass. A stop takes no
    // claim — it acts on an issue somebody *is* holding, which is the one case a claim would
    // refuse, and standing down is what releases that holder.
    const taken = candidate.action === 'stop'
      ? { ok: true, owner: '', reason: 'a stop takes no claim' }
      : reserve({ root: selected.root, repo: candidate.repo, number: candidate.number, runner: selected.runner, appActor: deps.appActor }, deps.machine, deps.runId, candidate.action, at)
    if (!taken.ok) {
      deps.out(`${key}: not started — ${taken.reason}`)
      // Known work this pass did not start. Another machine may have it, or the claim may have
      // failed — either way this board is not idle, and an idle board is what lets a five-minute
      // install begin.
      deps.onWaiting?.(candidate.repo, candidate.number, taken.reason)
      continue
    }
    const run: Inflight = { candidate, started: at, settled: false, stop: () => {}, interrupt: null, done: Promise.resolve() as unknown as Promise<RunRecord> }
    run.done = runOne(deps, selected, candidate, item, at, taken.owner, run).then((record) => { run.settled = true; return record })
    inflight.set(key, run)
    started.push(candidate)
  }
  // Wanted, but there was no slot for it this pass.
  for (const item of queue) {
    if (started.some((candidate) => runKey(candidate) === runKey(item.candidate))) continue
    if (interrupted.has(runKey(item.candidate))) continue
    deps.onWaiting?.(item.candidate.repo, item.candidate.number, 'no free slot this pass')
  }
  return started
}

// The claim a worker run takes before it starts, so another machine polling the same board
// sees the work is taken rather than starting it again. It is an App-authored `worker` claim,
// kept alive while the step runs and released on every way out.
//
// A step that runs an agent which claims for itself — dev-implement and its corrections path —
// hands the claim over instead: the rest of the workflow reads the session's own claim from inside
// its worktree, whose name this machine cannot know in advance. That hand-over is a seconds-wide
// window in which a second machine could start the same issue; closing it needs the fleet-wide
// lease that #3 tracks, not a longer claim here.
export const HANDS_OVER: Action[] = ['implement', 'corrections']

export interface Reservation { ok: boolean; owner: string; reason: string }

// The owner carries the *process*, not just the machine and the issue. Two workers on one host
// — the service and an operator running a pass by hand — would otherwise compute the same owner,
// each read it as its own claim, and both start the run.
export const ownerFor = (machine: string, runId: string, number: number) => `${machine}:worker-${runId}-${number}`

export function reserve(ctx: { root: string; repo: string; number: number; runner: GhRunner; appActor?: string }, machine: string, runId: string, action: Action, now = Date.now()): Reservation {
  const owner = ownerFor(machine, runId, ctx.number)
  try {
    const outcome = claim(ctx, { owner, kind: 'worker', harness: 'worker', model: action }, now)
    return { ok: outcome.ok, owner, reason: outcome.message }
  } catch (error) {
    return { ok: false, owner, reason: `the claim could not be taken: ${(error as Error).message}` }
  }
}

// One step and everything that follows it. Nothing here may reject: the loop does not await these
// promises, so a rejection nobody handles would take the whole worker down.
async function runOne(deps: PollDeps, selected: BoardContext, candidate: Candidate, item: { key: string; decision: Decision }, at: number, held: string | null, run: Inflight): Promise<RunRecord> {
  const claimCtx = { root: selected.root, repo: candidate.repo, number: candidate.number, runner: selected.runner, appActor: deps.appActor }
  // What the step started, filled in from its own callback, so the finally can forget it.
  const started: ChildRecord[] = []
  // While this machine holds the claim it says so, on the same schedule a session's hooks use.
  const beat = held ? setInterval(() => { try { heartbeat(claimCtx, held) } catch { /* a missed beat is not a failure */ } }, HEARTBEAT_EVERY_MS) : null
  beat?.unref?.()
  let result: StepResult
  try {
    if (candidate.action === 'stop') {
      // A stop needs no agent: it is this machine giving the issue back.
      result = { outcome: 'stopped', note: deps.standDown(candidate.repo, candidate.number, item.decision.reason, candidate.from), ms: 0 }
    } else {
      // The agent claims for itself from inside its own worktree, so this machine's reservation
      // steps aside first — holding both would stop the run it just started.
      if (held && HANDS_OVER.includes(candidate.action)) {
        if (beat) clearInterval(beat)
        try { release(claimCtx, held, deps.appActor ?? APP_ACTOR, 'handing the issue to the run this machine just started') } catch { /* the run still starts */ }
      }
      result = await deps.runStep({ action: candidate.action, number: candidate.number, repo: candidate.repo, split: item.decision.split, by: item.decision.by }, {
        root: selected.root,
        devMd: selected.devMd,
        token: selected.identity.token(),
        timeoutMs: deps.caps?.stepMs ?? STEP_TIMEOUT_MS,
        onStart: (pid, command) => {
          const record: ChildRecord = {
            repo: candidate.repo, pid, command, startedAt: (deps.start ?? processStart)(pid) ?? '', issue: candidate.number,
            action: candidate.action, owner: held, from: candidate.from,
          }
          started.push(record)
          run.stop = () => { stopChild(deps.stateRoot, record, { stop: deps.stop, start: deps.start, alive: deps.alive }) }
          try { noteChild(deps.stateRoot, record) } catch { /* the run still stops from here */ }
        },
      })
    }
  } catch (error) {
    result = { outcome: 'failed', note: (error as Error).message, ms: deps.now() - at }
  } finally {
    if (beat) clearInterval(beat)
    run.stop = () => {}
    // The record is the live set, so it goes the moment the run does.
    for (const record of started) { try { forgetChild(deps.stateRoot, record.pid) } catch { /* the next sweep drops it */ } }
  }
  // Whatever happened, this machine's own reservation goes back. A step that stood the issue down
  // has already released the session's claim; this releases the one taken before the launch.
  if (held && !HANDS_OVER.includes(candidate.action)) {
    try { release(claimCtx, held, deps.appActor ?? APP_ACTOR, `the ${candidate.action} run finished (${result.outcome})`) } catch { /* the record still lands */ }
  }
  // A run this machine stopped on purpose reports the reason it was stopped, not the exit code
  // that killing it produced.
  if (run.interrupt) result = { outcome: 'stopped', note: run.interrupt.reason, ms: result.ms }
  try {
    return settle(deps, candidate, item, at, result, run.interrupt, candidate.action === 'stop')
  } catch (error) {
    // The record could not be written down. Say so rather than dying, and let the next pass decide
    // again: without a saved outcome this trigger simply looks unacted-on.
    deps.out(`${runKey(candidate)} ${candidate.action} → ${result.outcome}, but the run could not be recorded: ${(error as Error).message}`)
    return { at: new Date(at).toISOString(), repo: candidate.repo, issue: candidate.number, action: candidate.action, outcome: result.outcome, ms: result.ms, machine: deps.machine, note: tail(result.note) }
  }
}

// What a finished step leaves behind: one bounded record, and what the next pass reads to know
// this trigger is spent. `acted` is re-read here, because another step may have settled meanwhile.
function settle(deps: PollDeps, candidate: Candidate, item: { key: string; decision: Decision }, at: number, result: StepResult,
  interrupt: Interrupt | null = null, alreadyHandedBack = false): RunRecord {
  // An interrupted run is recorded as what interrupted it: an operator's stop is a stop, and the
  // trigger it consumes is that operator's comment, not the run's own.
  const action = interrupt?.action ?? candidate.action
  const trigger = interrupt ? interrupt.trigger : item.decision.trigger
  const record: RunRecord = {
    at: new Date(at).toISOString(), repo: candidate.repo, issue: candidate.number, action,
    outcome: result.outcome, ms: result.ms, machine: deps.machine, note: tail(result.note),
  }
  recordRun(deps.stateRoot, record)
  const ended = deps.now()
  let retryAt: number | null = null
  let failuresNow = 0
  // A stop that was nothing to do with the issue spends nothing. The run is still recorded and the
  // issue still handed back, but `acted` is left exactly as the last real run left it — write a
  // spent trigger here and the restored issue looks already-done to the next pass and to every
  // other machine, which is how an administrative stop turns into an issue nobody ever picks up.
  if (interrupt && !interrupt.consumes) {
    deps.out(`${runKey({ repo: record.repo, number: record.issue })} ${record.action} → ${record.outcome}${record.note ? ` (${record.note})` : ''}`)
    if (result.outcome !== 'done' && !alreadyHandedBack && !interrupt.deferHandBack) {
      deps.standDown(candidate.repo, candidate.number, `${interrupt.reason}; this machine has saved and released the issue`, candidate.from)
    }
    return record
  }
  updateActed(deps.stateRoot, (acted) => {
    const previous = acted[item.key]
    const failed = result.outcome === 'failed' || result.outcome === 'killed'
    const failures = failed ? (previous && previous.action === action ? previous.failures : 0) + 1 : 0
    // The wait runs from the end of the run, not its start: a step that failed after twenty
    // minutes would otherwise be due again the moment it stopped.
    failuresNow = failures
    retryAt = failed ? ended + (deps.caps?.retryMs ?? RETRY_MS) * 2 ** (failures - 1) : result.outcome === 'limit' ? resetAt(result.note, ended) : null
    acted[item.key] = { at, action, outcome: result.outcome, trigger, failures, retryAt }
  })
  // Every run that did not finish hands the issue back the same way: the work is committed and
  // pushed, the claim released, the reason posted, and the state label put back where the run
  // found it — a failure that left the issue `in-progress` with nobody on it is a dead end. It
  // happens exactly once: a `stop` step has already done it, and an interrupted run does it here.
  if (result.outcome !== 'done' && !alreadyHandedBack) {
    // Only when there is a try left. A run that has spent them is parked, and saying it will try
    // again would be a promise the next poll refuses.
    const spent = failuresNow >= (deps.caps?.failures ?? MAX_FAILURES)
    const when = retryAt && !spent ? `, and tries again after ${new Date(retryAt).toISOString()}`
      : spent ? `, and has now failed ${failuresNow} times — it needs a person` : ''
    const why = interrupt ? interrupt.reason
      : result.outcome === 'limit' ? 'the subscription limit was reached'
        : `the ${candidate.action} run ${result.outcome === 'killed' ? 'ran past its time limit' : 'failed'}`
    deps.standDown(candidate.repo, candidate.number, `${why}; this machine has saved and released the issue${when}`, candidate.from)
  }
  deps.out(`${runKey({ repo: record.repo, number: record.issue })} ${record.action} → ${record.outcome}${record.note ? ` (${record.note})` : ''}`)
  return record
}

// The operator's word, recorded and read back the way the ship gate reads it. The worker
// relays the ack — an App may do that only by citing the person's own comment — and then asks
// `findValidAck` the same question `vegafactory issue check --for ship` asks. A relayed ack that
// does not validate ships nothing: the words on the page were never the gate, the ack is.
export interface ShipConfirmation { ok: boolean; reason: string }

export function confirmShip(ctx: { root: string; repo: string; number: number; runner: GhRunner; appActor?: string },
  permission: PermissionLookup, word: { id: number; by: string; quote: string }): ShipConfirmation {
  const read = () => {
    syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
    return snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
  }
  const verdict = (snap: Snapshot) => {
    const evidence = latestArtifact(snap, 'evidence', permission, ctx.appActor)
    if (!evidence) return { ok: false, reason: 'the evidence comment went away' }
    const ack = findValidAck(snap, 'ship', permission, evidenceChangedAt(evidence))
    return { ok: ack.ok, reason: ack.reason }
  }
  return locked(ctx, () => {
    const before = verdict(read())
    if (before.ok) return before
    const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
    const hashes = currentHashes(snap)
    postComment(ctx, ackBody({ stage: 'ship', by: word.by, brief: hashes.brief, plan: hashes.plan, source: `comment:${word.id}`, quote: word.quote }))
    return verdict(read())
  })
}

// The plan that may authorise two agents to run at once. Three things have to hold, and each one
// on its own is the difference between a permission and a sentence someone wrote: the operator
// acked *this* plan (the ack carries its hash), the plan passes the full lint that owns this
// grammar, and it was posted by someone with write access or by the factory's own App. A forged,
// stale, unacked or malformed plan authorises nothing, so its siblings run one at a time.
export function acknowledgedPlan(snap: Snapshot, permission: PermissionLookup, appActor?: string): { text: string | null; reason: string } {
  const ack = findValidAck(snap, 'plan', permission)
  if (!ack.ok || !ack.ack) return { text: null, reason: `the plan is not acked (${ack.reason})` }
  const acked = markerKeys(snap.body(ack.ack)).plan
  if (!acked) return { text: null, reason: 'the plan ack names no plan hash' }
  const plan = Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'plan' && fromFactory(permission, appActor)(entry) && artifactHash(snap.body(entry)) === acked)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1)
  if (!plan) return { text: null, reason: 'no plan comment matches the acked hash' }
  const text = snap.body(plan)
  const lint = lintPlan(text) as { blocks: string[] }
  if (lint.blocks.length) return { text: null, reason: `the acked plan does not pass plan-lint: ${lint.blocks[0]}` }
  return { text, reason: 'the acked plan' }
}

// The parent epic's acknowledged plan, where sibling file sets are declared.
function parentPlan(root: string, repo: string, parent: number, runner: GhRunner, permission: PermissionLookup, appActor?: string): string | null {
  try {
    syncIssue({ root, repo, number: parent, runner })
    return acknowledgedPlan(snapshot(cacheDir(root, repo, parent)), permission, appActor).text
  } catch { return null }
}

// Giving an issue up: commit and push whatever the worktree holds, then release the claim the run
// took, with a note. Nothing is forced, and a rejected push leaves the commit local for a person.
// Only a claim held by this machine is released: another machine's claim is not ours to drop.
export interface StandDownContext {
  root: string
  repo: string
  number: number
  runner: GhRunner
  machine: string
  appActor?: string
  now?: number
  // Where the state label goes back to, when a run left the issue in-progress.
  restoreTo?: State
  // The selected board's installation token is the dedicated worker account's only Git
  // credential. Tests may inject Git itself; production never falls back to ambient auth.
  token?: string | null
  git?: Git
}

// The branch a stand-down may touch, or why it may not. The directory alone proves nothing: a
// parked worktree left on the default branch, or one for another issue, must never be committed
// to or pushed just because it happens to sit at `.vegastack/.worktrees/<n>-…`.
export function pushableBranch(dir: string, number: number, git: Git): { branch: string | null; refusal: string | null } {
  const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (head.status !== 0 || !head.out) return { branch: null, refusal: 'the worktree is on a detached head, so nothing was committed or pushed' }
  const branch = head.out
  // The default branch first: it is the answer the operator most needs to see, and `main` fails
  // the issue-name check too, so checking it second would hide it behind a vaguer message.
  const fallback = defaultBranch(dir)
  if (fallback && branch === fallback) return { branch: null, refusal: `the worktree is on the default branch ${branch}, so nothing was committed or pushed` }
  if (issueFromBranch(branch) !== number) return { branch: null, refusal: `the worktree is on ${branch}, which does not name #${number}, so nothing was committed or pushed` }
  return { branch, refusal: null }
}

type Git = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => { status: number | null; out: string }

// Giving an issue up: release the claim this run took, save and push its branch, say why on the
// issue, and put the state label back. The claim is checked *first* — a worktree this machine no
// longer owns is not ours to commit in — and the branch is checked before any write.
export function standDownStrict(ctx: StandDownContext, reason: string): HandBackResult {
  const claimCtx = { root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner, appActor: ctx.appActor }
  const notes: string[] = []
  let ok = true
  // Who holds the issue, as three answers and not two: ours to finish, somebody else's to leave
  // alone, or unknown. Only the first two are safe, and they are safe for different reasons.
  let whose: 'ours' | 'free' | 'theirs' | 'unreadable' = 'unreadable'
  let owner: string | null = null
  try {
    syncIssue({ ...claimCtx })
    const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
    const held = holderOf(snap.state, snap.body, ctx.now ?? Date.now(), trustedFactory(claimCtx)).holder
    if (!held) { whose = 'free'; notes.push('no live claim to release') }
    else if (!held.owner.startsWith(`${ctx.machine}:`)) { whose = 'theirs'; ok = false; notes.push(`the claim is held by ${held.owner}, so nothing here was touched and the state label was left alone`) }
    else { whose = 'ours'; owner = held.owner }
  } catch (error) {
    ok = false
    notes.push(`the claim could not be read (${(error as Error).message}), so nothing here was touched and the state label was left alone`)
  }

  // Only a claim this machine holds authorises writing to its worktree, and a claim that could not
  // be read is not one. With no live claim at all the work is still this machine's to save: it is
  // the run we just started that left it there.
  const dir = whose === 'ours' || whose === 'free' ? workingDir(ctx.root, ctx.number) : null
  if (dir) {
    const git: Git = ctx.git ?? ((args, options) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000, env: options?.env })
      return { status: result.status, out: (result.stdout ?? '').trim() }
    })
    const { branch, refusal } = pushableBranch(dir, ctx.number, git)
    if (refusal) { ok = false; notes.push(refusal) }
    else {
      if (git(['status', '--porcelain']).out) {
        const staged = git(['add', '--all']).status === 0
        if (!staged) {
          ok = false
          notes.push('the open work could not be staged')
        } else {
          const committed = git(['commit', '--quiet', '-m', `wip: #${ctx.number} saved before standing down`]).status === 0
          if (!committed) ok = false
          notes.push(committed ? 'committed the open work' : 'the open work could not be committed')
        }
      }
      if (!ok) notes.push(`the push of ${branch} was not attempted because the open work was not saved`)
      else {
        const pushed = git(['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`], { env: appGitEnvironment(process.env, ctx.token ?? null) }).status === 0
        if (!pushed) ok = false
        notes.push(pushed ? `pushed ${branch}` : `the push of ${branch} was rejected, so the commit stays local`)
      }
    }
  }

  if (whose === 'ours' && owner) {
    try {
      release(claimCtx, owner, ctx.appActor ?? APP_ACTOR, reason)
      notes.push(`released ${owner}`)
    } catch (error) { ok = false; notes.push(`the claim could not be released: ${(error as Error).message}`) }
  }

  const note = `${reason} — ${notes.join(', ')}`
  // The issue says what happened and goes back to a state a later pass can pick up. Both are
  // best-effort: a stand-down that cannot reach GitHub still reports what it did locally.
  try {
    postComment(claimCtx, `<!-- vsk:v1 type=standdown -->\n**${ctx.machine}** stood down from #${ctx.number}: ${note}\n`)
  } catch (error) { ok = false; notes.push(`the hand-back comment failed: ${(error as Error).message}`) }
  if (ctx.restoreTo && (whose === 'ours' || whose === 'free')) {
    try {
      syncIssue({ ...claimCtx })
      // Read again, here. The check above happened before this run saved, pushed and released,
      // which is long enough for another machine to have claimed the issue — and moving one out
      // of `in-progress` while somebody is working it is worse than leaving it where it is.
      const now = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
      const taken = holderOf(now.state, now.body, ctx.now ?? Date.now(), trustedFactory(claimCtx)).holder
      if (taken && !taken.owner.startsWith(`${ctx.machine}:`)) {
        ok = false
        notes.push(`${taken.owner} claimed it meanwhile, so the state label was left alone`)
        return { ok, note: `${reason} — ${notes.join(', ')}` }
      }
      const labels = readState(cacheDir(ctx.root, ctx.repo, ctx.number))!.issue!.labels
      if (stateOf(labels).state === 'in-progress' && ctx.restoreTo !== 'in-progress') {
        setLabels(claimCtx, nextLabels(labels, { state: ctx.restoreTo }))
        notes.push(`put it back to ${ctx.restoreTo}`)
      }
    } catch (error) { ok = false; notes.push(`the state label could not be put back: ${(error as Error).message}`) }
  }
  return { ok, note: `${reason} — ${notes.join(', ')}` }
}

// Existing attended/step output stays a string. Lifecycle reconciliation uses the structured
// form above so an incomplete release/comment/restore can never be mistaken for success.
export function standDown(ctx: StandDownContext, reason: string): string {
  return standDownStrict(ctx, reason).note
}

// ---------------------------------------------------------------------------------------------
// CLI

export function workerUsage(): string {
  return `Usage: vegafactory worker <enable|disable|status|run> [options]

  enable                 check this machine and every configured explicit board are ready — the
                         node listed, harnesses answering, and each board's App identity, checkout,
                         hooks, policy and push path usable — then install the one machine unit
  disable                remove the unit; the machine stops picking work up
  status                 every configured or persisted board, plus this machine's recent runs
  run [--once]           the poll loop itself (the unit runs this); --once makes a single pass
                         and is the only form --json reports, because the document answers when
                         a pass ends

One ship at a time per repository (different repositories may ship together), and as many runs
across the whole machine as its roster row allows. The row's
caps cell sets them — \`runs 10 · step 72h · poll 1m · retry 15m · park 3\`, in any order, every
field optional and separated by \`·\` or a comma. \`runs\` and \`park\` take a count; \`step\` takes
minutes or hours, \`poll\` seconds or minutes, \`retry\` minutes. A field that is present and
unreadable refuses the machine rather than being guessed at. With no caps cell the defaults are
${MAX_RUNS} runs, step ${STEP_TIMEOUT_MS / 60_000}m, poll ${POLL_MS / 60_000}m, retry ${RETRY_MS / 60_000}m, park ${MAX_FAILURES}. The caps are re-read from the refreshed roster
every pass, so changing one is a control-room PR that lands on the next poll, not a release.

Two machines on one board each get their own machine-wide caps, and each keeps its own retry and
subscription-reset deadlines. A run takes the issue's claim before it starts, so another machine's
poll sees the work is taken, except in the seconds an implement run hands that claim to the
session it starts.

Options: --repo OWNER/NAME · --json · --dry-run (enable and disable show what they would do)

The roster's table names its columns in a header row — \`| node | owner | worker | repos | caps |\`,
in any order, extra columns ignored — so a cell is read by what its column is called. A node is
\`<os-user>@<hostname>\`, derived and never configured. \`worker\` is the gate and the only cell that
grants anything: \`yes\` lets this machine work a board unattended, and anything else — including an
empty cell, a heading that only nearly says \`worker\`, and a roster with no such column — grants
nothing. The \`repos\` cell accepts explicit \`OWNER/NAME\` entries only; an empty cell, \`*\`, and
\`all\` authorise no unattended repository and are reported as refusals.

A machine the control room's nodes.md does not name refuses every verb but disable. Writes
go out as the VegaFactory GitHub App, on separate repository-scoped hour-long tokens minted here from its private key:
  ${appKeyPath()}
(VEGAFACTORY_APP_PRIVATE_KEY_FILE moves it; VEGAFACTORY_APP_ID and VEGAFACTORY_APP_ACTOR name
another App and must be set together.) Each run gets only its board's token, so everything it
posts is the App's and none of it can pass as a person's word; it
is never given the key itself. The runs think on the operator's own subscription, so an API-key
variable in the environment refuses the command.
`
}

interface Args { verb: string; flags: Record<string, string>; json: boolean; dryRun: boolean; once: boolean }

export function parseWorkerArgs(argv: string[]): Args {
  const [verb, ...rest] = argv
  if (!verb) throw new Error('missing verb — run vegafactory worker --help')
  if (!['enable', 'disable', 'status', 'run'].includes(verb)) throw new Error(`unknown worker verb: ${verb} — run vegafactory worker --help`)
  const flags: Record<string, string> = {}
  let json = false
  let dryRun = false
  let once = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--json') { json = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--once') { once = true; continue }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    if (arg !== '--repo') throw new Error(`unknown worker option: ${arg}`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    flags[arg.slice(2)] = value
    i++
  }
  if (once && verb !== 'run') throw new Error('--once is only valid with worker run')
  if (dryRun && !['enable', 'disable'].includes(verb)) throw new Error('--dry-run is only valid with worker enable or disable')
  return { verb, flags, json, dryRun, once }
}

export interface CliDeps {
  cwd?: string
  out?: (text: string) => void
  runner?: GhRunner
  run?: Probe
  env?: NodeJS.ProcessEnv
  home?: string
  host?: string
  platform?: NodeJS.Platform
  fetch?: Fetch
  runStep?: RunStep
  git?: (clone: string) => GitRun
  rosterGit?: (clone: string, env: NodeJS.ProcessEnv) => GitRun
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
  start?: ProcessStart
  alive?: ProcessAlive
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  cli?: string[]
  update?: () => Promise<UpdateResult>
  // Test seam for the repository boundary. Production always provisions a repository-scoped
  // App identity and worker-owned checkout through `ensureWorkerCheckout`.
  provisionBoard?: (repo: string) => Promise<BoardContext>
  ensureCheckout?: typeof ensureWorkerCheckout
  runnerForBoard?: (repo: string, identity: AppIdentity) => GhRunner
}

const wait = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  // A shutdown must not be held up by a two-minute sleep nobody is waiting for any more.
  timer.unref?.()
})

export async function runWorker(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0]!)) { out(workerUsage()); return 0 }
  const host = deps.host ?? hostname()
  const machine = machineName(host)
  const rawJson = argv.includes('--json')
  const runJson = rawJson && !['enable', 'disable', 'status'].includes(argv[0]!)
  const emitRunJson = (notes: string[], boards: Array<{ repo: string; ok: boolean; reason?: string }> = [], runs: RunRecord[] = []) => {
    out(JSON.stringify({ machine, runs, boards, notes }, null, 2))
  }
  const emitBootstrapRefusal = (reason: string) => {
    if (runJson) emitRunJson([`refused: ${reason}`])
    else out(JSON.stringify({ ok: false, machine, reason }, null, 2))
  }
  let args: Args
  try { args = parseWorkerArgs(argv) }
  catch (error) {
    if (rawJson) { emitBootstrapRefusal((error as Error).message); return 2 }
    throw error
  }
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const homeOptions = { home, env }
  let factoryRoot: string
  let stateRoot: string
  const platform = deps.platform ?? process.platform
  let root: string
  let repo: string
  try {
    factoryRoot = factoryHome(homeOptions)
    stateRoot = workerDirectory(homeOptions)
    root = repoRoot(cwd)
    repo = assertRepo(args.flags.repo ?? detectRepo(root))
  } catch (error) {
    if (rawJson) { emitBootstrapRefusal((error as Error).message); return 2 }
    throw error
  }
  const keyPath = appKeyPath(env, home)
  const runDocument = (notes: string[], boards: Array<{ repo: string; ok: boolean; reason?: string }> = [], runs: RunRecord[] = []) => ({ machine, runs, boards, notes })
  const print = (value: unknown, text: string) => {
    if (runJson) out(JSON.stringify(runDocument([text]), null, 2))
    else out(args.json ? JSON.stringify(value, null, 2) : text)
  }

  // Refuse paid API credentials before even the control-room fetch. Acting and status verbs use
  // the App as their sole GitHub identity; injected runners remain the explicit unit-test seam.
  const STARTS_AGENTS = ['enable', 'run']
  if (STARTS_AGENTS.includes(args.verb)) {
    const billing = billingVariables(env)
    if (billing.length) {
      const [is, them] = billing.length === 1 ? ['is', 'it'] : ['are', 'them']
      print({ ok: false, billing }, `refused: ${billing.join(', ')} ${is} set — VegaFactory runs Claude Code and Codex on their subscriptions only; unset ${them} and retry`)
      return 2
    }
  }
  let app = { appId: APP_ID, appActor: APP_ACTOR }
  if (STARTS_AGENTS.includes(args.verb) || (args.verb === 'status' && !deps.runner)) {
    try { app = appIdentityConfig(env) } catch (error) {
      print({ ok: false, reason: (error as Error).message }, `refused: ${(error as Error).message}`)
      return 2
    }
  }
  let rosterIdentity: AppIdentity | null = null
  const freshListing = async (): Promise<Listing> => {
    if (deps.git) return verifiedListing(root, { repo, host, home, env, git: deps.git })
    const room = controlRoomClone(root, homeOptions)
    if (!room) return listedHere(root, { repo, host, home, env })
    rosterIdentity ??= appIdentity({ repo: room.repo, keyPath, appId: app.appId, fetch: deps.fetch })
    await rosterIdentity.freshen(deps.now?.())
    const token = rosterIdentity.token()
    return verifiedListing(root, {
      repo, host, home, env,
      git: clone => (deps.rosterGit ?? gitIn)(clone, appGitEnvironment(env, token)),
    })
  }
  // A verb that will act asks for a roster it has just proved; a read-only view shows what the
  // machine already has, so `status` still answers while the network is down.
  let listing: Listing
  try {
    listing = ['enable', 'run'].includes(args.verb)
      ? await freshListing()
      : listedHere(root, { repo, host, home, env })
  } catch (error) {
    if (rawJson) { emitBootstrapRefusal((error as Error).message); return 2 }
    throw error
  }
  // `--repo` locates the control room; it is not the sole board anymore. Once the row itself is
  // a valid worker row, its explicit repos cell is the authority and may legitimately no longer
  // contain the bootstrap repository used by an already-installed service.
  const workerListing = workerListingAllowed(listing, repo)
    ? { ...listing, ok: true, reason: `${machineName(host)} is listed in ${listing.file}` }
    : listing
  // That listing may have fast-forwarded the clone, and every gate below it can return before the
  // poll loop is ever reached. The record follows the clone here, once, so a run that stops for
  // billing or a missing key does not leave the profile unreadable behind it.
  if (listing.sha) await recordRoomSha(root, homeOptions, listing.sha)
  // The second gate: an unlisted machine does nothing but say so. `disable` is the exception, so a
  // machine taken off the roster can still take its own unit down.
  if (!workerListing.ok && args.verb !== 'disable') {
    print({ ok: false, machine, reason: workerListing.reason }, `refused: ${workerListing.reason}`)
    return 2
  }

  const configured = normalizeWorkerRepos(workerListing.entry?.repos ?? [])

  if (args.verb === 'run' && args.json && !args.once) {
    print({ ok: false, reason: '--json reports one pass; use it with --once' },
      'refused: --json reports one pass and answers when that pass ends — add --once, or drop --json and read the lines the loop prints')
    return 2
  }

  const provisionBoard = async (selectedRepo: string): Promise<BoardContext> => {
    const canonical = canonicalRepository(selectedRepo)
    if (deps.provisionBoard) return deps.provisionBoard(canonical)
    // Injected runners are the public test boundary used by the existing single-repository CLI
    // suite. Production never takes this branch; it owns and provisions every checkout below.
    if (deps.runner) {
      if (canonical !== canonicalRepository(repo)) throw new Error(`${canonical} has no injected board context`)
      let devMd = ''
      try { devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8') }
      catch { throw new Error('dev.md is unreadable') }
      const identity: AppIdentity = { runner: deps.runner, freshen: async () => {}, token: () => null }
      return { key: canonical, repo: canonical, root, identity, runner: deps.runner, devMd }
    }
    const identity = appIdentity({ repo: canonical, keyPath, appId: app.appId, fetch: deps.fetch })
    await identity.freshen(deps.now?.())
    const checkout = await (deps.ensureCheckout ?? ensureWorkerCheckout)({ repo: canonical, home, token: identity.token()!, env })
    if (!checkout.ok) throw new Error(checkout.reason)
    let devMd: string
    try { devMd = readFileSync(join(checkout.root, '.vegastack', 'dev.md'), 'utf8') }
    catch { throw new Error('dev.md is unreadable') }
    const push = pushPath(checkout.root, deps.run ?? probe, identity.token())
    if (!push.ok) throw new Error(push.detail)
    const runner = deps.runnerForBoard?.(canonical, identity) ?? identity.runner
    return { key: canonical, repo: canonical, root: checkout.root, identity: { ...identity, runner }, runner, devMd }
  }

  const previewBoard = async (selectedRepo: string): Promise<string> => {
    const canonical = canonicalRepository(selectedRepo)
    const identity = appIdentity({ repo: canonical, keyPath, appId: app.appId, fetch: deps.fetch })
    await identity.freshen(deps.now?.())
    const checkout = await (deps.ensureCheckout ?? ensureWorkerCheckout)({ repo: canonical, home, token: identity.token()!, env, dryRun: true })
    if (!checkout.ok) throw new Error(checkout.reason)
    if (checkout.created) return `${checkout.root} would be provisioned with isolated App identity, policy, hooks, and push path`
    try { readFileSync(join(checkout.root, '.vegastack', 'dev.md'), 'utf8') }
    catch { throw new Error('dev.md is unreadable') }
    const push = pushPath(checkout.root, deps.run ?? probe, identity.token())
    if (!push.ok) throw new Error(push.detail)
    return checkout.plannedHooks?.length
      ? `${checkout.root} passed read-only checks; ${checkout.plannedHooks.join(', ')} would be merged only by the real enable`
      : `${checkout.root} passed read-only checks; hook wiring is already complete`
  }

  if (args.verb === 'run') {
    const inspection = inspectLegacyWorkerState({ root, stateRoot, factoryRoot, repo })
    if (!inspection.ok || inspection.migrationNeeded) {
      const reason = inspection.ok
        ? 'legacy worker state needs a stopped-service migration — run `vegafactory worker enable` from an attended shell'
        : inspection.reason
      print({ ok: false, reason }, `refused: ${reason}`)
      return 2
    }
  }

  switch (args.verb) {
    case 'enable': {
      let checks: Check[]
      let boardChecks: Check[] = []
      if (deps.runner) {
        // The injected single-board boundary preserves the focused CLI tests without teaching a
        // fake GitHub runner how to clone repositories. Real enablement takes the branch below.
        let keyOk = false
        let token: string | null = null
        let keyDetail = ''
        try {
          token = (await mintToken({ repo, keyPath, appId: app.appId, fetch: deps.fetch })).token
          keyOk = true
          keyDetail = `the App key at ${keyPath} mints an installation token for ${repo}`
        } catch (error) { keyDetail = (error as Error).message }
        checks = readiness({ root, listing: workerListing, run: deps.run ?? probe, token, keyOk, keyDetail, env })
        boardChecks = [{ name: `repo:${canonicalRepository(repo)}`, ok: checks.every((check) => check.ok), detail: keyDetail }]
      } else {
        const billing = billingVariables(env)
        checks = [
          { name: 'listed', ok: workerListing.ok, detail: workerListing.reason },
          { name: 'billing', ok: billing.length === 0, detail: billing.length ? `${billing.join(', ')} set — a worker runs on subscriptions only; unset them` : 'no API-key variable is set' },
          ...harnessAnswers(deps.run ?? probe),
        ]
        for (const refused of configured.refused) boardChecks.push({ name: `repo:${refused}`, ok: false, detail: 'unattended workers require an explicit OWNER/NAME repository' })
        for (const boardRepo of configured.repos) {
          try {
            const detail = args.dryRun
              ? await previewBoard(boardRepo)
              : `${(await provisionBoard(boardRepo)).root} is provisioned with isolated App identity, policy, hooks, and push path`
            boardChecks.push({ name: `repo:${boardRepo}`, ok: true, detail })
          } catch (error) {
            boardChecks.push({ name: `repo:${boardRepo}`, ok: false, detail: (error as Error).message })
          }
        }
      }
      const path = unitPath(platform, home)
      const allChecks = [...checks, ...boardChecks]
      const globallyReady = checks.every((check) => check.ok)
      const healthyBoards = boardChecks.filter((check) => check.ok).length
      if (!globallyReady || healthyBoards === 0) {
        print({ ok: false, checks: allChecks, boards: boardChecks }, `${renderChecks(allChecks)}\n\nnot ready — fix the global FAIL lines and make at least one explicit repository healthy, then run this again`)
        return 2
      }
      // Before the dry run, not after it: a dry run exists to say what the real command would do,
      // and the real command refuses this.
      const unwritable = unwritableForUnit({ ...env, VEGAFACTORY_HOME: factoryRoot })
      if (unwritable) {
        print({ ok: false, reason: unwritable }, `refused: ${unwritable}`)
        return 2
      }
      const commands = serviceCommands(platform, path, 'enable', userInfo().uid, platform !== 'darwin' && alreadyLingering(deps.run ?? probe, userInfo().uid))
      if (args.dryRun) {
        print({ ok: true, checks: allChecks, boards: boardChecks, unit: path, dryRun: true }, `${renderChecks(allChecks)}\n\ndry run: would ${commands.map((command) => command.join(' ')).join(' && ')}, rotate private worker storage while stopped, then write ${path} before loading it`)
        return 0
      }
      const run = deps.run ?? probe
      const stopIndex = commands.findIndex((command) => (command[0] === 'launchctl' && command[1] === 'bootout')
        || (command[0] === 'systemctl' && command.includes('stop')))
      if (stopIndex < 0) throw new Error('worker enable has no service-stop boundary')
      for (const command of commands.slice(0, stopIndex + 1)) {
        const result = run(command[0]!, command.slice(1))
        const unloading = command[1] === 'bootout' || command.includes('stop')
        const nothingToUnload = /no such process|not (?:loaded|find|exist)|not loaded/i.test(result.stderr)
        if (result.code !== 0 && !(unloading && nothingToUnload)) {
          print({ ok: false, unit: path, failed: command.join(' '), detail: result.stderr },
            `refused before worker storage or ${path} changed: \`${command.join(' ')}\` failed: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`)
          return 1
        }
      }
      const storage = prepareWorkerStorage({ root, stateRoot, factoryRoot, repo, serviceStopped: true, start: deps.start, alive: deps.alive })
      if (!storage.ok) {
        print({ ok: false, unit: path, reason: storage.reason }, `the worker service is stopped, but its storage was not changed safely: ${storage.reason}`)
        return 1
      }
      replaceFile(path, unitText(platform, { cli: deps.cli ?? cliPath(), root, repo, logDir: stateRoot, factoryHome: factoryRoot, env }))
      for (const command of commands.slice(stopIndex + 1)) {
        const result = run(command[0]!, command.slice(1))
        if (result.code !== 0) {
          print({ ok: false, unit: path, failed: command.join(' '), detail: result.stderr },
            `wrote ${path}, but \`${command.join(' ')}\` failed: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`)
          return 1
        }
      }
      const enabledCaps = workerListing.entry?.caps ?? DEFAULT_CAPS
      print({ ok: true, checks: allChecks, boards: boardChecks, unit: path, caps: enabledCaps },
        `${renderChecks(allChecks)}\n\nenabled — ${path} is loaded; this machine polls ${configured.repos.join(', ') || 'no accepted repository'} every ${sayDuration(enabledCaps.pollMs, 'poll')}, ${enabledCaps.runs} runs at once across them`)
      return 0
    }
    case 'disable': {
      const path = unitPath(platform, home)
      const commands = serviceCommands(platform, path, 'disable')
      if (args.dryRun) {
        print({ dryRun: true, unit: path }, `dry run: would ${commands.map((command) => command.join(' ')).join(' && ')}, then delete ${path}`)
        return 0
      }
      const inspection = inspectLegacyWorkerState({ root, stateRoot, factoryRoot, repo })
      if (!inspection.ok) {
        print({ ok: false, unit: path, reason: inspection.reason }, `refused: worker records could not be validated before disable: ${inspection.reason}`)
        return 2
      }
      const run = deps.run ?? probe
      const problems: string[] = []
      for (const command of commands) {
        const result = run(command[0]!, command.slice(1))
        if (result.code !== 0 && !/no such|not (?:find|loaded|exist)/i.test(result.stderr)) {
          const reason = `${command.join(' ')}: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`
          print({ ok: false, unit: path, failed: command.join(' '), reason }, `refused: the worker service could not be unloaded; ${path} and every worker record were left in place: ${reason}`)
          return 1
        }
      }
      const migration = prepareWorkerStorage({ root, stateRoot, factoryRoot, repo, serviceStopped: true, start: deps.start, alive: deps.alive })
      if (!migration.ok) {
        print({ ok: false, unit: path, reason: migration.reason }, `the service is unloaded, but worker records could not be migrated; ${path} and every worker record were left in place: ${migration.reason}`)
        return 1
      }
      // Taking the unit away does not reach the agents it started: they were detached on purpose,
      // so the service could be restarted without killing a build. Disabling is not a restart.
      // Each record is proved to still be its own process before anything is signalled.
      const children = readChildren(stateRoot)
      const stopped = children.filter((record) => stopChild(stateRoot, record, { stop: deps.stop, start: deps.start, alive: deps.alive }))
      const remaining = readChildren(stateRoot)
      if (remaining.length) problems.push(`${remaining.length} child run${remaining.length === 1 ? '' : 's'} could not be stopped safely`)
      rmSync(path, { force: true })
      const ended = stopped.length ? ` and stopped ${stopped.length} run${stopped.length === 1 ? '' : 's'} it had started` : ''
      // The stopped runs held claims and left their issues in-progress. This process has no App
      // token of its own — `disable` has to work on a machine that has just been de-listed — so it
      // names them instead of pretending to have cleaned up.
      const unresolved = remaining
      const left = unresolved.length
        ? `\nThese issues need attention after disable:\n${unresolved.map((record) => `  ${record.repo}#${record.issue} (${record.action}${record.owner ? `, claimed by ${record.owner}` : ''}${remaining.includes(record) ? ', process could not be stopped safely' : ''})`).join('\n')}`
        : ''
      print({ ok: problems.length === 0, unit: path, problems, stopped, unresolved: remaining },
        (problems.length ? `removed ${path}${ended}, with: ${problems.join('; ')}` : `disabled — ${path} is unloaded and deleted${ended}`) + left)
      return problems.length ? 1 : 0
    }
    case 'status': {
      const runs = readRuns(stateRoot)
      let persisted: WorkerState
      try { persisted = readWorkerState(homeOptions) }
      catch (error) {
        const reason = (error as Error).message
        print({ ok: false, machine, reason }, `refused: ${reason}`)
        return 2
      }
      const repos = [...new Set([...configured.repos, ...Object.keys(persisted.boards)])]
      const boards: Array<{ repo: string; ok: boolean; state: string; issues: Array<{ number: number; title: string; url: string; state: State }>; reason?: string }> = []
      const unavailable: Array<{ repo: string; reason: string }> = configured.refused.map((name) => ({ repo: name, reason: 'unattended workers require an explicit OWNER/NAME repository' }))
      for (const boardRepo of repos) {
        const lifecycle = persisted.boards[boardRepo]?.state ?? (configured.repos.includes(boardRepo) ? 'configured' : 'persisted')
        try {
          let runner = deps.runner
          if (!runner) {
            const identity = appIdentity({ repo: boardRepo, keyPath, appId: app.appId, fetch: deps.fetch })
            await identity.freshen(deps.now?.())
            runner = deps.runnerForBoard?.(boardRepo, identity) ?? identity.runner
          }
          const issues = board(boardRepo, runner).map((issue) => ({
            number: issue.number, title: issue.title, url: issue.html_url,
            state: stateOf(issue.labels.map((label) => (typeof label === 'string' ? label : label.name))).state!,
          }))
          boards.push({ repo: boardRepo, ok: true, state: lifecycle, issues })
        } catch (error) {
          const reason = (error as Error).message
          boards.push({ repo: boardRepo, ok: false, state: lifecycle, issues: [], reason })
          unavailable.push({ repo: boardRepo, reason })
        }
      }
      const parked = Object.entries(readActed(stateRoot))
        .filter(([, entry]) => entry.failures >= (workerListing.entry?.caps ?? DEFAULT_CAPS).failures)
        .map(([key, entry]) => ({ repo: key.slice(0, key.indexOf('#')), issue: Number(key.slice(key.indexOf('#') + 1)), action: entry.action, failures: entry.failures }))
      const statusCaps = workerListing.entry?.caps ?? DEFAULT_CAPS
      const capsLine = `caps: ${statusCaps.runs} runs · step ${sayDuration(statusCaps.stepMs, 'step')} · poll ${sayDuration(statusCaps.pollMs, 'poll')} · retry ${sayDuration(statusCaps.retryMs, 'retry')} · park ${statusCaps.failures}`
      const boardLines = boards.flatMap((one) => {
        if (!one.ok) return [`${one.repo} · unavailable: ${one.reason}`]
        const byState = new Map<State, number[]>()
        for (const issue of one.issues) byState.set(issue.state, [...(byState.get(issue.state) ?? []), issue.number])
        return [`${one.repo} · ${one.state}`, ...[...byState].map(([state, issues]) => `  ${state.padEnd(18)} ${issues.map((issue) => `${one.repo}#${issue}`).join(' ')}`)]
      })
      print({ machine, caps: statusCaps, boards, runs, parked, unavailable }, [
        `${machine} · ${workerListing.ok ? 'listed as a worker' : workerListing.reason}`,
        ...(workerListing.ok ? [capsLine] : []),
        ...boardLines,
        ...unavailable.filter((one) => !boards.some((board) => board.repo === one.repo)).map((one) => `${one.repo} · refused: ${one.reason}`),
        ...(parked.length ? ['', `parked for a person: ${parked.map((row) => `${row.repo}#${row.issue} (${row.action} failed ${row.failures}×)`).join(', ')}`] : []),
        '',
        runs.length ? 'recent runs on this machine:' : 'no worker runs on this machine yet',
        ...runs.map((run) => `${run.at}  ${run.repo}#${run.issue} ${run.action.padEnd(12)} ${run.outcome.padEnd(8)} ${Math.round(run.ms / 1000)}s  ${run.note}`),
      ].join('\n'))
      return 0
    }
    case 'run': {
      // This process, named once: its claims carry it, and the lock below keeps it the only one.
      const runId = randomUUID().slice(0, 8)
      const lock = takeRunLock(stateRoot, runId, deps.start ?? processStart, deps.alive ?? processAlive)
      if (!lock.ok) {
        print({ ok: false, reason: lock.reason }, `refused: ${lock.reason}`)
        return 2
      }
      const update = deps.update ?? (() => maintainSelfUpdate({ mode: updateModeFor(root, home), home: { home }, now: Date.now() }))
      // `--json` puts exactly one document on stdout and nothing else, so every line this loop
      // would have printed is collected and leaves inside it. A caller that has to step over prose
      // to find the JSON is a caller that will one day step over the wrong line.
      //
      // That only works for a run that ends: an always-on loop would hold every line it ever
      // printed and emit them at shutdown, which is a leak and an answer nobody is waiting for.
      // So the document belongs to `--once`, and the service, which runs without `--json`, prints.
      const notes: string[] = []
      const note = (text: string) => { if (args.json) notes.push(text); else out(text) }
      let visibleBoards: Array<{ repo: string; ok: boolean; reason?: string }> = []
      const finish = (code: number, runs: RunRecord[]) => {
        if (args.json) out(JSON.stringify(runDocument(notes, visibleBoards, runs), null, 2))
        releaseRunLock(stateRoot, runId)
        return code
      }
      // The row that authorised this machine also says what it may do while working it.
      const caps = workerListing.entry!.caps!
      // Said once when it becomes true, not every pass: a roster edit that lengthens the step past
      // the token's hour is worth a line, and the same line every two minutes is worth nothing.
      let toldAboutStep = false
      const stepOutlivesToken = (limit: Caps) => {
        if (limit.stepMs <= TOKEN_LIFE_MS) { toldAboutStep = false; return }
        if (toldAboutStep) return
        toldAboutStep = true
        note(`note: step ${sayDuration(limit.stepMs, 'step')} is longer than the hour an installation token lives, so a run past that point can still work but can no longer write to GitHub — see #239`)
      }
      stepOutlivesToken(caps)
      // Counted per pass by `onWaiting`, which `poll` calls for every issue it left behind.
      let waiting = 0
      const unreadableFailures = new Map<string, string>()
      const contexts = new Map<string, BoardContext>()
      const recoveryContexts = new Map<string, BoardContext>()
      const reporter = workerProblemReporter(homeOptions, note)
      const pollDeps: PollDeps = {
        stateRoot, boards: [],
        machine, runId, caps, appActor: app.appActor, out: note, now: deps.now ?? Date.now,
        runStep: deps.runStep ?? defaultRunStep(env), stop: deps.stop, start: deps.start, alive: deps.alive,
        standDown: (boardRepo, number, reason, restoreTo) => {
          const key = canonicalRepository(boardRepo)
          const context = contexts.get(key) ?? recoveryContexts.get(key)
          if (!context) return `${reason} — ${boardRepo} is unavailable for hand-back`
          return standDown({ root: context.root, repo: context.repo, number, runner: context.runner, machine, appActor: app.appActor, restoreTo, token: context.identity.token() }, reason)
        },
        onWaiting: () => { waiting += 1 },
        onUnreadable: (boardRepo, _issue, reason) => unreadableFailures.set(canonicalRepository(boardRepo), reason),
        reportProblem: reporter.report,
        clearProblem: reporter.clear,
      }
      // Started steps outlive the pass that began them, so the next pass keeps their slots and
      // still acts on the rest of the board — a twenty-minute build does not stop the poll.
      const inflight = new Map<string, Inflight>()
      // Stopping means stopping: the agents this machine started are ended, their work saved and
      // their claims released. A worker that walked away leaving three agents writing to
      // GitHub would be worse than one that never started.
      const shutDown = async (why: string) => {
        for (const [key, run] of inflight) {
          if (run.settled) continue
          note(`${key} ${run.candidate.action} stopped: ${why}`)
          run.interrupt = { reason: why, action: run.candidate.action, trigger: null, consumes: false }
          run.stop()
        }
        // Every process group is ended and waited for before anything is written: each run's own
        // settle saves its work, releases its claim and puts its issue back, exactly once.
        return drain(inflight)
      }
      // A signal wakes the loop rather than waiting for the current sleep to run out: `launchctl
      // bootout` and Ctrl-C both mean now, and two minutes of agents writing to GitHub after the
      // operator asked them to stop is not stopping.
      let signalled: string | null = null
      let wake: (() => void) | null = null
      const onSignal = (signal: string) => {
        signalled ??= signal
        wake?.()
      }
      process.once('SIGINT', () => onSignal('SIGINT'))
      process.once('SIGTERM', () => onSignal('SIGTERM'))
      const untilNextPass = () => new Promise<void>((resolve) => {
        // A signal that arrived while the pass was still running has nothing to wake yet, so the
        // wait checks for it rather than starting and never being told.
        if (signalled) { resolve(); return }
        wake = () => { wake = null; resolve() }
        void (deps.sleep ?? wait)(pollDeps.caps?.pollMs ?? POLL_MS).then(() => { wake = null; resolve() })
      })
      for (;;) {
        if (signalled) {
          return finish(0, await shutDown(`this machine was asked to stop (${signalled})`))
        }
        // Whether this pass saw an idle board. A pass that threw, could not read an issue, or
        // started anything is not the pass to spend five minutes installing in.
        let idle = false
        let passFailed = false
        try {
          // The roster is the enrolment, so it is refreshed and re-read once per pass: a row
          // removed in a control-room PR stands this machine down at the next poll, with nothing
          // to log into, and a roster this machine cannot verify stops it just as firmly. One
          // reading, because two would each fetch and merge, and a second answer nobody acts on is
          // a gate that has been asked and ignored — the caps come off this same reading, so a
          // control-room PR that changes one lands on the next poll rather than on a restart.
          const still = await freshListing()
          // The clone moved whether or not the roster still lists this machine, and the record has
          // to follow it either way: a de-listed machine that later gets its row back would
          // otherwise find every profile read refused for a clone that is simply up to date.
          if (still.sha) await recordRoomSha(root, homeOptions, still.sha)
          const stillAllowed = workerListingAllowed(still, repo)
          if (!stillAllowed || !still.entry?.caps) {
            note(`stopping: ${still.reason}`)
            return finish(2, await shutDown('this machine is no longer listed'))
          }
          pollDeps.caps = still.entry.caps
          stepOutlivesToken(still.entry.caps)
          const previous = readWorkerState(homeOptions)
          // Active readiness is evidence for one pass only. Re-provisioning an existing checkout
          // is observational except for repairing hook wiring, and catches origin, hook, dev.md,
          // push-path, and credential drift before that board runs again. Dropping contexts stay
          // alive because they are the recovery capability for pending hand-backs.
          for (const boardRepo of contexts.keys()) {
            if (previous.boards[boardRepo]?.state !== 'dropping') {
              const context = contexts.get(boardRepo)!
              if ([...inflight.values()].some(run => !run.settled && canonicalRepository(run.candidate.repo) === boardRepo)) recoveryContexts.set(boardRepo, context)
              contexts.delete(boardRepo)
            }
          }
          const reconciled = await reconcileBoards({
            home, env, listed: still.entry.repos, previous, contexts, inflight,
            provision: provisionBoard,
            handBack: async (boardRepo, number, reason, restoreTo) => {
              const context = contexts.get(canonicalRepository(boardRepo)) ?? await provisionBoard(boardRepo)
              contexts.set(context.key, context)
              return standDownStrict({ root: context.root, repo: context.repo, number, runner: context.runner, machine, appActor: app.appActor, restoreTo, token: context.identity.token() }, reason)
            },
            out: note, stop: deps.stop, start: deps.start, alive: deps.alive,
          })
          const normalized = normalizeWorkerRepos(still.entry.repos)
          const unavailable = new Map(reconciled.unavailable.map((one) => [one.repo, one.reason]))
          const ready: BoardContext[] = []
          for (const context of reconciled.active) {
            try {
              await context.identity.freshen(deps.now?.())
              ready.push(context)
              reporter.clear(`repo:${context.repo}`)
            } catch (error) {
              const reason = (error as Error).message
              unavailable.set(context.repo, reason)
              reporter.report(`repo:${context.repo}`, reason, `${context.repo}: unavailable (${reason})`)
            }
          }
          pollDeps.boards = ready
          visibleBoards = [
            ...normalized.repos.map((boardRepo) => unavailable.has(boardRepo)
              ? { repo: boardRepo, ok: false, reason: unavailable.get(boardRepo)! }
              : { repo: boardRepo, ok: true }),
            ...normalized.refused.map((boardRepo) => ({ repo: boardRepo, ok: false, reason: 'unattended workers require an explicit OWNER/NAME repository' })),
          ]
          waiting = 0
          unreadableFailures.clear()
          const picked = await poll(pollDeps, inflight)
          for (const boardRepo of recoveryContexts.keys()) {
            if (![...inflight.values()].some(run => !run.settled && canonicalRepository(run.candidate.repo) === boardRepo)) recoveryContexts.delete(boardRepo)
          }
          if (unreadableFailures.size) visibleBoards = visibleBoards.map((board) => {
            const reason = unreadableFailures.get(board.repo)
            return reason ? { repo: board.repo, ok: false, reason } : board
          })
          for (const candidate of picked) note(`${canonicalRepository(candidate.repo)}#${candidate.number} ${candidate.action} started`)
          // Idle is a high bar on purpose, because the thing it permits takes five minutes: the
          // whole board was read, nothing was picked up, and nothing is still running. An issue
          // that could not be read might have been the one with work on it, and an issue that was
          // picked up may have settled again before this line.
          idle = waiting === 0 && picked.length === 0 && ![...inflight.values()].some(run => !run.settled)
        } catch (error) {
          passFailed = true
          note(`poll failed: ${(error as Error).message}`)
        }
        if (args.once) return finish(passFailed ? 2 : 0, await drain(inflight))
        // A global install can replace this process's entry file, so it runs only with no agent
        // alive. A successful update ends the old process; the service starts the new copy.
        // A run is unsettled from the moment it is started until its own completion handler
        // runs, so a run picked up in this very pass still counts as alive here — which is what
        // keeps an update from starting while the board has work. The registry check above it is
        // asked at most once an hour, so an idle box is not calling npm every couple of minutes.
        if (idle) {
          let result: UpdateResult
          try { result = await update() } catch { result = { action: 'failed', before: '', after: '', latest: null, message: 'vegafactory update failed; continuing with the installed copy' } }
          if (result.action === 'updated') {
            note(`${result.message}; restarting the worker`)
            return finish(0, await drain(inflight))
          }
          if (result.action === 'available' || result.action === 'failed') note(result.message)
        }
        await untilNextPass()
      }
    }
    default:
      throw new Error(`unknown worker verb: ${args.verb} — run vegafactory worker --help`)
  }
}

const cliPath = (): string[] => [process.execPath, process.argv[1] ?? 'vegafactory']

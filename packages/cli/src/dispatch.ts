// `vegafactory dispatch …` — the listed machine that works the board on its own.
//
// It refuses to run at all unless this machine is named in the control room's `nodes.md`,
// refreshed and verified before every pass: the roster is the enrolment, and removing a row is how
// a machine is stood down.
//
// Every write reaching GitHub from this machine — the dispatcher's own bookkeeping and everything
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
import { createSign, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join, posix } from 'node:path'
import { APP_ACTOR, HEARTBEAT_EVERY_MS, claim, heartbeat, holderOf, machineName, nodeId, release, trustedFactory } from './claim.ts'
import { defaultClonePath, factoryConfigPath, parseControlRoomKnob, readFactoryConfig } from './control-room.ts'
import { billingVariables, childEnvironment } from './env.ts'
import { GhError, defaultRunner, ghList, type GhResult, type GhRunner } from './gh.ts'
import { assertRepo, cacheDir, readState, replaceFile, syncIssue, withLock, type CommentEntry, type GhIssue, type IssueEntry } from './issue-cache.ts'
import {
  ackBody, artifactHash, currentHashes, detectRepo, evidenceChangedAt, findValidAck, locked, markerKeys, nextLabels, permissionLookup,
  postComment, repoRoot, setLabels, snapshot, type PermissionLookup, type Snapshot,
} from './issue.ts'
import { issueFromBranch } from './hook.ts'
import { defaultBranch } from './guard-rules.ts'
import { stateOf, type State } from './labels.ts'
import { lintPlan, normalizeGroupPath, parseIndependentGroups, sharedByEveryChild } from '../../../skills/dev/dev-plan/scripts/plan-lint.mjs'
import { appKeyPath as workerAppKey } from './home.ts'

// How often the board is read, how many steps run at once, and how long one step may take.
export const POLL_MS = 2 * 60_000
export const MAX_RUNS = 3
export const STEP_TIMEOUT_MS = 20 * 60_000
// A failed step waits this long before the next try, doubling each time, and is parked after three.
export const RETRY_MS = 15 * 60_000
export const MAX_FAILURES = 3
// What a run's own output contributes to its record; the output never reaches the issue.
export const MAX_NOTE = 400

export const SERVICE_NAME = 'com.vegastack.vegafactory.dispatch'

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
export interface Dispatcher { machine: string; operator: string | null; repos: string[]; caps: Caps | null; worker: boolean; problem: string | null }

// What a roster may call each column. A header maps a name to a position, so a row is read by what
// its columns are called rather than by where they happen to sit: a room may add, drop or reorder
// columns, and a notes column is never mistaken for caps.
const COLUMN_NAMES = {
  machine: ['machine', 'dispatcher', 'node'],
  operator: ['operator', 'owner'],
  repos: ['repos', 'repositories'],
  caps: ['caps'],
  worker: ['worker'],
} as const

interface Layout { machine: number; operator: number | null; repos: number; caps: number | null; worker: number | null; misnamed: boolean }

// The shape every roster had before its columns were named: three cells, and no caps. A table with
// no header is read this way, and a row with a fourth cell is refused rather than guessed at —
// there is no position a caps cell is known to sit in, so either the columns are named or there
// are none to name. Legacy three-cell rosters keep working untouched.
const POSITIONAL: Layout = { machine: 0, operator: 1, repos: 2, caps: null, worker: null, misnamed: false }
const UNNAMED_COLUMNS = 'the table names no columns, so nothing says which cell holds the caps or the gate — add a header row, `| node | owner | worker | repos | caps |`'
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
  if (halves.length !== 2 || !halves[0]!.trim() || !halves[1]!.trim()) return ''
  return nodeId(halves[0]!, halves[1]!)
}

// One row per machine. A table names its columns in a header row, and a bullet is
// `- machine — repos`; `*`, `all` or an empty repos cell means every repository of the org.
export function parseDispatchers(text: string): Dispatcher[] {
  const found: Dispatcher[] = []
  let layout = POSITIONAL
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
      // A wider table than the legacy three, with nothing naming its columns: the caps could be in
      // any of the extra cells or in none of them, and a gate does not guess. Refused by name.
      if (layout === POSITIONAL && row.length > 3) problem = UNNAMED_COLUMNS
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

export const dispatchersPath = (clone: string) => join(clone, 'nodes.md')

// Where this machine's copy of the org control room lives: the path the last sync recorded, else
// the default clone path for the org this repository's dev.md names.
export function controlRoomClone(root: string, home = homedir()): { org: string; clone: string } | null {
  const devMd = join(root, '.vegastack', 'dev.md')
  const knob = existsSync(devMd) ? parseControlRoomKnob(readFileSync(devMd, 'utf8')) : null
  if (!knob) return null
  let path: string | null = null
  try { path = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')).controlRooms[knob.org]?.path ?? null } catch { path = null }
  return { org: knob.org, clone: path ?? defaultClonePath(knob.org, home) }
}

export type GitRun = (args: string[]) => { status: number | null; out: string }

export const gitIn = (dir: string): GitRun => (args) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
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
  return { ok: true, reason: 'refreshed from the control room', sha: git(['rev-parse', 'HEAD']).out || null }
}

export interface Listing { ok: boolean; reason: string; entry: Dispatcher | null; file: string | null }

// `listedHere`, but only after the roster has been refreshed and verified. This is what a run
// asks each pass; a read-only view may ask `listedHere` alone and show what it has.
export function verifiedListing(root: string, options: { repo: string; host?: string; home?: string; git?: (clone: string) => GitRun }): Listing {
  const room = controlRoomClone(root, options.home ?? homedir())
  if (!room) return listedHere(root, options)
  const refresh = refreshRoster(room.clone, (options.git ?? gitIn)(room.clone))
  if (!refresh.ok) return { ok: false, reason: refresh.reason, entry: null, file: dispatchersPath(room.clone) }
  return listedHere(root, options)
}

// The gate every verb passes. A missing or unreadable roster refuses, never defaults: a machine
// nobody listed must not start working the board because a file was late.
export function listedHere(root: string, options: { repo: string; host?: string; home?: string }): Listing {
  // One spelling, and only one: a node is `<os-user>@<hostname>`. Accepting a bare hostname as
  // well would mean two rows could name this machine and a roster could grant through either.
  const machine = nodeId(undefined, options.host ?? hostname())
  const room = controlRoomClone(root, options.home ?? homedir())
  if (!room) return { ok: false, reason: `this repository names no control room (dev.md's control-room: knob), so no machine is listed to dispatch it`, entry: null, file: null }
  const file = dispatchersPath(room.clone)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: `${file} is not on this machine — run \`vegafactory sync\` to refresh the ${room.org} control room, and add ${machine} to nodes.md in a control-room PR`, entry: null, file }
  }
  const entry = parseDispatchers(text).find((row) => row.machine === machine) ?? null
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
  if (!every && !entry.repos.includes(options.repo)) {
    const named = entry.repos.length ? `for ${entry.repos.join(', ')}` : 'for no repository — its repos cell is empty'
    return { ok: false, reason: `${machine} is listed in ${file} ${named}, not ${options.repo}`, entry, file }
  }
  return { ok: true, reason: `${machine} is listed in ${file}`, entry, file }
}

// ---------------------------------------------------------------------------------------------
// Identity: the VegaFactory GitHub App

// The published App (dev-setup's references/github-app.md). An org running its own copy sets
// VEGAFACTORY_APP_ID; the key file is the only other input, and neither is ever printed.
export const APP_ID = '4812956'
export { APP_ACTOR }

export function appKeyPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const named = env.VEGAFACTORY_APP_PRIVATE_KEY_FILE?.trim()
  return named || workerAppKey({ env, home })
}

export function missingKeyMessage(path: string): string {
  return `the VegaFactory App private key is not readable at ${path} — put the .pem there (chmod 600) or set VEGAFACTORY_APP_PRIVATE_KEY_FILE to where it is; the dispatcher writes as the App and never falls back to a person's token`
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
// What this does not cover: a dispatched run is a child of this process and runs as the same user,
// so the filesystem lets it read this file however tight the mode is. The child is never told
// where the key is and is given an hour-long token instead, but that is a smaller door, not a shut
// one. The separate dispatcher account in the control room's dispatcher-box checklist is what
// closes it — the key belongs to an account that runs nothing else.
export function assertKeyFile(path: string, { stat = lstatSync as unknown as KeyStat, uid = process.getuid?.() ?? -1 } = {}) {
  let facts: KeyFacts
  try { facts = stat(path) } catch { throw new Error(missingKeyMessage(path)) }
  if (facts.isSymbolicLink()) throw new Error(`${path} is a symbolic link — the App key must be a real file, so what it points at cannot be swapped after this check`)
  if (!facts.isFile()) throw new Error(`${path} is not a regular file — the App key must be a real file`)
  if (uid >= 0 && facts.uid !== uid) throw new Error(`${path} is owned by uid ${facts.uid}, not the account running this (uid ${uid}) — the App key belongs to the dispatcher account`)
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
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vegafactory-dispatch' }
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
// an installation token lives an hour and the dispatcher lives for months.
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
// exists and the evidence for it never lands. The caps may say so, and the dispatcher says it out
// loud. Closing it properly is the credential broker in #239.
export const TOKEN_LIFE_MS = 55 * 60_000

export interface AppIdentity { runner: GhRunner; freshen: (now?: number) => Promise<void>; token: () => string | null }

export function appIdentity(input: { repo: string; keyPath: string; appId: string; fetch?: Fetch }): AppIdentity {
  let held: AppToken | null = null
  return {
    runner: tokenRunner(() => {
      if (!held) throw new GhError('the dispatcher has no installation token yet')
      return held.token
    }),
    // What a dispatched run is given so its own writes are the App's too. It is a value, never a
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
export type Probe = (command: string, args: string[]) => { code: number; stdout: string; stderr: string }

export const probe: Probe = (command, args) => {
  // stdin is closed, not inherited. Both harnesses read a prompt from stdin when one is open, so
  // an inherited terminal turns a readiness probe into a wait for input nobody is there to give.
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message }
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

// Whether this repository's harness hooks call the CLI. Both files are checked: a machine that
// dispatches Claude Code and Codex runs needs the guard and the heartbeat on both.
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
    // error, so this check could never pass and `dispatch enable` refused every machine.
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

// Where a dispatched run's work would go. A run must be able to push code, and the App's token
// cannot: its Contents is read-only. SSH answers no credential helper at all, so an SSH remote is
// always fine. An HTTPS remote has to prove that a credential comes back which is not the App's —
// the run asks for one with the App's token scrubbed from the environment, and this asks the same
// way, so a machine that is only logged in as the App finds out now rather than after a run's work.
export function pushPath(root: string, run: Probe): Check {
  const result = run('git', ['-C', root, 'remote', 'get-url', '--push', 'origin'])
  const url = result.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  if (result.code !== 0 || !url) return { name: 'push', ok: false, detail: `cannot read the push URL of origin in ${root}: ${(result.stderr || result.stdout).split('\n').at(-1)?.slice(0, 160) ?? `exit ${result.code}`}` }
  if (/^(git@|ssh:\/\/)/.test(url)) return { name: 'push', ok: true, detail: `origin pushes over SSH (${url})` }

  // Only an https remote uses the credential helper a run's Git is given. Anything else — http,
  // git://, a local path, a host alias — would not, so proving a credential proves nothing about
  // it, and a readiness check that passed would be a check that lied.
  const https = /^https:\/\/([^/]+)\//.exec(url)
  if (!https) {
    return { name: 'push', ok: false, detail: `origin pushes over ${url.split(':')[0] || 'an unknown transport'} (${url}), which a run's Git has no credential path for — give origin an SSH or https push URL` }
  }
  // The override a run's Git gets names github.com, so that is the only https host whose credential
  // path this check can vouch for. Another host would be asked about here and never used there.
  const host = https[1]!
  if (host !== 'github.com') {
    return { name: 'push', ok: false, detail: `origin pushes to ${host} over https, and a run's Git is only given a credential for github.com — give origin an SSH push URL: git remote set-url --push origin git@${host}:<owner>/<repo>.git` }
  }
  // Asked the way a run's Git will ask: with the App's token out of the environment, so what comes
  // back is the machine's own login rather than the credential that cannot push.
  const asked = run('env', ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', 'gh', 'auth', 'status', '--hostname', host])
  const account = /Logged in to \S+ account (\S+)/.exec(`${asked.stdout}\n${asked.stderr}`)?.[1] ?? ''
  if (asked.code === 0 && account) {
    return { name: 'push', ok: true, detail: `origin pushes over HTTPS as ${account}, which is what a run's Git gets once the App's token is scrubbed` }
  }
  return {
    name: 'push', ok: false,
    detail: `origin pushes over HTTPS (${url}) and this machine has no ${host} login of its own — the App's token cannot write code, so a run would finish its work and fail to push it. Log in with \`gh auth login\`, or give origin an SSH push URL: git remote set-url --push origin git@${host}:<owner>/<repo>.git`,
  }
}

export interface ReadyInput { root: string; listing: Listing; run: Probe; keyOk: boolean; keyDetail: string; env: NodeJS.ProcessEnv }

export function readiness(input: ReadyInput): Check[] {
  const billing = billingVariables(input.env)
  return [
    { name: 'listed', ok: input.listing.ok, detail: input.listing.reason },
    { name: 'billing', ok: billing.length === 0, detail: billing.length ? `${billing.join(', ')} set — the dispatcher runs on subscriptions only; unset them` : 'no API-key variable is set' },
    hooksWired(input.root),
    pushPath(input.root, input.run),
    ...harnessAnswers(input.run),
    { name: 'app-key', ok: input.keyOk, detail: input.keyDetail },
  ]
}

export const renderChecks = (checks: Check[]) => checks.map((check) => `${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(8)} ${check.detail}`).join('\n')

export function unitPath(platform: NodeJS.Platform, home = homedir()): string {
  return platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`)
    : join(home, '.config', 'systemd', 'user', 'vegafactory-dispatch.service')
}

// The unit runs one command: this CLI's own `dispatch run`, in the repository, restarted when it
// stops. Nothing in it carries a token; the repository and the log path are all it knows.
export function unitText(platform: NodeJS.Platform, input: { cli: string[]; root: string; repo: string; logDir: string }): string {
  const argv = [...input.cli, 'dispatch', 'run', '--repo', input.repo]
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
      `  <key>StandardOutPath</key><string>${escaped(join(input.logDir, 'dispatch.log'))}</string>`,
      `  <key>StandardErrorPath</key><string>${escaped(join(input.logDir, 'dispatch.err.log'))}</string>`,
      '</dict>', '</plist>', '',
    ].join('\n')
  }
  return [
    '[Unit]', 'Description=VegaFactory dispatcher', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${input.root}`,
    `ExecStart=${argv.map((arg) => JSON.stringify(arg)).join(' ')}`,
    'Restart=always', 'RestartSec=30', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')
}

export function serviceCommands(platform: NodeJS.Platform, path: string, verb: 'enable' | 'disable', uid = userInfo().uid): string[][] {
  if (platform === 'darwin') {
    const target = `gui/${uid}`
    return verb === 'enable'
      ? [['launchctl', 'bootstrap', target, path], ['launchctl', 'enable', `${target}/${SERVICE_NAME}`]]
      : [['launchctl', 'bootout', `${target}/${SERVICE_NAME}`]]
  }
  return verb === 'enable'
    ? [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'vegafactory-dispatch.service']]
    : [['systemctl', '--user', 'disable', '--now', 'vegafactory-dispatch.service']]
}

// ---------------------------------------------------------------------------------------------
// What the dispatcher writes down: the runs it made and what it has already acted on

export type Action = 'follow-up' | 'plan' | 'implement' | 'corrections' | 'ship' | 'stop' | 'none'
export type Outcome = 'done' | 'blocked' | 'failed' | 'killed' | 'limit' | 'stopped'

export interface RunRecord { at: string; issue: number; action: Action; outcome: Outcome; ms: number; machine: string; note: string }
export interface Acted { at: number; action: Action; outcome: Outcome; trigger: number | null; failures: number; retryAt: number | null }

export const dispatchDir = (root: string) => join(root, '.vegastack', '.tmp', 'dispatch')
export const childrenPath = (root: string) => join(dispatchDir(root), 'children.json')
const runsPath = (root: string) => join(dispatchDir(root), 'runs.jsonl')
const actedPath = (root: string) => join(dispatchDir(root), 'acted.json')

// The record is a working note on an always-on machine, so it is trimmed to the last RUNS_KEPT
// rather than grown forever; the control room's statistics are where runs are kept for good.
export const RUNS_KEPT = 500

export function recordRun(root: string, record: RunRecord) {
  mkdirSync(dispatchDir(root), { recursive: true })
  appendFileSync(runsPath(root), JSON.stringify(record) + '\n')
  try {
    const lines = readFileSync(runsPath(root), 'utf8').split('\n').filter(Boolean)
    if (lines.length > RUNS_KEPT * 2) replaceFile(runsPath(root), lines.slice(-RUNS_KEPT).join('\n') + '\n')
  } catch { /* the record is a note; failing to trim it is not worth a failed run */ }
}

export function readRuns(root: string, limit = 20): RunRecord[] {
  let text = ''
  try { text = readFileSync(runsPath(root), 'utf8') } catch { return [] }
  const rows: RunRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line) as RunRecord) } catch { /* a truncated line is not a run */ }
  }
  return rows.slice(-limit)
}

export function readActed(root: string): Record<string, Acted> {
  try {
    const saved: unknown = JSON.parse(readFileSync(actedPath(root), 'utf8'))
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, Acted> : {}
  } catch { return {} }
}

export function writeActed(root: string, acted: Record<string, Acted>) {
  mkdirSync(dispatchDir(root), { recursive: true })
  replaceFile(actedPath(root), JSON.stringify(acted, null, 2) + '\n')
}

// A pid on its own is not an identity: pids are reused, and a record left behind by a crash would
// have a later, unrelated process signalled in its place. The pair (pid, start time) is an
// identity, and the start time is what the operating system says, not what we remember.
export type ProcessStart = (pid: number) => string | null

export const processStart: ProcessStart = (pid) => {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10_000 })
  const line = (result.stdout ?? '').trim()
  return result.status === 0 && line ? line : null
}

// The runs this machine has started, and enough about each to prove it is still that run and to
// clean up after it. It is on disk because `dispatch disable` is a different process from the
// service it takes down: without this, the service's agents would keep running and keep writing to
// GitHub after the unit is gone.
export interface ChildRecord {
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
  return !!row && typeof row === 'object' && Number.isSafeInteger(row.pid) && row.pid > 1
    && typeof row.startedAt === 'string' && typeof row.command === 'string' && Number.isSafeInteger(row.issue)
}

export function readChildren(root: string): ChildRecord[] {
  try {
    const saved: unknown = JSON.parse(readFileSync(childrenPath(root), 'utf8'))
    return Array.isArray(saved) ? saved.filter(isRecord) : []
  } catch { return [] }
}

function writeChildren(root: string, change: (rows: ChildRecord[]) => ChildRecord[]) {
  mkdirSync(dispatchDir(root), { recursive: true })
  withLock(dispatchDir(root), () => {
    replaceFile(childrenPath(root), JSON.stringify(change(readChildren(root)), null, 2) + '\n')
  }, { what: 'the dispatcher\'s children' })
}

export function noteChild(root: string, record: ChildRecord) {
  writeChildren(root, (rows) => [...rows.filter((row) => row.pid !== record.pid), record])
}

// Removed when the run ends, so the file is the live set and not a history.
export function forgetChild(root: string, pid: number) {
  writeChildren(root, (rows) => rows.filter((row) => row.pid !== pid))
}

// Whether the process this record named is still that process.
export function stillTheChild(record: ChildRecord, start: ProcessStart = processStart): boolean {
  const now = start(record.pid)
  return now !== null && now === record.startedAt
}

// Stops a run and everything it started. The group is signalled, not the one process: an agent
// spawns its own tools, and leaving those behind is how a "stopped" dispatcher keeps working.
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
export function stopChild(root: string, record: ChildRecord, deps: { stop?: (pid: number, signal: NodeJS.Signals) => boolean; start?: ProcessStart } = {}): boolean {
  if (!stillTheChild(record, deps.start ?? processStart)) {
    forgetChild(root, record.pid)
    return false
  }
  const stopped = (deps.stop ?? stopGroup)(record.pid, 'SIGTERM')
  forgetChild(root, record.pid)
  return stopped
}

// Two steps finish at once, and an operator may run a pass by hand beside the service: the
// read-modify-write takes the same lock the issue cache uses, so neither loses the other's entry.
export function updateActed(root: string, change: (acted: Record<string, Acted>) => void) {
  mkdirSync(dispatchDir(root), { recursive: true })
  withLock(dispatchDir(root), () => {
    const acted = readActed(root)
    change(acted)
    writeActed(root, acted)
  }, { what: 'the dispatcher\'s record' })
}

// One dispatcher per machine. Two are not twice the work: they double every poll, race for every
// claim and split the run budget in ways neither can see. The lock records the process that holds
// it the same way a child record does, so a crashed dispatcher's lock is taken over rather than
// blocking the box for ever.
export const runLockPath = (root: string) => join(dispatchDir(root), 'run.lock')

export interface RunLock { pid: number; startedAt: string; runId: string; at: string }

export function takeRunLock(root: string, runId: string, start: ProcessStart = processStart): { ok: boolean; reason: string; held: RunLock | null } {
  mkdirSync(dispatchDir(root), { recursive: true })
  return withLock(dispatchDir(root), () => {
    let held: RunLock | null = null
    try { held = JSON.parse(readFileSync(runLockPath(root), 'utf8')) as RunLock } catch { held = null }
    if (held && Number.isSafeInteger(held.pid) && held.pid !== process.pid && start(held.pid) === held.startedAt) {
      return { ok: false, held, reason: `another dispatcher is already running on this machine (pid ${held.pid}, since ${held.at}) — stop it, or let it work` }
    }
    const mine: RunLock = { pid: process.pid, startedAt: start(process.pid) ?? '', runId, at: new Date().toISOString() }
    replaceFile(runLockPath(root), JSON.stringify(mine, null, 2) + '\n')
    return { ok: true, held: mine, reason: 'this machine\'s dispatcher' }
  }, { what: 'the dispatcher lock' })
}

export function releaseRunLock(root: string, runId: string) {
  try {
    const held = JSON.parse(readFileSync(runLockPath(root), 'utf8')) as RunLock
    if (held.runId === runId) rmSync(runLockPath(root), { force: true })
  } catch { /* nothing to give back */ }
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
// from a person with write access or from the factory's own App, because a dispatched run's
// artifacts are posted by the machine, not by a person sitting behind it.
const fromPerson = (permission: PermissionLookup) => (entry: CommentEntry) =>
  entry.authorType !== 'Bot' && !!entry.author && WRITE.has(permission(entry.author))
const fromFactory = (permission: PermissionLookup) => (entry: CommentEntry) =>
  entry.author === APP_ACTOR || fromPerson(permission)(entry)

// The operator's own comments: a person with write access, in the order they were written.
function operatorComments(snap: Snapshot, permission: PermissionLookup) {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'human' && fromPerson(permission)(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

// The newest work artifact of a type: written by a person with write access, or by the App on a
// dispatched run's behalf. An outsider's comment is text on a page and never either.
export function latestArtifact(snap: Snapshot, type: string, permission: PermissionLookup): CommentEntry | null {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === type && fromFactory(permission)(entry))
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
// A stand-down the released version wrote, which carried `type=handback` before stand-downs had
// their own marker. It is matched as the *whole* body and not a line within one, because a genuine
// hand-back may repeat a stand-down while asking something new — and reading that as bookkeeping
// would let a comment written before the question be chosen as its answer.
//
// The name is held to the shape `machineName` produces rather than to any bold run, so a sentence
// that merely begins with emphasis — `**Note** stood down from #5: …` — is still a question.
const LEGACY_STANDDOWN = /^\*\*[a-z0-9][a-z0-9-]*\*\* stood down from #\d+: [^\n]+$/

const withoutMarker = (body: string) => String(body ?? '').replace(/<!--[\s\S]*?-->/, '').trim()

const isBookkeeping = (snap: Snapshot, entry: CommentEntry) =>
  BOOKKEEPING.has(entry.type) || (entry.type === 'handback' && LEGACY_STANDDOWN.test(withoutMarker(snap.body(entry))))

// The action this issue is waiting for, and the comment that asks for it. `trigger` is what makes
// a run happen once: a comment already acted on asks for nothing more, and a state label already
// worked is not worked again until the issue moves.
export function decide(snap: Snapshot, permission: PermissionLookup, options: { acted?: Acted | null; now?: number; held?: boolean; failures?: number } = {}): Decision {
  const issue = snap.state.issue!
  const { acted = null, now = Date.now(), held = false } = options
  if (issue.state !== 'open') return nothing('the issue is closed')
  if (issue.labels.includes('epic')) return nothing('an epic is a map; its sub-issues carry the work')
  const { state } = stateOf(issue.labels)
  if (!state) return nothing('no state label')
  const comments = operatorComments(snap, permission)
  const decided = transitionOf(snap, issue, state, comments, permission, { acted, held })
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

function transitionOf(snap: Snapshot, issue: IssueFacts, state: State, comments: Comments, permission: PermissionLookup, run: { acted: Acted | null; held: boolean }): Decision {
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
    const evidence = latestArtifact(snap, 'evidence', permission)
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

export interface Candidate { number: number; action: Action; parent: number | null; files: string[]; from: State }

const CODE: Action[] = ['implement', 'corrections']

// The steps that may start now, in board order. One run per issue; at most `max` at once; one
// merge at a time, because merges go through the queue one by one; and two code runs together
// only when they are sibling sub-issues whose declared file sets are disjoint and safe.
export function schedule(candidates: Candidate[], running: Candidate[] = [], max = MAX_RUNS): Candidate[] {
  const picked: Candidate[] = [...running]
  const chosen: Candidate[] = []
  for (const candidate of candidates) {
    if (picked.length >= max) break
    if (picked.some((other) => other.number === candidate.number)) continue
    if (candidate.action === 'ship' && picked.some((other) => other.action === 'ship')) continue
    if (CODE.includes(candidate.action) && !picked.filter((other) => CODE.includes(other.action)).every((other) => disjointSiblings(candidate, other))) continue
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
export type RunStep = (step: Step, context: { root: string; timeoutMs?: number; onStart?: (pid: number, command: string) => void }) => Promise<StepResult>

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
    `You are a dispatched run on issue #${step.number} in ${step.repo}. Nobody is watching this session.`,
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
// Both tools are told not to stop and ask. Nobody is at the keyboard, and the first dispatched run
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

// The limit is enforced inside the child's own process group, so it holds even if the dispatcher
// dies: an agent orphaned by a crash or a `launchctl bootout` still stops on its own rather than
// writing to GitHub unsupervised for hours.
// The backstop sleeps with its own stdio, detached from the job's pipes, and is killed by name
// rather than through the subshell that started it. Both halves are load-bearing: killing a
// subshell leaves the `sleep` inside it running, and an orphan sleep holding the job's stdout means
// the reader never sees end-of-file. The first dispatched run finished its work in twelve seconds
// and held its slot for the full twenty-minute limit, because of exactly that.
const WATCHDOG = '"$@" & job=$!; { sleep "$VF_LIMIT" & dog=$!; wait "$dog"; kill -KILL 0; } </dev/null >/dev/null 2>&1 & guard=$!;'
  + ' wait "$job"; code=$?; pkill -P "$guard" 2>/dev/null; kill "$guard" 2>/dev/null; exit "$code"'

// One child, in its own process group so a stuck step is killed with everything it started. Only
// the tail of its output is kept: the record is bounded and the output never reaches the issue.
function execTool(tool: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onStart?: (pid: number, command: string) => void }): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', WATCHDOG, 'vegafactory-dispatch', tool, ...args], {
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
  const base = join(root, '.vegastack', '.worktrees')
  try {
    const match = readdirSync(base).find((name) => name.startsWith(`${number}-`))
    return match && statSync(join(base, match)).isDirectory() ? join(base, match) : null
  } catch { return null }
}

// The real step: a headless agent run on the operator's subscription, in the issue's worktree,
// killed after the step limit. `childEnvironment` is what refuses an API key in the environment.
// The environment a dispatched run gets. Three things are true of it and each one matters:
//
// - it runs on the operator's subscription, which is what `childEnvironment` proves;
// - it writes to GitHub as the App, on the short-lived installation token this machine minted, so
//   everything it posts is authored by `vegafactory[bot]` and nothing it writes can pass as a
//   person's stop, correction or "ship it";
// - it is never told where the App's private key is. The token expires in an hour; the key does
//   not. (A child running under the same account can still read that file through the filesystem —
//   the separate dispatcher account in the dispatcher-box checklist is what closes that, not this.)
export function childRunEnvironment(env: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...childEnvironment(env), VSK_ASK_ROUTE: 'issue' }
  for (const name of Object.keys(child)) if (name.startsWith('VEGAFACTORY_')) delete child[name]
  if (token) {
    child.GH_TOKEN = token
    child.GITHUB_TOKEN = token
    // GH_TOKEN is for the API and nothing else. `gh auth git-credential` prefers it over the
    // credential the machine is logged in with, and the App's Contents is read-only, so a push
    // carrying it fails — after the work, which is the worst moment to find out. Git therefore
    // asks for a credential with the App's token scrubbed out of the environment first, which
    // hands back the machine's own login instead. HTTPS keeps working exactly as it does for the
    // person at the keyboard, and an SSH remote ignores all of this because SSH asks no helper.
    //
    // This is attribution, not isolation: a child under this account can read that login for
    // itself whenever it likes. The separate dispatcher account closes that, and nothing here
    // pretends to (#239).
    for (const name of Object.keys(child)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(name)) delete child[name]
    child.GIT_CONFIG_COUNT = '2'
    // An empty value resets the helper list, so the machine's own github.com helper cannot answer
    // first with the token we are trying to keep away from Git.
    child.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper'
    child.GIT_CONFIG_VALUE_0 = ''
    child.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper'
    child.GIT_CONFIG_VALUE_1 = '!env -u GH_TOKEN -u GITHUB_TOKEN gh auth git-credential'
  }
  return child
}

export function defaultRunStep(devMd: string, env: NodeJS.ProcessEnv, { exec = execTool, timeoutMs = STEP_TIMEOUT_MS, token = () => null as string | null } = {}): RunStep {
  return async (step, context) => {
    const started = Date.now()
    const policy = stagePolicy(devMd, STAGE_OF[step.action] ?? 'implement')
    const { tool, args } = agentArgs(policy, stepPrompt(step))
    const cwd = workingDir(context.root, step.number) ?? context.root
    // Nobody is at the keyboard, so a round of questions goes to the issue and waits there for the
    // operator — dev-setup's references/ask-route.md, where VSK_ASK_ROUTE is the first step.
    // The limit arrives with the run rather than with the step function, so a roster change lands
    // on the next run instead of the next restart.
    const limit = context.timeoutMs ?? timeoutMs
    const child = await exec(tool, args, { cwd, env: childRunEnvironment(env, token()), timeoutMs: limit, onStart: context.onStart })
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

export interface PollDeps {
  root: string
  repo: string
  runner: GhRunner
  // This dispatcher process, so its claims are its own and no other process reads them as such.
  runId: string
  // The machine's own limits, from its roster row, re-read every pass.
  caps?: Caps
  now: () => number
  runStep: RunStep
  out: (text: string) => void
  machine: string
  // Saves, pushes, releases and hands an issue back: the reason goes on the issue, and the state
  // label goes back to where the run picked it up.
  standDown: (number: number, reason: string, restoreTo?: State) => string
  // How a started run is ended: its whole process group, so the tools it spawned go with it.
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
  // What the operating system says about a pid, which is half of a child's identity.
  start?: ProcessStart
}

// The steps this machine has started. It lives across polls, so the next pass two minutes later
// sees them, keeps their slots and can still act on the rest of the board. A finished run stays in
// the map until the next pass sweeps it, so nothing can disappear between starting and being read.
// `consumes` says whether the stop spends the trigger the run was working on. An operator's stop
// does: they asked for this, and it is their comment the record points at. An administrative stop
// — the machine de-listed, the service told to stop, a signal — does not: nothing about the issue
// changed, so the work has to look unstarted again or no machine ever picks it up.
export interface Interrupt { reason: string; action: Action; trigger: number | null; consumes: boolean }

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
export const drain = (inflight: Map<number, Inflight>) => Promise.all([...inflight.values()].map((run) => run.done))

// One pass over the board: read what changed, decide, and start what is safe to start now. The
// steps run to their own end; this returns as soon as they are under way.
export async function poll(deps: PollDeps, inflight: Map<number, Inflight> = new Map()): Promise<Candidate[]> {
  const { root, repo, runner, now } = deps
  // Last pass's finished runs, whose outcomes are now in `acted`: their slots and issues are free.
  for (const [number, run] of inflight) if (run.settled) inflight.delete(number)
  const permission = permissionLookup(repo, runner, { root })
  const trusted = trustedFactory({ repo, runner, root })
  const acted = readActed(root)
  const wanted: Array<{ candidate: Candidate; decision: Decision; key: string }> = []
  const plans = new Map<number, string | null>()
  // One issue nobody can read must not cost the board its pass, so everything per-issue is guarded.
  for (const issue of board(repo, runner)) {
    try {
      syncIssue({ root, repo, number: issue.number, runner })
      const snap = snapshot(cacheDir(root, repo, issue.number))
      const key = `${repo}#${issue.number}`
      const held = !!holderOf(snap.state, snap.body, now(), trusted).holder
      const decision = decide(snap, permission, { acted: acted[key] ?? null, now: now(), held, failures: deps.caps?.failures })
      if (decision.action === 'none') continue
      // A fresh claim means someone — a person or another machine — is already on it.
      if (decision.action !== 'stop' && held) {
        deps.out(`#${issue.number}: skipped, a fresh claim holds it`)
        continue
      }
      // The operator's word becomes a recorded ack, read back by the ship gate's own check. A word
      // that does not survive that is spent here rather than re-relayed on every pass.
      if (decision.action === 'ship') {
        const confirmed = confirmShip({ root, repo, number: issue.number, runner }, permission, { id: decision.trigger!, by: decision.by!, quote: decision.quote! })
        if (!confirmed.ok) {
          deps.out(`#${issue.number}: not shipping — ${confirmed.reason}`)
          recordRun(root, { at: new Date(now()).toISOString(), issue: issue.number, action: 'ship', outcome: 'blocked', ms: 0, machine: deps.machine, note: tail(confirmed.reason) })
          updateActed(root, (saved) => { saved[key] = { at: now(), action: 'ship', outcome: 'blocked', trigger: decision.trigger, failures: 0, retryAt: null } })
          continue
        }
      }
      const parent = snap.state.issue!.parent
      if (parent !== null && !plans.has(parent)) plans.set(parent, parentPlan(root, repo, parent, runner, permission))
      const files = parent === null ? [] : filesFromParent(plans.get(parent) ?? null, issue.number)
      wanted.push({ key, decision, candidate: { number: issue.number, action: decision.action, parent, files, from: stateOf(snap.state.issue!.labels).state! } })
    } catch (error) {
      deps.out(`#${issue.number}: could not be read (${(error as Error).message})`)
    }
  }

  // An operator's stop for a run that is already going cannot wait for a slot: scheduling would
  // skip the issue because it is running, and no other machine may release the claim this one
  // holds. So it is handled first — the run is ended, and its own settle hands the issue back.
  const interrupted: number[] = []
  for (const item of wanted) {
    const run = inflight.get(item.candidate.number)
    if (item.decision.action !== 'stop' || !run || run.settled) continue
    deps.out(`#${item.candidate.number}: ${item.decision.reason} — stopping the ${run.candidate.action} run`)
    run.interrupt = { reason: item.decision.reason, action: 'stop', trigger: item.decision.trigger, consumes: true }
    run.stop()
    await run.done
    inflight.delete(item.candidate.number)
    interrupted.push(item.candidate.number)
  }

  const started: Candidate[] = []
  const queue = wanted.filter((item) => !interrupted.includes(item.candidate.number))
  for (const candidate of schedule(queue.map((item) => item.candidate), [...inflight.values()].map((run) => run.candidate), deps.caps?.runs ?? MAX_RUNS)) {
    const item = queue.find((entry) => entry.candidate.number === candidate.number)!
    const at = now()
    // Taken before the slot, so a second machine on the same board sees the work is taken. Losing
    // the race is not a failure: the issue is simply someone else's this pass. A stop takes no
    // claim — it acts on an issue somebody *is* holding, which is the one case a claim would
    // refuse, and standing down is what releases that holder.
    const taken = candidate.action === 'stop'
      ? { ok: true, owner: '', reason: 'a stop takes no claim' }
      : reserve({ root, repo, number: candidate.number, runner }, deps.machine, deps.runId, candidate.action, at)
    if (!taken.ok) {
      deps.out(`#${candidate.number}: not started — ${taken.reason}`)
      continue
    }
    const run: Inflight = { candidate, started: at, settled: false, stop: () => {}, interrupt: null, done: Promise.resolve() as unknown as Promise<RunRecord> }
    run.done = runOne(deps, candidate, item, at, taken.owner, run).then((record) => { run.settled = true; return record })
    inflight.set(candidate.number, run)
    started.push(candidate)
  }
  return started
}

// The claim a dispatched run takes before it starts, so another machine polling the same board
// sees the work is taken rather than starting it again. It is an App-authored `dispatch` claim,
// kept alive while the step runs and released on every way out.
//
// A step that runs an agent which claims for itself — dev-implement and its corrections path —
// hands the claim over instead: the rest of the workflow reads the session's own claim from inside
// its worktree, whose name this machine cannot know in advance. That hand-over is a seconds-wide
// window in which a second machine could start the same issue; closing it needs the fleet-wide
// lease that #3 tracks, not a longer claim here.
export const HANDS_OVER: Action[] = ['implement', 'corrections']

export interface Reservation { ok: boolean; owner: string; reason: string }

// The owner carries the *process*, not just the machine and the issue. Two dispatchers on one host
// — the service and an operator running a pass by hand — would otherwise compute the same owner,
// each read it as its own claim, and both start the run.
export const ownerFor = (machine: string, runId: string, number: number) => `${machine}:dispatch-${runId}-${number}`

export function reserve(ctx: { root: string; repo: string; number: number; runner: GhRunner }, machine: string, runId: string, action: Action, now = Date.now()): Reservation {
  const owner = ownerFor(machine, runId, ctx.number)
  try {
    const outcome = claim(ctx, { owner, kind: 'dispatch', harness: 'dispatch', model: action }, now)
    return { ok: outcome.ok, owner, reason: outcome.message }
  } catch (error) {
    return { ok: false, owner, reason: `the claim could not be taken: ${(error as Error).message}` }
  }
}

// One step and everything that follows it. Nothing here may reject: the loop does not await these
// promises, so a rejection nobody handles would take the whole dispatcher down.
async function runOne(deps: PollDeps, candidate: Candidate, item: { key: string; decision: Decision }, at: number, held: string | null, run: Inflight): Promise<RunRecord> {
  const claimCtx = { root: deps.root, repo: deps.repo, number: candidate.number, runner: deps.runner }
  // What the step started, filled in from its own callback, so the finally can forget it.
  const started: ChildRecord[] = []
  // While this machine holds the claim it says so, on the same schedule a session's hooks use.
  const beat = held ? setInterval(() => { try { heartbeat(claimCtx, held) } catch { /* a missed beat is not a failure */ } }, HEARTBEAT_EVERY_MS) : null
  beat?.unref?.()
  let result: StepResult
  try {
    if (candidate.action === 'stop') {
      // A stop needs no agent: it is this machine giving the issue back.
      result = { outcome: 'stopped', note: deps.standDown(candidate.number, item.decision.reason, candidate.from), ms: 0 }
    } else {
      // The agent claims for itself from inside its own worktree, so this machine's reservation
      // steps aside first — holding both would stop the run it just started.
      if (held && HANDS_OVER.includes(candidate.action)) {
        if (beat) clearInterval(beat)
        try { release(claimCtx, held, APP_ACTOR, 'handing the issue to the run this machine just started') } catch { /* the run still starts */ }
      }
      result = await deps.runStep({ action: candidate.action, number: candidate.number, repo: deps.repo, split: item.decision.split, by: item.decision.by }, {
        root: deps.root,
        timeoutMs: deps.caps?.stepMs ?? STEP_TIMEOUT_MS,
        onStart: (pid, command) => {
          const record: ChildRecord = {
            pid, command, startedAt: (deps.start ?? processStart)(pid) ?? '', issue: candidate.number,
            action: candidate.action, owner: held, from: candidate.from,
          }
          started.push(record)
          run.stop = () => { stopChild(deps.root, record, { stop: deps.stop, start: deps.start }) }
          try { noteChild(deps.root, record) } catch { /* the run still stops from here */ }
        },
      })
    }
  } catch (error) {
    result = { outcome: 'failed', note: (error as Error).message, ms: deps.now() - at }
  } finally {
    if (beat) clearInterval(beat)
    run.stop = () => {}
    // The record is the live set, so it goes the moment the run does.
    for (const record of started) { try { forgetChild(deps.root, record.pid) } catch { /* the next sweep drops it */ } }
  }
  // Whatever happened, this machine's own reservation goes back. A step that stood the issue down
  // has already released the session's claim; this releases the one taken before the launch.
  if (held && !HANDS_OVER.includes(candidate.action)) {
    try { release(claimCtx, held, APP_ACTOR, `the ${candidate.action} run finished (${result.outcome})`) } catch { /* the record still lands */ }
  }
  // A run this machine stopped on purpose reports the reason it was stopped, not the exit code
  // that killing it produced.
  if (run.interrupt) result = { outcome: 'stopped', note: run.interrupt.reason, ms: result.ms }
  try {
    return settle(deps, candidate, item, at, result, run.interrupt, candidate.action === 'stop')
  } catch (error) {
    // The record could not be written down. Say so rather than dying, and let the next pass decide
    // again: without a saved outcome this trigger simply looks unacted-on.
    deps.out(`#${candidate.number} ${candidate.action} → ${result.outcome}, but the run could not be recorded: ${(error as Error).message}`)
    return { at: new Date(at).toISOString(), issue: candidate.number, action: candidate.action, outcome: result.outcome, ms: result.ms, machine: deps.machine, note: tail(result.note) }
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
    at: new Date(at).toISOString(), issue: candidate.number, action,
    outcome: result.outcome, ms: result.ms, machine: deps.machine, note: tail(result.note),
  }
  recordRun(deps.root, record)
  const ended = deps.now()
  let retryAt: number | null = null
  let failuresNow = 0
  // A stop that was nothing to do with the issue spends nothing. The run is still recorded and the
  // issue still handed back, but `acted` is left exactly as the last real run left it — write a
  // spent trigger here and the restored issue looks already-done to the next pass and to every
  // other machine, which is how an administrative stop turns into an issue nobody ever picks up.
  if (interrupt && !interrupt.consumes) {
    deps.out(`#${record.issue} ${record.action} → ${record.outcome}${record.note ? ` (${record.note})` : ''}`)
    if (result.outcome !== 'done' && !alreadyHandedBack) {
      deps.standDown(candidate.number, `${interrupt.reason}; this machine has saved and released the issue`, candidate.from)
    }
    return record
  }
  updateActed(deps.root, (acted) => {
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
    deps.standDown(candidate.number, `${why}; this machine has saved and released the issue${when}`, candidate.from)
  }
  deps.out(`#${record.issue} ${record.action} → ${record.outcome}${record.note ? ` (${record.note})` : ''}`)
  return record
}

// The operator's word, recorded and read back the way the ship gate reads it. The dispatcher
// relays the ack — an App may do that only by citing the person's own comment — and then asks
// `findValidAck` the same question `vegafactory issue check --for ship` asks. A relayed ack that
// does not validate ships nothing: the words on the page were never the gate, the ack is.
export interface ShipConfirmation { ok: boolean; reason: string }

export function confirmShip(ctx: { root: string; repo: string; number: number; runner: GhRunner },
  permission: PermissionLookup, word: { id: number; by: string; quote: string }): ShipConfirmation {
  const read = () => {
    syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
    return snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
  }
  const verdict = (snap: Snapshot) => {
    const evidence = latestArtifact(snap, 'evidence', permission)
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
export function acknowledgedPlan(snap: Snapshot, permission: PermissionLookup): { text: string | null; reason: string } {
  const ack = findValidAck(snap, 'plan', permission)
  if (!ack.ok || !ack.ack) return { text: null, reason: `the plan is not acked (${ack.reason})` }
  const acked = markerKeys(snap.body(ack.ack)).plan
  if (!acked) return { text: null, reason: 'the plan ack names no plan hash' }
  const plan = Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'plan' && fromFactory(permission)(entry) && artifactHash(snap.body(entry)) === acked)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1)
  if (!plan) return { text: null, reason: 'no plan comment matches the acked hash' }
  const text = snap.body(plan)
  const lint = lintPlan(text) as { blocks: string[] }
  if (lint.blocks.length) return { text: null, reason: `the acked plan does not pass plan-lint: ${lint.blocks[0]}` }
  return { text, reason: 'the acked plan' }
}

// The parent epic's acknowledged plan, where sibling file sets are declared.
function parentPlan(root: string, repo: string, parent: number, runner: GhRunner, permission: PermissionLookup): string | null {
  try {
    syncIssue({ root, repo, number: parent, runner })
    return acknowledgedPlan(snapshot(cacheDir(root, repo, parent)), permission).text
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
  now?: number
  // Where the state label goes back to, when a run left the issue in-progress.
  restoreTo?: State
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

type Git = (args: string[]) => { status: number | null; out: string }

// Giving an issue up: release the claim this run took, save and push its branch, say why on the
// issue, and put the state label back. The claim is checked *first* — a worktree this machine no
// longer owns is not ours to commit in — and the branch is checked before any write.
export function standDown(ctx: StandDownContext, reason: string): string {
  const claimCtx = { root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner }
  const notes: string[] = []
  // Who holds the issue, as three answers and not two: ours to finish, somebody else's to leave
  // alone, or unknown. Only the first two are safe, and they are safe for different reasons.
  let whose: 'ours' | 'free' | 'theirs' | 'unreadable' = 'unreadable'
  let owner: string | null = null
  try {
    syncIssue({ ...claimCtx })
    const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
    const held = holderOf(snap.state, snap.body, ctx.now ?? Date.now(), trustedFactory(claimCtx)).holder
    if (!held) { whose = 'free'; notes.push('no live claim to release') }
    else if (!held.owner.startsWith(`${ctx.machine}:`)) { whose = 'theirs'; notes.push(`the claim is held by ${held.owner}, so nothing here was touched and the state label was left alone`) }
    else { whose = 'ours'; owner = held.owner }
  } catch (error) {
    notes.push(`the claim could not be read (${(error as Error).message}), so nothing here was touched and the state label was left alone`)
  }

  // Only a claim this machine holds authorises writing to its worktree, and a claim that could not
  // be read is not one. With no live claim at all the work is still this machine's to save: it is
  // the run we just started that left it there.
  const dir = whose === 'ours' || whose === 'free' ? workingDir(ctx.root, ctx.number) : null
  if (dir) {
    const git: Git = (args) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 })
      return { status: result.status, out: (result.stdout ?? '').trim() }
    }
    const { branch, refusal } = pushableBranch(dir, ctx.number, git)
    if (refusal) notes.push(refusal)
    else {
      if (git(['status', '--porcelain']).out) {
        git(['add', '--all'])
        notes.push(git(['commit', '--quiet', '-m', `wip: #${ctx.number} saved before standing down`]).status === 0 ? 'committed the open work' : 'the open work could not be committed')
      }
      notes.push(git(['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`]).status === 0 ? `pushed ${branch}` : `the push of ${branch} was rejected, so the commit stays local`)
    }
  }

  if (whose === 'ours' && owner) {
    try {
      release(claimCtx, owner, APP_ACTOR, reason)
      notes.push(`released ${owner}`)
    } catch (error) { notes.push(`the claim could not be released: ${(error as Error).message}`) }
  }

  const note = `${reason} — ${notes.join(', ')}`
  // The issue says what happened and goes back to a state a later pass can pick up. Both are
  // best-effort: a stand-down that cannot reach GitHub still reports what it did locally.
  try {
    postComment(claimCtx, `<!-- vsk:v1 type=standdown -->\n**${ctx.machine}** stood down from #${ctx.number}: ${note}\n`)
  } catch (error) { notes.push(`the hand-back comment failed: ${(error as Error).message}`) }
  if (ctx.restoreTo && (whose === 'ours' || whose === 'free')) {
    try {
      syncIssue({ ...claimCtx })
      // Read again, here. The check above happened before this run saved, pushed and released,
      // which is long enough for another machine to have claimed the issue — and moving one out
      // of `in-progress` while somebody is working it is worse than leaving it where it is.
      const now = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
      const taken = holderOf(now.state, now.body, ctx.now ?? Date.now(), trustedFactory(claimCtx)).holder
      if (taken && !taken.owner.startsWith(`${ctx.machine}:`)) {
        notes.push(`${taken.owner} claimed it meanwhile, so the state label was left alone`)
        return `${reason} — ${notes.join(', ')}`
      }
      const labels = readState(cacheDir(ctx.root, ctx.repo, ctx.number))!.issue!.labels
      if (stateOf(labels).state === 'in-progress' && ctx.restoreTo !== 'in-progress') {
        setLabels(claimCtx, nextLabels(labels, { state: ctx.restoreTo }))
        notes.push(`put it back to ${ctx.restoreTo}`)
      }
    } catch (error) { notes.push(`the state label could not be put back: ${(error as Error).message}`) }
  }
  return `${reason} — ${notes.join(', ')}`
}

// ---------------------------------------------------------------------------------------------
// CLI

export function dispatchUsage(): string {
  return `Usage: vegafactory dispatch <enable|disable|status|run> [options]

  enable                 check this machine is ready — listed in the control room's nodes.md,
                         harness hooks wired, a real \`claude -p\` and \`codex exec\` answering, the
                         GitHub App key present — then install the launchd or systemd unit
  disable                remove the unit; the machine stops picking work up
  status                 the board, plus this machine's recent dispatcher runs
  run [--once]           the poll loop itself (the unit runs this); --once makes a single pass
                         and is the only form --json reports, because the document answers when
                         a pass ends

One merge at a time per machine, and as many runs at once as its roster row allows. The row's
caps cell sets them — \`runs 10 · step 72h · poll 1m · retry 15m · park 3\`, in any order, every
field optional and separated by \`·\` or a comma. \`runs\` and \`park\` take a count; \`step\` takes
minutes or hours, \`poll\` seconds or minutes, \`retry\` minutes. A field that is present and
unreadable refuses the machine rather than being guessed at. With no caps cell the defaults are
${MAX_RUNS} runs, step ${STEP_TIMEOUT_MS / 60_000}m, poll ${POLL_MS / 60_000}m, retry ${RETRY_MS / 60_000}m, park ${MAX_FAILURES}. The caps are re-read from the refreshed roster
every pass, so changing one is a control-room PR that lands on the next poll, not a release.

Two machines on one board each get their own caps, and each keeps its own retry and
subscription-reset deadlines. A run takes the issue's claim before it starts, so another machine's
poll sees the work is taken, except in the seconds an implement run hands that claim to the
session it starts.

Options: --repo OWNER/NAME · --json · --dry-run (enable and disable show what they would do)

The roster's table names its columns in a header row — \`| node | owner | worker | repos | caps |\`,
in any order, extra columns ignored — so a cell is read by what its column is called. A node is
\`<os-user>@<hostname>\`, derived and never configured. \`worker\` is the gate and the only cell that
grants anything: \`yes\` lets this machine work a board unattended, and anything else — including an
empty cell, a heading that only nearly says \`worker\`, and a roster with no such column — grants
nothing. An empty \`repos\` cell authorises nothing either; \`*\` or \`all\` must be said out loud.

A machine the control room's nodes.md does not name refuses every verb but disable. Writes
go out as the VegaFactory GitHub App, on an hour-long token minted here from its private key:
  ${appKeyPath()}
(VEGAFACTORY_APP_PRIVATE_KEY_FILE moves it, VEGAFACTORY_APP_ID names another App.) Each run gets
that token too, so everything it posts is the App's and none of it can pass as a person's word; it
is never given the key itself. The runs think on the operator's own subscription, so an API-key
variable in the environment refuses the command.
`
}

interface Args { verb: string; flags: Record<string, string>; json: boolean; dryRun: boolean; once: boolean }

export function parseDispatchArgs(argv: string[]): Args {
  const [verb, ...rest] = argv
  if (!verb) throw new Error('missing verb — run vegafactory dispatch --help')
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
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    flags[arg.slice(2)] = value
    i++
  }
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
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
  start?: ProcessStart
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  cli?: string[]
}

const wait = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  // A shutdown must not be held up by a two-minute sleep nobody is waiting for any more.
  timer.unref?.()
})

const appIdOf = (env: NodeJS.ProcessEnv) => env.VEGAFACTORY_APP_ID?.trim() || APP_ID

export async function runDispatch(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0]!)) { out(dispatchUsage()); return 0 }
  const args = parseDispatchArgs(argv)
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const host = deps.host ?? hostname()
  const platform = deps.platform ?? process.platform
  const root = repoRoot(cwd)
  const repo = assertRepo(args.flags.repo ?? detectRepo(root))
  const machine = machineName(host)
  // A verb that will act asks for a roster it has just proved; a read-only view shows what the
  // machine already has, so `status` still answers while the network is down.
  const listing = ['enable', 'run'].includes(args.verb)
    ? verifiedListing(root, { repo, host, home, git: deps.git })
    : listedHere(root, { repo, host, home })
  const keyPath = appKeyPath(env, home)
  const print = (value: unknown, text: string) => out(args.json ? JSON.stringify(value, null, 2) : text)

  // The first gate, before the roster and before anything is spawned or minted: a verb that can
  // start or probe an agent refuses outright while a variable that would bill it is set. The check
  // costs nothing, and running it later would already have spent paid credit on the probes.
  const STARTS_AGENTS = ['enable', 'run']
  if (STARTS_AGENTS.includes(args.verb)) {
    const billing = billingVariables(env)
    if (billing.length) {
      const [is, them] = billing.length === 1 ? ['is', 'it'] : ['are', 'them']
      print({ ok: false, billing }, `refused: ${billing.join(', ')} ${is} set — VegaFactory runs Claude Code and Codex on their subscriptions only; unset ${them} and retry`)
      return 2
    }
  }

  // The second gate: an unlisted machine does nothing but say so. `disable` is the exception, so a
  // machine taken off the roster can still take its own unit down.
  if (!listing.ok && args.verb !== 'disable') {
    print({ ok: false, machine, reason: listing.reason }, `refused: ${listing.reason}`)
    return 2
  }

  switch (args.verb) {
    case 'enable': {
      let keyOk = false
      let keyDetail = ''
      try {
        await mintToken({ repo, keyPath, appId: appIdOf(env), fetch: deps.fetch })
        keyOk = true
        keyDetail = `the App key at ${keyPath} mints an installation token for ${repo}`
      } catch (error) { keyDetail = (error as Error).message }
      const checks = readiness({ root, listing, run: deps.run ?? probe, keyOk, keyDetail, env })
      const path = unitPath(platform, home)
      if (!checks.every((check) => check.ok)) {
        print({ ok: false, checks }, `${renderChecks(checks)}\n\nnot ready — fix the FAIL lines above, then run this again`)
        return 2
      }
      const commands = serviceCommands(platform, path, 'enable')
      if (args.dryRun) {
        print({ ok: true, checks, unit: path, dryRun: true }, `${renderChecks(checks)}\n\ndry run: would write ${path}, then ${commands.map((command) => command.join(' ')).join(' && ')}`)
        return 0
      }
      mkdirSync(dispatchDir(root), { recursive: true })
      replaceFile(path, unitText(platform, { cli: deps.cli ?? cliPath(), root, repo, logDir: dispatchDir(root) }))
      const run = deps.run ?? probe
      for (const command of commands) {
        const result = run(command[0]!, command.slice(1))
        // launchctl answers non-zero for a label already loaded; the unit is installed either way.
        if (result.code !== 0 && !/already/i.test(result.stderr)) {
          print({ ok: false, unit: path, failed: command.join(' '), detail: result.stderr },
            `wrote ${path}, but \`${command.join(' ')}\` failed: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`)
          return 1
        }
      }
      const enabledCaps = listing.entry?.caps ?? DEFAULT_CAPS
      print({ ok: true, checks, unit: path, caps: enabledCaps },
        `${renderChecks(checks)}\n\nenabled — ${path} is loaded; this machine polls ${repo} every ${sayDuration(enabledCaps.pollMs, 'poll')}, ${enabledCaps.runs} runs at once`)
      return 0
    }
    case 'disable': {
      const path = unitPath(platform, home)
      const commands = serviceCommands(platform, path, 'disable')
      if (args.dryRun) {
        print({ dryRun: true, unit: path }, `dry run: would ${commands.map((command) => command.join(' ')).join(' && ')}, then delete ${path}`)
        return 0
      }
      const run = deps.run ?? probe
      const problems: string[] = []
      for (const command of commands) {
        const result = run(command[0]!, command.slice(1))
        if (result.code !== 0 && !/no such|not (?:find|loaded|exist)/i.test(result.stderr)) problems.push(`${command.join(' ')}: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`)
      }
      // Taking the unit away does not reach the agents it started: they were detached on purpose,
      // so the service could be restarted without killing a build. Disabling is not a restart.
      // Each record is proved to still be its own process before anything is signalled.
      const children = readChildren(root)
      const stopped = children.filter((record) => stopChild(root, record, { stop: deps.stop, start: deps.start }))
      rmSync(path, { force: true })
      const ended = stopped.length ? ` and stopped ${stopped.length} run${stopped.length === 1 ? '' : 's'} it had started` : ''
      // The stopped runs held claims and left their issues in-progress. This process has no App
      // token of its own — `disable` has to work on a machine that has just been de-listed — so it
      // names them instead of pretending to have cleaned up.
      const orphans = stopped.filter((record) => record.owner)
      const left = orphans.length
        ? `\nThese issues were left claimed by the runs that stopped; hand them back from a machine that can write:\n${orphans.map((record) => `  #${record.issue} (${record.action}, claimed by ${record.owner})`).join('\n')}`
        : ''
      print({ ok: problems.length === 0, unit: path, problems, stopped },
        (problems.length ? `removed ${path}${ended}, with: ${problems.join('; ')}` : `disabled — ${path} is unloaded and deleted${ended}`) + left)
      return problems.length ? 1 : 0
    }
    case 'status': {
      // Reading the board changes nothing, so it does not need the App: whoever runs this reads
      // with their own `gh`, and the key is only needed once the machine starts writing.
      const runner = deps.runner ?? defaultRunner
      const rows = board(repo, runner).map((issue) => ({
        number: issue.number, title: issue.title, url: issue.html_url,
        state: stateOf(issue.labels.map((label) => (typeof label === 'string' ? label : label.name))).state!,
      }))
      const runs = readRuns(root)
      const byState = new Map<string, number[]>()
      for (const row of rows) byState.set(row.state, [...(byState.get(row.state) ?? []), row.number])
      // An issue this machine has given up on is the one thing `status` must not leave out: it is
      // off the board as far as the dispatcher is concerned until a person looks at it.
      const parked = Object.entries(readActed(root))
        .filter(([key, entry]) => entry.failures >= (listing.entry?.caps ?? DEFAULT_CAPS).failures && key.startsWith(`${repo}#`))
        .map(([key, entry]) => ({ issue: Number(key.slice(key.indexOf('#') + 1)), action: entry.action, failures: entry.failures }))
      // What this machine is allowed to do, in the words of the row that allows it, so "why is it
      // doing that?" is answered without anyone opening the control room.
      const statusCaps = listing.entry?.caps ?? DEFAULT_CAPS
      const capsLine = `caps: ${statusCaps.runs} runs · step ${sayDuration(statusCaps.stepMs, 'step')} · poll ${sayDuration(statusCaps.pollMs, 'poll')} · retry ${sayDuration(statusCaps.retryMs, 'retry')} · park ${statusCaps.failures}`
      print({ repo, machine, listed: listing.ok, caps: statusCaps, board: rows, runs, parked }, [
        `${repo} · ${machine} · ${listing.ok ? 'listed to dispatch' : listing.reason}`,
        ...(listing.ok ? [capsLine] : []),
        ...[...byState].map(([state, numbers]) => `${state.padEnd(20)} ${numbers.map((number) => `#${number}`).join(' ')}`),
        ...(parked.length ? ['', `parked for a person: ${parked.map((row) => `#${row.issue} (${row.action} failed ${row.failures}×)`).join(', ')}`] : []),
        '',
        runs.length ? 'recent runs on this machine:' : 'no dispatcher runs on this machine yet',
        ...runs.map((run) => `${run.at}  #${run.issue} ${run.action.padEnd(12)} ${run.outcome.padEnd(8)} ${Math.round(run.ms / 1000)}s  ${run.note}`),
      ].join('\n'))
      return 0
    }
    case 'run': {
      // This process, named once: its claims carry it, and the lock below keeps it the only one.
      const runId = randomUUID().slice(0, 8)
      const lock = takeRunLock(root, runId, deps.start ?? processStart)
      if (!lock.ok) {
        print({ ok: false, reason: lock.reason }, `refused: ${lock.reason}`)
        return 2
      }
      let devMd = ''
      try { devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8') } catch { /* no profile, so the tools' own defaults */ }
      const identity = deps.runner ? null : appIdentity({ repo, keyPath, appId: appIdOf(env), fetch: deps.fetch })
      const runner = deps.runner ?? identity!.runner
      // `--json` puts exactly one document on stdout and nothing else, so every line this loop
      // would have printed is collected and leaves inside it. A caller that has to step over prose
      // to find the JSON is a caller that will one day step over the wrong line.
      //
      // That only works for a run that ends: an always-on loop would hold every line it ever
      // printed and emit them at shutdown, which is a leak and an answer nobody is waiting for.
      // So the document belongs to `--once`, and the service, which runs without `--json`, prints.
      if (args.json && !args.once) {
        print({ ok: false, reason: '--json reports one pass; use it with --once' },
          'refused: --json reports one pass and answers when that pass ends — add --once, or drop --json and read the lines the loop prints')
        releaseRunLock(root, runId)
        return 2
      }
      const notes: string[] = []
      const note = (text: string) => { if (args.json) notes.push(text); else out(text) }
      const finish = (code: number, runs: RunRecord[]) => {
        if (args.json) out(JSON.stringify({ machine, repo, runs, notes }, null, 2))
        releaseRunLock(root, runId)
        return code
      }
      // The row that authorised this machine also says what it may do while working it.
      const caps = listing.entry!.caps!
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
      const pollDeps: PollDeps = {
        root, repo, runner, machine, runId, caps, out: note, now: deps.now ?? Date.now,
        runStep: deps.runStep ?? defaultRunStep(devMd, env, { token: () => identity?.token() ?? null }), stop: deps.stop, start: deps.start,
        standDown: (number, reason, restoreTo) => standDown({ root, repo, number, runner, machine, restoreTo }, reason),
      }
      // Started steps outlive the pass that began them, so the next pass keeps their slots and
      // still acts on the rest of the board — a twenty-minute build does not stop the poll.
      const inflight = new Map<number, Inflight>()
      // Stopping means stopping: the agents this machine started are ended, their work saved and
      // their claims released. A dispatcher that walked away leaving three agents writing to
      // GitHub would be worse than one that never started.
      const shutDown = async (why: string) => {
        for (const [number, run] of inflight) {
          if (run.settled) continue
          note(`#${number} ${run.candidate.action} stopped: ${why}`)
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
        try {
          // The roster is the enrolment, so it is refreshed and re-read once per pass: a row
          // removed in a control-room PR stands this machine down at the next poll, with nothing
          // to log into, and a roster this machine cannot verify stops it just as firmly. One
          // reading, because two would each fetch and merge, and a second answer nobody acts on is
          // a gate that has been asked and ignored — the caps come off this same reading, so a
          // control-room PR that changes one lands on the next poll rather than on a restart.
          const still = verifiedListing(root, { repo, host, home, git: deps.git })
          if (!still.ok || !still.entry?.caps) {
            note(`stopping: ${still.reason}`)
            return finish(2, await shutDown('this machine is no longer listed'))
          }
          pollDeps.caps = still.entry.caps
          stepOutlivesToken(still.entry.caps)
          await identity?.freshen()
          for (const candidate of await poll(pollDeps, inflight)) note(`#${candidate.number} ${candidate.action} started`)
        } catch (error) {
          note(`poll failed: ${(error as Error).message}`)
        }
        if (args.once) return finish(0, await drain(inflight))
        await untilNextPass()
      }
    }
    default:
      throw new Error(`unknown dispatch verb: ${args.verb} — run vegafactory dispatch --help`)
  }
}

const cliPath = (): string[] => [process.execPath, process.argv[1] ?? 'vegafactory']

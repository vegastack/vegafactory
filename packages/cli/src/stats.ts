// `vegafactory stats collect|push|show` — usage numbers read from the harnesses' own session logs.
//
// Claude Code writes ~/.claude/projects/<slug>/<session>.jsonl, Codex writes
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Both are append-only, so every file is read from a
// saved byte offset: a session that was killed or abandoned is counted once, at the next run.
// One event per assistant turn — counts and identifiers only, never a prompt, a file, tool
// arguments or the subscription owner.
//
// Three rules keep the numbers honest. Collection holds one interprocess lock and commits through
// a journal, so an interrupted run replays instead of double-counting. An event id is stable per
// turn and a later line for the same turn appends a corrected copy with a higher revision, so
// readers take the newest record per id. The push writes only inside the control-room clone, only
// along real directories, and journals what it is about to do, so a death mid-push neither loses
// turns nor files them twice.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants as fsConstants, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { factoryConfigPath, parseControlRoomKnob, readFactoryConfig, type ControlRoomEntry } from './control-room.ts'
import { defaultRunner, ghRequest, type GhRunner } from './gh.ts'
import { issueFromBranch, issueFromWorktree } from './hook.ts'
import { cacheDir, readState, withLock } from './issue-cache.ts'
import { stateOf } from './labels.ts'
import { GIT_CREDENTIAL_ARGS } from './sync.ts'

export type Harness = 'claude' | 'codex'

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface StatsEvent {
  id: string
  // Rises each time a later line completes this turn; readers keep the highest revision per id.
  rev: number
  at: string
  operator: string
  machine: string
  harness: Harness
  model: string
  repo: string | null
  issue: number | null
  // The issue's workflow state when the turn was collected, for time per stage.
  state: string | null
  skill: string | null
  tokens: Tokens
  durationMs: number
  outcome: string
}

// A turn that took longer than this is idle time between turns, not work.
const MAX_TURN_MS = 10 * 60_000
// Per file, per pass: the rest is read in the next pass, so one huge log never stalls a session.
const MAX_SLICE_BYTES = 8 * 1024 * 1024
const PASSES_PER_FILE = 4
// A single record longer than this is not a turn — it is stepped over rather than re-read for ever.
const MAX_RECORD_BYTES = 64 * 1024 * 1024
const OPERATOR_TTL_MS = 12 * 60 * 60_000
export const PUSH_EVERY_MS = 60 * 60_000

export const statsDir = (home: string) => join(home, '.vegastack', '.tmp', 'stats')
const offsetsPath = (home: string) => join(statsDir(home), 'offsets.json')
const eventsPath = (home: string) => join(statsDir(home), 'events.jsonl')
const journalPath = (home: string) => join(statsDir(home), 'pending.json')
const pushPath = (home: string) => join(statsDir(home), 'push.json')
// One journal per control room: a crash pushing to one room must never be replayed against another.
const pushJournalPath = (home: string, room: string) => join(statsDir(home), 'push-pending', `${room.replace('/', '__')}.json`)
const identityPath = (home: string) => join(statsDir(home), 'identity.json')

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function readAt(path: string, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  const handle = openSync(path, 'r')
  try {
    const read = readSync(handle, buffer, 0, length, position)
    return buffer.subarray(0, read)
  } finally { closeSync(handle) }
}

// Appends without ever following a symlink: a link left where a stats file belongs must fail, not
// redirect the write.
function appendLines(path: string, text: string) {
  const handle = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600)
  try { writeSync(handle, text) } finally { closeSync(handle) }
}

// ---------------------------------------------------------------------------------------------
// Where a turn happened: repository, issue and the issue's workflow state, from the log's own cwd
// and branch. Filesystem only — a collect run never reaches the network for this.

export interface Site { repo: string | null; issue: number | null; state: string | null }
export type SiteLookup = (cwd: string | null, branch: string | null, repo?: string | null) => Site

export function canonicalRepo(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote.trim())
  return match?.[1] ?? null
}

function repoRootOf(dir: string): string | null {
  let at = dir
  for (let depth = 0; depth < 40; depth++) {
    if (existsSync(join(at, '.git'))) return at
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
  return null
}

// The main checkout and the repository name, the way the rest of the CLI reads them: `.git` is a
// directory in a checkout and a file pointing into the main one in a worktree, the `repo:` line of
// dev.md wins over the origin URL, and the folder name is the last resort.
export function checkoutOf(dir: string): { root: string | null; repo: string | null } {
  const root = repoRootOf(dir)
  if (!root) return { root: null, repo: null }
  let main = root
  try {
    let gitDir = join(root, '.git')
    if (statSync(gitDir).isFile()) {
      const pointer = /gitdir:\s*(.+)/.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim()
      if (pointer) {
        gitDir = pointer.replace(/[/\\]worktrees[/\\][^/\\]+[/\\]?$/, '')
        main = dirname(gitDir)
      }
    }
    try {
      const named = /^repo:\s*([\w.-]+\/[\w.-]+)/m.exec(readFileSync(join(main, '.vegastack', 'dev.md'), 'utf8'))?.[1]
      if (named) return { root: main, repo: named }
    } catch { /* no dev.md: the origin URL answers */ }
    const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(readFileSync(join(gitDir, 'config'), 'utf8'))?.[1]
    const remote = url ? canonicalRepo(url) : null
    if (remote) return { root: main, repo: remote }
  } catch { /* an unreadable checkout is named after its folder */ }
  return { root: main, repo: basename(main) }
}

export function defaultSite(): SiteLookup {
  const repos = new Map<string, { repo: string | null; root: string | null }>()
  const states = new Map<string, string | null>()
  return (cwd, branch, known) => {
    const issue = (cwd ? issueFromWorktree(cwd) : null) ?? (branch ? issueFromBranch(branch) : null)
    if (!cwd) return { repo: known ?? null, issue, state: null }
    let place = repos.get(cwd)
    if (!place) {
      place = checkoutOf(cwd)
      repos.set(cwd, place)
    }
    const repo = known ?? place.repo
    if (!place.root || !issue || !repo) return { repo, issue, state: null }
    const key = `${place.root}|${repo}|${issue}`
    if (!states.has(key)) {
      let state: string | null = null
      try { state = stateOf(readState(cacheDir(place.root, repo, issue))?.issue?.labels ?? []).state } catch { /* no local copy of the issue */ }
      states.set(key, state)
    }
    return { repo, issue, state: states.get(key) ?? null }
  }
}

// ---------------------------------------------------------------------------------------------
// Which skill a turn used. A harness records whatever the model passed it, so the name is kept
// only when it is a real skill: the right shape *and* an actual SKILL.md under a skill root this
// machine installs into. Anything else — a tool argument that merely looks like a name, a made-up
// one, a customer's identifier — is dropped rather than carried into the control room.

export type SkillLookup = (value: unknown) => string | null

const SKILL_PATH = /skills\/([a-z0-9][a-z0-9._-]*)\/SKILL\.md/
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/

// The shape a skill name must have. Necessary, never sufficient.
export function skillName(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && SKILL_NAME.test(value) ? value : null
}

export function skillRoots(home: string): string[] {
  // The bundle that ships with this CLI, then the two directories `skills add` installs into.
  const bundle = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skill')
  return [bundle, join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]
}

export function skillResolver(home: string, roots = skillRoots(home)): SkillLookup {
  const known = new Map<string, string | null>()
  return (value) => {
    const name = skillName(value)
    if (name === null) return null
    if (known.has(name)) return known.get(name)!
    const installed = roots.some((root) => {
      try { return lstatSync(join(root, name, 'SKILL.md')).isFile() } catch { return false }
    })
    known.set(name, installed ? name : null)
    return installed ? name : null
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing. Each parser reads a slice of one log and reports how many bytes of whole lines it
// consumed; `carry` holds what the next slice of the same file still needs — the Codex model and
// repository arrive once at the top, the turn boundary the next duration is measured from, and the
// last event emitted, so a line that belongs to it in a later slice corrects it instead of
// vanishing. `carry` rides along in offsets.json.

export interface Carry {
  last?: number | null
  model?: string | null
  cwd?: string | null
  branch?: string | null
  repo?: string | null
  session?: string | null
  skill?: string | null
  pending?: { key: string; event: StatsEvent } | null
}

export interface ParseContext { operator: string; machine: string; carry: Carry; site: SiteLookup; skill: SkillLookup }
export interface ParseResult { events: StatsEvent[]; consumed: number }

// A turn already written down, and whether this slice has already appended it.
interface Known { event: StatsEvent; fresh: boolean }

function opened(carry: Carry): Map<string, Known> {
  const known = new Map<string, Known>()
  if (carry.pending?.key) known.set(carry.pending.key, { event: structuredClone(carry.pending.event), fresh: false })
  return known
}

// Applies a late line to a turn already emitted: an in-slice event is edited in place, a turn from
// an earlier slice gets a corrected copy appended under the next revision, which readers keep.
function correct(known: Known, events: StatsEvent[], change: (event: StatsEvent) => void) {
  const before = JSON.stringify(known.event)
  change(known.event)
  if (known.fresh || JSON.stringify(known.event) === before) return
  known.event.rev = (known.event.rev ?? 1) + 1
  events.push(known.event)
  known.fresh = true
}

function span(from: number | null | undefined, at: number): number {
  if (from === null || from === undefined) return 0
  const gap = at - from
  return gap > 0 && gap < MAX_TURN_MS ? gap : 0
}

// Whole lines only: a log being written while it is read ends mid-line.
function wholeLines(text: string): { lines: string[]; consumed: number } {
  const end = text.lastIndexOf('\n')
  if (end === -1) return { lines: [], consumed: 0 }
  return { lines: text.slice(0, end).split('\n'), consumed: Buffer.byteLength(text.slice(0, end + 1)) }
}

export function parseClaude(text: string, context: ParseContext): ParseResult {
  const { lines, consumed } = wholeLines(text)
  const events: StatsEvent[] = []
  const carry = context.carry
  // One assistant turn is written as one line per content block, all under the same message id and
  // all repeating that turn's usage: the first line opens the event, the rest only add to it.
  const known = opened(carry)
  for (const line of lines) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const at = Date.parse(String(entry.timestamp ?? ''))
    if (!Number.isFinite(at)) continue
    // A turn is timed from its boundary — the prompt or tool result that started it, or the turn
    // before it. Snapshots, queue records and the turn's own extra lines never move that clock.
    if (entry.type === 'user') { carry.last = at; continue }
    if (entry.type !== 'assistant') continue
    const message = entry.message as { id?: string; model?: string; stop_reason?: string; usage?: Record<string, unknown>; content?: Array<Record<string, unknown>> } | undefined
    // A synthetic assistant message is Claude Code's own text (an API error, a cancel), not a turn.
    if (!message?.id || !message.usage || !message.model || message.model.startsWith('<')) continue
    const id = hash(`claude|${String(entry.sessionId ?? '')}|${message.id}`)
    const call = (message.content ?? []).find((block) => block.type === 'tool_use' && block.name === 'Skill')
    const chosen = context.skill((call?.input as { skill?: unknown } | undefined)?.skill)
    const already = known.get(message.id)
    if (already) {
      correct(already, events, (event) => {
        event.outcome = String(message.stop_reason ?? event.outcome)
        event.skill ??= chosen
      })
      carry.pending = { key: message.id, event: already.event }
      continue
    }
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : null
    const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch : null
    const site = context.site(cwd, branch)
    const event: StatsEvent = {
      id, rev: 1, at: new Date(at).toISOString(), operator: context.operator, machine: context.machine, harness: 'claude',
      model: message.model, repo: site.repo, issue: site.issue, state: site.state, skill: chosen,
      tokens: {
        input: count(message.usage.input_tokens), output: count(message.usage.output_tokens),
        cacheRead: count(message.usage.cache_read_input_tokens), cacheWrite: count(message.usage.cache_creation_input_tokens),
      },
      durationMs: span(carry.last, at), outcome: String(message.stop_reason ?? 'unknown'),
    }
    events.push(event)
    known.set(message.id, { event, fresh: true })
    carry.pending = { key: message.id, event }
    carry.last = at
  }
  return { events, consumed }
}

export function parseCodex(text: string, context: ParseContext): ParseResult {
  const { lines, consumed } = wholeLines(text)
  const events: StatsEvent[] = []
  const carry = context.carry
  // Keyed by turn id, so `task_complete` can name how the turn ended even a slice later.
  const known = opened(carry)
  for (const line of lines) {
    if (!line) continue
    let entry: { type?: string; timestamp?: string; payload?: Record<string, unknown> }
    try { entry = JSON.parse(line) as typeof entry } catch { continue }
    const at = Date.parse(String(entry.timestamp ?? ''))
    if (!Number.isFinite(at)) continue
    const payload = entry.payload ?? {}
    // A response is timed from when the model could start writing it: the turn's start or the
    // previous tool output. Codex logs its token record next to the tool call it just wrote, so
    // timing it from the line before would report nothing.
    if ((entry.type === 'event_msg' && payload.type === 'task_started') || (entry.type === 'response_item' && String(payload.type ?? '').endsWith('_output'))) carry.last = at
    if (entry.type === 'session_meta') {
      carry.session = typeof payload.session_id === 'string' ? payload.session_id : null
      carry.cwd = typeof payload.cwd === 'string' ? payload.cwd : null
      const git = payload.git as { repository_url?: string; branch?: string } | undefined
      carry.repo = git?.repository_url ? canonicalRepo(git.repository_url) : null
      carry.branch = git?.branch ?? null
      continue
    }
    if (entry.type === 'turn_context') {
      if (typeof payload.model === 'string') carry.model = payload.model
      if (typeof payload.cwd === 'string') carry.cwd = payload.cwd
      continue
    }
    if (entry.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
      // Codex has no Skill tool: a skill is used by reading its SKILL.md. Only a name that resolves
      // to an installed skill is kept — the rest of the command is never looked at again.
      const call = `${typeof payload.input === 'string' ? payload.input : ''}${typeof payload.arguments === 'string' ? payload.arguments : ''}`
      const found = context.skill(SKILL_PATH.exec(call)?.[1])
      if (found) carry.skill = found
      continue
    }
    if (entry.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      const turn = known.get(String(payload.turn_id ?? ''))
      if (turn) correct(turn, events, (event) => { event.outcome = payload.type === 'task_complete' ? 'end_turn' : 'aborted' })
      continue
    }
    if (entry.type !== 'token_usage_record') continue
    const usage = payload.usage as Record<string, unknown> | undefined
    if (!usage) continue
    const site = context.site(carry.cwd ?? null, carry.branch ?? null, carry.repo ?? null)
    // Codex counts cached tokens inside input_tokens; Claude reports them separately. Subtracting
    // here makes the four numbers mean the same thing in both harnesses.
    const cacheRead = count(usage.cached_input_tokens)
    const event: StatsEvent = {
      id: hash(`codex|${carry.session ?? ''}|${String(payload.response_id ?? '')}`), rev: 1,
      at: new Date(at).toISOString(), operator: context.operator, machine: context.machine, harness: 'codex',
      model: carry.model ?? 'unknown', repo: site.repo, issue: site.issue, state: site.state, skill: carry.skill ?? null,
      tokens: {
        input: Math.max(0, count(usage.input_tokens) - cacheRead), output: count(usage.output_tokens),
        cacheRead, cacheWrite: count(usage.cache_write_input_tokens),
      },
      durationMs: span(carry.last, at), outcome: 'tool_use',
    }
    events.push(event)
    carry.last = at
    carry.skill = null
    const turn = String(payload.turn_id ?? '')
    known.set(turn, { event, fresh: true })
    carry.pending = { key: turn, event }
  }
  return { events, consumed }
}

// ---------------------------------------------------------------------------------------------
// Collecting

export interface FileState {
  offset: number
  size: number
  // The file's identity and a fingerprint of the bytes already read: either one changing means the
  // path holds a different file (replaced, truncated, rewritten), which is read from the start.
  ino: number
  dev: number
  tail: string
  carry: Carry
}
export interface Offsets { schema: 1; files: Record<string, FileState> }

export function sessionLogs(home: string): Array<{ path: string; harness: Harness }> {
  const found: Array<{ path: string; harness: Harness }> = []
  const projects = join(home, '.claude', 'projects')
  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const file of readdirSync(join(projects, entry.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl')) found.push({ path: join(projects, entry.name, file.name), harness: 'claude' })
      }
    }
  } catch { /* Claude Code is not installed here */ }
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) found.push({ path, harness: 'codex' })
    }
  }
  try { walk(join(home, '.codex', 'sessions'), 0) } catch { /* Codex is not installed here */ }
  return found
}

const TAIL_BYTES = 512

// The fingerprint of the last bytes already consumed.
function tailOf(path: string, offset: number): string {
  if (offset <= 0) return ''
  const from = Math.max(0, offset - TAIL_BYTES)
  return hash(readAt(path, from, offset - from).toString('latin1'))
}

export function resumable(path: string, saved: FileState | undefined, info: { ino: number; dev: number; size: number }): boolean {
  if (!saved || !saved.offset) return false
  if (saved.ino !== info.ino || saved.dev !== info.dev) return false
  if (info.size < saved.offset) return false
  return tailOf(path, saved.offset) === saved.tail
}

export interface Slice { text: string; skipped: number }

// The next whole lines at `offset`. A record too long for one slice is stepped over: nothing in a
// session log is a turn at that size, and re-reading the same bytes for ever would stall collection.
export function sliceAt(path: string, offset: number, size: number): Slice {
  const window = Math.min(size - offset, MAX_SLICE_BYTES)
  const buffer = readAt(path, offset, window)
  const end = buffer.lastIndexOf(0x0a)
  if (end !== -1) return { text: buffer.subarray(0, end + 1).toString('utf8'), skipped: 0 }
  let at = offset + buffer.length
  while (at < size) {
    const chunk = readAt(path, at, Math.min(size - at, MAX_SLICE_BYTES))
    if (!chunk.length) break
    const newline = chunk.indexOf(0x0a)
    if (newline !== -1) return { text: '', skipped: at + newline + 1 - offset }
    at += chunk.length
    if (at - offset >= MAX_RECORD_BYTES) return { text: '', skipped: MAX_RECORD_BYTES }
  }
  // No newline yet: the record is still being written, so it waits.
  return { text: '', skipped: 0 }
}

export interface CollectOptions {
  home?: string
  machine?: string
  operator?: string
  runner?: GhRunner
  now?: () => number
  site?: SiteLookup
  skill?: SkillLookup
}

export interface CollectResult { files: number; events: number; bytes: number }

// The gh login, asked at most twice a day and kept on disk: every event carries it, and a collect
// run must not depend on the network.
export function resolveOperator(home: string, runner: GhRunner, now: number): string {
  const saved = readJson<{ login?: string; at?: number }>(identityPath(home), {})
  if (saved.login && typeof saved.at === 'number' && now - saved.at < OPERATOR_TTL_MS && now >= saved.at) return saved.login
  try {
    const login = ghRequest<{ login?: string }>('user', { runner }).body.login
    if (login) {
      atomicWrite(identityPath(home), JSON.stringify({ login, at: now }) + '\n')
      return login
    }
  } catch { /* offline or logged out: the last known login stands */ }
  return saved.login ?? 'unknown'
}

// A run interrupted between the append and the offsets leaves both in the journal. The append is
// sequential, so whatever of it already landed is at the end of the file: the rest is appended and
// the offsets are committed, and the batch is neither lost nor counted twice.
function repairEvents(home: string) {
  try {
    const size = statSync(eventsPath(home)).size
    if (!size || readAt(eventsPath(home), size - 1, 1).toString() === '\n') return
    const text = readFileSync(eventsPath(home), 'utf8')
    const end = text.lastIndexOf('\n')
    truncateSync(eventsPath(home), end === -1 ? 0 : Buffer.byteLength(text.slice(0, end + 1)))
  } catch { /* nothing written yet */ }
}

function tailLines(home: string, wanted: number): string[] {
  try { return readFileSync(eventsPath(home), 'utf8').split('\n').filter(Boolean).slice(-wanted) } catch { return [] }
}

function recover(home: string) {
  const pending = readJson<{ events?: StatsEvent[]; offsets?: Offsets } | null>(journalPath(home), null)
  if (!pending?.events || !pending.offsets) {
    rmSync(journalPath(home), { force: true })
    return
  }
  repairEvents(home)
  const rows = pending.events.map((event) => JSON.stringify(event))
  const tail = tailLines(home, rows.length)
  let landed = 0
  for (let take = Math.min(rows.length, tail.length); take > 0; take--) {
    if (tail.slice(-take).join('\n') === rows.slice(0, take).join('\n')) { landed = take; break }
  }
  if (landed < rows.length) appendLines(eventsPath(home), rows.slice(landed).join('\n') + '\n')
  atomicWrite(offsetsPath(home), JSON.stringify(pending.offsets, null, 2) + '\n')
  rmSync(journalPath(home), { force: true })
}

function commit(home: string, events: StatsEvent[], offsets: Offsets) {
  if (events.length) {
    atomicWrite(journalPath(home), JSON.stringify({ events, offsets }))
    appendLines(eventsPath(home), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
  atomicWrite(offsetsPath(home), JSON.stringify(offsets, null, 2) + '\n')
  rmSync(journalPath(home), { force: true })
}

export function collectStats(options: CollectOptions = {}): CollectResult {
  const home = options.home ?? homedir()
  mkdirSync(statsDir(home), { recursive: true })
  // One collector at a time on this machine: two hooks reading the same logs would append the same
  // turns twice and then overwrite each other's offsets.
  return withLock(statsDir(home), () => collectLocked(home, options))
}

function collectLocked(home: string, options: CollectOptions): CollectResult {
  recover(home)
  const now = options.now ?? Date.now
  const machine = options.machine ?? hostname()
  const operator = options.operator ?? resolveOperator(home, options.runner ?? defaultRunner, now())
  const site = options.site ?? defaultSite()
  const skill = options.skill ?? skillResolver(home)
  const offsets = readJson<Offsets>(offsetsPath(home), { schema: 1, files: {} })
  if (offsets.schema !== 1 || !offsets.files) throw new Error(`unsupported stats offsets in ${offsetsPath(home)} — delete it`)
  const collected: StatsEvent[] = []
  let files = 0
  let bytes = 0
  for (const log of sessionLogs(home)) {
    let info: { ino: number; dev: number; size: number }
    try { info = statSync(log.path) } catch { continue }
    const saved = offsets.files[log.path]
    const state: FileState = resumable(log.path, saved, info)
      ? { ...saved!, size: info.size }
      : { offset: 0, size: info.size, ino: info.ino, dev: info.dev, tail: '', carry: {} }
    let read = 0
    for (let pass = 0; pass < PASSES_PER_FILE && state.offset < info.size; pass++) {
      let slice: Slice
      try { slice = sliceAt(log.path, state.offset, info.size) } catch { break }
      if (slice.skipped) { state.offset += slice.skipped; continue }
      if (!slice.text) break
      const context: ParseContext = { operator, machine, carry: state.carry ?? {}, site, skill }
      const result = log.harness === 'claude' ? parseClaude(slice.text, context) : parseCodex(slice.text, context)
      collected.push(...result.events)
      state.carry = context.carry
      state.offset += result.consumed
      read += result.consumed
      if (!result.consumed) break
    }
    if (state.offset !== (saved?.offset ?? 0) || !saved) files += 1
    bytes += read
    state.tail = tailOf(log.path, state.offset)
    offsets.files[log.path] = state
  }
  commit(home, collected, offsets)
  return { files, events: collected.length, bytes }
}

// ---------------------------------------------------------------------------------------------
// Reading events back: whatever every operator pushed into the control-room clones this machine
// keeps, then this machine's own file. The newest revision of an id wins, so a turn corrected here
// but not pushed yet still reads as its finished self.

function parseEvents(text: string, into: Map<string, StatsEvent>, since: number | null) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: StatsEvent
    try { event = JSON.parse(line) as StatsEvent } catch { continue }
    if (!event?.id || !event.at) continue
    if (since !== null && Date.parse(event.at) < since) continue
    const seen = into.get(event.id)
    if (seen && (seen.rev ?? 0) > (event.rev ?? 0)) continue
    into.set(event.id, event)
  }
}

// Every entry is judged by lstat, so a symlink is never walked into or read through.
function jsonlUnder(dir: string, depth = 0): string[] {
  if (depth > 6) return []
  const found: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...jsonlUnder(path, depth + 1))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  } catch { /* no such tree */ }
  return found
}

export function controlRoomStatsDirs(home: string): string[] {
  try {
    const config = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8'))
    return Object.values(config.controlRooms)
      .filter((entry) => safeClonePath(home, entry.path) === null)
      .map((entry) => join(entry.path, 'stats'))
      .filter((dir) => { try { return lstatSync(dir).isDirectory() } catch { return false } })
  } catch { return [] }
}

export function loadEvents(home: string, { since = null as number | null, local = true, shared = true } = {}): StatsEvent[] {
  const events = new Map<string, StatsEvent>()
  if (shared) {
    for (const dir of controlRoomStatsDirs(home)) {
      for (const file of jsonlUnder(dir)) {
        try { parseEvents(readFileSync(file, 'utf8'), events, since) } catch { /* unreadable file */ }
      }
    }
  }
  if (local) {
    try { parseEvents(readFileSync(eventsPath(home), 'utf8'), events, since) } catch { /* nothing collected yet */ }
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at))
}

// `--since 7d`, `--since 12h`, `--since 30m` or a date.
export function parseSince(value: string, now: number): number {
  const span = /^(\d+)([mhdw])$/.exec(value.trim())
  if (span) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[span[2] as 'm' | 'h' | 'd' | 'w']
    return now - Number(span[1]) * unit
  }
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new Error(`--since wants 7d, 12h, 30m or a date, not ${value}`)
  return at
}

// ---------------------------------------------------------------------------------------------
// Summaries, shared by `stats show` and the dashboard.

export interface Bucket {
  key: string
  turns: number
  tokens: Tokens
  durationMs: number
  operators: string[]
  harnesses: string[]
  models: string[]
  repos: string[]
  issues: string[]
  skills: string[]
  state: string | null
  last: string
}

function add(into: Tokens, from: Tokens): Tokens {
  into.input += from.input ?? 0
  into.output += from.output ?? 0
  into.cacheRead += from.cacheRead ?? 0
  into.cacheWrite += from.cacheWrite ?? 0
  return into
}

export const totalTokens = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

export function group(events: StatsEvent[], keyOf: (event: StatsEvent) => string | null): Bucket[] {
  const buckets = new Map<string, Bucket & { sets: Record<string, Set<string>> }>()
  for (const event of events) {
    const key = keyOf(event)
    if (key === null) continue
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        key, turns: 0, tokens: zero(), durationMs: 0, operators: [], harnesses: [], models: [], repos: [], issues: [], skills: [],
        state: null, last: event.at,
        sets: { operators: new Set(), harnesses: new Set(), models: new Set(), repos: new Set(), issues: new Set(), skills: new Set() },
      }
      buckets.set(key, bucket)
    }
    bucket.turns += 1
    add(bucket.tokens, event.tokens ?? zero())
    bucket.durationMs += event.durationMs ?? 0
    bucket.sets.operators!.add(event.operator)
    bucket.sets.harnesses!.add(event.harness)
    bucket.sets.models!.add(event.model)
    if (event.repo) bucket.sets.repos!.add(event.repo)
    if (event.issue) bucket.sets.issues!.add(`${event.repo ?? '?'}#${event.issue}`)
    if (event.skill) bucket.sets.skills!.add(event.skill)
    if (event.at >= bucket.last) {
      bucket.last = event.at
      if (event.state) bucket.state = event.state
    }
  }
  return [...buckets.values()].map(({ sets, ...bucket }) => ({
    ...bucket,
    operators: [...sets.operators!].sort(), harnesses: [...sets.harnesses!].sort(), models: [...sets.models!].sort(),
    repos: [...sets.repos!].sort(), issues: [...sets.issues!].sort(), skills: [...sets.skills!].sort(),
  })).sort((a, b) => b.turns - a.turns || a.key.localeCompare(b.key))
}

export interface Summary {
  from: string | null
  to: string | null
  turns: number
  tokens: Tokens
  durationMs: number
  operators: Bucket[]
  projects: Bucket[]
  issues: Bucket[]
  models: Bucket[]
  skills: Bucket[]
  days: Bucket[]
  stages: Bucket[]
  operatorModels: Bucket[]
  projectModels: Bucket[]
}

export function summarize(events: StatsEvent[]): Summary {
  const tokens = zero()
  let durationMs = 0
  for (const event of events) { add(tokens, event.tokens ?? zero()); durationMs += event.durationMs ?? 0 }
  return {
    from: events[0]?.at ?? null,
    to: events.at(-1)?.at ?? null,
    turns: events.length,
    tokens,
    durationMs,
    operators: group(events, (event) => event.operator || 'unknown'),
    projects: group(events, (event) => event.repo),
    issues: group(events, (event) => (event.issue ? `${event.repo ?? '?'}#${event.issue}` : null)),
    models: group(events, (event) => `${event.harness} · ${event.model}`),
    skills: group(events, (event) => event.skill),
    days: group(events, (event) => event.at.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
    stages: group(events, (event) => event.state),
    operatorModels: group(events, (event) => `${event.operator} · ${event.model}`),
    projectModels: group(events, (event) => (event.repo ? `${event.repo} · ${event.model}` : null)),
  }
}

export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}G`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: string[]) => cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

const bucketRow = (bucket: Bucket): string[] => [
  bucket.key, String(bucket.turns), compact(bucket.tokens.input), compact(bucket.tokens.output),
  compact(bucket.tokens.cacheRead), compact(bucket.tokens.cacheWrite), duration(bucket.durationMs),
]
const HEADERS = ['', 'turns', 'in', 'out', 'cache r', 'cache w', 'time']

export function renderShow(summary: Summary): string {
  if (!summary.turns) return 'no turns collected yet — run "vegafactory stats collect" after a session'
  const parts = [
    `${summary.from?.slice(0, 10)} → ${summary.to?.slice(0, 10)} · ${summary.turns} turns · ${compact(totalTokens(summary.tokens))} tokens · ${duration(summary.durationMs)}`,
    '',
    table(['operator', ...HEADERS.slice(1)], summary.operators.map(bucketRow)),
    '',
    table(['project', ...HEADERS.slice(1)], summary.projects.map(bucketRow)),
    '',
    table(['model', ...HEADERS.slice(1)], summary.models.map(bucketRow)),
  ]
  if (summary.stages.length) parts.push('', table(['stage', ...HEADERS.slice(1)], summary.stages.map(bucketRow)))
  if (summary.skills.length) parts.push('', table(['skill', ...HEADERS.slice(1)], summary.skills.map(bucketRow)))
  return parts.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Pushing to the control room: one file per operator, per machine, per day, appended in the clone
// `vegafactory sync` already keeps, committed and pushed with the operator's own gh credentials.
// The clone belongs to sync, so this must hand it back exactly as it found it: the clone is checked
// before anything is written, only the generated files are staged, and a failure puts them back.

// One cursor per control room, never one for the machine: a turn that belongs to room A must not
// be marked sent because room B's push walked past it.
export interface RoomCursor { lastPushAt?: number; offset?: number }
export interface PushState { rooms?: Record<string, RoomCursor> }
export interface PushResult { ok: boolean; action: 'pushed' | 'committed' | 'skipped' | 'none' | 'refused'; events: number; paths: string[]; message: string }

// Which control room a journal or cursor belongs to. A journal is only ever applied to the clone it
// names, revalidated against what is on disk now.
export interface RoomIdentity { repo: string; remote: string; branch: string; path: string }

// What a push is about to do, written down before it touches anything: enough to finish the job or
// undo it after a death in the middle.
interface PushJournal {
  token: string
  at: number
  offset: number
  room: RoomIdentity
  files: Array<{ relative: string; had: number | null }>
}

function validJournal(value: unknown): PushJournal | null {
  const journal = value as PushJournal | null
  if (!journal || typeof journal !== 'object') return null
  const { token, at, offset, room, files } = journal
  if (typeof token !== 'string' || !token || !Number.isFinite(at)) return null
  if (!Number.isSafeInteger(offset) || offset < 0) return null
  if (!room || typeof room !== 'object' || ['repo', 'remote', 'branch', 'path'].some((key) => typeof (room as unknown as Record<string, unknown>)[key] !== 'string')) return null
  if (!Array.isArray(files) || !files.length) return null
  for (const file of files) {
    if (!file || typeof file.relative !== 'string' || !file.relative.startsWith('stats/')) return null
    if (file.had !== null && (!Number.isSafeInteger(file.had) || file.had < 0)) return null
  }
  return journal
}

export type GitRunner = (args: string[]) => { code: number; out: string }

export const defaultGit: GitRunner = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

const safe = (value: string) => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'unknown'

// The repository this session is in, with a worktree path folded back to its main checkout.
export function repoRootFor(cwd: string): string | null {
  const worktree = /^(.*)[/\\]\.vegastack[/\\]\.worktrees[/\\][^/\\]+$/.exec(cwd)
  return repoRootOf(worktree?.[1] ?? cwd)
}

// Every component of a path is judged by lstat, never followed.
function realPathTo(path: string, from: string): string | null {
  let cursor = from
  for (const part of path.slice(from.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    let info
    try { info = lstatSync(cursor) } catch { return `nothing at ${cursor}` }
    if (info.isSymbolicLink()) return `refusing a symlinked path: ${cursor}`
  }
  return null
}

// A control-room clone is only ever read or written where sync puts it: a canonical absolute path
// inside this machine's control-room store, with no symlink anywhere along it. Returns the reason
// it is not usable, or null when it is.
export function safeClonePath(home: string, path: unknown): string | null {
  const store = join(home, '.vegastack', 'control-room')
  if (typeof path !== 'string' || !path || !isAbsolute(path) || resolve(path) !== path) return 'the control-room path is not absolute and canonical'
  if (path !== store && !path.startsWith(store + sep)) return `the control-room clone is outside ${store}`
  const walked = realPathTo(path, parsePath(path).root)
  if (walked) return walked.startsWith('nothing at') ? `no control-room clone at ${path}` : walked
  return null
}

// A file this push may append to: every directory below the clone must be a real directory, and an
// existing file must be a regular file. A tracked symlink under stats/ would otherwise redirect the
// write out of the clone.
export function safeStatsPath(clone: string, relative: string): string | null {
  const parts = relative.split('/')
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.includes(sep) || isAbsolute(part))) return `unusable stats path: ${relative}`
  let cursor = clone
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part)
    let info
    try { info = lstatSync(cursor) } catch { continue }
    if (info.isSymbolicLink()) return `refusing a symlinked stats path: ${cursor}`
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) return `stats path is not a ${index < parts.length - 1 ? 'directory' : 'regular file'}: ${cursor}`
  }
  return null
}

interface Clone { path: string; branch: string; remote: string; repo: string }

const identityOf = (clone: Clone): RoomIdentity => ({ repo: clone.repo, remote: clone.remote, branch: clone.branch, path: clone.path })
const sameRoom = (a: RoomIdentity, b: RoomIdentity) => a.repo === b.repo && a.remote === b.remote && a.branch === b.branch && a.path === b.path

// Puts generated rows back exactly as they were, through checks a journal cannot talk its way out
// of: every path is re-validated against the clone, a truncation goes through a no-follow handle,
// and the sizes and the clone's own cleanliness are read back afterwards. Returns why it could not.
function restoreFiles(clone: Clone, files: PushJournal['files'], git: GitRunner): string | null {
  for (const file of files) {
    const unsafe = safeStatsPath(clone.path, file.relative)
    if (unsafe) return unsafe
  }
  for (const file of files) {
    const path = join(clone.path, ...file.relative.split('/'))
    let info
    try { info = lstatSync(path) } catch { info = null }
    try {
      if (file.had === null) {
        if (info?.isFile()) rmSync(path)
      } else if (info?.isFile()) {
        const handle = openSync(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW)
        try { ftruncateSync(handle, file.had) } finally { closeSync(handle) }
      }
    } catch (error) {
      return `the control-room clone could not be put back (${file.relative}: ${(error as Error).message})`
    }
  }
  const reset = git(['-C', clone.path, 'reset', '--quiet', '--', ...files.map((file) => file.relative)])
  if (reset.code !== 0) return `the control-room index could not be put back: ${reset.out.split('\n')[0]}`
  for (const file of files) {
    const path = join(clone.path, ...file.relative.split('/'))
    let size: number | null = null
    try { size = lstatSync(path).isFile() ? statSync(path).size : -1 } catch { size = null }
    if (file.had === null ? size !== null : size !== file.had) return `the control-room clone was not put back: ${file.relative}`
  }
  const dirty = git(['-C', clone.path, 'status', '--porcelain', '--untracked-files=all'])
  if (dirty.code !== 0 || dirty.out.trim()) return `the control-room clone is still not clean (${dirty.out.split('\n')[0] || 'unreadable'})`
  return null
}

function sendCommits(clone: Clone, git: GitRunner): { ok: boolean; message: string; restored: boolean } {
  const target = `HEAD:refs/heads/${clone.branch}`
  const head = git(['-C', clone.path, 'rev-parse', 'HEAD']).out.trim()
  let push = git([...GIT_CREDENTIAL_ARGS, '-C', clone.path, 'push', '--quiet', 'origin', target])
  if (push.code === 0) return { ok: true, message: '', restored: true }
  // Another machine pushed first: rebase this machine's own file on top and try once more.
  const pull = git([...GIT_CREDENTIAL_ARGS, '-C', clone.path, 'pull', '--quiet', '--rebase', 'origin', clone.branch])
  if (pull.code !== 0) {
    // A conflict leaves a rebase in progress and conflict markers in the tree; the clone belongs to
    // sync, so it goes back exactly as it was, and the caller is told when it could not.
    git(['-C', clone.path, 'rebase', '--abort'])
    const back = git(['-C', clone.path, 'rev-parse', 'HEAD']).out.trim()
    const dirty = git(['-C', clone.path, 'status', '--porcelain', '--untracked-files=all']).out.trim()
    const why = pull.out.split('\n')[0] ?? 'rebase failed'
    if (back !== head || dirty) return { ok: false, restored: false, message: `${why}; the control-room clone needs a hand: it is at ${back.slice(0, 7)}${dirty ? ' with local changes' : ''}` }
    return { ok: false, restored: true, message: `${why}; the clone was put back and the commit stays local` }
  }
  push = git([...GIT_CREDENTIAL_ARGS, '-C', clone.path, 'push', '--quiet', 'origin', target])
  return { ok: push.code === 0, message: push.out.split('\n')[0] ?? '', restored: true }
}

export interface PushOptions {
  home?: string
  cwd?: string
  now?: () => number
  force?: boolean
  git?: GitRunner
}

export function pushStats(options: PushOptions = {}): PushResult {
  const home = options.home ?? homedir()
  mkdirSync(statsDir(home), { recursive: true })
  // One push at a time: two of them would file the same turns twice.
  return withLock(join(statsDir(home), 'push'), () => pushLocked(home, options))
}

// The clone's identity: where it points and what it is on. Checked before anything is read or
// written, and before the state checks, because a crashed push is repaired first.
function identifyClone(home: string, entry: ControlRoomEntry, repo: string, git: GitRunner): { clone: Clone } | { reason: string; fatal: boolean } {
  const unsafe = safeClonePath(home, entry.path)
  if (unsafe) return { reason: unsafe, fatal: !unsafe.startsWith('no control-room clone') }
  const path = entry.path
  if (!existsSync(join(path, '.git'))) return { reason: `no local clone of the control room at ${path} — run "vegafactory sync" first`, fatal: false }
  const origin = git(['-C', path, 'remote', 'get-url', 'origin'])
  if (origin.code !== 0) return { reason: 'the control-room clone has no origin', fatal: true }
  const url = origin.out.trim()
  if (entry.remote ? url !== entry.remote : canonicalRepo(url) !== repo) return { reason: `the clone's origin (${url}) is not the control room this repo names`, fatal: true }
  const branch = entry.branch || 'main'
  const head = git(['-C', path, 'branch', '--show-current']).out.trim()
  if (head !== branch) return { reason: `the control-room clone is on ${head || 'a detached HEAD'}, not ${branch}`, fatal: true }
  if (git(['-C', path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).code !== 0) return { reason: `the clone has no origin/${branch} — run "vegafactory sync" first`, fatal: true }
  return { clone: { path, branch, remote: url, repo } }
}

// The repositories whose turns may be filed in this control room: the repository this push runs
// from (its own dev.md binds it), whatever the room's registry lists, and any other checkout on
// this machine whose profile names the same room. Everything else stays local.
const REGISTERED = /^\s*\|\s*([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)\s*\|/
const REPO_LINE = /^repo:\s*([\w.-]+\/[\w.-]+)/m

export function authorizedRepos(home: string, clone: Clone, devMd: string): Set<string> {
  const allowed = new Set<string>()
  const own = REPO_LINE.exec(devMd)?.[1]
  if (own) allowed.add(own)
  try {
    const registry = join(clone.path, 'repos.md')
    if (lstatSync(registry).isFile()) {
      for (const line of readFileSync(registry, 'utf8').split('\n')) {
        const listed = REGISTERED.exec(line)?.[1]
        if (listed && listed !== 'repo') allowed.add(listed)
      }
    }
  } catch { /* a room with no registry authorizes only what the profiles bind */ }
  try {
    const config = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8'))
    for (const row of (config.settings.repos ?? []) as Array<{ repo?: unknown; path?: unknown }>) {
      if (typeof row.repo !== 'string' || typeof row.path !== 'string') continue
      const profile = readFileSync(join(row.path, '.vegastack', 'dev.md'), 'utf8')
      if (parseControlRoomKnob(profile)?.repo === clone.repo && REPO_LINE.exec(profile)?.[1] === row.repo) allowed.add(row.repo)
    }
  } catch { /* unreadable checkouts authorize nothing */ }
  return allowed
}

// Everything that must be true of the clone's state before this writes into someone else's checkout.
function cloneState(clone: Clone, git: GitRunner): { ahead: string[] } | { reason: string } {
  const status = git(['-C', clone.path, 'status', '--porcelain', '--untracked-files=all'])
  if (status.code !== 0) return { reason: 'the control-room clone could not be read' }
  if (status.out.trim()) return { reason: `the control-room clone has local changes (${status.out.split('\n')[0]}) — sort them out first` }
  const ahead = git(['-C', clone.path, 'rev-list', `refs/remotes/origin/${clone.branch}..HEAD`]).out.split('\n').filter(Boolean)
  for (const sha of ahead) {
    const subject = git(['-C', clone.path, 'log', '-1', '--format=%s', sha]).out.trim()
    const touched = git(['-C', clone.path, 'show', '--name-only', '--format=', sha]).out.split('\n').filter(Boolean)
    if (!subject.startsWith('stats:') || touched.some((file) => !file.startsWith('stats/'))) {
      return { reason: `the control-room clone has a local commit that is not a stats push (${sha.slice(0, 7)} ${subject.slice(0, 60)})` }
    }
  }
  return { ahead }
}

// The cursor of one control room.
function readCursor(home: string, room: string): RoomCursor {
  return readJson<PushState>(pushPath(home), {}).rooms?.[room] ?? {}
}

function writeCursor(home: string, room: string, cursor: RoomCursor) {
  const state = readJson<PushState>(pushPath(home), {})
  atomicWrite(pushPath(home), JSON.stringify({ ...state, rooms: { ...state.rooms, [room]: cursor } }, null, 2) + '\n')
}

// A push that died between its commit and its cursor. If the commit is there, that room's cursor
// moves once and the commit is left for the retry below; if it is not, the rows go back and nothing
// is consumed. A journal is only ever applied to the clone it names, and anything it cannot prove —
// its own shape, its room, its paths, the restored sizes, a clean clone — keeps it on disk.
function recoverPush(home: string, clone: Clone, git: GitRunner): { ok: boolean; message: string } {
  const path = pushJournalPath(home, clone.repo)
  if (!existsSync(path)) return { ok: true, message: '' }
  const journal = validJournal(readJson<unknown>(path, null))
  if (!journal) return { ok: false, message: `an unreadable push journal is in the way: ${path}` }
  if (!sameRoom(journal.room, identityOf(clone))) {
    return { ok: false, message: `the push journal at ${path} was written for ${journal.room.repo} at ${journal.room.path} (${journal.room.branch}), which is not the clone this push found` }
  }
  const committed = git(['-C', clone.path, 'log', '--format=%H', '--grep', journal.token, `refs/remotes/origin/${clone.branch}..HEAD`]).out.trim()
  if (committed) {
    if ((readCursor(home, clone.repo).offset ?? 0) < journal.offset) writeCursor(home, clone.repo, { lastPushAt: journal.at, offset: journal.offset })
  } else {
    const failed = restoreFiles(clone, journal.files, git)
    if (failed) return { ok: false, message: `${failed} — the push journal is kept at ${path}` }
  }
  rmSync(path, { force: true })
  return { ok: true, message: '' }
}

function pushLocked(home: string, options: PushOptions): PushResult {
  const now = (options.now ?? Date.now)()
  const git = options.git ?? defaultGit
  const none = (message: string): PushResult => ({ ok: true, action: 'none', events: 0, paths: [], message })
  const refuse = (message: string): PushResult => ({ ok: false, action: 'refused', events: 0, paths: [], message })

  const root = repoRootFor(options.cwd ?? process.cwd())
  if (!root) return none('not in a repository — nothing to push')
  let devMd = ''
  try { devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8') } catch { return none('this repo has no .vegastack/dev.md') }
  const knob = parseControlRoomKnob(devMd)
  if (!knob) return none('this repo names no control room')
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(knob.repo)) return refuse(`${knob.repo} is not a repository name — fix the control-room line in .vegastack/dev.md`)
  let entry: ControlRoomEntry | undefined
  try { entry = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')).controlRooms[knob.org] } catch { return none('no control room is linked on this machine') }
  if (!entry) return none(`${knob.org}'s control room is not linked on this machine — run "vegafactory sync" first`)
  if (entry.repo && entry.repo !== knob.repo) return refuse(`the linked control room is ${entry.repo}, not ${knob.repo}`)

  const identified = identifyClone(home, entry, knob.repo, git)
  if ('reason' in identified) return identified.fatal ? refuse(identified.reason) : none(identified.reason)
  const { clone } = identified
  const repaired = recoverPush(home, clone, git)
  if (!repaired.ok) return refuse(repaired.message)
  const state = cloneState(clone, git)
  if ('reason' in state) return refuse(state.reason)

  // A stats commit that never reached the remote is retried before anything else: the cursor moved
  // when it was committed, so nothing else would ever send it.
  let recovered = 0
  if (state.ahead.length) {
    const sent = sendCommits(clone, git)
    if (!sent.ok) return { ok: false, action: 'committed', events: 0, paths: [], message: `an earlier stats commit is still unpushed: ${sent.message}` }
    recovered = state.ahead.length
  }
  const done = (result: PushResult): PushResult =>
    recovered && result.action !== 'pushed'
      ? { ...result, ok: true, action: 'pushed', message: `pushed ${recovered} earlier stats commit${recovered === 1 ? '' : 's'}; ${result.message}` }
      : result

  const cursor = readCursor(home, clone.repo)
  if (!options.force && cursor.lastPushAt && now - cursor.lastPushAt < PUSH_EVERY_MS && now >= cursor.lastPushAt) {
    return done({ ok: true, action: 'skipped', events: 0, paths: [], message: 'pushed less than an hour ago' })
  }
  // The cursor is a byte offset, so the file is sliced as bytes: one non-ASCII character in a model
  // or repository name would put a character count out of step with it.
  let buffer: Buffer
  try { buffer = readFileSync(eventsPath(home)) } catch { return done(none('nothing collected yet')) }
  const from = Math.min(Math.max(cursor.offset ?? 0, 0), buffer.length)
  const pending = buffer.subarray(from)
  const end = pending.lastIndexOf(0x0a)
  if (end === -1) return done(none('nothing new to push'))
  const lines = pending.subarray(0, end + 1).toString('utf8').split('\n').filter((line) => line.trim())
  if (!lines.length) return done(none('nothing new to push'))
  // This room's own cursor moves past everything read, whether or not this room may have it: a turn
  // that belongs somewhere else is never this room's to send, and its own room has its own cursor.
  const offset = from + end + 1

  // Each turn is filed under the operator and machine it was recorded on, never under whoever is
  // logged in now: a batch collected before a login or a hostname change belongs to its own file.
  // Only turns from a repository this room is bound to go anywhere; the rest stay on this machine.
  const allowed = authorizedRepos(home, clone, devMd)
  const groups = new Map<string, { relative: string; rows: string[] }>()
  let taken = 0
  for (const line of lines) {
    let event: StatsEvent
    try { event = JSON.parse(line) as StatsEvent } catch { continue }
    if (!event.repo || !allowed.has(event.repo)) continue
    const day = String(event.at ?? '').slice(0, 10).replace(/-/g, '/')
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(day)) continue
    const relative = `stats/${day}/${safe(event.operator)}-${safe(event.machine)}.jsonl`
    const group = groups.get(relative) ?? { relative, rows: [] }
    group.rows.push(line)
    groups.set(relative, group)
    taken += 1
  }
  if (!groups.size) {
    writeCursor(home, clone.repo, { lastPushAt: cursor.lastPushAt, offset })
    return done(none(`nothing new for ${clone.repo}`))
  }

  const relatives = [...groups.keys()].sort()
  for (const relative of relatives) {
    const unsafe = safeStatsPath(clone.path, relative)
    if (unsafe) return done(refuse(unsafe))
  }
  const journal: PushJournal = {
    token: randomUUID(), at: now, offset, room: identityOf(clone),
    files: relatives.map((relative) => {
      let had: number | null = null
      try { had = statSync(join(clone.path, ...relative.split('/'))).size } catch { /* a new day, a new file */ }
      return { relative, had }
    }),
  }
  // Puts the clone back and only then drops the journal: a rollback that could not finish leaves
  // the journal for the next run to refuse on, rather than pretending the clone is sound.
  const undo = (why: string): PushResult => {
    const failed = restoreFiles(clone, journal.files, git)
    if (failed) return done(refuse(`${why}; ${failed} — the push journal is kept at ${pushJournalPath(home, clone.repo)}`))
    rmSync(pushJournalPath(home, clone.repo), { force: true })
    return done(refuse(why))
  }
  atomicWrite(pushJournalPath(home, clone.repo), JSON.stringify(journal, null, 2) + '\n')
  try {
    for (const group of groups.values()) {
      const path = join(clone.path, ...group.relative.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      appendLines(path, group.rows.join('\n') + '\n')
    }
  } catch (error) {
    return undo(`the control-room clone could not be written: ${(error as Error).message}`)
  }
  const add = git(['-C', clone.path, 'add', '--', ...relatives])
  const staged = git(['-C', clone.path, 'diff', '--cached', '--name-only']).out.split('\n').filter(Boolean).sort()
  if (add.code !== 0 || staged.length !== relatives.length || staged.some((file, index) => file !== relatives[index])) {
    return undo(`only the stats files may be committed, but the clone staged ${staged.join(', ') || 'nothing'}`)
  }
  const subject = `stats: ${taken} turn${taken === 1 ? '' : 's'} from ${relatives.length} file${relatives.length === 1 ? '' : 's'}`
  const made = git(['-C', clone.path, 'commit', '--quiet', '-m', subject, '-m', `vsk-push: ${journal.token}`])
  if (made.code !== 0) {
    return undo(`the control-room commit failed: ${made.out.split('\n')[0]}`)
  }
  // The turns are durable in the clone now, so this room's cursor moves even if the push is
  // rejected; the next run finds the unpushed commit above and sends it. A death between the two is
  // what the journal is for: it names the commit and the clone, and recovery moves that one cursor.
  writeCursor(home, clone.repo, { lastPushAt: now, offset })
  rmSync(pushJournalPath(home, clone.repo), { force: true })
  const sent = sendCommits(clone, git)
  if (!sent.ok) {
    return { ok: false, action: 'committed', events: taken, paths: relatives, message: `committed in the control-room clone but not sent: ${sent.message}` }
  }
  return { ok: true, action: 'pushed', events: taken, paths: relatives, message: `pushed ${taken} turns to ${relatives.join(', ')}` }
}

// ---------------------------------------------------------------------------------------------
// The command

export function statsUsage(): string {
  return `Usage: vegafactory stats <collect|push|show> [options]

  collect                 read new turns from the Claude Code and Codex session logs on this machine
  push [--force]          append this machine's new turns to the org control room (at most hourly)
  show [--since 7d]       turns, tokens and time by operator, project, model, stage and skill

Options:
  --since 7d|12h|30m|DATE   only turns since then (show)
  --local                   only this machine's own turns, not the control room (show)
  --json                    machine-readable output
`
}

export function runStats(argv: string[], options: { home?: string; now?: () => number; out?: (text: string) => void } = {}): number {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now
  const out = options.out ?? ((text: string) => process.stdout.write(text + '\n'))
  const [verb, ...rest] = argv
  const json = rest.includes('--json')
  if (!verb || ['help', '--help', '-h'].includes(verb)) { out(statsUsage()); return 0 }

  if (verb === 'collect') {
    // Hooks call this on every session start and every turn: never let it fail a session.
    try {
      const result = collectStats({ home, now })
      if (json) out(JSON.stringify(result))
      else if (result.events) out(`collected ${result.events} turns from ${result.files} session logs`)
    } catch { /* silent on purpose */ }
    return 0
  }
  if (verb === 'push') {
    try {
      const result = pushStats({ home, now, force: rest.includes('--force') })
      if (json) out(JSON.stringify(result))
      else out(result.message)
      return result.ok ? 0 : 1
    } catch { return 0 }
  }
  if (verb === 'show') {
    const at = rest.indexOf('--since')
    const since = at === -1 ? null : parseSince(rest[at + 1] ?? '', now())
    const summary = summarize(loadEvents(home, { since, shared: !rest.includes('--local') }))
    out(json ? JSON.stringify(summary, null, 2) : renderShow(summary))
    return 0
  }
  throw new Error(`unknown stats command: ${verb} — run "vegafactory stats --help"`)
}

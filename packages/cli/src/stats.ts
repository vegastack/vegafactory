// `vegafactory stats collect|push|show` — usage numbers read from the harnesses' own session logs.
//
// Claude Code writes ~/.claude/projects/<slug>/<session>.jsonl, Codex writes
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Both are append-only, so every file is read from a
// saved byte offset: a session that was killed or abandoned is counted once, at the next run.
// One event per assistant turn — counts and identifiers only, never a prompt, a file, tool
// arguments or the subscription owner.
//
// Two rules keep the numbers honest under crashes and concurrent hooks. Collection holds one
// interprocess lock and commits through a journal, so an interrupted run replays instead of
// double-counting. An event id is stable per turn and a later line for the same turn appends a
// corrected copy, so readers take the last record per id and a split turn still ends up complete.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path'
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

export interface ParseContext { operator: string; machine: string; carry: Carry; site: SiteLookup }
export interface ParseResult { events: StatsEvent[]; consumed: number }

// A turn already written down, and whether this slice has already appended it.
interface Known { event: StatsEvent; fresh: boolean }

function opened(carry: Carry): Map<string, Known> {
  const known = new Map<string, Known>()
  if (carry.pending?.key) known.set(carry.pending.key, { event: structuredClone(carry.pending.event), fresh: false })
  return known
}

// Applies a late line to a turn already emitted: an in-slice event is edited in place, a turn from
// an earlier slice gets a corrected copy appended, which readers keep instead of the first one.
function correct(known: Known, events: StatsEvent[], change: (event: StatsEvent) => void) {
  const before = JSON.stringify(known.event)
  change(known.event)
  if (known.fresh || JSON.stringify(known.event) === before) return
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

const SKILL_PATH = /skills\/([a-z0-9][a-z0-9._-]*)\/SKILL\.md/
// A skill name, and nothing else: the value a harness records is written to the control room and
// the dashboard, so anything that is not a plain name (markup, a path, a sentence, a secret) is
// dropped rather than carried.
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/
export function skillName(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && SKILL_NAME.test(value) ? value : null
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
    const chosen = skillName((call?.input as { skill?: unknown } | undefined)?.skill)
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
      id, at: new Date(at).toISOString(), operator: context.operator, machine: context.machine, harness: 'claude',
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
      // Codex has no Skill tool: a skill is used by reading its SKILL.md. Only the name is kept.
      const text = `${typeof payload.input === 'string' ? payload.input : ''}${typeof payload.arguments === 'string' ? payload.arguments : ''}`
      const found = skillName(SKILL_PATH.exec(text)?.[1])
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
      id: hash(`codex|${carry.session ?? ''}|${String(payload.response_id ?? '')}`),
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
      for (const file of readdirSync(join(projects, entry.name))) {
        if (file.endsWith('.jsonl')) found.push({ path: join(projects, entry.name, file), harness: 'claude' })
      }
    }
  } catch { /* Claude Code is not installed here */ }
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) found.push({ path, harness: 'codex' })
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
  if (landed < rows.length) appendFileSync(eventsPath(home), rows.slice(landed).join('\n') + '\n')
  atomicWrite(offsetsPath(home), JSON.stringify(pending.offsets, null, 2) + '\n')
  rmSync(journalPath(home), { force: true })
}

function commit(home: string, events: StatsEvent[], offsets: Offsets) {
  if (events.length) {
    atomicWrite(journalPath(home), JSON.stringify({ events, offsets }))
    appendFileSync(eventsPath(home), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
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
      const context: ParseContext = { operator, machine, carry: state.carry ?? {}, site }
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
// Reading events back: this machine's own file, plus whatever every operator pushed into the
// control-room clones this machine keeps. The last record for an id wins, so a turn corrected by a
// later slice is read as its finished self.

function parseEvents(text: string, into: Map<string, StatsEvent>, since: number | null) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: StatsEvent
    try { event = JSON.parse(line) as StatsEvent } catch { continue }
    if (!event?.id || !event.at) continue
    if (since !== null && Date.parse(event.at) < since) continue
    into.set(event.id, event)
  }
}

function jsonlUnder(dir: string, depth = 0): string[] {
  if (depth > 6) return []
  const found: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...jsonlUnder(path, depth + 1))
      else if (entry.name.endsWith('.jsonl')) found.push(path)
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
      .filter((dir) => existsSync(dir))
  } catch { return [] }
}

export function loadEvents(home: string, { since = null as number | null, local = true, shared = true } = {}): StatsEvent[] {
  const events = new Map<string, StatsEvent>()
  if (local) {
    try { parseEvents(readFileSync(eventsPath(home), 'utf8'), events, since) } catch { /* nothing collected yet */ }
  }
  if (shared) {
    for (const dir of controlRoomStatsDirs(home)) {
      for (const file of jsonlUnder(dir)) {
        try { parseEvents(readFileSync(file, 'utf8'), events, since) } catch { /* unreadable file */ }
      }
    }
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

export interface PushState { lastPushAt?: number; offset?: number }
export interface PushResult { ok: boolean; action: 'pushed' | 'committed' | 'skipped' | 'none' | 'refused'; events: number; paths: string[]; message: string }

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

// A control-room clone is only ever read or written where sync puts it: a canonical absolute path
// inside this machine's control-room store, with no symlink anywhere along it. Returns the reason
// it is not usable, or null when it is.
export function safeClonePath(home: string, path: unknown): string | null {
  const store = join(home, '.vegastack', 'control-room')
  if (typeof path !== 'string' || !path || !isAbsolute(path) || resolve(path) !== path) return 'the control-room path is not absolute and canonical'
  if (path !== store && !path.startsWith(store + sep)) return `the control-room clone is outside ${store}`
  let cursor = parsePath(path).root
  for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    let info
    try { info = lstatSync(cursor) } catch { return `no control-room clone at ${path}` }
    if (info.isSymbolicLink()) return `refusing a symlinked control-room path: ${cursor}`
  }
  return null
}

interface Clone { path: string; branch: string }

// Everything that must be true before this writes into someone else's checkout.
function inspectClone(home: string, entry: ControlRoomEntry, repo: string, git: GitRunner): { clone: Clone; ahead: string[] } | { reason: string; fatal: boolean } {
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
  const status = git(['-C', path, 'status', '--porcelain', '--untracked-files=all'])
  if (status.code !== 0) return { reason: 'the control-room clone could not be read', fatal: true }
  if (status.out.trim()) return { reason: `the control-room clone has local changes (${status.out.split('\n')[0]}) — sort them out first`, fatal: true }
  const ahead = git(['-C', path, 'rev-list', `refs/remotes/origin/${branch}..HEAD`]).out.split('\n').filter(Boolean)
  for (const sha of ahead) {
    const subject = git(['-C', path, 'log', '-1', '--format=%s', sha]).out.trim()
    const touched = git(['-C', path, 'show', '--name-only', '--format=', sha]).out.split('\n').filter(Boolean)
    if (!subject.startsWith('stats:') || touched.some((file) => !file.startsWith('stats/'))) {
      return { reason: `the control-room clone has a local commit that is not a stats push (${sha.slice(0, 7)} ${subject.slice(0, 60)})`, fatal: true }
    }
  }
  return { clone: { path, branch }, ahead }
}

function sendCommits(clone: Clone, git: GitRunner): { ok: boolean; message: string } {
  const target = `HEAD:refs/heads/${clone.branch}`
  let push = git([...GIT_CREDENTIAL_ARGS, '-C', clone.path, 'push', '--quiet', 'origin', target])
  if (push.code !== 0) {
    // Another machine pushed first: rebase this machine's own file on top and try once more.
    const pull = git([...GIT_CREDENTIAL_ARGS, '-C', clone.path, 'pull', '--quiet', '--rebase', 'origin', clone.branch])
    if (pull.code === 0) push = git([...GIT_CREDENTIAL_ARGS, '-C', clone.path, 'push', '--quiet', 'origin', target])
  }
  return { ok: push.code === 0, message: push.out.split('\n')[0] ?? '' }
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
  let entry: ControlRoomEntry | undefined
  try { entry = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')).controlRooms[knob.org] } catch { return none('no control room is linked on this machine') }
  if (!entry) return none(`${knob.org}'s control room is not linked on this machine — run "vegafactory sync" first`)
  if (entry.repo && entry.repo !== knob.repo) return refuse(`the linked control room is ${entry.repo}, not ${knob.repo}`)

  const inspected = inspectClone(home, entry, knob.repo, git)
  if ('reason' in inspected) return inspected.fatal ? refuse(inspected.reason) : none(inspected.reason)
  const { clone, ahead } = inspected

  // A stats commit that never reached the remote is retried before anything else: the cursor moved
  // when it was committed, so nothing else would ever send it.
  let recovered = 0
  if (ahead.length) {
    const sent = sendCommits(clone, git)
    if (!sent.ok) return { ok: false, action: 'committed', events: 0, paths: [], message: `an earlier stats commit is still unpushed: ${sent.message}` }
    recovered = ahead.length
  }
  const done = (result: PushResult): PushResult =>
    recovered && result.action !== 'pushed'
      ? { ...result, ok: true, action: 'pushed', message: `pushed ${recovered} earlier stats commit${recovered === 1 ? '' : 's'}; ${result.message}` }
      : result

  const state = readJson<PushState>(pushPath(home), {})
  if (!options.force && state.lastPushAt && now - state.lastPushAt < PUSH_EVERY_MS && now >= state.lastPushAt) {
    return done({ ok: true, action: 'skipped', events: 0, paths: [], message: 'pushed less than an hour ago' })
  }
  let text = ''
  try { text = readFileSync(eventsPath(home), 'utf8') } catch { return done(none('nothing collected yet')) }
  const pending = text.slice(Math.min(state.offset ?? 0, text.length))
  const end = pending.lastIndexOf('\n')
  const lines = end === -1 ? [] : pending.slice(0, end).split('\n').filter((line) => line.trim())
  if (!lines.length) return done(none('nothing new to push'))
  const offset = (state.offset ?? 0) + Buffer.byteLength(pending.slice(0, end + 1))

  // Each turn is filed under the operator and machine it was recorded on, never under whoever is
  // logged in now: a batch collected before a login or a hostname change belongs to its own file.
  const groups = new Map<string, { relative: string; rows: string[] }>()
  for (const line of lines) {
    let event: StatsEvent
    try { event = JSON.parse(line) as StatsEvent } catch { continue }
    const day = String(event.at ?? '').slice(0, 10).replace(/-/g, '/')
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(day)) continue
    const relative = `stats/${day}/${safe(event.operator)}-${safe(event.machine)}.jsonl`
    const group = groups.get(relative) ?? { relative, rows: [] }
    group.rows.push(line)
    groups.set(relative, group)
  }
  if (!groups.size) return done(none('nothing new to push'))

  const written: Array<{ path: string; had: number | null }> = []
  const relatives = [...groups.keys()].sort()
  const undo = () => {
    for (const file of written) {
      try { file.had === null ? rmSync(file.path, { force: true }) : truncateSync(file.path, file.had) } catch { /* nothing to put back */ }
    }
    git(['-C', clone.path, 'reset', '--quiet', '--', ...relatives])
  }
  try {
    for (const group of groups.values()) {
      const path = join(clone.path, ...group.relative.split('/'))
      let had: number | null = null
      try { had = statSync(path).size } catch { /* a new day, a new file */ }
      mkdirSync(dirname(path), { recursive: true })
      written.push({ path, had })
      appendFileSync(path, group.rows.join('\n') + '\n')
    }
  } catch (error) {
    undo()
    return done(refuse(`the control-room clone could not be written: ${(error as Error).message}`))
  }
  const add = git(['-C', clone.path, 'add', '--', ...relatives])
  const staged = git(['-C', clone.path, 'diff', '--cached', '--name-only']).out.split('\n').filter(Boolean).sort()
  if (add.code !== 0 || staged.join(' ') !== relatives.join(' ')) {
    undo()
    return done(refuse(`only the stats files may be committed, but the clone staged ${staged.join(', ') || 'nothing'}`))
  }
  const message = `stats: ${lines.length} turn${lines.length === 1 ? '' : 's'} from ${relatives.length} file${relatives.length === 1 ? '' : 's'}`
  const commit = git(['-C', clone.path, 'commit', '--quiet', '-m', message])
  if (commit.code !== 0) {
    undo()
    return done(refuse(`the control-room commit failed: ${commit.out.split('\n')[0]}`))
  }
  // The turns are durable in the clone now, so the cursor moves even if the push is rejected; the
  // next run finds the unpushed commit above and sends it.
  atomicWrite(pushPath(home), JSON.stringify({ lastPushAt: now, offset }, null, 2) + '\n')
  const sent = sendCommits(clone, git)
  if (!sent.ok) {
    return { ok: false, action: 'committed', events: lines.length, paths: relatives, message: `committed in the control-room clone but the push was rejected: ${sent.message}` }
  }
  return { ok: true, action: 'pushed', events: lines.length, paths: relatives, message: `pushed ${lines.length} turns to ${relatives.join(', ')}` }
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

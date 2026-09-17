// `vegafactory stats collect|push|show` — usage numbers read from the harnesses' own session logs.
//
// Claude Code writes ~/.claude/projects/<slug>/<session>.jsonl, Codex writes
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Both are append-only, so every file is read from a
// saved byte offset: a session that was killed or abandoned is counted once, at the next run.
// One event per assistant turn — counts and identifiers only, never a prompt, a file, tool
// arguments or the subscription owner.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { factoryConfigPath, parseControlRoomKnob, readFactoryConfig } from './control-room.ts'
import { defaultRunner, ghRequest, type GhRunner } from './gh.ts'
import { issueFromBranch, issueFromWorktree } from './hook.ts'
import { cacheDir, readState } from './issue-cache.ts'
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
// Per file, per run: the rest is read on the next run, so one huge log never stalls a session.
const MAX_SLICE_BYTES = 8 * 1024 * 1024
const OPERATOR_TTL_MS = 12 * 60 * 60_000
export const PUSH_EVERY_MS = 60 * 60_000

export const statsDir = (home: string) => join(home, '.vegastack', '.tmp', 'stats')
const offsetsPath = (home: string) => join(statsDir(home), 'offsets.json')
const eventsPath = (home: string) => join(statsDir(home), 'events.jsonl')
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
// consumed; `carry` holds what the next slice of the same file still needs (the Codex model and
// repository arrive once, at the top) and rides along in offsets.json.

export interface Carry {
  last?: number | null
  model?: string | null
  cwd?: string | null
  branch?: string | null
  repo?: string | null
  session?: string | null
  skill?: string | null
  // The turn ids already emitted, so a turn split across two slices is not counted twice.
  ids?: string[]
}

export interface ParseContext { operator: string; machine: string; carry: Carry; site: SiteLookup }
export interface ParseResult { events: StatsEvent[]; consumed: number }

const KEPT_IDS = 64

function remember(carry: Carry, id: string): boolean {
  const ids = carry.ids ?? []
  if (ids.includes(id)) return false
  carry.ids = [...ids, id].slice(-KEPT_IDS)
  return true
}

function gap(carry: Carry, at: number): number {
  const previous = carry.last ?? null
  carry.last = at
  if (previous === null) return 0
  const span = at - previous
  return span > 0 && span < MAX_TURN_MS ? span : 0
}

// Whole lines only: a log being written while it is read ends mid-line.
function wholeLines(text: string): { lines: string[]; consumed: number } {
  const end = text.lastIndexOf('\n')
  if (end === -1) return { lines: [], consumed: 0 }
  return { lines: text.slice(0, end).split('\n'), consumed: Buffer.byteLength(text.slice(0, end + 1)) }
}

const SKILL_PATH = /skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/

export function parseClaude(text: string, context: ParseContext): ParseResult {
  const { lines, consumed } = wholeLines(text)
  const events: StatsEvent[] = []
  // One assistant turn is written as one line per content block, all under the same message id and
  // all repeating that turn's usage: the first line opens the event, the rest only add to it.
  const open = new Map<string, number>()
  for (const line of lines) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const at = Date.parse(String(entry.timestamp ?? ''))
    if (!Number.isFinite(at)) continue
    const durationMs = gap(context.carry, at)
    if (entry.type !== 'assistant') continue
    const message = entry.message as { id?: string; model?: string; stop_reason?: string; usage?: Record<string, unknown>; content?: Array<Record<string, unknown>> } | undefined
    // A synthetic assistant message is Claude Code's own text (an API error, a cancel), not a turn.
    if (!message?.id || !message.usage || !message.model || message.model.startsWith('<')) continue
    const session = String(entry.sessionId ?? '')
    const id = hash(`claude|${session}|${message.id}`)
    const call = (message.content ?? []).find((block) => block.type === 'tool_use' && block.name === 'Skill')
    const named = (call?.input as { skill?: string } | undefined)?.skill
    const chosen = typeof named === 'string' ? named : null
    const started = open.get(id)
    if (started !== undefined) {
      const already = events[started]!
      already.outcome = String(message.stop_reason ?? already.outcome)
      already.skill ??= chosen
      continue
    }
    if (!remember(context.carry, id)) continue
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : null
    const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch : null
    const site = context.site(cwd, branch)
    open.set(id, events.length)
    events.push({
      id, at: new Date(at).toISOString(), operator: context.operator, machine: context.machine, harness: 'claude',
      model: message.model, repo: site.repo, issue: site.issue, state: site.state,
      skill: chosen,
      tokens: {
        input: count(message.usage.input_tokens), output: count(message.usage.output_tokens),
        cacheRead: count(message.usage.cache_read_input_tokens), cacheWrite: count(message.usage.cache_creation_input_tokens),
      },
      durationMs, outcome: String(message.stop_reason ?? 'unknown'),
    })
  }
  return { events, consumed }
}

export function parseCodex(text: string, context: ParseContext): ParseResult {
  const { lines, consumed } = wholeLines(text)
  const events: StatsEvent[] = []
  const carry = context.carry
  // The last event of each turn, so `task_complete` can name how the turn ended.
  const turns = new Map<string, number>()
  for (const line of lines) {
    if (!line) continue
    let entry: { type?: string; timestamp?: string; payload?: Record<string, unknown> }
    try { entry = JSON.parse(line) as typeof entry } catch { continue }
    const at = Date.parse(String(entry.timestamp ?? ''))
    if (!Number.isFinite(at)) continue
    const durationMs = gap(carry, at)
    const payload = entry.payload ?? {}
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
      const call = `${typeof payload.input === 'string' ? payload.input : ''}${typeof payload.arguments === 'string' ? payload.arguments : ''}`
      const found = SKILL_PATH.exec(call)?.[1]
      if (found) carry.skill = found
      continue
    }
    if (entry.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      const index = turns.get(String(payload.turn_id ?? ''))
      if (index !== undefined) events[index]!.outcome = payload.type === 'task_complete' ? 'end_turn' : 'aborted'
      continue
    }
    if (entry.type !== 'token_usage_record') continue
    const usage = payload.usage as Record<string, unknown> | undefined
    if (!usage) continue
    const id = hash(`codex|${carry.session ?? ''}|${String(payload.response_id ?? '')}`)
    if (!remember(carry, id)) continue
    const site = context.site(carry.cwd ?? null, carry.branch ?? null, carry.repo ?? null)
    // Codex counts cached tokens inside input_tokens; Claude reports them separately. Subtracting
    // here makes the four numbers mean the same thing in both harnesses.
    const cacheRead = count(usage.cached_input_tokens)
    events.push({
      id, at: new Date(at).toISOString(), operator: context.operator, machine: context.machine, harness: 'codex',
      model: carry.model ?? 'unknown', repo: site.repo, issue: site.issue, state: site.state, skill: carry.skill ?? null,
      tokens: {
        input: Math.max(0, count(usage.input_tokens) - cacheRead), output: count(usage.output_tokens),
        cacheRead, cacheWrite: count(usage.cache_write_input_tokens),
      },
      durationMs, outcome: 'tool_use',
    })
    carry.skill = null
    turns.set(String(payload.turn_id ?? ''), events.length - 1)
  }
  return { events, consumed }
}

// ---------------------------------------------------------------------------------------------
// Collecting

export interface FileOffset { offset: number; size: number; carry: Carry }
export interface Offsets { schema: 1; files: Record<string, FileOffset> }

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

function readSlice(path: string, offset: number, size: number): string {
  const length = Math.min(size - offset, MAX_SLICE_BYTES)
  const buffer = Buffer.alloc(length)
  const handle = openSync(path, 'r')
  try { readSync(handle, buffer, 0, length, offset) } finally { closeSync(handle) }
  return buffer.toString('utf8')
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

export function collectStats(options: CollectOptions = {}): CollectResult {
  const home = options.home ?? homedir()
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
    let size = 0
    try { size = statSync(log.path).size } catch { continue }
    const saved = offsets.files[log.path] ?? { offset: 0, size: 0, carry: {} }
    // A smaller file is a new one at the same path: read it from the start.
    if (size < saved.offset) { saved.offset = 0; saved.carry = {} }
    if (size === saved.offset) { offsets.files[log.path] = { ...saved, size }; continue }
    let slice = ''
    try { slice = readSlice(log.path, saved.offset, size) } catch { continue }
    const context: ParseContext = { operator, machine, carry: saved.carry ?? {}, site }
    const result = log.harness === 'claude' ? parseClaude(slice, context) : parseCodex(slice, context)
    collected.push(...result.events)
    files += 1
    bytes += result.consumed
    offsets.files[log.path] = { offset: saved.offset + result.consumed, size, carry: context.carry }
  }
  if (collected.length) {
    mkdirSync(statsDir(home), { recursive: true })
    appendFileSync(eventsPath(home), collected.map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
  atomicWrite(offsetsPath(home), JSON.stringify(offsets, null, 2) + '\n')
  return { files, events: collected.length, bytes }
}

// ---------------------------------------------------------------------------------------------
// Reading events back: this machine's own file, plus whatever every operator pushed into the
// control-room clones this machine keeps.

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
    return Object.values(config.controlRooms).map((entry) => join(entry.path, 'stats')).filter((dir) => existsSync(dir))
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

export interface PushState { lastPushAt?: number; offset?: number }
export interface PushResult { ok: boolean; action: 'pushed' | 'committed' | 'skipped' | 'none' | 'refused'; events: number; path: string | null; message: string }

export type GitRunner = (args: string[]) => { code: number; out: string }

export const defaultGit: GitRunner = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'

// The repository this session is in, with a worktree path folded back to its main checkout.
export function repoRootFor(cwd: string): string | null {
  const worktree = /^(.*)[/\\]\.vegastack[/\\]\.worktrees[/\\][^/\\]+$/.exec(cwd)
  return repoRootOf(worktree?.[1] ?? cwd)
}

export interface PushOptions {
  home?: string
  cwd?: string
  machine?: string
  now?: () => number
  force?: boolean
  git?: GitRunner
}

export function pushStats(options: PushOptions = {}): PushResult {
  const home = options.home ?? homedir()
  const now = (options.now ?? Date.now)()
  const machine = options.machine ?? hostname()
  const git = options.git ?? defaultGit
  const none = (message: string): PushResult => ({ ok: true, action: 'none', events: 0, path: null, message })

  const root = repoRootFor(options.cwd ?? process.cwd())
  if (!root) return none('not in a repository — nothing to push')
  let devMd = ''
  try { devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8') } catch { return none('this repo has no .vegastack/dev.md') }
  const knob = parseControlRoomKnob(devMd)
  if (!knob) return none('this repo names no control room')
  let entry
  try { entry = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')).controlRooms[knob.org] } catch { return none('no control room is linked on this machine') }
  if (!entry?.path || !existsSync(join(entry.path, '.git'))) return none(`no local clone of ${knob.org}'s control room — run "vegafactory sync" first`)
  if (entry.repo && entry.repo !== knob.repo) return { ok: false, action: 'refused', events: 0, path: null, message: `the linked control room is ${entry.repo}, not ${knob.repo}` }

  const state = readJson<PushState>(pushPath(home), {})
  if (!options.force && state.lastPushAt && now - state.lastPushAt < PUSH_EVERY_MS && now >= state.lastPushAt) {
    return { ok: true, action: 'skipped', events: 0, path: null, message: 'pushed less than an hour ago' }
  }
  let text = ''
  try { text = readFileSync(eventsPath(home), 'utf8') } catch { return none('nothing collected yet') }
  const pending = text.slice(Math.min(state.offset ?? 0, text.length))
  const end = pending.lastIndexOf('\n')
  const lines = end === -1 ? [] : pending.slice(0, end).split('\n').filter((line) => line.trim())
  if (!lines.length) return none('nothing new to push')
  const offset = (state.offset ?? 0) + Buffer.byteLength(pending.slice(0, end + 1))

  const operator = safe(String(readJson<{ login?: string }>(identityPath(home), {}).login ?? JSON.parse(lines[0]!).operator ?? 'unknown'))
  const days = new Map<string, string[]>()
  for (const line of lines) {
    let at = ''
    try { at = String((JSON.parse(line) as StatsEvent).at) } catch { continue }
    const day = at.slice(0, 10).replace(/-/g, '/')
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(day)) continue
    days.set(day, [...(days.get(day) ?? []), line])
  }
  if (!days.size) return none('nothing new to push')
  const written: string[] = []
  for (const [day, rows] of days) {
    const relative = join('stats', day, `${operator}-${safe(machine)}.jsonl`)
    const path = join(entry.path, relative)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, rows.join('\n') + '\n')
    written.push(relative)
  }
  const inClone = (...args: string[]) => git(['-C', entry.path, ...args])
  inClone('add', '--', 'stats')
  const commit = inClone('commit', '--quiet', '-m', `stats: ${operator} on ${safe(machine)} (${lines.length} turns)`)
  if (commit.code !== 0) return { ok: false, action: 'refused', events: lines.length, path: written[0] ?? null, message: `the control-room commit failed: ${commit.out.split('\n')[0]}` }
  // The events are durable in the clone now, so the cursor moves even if the push is rejected;
  // the next run pushes the commit that is already there.
  atomicWrite(pushPath(home), JSON.stringify({ lastPushAt: now, offset }, null, 2) + '\n')
  const branch = entry.branch || 'main'
  const target = `HEAD:refs/heads/${branch}`
  let push = git([...GIT_CREDENTIAL_ARGS, '-C', entry.path, 'push', '--quiet', 'origin', target])
  if (push.code !== 0) {
    // Another machine pushed first: rebase this machine's own file on top and try once more.
    const pull = git([...GIT_CREDENTIAL_ARGS, '-C', entry.path, 'pull', '--quiet', '--rebase', 'origin', branch])
    if (pull.code === 0) push = git([...GIT_CREDENTIAL_ARGS, '-C', entry.path, 'push', '--quiet', 'origin', target])
  }
  if (push.code !== 0) {
    return { ok: false, action: 'committed', events: lines.length, path: written[0] ?? null, message: `committed in the control-room clone but the push was rejected: ${push.out.split('\n')[0]}` }
  }
  return { ok: true, action: 'pushed', events: lines.length, path: written[0] ?? null, message: `pushed ${lines.length} turns to ${written.join(', ')}` }
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

// The four capture points, as pure functions on the JSON each harness already emits.
//
// Nothing here spawns anything, reads the network, or asks a model a question: a headless run's
// stdout, a SessionEnd hook payload, a transcript's lines and a skill hook's payload go in, and one
// record — or one list of skill invocations — comes out. That is what makes "deterministic capture"
// a property a test can hold rather than a promise.
//
// Two rules bind every parser. An absent vendor field becomes `null`, never `0`: a run that
// reported no cost and a run that cost nothing are different facts. And no text field is ever read
// — the transcript is walked for `message.usage.*` and for the *shape* of `content[]` entries, so
// prompt text, assistant text and tool arguments have no path into a record even by accident.

import {
  normalizeRecord,
  type SkillInvocation, type StatsOutcome, type StatsRecord,
} from './record.ts'

export interface CaptureContext {
  repo: string
  ts: string
  stage?: string | null
  model?: string | null
  effort?: string | null
  human?: string | null
  worktree?: string | null
  parent?: number | null
  terminationCause?: import('../runs.ts').TerminalCause | null
  outcome?: StatsOutcome | null
  review_rounds?: number | null
  fix_rounds?: number | null
  handbacks?: number | null
  skills?: SkillInvocation[]
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const WORKTREE = /\.worktrees\/(\d+)-([^/]+)/

// The worktree path is the one place a headless run already carries its issue number, and the
// naming is the factory's own (`.vegastack/.worktrees/<n>-<slug>`), so reading it needs no `gh`
// call and cannot be wrong about a repo it did not create.
export function issueFromWorktree(path: string | null): { issue: number | null; slug: string | null } {
  const match = typeof path === 'string' ? WORKTREE.exec(path) : null
  if (!match) return { issue: null, slug: null }
  return { issue: Number(match[1]), slug: match[2] ?? null }
}

function baseFrom(context: CaptureContext, fallbackWorktree: string | null = null): Partial<StatsRecord> & { repo: string; ts: string } {
  const worktree = context.worktree ?? fallbackWorktree
  const { issue } = issueFromWorktree(worktree)
  return {
    repo: context.repo,
    ts: context.ts,
    issue,
    parent: context.parent ?? null,
    stage: context.stage ?? null,
    model: context.model ?? null,
    effort: context.effort ?? null,
    human: context.human ?? null,
    worktree,
    review_rounds: context.review_rounds ?? null,
    fix_rounds: context.fix_rounds ?? null,
    handbacks: context.handbacks ?? null,
    skills: context.skills ?? [],
  }
}

// `claude -p --output-format json` prints one result object: session id, wall duration, turn count,
// a usage block and the run's own total cost.
export function fromClaudeHeadless(stdout: unknown, context: CaptureContext): StatsRecord {
  const result = asObject(stdout)
  const usage = asObject(result.usage)
  const durationMs = numberOrNull(result.duration_ms)
  return normalizeRecord({
    ...baseFrom(context),
    harness: 'claude',
    mode: 'headless',
    session_id: stringOrNull(result.session_id),
    duration_s: durationMs === null ? null : Math.round(durationMs / 1000),
    turns: numberOrNull(result.num_turns),
    cost_usd: numberOrNull(result.total_cost_usd),
    tokens: {
      in: numberOrNull(usage.input_tokens),
      out: numberOrNull(usage.output_tokens),
      cache_read: numberOrNull(usage.cache_read_input_tokens),
      cache_write: numberOrNull(usage.cache_creation_input_tokens),
    },
    outcome: (context.terminationCause && context.terminationCause !== 'succeeded' ? 'failed' : context.outcome) ?? (result.is_error === true ? 'failed' : 'complete'),
  })
}

// `codex exec --json` streams events; usage is reported per completed turn, cumulatively, so the
// LAST `turn.completed` carries the run's totals and the count of them is the turn count. Codex
// reports no cache-creation counter and no cost, so both stay null rather than being derived.
export function fromCodexExec(events: unknown[], context: CaptureContext): StatsRecord {
  const completed = (Array.isArray(events) ? events : [])
    .map(asObject)
    .filter(event => event.type === 'turn.completed')
  const usage = asObject(completed[completed.length - 1]?.usage)
  return normalizeRecord({
    ...baseFrom(context),
    harness: 'codex',
    mode: 'headless',
    turns: completed.length > 0 ? completed.length : null,
    tokens: {
      in: numberOrNull(usage.input_tokens),
      out: numberOrNull(usage.output_tokens),
      cache_read: numberOrNull(usage.cached_input_tokens),
      cache_write: null,
    },
    outcome: (context.terminationCause && context.terminationCause !== 'succeeded' ? 'failed' : context.outcome) ?? null,
  })
}

// Claude Code's SessionEnd payload names the transcript; the transcript's assistant lines carry the
// usage the session actually spent. Only `message.usage.*` and the `type` of each `content[]` entry
// are read — never a text, never an input.
export function fromClaudeSessionEnd(hook: unknown, transcriptLines: string[], context: CaptureContext): StatsRecord {
  const payload = asObject(hook)
  let turns = 0
  let toolCalls = 0
  const totals = { in: 0, out: 0, cache_read: 0, cache_write: 0 }
  let sawAssistant = false
  for (const line of Array.isArray(transcriptLines) ? transcriptLines : []) {
    let entry: Record<string, unknown>
    try {
      entry = asObject(JSON.parse(line))
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    const message = asObject(entry.message)
    const usage = asObject(message.usage)
    turns += 1
    sawAssistant = true
    totals.in += numberOrNull(usage.input_tokens) ?? 0
    totals.out += numberOrNull(usage.output_tokens) ?? 0
    totals.cache_read += numberOrNull(usage.cache_read_input_tokens) ?? 0
    totals.cache_write += numberOrNull(usage.cache_creation_input_tokens) ?? 0
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (asObject(block).type === 'tool_use') toolCalls += 1
    }
  }
  return normalizeRecord({
    ...baseFrom(context, stringOrNull(payload.cwd)),
    harness: 'claude',
    mode: 'interactive',
    session_id: stringOrNull(payload.session_id),
    turns: turns > 0 ? turns : null,
    tool_calls: sawAssistant ? toolCalls : null,
    tokens: sawAssistant
      ? totals
      : { in: null, out: null, cache_read: null, cache_write: null },
    outcome: (context.terminationCause && context.terminationCause !== 'succeeded' ? 'failed' : context.outcome) ?? null,
  })
}

// Codex's session end exposes the session id and the working directory and nothing else this record
// wants. Every counter therefore stays null: a session that was recorded with unknown usage is a
// true row, while one with invented zeros would quietly drag every average down.
export function fromCodexSessionEnd(hook: unknown, context: CaptureContext): StatsRecord {
  const payload = asObject(hook)
  return normalizeRecord({
    ...baseFrom(context, stringOrNull(payload.cwd)),
    harness: 'codex',
    mode: 'interactive',
    session_id: stringOrNull(payload.session_id),
    outcome: (context.terminationCause && context.terminationCause !== 'succeeded' ? 'failed' : context.outcome) ?? null,
  })
}

export interface ReworkCounts { review_rounds: number; fix_rounds: number; handbacks: number }

const MARKER = /<!--\s*vsk:v1\s+([^>]*?)-->/
const FIX_ROUND = /\bfix round (\d+)\/\d+/g

// Rework lives in the issue's own workflow comments, located by marker and never by heading text
// (dev-setup's conventions.md): the review comments' `round=` is the review count, the ledger's
// `fix round R/3` lines are the fix count, and every hand-back comment is one hand-back. Comments
// that were read and carry none of these measure zero rework; a fetch that failed is the caller's
// null, so "no rework" and "could not look" never print the same.
export function reworkFromComments(bodies: string[]): ReworkCounts {
  const counts: ReworkCounts = { review_rounds: 0, fix_rounds: 0, handbacks: 0 }
  for (const body of bodies) {
    const marker = MARKER.exec(typeof body === 'string' ? body : '')
    if (!marker) continue
    const keys = marker[1] ?? ''
    const type = /\btype=([a-z-]+)/.exec(keys)?.[1]
    if (type === 'review') {
      const round = Number(/\bround=(\d+)/.exec(keys)?.[1] ?? '1')
      counts.review_rounds = Math.max(counts.review_rounds, round)
    } else if (type === 'ledger') {
      for (const match of body.matchAll(FIX_ROUND)) counts.fix_rounds = Math.max(counts.fix_rounds, Number(match[1]))
    } else if (type === 'handback') {
      counts.handbacks += 1
    }
  }
  return counts
}

export type SkillHookSource = 'claude-post-tool' | 'claude-prompt-expansion' | 'codex-prompt'

const MENTION = /\$([a-z0-9][a-z0-9-]*)/g

// Three sources, three confidences, and the record says which: a `Skill` tool call is the model
// choosing a skill, a prompt expansion is a person typing one, and a `$name` in a Codex prompt is
// only a proxy — Codex exposes no skill-activation event, and calling a mention an activation would
// make the skills summary claim precision it does not have.
export function fromSkillHook(hook: unknown, source: SkillHookSource): { sessionId: string | null; invocations: SkillInvocation[] } {
  const payload = hook && typeof hook === 'object' && !Array.isArray(hook) ? hook as Record<string, unknown> : {}
  const sessionId = typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null
  const invocations: SkillInvocation[] = []

  if (source === 'claude-post-tool' && payload.tool_name === 'Skill') {
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input as Record<string, unknown> : {}
    const name = typeof input.skill === 'string' ? input.skill : null
    if (name) invocations.push({ name, trigger: 'model', harness: 'claude' })
  } else if (source === 'claude-prompt-expansion' && typeof payload.command_name === 'string' && payload.command_name !== '') {
    invocations.push({ name: payload.command_name, trigger: 'typed', harness: 'claude' })
  } else if (source === 'codex-prompt' && typeof payload.prompt === 'string') {
    const seen = new Set<string>()
    for (const match of payload.prompt.matchAll(MENTION)) {
      const name = match[1]!
      if (seen.has(name)) continue
      seen.add(name)
      invocations.push({ name, trigger: 'mention', harness: 'codex' })
    }
  }
  return { sessionId, invocations }
}

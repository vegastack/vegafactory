// The status comment: one per issue, written by the CLI, never by hand. It shows where the
// issue is now, how long each stage took (from GitHub's label history), and the progress list.
import { spawnSync } from 'node:child_process'
import { claimsOf, holderOf, LEDGER_MARKER, trustedFactory, type Claim, type ClaimContext, type Trusted } from './claim.ts'
import { ghList, ghRequest } from './gh.ts'
import { readBody, readState, syncIssue, type CacheState, type CommentEntry } from './issue-cache.ts'
import { STATES, stateOf, type State } from './labels.ts'
import { saveSpans } from './stages.ts'

export interface LabelEvent { event: string; label?: { name: string }; created_at: string }
export interface Span { stage: State; start: string; end: string | null }

// Stage spans from labeled/unlabeled events on the state labels, oldest first.
export function stageSpans(events: LabelEvent[]): Span[] {
  const spans: Span[] = []
  const sorted = events.filter((e) => (e.event === 'labeled' || e.event === 'unlabeled') && STATES.includes(e.label?.name as State))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const event of sorted) {
    const name = event.label!.name as State
    const open = spans.at(-1)?.end === null ? spans.at(-1)! : null
    if (event.event === 'labeled') {
      if (open?.stage === name) continue
      if (open) open.end = event.created_at
      spans.push({ stage: name, start: event.created_at, end: null })
    } else if (open?.stage === name) open.end = event.created_at
  }
  return spans
}

export const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—')

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const PROGRESS = /<!--\s*vsk:progress:start\s*-->[\s\S]*?<!--\s*vsk:progress:end\s*-->/

export interface LedgerInput {
  state: CacheState
  body: (entry: CommentEntry) => string
  trusted: Trusted
  spans: Span[]
  branch: string | null
  lastPush: string | null
  progress: string | null
  now: number
}

const WORKING: State[] = ['planning', 'in-progress', 'ready-to-ship']

// Nobody works a queued issue; a waiting one is the operator's. Otherwise credit the latest
// claim made before the stage ended (a claim is posted just before the label moves).
function whoWorked(span: Span, claims: Claim[]): { owner: string; tool: string } {
  if (span.stage === 'waiting-on-operator') return { owner: 'you', tool: '—' }
  if (!WORKING.includes(span.stage)) return { owner: '—', tool: '—' }
  const c = claims.filter((claim) => !span.end || claim.claimedAt <= span.end).at(-1)
  return c ? { owner: `\`${c.owner}\``, tool: `${c.harness}${c.model ? ` · ${c.model}` : ''}` } : { owner: '—', tool: '—' }
}

export function renderLedger(input: LedgerInput): string {
  const { state, body, spans, now, trusted } = input
  const { holder } = holderOf(state, body, now, trusted)
  const { history, ledger } = claimsOf(state, body, trusted)
  const previous = ledger ? body(ledger) : ''
  const current = stateOf(state.issue!.labels).state ?? 'no state'
  const lines = [LEDGER_MARKER, '## Status', '']
  if (holder) {
    const active = holder.active ? ` · ${duration(holder.active * 60_000)} active` : ''
    lines.push(`**${current}** · held by \`${holder.owner}\` (${holder.harness}${holder.model ? ` · ${holder.model}` : ''}) · last active ${when(holder.heartbeat)}${active}`)
  } else lines.push(`**${current}**${current === 'waiting-on-operator' ? ' · waiting on you' : ''} · nobody holds it`)
  if (input.branch) lines.push(`Branch \`${input.branch}\` · last push ${when(input.lastPush)}`)

  if (spans.length) {
    lines.push('', '## Timeline', '', '| Stage | Who | Tool · model | Start | End | Time |', '|---|---|---|---|---|---|')
    for (const span of spans) {
      const end = span.end ? Date.parse(span.end) : now
      const who = whoWorked(span, history)
      lines.push(`| ${span.stage} | ${who.owner} | ${who.tool} | ${when(span.start)} | ${span.end ? when(span.end) : 'now'} | ${duration(end - Date.parse(span.start))} |`)
    }
  }
  const progress = input.progress ?? PROGRESS.exec(previous)?.[0] ?? null
  if (progress) lines.push('', progress.startsWith('<!--') ? progress : `<!-- vsk:progress:start -->\n## Progress\n\n${progress.trim()}\n<!-- vsk:progress:end -->`)
  return `${lines.join('\n')}\n`
}

function gitLine(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() || null : null
}

// Re-renders the status comment from GitHub's current facts and writes it.
export function writeStatus(ctx: ClaimContext, options: { cwd: string; branch?: string; progress?: string | null; now?: number }) {
  const { dir } = syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
  const state = readState(dir)!
  const body = (entry: CommentEntry) => readBody(dir, entry.file)
  const events = ghList<LabelEvent>(`repos/${ctx.repo}/issues/${ctx.number}/timeline`, ctx.runner)
  const spans = stageSpans(events)
  // The same spans answer "which stage was this turn in?" later, without asking GitHub again.
  saveSpans(dir, spans)
  const branch = options.branch ?? gitLine(options.cwd, ['branch', '--show-current'])
  const lastPush = branch ? gitLine(options.cwd, ['log', '-1', '--format=%cI', `origin/${branch}`]) : null
  const trusted = trustedFactory(ctx)
  const text = renderLedger({ state, body, trusted, spans, branch, lastPush, progress: options.progress ?? null, now: options.now ?? Date.now() })
  const { ledger } = claimsOf(state, body, trusted)
  if (ledger) {
    if (body(ledger) !== text) ghRequest(`repos/${ctx.repo}/issues/comments/${ledger.id}`, { method: 'PATCH', body: { body: text }, runner: ctx.runner })
  } else ghRequest(`repos/${ctx.repo}/issues/${ctx.number}/comments`, { method: 'POST', body: { body: text }, runner: ctx.runner })
  return syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
}

// `vegafactory issue …` — the agent's only way to read and write issues.
// Reads come from the local cache after a cheap freshness check; every write goes
// to GitHub first and then refreshes the cache.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { ghRequest, type GhRunner, defaultRunner } from './gh.ts'
import { claim, heartbeat, holderOf, ownerId, release, trustedHolders, type ClaimKind } from './claim.ts'
import { writeStatus } from './status-comment.ts'
import { artifactHash, assertRepo, cacheDir, commentType, dropIssue, permissionLookup, readBody, readState, syncIssue, withLock, WRITE_ROLES, type CacheState, type CommentEntry, type GhComment, type PermissionLookup } from './issue-cache.ts'
import { STATES, sizeOf, stateOf, transition, type State } from './labels.ts'
import { recordStage } from './stages.ts'

export const ACK_STAGES = ['brief', 'plan', 'ship'] as const
export type AckStage = typeof ACK_STAGES[number]

// ---------------------------------------------------------------------------------------------
// Where the cache lives and which repository we are in

// The main checkout's root, so every worktree of a repository shares one cache.
export { artifactHash, permissionLookup, type PermissionLookup }

export function repoRoot(cwd = process.cwd()): string {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('not inside a git repository')
  return dirname(result.stdout.trim())
}

export function detectRepo(root: string): string {
  const devMd = join(root, '.vegastack', 'dev.md')
  const line = existsSync(devMd) ? /^repo:\s*([\w.-]+\/[\w.-]+)/m.exec(readFileSync(devMd, 'utf8'))?.[1] : null
  if (line) return line
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)
  if (!match) throw new Error('cannot tell which GitHub repository this is — pass --repo owner/name')
  return match[1]!
}

// ---------------------------------------------------------------------------------------------
// Artifacts and acks

export function markerKeys(body: string): Record<string, string> {
  const match = /^\s*<!--\s*vsk:v1\s+([^>]*?)\s*-->/.exec(body ?? '')
  const keys: Record<string, string> = {}
  for (const pair of match?.[1]?.split(/\s+/) ?? []) {
    const eq = pair.indexOf('=')
    if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return keys
}

export interface Snapshot { state: CacheState; dir: string; body: (entry: CommentEntry) => string }

export function snapshot(dir: string): Snapshot {
  const state = readState(dir)
  if (!state?.issue) throw new Error(`no cached copy in ${dir} — run vegafactory issue sync first`)
  return { state, dir, body: (entry) => readBody(dir, entry.file) }
}

const byCreated = (a: CommentEntry, b: CommentEntry) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id

export function latestOfType(snap: Snapshot, type: string): CommentEntry | null {
  const matches = Object.values(snap.state.comments).filter((entry) => entry.type === type).sort(byCreated)
  return matches.at(-1) ?? null
}

export function currentHashes(snap: Snapshot): { brief: string; plan: string | null } {
  const plan = latestOfType(snap, 'plan')
  return { brief: artifactHash(readBody(snap.dir, 'issue.md')), plan: plan ? artifactHash(snap.body(plan)) : null }
}

export function ackBody(input: { stage: AckStage; by: string; brief: string; plan: string | null; source: string; quote: string }): string {
  const keys = [`type=ack`, `stage=${input.stage}`, `by=${input.by}`, `brief=${input.brief}`]
  if (input.plan) keys.push(`plan=${input.plan}`)
  keys.push(`source=${input.source}`)
  const quote = input.quote.trim().replace(/\s+/g, ' ').slice(0, 500)
  return `<!-- vsk:v1 ${keys.join(' ')} -->\n**Ack (${input.stage})** from @${input.by}: "${quote}"\n`
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const quoteOf = (ackText: string) => /: "([\s\S]*)"\s*$/.exec(ackText)?.[1] ?? '\u0000'

// The latest moment the brief or the plan changed.
export function artifactsChangedAt(snap: Snapshot): string {
  const plan = latestOfType(snap, 'plan')
  const brief = snap.state.issue!.bodyChangedAt
  return plan && plan.changedAt > brief ? plan.changedAt : brief
}

export interface AckVerdict { ok: boolean; reason: string; ack: CommentEntry | null }

// A valid ack: a person with write access acknowledged exactly the current brief (and plan).
// An app or bot may relay an ack only by citing the person's own comment.
export function findValidAck(snap: Snapshot, stage: AckStage, permission: PermissionLookup, after: string | null = null): AckVerdict {
  const hashes = currentHashes(snap)
  const needPlan = stage !== 'brief'
  if (needPlan && !hashes.plan && !snap.state.issue!.labels.includes('small')) {
    return { ok: false, reason: 'no plan comment yet', ack: null }
  }
  const acks = Object.values(snap.state.comments).filter((entry) => entry.type === 'ack').sort(byCreated).reverse()
  let lastReason = `no ${stage} ack yet`
  for (const entry of acks) {
    const keys = markerKeys(snap.body(entry))
    if (keys.stage !== stage) continue
    if (after && entry.createdAt <= after) { lastReason = `the ${stage} ack predates the latest evidence`; continue }
    if (keys.brief !== hashes.brief) { lastReason = `the brief changed after the ${stage} ack`; continue }
    if (needPlan && hashes.plan && keys.plan !== hashes.plan) { lastReason = `the plan changed after the ${stage} ack`; continue }
    const by = keys.by ?? ''
    if (!WRITE_ROLES.has(permission(by))) { lastReason = `@${by} has no write access`; continue }
    if (keys.source?.startsWith('comment:')) {
      const source = snap.state.comments[keys.source.slice('comment:'.length)]
      if (!source || source.author !== by || source.authorType === 'Bot') { lastReason = 'the ack cites a comment that is missing or not from that person'; continue }
      // The person's own words must postdate the artifacts they approve, be unedited since, and say what the ack quotes.
      if (source.createdAt <= artifactsChangedAt(snap)) { lastReason = `the cited comment predates the current brief or plan`; continue }
      if (source.updatedAt > entry.createdAt) { lastReason = 'the cited comment was edited after the ack'; continue }
      if (!squash(snap.body(source)).includes(squash(quoteOf(snap.body(entry))))) { lastReason = 'the cited comment does not contain the quoted words'; continue }
    } else if (entry.author !== by || entry.authorType === 'Bot') {
      lastReason = 'a session ack must be posted by the person themselves'
      continue
    }
    return { ok: true, reason: `acked by @${by}`, ack: entry }
  }
  return { ok: false, reason: lastReason, ack: null }
}

// ---------------------------------------------------------------------------------------------
// Checks before an agent acts

export type CheckFor = 'plan' | 'implement' | 'ship'

// A "ship it" must postdate the evidence's last meaningful edit; editing the evidence voids it.
export const evidenceChangedAt = (evidence: CommentEntry) => evidence.changedAt || evidence.updatedAt

export interface CheckResult { ok: boolean; blocks: string[]; warns: string[]; state: State | null; size: string | null }

export function checkIssue(snap: Snapshot, purpose: CheckFor, permission: PermissionLookup, options: { repo: string; devMdRepo?: string | null; resume?: boolean } ): CheckResult {
  const issue = snap.state.issue!
  const blocks: string[] = []
  const warns: string[] = []
  if (issue.state !== 'open') blocks.push(`issue is ${issue.state}`)
  if (options.devMdRepo && options.devMdRepo !== options.repo) blocks.push(`issue repo ${options.repo} does not match dev.md repo ${options.devMdRepo}`)
  const { state, problem } = stateOf(issue.labels)
  if (problem) blocks.push(problem)
  const size = sizeOf(issue.labels)
  if (!size && !issue.labels.includes('epic')) blocks.push('needs exactly one size label: small, medium, large or research')
  if (issue.labels.includes('epic') && purpose !== 'plan') blocks.push('an epic is a map; work its sub-issues instead')

  const expected: Record<CheckFor, State[]> = {
    plan: ['planning'],
    implement: options.resume ? ['queued', 'in-progress', 'ready-to-ship'] : ['queued'],
    ship: ['ready-to-ship'],
  }
  if (state && !expected[purpose].includes(state)) blocks.push(`issue is ${state}, expected ${expected[purpose].join(' or ')}`)
  if (purpose === 'implement' && issue.blockedBy.length) blocks.push(`blocked by open issues: ${issue.blockedBy.map((n) => `#${n}`).join(', ')}`)

  if (purpose === 'plan') {
    const ack = findValidAck(snap, 'brief', permission)
    if (!ack.ok) blocks.push(`brief not acked: ${ack.reason}`)
  } else if (purpose === 'implement' && size !== 'research') {
    const ack = findValidAck(snap, 'plan', permission)
    if (!ack.ok) blocks.push(`plan not acked: ${ack.reason}`)
  } else if (purpose === 'implement') {
    const ack = findValidAck(snap, 'brief', permission)
    if (!ack.ok) blocks.push(`brief not acked: ${ack.reason}`)
  } else if (purpose === 'ship') {
    const evidence = latestOfType(snap, 'evidence')
    if (!evidence) blocks.push('no evidence comment yet')
    const ack = findValidAck(snap, 'ship', permission, evidence ? evidenceChangedAt(evidence) : null)
    if (!ack.ok) blocks.push(`no "ship it": ${ack.reason}`)
  }
  if (/^##\s+Assumptions\b[\s\S]*?^\s*-\s+(?!\[x\])/im.test(readBody(snap.dir, 'issue.md')) && purpose === 'implement') {
    warns.push('the brief lists open assumptions — confirm each is settled')
  }
  return { ok: blocks.length === 0, blocks, warns, state, size }
}

// ---------------------------------------------------------------------------------------------
// Writes

export interface WriteContext { root: string; repo: string; number: number; runner: GhRunner }

// Holds the issue's lock for a whole read → check → write → refresh step.
export function locked<T>(ctx: WriteContext, fn: () => T): T {
  return withLock(cacheDir(ctx.root, ctx.repo, ctx.number), fn)
}

const refresh = (ctx: WriteContext) => syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })

function conflictIfChanged(ctx: WriteContext, commentId: number | null, since: number) {
  const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
  const rev = commentId === null ? snap.state.issue!.rev : snap.state.comments[String(commentId)]?.rev
  if (rev === undefined) throw new Error(`comment ${commentId} is not on issue #${ctx.number}`)
  if (rev > since) {
    const file = commentId === null ? 'issue.md' : snap.state.comments[String(commentId)]!.file
    throw new Error(`conflict: ${file} changed after cursor ${since} (now at ${rev}) — read it again, merge your edit, and retry with --since ${snap.state.rev}`)
  }
}

export function postComment(ctx: WriteContext, body: string): GhComment {
  const { body: comment } = ghRequest<GhComment>(`repos/${ctx.repo}/issues/${ctx.number}/comments`, { method: 'POST', body: { body }, runner: ctx.runner })
  return comment
}

export function editComment(ctx: WriteContext, commentId: number, body: string, since: number) {
  return locked(ctx, () => {
    refresh(ctx)
    conflictIfChanged(ctx, commentId, since)
    ghRequest(`repos/${ctx.repo}/issues/comments/${commentId}`, { method: 'PATCH', body: { body }, runner: ctx.runner })
    return refresh(ctx)
  })
}

export function editBody(ctx: WriteContext, body: string, since: number) {
  return locked(ctx, () => {
    refresh(ctx)
    conflictIfChanged(ctx, null, since)
    ghRequest(`repos/${ctx.repo}/issues/${ctx.number}`, { method: 'PATCH', body: { body }, runner: ctx.runner })
    return refresh(ctx)
  })
}

export function editLabels(ctx: WriteContext, add: string[], remove: string[]) {
  if (add.length) ghRequest(`repos/${ctx.repo}/issues/${ctx.number}/labels`, { method: 'POST', body: { labels: add }, runner: ctx.runner })
  for (const label of remove) {
    try {
      ghRequest(`repos/${ctx.repo}/issues/${ctx.number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE', runner: ctx.runner })
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
    }
  }
}

// The final label set: at most one state label, whatever the request.
export function nextLabels(current: string[], change: { state?: State; add?: string[]; remove?: string[] }): string[] {
  let labels = current.filter((label) => !(change.remove ?? []).includes(label))
  if (change.state) labels = labels.filter((label) => !(STATES as readonly string[]).includes(label)).concat(change.state)
  labels = [...new Set([...labels, ...(change.add ?? [])])]
  if (labels.filter((label) => (STATES as readonly string[]).includes(label)).length > 1) {
    throw new Error(`issue would carry two state labels (${labels.filter((label) => (STATES as readonly string[]).includes(label)).join(', ')}) — pass --state to pick one`)
  }
  return labels
}

// Replaces the whole label set in one request, so no reader sees two state labels. The state it
// lands on is written down with its time, so a turn is later credited to the stage it happened in.
export function setLabels(ctx: WriteContext, labels: string[]) {
  ghRequest(`repos/${ctx.repo}/issues/${ctx.number}/labels`, { method: 'PUT', body: { labels }, runner: ctx.runner })
  const state = stateOf(labels).state
  if (state) recordStage(ctx.root, ctx.repo, ctx.number, state)
}

export function moveTo(ctx: WriteContext, next: State) {
  locked(ctx, () => {
    const { dir } = refresh(ctx)
    setLabels(ctx, nextLabels(readState(dir)!.issue!.labels, { state: next }))
  })
}

// ---------------------------------------------------------------------------------------------
// CLI

export function issueUsage(): string {
  return `Usage: vegafactory issue <verb> <number> [options]

Read (agents read the files under .vegastack/.tmp/issues/<owner>__<repo>/<number>/):
  sync <n> [--since CURSOR]              refresh the local copy; print only what changed since CURSOR
  check <n> --for plan|implement|ship    the facts that must hold before acting (exit 2 when blocked)

Write (GitHub first, then the local copy):
  comment <n> --file PATH                post a new comment
  edit-comment <n> <comment-id> --file PATH --since CURSOR
  body <n> --file PATH --since CURSOR    replace the issue body
  label <n> [--add a,b] [--remove c] [--since CURSOR] [--state ${STATES.join('|')}]
  ack <n> --stage brief|plan|ship --by LOGIN --quote TEXT [--source comment:ID|session]
  claim <n> --harness claude|codex --model ID [--kind session|dispatch] [--take-back-by LOGIN]
                                         exit 2 when someone else holds it
  release <n> [--reason TEXT]            give the issue up
  heartbeat <n> [--active MINUTES]       mark the claim alive (hooks call this)
  status <n> [--progress-file PATH] [--branch NAME]
                                         rewrite the status comment from GitHub's facts
  holder <n>                             who holds the issue
  drop <n> --yes                         delete the local copy

Options: --repo OWNER/NAME (default: dev.md repo: or the origin remote) · --json · --dry-run shows
what a write verb would do · --yes confirms drop. claim, release and heartbeat always act as this
checkout (machine:worktree-folder); only a take-back displaces another holder.`
}

interface Parsed { verb: string; number: number; positional: string[]; flags: Record<string, string>; json: boolean; dryRun: boolean; yes: boolean }

export function parseIssueArgs(argv: string[]): Parsed {
  const [verb, rawNumber, ...rest] = argv
  if (!verb) throw new Error('missing verb — run vegafactory issue --help')
  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`issue ${verb} needs an issue number`)
  const flags: Record<string, string> = {}
  const positional: string[] = []
  let json = false
  let dryRun = false
  let yes = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--json') { json = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--yes') { yes = true; continue }
    if (arg.startsWith('--')) {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      flags[arg.slice(2)] = value
      i++
    } else positional.push(arg)
  }
  return { verb, number, positional, flags, json, dryRun, yes }
}

function worktreeName(cwd: string): string {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).stdout.trim()
  return basename(top || cwd)
}

const list = (value?: string) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [])
const cursor = (value?: string) => {
  const n = Number(value)
  if (value === undefined || !Number.isSafeInteger(n) || n < 0) throw new Error('--since needs the cursor printed by issue sync')
  return n
}

export function runIssue(argv: string[], { runner = defaultRunner, cwd = process.cwd(), out = console.log } = {}): number {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0]!)) { out(issueUsage()); return 0 }
  const args = parseIssueArgs(argv)
  const root = repoRoot(cwd)
  const repo = assertRepo(args.flags.repo ?? detectRepo(root))
  const ctx: WriteContext = { root, repo, number: args.number, runner }
  const print = (value: unknown, text: string) => out(args.json ? JSON.stringify(value, null, 2) : text)
  // A session acts only as itself, so it cannot release or keep alive someone else's claim.
  if (args.flags.owner !== undefined) throw new Error('--owner is not accepted: claim, release and heartbeat act as this checkout (machine:worktree-folder)')
  const owner = ownerId(worktreeName(cwd))
  const sync = (since = 0) => syncIssue({ root, repo, number: args.number, since, runner })
  // Each write verb validates everything first; a dry run then stops before any request.
  const preview = (what: string, detail: Record<string, unknown> = {}) => {
    if (!args.dryRun) return false
    print({ dryRun: true, verb: args.verb, ...detail }, `dry run: would ${what}`)
    return true
  }
  // Acks, claims and releases are written only by their own verbs, which check what they record.
  const input = (flag = 'file') => {
    if (!args.flags[flag]) throw new Error(`--${flag} is required`)
    const text = readFileSync(resolve(cwd, args.flags[flag]!), 'utf8')
    const type = commentType(text)
    if (['ack', 'claim', 'release'].includes(type)) throw new Error(`the text starts with a type=${type} marker — only \`vegafactory issue ${type}\` writes those`)
    return text
  }

  switch (args.verb) {
    case 'sync': {
      const result = sync(args.flags.since === undefined ? 0 : cursor(args.flags.since))
      const lines = result.changes.map((change) => `${change.kind === 'removed' ? 'removed' : 'changed'} ${change.file}`)
      print(result, [`dir ${result.dir}`, `cursor ${result.cursor}`, ...(lines.length ? lines : ['no changes'])].join('\n'))
      return 0
    }
    case 'check': {
      const purpose = args.flags.for as CheckFor
      if (!['plan', 'implement', 'ship'].includes(purpose)) throw new Error('--for must be plan, implement or ship')
      const dir = sync().dir
      const devMd = join(root, '.vegastack', 'dev.md')
      const devMdRepo = existsSync(devMd) ? /^repo:\s*(\S+)/m.exec(readFileSync(devMd, 'utf8'))?.[1] ?? null : null
      const result = checkIssue(snapshot(dir), purpose, permissionLookup(repo, runner), { repo, devMdRepo, resume: args.flags.resume === 'true' })
      print(result, [result.ok ? 'ok' : 'blocked', ...result.blocks.map((b) => `block: ${b}`), ...result.warns.map((w) => `warn: ${w}`)].join('\n'))
      return result.ok ? 0 : 2
    }
    case 'comment': {
      const text = input()
      if (preview(`post a ${text.length}-character comment on ${repo}#${args.number}`)) return 0
      const { comment, result } = locked(ctx, () => { sync(); const comment = postComment(ctx, text); return { comment, result: sync() } })
      print({ id: comment.id, url: comment.html_url, cursor: result.cursor }, `posted ${comment.html_url}\ncursor ${result.cursor}`)
      return 0
    }
    case 'edit-comment': {
      const id = Number(args.positional[0])
      if (!Number.isSafeInteger(id)) throw new Error('edit-comment needs a comment id')
      const text = input()
      const since = cursor(args.flags.since)
      if (preview(`replace comment ${id} on ${repo}#${args.number}`, { id, since })) return 0
      const result = editComment(ctx, id, text, since)
      print({ id, cursor: result.cursor }, `edited comment ${id}\ncursor ${result.cursor}`)
      return 0
    }
    case 'body': {
      const text = input()
      const since = cursor(args.flags.since)
      if (preview(`replace the body of ${repo}#${args.number}`, { since })) return 0
      const result = editBody(ctx, text, since)
      print({ cursor: result.cursor }, `edited the issue body\ncursor ${result.cursor}`)
      return 0
    }
    case 'label': {
      const next = args.flags.state as State | undefined
      if (next && !STATES.includes(next)) throw new Error(`--state must be one of ${STATES.join(', ')}`)
      const add = list(args.flags.add)
      const remove = list(args.flags.remove)
      if ([...add, ...remove].some((label) => (STATES as readonly string[]).includes(label))) throw new Error('state labels change only through --state, so an issue never carries two')
      if (!next && !add.length && !remove.length) throw new Error('label needs --state, --add or --remove')
      const since = args.flags.since === undefined ? null : cursor(args.flags.since)
      if (preview(`set labels on ${repo}#${args.number}`, { state: next ?? null, add, remove })) return 0
      const result = locked(ctx, () => {
        const { dir } = sync()
        if (since !== null) conflictIfChanged(ctx, null, since)
        setLabels(ctx, nextLabels(readState(dir)!.issue!.labels, { state: next, add, remove }))
        return sync()
      })
      const labels = readState(result.dir)!.issue!.labels
      print({ labels, cursor: result.cursor }, `labels ${labels.join(', ')}\ncursor ${result.cursor}`)
      return 0
    }
    case 'ack': {
      const stage = args.flags.stage as AckStage
      if (!ACK_STAGES.includes(stage)) throw new Error('--stage must be brief, plan or ship')
      if (!args.flags.by || !args.flags.quote) throw new Error('--by and --quote are required')
      const source = args.flags.source ?? 'session'
      if (source !== 'session' && !/^comment:\d+$/.test(source)) throw new Error('--source must be session or comment:<id>')
      const by = args.flags.by.replace(/^@/, '')
      const quote = args.flags.quote
      if (preview(`record a ${stage} ack from @${by} on ${repo}#${args.number}`, { stage, by, source })) return 0
      const { comment, result } = locked(ctx, () => {
        const hashes = currentHashes(snapshot(sync().dir))
        const comment = postComment(ctx, ackBody({ stage, by, brief: hashes.brief, plan: stage === 'brief' ? null : hashes.plan, source, quote }))
        return { comment, result: sync() }
      })
      print({ id: comment.id, url: comment.html_url, cursor: result.cursor }, `recorded ${stage} ack ${comment.html_url}\ncursor ${result.cursor}`)
      return 0
    }
    case 'claim': {
      const kind = (args.flags.kind ?? 'session') as ClaimKind
      if (kind !== 'session' && kind !== 'dispatch') throw new Error('--kind must be session or dispatch')
      if (!args.flags.harness || !args.flags.model) throw new Error('--harness and --model are required')
      const outcome = claim(ctx, { owner, kind, harness: args.flags.harness, model: args.flags.model, takeBackBy: args.flags['take-back-by']?.replace(/^@/, '') })
      const wait = outcome.waitMs ? `\nwait up to ${outcome.waitMs / 60_000} min for the previous holder's last push, then pull the branch` : ''
      print(outcome, `${outcome.ok ? 'ok' : 'blocked'}: ${outcome.message}${wait}`)
      return outcome.ok ? 0 : 2
    }
    case 'release':
      release(ctx, owner, owner, args.flags.reason ?? 'done')
      print({ released: owner }, `released ${owner}`)
      return 0
    case 'heartbeat': {
      const active = Number(args.flags.active ?? 0)
      if (!Number.isFinite(active) || active < 0) throw new Error('--active needs a number of minutes')
      heartbeat(ctx, owner, Math.round(active))
      print({ owner }, `heartbeat ${owner}`)
      return 0
    }
    case 'holder': {
      const dir = sync().dir
      const snap = snapshot(dir)
      const { holder, stale } = holderOf(snap.state, snap.body, Date.now(), trustedHolders(ctx))
      print({ holder, stale }, holder ? `${holder.owner} (${holder.harness}${holder.model ? ` · ${holder.model}` : ''}) · last active ${holder.heartbeat}` : 'nobody')
      return 0
    }
    case 'status': {
      const progress = args.flags['progress-file'] ? readFileSync(resolve(cwd, args.flags['progress-file']), 'utf8') : null
      const result = writeStatus(ctx, { cwd, branch: args.flags.branch, progress })
      print({ cursor: result.cursor }, `status comment updated\ncursor ${result.cursor}`)
      return 0
    }
    case 'drop':
      if (preview(`delete the local copy of #${args.number}`)) return 0
      if (!args.yes) throw new Error('drop deletes the local copy of the issue — pass --yes to confirm')
      dropIssue(root, repo, args.number)
      print({ dropped: true }, `dropped the local copy of #${args.number}`)
      return 0
    default:
      throw new Error(`unknown issue verb: ${args.verb} — run vegafactory issue --help`)
  }
}

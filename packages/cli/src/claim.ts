// Who holds an issue. A claim is a `type=claim` comment; a release is a `type=release`
// comment; only people with write access can post either. The holder is the earliest claim
// after the latest release, as long as its heartbeat is fresh. The heartbeat is a
// `vsk:claim` row on the holder's own claim comment, which only that holder's hooks edit.
import { hostname, userInfo } from 'node:os'
import { ghRequest, type GhRunner } from './gh.ts'
import { permissionLookup, readBody, readState, syncIssue, WRITE_ROLES, type CacheState, type CommentEntry, type PermissionLookup } from './issue-cache.ts'
import { stateOf, transition } from './labels.ts'
import { recordStage } from './stages.ts'

export type ClaimKind = 'session' | 'dispatch'
export const TIMEOUT_MS: Record<ClaimKind, number> = { session: 4 * 60 * 60_000, dispatch: 30 * 60_000 }
export const HEARTBEAT_EVERY_MS = 5 * 60_000

export interface Claim {
  owner: string
  kind: ClaimKind
  harness: string
  model: string
  claimedAt: string
  commentId: number
}
export interface Holder extends Claim { heartbeat: string; active: number; stale: boolean }

export function machineName(host = hostname()): string {
  return host.toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'machine'
}

// The name a node answers to: `<os-user>@<hostname>`, for example `mk@patrick-mac-mini`.
//
// Derived, never configured, so there is nothing to set up and nothing to drift. Two people
// sharing one machine are two nodes, and one person with three machines is three nodes and one
// owner — which is what makes "everything this person did" answerable across machines.
//
// The hostname is cut to its first label because that is the part that names the machine:
// `os.hostname()` answers `patrick-mac-mini.local` on macOS and a full domain name on many Linux
// hosts, and neither belongs in an identity a person has to recognise in a table. `scutil --get
// LocalHostName` gives the clean name directly but exists only on macOS, and this has to be the
// same rule on both.
//
// Deliberately **not** `machineName`: that maps every non-alphanumeric to a dash, which would turn
// this into `mk-patrick-mac-mini`, and it is also what `ownerId` stamps on every session claim
// that exists right now. Changing it would reshape claims already posted on GitHub.
export function nodeId(user = userInfo().username, host = hostname()): string {
  return `${namePart(user) || 'someone'}@${namePart(host.split('.')[0] ?? '') || 'machine'}`
}

// One rule for both halves, so the two sides of an id cannot be normalised differently.
const namePart = (value: string): string =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')

// One worktree is used by one session at a time, so machine + worktree folder names the holder.
export function ownerId(worktreeName: string, host = hostname()): string {
  return `${machineName(host)}:${worktreeName}`
}

export function markerKeys(body: string, marker = 'vsk:v1'): Record<string, string> {
  const match = new RegExp(`<!--\\s*${marker.replace(':', '\\:')}\\s+([^>]*?)\\s*-->`).exec(body ?? '')
  const keys: Record<string, string> = {}
  for (const pair of match?.[1]?.split(/\s+/) ?? []) {
    const eq = pair.indexOf('=')
    if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return keys
}

export function claimBody(input: { owner: string; kind: ClaimKind; harness: string; model: string; note?: string }): string {
  return `<!-- vsk:v1 type=claim owner=${input.owner} kind=${input.kind} harness=${input.harness} model=${input.model} -->\n`
    + `Claimed by \`${input.owner}\` (${input.harness}${input.model ? ` · ${input.model}` : ''})${input.note ? ` — ${input.note}` : ''}\n`
}

export function releaseBody(input: { owner: string; by: string; reason: string }): string {
  return `<!-- vsk:v1 type=release owner=${input.owner} by=${input.by} -->\nReleased \`${input.owner}\` — ${input.reason}\n`
}

export function claimLine(owner: string, heartbeat: string, activeMinutes = 0): string {
  return `<!-- vsk:claim owner=${owner} heartbeat=${heartbeat} active=${activeMinutes} -->`
}

// The heartbeat row for this owner in a claim comment, or null.
export function heartbeatOf(claimBody: string | null, owner: string): { heartbeat: string; active: number } | null {
  if (!claimBody) return null
  for (const match of claimBody.matchAll(/<!--\s*vsk:claim\s+([^>]*?)\s*-->/g)) {
    const keys = markerKeys(match[0], 'vsk:claim')
    if (keys.owner === owner && keys.heartbeat) return { heartbeat: keys.heartbeat, active: Number(keys.active ?? 0) }
  }
  return null
}

// The claim comment with this owner's row replaced (or added under the marker line).
export function withHeartbeat(claimBody: string, owner: string, heartbeat: string, activeMinutes: number): string {
  const lines = claimBody.split('\n').filter((row) => !/<!--\s*vsk:claim\b/.test(row))
  const marker = lines.findIndex((row) => /<!--\s*vsk:v1\b/.test(row))
  lines.splice(marker + 1, 0, claimLine(owner, heartbeat, activeMinutes))
  return lines.join('\n')
}

type Body = (entry: CommentEntry) => string
// Whether a claim or release comment counts: its author must be a person with write access.
export type Trusted = (entry: CommentEntry) => boolean

// The factory's one automation identity: the VegaFactory GitHub App, which only a holder of its
// private key can post as.
export const APP_ACTOR = 'vegafactory[bot]'

// A person with write access. This is what judges a review or an ack: no bot stands in for one.
export const trustBy = (permission: PermissionLookup): Trusted => (entry) => entry.authorType !== 'Bot' && !!entry.author && WRITE_ROLES.has(permission(entry.author))

// Who may post the factory's own work: a claim, a release, the status comment, a review. A
// dispatched run writes all of them as the App, and each one is judged by its own shape — a claim
// by its marker, a review by the fields that must agree with the findings it summarises. Judging
// finished work is the other half and never comes here: an acknowledgement, an acceptance of what
// a review left open and "ship it" go through `trustBy`, where a bot never counts.
export const trustFactoryBy = (permission: PermissionLookup): Trusted => (entry) => entry.author === APP_ACTOR || trustBy(permission)(entry)

export const trustedAuthors = (ctx: { repo: string; runner: GhRunner; root?: string }): Trusted => trustBy(permissionLookup(ctx.repo, ctx.runner, { root: ctx.root }))
export const trustedFactory = (ctx: { repo: string; runner: GhRunner; root?: string }): Trusted => trustFactoryBy(permissionLookup(ctx.repo, ctx.runner, { root: ctx.root }))

// Live claims (after the latest release of each owner), every claim ever made, and the one
// status comment. All three count only from trusted authors.
export function claimsOf(state: CacheState, body: Body, trusted: Trusted): { claims: Claim[]; history: Claim[]; ledger: CommentEntry | null } {
  const comments = Object.values(state.comments).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
  let claims: Claim[] = []
  const history: Claim[] = []
  let ledger: CommentEntry | null = null
  for (const entry of comments) {
    if (!['ledger', 'release', 'claim'].includes(entry.type) || !trusted(entry)) continue
    // The earliest trusted status comment is the one; later copies are ignored.
    if (entry.type === 'ledger') ledger ??= entry
    if (entry.type === 'release') {
      const keys = markerKeys(body(entry))
      claims = keys.owner ? claims.filter((claim) => claim.owner !== keys.owner) : []
    }
    if (entry.type === 'claim') {
      const keys = markerKeys(body(entry))
      if (!keys.owner) continue
      const claim: Claim = {
        owner: keys.owner, kind: keys.kind === 'dispatch' ? 'dispatch' : 'session',
        harness: keys.harness ?? '', model: keys.model ?? '', claimedAt: entry.createdAt, commentId: entry.id,
      }
      history.push(claim)
      if (!claims.some((live) => live.owner === claim.owner)) claims.push(claim)
    }
  }
  return { claims, history, ledger }
}

// The current holder: the earliest live claim. Stale claims are reported but do not hold.
export function holderOf(state: CacheState, body: Body, now: number, trusted: Trusted): { holder: Holder | null; stale: Holder[] } {
  const { claims } = claimsOf(state, body, trusted)
  const stale: Holder[] = []
  for (const claim of claims) {
    const entry = state.comments[String(claim.commentId)]
    const beat = heartbeatOf(entry ? body(entry) : null, claim.owner)
    const heartbeat = beat?.heartbeat ?? claim.claimedAt
    const isStale = now - Date.parse(heartbeat) > TIMEOUT_MS[claim.kind]
    const holder = { ...claim, heartbeat, active: beat?.active ?? 0, stale: isStale }
    if (!isStale) return { holder, stale }
    stale.push(holder)
  }
  return { holder: null, stale }
}

// ---------------------------------------------------------------------------------------------
// Claim operations. Each one reads GitHub fresh (through the cache) before and after writing.

export const LEDGER_MARKER = '<!-- vsk:v1 type=ledger -->'

export interface ClaimContext {
  root: string
  repo: string
  number: number
  runner: GhRunner
}

interface Fresh { state: CacheState; dir: string; body: Body }

function fresh(ctx: ClaimContext): Fresh {
  const { dir } = syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
  const state = readState(dir)
  if (!state?.issue) throw new Error(`issue #${ctx.number} is not cached`)
  return { state, dir, body: (entry) => readBody(dir, entry.file) }
}

function post(ctx: ClaimContext, body: string): number {
  return ghRequest<{ id: number }>(`repos/${ctx.repo}/issues/${ctx.number}/comments`, { method: 'POST', body: { body }, runner: ctx.runner }).body.id
}

// Writes this owner's heartbeat on its own claim comment. Nobody else edits that comment, and
// heartbeat rows are not content: they never bump the cache cursor.
export function heartbeat(ctx: ClaimContext, owner: string, activeMinutes = 0, now = Date.now(), trusted = trustedFactory(ctx)) {
  const f = fresh(ctx)
  const live = claimsOf(f.state, f.body, trusted).claims.find((claim) => claim.owner === owner)
  const entry = live ? f.state.comments[String(live.commentId)] : undefined
  if (!live || !entry) throw new Error(`${owner} holds no claim on #${ctx.number}`)
  const body = withHeartbeat(f.body(entry), owner, new Date(now).toISOString(), activeMinutes)
  ghRequest(`repos/${ctx.repo}/issues/comments/${live.commentId}`, { method: 'PATCH', body: { body }, runner: ctx.runner })
  syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
}

export function release(ctx: ClaimContext, owner: string, by: string, reason: string) {
  post(ctx, releaseBody({ owner, by, reason }))
  syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
}

export interface ClaimRequest { owner: string; kind: ClaimKind; harness: string; model: string; takeBackBy?: string }
export interface ClaimOutcome {
  ok: boolean
  message: string
  holder: Holder | null
  // Set after a take-back from a live holder: wait up to this long for its last push.
  waitMs: number
}

export function claim(ctx: ClaimContext, request: ClaimRequest, now = Date.now()): ClaimOutcome {
  const permission = permissionLookup(ctx.repo, ctx.runner, { root: ctx.root })
  const trusted = trustFactoryBy(permission)
  const holderNow = () => { const f = fresh(ctx); return holderOf(f.state, f.body, now, trusted) }
  const before = holderNow()
  if (before.holder?.owner === request.owner) {
    heartbeat(ctx, request.owner, 0, now, trusted)
    return { ok: true, message: `already held by ${request.owner}`, holder: before.holder, waitMs: 0 }
  }
  if (before.holder && !request.takeBackBy) {
    const h = before.holder
    return { ok: false, message: `held by ${h.owner} (${h.harness}${h.model ? ` · ${h.model}` : ''}), last active ${h.heartbeat} — take it back with --take-back-by <login>`, holder: h, waitMs: 0 }
  }
  if (request.takeBackBy && !WRITE_ROLES.has(permission(request.takeBackBy))) {
    return { ok: false, message: `@${request.takeBackBy} has no write access, so cannot take the issue back`, holder: before.holder, waitMs: 0 }
  }
  const previous = [...before.stale, ...(before.holder ? [before.holder] : [])]
  for (const old of previous) {
    const reason = old.stale ? `no heartbeat since ${old.heartbeat}` : `taken back by @${request.takeBackBy}`
    post(ctx, releaseBody({ owner: old.owner, by: request.takeBackBy ?? request.owner, reason }))
  }
  post(ctx, claimBody({ ...request, note: request.takeBackBy ? `taken back by @${request.takeBackBy}` : undefined }))

  // Two sessions can claim at once: both re-read, the earliest live claim wins, the other backs off.
  const after = holderNow()
  if (after.holder?.owner !== request.owner) {
    release(ctx, request.owner, request.owner, `lost the race to ${after.holder?.owner ?? 'another claim'}`)
    return { ok: false, message: `lost the race to ${after.holder?.owner}`, holder: after.holder, waitMs: 0 }
  }
  heartbeat(ctx, request.owner, 0, now, trusted)
  const f = fresh(ctx)
  if (stateOf(f.state.issue!.labels).state === 'queued') {
    const edit = transition(f.state.issue!.labels, 'in-progress')
    if (edit.add.length) ghRequest(`repos/${ctx.repo}/issues/${ctx.number}/labels`, { method: 'POST', body: { labels: edit.add }, runner: ctx.runner })
    for (const label of edit.remove) {
      try {
        ghRequest(`repos/${ctx.repo}/issues/${ctx.number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE', runner: ctx.runner })
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error
      }
    }
    recordStage(ctx.root, ctx.repo, ctx.number, 'in-progress')
    syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
  }
  const live = before.holder && !before.holder.stale
  return { ok: true, message: `claimed by ${request.owner}`, holder: after.holder, waitMs: live ? 2 * 60_000 : 0 }
}

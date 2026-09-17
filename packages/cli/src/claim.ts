// Who holds an issue. A claim is a `type=claim` comment; a release is a `type=release`
// comment. The holder is the earliest claim after the latest release, as long as its
// heartbeat is fresh. The heartbeat lives on the status (ledger) comment's claim line,
// which hooks refresh — never the model.
import { hostname } from 'node:os'
import { ghRequest, type GhRunner } from './gh.ts'
import { readBody, readState, syncIssue, type CacheState, type CommentEntry } from './issue-cache.ts'
import { stateOf, transition } from './labels.ts'

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
export interface Holder extends Claim { heartbeat: string; stale: boolean }

export function machineName(host = hostname()): string {
  return host.toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'machine'
}

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

// The heartbeat on the ledger for this owner, or null.
export function heartbeatOf(ledgerBody: string | null, owner: string): { heartbeat: string; active: number } | null {
  if (!ledgerBody) return null
  for (const match of ledgerBody.matchAll(/<!--\s*vsk:claim\s+([^>]*?)\s*-->/g)) {
    const keys = markerKeys(match[0], 'vsk:claim')
    if (keys.owner === owner && keys.heartbeat) return { heartbeat: keys.heartbeat, active: Number(keys.active ?? 0) }
  }
  return null
}

// Replaces this owner's claim line (or adds one under the marker line).
export function withHeartbeat(ledgerBody: string, owner: string, heartbeat: string, activeMinutes: number): string {
  const line = claimLine(owner, heartbeat, activeMinutes)
  const lines = ledgerBody.split('\n').filter((row) => {
    const keys = /<!--\s*vsk:claim\b/.test(row) ? markerKeys(row, 'vsk:claim') : null
    return !keys || keys.owner !== owner
  })
  const marker = lines.findIndex((row) => /<!--\s*vsk:v1\s+type=ledger\b/.test(row))
  lines.splice(marker === -1 ? 0 : marker + 1, 0, line)
  return lines.join('\n')
}

type Body = (entry: CommentEntry) => string

// Live claims (after the latest release of each owner), every claim ever made, and the status comment.
export function claimsOf(state: CacheState, body: Body): { claims: Claim[]; history: Claim[]; ledger: CommentEntry | null } {
  const comments = Object.values(state.comments).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
  let claims: Claim[] = []
  const history: Claim[] = []
  let ledger: CommentEntry | null = null
  for (const entry of comments) {
    if (entry.type === 'ledger') ledger = entry
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
export function holderOf(state: CacheState, body: Body, now = Date.now()): { holder: Holder | null; stale: Holder[] } {
  const { claims, ledger } = claimsOf(state, body)
  const ledgerBody = ledger ? body(ledger) : null
  const stale: Holder[] = []
  for (const claim of claims) {
    const beat = heartbeatOf(ledgerBody, claim.owner)?.heartbeat ?? claim.claimedAt
    const isStale = now - Date.parse(beat) > TIMEOUT_MS[claim.kind]
    const holder = { ...claim, heartbeat: beat, stale: isStale }
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

function patch(ctx: ClaimContext, commentId: number, body: string) {
  ghRequest(`repos/${ctx.repo}/issues/comments/${commentId}`, { method: 'PATCH', body: { body }, runner: ctx.runner })
}

export function emptyLedger(): string {
  return `${LEDGER_MARKER}\n## Status\n\n_Not started._\n`
}

// Writes this owner's heartbeat on the status comment, creating the comment when missing.
// Heartbeat lines are not content: they never bump the cache cursor or break an edit.
export function heartbeat(ctx: ClaimContext, owner: string, activeMinutes = 0, now = Date.now()) {
  const f = fresh(ctx)
  const { claims, ledger } = claimsOf(f.state, f.body)
  if (!claims.some((claim) => claim.owner === owner)) throw new Error(`${owner} holds no claim on #${ctx.number}`)
  const at = new Date(now).toISOString()
  if (!ledger) post(ctx, withHeartbeat(emptyLedger(), owner, at, activeMinutes))
  else patch(ctx, ledger.id, withHeartbeat(f.body(ledger), owner, at, activeMinutes))
  syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
}

const args = (f: Fresh): [CacheState, Body] => [f.state, f.body]

function dropHeartbeat(ctx: ClaimContext, owners: string[]) {
  const f = fresh(ctx)
  const { ledger } = claimsOf(f.state, f.body)
  if (!ledger) return
  const body = f.body(ledger)
  const kept = body.split('\n').filter((row) => !/<!--\s*vsk:claim\b/.test(row) || !owners.includes(markerKeys(row, 'vsk:claim').owner ?? ''))
  if (kept.length !== body.split('\n').length) patch(ctx, ledger.id, kept.join('\n'))
}

export function release(ctx: ClaimContext, owner: string, by: string, reason: string) {
  post(ctx, releaseBody({ owner, by, reason }))
  dropHeartbeat(ctx, [owner])
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
  const before = holderOf(...args(fresh(ctx)), now)
  if (before.holder?.owner === request.owner) {
    heartbeat(ctx, request.owner, 0, now)
    return { ok: true, message: `already held by ${request.owner}`, holder: before.holder, waitMs: 0 }
  }
  if (before.holder && !request.takeBackBy) {
    const h = before.holder
    return { ok: false, message: `held by ${h.owner} (${h.harness}${h.model ? ` · ${h.model}` : ''}), last active ${h.heartbeat} — take it back with --take-back-by <login>`, holder: h, waitMs: 0 }
  }
  const previous = [...before.stale, ...(before.holder ? [before.holder] : [])]
  for (const old of previous) {
    const reason = old.stale ? `no heartbeat since ${old.heartbeat}` : `taken back by @${request.takeBackBy}`
    post(ctx, releaseBody({ owner: old.owner, by: request.takeBackBy ?? request.owner, reason }))
  }
  if (previous.length) dropHeartbeat(ctx, previous.map((old) => old.owner))
  post(ctx, claimBody({ ...request, note: request.takeBackBy ? `taken back by @${request.takeBackBy}` : undefined }))

  // Two sessions can claim at once: both re-read, the earliest live claim wins, the other backs off.
  const after = holderOf(...args(fresh(ctx)), now)
  if (after.holder?.owner !== request.owner) {
    release(ctx, request.owner, request.owner, `lost the race to ${after.holder?.owner ?? 'another claim'}`)
    return { ok: false, message: `lost the race to ${after.holder?.owner}`, holder: after.holder, waitMs: 0 }
  }
  heartbeat(ctx, request.owner, 0, now)
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
    syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
  }
  const live = before.holder && !before.holder.stale
  return { ok: true, message: `claimed by ${request.owner}`, holder: after.holder, waitMs: live ? 2 * 60_000 : 0 }
}

const CLAIM_ROW = /^\s*<!--\s*vsk:claim\b[^>]*-->\s*$/

// Heartbeat rows belong to the hooks, so an edit keeps GitHub's current rows, not the editor's copy.
export function keepClaimRows(current: string, edited: string): string {
  const rows = current.split('\n').filter((row) => CLAIM_ROW.test(row))
  const lines = edited.split('\n').filter((row) => !CLAIM_ROW.test(row))
  if (!rows.length) return lines.join('\n')
  const marker = lines.findIndex((row) => /<!--\s*vsk:v1\s+type=ledger\b/.test(row))
  lines.splice(marker + 1, 0, ...rows)
  return lines.join('\n')
}

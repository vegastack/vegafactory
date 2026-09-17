// Who holds an issue. A claim is a `type=claim` comment; a release is a `type=release`
// comment. The holder is the earliest claim after the latest release, as long as its
// heartbeat is fresh. The heartbeat lives on the status (ledger) comment's claim line,
// which hooks refresh — never the model.
import { hostname } from 'node:os'
import type { CacheState, CommentEntry } from './issue-cache.ts'

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

export function claimsOf(state: CacheState, body: Body): { claims: Claim[]; ledger: CommentEntry | null } {
  const comments = Object.values(state.comments).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
  let claims: Claim[] = []
  let ledger: CommentEntry | null = null
  for (const entry of comments) {
    if (entry.type === 'ledger') ledger = entry
    if (entry.type === 'release') {
      const keys = markerKeys(body(entry))
      claims = keys.owner ? claims.filter((claim) => claim.owner !== keys.owner) : []
    }
    if (entry.type === 'claim') {
      const keys = markerKeys(body(entry))
      if (!keys.owner || claims.some((claim) => claim.owner === keys.owner)) continue
      claims.push({
        owner: keys.owner, kind: keys.kind === 'dispatch' ? 'dispatch' : 'session',
        harness: keys.harness ?? '', model: keys.model ?? '', claimedAt: entry.createdAt, commentId: entry.id,
      })
    }
  }
  return { claims, ledger }
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

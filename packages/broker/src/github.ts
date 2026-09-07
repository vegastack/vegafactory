// Everything the broker says to GitHub: the App JWT it authenticates with, the installation lookup
// that decides whether a repository is allowed at all, and (below) the capped token mint.
//
// Two rules hold throughout. The App private key never leaves this module as a string — it arrives
// from the Secrets Store binding, is imported into a non-extractable CryptoKey, and only signatures
// leave. And no error message ever carries a credential: a failing call reports a status, never the
// JWT it sent or the token it received.

import { allowedFetch, fetchJson, withDeadline } from './egress.ts'
import type { VerifiedIdentity } from './oidc.ts'

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'vegafactory-token-broker',
} as const

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----'
const PKCS8_ADVICE =
  'the App key must be PKCS#8 — convert it with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem'

export class AppKeyRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppKeyRejected'
  }
}

export class NotInstalled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotInstalled'
  }
}

export class UpstreamFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamFailure'
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.trim()
  if (!trimmed.startsWith(PKCS8_HEADER)) throw new AppKeyRejected(PKCS8_ADVICE)
  const body = trimmed
    .replace(PKCS8_HEADER, '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  let der: Uint8Array<ArrayBuffer>
  try {
    const binary = atob(body)
    der = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index)
  } catch {
    throw new AppKeyRejected('the App key is not valid base64 — ' + PKCS8_ADVICE)
  }
  try {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    throw new AppKeyRejected('the App key could not be imported — ' + PKCS8_ADVICE)
  }
}

// GitHub allows a 10-minute App JWT; 9 minutes with a 60-second backdate stays inside that even
// with clock drift on either side.
export async function appJwt(appId: string, key: CryptoKey, nowSeconds: number): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 540 })),
  )
  const input = `${header}.${payload}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))
  return `${input}.${base64url(new Uint8Array(signature))}`
}

export interface Installation { id: number; appId: number; accountId: number }

const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

export async function findInstallation(args: {
  identity: VerifiedIdentity; appId: string; jwt: string; doFetch: typeof fetch; signal?: AbortSignal
}): Promise<Installation> {
  const owner = args.identity.owner
  const repo = args.identity.repository.slice(owner.length + 1)
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`
  const response = await fetchJson(url, { method: 'GET', headers: { ...API_HEADERS, Authorization: `Bearer ${args.jwt}` }, signal: args.signal }, args.doFetch, 64 * 1024)
  if (response.status === 404) throw new NotInstalled('the VegaStack Factory App is not installed on this repository')
  if (response.status !== 200) throw new UpstreamFailure(`the installation lookup failed (HTTP ${response.status})`)
  const body = record(response.body)
  const accountId = record(body.account).id
  const configuredApp = /^[1-9]\d*$/.test(args.appId) ? Number(args.appId) : NaN
  if (!positiveId(body.id) || !positiveId(body.app_id) || !positiveId(accountId) ||
      !positiveId(configuredApp) || body.app_id !== configuredApp || accountId !== args.identity.ownerId) {
    throw new UpstreamFailure('the installation identity does not match the signed owner and configured App')
  }
  return { id: body.id, appId: body.app_id, accountId }
}

// The permission cap, and the only place it is written. The mint asks for exactly these three
// permissions, with repository permissions narrowed to one repository. Organization projects
// remain organization-wide. Both permission echo and actual repository enumeration are checked.
export const CAPPED_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  issues: 'write',
  metadata: 'read',
  organization_projects: 'write',
})

export class PermissionCapViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionCapViolation'
  }
}

export function permissionsMatchCap(echo: unknown): boolean {
  if (typeof echo !== 'object' || echo === null || Array.isArray(echo)) return false
  const actual = echo as Record<string, unknown>
  const expectedKeys = Object.keys(CAPPED_PERMISSIONS)
  const actualKeys = Object.keys(actual)
  if (actualKeys.length !== expectedKeys.length) return false
  return expectedKeys.every((key) => actual[key] === CAPPED_PERMISSIONS[key])
}

export class TokenScopeViolation extends Error {
  constructor() { super('the minted token repository scope does not match the signed identity'); this.name = 'TokenScopeViolation' }
}

export function repositoryScopeMatches(
  value: unknown, identity: Pick<VerifiedIdentity, 'repository' | 'repositoryId' | 'ownerId'>,
): boolean {
  const body = record(value)
  if (body.total_count !== 1 || !Array.isArray(body.repositories) || body.repositories.length !== 1) return false
  const repo = record(body.repositories[0])
  return repo.id === identity.repositoryId && repo.full_name === identity.repository && record(repo.owner).id === identity.ownerId
}

export async function mintRepoToken(args: {
  installation: Installation
  identity: VerifiedIdentity
  jwt: string
  doFetch: typeof fetch
  now: () => number
  signal?: AbortSignal
}): Promise<{ token: string; expiresAt: string; permissions: Record<string, string> }> {
  const url = `https://api.github.com/app/installations/${args.installation.id}/access_tokens`
  if (args.identity.expiresAt <= args.now()) throw new UpstreamFailure('the caller expired before minting')
  const response = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { ...API_HEADERS, Authorization: `Bearer ${args.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_ids: [args.identity.repositoryId], permissions: CAPPED_PERMISSIONS }),
      signal: args.signal,
    },
    args.doFetch,
    64 * 1024,
  )
  if (response.status !== 201) throw new UpstreamFailure(`the token mint failed (HTTP ${response.status})`)
  const body = record(response.body)
  const token = body.token
  // Accept GitHub's opaque current/legacy formats, without a fixed-length token assumption.
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new UpstreamFailure('the token mint returned no usable token')
  try {
    const expiresAt = body.expires_at
    const expiry = typeof expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiresAt)
      ? Date.parse(expiresAt) / 1000 : NaN
    const checkExpiry = () => {
      const now = args.now()
      const canonical = typeof expiresAt === 'string' ? expiresAt.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`) : ''
      if (!Number.isFinite(expiry) || new Date(expiry * 1000).toISOString() !== canonical ||
          expiry <= now + 30 || expiry > now + 3660 || args.identity.expiresAt <= now) {
        throw new UpstreamFailure('the minted token or caller has an unusable expiry')
      }
      args.signal?.throwIfAborted()
    }
    checkExpiry()
    if (!permissionsMatchCap(body.permissions)) throw new PermissionCapViolation('the minted token permissions do not match the cap')
    const repositories = await fetchJson('https://api.github.com/installation/repositories?per_page=2', {
      headers: { ...API_HEADERS, Authorization: `Bearer ${token}` }, signal: args.signal,
    }, args.doFetch, 64 * 1024)
    if (repositories.status !== 200) throw new UpstreamFailure('the minted token scope could not be read')
    // Refuse pagination rather than accepting an incomplete view of a token's reach.
    if (repositories.headers.has('link') || !repositoryScopeMatches(repositories.body, args.identity)) throw new TokenScopeViolation()
    checkExpiry()
    return { token, expiresAt: expiresAt as string, permissions: { ...CAPPED_PERMISSIONS } }
  } catch (error) {
    // Only this just-minted disposable token is revoked. No shared App, installation or key
    // mutation. A failed revoke cannot change the refusal; the exchange deadline still wins.
    try {
      await withDeadline(async (signal) => {
        const revoked = await allowedFetch('https://api.github.com/installation/token', {
          method: 'DELETE', headers: { ...API_HEADERS, Authorization: `Bearer ${token}` }, signal,
        }, args.doFetch)
        void revoked.body?.cancel().catch(() => {})
      }, args.signal)
    } catch { /* best effort within the remaining exchange budget */ }
    throw error
  }
}

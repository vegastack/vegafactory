// GitHub Actions OIDC verification. Nothing here trusts the request body: the repository a caller
// eventually receives a token for is read from the *signed* `repository` and `repository_owner`
// claims and from nowhere else, which is the whole of the broker's tenancy model.
//
// The signing keys are GitHub's public JWKS document, cached twice and cheaply: a module-scope memo
// inside the isolate, and the Cloudflare edge, because the subrequest carries
// `cf: { cacheTtl: 3600, cacheEverything: true }` (a JSON body is not a default-cached type, so the
// hint is what makes the edge hold it). Both caches are per-Cloudflare-location — the same reach a
// KV read had — and a miss costs one HTTPS call to a public endpoint, so the broker needs no store.

import { fetchJson, withDeadline } from './egress.ts'

export const ISSUER = 'https://token.actions.githubusercontent.com'
export const JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks'
const JWKS_TTL_SECONDS = 3600
const DEFAULT_SKEW_SECONDS = 60
const MAX_JWT_BYTES = 16 * 1024
// Broker acceptance bound, not a configurable workflow policy or a claimed issuer guarantee.
const MAX_JWT_LIFETIME_SECONDS = 600

export type RejectionReason =
  | 'malformed'
  | 'alg'
  | 'kid'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'not_yet_valid'
  | 'claims'

export class TokenRejected extends Error {
  readonly reason: string
  constructor(reason: RejectionReason, detail: string) {
    super(`token rejected (${reason}): ${detail}`)
    this.name = 'TokenRejected'
    this.reason = reason
  }
}

export interface VerifiedIdentity {
  repository: string
  repositoryId: number
  owner: string
  ownerId: number
  audience: string
  expiresAt: number
}

export interface Jwks {
  keys: JsonWebKey[]
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeSegment(segment)))
  } catch {
    throw new TokenRejected('malformed', `${what} is not base64url JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TokenRejected('malformed', `${what} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

// Structural parse only: three segments, RS256, a kid. The handler runs this before it fetches
// anything, so a malformed or unusable bearer token is a 401 that costs no subrequest.
export function parseJwtHeader(token: string): {
  kid: string
  headerSegment: string
  payloadSegment: string
  signatureSegment: string
} {
  if (token.length > MAX_JWT_BYTES || !/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new TokenRejected('malformed', 'the JWT is oversized or not base64url')
  }
  const parts = token.split('.')
  if (parts.length !== 3) throw new TokenRejected('malformed', 'a JWT has three segments')
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string]
  if (!headerSegment || !payloadSegment || !signatureSegment) throw new TokenRejected('malformed', 'an empty segment')
  const header = decodeJson(headerSegment, 'the header')
  if (header.alg !== 'RS256') throw new TokenRejected('alg', 'only RS256 is accepted')
  const kid = header.kid
  if (typeof kid !== 'string' || kid.length === 0) throw new TokenRejected('kid', 'the header carries no kid')
  return { kid, headerSegment, payloadSegment, signatureSegment }
}

export async function verifyOidcToken(
  token: string,
  options: { jwks: Jwks; audience: string; nowSeconds: number; skewSeconds?: number },
): Promise<VerifiedIdentity> {
  const skew = Math.min(DEFAULT_SKEW_SECONDS, Math.max(0, options.skewSeconds ?? DEFAULT_SKEW_SECONDS))
  const { kid, headerSegment, payloadSegment, signatureSegment } = parseJwtHeader(token)

  const jwk = options.jwks.keys.find((key) => (key as { kid?: unknown }).kid === kid)
  if (!jwk) throw new TokenRejected('kid', 'no signing key matches the kid')

  let publicKey: CryptoKey
  try {
    publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  } catch {
    throw new TokenRejected('kid', 'the signing key could not be imported')
  }

  let signatureOk = false
  try {
    signatureOk = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      decodeSegment(signatureSegment),
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    )
  } catch {
    signatureOk = false
  }
  if (!signatureOk) throw new TokenRejected('signature', 'the signature does not verify')

  const payload = decodeJson(payloadSegment, 'the payload')
  if (payload.iss !== ISSUER) throw new TokenRejected('issuer', 'the issuer is not GitHub Actions OIDC')
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(options.audience)) throw new TokenRejected('audience', 'the audience is not this broker')

  const exp = payload.exp
  const nbf = payload.nbf
  const iat = payload.iat
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= options.nowSeconds) {
    throw new TokenRejected('expired', 'the token has no future expiry')
  }
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) ||
      typeof nbf !== 'number' || !Number.isSafeInteger(nbf)) {
    throw new TokenRejected('claims', 'the token carries no numeric iat/nbf')
  }
  if (iat - skew > options.nowSeconds || nbf - skew > options.nowSeconds) {
    throw new TokenRejected('not_yet_valid', 'the token is not valid yet')
  }
  if (exp <= iat || exp <= nbf || exp - iat > MAX_JWT_LIFETIME_SECONDS) {
    throw new TokenRejected('claims', 'the token lifetime exceeds the broker bound')
  }

  const repository = payload.repository
  const repositoryOwner = payload.repository_owner
  if (typeof repository !== 'string' || repository.length === 0) throw new TokenRejected('claims', 'the repository claim is missing')
  if (typeof repositoryOwner !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(repositoryOwner)) {
    throw new TokenRejected('claims', 'the repository_owner claim is missing')
  }
  const prefix = `${repositoryOwner}/`
  if (!repository.startsWith(prefix)) throw new TokenRejected('claims', 'the repository claim does not sit under repository_owner')
  const repositoryName = repository.slice(prefix.length)
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repositoryName) || repositoryName === '.' || repositoryName === '..') {
    throw new TokenRejected('claims', 'the repository name is not a single segment')
  }

  return { repository, ...parseSignedRepositoryIds(payload), owner: repositoryOwner, audience: options.audience, expiresAt: exp }
}

export function parseSignedRepositoryIds(claims: Record<string, unknown>): { repositoryId: number; ownerId: number } {
  const id = (value: unknown): number => {
    const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new TokenRejected('claims', 'signed repository IDs must be safe positive integers')
    }
    return number
  }
  return { repositoryId: id(claims.repository_id), ownerId: id(claims.repository_owner_id) }
}

interface JwksCache {
  memo?: { document: Jwks; expiresAtSeconds: number }
  pending?: Promise<Jwks>
  refresh?: Promise<Jwks>
  lastRefresh?: number
}
// Production uses the single global fetch transport, so this remains one cache per isolate.
// Injected transports have independent public-key caches, without a test-only reset API.
const caches = new WeakMap<typeof fetch, JwksCache>()

export async function loadJwks(
  doFetch: typeof fetch, nowSeconds: number,
  options: { forceOrigin?: boolean; signal?: AbortSignal } = {},
): Promise<Jwks> {
  options.signal?.throwIfAborted()
  let state = caches.get(doFetch)
  if (!state) { state = {}; caches.set(doFetch, state) }
  const cache = state
  const force = options.forceOrigin === true
  if (!force && cache.memo && nowSeconds < cache.memo.expiresAtSeconds) return cache.memo.document
  if (force && !cache.refresh && cache.lastRefresh !== undefined && nowSeconds - cache.lastRefresh < 60) {
    throw new TokenRejected('kid', 'the signing-key refresh is rate limited')
  }
  const fetchDocument = (): Promise<Jwks> => withDeadline(async (signal) => {
    const response = await fetchJson(JWKS_URL, force
      ? { cache: 'no-store', signal }
      : { cf: { cacheTtl: JWKS_TTL_SECONDS, cacheEverything: true }, signal }, doFetch, 256 * 1024)
    const body = response.body as { keys?: unknown } | null
    if (response.status !== 200 || !Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 32) {
      throw new Error('the JWKS document is unavailable or malformed')
    }
    const kids = new Set<string>()
    for (const key of body.keys) {
      if (!key || typeof key !== 'object' || key.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid ||
          typeof key.n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key.n) || typeof key.e !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key.e) ||
          (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig') || kids.has(key.kid)) {
        throw new Error('the JWKS document has unusable keys')
      }
      await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      kids.add(key.kid)
    }
    signal.throwIfAborted()
    const document: Jwks = { keys: body.keys }
    cache.memo = { document, expiresAtSeconds: nowSeconds + JWKS_TTL_SECONDS }
    return document
  })
  if (force && !cache.refresh) {
    cache.lastRefresh = nowSeconds
    // An ordinary in-flight read must finish first so an older edge reply cannot overwrite
    // the rotated origin document afterwards. Both reads retain their own three-second bound.
    cache.refresh = (async () => {
      if (cache.pending) await cache.pending.catch(() => {})
      return fetchDocument()
    })().finally(() => { cache.refresh = undefined })
  } else if (!force && !cache.pending && !cache.refresh) {
    cache.pending = fetchDocument().finally(() => { cache.pending = undefined })
  }
  const pending = cache.refresh ?? cache.pending!
  // One caller abandoning its exchange must not abort another caller's shared origin refresh.
  return withDeadline(async () => pending, options.signal)
}

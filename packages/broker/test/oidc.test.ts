import { describe, expect, test } from 'bun:test'
import { TokenRejected, parseSignedRepositoryIds, verifyOidcToken, loadJwks } from '../src/oidc.ts'
import { EgressRefused } from '../src/egress.ts'

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const rotatedPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] as unknown as JsonWebKey[] }

async function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key: CryptoKey = pair.privateKey) {
  const input = `${b64u(new TextEncoder().encode(JSON.stringify(header)))}.${b64u(new TextEncoder().encode(JSON.stringify(payload)))}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))
  return `${input}.${b64u(new Uint8Array(sig))}`
}
const now = 1_800_000_000
const good = { iss: 'https://token.actions.githubusercontent.com', aud: 'vegastack-factory', exp: now + 300, nbf: now - 10, iat: now - 10, repository: 'acme/widgets', repository_owner: 'acme', repository_id: '12', repository_owner_id: '4' }

describe('verifyOidcToken', () => {
  test('accepts a well-formed token and splits the repository claim', async () => {
    const claims = await verifyOidcToken(await sign(good), { jwks, audience: 'vegastack-factory', nowSeconds: now })
    expect(claims).toEqual({ repository: 'acme/widgets', repositoryName: 'widgets', repositoryId: 12, owner: 'acme', ownerId: 4, audience: 'vegastack-factory', expiresAt: now + 300 })
  })

  test('rejects each broken claim with its own reason', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['issuer', { ...good, iss: 'https://evil.test' }],
      ['audience', { ...good, aud: 'someone-else' }],
      ['expired', { ...good, exp: now - 120 }],
      ['not_yet_valid', { ...good, nbf: now + 120 }],
      ['claims', { ...good, repository: 'other/widgets' }],
      ['claims', { ...good, repository_owner: undefined }],
      ['claims', { ...good, repository_id: '12x' }],
      ['claims', { ...good, repository_owner_id: 0 }],
      ['expired', { ...good, exp: now }],
      ['expired', { ...good, exp: now - 1 }],
      ['not_yet_valid', { ...good, iat: now + 61 }],
      ['claims', { ...good, iat: undefined }],
      ['claims', { ...good, exp: now + 3600 }],
    ]
    for (const [reason, payload] of cases) {
      const error = await verifyOidcToken(await sign(payload), { jwks, audience: 'vegastack-factory', nowSeconds: now }).catch((e) => e)
      expect(error).toBeInstanceOf(TokenRejected)
      expect((error as TokenRejected).reason).toBe(reason)
    }
  })

  test('rejects alg none, an unknown kid, a tampered signature, and a malformed token', async () => {
    const alg = await verifyOidcToken(await sign(good, { alg: 'none', kid: 'k1' }), { jwks, audience: 'vegastack-factory', nowSeconds: now }).catch((e) => e)
    expect((alg as TokenRejected).reason).toBe('alg')
    const kid = await verifyOidcToken(await sign(good, { alg: 'RS256', kid: 'nope' }), { jwks, audience: 'vegastack-factory', nowSeconds: now }).catch((e) => e)
    expect((kid as TokenRejected).reason).toBe('kid')
    const signed = await sign(good)
    const tampered = `${signed.slice(0, -4)}AAAA`
    const bad = await verifyOidcToken(tampered, { jwks, audience: 'vegastack-factory', nowSeconds: now }).catch((e) => e)
    expect((bad as TokenRejected).reason).toBe('signature')
    const junk = await verifyOidcToken('a.b', { jwks, audience: 'vegastack-factory', nowSeconds: now }).catch((e) => e)
    expect((junk as TokenRejected).reason).toBe('malformed')
  })
})

test('signed numeric IDs reject coercion, missing and unsafe values', () => {
  expect(parseSignedRepositoryIds(good)).toEqual({ repositoryId: 12, ownerId: 4 })
  for (const value of ['1x', '1e3', '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    expect(() => parseSignedRepositoryIds({ ...good, repository_id: value })).toThrow(TokenRejected)
  }
})

test('otherwise-valid signed JWT is accepted below16KiB and refused above16KiB', async () => {
  const under = await sign({ ...good, padding: 'x'.repeat(11 * 1024) })
  const over = await sign({ ...good, padding: 'x'.repeat(13 * 1024) })
  expect(new TextEncoder().encode(under).byteLength).toBeLessThan(16 * 1024)
  expect(new TextEncoder().encode(over).byteLength).toBeGreaterThan(16 * 1024)
  const options = { jwks, audience: 'vegastack-factory', nowSeconds: now }
  expect((await verifyOidcToken(under, options)).repositoryId).toBe(12)
  const error = await verifyOidcToken(over, options).catch((caught) => caught)
  expect(error).toBeInstanceOf(TokenRejected)
  expect(error.reason).toBe('malformed')
  expect(error.message).toContain('oversized')
})

test('unknown kid refresh bypasses the edge once and accepts the rotated signed JWT', async () => {
  const rotated = { ...(await crypto.subtle.exportKey('jwk', rotatedPair.publicKey)), kid: 'rotated', alg: 'RS256', use: 'sig' }
  const seen: RequestInit[] = []
  const transport = (async (_url: string, init: RequestInit) => {
    seen.push(init)
    return new Response(JSON.stringify(init.cache === 'no-store' ? { keys: [rotated] } : jwks))
  }) as typeof fetch
  await loadJwks(transport, now)
  const token = await sign(good, { alg: 'RS256', kid: 'rotated' }, rotatedPair.privateKey)
  // Even relabelling the stale public key cannot verify the newly rotated private key.
  const stale = await verifyOidcToken(token, {
    jwks: { keys: [{ ...jwks.keys[0], kid: 'rotated' } as JsonWebKey] }, audience: 'vegastack-factory', nowSeconds: now,
  }).catch((error) => error)
  expect(stale).toBeInstanceOf(TokenRejected)
  expect(stale.reason).toBe('signature')
  const [first, second] = await Promise.all([
    loadJwks(transport, now + 1, { forceOrigin: true }),
    loadJwks(transport, now + 1, { forceOrigin: true }),
  ])
  expect(first).toEqual(second)
  expect((await verifyOidcToken(token, { jwks: first, audience: 'vegastack-factory', nowSeconds: now + 1 })).repositoryId).toBe(12)
  expect(seen).toHaveLength(2)
  expect(seen[1]?.cache).toBe('no-store')
  expect((seen[1] as RequestInit & { cf?: unknown }).cf).toBeUndefined()
  await expect(loadJwks(transport, now + 2, { forceOrigin: true })).rejects.toThrow()
  expect(seen).toHaveLength(2)
})

test('failed origin refresh preserves the original memo and its expiry', async () => {
  let calls = 0
  const transport = (async (_url: string) => {
    calls++
    return calls === 1 ? new Response(JSON.stringify(jwks)) : new Response('{}', { status: 503 })
  }) as typeof fetch
  await loadJwks(transport, now)
  await expect(loadJwks(transport, now + 3590, { forceOrigin: true })).rejects.toThrow()
  expect(await loadJwks(transport, now + 3599)).toEqual(jwks)
  expect(calls).toBe(2)
  await expect(loadJwks(transport, now + 3600)).rejects.toThrow()
  expect(calls).toBe(3)
})

test('otherwise-valid JWKS stream is accepted below256KiB and refused above256KiB', async () => {
  const document = (padding: number) => JSON.stringify({ ...jwks, padding: 'x'.repeat(padding) })
  const under = document(255 * 1024)
  const over = document(256 * 1024)
  expect(new TextEncoder().encode(under).byteLength).toBeLessThan(256 * 1024)
  expect(new TextEncoder().encode(over).byteLength).toBeGreaterThan(256 * 1024)
  const transport = (body: string) => (async (_url: string) => {
    const bytes = new TextEncoder().encode(body)
    let offset = 0
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (offset === bytes.byteLength) { controller.close(); return }
        const end = Math.min(offset + 16 * 1024, bytes.byteLength)
        controller.enqueue(bytes.slice(offset, end)); offset = end
      },
    }, { highWaterMark: 0 }))
    expect(response.headers.has('content-length')).toBe(false)
    return response
  }) as typeof fetch
  const accepted = await loadJwks(transport(under), now)
  expect((await verifyOidcToken(await sign(good), { jwks: accepted, audience: 'vegastack-factory', nowSeconds: now })).repositoryId).toBe(12)
  const error = await loadJwks(transport(over), now).catch((caught) => caught)
  expect(error).toBeInstanceOf(EgressRefused)
  expect(error.message).toBe('upstream response exceeds the body limit')
})

test('JWKS refuses too many keys and unusable rotation without caching failures', async () => {
  const tooMany = (async (_url: string) => new Response(JSON.stringify({ keys: Array.from({ length: 33 }, (_, index) => ({ ...jwks.keys[0], kid: `k${index}` })) }))) as typeof fetch
  await expect(loadJwks(tooMany, now)).rejects.toThrow()
  let calls = 0
  const transport = (async (_url: string) => new Response(JSON.stringify(++calls === 1 ? jwks : { keys: [{ ...jwks.keys[0], n: '', kid: 'rotated' }] }))) as typeof fetch
  await loadJwks(transport, now)
  await expect(loadJwks(transport, now + 1, { forceOrigin: true })).rejects.toThrow()
  expect(await loadJwks(transport, now + 2)).toEqual(jwks)
})

test('one cancelled waiter cannot abort another caller sharing a refresh', async () => {
  const transport = (async (_url: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify(jwks))
  }) as typeof fetch
  const cancelled = new AbortController()
  const first = loadJwks(transport, now, { forceOrigin: true, signal: cancelled.signal }).catch((error) => error)
  const second = loadJwks(transport, now, { forceOrigin: true })
  cancelled.abort()
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toEqual(jwks)
})

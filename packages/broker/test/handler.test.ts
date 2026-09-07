import { describe, expect, test, spyOn } from 'bun:test'
import worker, { handleTokenRequest } from '../src/index.ts'
import type { Env } from '../src/env.ts'

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const rotatedPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
const appPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`
const now = 1_800_000_000
const expiry = new Date((now + 3600) * 1000).toISOString()

async function oidcToken(claims: Record<string, unknown> = {}, kid = 'k1', key: CryptoKey = pair.privateKey) {
  const header = { alg: 'RS256', kid, typ: 'JWT' }
  const payload = { iss: 'https://token.actions.githubusercontent.com', aud: 'vegastack-factory', exp: now + 300, nbf: now - 10, iat: now - 10, repository: 'acme/widgets', repository_owner: 'acme', repository_id: '12', repository_owner_id: '4', ...claims }
  const input = `${b64u(new TextEncoder().encode(JSON.stringify(header)))}.${b64u(new TextEncoder().encode(JSON.stringify(payload)))}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))
  return `${input}.${b64u(new Uint8Array(sig))}`
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    APP_PRIVATE_KEY: { async get() { return appPem } },
    TOKEN_LIMITER: { async limit() { return { success: true } } },
    VEGAFACTORY_APP_ID: '4812956',
    OIDC_AUDIENCE: 'vegastack-factory',
    ...overrides,
  }
}

const jwks = new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
const github = (installation: Response, mint: Response) => (async (url: string) =>
  url.includes('/.well-known/jwks') ? jwks.clone() : url.endsWith('/installation') ? installation.clone() : url.includes('/installation/repositories') ? new Response(JSON.stringify({ total_count: 1, repositories: [{ id: 12, full_name: 'acme/widgets', owner: { id: 4 } }] })) : url.endsWith('/installation/token') ? new Response(null, { status: 204 }) : mint.clone()) as unknown as typeof fetch
const installed = new Response(JSON.stringify({ id: 42, app_id: 4812956, account: { id: 4 } }), { status: 200 })
const cap = { issues: 'write', metadata: 'read', organization_projects: 'write' }
const minted = new Response(JSON.stringify({ token: 'ghs_secret', expires_at: expiry, permissions: cap }), { status: 201 })
const deps = (doFetch: typeof fetch, records: Record<string, unknown>[]) => ({ doFetch, nowSeconds: () => now, log: (r: Record<string, unknown>) => { records.push(r) } })
const never = (async () => { throw new Error('no call expected') }) as unknown as typeof fetch
const post = async (token?: string) => new Request('https://factory-token.vegastack.com/token', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })

describe('routing', () => {
  test('answers only POST /token and GET /health', async () => {
    const records: Record<string, unknown>[] = []
    expect((await handleTokenRequest(new Request('https://factory-token.vegastack.com/token'), envWith(), deps(never, records))).status).toBe(405)
    // `never` is safe here: routing and the 401 paths are decided before any subrequest
    expect((await handleTokenRequest(new Request('https://factory-token.vegastack.com/', { method: 'POST' }), envWith(), deps(never, records))).status).toBe(404)
  })

  test('GET /health is unauthenticated, reads no credential, and is not audited', async () => {
    const records: Record<string, unknown>[] = []
    const response = await handleTokenRequest(new Request('https://factory-token.vegastack.com/health'), envWith(), deps(never, records))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(records).toHaveLength(0)
  })
})

test('worker.fetch binds signed identities while allowing new workflows, refs and base PR contexts', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const logs: string[] = []
  const transport = spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/.well-known/jwks')) return jwks.clone()
    if (url.includes('forker/widgets/installation')) return new Response('{}', { status: 404 })
    if (url.endsWith('/installation')) return installed.clone()
    if (init.method === 'POST') {
      return minted.clone()
    }
    if (url.includes('/installation/repositories')) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer ghs_secret')
      return new Response(JSON.stringify({ total_count: 1, repositories: [{ id: 12, full_name: 'acme/widgets', owner: { id: 4 } }] }))
    }
    return new Response(null, { status: 204 })
  }) as typeof fetch)
  const clock = spyOn(Date, 'now').mockReturnValue(now * 1000)
  const log = spyOn(console, 'log').mockImplementation((line) => { logs.push(String(line)) })
  try {
    for (const claims of [
      { workflow: 'Previously unseen', ref: 'refs/heads/topic', event_name: 'workflow_dispatch' },
      { workflow: 'Release', ref: 'refs/tags/v1', environment: 'production' },
      { workflow: 'PR housekeeping', ref: 'refs/heads/main', event_name: 'pull_request_target', head_ref: 'fork-topic' },
    ]) expect((await worker.fetch(await post(await oidcToken(claims)), envWith())).status).toBe(200)
    expect(calls.filter(({ init }) => init.method === 'POST').map(({ init }) => JSON.parse(String(init.body))))
      .toEqual(Array.from({ length: 3 }, () => ({ repository_ids: [12], permissions: cap })))
    expect((await worker.fetch(await post(await oidcToken({ repository: 'forker/widgets', repository_owner: 'forker', repository_id: '13', repository_owner_id: '9' })), envWith())).status).toBe(403)
    for (const claims of [{ aud: 'other' }, { repository: 'other/widgets' }, { repository_id: '1e2' }, { exp: now }]) {
      const before = calls.length
      expect((await worker.fetch(await post(await oidcToken(claims)), envWith())).status).toBe(401)
      expect(calls).toHaveLength(before)
    }
    const response = await worker.fetch(await post(await oidcToken({ repository_id: '99' })), envWith())
    expect(response.status).toBe(500)
    expect((await response.clone().json()).reason).toBe('token_scope_violation')
    expect(JSON.parse(String(calls.filter(({ init }) => init.method === 'POST').at(-1)?.init.body)).repository_ids).toEqual([99])
    expect(await response.text()).not.toContain('ghs_secret')
    expect(logs.join('')).not.toContain('ghs_secret')
  } finally { transport.mockRestore(); clock.mockRestore(); log.mockRestore() }
})

test('handler refuses overbroad scope and cleans up only the just-minted token', async () => {
  const calls: string[] = []
  const base = github(installed, minted)
  const transport = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${url}`)
    if (url.includes('/installation/repositories')) return new Response(JSON.stringify({ total_count: 2, repositories: [] }))
    if (init.method === 'DELETE') {
      expect(url).toBe('https://api.github.com/installation/token')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer ghs_secret')
      throw new Error('ghs_secret upstream detail')
    }
    return base(url, init)
  }) as typeof fetch
  const records: Record<string, unknown>[] = []
  const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(transport, records))
  expect(response.status).toBe(500)
  expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE https://api.github.com/installation/token'])
  expect(await response.text()).not.toContain('ghs_secret')
  expect(JSON.stringify(records)).not.toContain('ghs_secret')
})

test('handler rejects malformed identity and mint responses without credential output', async () => {
  const records: Record<string, unknown>[] = []
  for (const [installationBody, mintBody] of [
    [{ id: 42, app_id: 1, account: { id: 4 } }, { token: 'ghs_secret', expires_at: expiry, permissions: cap }],
    [{ id: 42, app_id: 4812956, account: { id: 9 } }, { token: 'ghs_secret', expires_at: expiry, permissions: cap }],
    [{ id: 42, app_id: 4812956, account: { id: 4 } }, {}],
    [{ id: 42, app_id: 4812956, account: { id: 4 } }, { token: 'ghs_secret', permissions: cap }],
    [{ id: 42, app_id: 4812956, account: { id: 4 } }, { token: 'ghs_secret', expires_at: expiry }],
  ]) {
    const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(github(
      new Response(JSON.stringify(installationBody)), new Response(JSON.stringify(mintBody), { status: 201 }),
    ), records))
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(await response.text()).not.toContain('ghs_secret')
  }
  expect(JSON.stringify(records)).not.toContain('ghs_secret')
})

test('unavailable JWKS refuses through the real handler', async () => {
  const base = github(installed, minted)
  const transport = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/.well-known/jwks')) return new Response('{}', { status: 503 })
    return base(url, init)
  }) as typeof fetch
  const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(transport, []))
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('ghs_secret')
})

test('otherwise-valid mint stream grants below64KiB and refuses above64KiB', async () => {
  const base = github(installed, minted)
  for (const padding of [63 * 1024, 64 * 1024]) {
    const body = { token: 'ghs_secret', expires_at: expiry, permissions: cap, padding: 'x'.repeat(padding) }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const overLimit = padding === 64 * 1024
    if (overLimit) expect(bytes.byteLength).toBeGreaterThan(64 * 1024)
    else expect(bytes.byteLength).toBeLessThan(64 * 1024)
    let enumerations = 0
    const transport = (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        let offset = 0
        const response = new Response(new ReadableStream({
          pull(controller) {
            if (offset === bytes.byteLength) { controller.close(); return }
            const end = Math.min(offset + 16 * 1024, bytes.byteLength)
            controller.enqueue(bytes.slice(offset, end)); offset = end
          },
        }, { highWaterMark: 0 }), { status: 201 })
        expect(response.headers.has('content-length')).toBe(false)
        return response
      }
      if (url.includes('/installation/repositories')) enumerations++
      return base(url, init)
    }) as typeof fetch
    const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(transport, []))
    if (overLimit) {
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'bad_gateway', reason: 'upstream_failure' })
      expect(enumerations).toBe(0)
    } else {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ token: 'ghs_secret', expires_at: expiry, repository: 'acme/widgets', permissions: cap })
      expect(enumerations).toBe(1)
    }
  }
})

test('handler performs one origin bypass for concurrent rotated-key callers', async () => {
  let bypasses = 0
  const base = github(installed, minted)
  const rotatedJwk = { ...(await crypto.subtle.exportKey('jwk', rotatedPair.publicKey)), kid: 'rotation', alg: 'RS256', use: 'sig' }
  const transport = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/.well-known/jwks')) {
      if (init.cache === 'no-store') {
        bypasses++
        expect((init as RequestInit & { cf?: unknown }).cf).toBeUndefined()
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Response(JSON.stringify({ keys: [rotatedJwk] }))
      }
      return jwks.clone()
    }
    return base(url, init)
  }) as typeof fetch
  const records: Record<string, unknown>[] = []
  expect((await handleTokenRequest(await post(await oidcToken()), envWith(), deps(transport, records))).status).toBe(200)
  const token = await oidcToken({}, 'rotation', rotatedPair.privateKey)
  const staleTransport = (async (_url: string) => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'rotation' }] }))) as typeof fetch
  const refused = await handleTokenRequest(await post(token), envWith(), deps(staleTransport, records))
  expect(refused.status).toBe(401)
  expect((await refused.json()).reason).toBe('signature')
  const responses = await Promise.all([1, 2].map(async () => handleTokenRequest(await post(token), envWith(), deps(transport, records))))
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(bypasses).toBe(1)
})

test('stalled limiter and secret reads refuse within their bounded waits', async () => {
  const transport = github(installed, minted)
  for (const overrides of [
    { TOKEN_LIMITER: { limit: () => new Promise<{ success: boolean }>(() => {}) } },
    { APP_PRIVATE_KEY: { get: () => new Promise<string>(() => {}) } },
  ]) {
    const started = performance.now()
    const response = await handleTokenRequest(await post(await oidcToken()), envWith(overrides), deps(transport, []))
    expect([502, 503]).toContain(response.status)
    expect(performance.now() - started).toBeLessThan(4000)
  }
}, 9000)

test('scope lookup timeout attempts bounded revocation and never returns the token', async () => {
  let revoked = false
  const base = github(installed, minted)
  const transport = (async (url: string, init: RequestInit) => {
    if (url.includes('/installation/repositories')) return new Promise<Response>(() => {})
    if (init.method === 'DELETE') { revoked = true; return new Response(null, { status: 204 }) }
    return base(url, init)
  }) as typeof fetch
  const records: Record<string, unknown>[] = []
  const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(transport, records))
  expect(response.status).toBe(502)
  expect(revoked).toBe(true)
  expect(await response.text()).not.toContain('ghs_secret')
  expect(JSON.stringify(records)).not.toContain('ghs_secret')
}, 5000)

test('whole exchange refuses after15s even when individual stages finish within3s', async () => {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 2700))
  const base = github(installed, minted)
  const calls: string[] = []
  const transport = (async (url: string, init: RequestInit) => {
    calls.push(url)
    await delay()
    return base(url, init)
  }) as typeof fetch
  const records: Record<string, unknown>[] = []
  const started = performance.now()
  const response = await handleTokenRequest(await post(await oidcToken()), envWith({
    TOKEN_LIMITER: { async limit() { await delay(); return { success: true } } },
    APP_PRIVATE_KEY: { async get() { await delay(); return appPem } },
  }), deps(transport, records))
  expect(response.status).toBe(502)
  expect((await response.json()).reason).toBe('exchange_timeout')
  expect(performance.now() - started).toBeLessThan(16_500)
  expect(calls.some((url) => url.includes('/installation/repositories'))).toBe(true)
  expect(records).toHaveLength(1)
  expect(JSON.stringify(records)).not.toContain('ghs_secret')
}, 18_000)

describe('the happy path', () => {
  test('mints a one-repository token and audits the grant without the credential', async () => {
    const records: Record<string, unknown>[] = []
    const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(github(installed, minted), records))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ token: 'ghs_secret', expires_at: expiry, repository: 'acme/widgets', permissions: cap })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'token_request', decision: 'granted', repository: 'acme/widgets', owner: 'acme', installation_id: 42, status: 200 })
    expect(JSON.stringify(records)).not.toContain('ghs_')
  })
})

describe('the refusals', () => {
  test('401s a missing or unusable bearer token and audits the denial without the credential', async () => {
    const records: Record<string, unknown>[] = []
    expect((await handleTokenRequest(await post(), envWith(), deps(never, records))).status).toBe(401)
    const response = await handleTokenRequest(await post('a.b.c'), envWith(), deps(never, records))
    expect(response.status).toBe(401)
    expect(records.at(-1)).toMatchObject({ event: 'token_request', decision: 'denied' })
    expect(JSON.stringify(records)).not.toContain('a.b.c')
  })

  test('429s over the rate limit and 503s when the limiter is unavailable', async () => {
    const records: Record<string, unknown>[] = []
    const denied = await handleTokenRequest(await post(await oidcToken()), envWith({ TOKEN_LIMITER: { async limit() { return { success: false } } } }), deps(github(installed, minted), records))
    expect(denied.status).toBe(429)
    expect(denied.headers.get('retry-after')).toBe('60')
    const down = await handleTokenRequest(await post(await oidcToken()), envWith({ TOKEN_LIMITER: { async limit() { throw new Error('down') } } }), deps(github(installed, minted), records))
    expect(down.status).toBe(503)
  })

  test('403s a repository the App is not installed on and 502s an upstream failure', async () => {
    const records: Record<string, unknown>[] = []
    const notInstalled = github(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }), minted)
    expect((await handleTokenRequest(await post(await oidcToken()), envWith(), deps(notInstalled, records))).status).toBe(403)
    const upstream = github(new Response('{}', { status: 500 }), minted)
    expect((await handleTokenRequest(await post(await oidcToken()), envWith(), deps(upstream, records))).status).toBe(502)
    expect(records.at(-1)).toMatchObject({ decision: 'denied' })
  })

  test('500s a widened permission echo and never returns or logs the token', async () => {
    const records: Record<string, unknown>[] = []
    const wide = new Response(JSON.stringify({ token: 'ghs_secret', expires_at: expiry, permissions: { ...cap, contents: 'write' } }), { status: 201 })
    const response = await handleTokenRequest(await post(await oidcToken()), envWith(), deps(github(installed, wide), records))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('ghs_')
    expect(JSON.stringify(records)).not.toContain('ghs_')
  })
})

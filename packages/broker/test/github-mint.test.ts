import { describe, expect, test } from 'bun:test'
import { CAPPED_PERMISSIONS, PermissionCapViolation, UpstreamFailure, mintRepoToken, permissionsMatchCap, repositoryScopeMatches } from '../src/github.ts'

const cap = { issues: 'write', metadata: 'read', organization_projects: 'write' }
const now = 1_800_000_000
const identity = { repository: 'acme/widgets', repositoryId: 12, owner: 'acme', ownerId: 4, audience: 'vegastack-factory', expiresAt: now + 300 }
const installation = { id: 42, appId: 123456, accountId: 4 }
const scope = { total_count: 1, repositories: [{ id: 12, full_name: 'acme/widgets', owner: { id: 4 } }] }
const expiry = new Date((now + 3600) * 1000).toISOString()
const tokenBody = { token: 'ghs_secret', expires_at: expiry, permissions: cap }
const args = { installation, identity, jwt: 'jwt', now: () => now }

describe('permissionsMatchCap', () => {
  test('accepts exactly the cap and rejects every deviation', () => {
    expect(CAPPED_PERMISSIONS).toEqual(cap)
    expect(permissionsMatchCap({ ...cap })).toBe(true)
    expect(permissionsMatchCap({ ...cap, contents: 'write' })).toBe(false)
    expect(permissionsMatchCap({ ...cap, issues: 'read' })).toBe(false)
    expect(permissionsMatchCap({ issues: 'write', metadata: 'read' })).toBe(false)
    expect(permissionsMatchCap(null)).toBe(false)
    expect(permissionsMatchCap('write')).toBe(false)
  })
})

describe('mintRepoToken', () => {
  test('asks for one repository and the capped permissions, and returns the echo', async () => {
    let body: Record<string, unknown> = {}
    let seen = ''
    const spy = (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        seen = url
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify(tokenBody), { status: 201 })
      }
      expect(url).toBe('https://api.github.com/installation/repositories?per_page=2')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer ghs_secret')
      return new Response(JSON.stringify(scope))
    }) as unknown as typeof fetch
    const minted = await mintRepoToken({ ...args, doFetch: spy })
    expect(seen).toBe('https://api.github.com/app/installations/42/access_tokens')
    expect(body).toEqual({ repository_ids: [12], permissions: cap })
    expect(minted).toEqual({ token: 'ghs_secret', expiresAt: expiry, permissions: cap })
  })

  test('refuses a widened echo without leaking the token, and maps a failed mint to UpstreamFailure', async () => {
    let revoked = false
    const wide = (async (url: string, init: RequestInit) => {
      if (init.method === 'DELETE') { revoked = true; expect(url).toBe('https://api.github.com/installation/token'); return new Response(null, { status: 204 }) }
      return new Response(JSON.stringify({ ...tokenBody, permissions: { ...cap, contents: 'write' } }), { status: 201 })
    }) as typeof fetch
    const error = await mintRepoToken({ ...args, doFetch: wide }).catch((e) => e)
    expect(error).toBeInstanceOf(PermissionCapViolation)
    expect((error as Error).message).not.toContain('ghs_secret')
    expect(revoked).toBe(true)
    const refused = (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof fetch
    await expect(mintRepoToken({ ...args, doFetch: refused })).rejects.toBeInstanceOf(UpstreamFailure)
  })

  test('independent repository check refuses extra/mismatched repositories and next page', async () => {
    expect(repositoryScopeMatches(scope, identity)).toBe(true)
    const bodies = [
      { ...scope, total_count: 2 },
      { ...scope, repositories: [...scope.repositories, { id: 13 }] },
      { total_count: 1, repositories: [{ ...scope.repositories[0], id: 13 }] },
      { total_count: 1, repositories: [{ ...scope.repositories[0], full_name: 'acme/other' }] },
      { total_count: 1, repositories: [{ ...scope.repositories[0], owner: { id: 9 } }] },
      {}, null,
    ]
    for (const body of bodies) expect(repositoryScopeMatches(body, identity)).toBe(false)
    let revoked = false
    const doFetch = (async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') return new Response(JSON.stringify(tokenBody), { status: 201 })
      if (init.method === 'DELETE') { revoked = true; throw new Error('credential ghs_secret') }
      return new Response(JSON.stringify(scope), { headers: { Link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' } })
    }) as typeof fetch
    const error = await mintRepoToken({ ...args, doFetch }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain('ghs_secret')
    expect(revoked).toBe(true)
  })

  test('refuses missing/expired/overlong expiry and still attempts disposable revocation', async () => {
    for (const expires_at of [undefined, 'nonsense', new Date((now + 30) * 1000).toISOString(), new Date((now + 3661) * 1000).toISOString()]) {
      let revoked = false
      const doFetch = (async (_url: string, init: RequestInit) => {
        if (init.method === 'DELETE') { revoked = true; return new Response(null, { status: 204 }) }
        return new Response(JSON.stringify({ ...tokenBody, expires_at }), { status: 201 })
      }) as typeof fetch
      await expect(mintRepoToken({ ...args, doFetch })).rejects.toThrow()
      expect(revoked).toBe(true)
    }
  })
})

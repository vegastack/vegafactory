import { describe, expect, test } from 'bun:test'
import { AppKeyRejected, NotInstalled, UpstreamFailure, appJwt, findInstallation, importAppKey } from '../src/github.ts'

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`

describe('app credentials', () => {
  test('imports a PKCS#8 key and mints a short App JWT', async () => {
    const key = await importAppKey(pkcs8Pem)
    const jwt = await appJwt('123456', key, 1_800_000_000)
    const [header, payload] = jwt.split('.').slice(0, 2).map((part) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))))
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(payload).toEqual({ iss: '123456', iat: 1_799_999_940, exp: 1_800_000_540 })
  })

  test('refuses a PKCS#1 key and names the conversion command', async () => {
    const error = await importAppKey('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n').catch((e) => e)
    expect(error).toBeInstanceOf(AppKeyRejected)
    expect((error as Error).message).toContain('openssl pkcs8 -topk8')
  })
})

describe('findInstallation', () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const identity = { repository: 'acme/widgets', repositoryId: 12, owner: 'acme', ownerId: 4, audience: 'vegastack-factory', expiresAt: 1_800_000_300 }
  const lookup = (doFetch: typeof fetch) => findInstallation({ identity, appId: '123456', jwt: 'jwt', doFetch })
  const installed = { id: 42, app_id: 123456, account: { id: 4 } }

  test('returns the installation id for an installed repository', async () => {
    expect(await lookup(respond(200, installed))).toEqual({ id: 42, appId: 123456, accountId: 4 })
  })

  test('turns 404 into NotInstalled and any other failure into UpstreamFailure', async () => {
    await expect(lookup(respond(404, { message: 'Not Found' }))).rejects.toBeInstanceOf(NotInstalled)
    await expect(lookup(respond(500, {}))).rejects.toBeInstanceOf(UpstreamFailure)
    for (const body of [{ id: 42 }, { ...installed, id: -1 }, { ...installed, app_id: 999 }, { ...installed, account: { id: 9 } }]) {
      await expect(lookup(respond(200, body))).rejects.toBeInstanceOf(UpstreamFailure)
    }
  })

  test('percent-encodes the path segments it is given', async () => {
    let seen = ''
    const spy = (async (url: string) => { seen = url; return new Response(JSON.stringify(installed), { status: 200 }) }) as unknown as typeof fetch
    await findInstallation({ identity: { ...identity, repository: 'acme/wid gets' }, appId: '123456', jwt: 'jwt', doFetch: spy })
    expect(seen).toBe('https://api.github.com/repos/acme/wid%20gets/installation')
  })
})

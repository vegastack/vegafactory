import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const body = readFileSync(resolve(import.meta.dir, '../action/action.yml'), 'utf8')
const script = body.split('        script: |\n')[1]!.replace(/^          /gm, '')

async function exercise(response: Response | Error) {
  const events: { kind: string; name?: string; value?: string }[] = []
  const core = {
    getIDToken: async (audience: string) => { expect(audience).toBe('vegastack-factory'); return 'oidc_fixture' },
    setSecret: (value: string) => events.push({ kind: 'mask', value }),
    setOutput: (name: string, value: string) => events.push({ kind: 'output', name, value }),
    info: (value: string) => events.push({ kind: 'info', value }),
    setFailed: (value: string) => events.push({ kind: 'failed', value }),
  }
  const fetch = async (url: string, init: RequestInit) => {
    expect(url).toBe('https://broker.fixture.test/token')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer oidc_fixture')
    if (response instanceof Error) throw response
    return response
  }
  await runInNewContext(`(async () => {${script}\n})()`, {
    core, fetch, AbortSignal, Date,
    process: { env: { BROKER_ENDPOINT: 'https://broker.fixture.test/token', BROKER_AUDIENCE: 'vegastack-factory' } },
  }, { timeout: 1000 })
  return events
}

describe('factory-token composite action', () => {
  test('declares the contract the broker actually serves', () => {
    expect(body).toContain('using: composite')
    expect(body).toContain('https://factory-token.vegastack.com/token')
    expect(body).toContain('vegastack-factory')
    expect(body).toContain('core.getIDToken')
    expect(body).toContain('::add-mask::')
  })

  test('never writes the token to a log or to an unmasked output', () => {
    expect(body).not.toMatch(/echo\s+.*\$\{?TOKEN/)
    expect(body).not.toContain('set -x')
    expect(body).toMatch(/id-token/)
  })

  test('executes the source script and masks before exposing both documented outputs', async () => {
    const expires_at = new Date(Date.now() + 3600_000).toISOString()
    const events = await exercise(new Response(JSON.stringify({ token: 'ghs_fixture', expires_at, repository: 'acme/widgets' })))
    const mask = events.findIndex((event) => event.kind === 'mask' && event.value === 'ghs_fixture')
    expect(mask).toBeGreaterThanOrEqual(0)
    expect(events.findIndex((event) => event.kind === 'output')).toBeGreaterThan(mask)
    expect(events.filter((event) => event.kind === 'output')).toEqual([
      { kind: 'output', name: 'token', value: 'ghs_fixture' }, { kind: 'output', name: 'expires_at', value: expires_at },
    ])
    expect(body).toContain('value: ${{ steps.mint.outputs.expires_at }}')
  })

  test('refusals and transport errors cannot reflect credential-bearing details or create outputs', async () => {
    for (const response of [
      new Response(JSON.stringify({ reason: 'ghs_fixture', token: 'ghs_fixture' }), { status: 500 }),
      new Response(JSON.stringify({ expires_at: 'not-an-expiry' })),
      new Error('oidc_fixture ghs_fixture'),
    ]) {
      const events = await exercise(response)
      expect(events.some((event) => event.kind === 'failed')).toBe(true)
      expect(events.filter((event) => event.kind === 'output')).toHaveLength(0)
      expect(JSON.stringify(events.filter((event) => ['failed', 'info'].includes(event.kind)))).not.toMatch(/ghs_fixture|oidc_fixture/)
    }
  })
})

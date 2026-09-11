import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkBrokerConfig } from '../scripts/config-check.mjs'

const envBlock = (host: string, storeId: string, namespaceId: string) => ({
  workers_dev: false,
  vars: { OIDC_AUDIENCE: 'vegastack-factory', VEGAFACTORY_APP_ID: '4812956' },
  secrets_store_secrets: [{ binding: 'APP_PRIVATE_KEY', store_id: storeId, secret_name: 'vegafactory-app-private-key' }],
  ratelimits: [{ name: 'TOKEN_LIMITER', namespace_id: namespaceId, simple: { limit: 30, period: 60 } }],
  routes: [{ pattern: host, custom_domain: true }],
  observability: { enabled: true },
})
const base = {
  name: 'vegafactory-token-broker', main: 'src/index.ts', compatibility_date: '2026-09-01',
  env: {
    preview: envBlock('vegafactory-token.vegastack.dev', 'c'.repeat(32), '1001'),
    production: envBlock('vegafactory-token.vegastack.com', 'd'.repeat(32), '1002'),
  },
}

describe('checkBrokerConfig', () => {
  test('passes a complete config', () => {
    expect(checkBrokerConfig(JSON.stringify(base))).toEqual({ blocks: [], warns: [] })
  })

  test('blocks any storage binding, because the broker declares none', () => {
    const kv = structuredClone(base) as Record<string, any>
    kv.env.production.kv_namespaces = [{ binding: 'ANYTHING', id: 'e'.repeat(32) }]
    expect(checkBrokerConfig(JSON.stringify(kv)).blocks.join(' ')).toContain('kv_namespaces')
  })

  test('a secret-shaped var or a storage binding at the top level is blocked, not just inside env blocks', () => {
    // The plan constraint is no plaintext secret anywhere in wrangler.jsonc; the leak is the
    // committed file, whether or not wrangler inherits the key into a named environment.
    const topVars = structuredClone(base) as Record<string, any>
    topVars.vars = { VEGAFACTORY_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----AAAA' }
    expect(checkBrokerConfig(JSON.stringify(topVars)).blocks).toEqual(['vars.VEGAFACTORY_APP_PRIVATE_KEY is a secret-shaped plain var — secrets belong in the Secrets Store binding'])
    const topKv = structuredClone(base) as Record<string, any>
    topKv.kv_namespaces = [{ binding: 'X', id: 'y' }]
    expect(checkBrokerConfig(JSON.stringify(topKv)).blocks).toEqual(['kv_namespaces is declared — the broker persists nothing and declares no storage binding'])
  })

  test('blocks a workers.dev origin, a missing custom domain, and a secret-shaped var', () => {
    const devOrigin = structuredClone(base); devOrigin.env.production.workers_dev = true
    expect(checkBrokerConfig(JSON.stringify(devOrigin)).blocks.join(' ')).toContain('workers_dev')
    const noDomain = structuredClone(base); noDomain.env.production.routes[0]!.custom_domain = false
    expect(checkBrokerConfig(JSON.stringify(noDomain)).blocks.join(' ')).toContain('custom_domain')
    const leaky = structuredClone(base) as Record<string, any>; leaky.env.production.vars.VEGAFACTORY_APP_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----'
    expect(checkBrokerConfig(JSON.stringify(leaky)).blocks.join(' ')).toContain('VEGAFACTORY_APP_PRIVATE_KEY')
    expect(checkBrokerConfig('{ // a comment\n }').blocks.join(' ')).toContain('comment-free')
  })

  test('blocks a private key held anywhere but the Secrets Store binding', () => {
    const noStore = structuredClone(base); noStore.env.production.secrets_store_secrets = []
    expect(checkBrokerConfig(JSON.stringify(noStore)).blocks.join(' ')).toContain('APP_PRIVATE_KEY')
    const renamed = structuredClone(base); renamed.env.preview.secrets_store_secrets[0]!.binding = 'SOMETHING_ELSE'
    expect(checkBrokerConfig(JSON.stringify(renamed)).blocks.join(' ')).toContain('APP_PRIVATE_KEY')
    const unnamed = structuredClone(base); unnamed.env.preview.secrets_store_secrets[0]!.secret_name = ''
    expect(checkBrokerConfig(JSON.stringify(unnamed)).blocks.join(' ')).toContain('secret_name')
  })

  test('blocks a rate limiter the platform cannot honour or that both environments share', () => {
    const period = structuredClone(base); period.env.production.ratelimits[0]!.simple.period = 3600
    expect(checkBrokerConfig(JSON.stringify(period)).blocks.join(' ')).toContain('period')
    const limit = structuredClone(base); limit.env.production.ratelimits[0]!.simple.limit = 0
    expect(checkBrokerConfig(JSON.stringify(limit)).blocks.join(' ')).toContain('limit')
    const shared = structuredClone(base); shared.env.production.ratelimits[0]!.namespace_id = '1001'
    expect(checkBrokerConfig(JSON.stringify(shared)).blocks.join(' ')).toContain('namespace_id')
  })

  test('blocks an empty store id and says how to find the account store', () => {
    const empty = structuredClone(base); empty.env.preview.secrets_store_secrets[0]!.store_id = ''
    const blocks = checkBrokerConfig(JSON.stringify(empty)).blocks
    expect(blocks).toEqual([
      'env.preview.secrets_store_secrets[0].store_id is empty — the account allows one store — read its id with: wrangler secrets-store store list --remote',
    ])
  })

  test('the committed config is clean: both environments bind the account store', () => {
    const path = resolve(import.meta.dir, '../wrangler.jsonc')
    const result = checkBrokerConfig(readFileSync(path, 'utf8'))
    expect(result.blocks).toEqual([])
    expect(result.warns).toEqual([])
  })
})

describe('same-App domain migration', () => {
  test('rejects the old domains, a different App and an uncoordinated audience rename', () => {
    for (const environment of ['preview', 'production'] as const) {
      const host = structuredClone(base)
      host.env[environment].routes[0]!.pattern = `factory-token.vegastack.${environment === 'preview' ? 'dev' : 'com'}`
      expect(checkBrokerConfig(JSON.stringify(host)).blocks.join(' ')).toContain('routes[0].pattern')
      const app = structuredClone(base)
      app.env[environment].vars.VEGAFACTORY_APP_ID = '1234567'
      expect(checkBrokerConfig(JSON.stringify(app)).blocks.join(' ')).toContain('VEGAFACTORY_APP_ID must be 4812956')
      const audience = structuredClone(base)
      audience.env[environment].vars.OIDC_AUDIENCE = 'vegafactory'
      expect(checkBrokerConfig(JSON.stringify(audience)).blocks.join(' ')).toContain('OIDC_AUDIENCE must be vegastack-factory')
    }
  })

  test('rejects whitespace-only store IDs and a different secret name', () => {
    const blank = structuredClone(base)
    blank.env.preview.secrets_store_secrets[0]!.store_id = '   '
    expect(checkBrokerConfig(JSON.stringify(blank)).blocks.join(' ')).toContain('store_id is empty')
    const name = structuredClone(base)
    name.env.production.secrets_store_secrets[0]!.secret_name = 'some-other-app'
    expect(checkBrokerConfig(JSON.stringify(name)).blocks.join(' ')).toContain('secret_name must be vegafactory-app-private-key')
  })
})

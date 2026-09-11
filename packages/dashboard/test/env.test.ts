import { dashboardCacheNamespace } from '../../cli/src/dashboard'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv } from '../src/lib/env'

const complete = {
  VEGAFACTORY_CONTROL_ROOM: '/home/mk/.vegastack/control-room/vegastack',
  VEGAFACTORY_CACHE: dashboardCacheNamespace('/home/mk', 'vegastack'),
  VEGAFACTORY_ORG: 'vegastack',
  VEGAFACTORY_VERSION: '1.0.0',
  VEGAFACTORY_INSTANCE_ID: '05e5c78b-6dc8-470a-848f-d6bedab83d7c',
  VEGAFACTORY_CACHE_SCHEMA: '2',
  VEGAFACTORY_REPOS: '',
  VEGAFACTORY_STATE: '/home/mk/.vegastack/factory.json',
}

test('takes the required identity variables, defaults the optional ones, names what is missing', () => {
  const bare = readEnv(complete)
  expect(bare.ok && bare.env).toMatchObject({ org: 'vegastack', repos: [], viewer: null, token: null, bin: null })
  const full = readEnv({ ...complete, VEGAFACTORY_REPOS: 'vegastack/vegafactory, vegastack/site', VEGAFACTORY_GH_TOKEN: 'gho_x' })
  expect(full.ok && full.env.repos).toEqual(['vegastack/site', 'vegastack/vegafactory'])
  expect(full.ok && full.env.token).toBe('gho_x')
  expect(readEnv({ VEGAFACTORY_ORG: 'vegastack' }))
    .toEqual({ ok: false, missing: ['VEGAFACTORY_CONTROL_ROOM', 'VEGAFACTORY_CACHE', 'VEGAFACTORY_STATE', 'VEGAFACTORY_VERSION', 'VEGAFACTORY_INSTANCE_ID', 'VEGAFACTORY_CACHE_SCHEMA', 'VEGAFACTORY_REPOS'] })
})

test('the stylesheet imports the design-system preset rather than declaring colours', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/app/globals.css'), 'utf8')
  expect(css).toContain('@import "@vegastack/design/preset.css";')
  expect(css).not.toMatch(/#[0-9a-fA-F]{6}\b/)
})

test('rejects legacy/wrong-org namespace, absent nonce/schema and foreign repositories', () => {
  expect(readEnv({...complete, VEGAFACTORY_CACHE: '/home/mk/.vegastack/cache/stats.db'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_CACHE: dashboardCacheNamespace('/other', 'vegastack')}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_ORG: 'other'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_INSTANCE_ID: ''}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_CACHE_SCHEMA: '1'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_VERSION: 'latest'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_REPOS: 'other/repo'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_REPOS: 'vegastack/repo,vegastack/repo'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_STATE: 'relative/factory.json'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_CONTROL_ROOM: 'relative/room'}).ok).toBe(false)
  expect(readEnv({...complete, VEGAFACTORY_VERSION: 'unverified-development'}).ok).toBe(true)
})

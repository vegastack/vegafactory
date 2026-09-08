import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dashboardCacheNamespace } from '../../cli/src/dashboard'

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8')

test('is publishable at the CLI version, from an assembled standalone tree', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.name).toBe('@vegastack/vegafactory-dashboard')
  expect(manifest.private).toBeUndefined()
  expect(manifest.version).toBe(JSON.parse(read('../cli/package.json')).version)
  expect(manifest.files).toEqual(['dist-standalone', 'README.md', 'LICENSE'])
  expect(manifest.scripts.prepack).toBe('bun run build && bun run assemble')
  const config = read('next.config.ts')
  expect(config).toContain("output: 'standalone'")
  expect(config).toContain('outputFileTracingRoot')
  expect(config).toContain("serverExternalPackages: ['bun:sqlite']")
})

test('standalone runtime declares Node and Bun requirements separately from platform proof', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.engines.node).toBe('>=24')
  expect(manifest.engines.bun).toBe('>=1.3')
})

test('first-use health proves exact launcher identity without exposing paths or credentials', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-health-')))
  const keys = ['VEGAFACTORY_CONTROL_ROOM', 'VEGAFACTORY_CACHE', 'VEGAFACTORY_ORG', 'VEGAFACTORY_STATE', 'VEGAFACTORY_VERSION', 'VEGAFACTORY_INSTANCE_ID', 'VEGAFACTORY_CACHE_SCHEMA', 'VEGAFACTORY_REPOS', 'VEGAFACTORY_GH_TOKEN'] as const
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const instanceId = crypto.randomUUID()
  Object.assign(process.env, {
    VEGAFACTORY_CONTROL_ROOM: join(home, 'room'), VEGAFACTORY_CACHE: dashboardCacheNamespace(home, 'vegastack'),
    VEGAFACTORY_ORG: 'vegastack', VEGAFACTORY_STATE: join(home, '.vegastack/factory.json'), VEGAFACTORY_VERSION: '1.0.0',
    VEGAFACTORY_INSTANCE_ID: instanceId, VEGAFACTORY_CACHE_SCHEMA: '2', VEGAFACTORY_REPOS: '', VEGAFACTORY_GH_TOKEN: 'secret-token',
  })
  try {
    const response = await (await import('../src/app/api/health/route')).GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, org: 'vegastack', version: '1.0.0', instanceId, cacheSchema: 2, dataState: 'unavailable', sourceAgeSeconds: null })
  } finally {
    for (const key of keys) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]
    await rm(home, { recursive: true, force: true })
  }
})

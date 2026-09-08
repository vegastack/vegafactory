import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { CACHE_SCHEMA_VERSION } from './cache/schema'
export interface ServerEnv {
  controlRoom: string
  cacheFile: string
  org: string
  repos: string[]
  stateFile: string
  instanceId: string
  cacheSchema: number
  version: string
  viewer: string | null
  token: string | null
  bin: string | null
}

const REQUIRED = ['VEGAFACTORY_CONTROL_ROOM', 'VEGAFACTORY_CACHE', 'VEGAFACTORY_ORG', 'VEGAFACTORY_STATE', 'VEGAFACTORY_VERSION', 'VEGAFACTORY_INSTANCE_ID', 'VEGAFACTORY_CACHE_SCHEMA', 'VEGAFACTORY_REPOS'] as const

const value = (source: Record<string, string | undefined>, key: string): string | null => {
  const raw = source[key]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

// Launcher identity and an organization-derived namespace are required even for an empty shell.
export function readEnv(source: Record<string, string | undefined>): { ok: true; env: ServerEnv } | { ok: false; missing: string[] } {
  const missing: string[] = REQUIRED.filter((key) => key === 'VEGAFACTORY_REPOS' ? source[key] === undefined : value(source, key) === null)
  if (missing.length > 0) return { ok: false, missing }
  const org = value(source, 'VEGAFACTORY_ORG')!
  const cache = value(source, 'VEGAFACTORY_CACHE')!
  const stateFile = value(source, 'VEGAFACTORY_STATE')!
  const controlRoom = value(source, 'VEGAFACTORY_CONTROL_ROOM')!
  const orgHash = createHash('sha256').update(org).digest('hex')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(org)) missing.push('VEGAFACTORY_ORG')
  const expectedCache = isAbsolute(stateFile) && basename(stateFile) === 'factory.json'
    ? join(dirname(stateFile), 'dashboard', orgHash, `cache-v${CACHE_SCHEMA_VERSION}`) : null
  if (!isAbsolute(cache) || resolve(cache) !== cache || cache !== expectedCache || basename(cache) !== `cache-v${CACHE_SCHEMA_VERSION}` || basename(dirname(cache)) !== orgHash) missing.push('VEGAFACTORY_CACHE')
  if (!isAbsolute(stateFile) || resolve(stateFile) !== stateFile || basename(stateFile) !== 'factory.json') missing.push('VEGAFACTORY_STATE')
  if (!isAbsolute(controlRoom) || resolve(controlRoom) !== controlRoom) missing.push('VEGAFACTORY_CONTROL_ROOM')
  if (value(source, 'VEGAFACTORY_CACHE_SCHEMA') !== String(CACHE_SCHEMA_VERSION)) missing.push('VEGAFACTORY_CACHE_SCHEMA')
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value(source, 'VEGAFACTORY_INSTANCE_ID')!)) missing.push('VEGAFACTORY_INSTANCE_ID')
  if (!/^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|unverified-development)$/.test(value(source, 'VEGAFACTORY_VERSION')!)) missing.push('VEGAFACTORY_VERSION')
  const repos = (source.VEGAFACTORY_REPOS ?? '').split(',').map(repo => repo.trim()).filter(Boolean)
  if (repos.some(repo => !repo.startsWith(org + '/') || !/^[a-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) || new Set(repos).size !== repos.length) missing.push('VEGAFACTORY_REPOS')
  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    env: {
      controlRoom: value(source, 'VEGAFACTORY_CONTROL_ROOM')!,
      cacheFile: value(source, 'VEGAFACTORY_CACHE')!,
      org: value(source, 'VEGAFACTORY_ORG')!,
      stateFile: value(source, 'VEGAFACTORY_STATE')!,
      repos: [...new Set(repos)].sort(),
      version: value(source, 'VEGAFACTORY_VERSION')!,
      instanceId: value(source, 'VEGAFACTORY_INSTANCE_ID')!,
      cacheSchema: CACHE_SCHEMA_VERSION,
      viewer: value(source, 'VEGAFACTORY_VIEWER'),
      token: value(source, 'VEGAFACTORY_GH_TOKEN'),
      bin: value(source, 'VEGAFACTORY_BIN'),
    },
  }
}

// `vegafactory dashboard` — fetch the dashboard package on first use, then launch its Next.js
// standalone server under Bun on the loopback interface.
//
// The dashboard is a second published package rather than part of this one: its traced server
// tree is tens of megabytes, and every `vegafactory skills add` would pay for it. Fetching it at
// the CLI's own version keeps the two in step without a resolution step that can drift.

import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { acquireClaim, processIdentity, releaseClaim, type ProcessIdentity } from './claims.ts'
import { inspectOwnedGroup, signalOwnedGroup } from './run-wrapper.ts'

export const DASHBOARD_PACKAGE = '@vegastack/vegafactory-dashboard'
export const SERVER_ENTRY = 'dist-standalone/packages/dashboard/server.js'
const DEFAULT_PORT = 7777
const PORT_SPAN = 10
const HEALTH_TIMEOUT_MS = 20_000

export function dashboardSpec(version: string): string {
  return `${DASHBOARD_PACKAGE}@${version}`
}

export interface DashboardPaths {
  root: string
  entry: string
  source: 'override' | 'cache'
}

// One install root per CLI version, so a downgrade finds its own tree rather than a newer one,
// and an upgrade never has to invalidate anything. `--dir` points straight at a built package —
// the repo's own `packages/dashboard` while developing.
export function dashboardPaths(input: { home: string; version: string; override: string | null }): DashboardPaths {
  if (input.override) return { root: input.override, entry: join(input.override, SERVER_ENTRY), source: 'override' }
  const root = join(input.home, '.vegastack', 'dashboard', input.version)
  return { root, entry: join(root, 'node_modules', DASHBOARD_PACKAGE, SERVER_ENTRY), source: 'cache' }
}

export function installArgs(input: { root: string; version: string }): string[] {
  return ['install', '--prefix', input.root, dashboardSpec(input.version), '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts']
}

export interface DashboardPlan {
  action: 'launch' | 'fetch-then-launch' | 'plan' | 'refuse'
  reason: string
}

// An override is never fetched over: `--dir` names a tree the operator is working in, and
// installing a published tarball on top of it would silently replace what they are testing.
export function planDashboard(input: { entryExists: boolean; source: 'override' | 'cache'; dryRun: boolean }): DashboardPlan {
  if (!input.entryExists && input.source === 'override') {
    return {
      action: 'refuse',
      reason: 'the --dir tree has no dist-standalone/packages/dashboard/server.js; run bun run build && bun run assemble in it first',
    }
  }
  if (input.dryRun) {
    return {
      action: 'plan',
      reason: input.entryExists ? 'the server entry is present; a real run would launch it' : `a real run would fetch ${DASHBOARD_PACKAGE} and launch it`,
    }
  }
  if (input.entryExists) return { action: 'launch', reason: 'the server entry is present' }
  return { action: 'fetch-then-launch', reason: `${DASHBOARD_PACKAGE} is not installed for this version yet` }
}

export function portCandidates(start: number, span: number): number[] {
  return Array.from({ length: span }, (_, index) => start + index)
}

export function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/health`
}

export interface ServerLaunchInput {
  controlRoom: string
  cacheFile: string
  org: string
  repos: string[]
  stateFile: string
  viewer: string | null
  token: string | null
  bin: string
  port: number
  version: string
  instanceId: string
}

// The whole contract the server reads, and nothing else. A null value is omitted rather than set
// empty, so the server's own "is this variable present" test stays true to what the CLI knew.
// HOSTNAME pins the listener to the loopback interface: the token in this environment must not
// be reachable from the network.
export function launchEnv({ env }: { env: ServerLaunchInput }): Record<string, string> {
  const out: Record<string, string> = {
    HOSTNAME: '127.0.0.1',
    PORT: String(env.port),
    VEGAFACTORY_CONTROL_ROOM: env.controlRoom,
    VEGAFACTORY_CACHE: env.cacheFile,
    VEGAFACTORY_ORG: env.org,
    VEGAFACTORY_STATE: env.stateFile,
    VEGAFACTORY_BIN: env.bin,
    VEGAFACTORY_REPOS: env.repos.join(','),
    VEGAFACTORY_VERSION: env.version,
    VEGAFACTORY_INSTANCE_ID: env.instanceId,
    VEGAFACTORY_CACHE_SCHEMA: '2',
  }
  if (env.viewer) out.VEGAFACTORY_VIEWER = env.viewer
  if (env.token) out.VEGAFACTORY_GH_TOKEN = env.token
  return out
}

const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(command, args, { ...options, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (error as { code?: unknown }).code : 0
      resolve({ code: typeof code === 'number' ? code : error ? 1 : 0, stdout, stderr })
    })
  })

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// A symlink anywhere on the install path is refused rather than followed: the install root is a
// directory this tool owns and writes into, and following a link there would let anything on the
// machine redirect an `npm install --prefix` into a tree the operator did not choose.
async function symlinked(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}


export interface DashboardOptions {
  rest: string[]
  home?: string
  version: string
}

interface Flags {
  port: number
  org: string | null
  open: boolean
  dir: string | null
  dryRun: boolean
  json: boolean
  help: boolean
}

export function parseDashboardFlags(rest: string[]): Flags {
  const flags: Flags = { port: DEFAULT_PORT, org: null, open: false, dir: null, dryRun: false, json: false, help: false }
  const argv = [...rest]
  while (argv.length) {
    const flag = argv.shift()!
    if (flag === '--port') {
      const value = argv.shift()
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port requires a port number between 1 and 65535')
      flags.port = port
    }
    else if (flag === '--org') {
      const value = argv.shift()
      if (!value || value.startsWith('-')) throw Error('--org requires a value')
      flags.org = value
    }
    else if (flag === '--open') flags.open = true
    else if (flag === '--dir') {
      const value = argv.shift()
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error('--dir requires a value')
      flags.dir = value
    }
    else if (flag === '--dry-run') flags.dryRun = true
    else if (flag === '--json') flags.json = true
    else if (flag === 'help' || flag === '--help' || flag === '-h') flags.help = true
    else throw new Error(`Unknown option: ${flag}`)
  }
  return flags
}

export function dashboardUsage(): string {
  return `Usage: vegafactory dashboard [--org ORG] [--port N] [--open] [--dir PATH] [--dry-run] [--json]

Starts the local read-only dashboard over the control room's statistics and the live board.
The package is fetched on first use into ~/.vegastack/dashboard/<version>/ and the server
binds 127.0.0.1 only. Organization caches use immutable pinned generations under
~/.vegastack/dashboard/<sha256(org)>/cache-v2/. Legacy shared caches are preserved.

  --org ORG    organization (inferred only when one is configured)
  --port N     first port to try (default ${DEFAULT_PORT}; the next ${PORT_SPAN - 1} are tried in turn)
  --open       open the URL in the browser once the server answers
  --dir PATH   launch an already-built package tree instead of the fetched one
  --dry-run    print what a real run would do, and change nothing
  --json       machine-readable result

Exit 0 the server answers, or the dry-run plan printed · 1 the server exited or never
answered · 2 a usage error or a refusal.`
}

// Collects the environment from this machine: the control room this org recorded, the viewer and
// token from `gh`, and the path to this very binary for the status bridge. Everything optional
// degrades to null — a dashboard with no `gh` still renders every cached view.
async function collect(home: string, requested: string | null): Promise<{
  controlRoom: string
  org: string
  stateFile: string
  repos: string[]
  viewer: string | null
  token: string | null
} | { error: string }> {
  const { factoryConfigPath, readFactoryConfig } = await import('./control-room.ts')
  const stateFile = factoryConfigPath(home)
  let config
  try {
    const text = await readFile(stateFile, 'utf8').catch(() => null)
    config = readFactoryConfig(text)
  } catch (error) {
    return { error: (error as Error).message }
  }
  let org: string, repos: string[]
  try {
    org = selectDashboardOrg(Object.keys(config.controlRooms), requested)
    repos = dashboardRepositories(config.settings.repos, org)
    if (!isAbsolute(config.controlRooms[org]!.path)) throw Error('control room path must be absolute')
  } catch (error) { return { error: (error as Error).message } }

  const { ghText } = await import('./gh.ts')
  const quiet = async (args: string[]): Promise<string | null> => {
    try {
      return (await ghText(args)).trim() || null
    } catch {
      return null
    }
  }

  return {
    controlRoom: config.controlRooms[org]!.path,
    org,
    stateFile,
    repos,
    viewer: await quiet(['api', 'user', '-q', '.login']),
    token: await quiet(['auth', 'token']),
  }
}

export async function runDashboard(options: DashboardOptions): Promise<number> {
  let flags: Flags
  try {
    flags = parseDashboardFlags(options.rest)
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    return 2
  }
  if (flags.help) {
    console.log(dashboardUsage())
    return 0
  }

  const home = options.home ?? homedir()
  const paths = dashboardPaths({ home, version: options.version, override: flags.dir })
  // Both the install root and the entry, because they are two different attacks: a linked root
  // redirects an `npm install --prefix` into a tree the operator did not choose, and a linked
  // entry redirects what `bun` executes even when the root is honest.
  for (const path of [paths.root, paths.entry]) {
    if (await symlinked(path)) {
      console.error(`error: ${path} is a symlink; the dashboard refuses to install or launch through one`)
      return 2
    }
  }

  const plan = planDashboard({ entryExists: await exists(paths.entry), source: paths.source, dryRun: flags.dryRun })
  if (plan.action === 'refuse') {
    console.error(`error: ${plan.reason}`)
    return 2
  }

  const environment = await collect(home, flags.org)
  if ('error' in environment) {
    console.error(`error: ${environment.error}`)
    return 2
  }

  const cacheFile = dashboardCacheNamespace(home, environment.org)
  if (plan.action === 'plan') {
    const document = {
      command: 'dashboard', ok: true, url: healthUrl(flags.port).replace('/api/health', ''),
      dir: paths.root, entry: paths.entry, fetched: false, pid: null, plan: plan.reason,
    }
    console.log(flags.json ? JSON.stringify(document, null, 2) : `${plan.reason}\n  install root: ${paths.root}\n  entry: ${paths.entry}\n  cache: ${cacheFile}`)
    return 0
  }

  let fetched = false
  try {
    if (paths.source === 'cache') {
      const descriptorPath = fileURLToPath(new URL('./dashboard-artifact.json', import.meta.url))
      const descriptor = validateDashboardDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')), options.version)
      fetched = await installDashboardArtifact(paths.root, descriptor, () => downloadDashboard(options.version, descriptor))
    } else await verifyAncestors(dirname(paths.entry))
  } catch (error) { console.error(`error: ${(error as Error).message}`); return 2 }

  const version = paths.source === 'override' ? 'unverified-development' : options.version
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  for (const port of portCandidates(flags.port, PORT_SPAN).filter(port => port <= 65535)) {
    if (Date.now() >= deadline) break
    const identity: DashboardIdentity = {org: environment.org, version, instanceId: randomUUID(), cacheSchema: 2}
    const env = launchEnv({env: {...environment, cacheFile, port, version, instanceId: identity.instanceId, bin: process.argv[1] ?? 'vegafactory'}})
    const attempt = launchDashboardChild(paths.entry, {...process.env, ...env}, flags.json)
    try {
      const ready = await waitDashboardChild(attempt, identity, port, Math.min(deadline, Date.now() + 2_000))
      if (!ready) {
        if (!await stopDashboardChild(attempt)) { console.error('error: dashboard child termination is unverified; retained ownership, no port retry'); return 1 }
        continue
      }
      const url = `http://127.0.0.1:${port}`
      if (flags.json) console.log(JSON.stringify({command: 'dashboard', ok: true, ...identity, url, dir: paths.root, entry: paths.entry, fetched, pid: attempt.child.pid ?? null}, null, 2))
      else console.log(`dashboard: ${url}${paths.source === 'override' ? ' (unverified-development)' : ''}  (ctrl-c to stop)`)
      if (flags.open) await run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
      const interrupt = () => { void stopDashboardChild(attempt) }
      process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
      try { const code = await attempt.finished; return code === 0 || code === null ? 0 : 1 }
      finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
    } catch (error) {
      const stopped = await stopDashboardChild(attempt)
      console.error(`error: ${(error as Error).message}${stopped ? '' : '; child termination unverified'}`)
      return 1
    }
  }
  console.error('error: no owned dashboard instance became ready within 20 seconds')
  return 1
}

export interface DashboardChild {
  child: ReturnType<typeof spawn>
  finished: Promise<number | null>
  identity: Promise<ProcessIdentity | null>
  exited: boolean
  error: Error | null
  stopping?: Promise<boolean>
}
export function launchDashboardChild(entry: string, env: NodeJS.ProcessEnv, quiet = true): DashboardChild {
  const child = spawn('bun', [entry], {env, detached: true, stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit'})
  let complete!: (code: number | null) => void
  let identify!: (value: ProcessIdentity | null) => void
  const state: DashboardChild = {child, finished: new Promise(resolve => {complete = resolve}), identity: new Promise(resolve => {identify = resolve}), exited: false, error: null}
  child.once('error', error => {state.error = error; state.exited = true; identify(null); complete(1)})
  child.once('exit', code => {state.exited = true; complete(code)})
  child.once('spawn', () => {void processIdentity(child.pid!).then(identify, () => identify(null))})
  return state
}
export async function waitDashboardChild(state: DashboardChild, identity: DashboardIdentity, port: number, deadline: number): Promise<boolean> {
  while (!state.exited && !state.error && Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl(port), {cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))})
      const actual: unknown = await response.json()
      if (response.ok && matchesReadiness(actual, identity) && !state.exited && !state.error) {
        const owned = await state.identity
        if (owned && (await inspectOwnedGroup(owned)).kind === 'owned' && !state.exited) return true
      }
    } catch { /* The bounded next probe can observe this child's bind or exit. */ }
    if (!state.exited) await Promise.race([state.finished, new Promise(resolve => setTimeout(resolve, 250))])
  }
  return false
}
export function stopDashboardChild(state: DashboardChild): Promise<boolean> {
  return state.stopping ??= (async () => {
    const identity = await state.identity
    if (!identity) return state.exited
    let observation = await inspectOwnedGroup(identity)
    if (observation.kind === 'absent') { await state.finished; return true }
    if (observation.kind !== 'owned' || !await signalOwnedGroup(identity, 'SIGTERM')) return false
    await Promise.race([state.finished, new Promise(resolve => setTimeout(resolve, 5000))])
    observation = await inspectOwnedGroup(identity)
    if (observation.kind !== 'absent') {
      if (observation.kind !== 'owned' || !await signalOwnedGroup(identity, 'SIGKILL')) return false
      await Promise.race([state.finished, new Promise(resolve => setTimeout(resolve, 1000))])
    }
    return state.exited && (await inspectOwnedGroup(identity)).kind === 'absent'
  })()
}

export interface DashboardIdentity { org: string; version: string; instanceId: string; cacheSchema: 2 }
export function matchesReadiness(actual: unknown, expected: DashboardIdentity): boolean {
  if (!actual || typeof actual !== 'object') return false
  const value = actual as Record<string, unknown>
  return value.ok === true && value.org === expected.org && value.version === expected.version &&
    value.instanceId === expected.instanceId && value.cacheSchema === expected.cacheSchema &&
    ['ready', 'empty', 'unavailable'].includes(value.dataState as string) &&
    (value.sourceAgeSeconds === null || typeof value.sourceAgeSeconds === 'number' && Number.isFinite(value.sourceAgeSeconds) && value.sourceAgeSeconds >= 0)
}
export function selectDashboardOrg(orgs: string[], requested: string | null): string {
  const canonical = orgs.map(org => org.toLowerCase())
  if (orgs.some((org, i) => org !== canonical[i] || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(org)) || new Set(canonical).size !== orgs.length) throw Error('configured org identity is not canonical')
  const selected = requested?.toLowerCase() ?? (canonical.length === 1 ? canonical[0] : null)
  if (!selected || !canonical.includes(selected)) throw Error('select a configured organization with --org')
  return selected
}
export function dashboardRepositories(raw: unknown, org: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw Error('configured repositories must be registration objects')
  const repos: string[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.repo !== 'string' || typeof item.org !== 'string' || typeof item.path !== 'string' || !isAbsolute(item.path)) throw Error('invalid repository registration')
    if (item.org !== org) continue
    if (!item.repo.startsWith(org + '/') || !/^[a-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(item.repo)) throw Error('repository does not belong to selected org')
    if (repos.includes(item.repo)) throw Error('duplicate repository registration')
    repos.push(item.repo)
  }
  return repos.sort()
}
export function dashboardCacheNamespace(home: string, org: string): string {
  return join(home, '.vegastack', 'dashboard', digest(org), 'cache-v2')
}
interface ArtifactFile { path: string; sha256: string; mode: number }
export interface DashboardArtifactDescriptor {
  schemaVersion: 1; name: string; version: string; sha256: string; integrity: string; bytes: number; files: ArtifactFile[]
}
const digest = (bytes: string | Uint8Array, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
function artifactPath(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.split('/').some(x => !x || x === '.' || x === '..') || /^[A-Za-z]:/.test(path)) throw Error('unsafe package path')
  return path
}
export function validateDashboardDescriptor(value: unknown, version: string): DashboardArtifactDescriptor {
  const d = value as DashboardArtifactDescriptor
  if (!d || typeof d !== 'object' || Object.keys(d).sort().join(',') !== 'bytes,files,integrity,name,schemaVersion,sha256,version' ||
    d.schemaVersion !== 1 || d.name !== DASHBOARD_PACKAGE || d.version !== version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^[a-f0-9]{64}$/.test(d.sha256) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(d.integrity) ||
    !Number.isSafeInteger(d.bytes) || d.bytes < 1 || d.bytes > 1024 * 1024 * 1024 || !Array.isArray(d.files) || !d.files.length) throw Error('missing, stale or malformed dashboard descriptor')
  const seen = new Set<string>()
  let previous = ''
  for (const file of d.files) {
    if (!file || typeof file !== 'object' || Object.keys(file).sort().join(',') !== 'mode,path,sha256') throw Error('invalid dashboard file manifest')
    artifactPath(file.path)
    if (file.path <= previous || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || ![0o644, 0o755].includes(file.mode)) throw Error('invalid dashboard file manifest')
    previous = file.path; seen.add(file.path)
  }
  for (const file of d.files) for (let path = dirname(file.path); path !== '.'; path = dirname(path)) if (seen.has(path)) throw Error('package file/directory collision')
  if (!seen.has('package.json') || !seen.has(SERVER_ENTRY)) throw Error('dashboard descriptor has no package identity/server')
  return d
}

function readPackageArchive(bytes: Buffer): Array<ArtifactFile & {data: Buffer}> {
  const tar = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 })
  const files: Array<ArtifactFile & {data: Buffer}> = []; const seen = new Set<string>(); let pax: Record<string,string> | null = null; let ended = false
  const str = (b: Buffer) => b.toString('utf8').split('\0')[0]!
  const oct = (b: Buffer) => { const s = str(b).trim(); if (s && !/^[0-7]+$/.test(s)) throw new Error('invalid tar number'); return s ? parseInt(s, 8) : 0 }
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512)
    if (h.every(b => b === 0)) { if (!tar.subarray(off).every(b => b === 0)) throw new Error('trailing tar data'); ended = true; break }
    const sum = [...h].reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0)
    if (sum !== oct(h.subarray(148, 156))) throw new Error('tar checksum mismatch')
    const size = oct(h.subarray(124, 136)); const mode = oct(h.subarray(100, 108)); const type = str(h.subarray(156, 157)) || '0'
    if (!Number.isSafeInteger(size) || off + 512 + size > tar.length) throw new Error('truncated tar entry')
    const data = tar.subarray(off + 512, off + 512 + size); off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      if (pax) throw new Error('duplicate pax header')
      pax = {}
      for (let i = 0; i < data.length;) {
        const space = data.indexOf(32, i); const n = Number(data.subarray(i, space).toString())
        if (space < i || !Number.isSafeInteger(n) || n <= space - i + 1 || i + n > data.length || data[i+n-1] !== 10) throw new Error('invalid pax record')
        const record = data.subarray(space + 1, i+n-1).toString(); const eq = record.indexOf('='); const key = record.slice(0, eq)
        if (eq < 1 || Object.hasOwn(pax,key)) throw new Error('invalid duplicate pax key')
        if (!['path','mtime','atime','ctime','uid','gid','uname','gname','SCHILY.dev','SCHILY.ino','SCHILY.nlink'].includes(key)) throw new Error(`unsupported pax key: ${key}`)
        pax[key] = record.slice(eq+1); i += n
      }
      continue
    }
    let path = pax?.path ?? [str(h.subarray(345,500)),str(h.subarray(0,100))].filter(Boolean).join('/'); pax = null
    if (type === '5') path = path.replace(/\/$/,'')
    artifactPath(path)
    if (path !== 'package' && !path.startsWith('package/')) throw new Error('tar entry outside package')
    if (seen.has(path)) throw new Error('duplicate package path'); seen.add(path)
    if (type === '5') continue
    if (type !== '0' || path === 'package' || ![0o644,0o755].includes(mode)) throw new Error('unsupported package entry type or mode')
    files.push({ path: path.slice(8), sha256: digest(data), mode, data })
  }
  if (!ended || pax) throw new Error('incomplete tar archive')
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const paths = new Set(files.map(f => f.path))
  for (const f of files) for (let p = dirname(f.path); p !== '.'; p = dirname(p)) if (paths.has(p)) throw new Error('file/directory collision')
  return files
}
export function verifyDashboardArtifact(bytes: Buffer, descriptor: DashboardArtifactDescriptor): Array<ArtifactFile & {data: Buffer}> {
  validateDashboardDescriptor(descriptor, descriptor.version)
  if (bytes.length !== descriptor.bytes || digest(bytes) !== descriptor.sha256 || `sha512-${digest(bytes, 'sha512', 'base64')}` !== descriptor.integrity) throw Error('dashboard artifact integrity mismatch')
  const files = readPackageArchive(bytes)
  if (JSON.stringify(files.map(({path, sha256, mode}) => ({path, sha256, mode}))) !== JSON.stringify(descriptor.files)) throw Error('dashboard artifact file manifest mismatch')
  const pkg = JSON.parse(files.find(file => file.path === 'package.json')!.data.toString())
  if (pkg.name !== descriptor.name || pkg.version !== descriptor.version) throw Error('dashboard package identity mismatch')
  return files
}
async function verifyAncestors(path: string, create = false): Promise<void> {
  let current: string = sep
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('dashboard path contains a link or non-directory')
  }
}
export async function verifyDashboardTree(root: string, descriptor: DashboardArtifactDescriptor): Promise<void> {
  validateDashboardDescriptor(descriptor, descriptor.version)
  await verifyAncestors(root)
  const expected = new Map(descriptor.files.map(file => [file.path, file]))
  const directories = new Set<string>()
  for (const file of descriptor.files) for (let path = dirname(file.path); path !== '.'; path = dirname(path)) directories.add(path)
  const observed = new Set<string>()
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const before = await lstat(directory)
    if (!before.isDirectory() || before.isSymbolicLink()) throw Error('dashboard directory changed')
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, path = join(directory, name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw Error('dashboard filesystem link refused')
      if (info.isDirectory()) {
        if (!directories.has(relative)) throw Error('unexpected dashboard directory')
        await walk(path, relative); continue
      }
      const file = expected.get(relative)
      if (!file || !info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== file.mode) throw Error('dashboard file/type/mode mismatch')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat()
        if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1) throw Error('dashboard file changed while opening')
        const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(path)
        if (digest(bytes) !== file.sha256 || after.ino !== named.ino || after.dev !== named.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || named.isSymbolicLink()) throw Error('dashboard file integrity mismatch')
      } finally { await handle.close() }
      observed.add(relative)
    }
    const after = await lstat(directory)
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.isSymbolicLink()) throw Error('dashboard directory changed during verification')
  }
  await walk(root, '')
  if (observed.size !== expected.size) throw Error('dashboard files missing')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (pkg.name !== descriptor.name || pkg.version !== descriptor.version) throw Error('dashboard package identity mismatch')
}
export function dashboardInstallReceipt(descriptor: DashboardArtifactDescriptor): string {
  return JSON.stringify({schemaVersion: 1, owner: 'vegafactory-dashboard', version: descriptor.version, descriptorSha256: digest(JSON.stringify(descriptor))})
}
export async function installDashboardArtifact(root: string, descriptor: DashboardArtifactDescriptor, download: () => Promise<Buffer>): Promise<boolean> {
  await verifyAncestors(dirname(root), true)
  const claimRoot = join(dirname(root), '.install-claims')
  await verifyAncestors(claimRoot, true)
  const identity = await processIdentity(), deadline = Date.now() + 120_000
  let held
  for (;;) {
    const result = await acquireClaim(join(claimRoot, `${digest(descriptor.version)}.claim`), identity)
    if (result.kind === 'owned') { held = result.claim; break }
    if (result.kind === 'refused' || Date.now() >= deadline) throw Error('dashboard install claim unavailable')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  let staging: string | null = null
  try {
    if (await exists(root)) {
      await verifyAncestors(root)
      const receipt = join(root, 'dashboard-install.json'), info = await lstat(receipt)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await readFile(receipt, 'utf8') !== dashboardInstallReceipt(descriptor)) throw Error('unowned dashboard install preserved; remove or relocate it explicitly before retrying')
      await verifyDashboardTree(join(root, 'node_modules', DASHBOARD_PACKAGE), descriptor)
      return false
    }
    staging = await mkdtemp(`${root}.staging-`)
    const files = verifyDashboardArtifact(await download(), descriptor)
    const packageRoot = join(staging, 'node_modules', DASHBOARD_PACKAGE)
    await mkdir(packageRoot, {recursive: true})
    for (const file of files) {
      if (Date.now() >= deadline) throw Error('dashboard install deadline exceeded')
      const path = join(packageRoot, file.path)
      await mkdir(dirname(path), {recursive: true})
      await writeFile(path, file.data, {flag: 'wx', mode: file.mode}); await chmod(path, file.mode)
    }
    await verifyDashboardTree(packageRoot, descriptor)
    await writeFile(join(staging, 'dashboard-install.json'), dashboardInstallReceipt(descriptor), {flag: 'wx'})
    if (await exists(root)) throw Error('dashboard install appeared before publication')
    await rename(staging, root); staging = null
    return true
  } finally { if (staging) await rm(staging, {recursive: true, force: true}); await releaseClaim(held) }
}
async function downloadDashboard(version: string, descriptor: DashboardArtifactDescriptor): Promise<Buffer> {
  const signal = AbortSignal.timeout(120_000)
  const registry = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org/'
  const metadata = await fetch(new URL(`${encodeURIComponent(DASHBOARD_PACKAGE)}/${version}`, registry.endsWith('/') ? registry : registry + '/'), {signal})
  if (!metadata.ok) throw Error('dashboard package lookup failed')
  const value = await metadata.json() as {dist?: {tarball?: string}}
  if (!value.dist?.tarball) throw Error('dashboard tarball locator missing')
  const response = await fetch(value.dist.tarball, {signal})
  if (!response.ok || !response.body) throw Error('dashboard download failed')
  const chunks: Buffer[] = []; let size = 0
  const reader = response.body.getReader()
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > descriptor.bytes) throw Error('dashboard archive size mismatch'); chunks.push(Buffer.from(part.value)) } }
  finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

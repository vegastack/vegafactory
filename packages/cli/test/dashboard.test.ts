import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  dashboardCacheNamespace, dashboardInstallReceipt, dashboardPaths, dashboardRepositories,
  dashboardSpec, installArgs, installDashboardArtifact, launchDashboardChild, launchEnv,
  matchesReadiness, planDashboard, portCandidates, selectDashboardOrg, SERVER_ENTRY,
  stopDashboardChild, validateDashboardDescriptor, verifyDashboardArtifact, verifyDashboardTree,
  waitDashboardChild, type DashboardArtifactDescriptor, type DashboardIdentity,
} from '../src/dashboard.ts'

const base = {
  controlRoom: '/c', cacheFile: '/c/stats.db', org: 'vegastack', repos: ['vegastack/vegafactory'],
  viewer: 'mk', token: 'gho_x', bin: '/bin/vegafactory', stateFile: '/f.json', port: 7777, version: '1.0.0', instanceId: '05e5c78b-6dc8-470a-848f-d6bedab83d7c',
}

test('the cache root is versioned, the fetch is pinned, and --dir is never fetched over', () => {
  const paths = dashboardPaths({ home: '/home/mk', version: '0.19.0', override: null })
  expect(paths.root).toBe('/home/mk/.vegastack/dashboard/0.19.0')
  expect(paths.entry).toBe(join(paths.root, 'node_modules', '@vegastack/vegafactory-dashboard', SERVER_ENTRY))
  expect(dashboardSpec('0.19.0')).toBe('@vegastack/vegafactory-dashboard@0.19.0')
  expect(installArgs({ root: '/r', version: '0.19.0' }))
    .toEqual(['install', '--prefix', '/r', dashboardSpec('0.19.0'), '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts'])
  expect(planDashboard({ entryExists: false, source: 'cache', dryRun: false }).action).toBe('fetch-then-launch')
  expect(planDashboard({ entryExists: true, source: 'cache', dryRun: false }).action).toBe('launch')
  expect(planDashboard({ entryExists: false, source: 'cache', dryRun: true }).action).toBe('plan')
  expect(dashboardPaths({ home: '/home/mk', version: '0.19.0', override: '/repo/packages/dashboard' }).entry)
    .toBe(join('/repo/packages/dashboard', SERVER_ENTRY))
  expect(planDashboard({ entryExists: false, source: 'override', dryRun: false })).toEqual({
    action: 'refuse',
    reason: 'the --dir tree has no dist-standalone/packages/dashboard/server.js; run bun run build && bun run assemble in it first',
  })
})

test('the launch environment is exactly the server contract, on the loopback interface', () => {
  expect(Object.keys(launchEnv({ env: base })).sort()).toEqual([
    'HOSTNAME', 'PORT', 'VEGAFACTORY_BIN', 'VEGAFACTORY_CACHE', 'VEGAFACTORY_CACHE_SCHEMA', 'VEGAFACTORY_CONTROL_ROOM',
    'VEGAFACTORY_GH_TOKEN', 'VEGAFACTORY_INSTANCE_ID', 'VEGAFACTORY_ORG', 'VEGAFACTORY_REPOS', 'VEGAFACTORY_STATE', 'VEGAFACTORY_VERSION', 'VEGAFACTORY_VIEWER',
  ])
  expect(launchEnv({ env: base })).toMatchObject({ HOSTNAME: '127.0.0.1', PORT: '7777', VEGAFACTORY_GH_TOKEN: 'gho_x' })
  const partial = launchEnv({ env: { ...base, viewer: null, token: null } })
  expect(partial.VEGAFACTORY_REPOS).toBe('vegastack/vegafactory')
  expect(partial).not.toHaveProperty('VEGAFACTORY_VIEWER')
  expect(partial).not.toHaveProperty('VEGAFACTORY_GH_TOKEN')
  expect(portCandidates(7777, 3)).toEqual([7777, 7778, 7779])
})

test('organization selection is explicit only when ambiguous and repository registrations stay scoped', () => {
  expect(selectDashboardOrg(['vegastack'], null)).toBe('vegastack')
  expect(selectDashboardOrg(['vegastack', 'acme'], 'acme')).toBe('acme')
  expect(() => selectDashboardOrg(['vegastack', 'acme'], null)).toThrow('--org')
  expect(() => selectDashboardOrg(['vegastack'], 'acme')).toThrow('--org')
  expect(() => selectDashboardOrg(['VegaStack'], null)).toThrow('canonical')
  const rows = [
    { repo: 'vegastack/site', org: 'vegastack', path: '/code/site' },
    { repo: 'acme/app', org: 'acme', path: '/code/app' },
    { repo: 'vegastack/vegafactory', org: 'vegastack', path: '/code/factory' },
  ]
  expect(dashboardRepositories(rows, 'vegastack')).toEqual(['vegastack/site', 'vegastack/vegafactory'])
  expect(dashboardRepositories([], 'vegastack')).toEqual([])
  expect(() => dashboardRepositories([{ repo: 'acme/app', org: 'vegastack', path: '/code/app' }], 'vegastack')).toThrow('does not belong')
  expect(() => dashboardRepositories([{ repo: 'vegastack/app', org: 'vegastack', path: 'relative' }], 'vegastack')).toThrow('registration')
  expect(dashboardCacheNamespace('/home/mk', 'vegastack')).toBe(join('/home/mk/.vegastack/dashboard', createHash('sha256').update('vegastack').digest('hex'), 'cache-v2'))
})

const identity: DashboardIdentity = { org: 'vegastack', version: '1.0.0', instanceId: base.instanceId, cacheSchema: 2 }
test('readiness requires the exact living-child identity and an honest data state', () => {
  expect(matchesReadiness({ ok: true, ...identity, dataState: 'empty', sourceAgeSeconds: null }, identity)).toBe(true)
  expect(matchesReadiness({ ok: true, ...identity, dataState: 'ready', sourceAgeSeconds: 0 }, identity)).toBe(true)
  for (const changed of [
    { instanceId: crypto.randomUUID() }, { org: 'acme' }, { version: '1.0.1' }, { cacheSchema: 1 },
    { dataState: 'loading' }, { sourceAgeSeconds: -1 }, { sourceAgeSeconds: Number.NaN },
  ]) expect(matchesReadiness({ ok: true, ...identity, dataState: 'ready', sourceAgeSeconds: 1, ...changed }, identity)).toBe(false)
  expect(matchesReadiness({ ok: true, ...identity }, identity)).toBe(false)
})

interface ArchiveEntry { path: string; data?: string; type?: string; mode?: number }
function archive(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const bytes = Buffer.from(entry.data ?? '')
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 100)
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156)
    header.write(entry.type ?? '0', 156)
    header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

const artifactEntries = [
  { path: 'package/package.json', data: JSON.stringify({ name: '@vegastack/vegafactory-dashboard', version: '1.0.0' }) },
  { path: `package/${SERVER_ENTRY}`, data: 'console.log("server")\n', mode: 0o755 },
  { path: 'package/LICENSE', data: 'license\n' },
]
function artifactFixture(entries: ArchiveEntry[] = artifactEntries): { bytes: Buffer; descriptor: DashboardArtifactDescriptor } {
  const bytes = archive(entries)
  const files = entries.filter(entry => !entry.type || entry.type === '0').map(entry => {
    const data = Buffer.from(entry.data ?? '')
    return { path: entry.path.slice('package/'.length), sha256: createHash('sha256').update(data).digest('hex'), mode: entry.mode ?? 0o644 }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { bytes, descriptor: { schemaVersion: 1, name: '@vegastack/vegafactory-dashboard', version: '1.0.0',
    sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, bytes: bytes.length, files } }
}

test('the bundled descriptor binds exact archive bytes, package identity, paths, modes and schema', () => {
  const { bytes, descriptor } = artifactFixture()
  expect(verifyDashboardArtifact(bytes, descriptor).map(({ path, mode }) => ({ path, mode }))).toEqual(descriptor.files.map(({ path, mode }) => ({ path, mode })))
  expect(validateDashboardDescriptor(descriptor, '1.0.0')).toEqual(descriptor)
  expect(() => validateDashboardDescriptor({ ...descriptor, extra: true }, '1.0.0')).toThrow('malformed')
  expect(() => validateDashboardDescriptor({ ...descriptor, files: descriptor.files.map((file, index) => index ? file : { ...file, extra: true }) }, '1.0.0')).toThrow('manifest')
  expect(() => verifyDashboardArtifact(Buffer.concat([bytes, Buffer.from('changed')]), descriptor)).toThrow('integrity')
  const replacement = artifactFixture(artifactEntries.map(entry => entry.path.endsWith(SERVER_ENTRY) ? { ...entry, data: 'changed' } : entry))
  expect(() => verifyDashboardArtifact(replacement.bytes, descriptor)).toThrow('integrity')
  for (const entries of [
    [{ path: '/package/a' }], [{ path: 'package/../a' }], [{ path: 'package/a' }, { path: 'package/a' }],
    [{ path: 'package/a', type: '1' }], [{ path: 'package/a', type: '2' }], [{ path: 'package/a', type: '3' }],
  ]) {
    const attack = archive(entries)
    const attackDescriptor = { ...descriptor, bytes: attack.length, sha256: createHash('sha256').update(attack).digest('hex'), integrity: `sha512-${createHash('sha512').update(attack).digest('base64')}` }
    expect(() => verifyDashboardArtifact(attack, attackDescriptor)).toThrow()
  }
})

test('descriptor-verified installation stages once, publishes atomically and revalidates every launch', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-install-')))
  const root = join(home, '.vegastack/dashboard/1.0.0')
  const { bytes, descriptor } = artifactFixture()
  let downloads = 0
  try {
    const results = await Promise.all([
      installDashboardArtifact(root, descriptor, async () => { downloads++; await Bun.sleep(40); return bytes }),
      installDashboardArtifact(root, descriptor, async () => { downloads++; return bytes }),
    ])
    expect(results.sort()).toEqual([false, true])
    expect(downloads).toBe(1)
    expect(await readFile(join(root, 'dashboard-install.json'), 'utf8')).toBe(dashboardInstallReceipt(descriptor))
    expect(JSON.parse(await readFile(join(root, 'dashboard-install.json'), 'utf8'))).toEqual({
      schemaVersion: 1, owner: 'vegafactory-dashboard', version: '1.0.0', descriptorSha256: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
    })
    await verifyDashboardTree(join(root, 'node_modules/@vegastack/vegafactory-dashboard'), descriptor)
    const server = join(root, 'node_modules/@vegastack/vegafactory-dashboard', SERVER_ENTRY)
    await writeFile(server, 'changed')
    await expect(installDashboardArtifact(root, descriptor, async () => bytes)).rejects.toThrow('integrity')
    expect(await readFile(server, 'utf8')).toBe('changed')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('tree verification refuses unexpected files, links, hard links and changed modes', async () => {
  const { bytes, descriptor } = artifactFixture()
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-tree-')))
  const root = join(home, 'versions/1.0.0'), packageRoot = join(root, 'node_modules/@vegastack/vegafactory-dashboard')
  const reset = async () => { await rm(root, { recursive: true, force: true }); await installDashboardArtifact(root, descriptor, async () => bytes) }
  try {
    await reset(); await writeFile(join(packageRoot, 'extra'), 'extra'); await expect(verifyDashboardTree(packageRoot, descriptor)).rejects.toThrow('file/type/mode')
    await reset(); await chmod(join(packageRoot, 'LICENSE'), 0o755); await expect(verifyDashboardTree(packageRoot, descriptor)).rejects.toThrow('mode')
    await reset(); await rm(join(packageRoot, 'LICENSE')); await symlink('package.json', join(packageRoot, 'LICENSE')); await expect(verifyDashboardTree(packageRoot, descriptor)).rejects.toThrow('link')
    await reset(); await rm(join(packageRoot, 'LICENSE')); await link(join(packageRoot, 'package.json'), join(packageRoot, 'LICENSE')); await expect(verifyDashboardTree(packageRoot, descriptor)).rejects.toThrow('mode')
    const alias = join(home, 'alias'); await symlink(join(home, 'versions'), alias)
    await expect(verifyDashboardTree(join(alias, '1.0.0/node_modules/@vegastack/vegafactory-dashboard'), descriptor)).rejects.toThrow('link')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a failed install never selects partial bytes and preserves unrelated interrupted staging', async () => {
  const { descriptor } = artifactFixture()
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-failed-install-')))
  const root = join(home, 'versions/1.0.0'), oldStaging = `${root}.staging-preserved`
  try {
    await mkdir(dirname(root), { mode: 0o755 }); await mkdir(oldStaging, { mode: 0o700 }); await writeFile(join(oldStaging, 'evidence'), 'preserved')
    await expect(installDashboardArtifact(root, descriptor, async () => { throw Error('download interrupted') })).rejects.toThrow('interrupted')
    await expect(lstat(root)).rejects.toThrow()
    expect(await readFile(join(oldStaging, 'evidence'), 'utf8')).toBe('preserved')
    expect((await readdir(dirname(root))).filter(name => name.startsWith('1.0.0.staging-'))).toEqual(['1.0.0.staging-preserved'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('readiness rejects an unrelated response and observes the intended child lose the port race', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-child-')))
  const entry = join(home, 'server.ts')
  const unrelated = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true, ...identity, instanceId: crypto.randomUUID(), dataState: 'empty', sourceAgeSeconds: null }) })
  const occupiedPort = unrelated.port!
  try {
    await writeFile(entry, `const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>Response.json({ok:true,org:process.env.VEGAFACTORY_ORG,version:process.env.VEGAFACTORY_VERSION,instanceId:process.env.VEGAFACTORY_INSTANCE_ID,cacheSchema:2,dataState:'empty',sourceAgeSeconds:null})});process.on('SIGTERM',()=>{server.stop(true);process.exit(0)})`)
    const child = launchDashboardChild(entry, { ...process.env, PORT: String(occupiedPort), VEGAFACTORY_ORG: identity.org, VEGAFACTORY_VERSION: identity.version, VEGAFACTORY_INSTANCE_ID: identity.instanceId })
    expect(await waitDashboardChild(child, identity, occupiedPort, Date.now() + 3000)).toBe(false)
    expect(await child.finished).not.toBe(0)
    expect(await stopDashboardChild(child)).toBe(true)
  } finally { unrelated.stop(true); await rm(home, { recursive: true, force: true }) }
})

test('readiness accepts the exact owned child and bounded cleanup removes its process group', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-owned-child-')))
  const entry = join(home, 'server.ts')
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const port = reservation.port!
  reservation.stop(true)
  const expected = { ...identity, instanceId: crypto.randomUUID() }
  try {
    await writeFile(entry, `const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>Response.json({ok:true,org:process.env.VEGAFACTORY_ORG,version:process.env.VEGAFACTORY_VERSION,instanceId:process.env.VEGAFACTORY_INSTANCE_ID,cacheSchema:2,dataState:'unavailable',sourceAgeSeconds:null})});process.on('SIGTERM',()=>{server.stop(true);process.exit(0)})`)
    const child = launchDashboardChild(entry, { ...process.env, PORT: String(port), VEGAFACTORY_ORG: expected.org, VEGAFACTORY_VERSION: expected.version, VEGAFACTORY_INSTANCE_ID: expected.instanceId })
    expect(await waitDashboardChild(child, expected, port, Date.now() + 5000)).toBe(true)
    expect(await stopDashboardChild(child)).toBe(true)
    expect(child.exited).toBe(true)
  } finally { await rm(home, { recursive: true, force: true }) }
})

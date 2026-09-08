import { basename, dirname, isAbsolute, join, resolve, parse } from 'node:path'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseControlRoomReference, parsePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'

export interface ControlRoomKnob {
  org: string
  repo: string
  group: string | null
  sha: string | null
}

export interface ControlRoomEntry {
  repo: string
  path: string
  branch: string
  remote?: string
  lastSyncedAt: string | null
  sha: string | null
  snapshots?: Record<string, PolicySnapshot>
  history?: Record<string, PolicySnapshot>[]
  [key: string]: unknown
}

export interface FactoryConfig {
  schemaVersion: 1 | 2
  revision?: number
  controlRooms: Record<string, ControlRoomEntry>
  // Everything else the document carries — the dispatcher's `repos`, `interval`, `maxRuns` and
  // `subagents` live in this same file and are hand-written by the operator. Sync reads none of
  // them and must give all of them back untouched: a rewrite that keeps only what it understands
  // would silently delete the dispatcher's configuration on the next refresh.
  settings: Record<string, unknown>
}

const DEFAULT_MAX_AGE_MINUTES = 30

// `control-room: <org>/<repo>#<group>@<sha7>` — group and sha are both optional, and the value
// stops at the first whitespace so the trailing `# comment` every knob line carries is ignored.
export function parseControlRoomKnob(devMdText: string): ControlRoomKnob | null {
  return parseControlRoomReference(devMdText)
}

// Freshness is a duration, not a timestamp: `<n>m` or `<n>h`. Anything unparseable falls back to
// the default rather than disabling the refresh, because a typo must not silently freeze a clone.
export function parseSyncMaxAge(devMdText: string): number {
  const seconds = (parsePolicy(devMdText, 'repo').values as Record<string, unknown>)['sync-max-age']
  return typeof seconds === 'number' ? seconds / 60 : DEFAULT_MAX_AGE_MINUTES
}

export function defaultClonePath(org: string, home: string): string {
  return join(home, '.vegastack', 'control-room', org)
}

export function factoryConfigPath(home: string): string {
  return join(home, '.vegastack', 'factory.json')
}

// A missing state file is an empty config — the first sync writes it. An unreadable one throws:
// silently resetting it would drop every other org's clone record and re-clone the world.
export function readFactoryConfig(text: string | null): FactoryConfig {
  if (text === null || text === undefined || text.trim() === '') return { schemaVersion: 1, controlRooms: {}, settings: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('~/.vegastack/factory.json is not valid JSON — fix or delete it')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('factory.json must be an object')
  const document = parsed as Record<string, unknown>
  if (![1, 2].includes(document.schemaVersion as number)) throw new Error('factory.json: unsupported settings schema')
  if (document.schemaVersion === 2 && (!Number.isSafeInteger(document.revision) || Number(document.revision) < 0)) throw new Error('factory.json: invalid revision')
  if (document.controlRooms !== undefined && (!document.controlRooms || typeof document.controlRooms !== 'object' || Array.isArray(document.controlRooms))) throw new Error('factory.json: invalid controlRooms')
  const controlRooms: Record<string, ControlRoomEntry> = {}
  const raw = (parsed as { controlRooms?: unknown } | null)?.controlRooms
  if (raw && typeof raw === 'object') {
    for (const [org, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) controlRooms[org] = entry as ControlRoomEntry
    }
  }
  const settings: Record<string, unknown> = {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key !== 'schemaVersion' && key !== 'controlRooms' && key !== 'revision') settings[key] = value
    }
  }
  return { schemaVersion: document.schemaVersion as 1 | 2, ...(document.schemaVersion === 2 ? { revision: document.revision as number } : {}), controlRooms, settings }
}

export function withSyncResult(config: FactoryConfig, org: string, entry: ControlRoomEntry): FactoryConfig {
  return { ...config, controlRooms: { ...config.controlRooms, [org]: entry } }
}

// What actually lands on disk: the settings this file understood nothing about come back as
// top-level keys, exactly where the operator wrote them.
export function serializeFactoryConfig(config: FactoryConfig): Record<string, unknown> {
  return { ...config.settings, schemaVersion: config.schemaVersion, ...(config.schemaVersion === 2 ? { revision: config.revision } : {}), controlRooms: config.controlRooms }
}

// Age is measured from the last successful fetch, never from the clone directory's mtime: a fetch
// that finds nothing new leaves mtime untouched, so an unchanged control room would look
// permanently stale and re-fetch on every session.
export function ageMinutes(lastSyncedAt: string | null, now: number): number | null {
  if (!lastSyncedAt) return null
  const at = Date.parse(lastSyncedAt)
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now) return null
  return Math.floor((now - at) / 60_000)
}

export function isStale(lastSyncedAt: string | null, now: number, maxAgeMinutes: number): boolean {
  const age = ageMinutes(lastSyncedAt, now)
  if (age === null) return true
  return age >= maxAgeMinutes
}

export interface PolicySnapshot {
  schemaVersion: 2
  org: string
  group: string | null
  repository: string
  origin: string
  sourceCommit: string
  policyDigest: string
  validatedAt: string
  contentPath: string
}

// orgs is only the callback projection of controlRooms. Unknown wire keys, including an
// extension named orgs, remain in settings. factory.json is the single durable authority.
export interface SettingsV2 {
  schemaVersion: 2
  revision: number
  orgs: Record<string, ControlRoomEntry>
  settings: Record<string, unknown>
}

export function snapshotFreshness(validatedAt: string, now: number, maxAgeSeconds: number): 'fresh' | 'stale' | 'unavailable' {
  const at = Date.parse(validatedAt)
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return 'unavailable'
  return now - at >= maxAgeSeconds * 1000 ? 'stale' : 'fresh'
}

export async function assertSafeLocalPath(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('settings/content path must be canonical and absolute')
  let cursor = parse(path).root
  for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part)
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info?.isSymbolicLink()) throw new Error(`refusing symlink path: ${cursor}`)
  }
}

async function syncDirectory(path: string) {
  const dir = await open(path, 'r')
  try { await dir.sync() } finally { await dir.close() }
}

export async function readSettingsFile(path: string): Promise<FactoryConfig> {
  await assertSafeLocalPath(path)
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  return readFactoryConfig(text)
}

export async function updateSettings(root: string, mutate: (settings: SettingsV2) => SettingsV2 | Promise<SettingsV2>): Promise<SettingsV2> {
  return updateSettingsAtPath(join(root, 'factory.json'), mutate)
}

// Long network work happens outside this guard. Never steal it from an unknown/dead owner:
// interrupted ownership requires offline inspection; elapsed time is not ownership proof.
export async function updateSettingsAtPath(path: string, mutate: (settings: SettingsV2) => SettingsV2 | Promise<SettingsV2>): Promise<SettingsV2> {
  await assertSafeLocalPath(path)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const guard = path + '.guard', token = randomUUID(), deadline = Date.now() + 2000
  for (;;) {
    try { await mkdir(guard, { mode: 0o700 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await assertSafeLocalPath(guard)
      if (Date.now() >= deadline) throw new Error(`settings guard busy or incomplete: ${guard}; offline recovery required`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  let owned = false
  const temporary = join(dirname(path), `.${basename(path)}.${token}.tmp`)
  try {
    const owner = await open(join(guard, 'owner.json'), 'wx', 0o600)
    try { await owner.writeFile(JSON.stringify({ token, pid: process.pid })); await owner.sync() } finally { await owner.close() }
    await syncDirectory(guard); owned = true
    const beforeText = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    const before = readFactoryConfig(beforeText)
    const next = await mutate(structuredClone({ schemaVersion: 2, revision: before.revision ?? 0, orgs: before.controlRooms, settings: before.settings }))
    if (!next || next.schemaVersion !== 2 || !next.orgs || typeof next.orgs !== 'object' || Array.isArray(next.orgs) || !next.settings || typeof next.settings !== 'object' || Array.isArray(next.settings)) throw new Error('invalid settings mutation')
    const committed: SettingsV2 = structuredClone({ ...next, revision: (before.revision ?? 0) + 1 })
    const wire = serializeFactoryConfig({ schemaVersion: 2, revision: committed.revision, controlRooms: committed.orgs, settings: committed.settings })
    readFactoryConfig(JSON.stringify(wire))
    // Preserve the original schema1 bytes; failed semantic validation above never migrates.
    if (beforeText !== null && before.schemaVersion === 1) {
      const backup = await open(path + '.schema1.bak', 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') return null; throw error })
      if (backup) { try { await backup.writeFile(beforeText); await backup.sync() } finally { await backup.close() } }
    }
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(wire, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    // Detect participating-independent manual edits made during the callback. A text editor
    // bypassing this guard cannot be given an atomic compare-and-swap guarantee.
    const currentText = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (currentText !== beforeText) throw new Error('settings changed outside the transaction; refusing overwrite')
    await rename(temporary, path); await syncDirectory(dirname(path))
    return structuredClone(committed)
  } finally {
    await rm(temporary, { force: true })
    if (owned) {
      const owner = JSON.parse(await readFile(join(guard, 'owner.json'), 'utf8'))
      if (owner.token === token) { await rm(guard, { recursive: true }); await syncDirectory(dirname(path)) }
    }
  }
}

export { loadSnapshotPolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { loadSnapshotPolicy, resolvePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'

// The exact configured path is used by services as well as interactive CLI readers.
export function loadConfiguredPolicy(input: { home: string; repo: string; devMd: string; now?: string | number; settingsPath?: string }) {
  const room = parseControlRoomKnob(input.devMd)
  if (!room) return resolvePolicy({ repo: input.devMd, identity: { repo: input.repo }, freshness: { configured: false, now: input.now ?? Date.now() } })
  let entry: ControlRoomEntry | undefined
  try { entry = readFactoryConfig(readFileSync(input.settingsPath ?? factoryConfigPath(input.home), 'utf8')).controlRooms[room.org] } catch { /* Unavailable, never defaults. */ }
  return loadSnapshotPolicy({ snapshot: entry?.snapshots?.[input.repo], repo: input.repo, devMd: input.devMd, expectedOrigin: entry?.remote, now: input.now })
}
import { readFileSync } from 'node:fs'

export async function getPolicySnapshot(org: string, repo: string, now: number, context: { settingsPath: string; devMd: string }) {
  const config = await readSettingsFile(context.settingsPath)
  const entry = config.controlRooms[org], snapshot = entry?.snapshots?.[repo]
  const resolved = loadSnapshotPolicy({ snapshot, repo, devMd: context.devMd, expectedOrigin: entry?.remote, now })
  const bootstrap = config.settings.machine as { id?: string; installationId?: string; hostBindingDigest?: string; group?: string } | undefined
  const registration = bootstrap ? resolved.policy.fleet?.machines?.[bootstrap.id ?? ''] : null
  const machineReason = !bootstrap ? null : !registration ? 'machine is not enrolled' : !registration.enabled ? 'machine enrollment is disabled'
    : registration.installationId !== bootstrap.installationId || registration.hostBindingDigest !== bootstrap.hostBindingDigest || registration.group !== bootstrap.group ? 'machine bootstrap and registration disagree' : null
  const machine = bootstrap ? { id: bootstrap.id ?? null, state: machineReason ? 'unavailable' : 'configured', reason: machineReason,
    executionIdentityVerified: false, sourceCommit: snapshot?.sourceCommit ?? null,
    configuration: registration ? { ...registration, defaults: { ...resolved.policy.fleet.defaults, ...resolved.policy.fleet.groupDefaults?.[registration.group], ...registration.overrides } } : null } : null
  return {
    state: machineReason ? 'unavailable' : resolved.ok ? 'fresh' : resolved.policy.freshness.state === 'stale' && resolved.blocks.every((block: string) => block.startsWith('mandatory policy stale:')) ? 'stale' : 'unavailable',
    snapshot: snapshot ?? null, ageSeconds: resolved.policy.freshness.ageSeconds,
    reason: machineReason ?? (resolved.ok ? null : resolved.blocks.join('; ')), policy: resolved, machine,
  }
}

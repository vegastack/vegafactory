import { basename, dirname, isAbsolute, join, resolve, parse as parsePath, sep } from 'node:path'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseControlRoomReference, resolvePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { controlRoomClonePath, controlRoomStore, factoryConfigPath as configPath } from './home.ts'

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
  [key: string]: unknown
}

export interface FactoryConfig {
  schemaVersion: 2
  revision: number
  controlRooms: Record<string, ControlRoomEntry>
  // Everything else the document carries — the worker's `repos`, `interval`, `maxRuns` and
  // `subagents` live in this same file and are hand-written by the operator. Sync reads none of
  // them and must give all of them back untouched: a rewrite that keeps only what it understands
  // would silently delete the worker's configuration on the next refresh.
  settings: Record<string, unknown>
}

// `control-room: <org>/<repo>#<group>@<sha7>` — group and sha are both optional, and the value
// stops at the first whitespace so the trailing `# comment` every knob line carries is ignored.
export function parseControlRoomKnob(devMdText: string): ControlRoomKnob | null {
  return parseControlRoomReference(devMdText)
}

// These three are one fact spelled three ways, so they come from one place: `safeClonePath`
// contains what `defaultClonePath` produces, and a skew between them fails every control-room read
// closed rather than loudly.
export function defaultClonePath(org: string, home: string): string {
  return controlRoomClonePath(org, { home })
}

export function factoryConfigPath(home: string): string {
  return configPath({ home })
}

// A missing state file is an empty config — the first sync writes it. An unreadable one throws:
// silently resetting it would drop every other org's clone record and re-clone the world.
export function readFactoryConfig(text: string | null): FactoryConfig {
  if (text === null || text === undefined || text.trim() === '') return { schemaVersion: 2, revision: 0, controlRooms: {}, settings: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${configPath()} is not valid JSON — fix or delete it`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('factory.json must be an object')
  const document = parsed as Record<string, unknown>
  // One schema, and only one. A file written by anything else is not migrated and not guessed at:
  // it is the operator's own settings, and rewriting them on a version number would lose whatever
  // the newer or older writer meant by them.
  if (document.schemaVersion !== 2) throw new Error(`factory.json: unsupported settings schema ${JSON.stringify(document.schemaVersion)} — this build reads schema 2`)
  if (!Number.isSafeInteger(document.revision) || Number(document.revision) < 0) throw new Error('factory.json: invalid revision')
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
  return { schemaVersion: 2, revision: document.revision as number, controlRooms, settings }
}

export function withSyncResult(config: FactoryConfig, org: string, entry: ControlRoomEntry): FactoryConfig {
  return { ...config, controlRooms: { ...config.controlRooms, [org]: entry } }
}

// What actually lands on disk: the settings this file understood nothing about come back as
// top-level keys, exactly where the operator wrote them.
export function serializeFactoryConfig(config: FactoryConfig): Record<string, unknown> {
  return { ...config.settings, schemaVersion: 2, revision: config.revision, controlRooms: config.controlRooms }
}

// How stale the local copy of the control room may be before a session refreshes it.
export const MAX_AGE_MINUTES = 5

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

// orgs is only the callback projection of controlRooms. Unknown wire keys, including an
// extension named orgs, remain in settings. factory.json is the single durable authority.
export interface SettingsV2 {
  schemaVersion: 2
  revision: number
  orgs: Record<string, ControlRoomEntry>
  settings: Record<string, unknown>
}

export async function assertSafeLocalPath(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('settings/content path must be canonical and absolute')
  let cursor = parsePath(path).root
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
export interface SettingsError extends Error {
  // True when the new settings were already renamed into place before the failure. A caller that
  // rolls its own work back on a failure has to know: rolling back after a successful publication
  // is the very split the rollback exists to prevent.
  published?: boolean
}

export function publishedAlready(error: unknown): boolean {
  return (error as SettingsError | null)?.published === true
}

export async function updateSettingsAtPath(path: string, mutate: (settings: SettingsV2) => SettingsV2 | Promise<SettingsV2>): Promise<SettingsV2> {
  let published = false
  try {
    return await publishSettings(path, mutate, () => { published = true })
  } catch (error) {
    if (error instanceof Error) (error as SettingsError).published = published
    throw error
  }
}

async function publishSettings(path: string, mutate: (settings: SettingsV2) => SettingsV2 | Promise<SettingsV2>, onPublished: () => void): Promise<SettingsV2> {
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
    const next = await mutate(structuredClone({ schemaVersion: 2, revision: before.revision, orgs: before.controlRooms, settings: before.settings }))
    if (!next || next.schemaVersion !== 2 || !next.orgs || typeof next.orgs !== 'object' || Array.isArray(next.orgs) || !next.settings || typeof next.settings !== 'object' || Array.isArray(next.settings)) throw new Error('invalid settings mutation')
    const committed: SettingsV2 = structuredClone({ ...next, revision: before.revision + 1 })
    const wire = serializeFactoryConfig({ schemaVersion: 2, revision: committed.revision, controlRooms: committed.orgs, settings: committed.settings })
    readFactoryConfig(JSON.stringify(wire))
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(wire, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    // Detect participating-independent manual edits made during the callback. A text editor
    // bypassing this guard cannot be given an atomic compare-and-swap guarantee.
    const currentText = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (currentText !== beforeText) throw new Error('settings changed outside the transaction; refusing overwrite')
    await rename(temporary, path); onPublished(); await syncDirectory(dirname(path))
    return structuredClone(committed)
  } finally {
    await rm(temporary, { force: true })
    if (owned) {
      const owner = JSON.parse(await readFile(join(guard, 'owner.json'), 'utf8'))
      if (owner.token === token) { await rm(guard, { recursive: true }); await syncDirectory(dirname(path)) }
    }
  }
}


// Every component of a path is judged by lstat, never followed.
function realPathTo(path: string, from: string): string | null {
  let cursor = from
  for (const part of path.slice(from.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    let info
    try { info = lstatSync(cursor) } catch { return `nothing at ${cursor}` }
    if (info.isSymbolicLink()) return `refusing a symlinked path: ${cursor}`
  }
  return null
}

// A control-room clone is only ever read or written where sync puts it: a canonical absolute path
// inside this machine's control-room store, with no symlink anywhere along it. Returns the reason
// it is not usable, or null when it is.
export function safeClonePath(home: string, path: unknown): string | null {
  const store = controlRoomStore({ home })
  if (typeof path !== 'string' || !path || !isAbsolute(path) || resolve(path) !== path) return 'the control-room path is not absolute and canonical'
  if (path !== store && !path.startsWith(store + sep)) return `the control-room clone is outside ${store}`
  const walked = realPathTo(path, parsePath(path).root)
  if (walked) return walked.startsWith('nothing at') ? `no control-room clone at ${path}` : walked
  return null
}

export interface Profile {
  ok: boolean
  values: Record<string, unknown>
  locked: string[]
  sources: Record<string, string>
  blocks: string[]
  room: ControlRoomKnob | null
  clonePath: string | null
  sha: string | null
  lastSyncedAt: string | null
  stale: boolean
}

export const SHA = /^[a-f0-9]{40}$/

// Replacement objects are a per-repository redirect: one hand-written entry under `refs/replace`
// makes `cat-file` hand back different bytes for a commit or a blob while every identity check
// still passes. Nothing this tool does wants them, so they are off for every read and every
// mutating command, by flag and by environment, in this file and in sync.
export const GIT_NO_REPLACE: readonly string[] = ['--no-replace-objects']
export const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' })
const git = (cwd: string, args: string[]) =>
  execFileSync('git', [...GIT_NO_REPLACE, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: gitEnv() })

// The copy must hold its own repository, in the ordinary place, with its worktree where it stands.
// A symlinked `.git`, a `.git` file pointing elsewhere, a separate common directory or a
// `core.worktree` redirect all move git's reads and writes outside the store the other checks
// cover — the metadata is as much a part of the copy as the files are.
export function repositoryReason(path: string): string | null {
  const dot = join(path, '.git')
  let info
  try { info = lstatSync(dot) } catch { return `no Git repository at ${path}` }
  if (info.isSymbolicLink()) return `refusing a symlinked .git at ${dot}`
  if (!info.isDirectory()) return `refusing a .git file at ${dot}; the copy must hold its own repository`
  try {
    // git answers these with the resolved path, so the comparison is made on resolved paths too.
    // That is not a hole: `safeClonePath` has already refused every symlinked component of the
    // copy's own path, so here the two spellings can only differ above the store.
    const real = realpathSync(path), realDot = join(real, '.git')
    if (git(path, ['rev-parse', '--absolute-git-dir']).trim() !== realDot) return `the copy keeps its Git metadata outside ${dot}`
    if (resolve(real, git(path, ['rev-parse', '--git-common-dir']).trim()) !== realDot) return `the copy shares its Git metadata with another repository`
    if (git(path, ['rev-parse', '--show-toplevel']).trim() !== real) return `the copy's worktree is not ${path}`
  } catch (error) { return `the repository at ${path} could not be read (${(error as Error).message.split('\n')[0]})` }
  return null
}

// One holder at a time per org, shared by every command that touches that org's copy: sync fetches
// and checks out, `stats push` commits and pushes, and both move the recorded commit. The lock is
// never stolen from an owner that looks old — an interrupted run is a human's to inspect.
export function orgLockPath(clonePath: string): string {
  return clonePath + '.lock'
}

export async function lockOrg(clonePath: string, waitMs = 120_000): Promise<() => Promise<void>> {
  const lock = orgLockPath(clonePath)
  await assertSafeLocalPath(lock)
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error(`another run is using ${clonePath}; wait for it to finish, or remove ${lock}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  return async () => { await rm(lock, { recursive: true, force: true }) }
}

// The same lock from synchronous code. It waits a few seconds rather than two minutes: the caller
// is an hourly best-effort push, and a push that skips one hour costs nothing.
export function lockOrgSync(clonePath: string, waitMs = 5_000): (() => void) | null {
  const lock = orgLockPath(clonePath)
  const deadline = Date.now() + waitMs
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) return null
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  return () => { rmSync(lock, { recursive: true, force: true }) }
}

// A command that moved the copy records where it left it, through the same guarded file every
// other writer uses. Anything that advances the checkout must call this, or the next read finds a
// commit the record does not know and refuses a copy that is perfectly good.
export function recordOrgSha(settingsPath: string, org: string, sha: string): void {
  if (!SHA.test(sha)) throw new Error('a recorded commit must be a full SHA')
  const guard = settingsPath + '.guard'
  mkdirSync(guard, { mode: 0o700 })
  try {
    const config = readFactoryConfig(readFileSync(settingsPath, 'utf8'))
    const entry = config.controlRooms[org]
    if (!entry) throw new Error(`${org}'s control room is not linked on this machine`)
    const next = { ...config, controlRooms: { ...config.controlRooms, [org]: { ...entry, sha } } }
    const temporary = `${settingsPath}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(serializeFactoryConfig(next), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, settingsPath)
  } finally { rmSync(guard, { recursive: true, force: true }) }
}

// The copy `sync` left, or the reason it cannot be read. Everything recorded in factory.json is
// treated as a claim to check, never as a fact: the path must be the one path this org's copy may
// live at, the recorded repository must be the one the profile names, and the working tree must
// still be the exact commit sync validated, on the recorded branch and origin, with nothing
// changed. Another org's copy, a wrong-origin copy, the leftovers of a failed sync and a hand-edit
// all fail one of those, and a copy that fails any of them is not policy.
function verifiedRoom(home: string, room: ControlRoomKnob, entry: ControlRoomEntry | undefined): { path: string | null; sha: string | null; reason: string | null } {
  const refuse = (reason: string) => ({ path: null, sha: null, reason: `${reason} — run: vegafactory sync` })
  const path = defaultClonePath(room.org, home)
  if (!entry) return refuse('this machine has no copy of the control room')
  if (entry.path !== path) return refuse(`the recorded copy is not at ${path}`)
  if (entry.repo !== room.repo) return refuse(`the recorded copy is ${entry.repo}, not the ${room.repo} this profile names`)
  if (!SHA.test(entry.sha ?? '')) return refuse('the recorded copy has no validated commit')
  // No recorded remote means nothing to hold the origin to, and the schema still allows the field
  // to be missing — so an entry without one is unverifiable rather than unverified.
  if (typeof entry.remote !== 'string' || !entry.remote.trim()) return refuse('the recorded copy names no origin')
  if (typeof entry.branch !== 'string' || !entry.branch.trim()) return refuse('the recorded copy names no branch')
  const unsafe = safeClonePath(home, path)
  if (unsafe) return refuse(unsafe)
  const notARepository = repositoryReason(path)
  if (notARepository) return refuse(notARepository)
  try {
    if (git(path, ['rev-parse', 'HEAD']).trim() !== entry.sha) return refuse('the copy has moved off the commit sync recorded')
    if (git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() !== entry.branch) return refuse(`the copy is not on ${entry.branch}`)
    if (git(path, ['remote', 'get-url', 'origin']).trim() !== entry.remote) return refuse('the copy has a different origin')
    if (git(path, ['status', '--porcelain', '--untracked-files=all']).trim()) return refuse('the copy has local changes')
  } catch (error) { return refuse(`the copy could not be read (${(error as Error).message.split('\n')[0]})`) }
  return { path, sha: entry.sha!, reason: null }
}

// Read one file out of the recorded commit rather than off the disk. A tracked symlink under the
// copy would otherwise send `readFileSync` anywhere on the machine, and only a regular blob in that
// commit is policy — the mode check is what makes the link a refusal instead of a redirect.
function readBlob(path: string, sha: string, relative: string): { text: string; reason: string | null } {
  let listed
  try { listed = git(path, ['ls-tree', '-z', sha, '--', relative]) } catch { return { text: '', reason: `the control room has no ${relative}` } }
  const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t/.exec(listed)
  if (!match || match[2] !== 'blob') return { text: '', reason: `the control room has no ${relative}` }
  if (!['100644', '100755'].includes(match[1]!)) return { text: '', reason: `${relative} is not a regular file in the control room` }
  try { return { text: git(path, ['cat-file', 'blob', match[3]!]), reason: null } }
  catch (error) { return { text: '', reason: `${relative} could not be read (${(error as Error).message.split('\n')[0]})` } }
}

// The profile a repo actually runs on: the org's `org.md`, its group's `group.md`, then the repo's
// own dev.md. The room is read from the copy `sync` keeps, never from the network — a copy that is
// missing, unusable or stale still resolves from what is left, and the caller is told which.
export function loadProfile(input: { home: string; devMd: string; now?: number }): Profile {
  const now = input.now ?? Date.now()
  const blocks: string[] = []
  let room: ControlRoomKnob | null = null
  try { room = parseControlRoomKnob(input.devMd) } catch (error) { blocks.push((error as Error).message) }
  let org = '', group = '', clonePath: string | null = null, sha: string | null = null, lastSyncedAt: string | null = null
  if (room) {
    let entry: ControlRoomEntry | undefined
    try { entry = readFactoryConfig(readFileSync(factoryConfigPath(input.home), 'utf8')).controlRooms[room.org] } catch { /* never synced here */ }
    lastSyncedAt = entry?.lastSyncedAt ?? null
    const verified = verifiedRoom(input.home, room, entry)
    if (verified.reason) blocks.push(verified.reason)
    else {
      clonePath = verified.path; sha = verified.sha
      for (const [relative, into] of [['org.md', 'org'], ...(room.group ? [[`groups/${room.group}/group.md`, 'group']] : [])] as const) {
        const read = readBlob(verified.path!, verified.sha!, relative)
        if (read.reason) blocks.push(read.reason)
        else if (into === 'org') org = read.text
        else group = read.text
      }
    }
  }
  const resolved = resolvePolicy({ org, group, repo: input.devMd })
  return {
    ...resolved, blocks: [...blocks, ...resolved.blocks], ok: resolved.ok && blocks.length === 0,
    room, clonePath, sha, lastSyncedAt, stale: room !== null && isStale(lastSyncedAt, now, MAX_AGE_MINUTES),
  }
}

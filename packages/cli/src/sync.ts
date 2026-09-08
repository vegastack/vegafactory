// Fetch and validate immutable candidates before one canonical settings publication.
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { platform, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import {
  ageMinutes, defaultClonePath, factoryConfigPath, isStale, parseControlRoomKnob,
  assertSafeLocalPath, readSettingsFile, updateSettingsAtPath, loadSnapshotPolicy,
  type ControlRoomEntry, type FactoryConfig, type PolicySnapshot,
} from './control-room.ts'
import { resolveMachinePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'

const run = promisify(execFile)
export const GIT_CREDENTIAL_ARGS: readonly string[] = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
export interface SyncTarget {
  org: string
  repo: string
  group: string | null
  clonePath: string
  branch: string
  remote: string
  recordedSha: string | null
  settingsPath: string
  devMdText: string
  repoPath?: string
  home: string
}
export interface SyncResult {
  ok: boolean
  action: 'clone' | 'refresh' | 'fresh' | 'stale' | 'refused'
  org: string
  path: string
  sha: string | null
  lastSyncedAt: string | null
  ageMinutes: number | null
  message: string
  config: FactoryConfig
}
async function git(args: string[], timeout = 5000) {
  return run('git', args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}
async function exists(path: string) {
  return lstat(path).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error })
}
const canonicalRepo = (remote: string): string | null => {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote)
  return match?.[1] ?? null
}
const profileRepo = (text: string) => /^repo:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\s|$)/m.exec(text)?.[1] ?? null
const fingerprint = (value: unknown) => JSON.stringify(value)
const connection = (entry?: ControlRoomEntry) => entry ? { repo: entry.repo, path: entry.path, branch: entry.branch, remote: entry.remote } : null

export function resolveTarget(input: { devMdText: string; config: FactoryConfig; home: string; org?: string; settingsPath?: string; repoPath?: string }): SyncTarget | null {
  const fromProfile = parseControlRoomKnob(input.devMdText), org = input.org?.trim()
  if (fromProfile && org && fromProfile.org !== org) throw new Error(`--org ${org} disagrees with the profile's control-room: ${fromProfile.repo}`)
  if (org && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) throw new Error('invalid organization')
  const knob = fromProfile ?? (org ? { org, repo: `${org}/vegafactory-control-room`, group: null, sha: null } : null)
  if (!knob) return null
  const entry = input.config.controlRooms[knob.org]
  if (entry && entry.repo !== knob.repo) throw new Error('profile and configured control-room repository disagree')
  const machine = input.config.settings.machine as MachineBootstrap | undefined
  if (machine && (machine.controlRoom?.repo !== knob.repo || machine.group !== knob.group || (entry && (machine.controlRoom.remote !== entry.remote || machine.controlRoom.branch !== entry.branch)))) throw new Error('profile and machine bootstrap disagree')
  return {
    org: knob.org, repo: knob.repo, group: knob.group, clonePath: entry?.path ?? defaultClonePath(knob.org, input.home),
    branch: entry?.branch ?? machine?.controlRoom.branch ?? 'main', remote: entry?.remote ?? machine?.controlRoom.remote ?? `https://github.com/${knob.repo}.git`,
    recordedSha: knob.sha, settingsPath: input.settingsPath ?? factoryConfigPath(input.home), devMdText: input.devMdText, repoPath: input.repoPath, home: input.home,
  }
}

interface MachineBootstrap {
  id: string; installationId: string; hostBindingDigest: string; group: string
  controlRoom: { repositoryId: string; repo: string; remote: string; branch: string }
}
export async function localHostBindingDigest(): Promise<string> {
  let host: string
  if (platform() === 'darwin') {
    const out = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000 })
    host = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out.stdout)?.[1] ?? ''
  } else host = (await readFile('/etc/machine-id', 'utf8')).trim()
  if (!host) throw new Error('cannot verify local host binding')
  return createHash('sha256').update(`${platform()}:${userInfo().uid}:${host}`).digest('hex')
}
async function githubIdentity(repo: string): Promise<{ node_id: string; full_name: string; permissions?: { pull?: boolean } }> {
  const result = await run('gh', ['api', `repos/${repo}`], { timeout: 10000, maxBuffer: 1024 * 1024 })
  const identity = JSON.parse(result.stdout)
  if (identity.full_name !== repo || typeof identity.node_id !== 'string' || identity.permissions?.pull !== true) throw new Error(`verified repository identity/read access unavailable: ${repo}`)
  return identity
}
interface Binding { repo: string; devMd: string; path?: string; group: string | null }
async function bindingsFor(target: SyncTarget, config: FactoryConfig): Promise<Binding[]> {
  const bindings = new Map<string, Binding>()
  const add = (devMd: string, path?: string) => {
    const room = parseControlRoomKnob(devMd), repo = profileRepo(devMd)
    if (!room || room.org !== target.org) return
    if (room.repo !== target.repo || !repo) throw new Error('confirmed code repository and matching control-room profile required')
    const previous = bindings.get(repo)
    if (previous && previous.devMd !== devMd) throw new Error(`conflicting local profiles for ${repo}`)
    bindings.set(repo, { repo, devMd, path, group: room.group })
  }
  if (target.repoPath) {
    await assertSafeLocalPath(target.repoPath)
    const repo = profileRepo(target.devMdText)
    const origin = (await git(['-C', target.repoPath, 'remote', 'get-url', 'origin'])).stdout.trim()
    if (!repo || canonicalRepo(origin) !== repo) throw new Error('selected checkout origin does not match its confirmed repository profile')
  }
  add(target.devMdText, target.repoPath)
  const repos = config.settings.repos
  if (repos !== undefined && !Array.isArray(repos)) throw new Error('configured repository checkouts must be an array')
  for (const row of (repos ?? []) as { repo: string; path: string; org: string }[]) {
    if (row.org !== target.org) continue
    if (typeof row.path !== 'string' || typeof row.repo !== 'string') throw new Error('invalid configured checkout')
    const path = row.path.startsWith('~/') ? join(target.home, row.path.slice(2)) : resolve(target.home, row.path)
    await assertSafeLocalPath(path)
    const text = await readFile(join(path, '.vegastack/dev.md'), 'utf8')
    if (profileRepo(text) !== row.repo) throw new Error('configured checkout/profile identity disagreement')
    const origin = (await git(['-C', path, 'remote', 'get-url', 'origin'])).stdout.trim()
    if (canonicalRepo(origin) !== row.repo) throw new Error(`wrong code checkout origin: ${row.repo}`)
    add(text, path)
  }
  if (!bindings.size) throw new Error('no confirmed code repository profile; persist setup answers and complete the profile before sync')
  return [...bindings.values()]
}
function validateSnapshot(snapshot: PolicySnapshot, binding: Binding, now: number) {
  return loadSnapshotPolicy({ snapshot, repo: binding.repo, devMd: binding.devMd, expectedOrigin: snapshot.origin, now })
}

export function planSync(input: {
  cloneExists: boolean
  lastSyncedAt: string | null
  now: number
  maxAgeMinutes: number
  force: boolean
}): { action: 'clone' | 'refresh' | 'fresh'; reason: string } {
  if (!input.cloneExists) return { action: 'clone', reason: 'no local clone yet' }
  if (input.force) return { action: 'refresh', reason: 'forced' }
  if (isStale(input.lastSyncedAt, input.now, input.maxAgeMinutes)) {
    return { action: 'refresh', reason: `last fetch older than ${input.maxAgeMinutes}m` }
  }
  return { action: 'fresh', reason: `fetched within ${input.maxAgeMinutes}m` }
}

export async function syncControlRoom(input: { target: SyncTarget; config: FactoryConfig; now: number; maxAgeMinutes?: number; force?: boolean; dryRun?: boolean }): Promise<SyncResult> {
  const { target, now } = input
  let config = input.config
  let previous = config.controlRooms[target.org]
  const base = (): Omit<SyncResult, 'ok' | 'action' | 'message'> => ({
    org: target.org, path: previous?.snapshots ? Object.values(previous.snapshots)[0]?.contentPath ?? target.clonePath : target.clonePath,
    sha: previous?.sha ?? null, lastSyncedAt: previous?.lastSyncedAt ?? null,
    ageMinutes: ageMinutes(previous?.lastSyncedAt ?? null, now), config: structuredClone(config),
  })
  let targetRepositoryId: string | undefined
  const started = Date.now()
  const bounded = () => { if (Date.now() - started >= 90000) throw new Error('candidate fetch/validation exceeded 90 seconds') }
  try {
    // Never use the caller's old object as publication authority, including first setup.
    config = await readSettingsFile(target.settingsPath); previous = config.controlRooms[target.org]
    const currentTarget = resolveTarget({ devMdText: target.devMdText, config, home: target.home, org: target.org, settingsPath: target.settingsPath, repoPath: target.repoPath })!
    if (fingerprint(connection(previous)) !== fingerprint(connection(input.config.controlRooms[target.org])) || currentTarget.remote !== target.remote || currentTarget.branch !== target.branch || currentTarget.repo !== target.repo) throw new Error('control-room connection changed; reload settings')
    await assertSafeLocalPath(target.clonePath)
    const remoteRepo = canonicalRepo(target.remote)
    if (remoteRepo !== target.repo && !(isAbsolute(target.remote) && !config.settings.machine && previous?.remote === target.remote)) throw new Error('control-room origin does not match the confirmed repository')
    await git(['check-ref-format', '--branch', target.branch])
    const bindings = await bindingsFor(target, config)
    if (await exists(join(target.clonePath, '.git'))) {
      await git(['-C', target.clonePath, 'rev-parse', '--verify', 'HEAD'])
      if ((await git(['-C', target.clonePath, 'remote', 'get-url', 'origin'])).stdout.trim() !== target.remote) throw new Error('operator checkout has wrong origin; refusing to rewrite it')
      if ((await git(['-C', target.clonePath, 'status', '--porcelain', '--untracked-files=all'])).stdout.trim()) throw new Error(`local modifications at ${target.clonePath}; preserve edits before refresh`)
    }
    else if (await exists(target.clonePath)) throw new Error('configured telemetry checkout exists without a valid Git repository; preserve it for recovery')
    for (const snapshot of Object.values(previous?.snapshots ?? {})) {
      await assertSafeLocalPath(snapshot.contentPath)
      if ((await git(['-C', snapshot.contentPath, 'status', '--porcelain', '--untracked-files=all'])).stdout.trim()) throw new Error(`local modifications at ${snapshot.contentPath}; refusing snapshot replacement`)
    }
    const fresh = bindings.every(binding => {
      const snapshot = previous?.snapshots?.[binding.repo]
      return snapshot && validateSnapshot(snapshot, binding, now).ok
    })

    const action = previous?.snapshots && Object.keys(previous.snapshots).length ? 'refresh' : 'clone'
    if (input.dryRun) return { ...base(), ok: true, action, message: `would fetch and validate ${target.repo}; schema1 migration retains a backup` }
    const machine = config.settings.machine as MachineBootstrap | undefined
    let executionLogin: string | undefined, hostBindingDigest: string | undefined
    if (remoteRepo && (!fresh || input.force || machine)) {
      const identity = await githubIdentity(target.repo)
      if (machine && identity.node_id !== machine.controlRoom.repositoryId) throw new Error('control-room repository ID changed; verified reconciliation required')
      if (previous?.repositoryId && previous.repositoryId !== identity.node_id) throw new Error('control-room repository ID changed; verified reconciliation required')
      if (machine) {
        hostBindingDigest = await localHostBindingDigest()
        if (hostBindingDigest !== machine.hostBindingDigest) throw new Error('machine host binding mismatch; copied bootstrap cannot enroll this host')
        executionLogin = JSON.parse((await run('gh', ['api', 'user'], { timeout: 10000 })).stdout).login
      }
      // Retain the checked ID for the first non-enrolled connection as well.
      targetRepositoryId = identity.node_id
    }
    if (fresh && !input.force) {
      if (machine) for (const binding of bindings) {
        const result = validateSnapshot(previous!.snapshots![binding.repo]!, binding, now)
        const enrolled = resolveMachinePolicy({ policy: result.policy, machineId: machine.id, installationId: machine.installationId, hostBindingDigest, executionLogin })
        if (!enrolled.ok || !enrolled.machine.allowedRepositories.includes(binding.repo) || enrolled.machine.group !== machine.group) throw new Error(enrolled.blocks.join('; ') || 'repository outside machine enrollment')
      }
      return { ...base(), ok: true, action: 'fresh', message: 'all configured repository snapshots are validated and fresh' }
    }
    bounded()
    const parent = join(dirname(target.settingsPath), 'policy-snapshots', target.org)
    await assertSafeLocalPath(parent); await mkdir(parent, { recursive: true, mode: 0o700 })
    const candidate = await mkdtemp(join(parent, 'snapshot-'))
    await git(['init', '--quiet', candidate])
    await git(['-C', candidate, 'remote', 'add', 'origin', target.remote])
    let fetched = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await git([...GIT_CREDENTIAL_ARGS, '-C', candidate, 'fetch', '--depth', '1', 'origin', target.branch], Math.min(30000, 90000 - (Date.now() - started))); fetched = true; break }
      catch (error) { if (attempt === 1) throw error; bounded(); await new Promise(resolve => setTimeout(resolve, 1000)) }
    }
    if (!fetched) throw new Error('fetch failed')
    await git(['-C', candidate, 'checkout', '--detach', 'FETCH_HEAD'])
    const sha = (await git(['-C', candidate, 'rev-parse', 'HEAD'])).stdout.trim()
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('fetched commit identity is not a full SHA')
    const validatedAt = new Date(now).toISOString(), snapshots: Record<string, PolicySnapshot> = {}
    for (const binding of bindings) {
      bounded()
      const snapshot: PolicySnapshot = { schemaVersion: 2, org: target.org, group: binding.group, repository: target.repo, origin: target.remote, sourceCommit: sha, policyDigest: '0'.repeat(64), validatedAt, contentPath: candidate }
      // The canonical reader computes all source/registry/profile identities. A provisional
      // digest is never published; the second read verifies the resulting complete binding.
      snapshot.policyDigest = validateSnapshot(snapshot, binding, now).policy.policyDigest
      const result = validateSnapshot(snapshot, binding, now)
      if (!result.ok) throw new Error(result.blocks.join('; '))
      if (machine) {
        const enrolled = resolveMachinePolicy({ policy: result.policy, machineId: machine.id, installationId: machine.installationId, hostBindingDigest, executionLogin })
        if (!enrolled.ok || !enrolled.machine.allowedRepositories.includes(binding.repo) || enrolled.machine.group !== machine.group) throw new Error(enrolled.blocks.join('; ') || 'repository outside machine enrollment')
        const identity = await githubIdentity(binding.repo)
        if (identity.node_id !== enrolled.machine.repositoryIds[binding.repo]) throw new Error('code repository ID mismatch')
      }
      snapshots[binding.repo] = snapshot
    }
    bounded()
    // Bootstrap the separate telemetry writer once, from the exact validated local object.
    // Existing operator/writer checkouts are never reset, repointed or fast-forwarded by sync.
    if (!await exists(target.clonePath)) {
      await mkdir(dirname(target.clonePath), { recursive: true, mode: 0o700 })
      await mkdir(target.clonePath, { mode: 0o700 })
      await git(['init', '--quiet', target.clonePath])
      await git(['-C', target.clonePath, 'remote', 'add', 'origin', target.remote])
      await git(['-C', target.clonePath, 'fetch', '--depth', '1', candidate, sha])
      await git(['-C', target.clonePath, 'checkout', '-b', target.branch, 'FETCH_HEAD'])
    }
    const committed = await updateSettingsAtPath(target.settingsPath, async state => {
      if (fingerprint(state.orgs[target.org]?.snapshots) !== fingerprint(previous?.snapshots)) throw new Error('another validated sync published first; reload current snapshot')
      if (fingerprint(connection(state.orgs[target.org])) !== fingerprint(connection(previous)) || fingerprint(state.settings.machine) !== fingerprint(config.settings.machine) || fingerprint(state.settings.repos) !== fingerprint(config.settings.repos)) throw new Error('bootstrap or checkout settings changed during refresh')
      for (const binding of bindings) {
        if (binding.path && await readFile(join(binding.path, '.vegastack/dev.md'), 'utf8') !== binding.devMd) throw new Error('local profile changed during refresh')
      }
      bounded()
      const old = state.orgs[target.org]
      // Keep two previous valid pointer sets. Immutable content is never deleted here, so
      // older active-run pins survive retention and interrupted candidates remain inspectable.
      const history = [...(old?.snapshots ? [old.snapshots] : []), ...(old?.history ?? [])].slice(0, 2)
      if (target.repoPath && !((state.settings.repos ?? []) as { repo: string }[]).some(row => row.repo === profileRepo(target.devMdText))) {
        state.settings.repos = [...((state.settings.repos ?? []) as object[]), { repo: profileRepo(target.devMdText), path: target.repoPath, org: target.org }]
      }
      state.orgs[target.org] = { ...old, recovery: undefined, repo: target.repo, path: target.clonePath, branch: target.branch, remote: target.remote,
        ...(targetRepositoryId ? { repositoryId: targetRepositoryId } : {}), sha, lastSyncedAt: validatedAt, snapshots, history }
      return state
    })
    const committedConfig: FactoryConfig = { schemaVersion: 2, revision: committed.revision, controlRooms: committed.orgs, settings: committed.settings }
    return { ok: true, action, org: target.org, path: candidate, sha, lastSyncedAt: validatedAt, ageMinutes: 0,
      message: `control room ${target.org}: validated ${sha}; settings revision ${committed.revision}`, config: committedConfig }
  } catch (error) {
    const reason = (error as Error).message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@').split('\n')[0]
    return { ...base(), ok: false, action: 'refused', message: `${reason}; last-good source ${previous?.sha ?? 'unavailable'}` }
  }
  // declaration is initialized before any asynchronous work in this invocation
}

// Recovery selects validated backup content for inspection, never renews authority. The
// authoritative map is empty until a real fetch/validation publishes it again; even a recently
// created backup cannot accidentally authorize a new launch merely because restore was applied.
export async function inspectSnapshots(input: { target: SyncTarget; now: number }) {
  const config = await readSettingsFile(input.target.settingsPath)
  const bindings = await bindingsFor(input.target, config)
  const entry = config.controlRooms[input.target.org]
  const inspect = (snapshots: Record<string, PolicySnapshot>) => {
    const reasons: string[] = []
    if (Object.keys(snapshots).sort().join() !== bindings.map(b => b.repo).sort().join()) reasons.push('backup repository bindings differ from current confirmed profiles')
    for (const binding of bindings) {
      const snapshot = snapshots[binding.repo]
      if (!snapshot || snapshot.origin !== input.target.remote || snapshot.repository !== input.target.repo || !Number.isFinite(Date.parse(snapshot.validatedAt)) || Date.parse(snapshot.validatedAt) > input.now) { reasons.push('backup source or validation identity mismatch'); continue }
      const checked = validateSnapshot(snapshot, binding, Date.parse(snapshot.validatedAt))
      reasons.push(...checked.blocks)
    }
    return { ok: reasons.length === 0, reasons, snapshots: structuredClone(snapshots) }
  }
  return { current: inspect(entry?.snapshots ?? {}), history: (entry?.history ?? []).map(inspect), revision: config.revision ?? 0 }
}
export async function restoreSnapshot(input: { target: SyncTarget; index: number; now: number; apply?: boolean }) {
  if (!Number.isSafeInteger(input.index) || input.index < 0) throw new Error('backup index must be a non-negative integer')
  const inspection = await inspectSnapshots(input)
  const backup = inspection.history[input.index]
  if (!backup?.ok) throw new Error(backup?.reasons.join('; ') || 'backup unavailable')
  if (!input.apply) return { applied: false, snapshots: backup.snapshots, message: 'verified backup; apply selects recovery content and requires a fresh fetch before authority resumes' }
  await updateSettingsAtPath(input.target.settingsPath, state => {
    if (state.revision !== inspection.revision || fingerprint(state.orgs[input.target.org]?.history?.[input.index]) !== fingerprint(backup.snapshots)) throw new Error('settings changed during recovery inspection')
    const entry = state.orgs[input.target.org]!
    entry.recovery = { snapshots: backup.snapshots, selectedAt: new Date(input.now).toISOString(), requiresFetch: true }
    entry.history = [entry.snapshots ?? {}, ...(entry.history ?? [])].filter(rows => Object.keys(rows).length).slice(0, 2)
    entry.snapshots = {}
    return state
  })
  return { applied: true, snapshots: backup.snapshots, message: 'recovery selected; fresh successful sync required before authority resumes' }
}

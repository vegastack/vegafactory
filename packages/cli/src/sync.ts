// One shallow fetch of the org control room into this machine's copy of it. Nothing here reads
// policy, validates a profile or grants anything: it moves the room's Markdown to where the skills
// read it, and records when that last worked.
import { execFile } from 'node:child_process'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  MAX_AGE_MINUTES, ageMinutes, defaultClonePath, factoryConfigPath, isStale, parseControlRoomKnob,
  assertSafeLocalPath, readSettingsFile, safeClonePath, updateSettingsAtPath,
  type ControlRoomEntry, type FactoryConfig,
} from './control-room.ts'

const run = promisify(execFile)
export const GIT_CREDENTIAL_ARGS: readonly string[] = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

export interface SyncTarget {
  org: string
  repo: string
  group: string | null
  clonePath: string
  branch: string
  remote: string
  settingsPath: string
  home: string
}

export interface SyncResult {
  ok: boolean
  action: 'clone' | 'refresh' | 'fresh' | 'refused'
  org: string
  path: string
  sha: string | null
  lastSyncedAt: string | null
  ageMinutes: number | null
  message: string
  config: FactoryConfig
}

async function git(args: string[], timeout = 30000) {
  return run('git', args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}
async function exists(path: string) {
  return lstat(path).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error })
}
const canonicalRepo = (remote: string): string | null =>
  /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1] ?? null

// Which room this machine should have a copy of: the repo's own profile names it, and `--org` names
// it for the first run in a repo whose dev.md has no `control-room:` line yet. The two must agree.
export function resolveTarget(input: { devMdText: string; config: FactoryConfig; home: string; org?: string; settingsPath?: string }): SyncTarget | null {
  const fromProfile = parseControlRoomKnob(input.devMdText), org = input.org?.trim()
  if (fromProfile && org && fromProfile.org !== org) throw new Error(`--org ${org} disagrees with the profile's control-room: ${fromProfile.repo}`)
  if (org && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) throw new Error('invalid organization')
  const knob = fromProfile ?? (org ? { org, repo: `${org}/vegafactory-control-room`, group: null, sha: null } : null)
  if (!knob) return null
  const entry = input.config.controlRooms[knob.org]
  if (entry && entry.repo !== knob.repo) throw new Error('profile and configured control-room repository disagree')
  // The copy always lives at one path per org, so nothing in settings can move it somewhere the
  // safety checks do not cover. The remote and branch stay configurable for a room on a fork.
  return {
    org: knob.org, repo: knob.repo, group: knob.group, clonePath: defaultClonePath(knob.org, input.home),
    branch: entry?.branch ?? 'main', remote: entry?.remote ?? `https://github.com/${knob.repo}.git`,
    settingsPath: input.settingsPath ?? factoryConfigPath(input.home), home: input.home,
  }
}

export function planSync(input: { cloneExists: boolean; lastSyncedAt: string | null; now: number; force: boolean }): { action: 'clone' | 'refresh' | 'fresh'; reason: string } {
  if (!input.cloneExists) return { action: 'clone', reason: 'no local copy yet' }
  if (input.force) return { action: 'refresh', reason: 'forced' }
  if (isStale(input.lastSyncedAt, input.now, MAX_AGE_MINUTES)) return { action: 'refresh', reason: `last fetch older than ${MAX_AGE_MINUTES}m` }
  return { action: 'fresh', reason: `fetched within ${MAX_AGE_MINUTES}m` }
}

async function lockOrg(clonePath: string): Promise<() => Promise<void>> {
  // One sync at a time per org: inspect, fetch, checkout and publish all read and write the one
  // copy, so two of them interleaved could publish a commit that is not the one on disk. The lock
  // is never stolen from an owner that appears old — an interrupted sync is inspected by a human,
  // because the alternative is two processes writing one checkout on the strength of a guess.
  const lock = clonePath + '.lock'
  await assertSafeLocalPath(lock)
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 120_000
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error(`another sync is using ${clonePath}; wait for it to finish, or remove ${lock}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  return async () => { await rm(lock, { recursive: true, force: true }) }
}

const connection = (entry?: ControlRoomEntry) => entry ? JSON.stringify([entry.repo, entry.path, entry.branch, entry.remote ?? null]) : null

/**
 * Fetch the control room into `~/.vegastack/control-room/<org>`, unless the copy was fetched less
 * than five minutes ago. The copy mirrors the room's branch: it must still be the exact commit the
 * last sync recorded, on the recorded branch and origin, with nothing changed — anything else is a
 * refusal, because the mirror would otherwise throw away a local edit or a local commit without
 * saying so. A refusal leaves the copy and the record as they were: stale answers beat no answers.
 */
export async function syncControlRoom(input: { target: SyncTarget; config: FactoryConfig; now: number; force?: boolean; dryRun?: boolean }): Promise<SyncResult> {
  const { target, now } = input
  let previous: ControlRoomEntry | undefined = input.config.controlRooms[target.org]
  const base = () => ({
    org: target.org, path: target.clonePath, sha: previous?.sha ?? null, lastSyncedAt: previous?.lastSyncedAt ?? null,
    ageMinutes: ageMinutes(previous?.lastSyncedAt ?? null, now), config: structuredClone(input.config),
  })
  let release: (() => Promise<void>) | null = null
  try {
    await assertSafeLocalPath(target.clonePath)
    release = await lockOrg(target.clonePath)
    // The caller's config was read before the lock; what is on disk now is the only authority.
    const config = await readSettingsFile(target.settingsPath)
    previous = config.controlRooms[target.org]
    if (connection(previous) !== connection(input.config.controlRooms[target.org])) throw new Error('the control-room connection changed; reload settings and sync again')
    // A recorded absolute path is a room on this machine — a fixture or a mirror; anything else
    // must be the GitHub remote the profile names.
    if (canonicalRepo(target.remote) !== target.repo && !(isAbsolute(target.remote) && previous?.remote === target.remote)) throw new Error('the control-room origin does not match the repository the profile names')
    await git(['check-ref-format', '--branch', target.branch], 5000)
    const cloned = await exists(join(target.clonePath, '.git'))
    if (!cloned && await exists(target.clonePath)) throw new Error(`${target.clonePath} exists and is not a Git clone; move it aside first`)

    // Every one of these runs before the fresh and dry-run answers too. A copy that is ahead by a
    // commit, or carries an edit, is a copy the refresh would silently discard, and reporting it
    // fresh would be reporting that the room's policy is what this machine is running on.
    let restoreSha: string | null = null
    if (cloned) {
      const unsafe = safeClonePath(target.home, target.clonePath)
      if (unsafe) throw new Error(unsafe)
      if ((await git(['-C', target.clonePath, 'remote', 'get-url', 'origin'], 5000)).stdout.trim() !== target.remote) throw new Error('the local copy has a different origin; refusing to rewrite it')
      if ((await git(['-C', target.clonePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], 5000)).stdout.trim() !== target.branch) throw new Error(`the local copy is not on ${target.branch}; refusing to rewrite it`)
      restoreSha = (await git(['-C', target.clonePath, 'rev-parse', 'HEAD'], 5000)).stdout.trim()
      if (previous?.sha && restoreSha !== previous.sha) throw new Error(`the local copy is at ${restoreSha.slice(0, 7)}, not the ${previous.sha.slice(0, 7)} sync recorded; preserve the difference before a refresh`)
      if ((await git(['-C', target.clonePath, 'status', '--porcelain', '--untracked-files=all'], 5000)).stdout.trim()) throw new Error(`local changes at ${target.clonePath}; commit or clear them before a refresh`)
    }

    const plan = planSync({ cloneExists: cloned, lastSyncedAt: previous?.lastSyncedAt ?? null, now, force: input.force === true })
    if (plan.action === 'fresh') return { ...base(), ok: true, action: 'fresh', message: `control room ${target.org}: ${plan.reason}` }
    if (input.dryRun) return { ...base(), ok: true, action: plan.action, message: `would ${plan.action} ${target.repo} into ${target.clonePath}: ${plan.reason}` }

    if (!cloned) {
      await mkdir(dirname(target.clonePath), { recursive: true, mode: 0o700 })
      await mkdir(target.clonePath, { mode: 0o700 })
      await git(['init', '--quiet', target.clonePath], 5000)
      await git(['-C', target.clonePath, 'remote', 'add', 'origin', target.remote], 5000)
    }
    await git([...GIT_CREDENTIAL_ARGS, '-C', target.clonePath, 'fetch', '--depth', '1', 'origin', target.branch])

    // From here the checkout and the record must end up agreeing. The fetch is one commit deep, so
    // two of them share no history and the copy is set to the fetched commit rather than merged
    // into. If the record cannot then be written, the copy goes back to what it was — otherwise a
    // refusal would report that the previous copy stands while the new one sat on disk.
    try {
      await git(['-C', target.clonePath, 'checkout', '--quiet', '-B', target.branch, 'FETCH_HEAD'], 5000)
      const sha = (await git(['-C', target.clonePath, 'rev-parse', 'HEAD'], 5000)).stdout.trim()
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('the fetched commit is not a full SHA')
      const lastSyncedAt = new Date(now).toISOString()
      const committed = await updateSettingsAtPath(target.settingsPath, state => {
        const current = state.orgs[target.org]
        if (connection(current) !== connection(previous)) throw new Error('the control-room connection changed during the refresh')
        if ((current?.sha ?? null) !== (previous?.sha ?? null)) throw new Error('another sync published first')
        state.orgs[target.org] = { ...current, repo: target.repo, path: target.clonePath, branch: target.branch, remote: target.remote, sha, lastSyncedAt }
        return state
      })
      return {
        ok: true, action: plan.action, org: target.org, path: target.clonePath, sha, lastSyncedAt, ageMinutes: 0,
        message: `control room ${target.org}: ${sha.slice(0, 7)} in ${target.clonePath}`,
        config: { schemaVersion: 2, revision: committed.revision, controlRooms: committed.orgs, settings: committed.settings },
      }
    } catch (error) {
      if (restoreSha) await git(['-C', target.clonePath, 'checkout', '--quiet', '-B', target.branch, restoreSha], 5000).catch(() => {})
      else await rm(target.clonePath, { recursive: true, force: true })
      throw error
    }
  } catch (error) {
    const reason = (error as Error).message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@').split('\n')[0]
    return { ...base(), ok: false, action: 'refused', message: `${reason}; the copy at ${previous?.sha?.slice(0, 7) ?? 'no recorded commit'} stands` }
  } finally {
    if (release) await release()
  }
}

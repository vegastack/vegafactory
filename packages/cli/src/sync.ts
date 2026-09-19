// One shallow fetch of the org control room into this machine's copy of it. Nothing here reads
// policy, validates a profile or grants anything: it moves the room's Markdown to where the skills
// read it, and records when that last worked.
import { execFile } from 'node:child_process'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  GIT_NO_REPLACE, MAX_AGE_MINUTES, SHA, ageMinutes, defaultClonePath, factoryConfigPath, gitEnv, isStale,
  lockOrg, parseControlRoomKnob, publishedAlready, readSettingsFile, repositoryReason, safeClonePath,
  assertSafeLocalPath, updateSettingsAtPath,
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
  return run('git', [...GIT_NO_REPLACE, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, env: gitEnv() })
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

const connection = (entry?: ControlRoomEntry) => entry ? JSON.stringify([entry.repo, entry.path, entry.branch, entry.remote ?? null]) : null

/**
 * Fetch the control room into `~/.vegafactory/control-room/<org>`, unless the copy was fetched less
 * than five minutes ago. The copy mirrors the room's branch: it must be a repository of its own,
 * still on the exact commit the last sync recorded, on the recorded branch and origin, with
 * nothing changed — anything else is a refusal, because the mirror would otherwise throw away a
 * local edit or a local commit without saying so. A refusal leaves the copy and the record as they
 * were: stale answers beat no answers.
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
      const notARepository = repositoryReason(target.clonePath)
      if (notARepository) throw new Error(notARepository)
      // Without a recorded commit there is nothing to hold the copy to, so a local commit would go
      // over the side unnoticed. An unrecorded copy is the operator's to keep or to remove.
      if (!SHA.test(previous?.sha ?? '')) throw new Error(`${target.clonePath} exists but no sync recorded its commit; move it aside and sync again`)
      if ((await git(['-C', target.clonePath, 'remote', 'get-url', 'origin'], 5000)).stdout.trim() !== target.remote) throw new Error('the local copy has a different origin; refusing to rewrite it')
      if ((await git(['-C', target.clonePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], 5000)).stdout.trim() !== target.branch) throw new Error(`the local copy is not on ${target.branch}; refusing to rewrite it`)
      restoreSha = (await git(['-C', target.clonePath, 'rev-parse', 'HEAD'], 5000)).stdout.trim()
      if (restoreSha !== previous!.sha) throw new Error(`the local copy is at ${restoreSha.slice(0, 7)}, not the ${previous!.sha!.slice(0, 7)} sync recorded; preserve the difference before a refresh`)
      if ((await git(['-C', target.clonePath, 'status', '--porcelain', '--untracked-files=all'], 5000)).stdout.trim()) throw new Error(`local changes at ${target.clonePath}; commit or clear them before a refresh`)
    }

    const plan = planSync({ cloneExists: cloned, lastSyncedAt: previous?.lastSyncedAt ?? null, now, force: input.force === true })
    if (plan.action === 'fresh') return { ...base(), ok: true, action: 'fresh', message: `control room ${target.org}: ${plan.reason}` }
    if (input.dryRun) return { ...base(), ok: true, action: plan.action, message: `would ${plan.action} ${target.repo} into ${target.clonePath}: ${plan.reason}` }

    // Everything that touches the copy lives inside this block, from the first mkdir onward. A
    // half-made repository left by a failed first fetch would be "an existing clone" to the next
    // run, and a checkout the record never learned about would make a refusal say the previous
    // copy stands while the new one sat on disk. So on the way out the copy goes back to the
    // commit it was on, or, if this run created it, it goes away — unless the record was already
    // published, in which case the copy is the one the record names and must stay.
    try {
      if (!cloned) {
        await mkdir(dirname(target.clonePath), { recursive: true, mode: 0o700 })
        await mkdir(target.clonePath, { mode: 0o700 })
        await git(['init', '--quiet', target.clonePath], 5000)
        await git(['-C', target.clonePath, 'remote', 'add', 'origin', target.remote], 5000)
      }
      await git([...GIT_CREDENTIAL_ARGS, '-C', target.clonePath, 'fetch', '--depth', '1', 'origin', target.branch])
      // The fetch is one commit deep, so two of them share no history: the copy is set to the
      // fetched commit rather than merged into.
      await git(['-C', target.clonePath, 'checkout', '--quiet', '-B', target.branch, 'FETCH_HEAD'], 5000)
      const sha = (await git(['-C', target.clonePath, 'rev-parse', 'HEAD'], 5000)).stdout.trim()
      if (!SHA.test(sha)) throw new Error('the fetched commit is not a full SHA')
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
      if (publishedAlready(error)) throw error
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

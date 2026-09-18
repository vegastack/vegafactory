// One shallow fetch of the org control room into this machine's copy of it. Nothing here reads
// policy, validates a profile or grants anything: it moves the room's Markdown to where the skills
// read it, and records when that last worked.
import { execFile } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  MAX_AGE_MINUTES, ageMinutes, defaultClonePath, factoryConfigPath, isStale, parseControlRoomKnob,
  assertSafeLocalPath, safeClonePath, updateSettingsAtPath,
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

/**
 * Fetch the control room into `~/.vegastack/control-room/<org>`, unless the copy was fetched less
 * than five minutes ago. The copy mirrors the room's branch. A refusal leaves the old copy and the
 * old record as they were: stale answers beat no answers, and a hand-edited copy is never
 * overwritten — the refresh refuses until the operator clears the edit.
 */
export async function syncControlRoom(input: { target: SyncTarget; config: FactoryConfig; now: number; force?: boolean; dryRun?: boolean }): Promise<SyncResult> {
  const { target, now } = input
  const previous: ControlRoomEntry | undefined = input.config.controlRooms[target.org]
  const base = () => ({
    org: target.org, path: target.clonePath, sha: previous?.sha ?? null, lastSyncedAt: previous?.lastSyncedAt ?? null,
    ageMinutes: ageMinutes(previous?.lastSyncedAt ?? null, now), config: structuredClone(input.config),
  })
  try {
    await assertSafeLocalPath(target.clonePath)
    // A recorded absolute path is a room on this machine — a fixture or a mirror; anything else
    // must be the GitHub remote the profile names.
    if (canonicalRepo(target.remote) !== target.repo && !(isAbsolute(target.remote) && previous?.remote === target.remote)) throw new Error('the control-room origin does not match the repository the profile names')
    await git(['check-ref-format', '--branch', target.branch], 5000)
    const cloned = await exists(join(target.clonePath, '.git'))
    if (!cloned && await exists(target.clonePath)) throw new Error(`${target.clonePath} exists and is not a Git clone; move it aside first`)
    if (cloned) {
      const unsafe = safeClonePath(target.home, target.clonePath)
      if (unsafe) throw new Error(unsafe)
      if ((await git(['-C', target.clonePath, 'remote', 'get-url', 'origin'], 5000)).stdout.trim() !== target.remote) throw new Error('the local copy has a different origin; refusing to rewrite it')
    }
    const plan = planSync({ cloneExists: cloned, lastSyncedAt: previous?.lastSyncedAt ?? null, now, force: input.force === true })
    if (plan.action === 'fresh') return { ...base(), ok: true, action: 'fresh', message: `control room ${target.org}: ${plan.reason}` }
    if (input.dryRun) return { ...base(), ok: true, action: plan.action, message: `would ${plan.action} ${target.repo} into ${target.clonePath}: ${plan.reason}` }

    if (!cloned) {
      await mkdir(dirname(target.clonePath), { recursive: true, mode: 0o700 })
      await mkdir(target.clonePath, { mode: 0o700 })
      await git(['init', '--quiet', target.clonePath], 5000)
      await git(['-C', target.clonePath, 'remote', 'add', 'origin', target.remote], 5000)
    } else if ((await git(['-C', target.clonePath, 'status', '--porcelain', '--untracked-files=all'], 5000)).stdout.trim()) {
      throw new Error(`local changes at ${target.clonePath}; commit or clear them before a refresh`)
    }
    await git([...GIT_CREDENTIAL_ARGS, '-C', target.clonePath, 'fetch', '--depth', '1', 'origin', target.branch])
    // The copy mirrors the room's branch rather than merging into it: the fetch is one commit deep,
    // so two of them share no history. Nothing is lost — a copy with local changes refused above.
    await git(['-C', target.clonePath, 'checkout', '--quiet', '-B', target.branch, 'FETCH_HEAD'], 5000)
    const sha = (await git(['-C', target.clonePath, 'rev-parse', 'HEAD'], 5000)).stdout.trim()
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('the fetched commit is not a full SHA')

    const lastSyncedAt = new Date(now).toISOString()
    const committed = await updateSettingsAtPath(target.settingsPath, state => {
      state.orgs[target.org] = { ...state.orgs[target.org], repo: target.repo, path: target.clonePath, branch: target.branch, remote: target.remote, sha, lastSyncedAt }
      return state
    })
    return {
      ok: true, action: plan.action, org: target.org, path: target.clonePath, sha, lastSyncedAt, ageMinutes: 0,
      message: `control room ${target.org}: ${sha.slice(0, 7)} in ${target.clonePath}`,
      config: { schemaVersion: 2, revision: committed.revision, controlRooms: committed.orgs, settings: committed.settings },
    }
  } catch (error) {
    const reason = (error as Error).message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@').split('\n')[0]
    return { ...base(), ok: false, action: 'refused', message: `${reason}; the copy at ${previous?.sha?.slice(0, 7) ?? 'no recorded commit'} stands` }
  }
}

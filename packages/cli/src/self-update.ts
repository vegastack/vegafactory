import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateNotePath, type HomeOptions } from './home.ts'
import { loadProfile } from './control-room.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const packageVersion = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version

export type UpdateMode = 'off' | 'notify' | 'auto'
export type UpdateAction = 'none' | 'current' | 'available' | 'updated' | 'unverified' | 'failed' | 'unavailable'
export interface UpdateResult {
  action: UpdateAction
  before: string
  after: string
  latest: string | null
  message: string
}

export interface UpdateRunResult { code: number; stdout: string; stderr: string }
export type UpdateRunner = (command: string, args: string[], timeoutMs: number) => UpdateRunResult
export type LatestVersion = () => Promise<string | null>

const defaultResolve = (input: { home: string; devMd: string }) => loadProfile(input)

export const SELF_UPDATE_LIMIT_S = 5 * 60

// npm publishes a new version every week or two, and an idle worker polls every couple of minutes.
// Asking the registry each pass is a few hundred calls a day to learn something that changed once,
// so the answer is remembered and the question is asked at most this often.
export const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000

// What one machine remembers between runs: when npm was last asked, and the version a background
// install was working towards. The note is advisory — every read falls back to "nothing known",
// because a machine that cannot read it must still run.
export interface UpdateNote { checkedAt?: number; latest?: string | null; startedFrom?: string; startedTo?: string; startedAt?: number }

export function readUpdateNote(options: HomeOptions = {}): UpdateNote {
  try {
    const parsed = JSON.parse(readFileSync(updateNotePath(options), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UpdateNote : {}
  } catch { return {} }
}

export function writeUpdateNote(note: UpdateNote, options: HomeOptions = {}): void {
  const path = updateNotePath(options)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(note, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  } catch { /* the note is a convenience; a machine that cannot write it still runs */ }
}

export function clearUpdateNote(options: HomeOptions = {}): void {
  try { rmSync(updateNotePath(options), { force: true }) } catch { /* see writeUpdateNote */ }
}

// Whether the hour since the last attempt has passed. An attempt counts whether or not it got an
// answer, because the cost being spread is the asking and the installing, not the answer.
export function dueForCheck(now: number, options: HomeOptions = {}): boolean {
  const { checkedAt } = readUpdateNote(options)
  return typeof checkedAt !== 'number' || now - checkedAt >= UPDATE_CHECK_EVERY_MS
}

// A registry answer remembered from less than an hour ago, or null to go and ask.
export function rememberedLatest(now: number, options: HomeOptions = {}): string | null {
  const note = readUpdateNote(options)
  if (typeof note.checkedAt !== 'number' || now - note.checkedAt >= UPDATE_CHECK_EVERY_MS) return null
  return typeof note.latest === 'string' ? note.latest : null
}
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function safe(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').trim()
}

// Release order, not string order. The prerelease rule is the part that matters here: `1.0.0-rc.1`
// comes *before* `1.0.0`, so a machine on a prerelease is behind the stable release of the same
// number and has to be told so — comparing only the numbers made the two equal and left it there.
export function semverLess(a: string, b: string): boolean {
  const numbers = (value: string) => value.split('+')[0]!.split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const pre = (value: string) => {
    const dash = value.split('+')[0]!.indexOf('-')
    return dash === -1 ? null : value.split('+')[0]!.slice(dash + 1)
  }
  const [aMajor = 0, aMinor = 0, aPatch = 0] = numbers(a)
  const [bMajor = 0, bMinor = 0, bPatch = 0] = numbers(b)
  if (aMajor !== bMajor) return aMajor < bMajor
  if (aMinor !== bMinor) return aMinor < bMinor
  if (aPatch !== bPatch) return aPatch < bPatch
  const [aPre, bPre] = [pre(a), pre(b)]
  if (aPre === bPre) return false
  // Having a prerelease tag makes a version earlier than the same numbers without one.
  if (aPre === null) return false
  if (bPre === null) return true
  // Both are prereleases of the same version: dot-separated, numbers below strings, per semver.
  const aParts = aPre.split('.'), bParts = bPre.split('.')
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const left = aParts[index], right = bParts[index]
    if (left === undefined) return true
    if (right === undefined) return false
    if (left === right) continue
    const leftNumber = /^\d+$/.test(left), rightNumber = /^\d+$/.test(right)
    if (leftNumber && rightNumber) return Number(left) < Number(right)
    if (leftNumber !== rightNumber) return leftNumber
    return left < right
  }
  return false
}

// One registry, over TLS. The *check* is fixed here because it is what decides that an update
// should happen at all; the install that follows is plain npm and uses this machine's own config.
const REGISTRY = 'https://registry.npmjs.org'
export const PACKAGE = '@vegastack/vegafactory'

export async function latestPublishedVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${REGISTRY}/@vegastack%2fvegafactory/latest`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    const version = ((await response.json()) as { version?: unknown }).version
    return typeof version === 'string' && VERSION.test(version) ? version : null
  } catch {
    return null
  }
}

// The value that actually applies here: the org's, then the group's, then this repo's — a locked
// `off` in `org.md` is the whole point of the control room, and reading only the local file made
// every inherited value look like a missing one, which means the shipped `auto`.
//
// Failure is closed, not open. A profile that cannot be resolved may be the one refusing this, and
// the thing being decided is whether to fetch and run executable code unattended.
export function effectiveUpdateMode(input: { home: string; devMd: string | null; resolve?: (input: { home: string; devMd: string }) => { ok: boolean; values: Record<string, unknown> } }): UpdateMode {
  if (input.devMd === null) return selfUpdateMode('')
  let profile: { ok: boolean; values: Record<string, unknown> }
  try { profile = (input.resolve ?? defaultResolve)({ home: input.home, devMd: input.devMd }) } catch { return 'off' }
  if (!profile.ok) return 'off'
  const value = profile.values['vegafactory-update']
  if (value === undefined || value === null) return selfUpdateMode('')
  return selfUpdateMode(`vegafactory-update: ${String(value)}`)
}

// Plain `npm install -g`, which is what the brief asked for and what a person would type. npm
// resolves it through this machine's own configuration — a corporate mirror, a scope mapping —
// and that configuration is the machine owner's to make: overriding it here would break the very
// setups it exists for, to guard against an attacker who already controls the operator's npm.
export function installArgs(): string[] {
  return ['install', '-g', `${PACKAGE}@latest`]
}

// `vegafactory update`, the command a person types. No `home` is passed: the remembered answer
// exists to stop an idle worker polling npm every couple of minutes, and reusing it here would
// answer "already current" from a check made up to an hour ago. Nothing is written either, which
// is what `--dry-run` promises.
export async function runUpdateCommand(
  dryRun: boolean,
  options: { latest?: LatestVersion; run?: UpdateRunner; say?: (text: string) => void } = {},
): Promise<void> {
  const say = options.say ?? console.log
  const result = await maintainSelfUpdate({ mode: dryRun ? 'notify' : 'auto', latest: options.latest, run: options.run })
  if (!dryRun) { say(result.message); return }
  say(result.action === 'available'
    ? `dry run: would run npm ${installArgs().join(' ')} (${result.before} → ${result.latest})`
    : result.message)
}

// An unreadable policy leaves the machine untouched. A missing line keeps existing projects on
// the shipped default, so adding the knob does not make old profiles a separate update class.
export function selfUpdateMode(devMd: string): UpdateMode {
  const declared = [...String(devMd ?? '').matchAll(/^vegafactory-update:\s*(\S+)/gm)].map(match => match[1])
  if (declared.length === 0) return 'auto'
  if (declared.length !== 1 || !['off', 'notify', 'auto'].includes(declared[0]!)) return 'off'
  return declared[0] as UpdateMode
}

export const defaultUpdateRunner: UpdateRunner = (command, args, timeoutMs) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message }
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const idle = (action: UpdateAction, before: string, latest: string | null, message: string): UpdateResult => ({ action, before, after: before, latest, message })

// The registry lookup is the guard: npm's published version is the unit of change. Every failure
// becomes a result so hooks and workers keep running on the copy that was already installed.
export async function maintainSelfUpdate(options: {
  mode: UpdateMode
  before?: string
  latest?: LatestVersion
  run?: UpdateRunner
  // Passing a home turns on the remembered answer: the registry is asked at most once an hour,
  // which is what keeps an idle worker from calling npm on every pass.
  home?: HomeOptions
  now?: number
}): Promise<UpdateResult> {
  const before = options.before ?? packageVersion
  if (options.mode === 'off') return idle('none', before, null, '')

  const now = options.now ?? Date.now()
  // The hour covers the whole attempt, not just a successful lookup. Remembering only successes
  // meant an unreachable registry was retried every pass, and a failed install of a version
  // already remembered was retried every pass too — each one holding the loop for its own bound.
  if (options.home && !dueForCheck(now, options.home)) {
    const remembered = rememberedLatest(now, options.home)
    if (!remembered) return idle('none', before, null, '')
    if (!semverLess(before, remembered)) return idle('current', before, remembered, `vegafactory ${before} is already current`)
    if (options.mode === 'notify') return idle('available', before, remembered, `vegafactory ${remembered} is available; installed ${before} — run: vegafactory update`)
    return idle('none', before, remembered, '')
  }
  let latest: string | null
  try { latest = await (options.latest ?? latestPublishedVersion)() } catch { latest = null }
  // The attempt is stamped either way, so a registry that is down costs one call an hour and not
  // one every pass. What it answered is remembered only when it answered.
  if (options.home) writeUpdateNote({ ...readUpdateNote(options.home), checkedAt: now, ...(latest ? { latest } : {}) }, options.home)
  if (!latest) return idle('unavailable', before, null, `could not check npm; continuing with vegafactory ${before}`)
  if (!semverLess(before, latest)) {
    const detail = semverLess(latest, before) ? ` (ahead of npm latest ${latest})` : ''
    return idle('current', before, latest, `vegafactory ${before} is already current${detail}`)
  }
  if (options.mode === 'notify') return idle('available', before, latest, `vegafactory ${latest} is available; installed ${before} — run: vegafactory update`)

  const run = options.run ?? defaultUpdateRunner
  let installed: UpdateRunResult
  try {
    installed = run('npm', installArgs(), SELF_UPDATE_LIMIT_S * 1000)
  } catch (error) {
    return idle('failed', before, latest, `update failed; continuing with vegafactory ${before}: ${safe((error as Error).message)}`)
  }
  if (installed.code !== 0) {
    const detail = safe(installed.stderr || installed.stdout).split('?').filter(Boolean).at(-1) ?? `exit ${installed.code}`
    return idle('failed', before, latest, `update failed; continuing with vegafactory ${before}: ${detail}`)
  }

  // npm exiting zero says the command ran, not that this machine now has the new copy. The version
  // it actually reports is the only evidence of that, so the three answers are kept apart: the new
  // version is an update, the old one is a failure however npm exited, and no usable answer is
  // neither — reported as unverified rather than announced as a success nobody checked.
  let observed: string | null = null
  try {
    const checked = run('vegafactory', ['--version'], 10_000)
    const value = checked.stdout.trim()
    if (checked.code === 0 && VERSION.test(value)) observed = value
  } catch { /* no answer is its own answer, below */ }
  if (observed === null) {
    return { action: 'unverified', before, after: before, latest, message: `installed vegafactory ${latest}, but could not confirm the version now on this machine; continuing with ${before}` }
  }
  if (semverLess(observed, latest)) {
    return { action: 'failed', before, after: observed, latest, message: `update did not take: npm finished but this machine still reports vegafactory ${observed}` }
  }
  return { action: 'updated', before, after: observed, latest, message: `updated vegafactory ${before} → ${observed}` }
}

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateNotePath, type HomeOptions } from './home.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const packageVersion = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version

export type UpdateMode = 'off' | 'notify' | 'auto'
export type UpdateAction = 'none' | 'current' | 'available' | 'updated' | 'failed' | 'unavailable'
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

// One registry, over TLS, and not configurable. This answer decides whether a global install of
// executable code runs unattended, so a redirectable base — an environment variable, a mirror —
// would let whoever set it choose what this machine installs and then runs as its own user.
const REGISTRY = 'https://registry.npmjs.org'

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
  const remembered = options.home ? rememberedLatest(now, options.home) : null
  let latest: string | null = remembered
  if (!latest) {
    try { latest = await (options.latest ?? latestPublishedVersion)() } catch { latest = null }
    // Only a real answer is remembered. Remembering a failure would hold the machine on a stale
    // version for an hour because npm was briefly unreachable.
    if (latest && options.home) writeUpdateNote({ ...readUpdateNote(options.home), checkedAt: now, latest }, options.home)
  }
  if (!latest) return idle('unavailable', before, null, `could not check npm; continuing with vegafactory ${before}`)
  if (!semverLess(before, latest)) {
    const detail = semverLess(latest, before) ? ` (ahead of npm latest ${latest})` : ''
    return idle('current', before, latest, `vegafactory ${before} is already current${detail}`)
  }
  if (options.mode === 'notify') return idle('available', before, latest, `vegafactory ${latest} is available; installed ${before} — run: vegafactory update`)

  const run = options.run ?? defaultUpdateRunner
  let installed: UpdateRunResult
  try {
    installed = run('npm', ['install', '-g', '@vegastack/vegafactory@latest'], SELF_UPDATE_LIMIT_S * 1000)
  } catch (error) {
    return idle('failed', before, latest, `update failed; continuing with vegafactory ${before}: ${safe((error as Error).message)}`)
  }
  if (installed.code !== 0) {
    const detail = safe(installed.stderr || installed.stdout).split('?').filter(Boolean).at(-1) ?? `exit ${installed.code}`
    return idle('failed', before, latest, `update failed; continuing with vegafactory ${before}: ${detail}`)
  }

  let after = latest
  try {
    const checked = run('vegafactory', ['--version'], 10_000)
    const value = checked.stdout.trim()
    if (checked.code === 0 && VERSION.test(value)) after = value
  } catch { /* npm completed; the registry version is the best available after value */ }
  return { action: 'updated', before, after, latest, message: `updated vegafactory ${before} → ${after}` }
}

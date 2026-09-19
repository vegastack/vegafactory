import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function safe(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').trim()
}

export function semverLess(a: string, b: string): boolean {
  const parse = (value: string) => value.split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a)
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b)
  if (aMajor !== bMajor) return aMajor < bMajor
  if (aMinor !== bMinor) return aMinor < bMinor
  return aPatch < bPatch
}

export async function latestPublishedVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher('https://registry.npmjs.org/@vegastack%2fvegafactory/latest', { signal: AbortSignal.timeout(3000) })
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
}): Promise<UpdateResult> {
  const before = options.before ?? packageVersion
  if (options.mode === 'off') return idle('none', before, null, '')

  let latest: string | null
  try { latest = await (options.latest ?? latestPublishedVersion)() } catch { latest = null }
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

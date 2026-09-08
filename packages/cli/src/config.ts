// What the dispatcher is allowed to do, split the way responsibility is split: machine facts in
// `~/.vegastack/factory.json` (which repos this box watches, how often, how many runs at once) and
// policy in each repo's `.vegastack/dev.md` (whether the repo is opted in at all, who its operators
// are, which harness runs which stage). Nothing here touches the network or the disk except
// `loadFactoryConfig`, so every branch is unit-testable.
//
// Fail closed is the rule, not a mood: a dev.md with no `dispatch:` line is `off`, an unknown value
// is `off`, a stage naming a harness this dispatcher cannot launch is dropped rather than guessed,
// and any unreadable field in factory.json is a named error instead of a default. A dispatcher that
// silently defaults is a dispatcher that starts a dark build nobody asked for.
import { readFactoryConfig } from './control-room.ts'
import { resolvePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export type Harness = 'claude' | 'codex'
export type Stage = 'plan' | 'implement' | 'corrections'
export type StageName = 'intake' | 'plan' | 'implement' | 'review' | 'status' | 'chronicle'

export interface StagePolicy { harness: Harness; model: string; effort: string }
export interface RepoEntry { path: string; repo: string; org: string }
export interface Subagents { spawnDepth: number; concurrent: number }

export interface FactoryConfig {
  repos: RepoEntry[]
  interval: number
  maxRuns: number
  subagents: Subagents
  controlRoom: Record<string, string>
  home: string
  stateFile: string
  logRoot: string
  lockRoot: string
  dispatcherLock: string
  executionMode?: 'legacy' | 'shared'
  settingsPath?: string
}

export type State = 'needsOperator' | 'needsPlan' | 'ready' | 'working' | 'forOperator'
export type LabelMap = Record<State, string>

export interface RepoPolicy {
  labelMap?: LabelMap
  dispatch: 'off' | 'local'
  operators: string[]
  stages: Partial<Record<StageName, StagePolicy>>
  refusal?: string | null
  effective?: ReturnType<typeof resolvePolicy>['policy']
}

const DEFAULTS = { interval: 120, maxRuns: 1, spawnDepth: 1, concurrent: 3 }

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return isAbsolute(path) ? path : resolve(home, path)
}

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`factory.json: ${field} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return value
}

export function parseFactoryConfig(raw: unknown, home: string): FactoryConfig {
  const document = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const repos = document.repos
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error('factory.json: repos must be a non-empty array of { path, repo, org } — the dispatcher watches nothing until one is listed')
  }
  const entries: RepoEntry[] = repos.map((entry, index) => {
    const row = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    for (const field of ['path', 'repo', 'org'] as const) {
      if (typeof row[field] !== 'string' || row[field] === '') throw new Error(`factory.json: repos[${index}].${field} is missing`)
    }
    return { path: expandHome(row.path as string, home), repo: row.repo as string, org: row.org as string }
  })

  const subagentsRaw = (document.subagents && typeof document.subagents === 'object' ? document.subagents : {}) as Record<string, unknown>
  // The control-room clone paths live in the same document, written by `vegafactory sync`; the
  // dispatcher reads them and never writes them.
  const controlRoom: Record<string, string> = {}
  const rooms = document.controlRooms
  if (rooms && typeof rooms === 'object' && !Array.isArray(rooms)) {
    for (const [org, entry] of Object.entries(rooms as Record<string, unknown>)) {
      const path = (entry as { path?: unknown } | null)?.path
      if (typeof path === 'string' && path !== '') controlRoom[org] = path
    }
  }

  const root = join(home, '.vegastack', 'factory')
  return {
    repos: entries,
    interval: positiveInteger(document.interval, 'interval', DEFAULTS.interval),
    maxRuns: positiveInteger(document.maxRuns, 'maxRuns', DEFAULTS.maxRuns),
    subagents: {
      spawnDepth: positiveInteger(subagentsRaw.spawnDepth, 'subagents.spawnDepth', DEFAULTS.spawnDepth),
      concurrent: positiveInteger(subagentsRaw.concurrent, 'subagents.concurrent', DEFAULTS.concurrent),
    },
    controlRoom,
    home,
    stateFile: join(root, 'state.json'),
    logRoot: join(root, 'logs'),
    lockRoot: join(root, 'locks'),
    dispatcherLock: join(root, 'dispatcher.lock'),
    // Presence of bootstrap opts into shared registration checks, never into authority. The
    // snapshot/claim owners complete that path; an unavailable registry must not fall back.
    executionMode: document.machine !== undefined || document.executionMode === 'shared' ? 'shared' : 'legacy',
  }
}

export async function loadFactoryConfig(path: string, home: string): Promise<FactoryConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`factory.json: cannot read ${path} — write it before running the dispatcher`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`factory.json: ${path} is not valid JSON — fix it rather than deleting it, the control-room clone paths live there too`)
  }
  // The pre-sync dispatcher supported unversioned local-only configuration. Preserve that
  // format for local work; any policy or enrollment state requires a supported schema.
  const wire = parsed as Record<string, unknown>
  if (wire.schemaVersion !== undefined || wire.controlRooms !== undefined || wire.machine !== undefined) readFactoryConfig(text)
  return { ...parseFactoryConfig(parsed, home), settingsPath: resolve(path) }
}

// Thin adapters preserve the dispatcher shape; all interpretation belongs to the owner helper.
export interface PolicyContext {
  org?: string
  identity?: Record<string, unknown>
  freshness?: Record<string, unknown>
}

export function parseRepoPolicy(text: string): RepoPolicy {
  return mergeRepoPolicy(null, text)
}

export function mergeRepoPolicy(groupMd: string | null, devMd: string, context: PolicyContext = {}): RepoPolicy {
  const resolved = resolvePolicy({ org: context.org ?? '', group: groupMd ?? '', repo: devMd, identity: context.identity, freshness: context.freshness })
  return repoPolicyFromEffective(resolved)
}

export function repoPolicyFromEffective(resolved: ReturnType<typeof resolvePolicy>): RepoPolicy {
  return {
    dispatch: resolved.policy.values.dispatch === 'local' ? 'local' : 'off',
    operators: resolved.policy.values.operators ?? [],
    stages: resolved.policy.values.stages ?? {},
    refusal: resolved.ok ? null : resolved.blocks.join('; '),
    effective: resolved.policy,
    labelMap: resolved.policy.values['workflow-labels'],
  }
}

export function stagePolicy(policy: RepoPolicy, stage: Stage): StagePolicy {
  if (policy.refusal) throw new Error(policy.refusal)
  const name: StageName = stage === 'corrections' ? 'implement' : stage
  const found = policy.stages[name]
  if (!found) throw new Error(`no harness policy for the ${stage} stage — add a ${name} entry to harness-policy: in dev.md`)
  return found
}

import { parsePolicy, resolvePolicy } from '../../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
// The stats record — what one agent run or one interactive session is, as data.
//
// Counts and identifiers only. No prompt text, no assistant text, no tool arguments and no file
// contents ever enter a record: the vendors' transcripts are read for usage totals and tool-call
// counts and for nothing else. A capture path that would need text is a stop condition, not a
// design choice — which is why this file has no free-form string field at all beyond the
// identifiers the org already knows (repo, issue, stage, harness, model, human, session id).
//
// Everything here is pure. The month token is derived from a fixed English table in UTC rather
// than `toLocaleString`, so the file a machine in Bengaluru writes at 02:00 IST on 1 September
// lands in the same month bucket as the one a machine in Berlin writes at 22:30 CEST on 31 August.
// A missing field is `null`, never a guess and never a zero: "no cost reported" and "cost zero"
// are different facts, and a rollup that cannot tell them apart is a rollup nobody can trust.

export type StatsMode = 'headless' | 'interactive'
export type StatsOutcome = 'complete' | 'handback' | 'failed'
export type SkillTrigger = 'model' | 'typed' | 'mention'

export interface SkillInvocation { name: string; trigger: SkillTrigger; harness: string }

export interface StatsTokens {
  in: number | null
  out: number | null
  cache_read: number | null
  cache_write: number | null
}

export interface StatsRecord {
  ts: string
  repo: string
  issue: number | null
  parent: number | null
  stage: string | null
  harness: string | null
  model: string | null
  effort: string | null
  mode: StatsMode | null
  human: string | null
  session_id: string | null
  worktree: string | null
  duration_s: number | null
  turns: number | null
  tool_calls: number | null
  subagents: number | null
  tokens: StatsTokens
  cost_usd: number | null
  outcome: StatsOutcome | null
  review_rounds: number | null
  fix_rounds: number | null
  handbacks: number | null
  skills: SkillInvocation[]
}

// The single home of the serialized key order. `serializeRecord` builds its object field by field
// from this list, so a field added to the interface but not to this list is a type error rather
// than a line that silently changes shape halfway through a month's file.
export const RECORD_FIELDS: readonly (keyof StatsRecord)[] = [
  'ts', 'repo', 'issue', 'parent', 'stage', 'harness', 'model', 'effort', 'mode',
  'human', 'session_id', 'worktree', 'duration_s', 'turns', 'tool_calls', 'subagents',
  'tokens', 'cost_usd', 'outcome', 'review_rounds', 'fix_rounds', 'handbacks', 'skills',
] as const

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const

export function monthToken(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`
}

export function parseMonthToken(token: string): { year: number; month: number } | null {
  const match = /^([A-Z]{3})-(\d{4})$/.exec(typeof token === 'string' ? token : '')
  if (!match) return null
  const month = MONTHS.indexOf(match[1] as (typeof MONTHS)[number])
  if (month < 0) return null
  return { year: Number(match[2]), month: month + 1 }
}

// One path segment, so `stats/<repo>/…` never nests and never collides with a month directory.
export function repoSegment(repo: string): string {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')
}

const NULLABLE_FIELDS: readonly (keyof StatsRecord)[] = RECORD_FIELDS
  .filter(field => field !== 'ts' && field !== 'repo' && field !== 'tokens' && field !== 'skills')

export function normalizeRecord(partial: Partial<StatsRecord> & { repo: string; ts: string }): StatsRecord {
  const tokens = (partial.tokens ?? {}) as Partial<StatsTokens>
  const record = {
    ts: partial.ts,
    repo: partial.repo,
    tokens: {
      in: tokens.in ?? null,
      out: tokens.out ?? null,
      cache_read: tokens.cache_read ?? null,
      cache_write: tokens.cache_write ?? null,
    },
    skills: Array.isArray(partial.skills) ? partial.skills : [],
  } as StatsRecord
  for (const field of NULLABLE_FIELDS) {
    const value = (partial as Record<string, unknown>)[field]
    ;(record as unknown as Record<string, unknown>)[field] = value === undefined ? null : value
  }
  return record
}

// A record that cannot be filed is named, not written: an outbox line with no repo or no timestamp
// is a line no rollup can ever place, and silently dropping it hides the capture bug that made it.
export function recordProblems(record: StatsRecord): string[] {
  const problems: string[] = []
  if (typeof record.repo !== 'string' || record.repo === '') problems.push('repo is empty')
  if (typeof record.ts !== 'string' || !Number.isFinite(Date.parse(record.ts))) {
    problems.push(`ts is not an ISO-8601 timestamp: ${JSON.stringify(record.ts)}`)
  }
  for (const [index, skill] of (record.skills ?? []).entries()) {
    if (!skill || typeof skill.name !== 'string' || skill.name === '') problems.push(`skills[${index}] has no name`)
  }
  return problems
}

export function serializeRecord(record: StatsRecord): string {
  const ordered: Record<string, unknown> = {}
  for (const field of RECORD_FIELDS) ordered[field] = record[field]
  return JSON.stringify(ordered)
}

// --- policy ------------------------------------------------------------------------------

export interface StatsKnobs {
  stats?: 'on' | 'off'
  statsPeople?: 'on' | 'off'
  statsOverride?: 'allowed' | 'locked'
}

// Legacy public shape, parsed by the same owner as runtime and guard policy.
export function parseStatsKnobs(text: string): StatsKnobs {
  const layer = parsePolicy(text, 'repo')
  const values = layer.values as Record<string, unknown>
  const knobs: StatsKnobs = {}
  if (values.stats === 'on' || values.stats === 'off') knobs.stats = values.stats
  if (values['stats-people'] === 'on' || values['stats-people'] === 'off') knobs.statsPeople = values['stats-people']
  if (values['stats-override'] === 'allowed' || values['stats-override'] === 'locked') knobs.statsOverride = values['stats-override']
  return knobs
}

export interface StatsPolicy {
  enabled: boolean
  people: boolean
  source: 'org' | 'group' | 'repo' | 'default'
  refusal: string | null
}

// enabled is the diagnostic effective value. A non-null refusal always blocks capture/export.
export function resolveStatsPolicy(layers: { org?: string; group?: string; repo?: string; identity?: Record<string, unknown>; freshness?: Record<string, unknown> }): StatsPolicy {
  const resolved = resolvePolicy(layers)
  return statsPolicyFromEffective(resolved)
}

export function statsPolicyFromEffective(resolved: ReturnType<typeof resolvePolicy>): StatsPolicy {
  const values = resolved.policy.values
  const enabled = values.stats !== 'off'
  return {
    enabled,
    people: enabled && values['stats-people'] === 'on',
    source: resolved.policy.sources.stats?.scope ?? 'default',
    refusal: resolved.ok ? null : resolved.blocks.join('; '),
  }
}

// The local durable run record is the only terminal capture authority. Vendor stdout
// has already been reduced by #138; hook inputs never supply measurement payloads.
export async function captureTerminalRun(home: string, runId: string, destination: import('./types.ts').Destination, policy: StatsPolicy): Promise<string | null> {
  if (!policy.enabled || policy.refusal) return null
  const { readRun, runsRoot, acknowledgeTerminalCapture } = await import('../runs.ts')
  const { hashBytes, validateDestination } = await import('./types.ts')
  const { enqueueEvent, spoolRoot } = await import('./outbox.ts')
  const run = await readRun(runsRoot(home), runId)
  if (run.state !== 'terminal' || run.waitReason || !run.execution || run.terminationCause === 'termination-unconfirmed' || run.repo !== validateDestination(destination).repo) return null
  const captureKey = `${run.runId}:terminal:0`
  const delivery = run.pendingDelivery.find(p => p.kind === 'telemetry-capture' && 'captureKey' in p.target && p.target.captureKey === captureKey)
  if (!delivery?.payload || !delivery.payloadDigest || hashBytes(delivery.payload) !== delivery.payloadDigest) return null
  const record = parseLocalRecord(JSON.parse(delivery.payload))
  if (recordProblems(record).length || record.repo !== run.repo || record.issue !== run.issue || record.session_id !== (run.vendorSessionId ?? null)) throw Error('terminal-measurement-identity-mismatch')
  const event = await enqueueEvent(spoolRoot(home), {
    schemaVersion: 2, eventId: crypto.randomUUID(), destination, captureKey,
    payload: { schemaVersion: 2, recordKind: 'execution', utcDay: new Date(record.ts).toISOString().slice(0, 10), stage: run.stage, outcome: run.terminationCause ?? 'interrupted', values: JSON.parse(delivery.payload) },
  })
  await acknowledgeTerminalCapture(runsRoot(home), runId, captureKey, delivery.payloadDigest)
  return event.eventId
}

export interface ManagedHookInput { harness: 'claude' | 'codex'; event: 'SessionStart' | 'Stop' | 'SessionEnd'; sessionId: string; turnId?: string; cwd: string; stopHookActive: boolean }
export function parseManagedHook(raw: string): ManagedHookInput | null {
  if (Buffer.byteLength(raw) > 64 * 1024) return null
  try {
    const value = JSON.parse(raw) as ManagedHookInput
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['harness','event','sessionId','turnId','cwd','stopHookActive'].includes(k)) || !['claude','codex'].includes(value.harness) || !['SessionStart','Stop','SessionEnd'].includes(value.event) || typeof value.stopHookActive !== 'boolean') return null
    const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
    if (typeof value.sessionId !== 'string' || !id.test(value.sessionId) || (value.turnId !== undefined && (typeof value.turnId !== 'string' || !id.test(value.turnId))) || typeof value.cwd !== 'string' || !value.cwd.startsWith('/') || value.cwd.length > 4096 || /[\0\r\n]/.test(value.cwd) || value.event === 'Stop' && value.stopHookActive) return null
    return value
  } catch { return null }
}

export async function registeredCaptureContext(home: string, repo: string, checkout: string): Promise<{destination: import('./types.ts').Destination; policy: StatsPolicy; learningEnabled:boolean} | null> {
  const { readFile } = await import('node:fs/promises'), { join, resolve } = await import('node:path')
  const { readPrivateRunFile } = await import('../runs.ts')
  const { parseControlRoomKnob, readFactoryConfig } = await import('../control-room.ts')
  const { validateDestination } = await import('./types.ts')
  const raw = await readPrivateRunFile(join(home,'.vegastack','factory.json'))
  const wire = JSON.parse(raw) as {repos?:Array<{repo:string;path:string;org:string}>}
  const entries = (wire.repos ?? []).filter(entry => entry.repo === repo && typeof entry.path === 'string' && (checkout === resolve(entry.path) || checkout.startsWith(join(resolve(entry.path),'.vegastack','.worktrees') + '/')))
  if (entries.length !== 1) return null
  const devMd = await readFile(join(checkout,'.vegastack','dev.md'),'utf8')
  const knob = parseControlRoomKnob(devMd), factory = readFactoryConfig(raw)
  if (!knob || knob.org !== entries[0]!.org || factory.controlRooms[knob.org]?.repo !== knob.repo) return null
  const { loadConfiguredPolicy } = await import('../../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  const effective = loadConfiguredPolicy({home,repo,devMd})
  const policy = statsPolicyFromEffective(effective)
  if (!effective.ok || !policy.enabled || policy.refusal) return null
  return { destination:validateDestination({host:'github.com',org:knob.org,repo,controlRoom:knob.repo}), policy, learningEnabled:effective.policy.values.learning!=='off' }
}

export async function consumeManagedHook(home: string, raw: string): Promise<{ok:true} | null> {
  const input = parseManagedHook(raw)
  if (!input) return null
  try {
    // Check the private registry before reading any caller-named directory or run payload.
    const { join, resolve } = await import('node:path')
    const { readPrivateRunFile, findOwnedRunSession, runsRoot } = await import('../runs.ts')
    const registry = JSON.parse(await readPrivateRunFile(join(home,'.vegastack','factory.json'))) as {repos?:Array<{path:string}>}
    if (!(registry.repos ?? []).some(entry => typeof entry.path === 'string' && (input.cwd === resolve(entry.path) || input.cwd.startsWith(join(resolve(entry.path),'.vegastack','.worktrees') + '/')))) return null
    const run = await findOwnedRunSession(runsRoot(home),input)
    if (!run || run.harness !== input.harness) return null
    const context = await registeredCaptureContext(home,run.repo,run.checkout)
    if (!context || !context.learningEnabled) return null
    // #144 may later return a verified context pointer. No pointer is invented here.
    if (input.event === 'SessionStart' || run.state !== 'terminal') return null
    return await captureTerminalRun(home,run.runId,context.destination,context.policy) ? {ok:true} : null
  } catch { return null }
}

export function parseLocalRecord(value: unknown): StatsRecord {
  const record=value as StatsRecord
  if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(k=>!RECORD_FIELDS.includes(k as keyof StatsRecord)))throw Error('unknown-local-record-field')
  if(recordProblems(record).length||!record.tokens||Object.keys(record.tokens).some(k=>!['in','out','cache_read','cache_write'].includes(k))||Object.values(record.tokens).some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0)))throw Error('invalid-local-record')
  for(const key of ['issue','parent','duration_s','turns','tool_calls','subagents','cost_usd','review_rounds','fix_rounds','handbacks'] as const){const v=record[key];if(v!==null&&v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||v<0))throw Error('invalid-local-number')}
  for(const key of ['stage','harness','model','effort','mode','human','session_id','worktree','outcome'] as const){const v=record[key];if(v!==null&&v!==undefined&&(typeof v!=='string'||v.length>4096||/[\r\n\0]/.test(v)))throw Error('invalid-local-identifier')}
  if(!Array.isArray(record.skills)||record.skills.some(s=>!s||Object.keys(s).sort().join(',')!=='harness,name,trigger'||!['model','typed','mention'].includes(s.trigger)||typeof s.name!=='string'||typeof s.harness!=='string'||s.name.length>128||s.harness.length>128))throw Error('invalid-local-skills')
  return normalizeRecord(record)
}

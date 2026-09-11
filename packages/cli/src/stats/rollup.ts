// The rollups — three summary documents regenerated from the month's records, never appended to.
//
// Regeneration is the whole design: a summary that accumulated would drift the first time a record
// arrived late from a machine that was offline, and there would be no way to tell a stale total
// from a real one. Rolling the month up from its files every time makes the summary a pure
// function of the records, so two runs on the same input produce the same bytes.
//
// That is also why nothing here stamps a generation time and why `stableStringify` sorts every key:
// a timestamp would make every regeneration a diff, and a control room whose summaries change on
// every push teaches everyone to stop reading the diffs.
//
// One division of labour worth keeping straight: durations, tokens, cost, outcomes and rework come
// from the records, while lead and cycle time come from the issues' label timelines. A run does not
// know how long its issue waited for a human, and no amount of per-run capture can tell you.

import { parseMonthToken, type StatsRecord } from './record.ts'

export interface TimelineEvent {
  issue: number
  event: string
  label: string | null
  created_at: string
}

export interface StageStats {
  runs: number
  duration_s: number
  tokens: number
  cost_usd: number
  outcomes: Record<string, number>
}

export interface Pct { p50: number | null; p90: number | null }

export interface RepoSummary {
  schemaVersion: 1
  repo: string
  month: string
  runs: number
  by_stage: Record<string, StageStats>
  // Null when no record in the month measured it: "no review rounds were captured" and "there
  // were no review rounds" are different facts, and a summary that printed 0 for both would be
  // read as the second.
  rework: { review_rounds: number | null; fix_rounds: number | null; handbacks: number | null; runs_with_rework: number }
  throughput: { issues_touched: number; issues_closed: number }
  lead_time_h: Pct
  cycle_time_h: Record<string, Pct>
  people: Record<string, StageStats> | null
}

export interface OrgSummary {
  schemaVersion: 1
  month: string
  repos: string[]
  runs: number
  by_stage: Record<string, StageStats>
  cost_usd: number
  people: Record<string, StageStats> | null
}

export interface SkillsSummary {
  schemaVersion: 1
  month: string
  skills: Record<string, {
    invocations: number
    by_trigger: Record<string, number>
    by_harness: Record<string, number>
    outcomes: Record<string, number>
  }>
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

// Nearest-rank on a sorted series, and `null` rather than a made-up zero for an empty one: "no
// issue finished this month" and "issues finished instantly" must not print the same.
function percentiles(series: number[]): Pct {
  if (series.length === 0) return { p50: null, p90: null }
  const sorted = [...series].sort((a, b) => a - b)
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!
  return { p50: at(0.5), p90: at(0.9) }
}

function emptyStage(): StageStats {
  return { runs: 0, duration_s: 0, tokens: 0, cost_usd: 0, outcomes: {} }
}

function tokensOf(record: StatsRecord): number {
  const { in: input, out, cache_read: cacheRead, cache_write: cacheWrite } = record.tokens
  return (input ?? 0) + (out ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
}

function addRecord(bucket: StageStats, record: StatsRecord): void {
  bucket.runs += 1
  bucket.duration_s += record.duration_s ?? 0
  bucket.tokens += tokensOf(record)
  bucket.cost_usd = Number((bucket.cost_usd + (record.cost_usd ?? 0)).toFixed(6))
  if (record.outcome) bucket.outcomes[record.outcome] = (bucket.outcomes[record.outcome] ?? 0) + 1
}

function mergeStage(into: StageStats, from: StageStats): void {
  into.runs += from.runs
  into.duration_s += from.duration_s
  into.tokens += from.tokens
  into.cost_usd = Number((into.cost_usd + from.cost_usd).toFixed(6))
  for (const [outcome, count] of Object.entries(from.outcomes)) {
    into.outcomes[outcome] = (into.outcomes[outcome] ?? 0) + count
  }
}

function hours(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return (to - from) / 3_600_000
}

// Cycle time per state label: how long each issue actually sat in `ready`, in `working`, in
// `for-operator`. A label still on the issue at month end contributes nothing rather than being
// closed off at an arbitrary "now" — a rollup that used the clock would not be reproducible.
function cycleTimes(timelines: TimelineEvent[]): Record<string, Pct> {
  const open = new Map<string, string>()
  const series = new Map<string, number[]>()
  for (const event of [...timelines].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (!event.label) continue
    const key = `${event.issue}:${event.label}`
    if (event.event === 'labeled') open.set(key, event.created_at)
    else if (event.event === 'unlabeled') {
      const since = open.get(key)
      if (since === undefined) continue
      open.delete(key)
      const span = hours(since, event.created_at)
      if (span === null) continue
      const list = series.get(event.label) ?? []
      list.push(span)
      series.set(event.label, list)
    }
  }
  const out: Record<string, Pct> = {}
  for (const label of [...series.keys()].sort()) out[label] = percentiles(series.get(label)!)
  return out
}

function leadTimes(timelines: TimelineEvent[], month?:string): { pct: Pct; closed: number } {
  const created = new Map<number, string>()
  const spans: number[] = []
  let closed = 0
  const counted=new Set<number>()
  for (const event of [...timelines].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (event.event === 'created') created.set(event.issue, event.created_at)
    else if (event.event === 'closed') {
      if(counted.has(event.issue)||month&&!inMonth(event.created_at,month))continue
      counted.add(event.issue)
      closed += 1
      const at = created.get(event.issue)
      if (at === undefined) continue
      const span = hours(at, event.created_at)
      if (span !== null) spans.push(span)
    }
  }
  return { pct: percentiles(spans), closed }
}

// Rework rounds are an issue's, not a run's: every run on an issue reads the same ledger, so the
// month's total takes each issue's highest reading once rather than summing it per run. A record
// with no issue stands alone. Null when nothing in the month measured the field at all.
function reworkTotal(records: StatsRecord[], field: 'review_rounds' | 'fix_rounds' | 'handbacks'): number | null {
  const perIssue = new Map<string, number>()
  let measured = false
  records.forEach((record, index) => {
    const value = record[field]
    if (value === null || value === undefined) return
    measured = true
    const key = record.issue === null ? `run:${index}` : `issue:${record.issue}`
    perIssue.set(key, Math.max(perIssue.get(key) ?? 0, value))
  })
  if (!measured) return null
  let total = 0
  for (const value of perIssue.values()) total += value
  return total
}

export function rollupRepo(
  records: StatsRecord[],
  timelines: TimelineEvent[],
  options: { repo: string; month: string; people: boolean },
): RepoSummary {
  const byStage: Record<string, StageStats> = {}
  const byPerson: Record<string, StageStats> = {}
  const issues = new Set<number>()
  let runsWithRework = 0

  for (const record of records) {
    const stage = record.stage ?? 'unknown'
    byStage[stage] = byStage[stage] ?? emptyStage()
    addRecord(byStage[stage]!, record)
    const person = record.human ?? 'unknown'
    byPerson[person] = byPerson[person] ?? emptyStage()
    addRecord(byPerson[person]!, record)
    if (record.issue !== null) issues.add(record.issue)
    if ((record.review_rounds ?? 0) + (record.fix_rounds ?? 0) + (record.handbacks ?? 0) > 0) runsWithRework += 1
  }

  const parsedMonth=parseMonthToken(options.month)
  const metricMonth=parsedMonth?`${parsedMonth.year}-${String(parsedMonth.month).padStart(2,'0')}`:/^\d{4}-\d{2}$/.test(options.month)?options.month:undefined
  const lead = leadTimes(timelines,metricMonth)
  return {
    schemaVersion: 1,
    repo: options.repo,
    month: options.month,
    runs: records.length,
    by_stage: byStage,
    rework: {
      review_rounds: reworkTotal(records, 'review_rounds'),
      fix_rounds: reworkTotal(records, 'fix_rounds'),
      handbacks: reworkTotal(records, 'handbacks'),
      runs_with_rework: runsWithRework,
    },
    throughput: { issues_touched: issues.size, issues_closed: lead.closed },
    lead_time_h: lead.pct,
    cycle_time_h: cycleTimes(timelines),
    people: options.people ? byPerson : null,
  }
}

export function rollupOrg(summaries: RepoSummary[], options: { month: string; people: boolean }): OrgSummary {
  const byStage: Record<string, StageStats> = {}
  const byPerson: Record<string, StageStats> = {}
  let runs = 0
  let cost = 0
  for (const summary of summaries) {
    runs += summary.runs
    for (const [stage, stats] of Object.entries(summary.by_stage)) {
      byStage[stage] = byStage[stage] ?? emptyStage()
      mergeStage(byStage[stage]!, stats)
      cost = Number((cost + stats.cost_usd).toFixed(6))
    }
    for (const [person, stats] of Object.entries(summary.people ?? {})) {
      byPerson[person] = byPerson[person] ?? emptyStage()
      mergeStage(byPerson[person]!, stats)
    }
  }
  return {
    schemaVersion: 1,
    month: options.month,
    repos: summaries.map(summary => summary.repo).sort(),
    runs,
    by_stage: byStage,
    cost_usd: cost,
    people: options.people ? byPerson : null,
  }
}

export function rollupSkills(records: StatsRecord[], options: { month: string }): SkillsSummary {
  const skills: SkillsSummary['skills'] = {}
  for (const record of records) {
    for (const invocation of record.skills ?? []) {
      const entry = skills[invocation.name] ?? { invocations: 0, by_trigger: {}, by_harness: {}, outcomes: {} }
      entry.invocations += 1
      entry.by_trigger[invocation.trigger] = (entry.by_trigger[invocation.trigger] ?? 0) + 1
      entry.by_harness[invocation.harness] = (entry.by_harness[invocation.harness] ?? 0) + 1
      // The outcome is the *run's*, not the skill's: a skill invoked in a run that handed back is
      // evidence about the run, and the summary says so rather than implying the skill failed.
      if (record.outcome) entry.outcomes[record.outcome] = (entry.outcomes[record.outcome] ?? 0) + 1
      skills[invocation.name] = entry
    }
  }
  return { schemaVersion: 1, month: options.month, skills }
}

// Transport identity is resolved before #148's metric definitions see any measurements.
export { readEventBatch as readMeasurementEvents } from './types.ts'

export async function readControlRoomEvents(root:string,reader?:import('./types.ts').ExportReader):Promise<import('./types.ts').EventBatch> {
  const {readdir,readFile,lstat}=await import('node:fs/promises'),{join}=await import('node:path')
  const inputs:Array<{source:string;bytes:string}>=[]
  const walk=async(dir:string):Promise<void>=>{
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    for(const entry of entries){
      if(entry.isSymbolicLink())continue
      const path=join(dir,entry.name)
      if(entry.isDirectory())await walk(path)
      else if(entry.isFile()&&dir.endsWith('/events')&&entry.name.endsWith('.json')){
        const info=await lstat(path);if(info.size>1024*1024)throw Error('export-event-too-large')
        inputs.push({source:path,bytes:await readFile(path,'utf8')})
      }
    }
  }
  await walk(join(root,'stats'))
  return(await import('./types.ts')).readEventBatch(inputs,reader)
}

import { inMonth, summarizeExecutions, summarizeIssueMonth, type SubscriptionFee } from './metrics.ts'
import type { ExportedEvent } from './types.ts'
import type { TaskActivityCollection } from './timeline.ts'
export interface MeasuredRepoSummary {
  schemaVersion:2
  metricVersion:2
  repo:string
  month:string
  runs:number
  execution:ReturnType<typeof summarizeExecutions>
  byStage:Record<string,ReturnType<typeof summarizeExecutions>>
  taskActivity:ReturnType<typeof summarizeIssueMonth>
  discovery:{complete:boolean;reason:string|null;observedAt:string|null;sourceDigest:string|null}
  legacy:RepoSummary|null
}
export function rollupMeasuredRepo(events:ExportedEvent[],options:{repo:string;month:string;collection?:TaskActivityCollection|null;subscriptionFee?:SubscriptionFee|null;legacy?:StatsRecord[];person?:boolean}):MeasuredRepoSummary {
  const scoped=events.filter(e=>e.destination.repo===options.repo)
  const execution=summarizeExecutions(scoped.filter(e=>e.payload.utcDay.slice(0,7)===options.month),options.subscriptionFee)
  const activities=scoped.flatMap(e=>e.payload.recordKind==='activity'&&e.payload.activity?[e.payload.activity]:[])
  const snapshots=scoped.flatMap(e=>e.payload.recordKind==='rework-snapshot'&&e.payload.reworkSnapshot?[e.payload.reworkSnapshot]:[])
  const c=options.collection
  const byStage:MeasuredRepoSummary['byStage']={}
  for(const stage of new Set(scoped.filter(e=>e.payload.recordKind==='execution'&&e.payload.utcDay.slice(0,7)===options.month).map(e=>e.payload.recordKind==='execution'?e.payload.stage:'unknown')))byStage[stage]=summarizeExecutions(scoped.filter(e=>e.payload.recordKind==='execution'&&e.payload.stage===stage&&e.payload.utcDay.slice(0,7)===options.month))
  const taskActivity=summarizeIssueMonth([...activities,...(c?.activities??[])],options.month,{complete:c?.complete??(options.person===true&&(activities.length>0||snapshots.length>0)),snapshots:[...snapshots,...(c?.snapshots??[])]})
  return {schemaVersion:2,metricVersion:2,repo:options.repo,month:options.month,runs:execution.executionEvents,execution,byStage,taskActivity,discovery:{complete:c?.complete??false,reason:c?.reason??'activity-source-unavailable',observedAt:c?.observedAt??null,sourceDigest:c?.sourceDigest??null},legacy:options.legacy?.length?rollupRepo(options.legacy,[],{repo:options.repo,month:options.month,people:false}):null}
}

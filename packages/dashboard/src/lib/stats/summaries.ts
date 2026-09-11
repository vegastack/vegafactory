import { join } from 'node:path'

import { readOrNull } from '../read'

// The rollup documents #121 writes — `stats rollup` in packages/cli/src/stats/rollup.ts — read
// as they are written. The shape is re-declared here rather than imported because the dashboard
// ships as its own tarball, and it is held to the writer by test: the CLI's fixture summaries are
// the writer's bytes, and test/summaries.test.ts reads those same files through these functions.

export interface Pct {
  p50: number | null
  p90: number | null
}

export interface Summary {
  scope: string
  metricVersion?: 1 | 2
  definitionLabel?: string
  mergedIssues?: number | null
  mergedTasks?: number | null
  implementedTasks?: number | null
  releasedTasks?: number | null
  operatorMinutes?: number | null
  coverage?: Record<string, unknown>
  discovery?: {complete:boolean;observedAt:string|null;reason:string|null}
  month: string
  runs: number | null
  /** Repo-wide, hours from issue creation to close; null when no issue closed this month. */
  leadTimeH: Pct
  /** Hours each issue sat in a workflow state label — `ready`, `working`, `for-operator` — keyed by label. */
  cycleTimeH: Record<string, Pct>
  rework: { reviewRounds: number | null; fixRounds: number | null; handbacks: number | null }
  throughput: { issuesTouched: number | null; issuesClosed: number | null }
  /** Org summaries carry the month's cost; repo summaries carry it per stage and not at the top. */
  costUsd: number | null
  /**
   * Dotted keys this document did not carry, among the ones its kind is written with. A field
   * the reader cannot find is named here and rendered as "not in the rollup" rather than
   * defaulted to zero, which would read as a measured result.
   */
  missing: string[]
}

export type SummaryKind = 'repo' | 'org'

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const asObject = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

function field(row: Record<string, unknown>, key: string, dotted: string, missing: string[]): number | null {
  const value = asNumber(row[key])
  if (value === null) missing.push(dotted)
  return value
}

const pct = (value: unknown): Pct => ({ p50: asNumber(asObject(value).p50), p90: asNumber(asObject(value).p90) })

// The same transform the CLI's `repoSegment` applies: one path segment per repo, so the summary
// sits at `stats/<owner>__<name>/<MON-YYYY>.summary.json` and never nests under a month.
export function repoSegment(repo: string): string {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')
}

const EMPTY_PCT: Pct = { p50: null, p90: null }

// Read field by field, never destructured against a declared shape: a summary #121 widens keeps
// rendering, and a summary that is missing something says which thing. A repo document is asked
// for lead and cycle time, rework and throughput; an org document for its cost — never the other
// way round, so the banner names only what the writer is supposed to have put there.
export function parseSummary(kind: SummaryKind, scope: string, month: string, text: string): Summary {
  const empty: Summary = {
    scope, month, metricVersion:1,definitionLabel:'legacy definitions',runs: null, leadTimeH: EMPTY_PCT, cycleTimeH: {},
    rework: { reviewRounds: null, fixRounds: null, handbacks: null },
    throughput: { issuesTouched: null, issuesClosed: null },
    costUsd: null, missing: ['document'],
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const document = parsed as Record<string, unknown>
  if(document.schemaVersion===2&&document.metricVersion===2){
    const execution=asObject(document.execution),values=asObject(execution.values),activity=asObject(document.taskActivity),discovery=asObject(document.discovery)
    return {...empty,metricVersion:2,definitionLabel:'metric v2',runs:asNumber(execution.executionEvents),costUsd:asNumber(asObject(values.costUsd).value),operatorMinutes:asNumber(asObject(execution.operatorMinutes).value),coverage:values,rework:{reviewRounds:asNumber(activity.reviewRounds),fixRounds:asNumber(activity.fixRounds),handbacks:asNumber(activity.handbacks)},mergedIssues:asNumber(activity.mergedIssues),mergedTasks:asNumber(activity.mergedTasks),implementedTasks:asNumber(activity.implementedTasks),releasedTasks:asNumber(activity.releasedTasks),discovery:{complete:discovery.complete===true,observedAt:typeof discovery.observedAt==='string'?discovery.observedAt:null,reason:typeof discovery.reason==='string'?discovery.reason:null},missing:discovery.complete===true?[]:['task source coverage']}
  }
  const missing: string[] = []
  const runs = field(document, 'runs', 'runs', missing)

  if (kind === 'org') {
    return { ...empty, runs, costUsd: field(document, 'cost_usd', 'cost_usd', missing), missing }
  }

  const cycleTimeH: Record<string, Pct> = {}
  for (const [label, value] of Object.entries(asObject(document.cycle_time_h))) cycleTimeH[label] = pct(value)
  const reworkRow = asObject(document.rework)
  const throughputRow = asObject(document.throughput)
  return {
    scope,
    month,
    metricVersion:1,definitionLabel:'legacy definitions',
    runs,
    // Lead time p50/p90 are null in the writer's own output for a month with no closed issue, so
    // a null here is a reading, not a gap; only a missing `lead_time_h` block would be one.
    leadTimeH: pct(document.lead_time_h),
    cycleTimeH,
    rework: {
      reviewRounds: field(reworkRow, 'review_rounds', 'rework.review_rounds', missing),
      fixRounds: field(reworkRow, 'fix_rounds', 'rework.fix_rounds', missing),
      handbacks: field(reworkRow, 'handbacks', 'rework.handbacks', missing),
    },
    throughput: {
      issuesTouched: field(throughputRow, 'issues_touched', 'throughput.issues_touched', missing),
      issuesClosed: field(throughputRow, 'issues_closed', 'throughput.issues_closed', missing),
    },
    costUsd: null,
    missing,
  }
}

export async function readRepoSummary(controlRoom: string, repo: string, month: string): Promise<Summary | null> {
  const text = await readOrNull(join(controlRoom, 'stats', repoSegment(repo), `${month}.summary.json`))
  return text === null ? null : parseSummary('repo', repo, month, text)
}

export async function readOrgSummary(controlRoom: string, month: string): Promise<Summary | null> {
  const text = await readOrNull(join(controlRoom, 'stats', 'org', `${month}.summary.json`))
  return text === null ? null : parseSummary('org', 'org', month, text)
}

// The org skills rollup is `{ schemaVersion, month, skills: { <name>: { invocations, by_trigger,
// by_harness, outcomes } } }`; the skills view wants the invocation count per name. A document
// with no `skills` object is null — the same signal as a file the clone does not carry — never a
// half rollup that renders every skill as absent.
export async function readOrgSkills(controlRoom: string, month: string): Promise<Record<string, number> | null> {
  const text = await readOrNull(join(controlRoom, 'stats', 'org', `${month}.skills.json`))
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const skills = asObject(parsed).skills
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return null
  const rollup: Record<string, number> = {}
  for (const [name, entry] of Object.entries(skills as Record<string, unknown>)) {
    const count = asNumber(asObject(entry).invocations)
    if (count !== null) rollup[name] = count
  }
  return rollup
}

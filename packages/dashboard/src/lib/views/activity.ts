import { summarizeExecutions, summarizeMeasured, type MetricValue } from '../../../../cli/src/stats/metrics'
import type { ExportedEvent, TaskActivity } from '../../../../cli/src/stats/types'
import { cachedExecutionEvents } from '../cache/queries'
import type { PageContext } from '../context'
import type { Live } from '../live/github'
import type { DurableRecoverySummary, SharedTaskStatus, StatusReport, StatusRun } from '../live/status'
import { authorizedReportFilters, type ViewState } from './performance'

export interface ActivityHistory {
  coverage: 'complete' | 'partial' | 'unsupported' | 'unavailable' | 'bounded'
  events: NonNullable<SharedTaskStatus['history']>['events']
}

export interface ActivityRow {
  repo: string
  issue: number
  taskId: string | null
  taskOwner: string | null
  agentAccountOwner: string | null
  terminalSegments: number
  attempts: number | null
  unknownExecutionIdentity: number
  runtimeSeconds: number | null
  runtimeCoverage: MetricValue
  outcomes: Record<string, number>
  activities: Record<TaskActivity['kind'], number>
  latestActivity: TaskActivity['kind'] | null
  implementedAt: string | null
  mergedAt: string | null
  releasedAt: string | null
  sharedState: string | null
  currentMachine: string | null
  originMachine: string | null
  lastObservedAt: string | null
  checkpoint: SharedTaskStatus['checkpoint']
  history: ActivityHistory
  recovery: DurableRecoverySummary | null
  pendingDelivery: number | null
  terminationCause: string | null
  remoteObservation: 'fresh' | 'stale' | 'unavailable' | null
}

export interface ActivityView {
  month: string
  state: ViewState
  rows: ActivityRow[]
}

interface ActivitySqlRow {
  repo: string
  issue: number
  task_id: string | null
  activity_id: string
  kind: TaskActivity['kind']
  occurred_at: string
  task_owner: string | null
  agent_account_owner: string | null
  payload_json: string
}

interface PendingRow {
  repo: string
  issue: number
  taskIds: Set<string>
  taskOwners: Set<string>
  accountOwners: Set<string>
  executions: ExportedEvent[]
  activities: Array<{ value: TaskActivity; taskOwner: string | null; accountOwner: string | null }>
  shared: SharedTaskStatus | null
  runs: StatusRun[]
  remoteObservation: ActivityRow['remoteObservation']
  conflict: boolean
}

const period = (month: string): string => {
  const names = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const match = /^([A-Z]{3})-(\d{4})$/.exec(month)
  return match ? `${match[2]}-${String(names.indexOf(match[1]!) + 1).padStart(2, '0')}` : month
}

const owner = (values: Set<string>): string | null => values.size === 1 ? [...values][0]! : null
const taskKey = (repo: string, issue: number): string => `${repo}\0${issue}`
const freshPending = (repo: string, issue: number): PendingRow => ({
  repo, issue, taskIds: new Set(), taskOwners: new Set(), accountOwners: new Set(),
  executions: [], activities: [], shared: null, runs: [], remoteObservation: null, conflict: false,
})

function latestRun(runs: StatusRun[]): StatusRun | null {
  return [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).at(-1) ?? null
}

function reportRow(row: PendingRow): ActivityRow {
  const execution = summarizeExecutions(row.executions)
  const durations = summarizeMeasured(row.executions.map(event => event.payload.recordKind === 'execution' ? event.payload.durationSeconds ?? null : null))
  const runtimeCoverage: MetricValue = {
    value: durations.total,
    known: durations.known,
    unknown: durations.unknown,
    availability: durations.known === 0 ? 'unavailable' : durations.unknown ? 'partial' : 'available',
    definitionVersion: 2,
  }
  const attempts = new Set<string>()
  for (const event of row.executions) if (event.payload.recordKind === 'execution' && event.payload.executionRef) attempts.add(`${event.payload.executionRef}:${event.payload.attempt ?? 1}`)
  const activityCounts: ActivityRow['activities'] = { implemented: 0, merged: 0, released: 0, review: 0, fix: 0, handback: 0 }
  const latestByKind = new Map<TaskActivity['kind'], string>()
  let latest: TaskActivity | null = null
  for (const { value } of row.activities) {
    activityCounts[value.kind]++
    const prior = latestByKind.get(value.kind)
    if (!prior || Date.parse(value.occurredAt) > Date.parse(prior)) latestByKind.set(value.kind, value.occurredAt)
    if (!latest || Date.parse(value.occurredAt) > Date.parse(latest.occurredAt)) latest = value
  }
  const run = latestRun(row.runs)
  const deliveries = row.runs.map(value => value.pendingDelivery).filter((value): value is number => value !== null && value !== undefined)
  return {
    repo: row.repo,
    issue: row.issue,
    taskId: row.taskIds.size === 1 ? [...row.taskIds][0]! : null,
    taskOwner: owner(row.taskOwners),
    agentAccountOwner: owner(row.accountOwners),
    terminalSegments: execution.executionEvents,
    attempts: execution.executionEvents === 0 || execution.unknownExecutionIdentity > 0 ? null : attempts.size,
    unknownExecutionIdentity: execution.unknownExecutionIdentity,
    runtimeSeconds: durations.total,
    runtimeCoverage,
    outcomes: execution.outcomes,
    activities: activityCounts,
    latestActivity: latest?.kind ?? null,
    implementedAt: latestByKind.get('implemented') ?? null,
    mergedAt: latestByKind.get('merged') ?? null,
    releasedAt: latestByKind.get('released') ?? null,
    sharedState: row.conflict ? null : row.shared?.state ?? run?.state ?? null,
    currentMachine: row.conflict ? null : row.shared?.machineId ?? null,
    originMachine: row.conflict ? null : row.shared?.originMachineId ?? null,
    lastObservedAt: row.conflict ? null : row.shared?.lastTransitionObservedAt ?? null,
    checkpoint: row.conflict ? null : row.shared?.checkpoint ?? null,
    history: row.conflict || !row.shared?.history
      ? { coverage: 'unavailable', events: [] }
      : { coverage: row.shared.history.coverage, events: row.shared.history.events },
    recovery: run?.recovery ?? null,
    pendingDelivery: row.runs.length === 0 || deliveries.length !== row.runs.length
      ? null
      : deliveries.reduce((sum, value) => sum + value, 0),
    terminationCause: run?.terminationCause ?? null,
    remoteObservation: row.remoteObservation,
  }
}

export function buildActivityView(context: PageContext, status: Live<StatusReport>): ActivityView {
  const filters = authorizedReportFilters(context, true)
  const allowed = filters.allowedRepos ?? []
  if (!Array.isArray(allowed) || allowed.length === 0) {
    const stale = `${context.freshness.label} ${context.policy.refusal ?? ''} ${context.knowledgeWarning ?? ''}`.toLowerCase().includes('stale')
    return { month: filters.month, state: { availability: 'unavailable', stale, partial: false, reasons: ['Current verified attributed-reporting policy grants no task activity scope.'] }, rows: [] }
  }
  const inScope = (repo: string) => allowed.includes(repo)
    && (!filters.group || filters.repos.includes(repo))
    && (!filters.repo || filters.repo === repo)
  const access = context.access ?? filters.access
  const matchesOwner = (row: { task_owner: string | null; agent_account_owner: string | null }) => access?.kind !== 'person'
    || (access.dimension === 'task-owner' ? row.task_owner : row.agent_account_owner) === access.subject
  try {
    const rows = new Map<string, PendingRow>()
    const get = (repo: string, issue: number) => {
      const key = taskKey(repo, issue)
      const value = rows.get(key) ?? freshPending(repo, issue)
      rows.set(key, value)
      return value
    }
    const person = access?.kind === 'person' ? { login: access.subject, dimension: access.dimension } : undefined
    const executions = cachedExecutionEvents(context.db, filters, person)
    for (const event of executions) {
      const payload = event.payload
      if (payload.recordKind !== 'execution' || !payload.taskRef || typeof payload.taskRef === 'string' || !inScope(event.destination.repo)) continue
      if (access?.kind === 'person' && (access.dimension === 'task-owner' ? payload.taskOwner : payload.agentAccountOwner) !== access.subject) continue
      const row = get(event.destination.repo, payload.taskRef.issue)
      if (payload.taskRef.taskId) row.taskIds.add(payload.taskRef.taskId)
      if (payload.taskOwner) row.taskOwners.add(payload.taskOwner)
      if (payload.agentAccountOwner) row.accountOwners.add(payload.agentAccountOwner)
      row.executions.push(event)
    }
    const activities = context.db.query<ActivitySqlRow>('select repo,issue,task_id,activity_id,kind,occurred_at,task_owner,agent_account_owner,payload_json from activity_measurements').all()
      .filter(row => inScope(row.repo) && row.occurred_at.slice(0, 7) === period(filters.month) && matchesOwner(row))
    const uniqueActivities = new Map<string, ActivitySqlRow>()
    for (const activity of activities) {
      const key = `${activity.repo}\0${activity.issue}\0${activity.activity_id}`
      const prior = uniqueActivities.get(key)
      if (!prior || (prior.task_owner === null && activity.task_owner !== null) || (prior.agent_account_owner === null && activity.agent_account_owner !== null)) uniqueActivities.set(key, activity)
    }
    for (const activity of uniqueActivities.values()) {
      const value = JSON.parse(activity.payload_json) as TaskActivity
      const row = get(activity.repo, activity.issue)
      if (activity.task_id) row.taskIds.add(activity.task_id)
      if (activity.task_owner) row.taskOwners.add(activity.task_owner)
      if (activity.agent_account_owner) row.accountOwners.add(activity.agent_account_owner)
      row.activities.push({ value, taskOwner: activity.task_owner, accountOwner: activity.agent_account_owner })
    }

    let remoteStale = false
    let remoteUnavailable = false
    let sharedUnavailable = false
    if (status.ok) for (const repo of status.data.repos.filter(value => inScope(value.repo))) {
      const observation: ActivityRow['remoteObservation'] = repo.snapshot?.state === 'fresh' || repo.snapshot?.state === 'stale' || repo.snapshot?.state === 'unavailable'
        ? repo.snapshot.state
        : null
      if (observation === 'stale') remoteStale = true
      if (observation === 'unavailable') remoteUnavailable = true
      if (!repo.shared || repo.shared.refusal !== null) sharedUnavailable = true
      if (access?.kind !== 'person') for (const task of repo.shared?.tasks ?? []) {
        const row = get(repo.repo, task.issue)
        if (row.shared && row.shared.taskKey !== task.taskKey) row.conflict = true
        else row.shared = task
        row.remoteObservation = observation
      }
      for (const run of repo.runs) if (run.issue !== null && (access?.kind !== 'person' || rows.has(taskKey(repo.repo, run.issue)))) {
        const row = get(repo.repo, run.issue)
        row.runs.push(run)
        row.remoteObservation = observation
      }
    }

    const collectionRows = context.db.query<{ repo: string; period: string; payload_json: string }>('select repo,period,payload_json from activity_collections').all()
      .filter(row => inScope(row.repo) && row.period === period(filters.month))
    const completeRepos = new Set(collectionRows.filter(row => {
      try { return (JSON.parse(row.payload_json) as { complete?: unknown }).complete === true } catch { return false }
    }).map(row => row.repo))
    const requiredRepos = allowed.filter(inScope)
    const activityComplete = access?.kind === 'person' || requiredRepos.every(repo => completeRepos.has(repo))
    const result = [...rows.values()].map(reportRow).sort((a, b) => a.repo.localeCompare(b.repo) || a.issue - b.issue)
    const historyPartial = result.some(row => row.sharedState !== null && row.history.coverage !== 'complete')
    const reasons: string[] = []
    if (!activityComplete) reasons.push('Task activity collection is incomplete for part of the selected scope.')
    if (!status.ok) reasons.push('Current dispatcher and shared-ownership status is unavailable; cached activity remains visible.')
    if (remoteUnavailable) reasons.push('A remote policy observation is unavailable; machine state is not inferred.')
    if (sharedUnavailable) reasons.push('Shared task ownership is unavailable for part of the selected scope.')
    if (historyPartial) reasons.push('Shared ownership history is unavailable, partial, bounded, or unsupported for one or more tasks.')
    if (rows.size && result.some(row => row.taskOwner === null || row.agentAccountOwner === null)) reasons.push('One or more task or agent-account owners are unknown.')
    if (remoteStale) reasons.push('One or more remote policy observations are stale; offline machines are not treated as idle.')
    const partial = !activityComplete || !status.ok || historyPartial || remoteStale || remoteUnavailable || sharedUnavailable
    const availability: ViewState['availability'] = result.length ? 'ready' : activityComplete ? 'empty' : status.ok ? 'empty' : 'unavailable'
    if (availability === 'empty') reasons.push('No task activity is recorded for this month and filter.')
    return {
      month: filters.month,
      rows: result,
      state: {
        availability,
        stale: remoteStale || `${context.freshness.label} ${context.policy.refusal ?? ''}`.toLowerCase().includes('stale'),
        partial,
        reasons,
      },
    }
  } catch {
    return { month: filters.month, state: { availability: 'failed', stale: false, partial: false, reasons: ['The cached activity report could not be read. Refresh after the local data source is available.'] }, rows: [] }
  }
}

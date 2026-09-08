import type { Filters } from '../cache/filters'
import { cachedExecutionEvents, orgTotals, perIssue, perRepo, perStage, type Totals } from '../cache/queries'
import type { PageContext } from '../context'

export interface ViewState {
  availability: 'loading' | 'ready' | 'empty' | 'failed' | 'unavailable'
  stale: boolean
  partial: boolean
  reasons: string[]
}

export interface PerformanceView {
  month: string
  state: ViewState
  totals: Totals | null
  repos: ReturnType<typeof perRepo>
  stages: ReturnType<typeof perStage>
  issues: ReturnType<typeof perIssue>
  unlinkedExecutions: number | null
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Re-establish the report boundary even for direct adapter callers. Production context always
 * carries `allowedRepos`; an omitted policy scope falls back to the already-denying filter scope.
 */
export function authorizedReportFilters(context: PageContext, attributedOnly = false): Filters {
  const policyAllowed = context.allowedRepos !== undefined
    ? context.allowedRepos
    : context.filters.allowedRepos === undefined ? [] : context.filters.allowedRepos
  const allowed = policyAllowed === null ? null : unique(policyAllowed)
  const permitted = (repo: string) => allowed === null || allowed.includes(repo)
  const refuse = context.policy.refusal !== null && context.policy.refusal !== undefined
  const invalidRepoSelection = context.filters.repo !== null && !permitted(context.filters.repo)
  const selected = context.filters.repo
    ? (permitted(context.filters.repo) ? [context.filters.repo] : [])
    : context.filters.group
      ? (allowed ?? Object.keys(context.repoGroups)).filter(repo => context.repoGroups[repo] === context.filters.group)
      : []
  const narrowed = context.filters.repo !== null || context.filters.group !== null
  const attributed = unique((context.filters.attributedRepos ?? [])
    .filter(permitted)
    .filter(repo => !narrowed || selected.includes(repo)))
  return {
    ...context.filters,
    allowedRepos: refuse || invalidRepoSelection ? [] : attributedOnly ? attributed : allowed,
    attributedRepos: refuse || invalidRepoSelection ? [] : attributed,
    repos: refuse || invalidRepoSelection ? [] : selected,
  }
}

function staleContext(context: PageContext): boolean {
  return `${context.freshness.label} ${context.policy.refusal ?? ''} ${context.knowledgeWarning ?? ''}`.toLowerCase().includes('stale')
}

const noScopeState = (context: PageContext): ViewState => ({
  availability: 'unavailable',
  stale: staleContext(context),
  partial: false,
  reasons: ['Current verified policy grants no repository reporting scope.'],
})

export function buildPerformanceView(context: PageContext): PerformanceView {
  const filters = authorizedReportFilters(context)
  if (Array.isArray(filters.allowedRepos) && filters.allowedRepos.length === 0) {
    return { month: filters.month, state: noScopeState(context), totals: null, repos: [], stages: [], issues: [], unlinkedExecutions: null }
  }
  try {
    const totals = orgTotals(context.db, filters)
    const repos = perRepo(context.db, filters)
    const stages = perStage(context.db, filters)
    const issues = perIssue(context.db, filters)
    const events = totals.metricVersion === 2 ? cachedExecutionEvents(context.db, filters) : []
    const unlinkedExecutions = totals.metricVersion === 2
      ? events.filter(event => event.payload.recordKind === 'execution' && !event.payload.taskRef).length
      : null
    const coveragePartial = Object.values(totals.coverage).some(value => value.availability !== 'available')
    const taskPartial = totals.metricVersion === 1 || [
      totals.mergedIssues, totals.mergedTasks, totals.implementedTasks, totals.releasedTasks,
      totals.reviewRounds, totals.fixRounds, totals.handbacks,
    ].some(value => value === null)
    const sourceUnavailable = context.generation?.dataState === 'unavailable'
    const hasData = totals.runs > 0 || repos.length > 0 || issues.length > 0 || totals.lifetime.length > 0
    const reasons: string[] = []
    if (coveragePartial) reasons.push('Some usage fields have unknown measurements; known values remain visible with coverage.')
    if (taskPartial) reasons.push('Task activity coverage is incomplete; unknown outcomes and rework stay unavailable.')
    if (totals.metricVersion === 1) reasons.push('Historical rows use legacy definitions and do not acquire metric-v2 attribution.')
    if (context.freshness.offline || sourceUnavailable) reasons.push('The current metrics refresh is unavailable; safely retained rows may be shown.')
    const partial = coveragePartial || taskPartial || context.freshness.offline || sourceUnavailable
    const availability: ViewState['availability'] = hasData ? 'ready' : sourceUnavailable ? 'unavailable' : 'empty'
    if (availability === 'empty') reasons.push('No reportable usage or task activity is recorded for this month and filter.')
    return {
      month: filters.month,
      totals,
      repos,
      stages,
      issues,
      unlinkedExecutions,
      state: { availability, stale: staleContext(context), partial, reasons },
    }
  } catch {
    return {
      month: filters.month,
      state: { availability: 'failed', stale: staleContext(context), partial: false, reasons: ['The cached performance report could not be read. Refresh after the local data source is available.'] },
      totals: null,
      repos: [],
      stages: [],
      issues: [],
      unlinkedExecutions: null,
    }
  }
}

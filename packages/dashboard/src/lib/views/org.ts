import type { PageContext } from '../context'
import { orgTotals, perRepo, perStage, type Totals } from '../cache/queries'
import type { Summary } from '../stats/summaries'

export interface OrgView {
  month: string
  totals: Totals
  repos: Array<{ repo: string; group: string | null } & Totals>
  stages: Array<{ stage: string } & Totals>
  /** Legacy compatibility field; measured operator minutes are in totals. */
  humanShare: null
  summary: Summary | null
}

export function buildOrgView({ context, summary }: { context: PageContext; summary: Summary | null }): OrgView {
  const totals = orgTotals(context.db, context.filters)
  if(context.filters.allowedRepos!==null||context.filters.group||context.filters.repo)summary=null
  return {
    month: context.filters.month,
    totals,
    repos: perRepo(context.db, context.filters).map((row) => ({ ...row, group: context.repoGroups[row.repo] ?? null })),
    stages: perStage(context.db, context.filters),
    // A month with no runs has no share, and zero is the honest reading of "no human time went
    // anywhere" — dividing would produce NaN and render as a broken number.
    humanShare: null,
    summary,
  }
}

import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { money, StatTable } from '@/components/stat-table'
import { withContext } from '@/lib/context'
import { readOrgSkills } from '@/lib/stats/summaries'
import { buildSkillsView } from '@/lib/views/skills'

export const dynamic = 'force-dynamic'

const counts = (row: Record<string, number>): string =>
  Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} ${value}`).join(' · ') || 'Unavailable'

export default async function SkillsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withContext(await searchParams, async context => {
    const mayReadWholeOrg = context.filters.allowedRepos === null && !context.filters.group && !context.filters.repo
    const view = buildSkillsView({
      context,
      orgSkills: mayReadWholeOrg ? await readOrgSkills(context.env.controlRoom, context.filters.month) : null,
    })

    return (
    <Shell title={`${context.env.org} skills · ${context.filters.month}`} freshness={context.freshness} pathname="/skills" filters={context.filters}>
      <FilterBar base="/skills" options={context.options} filters={context.filters} />
      <p className="text-muted-foreground mb-6 text-sm">
        Each skill is associated with the whole reported run. Mean associated run cost is nonadditive,
        is not marginal cost or ROI, and can be unavailable when cost coverage is unknown.
      </p>
      <StatTable
        caption="Invocations, trigger, outcome, coverage and mean associated run cost per skill"
        rows={view.rows}
        rowKey={(row) => row.name}
        empty="No skill invocations recorded for this month."
        columns={[
          { key: 'name', label: 'Skill', render: (row) => row.name },
          { key: 'invocations', label: 'Invocations', align: 'end', render: (row) => row.invocations },
          { key: 'org', label: 'Historical org rollup', align: 'end', render: (row) => view.orgTotals?.[row.name] ?? 'Unavailable' },
          { key: 'triggers', label: 'Trigger', render: (row) => counts(row.triggers) },
          { key: 'outcomes', label: 'Outcome', render: (row) => counts(row.outcomes) },
          { key: 'coverage', label: 'Cost coverage', render: (row) => `${row.coverage.known} known · ${row.coverage.unknown} unknown` },
          { key: 'per', label: 'Mean associated run cost', align: 'end', render: (row) => money(row.meanAssociatedRunCostUsd) },
        ]}
      />
    </Shell>
    )
  })
}

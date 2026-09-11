import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { hours, money, quantity, StatTable } from '@/components/stat-table'
import { withContext } from '@/lib/context'
import { readRepoSummary } from '@/lib/stats/summaries'
import { buildRepoView } from '@/lib/views/repo'

export const dynamic = 'force-dynamic'

export default async function RepoPage({ params, searchParams }: {
  params: Promise<{ owner: string; name: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { owner, name } = await params
  const repo = `${owner}/${name}`
  return withContext(await searchParams, async context => {
    if (!context.allowedRepos?.includes(repo)) {
      return (
        <Shell title={`${context.env.org} · repository unavailable`} freshness={context.freshness} pathname={`/repo/${repo}`} filters={context.filters}>
          <p className="text-muted-foreground text-sm">This repository is outside the current verified reporting scope.</p>
        </Shell>
      )
    }
    const summary = context.filters.attributedRepos?.includes(repo)
      ? await readRepoSummary(context.env.controlRoom, repo, context.filters.month)
      : null
    const view = buildRepoView({ context, repo, summary })

    return (
    <Shell title={`${repo} · ${view.month}`} freshness={context.freshness} pathname={`/repo/${repo}`} filters={context.filters}>
      <FilterBar base={`/repo/${repo}`} options={context.options} filters={context.filters} />

      {view.missing.length > 0 && (
        <p className="text-muted-foreground mb-6 text-sm">
          Not in the rollup for this month: {view.missing.join(', ')}.
        </p>
      )}

      <dl className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Lead time p50', value: hours(view.leadTimeH.p50) },
          { label: 'Lead time p90', value: hours(view.leadTimeH.p90) },
          { label: 'Terminal segments', value: String(view.totals.runs) },
          { label: 'Reported cost', value: money(view.totals.costUsd) },
        ].map((tile) => (
          <div key={tile.label} className="border-border rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{tile.label}</dt>
            <dd className="mt-1 text-2xl font-medium tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium">Cycle time by state</h2>
        <StatTable
          caption="Hours issues sat in each workflow state, from the rollup's label timelines"
          rows={view.cycleTimeH}
          rowKey={(row) => row.label}
          empty="No state timings in the rollup for this month."
          columns={[
            { key: 'label', label: 'State', render: (row) => row.label },
            { key: 'p50', label: 'p50', align: 'end', render: (row) => hours(row.p50) },
            { key: 'p90', label: 'p90', align: 'end', render: (row) => hours(row.p90) },
          ]}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium">Stages</h2>
        <StatTable
          caption="Reported execution usage per workflow stage, from the cache"
          rows={view.stages}
          rowKey={(row) => row.stage}
          empty="No stages recorded for this month."
          columns={[
            { key: 'stage', label: 'Stage', render: (row) => row.stage },
            { key: 'runs', label: 'Terminal segments', align: 'end', render: (row) => row.runs },
            { key: 'cost', label: 'Reported cost', align: 'end', render: (row) => money(row.costUsd) },
            { key: 'operator', label: 'Operator minutes', align: 'end', render: (row) => quantity(row.operatorMinutes) },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Task-linked issue subtotals</h2>
        <StatTable
          caption="Task-linked reported cost and monthly rework per issue"
          rows={view.issues}
          rowKey={(row) => String(row.issue)}
          empty="No issues recorded for this month."
          columns={[
            { key: 'issue', label: 'Issue', render: (row) => `#${row.issue}` },
            { key: 'cost', label: 'Reported cost', align: 'end', render: (row) => money(row.costUsd) },
            { key: 'review', label: 'Monthly reviews', align: 'end', render: (row) => quantity(row.reviewRounds) },
            { key: 'fix', label: 'Monthly corrections', align: 'end', render: (row) => quantity(row.fixRounds) },
            { key: 'handbacks', label: 'Monthly handbacks', align: 'end', render: (row) => quantity(row.handbacks) },
          ]}
        />
      </section>
    </Shell>
    )
  })
}

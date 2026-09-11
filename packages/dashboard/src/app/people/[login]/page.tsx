import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { money, quantity, StatTable } from '@/components/stat-table'
import { withContext } from '@/lib/context'
import { buildPersonView, type PeopleDimension } from '@/lib/views/people'

export const dynamic = 'force-dynamic'

export default async function PersonPage({ params, searchParams }: {
  params: Promise<{ login: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const login = (await params).login.trim().toLowerCase()
  const query = await searchParams
  const rawDimension = Array.isArray(query.dimension) ? query.dimension[0] : query.dimension
  const dimension: PeopleDimension = rawDimension === 'account-owner' ? 'account-owner' : 'task-owner'
  return withContext(query, async context => {
    const view = await buildPersonView({ context, login, dimension })

    if (!view.gate.allowed) {
      return (
        <Shell title={`${context.env.org} · ${login}`} freshness={context.freshness} pathname={`/people/${login}`} filters={context.filters} navigationExtra={{ dimension }}>
          <p className="text-muted-foreground text-sm">This person report is unavailable for the current verified identity, policy, and repository scope.</p>
          {view.gate.reason && <p className="text-muted-foreground mt-2 text-sm">Reason: {view.gate.reason}</p>}
        </Shell>
      )
    }

    const dimensionHref = (next: PeopleDimension) => {
      const values = new URLSearchParams({ dimension: next })
      for (const key of ['month', 'repo', 'group', 'harness', 'model'] as const) {
        const value = context.filters[key]
        if (value) values.set(key, value)
      }
      return `/people/${login}?${values}`
    }

    return (
    <Shell title={`${view.person?.name ?? login} · ${context.filters.month}`} freshness={context.freshness} pathname={`/people/${login}`} filters={context.filters} navigationExtra={{ dimension }}>
      <nav aria-label="Ownership dimension" className="mb-4 flex gap-4 text-sm">
        <a href={dimensionHref('task-owner')} aria-current={dimension === 'task-owner' ? 'page' : undefined} className="underline-offset-4 hover:underline">Task owner</a>
        <a href={dimensionHref('account-owner')} aria-current={dimension === 'account-owner' ? 'page' : undefined} className="underline-offset-4 hover:underline">Agent-account owner</a>
      </nav>
      <FilterBar base={`/people/${login}`} options={context.options} filters={context.filters} extra={{ dimension }} />
      <dl className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Terminal segments', value: quantity(view.totals?.runs ?? null) },
          { label: 'Reported cost', value: money(view.totals?.costUsd ?? null) },
          { label: 'Operator minutes', value: quantity(view.totals?.operatorMinutes ?? null) },
          { label: 'Merged tasks', value: quantity(view.totals?.mergedTasks ?? null) },
        ].map((tile) => (
          <div key={tile.label} className="border-border rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{tile.label}</dt>
            <dd className="mt-1 text-2xl font-medium tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>
      <StatTable
        caption={`Reported terminal segments for this ${dimension === 'task-owner' ? 'task owner' : 'agent-account owner'} by stage`}
        rows={view.stages}
        rowKey={(row) => row.stage}
        empty={`No ${dimension === 'task-owner' ? 'task-owner' : 'agent-account-owner'} activity is recorded in the permitted scope this month.`}
        columns={[
          { key: 'stage', label: 'Stage', render: (row) => row.stage },
          { key: 'runs', label: 'Terminal segments', align: 'end', render: (row) => row.runs },
          { key: 'cost', label: 'Reported cost', align: 'end', render: (row) => money(row.costUsd) },
          { key: 'operator', label: 'Operator minutes', align: 'end', render: (row) => quantity(row.operatorMinutes) },
        ]}
      />
    </Shell>
    )
  }, { kind: 'person', subject: login, dimension })
}

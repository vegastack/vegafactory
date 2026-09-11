import Link from 'next/link'

import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { money, quantity, StatTable } from '@/components/stat-table'
import { withContext, type PageContext } from '@/lib/context'
import { buildPeopleView } from '@/lib/views/people'

export const dynamic = 'force-dynamic'

function resolvedRole(context: PageContext, login: string): string {
  const administration = context.policy.effective?.administration
  if (!administration) return 'Unavailable'
  if (administration.orgAdmins.includes(login)) return 'Organization admin'
  const groups = Object.entries(administration.groupAdmins as Record<string, string[]>)
    .filter(([, logins]) => logins.includes(login))
    .map(([group]) => group)
    .sort()
  return groups.length ? `Group admin: ${groups.join(', ')}` : 'Member'
}

function personHref(context: PageContext, login: string): string {
  const query = new URLSearchParams({ dimension: 'task-owner' })
  for (const key of ['month', 'repo', 'group', 'harness', 'model'] as const) {
    const value = context.filters[key]
    if (value) query.set(key, value)
  }
  return `/people/${login}?${query}`
}

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withContext(await searchParams, async context => {
    const view = await buildPeopleView({ context })

    return (
    <Shell title={`${context.env.org} people · ${context.filters.month}`} freshness={context.freshness} pathname="/people" filters={context.filters}>
      <FilterBar base="/people" options={context.options} filters={context.filters} />
      {view.gated && (
        <p className="text-muted-foreground mb-6 text-sm">
          People reports require confirmed attributed reporting and current repository permissions.
          Organization and group administrators see only their permitted scope.
          {view.refusal && <span className="block">{view.refusal}</span>}
        </p>
      )}
      <p className="text-muted-foreground mb-6 text-sm">Private repository readers can also read report files and Git history. This page does not restrict access to existing clones.</p>
      <StatTable
        caption="Reported execution and task outcomes per task owner"
        rows={view.rows}
        rowKey={(row) => row.login}
        empty={view.refusal ? 'People reporting is unavailable for the current policy and scope.' : 'No task-owner activity is recorded in the permitted scope this month.'}
        columns={[
          { key: 'login', label: 'Task owner', render: (row) => <Link className="underline-offset-4 hover:underline" href={personHref(context, row.login)}>{row.name}</Link> },
          { key: 'role', label: 'Administration', render: (row) => resolvedRole(context, row.login) },
          { key: 'runs', label: 'Terminal segments', align: 'end', render: (row) => row.runs },
          { key: 'cost', label: 'Reported cost', align: 'end', render: (row) => money(row.costUsd) },
          { key: 'operator', label: 'Operator minutes', align: 'end', render: (row) => quantity(row.operatorMinutes) },
          { key: 'merged', label: 'Merged tasks', align: 'end', render: (row) => quantity(row.mergedTasks) },
        ]}
      />
      {view.unknownOwners && (
        <section aria-labelledby="unknown-owners" className="mt-8">
          <h2 id="unknown-owners" className="mb-3 text-lg font-medium">Unattributed ownership</h2>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="border-border rounded-lg border p-4">
              <dt className="text-muted-foreground text-sm">Unknown task owner segments</dt>
              <dd className="mt-1 text-lg tabular-nums">{quantity(view.unknownOwners.taskOwner?.runs ?? null)}</dd>
            </div>
            <div className="border-border rounded-lg border p-4">
              <dt className="text-muted-foreground text-sm">Unknown agent-account owner segments</dt>
              <dd className="mt-1 text-lg tabular-nums">{quantity(view.unknownOwners.agentAccountOwner?.runs ?? null)}</dd>
            </div>
          </dl>
        </section>
      )}
    </Shell>
    )
  })
}

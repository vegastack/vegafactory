import Link from 'next/link'

import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { money, quantity, seconds, StatTable } from '@/components/stat-table'
import { withContext, type PageContext } from '@/lib/context'
import { buildPerformanceView, type ViewState } from '@/lib/views/performance'

export const dynamic = 'force-dynamic'

function StateNotice({ state }: { state: ViewState }) {
  if (state.availability === 'ready' && !state.stale && !state.partial) return null
  return (
    <section
      aria-label="Report state"
      role={state.availability === 'failed' ? 'alert' : 'status'}
      className="border-border bg-muted text-muted-foreground mb-6 rounded-lg border px-4 py-3 text-sm"
    >
      <p className="text-foreground font-medium">
        {state.availability === 'failed' ? 'Performance report failed.'
          : state.availability === 'unavailable' ? 'Performance report is unavailable.'
            : state.availability === 'empty' ? 'Performance report is empty.'
              : state.stale && state.partial ? 'Performance data is stale and partial.'
                : state.stale ? 'Performance data is stale.' : 'Performance data is partial.'}
      </p>
      {state.reasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{state.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <p className="mt-2">Refresh this page after restoring the reported local source or policy.</p>
    </section>
  )
}

function repoHref(context: PageContext, repo: string): string {
  const query = new URLSearchParams()
  for (const key of ['month', 'group', 'harness', 'model'] as const) {
    const value = context.filters[key]
    if (value) query.set(key, value)
  }
  return `/repo/${repo}${query.size ? `?${query}` : ''}`
}

export default async function PerformancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withContext(await searchParams, async context => {
    const view = buildPerformanceView(context)
    const totals = view.totals
    const fee = totals?.subscriptionFee
    return (
      <Shell title={`${context.env.org} performance · ${view.month}`} freshness={context.freshness} pathname="/performance" filters={context.filters}>
        <FilterBar base="/performance" options={context.options} filters={context.filters} />
        <StateNotice state={view.state} />

        <dl className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: 'Terminal segments', value: quantity(totals?.runs ?? null) },
            { label: 'Logical executions', value: quantity(totals?.logicalExecutions ?? null) },
            { label: 'Reported cost', value: money(totals?.costUsd ?? null) },
            { label: 'Operator minutes', value: quantity(totals?.operatorMinutes ?? null) },
            { label: 'API-equivalent estimate', value: money(totals?.apiEquivalentUsd ?? null) },
            { label: 'Subscription fee', value: fee ? `${fee.amount.toFixed(2)} ${fee.currency} · ${fee.period}` : 'Unavailable' },
            { label: 'Unlinked terminal segments', value: quantity(view.unlinkedExecutions) },
            { label: 'Unknown execution identity', value: totals ? String(totals.unknownExecutionIdentity) : 'Unavailable' },
          ].map(metric => (
            <div key={metric.label} className="border-border rounded-lg border p-4">
              <dt className="text-muted-foreground text-sm">{metric.label}</dt>
              <dd className="mt-1 text-lg font-medium tabular-nums">{metric.value}</dd>
            </div>
          ))}
        </dl>

        <section className="mb-8" aria-labelledby="coverage-heading">
          <h2 id="coverage-heading" className="mb-3 text-lg font-medium">Definitions and coverage</h2>
          <p className="text-muted-foreground mb-3 max-w-3xl text-sm">
            Reported usage is measured by terminal segment. API-equivalent cost is an estimate, subscription fees are account-level evidence, and neither is allocated to a task. Cache-token inclusion remains unknown pending harness qualification.
          </p>
          <StatTable
            caption="Measurement coverage for reported usage"
            rows={totals ? Object.entries(totals.coverage) : []}
            rowKey={([field]) => field}
            empty="Measurement coverage is unavailable."
            columns={[
              { key: 'field', label: 'Field', render: ([field]) => field },
              { key: 'value', label: 'Reported value', align: 'end', render: ([, value]) => quantity(value.value) },
              { key: 'known', label: 'Known', align: 'end', render: ([, value]) => value.known },
              { key: 'unknown', label: 'Unknown', align: 'end', render: ([, value]) => value.unknown },
              { key: 'availability', label: 'Availability', render: ([, value]) => value.availability },
            ]}
          />
        </section>

        <section className="mb-8" aria-labelledby="outcomes-heading">
          <h2 id="outcomes-heading" className="mb-3 text-lg font-medium">Monthly task outcomes and rework</h2>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              ['Merged issues', totals?.mergedIssues ?? null],
              ['Merged tasks', totals?.mergedTasks ?? null],
              ['Implemented tasks', totals?.implementedTasks ?? null],
              ['Released tasks', totals?.releasedTasks ?? null],
              ['Reviews', totals?.reviewRounds ?? null],
              ['Corrections', totals?.fixRounds ?? null],
              ['Handbacks', totals?.handbacks ?? null],
            ].map(([label, value]) => (
              <div key={String(label)} className="border-border rounded-lg border p-4">
                <dt className="text-muted-foreground text-sm">{label}</dt>
                <dd className="mt-1 text-lg tabular-nums">{quantity(value as number | null)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mb-8" aria-labelledby="repo-heading">
          <h2 id="repo-heading" className="mb-3 text-lg font-medium">Repository usage</h2>
          <StatTable
            caption="Repository usage including terminal segments not linked to an issue"
            rows={view.repos}
            rowKey={row => row.repo}
            empty="No repository usage is recorded for this month and filter."
            columns={[
              { key: 'repo', label: 'Repository', render: row => <Link className="underline-offset-4 hover:underline" href={repoHref(context, row.repo)}>{row.repo}</Link> },
              { key: 'runs', label: 'Terminal segments', align: 'end', render: row => row.runs },
              { key: 'duration', label: 'Reported runtime', align: 'end', render: row => seconds(row.durationS) },
              { key: 'cost', label: 'Reported cost', align: 'end', render: row => money(row.costUsd) },
              { key: 'merged', label: 'Merged tasks', align: 'end', render: row => quantity(row.mergedTasks) },
            ]}
          />
        </section>

        <section className="mb-8" aria-labelledby="issue-heading">
          <h2 id="issue-heading" className="mb-3 text-lg font-medium">Task-linked issue subtotals</h2>
          <p className="text-muted-foreground mb-3 text-sm">These rows exclude unlinked terminal segments; repository totals above do not.</p>
          <StatTable
            caption="Task-linked issue usage and monthly rework"
            rows={view.issues}
            rowKey={row => `${row.repo}-${row.issue}`}
            empty="No task-linked issues are recorded for this month and filter."
            columns={[
              { key: 'issue', label: 'Issue', render: row => <a className="underline-offset-4 hover:underline" href={`https://github.com/${row.repo}/issues/${row.issue}`}>{row.repo} #{row.issue}</a> },
              { key: 'runs', label: 'Terminal segments', align: 'end', render: row => row.runs },
              { key: 'cost', label: 'Reported cost', align: 'end', render: row => money(row.costUsd) },
              { key: 'review', label: 'Reviews', align: 'end', render: row => quantity(row.reviewRounds) },
              { key: 'fix', label: 'Corrections', align: 'end', render: row => quantity(row.fixRounds) },
              { key: 'handback', label: 'Handbacks', align: 'end', render: row => quantity(row.handbacks) },
            ]}
          />
        </section>

        <section aria-labelledby="lifetime-heading">
          <h2 id="lifetime-heading" className="mb-3 text-lg font-medium">Lifetime authoritative snapshots</h2>
          <p className="text-muted-foreground mb-3 text-sm">Latest authoritative as-of values are not summed with monthly activity.</p>
          <StatTable
            caption="Latest lifetime rework snapshots by task"
            rows={totals?.lifetime ?? []}
            rowKey={row => `${row.taskRef.repo}-${row.taskRef.issue}-${row.taskRef.taskId ?? 'issue'}`}
            empty="No authoritative lifetime rework snapshot is available."
            columns={[
              { key: 'task', label: 'Task', render: row => `${row.taskRef.repo} #${row.taskRef.issue}${row.taskRef.taskId ? ` · ${row.taskRef.taskId}` : ''}` },
              { key: 'asOf', label: 'As of', render: row => <time dateTime={row.asOf}>{row.asOf}</time> },
              { key: 'review', label: 'Reviews', align: 'end', render: row => quantity(row.reviewRounds) },
              { key: 'fix', label: 'Corrections', align: 'end', render: row => quantity(row.fixRounds) },
              { key: 'handback', label: 'Handbacks', align: 'end', render: row => quantity(row.handbacks) },
            ]}
          />
        </section>
      </Shell>
    )
  })
}

import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { quantity, seconds, StatTable } from '@/components/stat-table'
import { withContext } from '@/lib/context'
import { readStatus } from '@/lib/live/status'
import { buildActivityView } from '@/lib/views/activity'
import { authorizedReportFilters } from '@/lib/views/performance'

export const dynamic = 'force-dynamic'

const counts = (values: Record<string, number>): string => Object.entries(values)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, value]) => `${name} ${value}`)
  .join(' · ') || 'Unavailable'

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withContext(await searchParams, async context => {
    const filters = authorizedReportFilters(context, true)
    const repos = Array.isArray(filters.allowedRepos) ? filters.allowedRepos : []
    const status = await readStatus({ bin: context.env.bin, configPath: context.env.stateFile, org: context.env.org, repos })
    const view = buildActivityView(context, status)
    return (
      <Shell title={`${context.env.org} activity · ${view.month}`} freshness={context.freshness} pathname="/activity" filters={context.filters}>
        <FilterBar base="/activity" options={context.options} filters={context.filters} />
        {(view.state.availability !== 'ready' || view.state.stale || view.state.partial) && (
          <section
            aria-label="Report state"
            role={view.state.availability === 'failed' ? 'alert' : 'status'}
            className="border-border bg-muted text-muted-foreground mb-6 rounded-lg border px-4 py-3 text-sm"
          >
            <p className="text-foreground font-medium">
              {view.state.availability === 'failed' ? 'Activity report failed.'
                : view.state.availability === 'unavailable' ? 'Activity report is unavailable.'
                  : view.state.availability === 'empty' ? 'Activity report is empty.'
                    : view.state.stale && view.state.partial ? 'Activity data is stale and partial.'
                      : view.state.stale ? 'Activity data is stale.' : 'Activity data is partial.'}
            </p>
            {view.state.reasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{view.state.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
            <p className="mt-2">Refresh after the reported source or policy is restored. This dashboard does not change task state.</p>
          </section>
        )}

        <StatTable
          caption="Task activity, reported execution, ownership, recovery, and shared-machine history"
          rows={view.rows}
          rowKey={row => `${row.repo}-${row.issue}`}
          empty={view.state.availability === 'unavailable'
            ? 'Task activity is unavailable for the current verified policy and scope.'
            : 'No task activity is recorded for this month and filter.'}
          columns={[
            { key: 'task', label: 'Task', render: row => <a className="underline-offset-4 hover:underline" href={`https://github.com/${row.repo}/issues/${row.issue}`}>{row.repo} #{row.issue}{row.taskId ? ` · ${row.taskId}` : ''}</a> },
            { key: 'taskOwner', label: 'Task owner', render: row => row.taskOwner ?? 'Unavailable' },
            { key: 'accountOwner', label: 'Agent-account owner', render: row => row.agentAccountOwner ?? 'Unavailable' },
            { key: 'state', label: 'Current state', render: row => row.sharedState ?? row.latestActivity ?? row.terminationCause ?? 'Unavailable' },
            { key: 'machine', label: 'Current machine', render: row => row.currentMachine ?? 'Unavailable' },
            { key: 'observed', label: 'Last observed', render: row => row.lastObservedAt ? <time dateTime={row.lastObservedAt}>{row.lastObservedAt}</time> : 'Unavailable' },
            { key: 'checkpoint', label: 'Checkpoint', render: row => row.checkpoint ? 'Recorded, availability unknown' : 'Unavailable' },
            { key: 'attempts', label: 'Attempts', align: 'end', render: row => quantity(row.attempts) },
            { key: 'runtime', label: 'Reported runtime', align: 'end', render: row => `${seconds(row.runtimeSeconds)} · ${row.runtimeCoverage.known} known/${row.runtimeCoverage.unknown} unknown` },
            { key: 'outcomes', label: 'Execution outcomes', render: row => counts(row.outcomes) },
            { key: 'activity', label: 'Typed monthly activity', render: row => counts(row.activities) },
            { key: 'delivery', label: 'Pending delivery', align: 'end', render: row => quantity(row.pendingDelivery) },
            { key: 'recovery', label: 'Recovery', render: row => row.recovery ? `${row.recovery.action}: ${row.recovery.reason}` : 'Unavailable' },
            { key: 'history', label: 'Ownership history', render: row => (
              <details>
                <summary>{row.history.coverage} · {row.history.events.length} transitions</summary>
                {row.history.events.length === 0
                  ? <p className="text-muted-foreground mt-2">No bounded shared-owner history is available.</p>
                  : <ol className="mt-2 space-y-1">{row.history.events.map((event, index) => (
                    <li key={`${event.kind}-${event.generation}-${index}`}>
                      {event.kind}: {event.previousMachineId ? `${event.previousMachineId} to ` : ''}{event.machineId}
                      {event.observedAt ? <> at <time dateTime={event.observedAt}>{event.observedAt}</time></> : ' at an unknown time'}
                    </li>
                  ))}</ol>}
              </details>
            ) },
          ]}
        />
      </Shell>
    )
  })
}

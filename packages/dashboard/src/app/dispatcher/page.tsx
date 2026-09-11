import { OfflineBanner } from '@/components/offline-banner'
import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { quantity, StatTable } from '@/components/stat-table'
import { withContext } from '@/lib/context'
import { readStatus } from '@/lib/live/status'
import { buildDispatcherView } from '@/lib/views/dispatcher'

export const dynamic = 'force-dynamic'

export default async function DispatcherPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withContext(await searchParams, async context => {
    const allowed = context.allowedRepos ?? []
    const repos = context.filters.repo
      ? allowed.filter(repo => repo === context.filters.repo)
      : context.filters.group
        ? allowed.filter(repo => context.repoGroups[repo] === context.filters.group)
        : allowed
    const status = await readStatus({ bin: context.env.bin, configPath: context.env.stateFile, org: context.env.org, repos })
    const view = buildDispatcherView({ context, status, now: Date.now() })

    return (
    <Shell title={`${context.env.org} · dispatcher`} freshness={view.freshness} pathname="/dispatcher" filters={context.filters}>
      <FilterBar base="/dispatcher" options={context.options} filters={context.filters} />
      <OfflineBanner freshness={view.freshness} reasons={view.reasons} />

      <dl className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Running', value: view.running === null ? 'Unavailable' : view.running ? 'Yes' : 'No' },
          { label: 'PID', value: quantity(view.pid) },
          { label: 'Last tick', value: view.lastTick ?? 'Unavailable' },
          { label: 'Interval', value: view.interval === null ? 'Unavailable' : `${view.interval}s` },
        ].map((tile) => (
          <div key={tile.label} className="border-border rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{tile.label}</dt>
            <dd className="mt-1 text-lg font-medium">{tile.value}</dd>
          </div>
        ))}
      </dl>

      {view.repos.map((repo) => (
        <section key={repo.repo} className="mb-8">
          <h2 className="mb-3 text-lg font-medium">{repo.repo}</h2>
          <p className="text-muted-foreground mb-3 text-sm">
            dispatch {repo.dispatch || 'Unavailable'} · needs-plan {repo.board.needsPlan} · ready {repo.board.ready} ·
            working {repo.board.working} · for-operator {repo.board.forOperator}
          </p>
          <StatTable
            caption={`Recent headless runs in ${repo.repo}`}
            rows={repo.runs}
            rowKey={(row) => `${row.stage}-${row.startedAt}-${row.issue ?? 'none'}`}
            empty="No runs recorded."
            columns={[
              { key: 'issue', label: 'Issue', render: (row) => row.issue === null ? 'Unavailable' : <a className="underline-offset-4 hover:underline" href={`https://github.com/${repo.repo}/issues/${row.issue}`}>#{row.issue}</a> },
              { key: 'stage', label: 'Stage', render: (row) => row.stage },
              { key: 'started', label: 'Started', render: (row) => row.startedAt },
              { key: 'state', label: 'State', render: (row) => row.terminationCause ?? row.state ?? 'Unavailable' },
              { key: 'exit', label: 'Exit', align: 'end', render: (row) => quantity(row.exitCode) },
              { key: 'delivery', label: 'Pending delivery', align: 'end', render: (row) => quantity(row.pendingDelivery ?? null) },
              { key: 'recovery', label: 'Recovery', render: (row) => row.recovery ? `${row.recovery.action}: ${row.recovery.reason}` : 'Unavailable' },
            ]}
          />
        </section>
      ))}
    </Shell>
    )
  })
}

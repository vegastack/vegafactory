import { Shell } from '@/components/shell'
import { StatTable } from '@/components/stat-table'
import { loadContext } from '@/lib/context'
import { fetchBoardRepositories } from '@/lib/live/github'
import { readStatus } from '@/lib/live/status'
import { buildBoardView } from '@/lib/views/board'

export const dynamic = 'force-dynamic'

export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await loadContext(await searchParams)
  const repos = context.filters.repo ? [context.filters.repo] : context.env.repos
  // The board is one org-wide column set: a repo that fails names itself in the banner, and the
  // repos that answered still fill the columns.
  const [{ issues, pulls }, status] = await Promise.all([
    fetchBoardRepositories(repos, context.env.token),
    readStatus({ bin: context.env.bin }),
  ])
  const view = buildBoardView({
    context, issues: issues.live, pulls: pulls.live, status, now: Date.now(),
    warnings: [...issues.reasons, ...pulls.reasons],
    issueRepositories: issues.repositories, pullRepositories: pulls.repositories,
  })

  return (
    <Shell title="Board" freshness={view.freshness}>
      {view.reasons.length > 0 && (
        <section aria-label="Data availability" className="border-border bg-muted text-muted-foreground mb-6 rounded-lg border px-4 py-3 text-sm">
          <p>Some data is incomplete or unavailable. Available rows are shown.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {[...new Set(view.reasons)].map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        </section>
      )}

      {view.repositories.length > 0 && (
        <section aria-label="Repository data status" className="mb-4 text-sm">
          <ul>
            {view.repositories.map(repo => (
              <li key={repo.repo} className="text-muted-foreground">
                {repo.repo}: {repo.complete ? 'Complete' : 'Incomplete'}. Observed <time dateTime={repo.observedAt}>{repo.observedAt}</time>.
              </li>
            ))}
          </ul>
          {(!view.issuesComplete || !view.pullsComplete) && <p>Available rows are shown. Refresh this page to retry after resolving the reported failure or rate limit.</p>}
        </section>
      )}

      <section className="mb-8 grid gap-4 md:grid-cols-5">
        {view.columns.map((column) => (
          <div key={column.label} className="border-border rounded-lg border p-4">
            <h2 className="text-muted-foreground mb-3 text-sm font-medium">{column.label}</h2>
            {column.issues.length === 0
              ? <p className="text-muted-foreground text-sm">{view.issuesComplete ? 'No issues.' : 'Issue list incomplete.'}</p>
              : (
                <ul className="space-y-2 text-sm">
                  {column.issues.map((issue) => (
                    <li key={issue.url}>
                      <a href={issue.url} className="underline-offset-4 hover:underline">#{issue.number} {issue.title}</a>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        ))}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Open pull requests</h2>
        <StatTable
          caption="Open pull requests across the passed repos"
          rows={view.pulls}
          rowKey={(row) => row.url}
          empty={view.pullsComplete ? 'No open pull requests.' : 'Pull request list incomplete.'}
          columns={[
            { key: 'number', label: 'PR', render: (row) => <a className="underline-offset-4 hover:underline" href={row.url}>#{row.number}</a> },
            { key: 'title', label: 'Title', render: (row) => row.title },
            { key: 'draft', label: 'Draft', render: (row) => (row.draft ? 'yes' : 'no') },
          ]}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Worktrees</h2>
        <StatTable
          caption="Feature worktrees the dispatcher reports"
          rows={view.worktrees}
          rowKey={(row) => row.path}
          empty="No worktrees reported."
          columns={[
            { key: 'branch', label: 'Branch', render: (row) => row.branch },
            { key: 'issue', label: 'Issue', render: (row) => (row.issue === null ? '—' : `#${row.issue}`) },
            { key: 'state', label: 'State', render: (row) => row.state },
            { key: 'path', label: 'Path', render: (row) => row.path },
          ]}
        />
      </section>
    </Shell>
  )
}

import { FilterBar } from '@/components/filter-bar'
import { Shell } from '@/components/shell'
import { withContext } from '@/lib/context'
import { fetchBoardRepositories } from '@/lib/live/github'
import { readStatus } from '@/lib/live/status'
import { buildActivityView } from '@/lib/views/activity'
import { buildBoardView } from '@/lib/views/board'
import { authorizedReportFilters } from '@/lib/views/performance'

export const dynamic = 'force-dynamic'

export interface AttentionItem {
  key: string
  title: string
  detail: string
  href: string
  observedAt?: string | null
}

function AttentionSection({ title, items, empty }: { title: string; items: AttentionItem[]; empty: string }) {
  const id = `attention-${title.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} className="border-border border-t py-6 first:border-t-0 first:pt-0">
      <h2 id={id} className="text-lg font-medium">{title}</h2>
      {items.length === 0
        ? <p className="text-muted-foreground mt-2 text-sm">{empty}</p>
        : <ol className="mt-3 space-y-3">{items.map(item => (
          <li key={item.key} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
            <div className="min-w-0">
              <a href={item.href} className="font-medium underline-offset-4 hover:underline">{item.title}</a>
              <p className="text-muted-foreground text-sm">{item.detail}</p>
            </div>
            {item.observedAt && <time className="text-muted-foreground text-sm" dateTime={item.observedAt}>{item.observedAt}</time>}
          </li>
        ))}</ol>}
    </section>
  )
}

export function AttentionSections({ decision, blocked, running, merged, incomplete }: {
  decision: AttentionItem[]
  blocked: AttentionItem[]
  running: AttentionItem[]
  merged: AttentionItem[]
  incomplete: boolean
}) {
  return (
    <div>
      <AttentionSection title="Needs your decision" items={decision} empty={incomplete ? 'Decision data is incomplete.' : 'No decisions need your response.'} />
      <AttentionSection title="Blocked or failed" items={blocked} empty={incomplete ? 'Failure data is incomplete.' : 'No blocked or failed task is reported.'} />
      <AttentionSection title="Running" items={running} empty={incomplete ? 'Running-state data is incomplete.' : 'No task is reported running.'} />
      <AttentionSection title="Recently merged" items={merged} empty={incomplete ? 'Merged activity data is incomplete.' : 'No merged task is recorded for this month.'} />
    </div>
  )
}

export default async function AttentionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withContext(await searchParams, async context => {
    const reportFilters = authorizedReportFilters(context)
    const allowed = Array.isArray(reportFilters.allowedRepos) ? reportFilters.allowedRepos : []
    const repos = context.filters.repo || context.filters.group ? reportFilters.repos : allowed
    const [{ issues, pulls }, status] = await Promise.all([
      fetchBoardRepositories(repos, context.env.token),
      readStatus({ bin: context.env.bin, configPath: context.env.stateFile, org: context.env.org, repos }),
    ])
    const board = buildBoardView({
      context, issues: issues.live, pulls: pulls.live, status, now: Date.now(),
      warnings: [...issues.reasons, ...pulls.reasons],
      issueRepositories: issues.repositories, pullRepositories: pulls.repositories,
    })
    const activity = buildActivityView(context, status)
    const used = new Set<string>()
    const take = (key: string) => { if (used.has(key)) return false; used.add(key); return true }
    const decision = (board.columns.find(column => column.label === 'needs-operator')?.issues ?? []).flatMap(issue => {
      const key = `${issue.repo}#${issue.number}`
      return take(key) ? [{ key, title: `${issue.repo} #${issue.number}: ${issue.title}`, detail: 'A verified workflow snapshot reports that an operator decision is required.', href: issue.url, observedAt: issue.updatedAt }] : []
    })
    const blocked = activity.rows.filter(row => row.sharedState === 'blocked' || (row.terminationCause !== null && row.terminationCause !== 'succeeded')).flatMap(row => {
      const key = `${row.repo}#${row.issue}`
      return take(key) ? [{ key, title: `${row.repo} #${row.issue}`, detail: row.recovery ? `Recovery: ${row.recovery.action}. ${row.recovery.reason}` : row.terminationCause ?? 'Shared task state is blocked.', href: `https://github.com/${row.repo}/issues/${row.issue}`, observedAt: row.lastObservedAt }] : []
    })
    const running = activity.rows.filter(row => row.sharedState === 'running').flatMap(row => {
      const key = `${row.repo}#${row.issue}`
      return take(key) ? [{ key, title: `${row.repo} #${row.issue}`, detail: `Current machine: ${row.currentMachine ?? 'unavailable'}. Checkpoint ${row.checkpoint ? 'recorded, availability unknown' : 'unavailable'}.`, href: `https://github.com/${row.repo}/issues/${row.issue}`, observedAt: row.lastObservedAt }] : []
    })
    const merged = activity.rows.filter(row => row.mergedAt !== null).sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!)).flatMap(row => {
      const key = `${row.repo}#${row.issue}`
      return take(key) ? [{ key, title: `${row.repo} #${row.issue}`, detail: row.releasedAt ? 'Merged into main and release activity recorded.' : 'Merged into main; release remains separate.', href: `https://github.com/${row.repo}/issues/${row.issue}`, observedAt: row.mergedAt }] : []
    })
    const incomplete = !board.issuesComplete || activity.state.partial || activity.state.availability === 'failed' || activity.state.availability === 'unavailable'
    const reasons = [...new Set([
      ...board.reasons.map(() => 'Some workflow or GitHub observations are incomplete.'),
      ...activity.state.reasons,
    ])]

    return (
      <Shell title={`${context.env.org} attention`} freshness={board.freshness} pathname="/" filters={context.filters}>
        <FilterBar base="/" options={context.options} filters={context.filters} />
        {reasons.length > 0 && (
          <section aria-label="Data state" role="status" className="border-border bg-muted text-muted-foreground mb-6 rounded-lg border px-4 py-3 text-sm">
            <p className="text-foreground font-medium">Available attention data is shown.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            <p className="mt-2">Refresh after restoring the reported source or policy. This page is read-only.</p>
          </section>
        )}
        <AttentionSections decision={decision} blocked={blocked} running={running} merged={merged} incomplete={incomplete} />
      </Shell>
    )
  })
}

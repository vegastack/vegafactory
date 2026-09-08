import { createHash } from 'node:crypto'
import { WORKFLOW_STATES } from '../live/status'
import type { PageContext } from '../context'
import { freshnessAt, type Freshness } from '../freshness'
import type { Live, LiveIssue, LivePull, RepoCompleteness } from '../live/github'
import type { StatusReport, StatusWorktree } from '../live/status'

// The five workflow states, in the order work moves through them. They are the labels the
// conventions define, and the board is a projection of those labels — never a second state store.
export const STATES = ['needs-operator', 'needs-plan', 'ready', 'working', 'for-operator'] as const

export interface BoardView {
  columns: Array<{ label: string; issues: LiveIssue[] }>
  pulls: LivePull[]
  worktrees: StatusWorktree[]
  freshness: Freshness
  reasons: string[]
  issuesComplete: boolean
  pullsComplete: boolean
  repositories: Array<{ repo: string; complete: boolean; reasons: string[]; observedAt: string }>
}

// Every live source contributes independently: GitHub down still leaves the worktree list the
// local dispatcher reported, and the columns render empty rather than the page erroring. What a
// reader must never get is an empty column that looks like a fact — hence the reasons list and
// the offline flag, which the banner renders above the board. `warnings` are the per-repo
// failures behind a live read that still answered for other repos: they set offline and reach
// the banner without emptying the columns the healthy repos filled.
export function buildBoardView({ context, issues, pulls, status, now, warnings = [], issueRepositories = [], pullRepositories = [] }: {
  context: PageContext
  issues: Live<LiveIssue[]>
  pulls: Live<LivePull[]>
  status: Live<StatusReport>
  now: number
  warnings?: string[]
  issueRepositories?: RepoCompleteness[]
  pullRepositories?: RepoCompleteness[]
}): BoardView {
  const reasons: string[] = []
  if (!issues.ok) reasons.push(issues.reason)
  if (!pulls.ok) reasons.push(pulls.reason)
  if (!status.ok) reasons.push(status.reason)
  for (const warning of warnings) if (!reasons.includes(warning)) reasons.push(warning)

  const observations = [...issueRepositories, ...pullRepositories]
  const repositories = [...new Set(observations.map(row => row.repo))].map(repo => {
    const sources = observations.filter(row => row.repo === repo)
    const failures = [...new Set(sources.flatMap(row => row.reason ? [row.reason] : []))]
    return { repo, complete: sources.every(row => row.complete), reasons: failures,
      observedAt: sources.map(row => row.observedAt).sort()[0]! }
  })
  for (const row of repositories) for (const reason of row.reasons) if (!reasons.includes(reason)) reasons.push(reason)
  let issuesComplete = issues.ok && issueRepositories.every(row => row.complete)
  const pullsComplete = pulls.ok && pullRepositories.every(row => row.complete)
  const rows = issues.ok ? issues.data : []
  const columns: BoardView['columns'] = STATES.map(label => ({ label, issues: [] }))
  const unresolved: LiveIssue[] = []
  for (const issue of rows) {
    const snapshots = status.ok ? status.data.repos.filter(row => row.repo === issue.repo) : []
    const snapshot = snapshots.length === 1 ? snapshots[0]?.workflow : null
    const digest = createHash('sha256').update(JSON.stringify([...new Set(issue.labels)].sort())).digest('hex')
    const age = snapshot ? now - Date.parse(snapshot.observedAt) : NaN
    const matches = snapshot?.issues.filter(row => row.nodeId === issue.nodeId) ?? []
    const semantic = matches.length === 1 ? matches[0] : null
    const reason: string | null = !snapshot ? 'workflow snapshot missing or malformed' : !snapshot.complete ? 'workflow snapshot incomplete: ' + snapshot.blocks.join('; ')
      : !Number.isFinite(age) || age < 0 || age >= 300_000 ? 'workflow snapshot stale'
      : !semantic || semantic.number !== issue.number ? 'workflow identity missing or mismatched'
      : semantic.labelsDigest !== digest ? 'workflow labels changed since observation'
      : semantic.state === null || semantic.blocks.length ? semantic.blocks.join('; ') || 'workflow state unresolved' : null
    if (reason) {
      issuesComplete = false
      reasons.push(`${issue.repo ?? 'unknown repository'} #${issue.number}: ${reason}${snapshot ? ' (observed ' + snapshot.observedAt + ')' : ''}`)
      unresolved.push(issue)
    } else {
      const index = WORKFLOW_STATES.indexOf(semantic!.state!)
      if (index < 0) { unresolved.push(issue); issuesComplete = false; reasons.push('workflow state unavailable') }
      else columns[index]!.issues.push(issue)
    }
  }
  const observedRepos = new Set([...observations.map(row => row.repo), ...rows.map(row => row.repo)])
  if (status.ok) for (const row of status.data.repos) {
    if (!observedRepos.has(row.repo)) continue
    const snapshot = row.workflow
    if (!snapshot) continue
    const entry = repositories.find(item => item.repo === row.repo)
    const complete = snapshot.complete && now >= Date.parse(snapshot.observedAt) && now - Date.parse(snapshot.observedAt) < 300_000
    if (entry) { entry.complete &&= complete; entry.observedAt = [entry.observedAt, snapshot.observedAt].sort()[0]! }
    else repositories.push({ repo: row.repo, complete, reasons: snapshot.blocks, observedAt: snapshot.observedAt })
    if (!complete) { issuesComplete = false; reasons.push(row.repo + ': workflow snapshot incomplete or stale (observed ' + snapshot.observedAt + ')') }
  }
  for (const row of issueRepositories) {
    if (!status.ok || !status.data.repos.some(repo => repo.repo === row.repo && repo.workflow)) {
      issuesComplete = false
      const entry = repositories.find(repo => repo.repo === row.repo)
      if (entry) entry.complete = false
      reasons.push(row.repo + ': workflow snapshot unavailable')
    }
  }
  if (unresolved.length) columns.push({ label: 'Unresolved', issues: unresolved })
  for (const column of columns) column.issues.sort((a, b) => a.number - b.number)
  return {
    issuesComplete, pullsComplete, repositories, columns,
    pulls: pulls.ok ? pulls.data : [],
    worktrees: status.ok ? status.data.repos.flatMap((repo) => repo.worktrees) : [],
    freshness: freshnessAt({ syncedAt: context.freshness.syncedAt, now, liveOk: reasons.length === 0 }),
    reasons,
  }
}

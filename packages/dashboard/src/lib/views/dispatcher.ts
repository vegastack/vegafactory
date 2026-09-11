import type { PageContext } from '../context'
import { freshnessAt, type Freshness } from '../freshness'
import type { Live } from '../live/github'
import type { StatusReport } from '../live/status'

export interface DispatcherView {
  running: boolean | null
  pid: number | null
  lastTick: string | null
  interval: number | null
  repos: StatusReport['repos']
  freshness: Freshness
  reasons: string[]
}

// A failed status read does not prove either idle or running. Keep it unknown so the operator is
// directed to restore observation rather than act on an invented state.
export function buildDispatcherView({ context, status, now }: {
  context: PageContext
  status: Live<StatusReport>
  now: number
}): DispatcherView {
  if (!status.ok) {
    return {
      running: null, pid: null, lastTick: null, interval: null, repos: [],
      freshness: freshnessAt({ syncedAt: context.freshness.syncedAt, now, liveOk: false }),
      reasons: [status.reason],
    }
  }
  return {
    running: status.data.dispatcher.running,
    pid: status.data.dispatcher.pid,
    lastTick: status.data.dispatcher.lastTick,
    interval: status.data.dispatcher.interval,
    repos: status.data.repos,
    freshness: freshnessAt({ syncedAt: context.freshness.syncedAt, now, liveOk: true }),
    reasons: status.data.repos.flatMap(repo=>[
      ...repo.runs.filter(run=>(run.pendingDelivery??0)>0||run.terminationCause==='termination-unconfirmed').map(run=>`${repo.repo} #${run.issue}: ${run.terminationCause??run.state??'unknown'}${run.pendingDelivery?` · ${run.pendingDelivery} deliveries pending`:''}`),
      ...(repo.recovery??[]).map(row=>`${repo.repo}${row.issue===null?'':` #${row.issue}`}: recovery ${row.action} · ${row.reason}`),
    ]),
  }
}

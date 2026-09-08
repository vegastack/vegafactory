import { expect, test } from 'bun:test'

import { serializeExport } from '../../cli/src/stats/privacy'
import { destinationKey, type Destination, type LocalMeasurement } from '../../cli/src/stats/types'
import type { PageContext } from '../src/lib/context'
import type { StatusReport } from '../src/lib/live/status'
import { buildActivityView } from '../src/lib/views/activity'
import { buildPerformanceView } from '../src/lib/views/performance'
import { contextFixture } from './helpers/context'

const repo = 'vegastack/vegafactory'
const foreignRepo = 'vegastack/site'
const destination = (name = repo): Destination => ({ host: 'github.com', org: 'vegastack', repo: name, controlRoom: 'vegastack/control-room' })
const evidence = { repo, issue: 151, commentId: 1, nodeId: 'IC_evidence', bodySha256: 'a'.repeat(64) }
const taskRef = { repo, issue: 151, taskId: '151-T2' }

function insert(context: PageContext, local: LocalMeasurement, target = destination()): void {
  const eventId = crypto.randomUUID()
  const wire = serializeExport(local, target, eventId, { values: { 'stats-export': 'attributed' } })
  if (!wire) throw new Error('fixture export unexpectedly suppressed')
  const { destination: _destination, eventId: _eventId, metricVersion: _metricVersion, ...payload } = wire
  context.db.query('insert into events(destination,event_id,payload_sha256,payload_json) values(?,?,?,?)')
    .run(destinationKey(target), eventId, 'b'.repeat(64), JSON.stringify(payload))
}

async function measuredContext(): Promise<PageContext> {
  const context = await contextFixture({ month: 'SEP-2026', viewer: 'dev1', statsPeople: 'on' })
  context.allowedRepos = [repo]
  context.filters = { ...context.filters, allowedRepos: [repo], attributedRepos: [repo], repos: [] }
  context.options.repos = [repo]
  context.db.query("insert into metric_metadata(key,value_json) values('allowedRepos',?) on conflict(key) do update set value_json=excluded.value_json").run(JSON.stringify([repo]))
  context.db.query("insert into metric_metadata(key,value_json) values('subscriptionFee',?) on conflict(key) do update set value_json=excluded.value_json").run(JSON.stringify({ amount: 20, currency: 'USD', period: '2026-09', source: 'operator-supplied' }))
  context.db.query('insert into activity_collections(repo,period,payload_json) values(?,?,?)').run(repo, '2026-09', JSON.stringify({ activities: [], snapshots: [], complete: true, reason: null, observedAt: '2026-09-30T00:00:00.000Z', sourceDigest: 'c'.repeat(64) }))

  insert(context, {
    schemaVersion: 2, recordKind: 'execution', utcDay: '2026-09-08', stage: 'implement', outcome: 'succeeded',
    executionRef: crypto.randomUUID(), attempt: 1, taskRef, taskOwner: 'dev1', agentAccountOwner: 'agent-a',
    durationSeconds: null, tokensIn: 0, tokensOut: 0, cacheReadTokens: null, cacheWriteTokens: null,
    costUsd: 0, operatorMinutes: 0, apiEquivalentUsd: 1.25,
    estimateBasis: { sourceUrl: 'https://example.com/pricing', checkedAt: '2026-09-01T00:00:00.000Z', priceDigest: 'd'.repeat(64), currency: 'USD', model: 'fixture' },
  })
  insert(context, {
    schemaVersion: 2, recordKind: 'execution', utcDay: '2026-09-09', stage: 'review', outcome: 'failed',
    executionRef: crypto.randomUUID(), attempt: 1, taskRef: null, taskOwner: null, agentAccountOwner: null,
    durationSeconds: 10, costUsd: null, operatorMinutes: null, apiEquivalentUsd: null, estimateBasis: null,
  })
  insert(context, {
    schemaVersion: 2, recordKind: 'execution', utcDay: '2026-09-09', stage: 'review', outcome: 'succeeded',
    executionRef: crypto.randomUUID(), attempt: 1, taskRef: { repo: foreignRepo, issue: 77, taskId: 'FOREIGN' }, taskOwner: 'other', agentAccountOwner: 'other-agent',
    durationSeconds: 99, costUsd: 99,
  }, destination(foreignRepo))
  for (const [activityId, kind, occurredAt] of [
    ['implemented', 'implemented', '2026-09-05T00:00:00.000Z'],
    ['review', 'review', '2026-09-06T00:00:00.000Z'],
    ['fix', 'fix', '2026-09-07T00:00:00.000Z'],
    ['handback', 'handback', '2026-09-08T00:00:00.000Z'],
    ['merged', 'merged', '2026-09-09T00:00:00.000Z'],
  ] as const) {
    insert(context, {
      schemaVersion: 2, recordKind: 'activity', utcDay: occurredAt.slice(0, 10), taskRef, taskOwner: 'dev1', agentAccountOwner: 'agent-a',
      activity: {
        taskRef, activityId, kind, occurredAt, sourceRef: evidence,
        deliveryRef: kind === 'merged' ? { repo, pr: 9, prNodeId: 'PR_delivery', acceptedParentHead: 'e'.repeat(40), mergedCommit: 'f'.repeat(40) } : null,
      },
    })
  }
  insert(context, {
    schemaVersion: 2, recordKind: 'rework-snapshot', utcDay: '2026-09-30', taskRef, taskOwner: 'dev1',
    reworkSnapshot: { taskRef, asOf: '2026-09-30T00:00:00.000Z', sourceRef: evidence, counterEpoch: `${'1'.repeat(64)}:v2`, reviewRounds: 3, fixRounds: 2, handbacks: 1, historyComplete: true, historyStart: '2026-01-01T00:00:00.000Z' },
  })
  return context
}

test('performance keeps zero, unknown coverage, report fee, estimates, unlinked runs, and typed rework separate', async () => {
  const view = buildPerformanceView(await measuredContext())
  expect(view.state).toMatchObject({ availability: 'ready', partial: true })
  expect(view.totals).toMatchObject({ runs: 2, costUsd: 0, operatorMinutes: 0, apiEquivalentUsd: 1.25, subscriptionFee: { amount: 20 } })
  expect(view.totals?.coverage.costUsd).toMatchObject({ known: 1, unknown: 1, availability: 'partial' })
  expect(view.unlinkedExecutions).toBe(1)
  expect(view.issues.map(row => `${row.repo}#${row.issue}`)).toEqual([`${repo}#151`])
  expect(view.totals?.reviewRounds).toBe(1)
  expect(view.totals?.fixRounds).toBe(1)
  expect(view.totals?.handbacks).toBe(1)
  expect(view.totals?.lifetime).toEqual([{ taskRef, asOf: '2026-09-30T00:00:00.000Z', reviewRounds: 3, fixRounds: 2, handbacks: 1 }])
  expect(JSON.stringify(view)).not.toContain(foreignRepo)
})

test('activity joins a same-task handoff once and retains distinct simultaneous tasks', async () => {
  const context = await measuredContext()
  const history = {
    coverage: 'complete' as const,
    events: [
      { kind: 'acquire' as const, generation: 1, machineId: 'machine-a', previousMachineId: null, sourceCommit: '1'.repeat(40), observedAt: '2026-09-01T00:00:00.000Z' },
      { kind: 'handoff' as const, generation: 2, machineId: 'machine-b', previousMachineId: 'machine-a', sourceCommit: '2'.repeat(40), observedAt: '2026-09-08T00:00:00.000Z' },
    ],
  }
  const status: StatusReport = {
    dispatcher: { running: true, pid: 1, lastTick: '2026-09-09T00:00:00.000Z', interval: 60 },
    repos: [
      { repo, dispatch: 'local', board: { needsPlan: 0, ready: 0, working: 2, forOperator: 0 }, worktrees: [], runs: [], shared: { head: '2'.repeat(40), refusal: null, tasks: [
        { taskKey: 'a'.repeat(64), repo, issue: 151, state: 'running', machineId: 'machine-b', generation: 2, sourceCommit: '2'.repeat(40), originMachineId: 'machine-a', lastTransitionObservedAt: '2026-09-08T00:00:00.000Z', checkpoint: { headSha: '3'.repeat(40), publishedAt: '2026-09-08T00:00:00.000Z', sourceCommit: '2'.repeat(40), availability: 'unknown' }, history },
        { taskKey: 'b'.repeat(64), repo, issue: 152, state: 'running', machineId: 'machine-c', generation: 1 },
      ] } },
      { repo: foreignRepo, dispatch: 'local', board: { needsPlan: 0, ready: 0, working: 1, forOperator: 0 }, worktrees: [], runs: [], shared: { head: null, refusal: null, tasks: [{ taskKey: 'c'.repeat(64), repo: foreignRepo, issue: 77, state: 'running', machineId: 'foreign-machine', generation: 1 }] } },
    ],
  }
  const view = buildActivityView(context, { ok: true, data: status })
  expect(view.rows.map(row => row.issue)).toEqual([151, 152])
  expect(view.rows[0]).toMatchObject({ taskOwner: 'dev1', agentAccountOwner: 'agent-a', currentMachine: 'machine-b', originMachine: 'machine-a', checkpoint: { availability: 'unknown' } })
  expect(view.rows[0]?.history.events.map(event => event.kind)).toEqual(['acquire', 'handoff'])
  expect(JSON.stringify(view)).not.toContain('foreign-machine')
})

test('missing or empty authorization never becomes an empty full-org report', async () => {
  const context = await contextFixture({ month: 'SEP-2026' })
  context.allowedRepos = []
  context.filters = { ...context.filters, allowedRepos: [], attributedRepos: [], repos: [] }
  const performance = buildPerformanceView(context)
  const activity = buildActivityView(context, { ok: false, reason: 'status unavailable' })
  expect(performance.state.availability).toBe('unavailable')
  expect(performance.repos).toEqual([])
  expect(activity.state.availability).toBe('unavailable')
  expect(activity.rows).toEqual([])
})

test('personal activity keeps task-owner and account-owner grants separate', async () => {
  const context = await measuredContext()
  const access = { kind: 'person' as const, subject: 'agent-a', dimension: 'account-owner' as const }
  context.access = access
  context.filters = { ...context.filters, access }
  const account = buildActivityView(context, { ok: true, data: { dispatcher: { running: false, pid: null, lastTick: null, interval: null }, repos: [] } })
  expect(account.rows).toHaveLength(1)
  expect(account.rows[0]).toMatchObject({ issue: 151, taskOwner: 'dev1', agentAccountOwner: 'agent-a', terminalSegments: 1 })
  const wrong = { kind: 'person' as const, subject: 'agent-a', dimension: 'task-owner' as const }
  context.access = wrong
  context.filters = { ...context.filters, access: wrong }
  expect(buildActivityView(context, { ok: true, data: { dispatcher: { running: false, pid: null, lastTick: null, interval: null }, repos: [] } }).rows).toEqual([])
})

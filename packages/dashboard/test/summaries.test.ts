import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshnessFrom } from '../src/lib/freshness'
import { parseSummary, readOrgSkills, readOrgSummary, readRepoSummary, repoSegment } from '../src/lib/stats/summaries'

const now = Date.parse('2026-09-03T12:00:00.000Z')
const state = (iso: string, org = 'vegastack') => JSON.stringify({
  schemaVersion: 1,
  controlRooms: { [org]: { repo: 'vegastack/vegafactory-control-room', path: '/c', branch: 'main', lastSyncedAt: iso, sha: 'abc1234' } },
})

// The CLI's rollup fixtures are the writer's own bytes (packages/cli/test/stats-rollup.test.ts
// holds them to that), laid out here exactly as `stats rollup` and `stats push` lay them out in
// the control room. Reading them through the same functions the pages call is what makes the
// writer and this reader one shape.
const writerFixtures = join(import.meta.dir, '../../cli/test/fixtures/stats/SEP-2026')
async function roomWithSummaries(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vf-summaries-'))
  await mkdir(join(root, 'stats', 'vegastack__vegafactory'), { recursive: true })
  await mkdir(join(root, 'stats', 'org'), { recursive: true })
  await copyFile(join(writerFixtures, 'vegafactory.summary.json'), join(root, 'stats', 'vegastack__vegafactory', 'SEP-2026.summary.json'))
  await copyFile(join(writerFixtures, 'org.summary.json'), join(root, 'stats', 'org', 'SEP-2026.summary.json'))
  await copyFile(join(writerFixtures, 'org.skills.json'), join(root, 'stats', 'org', 'SEP-2026.skills.json'))
  return root
}

test('the repo summary is found where the CLI writes it and read in the shape the CLI writes', async () => {
  const root = await roomWithSummaries()
  expect(repoSegment('vegastack/vegafactory')).toBe('vegastack__vegafactory')
  const summary = await readRepoSummary(root, 'vegastack/vegafactory', 'SEP-2026')
  expect(summary).not.toBeNull()
  expect(summary).toMatchObject({
    scope: 'vegastack/vegafactory', month: 'SEP-2026', runs: 5,
    leadTimeH: { p50: 48, p90: 48 },
    cycleTimeH: { ready: { p50: 12, p90: 12 }, working: { p50: 24, p90: 24 } },
    rework: { reviewRounds: 3, fixRounds: 1, handbacks: 1 },
    throughput: { issuesTouched: 2, issuesClosed: 1 },
    missing: [],
  })
  expect(await readRepoSummary(root, 'vegastack/other', 'SEP-2026')).toBeNull()
})

test('the org summary carries cost and runs and is not asked for what the writer never puts there', async () => {
  const root = await roomWithSummaries()
  const summary = await readOrgSummary(root, 'SEP-2026')
  expect(summary).toMatchObject({ scope: 'org', runs: 5, costUsd: 6.7, missing: [] })
})

test('the org skills rollup yields invocations per skill, and null when the document is not one', async () => {
  const root = await roomWithSummaries()
  expect(await readOrgSkills(root, 'SEP-2026')).toEqual({
    'dev-architect': 1, 'dev-implement': 2, 'dev-plan': 1, 'dev-review': 1, 'dev-ship': 1,
  })
  await writeFile(join(root, 'stats', 'org', 'AUG-2026.skills.json'), JSON.stringify({ schemaVersion: 1, month: 'AUG-2026' }))
  expect(await readOrgSkills(root, 'AUG-2026')).toBeNull()
  expect(await readOrgSkills(root, 'JUL-2026')).toBeNull()
})

test('a summary is read field by field, and what it lacks is named rather than guessed', () => {
  const summary = parseSummary('repo', 'vegastack/vegafactory', 'SEP-2026', JSON.stringify({
    runs: 12, lead_time_h: { p50: null, p90: null }, cycle_time_h: { ready: { p50: 2, p90: 5 } },
    rework: { review_rounds: null, fix_rounds: 1, handbacks: 2, runs_with_rework: 1 },
  }))
  expect(summary.leadTimeH).toEqual({ p50: null, p90: null })
  expect(summary.cycleTimeH).toEqual({ ready: { p50: 2, p90: 5 } })
  expect(summary.rework).toEqual({ reviewRounds: null, fixRounds: 1, handbacks: 2 })
  expect(summary.missing).toEqual(['rework.review_rounds', 'throughput.issues_touched', 'throughput.issues_closed'])
  expect(parseSummary('org', 'org', 'SEP-2026', '{not json')).toMatchObject({ cycleTimeH: {}, missing: ['document'] })
  expect(parseSummary('org', 'org', 'SEP-2026', JSON.stringify({ runs: 1 })).missing).toEqual(['cost_usd'])
})

test('freshness reads the org entry sync wrote; a failed live read only sets offline', () => {
  expect(freshnessFrom({ factoryJson: state('2026-09-03T11:30:00.000Z'), org: 'vegastack', now, liveOk: true }))
    .toEqual({ syncedAt: '2026-09-03T11:30:00.000Z', ageMinutes: 30, label: 'synced 30 minutes ago', offline: false })
  expect(freshnessFrom({ factoryJson: null, org: 'vegastack', now, liveOk: true }).label).toBe('never synced')
  expect(freshnessFrom({ factoryJson: state('2026-09-03T11:30:00.000Z', 'other'), org: 'vegastack', now, liveOk: true }).label).toBe('never synced')
  expect(freshnessFrom({ factoryJson: state('2026-09-03T09:00:00.000Z'), org: 'vegastack', now, liveOk: false }))
    .toMatchObject({ offline: true, label: 'synced 3 hours ago' })
})

test('v2 summary reader exposes coverage and merged states without reusing legacy close or human-touch metrics', async () => {
  const {rollupMeasuredRepo}=await import('../../cli/src/stats/rollup')
  const {serializeExport,readExport}=await import('../../cli/src/stats/privacy')
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  const wire=serializeExport({schemaVersion:2,recordKind:'execution',utcDay:'2026-09-01',stage:'implement',outcome:'succeeded',costUsd:null,tokensIn:0},destination,crypto.randomUUID(),{values:{'stats-export':'non-attributed'}})!
  const report=rollupMeasuredRepo([readExport(JSON.stringify(wire))],{repo:'o/r',month:'2026-09'})
  const parsed=parseSummary('repo','o/r','SEP-2026',JSON.stringify(report))
  expect(parsed).toMatchObject({metricVersion:2,definitionLabel:'metric v2',runs:1,costUsd:null,operatorMinutes:null,mergedIssues:null,coverage:{costUsd:{value:null,known:0,unknown:1},tokensIn:{value:0,known:1,unknown:0}}})
  expect(parsed.throughput.issuesClosed).toBeNull()
  expect(parsed.missing).toContain('task source coverage')
})

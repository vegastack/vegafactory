import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeRecord, type StatsRecord } from '../src/stats/record.ts'
import { rollupRepo, rollupOrg, rollupSkills, stableStringify } from '../src/stats/rollup.ts'

const fixtures = join(import.meta.dir, 'fixtures/stats/SEP-2026')
const records: StatsRecord[] = readFileSync(join(fixtures, 'mini.jsonl'), 'utf8')
  .trimEnd().split('\n').map((line) => JSON.parse(line) as StatsRecord)
const timelines = JSON.parse(readFileSync(join(fixtures, 'timeline-121.json'), 'utf8'))
const options = { repo: 'vegastack/vegafactory', month: 'SEP-2026', people: true }

test('the same fixture month rolls up byte-identically twice', () => {
  const first = stableStringify(rollupRepo(records, timelines, options))
  const second = stableStringify(rollupRepo(records, timelines, options))
  expect(first).toBe(second)
  expect(first).not.toContain('generatedAt')
})

test('stableStringify sorts keys', () => {
  expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
})

test('per-stage totals and rework come from the records alone', () => {
  const summary = rollupRepo(records, timelines, options)
  expect(summary.runs).toBe(records.length)
  expect(summary.by_stage.implement!.runs).toBe(2)
  expect(summary.by_stage.implement!.outcomes).toEqual({ complete: 1, handback: 1 })
  expect(summary.rework.review_rounds).toBe(3)
  expect(summary.rework.runs_with_rework).toBe(2)
})

test('lead and cycle time come from the label timeline, not from the records', () => {
  const summary = rollupRepo(records, timelines, options)
  expect(summary.lead_time_h.p50).toBe(48)
  expect(summary.cycle_time_h.ready!.p50).toBe(12)
  expect(summary.cycle_time_h.working!.p50).toBe(24)
})

test('the org summary sums its repos, sorts them, and drops people blocks when gated off', () => {
  const repoA = rollupRepo(records, timelines, options)
  const repoB = rollupRepo(records, timelines, { ...options, repo: 'vegastack/billing' })
  const org = rollupOrg([repoA, repoB], { month: 'SEP-2026', people: true })
  expect(org.repos).toEqual(['vegastack/billing', 'vegastack/vegafactory'])
  expect(org.runs).toBe(repoA.runs + repoB.runs)
  expect(rollupRepo(records, timelines, { ...options, people: false }).people).toBeNull()
  expect(rollupOrg([repoA], { month: 'SEP-2026', people: false }).people).toBeNull()
})

test('the skills summary counts invocations by trigger and harness', () => {
  const run = (ts: string, outcome: string, skills: object[]) => normalizeRecord({ repo: 'r', ts, outcome, skills } as never)
  const summary = rollupSkills([
    run('2026-09-03T10:00:00.000Z', 'complete', [{ name: 'dev-implement', trigger: 'typed', harness: 'claude' }, { name: 'dev-architect', trigger: 'model', harness: 'claude' }]),
    run('2026-09-04T10:00:00.000Z', 'handback', [{ name: 'dev-implement', trigger: 'mention', harness: 'codex' }]),
  ], { month: 'SEP-2026' })
  expect(summary.skills['dev-implement']).toEqual({
    invocations: 2, by_trigger: { mention: 1, typed: 1 },
    by_harness: { claude: 1, codex: 1 }, outcomes: { complete: 1, handback: 1 },
  })
})

test('rework never measured is null, never a confident zero, and rounds count once per issue', () => {
  const bare = records.map((record) => ({ ...record, review_rounds: null, fix_rounds: null, handbacks: null }))
  const unmeasured = rollupRepo(bare, timelines, options)
  expect(unmeasured.rework).toEqual({ review_rounds: null, fix_rounds: null, handbacks: null, runs_with_rework: 0 })
  expect(stableStringify(unmeasured)).toContain('"review_rounds":null')
  // Two runs of one issue each read the same ledger: its rounds are the issue's, counted once.
  const twice = rollupRepo([...records, { ...records[1]!, ts: '2026-09-05T10:00:00.000Z' }], timelines, options)
  expect(twice.rework.review_rounds).toBe(3)
  expect(twice.rework.fix_rounds).toBe(1)
  expect(twice.rework.handbacks).toBe(1)
})

// The three fixture summaries are the writer's exact bytes, and the dashboard's reader tests
// (packages/dashboard/test/summaries.test.ts) parse those same files: a change to the shape here
// fails this test until the fixtures are regenerated, and then fails the reader until it follows.
test('the fixture summaries are byte-identical to what the writer produces today', () => {
  const read = (name: string) => readFileSync(join(fixtures, name), 'utf8')
  const repo = rollupRepo(records, timelines, { ...options, people: false })
  expect(`${stableStringify(repo)}\n`).toBe(read('vegafactory.summary.json'))
  expect(`${stableStringify(rollupOrg([repo], { month: 'SEP-2026', people: false }))}\n`).toBe(read('org.summary.json'))
  expect(`${stableStringify(rollupSkills(records, { month: 'SEP-2026' }))}\n`).toBe(read('org.skills.json'))
})

test('strict event readers deduplicate immutable and cross-machine semantic activities and snapshots',async()=>{
  const {readMeasurementEvents}=await import('../src/stats/rollup.ts'),{serializeExport}=await import('../src/stats/privacy.ts')
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'},taskRef={repo:'o/r',issue:1,taskId:'148-T1'},sourceRef={repo:'o/r',issue:1,commentId:1,nodeId:'IC_event',bodySha256:'a'.repeat(64)}
  const event=serializeExport({schemaVersion:2,recordKind:'activity',utcDay:'2026-09-08',taskRef,activity:{taskRef,activityId:'IC_event:fix',kind:'fix',occurredAt:'2026-09-08T00:00:00Z',sourceRef,deliveryRef:null}},destination,crypto.randomUUID(),{values:{'stats-export':'attributed'}})!
  const batch=readMeasurementEvents([{source:'a',bytes:JSON.stringify(event)},{source:'b',bytes:JSON.stringify(event)},{source:'c',bytes:JSON.stringify({...event,eventId:crypto.randomUUID()})}])
  expect(batch.events).toHaveLength(1);expect(batch.duplicates).toBe(2);expect(batch.invalid).toEqual([])
  const conflict=readMeasurementEvents([{source:'a',bytes:JSON.stringify(event)},{source:'b',bytes:JSON.stringify({...event,utcDay:'2026-09-09'})}])
  expect(conflict.events).toHaveLength(0);expect(conflict.invalid).toHaveLength(2)
  const snapshot=serializeExport({schemaVersion:2,recordKind:'rework-snapshot',utcDay:'2026-09-08',taskRef,reworkSnapshot:{taskRef,asOf:'2026-09-08T00:00:00Z',sourceRef,counterEpoch:'b'.repeat(64)+':v2',reviewRounds:2,fixRounds:1,handbacks:1,historyComplete:true,historyStart:'2026-08-01T00:00:00Z'}},destination,crypto.randomUUID(),{values:{'stats-export':'attributed'}})!
  expect(readMeasurementEvents([{source:'a',bytes:JSON.stringify(snapshot)},{source:'b',bytes:JSON.stringify({...snapshot,eventId:crypto.randomUUID()})}])).toMatchObject({duplicates:1,invalid:[]})
})

test('CLI show consumes unique actual privacy exports and keeps source discovery unavailable independently',async()=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os')
  const {runStats,parseStatsArgs}=await import('../src/stats/cli.ts'),{serializeExport}=await import('../src/stats/privacy.ts'),{resolvePolicy}=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  const home=await mkdtemp(join(tmpdir(),'typed-cli-')),dir=join(home,'stats','o__r','2026-09','events'),lines:string[]=[]
  try{
    await mkdir(dir,{recursive:true})
    const event=serializeExport({schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded',executionRef:crypto.randomUUID(),costUsd:null},{host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'},crypto.randomUUID(),{values:{'stats-export':'attributed'}})!
    await writeFile(join(dir,'a.json'),JSON.stringify(event));await writeFile(join(dir,'b.json'),JSON.stringify(event))
    const effective=resolvePolicy({org:'stats: on\nstats-people: on\nstats-export: attributed\n```vsk-policy\n'+JSON.stringify({schemaVersion:2,administration:{orgAdmins:['robot'],groupAdmins:{},groupAdminCapabilities:{}}})+'\n```',identity:{org:'o',repo:'o/r',group:'dev',peopleByScope:{org:[{login:'robot',groups:['dev']}]},repoGroups:{'o/r':'dev'}}})
    expect(effective.ok).toBe(true)
    const deps:import('../src/stats/cli.ts').StatsDeps={home,cloneRoot:home,hostname:'fixture',ghUser:'robot',login:'robot',isLead:false,viewerVerified:true,effectivePolicy:effective.policy,policy:{enabled:true,people:true,source:'org',refusal:null},repo:'o/r',git:async()=>{throw Error('no git')},gh:async()=>[],readGh:async()=>{throw Error('offline')},readStdin:async()=>'',readTranscript:async()=>{throw Error('no transcript')},now:()=>new Date('2026-09-08'),log:line=>lines.push(line)}
    expect(await runStats(parseStatsArgs(['--json']),deps)).toBe(0)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({runs:1,execution:{values:{costUsd:{value:null,known:0,unknown:1}}}})
    expect(await runStats(parseStatsArgs(['rollup','--json']),deps)).toBe(1)
    expect(await runStats(parseStatsArgs(['--json']),deps)).toBe(0)
    await writeFile(join(dir,'b.json'),JSON.stringify({...event,privateReceipt:'CANARY'}))
    expect(await runStats(parseStatsArgs(['--json']),deps)).toBe(2)
    expect(lines.at(-1)).not.toContain('CANARY')
  }finally{await rm(home,{recursive:true,force:true})}
})

test('metric v2 keeps measured coverage and separate execution, activity and snapshot denominators', async () => {
  const { summarizeMeasured, summarizeIssueMonth, utcMonthBounds } = await import('../src/stats/metrics.ts')
  expect(summarizeMeasured([null, null])).toEqual({ total: null, known: 0, unknown: 2 })
  expect(summarizeMeasured([0, null, 3])).toEqual({ total: 3, known: 2, unknown: 1 })
  expect(utcMonthBounds('2024-02')).toEqual({ start: '2024-02-01T00:00:00.000Z', end: '2024-03-01T00:00:00.000Z' })
  expect(utcMonthBounds('2026-12').end).toBe('2027-01-01T00:00:00.000Z')
  expect(() => utcMonthBounds('2026-13')).toThrow()
  const taskRef = { repo: 'o/project.docs', issue: 1, taskId: 'T1' }
  const sourceRef = { repo: taskRef.repo, issue: 1, commentId: 2, nodeId: 'IC_2', bodySha256: 'a'.repeat(64) }
  const activity = (id: string, at: string, kind: 'fix' | 'merged') => ({ taskRef, activityId: id, kind, occurredAt: at, sourceRef, deliveryRef: kind === 'merged' ? {repo:taskRef.repo,pr:4,prNodeId:'PR_4',acceptedParentHead:'a'.repeat(40),mergedCommit:'b'.repeat(40)} : null })
  const events = [activity('aug','2026-08-31T23:59:59Z','fix'),activity('sep','2026-09-01T00:00:00Z','fix'),activity('sep','2026-09-01T00:00:00Z','fix'),activity('merge','2026-09-30T23:59:59Z','merged'),activity('oct','2026-10-01T00:00:00Z','merged')]
  expect(summarizeIssueMonth(events, '2026-09')).toMatchObject({ mergedIssues: 1, fixRounds: 1, reviewRounds: 0, handbacks: 0 })
  expect(summarizeIssueMonth(events, '2026-09', {complete:false})).toMatchObject({ mergedIssues:null, fixRounds:null })
})

test('snapshot rework requires both exact boundaries and monotone epoch; lifetime is one authoritative as-of', async () => {
  const {summarizeIssueMonth}=await import('../src/stats/metrics.ts')
  const taskRef={repo:'o/r',issue:1,taskId:'148-T1'},sourceRef={repo:'o/r',issue:1,commentId:1,nodeId:'IC_one',bodySha256:'a'.repeat(64)}
  const snapshot=(asOf:string,fixRounds:number,counterEpoch='b'.repeat(64)+':v2')=>({taskRef,asOf,sourceRef,counterEpoch,reviewRounds:2,fixRounds,handbacks:1,historyComplete:true,historyStart:'2026-08-01T00:00:00.000Z'})
  const baseline=snapshot('2026-09-01T00:00:00.000Z',3),end=snapshot('2026-10-01T00:00:00.000Z',4)
  const result=summarizeIssueMonth([],'2026-09',{snapshots:[baseline,baseline,end,end]})
  expect(result).toMatchObject({reviewRounds:0,fixRounds:1,handbacks:0,lifetime:[{fixRounds:4,asOf:end.asOf}]})
  expect(summarizeIssueMonth([],'2026-09',{snapshots:[end]}).fixRounds).toBeNull()
  expect(summarizeIssueMonth([],'2026-09',{snapshots:[baseline,snapshot('2026-09-20T00:00:00.000Z',4)]}).fixRounds).toBeNull()
  expect(summarizeIssueMonth([],'2026-09',{snapshots:[baseline,snapshot(end.asOf,1)]}).fixRounds).toBeNull()
  expect(summarizeIssueMonth([],'2026-09',{snapshots:[baseline,snapshot(end.asOf,4,'c'.repeat(64)+':v2')]}).fixRounds).toBeNull()
})

test('expired lifetime remains unavailable and null owners do not collide with a real unknown login', async () => {
  const {summarizeIssueMonth,summarizeExecutions}=await import('../src/stats/metrics.ts')
  const taskRef={repo:'o/r',issue:1,taskId:null},sourceRef={repo:'o/r',issue:1,commentId:1,nodeId:'IC_old',bodySha256:'a'.repeat(64)}
  const report=summarizeIssueMonth([],'2026-09',{observedAt:'2028-01-01T00:00:00.000Z',snapshots:[{taskRef,sourceRef,asOf:'2026-09-01T00:00:00.000Z',counterEpoch:'b'.repeat(64)+':v2',reviewRounds:2,fixRounds:4,handbacks:1,historyComplete:true,historyStart:'2026-08-01T00:00:00.000Z'}]})
  expect(report.lifetime).toMatchObject([{asOf:'2026-09-01T00:00:00.000Z',reviewRounds:null,fixRounds:null,handbacks:null}])
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  const events=[null,'unknown'].map(taskOwner=>({eventId:crypto.randomUUID(),destination,payload:{schemaVersion:2 as const,recordKind:'execution' as const,utcDay:'2026-09-01',stage:'implement',outcome:'succeeded',taskOwner}}))
  expect(summarizeExecutions(events).taskOwners).toEqual([{owner:null,events:1},{owner:'unknown',events:1}])
})

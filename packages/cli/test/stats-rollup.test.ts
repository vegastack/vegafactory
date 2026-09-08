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

test('event readers deduplicate immutable and cross-machine semantic identities before counting',async()=>{
  const {readMeasurementEvents}=await import('../src/stats/rollup.ts')
  const destination={host:'github.com' as const,org:'o',repo:'o/r',controlRoom:'o/room'}
  const event={eventId:crypto.randomUUID(),destination,payload:{schemaVersion:2,recordKind:'activity',utcDay:'2026-09-08',taskRef:'task',activityId:'activity'}}
  const read=(bytes:string)=>JSON.parse(bytes)
  const batch=readMeasurementEvents([{source:'a',bytes:JSON.stringify(event)},{source:'b',bytes:JSON.stringify(event)},{source:'c',bytes:JSON.stringify({...event,eventId:crypto.randomUUID()})}],read)
  expect(batch.events).toHaveLength(1);expect(batch.duplicates).toBe(2);expect(batch.invalid).toEqual([])
  expect(readMeasurementEvents([{source:'a',bytes:JSON.stringify(event)}]).invalid[0]?.reason).toBe('privacy-reader-unavailable-149')
  const conflict=readMeasurementEvents([{source:'a',bytes:JSON.stringify(event)},{source:'b',bytes:JSON.stringify({...event,payload:{...event.payload,utcDay:'2026-09-09'}})}],read)
  expect(conflict.events).toHaveLength(0);expect(conflict.invalid).toHaveLength(2)
})

test('CLI rollup and show consume unique v2 events through injected owner reader, while production refuses',async()=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os')
  const {runStats,parseStatsArgs}=await import('../src/stats/cli.ts')
  const {normalizeRecord}=await import('../src/stats/record.ts')
  const home=await mkdtemp(join(tmpdir(),'typed-cli-')),dir=join(home,'stats','o__r','2026-09','events'),lines:string[]=[]
  try{
    await mkdir(dir,{recursive:true})
    const event={eventId:crypto.randomUUID(),destination:{host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'},payload:{schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'}}
    await writeFile(join(dir,'a.json'),JSON.stringify(event));await writeFile(join(dir,'b.json'),JSON.stringify(event))
    const deps:import('../src/stats/cli.ts').StatsDeps={home,cloneRoot:home,hostname:'fixture',ghUser:'robot',login:'robot',isLead:false,policy:{enabled:true,people:false,source:'org',refusal:null},repo:'o/r',git:async()=>{throw Error('no git')},gh:async()=>[],readStdin:async()=>'',readTranscript:async()=>{throw Error('no transcript')},now:()=>new Date('2026-09-08'),log:line=>lines.push(line),exportReader:bytes=>JSON.parse(bytes),measurementRecord:e=>normalizeRecord({repo:e.destination.repo,ts:e.payload.utcDay,stage:e.payload.recordKind==='execution'?e.payload.stage:null,outcome:'complete'})}
    expect(await runStats(parseStatsArgs(['--json']),deps)).toBe(0)
    expect(JSON.parse(lines.at(-1)!).runs).toBe(1)
    expect(await runStats(parseStatsArgs(['rollup','--json']),deps)).toBe(0)
    expect(await runStats(parseStatsArgs(['--json']),{...deps,exportReader:undefined})).toBe(2)
    expect(lines.at(-1)).toContain('privacy-reader-unavailable-149')
  }finally{await rm(home,{recursive:true,force:true})}
})

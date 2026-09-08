import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CACHE_SCHEMA_VERSION, openCache, refreshCache, type Db } from '../src/lib/cache/build'

const record = (issue: number) => JSON.stringify({
  ts: '2026-09-02T10:00:00.000Z', repo: 'vegastack/vegafactory', issue, cost_usd: 0.4,
  skills: [{ name: 'dev-implement', trigger: 'model', harness: 'claude' }],
})
const count = (db: Db, t: string) => db.query<{ n: number }>(`select count(*) as n from ${t}`).get()!.n

async function room() {
  const root = await mkdtemp(join(tmpdir(), 'vf-room-'))
  const dir = join(root, 'stats', 'vegastack__vegafactory', 'SEP-2026')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'mini.jsonl'), `${record(122)}\n{bad\n`)
  return { root, file: join(dir, 'mini.jsonl'), cache: join(root, 'stats.db') }
}

test('unchanged sources are skipped, changed ones replace their rows, vanished ones drop them', async () => {
  const { root, file, cache } = await room()
  const db = await openCache(cache)
  expect(await refreshCache(db, root)).toMatchObject({ total: 1, skippedLines: 1 })
  expect(count(db, 'skill_invocations')).toBe(1)
  expect((await refreshCache(db, root)).ingested).toEqual([])
  await writeFile(file, `${record(122)}\n${record(121)}\n`)
  expect((await refreshCache(db, root)).ingested).toHaveLength(1)
  expect(count(db, 'runs')).toBe(2)
  await rm(file)
  expect((await refreshCache(db, root)).removed).toHaveLength(1)
  expect(count(db, 'runs')).toBe(0)
  db.run(`pragma user_version = ${CACHE_SCHEMA_VERSION + 1}`)
  db.close()
  expect(count(await openCache(cache), 'sources')).toBe(0)
  await writeFile(cache, 'this is not a database')
  expect(count(await openCache(cache), 'runs')).toBe(0)
})

test('the cache directory is created; the server owns the path, not the caller', async () => {
  const { root } = await room()
  const nested = join(root, 'does', 'not', 'exist', 'yet', 'stats.db')
  const db = await openCache(nested)
  expect(count(db, 'runs')).toBe(0)
})

test('immutable events deduplicate across sources, survive one source removal and reject conflicting identity',async()=>{
  const {Database}=await import('bun:sqlite'),{SCHEMA_SQL}=await import('../src/lib/cache/schema')
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
  const root=await mkdtemp(join(tmpdir(),'event-cache-')),db=new Database(':memory:');db.exec(SCHEMA_SQL)
  try{
    const dir=join(root,'stats','o__r','2026-09','events');await mkdir(dir,{recursive:true})
    const {serializeExport}=await import('../../cli/src/stats/privacy')
    const event=serializeExport({schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'},{host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'},crypto.randomUUID(),{values:{'stats-export':'non-attributed'}})!
    const a=join(dir,'a.json'),b=join(dir,'b.json');await writeFile(a,JSON.stringify(event));await writeFile(b,JSON.stringify(event))
    const reader={}
    expect((await refreshCache(db,root,reader)).eventTotal).toBe(1)
    expect(db.query('select count(*) as n from events').get()).toEqual({n:1})
    await rm(a);expect((await refreshCache(db,root,reader)).eventTotal).toBe(1)
    await writeFile(a,JSON.stringify({...event,outcome:'failed'}))
    await expect(refreshCache(db,root,reader)).rejects.toThrow('metric-invalid-events')
    expect(db.query('select count(*) as n from events').get()).toEqual({n:1})
    await expect(refreshCache(db,root)).rejects.toThrow('metric-invalid-events')
  }finally{db.close();await rm(root,{recursive:true,force:true})}
})

test('one producer/outbox/current-policy export drives equal CLI and SQLite metrics with rollback and distinct segments', async () => {
  const fs=await import('node:fs/promises'),{Database}=await import('bun:sqlite')
  const {SCHEMA_SQL}=await import('../src/lib/cache/schema'),{orgTotals,perSkill,personTotals,perIssue,unknownOwnerTotals}=await import('../src/lib/cache/queries')
  const {enqueueEvent,inspectSpool,spoolRoot}=await import('../../cli/src/stats/outbox')
  const {currentPolicySerializer}=await import('../../cli/src/stats/privacy')
  const {terminalCaptureKey,eventPath}=await import('../../cli/src/stats/types')
  const {readControlRoomEvents,rollupMeasuredRepo}=await import('../../cli/src/stats/rollup')
  const fixture=JSON.parse(await fs.readFile(join(import.meta.dirname,'../../cli/test/fixtures/stats/metric-v2.json'),'utf8'))
  const home=await mkdtemp(join(tmpdir(),'metrics-conformance-')),clone=join(home,'room'),db=new Database(':memory:');db.exec(SCHEMA_SQL)
  const runId=crypto.randomUUID(),other=crypto.randomUUID(),sequence=crypto.randomUUID()
  try{
    for(const [index,payload] of fixture.execution.entries())await enqueueEvent(spoolRoot(home),{schemaVersion:2,eventId:crypto.randomUUID(),destination:fixture.destination,captureKey:terminalCaptureKey(index<2?runId:other,index===1?sequence:'0'),payload:{...payload,localRunId:index<2?runId:other}})
    const events=(await inspectSpool(spoolRoot(home))).events,serialize=currentPolicySerializer(home,async()=>({values:{'stats-export':'attributed'},policyDigest:'a'.repeat(64)}))
    for(const event of events){const wire=await serialize(event);expect(wire).not.toBeNull();const path=join(clone,eventPath(event));await mkdir(join(path,'..'),{recursive:true});await writeFile(path,wire!.bytes)}
    const first=events[0]!,firstPath=join(clone,eventPath(first));await writeFile(join(firstPath,'..','duplicate.json'),await fs.readFile(firstPath))
    const empty={activities:[],snapshots:[],complete:true,reason:null,observedAt:'2026-09-30T00:00:00.000Z',sourceDigest:'a'.repeat(64)}
    const result=await refreshCache(db,clone,{allowedRepos:[fixture.destination.repo],org:'o',subscriptionFee:fixture.subscriptionFee,activityCollections:[{repo:fixture.destination.repo,period:fixture.period,collection:empty}]})
    expect(result).toMatchObject({eventTotal:3,duplicateEvents:1,metricVersion:2,organization:'o'})
    const batch=await readControlRoomEvents(clone),cli=rollupMeasuredRepo(batch.events.map(row=>row.event),{repo:fixture.destination.repo,month:fixture.period,collection:empty,subscriptionFee:fixture.subscriptionFee})
    const filters={month:'SEP-2026',repo:null,group:null,harness:null,model:null,repos:[],allowedRepos:[fixture.destination.repo],attributedRepos:[fixture.destination.repo]}
    const sql=orgTotals(db,filters)
    expect(cli.execution).toMatchObject({executionEvents:3,logicalExecutions:2,values:{costUsd:fixture.expected.costUsd,tokensIn:fixture.expected.tokensIn,durationSeconds:fixture.expected.durationSeconds},operatorMinutes:fixture.expected.operatorMinutes})
    expect(sql).toMatchObject({runs:3,costUsd:3,durationS:30,tokensIn:3,operatorMinutes:5,logicalExecutions:2,humanTouchpoints:null})
    expect(sql.coverage.costUsd).toEqual(cli.execution.values.costUsd)
    expect(db.query('select sum(cost_usd) as cost from measurements').get()).toEqual({cost:3})
    expect(perSkill(db,filters).map(row=>row.costUsd)).toEqual([3,3])
    expect(db.query("select value_json from metric_metadata where key='subscriptionFee'").get()).toEqual({value_json:JSON.stringify({amount:20,currency:'USD',period:'2026-09',source:'operator-supplied'})})
    const before=db.query('select * from sources order by path').all(),beforeEvents=db.query('select * from events order by event_id').all()
    const failing:Db={...db,query:db.query.bind(db) as Db['query'],close:()=>{},run:(sql,...params)=>{if(sql==='delete from events')throw Error('controlled ingestion failure');return db.run(sql,params as never)}}
    await expect(refreshCache(failing,clone,{allowedRepos:[fixture.destination.repo]})).rejects.toThrow('controlled ingestion failure')
    expect(db.query('select * from sources order by path').all()).toEqual(before)
    expect(db.query('select * from events order by event_id').all()).toEqual(beforeEvents)
    const downgraded={...filters,attributedRepos:[]}
    expect(personTotals(db,downgraded,'person')).toBeNull()
    expect(perIssue(db,downgraded)).toEqual([])
    expect(orgTotals(db,downgraded).costUsd).toBe(3)
    const personal={...filters,access:{kind:'person' as const,subject:'person',dimension:'task-owner' as const}}
    expect(personTotals(db,personal,'person')?.runs).toBe(1)
    expect(personTotals(db,personal,'account','account-owner')).toBeNull()
    expect(orgTotals(db,{...personal,repos:[],group:null}).runs).toBe(0)
    expect(perIssue(db,personal)).toEqual([])
    const {semanticCaptureKey}=await import('../../cli/src/stats/types')
    const taskRef={repo:fixture.destination.repo,issue:1,taskId:'148-T1'},sourceRef={repo:fixture.destination.repo,issue:1,commentId:5,nodeId:'IC_activity',bodySha256:'b'.repeat(64)}
    const deliveryRef={repo:fixture.destination.repo,pr:3,prNodeId:'PR_delivery',acceptedParentHead:'c'.repeat(40),mergedCommit:'d'.repeat(40)}
    const activity=(activityId:string,kind:'fix'|'merged',occurredAt:string,taskOwner:string|null='person')=>({schemaVersion:2 as const,recordKind:'activity' as const,utcDay:occurredAt.slice(0,10),taskRef,taskOwner,agentAccountOwner:'account',activity:{taskRef,activityId,kind,occurredAt,deliveryRef:kind==='merged'?deliveryRef:null,sourceRef}})
    const snapshot=(asOf:string,fixRounds:number)=>({schemaVersion:2 as const,recordKind:'rework-snapshot' as const,utcDay:asOf.slice(0,10),taskRef,taskOwner:'person',reworkSnapshot:{taskRef,asOf,sourceRef,counterEpoch:'e'.repeat(64)+':v2',reviewRounds:2,fixRounds,handbacks:1,historyComplete:true,historyStart:'2026-08-01T00:00:00.000Z'}})
    const payloads=[activity('IC_aug:fix','fix','2026-08-02T00:00:00.000Z'),activity('IC_sep:fix','fix','2026-09-02T00:00:00.000Z'),activity('PR_delivery:merged','merged','2026-09-10T00:00:00.000Z'),activity('IC_unknown:fix','fix','2026-09-03T00:00:00.000Z',null),snapshot('2026-09-01T00:00:00.000Z',3),snapshot('2026-10-01T00:00:00.000Z',4)]
    for(const payload of payloads)await enqueueEvent(spoolRoot(home),{schemaVersion:2,eventId:crypto.randomUUID(),destination:fixture.destination,captureKey:semanticCaptureKey(fixture.destination,payload),payload})
    for(const event of (await inspectSpool(spoolRoot(home))).events){const wire=await serialize(event);const path=join(clone,eventPath(event));await mkdir(join(path,'..'),{recursive:true});await writeFile(path,wire!.bytes)}
    await refreshCache(db,clone,{allowedRepos:[fixture.destination.repo],org:'o',activityCollections:[{repo:fixture.destination.repo,period:fixture.period,collection:empty}]})
    expect(personTotals(db,filters,'person')).toMatchObject({runs:1,mergedIssues:1,mergedTasks:1,fixRounds:1,lifetime:[{fixRounds:4}]})
    expect(personTotals(db,filters,'account','account-owner')).toMatchObject({runs:2,mergedIssues:1,fixRounds:2,lifetime:[]})
    expect(unknownOwnerTotals(db,filters,'task-owner')).toMatchObject({runs:2,fixRounds:1})
    expect(unknownOwnerTotals(db,personal,'task-owner')).toBeNull()
    expect(personTotals(db,downgraded,'person')).toBeNull()
    const scopedFilter={...filters,month:'OCT-2026'}
    const {filterOptions}=await import('../src/lib/cache/filters')
    expect(filterOptions(db,{[fixture.destination.repo]:'dev'},[fixture.destination.repo]).months).toContain('OCT-2026')
    expect(orgTotals(db,scopedFilter).runs).toBe(0)
  }finally{db.close();await rm(home,{recursive:true,force:true})}
})

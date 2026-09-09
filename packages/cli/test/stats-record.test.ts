import { describe, expect, test } from 'bun:test'
import {
  monthToken, parseMonthToken, repoSegment, normalizeRecord,
  recordProblems, serializeRecord, parseStatsKnobs, resolveStatsPolicy,
} from '../src/stats/record.ts'

describe('monthToken', () => {
  test('is uppercase three-letter English month plus year, in UTC', () => {
    expect(monthToken(new Date('2026-09-15T12:00:00Z'))).toBe('SEP-2026')
    expect(monthToken(new Date('2026-01-01T00:00:00Z'))).toBe('JAN-2026')
    // 02:00 IST on 1 Sep is 20:30Z on 31 Aug: the token follows UTC, not the machine.
    expect(monthToken(new Date('2026-08-31T20:30:00Z'))).toBe('AUG-2026')
  })
  test('round-trips through parseMonthToken and rejects junk', () => {
    expect(parseMonthToken('SEP-2026')).toEqual({ year: 2026, month: 9 })
    expect(parseMonthToken('sep-2026')).toBeNull()
    expect(parseMonthToken('SEPT-2026')).toBeNull()
  })
})

test('repoSegment is one filename-safe path segment', () => {
  expect(repoSegment('vegastack/vegafactory')).toBe('vegastack__vegafactory')
})

describe('normalizeRecord', () => {
  const base = { repo: 'vegastack/vegafactory', ts: '2026-09-03T10:00:00.000Z' }
  test('missing fields become null, never guesses', () => {
    const record = normalizeRecord(base)
    expect(record.issue).toBeNull()
    expect(record.cost_usd).toBeNull()
    expect(record.tokens).toEqual({ in: null, out: null, cache_read: null, cache_write: null })
    expect(record.skills).toEqual([])
  })
  test('serializeRecord emits one line with a fixed key order', () => {
    const line = serializeRecord(normalizeRecord({ ...base, issue: 121, stage: 'implement' }))
    expect(line.endsWith('\n')).toBe(false)
    expect(line.includes('\n')).toBe(false)
    expect(Object.keys(JSON.parse(line))).toEqual([
      'ts', 'repo', 'issue', 'parent', 'stage', 'harness', 'model', 'effort', 'mode',
      'human', 'session_id', 'worktree', 'duration_s', 'turns', 'tool_calls', 'subagents',
      'tokens', 'cost_usd', 'outcome', 'review_rounds', 'fix_rounds', 'handbacks', 'skills',
    ])
  })
  test('recordProblems names an unusable record instead of writing it', () => {
    const bad = { ...normalizeRecord(base), repo: '', ts: 'not-a-date' }
    expect(recordProblems(bad)).toEqual([
      'repo is empty',
      'ts is not an ISO-8601 timestamp: "not-a-date"',
    ])
    expect(recordProblems(normalizeRecord(base))).toEqual([])
  })
})

describe('resolveStatsPolicy', () => {
  const org = 'org: vegastack\nstats: on\nstats-people: on\nstats-override: allowed\n'
  const orgLocked = 'org: vegastack\nstats: on\nstats-people: off\nstats-override: locked\n'
  test('parseStatsKnobs reads only the three knob lines, and the default is on', () => {
    expect(parseStatsKnobs(org)).toEqual({ stats: 'on', statsPeople: 'on', statsOverride: 'allowed' })
    expect(resolveStatsPolicy({})).toEqual({ enabled: true, people: false, source: 'default', refusal: null })
  })
  test('group overrides org', () => {
    expect(resolveStatsPolicy({ org, group: 'stats: off\n' }))
      .toEqual({ enabled: false, people: false, source: 'group', refusal: null })
  })
  test('a repo opt-out is honoured when the org allows overrides', () => {
    expect(resolveStatsPolicy({ org, repo: 'stats: off\n' }))
      .toEqual({ enabled: false, people: false, source: 'repo', refusal: null })
  })
  test('a repo opt-out under a locked org is ignored, with the reason stated', () => {
    expect(resolveStatsPolicy({ org: orgLocked, repo: 'stats: off\n' })).toEqual({
      enabled: true,
      people: false,
      source: 'org',
      refusal: 'repo: stats override requires exact org delegation',
    })
  })
})

test('group cannot unlock org stats and malformed known knobs refuse capture', () => {
  const policy = resolveStatsPolicy({ org: 'stats: on\nstats-override: locked', group: 'stats-override: allowed', repo: 'stats: off' })
  expect(policy.enabled).toBe(true)
  expect(policy.refusal).toMatch(/delegation/)
  expect(resolveStatsPolicy({ repo: 'stats: nonsense' }).refusal).toMatch(/stats/)
})

import { serializeExport as privacySerialize, validateExport, readExport as privacyRead, reportingExecutionRef, projectLegacyStats } from '../src/stats/privacy.ts'
import { canonicalJson, type Destination, type LocalMeasurement } from '../src/stats/types.ts'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const destination:Destination={host:'github.com',org:'o',repo:'o/r',controlRoom:'o/room'}
const eventId='9d31a521-53ea-4c39-bb58-213739ab6d47'
const localExecution:Extract<LocalMeasurement,{recordKind:'execution'}>={schemaVersion:2,recordKind:'execution',utcDay:'2026-09-06',stage:'implement',outcome:'succeeded',costUsd:null,turns:0}
const nonAttributed={values:{'stats-export':'non-attributed'}}
const legacyProjection={ts:'2026-09-06T00:00:00.000Z',repo:'o/r',stage:'corrections',harness:null,model:null,effort:null,mode:null,human:null,outcome:'handback',skills:[{name:'dev-implement',trigger:'typed',harness:'codex'}]}
test('legacy compatibility projection keeps historical nulls and rejects every retained unsafe string',()=>{
 expect(projectLegacyStats(legacyProjection)).toEqual(legacyProjection)
 expect(projectLegacyStats({...legacyProjection,outcome:'for-operator'})).toEqual({...legacyProjection,outcome:'handback'})
 expect(projectLegacyStats({...legacyProjection,stage:'ship'})).toEqual({...legacyProjection,stage:'ship'})
 const encode=(value:string)=>Buffer.from(value).toString('base64').replace(/=+$/,'')
 const encoded=(value:string)=>[encode(value),encode(encode(value)),encode(encode(encode(value)))]
 const canaries=['ghp_12345678901234567890','%67%68%70%5f12345678901234567890',...encoded('ghp_12345678901234567890'),'/Users/private/project','%2FUsers%2Fprivate%2Fproject',...encoded('/Users/private/project'),'C:\\Users\\private\\project','C%3A%5CUsers%5Cprivate%5Cproject',...encoded('C:\\Users\\private\\project'),'-----BEGIN PRIVATE KEY-----',...encoded('-----BEGIN PRIVATE KEY-----'),encode('private\ncontent-long'),encode('private\0content-long')]
 for(const canary of canaries){
  for(const field of ['ts','repo','stage','harness','model','effort','mode','human','outcome'] as const)expect(()=>projectLegacyStats({...legacyProjection,[field]:field==='repo'?`o/${canary}`:canary})).toThrow()
  for(const field of ['name','trigger','harness'] as const)expect(()=>projectLegacyStats({...legacyProjection,skills:[{...legacyProjection.skills[0]!,[field]:canary}]})).toThrow()
 }
 for(const [field,value] of [['stage','deploy'],['mode','batch'],['outcome','ready']] as const)expect(()=>projectLegacyStats({...legacyProjection,[field]:value})).toThrow()
 expect(()=>projectLegacyStats({...legacyProjection,harness:'x'.repeat(129)})).toThrow('privacy-invalid-identifier')
 expect(()=>projectLegacyStats({...legacyProjection,skills:[{...legacyProjection.skills[0]!,trigger:'implicit'}]})).toThrow('privacy-invalid-skill-trigger')
 expect(()=>projectLegacyStats({...legacyProjection,skills:Array.from({length:129},()=>legacyProjection.skills[0])})).toThrow('privacy-invalid-skills')
})
test('privacy schema projects private canaries away and distinguishes zero from unknown',()=>{
 const local={...localExecution,hostname:'PRIVATE_HOST_CANARY',stdout:'ghp_SECRET_CANARY',argv:['/Users/CANARY'],values:{human:'PRIVATE_HUMAN_CANARY',session_id:'PRIVATE_SESSION_CANARY',worktree:'/Users/CANARY'}}
 const wire=privacySerialize(local,destination,eventId,nonAttributed)!
 expect(canonicalJson(wire)).not.toContain('CANARY')
 expect(wire.recordKind).toBe('execution')
 if(wire.recordKind!=='execution')throw Error('execution expected')
 expect(wire.turns).toBe(0);expect(wire.costUsd).toBeNull()
 expect(wire.coverage.turns).toEqual({known:1,unknown:0})
 expect(wire.coverage.costUsd).toEqual({known:0,unknown:1})
 expect(privacyRead(canonicalJson(wire)).eventId).toBe(eventId)
 expect(()=>validateExport({...wire,argv:[]})).toThrow('privacy-unknown-or-missing-field')
 expect(()=>validateExport({...wire,skills:[{name:'tool',trigger:'typed',harness:'codex',raw:'CANARY'}]})).toThrow()
 expect(()=>privacySerialize({...localExecution,costUsd:-1},destination,eventId,nonAttributed)).toThrow('privacy-invalid-number')
 expect(()=>privacySerialize({...localExecution,turns:0.5},destination,eventId,nonAttributed)).toThrow('privacy-invalid-number')
})
test('attributed reporting identity is random, private, stable across retries, with unknown owners',async()=>{
 const root=await mkdtemp(join(tmpdir(),'privacy-149-'))
 try{
  const run='0d31a521-53ea-4c39-bb58-213739ab6d47'
  const executionRef=await reportingExecutionRef(root,run,destination)
  const {hashBytes,destinationId}=await import('../src/stats/types.ts')
  expect(executionRef).not.toBe(run);expect(await reportingExecutionRef(root,run,destination)).toBe(executionRef)
  expect((await stat(join(root,'reporting-identities',hashBytes(canonicalJson([destinationId(destination),run+':terminal:0']))+'.json'))).mode&0o777).toBe(0o600)
  const wire=privacySerialize({...localExecution,executionRef},destination,eventId,{values:{'stats-export':'attributed'}})!
  expect(wire).toMatchObject({executionRef,taskRef:null,taskOwner:null,agentAccountOwner:null})
  expect(canonicalJson(wire)).not.toContain(run)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('activity and rework snapshots have exact identities and suppression is not malformed success',()=>{
 const taskRef={repo:'o/r',issue:149,taskId:'149-T1'}
 const sourceRef={repo:'o/r',issue:149,commentId:123,nodeId:null,bodySha256:'a'.repeat(64)}
 const activity:LocalMeasurement={schemaVersion:2,recordKind:'activity',utcDay:'2026-09-06',taskRef,activity:{taskRef,activityId:'comment-123',kind:'fix',occurredAt:'2026-09-06T00:00:00Z',deliveryRef:null,sourceRef}}
 const attributed={values:{'stats-export':'attributed'}}
 expect(privacySerialize(activity,destination,eventId,nonAttributed)).toBeNull()
 const wire=privacySerialize(activity,destination,eventId,attributed)!
 expect(wire).not.toHaveProperty('outcome');expect(wire).not.toHaveProperty('executionRef')
 expect(()=>validateExport({...wire,outcome:'succeeded'})).toThrow()
 expect(()=>privacySerialize({...activity,activity:{...activity.activity!,sourceRef:{...sourceRef,repo:'o/foreign'}}},destination,eventId,nonAttributed)).toThrow('privacy-foreign-evidence-repository')
 expect(()=>validateExport({...wire,activity:{...activity.activity,taskRef:{...taskRef,issue:150}}})).toThrow('privacy-task-reference-mismatch')
 const snapshot:LocalMeasurement={schemaVersion:2,recordKind:'rework-snapshot',utcDay:'2026-09-06',taskRef,reworkSnapshot:{taskRef,asOf:'2026-09-06T00:00:00Z',sourceRef,counterEpoch:'b'.repeat(64)+':v2',reviewRounds:3,fixRounds:null,handbacks:0,historyComplete:false,historyStart:null}}
 expect(privacySerialize(snapshot,destination,eventId,attributed)).toMatchObject({recordKind:'rework-snapshot'})
 expect(privacySerialize(snapshot,destination,eventId,nonAttributed)).toBeNull()
 expect(privacySerialize(localExecution,destination,eventId,{values:{'stats-export':'off'}})).toBeNull()
})

test('nested credential encodings, price evidence and malformed nullability cannot bypass the reader',()=>{
 const wire=privacySerialize(localExecution,destination,eventId,nonAttributed)!
 for(const model of ['ghp_12345678901234567890','%67%68%70%5f12345678901234567890',Buffer.from('ghp_12345678901234567890').toString('base64')])expect(()=>validateExport({...wire,model})).toThrow('privacy-invalid-identifier')
 expect(()=>privacySerialize({...localExecution,skills:null} as never,destination,eventId,nonAttributed)).toThrow('privacy-invalid-skills')
 expect(()=>privacySerialize({...localExecution,coverage:null} as never,destination,eventId,nonAttributed)).toThrow('privacy-invalid-object')
 expect(()=>privacyRead(JSON.stringify(wire).replace('"schemaVersion":2','"schemaVersion":2,"schemaVersion":2'))).toThrow('privacy-invalid-json')
 const attributed=privacySerialize({...localExecution,executionRef:crypto.randomUUID(),apiEquivalentUsd:0.01,estimateBasis:{sourceUrl:'https://example.com/pricing',checkedAt:'2026-09-06T00:00:00Z',priceDigest:'a'.repeat(64),currency:'USD',model:'fixture'}},destination,eventId,{values:{'stats-export':'attributed'}})!
 expect(attributed).toMatchObject({costUsd:null,apiEquivalentUsd:0.01})
 expect(()=>validateExport({...attributed,estimateBasis:{sourceUrl:'https://user:secret@example.com/pricing',checkedAt:'2026-09-06T00:00:00Z',priceDigest:'a'.repeat(64),currency:'USD',model:'fixture'}})).toThrow('privacy-invalid-price-source')
 expect(()=>validateExport({...wire,skills:Array.from({length:129},()=>({name:'skill',trigger:'typed',harness:'codex'}))})).toThrow('privacy-invalid-skills')
})

test('canonical private recovery authority is accepted only by its owner schema, never generic report copying',async()=>{
 const {parseRecoveryEnvelope}=await import('../src/shared-claims.ts')
 const source={kind:'github-comment',repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)}
 const recovery={schemaVersion:2,taskKey:'a'.repeat(64),runId:crypto.randomUUID(),generation:1,approvalBindings:[{approvalId:'approved',source}],recordBinding:null,scopeDigest:'b'.repeat(64),approvalDigest:'c'.repeat(64),execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'opaque-account',qualification:source},checkpoint:null,completed:[],children:[],joins:[],effects:[],remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'unverified'}}
 expect(parseRecoveryEnvelope(recovery)).toMatchObject({approvalBindings:recovery.approvalBindings,recordBinding:null})
 for(const canary of [{...recovery,argv:['CANARY']},{...recovery,execution:{...recovery.execution,memory:'NATIVE_MEMORY_CANARY'}},{...recovery,approvalBindings:[{approvalId:'approved',source:{...source,quote:'CANARY'}}]}])expect(()=>parseRecoveryEnvelope(canary)).toThrow()
 const wire=privacySerialize(localExecution,destination,eventId,nonAttributed)!
 expect(()=>validateExport({...wire,approvalBindings:recovery.approvalBindings})).toThrow('privacy-unknown-or-missing-field')
 expect(()=>validateExport({...wire,recordBinding:null})).toThrow('privacy-unknown-or-missing-field')
})

test('historical flat capture cannot be upgraded to attribution by a later policy',()=>{
 const historical={...localExecution,values:{human:'PRIVATE_CANARY',session_id:'PRIVATE_CANARY',worktree:'/Users/PRIVATE_CANARY',turns:2}}
 const wire=privacySerialize(historical,destination,eventId,{values:{'stats-export':'attributed'}})!
 expect(wire).not.toHaveProperty('executionRef');expect(wire).not.toHaveProperty('taskOwner')
 expect(canonicalJson(wire)).not.toContain('CANARY')
})

async function terminalPrivacyFixture(continuedFirst=false){
 const {enqueueEvent,spoolRoot,readSpoolJson,spoolEventFile}=await import('../src/stats/outbox.ts')
 const {terminalCaptureKey,hashBytes,destinationId}=await import('../src/stats/types.ts')
 const home=await mkdtemp(join(tmpdir(),'privacy-segments-149-')),root=spoolRoot(home),runId=crypto.randomUUID(),sequence=crypto.randomUUID()
 const input=(segment:string,target=destination):import('../src/stats/types.ts').SpoolEnvelope&{payload:typeof localExecution}=>({schemaVersion:2,eventId:crypto.randomUUID(),destination:target,captureKey:terminalCaptureKey(runId,segment),payload:{...localExecution,localRunId:runId,outcome:segment==='0'?'interrupted':'succeeded'}})
 const save=async(event:ReturnType<typeof input>)=>{await enqueueEvent(root,event);return (await readSpoolJson<ReturnType<typeof input>>(spoolEventFile(root,event)))!}
 const mapFile=(event:ReturnType<typeof input>)=>join(root,'captures',hashBytes(canonicalJson([destinationId(event.destination),event.captureKey]))+'.json')
 const first=await save(input(continuedFirst?sequence:'0')),firstMap=await readFile(mapFile(first),'utf8'),firstBytes=await readFile(spoolEventFile(root,first),'utf8')
 const second=await save(input(continuedFirst?'0':sequence)),initial=continuedFirst?second:first,continued=continuedFirst?first:second
 const logicalFile=join(root,'reporting-identities',hashBytes(canonicalJson([destinationId(destination),initial.captureKey]))+'.json')
 return{home,root,runId,sequence,initial,continued,first,firstMap,firstBytes,logicalFile,input,save,mapFile,spoolEventFile,dispose:()=>rm(home,{recursive:true,force:true})}
}
test.each([false,true])('terminal privacy exports both segments with one logical identity, continuation first=%s',async continuedFirst=>{
 const f=await terminalPrivacyFixture(continuedFirst),{currentPolicySerializer}=await import('../src/stats/privacy.ts')
 try{
  let mode='attributed';const destinations:string[]=[]
  const serialize=currentPolicySerializer(f.home,async d=>{destinations.push(d.repo);return{values:{'stats-export':mode},policyDigest:'a'.repeat(64)}})
  const original=await serialize(f.initial),continuation=await serialize(f.continued)
  expect(original).not.toBeNull();expect(continuation).not.toBeNull()
  const before=privacyRead(original!.bytes),after=privacyRead(continuation!.bytes)
  const {readExport:dashboardRead}=await import('../../dashboard/src/lib/stats/record.ts')
  expect(dashboardRead(original!.bytes)).toEqual(before);expect(dashboardRead(continuation!.bytes)).toEqual(after)
  if(before.payload.recordKind!=='execution'||after.payload.recordKind!=='execution')throw Error('execution expected')
  expect(before.payload).toMatchObject({executionRef:f.initial.payload.executionRef,outcome:'interrupted'})
  expect(after.payload).toMatchObject({executionRef:f.initial.payload.executionRef,outcome:'succeeded'})
  expect(before.eventId).not.toBe(after.eventId);expect(f.initial.payload.executionRef).not.toBe(f.runId)
  for(const bytes of [original!.bytes,continuation!.bytes]){expect(bytes).not.toContain(f.runId);expect(bytes).not.toContain(f.sequence);expect(bytes).not.toContain('captureKey')}
  expect(await readFile(f.mapFile(f.first),'utf8')).toBe(f.firstMap)
  expect(await readFile(f.spoolEventFile(f.root,f.first),'utf8')).toBe(f.firstBytes)
  const foreign=await f.save(f.input(f.sequence,{host:'github.com',org:'other',repo:'other/r',controlRoom:'other/room'}))
  const foreignRead=privacyRead((await serialize(foreign))!.bytes)
  if(foreignRead.payload.recordKind!=='execution')throw Error('execution expected')
  expect(foreignRead.destination.repo).toBe('other/r');expect(foreignRead.payload.executionRef).not.toBe(after.payload.executionRef)
  expect(destinations).toEqual(['o/r','o/r','other/r'])
  mode='non-attributed';expect(privacyRead((await serialize(f.continued))!.bytes).payload).not.toHaveProperty('executionRef')
  mode='off';expect(await serialize(f.continued)).toBeNull()
  expect((await serialize(f.initial))).toBeNull()
  mode='attributed';expect((await serialize(f.initial))!.bytes).toBe(original!.bytes)
 }finally{await f.dispose()}
})
test.each(['event','digest','destination','key','run','ordinal','forged-logical','missing-logical','conflicting-logical'] as const)('terminal privacy refuses %s continuation bindings without repairing history',async kind=>{
 const f=await terminalPrivacyFixture(),{currentPolicySerializer}=await import('../src/stats/privacy.ts'),{writeSpoolJson}=await import('../src/stats/outbox.ts'),{hashBytes}=await import('../src/stats/types.ts')
 const {unlink}=await import('node:fs/promises')
 try{
  const event=structuredClone(f.continued),mapping=JSON.parse(await readFile(f.mapFile(event),'utf8'))
  if(kind==='event')mapping.eventId=crypto.randomUUID()
  if(kind==='digest')mapping.payloadDigest='f'.repeat(64)
  if(kind==='destination')mapping.destination='f'.repeat(64)
  if(kind==='key')mapping.captureKey=f.initial.captureKey
  if(kind==='run')event.payload.localRunId=crypto.randomUUID()
  if(kind==='ordinal')event.captureKey=f.runId+':terminal:1'
  if(kind==='forged-logical'){event.payload.executionRef=crypto.randomUUID();mapping.executionRef=event.payload.executionRef;mapping.payloadDigest=hashBytes(canonicalJson(event.payload))}
  if(kind==='missing-logical')await unlink(f.mapFile(f.initial))
  if(kind==='conflicting-logical')await writeSpoolJson(f.logicalFile,{executionRef:crypto.randomUUID()})
  await writeSpoolJson(f.mapFile(f.continued),mapping)
  const snapshot=await readFile(f.mapFile(f.continued),'utf8')
  const serialize=currentPolicySerializer(f.home,async()=>({values:{'stats-export':'attributed'},policyDigest:'a'.repeat(64)}))
  await expect(serialize(event)).rejects.toThrow('privacy-reporting-identity-unavailable')
  expect(await readFile(f.mapFile(f.continued),'utf8')).toBe(snapshot)
  if(kind==='missing-logical'){await expect(readFile(f.mapFile(f.initial),'utf8')).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(f.logicalFile,'utf8')).rejects.toMatchObject({code:'ENOENT'})}
  else expect(await readFile(f.mapFile(f.initial),'utf8')).toBe(f.firstMap)
 }finally{await f.dispose()}
})

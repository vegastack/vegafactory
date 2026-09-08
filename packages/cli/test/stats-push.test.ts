import { expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { enqueueEvent, spoolRoot, inspectSpool } from '../src/stats/outbox.ts'
import { boundedTelemetryGit, matchesDestination, pushOutbox, readDeliveryReceipt, type GitRunner, type PushOptions } from '../src/stats/push.ts'
import { canonicalJson, eventPath, type SpoolEnvelope } from '../src/stats/types.ts'

let home:string,clone:string,remote:string
const url='https://github.com/a/room.git'
const env={...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}
const g=(cwd:string,args:string[]):string=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
let git:GitRunner
beforeEach(async()=>{
  home=await mkdtemp(join(tmpdir(),'telemetry-git-'));clone=join(home,'writer');remote=join(home,'remote.git')
  const seed=join(home,'seed');await mkdir(seed)
  g(home,['init','--bare','--initial-branch=main',remote]);g(seed,['init','--initial-branch=main']);await writeFile(join(seed,'README'),'fixture');g(seed,['add','.']);g(seed,['commit','-m','seed']);g(seed,['push',remote,'main']);g(home,['clone',remote,clone]);g(clone,['remote','set-url','origin',url])
  const actual=boundedTelemetryGit()
  // Controlled transport replaces only the already verified canonical URL with a real bare Git remote.
  git=(args,cwd,options)=>actual(args.map(arg=>arg===url?remote:arg),cwd,options)
})
afterEach(async()=>{await rm(home,{recursive:true,force:true})})
const event=(org='a'):SpoolEnvelope=>({schemaVersion:2,eventId:crypto.randomUUID(),captureKey:crypto.randomUUID()+':terminal:0',destination:{host:'github.com',org,repo:org+'/r',controlRoom:org+'/room'},payload:{schemaVersion:2,recordKind:'execution',utcDay:'2026-09-08',stage:'implement',outcome:'succeeded'}})
const options=():PushOptions=>({home,cloneRoot:clone,ghUser:'private-person',hostname:'private-host',commit:true,git,serialize:async e=>({bytes:canonicalJson({eventId:e.eventId,destination:e.destination,payload:e.payload})+'\n',policyDigest:'a'.repeat(64)}),effects:{beforeSend:async()=>{},afterReadback:async()=>{}},wait:async()=>{}})
const remoteHead=()=>g(home,['--git-dir='+remote,'rev-parse','main'])
const remoteFiles=()=>g(home,['--git-dir='+remote,'ls-tree','-r','--name-only','main'])

test('destinations accept canonical SSH/HTTPS only and isolate organizations',()=>{
  const d=event().destination
  expect(matchesDestination(d,url)).toBe(true);expect(matchesDestination(d,'git@github.com:a/room.git')).toBe(true)
  for(const remote of ['https://github.com/b/room.git','https://evil.test/a/room.git','https://github.com/a/room.git?x=1','https://person@github.com/a/room.git','https://github.com/a/../room.git'])expect(matchesDestination(d,remote)).toBe(false)
})

test('dry run performs no Git and missing production serializer refuses new export',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  let calls=0
  const dry=await pushOutbox({...options(),commit:false,git:async()=>{calls++;throw Error('unexpected')}})
  expect(calls).toBe(0);expect(dry.pushed).toBe(0)
  const before=remoteHead(),refused=await pushOutbox({...options(),serialize:undefined})
  expect(refused.refusals).toContain('privacy-current-policy-unavailable');expect(remoteHead()).toBe(before)
})

test('immutable delivery isolates organizations and preserves a concurrent producer',async()=>{
  const a=event(),b=event('b'),later=event();await enqueueEvent(spoolRoot(home),a);await enqueueEvent(spoolRoot(home),b)
  let produced=false
  const result=await pushOutbox({...options(),git:async(args,cwd,extra)=>{if(args.includes('push')&&!produced){produced=true;await enqueueEvent(spoolRoot(home),later)}return git(args,cwd,extra)}})
  expect(result.pushed).toBe(1);expect(remoteFiles()).toContain(eventPath(a));expect(remoteFiles()).not.toContain(b.eventId);expect(remoteFiles()).not.toContain(later.eventId)
  expect((await inspectSpool(spoolRoot(home))).events.map(e=>e.eventId)).toContain(later.eventId)
  expect(g(home,['--git-dir='+remote,'log','-1','--format=%an <%ae> %cn <%ce> %B'])).toMatch(/^VegaFactory telemetry <telemetry@example.invalid> VegaFactory telemetry/)
  expect(g(home,['--git-dir='+remote,'log','-1','--format=%B'])).not.toMatch(/private-person|private-host|terminal|implement/)
  expect((await pushOutbox(options())).pushed).toBe(1)
},10000) // Two real Git deliveries; this is a test-runner allowance, not a hook deadline.

test('lost local acknowledgment recognizes historical bytes after policy tightening',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  const first=await pushOutbox({...options(),effects:{beforeSend:async()=>{},afterReadback:async()=>{throw Error('crash-before-local-ack')}}})
  expect(first.ok).toBe(false);expect(await readDeliveryReceipt(spoolRoot(home),e)).toBeNull()
  const head=remoteHead();let serialized=0
  const second=await pushOutbox({...options(),serialize:async()=>{serialized++;throw Error('new-policy-disallows-previous-fields')}})
  expect(second.pushed).toBe(1);expect(serialized).toBe(0);expect(remoteHead()).toBe(head)
  expect((await readDeliveryReceipt(spoolRoot(home),e))?.policyDigest).toBe('a'.repeat(64))
})

test('real SIGKILL after remote push recovers one event without resending under tighter policy',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  const pushModule=join(process.cwd(),'packages/cli/src/stats/push.ts'),typesModule=join(process.cwd(),'packages/cli/src/stats/types.ts')
  const code=`import {pushOutbox,boundedTelemetryGit} from ${JSON.stringify(pushModule)};import {canonicalJson} from ${JSON.stringify(typesModule)};const actual=boundedTelemetryGit();await pushOutbox({home:${JSON.stringify(home)},cloneRoot:${JSON.stringify(clone)},ghUser:'fixture',hostname:'fixture',commit:true,git:(args,cwd,options)=>actual(args.map(a=>a===${JSON.stringify(url)}?${JSON.stringify(remote)}:a),cwd,options),serialize:async e=>({bytes:canonicalJson({eventId:e.eventId,destination:e.destination,payload:e.payload}),policyDigest:'a'.repeat(64)}),effects:{beforeSend:async()=>{},afterReadback:async()=>{process.kill(process.pid,'SIGKILL')}},wait:async()=>{}})`
  const child=Bun.spawn([process.execPath,'-e',code],{stdout:'pipe',stderr:'pipe'})
  await child.exited;expect(child.signalCode).toBe('SIGKILL');expect(remoteFiles()).toContain(e.eventId)
  const head=remoteHead(),again=await pushOutbox({...options(),serialize:async()=>{throw Error('must reconcile first')}})
  expect(again.pushed).toBe(1);expect(remoteHead()).toBe(head)
},10000)

test('remote denial buffers exact attempts with bounded retry and leaves clone untouched',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  const before=g(clone,['rev-parse','HEAD']),delays:number[]=[];let pushes=0
  const result=await pushOutbox({...options(),wait:async ms=>{delays.push(ms)},git:async(args,cwd,extra)=>{if(args.includes('reset'))throw Error('reset must never happen');if(args.includes('push')){pushes++;return{code:1,stdout:'',stderr:'denied'}}return git(args,cwd,extra)}})
  expect(result.ok).toBe(false);expect(pushes).toBe(3);expect(delays).toEqual([1000,2000,4000]);expect(result.deferred).toContain(e.eventId)
  expect(g(clone,['rev-parse','HEAD'])).toBe(before);expect(g(clone,['status','--porcelain'])).toBe('')
  expect((await inspectSpool(spoolRoot(home))).events).toHaveLength(1)
})

test('dirty and divergent writers remain intact and explain recovery',async()=>{
  await enqueueEvent(spoolRoot(home),event());await writeFile(join(clone,'unrelated'),'preserve')
  expect((await pushOutbox(options())).refusals.join()).toContain('writer-dirty-preserved')
  g(clone,['add','.']);g(clone,['commit','-m','unrelated local work']);const head=g(clone,['rev-parse','HEAD'])
  expect((await pushOutbox(options())).refusals.join()).toContain('writer-diverged-preserved')
  expect(g(clone,['rev-parse','HEAD'])).toBe(head);expect(await readFile(join(clone,'unrelated'),'utf8')).toBe('preserve')
})

test('unknown remote bytes quarantine instead of overwrite or acknowledge',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  const seed=join(home,'seed'),file=join(seed,eventPath(e));await mkdir(dirname(file),{recursive:true});await writeFile(file,'{"unknown":true}\n');g(seed,['add','.']);g(seed,['commit','-m','conflict']);g(seed,['push',remote,'main'])
  const before=remoteHead(),result=await pushOutbox(options())
  expect(result.refusals).toContain('remote-event-payload-conflict');expect(remoteHead()).toBe(before)
  expect((await inspectSpool(spoolRoot(home))).quarantine.some(q=>q.reason==='remote-event-payload-conflict')).toBe(true)
})

test('two pushers on one writer serialize and never duplicate the event',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  const results=await Promise.all([pushOutbox(options()),pushOutbox(options())])
  expect(results.reduce((n,r)=>n+r.pushed,0)).toBe(1)
  expect(remoteFiles().split('\n').filter(p=>p.includes(e.eventId))).toHaveLength(1)
  expect((await pushOutbox(options())).pushed).toBe(0)
})

test('suppressed activity and snapshot persist a local disposition without false acknowledgment',async()=>{
  const activity={...event(),payload:{schemaVersion:2 as const,recordKind:'activity' as const,utcDay:'2026-09-08',taskRef:'opaque-task',activityId:'opaque-activity'}}
  const snapshot={...event(),payload:{schemaVersion:2 as const,recordKind:'rework-snapshot' as const,utcDay:'2026-09-08',taskRef:'opaque-task',counterEpoch:'e1',asOf:'2026-09-08',sourceRef:'source1'}}
  for(const e of [activity,snapshot])await enqueueEvent(spoolRoot(home),e)
  let serialized=0;const suppressed={...options(),serialize:async()=>{serialized++;return null}}
  expect((await pushOutbox(suppressed)).pushed).toBe(0);expect((await pushOutbox(suppressed)).pushed).toBe(0);expect(serialized).toBe(2)
  expect(await readDeliveryReceipt(spoolRoot(home),activity)).toBeNull();expect(remoteFiles()).toBe('README')
  expect((await readdir(join(spoolRoot(home),'suppressed')))).toHaveLength(1)
})

test('retention removes only acknowledged old events and capture tombstones prevent replay',async()=>{
  const {cleanupDelivered}=await import('../src/stats/push.ts')
  const delivered=event(),pending=event();delivered.payload.utcDay='2025-01-01'
  await enqueueEvent(spoolRoot(home),delivered)
  expect((await pushOutbox({...options(),now:()=>new Date('2025-01-01T00:00:00Z')})).pushed).toBe(1)
  await enqueueEvent(spoolRoot(home),pending)
  const protectedResult=await cleanupDelivered(spoolRoot(home),{now:new Date('2026-09-08T00:00:00Z'),controller:{active:async()=>true,removeActiveReport:async()=>{throw Error('active report must stay')}}})
  expect(protectedResult.removed).toBe(0)
  const held=await cleanupDelivered(spoolRoot(home),{now:new Date('2026-09-08T00:00:00Z')})
  expect(held.removed).toBe(0);expect(held.held[0]?.reason).toBe('retention-shared-removal-unavailable')
  // Controlled owner seam tests local payload retirement; it is not provider qualification.
  const removed=await cleanupDelivered(spoolRoot(home),{now:new Date('2026-09-08T00:00:00Z'),controller:{active:async()=>false,removeActiveReport:async()=>{}}})
  expect(removed.removed).toBe(1);expect(removed.protected).toBe(1)
  await enqueueEvent(spoolRoot(home),{...delivered,eventId:crypto.randomUUID()})
  expect((await inspectSpool(spoolRoot(home))).events.map(e=>e.eventId)).toEqual([pending.eventId])
  expect(await readDeliveryReceipt(spoolRoot(home),delivered)).not.toBeNull()
})

test('Git URL rewriting cannot redirect a canonical destination',async()=>{
  const e=event();await enqueueEvent(spoolRoot(home),e)
  g(clone,['config','url.https://evil.invalid/.insteadOf','https://github.com/'])
  const result=await pushOutbox(options())
  expect(result.refusals).toContain('writer-url-rewrite-refused')
  expect(remoteFiles()).toBe('README')
})

test('fourteen-day basic log retention preserves active and pending-delivery runs',async()=>{
  const runtime=await import('../src/runs.ts'),{cleanupBasicLogs}=await import('../src/stats/push.ts')
  const make=async(pending:boolean)=>{
    let run=await runtime.createRun({root:runtime.runsRoot(home),repo:'a/r',issue:1,parent:null,checkout:clone,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:'2025-01-01T00:00:00Z',taskKey:{repo:'a/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'local-diagnostic'}})
    run=await runtime.transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'succeeded',finishedAt:'2025-01-01T00:00:00Z',pendingDelivery:pending?[{id:crypto.randomUUID(),kind:'telemetry-capture',target:{captureKey:run.runId+':terminal:0'},intentRef:null,status:'pending',attempts:0,lastError:null}]:[]},runtime.runsRoot(home))
    const file=join(runtime.runsRoot(home),run.runId,'events.jsonl');await writeFile(file,'{"at":"2025-01-01T00:00:00Z","event":"exit"}\n',{mode:0o600});return file
  }
  const done=await make(false),pending=await make(true)
  const result=await cleanupBasicLogs(home,new Date('2026-09-08'))
  expect(result).toMatchObject({removed:1,protected:1})
  await expect(readFile(done,'utf8')).rejects.toMatchObject({code:'ENOENT'})
  expect(await readFile(pending,'utf8')).toContain('exit')
})

test('production current policy serializes all three variants through real Git and both readers, then reconciles before off suppression',async()=>{
 const {loadSnapshotPolicy}=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
 const {reportingExecutionRef}=await import('../src/stats/privacy.ts')
 const {readControlRoomEvents}=await import('../src/stats/rollup.ts')
 // The dashboard uses Bundler module resolution; exercise its actual runtime entry
 // dynamically while each package's own source is strictly typechecked separately.
 const dashboardModule=join(process.cwd(),'packages/dashboard/src/lib/cache/build.ts')
 const {openCache,refreshCache}=await import(dashboardModule)
 const code=join(home,'code'),room=join(home,'seed'),devFile=join(code,'.vegastack','dev.md')
 await mkdir(join(code,'.vegastack'),{recursive:true});await mkdir(join(room,'groups','dev'),{recursive:true});await mkdir(join(home,'.vegastack'),{recursive:true,mode:0o700})
 const devMd='repo: a/r\ncontrol-room: a/room#dev\nsync-max-age: 2h\n'
 await writeFile(devFile,devMd);await writeFile(join(room,'org.md'),'stats: on\nstats-people: on\nstats-export: attributed\nsync-max-age: 2h\n')
 await writeFile(join(room,'groups/dev/group.md'),'review: subagent\n')
 await writeFile(join(room,'people.csv'),'login,name,role,slack,timezone,groups\nalice,Alice,engineer,,UTC,dev\n')
 await writeFile(join(room,'repos.md'),'| repo | group | board | owner | repository-id |\n|---|---|---|---|---|\n| a/r | dev | | alice | R_r |\n')
 g(room,['remote','add','origin',url]);g(room,['add','.']);g(room,['commit','-m','confirmed reporting policy']);g(room,['push',remote,'main'])
 const snapshot={schemaVersion:2,org:'a',group:'dev',repository:'a/room',origin:url,sourceCommit:g(room,['rev-parse','HEAD']),policyDigest:'0'.repeat(64),validatedAt:new Date().toISOString(),contentPath:room}
 const save=async(text:string)=>{
  await writeFile(devFile,text)
  snapshot.policyDigest=loadSnapshotPolicy({snapshot,repo:'a/r',devMd:text,expectedOrigin:url,now:Date.now()}).policy.policyDigest
  expect(loadSnapshotPolicy({snapshot,repo:'a/r',devMd:text,expectedOrigin:url,now:Date.now()}).ok).toBe(true)
  await writeFile(join(home,'.vegastack','factory.json'),JSON.stringify({schemaVersion:2,revision:0,repos:[{repo:'a/r',org:'a',path:code}],controlRooms:{a:{repo:'a/room',remote:url,snapshots:{'a/r':snapshot}}}}),{mode:0o600})
 }
 await save(devMd)
 const execution=event(),runId=execution.captureKey.slice(0,36)
 execution.payload={...execution.payload,recordKind:'execution',stage:'implement',outcome:'succeeded',localRunId:runId,executionRef:await reportingExecutionRef(spoolRoot(home),runId,execution.destination),taskRef:null,taskOwner:null,agentAccountOwner:null,values:{hostname:'PRIVATE_CANARY',stdout:'ghp_PRIVATE_CANARY',worktree:'/Users/PRIVATE_CANARY',cost_usd:0}}
 const taskRef={repo:'a/r',issue:1,taskId:'1-T1'},sourceRef={repo:'a/r',issue:1,commentId:1,nodeId:'IC_1',bodySha256:'d'.repeat(64)}
 const activity:SpoolEnvelope={...event(),payload:{schemaVersion:2,recordKind:'activity',utcDay:'2026-09-08',taskRef,taskOwner:'alice',agentAccountOwner:null,activity:{taskRef,activityId:'review-1',kind:'review',occurredAt:'2026-09-08T00:00:00Z',deliveryRef:null,sourceRef}}}
 const snapshotEvent:SpoolEnvelope={...event(),payload:{schemaVersion:2,recordKind:'rework-snapshot',utcDay:'2026-09-08',taskRef,taskOwner:'alice',reworkSnapshot:{taskRef,asOf:'2026-09-08T00:00:00Z',sourceRef,counterEpoch:'e'.repeat(64)+':v2',reviewRounds:1,fixRounds:0,handbacks:0,historyComplete:true,historyStart:'2026-09-01T00:00:00Z'}}}
 for(const e of [execution,activity,snapshotEvent])await enqueueEvent(spoolRoot(home),e)
 const first=await pushOutbox({...options(),serialize:undefined,effects:{beforeSend:async()=>{},afterReadback:async()=>{throw Error('lost-local-ack')}}})
 expect(first.ok).toBe(false);expect(await readDeliveryReceipt(spoolRoot(home),execution)).toBeNull()
 for(const e of [execution,activity,snapshotEvent])expect(g(home,['--git-dir='+remote,'show','main:'+eventPath(e)])).not.toContain('CANARY')
 await save(devMd+'stats-export: off\n')
 const queued=event();await enqueueEvent(spoolRoot(home),queued)
 const second=await pushOutbox({...options(),serialize:undefined})
 expect(second.ok).toBe(true);expect(second.pushed).toBe(3)
 expect(await readDeliveryReceipt(spoolRoot(home),queued)).toBeNull()
 expect((await inspectSpool(spoolRoot(home))).suppressed).toBe(1)
 expect(remoteFiles()).not.toContain(queued.eventId)
 const reader=join(home,'reader');g(home,['clone',remote,reader])
 const cli=await readControlRoomEvents(reader)
 expect(cli.invalid).toHaveLength(0);expect(cli.events).toHaveLength(3)
 expect(cli.events.filter(e=>e.event.payload.recordKind==='execution')).toHaveLength(1)
 const {buildStatsDeps,parseStatsArgs,runStats}=await import('../src/stats/cli.ts')
 const outputs:string[]=[],deps=await buildStatsDeps(home,code,line=>outputs.push(line),async()=>({login:'alice',id:1}))
 deps.cloneRoot=reader
 const disabled=join(home,'off-export.jsonl')
 expect(await runStats(parseStatsArgs(['export','--me','--output',disabled]),deps)).toBe(0)
 expect(await readFile(disabled,'utf8')).toBe('')
 await save(devMd)
 const exported=join(home,'own-export.jsonl')
 expect(await runStats(parseStatsArgs(['export','--me','--output',exported]),deps)).toBe(0)
 const ownBytes=await readFile(exported,'utf8')
 expect(ownBytes.trim().split('\n')).toHaveLength(2);expect(ownBytes).not.toContain('CANARY')
 const {stat}=await import('node:fs/promises');expect((await stat(exported)).mode&0o777).toBe(0o600)
 expect(await runStats(parseStatsArgs(['export','--org','--output',join(home,'refused.jsonl')]),deps)).toBe(2)
 expect(outputs.at(-1)).toBe('privacy-read-scope-refused')
 await save(devMd+'stats-export: off\n')
 const db=await openCache(join(home,'reader.db'))
 try{expect(await refreshCache(db,reader)).toMatchObject({eventTotal:3,invalidEvents:0})}finally{db.close()}
 const originalReceipt=await readDeliveryReceipt(spoolRoot(home),activity)
 const historical=remoteHead()
 const cleaned=await pushOutbox({...options(),serialize:undefined,cleanupOnly:true,now:()=>new Date('2028-09-08T00:00:00Z'),git:async(args,cwd,extra)=>{const result=await git(args,cwd,extra);return args.includes('push')?{code:1,stdout:'',stderr:'response lost'}:result}})
 expect(cleaned.ok).toBe(true);expect(cleaned.retention?.removed).toBe(2)
 expect(cleaned.retention?.protected).toBe(2) // unknown execution recovery + undelivered suppressed event
 expect(remoteFiles()).not.toContain(activity.eventId);expect(remoteFiles()).not.toContain(snapshotEvent.eventId)
 expect(remoteFiles()).toContain(execution.eventId)
 expect(await readDeliveryReceipt(spoolRoot(home),activity)).toEqual(originalReceipt)
 expect(g(home,['--git-dir='+remote,'ls-tree','-r','--name-only',historical])).toContain(activity.eventId)
 const {destinationId}=await import('../src/stats/types.ts')
 const removal=JSON.parse(await readFile(join(spoolRoot(home),'retention',destinationId(activity.destination),activity.eventId+'.json'),'utf8'))
 expect(removal).toMatchObject({state:'absent',eventId:activity.eventId,originalPayloadSha256:originalReceipt!.payloadSha256})
 expect(removal.attemptedCommits).toHaveLength(1)
 // A current remote divergence is held, even with an old valid delivery receipt.
 await save(devMd)
 const divergent=event();divergent.captureKey='legacy:'+crypto.randomUUID();divergent.payload={schemaVersion:2,recordKind:'execution',utcDay:'2020-01-01',stage:'implement',outcome:'succeeded',historicalNonAttributed:true}
 await enqueueEvent(spoolRoot(home),divergent)
 expect((await pushOutbox({...options(),serialize:undefined,retention:{active:async()=>true,removeActiveReport:async()=>{throw Error('hold')}}})).ok).toBe(true)
 g(reader,['pull','--ff-only']);await writeFile(join(reader,eventPath(divergent)),'{"changed":true}\n');g(reader,['add','.']);g(reader,['commit','-m','divergent report']);g(reader,['push','origin','main'])
 const refused=await pushOutbox({...options(),serialize:undefined,cleanupOnly:true})
 expect(refused.refusals).toContain('retention-remote-payload-diverged')
 expect((await inspectSpool(spoolRoot(home))).events.some(e=>e.eventId===divergent.eventId)).toBe(true)
 expect(await readDeliveryReceipt(spoolRoot(home),divergent)).not.toBeNull()
 // Restore the fixture's original bytes, then prove an unconfirmed cleanup stays pending.
 const originalAttempts=JSON.parse(await readFile(join(spoolRoot(home),'attempts',destinationId(divergent.destination),divergent.eventId+'.json'),'utf8'))
 await writeFile(join(reader,eventPath(divergent)),originalAttempts[0].bytes);g(reader,['add','.']);g(reader,['commit','-m','restore original fixture bytes']);g(reader,['push','origin','main'])
 const denied=await pushOutbox({...options(),serialize:undefined,cleanupOnly:true,git:async(args,cwd,extra)=>args.includes('push')?{code:1,stdout:'',stderr:'denied'}:git(args,cwd,extra)})
 expect(denied.refusals).toContain('retention-removal-unconfirmed');expect(remoteFiles()).toContain(divergent.eventId)
 const pendingRemoval=JSON.parse(await readFile(join(spoolRoot(home),'retention',destinationId(divergent.destination),divergent.eventId+'.json'),'utf8'))
 expect(pendingRemoval.state).toBe('prepared');expect(pendingRemoval.observedCommit).toBeNull();expect(pendingRemoval.attemptedCommits).toHaveLength(3)
 const retried=await pushOutbox({...options(),serialize:undefined,cleanupOnly:true})
 expect(retried.ok).toBe(true);expect(retried.retention?.removed).toBe(1);expect(remoteFiles()).not.toContain(divergent.eventId)
 expect(await readDeliveryReceipt(spoolRoot(home),divergent)).not.toBeNull()
},45000)

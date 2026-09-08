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
  expect(refused.refusals).toContain('privacy-serializer-unavailable-149');expect(remoteHead()).toBe(before)
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
})

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
  const removed=await cleanupDelivered(spoolRoot(home),{now:new Date('2026-09-08T00:00:00Z')})
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
    const file=join(runtime.runsRoot(home),run.runId,'events.jsonl');await writeFile(file,'{"kind":"exit"}\n',{mode:0o600});return file
  }
  const done=await make(false),pending=await make(true)
  const result=await cleanupBasicLogs(home,new Date('2026-09-08'))
  expect(result).toEqual({removed:1,protected:1})
  await expect(readFile(done,'utf8')).rejects.toMatchObject({code:'ENOENT'})
  expect(await readFile(pending,'utf8')).toContain('exit')
})

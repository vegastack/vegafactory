import { expect,test } from 'bun:test'
import { planRetention, diskPressure, exportMode } from '../src/stats/privacy.ts'
test('retention clamps calendar month ends and holds unsent and recovery identity',()=>{
 const files=[
 {path:'old-log',kind:'basic-diagnostic',createdAt:'2026-08-23T00:00:00Z',bytes:10,active:false,delivered:true},
 {path:'boundary-log',kind:'basic-diagnostic',createdAt:'2026-08-24T00:00:00Z',bytes:11,active:false,delivered:true},
 {path:'old-event',kind:'delivered-report',createdAt:'2025-09-06T00:00:00Z',bytes:12,active:false,delivered:true},
 {path:'unsent',kind:'spool',createdAt:'2020-01-01T00:00:00Z',bytes:13,active:false,delivered:false},
 {path:'recovery',kind:'delivered-report',createdAt:'2020-01-01T00:00:00Z',bytes:14,active:false,delivered:true,recovery:true},
 {path:'checkpoint',kind:'source-checkpoint',createdAt:'2020-01-01T00:00:00Z',bytes:15,active:false,delivered:true},
 ]
 const r=planRetention({now:'2026-09-06T00:00:00Z',files,policy:{diagnosticDays:14,sharedMonths:12}})
 expect(r.deleteCandidates.map(r=>r.path)).toEqual(['old-log','old-event'])
 expect(r.held).toHaveLength(4);expect(r.bytes).toBe(22)
 const leap=planRetention({now:'2025-02-28T00:00:00Z',files:[{path:'leap',kind:'delivered-report',createdAt:'2024-02-29T00:00:00Z',bytes:1,active:false,delivered:true}],policy:{diagnosticDays:14,sharedMonths:12}})
 expect(leap.deleteCandidates).toHaveLength(1)
})
test('pressure pauses below 1GiB, resumes at 2GiB and queue alone only warns',()=>{
 const GiB=1024**3
 expect(diskPressure(GiB-1,false,0)).toMatchObject({paused:true,reason:'disk-low'})
 expect(diskPressure(GiB,true,0)).toMatchObject({paused:true})
 expect(diskPressure(2*GiB,true,0)).toMatchObject({paused:false})
 expect(diskPressure(10*GiB,false,GiB)).toMatchObject({paused:false,queueWarning:true})
 expect(diskPressure(null,false,0)).toMatchObject({paused:true,reason:'disk-probe-unavailable'})
})
test('repository cannot self-authorize attributed reporting',()=>{
 expect(()=>exportMode({org:{'stats-export':'non-attributed'},repo:{'stats-export':'attributed'},delegations:[]})).toThrow()
})

import { mkdtemp,rm,readFile,stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probePressure,basicDiagnostic,privacyReason } from '../src/stats/privacy.ts'
test('real statfs and persisted pressure hysteresis fail closed across restarts',async()=>{
 const home=await mkdtemp(join(tmpdir(),'pressure-149-'))
 try{
  expect((await probePressure(home,0)).freeBytes).toBeGreaterThan(0)
  expect((await probePressure(home,0,async()=>100)).paused).toBe(true)
  expect((await probePressure(home,0,async()=>1024**3)).paused).toBe(true)
  expect((await probePressure(home,0,async()=>2*1024**3)).paused).toBe(false)
  expect((await probePressure(home,0,async()=>{throw Object.assign(Error('PRIVATE_CANARY'),{code:'EACCES'})})).reason).toBe('disk-probe-unavailable')
  const file=join(home,'.vegastack','stats','events-v2','disk-pressure.json')
  expect((await stat(file)).mode&0o777).toBe(0o600)
  expect(await readFile(file,'utf8')).not.toContain('CANARY')
 }finally{await rm(home,{recursive:true,force:true})}
})
test('basic diagnostics discard arbitrary fields and outward errors never quote filesystem text',()=>{
 expect(basicDiagnostic('2026-09-06T00:00:00Z','exit',{exitCode:1,stdout:'CANARY',args:['CANARY'],path:'/Users/CANARY'})).toEqual({at:'2026-09-06T00:00:00Z',event:'exit',exitCode:1})
 expect(privacyReason(Object.assign(Error('/Users/CANARY'),{code:'ENOSPC'}))).toBe('storage-full')
 expect(privacyReason(Object.assign(Error('/Users/CANARY'),{code:'EACCES'}))).toBe('storage-permission-denied')
 expect(privacyReason(Error('/Users/CANARY'))).toBe('operation-unavailable')
 expect(privacyReason(Error('privacy-arbitrary-sensitive-content'))).toBe('operation-unavailable')
})

test('real permission failure preserves terminal basic logs and dry-run never removes them',async()=>{
 const fs=await import('node:fs/promises'),runtime=await import('../src/runs.ts'),{cleanupBasicLogs}=await import('../src/stats/push.ts')
 const home=await mkdtemp(join(tmpdir(),'retention-permission-')),root=runtime.runsRoot(home)
 let directory=''
 try{
  let run=await runtime.createRun({root,repo:'o/r',issue:1,parent:null,checkout:home,branch:'feat/1-fixture',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:'2020-01-01T00:00:00Z',taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
  run=await runtime.transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'failed',finishedAt:'2020-01-01T00:00:00Z'},root)
  directory=join(root,run.runId);const file=join(directory,'events.jsonl'),bytes=JSON.stringify(basicDiagnostic('2020-01-01T00:00:00Z','exit',{exitCode:1}))+'\n'
  await fs.writeFile(file,bytes,{mode:0o600})
  const preview=await cleanupBasicLogs(home,new Date('2026-09-06'),{dryRun:true})
  expect(preview.removed).toBe(0);expect(preview.deleteCandidates).toEqual([file]);expect(await readFile(file,'utf8')).toBe(bytes)
  await fs.chmod(directory,0o500)
  try{const result=await cleanupBasicLogs(home,new Date('2026-09-06'));expect(result.removed).toBe(0)}catch(error){expect((error as NodeJS.ErrnoException).code).toBe('EACCES')}
  expect(await readFile(file,'utf8')).toBe(bytes)
  await fs.chmod(directory,0o700)
  expect((await cleanupBasicLogs(home,new Date('2026-09-06'))).removed).toBe(1)
 }finally{if(directory)await fs.chmod(directory,0o700).catch(()=>{});await rm(home,{recursive:true,force:true})}
})

test.each(['linear','merged-parent'])('checkpoint privacy rejects removed secret history through the actual owner: %s',async(kind)=>{
 const fs=await import('node:fs/promises'),{execFileSync}=await import('node:child_process')
 const {createRun}=await import('../src/runs.ts'),{prepareCheckpoint}=await import('../src/checkpoints.ts')
 const home=await mkdtemp(join(tmpdir(),'privacy-history-')),cwd=join(home,'source'),remote=join(home,'remote.git'),root=join(home,'runs')
 try{
  await fs.mkdir(cwd)
  const git=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim()
  git('init','-b','main');await fs.writeFile(join(cwd,'allowed.txt'),'base');git('add','.');git('commit','-m','base')
  const base=git('rev-parse','HEAD');git('init','--bare',remote);git('remote','add','origin',remote);git('push','origin','HEAD:main');git('checkout','-b','feat/1-work')
  if(kind==='merged-parent')git('checkout','-b','secret-side')
  await fs.writeFile(join(cwd,'allowed.txt'),'credential-canary-DO-NOT-EXPORT');git('add','.');git('commit','-m','intermediate fixture')
  const forbiddenCommit=git('rev-parse','HEAD'),forbiddenBlob=git('rev-parse','HEAD:allowed.txt')
  await fs.writeFile(join(cwd,'allowed.txt'),'base');git('add','.');git('commit','-m','clean final tree')
  if(kind==='merged-parent'){git('checkout','feat/1-work');git('commit','--allow-empty','-m','parent progress');git('merge','--no-ff','secret-side','-m','merge cleaned side')}
  const head=git('rev-parse','HEAD')
  expect(await fs.readFile(join(cwd,'allowed.txt'),'utf8')).toBe('base');expect(git('status','--porcelain')).toBe('')
  const approvalBindings=[{approvalId:'fixture',source:{kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)}}]
  const run=await createRun({root,repo:'o/r',issue:1,parent:null,checkout:cwd,branch:'feat/1-work',baseSha:base,headSha:head,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings,recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
  const approvedIntent={id:'fixture-backup',repo:'o/r',repositoryId:'R_repo',remote:'origin',remoteUrl:remote,branch:run.branch,baseRef:'refs/heads/main',baseSha:base,scopeDigest:run.taskKey.scopeDigest,paths:['allowed.txt'],approvalBindings}
  await expect(prepareCheckpoint({run,approvedIntent,headSha:head},{root,verifyAuthority:async()=>{}})).rejects.toThrow()
  expect(git('ls-remote','origin','refs/heads/feat/1-work')).toBe('')
  for(const object of [forbiddenCommit,forbiddenBlob])expect(()=>git('--git-dir',remote,'cat-file','-e',object)).toThrow()
 }finally{await rm(home,{recursive:true,force:true})}
},15000)

async function archiveRetentionFixture(){
 const fs=await import('node:fs/promises'),runtime=await import('../src/runs.ts'),owner=await import('../src/shared-claims.ts')
 const home=await mkdtemp(join(tmpdir(),'retention-archive-')),head='1'.repeat(40),digest='a'.repeat(64),installation=crypto.randomUUID()
 const machine={id:'fixture-machine',installationId:crypto.randomUUID(),sessionId:crypto.randomUUID(),hostBindingDigest:digest}
 const source={kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_parent',commentId:'12',bodySha256:digest}
 const approvalBindings=[{approvalId:'approved',source}],qualification={kind:'state-receipt' as const,operationId:crypto.randomUUID(),commitSha:head,blobSha256:digest}
 const execution={providerMode:'subscription' as const,harness:'codex' as const,harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'opaque-account',qualification}
 const acceptance={...qualification,operationId:crypto.randomUUID()}
 const coverage={kind:'qualified-managed-only' as const,qualification},key=owner.taskKey('github.com','R_app','I_1'),token=crypto.randomUUID()
 let run=await runtime.createRun({root:runtime.runsRoot(home),repo:'acme/app',issue:1,parent:null,checkout:home,branch:'task/1',baseSha:head,headSha:head,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution,approvalBindings,recordBinding:null,approvalRefs:[],policyDigest:digest,claimToken:crypto.randomUUID(),approvedTaskIds:['1-T1'],startedAt:'2020-01-01T00:00:00Z',taskKey:{repo:'acme/app',issue:1,taskId:'1-T1',scopeDigest:digest},activeElapsedMs:100,taskOwner:null,agentAccountOwner:null,accountRef:'opaque-account',waitReason:null,machine,sharedClaim:{taskKey:key,generation:1,ownerToken:token,stateCommit:head},checkpoint:null,remoteEffectCoverage:coverage})
 run=await runtime.transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'succeeded',finishedAt:'2020-01-01T00:00:01Z'},runtime.runsRoot(home))
 const stopProof={kind:'operator-confirmed' as const,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,hostBindingDigest:digest,bootIdDigest:digest,runIds:[run.runId],generation:1,observedAt:'2020-01-01T00:00:01Z',evidenceRef:source}
 const task:import('../src/shared-claims.ts').TaskRecord={schemaVersion:1,taskKey:key,host:'github.com',repo:run.repo,issue:1,repositoryNodeId:'R_app',issueNodeId:'I_1',scopeDigest:digest,approvalDigest:digest,approvalBindings,generation:1,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,ownerToken:token,runId:run.runId,stage:'implement',state:'completed',paths:['allowed.txt'],resources:[],independent:false,parentTaskKey:null,approvedTaskIds:['1-T1'],checkpoint:null,stopProof,unresolvedEffects:[],acceptedScopes:[{scopeDigest:digest,receipt:acceptance}],recovery:{schemaVersion:2,taskKey:key,runId:run.runId,generation:1,approvalBindings,recordBinding:null,scopeDigest:digest,approvalDigest:digest,execution,checkpoint:null,completed:[],children:[],joins:[],effects:[],remoteEffectCoverage:coverage}}
 const evidence=new Map<string,string>()
 const receipt=(ref:typeof qualification,payload:unknown)=>{const bytes=owner.canonical({schemaVersion:1,operationId:ref.operationId,type:'receipt',taskKey:key,generation:1,previousHead:head,requestDigest:digest,resultOwner:{ownerToken:token,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,runId:run.runId},recoveryPayload:payload});ref.blobSha256=owner.sha256(bytes);evidence.set('coordination/operations/'+ref.operationId+'.json',bytes)}
 receipt(qualification,{schemaVersion:2,kind:'execution-qualification',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'opaque-account',configurationDigest:digest,candidateSha:head,validationIds:['149-T3/check/'+digest],managedKinds:['checkpoint-push','handback','evidence','telemetry-push'],unmanagedDenied:true,result:'qualified'})
 receipt(acceptance,{schemaVersion:2,kind:'acceptance',taskId:'1-T1',runId:run.runId,sourceSha:head,scopeDigest:digest,validationId:'149-T3/check/'+digest,commandDigest:digest,result:'passed',acceptedScope:{schemaVersion:2,repo:run.repo,issue:run.issue,artifacts:[{repo:run.repo,issue:1,kind:'brief',artifactId:'I_1',rev:1,digest}],approvalBindings,approvedTaskIds:['1-T1'],completedTaskIds:['1-T1'],parentRepo:run.repo,parentIssue:133,parentBefore:head,parentAfter:head,acceptedAt:'2020-01-01T00:00:01Z'}})
 // Persist the same original reference identities in local truth, as the producer does.
 const runFile=join(runtime.runsRoot(home),run.runId,'run.json');run=runtime.parseRun({...run,execution,remoteEffectCoverage:coverage,approvedTaskIds:['1-T1']});await fs.writeFile(runFile,JSON.stringify(run),{mode:0o600})
 let active=false,missing=false,reads=0,advance=false,currentHead=head
 const target:import('../src/shared-claims.ts').CoordinationTarget={host:'github.com',repository:'acme/control',repositoryId:'R_control',branch:'factory-state',rootCommit:head,installationId:installation,localRoot:join(home,'coordination'),verifyCandidate:async()=>{},verifyTransition:async()=>{},verifyEvidence:async()=>{},provider:{branch:async()=>({id:'REF_state',head:currentHead,repositoryId:'R_control',private:true,defaultBranch:'main'}),compare:async(_target,base,next)=>base===next?'identical':base===head&&next==='2'.repeat(40)?'ahead':'diverged',commit:async()=>{throw Error('inspection must be read-only')},read:async(_target,at,path)=>{
  expect([head,'2'.repeat(40)]).toContain(at);reads++
  if(path==='coordination/index.json'){if(advance){currentHead='2'.repeat(40);advance=false}return owner.canonical({schemaVersion:1,installationId:installation,revision:0,active:active?[{taskKey:key,repo:task.repo,issueNodeId:task.issueNodeId,machineId:machine.id,parentTaskKey:null,paths:task.paths,resources:[],independent:false}]:[],machines:active?[machine.id]:[]})}
  if(path==='coordination/machines/'+machine.id+'.json')return owner.canonical({schemaVersion:1,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,hostBindingDigest:digest,bootIdDigest:digest,observedAt:'2020-01-01T00:00:01Z',activeTaskKeys:[key]})
  if(path==='coordination/tasks/'+key+'.json')return missing?null:owner.canonical(task)
  return evidence.get(path)??null
 }}}
 const log=join(runtime.runsRoot(home),run.runId,'events.jsonl');await fs.writeFile(log,JSON.stringify(basicDiagnostic('2020-01-01T00:00:01Z','exit',{exitCode:0}))+'\n',{mode:0o600})
 const acknowledgeTelemetry=()=>{
  const operationId=crypto.randomUUID(),target={kind:'telemetry' as const,destinationRepositoryId:'R_control',destinationPath:'stats/event.json',eventId:crypto.randomUUID(),batchId:crypto.randomUUID()},intent={...qualification,operationId:crypto.randomUUID()},outcome={...qualification,operationId:crypto.randomUUID()}
  const payload={schemaVersion:2,effectId:operationId,runId:run.runId,generation:1,approvalBindings,effectKind:'telemetry-push',target,payloadDigest:digest,reasonCode:null}
  receipt(intent,{...payload,kind:'effect-intent',result:'prepared',observedRemoteId:null,observedDigest:null})
  receipt(outcome,{...payload,kind:'effect-outcome',result:'acknowledged',observedRemoteId:head,observedDigest:digest})
  task.recovery!.effects=[{operationId,runId:run.runId,generation:1,kind:'telemetry-push',target,payloadDigest:digest,state:'acknowledged',intent,outcome}]
 }
 return{home,run,task,target,head,log,source,qualification,acknowledgeTelemetry,get reads(){return reads},setActive:()=>{active=true;task.state='running'},setMissing:()=>{missing=true},loseEvidence:()=>evidence.clear(),advanceDuringRead:()=>{advance=true},dispose:()=>rm(home,{recursive:true,force:true})}
}

test('managed retention uses the real137 archival reader and removes only the expired basic payload',async()=>{
 const f=await archiveRetentionFixture(),{assessManagedRetention,cleanupBasicLogs}=await import('../src/stats/push.ts')
 try{
  expect(await assessManagedRetention(f.home,f.run,async()=>f.target)).toEqual({held:false,reason:null,head:f.head});expect(f.reads).toBeGreaterThan(0)
  const runtime=await import('../src/runs.ts'),before=await readFile(join(runtime.runsRoot(f.home),f.run.runId,'run.json'),'utf8')
  const result=await cleanupBasicLogs(f.home,new Date('2026-09-08'),{targetForRun:async()=>f.target})
  expect(result.removed).toBe(1);await expect(readFile(f.log,'utf8')).rejects.toMatchObject({code:'ENOENT'})
  expect(await readFile(join(runtime.runsRoot(f.home),f.run.runId,'run.json'),'utf8')).toBe(before)
 }finally{await f.dispose()}
})
test.each(['active','absent','binding','machine','authority','recovery-missing','coverage','stop','acceptance','unresolved','telemetry-prepared','telemetry-ambiguous','local-pending','evidence-missing','malformed'] as const)('archival retention keeps %s state despite a completed label',async kind=>{
 const f=await archiveRetentionFixture(),{assessManagedRetention,cleanupBasicLogs}=await import('../src/stats/push.ts')
 try{
  if(kind==='active')f.setActive()
  if(kind==='evidence-missing')f.loseEvidence()
  if(kind==='malformed')(f.task as unknown as Record<string,unknown>).raw='CANARY'
  if(kind==='absent')f.setMissing()
  if(kind==='binding')f.task.ownerToken=crypto.randomUUID()
  if(kind==='machine')f.task.sessionId=crypto.randomUUID()
  if(kind==='authority')f.task.approvalBindings=[{approvalId:'changed',source:f.source}]
  if(kind==='recovery-missing')f.task.recovery=null
  if(kind==='coverage')f.task.recovery!.remoteEffectCoverage={kind:'unmanaged-possible',reasonCode:'unknown'}
  if(kind==='stop')f.task.stopProof=null
  if(kind==='acceptance')f.task.acceptedScopes=[]
  if(kind==='unresolved')f.task.unresolvedEffects=[f.qualification]
  if(kind.startsWith('telemetry-'))f.task.recovery!.effects=[{operationId:crypto.randomUUID(),runId:f.run.runId,generation:1,kind:'telemetry-push',target:{kind:'telemetry',destinationRepositoryId:'R_control',destinationPath:'stats/event.json',eventId:crypto.randomUUID(),batchId:crypto.randomUUID()},payloadDigest:'a'.repeat(64),state:kind==='telemetry-prepared'?'prepared':'ambiguous',intent:f.qualification,outcome:null}]
  if(kind==='local-pending'){
   const runtime=await import('../src/runs.ts');f.run=await runtime.updateRun(runtime.runsRoot(f.home),f.run.runId,()=>({pendingDelivery:[{id:crypto.randomUUID(),kind:'telemetry-capture',target:{captureKey:f.run.runId+':terminal:0'},intentRef:null,status:'pending',attempts:0,lastError:null}]}))
  }
  expect((await assessManagedRetention(f.home,f.run,async()=>f.target)).held).toBe(true)
  expect((await cleanupBasicLogs(f.home,new Date('2026-09-08'),{targetForRun:async()=>f.target})).removed).toBe(0)
  expect(await readFile(f.log,'utf8')).toContain('exit')
 }finally{await f.dispose()}
})
test('archival retention uses one exact head even if the provider advances during reading',async()=>{
 const f=await archiveRetentionFixture(),{assessManagedRetention}=await import('../src/stats/push.ts')
 try{f.advanceDuringRead();expect(await assessManagedRetention(f.home,f.run,async()=>f.target)).toEqual({held:true,reason:'retention-task-unverified',head:f.head})}finally{await f.dispose()}
})

test('archival retention verifies acknowledged telemetry evidence instead of trusting its status label',async()=>{
 const f=await archiveRetentionFixture(),{assessManagedRetention}=await import('../src/stats/push.ts')
 try{
  f.acknowledgeTelemetry()
  expect((await assessManagedRetention(f.home,f.run,async()=>f.target)).held).toBe(false)
  f.task.recovery!.effects[0]!.outcome=f.qualification
  expect((await assessManagedRetention(f.home,f.run,async()=>f.target)).held).toBe(true)
  expect(await readFile(f.log,'utf8')).toContain('exit')
 }finally{await f.dispose()}
})

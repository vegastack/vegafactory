import {test,expect} from 'bun:test'
import {mkdtemp,rm,stat,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRun,transitionRun,readRuns,parseRun,classifyRecovery,nextQuotaCheck,type RunInput} from '../src/runs.ts'
const input=(root:string):RunInput=>({root,repo:'o/r',issue:1,parent:null,checkout:root,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
test('private durable records survive reload; competing stale CAS cannot overwrite',async()=>{const root=await mkdtemp(join(tmpdir(),'runs-'));try{const r=await createRun(input(root));expect((await stat(join(root,r.runId,'run.json'))).mode&0o777).toBe(0o600);const outcomes=await Promise.allSettled([transitionRun(r.runId,1,{activeElapsedMs:100},root),transitionRun(r.runId,1,{activeElapsedMs:200},root)]);expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);const [saved]=await readRuns(root);expect(saved!.generation).toBe(2);expect([100,200]).toContain(saved!.activeElapsedMs!);await expect(transitionRun(r.runId,2,{approvalBindings:[]} as never,root)).rejects.toThrow('immutable')}finally{await rm(root,{recursive:true,force:true})}})
test('terminal identity/cause and interrupted recovery never imply replay',async()=>{const root=await mkdtemp(join(tmpdir(),'runs-'));try{const r=await createRun(input(root));await expect(transitionRun(r.runId,1,{state:'terminal'},root)).rejects.toThrow();const done=await transitionRun(r.runId,1,{state:'terminal',terminationCause:'succeeded',finishedAt:new Date().toISOString()},root);await expect(transitionRun(r.runId,done.generation,{state:'running'},root)).rejects.toThrow();expect(classifyRecovery({state:'running',ownerAlive:false,pendingDelivery:[]})).toEqual({state:'interrupted',replay:false});expect(()=>parseRun({...done,schemaVersion:7})).toThrow()}finally{await rm(root,{recursive:true,force:true})}})
test('quota checks back off without a task elapsed allowance',()=>{expect(nextQuotaCheck(0,0)).toBe(900000);expect(nextQuotaCheck(4,0)).toBe(3600000);expect(nextQuotaCheck(0,0,42)).toBe(42)})

test('approved task files use only structural canonical plan lines',async()=>{
  const runtime=await import('../src/runs.ts'),approval=await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs')
  const body='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: fixture** <!-- task-id:1-T1 -->\n  - Files — `allowed.ts`\n    Files — `indented-code.ts`\n```text\nFiles — `fenced.ts`\n``` still-fenced\nFiles — `also-fenced.ts`\n```\n'
  const binding={repo:'o/r',issue:1,kind:'plan' as const,artifactId:'PLAN_1',rev:1,digest:approval.scopeDigest(body,'plan')}
  expect((await runtime.approvedTaskSelection([binding],[{node_id:'PLAN_1',body}],'implement',{},['1-T1'])).paths).toEqual(['allowed.ts'])
})

test('terminal measurement segments exclude earlier published attempts and preserve unknown intervals',async()=>{
  const runtime=await import('../src/runs.ts'),root=await mkdtemp(join(tmpdir(),'segments-'))
  try{
    const run=await createRun(input(root)),oldId=crypto.randomUUID(),firstId=crypto.randomUUID()
    const previous=(id:string,elapsed:number|null):import('../src/runs.ts').RunAttempt=>({id,startedAt:run.startedAt,finishedAt:null,processIdentity:null,processGroupId:null,terminationCause:'interrupted',exitCode:null,activeElapsedMs:elapsed})
    const current=parseRun({...run,attempts:[previous(oldId,100),previous(firstId,20)],terminalSegment:{sequence:firstId,firstAttemptId:firstId},attemptElapsedMs:30,activeElapsedMs:150})
    expect(runtime.terminalCaptureDescriptor(run).captureKey).toBe(run.runId+':terminal:0')
    expect(runtime.terminalCaptureDescriptor(current).captureKey).toBe(run.runId+':terminal:'+firstId)
    expect(runtime.terminalCaptureAttempts(current).map(a=>a.id)).toEqual([firstId])
    expect(runtime.terminalCaptureElapsedMs(current)).toBe(50)
    expect(runtime.terminalCaptureElapsedMs({...current,attemptElapsedMs:null})).toBeNull()
    expect(runtime.terminalCaptureElapsedMs({...current,attempts:[previous(oldId,null),previous(firstId,20)]})).toBe(50)
    expect(()=>parseRun({...current,terminalSegment:{sequence:crypto.randomUUID(),firstAttemptId:firstId}})).toThrow('segment')
  }finally{await rm(root,{recursive:true,force:true})}
})

// Controlled recovery controller fixture; this does not qualify a remote provider.
async function continuationFixture(){
  const runtime=await import('../src/runs.ts'),{execFileSync,spawn}=await import('node:child_process'),{mkdir}=await import('node:fs/promises')
  const {processIdentity}=await import('../src/claims.ts'),{readHostBinding}=await import('../src/machine-identity.ts')
  const directory=await mkdtemp(join(tmpdir(),'continuation-')),root=join(directory,'runs'),checkout=join(directory,'source')
  await mkdir(checkout);execFileSync('git',['init','-q','-b','feat/1-work'],{cwd:checkout});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','fixture'],{cwd:checkout})
  const git=(args:string[])=>execFileSync('git',args,{cwd:checkout,encoding:'utf8'}).trim(),host=(await readHostBinding()).digest
  const source={kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_issue',commentId:'12',bodySha256:'a'.repeat(64)}
  const runId=crypto.randomUUID(),checkpoint={schemaVersion:1 as const,id:crypto.randomUUID(),repo:'o/r',repositoryId:'R_repo',branch:'feat/1-work',baseSha:git(['rev-parse','HEAD']),headSha:git(['rev-parse','HEAD']),treeSha:git(['rev-parse','HEAD^{tree}']),scopeDigest:'c'.repeat(64),runId,publishedAt:new Date().toISOString()}
  const seed=input(root),execution={providerMode:'subscription' as const,harness:'codex' as const,harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'fixture',qualification:source}
  let run=await createRun({...seed,runId,checkout,baseSha:checkpoint.baseSha,headSha:checkpoint.headSha,execution,harness:'codex',accountRef:'fixture',checkpoint,approvedTaskIds:['1-T1','1-T2'],approvalBindings:[{approvalId:'fixture',source}],hostBindingDigest:host,machine:{id:'fixture',installationId:crypto.randomUUID(),sessionId:crypto.randomUUID(),hostBindingDigest:host},sharedClaim:{taskKey:'d'.repeat(64),generation:1,ownerToken:crypto.randomUUID(),stateCommit:'e'.repeat(40)},worktreeDigest:await runtime.worktreeFingerprint(checkout)})
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
  try{
    const identity=await processIdentity(child.pid!)
    run=await transitionRun(runId,run.generation,{state:'running',pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid,processIdentity:identity,vendorSessionId:'prior-session',activeElapsedMs:100,attemptElapsedMs:100},root)
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();await exited
    run=await transitionRun(runId,run.generation,{state:'interrupted',terminationCause:'interrupted',finishedAt:null,attemptElapsedMs:null,activeElapsedMs:null},root)
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
  const request:import('../src/runs.ts').RunContinuationRequest={root,runId,expectedGeneration:run.generation,requestId:crypto.randomUUID(),previousAttemptId:run.attemptId!,checkpoint,worktreeDigest:run.worktreeDigest!,currentOwner:{machine:run.machine,sharedClaim:run.sharedClaim}}
  const decision=():import('../src/runs.ts').RecoveryContinuationDecision=>({action:'resume-task',reason:'fixture unfinished task',runId,expectedGeneration:request.expectedGeneration,previousAttemptId:request.previousAttemptId,taskIds:['1-T2'],approvedTaskIds:run.approvedTaskIds!,approvalBindings:run.approvalBindings,recordBinding:run.recordBinding,artifacts:run.approvalRefs,execution,checkpoint,worktreeDigest:request.worktreeDigest,currentOwner:request.currentOwner,sourceRefs:[{id:'fixture-history',updatedAt:new Date().toISOString(),bodySha256:'a'.repeat(64)}]})
  return{runtime,directory,root,run,request,decision}
}

test('verified continuation preserves unknown interruption, immutable old capture and one retry identity',async()=>{
  const f=await continuationFixture()
  try{
    await f.runtime.ensureTerminalCaptureIntent(f.root,f.run.runId)
    f.run=await f.runtime.readRun(f.root,f.run.runId);f.request.expectedGeneration=f.run.generation
    const bytes=await readFile(join(f.root,f.run.runId,'run.json'),'utf8')
    let verifies=0
    const controller={verifyRecovery:async()=>{verifies++;return f.decision()}}
    const next=await f.runtime.beginVerifiedRunContinuation(f.request,controller)
    expect(next.runId).toBe(f.run.runId);expect(next.attemptId).not.toBe(f.run.attemptId);expect(next.attemptOperationIds).not.toEqual(f.run.attemptOperationIds)
    expect(next.attempts?.[0]?.finishedAt).toBeNull();expect(next.attempts?.[0]?.activeElapsedMs).toBeNull();expect(next.attempts?.[0]?.vendorSessionId).toBe('prior-session')
    expect(next.vendorSessionId).toBeNull();expect(next.pendingDelivery).toEqual(f.run.pendingDelivery);expect(next.activeElapsedMs).toBeNull()
    expect(await readFile(join(f.root,next.runId,'history',f.run.attemptId+'.'+next.attempts![0]!.snapshotDigest+'.json'),'utf8')).toBe(bytes)
    expect(await f.runtime.readRunAttemptSnapshot(f.root,next.runId,next.attempts![0]!)).toEqual(f.run)
    expect((await f.runtime.beginVerifiedRunContinuation(f.request,controller))).toEqual(next);expect(verifies).toBe(1)
    await expect(f.runtime.beginVerifiedRunContinuation({...f.request,worktreeDigest:'f'.repeat(64)},controller)).rejects.toThrow('rebound')
    await expect(transitionRun(next.runId,next.generation,{pendingDelivery:[]},f.root)).rejects.toThrow('immutable')
    expect(f.runtime.terminalCaptureDescriptor(next).captureKey).toBe(next.runId+':terminal:'+next.attemptId)
    expect(f.runtime.terminalCaptureElapsedMs(next)).toBe(0)
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('continuation refuses wrong source, stale owner, incomplete proof without mutations',async()=>{
  const f=await continuationFixture()
  try{
    const original=await readFile(join(f.root,f.run.runId,'run.json'),'utf8'),good={verifyRecovery:async()=>f.decision()}
    await expect(f.runtime.beginVerifiedRunContinuation({...f.request,checkpoint:{...f.request.checkpoint,headSha:'f'.repeat(40)}},good)).rejects.toThrow('source')
    await expect(f.runtime.beginVerifiedRunContinuation({...f.request,currentOwner:{...f.request.currentOwner,sharedClaim:{...f.run.sharedClaim!,ownerToken:crypto.randomUUID()}}},good)).rejects.toThrow('owner')
    await expect(f.runtime.beginVerifiedRunContinuation(f.request,{verifyRecovery:async()=>({verified:true}) as never})).rejects.toThrow()
    await expect(f.runtime.beginVerifiedRunContinuation(f.request,{verifyRecovery:async()=>({...f.decision(),taskIds:['1-T9']})})).rejects.toThrow('decision')
    await expect(f.runtime.beginVerifiedRunContinuation(f.request,{verifyRecovery:async()=>{throw Error('fresh authority unavailable')}})).rejects.toThrow('authority')
    expect(await readFile(join(f.root,f.run.runId,'run.json'),'utf8')).toBe(original)
    await writeFile(join(f.run.checkout,'dirty.txt'),'unbacked user edit')
    await expect(f.runtime.beginVerifiedRunContinuation(f.request,good)).rejects.toThrow('checkout')
    expect(await readFile(join(f.root,f.run.runId,'run.json'),'utf8')).toBe(original)
    await rm(join(f.run.checkout,'dirty.txt'))
    const next=await f.runtime.beginVerifiedRunContinuation(f.request,good)
    expect(next.attempts).toHaveLength(1)
    await expect(f.runtime.beginRunAttempt(f.root,next.runId,next.generation)).rejects.toThrow('quota')
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('post-capture continuation preserves old payload and ACK while allocating one nonoverlapping terminal segment',async()=>{
  const f=await continuationFixture(),{normalizeRecord}=await import('../src/stats/record.ts')
  try{
    f.run=await transitionRun(f.run.runId,f.run.generation,{state:'terminal',finishedAt:new Date().toISOString(),activeElapsedMs:100,attemptElapsedMs:100},f.root)
    const payload=normalizeRecord({repo:f.run.repo,issue:f.run.issue,session_id:'prior-session',ts:f.run.finishedAt!,duration_s:0.1,outcome:'failed'})
    const prior=await f.runtime.prepareTerminalCapture(f.root,f.run.runId,payload)
    const priorKey=f.runtime.terminalCaptureDescriptor(f.run).captureKey
    await f.runtime.acknowledgeTerminalCapture(f.root,f.run.runId,priorKey,prior.payloadDigest!)
    f.run=await f.runtime.readRun(f.root,f.run.runId);f.request.expectedGeneration=f.run.generation
    const oldBytes=await readFile(join(f.root,f.run.runId,'run.json'),'utf8')
    let next=await f.runtime.beginVerifiedRunContinuation(f.request,{verifyRecovery:async()=>f.decision()})
    expect(next.pendingDelivery[0]).toEqual({...prior,status:'acknowledged',lastError:null})
    expect(await readFile(join(f.root,next.runId,'history',f.run.attemptId+'.'+next.attempts![0]!.snapshotDigest+'.json'),'utf8')).toBe(oldBytes)
    next=await transitionRun(next.runId,next.generation,{state:'terminal',terminationCause:'succeeded',finishedAt:new Date().toISOString(),activeElapsedMs:130,attemptElapsedMs:30},f.root)
    expect(f.runtime.terminalCaptureElapsedMs(next)).toBe(30)
    expect(f.runtime.terminalCaptureAttempts(next)).toEqual([])
    const laterPayload=normalizeRecord({repo:next.repo,issue:next.issue,session_id:null,ts:next.finishedAt!,duration_s:0.03,outcome:'complete'})
    const later=await f.runtime.prepareTerminalCapture(f.root,next.runId,laterPayload)
    expect(later.target).not.toEqual(prior.target)
    expect(await f.runtime.prepareTerminalCapture(f.root,next.runId,laterPayload)).toEqual(later)
    const saved=await f.runtime.readRun(f.root,next.runId)
    expect(saved.pendingDelivery).toHaveLength(2);expect(saved.pendingDelivery[0]?.payload).toBe(prior.payload);expect(saved.pendingDelivery[0]?.payloadDigest).toBe(prior.payloadDigest)
    await expect(f.runtime.prepareTerminalCapture(f.root,next.runId,{...laterPayload,duration_s:1})).rejects.toThrow('rebound')
    await expect(transitionRun(saved.runId,saved.generation,{pendingDelivery:saved.pendingDelivery.map(p=>p.id===prior.id?{...p,payload:'rewritten'}:p)},f.root)).rejects.toThrow('immutable')
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('verified continuation independently rejects a live group and unknown termination',async()=>{
  const f=await continuationFixture(),{spawn}=await import('node:child_process'),{processIdentity}=await import('../src/claims.ts')
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
  try{
    const identity=await processIdentity(child.pid!),controller={verifyRecovery:async()=>f.decision()}
    // Fixture replaces only its own private record to represent a crashed controller
    // whose original owned process is still alive; public mutation forbids this swap.
    await f.runtime.atomicRunFile(join(f.root,f.run.runId,'run.json'),parseRun({...f.run,pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid,processIdentity:identity}))
    await expect(f.runtime.beginVerifiedRunContinuation(f.request,controller)).rejects.toThrow('stop unavailable')
    await f.runtime.atomicRunFile(join(f.root,f.run.runId,'run.json'),parseRun({...f.run,terminationCause:'termination-unconfirmed'}))
    await expect(f.runtime.beginVerifiedRunContinuation(f.request,controller)).rejects.toThrow('stopped attempt')
    await f.runtime.atomicRunFile(join(f.root,f.run.runId,'run.json'),f.run)
    const [one,two]=await Promise.allSettled([f.runtime.beginVerifiedRunContinuation(f.request,controller),f.runtime.beginVerifiedRunContinuation({...f.request,requestId:crypto.randomUUID()},controller)])
    expect([one,two].filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect((await f.runtime.readRun(f.root,f.run.runId)).attempts).toHaveLength(1)
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited}
    await rm(f.directory,{recursive:true,force:true})
  }
})

// Two homes and a real source checkpoint; callbacks are controlled controller
// fixtures, not a claim to qualify GitHub stop evidence or a vendor runtime.
async function receivingFixture(){
  const runtime=await import('../src/runs.ts'),wire=await import('../src/shared-claims.ts')
  const {execFileSync}=await import('node:child_process'),{mkdir}=await import('node:fs/promises')
  const {readHostBinding}=await import('../src/machine-identity.ts')
  const directory=await mkdtemp(join(tmpdir(),'receiving-')),oldHome=join(directory,'old-home'),newHome=join(directory,'new-home'),root=join(newHome,'runs'),source=join(oldHome,'source'),checkout=join(newHome,'checkout'),remote=join(directory,'remote.git')
  await mkdir(source,{recursive:true});await mkdir(newHome)
  const git=(cwd:string,args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  git(source,['init','-q','-b','feat/1-work']);await writeFile(join(source,'allowed.txt'),'verified progress\n')
  git(source,['add','allowed.txt']);git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','verified progress'])
  git(directory,['clone','-q','--bare',source,remote]);git(newHome,['clone','-q',remote,checkout])
  await writeFile(join(oldHome,'pending-outbox'),'original private telemetry bytes')
  const runId=crypto.randomUUID(),host=(await readHostBinding()).digest,taskKey='d'.repeat(64)
  const authority={approvalId:'fixture',source:{kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_issue',commentId:'12',bodySha256:'a'.repeat(64)}}
  const reference=()=>({kind:'state-receipt' as const,operationId:crypto.randomUUID(),commitSha:'e'.repeat(40),blobSha256:'f'.repeat(64)})
  const artifacts:import('../src/shared-claims.ts').ArtifactRef[]=[{repo:'o/r',issue:1,kind:'plan',artifactId:'PLAN_1',rev:1,digest:'a'.repeat(64)}]
  const approvedTaskIds=['1-T1','1-T2'],scopeDigest=wire.sha256(wire.canonical({artifacts,taskIds:approvedTaskIds}))
  const checkpoint:import('../src/shared-claims.ts').CheckpointRef={schemaVersion:1,id:crypto.randomUUID(),repo:'o/r',repositoryId:'R_repo',branch:'feat/1-work',baseSha:git(checkout,['rev-parse','HEAD']),headSha:git(checkout,['rev-parse','HEAD']),treeSha:git(checkout,['rev-parse','HEAD^{tree}']),scopeDigest,runId,publishedAt:'2026-09-07T00:00:00.000Z'}
  const execution:import('../src/shared-claims.ts').ExecutionIdentity={providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'fixture',effort:'high',accountRef:'original-account',qualification:reference()}
  const effect:import('../src/shared-claims.ts').EffectRef={operationId:crypto.randomUUID(),runId,generation:3,kind:'telemetry-push',target:{kind:'telemetry',destinationRepositoryId:'R_room',destinationPath:'data/fixture.jsonl',eventId:crypto.randomUUID(),batchId:crypto.randomUUID()},payloadDigest:'a'.repeat(64),state:'ambiguous',intent:reference(),outcome:null}
  const envelope:import('../src/shared-claims.ts').RecoveryEnvelope={schemaVersion:2,taskKey,runId,generation:3,approvalBindings:[authority],recordBinding:authority,scopeDigest,approvalDigest:'b'.repeat(64),execution,checkpoint,completed:[{taskId:'1-T1',headSha:checkpoint.headSha,acceptance:{sourceSha:checkpoint.headSha,validationId:'fixture/check/'+'a'.repeat(64),commandDigest:'a'.repeat(64),evidence:reference()}}],children:[],joins:[],effects:[effect],remoteEffectCoverage:{kind:'reconciled',evidence:reference()}}
  const original:import('../src/shared-claims.ts').TaskRecord={schemaVersion:1,taskKey,host:'github.com',repo:'o/r',issue:1,repositoryNodeId:'R_repo',issueNodeId:'I_issue',scopeDigest,approvalDigest:'b'.repeat(64),approvalBindings:[authority],generation:3,machineId:'old-machine',installationId:crypto.randomUUID(),sessionId:crypto.randomUUID(),ownerToken:crypto.randomUUID(),runId,stage:'implement',state:'running',paths:['allowed.txt'],resources:[],independent:true,parentTaskKey:null,parentBinding:null,approvedTaskIds,checkpoint,stopProof:null,unresolvedEffects:[],recovery:envelope,acceptedScopes:[]}
  const machine={id:'receiver',installationId:crypto.randomUUID(),sessionId:crypto.randomUUID(),hostBindingDigest:host}
  const stopProof:import('../src/shared-claims.ts').StopProof={kind:'verified-reboot',machineId:original.machineId,installationId:original.installationId,sessionId:original.sessionId,hostBindingDigest:'1'.repeat(64),bootIdDigest:'2'.repeat(64),runIds:[runId],generation:3,observedAt:'2026-09-07T01:00:00.000Z',evidenceRef:reference()}
  const current:import('../src/shared-claims.ts').TaskRecord={...structuredClone(original),generation:4,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,ownerToken:crypto.randomUUID(),state:'claimed',stopProof,recovery:{...structuredClone(envelope),generation:4}}
  const handoff=reference(),previousHead='3'.repeat(40)
  const receipt:import('../src/shared-claims.ts').OperationReceipt={schemaVersion:1,operationId:handoff.operationId,type:'handoff',taskKey,generation:4,previousHead,requestDigest:'4'.repeat(64),resultOwner:{ownerToken:current.ownerToken,machineId:machine.id,installationId:machine.installationId,sessionId:machine.sessionId,runId},recoveryPayload:null}
  handoff.blobSha256=wire.sha256(wire.canonical(receipt))
  const decision:import('../src/runs.ts').VerifiedReceivingRunDecision={action:'resume-task',reason:'verified fixture outstanding task',original:{stateCommit:previousHead,task:original},current:{stateCommit:handoff.commitSha,task:current},handoff:{ref:handoff,receipt},artifacts,authorityRequest:{kind:'native'},taskIds:['1-T2'],sourceRefs:[{id:'fixture-source',updatedAt:'2026-09-07T01:00:00.000Z',bodySha256:'a'.repeat(64)}],receiver:{machine,claimToken:crypto.randomUUID(),policyDigest:'b'.repeat(64),runtimeBinding:{schemaVersion:1,sourceSha:'5'.repeat(40),treeSha:'6'.repeat(40),packageName:'@vegastack/vegafactory',version:'0.1.0',tarballSha256:'7'.repeat(64),inventoryDigest:'8'.repeat(64)},configurationDigest:'9'.repeat(64),worktreeDigest:await runtime.worktreeFingerprint(checkout)}}
  const request:import('../src/runs.ts').ReceivingRunRequest={root,requestId:crypto.randomUUID(),runId,taskKey,expectedSharedGeneration:4,checkout,handoff}
  const controller={verifyRecovery:async()=>structuredClone(decision)}
  return{runtime,wire,directory,oldHome,newHome,root,checkout,request,decision,controller,effect}
}

test('receiving home preserves logical run, unavailable history and old telemetry without old local home',async()=>{
  const f=await receivingFixture()
  try{
    await rm(f.oldHome,{recursive:true,force:true})
    const old=f.wire.canonical(f.decision.original.task)
    const run=await f.runtime.createVerifiedReceivingRun(f.request,f.controller)
    expect(run.runId).toBe(f.request.runId);expect(run.approvedTaskIds).toEqual(['1-T1','1-T2']);expect(run.taskKey.scopeDigest).toBe(f.decision.original.task.scopeDigest)
    expect(run.execution).toEqual(f.decision.original.task.recovery!.execution);expect(run.recordBinding).toEqual(f.decision.original.task.recovery!.recordBinding)
    expect(run.machine).toEqual(f.decision.receiver.machine);expect(run.sharedClaim?.generation).toBe(4);expect(run.state).toBe('prepared')
    expect(run.attempts).toEqual([]);expect(run.attemptId).not.toBe(run.runId);expect(run.processIdentity).toBeNull();expect(run.stopProof).toBeNull();expect(run.vendorSessionId).toBeNull();expect(run.finishedAt).toBeNull()
    expect(run.remoteRecovery?.originalTask).toEqual({bytes:old,sha256:f.wire.sha256(old)})
    expect(JSON.parse(run.remoteRecovery!.originalTask.bytes).recovery.effects).toEqual([f.effect])
    expect(JSON.parse(run.remoteRecovery!.originalTask.bytes).stopProof).toBeNull();expect(run.remoteRecovery!.stopProof).toEqual(f.decision.current.task.stopProof!)
    expect(run.pendingDelivery).toEqual([]);expect(run.activeElapsedMs).toBeNull();expect(f.runtime.priorRunElapsedMs(run)).toBeNull();expect(f.runtime.terminalCaptureElapsedMs(run)).toBe(0)
    expect(f.runtime.runReportingHold(run)).toBe('original-reporting-context-unavailable')
    expect(f.runtime.terminalCaptureDescriptor(run).sequence).toBe(run.attemptId!)
    expect((await stat(join(f.root,run.runId,'run.json'))).mode&0o777).toBe(0o600)
    expect(await f.runtime.readRun(f.root,run.runId)).toEqual(run)
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('receiving allocation rechecks authority on replay, rejects rebound and existing ordinary records',async()=>{
  const f=await receivingFixture()
  try{
    let calls=0
    const controller={verifyRecovery:async()=>{calls++;return structuredClone(f.decision)}}
    const run=await f.runtime.createVerifiedReceivingRun(f.request,controller)
    f.decision.current.stateCommit='b'.repeat(40);f.decision.sourceRefs[0]!.updatedAt='2026-09-08T00:00:00.000Z'
    expect(await f.runtime.createVerifiedReceivingRun(f.request,controller)).toEqual(run);expect(calls).toBe(4)
    expect(await readFile(join(f.oldHome,'pending-outbox'),'utf8')).toBe('original private telemetry bytes')
    await expect(f.runtime.createVerifiedReceivingRun({...f.request,requestId:crypto.randomUUID()},controller)).rejects.toThrow('rebound')
    await expect(f.runtime.createVerifiedReceivingRun(f.request,{verifyRecovery:async()=>{throw Error('source revoked')}})).rejects.toThrow('revoked')
    await f.runtime.atomicRunFile(join(f.root,run.runId,'run.json'),parseRun({...run,policyDigest:'f'.repeat(64)}))
    await expect(f.runtime.createVerifiedReceivingRun(f.request,controller)).rejects.toThrow('saved identity')
    await f.runtime.atomicRunFile(join(f.root,run.runId,'run.json'),run)
    await f.runtime.prepareRunAttemptDirectory(f.root,run)
    await expect(f.runtime.createVerifiedReceivingRun(f.request,controller)).rejects.toThrow('wrapper')
    const otherRoot=join(f.newHome,'ordinary')
    const ordinary=await createRun({...input(otherRoot),runId:f.request.runId})
    await expect(f.runtime.createVerifiedReceivingRun({...f.request,root:otherRoot},controller)).rejects.toThrow('rebound')
    expect(await f.runtime.readRun(otherRoot,ordinary.runId)).toEqual(ordinary)
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('receiving constructor rejects changed scope, completed tasks, owner, stop, history and unresolved control effects',async()=>{
  const f=await receivingFixture()
  try{
    const cases:Array<(decision:import('../src/runs.ts').VerifiedReceivingRunDecision)=>void>=[
      d=>{d.taskIds=['1-T1']},d=>{d.taskIds=['1-T9']},d=>{d.current.task.generation++},d=>{d.current.task.runId=crypto.randomUUID()},
      d=>{d.handoff.receipt.previousHead='a'.repeat(40)},d=>{d.current.task.stopProof!.generation++},d=>{d.receiver.machine.hostBindingDigest='a'.repeat(64)},
      d=>{d.receiver.runtimeBinding.inventoryDigest='invalid'},d=>{delete (d as Partial<typeof d>).authorityRequest},d=>{d.artifacts[0]!.rev++},d=>{d.current.task.recovery!.effects=[]},
      d=>{d.current.task.parentTaskKey='a'.repeat(64)},d=>{d.current.task.state='running'},
      d=>{d.original.task.recovery!.remoteEffectCoverage={kind:'unmanaged-possible',reasonCode:'unverified'};d.current.task.recovery!.remoteEffectCoverage=d.original.task.recovery!.remoteEffectCoverage},
      d=>{const effect=d.original.task.recovery!.effects[0]!;effect.kind='handback';effect.target={kind:'issue-comment',repositoryId:'R_repo',issueNodeId:'I_issue',commentId:null,markerId:'original-marker'};d.current.task.recovery!.effects=structuredClone(d.original.task.recovery!.effects)},
    ]
    for(const change of cases){const decision=structuredClone(f.decision);change(decision);await expect(f.runtime.createVerifiedReceivingRun(f.request,{verifyRecovery:async()=>decision})).rejects.toThrow();expect(await f.runtime.readRuns(f.root)).toEqual([])}
    let checks=0
    await expect(f.runtime.createVerifiedReceivingRun(f.request,{verifyRecovery:async()=>{const decision=structuredClone(f.decision);if(++checks===2)decision.receiver.claimToken=crypto.randomUUID();return decision}})).rejects.toThrow('changed during verification')
    await writeFile(join(f.checkout,'allowed.txt'),'unbacked change')
    await expect(f.runtime.createVerifiedReceivingRun(f.request,f.controller)).rejects.toThrow('checkout changed')
    expect(await f.runtime.readRuns(f.root)).toEqual([])
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('receiving provenance cannot be injected or rewritten and unknown cumulative history survives local capture and quota retry',async()=>{
  const f=await receivingFixture(),{normalizeRecord}=await import('../src/stats/record.ts')
  try{
    let run=await f.runtime.createVerifiedReceivingRun(f.request,f.controller)
    await expect(createRun({...input(f.root),remoteRecovery:run.remoteRecovery} as never)).rejects.toThrow('verified constructor')
    await expect(transitionRun(run.runId,run.generation,{remoteRecovery:undefined} as never,f.root)).rejects.toThrow('immutable')
    await expect(transitionRun(run.runId,run.generation,{activeElapsedMs:0},f.root)).rejects.toThrow('unknown')
    expect(()=>parseRun({...run,remoteRecovery:{...run.remoteRecovery,originalTask:{...run.remoteRecovery!.originalTask,bytes:'changed'}}})).toThrow('provenance')
    expect(()=>parseRun({...run,remoteRecovery:{...run.remoteRecovery,reportingContext:'available'}})).toThrow('provenance')
    const original=run.remoteRecovery
    run=await transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'failed',finishedAt:new Date().toISOString(),attemptElapsedMs:25,activeElapsedMs:null,vendorSessionId:'receiver-session',waitReason:'subscription-quota'},f.root)
    run=await f.runtime.beginRunAttempt(f.root,run.runId,run.generation)
    expect(run.attempts).toHaveLength(1);expect(run.remoteRecovery).toEqual(original);expect(run.activeElapsedMs).toBeNull();expect(f.runtime.priorRunElapsedMs(run)).toBeNull()
    run=await transitionRun(run.runId,run.generation,{state:'terminal',terminationCause:'succeeded',finishedAt:new Date().toISOString(),attemptElapsedMs:35,activeElapsedMs:null,waitReason:null},f.root)
    expect(f.runtime.terminalCaptureElapsedMs(run)).toBe(60)
    const capture=await f.runtime.prepareTerminalCapture(f.root,run.runId,normalizeRecord({repo:run.repo,issue:run.issue,session_id:run.vendorSessionId,ts:run.finishedAt!,duration_s:0.06,outcome:'complete'}))
    const saved=await f.runtime.readRun(f.root,run.runId)
    expect(saved.pendingDelivery[0]?.payload).toBe(capture.payload);expect(saved.remoteRecovery).toEqual(original);expect(f.runtime.runReportingHold(saved)).toBe('original-reporting-context-unavailable')
    await expect(transitionRun(run.runId,saved.generation,{pendingDelivery:[]},f.root)).rejects.toThrow('immutable')
    const ordinary=await createRun(input(join(f.newHome,'ordinary')))
    expect(f.runtime.runReportingHold(ordinary)).toBeNull();expect(f.runtime.priorRunElapsedMs(ordinary)).toBe(0)
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('receiving allocation excludes simultaneous duplicate constructors and malformed opaque provenance',async()=>{
  const f=await receivingFixture()
  try{
    const outcomes=await Promise.allSettled([f.runtime.createVerifiedReceivingRun(f.request,f.controller),f.runtime.createVerifiedReceivingRun({...f.request,requestId:crypto.randomUUID()},f.controller)])
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    const [run]=await f.runtime.readRuns(f.root)
    expect(run!.attempts).toEqual([])
    const bytes='x'.repeat(256*1024+1)
    expect(()=>parseRun({...run,remoteRecovery:{...run!.remoteRecovery,originalTask:{bytes,sha256:f.wire.sha256(bytes)}}})).toThrow('provenance')
  }finally{await rm(f.directory,{recursive:true,force:true})}
})

test('receiving startup reconciliation keeps historical usage unknown after receiver spawn failure',async()=>{
  const f=await receivingFixture(),{spawn}=await import('node:child_process'),{processIdentity}=await import('../src/claims.ts')
  let child:ReturnType<typeof spawn>|undefined
  try{
    const run=await f.runtime.createVerifiedReceivingRun(f.request,f.controller)
    const attempt=await f.runtime.prepareRunAttemptDirectory(f.root,run)
    child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
    const identity=await processIdentity(child.pid!)
    const stopped=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill();await stopped
    await f.runtime.atomicRunFile(join(attempt,'handshake.json'),{schemaVersion:1,runId:run.runId,attemptId:run.attemptId,identity,pgid:identity.pid})
    await f.runtime.atomicRunFile(join(attempt,'result.json'),{schemaVersion:1,runId:run.runId,attemptId:run.attemptId,exitCode:null,cause:'spawn-failed',finishedAt:new Date().toISOString()})
    const [recovered]=await f.runtime.reconcileRuns(f.root)
    expect(recovered!.state).toBe('terminal');expect(recovered!.terminationCause).toBe('spawn-failed');expect(recovered!.attemptElapsedMs).toBe(0);expect(recovered!.activeElapsedMs).toBeNull()
    expect(recovered!.remoteRecovery).toEqual(run.remoteRecovery);expect(f.runtime.runReportingHold(recovered!)).toBe('original-reporting-context-unavailable')
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill('SIGKILL');await exited}
    await rm(f.directory,{recursive:true,force:true})
  }
})

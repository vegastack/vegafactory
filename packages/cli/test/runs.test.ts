import {test,expect} from 'bun:test'
import {mkdtemp,rm,stat,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRun,transitionRun,readRuns,parseRun,classifyRecovery,nextQuotaCheck,type RunInput} from '../src/runs.ts'
const input=(root:string):RunInput=>({root,repo:'o/r',issue:1,parent:null,checkout:root,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'fixture',model:'fixture',effort:'high',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
test('private durable records survive reload; competing stale CAS cannot overwrite',async()=>{const root=await mkdtemp(join(tmpdir(),'runs-'));try{const r=await createRun(input(root));expect((await stat(join(root,r.runId,'run.json'))).mode&0o777).toBe(0o600);const outcomes=await Promise.allSettled([transitionRun(r.runId,1,{activeElapsedMs:100},root),transitionRun(r.runId,1,{activeElapsedMs:200},root)]);expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);const [saved]=await readRuns(root);expect(saved!.generation).toBe(2);expect([100,200]).toContain(saved!.activeElapsedMs!);await expect(transitionRun(r.runId,2,{approvalBindings:[]} as never,root)).rejects.toThrow('immutable')}finally{await rm(root,{recursive:true,force:true})}})
test('terminal identity/cause and interrupted recovery never imply replay',async()=>{const root=await mkdtemp(join(tmpdir(),'runs-'));try{const r=await createRun(input(root));await expect(transitionRun(r.runId,1,{state:'terminal'},root)).rejects.toThrow();const done=await transitionRun(r.runId,1,{state:'terminal',terminationCause:'succeeded',finishedAt:new Date().toISOString()},root);await expect(transitionRun(r.runId,done.generation,{state:'running'},root)).rejects.toThrow();expect(classifyRecovery({state:'running',ownerAlive:false,pendingDelivery:[]})).toEqual({state:'interrupted',replay:false});expect(()=>parseRun({...done,schemaVersion:7})).toThrow()}finally{await rm(root,{recursive:true,force:true})}})
test('quota checks back off without a task elapsed allowance',()=>{expect(nextQuotaCheck(0,0)).toBe(900000);expect(nextQuotaCheck(4,0)).toBe(3600000);expect(nextQuotaCheck(0,0,42)).toBe(42)})

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

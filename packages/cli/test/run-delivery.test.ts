import {test,expect} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRun,deliverRunStatus,resumeSubscriptionWork,readRun,transitionRun,type RunInput} from '../src/runs.ts'
const source={kind:'github-comment' as const,repositoryId:'R_repo',issueNodeId:'I_parent',commentId:'12',bodySha256:'a'.repeat(64)}
function input(root:string):RunInput{return{root,repo:'o/r',issue:1,parent:null,checkout:root,branch:'feat/1-work',baseSha:'a'.repeat(40),headSha:null,stage:'implement',harness:'codex',model:'same-model',effort:'high',execution:{providerMode:'subscription',harness:'codex',harnessVersion:'fixture',model:'same-model',effort:'high',accountRef:'same-account',qualification:source},approvalBindings:[{approvalId:'original',source}],recordBinding:null,approvalRefs:[],policyDigest:'b'.repeat(64),claimToken:crypto.randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'o/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},activeElapsedMs:10,taskOwner:null,agentAccountOwner:null,accountRef:'same-account',waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}}}
test('lost handback response reconciles its opaque marker and never exposes run identity',async()=>{const root=await mkdtemp(join(tmpdir(),'delivery-'));try{const run=await createRun(input(root));const comments:Array<{id:number;body:string;user:{login:string}}>=[];let sends=0;const controller={senderLogin:'robot',wait:async()=>{},verifyAuthority:async()=>{},gh:async(args:string[],options?:{input?:string})=>{if(args.includes('POST')){sends++;comments.push({id:7,user:{login:'robot'},body:JSON.parse(options!.input!).body});throw Error('lost response')}return 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(comments)}};const request={root,runId:run.runId,intentRef:'approved-status',approvalBindings:run.approvalBindings};const saved=await deliverRunStatus(request,controller);expect(saved.pendingDelivery[0]?.status).toBe('acknowledged');expect(comments[0]!.body).not.toContain(run.runId);expect(comments[0]!.body).not.toContain(root);await deliverRunStatus(request,controller);expect(sends).toBe(1)}finally{await rm(root,{recursive:true,force:true})}})
test('quota waiting persists and resumes exact setup after more than six hours',async()=>{const root=await mkdtemp(join(tmpdir(),'quota-'));try{const run=await createRun(input(root));let now=0,attempts=0,checks=0;const executions:string[]=[];const result=await resumeSubscriptionWork(root,run.runId,{now:()=>now,wait:async ms=>{now+=ms},verifyCurrent:async()=>{},available:async execution=>{executions.push(JSON.stringify(execution));return ++checks===10},checkpoint:async()=>{},attempt:async()=>++attempts===1?{kind:'subscription-quota'}:{kind:'complete'}});expect(result).toBe('complete');expect(now).toBeGreaterThan(6*60*60*1000);expect(attempts).toBe(2);expect(new Set(executions).size).toBe(1);const saved=await readRun(root,run.runId);expect(saved.activeElapsedMs).toBe(10);expect(saved.waitReason).toBe(null)}finally{await rm(root,{recursive:true,force:true})}})
test('restart uses saved quota availability deadline and explicit cancellation stops waiting',async()=>{const root=await mkdtemp(join(tmpdir(),'quota-'));try{let run=await createRun(input(root));run=await transitionRun(run.runId,run.generation,{waitReason:'subscription-quota',quotaWait:{checks:2,nextCheckAt:new Date(999000).toISOString()}},root);const abort=new AbortController();let waited=0;const result=await resumeSubscriptionWork(root,run.runId,{now:()=>1000,wait:async ms=>{waited=ms;abort.abort()},verifyCurrent:async()=>{},available:async()=>{throw Error('must not inspect')},checkpoint:async()=>{},attempt:async()=>{throw Error('must not execute')}},abort.signal);expect(result).toBe('cancelled');expect(waited).toBe(998000)}finally{await rm(root,{recursive:true,force:true})}})


test('missing process identity proves stop only for an independently verified never-started attempt',async()=>{
  const runtime=await import('../src/runs.ts'),{readHostBinding}=await import('../src/machine-identity.ts')
  const root=await mkdtemp(join(tmpdir(),'stop-identity-'))
  try{
    let run=await createRun({...input(root),hostBindingDigest:(await readHostBinding()).digest})
    expect(await runtime.verifyLocalRunStopped(run)).toBe(false)
    run=await runtime.updateRun(root,run.runId,()=>({state:'terminal',terminationCause:'spawn-failed',finishedAt:new Date().toISOString()}))
    expect(await runtime.verifyLocalRunStopped(run)).toBe(true)
    await runtime.prepareRunAttemptDirectory(root,run)
    expect(await runtime.verifyLocalRunStopped(run)).toBe(false)
    expect(await runtime.verifyLocalRunStopped({...run,hostBindingDigest:'f'.repeat(64)})).toBe(false)
  }finally{await rm(root,{recursive:true,force:true})}
})

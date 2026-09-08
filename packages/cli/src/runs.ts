// Private local execution truth. Remote ownership and delivery acknowledgments stay separate.
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { acquireClaim, releaseClaim, processIdentity, type ProcessIdentity } from './claims.ts'
import { parseEvidenceRef, parseCheckpointRef, type ApprovalAuthorityRef, type ArtifactRef, type ExecutionIdentity, type CheckpointRef, type RecoveryEnvelope } from './shared-claims.ts'
export type TerminalCause = 'succeeded' | 'failed' | 'spawn-failed' | 'timed-out' | 'cancelled' | 'interrupted' | 'termination-unconfirmed'
export interface PendingDelivery {
  id: string; kind: 'feature-push' | 'handback' | 'evidence' | 'telemetry-capture'
  target: {repo:string;remote:string;branch:string;sha:string} | {repo:string;issue:number;commentId:number|null} | {captureKey:string}
  intentRef: string|null; exportProof?: {repositoryId:string;remoteRef:string;verifiedRemoteHead:string|null;approvedBaseSha:string;headSha:string;closureDigest:string;validatorVersion:1}; approvalBindings?:ApprovalAuthorityRef[]; status:'pending'|'ambiguous'|'acknowledged'; attempts:number; lastError:string|null
}
export interface RunRecord {
  checkpointIntent?:import('./checkpoints.ts').CheckpointIntent
  schemaVersion:2; runId:string; generation:number; repo:string; issue:number; parent:number|null
  checkout:string; branch:string; baseSha:string; headSha:string|null; stage:string; harness:string; model:string; effort:string
  // Null records an unqualified local diagnostic attempt; shared/vendor admission requires identity.
  execution:ExecutionIdentity|null; approvalBindings:ApprovalAuthorityRef[]; recordBinding:ApprovalAuthorityRef|null; approvalRefs:ArtifactRef[]
  policyDigest:string; claimToken:string; state:'prepared'|'running'|'terminal'|'interrupted'; terminationCause:TerminalCause|null
  exitCode:number|null; pid:number|null; processStartId:string|null; processGroupId:number|null; processIdentity:ProcessIdentity|null
  startedAt:string; finishedAt:string|null; pendingDelivery:PendingDelivery[]
  taskKey:{repo:string;issue:number;taskId:string;scopeDigest:string}; activeElapsedMs:number|null
  quotaWait?:{nextCheckAt:string;checks:number}|null
  taskOwner:string|null; agentAccountOwner:string|null; accountRef:string|null; waitReason:null|'subscription-quota'
  machine:{id:string;installationId:string;sessionId:string;hostBindingDigest:string}|null
  sharedClaim:{taskKey:string;generation:number;ownerToken:string;stateCommit:string}|null; checkpoint:CheckpointRef|null
  remoteEffectCoverage:RecoveryEnvelope['remoteEffectCoverage']
}
type Automatic = 'schemaVersion'|'runId'|'generation'|'state'|'terminationCause'|'exitCode'|'pid'|'processStartId'|'processGroupId'|'processIdentity'|'finishedAt'|'pendingDelivery'
export type RunInput = Omit<RunRecord,Automatic> & {root:string;runId?:string}
export type RunPatch = Partial<Pick<RunRecord,'state'|'terminationCause'|'exitCode'|'pid'|'processStartId'|'processGroupId'|'processIdentity'|'finishedAt'|'pendingDelivery'|'headSha'|'activeElapsedMs'|'waitReason'|'quotaWait'|'checkpoint'|'sharedClaim'>>
const patchKeys = new Set(['state','terminationCause','exitCode','pid','processStartId','processGroupId','processIdentity','finishedAt','pendingDelivery','headSha','activeElapsedMs','waitReason','quotaWait','checkpoint','sharedClaim'])
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const causes = new Set(['succeeded','failed','spawn-failed','timed-out','cancelled','interrupted','termination-unconfirmed'])
const roots = new Map<string,string>()
export const runsRoot = (home=homedir()) => join(home,'.vegastack','runs')
function requireId(id:string) { if (!uuid.test(id)) throw Error('invalid run identity') }
async function privatePath(path:string,directory:boolean) { const s=await lstat(path); if(s.isSymbolicLink() || (directory?!s.isDirectory():!s.isFile()) || (s.mode&0o077)!==0 || s.uid!==process.getuid?.()) throw Error('unsafe private run path') }
export async function atomicRunFile(path:string,value:unknown):Promise<void> {
  await privatePath(dirname(path),true)
  try { await privatePath(path,false) } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e }
  const temp=path+'.'+randomUUID()+'.tmp'; const f=await open(temp,'wx',0o600)
  try {await f.writeFile(JSON.stringify(value)+'\n');await f.sync()} finally {await f.close()}
  await rename(temp,path);const d=await open(dirname(path),'r');try {await d.sync()}finally{await d.close()}
}
export function validateAuthority(ref:ApprovalAuthorityRef):void {
  if(!ref || Object.keys(ref).sort().join(',')!=='approvalId,source' || !ref.approvalId || parseEvidenceRef(ref.source).kind!=='github-comment') throw Error('invalid approval authority')
}
export function parseRun(value:unknown):RunRecord {
  const r=value as RunRecord
  const keys=['schemaVersion','runId','generation','repo','issue','parent','checkout','branch','baseSha','headSha','stage','harness','model','effort','execution','approvalBindings','recordBinding','approvalRefs','policyDigest','claimToken','state','terminationCause','exitCode','pid','processStartId','processGroupId','processIdentity','startedAt','finishedAt','pendingDelivery','taskKey','activeElapsedMs','taskOwner','agentAccountOwner','accountRef','waitReason','machine','sharedClaim','checkpoint','remoteEffectCoverage']
  if(!r||typeof r!=='object'||Object.keys(r).some(k=>!keys.includes(k)&&k!=='quotaWait'&&k!=='checkpointIntent')||keys.some(k=>!(k in r)))throw Error('unknown or missing run field')
  if(!r || r.schemaVersion!==2 || !uuid.test(r.runId) || !Number.isSafeInteger(r.generation) || r.generation<1 || !/^[^/]+\/[^/]+$/.test(r.repo) || !Number.isSafeInteger(r.issue) || r.issue<1 || !isAbsolute(r.checkout) || !['prepared','running','terminal','interrupted'].includes(r.state) || (r.terminationCause!==null&&!causes.has(r.terminationCause)) || !Array.isArray(r.approvalBindings) || !Array.isArray(r.pendingDelivery) || !r.taskKey || r.taskKey.repo!==r.repo || r.taskKey.issue!==r.issue || (r.activeElapsedMs!==null&&(!Number.isFinite(r.activeElapsedMs)||r.activeElapsedMs<0))) throw Error('invalid run record')
  if(r.sharedClaim&&(!r.execution||!r.machine||!r.approvalBindings.length))throw Error('shared run qualification or ownership missing')
  if(r.execution){const e=r.execution;if(Object.keys(e).sort().join(',')!=='accountRef,effort,harness,harnessVersion,model,providerMode,qualification'||e.providerMode!=='subscription'||!['claude','codex'].includes(e.harness)||e.harness!==r.harness||e.model!==r.model||e.effort!==r.effort||e.accountRef!==r.accountRef)throw Error('execution identity mismatch');parseEvidenceRef(e.qualification)}
  if(r.quotaWait&&(!Number.isFinite(Date.parse(r.quotaWait.nextCheckAt))||!Number.isSafeInteger(r.quotaWait.checks)||r.quotaWait.checks<0))throw Error('invalid quota schedule')
  r.approvalBindings.forEach(validateAuthority);if(r.recordBinding)validateAuthority(r.recordBinding);if(r.checkpoint)parseCheckpointRef(r.checkpoint)
  if(r.state==='terminal' && (!r.terminationCause || !r.finishedAt))throw Error('terminal run requires cause and finish')
  for(const p of r.pendingDelivery)if(!uuid.test(p.id)||!['feature-push','handback','evidence','telemetry-capture'].includes(p.kind)||!['pending','ambiguous','acknowledged'].includes(p.status)||!Number.isSafeInteger(p.attempts)||p.attempts<0)throw Error('invalid pending delivery')
  return r
}
export async function createRun(input:RunInput):Promise<RunRecord> {
  const {root,runId=randomUUID(),...identity}=input;requireId(runId)
  await mkdir(root,{recursive:true,mode:0o700});await privatePath(root,true)
  const dir=join(root,runId);await mkdir(dir,{mode:0o700})
  const record=parseRun({...identity,schemaVersion:2,runId,generation:1,state:'prepared',terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,finishedAt:null,pendingDelivery:[]})
  await atomicRunFile(join(dir,'run.json'),record);roots.set(runId,root);return record
}
export async function readRun(root:string,runId:string):Promise<RunRecord>{requireId(runId);await privatePath(root,true);const dir=join(root,runId);await privatePath(dir,true);const path=join(dir,'run.json');await privatePath(path,false);const r=parseRun(JSON.parse(await readFile(path,'utf8')));if(r.runId!==runId)throw Error('run identity mismatch');roots.set(runId,root);return r}
export async function readRuns(root:string):Promise<RunRecord[]>{let names:string[];try{names=await readdir(root)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}const result:RunRecord[]=[];for(const id of names)if(uuid.test(id))result.push(await readRun(root,id));return result}
export async function transitionRun(runId:string,expectedGeneration:number,patch:RunPatch,root=roots.get(runId)??runsRoot()):Promise<RunRecord>{
  requireId(runId);if(Object.keys(patch).some(k=>!patchKeys.has(k)))throw Error('immutable run identity')
  const lock=await acquireClaim(join(root,runId,'mutation'),await processIdentity());if(lock.kind!=='owned')throw Error('run mutation unavailable')
  try{const old=await readRun(root,runId);if(old.generation!==expectedGeneration)throw Error('stale run generation');if(patch.activeElapsedMs!==undefined&&old.activeElapsedMs!==null&&patch.activeElapsedMs!==null&&patch.activeElapsedMs<old.activeElapsedMs)throw Error('active elapsed checkpoint decreased');if(old.state==='terminal'&&patch.state&&patch.state!=='terminal')throw Error('terminal run cannot restart');const next=parseRun({...old,...patch,generation:old.generation+1});await atomicRunFile(join(root,runId,'run.json'),next);return next}finally{await releaseClaim(lock.claim)}
}
export function classifyRecovery(input:{state:RunRecord['state'];ownerAlive:boolean;pendingDelivery:unknown[]}):{state:RunRecord['state'];replay:false}{return{state:!input.ownerAlive&&['prepared','running'].includes(input.state)?'interrupted':input.state,replay:false}}
export async function reconcileRuns(root:string):Promise<RunRecord[]>{const result:RunRecord[]=[];for(let r of await readRuns(root)){if(['prepared','running'].includes(r.state)){let alive=true;if(r.processIdentity){try{const actual=await processIdentity(r.processIdentity.pid);alive=JSON.stringify(actual)===JSON.stringify(r.processIdentity)}catch{try{process.kill(r.processIdentity.pid,0)}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false}}} // Unknown handshake is preserved; absence of PID is not proof of absence.
 if(!alive)r=await transitionRun(r.runId,r.generation,{state:'interrupted',terminationCause:'interrupted'},root)}result.push(r)}return result}
export function nextQuotaCheck(attempt:number,now:number,providerRetryAt?:number):number{return providerRetryAt&&providerRetryAt>now?providerRetryAt:now+Math.min(60,15*2**Math.min(attempt,2))*60_000}

// Source provenance comes from the owner evaluator's actual read set, never a caller locator.
export async function bindVerifiedApprovalSources(tuples:Array<{approvalId:string;commentId:number;bodySha256:string}>, reads:unknown[], gh:(args:string[])=>Promise<unknown>, rawGh?:(args:string[],options?:import('./gh.ts').GhOptions)=>Promise<string>):Promise<ApprovalAuthorityRef[]> {
  const {createHash}=await import('node:crypto')
  const {fetchGhPages}=await import('./gh.ts')
  const comments=reads.flatMap(value=>Array.isArray(value)?value:[value]).filter((value):value is Record<string,unknown>=>!!value&&typeof value==='object')
  const refs:ApprovalAuthorityRef[]=[]
  for(const tuple of tuples){
    if(!Number.isSafeInteger(tuple.commentId)||tuple.commentId<=0)throw Error('approval comment ID is not lossless')
    const matches=comments.filter(c=>c.id===tuple.commentId&&typeof c.body==='string'&&createHash('sha256').update(c.body).digest('hex')===tuple.bodySha256)
    const source=matches[0];if(!source||typeof source.issue_url!=='string')throw Error('verified containing approval history unavailable')
    const locator=/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(source.issue_url);if(!locator)throw Error('approval source host unavailable')
    const sourceRepo=locator[1]!,issue=locator[2]!
    const direct=await gh(['api',`repos/${sourceRepo}/issues/comments/${tuple.commentId}`]) as Record<string,unknown>
    if(direct.id!==tuple.commentId||direct.body!==source.body||direct.issue_url!==source.issue_url)throw Error('approval source changed')
    const history=await fetchGhPages<Record<string,unknown>>(rawGh??(await import('./gh.ts')).ghText,`repos/${sourceRepo}/issues/${issue}/comments`)
    if(!history.complete||history.items.filter(c=>c.id===tuple.commentId&&c.body===source.body).length!==1)throw Error('approval containing history changed')
    const repository=await gh(['api',`repos/${sourceRepo}`]) as {node_id:string}
    const subject=await gh(['api',`repos/${sourceRepo}/issues/${issue}`]) as {node_id:string}
    const ref:ApprovalAuthorityRef={approvalId:tuple.approvalId,source:{kind:'github-comment',repositoryId:repository.node_id,issueNodeId:subject.node_id,commentId:String(tuple.commentId),bodySha256:tuple.bodySha256}}
    validateAuthority(ref);refs.push(ref)
  }
  return refs
}

export async function deliverRunStatus(input:{root:string;runId:string;intentRef:string;approvalBindings:ApprovalAuthorityRef[]},controller:{
  gh:(args:string[],options?:import('./gh.ts').GhOptions)=>Promise<string>
  verifyAuthority:(run:RunRecord,intentRef:string)=>Promise<void>
  beforeSend?:(run:RunRecord,delivery:PendingDelivery,payload:string)=>Promise<void>
  afterReadback?:(run:RunRecord,delivery:PendingDelivery,commentId:number,payload:string)=>Promise<void>
}):Promise<RunRecord>{
  const {fetchGhPages}=await import('./gh.ts')
  let run=await readRun(input.root,input.runId)
  if(!input.intentRef||!input.approvalBindings.length||JSON.stringify(input.approvalBindings)!==JSON.stringify(run.approvalBindings))throw Error('handback authority unavailable')
  await controller.verifyAuthority(run,input.intentRef)
  let delivery=run.pendingDelivery.find(p=>p.kind==='handback'&&p.intentRef===input.intentRef)
  if(!delivery){delivery={id:randomUUID(),kind:'handback',target:{repo:run.repo,issue:run.issue,commentId:null},intentRef:input.intentRef,status:'pending',attempts:0,lastError:null};run=await transitionRun(run.runId,run.generation,{pendingDelivery:[...run.pendingDelivery,delivery]},input.root)}
  if(delivery.status==='acknowledged')return run
  const marker=`<!-- vsk:delivery:${delivery.id} -->`
  const payload=`${marker}\nExecution requires attention: ${run.terminationCause??'interrupted'}. Saved work is preserved.\n`
  const persist=async(patch:Partial<PendingDelivery>)=>{delivery={...delivery!,...patch};run=await transitionRun(run.runId,run.generation,{pendingDelivery:run.pendingDelivery.map(p=>p.id===delivery!.id?delivery!:p)},input.root)}
  const comments=async()=>{const page=await fetchGhPages<{id:number;body:string}>(controller.gh,`repos/${run.repo}/issues/${run.issue}/comments`);if(!page.complete)throw Error('handback-read-incomplete');return page.items.filter(c=>typeof c.body==='string'&&c.body.includes(marker))}
  try{
    const matches=await comments();if(matches.length>1)throw Error('handback-marker-ambiguous')
    if(matches.length===1){if(matches[0]!.body!==payload)throw Error('handback-payload-mismatch');if(run.sharedClaim&&!controller.afterReadback)throw Error('handback-shared-outcome-unavailable');await controller.afterReadback?.(run,delivery,matches[0]!.id,payload);await persist({status:'acknowledged',target:{repo:run.repo,issue:run.issue,commentId:matches[0]!.id},lastError:null});return run}
    // A lost create response can be reconciled, but absence alone never licenses another create.
    if(delivery.status==='ambiguous')throw Error('handback-create-unconfirmed')
    if(run.sharedClaim&&!controller.beforeSend)throw Error('handback-shared-intent-unavailable')
    await controller.beforeSend?.(run,delivery,payload)
    await controller.verifyAuthority(run,input.intentRef)
    await persist({status:'ambiguous',attempts:delivery.attempts+1})
    try{await controller.gh(['api',`repos/${run.repo}/issues/${run.issue}/comments`,'--method','POST','--input','-'],{input:JSON.stringify({body:payload}),timeoutMs:10_000})}catch{/* Readback, never blind replay. */}
    for(let attempt=0;attempt<3;attempt++){
      if(attempt)await new Promise(resolve=>setTimeout(resolve,2**attempt*1000))
      const found=await comments();if(found.length>1)throw Error('handback-marker-ambiguous');if(found.length===1&&found[0]!.body===payload){if(run.sharedClaim&&!controller.afterReadback)throw Error('handback-shared-outcome-unavailable');await controller.afterReadback?.(run,delivery,found[0]!.id,payload);await persist({status:'acknowledged',target:{repo:run.repo,issue:run.issue,commentId:found[0]!.id},lastError:null});return run}
    }
    throw Error('handback-readback-exhausted')
  }catch{await persist({lastError:'handback-delivery-unconfirmed'});return run}
}

// Shared effect publication has two durable phases: receipt, then envelope link. The
// prepared effect is marked ambiguous by #137 before the adapter may send even once.
export async function prepareManagedRunEffect(input:{claim:import('./shared-claims.ts').SharedClaim;run:RunRecord;effect:Omit<import('./shared-claims.ts').EffectRef,'intent'|'outcome'|'state'>}):Promise<{claim:import('./shared-claims.ts').SharedClaim;effect:import('./shared-claims.ts').EffectRef}>{
  const owner=await import('./shared-claims.ts')
  const snapshot=await owner.readCoordination(input.claim.target)
  const task=snapshot.tasks[input.claim.taskKey]
  if(!task?.recovery||task.runId!==input.run.runId||input.effect.runId!==input.run.runId||task.generation!==input.claim.generation)throw Error('managed effect recovery envelope unavailable')
  const e=input.effect
  const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-intent',effectId:e.operationId,runId:e.runId,generation:e.generation,approvalBindings:input.run.approvalBindings,effectKind:e.kind,target:e.target,payloadDigest:e.payloadDigest,result:'prepared',observedRemoteId:null,observedDigest:null,reasonCode:null}
  const receipt=await owner.publishRecoveryReceipt({claim:input.claim,operationId:randomUUID(),payload})
  const effect:import('./shared-claims.ts').EffectRef={...e,state:'prepared',intent:receipt.reference,outcome:null}
  const recovery={...task.recovery,effects:[...task.recovery.effects,effect]}
  const linked=await owner.transitionSharedTask({claim:receipt.claim,operationId:randomUUID(),transition:{kind:'recovery',recovery}})
  if(linked.kind!=='owned')throw Error('managed effect receipt link unavailable')
  return owner.beginManagedEffect({claim:linked.claim,effectId:effect.operationId,operationId:randomUUID()})
}

export function sumActiveElapsed(attempts:RunRecord[]):number|null {
  const unique=new Map(attempts.map(run=>[run.runId,run]))
  if([...unique.values()].some(run=>run.activeElapsedMs===null))return null
  return [...unique.values()].reduce((total,run)=>total+run.activeElapsedMs!,0)
}
export interface QuotaRecoveryController {
  now:()=>number
  wait:(ms:number,signal?:AbortSignal)=>Promise<void>
  // These adapters must verify the same subscription setup and current original authority.
  verifyCurrent:(run:RunRecord)=>Promise<void>
  available:(execution:ExecutionIdentity)=>Promise<boolean>
  attempt:(run:RunRecord)=>Promise<{kind:'complete'}|{kind:'blocked'}|{kind:'subscription-quota';retryAt?:number}>
  checkpoint:(run:RunRecord)=>Promise<void>
}
export async function resumeSubscriptionWork(root:string,runId:string,controller:QuotaRecoveryController,signal?:AbortSignal):Promise<'complete'|'blocked'|'cancelled'>{
  let run=await readRun(root,runId)
  if(!run.execution)throw Error('subscription execution identity unavailable')
  const execution=JSON.stringify(run.execution)
  for(;;){
    if(signal?.aborted)return'cancelled'
    run=await readRun(root,runId)
    if(JSON.stringify(run.execution)!==execution)throw Error('subscription setup changed')
    await controller.verifyCurrent(run)
    if(run.waitReason==='subscription-quota'){
      const wait=run.quotaWait??{nextCheckAt:new Date(nextQuotaCheck(0,controller.now())).toISOString(),checks:0}
      // Checkpointed wall-clock availability schedule survives reboot. Active execution uses monotonic measurements elsewhere.
      if(!run.quotaWait)run=await transitionRun(runId,run.generation,{quotaWait:wait},root)
      try{await controller.wait(Math.max(0,Date.parse(wait.nextCheckAt)-controller.now()),signal)}catch{if(signal?.aborted)return'cancelled';throw Error('quota availability wait failed')}
      if(signal?.aborted)return'cancelled'
      await controller.verifyCurrent(run)
      if(!await controller.available(run.execution!)){run=await transitionRun(runId,run.generation,{quotaWait:{checks:wait.checks+1,nextCheckAt:new Date(nextQuotaCheck(wait.checks+1,controller.now())).toISOString()}},root);continue}
      run=await transitionRun(runId,run.generation,{waitReason:null,quotaWait:null},root)
    }
    const outcome=await controller.attempt(run)
    if(outcome.kind==='complete'||outcome.kind==='blocked')return outcome.kind
    await controller.checkpoint(run)
    // Re-read after checkpoint and attempt mutations; never overwrite their generation.
    run=await readRun(root,runId)
    run=await transitionRun(runId,run.generation,{waitReason:'subscription-quota',quotaWait:{checks:0,nextCheckAt:new Date(nextQuotaCheck(0,controller.now(),outcome.retryAt)).toISOString()}},root)
  }
}

export async function acknowledgeManagedRunEffect(input:{claim:import('./shared-claims.ts').SharedClaim;run:RunRecord;effectId:string;observedRemoteId:string;observedDigest:string}):Promise<import('./shared-claims.ts').SharedClaim>{
  const owner=await import('./shared-claims.ts'),snapshot=await owner.readCoordination(input.claim.target),task=snapshot.tasks[input.claim.taskKey]
  const effect=task?.recovery?.effects.find(e=>e.operationId===input.effectId)
  if(!task?.recovery||!effect||effect.state!=='ambiguous'||effect.runId!==input.run.runId||effect.payloadDigest!==input.observedDigest)throw Error('effect readback identity mismatch')
  const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-outcome',effectId:effect.operationId,runId:effect.runId,generation:effect.generation,approvalBindings:input.run.approvalBindings,effectKind:effect.kind,target:effect.target,payloadDigest:effect.payloadDigest,result:'acknowledged',observedRemoteId:input.observedRemoteId,observedDigest:input.observedDigest,reasonCode:null}
  const receipt=await owner.publishRecoveryReceipt({claim:input.claim,operationId:randomUUID(),payload})
  const linked=await owner.transitionSharedTask({claim:receipt.claim,operationId:randomUUID(),transition:{kind:'recovery',recovery:{...task.recovery,effects:task.recovery.effects.map(e=>e.operationId===effect.operationId?{...e,state:'acknowledged',outcome:receipt.reference}:e)}}})
  if(linked.kind!=='owned')throw Error('effect outcome receipt link unavailable')
  return linked.claim
}

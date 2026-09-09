import { canonical as canonicalWire } from './shared-claims.ts'
import { parseStrictJson } from '../../../skills/dev/dev-implement/scripts/lib/approval.mjs'
// Private local execution truth. Remote ownership and delivery acknowledgments stay separate.
import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, realpath } from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { acquireClaim, releaseClaim, processIdentity, type ProcessIdentity } from './claims.ts'
import { parseEvidenceRef, parseCheckpointRef, parseStopProof, parseRecoveryPayload, parseRecoveryEnvelope, type ApprovalAuthorityRef, type ArtifactRef, type ExecutionIdentity, type CheckpointRef, type RecoveryEnvelope, type EvidenceRef, type TaskRecord, type OperationReceipt } from './shared-claims.ts'
export type TerminalCause = 'succeeded' | 'failed' | 'spawn-failed' | 'timed-out' | 'cancelled' | 'interrupted' | 'termination-unconfirmed'
export interface PendingDelivery {
  payload?:string
  payloadDigest?:string
  checkpoint?:CheckpointRef
  sourceAcknowledged?:boolean
  effect?:{kind:import('./shared-claims.ts').EffectRef['kind'];target:import('./shared-claims.ts').EffectTarget;payloadDigest:string;generation:number;intent:import('./shared-claims.ts').EvidenceRef|null;outcome:import('./shared-claims.ts').EvidenceRef|null}
  retryReceiptIds?:string[]
  receiptIds?:{intent:string;link:string;send:string;outcome:string;outcomeLink:string;checkpointLink:string}

  id: string; kind: 'feature-push' | 'handback' | 'evidence' | 'telemetry-capture'
  target: {repo:string;remote:string;branch:string;sha:string} | {repo:string;issue:number;commentId:number|null} | {captureKey:string}
  intentRef: string|null; exportProof?: {repositoryId:string;remoteRef:string;verifiedRemoteHead:string|null;approvedBaseSha:string;headSha:string;closureDigest:string;validatorVersion:1}; approvalBindings?:ApprovalAuthorityRef[]; status:'pending'|'ambiguous'|'acknowledged'; attempts:number; lastError:string|null
}
export interface RunAttempt {
  id:string; startedAt:string; finishedAt:string|null; processIdentity:ProcessIdentity|null; processGroupId:number|null
  terminationCause:TerminalCause; exitCode:number|null; activeElapsedMs:number|null
  vendorSessionId?:string|null; terminalSequence?:string; snapshotDigest?:string
}
export interface RunRecord {
  remoteRecovery?:{
    kind:'receiving-home';requestId:string;requestDigest:string
    handoff:Extract<EvidenceRef,{kind:'state-receipt'}>;originalStateCommit:string
    stopProof:NonNullable<TaskRecord['stopProof']>
    // Historical bytes are retained, not decoded into ownership or send authority.
    originalTask:{bytes:string;sha256:string}
    priorHistory:'unavailable';reportingContext:'unavailable'
  }
  terminalSegment?:{sequence:string;firstAttemptId:string}
  continuations?:Array<{requestId:string;requestDigest:string;previousAttemptId:string;attemptId:string}>
  acceptedScopeRef?:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>|null
  stopProof?:import('./shared-claims.ts').StopProof|null
  stopReceiptIds?:{receipt:string;transition:string}
  stopReceiptPayload?:Extract<import('./shared-claims.ts').RecoveryEvidencePayload,{kind:'effect-reconciliation'}>
  terminationRequest?:{cause:'timed-out'|'cancelled'|'interrupted'|'failed';at:string}|null
  cancelRequestedAt?:string|null
  quotaChecks?:number
  attemptElapsedMs?:number|null
  approvedTaskIds?:string[]
  authorityRequest?:RunAuthorityRequest
  worktreeDigest?:string|null
  handbackIntent?:{id:string;approvalBindings:ApprovalAuthorityRef[]}
  dispatchRequest?:{commentId:number|null;reactionId:number|null}
  attemptOperationIds?:{recovery:string;start:string;coverage:string}
  claimOperationId?:string
  runtimeBinding?:InstalledRuntimeBinding
  configurationDigest?:string
  vendorSessionId?:string|null
  attemptId?:string
  attempts?:RunAttempt[]
  hostBindingDigest?:string|null

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
type Automatic = 'remoteRecovery'|'terminalSegment'|'continuations'|'attemptOperationIds'|'claimOperationId'|'attemptElapsedMs'|'attemptId'|'attempts'|'schemaVersion'|'runId'|'generation'|'state'|'terminationCause'|'exitCode'|'pid'|'processStartId'|'processGroupId'|'processIdentity'|'finishedAt'|'pendingDelivery'
export type RunInput = Omit<RunRecord,Automatic> & {root:string;runId?:string}
export type RunPatch = Partial<Pick<RunRecord,'state'|'terminationCause'|'exitCode'|'pid'|'processStartId'|'processGroupId'|'processIdentity'|'finishedAt'|'pendingDelivery'|'headSha'|'activeElapsedMs'|'waitReason'|'quotaWait'|'quotaChecks'|'terminationRequest'|'cancelRequestedAt'|'attemptElapsedMs'|'worktreeDigest'|'stopProof'|'stopReceiptIds'|'stopReceiptPayload'|'acceptedScopeRef'|'vendorSessionId'|'checkpoint'|'sharedClaim'>>
const patchKeys = new Set(['state','terminationCause','exitCode','pid','processStartId','processGroupId','processIdentity','finishedAt','pendingDelivery','headSha','activeElapsedMs','waitReason','quotaWait','quotaChecks','terminationRequest','cancelRequestedAt','attemptElapsedMs','worktreeDigest','stopProof','stopReceiptIds','stopReceiptPayload','acceptedScopeRef','vendorSessionId','checkpoint','sharedClaim'])
const sameJson=(a:unknown,b:unknown)=>canonicalWire(a)===canonicalWire(b)
const hashBytes=(bytes:string)=>createHash('sha256').update(bytes).digest('hex')
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const causes = new Set(['succeeded','failed','spawn-failed','timed-out','cancelled','interrupted','termination-unconfirmed'])
const roots = new Map<string,string>()
export const runsRoot = (home=homedir()) => join(home,'.vegastack','runs')
function requireId(id:string) { if (!uuid.test(id)) throw Error('invalid run identity') }
async function privatePath(path:string,directory:boolean) {
  const stat=await lstat(path)
  if(stat.isSymbolicLink() || (directory?!stat.isDirectory():!stat.isFile()) || (stat.mode&0o077)!==0 || stat.uid!==process.getuid?.()) throw Error('unsafe private run path')
}
export async function readPrivateRunFile(path:string,maxBytes=4*1024*1024):Promise<string> {
  await privatePath(dirname(path),true)
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const stat=await file.stat()
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>maxBytes)throw Error('unsafe or oversized private run record')
    const bytes=await file.readFile()
    if(bytes.length>maxBytes)throw Error('private run record grew beyond bound')
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  } finally {await file.close()}
}
export async function atomicRunFile(path:string,value:unknown):Promise<void> {
  await privatePath(dirname(path),true)
  try {await privatePath(path,false)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const temp=path+'.'+randomUUID()+'.tmp',bytes=JSON.stringify(value)+'\n'
  const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try {
    try {await file.writeFile(bytes);await file.sync()}finally{await file.close()}
    // Refuse a replacement link or wrong-owner target; never write through one.
    try {await privatePath(path,false)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    await rename(temp,path)
    const directory=await open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW)
    try {await directory.sync()}finally{await directory.close()}
  }catch(error){await rm(temp,{force:true}).catch(()=>{});throw error}
}
export function validateAuthority(ref:ApprovalAuthorityRef):void {
  if(!ref || Object.keys(ref).sort().join(',')!=='approvalId,source' || !ref.approvalId || parseEvidenceRef(ref.source).kind!=='github-comment') throw Error('invalid approval authority')
}
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v)
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)
const number=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))
const closed=(v:unknown,keys:string[])=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))
const nullable=(v:unknown,check:(value:unknown)=>boolean)=>v===null||check(v)
export function validRunProcess(value:unknown):value is ProcessIdentity {
  if(!closed(value,['pid','uid','bootId','startId']))return false
  const v=value as ProcessIdentity
  return number(v.pid)&&v.pid>0&&number(v.uid)&&text(v.bootId)&&text(v.startId)
}
function validBranch(value:unknown):value is string {
  return text(value)&&!value.startsWith('-')&&!value.startsWith('/')&&!value.endsWith('/')&&!/[\s~^:?*\[\\]/.test(value)&&!value.includes('..')&&!value.includes('@{')&&value.split('/').every(p=>p&&!p.startsWith('.')&&!p.endsWith('.')&&!p.endsWith('.lock'))
}
function validRepo(value:unknown):value is string{return typeof value==='string'&&/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value)}
function validExecution(value:unknown):value is ExecutionIdentity {
  if(!closed(value,['providerMode','harness','harnessVersion','model','effort','accountRef','qualification']))return false
  const v=value as ExecutionIdentity
  if(v.providerMode!=='subscription'||!['claude','codex'].includes(v.harness)||![v.harnessVersion,v.model,v.effort,v.accountRef].every(x=>text(x)))return false
  try{parseEvidenceRef(v.qualification);return true}catch{return false}
}
function validatePending(value:unknown,run:RunRecord):void {
  if(!plain(value))throw Error('invalid pending delivery')
  const required=['id','kind','target','intentRef','status','attempts','lastError']
  const allowed=[...required,'exportProof','approvalBindings','payload','payloadDigest','checkpoint','sourceAcknowledged','receiptIds','effect','retryReceiptIds']
  if(required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('unknown or missing delivery field')
  const p=value as unknown as PendingDelivery
  if(!uuid.test(p.id)||!['feature-push','handback','evidence','telemetry-capture'].includes(p.kind)||!['pending','ambiguous','acknowledged'].includes(p.status)||!number(p.attempts)||!nullable(p.intentRef,text)||!nullable(p.lastError,v=>typeof v==='string'&&/^[a-z0-9-]{1,128}$/.test(v)))throw Error('invalid delivery identity/state')
  if(p.kind==='feature-push'){
    if(!closed(p.target,['repo','remote','branch','sha']))throw Error('invalid source delivery target')
    const target=p.target as {repo:string;remote:string;branch:string;sha:string}
    if(target.repo!==run.repo||target.branch!==run.branch||!sha(target.sha)||!text(target.remote))throw Error('source delivery escaped run')
  }else if(p.kind==='telemetry-capture'){
    if(!closed(p.target,['captureKey'])||!text((p.target as {captureKey:string}).captureKey))throw Error('invalid telemetry target')
  }else{
    if(!closed(p.target,['repo','issue','commentId']))throw Error('invalid public delivery target')
    const target=p.target as {repo:string;issue:number;commentId:number|null}
    if(target.repo!==run.repo||target.issue!==run.issue||!nullable(target.commentId,v=>number(v)&&v>0))throw Error('public delivery escaped run')
  }
  if(p.payload!==undefined&&(typeof p.payload!=='string'||Buffer.byteLength(p.payload)>1024*1024))throw Error('invalid delivery payload')
  if(p.payloadDigest!==undefined&&!digest(p.payloadDigest))throw Error('invalid delivery digest')
  if(p.sourceAcknowledged!==undefined&&typeof p.sourceAcknowledged!=='boolean')throw Error('invalid source acknowledgment')
  if(p.checkpoint!==undefined)parseCheckpointRef(p.checkpoint)
  if(p.retryReceiptIds!==undefined&&(!Array.isArray(p.retryReceiptIds)||new Set(p.retryReceiptIds).size!==p.retryReceiptIds.length||p.retryReceiptIds.some(id=>!uuid.test(id))))throw Error('invalid retry receipt identity')
  if(p.receiptIds!==undefined&&(!closed(p.receiptIds,['intent','link','send','outcome','outcomeLink','checkpointLink'])||Object.values(p.receiptIds).some(id=>!uuid.test(id))))throw Error('invalid delivery receipt IDs')
  if(p.effect!==undefined){const e=p.effect;if(!closed(e,['kind','target','payloadDigest','generation','intent','outcome'])||!['checkpoint-push','handback','evidence','telemetry-push'].includes(e.kind)||!digest(e.payloadDigest)||!number(e.generation)||e.generation<1)throw Error('invalid managed delivery effect');parseRecoveryPayload({schemaVersion:2,kind:'effect-intent',effectId:p.id,runId:run.runId,generation:e.generation,approvalBindings:run.approvalBindings,effectKind:e.kind,target:e.target,payloadDigest:e.payloadDigest,result:'prepared',observedRemoteId:null,observedDigest:null,reasonCode:null});if(e.intent)parseEvidenceRef(e.intent);if(e.outcome)parseEvidenceRef(e.outcome)}
  if(p.approvalBindings){p.approvalBindings.forEach(validateAuthority);if(!sameJson(p.approvalBindings,run.approvalBindings))throw Error('delivery authority differs')}
  if(p.exportProof){const proof=p.exportProof;if(!closed(proof,['repositoryId','remoteRef','verifiedRemoteHead','approvedBaseSha','headSha','closureDigest','validatorVersion'])||!text(proof.repositoryId)||proof.remoteRef!==`refs/heads/${run.branch}`||!nullable(proof.verifiedRemoteHead,sha)||proof.approvedBaseSha!==run.baseSha||!sha(proof.headSha)||!digest(proof.closureDigest)||proof.validatorVersion!==1)throw Error('invalid export proof')}
}
export function parseRun(value:unknown):RunRecord {
  const required=['schemaVersion','runId','generation','repo','issue','parent','checkout','branch','baseSha','headSha','stage','harness','model','effort','execution','approvalBindings','recordBinding','approvalRefs','policyDigest','claimToken','state','terminationCause','exitCode','pid','processStartId','processGroupId','processIdentity','startedAt','finishedAt','pendingDelivery','taskKey','activeElapsedMs','taskOwner','agentAccountOwner','accountRef','waitReason','machine','sharedClaim','checkpoint','remoteEffectCoverage']
  const optional=['remoteRecovery','terminalSegment','continuations','quotaWait','checkpointIntent','attemptId','attempts','hostBindingDigest','vendorSessionId','authorityRequest','handbackIntent','deliveryError','runtimeBinding','configurationDigest','dispatchRequest','attemptOperationIds','claimOperationId','approvedTaskIds','attemptElapsedMs','quotaChecks','terminationRequest','cancelRequestedAt','worktreeDigest','stopProof','stopReceiptIds','stopReceiptPayload','acceptedScopeRef']
  if(!plain(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('unknown or missing run field')
  const r=value as unknown as RunRecord,diagnostic=r.execution===null
  if(r.schemaVersion!==2||!uuid.test(r.runId)||!number(r.generation)||r.generation<1||!validRepo(r.repo)||!number(r.issue)||r.issue<1||!nullable(r.parent,v=>number(v)&&v>0)||!text(r.checkout,8192)||!isAbsolute(r.checkout)||!date(r.startedAt)||!nullable(r.finishedAt,date)||!['prepared','running','terminal','interrupted'].includes(r.state)||!nullable(r.terminationCause,v=>typeof v==='string'&&causes.has(v))||!nullable(r.exitCode,v=>Number.isSafeInteger(v))||!nullable(r.activeElapsedMs,v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)||!uuid.test(r.claimToken))throw Error('invalid run lifecycle')
  if(![r.stage,r.harness,r.model,r.effort].every(v=>text(v))||!(validBranch(r.branch)||diagnostic&&r.branch==='')||!(sha(r.baseSha)||diagnostic&&r.baseSha==='')||!nullable(r.headSha,sha)||!(digest(r.policyDigest)||diagnostic&&r.policyDigest===''))throw Error('invalid run source/setup')
  if(!closed(r.taskKey,['repo','issue','taskId','scopeDigest'])||r.taskKey.repo!==r.repo||r.taskKey.issue!==r.issue||!text(r.taskKey.taskId)||!(digest(r.taskKey.scopeDigest)||diagnostic&&r.taskKey.scopeDigest===''))throw Error('invalid task identity')
  for(const login of [r.taskOwner,r.agentAccountOwner])if(!nullable(login,v=>typeof v==='string'&&/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(v)))throw Error('invalid owner attribution')
  if(!nullable(r.accountRef,text)||!nullable(r.processIdentity,validRunProcess)||!nullable(r.pid,v=>number(v)&&v>0)||!nullable(r.processGroupId,v=>number(v)&&v>0)||!nullable(r.processStartId,text))throw Error('invalid process identity')
  if(r.processIdentity ? r.pid!==r.processIdentity.pid||r.processGroupId!==r.pid||r.processStartId!==r.processIdentity.startId : r.pid!==null||r.processGroupId!==null||r.processStartId!==null)throw Error('inconsistent process identity')
  if(!Array.isArray(r.approvalBindings)||!Array.isArray(r.approvalRefs)||!Array.isArray(r.pendingDelivery))throw Error('invalid run collections')
  r.approvalBindings.forEach(validateAuthority)
  if(new Set(r.approvalBindings.map(a=>JSON.stringify(a))).size!==r.approvalBindings.length)throw Error('duplicate authority')
  if(r.recordBinding!==null)validateAuthority(r.recordBinding)
  for(const a of r.approvalRefs)if(!closed(a,['repo','issue','kind','artifactId','rev','digest'])||a.repo!==r.repo||a.issue!==r.issue||!['brief','plan'].includes(a.kind)||!text(a.artifactId)||!number(a.rev)||a.rev<1||!digest(a.digest))throw Error('invalid artifact binding')
  if(r.execution!==null&&(!validExecution(r.execution)||r.execution.harness!==r.harness||r.execution.model!==r.model||r.execution.effort!==r.effort||r.execution.accountRef!==r.accountRef))throw Error('execution identity mismatch')
  if(r.sharedClaim!==null){if(!closed(r.sharedClaim,['taskKey','generation','ownerToken','stateCommit'])||!digest(r.sharedClaim.taskKey)||!number(r.sharedClaim.generation)||r.sharedClaim.generation<1||!uuid.test(r.sharedClaim.ownerToken)||!sha(r.sharedClaim.stateCommit)||!r.execution||!r.machine||!r.approvalBindings.length)throw Error('invalid shared ownership')}
  if(r.machine!==null&&(!closed(r.machine,['id','installationId','sessionId','hostBindingDigest'])||!text(r.machine.id)||!uuid.test(r.machine.installationId)||!uuid.test(r.machine.sessionId)||!digest(r.machine.hostBindingDigest)))throw Error('invalid machine identity')
  if(r.hostBindingDigest!==undefined&&!nullable(r.hostBindingDigest,digest))throw Error('invalid host binding')
  if(r.checkpoint!==null){parseCheckpointRef(r.checkpoint);if(r.checkpoint.runId!==r.runId||r.checkpoint.repo!==r.repo||r.checkpoint.scopeDigest!==r.taskKey.scopeDigest)throw Error('checkpoint identity differs')}
  if(r.state==='terminal'&&(!r.terminationCause||!r.finishedAt))throw Error('terminal run requires cause and finish')
  if(r.state==='running'&&!r.processIdentity)throw Error('running run requires a verified process')
  if(r.waitReason!==null&&r.waitReason!=='subscription-quota')throw Error('invalid wait reason')
  if(r.quotaWait!=null&&(!closed(r.quotaWait,['nextCheckAt','checks'])||!date(r.quotaWait.nextCheckAt)||!number(r.quotaWait.checks)))throw Error('invalid quota schedule')
  if(!plain(r.remoteEffectCoverage)||!['unmanaged-possible','qualified-managed-only','reconciled'].includes(r.remoteEffectCoverage.kind))throw Error('invalid effect coverage')
  if(r.remoteEffectCoverage.kind==='unmanaged-possible'){if(!closed(r.remoteEffectCoverage,['kind','reasonCode'])||!text(r.remoteEffectCoverage.reasonCode))throw Error('invalid unknown coverage')}
  else{const key=r.remoteEffectCoverage.kind==='reconciled'?'evidence':'qualification';if(!closed(r.remoteEffectCoverage,['kind',key]))throw Error('invalid coverage evidence');parseEvidenceRef((r.remoteEffectCoverage as unknown as Record<string,unknown>)[key])}
  if(r.authorityRequest!==undefined){if(r.authorityRequest.kind==='native'){if(!closed(r.authorityRequest,['kind']))throw Error('invalid native authority request')}else{const {kind,...request}=r.authorityRequest;if(kind!=='consolidated')throw Error('unknown authority request');validateApprovalRequest(request)}}
  if(r.handbackIntent!==undefined&&(!closed(r.handbackIntent,['id','approvalBindings'])||!text(r.handbackIntent.id)||!sameJson(r.handbackIntent.approvalBindings,r.approvalBindings)))throw Error('invalid handback intent')
  if(r.dispatchRequest!==undefined&&(!closed(r.dispatchRequest,['commentId','reactionId'])||Object.values(r.dispatchRequest).some(v=>!nullable(v,x=>number(x)&&x>0))))throw Error('invalid dispatch request')
  if(r.checkpointIntent!==undefined)validateCheckpointIntentShape(r.checkpointIntent)
  if(r.acceptedScopeRef!=null&&parseEvidenceRef(r.acceptedScopeRef).kind!=='state-receipt')throw Error('invalid accepted scope reference')
  if(r.stopReceiptIds!==undefined&&(!closed(r.stopReceiptIds,['receipt','transition'])||Object.values(r.stopReceiptIds).some(id=>!uuid.test(id))))throw Error('invalid stop operation identity')
  if(r.stopReceiptPayload!==undefined){const p=parseRecoveryPayload(r.stopReceiptPayload);if(!r.stopReceiptIds||p.kind!=='effect-reconciliation'||p.runId!==r.runId||p.scopeDigest!==r.taskKey.scopeDigest||!sameJson(p.approvalBindings,r.approvalBindings)||p.reasonCode!=='owned-process-group-stopped')throw Error('invalid saved stop receipt payload')}
  if(r.stopProof!==undefined&&r.stopProof!==null){parseStopProof(r.stopProof);if(!r.machine||r.stopProof.machineId!==r.machine.id||r.stopProof.installationId!==r.machine.installationId||!r.stopProof.runIds.includes(r.runId))throw Error('stop proof identity differs')}
  if(r.worktreeDigest!==undefined&&!nullable(r.worktreeDigest,digest))throw Error('invalid saved worktree digest')
  if(r.terminationRequest!=null&&(!closed(r.terminationRequest,['cause','at'])||!['timed-out','cancelled','interrupted','failed'].includes(r.terminationRequest.cause)||!date(r.terminationRequest.at)))throw Error('invalid termination request')
  if(r.cancelRequestedAt!==undefined&&!nullable(r.cancelRequestedAt,date))throw Error('invalid cancellation checkpoint')
  if(r.quotaChecks!==undefined&&!number(r.quotaChecks))throw Error('invalid quota check counter')
  if(r.attemptElapsedMs!==undefined&&!nullable(r.attemptElapsedMs,v=>typeof v==='number'&&Number.isFinite(v)&&v>=0))throw Error('invalid attempt elapsed checkpoint')
  if(r.approvedTaskIds!==undefined&&(!Array.isArray(r.approvedTaskIds)||!r.approvedTaskIds.length||new Set(r.approvedTaskIds).size!==r.approvedTaskIds.length||r.approvedTaskIds.some(id=>typeof id!=='string'||!/^(?:plan|[1-9]\d*-T[1-9]\d*)$/.test(id))))throw Error('invalid approved task selection')
  if(r.attemptOperationIds!==undefined&&(!closed(r.attemptOperationIds,['recovery','start','coverage'])||Object.values(r.attemptOperationIds).some(id=>!uuid.test(id))))throw Error('invalid attempt operation identity')
  if(r.claimOperationId!==undefined&&!uuid.test(r.claimOperationId))throw Error('invalid acquisition operation identity')
  if(r.runtimeBinding!==undefined)parseInstalledRuntimeBinding(r.runtimeBinding)
  if(r.configurationDigest!==undefined&&!digest(r.configurationDigest))throw Error('invalid execution configuration binding')
  if(r.vendorSessionId!==undefined&&!nullable(r.vendorSessionId,v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)))throw Error('invalid vendor session')
  if(r.attemptId!==undefined&&!uuid.test(r.attemptId))throw Error('invalid attempt identity')
  if(r.attempts!==undefined){if(!Array.isArray(r.attempts))throw Error('invalid attempt history');const ids=new Set<string>();for(const a of r.attempts){if(!plain(a)||['id','startedAt','finishedAt','processIdentity','processGroupId','terminationCause','exitCode','activeElapsedMs'].some(k=>!Object.hasOwn(a,k))||Object.keys(a).some(k=>!['id','startedAt','finishedAt','processIdentity','processGroupId','terminationCause','exitCode','activeElapsedMs','vendorSessionId','terminalSequence','snapshotDigest'].includes(k))||!uuid.test(a.id)||ids.has(a.id)||a.id===r.attemptId||!date(a.startedAt)||!nullable(a.finishedAt,date)||a.vendorSessionId!==undefined&&!nullable(a.vendorSessionId,v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v))||a.terminalSequence!==undefined&&a.terminalSequence!=='0'&&!uuid.test(a.terminalSequence)||a.snapshotDigest!==undefined&&!digest(a.snapshotDigest)||!causes.has(a.terminationCause)||!nullable(a.processIdentity,validRunProcess)||a.processGroupId!==(a.processIdentity?.pid??null)||!nullable(a.exitCode,v=>Number.isSafeInteger(v))||!nullable(a.activeElapsedMs,v=>typeof v==='number'&&Number.isFinite(v)&&v>=0))throw Error('invalid previous attempt');ids.add(a.id)}}
  if(r.terminalSegment!==undefined&&(!closed(r.terminalSegment,['sequence','firstAttemptId'])||!uuid.test(r.terminalSegment.sequence)||r.terminalSegment.sequence!==r.terminalSegment.firstAttemptId||![r.attemptId,...(r.attempts??[]).map(a=>a.id)].includes(r.terminalSegment.firstAttemptId)))throw Error('invalid terminal segment')
  if(r.continuations!==undefined){
    if(!Array.isArray(r.continuations))throw Error('invalid continuation history')
    const requests=new Set<string>(),attempts=new Set<string>()
    for(const c of r.continuations){if(!closed(c,['requestId','requestDigest','previousAttemptId','attemptId'])||![c.requestId,c.previousAttemptId,c.attemptId].every(id=>uuid.test(id))||!digest(c.requestDigest)||requests.has(c.requestId)||attempts.has(c.attemptId)||!r.attempts?.some(a=>a.id===c.previousAttemptId)||![r.attemptId,...(r.attempts??[]).map(a=>a.id)].includes(c.attemptId))throw Error('invalid continuation identity');requests.add(c.requestId);attempts.add(c.attemptId)}
  }
  if(r.remoteRecovery!==undefined){
    const p=r.remoteRecovery
    if(!closed(p,['kind','requestId','requestDigest','handoff','originalStateCommit','stopProof','originalTask','priorHistory','reportingContext'])||p.kind!=='receiving-home'||!uuid.test(p.requestId)||!digest(p.requestDigest)||!sha(p.originalStateCommit)||!closed(p.originalTask,['bytes','sha256'])||typeof p.originalTask.bytes!=='string'||!p.originalTask.bytes.length||Buffer.byteLength(p.originalTask.bytes)>256*1024||!digest(p.originalTask.sha256)||hashBytes(p.originalTask.bytes)!==p.originalTask.sha256||p.priorHistory!=='unavailable'||p.reportingContext!=='unavailable'||parseEvidenceRef(p.handoff).kind!=='state-receipt')throw Error('invalid receiving run provenance')
    parseStopProof(p.stopProof)
    if(r.activeElapsedMs!==null||!r.execution||!r.machine||!r.sharedClaim||!r.approvedTaskIds?.length||!r.terminalSegment)throw Error('receiving run history must remain unknown')
  }
  for(const p of r.pendingDelivery)validatePending(p,r)
  return structuredClone(r)
}

export async function createRun(input:RunInput):Promise<RunRecord> {
  if(Object.hasOwn(input,'remoteRecovery'))throw Error('receiving provenance requires verified constructor')
  const {root,runId=randomUUID(),...identity}=input
  requireId(runId)
  if(!isAbsolute(root))throw Error('run root must be absolute')
  const record=parseRun({...identity,claimOperationId:randomUUID(),attemptOperationIds:{recovery:randomUUID(),start:randomUUID(),coverage:randomUUID()},attemptElapsedMs:0,attemptId:randomUUID(),attempts:[],schemaVersion:2,runId,generation:1,state:'prepared',terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,finishedAt:null,pendingDelivery:[]})
  await mkdir(root,{recursive:true,mode:0o700})
  await privatePath(root,true)
  if((await lstat(dirname(root))).isSymbolicLink())throw Error('run root parent is a symlink')
  const dir=join(root,runId)
  const creation=await acquireClaim(join(root,runId+'.creation'),await processIdentity())
  if(creation.kind!=='owned')throw Error('run creation unavailable')
  try{await mkdir(dir,{mode:0o700});await atomicRunFile(join(dir,'run.json'),record)}finally{await releaseClaim(creation.claim)}
  roots.set(runId,root)
  return record
}

export async function readRun(root:string,runId:string):Promise<RunRecord>{requireId(runId);await privatePath(root,true);const dir=join(root,runId);await privatePath(dir,true);const path=join(dir,'run.json');await privatePath(path,false);const r=parseRun(parseStrictJson(await readPrivateRunFile(path)));if(r.runId!==runId)throw Error('run identity mismatch');roots.set(runId,root);return r}
export async function readRuns(root:string):Promise<RunRecord[]>{let names:string[];try{names=await readdir(root)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}const result:RunRecord[]=[];for(const id of names)if(uuid.test(id))result.push(await readRun(root,id));return result}
async function mutateRun(runId:string,expectedGeneration:number,root:string,change:(old:RunRecord)=>RunRecord|Promise<RunRecord>,replay?:(old:RunRecord)=>boolean):Promise<RunRecord>{
  requireId(runId)
  const lock=await acquireClaim(join(root,runId,'mutation'),await processIdentity())
  if(lock.kind!=='owned')throw Error('run mutation unavailable')
  try {
    const old=await readRun(root,runId)
    if(replay?.(old))return old
    if(old.generation!==expectedGeneration)throw Error('stale run generation')
    const next=parseRun({...await change(old),generation:old.generation+1})
    await atomicRunFile(join(root,runId,'run.json'),next)
    return next
  }finally{await releaseClaim(lock.claim)}
}
export async function transitionRun(runId:string,expectedGeneration:number,patch:RunPatch,root=roots.get(runId)??runsRoot()):Promise<RunRecord>{
  if(Object.keys(patch).some(k=>!patchKeys.has(k)))throw Error('immutable run identity')
  return mutateRun(runId,expectedGeneration,root,old=>{
    if(patch.activeElapsedMs!==undefined&&old.activeElapsedMs!==null&&patch.activeElapsedMs!==null&&patch.activeElapsedMs<old.activeElapsedMs)throw Error('active elapsed checkpoint decreased')
    if(old.state==='terminal')for(const field of ['state','terminationCause','exitCode','finishedAt'] as const)if(patch[field]!==undefined&&!sameJson(patch[field],old[field]))throw Error('terminal attempt is immutable')
    if(old.terminationRequest&&['timed-out','cancelled'].includes(old.terminationRequest.cause)&&patch.terminationRequest!==undefined&&!sameJson(patch.terminationRequest,old.terminationRequest))throw Error('terminal request cause is immutable')
    if(old.cancelRequestedAt&&patch.cancelRequestedAt!==undefined&&patch.cancelRequestedAt!==old.cancelRequestedAt)throw Error('recorded cancellation is immutable')
    if(old.vendorSessionId&&patch.vendorSessionId!==undefined&&patch.vendorSessionId!==old.vendorSessionId)throw Error('vendor session identity changed')
    if(old.processIdentity)for(const field of ['pid','processStartId','processGroupId','processIdentity'] as const)if(patch[field]!==undefined&&!sameJson(patch[field],old[field]))throw Error('acknowledged process identity is immutable')
    if(old.sharedClaim&&patch.sharedClaim&&['taskKey','generation','ownerToken'].some(key=>old.sharedClaim![key as keyof typeof old.sharedClaim]!==patch.sharedClaim![key as keyof typeof patch.sharedClaim]))throw Error('shared owner cannot change through lifecycle update')
    if(patch.pendingDelivery)for(const previous of old.pendingDelivery.filter(p=>p.kind==='telemetry-capture')){
      const next=patch.pendingDelivery.find(p=>p.id===previous.id)
      if(!next||next.kind!==previous.kind||!sameJson(next.target,previous.target)||previous.payload!==undefined&&next.payload!==previous.payload||previous.payloadDigest!==undefined&&next.payloadDigest!==previous.payloadDigest)throw Error('terminal capture is immutable')
    }
    return{...old,...patch}
  })
}
export const runAttemptDirectory=(root:string,run:RunRecord)=>join(root,run.runId,'attempts',run.attemptId??run.runId)
export async function prepareRunAttemptDirectory(root:string,run:RunRecord):Promise<string>{
  const parent=join(root,run.runId,'attempts')
  await privatePath(join(root,run.runId),true)
  await mkdir(parent,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error})
  await privatePath(parent,true)
  const directory=runAttemptDirectory(root,run)
  await mkdir(directory,{mode:0o700}) // Exclusive: a second launcher cannot acknowledge the same attempt.
  const fd=await open(parent,'r');try{await fd.sync()}finally{await fd.close()}
  return directory
}
export async function beginRunAttempt(root:string,runId:string,expectedGeneration:number):Promise<RunRecord>{
  return mutateRun(runId,expectedGeneration,root,async old=>{
    if(old.cancelRequestedAt||old.state!=='terminal'||!old.finishedAt||!old.terminationCause||old.terminationCause==='termination-unconfirmed'||old.waitReason!=='subscription-quota')throw Error('attempt requires a stopped quota checkpoint')
    if(old.processIdentity){const {inspectOwnedGroup}=await import('./run-wrapper.ts');if((await inspectOwnedGroup(old.processIdentity)).kind!=='absent')throw Error('previous owned process group is not verified absent')}
    if(!old.processIdentity){try{await lstat(runAttemptDirectory(root,old));throw Error('prior launch handshake is unresolved')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
    if(old.worktreeDigest&&await worktreeFingerprint(old.checkout)!==old.worktreeDigest)throw Error('saved checkout changed; verified handover required')
    const previous:RunAttempt={id:old.attemptId??old.runId,startedAt:old.startedAt,finishedAt:old.finishedAt,processIdentity:old.processIdentity,processGroupId:old.processGroupId,terminationCause:old.terminationCause,exitCode:old.exitCode,activeElapsedMs:old.attemptElapsedMs??old.activeElapsedMs}
    return{...old,attemptId:randomUUID(),attemptOperationIds:{recovery:randomUUID(),start:randomUUID(),coverage:randomUUID()},attempts:[...(old.attempts??[]),previous],state:'prepared',terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,startedAt:new Date().toISOString(),finishedAt:null,attemptElapsedMs:0,terminationRequest:null,waitReason:null,quotaWait:null}
  })
}

export interface RunContinuationRequest {
  root:string;runId:string;expectedGeneration:number;requestId:string;previousAttemptId:string
  checkpoint:CheckpointRef;worktreeDigest:string
  currentOwner:{machine:RunRecord['machine'];sharedClaim:RunRecord['sharedClaim']}
}
export interface RecoveryContinuationDecision {
  action:'resume-task';reason:string;runId:string;expectedGeneration:number;previousAttemptId:string
  taskIds:string[];approvedTaskIds:string[];approvalBindings:RunRecord['approvalBindings'];recordBinding:RunRecord['recordBinding']
  artifacts:RunRecord['approvalRefs'];execution:NonNullable<RunRecord['execution']>;checkpoint:CheckpointRef;worktreeDigest:string
  currentOwner:RunContinuationRequest['currentOwner'];sourceRefs:Array<{id:string;updatedAt:string;bodySha256:string}>
}
export interface RunContinuationController {
  // Controller-owned code performs fresh authority, completed-work, qualification and
  // shared-owner reconciliation. It is never loaded from the persisted request.
  verifyRecovery:(input:{run:RunRecord;request:RunContinuationRequest})=>Promise<RecoveryContinuationDecision>
}
async function saveContinuationSnapshot(root:string,run:RunRecord):Promise<string>{
  const {sha256}=await import('./shared-claims.ts'),directory=join(root,run.runId,'history')
  await mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error})
  await privatePath(directory,true)
  const bytes=await readPrivateRunFile(join(root,run.runId,'run.json')),snapshotDigest=sha256(bytes),path=join(directory,(run.attemptId??run.runId)+'.'+snapshotDigest+'.json')
  // The run mutation guard serializes this immutable publication. Atomic rename
  // avoids leaving a partial snapshot that would poison a retry after disk failure.
  try{if(await readPrivateRunFile(path)!==bytes)throw Error('original attempt snapshot differs')}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await atomicRunFile(path,parseStrictJson(bytes))}
  const dir=await open(directory,'r');try{await dir.sync()}finally{await dir.close()}
  return snapshotDigest
}
export async function readRunAttemptSnapshot(root:string,runId:string,attempt:RunAttempt):Promise<RunRecord>{
  requireId(runId);requireId(attempt.id)
  if(!attempt.snapshotDigest)throw Error('original private attempt snapshot unavailable')
  const bytes=await readPrivateRunFile(join(root,runId,'history',attempt.id+'.'+attempt.snapshotDigest+'.json')),{sha256}=await import('./shared-claims.ts')
  if(sha256(bytes)!==attempt.snapshotDigest)throw Error('original private attempt snapshot changed')
  const snapshot=parseRun(parseStrictJson(bytes))
  if(snapshot.runId!==runId||(snapshot.attemptId??snapshot.runId)!==attempt.id)throw Error('original private attempt identity differs')
  return snapshot
}
export async function beginVerifiedRunContinuation(request:RunContinuationRequest,controller:RunContinuationController):Promise<RunRecord>{
  request=structuredClone(request)
  const {root,runId,expectedGeneration,requestId,previousAttemptId}=request,{sha256}=await import('./shared-claims.ts')
  if(!isAbsolute(root)||!number(expectedGeneration)||expectedGeneration<1||!uuid.test(requestId)||!uuid.test(previousAttemptId)||!digest(request.worktreeDigest)||typeof controller?.verifyRecovery!=='function')throw Error('verified continuation request unavailable')
  parseCheckpointRef(request.checkpoint)
  const requestDigest=sha256(canonicalWire(request))
  return mutateRun(runId,expectedGeneration,root,async old=>{
    if((old.attemptId??old.runId)!==previousAttemptId||!['terminal','interrupted'].includes(old.state)||!old.terminationCause||old.terminationCause==='termination-unconfirmed'||old.cancelRequestedAt||old.waitReason==='subscription-quota')throw Error('continuation requires the original stopped attempt')
    if(!old.execution||!old.approvedTaskIds?.length||!old.approvalBindings.length||!old.machine||!old.sharedClaim||!request.currentOwner.machine||!request.currentOwner.sharedClaim)throw Error('continuation original authority/owner unavailable')
    if(!sameJson(old.checkpoint,request.checkpoint)||old.worktreeDigest!==request.worktreeDigest||request.checkpoint.runId!==runId||request.checkpoint.repo!==old.repo||request.checkpoint.branch!==old.branch||request.checkpoint.baseSha!==old.baseSha||request.checkpoint.headSha!==old.headSha||request.checkpoint.scopeDigest!==old.taskKey.scopeDigest)throw Error('continuation source checkpoint differs')
    if(request.currentOwner.sharedClaim.taskKey!==old.sharedClaim.taskKey||request.currentOwner.sharedClaim.generation<old.sharedClaim.generation||request.currentOwner.sharedClaim.generation===old.sharedClaim.generation&&(!sameJson(request.currentOwner.machine,old.machine)||request.currentOwner.sharedClaim.ownerToken!==old.sharedClaim.ownerToken))throw Error('continuation owner generation differs')
    // This operation consumes an existing private same-home record. Remote-only
    // reconstruction must not turn foreign PIDs or missing history into local proof.
    if(!await verifyLocalRunStopped(old))throw Error('original owned process stop unavailable')
    const {readHostBinding}=await import('./machine-identity.ts')
    if(request.currentOwner.machine.hostBindingDigest!==(await readHostBinding()).digest)throw Error('continuation target host differs')
    const decision=await controller.verifyRecovery({run:structuredClone(old),request:structuredClone(request)})
    if(!decision||decision.action!=='resume-task'||!text(decision.reason)||decision.runId!==runId||decision.expectedGeneration!==expectedGeneration||decision.previousAttemptId!==previousAttemptId||!sameJson(decision.approvedTaskIds,old.approvedTaskIds)||!sameJson(decision.approvalBindings,old.approvalBindings)||!sameJson(decision.recordBinding,old.recordBinding)||!sameJson(decision.artifacts,old.approvalRefs)||!sameJson(decision.execution,old.execution)||!sameJson(decision.checkpoint,request.checkpoint)||decision.worktreeDigest!==request.worktreeDigest||!sameJson(decision.currentOwner,request.currentOwner)||!Array.isArray(decision.taskIds)||!decision.taskIds.length||new Set(decision.taskIds).size!==decision.taskIds.length||decision.taskIds.some(id=>!old.approvedTaskIds!.includes(id))||!Array.isArray(decision.sourceRefs)||!decision.sourceRefs.length||decision.sourceRefs.some(ref=>!closed(ref,['id','updatedAt','bodySha256'])||!text(ref.id)||!date(ref.updatedAt)||!digest(ref.bodySha256)))throw Error('verified recovery decision differs')
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),execute=promisify(execFile)
    const git=async(args:string[])=>(await execute('git',args,{cwd:old.checkout,encoding:'utf8',timeout:5000,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim()
    const [head,tree,branch,fingerprint]=await Promise.all([git(['rev-parse','HEAD']),git(['rev-parse','HEAD^{tree}']),git(['symbolic-ref','--short','HEAD']),worktreeFingerprint(old.checkout)])
    if(head!==request.checkpoint.headSha||tree!==request.checkpoint.treeSha||branch!==old.branch||fingerprint!==request.worktreeDigest)throw Error('continuation checkout changed')
    // Read stop again after controller I/O before preserving and resetting the attempt.
    if(!await verifyLocalRunStopped(old))throw Error('original owned process stop changed')
    const attemptId=randomUUID(),snapshotDigest=await saveContinuationSnapshot(root,old)
    const previous:RunAttempt={id:previousAttemptId,startedAt:old.startedAt,finishedAt:old.finishedAt,processIdentity:old.processIdentity,processGroupId:old.processGroupId,terminationCause:old.terminationCause,exitCode:old.exitCode,activeElapsedMs:old.attemptElapsedMs??null,vendorSessionId:old.vendorSessionId??null,terminalSequence:terminalCaptureDescriptor(old).sequence,snapshotDigest}
    const next={...old,...request.currentOwner,hostBindingDigest:request.currentOwner.machine.hostBindingDigest,attemptId,attemptOperationIds:{recovery:randomUUID(),start:randomUUID(),coverage:randomUUID()},attempts:[...(old.attempts??[]),previous],continuations:[...(old.continuations??[]),{requestId,requestDigest,previousAttemptId,attemptId}],terminalSegment:{sequence:attemptId,firstAttemptId:attemptId},state:'prepared' as const,terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,startedAt:new Date().toISOString(),finishedAt:null,attemptElapsedMs:0,terminationRequest:null,cancelRequestedAt:null,waitReason:null,quotaWait:null,vendorSessionId:null,stopProof:null,acceptedScopeRef:null}
    delete next.stopReceiptIds;delete next.stopReceiptPayload
    return next
  },old=>{
    const existing=old.continuations?.find(c=>c.requestId===requestId)
    if(!existing)return false
    if(existing.requestDigest!==requestDigest)throw Error('continuation request identity rebound')
    if(existing.attemptId!==old.attemptId)throw Error('continuation attempt already advanced')
    return true // A replay supplies no launch authority; normal admission still runs.
  })
}

// Receiving-home recovery has no original local PID, private attempts or outbox.
// #144 supplies executable current authority/qualification/stop/handoff verification;
// it must use #137's actual pinned readers, never load a verifier from saved data.
export interface ReceivingRunRequest {
  root:string;requestId:string;runId:string;taskKey:string;expectedSharedGeneration:number;checkout:string
  handoff:Extract<EvidenceRef,{kind:'state-receipt'}>
}
export interface VerifiedReceivingRunDecision {
  action:'resume-task';reason:string
  original:{stateCommit:string;task:TaskRecord};current:{stateCommit:string;task:TaskRecord}
  handoff:{ref:Extract<EvidenceRef,{kind:'state-receipt'}>;receipt:OperationReceipt}
  artifacts:ArtifactRef[];authorityRequest:RunAuthorityRequest;taskIds:string[]
  sourceRefs:Array<{id:string;updatedAt:string;bodySha256:string}>
  receiver:{machine:NonNullable<RunRecord['machine']>;claimToken:string;policyDigest:string;runtimeBinding:InstalledRuntimeBinding;configurationDigest:string;worktreeDigest:string}
}
export interface ReceivingRunController {
  verifyRecovery:(request:ReceivingRunRequest)=>Promise<VerifiedReceivingRunDecision>
}
export function runReportingHold(run:RunRecord):'original-reporting-context-unavailable'|null {
  return run.remoteRecovery?'original-reporting-context-unavailable':null
}
export function priorRunElapsedMs(run:RunRecord):number|null {
  if(run.remoteRecovery||(run.attempts??[]).some(attempt=>attempt.activeElapsedMs===null))return null
  return (run.attempts??[]).reduce((total,attempt)=>total+attempt.activeElapsedMs!,0)
}
function receivingFacts(request:ReceivingRunRequest,decision:VerifiedReceivingRunDecision) {
  if(!decision||decision.action!=='resume-task'||!text(decision.reason)||!decision.original||!decision.current||!decision.handoff||!decision.receiver)throw Error('verified receiving recovery unavailable')
  const {original,current,receiver}=decision,old=original.task,next=current.task,receipt=decision.handoff.receipt
  if(!old||!next||!receipt||!sha(original.stateCommit)||!sha(current.stateCommit)||!sameJson(request.handoff,decision.handoff.ref)||receipt.schemaVersion!==1||receipt.type!=='handoff'||receipt.recoveryPayload!==null||hashBytes(canonicalWire(receipt))!==request.handoff.blobSha256||receipt.operationId!==request.handoff.operationId||receipt.taskKey!==request.taskKey||receipt.previousHead!==original.stateCommit||!digest(receipt.requestDigest)||receipt.generation!==request.expectedSharedGeneration)throw Error('receiving handoff receipt differs')
  if(old.runId!==request.runId||next.runId!==request.runId||old.taskKey!==request.taskKey||next.taskKey!==request.taskKey||next.generation!==request.expectedSharedGeneration||old.generation+1!==next.generation||old.state==='completed'||next.state!=='claimed'||old.parentTaskKey!==null||next.parentTaskKey!==null||old.parentBinding!=null||next.parentBinding!=null)throw Error('receiving standalone owner generation differs')
  for(const key of ['host','repo','issue','repositoryNodeId','issueNodeId','scopeDigest','approvalDigest','approvalBindings','stage','approvedTaskIds','paths','resources','independent','acceptedScopes'] as const)if(!sameJson(old[key],next[key]))throw Error('receiving original task scope differs')
  const owner={ownerToken:next.ownerToken,machineId:next.machineId,installationId:next.installationId,sessionId:next.sessionId,runId:next.runId}
  if(!sameJson(receipt.resultOwner,owner)||!uuid.test(next.ownerToken)||next.ownerToken===old.ownerToken||receiver.machine.id!==next.machineId||receiver.machine.installationId!==next.installationId||receiver.machine.sessionId!==next.sessionId||!uuid.test(receiver.claimToken)||!digest(receiver.policyDigest)||!digest(receiver.configurationDigest)||!digest(receiver.worktreeDigest))throw Error('receiving current owner/setup differs')
  // Handoff retains the verified stop in its result. A reboot receipt need not
  // already have existed in the lost owner's predecessor task record.
  const stop=parseStopProof(next.stopProof)
  if(stop.machineId!==old.machineId||stop.installationId!==old.installationId||stop.sessionId!==old.sessionId||stop.generation!==old.generation||!stop.runIds.includes(old.runId))throw Error('receiving original stop proof differs')
  const envelope=parseRecoveryEnvelope(old.recovery),currentEnvelope=parseRecoveryEnvelope(next.recovery),checkpoint=parseCheckpointRef(old.checkpoint)
  if(envelope.taskKey!==old.taskKey||envelope.runId!==old.runId||envelope.generation!==old.generation||envelope.scopeDigest!==old.scopeDigest||envelope.approvalDigest!==old.approvalDigest||!sameJson(envelope.approvalBindings,old.approvalBindings)||!sameJson(currentEnvelope,{...envelope,generation:next.generation})||!sameJson(checkpoint,envelope.checkpoint)||!sameJson(checkpoint,next.checkpoint)||checkpoint.runId!==old.runId||checkpoint.repo!==old.repo||checkpoint.repositoryId!==old.repositoryNodeId||checkpoint.scopeDigest!==old.scopeDigest)throw Error('receiving original checkpoint/effects differ')
  if(envelope.remoteEffectCoverage.kind==='unmanaged-possible'||envelope.effects.some(effect=>(effect.kind!=='telemetry-push'||effect.target.kind!=='telemetry')&&['prepared','ambiguous'].includes(effect.state)))throw Error('receiving unresolved code/control effects')
  if(!Array.isArray(old.approvedTaskIds)||!old.approvedTaskIds.length||new Set(old.approvedTaskIds).size!==old.approvedTaskIds.length||!Array.isArray(decision.taskIds)||!decision.taskIds.length||new Set(decision.taskIds).size!==decision.taskIds.length||decision.taskIds.some(id=>!old.approvedTaskIds.includes(id)||envelope.completed.some(done=>done.taskId===id)))throw Error('receiving outstanding task selection differs')
  if(!Array.isArray(decision.artifacts)||!decision.artifacts.length||hashBytes(canonicalWire({artifacts:decision.artifacts,taskIds:old.approvedTaskIds}))!==old.scopeDigest)throw Error('receiving approved artifact scope differs')
  if(!Array.isArray(decision.sourceRefs)||!decision.sourceRefs.length||decision.sourceRefs.some(ref=>!closed(ref,['id','updatedAt','bodySha256'])||!text(ref.id)||!date(ref.updatedAt)||!digest(ref.bodySha256)))throw Error('receiving fresh source evidence unavailable')
  if(!decision.authorityRequest||!['native','consolidated'].includes(decision.authorityRequest.kind))throw Error('receiving launch authority unavailable')
  parseInstalledRuntimeBinding(receiver.runtimeBinding)
  if(!validExecution(envelope.execution))throw Error('receiving original execution unavailable')
  const bytes=canonicalWire(old)
  if(Buffer.byteLength(bytes)>256*1024)throw Error('receiving original provenance exceeds bound')
  // Exclude moving current read-head/source timestamps, never immutable authority,
  // handoff, receiver setup, local claim, checkpoint or outstanding task selection.
  const requestDigest=hashBytes(canonicalWire({request,originalStateCommit:original.stateCommit,originalTaskDigest:hashBytes(bytes),stopProof:stop,owner,receiver,artifacts:decision.artifacts,authorityRequest:decision.authorityRequest,taskIds:decision.taskIds,sourceRefs:decision.sourceRefs.map(({id,bodySha256})=>({id,bodySha256}))}))
  return{old,next,envelope,checkpoint,bytes,requestDigest}
}
async function verifyReceivingCheckout(request:ReceivingRunRequest,decision:VerifiedReceivingRunDecision):Promise<void>{
  const {readHostBinding}=await import('./machine-identity.ts')
  if(decision.receiver.machine.hostBindingDigest!==(await readHostBinding()).digest)throw Error('receiving target host differs')
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),execute=promisify(execFile)
  const git=async(args:string[])=>(await execute('git',args,{cwd:request.checkout,encoding:'utf8',timeout:5000,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim()
  const checkpoint=decision.current.task.checkpoint!
  const [head,tree,branch,fingerprint]=await Promise.all([git(['rev-parse','HEAD']),git(['rev-parse','HEAD^{tree}']),git(['symbolic-ref','--short','HEAD']),worktreeFingerprint(request.checkout)])
  if(head!==checkpoint.headSha||tree!==checkpoint.treeSha||branch!==checkpoint.branch||fingerprint!==decision.receiver.worktreeDigest)throw Error('receiving checkout changed')
}
export async function createVerifiedReceivingRun(request:ReceivingRunRequest,controller:ReceivingRunController):Promise<RunRecord>{
  if(!closed(request,['root','requestId','runId','taskKey','expectedSharedGeneration','checkout','handoff'])||!isAbsolute(request.root)||!isAbsolute(request.checkout)||!uuid.test(request.requestId)||!uuid.test(request.runId)||!digest(request.taskKey)||!number(request.expectedSharedGeneration)||request.expectedSharedGeneration<2||parseEvidenceRef(request.handoff).kind!=='state-receipt'||!controller||typeof controller.verifyRecovery!=='function')throw Error('receiving request unavailable')
  // Clone callback boundaries: its caller must not change an admitted request/decision.
  request=structuredClone(request)
  await mkdir(request.root,{recursive:true,mode:0o700});await privatePath(request.root,true)
  if((await lstat(dirname(request.root))).isSymbolicLink())throw Error('run root parent is a symlink')
  const lock=await acquireClaim(join(request.root,request.runId+'.creation'),await processIdentity())
  if(lock.kind!=='owned')throw Error('receiving run creation unavailable')
  try{
    const decision=structuredClone(await controller.verifyRecovery(structuredClone(request))),facts=receivingFacts(request,decision)
    await verifyReceivingCheckout(request,decision)
    const fresh=structuredClone(await controller.verifyRecovery(structuredClone(request))),verified=receivingFacts(request,fresh)
    if(verified.requestDigest!==facts.requestDigest)throw Error('receiving authority/setup changed during verification')
    await verifyReceivingCheckout(request,fresh)
    const {old,next,envelope,checkpoint,bytes,requestDigest}=verified,receiver=fresh.receiver
    const identity={
      runId:request.runId,repo:old.repo,issue:old.issue,parent:null,checkout:request.checkout,
      branch:checkpoint.branch,baseSha:checkpoint.baseSha,headSha:checkpoint.headSha,stage:old.stage,
      harness:envelope.execution.harness,model:envelope.execution.model,effort:envelope.execution.effort,
      execution:envelope.execution,approvalBindings:old.approvalBindings,recordBinding:envelope.recordBinding,
      approvalRefs:fresh.artifacts,authorityRequest:fresh.authorityRequest,policyDigest:receiver.policyDigest,
      claimToken:receiver.claimToken,taskKey:{repo:old.repo,issue:old.issue,taskId:old.approvedTaskIds.length===1?old.approvedTaskIds[0]:'whole-issue',scopeDigest:old.scopeDigest},
      approvedTaskIds:old.approvedTaskIds,accountRef:envelope.execution.accountRef,machine:receiver.machine,
      hostBindingDigest:receiver.machine.hostBindingDigest,checkpoint,runtimeBinding:receiver.runtimeBinding,
      configurationDigest:receiver.configurationDigest,worktreeDigest:receiver.worktreeDigest,
    }
    let existing=false
    try{await lstat(join(request.root,request.runId));existing=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    // An existing incomplete or invalid directory is evidence to reconcile, not
    // permission to replace private state left by another creator or a crash.
    const saved=existing?await readRun(request.root,request.runId):null
    if(saved){
      if(saved.remoteRecovery?.requestId!==request.requestId||saved.remoteRecovery.requestDigest!==verified.requestDigest)throw Error('receiving request identity rebound')
      if(Object.entries(identity).some(([key,value])=>!sameJson(saved[key as keyof RunRecord],value))||saved.remoteRecovery.originalStateCommit!==fresh.original.stateCommit||saved.remoteRecovery.originalTask.bytes!==bytes||!sameJson(saved.remoteRecovery.stopProof,next.stopProof))throw Error('receiving saved identity differs')
      if(saved.state!=='prepared'||saved.pid!==null||saved.attemptId!==saved.terminalSegment?.firstAttemptId||saved.attempts?.length||saved.sharedClaim?.generation!==verified.next.generation||saved.sharedClaim.ownerToken!==verified.next.ownerToken)throw Error('receiving allocation already advanced')
      try{await lstat(runAttemptDirectory(request.root,saved));throw Error('receiving wrapper already prepared')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      return saved // Fresh verification still does not authorize a vendor spawn.
    }
    const attemptId=randomUUID()
    const run=parseRun({
      ...identity,schemaVersion:2,generation:1,state:'prepared',terminationCause:null,exitCode:null,
      pid:null,processStartId:null,processGroupId:null,processIdentity:null,startedAt:new Date().toISOString(),
      finishedAt:null,pendingDelivery:[],activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,waitReason:null,
      sharedClaim:{taskKey:next.taskKey,generation:next.generation,ownerToken:next.ownerToken,stateCommit:fresh.current.stateCommit},
      remoteEffectCoverage:envelope.remoteEffectCoverage,attemptId,attempts:[],attemptElapsedMs:0,
      attemptOperationIds:{recovery:randomUUID(),start:randomUUID(),coverage:randomUUID()},
      terminalSegment:{sequence:attemptId,firstAttemptId:attemptId},vendorSessionId:null,stopProof:null,
      remoteRecovery:{kind:'receiving-home',requestId:request.requestId,requestDigest,handoff:request.handoff,
        originalStateCommit:fresh.original.stateCommit,stopProof:next.stopProof,originalTask:{bytes,sha256:hashBytes(bytes)},
        priorHistory:'unavailable',reportingContext:'unavailable'},
    })
    const staging=join(request.root,'.receiving-'+randomUUID())
    await mkdir(staging,{mode:0o700})
    try{
      await atomicRunFile(join(staging,'run.json'),run)
      // Both constructors hold the same guard. Publish the complete private
      // directory atomically: a crash never exposes an empty receiving run.
      await rename(staging,join(request.root,run.runId))
      for(const directory of [join(request.root,run.runId),request.root]){const handle=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await handle.sync()}finally{await handle.close()}}
    }finally{await rm(staging,{recursive:true,force:true})}
    roots.set(run.runId,request.root)
    return run
  }finally{await releaseClaim(lock.claim)}
}

export function classifyRecovery(input:{state:RunRecord['state'];ownerAlive:boolean;pendingDelivery:unknown[]}):{state:RunRecord['state'];replay:false}{return{state:!input.ownerAlive&&['prepared','running'].includes(input.state)?'interrupted':input.state,replay:false}}
export async function reconcileRuns(root:string):Promise<RunRecord[]>{
  const result:RunRecord[]=[]
  for(let run of await readRuns(root)){
    if(!['prepared','running','interrupted'].includes(run.state)&&run.terminationCause!=='termination-unconfirmed'){result.push(run);continue}
    const directory=runAttemptDirectory(root,run)
    let handshake:import('./run-wrapper.ts').WrapperHandshake|null=null,terminal:import('./run-wrapper.ts').WrapperResult|null=null,invalid=false,attemptExists=false
    try{await privatePath(directory,true);attemptExists=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')invalid=true}
    if(attemptExists){
      try{const h=parseStrictJson(await readPrivateRunFile(join(directory,'handshake.json'),16384));if(!closed(h,['schemaVersion','runId','attemptId','identity','pgid'])||h.schemaVersion!==1||h.runId!==run.runId||h.attemptId!==(run.attemptId??run.runId)||!validRunProcess(h.identity)||h.pgid!==h.identity.pid)throw Error('invalid handshake');handshake=h}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')invalid=true}
      try{const t=parseStrictJson(await readPrivateRunFile(join(directory,'result.json'),16384));if(!closed(t,['schemaVersion','runId','attemptId','exitCode','cause','finishedAt'])||t.schemaVersion!==1||t.runId!==run.runId||t.attemptId!==(run.attemptId??run.runId)||!['succeeded','failed','spawn-failed','interrupted'].includes(t.cause)||!nullable(t.exitCode,v=>Number.isSafeInteger(v))||!date(t.finishedAt))throw Error('invalid terminal handshake');terminal=t}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')invalid=true}
    }
    if(handshake&&run.processIdentity&&!sameJson(handshake.identity,run.processIdentity))invalid=true
    if(!invalid&&handshake&&!run.processIdentity&&run.state==='prepared')run=await updateRun(root,run.runId,()=>({pid:handshake!.identity.pid,processStartId:handshake!.identity.startId,processGroupId:handshake!.pgid,processIdentity:handshake!.identity}))
    if(!run.processIdentity&&!attemptExists&&!invalid){result.push(run);continue} // Durable preparation proves no wrapper was launched.
    let stopped=false
    if(!invalid)try{stopped=await verifyLocalRunStopped(run)}catch{}
    if(stopped){
      const cause:TerminalCause=run.terminationRequest?.cause??terminal?.cause??'interrupted'
      run=await mutateRun(run.runId,run.generation,root,old=>({...old,state:terminal?'terminal':'interrupted',terminationCause:cause,exitCode:terminal?.exitCode??null,finishedAt:terminal?.finishedAt??null,activeElapsedMs:terminal?.cause==='spawn-failed'?priorRunElapsedMs(old):null,attemptElapsedMs:terminal?.cause==='spawn-failed'?0:null}))
    }else{
      const observation=!invalid&&run.processIdentity?await(await import('./run-wrapper.ts')).inspectOwnedGroup(run.processIdentity):null
      if(invalid||observation?.kind==='foreign'||observation?.kind==='unknown'||!run.processIdentity)run=await mutateRun(run.runId,run.generation,root,old=>({...old,state:'interrupted',terminationCause:'termination-unconfirmed',activeElapsedMs:null,attemptElapsedMs:null}))
    }
    result.push(run)
  }
  return result
}

export function nextQuotaCheck(attempt:number,now:number,providerRetryAt?:number):number{return providerRetryAt&&providerRetryAt>now?providerRetryAt:now+Math.min(60,15*2**Math.min(attempt,2))*60_000}

// Source provenance comes from the owner evaluator's actual read set, never a caller locator.
export async function bindVerifiedApprovalSources(tuples:Array<{approvalId:string;commentId:number;bodySha256:string}>, reads:unknown[], gh:(args:string[])=>Promise<unknown>, rawGh?:(args:string[],options?:import('./gh.ts').GhOptions)=>Promise<string>):Promise<ApprovalAuthorityRef[]> {
  const {createHash}=await import('node:crypto')
  const {fetchGhPages}=await import('./gh.ts')
  const comments=reads.flat(Infinity).filter((value):value is Record<string,unknown>=>!!value&&typeof value==='object')
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
    const earlier=new Map(comments.filter(c=>c.issue_url===source.issue_url&&typeof c.id==='number'&&typeof c.body==='string').map(c=>[c.id,c.body]))
    if(history.items.some(c=>earlier.get(c.id)!==c.body)||earlier.size!==history.items.length)throw Error('approval history changed after evaluation')
    const repository=await gh(['api',`repos/${sourceRepo}`]) as {node_id:string}
    const subject=await gh(['api',`repos/${sourceRepo}/issues/${issue}`]) as {node_id:string}
    const ref:ApprovalAuthorityRef={approvalId:tuple.approvalId,source:{kind:'github-comment',repositoryId:repository.node_id,issueNodeId:subject.node_id,commentId:String(tuple.commentId),bodySha256:tuple.bodySha256}}
    validateAuthority(ref);refs.push(ref)
  }
  return refs
}

export interface RunStatusController {
  gh:(args:string[],options?:import('./gh.ts').GhOptions)=>Promise<string>
  senderLogin:string
  verifyAuthority:(run:RunRecord,intentRef:string)=>Promise<void>
  beforeSend?:(run:RunRecord,delivery:PendingDelivery,payload:string)=>Promise<void>
  afterReadback?:(run:RunRecord,delivery:PendingDelivery,commentId:number,payload:string)=>Promise<void>
  wait?:(ms:number)=>Promise<void>
}
export async function deliverRunStatus(input:{root:string;runId:string;intentRef:string;approvalBindings:ApprovalAuthorityRef[]},controller:RunStatusController):Promise<RunRecord>{
  return withRunDelivery(input.root,input.runId,async()=>{
    const {fetchGhPages}=await import('./gh.ts'),{sha256}=await import('./shared-claims.ts')
    let run=await readRun(input.root,input.runId)
    if(!input.intentRef||!text(controller.senderLogin)||!input.approvalBindings.length||!sameJson(input.approvalBindings,run.approvalBindings))throw Error('handback authority unavailable')
    await controller.verifyAuthority(run,input.intentRef)
    let delivery=run.pendingDelivery.find(p=>p.kind==='handback'&&p.intentRef===input.intentRef)
    if(!delivery){const id=randomUUID(),marker=`<!-- vsk:delivery:${id} -->`,payload=`${marker}\nExecution requires attention: ${run.terminationCause??'interrupted'}. Saved work is preserved.\n`;delivery={id,kind:'handback',target:{repo:run.repo,issue:run.issue,commentId:null},intentRef:input.intentRef,status:'pending',attempts:0,lastError:null,payload,payloadDigest:sha256(payload),approvalBindings:run.approvalBindings};const prepared=delivery;run=await updateRun(input.root,run.runId,r=>({pendingDelivery:[...r.pendingDelivery,prepared]}))}
    if(delivery.status==='acknowledged')return run
    const id=delivery.id,marker=`<!-- vsk:delivery:${id} -->`,payload=delivery.payload
    if(!payload||delivery.payloadDigest!==sha256(payload))throw Error('handback original payload unavailable')
    const persist=async(patch:Partial<PendingDelivery>)=>{run=await updateRun(input.root,run.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===id?{...p,...patch}:p)}));delivery=run.pendingDelivery.find(p=>p.id===id)!}
    const comments=async()=>{const page=await fetchGhPages<{id:number;body:string;user:{login:string}}>(controller.gh,`repos/${run.repo}/issues/${run.issue}/comments`);if(!page.complete)throw Error('handback-read-incomplete');return page.items.filter(c=>typeof c.body==='string'&&c.body.startsWith(marker+'\n')&&c.user?.login===controller.senderLogin)}
    const acknowledge=async(comment:{id:number;body:string})=>{
      if(comment.body!==payload)throw Error('handback-payload-differs')
      if(run.sharedClaim&&!controller.afterReadback)throw Error('handback-shared-outcome-unavailable')
      await controller.afterReadback?.(run,delivery!,comment.id,payload)
      await persist({status:'acknowledged',target:{repo:run.repo,issue:run.issue,commentId:comment.id},lastError:null})
    }
    try{
      const found=await comments();if(found.length>1)throw Error('handback-marker-ambiguous')
      if(found[0]?.body===payload){await acknowledge(found[0]);return run}
      if(delivery.status==='ambiguous')throw Error('handback-create-unconfirmed')
      const existing=found[0]?.id??null
      if(existing!==null)await persist({target:{repo:run.repo,issue:run.issue,commentId:existing}})
      if(run.sharedClaim&&!controller.beforeSend)throw Error('handback-shared-intent-unavailable')
      await controller.beforeSend?.(run,delivery,payload)
      await controller.verifyAuthority(run,input.intentRef)
      await persist({status:'ambiguous',attempts:delivery.attempts+1})
      const endpoint=existing===null?`repos/${run.repo}/issues/${run.issue}/comments`:`repos/${run.repo}/issues/comments/${existing}`
      try{await controller.gh(['api',endpoint,'--method',existing===null?'POST':'PATCH','--input','-'],{input:JSON.stringify({body:payload}),timeoutMs:10_000})}catch{/* Only exact remote readback resolves a lost response. */}
      for(const delay of [1000,2000,4000]){
        await(controller.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(delay)
        const matches=await comments();if(matches.length>1)throw Error('handback-marker-ambiguous')
        if(matches[0]?.body===payload){await acknowledge(matches[0]);return run}
      }
      throw Error('handback-readback-exhausted')
    }catch{await persist({lastError:'handback-delivery-unconfirmed'});return run}
  })
}

// Shared effect publication has two durable phases: receipt, then envelope link. The
// prepared effect is marked ambiguous by #137 before the adapter may send even once.
export async function prepareManagedRunEffect(input:{claim:import('./shared-claims.ts').SharedClaim;run:RunRecord;effect:Omit<import('./shared-claims.ts').EffectRef,'intent'|'outcome'|'state'>}):Promise<{claim:import('./shared-claims.ts').SharedClaim;effect:import('./shared-claims.ts').EffectRef}>{
  const owner=await import('./shared-claims.ts'),root=roots.get(input.run.runId)??runsRoot(),e=input.effect
  let record=await updateRun(root,input.run.runId,run=>{
    const delivery=run.pendingDelivery.find(p=>p.id===e.operationId)
    if(!delivery||e.runId!==run.runId||e.generation!==input.claim.generation)throw Error('durable managed delivery intent unavailable')
    const effect={kind:e.kind,target:e.target,payloadDigest:e.payloadDigest,generation:e.generation,intent:delivery.effect?.intent??null,outcome:delivery.effect?.outcome??null}
    if(delivery.effect&&owner.canonical(delivery.effect)!==owner.canonical(effect))throw Error('managed delivery identity changed')
    const receiptIds=delivery.receiptIds??{intent:randomUUID(),link:randomUUID(),send:randomUUID(),outcome:randomUUID(),outcomeLink:randomUUID(),checkpointLink:randomUUID()}
    return{pendingDelivery:run.pendingDelivery.map(p=>p.id===delivery.id?{...p,effect,receiptIds}:p)}
  })
  let delivery=record.pendingDelivery.find(p=>p.id===e.operationId)!,claim=input.claim
  let snapshot=await owner.readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
  if(!task?.recovery||task.runId!==record.runId||task.generation!==claim.generation||task.ownerToken!==claim.ownerToken)throw Error('managed effect recovery envelope unavailable')
  let effect=task.recovery.effects.find(x=>x.operationId===e.operationId)
  if(effect){
    if(owner.canonical({...effect,intent:undefined,outcome:undefined,state:undefined})!==owner.canonical({...e,intent:undefined,outcome:undefined,state:undefined}))throw Error('remote prepared effect differs')
    if(effect.state!=='prepared')throw Error('managed effect already reserved; reconcile before retry')
  }else{
    const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-intent',effectId:e.operationId,runId:e.runId,generation:e.generation,approvalBindings:record.approvalBindings,effectKind:e.kind,target:e.target,payloadDigest:e.payloadDigest,result:'prepared',observedRemoteId:null,observedDigest:null,reasonCode:null}
    const receipt=await owner.publishRecoveryReceipt({claim,operationId:delivery.receiptIds!.intent,payload})
    claim=receipt.claim
    record=await updateRun(root,record.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===delivery.id?{...p,effect:{...p.effect!,intent:receipt.reference}}:p)}))
    delivery=record.pendingDelivery.find(p=>p.id===e.operationId)!
    snapshot=await owner.readCoordination(claim.target);task=snapshot.tasks[claim.taskKey]
    if(!task?.recovery)throw Error('managed envelope disappeared')
    effect={...e,state:'prepared',intent:receipt.reference,outcome:null}
    const found=task.recovery.effects.find(x=>x.operationId===e.operationId)
    if(found){effect=found}else{
      const linked=await owner.transitionSharedTask({claim,operationId:delivery.receiptIds!.link,transition:{kind:'recovery',recovery:{...task.recovery,effects:[...task.recovery.effects,effect]}}})
      if(linked.kind!=='owned')throw Error('managed effect receipt link unavailable')
      claim=linked.claim
    }
  }
  // beginManagedEffect performs the final current-owner/coverage check and reserves one send.
  const reserved=await owner.beginManagedEffect({claim,effectId:e.operationId,operationId:delivery.receiptIds!.send})
  await updateRun(root,record.runId,r=>({sharedClaim:r.sharedClaim?{...r.sharedClaim,stateCommit:reserved.claim.stateCommit}:null,pendingDelivery:r.pendingDelivery.map(p=>p.id===delivery.id?{...p,status:'ambiguous',effect:{...p.effect!,intent:effect!.intent}}:p)}))
  return reserved
}

export function sumActiveElapsed(attempts:RunRecord[]):number|null {
  const unique=new Map<string,RunRecord>()
  for(const run of attempts)if((unique.get(run.runId)?.generation??0)<run.generation)unique.set(run.runId,run)
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
  const execution=canonicalWire(run.execution)
  for(;;){
    if(signal?.aborted)return'cancelled'
    run=await readRun(root,runId)
    if(canonicalWire(run.execution)!==execution)throw Error('subscription setup changed')
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
  const owner=await import('./shared-claims.ts'),root=roots.get(input.run.runId)??runsRoot()
  const record=await readRun(root,input.run.runId),delivery=record.pendingDelivery.find(p=>p.id===input.effectId)
  if(!delivery?.receiptIds||!delivery.effect)throw Error('managed effect receipt identity unavailable')
  let snapshot=await owner.readCoordination(input.claim.target),task=snapshot.tasks[input.claim.taskKey]
  const effect=task?.recovery?.effects.find(e=>e.operationId===input.effectId)
  if(!task?.recovery||!effect||!['ambiguous','acknowledged'].includes(effect.state)||effect.runId!==record.runId||effect.payloadDigest!==input.observedDigest)throw Error('effect readback identity mismatch')
  if(effect.state==='acknowledged'){if(!effect.outcome)throw Error('effect outcome receipt absent');await owner.resolveEvidence(input.claim.target,effect.outcome);return{...input.claim,stateCommit:snapshot.head}}
  const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-outcome',effectId:effect.operationId,runId:effect.runId,generation:effect.generation,approvalBindings:record.approvalBindings,effectKind:effect.kind,target:effect.target,payloadDigest:effect.payloadDigest,result:'acknowledged',observedRemoteId:input.observedRemoteId,observedDigest:input.observedDigest,reasonCode:null}
  const receipt=await owner.publishRecoveryReceipt({claim:input.claim,operationId:delivery.receiptIds.outcome,payload})
  await updateRun(root,record.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===delivery.id?{...p,effect:{...p.effect!,outcome:receipt.reference}}:p)}))
  snapshot=await owner.readCoordination(input.claim.target);task=snapshot.tasks[input.claim.taskKey]
  if(!task?.recovery)throw Error('effect outcome envelope unavailable')
  const linked=await owner.transitionSharedTask({claim:receipt.claim,operationId:delivery.receiptIds.outcomeLink,transition:{kind:'recovery',recovery:{...task.recovery,effects:task.recovery.effects.map(e=>e.operationId===effect.operationId?{...e,state:'acknowledged',outcome:receipt.reference}:e)}}})
  if(linked.kind!=='owned')throw Error('effect outcome receipt link unavailable')
  await updateRun(root,record.runId,r=>({sharedClaim:r.sharedClaim?{...r.sharedClaim,stateCommit:linked.claim.stateCommit}:null}))
  return linked.claim
}

export interface InstalledRuntimeBinding {
  schemaVersion:1;sourceSha:string;treeSha:string;packageName:'@vegastack/vegafactory';version:string;tarballSha256:string;inventoryDigest:string
}
export function parseInstalledRuntimeBinding(value:unknown):InstalledRuntimeBinding {
  if(!closed(value,['schemaVersion','sourceSha','treeSha','packageName','version','tarballSha256','inventoryDigest']))throw Error('installed runtime binding unavailable')
  const b=value as InstalledRuntimeBinding
  if(b.schemaVersion!==1||b.packageName!=='@vegastack/vegafactory'||!sha(b.sourceSha)||!sha(b.treeSha)||!digest(b.tarballSha256)||!digest(b.inventoryDigest)||typeof b.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(b.version))throw Error('invalid installed runtime binding')
  return structuredClone(b)
}
export async function verifyInstalledRuntimeBinding(binding:InstalledRuntimeBinding,packageRoot:string,runningEntry:string):Promise<void>{
  parseInstalledRuntimeBinding(binding)
  const {createHash}=await import('node:crypto')
  const root=await realpath(packageRoot),entry=await realpath(runningEntry)
  if(entry!==join(root,'dist','index.js'))throw Error('running CLI is outside the verified installed package')
  const files:Array<{path:string;mode:number;sha256:string}>=[]
  let totalBytes=0
  const walk=async(directory:string,prefix:string)=>{
    for(const item of await readdir(directory,{withFileTypes:true})){
      const path=join(directory,item.name),relative=prefix+item.name,stat=await lstat(path)
      if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error('installed runtime contains a link or unsupported object')
      if(stat.isDirectory()){await walk(path,relative+'/');continue}
      const mode=stat.mode&0o777
      if(![0o644,0o755].includes(mode)||stat.size>32*1024*1024||(totalBytes+=stat.size)>256*1024*1024||files.length>=10000)throw Error('installed runtime inventory exceeds bounds')
      const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
      try{const bytes=await fd.readFile();if(bytes.length!==stat.size)throw Error('installed runtime changed during inspection');files.push({path:relative,mode,sha256:createHash('sha256').update(bytes).digest('hex')})}finally{await fd.close()}
    }
  }
  await walk(root,'')
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  if(!files.some(f=>f.path==='dist/run-wrapper.js')||createHash('sha256').update(JSON.stringify(files)).digest('hex')!==binding.inventoryDigest)throw Error('installed runtime inventory differs from qualified binding')
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
  if(manifest.name!==binding.packageName||manifest.version!==binding.version)throw Error('installed runtime package identity differs')
}
export async function executionConfigurationDigest(input:{binding:InstalledRuntimeBinding;execution:ExecutionIdentity;plan:import('./launch.ts').LaunchPlan;metadata:import('./launch.ts').HarnessMetadata;platform?:string;nodeVersion?:string}):Promise<string>{
  const {createHash}=await import('node:crypto'),{canonical}=await import('./shared-claims.ts')
  const {binding,execution,plan,metadata}=input
  parseInstalledRuntimeBinding(binding)
  const args:string[]=[]
  for(let i=0;i<plan.args.length;i++){
    const value=plan.args[i]!
    if(value===plan.prompt)continue
    if(value==='resume'||value==='--resume'){i++;continue}
    if(value==='-C'){args.push(value,'<checkout>');i++;continue}
    args.push(value.split(plan.cwd).join('<checkout>'))
  }
  const env=Object.fromEntries(Object.entries(plan.env).filter(([key])=>!['VSK_RUN_ID','VSK_ATTEMPT_ID','VSK_ACCOUNT_REF'].includes(key)).map(([key,value])=>[key,value.split(plan.cwd).join('<checkout>')]).sort(([a],[b])=>a!<b!?-1:a!>b!?1:0))
  return createHash('sha256').update(canonical({schemaVersion:1,binding,platform:input.platform??process.platform,nodeVersion:input.nodeVersion??process.versions.node,harness:execution.harness,harnessVersion:execution.harnessVersion,model:execution.model,effort:execution.effort,accountRef:execution.accountRef,args,env,features:metadata.features??{},hookHash:metadata.hookHash??null,hookApplicable:metadata.hookApplicable===true,memoryRetrievalDisabled:metadata.memoryRetrievalDisabled===true,memoryGenerationDisabled:metadata.memoryGenerationDisabled===true})).digest('hex')
}
export function verifyExecutionQualification(payload:unknown,execution:ExecutionIdentity,binding:InstalledRuntimeBinding,configurationDigest:string,requireManagedCoverage=false):void{
  const p=parseRecoveryPayload(payload)
  if(!p||p.kind!=='execution-qualification'||!['qualified','unqualified'].includes(p.result)||p.candidateSha!==binding.sourceSha||p.configurationDigest!==configurationDigest||p.harness!==execution.harness||p.harnessVersion!==execution.harnessVersion||p.model!==execution.model||p.effort!==execution.effort||p.accountRef!==execution.accountRef)throw Error('execution evidence does not bind this source/setup')
  if(requireManagedCoverage&&(p.result!=='qualified'||!p.unmanagedDenied||!p.validationIds.length||!['checkpoint-push','handback','evidence','telemetry-push'].every(kind=>p.managedKinds.includes(kind as typeof p.managedKinds[number]))))throw Error('complete managed-effect coverage is unverified')
}

export type RunAuthorityRequest={kind:'native'}|({kind:'consolidated'}&Omit<NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>,'requested'>&{requested:Omit<NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>['requested'],'operation'>&{operation:'edit'|'check'|'review'|'integrate'|'checkpoint'}})
export interface RunAuthorityDependencies {
  gh?:(args:string[],options?:import('./gh.ts').GhOptions)=>Promise<string>
  approvalScript?:string
  preflightScript?:string
}
export async function approvalTools(deps:RunAuthorityDependencies={}){
  const {fileURLToPath,pathToFileURL}=await import('node:url')
  const preflight=deps.preflightScript??process.env.VSK_PREFLIGHT_SCRIPT??join(dirname(dirname(fileURLToPath(import.meta.url))),'skill','dev-implement','scripts','preflight.mjs')
  const approval=deps.approvalScript??join(dirname(preflight),'lib','approval.mjs')
  return{approval:await import(pathToFileURL(approval).href),preflight:await import(pathToFileURL(preflight).href)}
}
export async function verifyRunAuthority(run:RunRecord,config:import('./config.ts').FactoryConfig,purpose:'launch'|'effect'='effect',deps:RunAuthorityDependencies={}):Promise<void>{
  const {loadConfiguredPolicy}=await import('./control-room.ts'),{repoPolicyFromEffective}=await import('./config.ts'),{ghText,boundedGhJson,fetchGhPages,readBudget}=await import('./gh.ts'),{canonical}=await import('./shared-claims.ts')
  const entry=config.repos.find(r=>r.repo.toLowerCase()===run.repo.toLowerCase())
  if(!entry||!run.approvalBindings.length)throw Error('run authority context unavailable')
  const devMd=await readFile(join(entry.path,'.vegastack','dev.md'),'utf8'),resolved=loadConfiguredPolicy({home:config.home,repo:run.repo,devMd,settingsPath:config.settingsPath})
  if(!resolved.ok)throw Error('current run policy unavailable')
  const policy=repoPolicyFromEffective(resolved),gh=deps.gh??ghText,budget=readBudget(),reads:unknown[]=[]
  const readJson=async(args:string[])=>{const value=await boundedGhJson(gh,args,budget);reads.push(value);return value}
  const {approval,preflight}=await approvalTools(deps)
  let checked:{ok?:boolean;blocks:string[];bindings:ArtifactRef[];approvalBindings:Array<{approvalId:string;commentId:number;bodySha256:string}>;recordBinding?:{approvalId:string;commentId:number;bodySha256:string}}
  if(run.authorityRequest?.kind==='consolidated'){
    const {kind:_,...request}=run.authorityRequest
    if(request.requested.repo!==run.repo||request.requested.issue!==run.issue||request.requested.branch!==run.branch||request.requested.baseSha!==run.baseSha)throw Error('run request identity differs')
    checked=await approval.gatherConsolidatedApproval({...request,operators:policy.operators,readJson})
  }else{
    const issue=await readJson(['api',`repos/${run.repo}/issues/${run.issue}`]) as {body:string;node_id:string;labels:Array<{name:string}>}
    const comments=await fetchGhPages<Record<string,unknown>>(gh,`repos/${run.repo}/issues/${run.issue}/comments`,budget)
    if(!comments.complete)throw Error('complete run approval history unavailable')
    reads.push(comments.items)
    const sourceComments=await approval.readApprovalSources(comments.items,readJson)
    checked=approval.evaluateApprovals({repo:run.repo,issue:run.issue,brief:issue,comments:comments.items,operators:policy.operators,requiredScope:run.stage==='plan'?'brief':'brief+plan',sourceComments})
    if(purpose==='launch'){
      const labels=issue.labels.map(l=>l.name),map=policy.labelMap
      const working=map?labels.includes(map.working):labels.includes('working')
      const expected=working?'working':run.stage==='plan'?'needs-plan':run.stage==='corrections'?'for-operator':'ready'
      const admission=await preflight.gatherAndEvaluate({repo:run.repo,issue:String(run.issue),stage:run.stage==='plan'?'plan':'implement',expect:expected},{readJson,devMd,configuredPolicy:resolved})
      if(admission.blocks.length||canonical(admission.approvalBindings)!==canonical(checked.approvalBindings))throw Error('fresh run admission refused')
    }
  }
  if(checked.blocks.length||checked.ok===false||canonical(checked.bindings)!==canonical(run.approvalRefs))throw Error('run source scope or approval changed')
  if(run.approvedTaskIds){const selection=await approvedTaskSelection(checked.bindings,reads,run.stage,deps,run.approvedTaskIds);if(selection.scopeDigest!==run.taskKey.scopeDigest||selection.taskId!==run.taskKey.taskId)throw Error('run selected task scope changed')}
  const bound=await bindVerifiedApprovalSources(checked.approvalBindings,reads,readJson,gh)
  if(canonical(bound)!==canonical(run.approvalBindings))throw Error('run canonical authority changed')
  if(run.recordBinding){
    if(!checked.recordBinding)throw Error('run record provenance unavailable')
    const [record]=await bindVerifiedApprovalSources([checked.recordBinding],reads,readJson,gh)
    if(canonical(record)!==canonical(run.recordBinding))throw Error('run record provenance changed')
  }
}

export async function updateRun(root:string,runId:string,change:(record:RunRecord)=>RunPatch):Promise<RunRecord>{
  const until=Date.now()+2000
  for(;;){const record=await readRun(root,runId);try{return await transitionRun(runId,record.generation,change(record),root)}catch(error){if(Date.now()>=until||!/stale run generation|run mutation unavailable/.test((error as Error).message))throw error;await new Promise(resolve=>setTimeout(resolve,10))}}
}
export async function withRunDelivery<T>(root:string,runId:string,work:()=>Promise<T>):Promise<T>{
  requireId(runId)
  const held=await acquireClaim(join(root,runId,'delivery'),await processIdentity())
  if(held.kind!=='owned')throw Error('run-delivery-busy')
  try{return await work()}finally{await releaseClaim(held.claim)}
}
export async function findOwnedRunSession(root:string,input:{sessionId:string;cwd:string}):Promise<RunRecord|null>{
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId)||!isAbsolute(input.cwd))return null
  try{
    const matches=(await readRuns(root)).filter(run=>run.vendorSessionId===input.sessionId&&run.checkout===input.cwd&&['running','terminal'].includes(run.state)&&run.processIdentity&&run.terminationCause!=='termination-unconfirmed')
    if(matches.length!==1)return null
    const run=matches[0]!,host=run.hostBindingDigest??run.machine?.hostBindingDigest
    if(!host||(await(await import('./machine-identity.ts')).readHostBinding()).digest!==host||await realpath(run.checkout)!==run.checkout)return null
    const {inspectOwnedGroup}=await import('./run-wrapper.ts'),state=await inspectOwnedGroup(run.processIdentity!)
    if(run.state==='running'?state.kind!=='owned':state.kind!=='absent')return null
    return run
  }catch{return null}
}

export interface TerminalCaptureDescriptor {runId:string;attemptId:string;eventKind:'terminal';sequence:string;captureKey:string}
export function terminalCaptureDescriptor(run:RunRecord):TerminalCaptureDescriptor {
  const sequence=run.terminalSegment?.sequence??'0'
  return{runId:run.runId,attemptId:run.attemptId??run.runId,eventKind:'terminal',sequence,captureKey:`${run.runId}:terminal:${sequence}`}
}
// Quota retries remain in their current measurement segment. A verified continuation
// starts a new segment, even when the previous interruption is still uncaptured.
export function terminalCaptureAttempts(run:RunRecord):RunAttempt[]{
  const attempts=run.attempts??[]
  if(!run.terminalSegment)return attempts
  if(run.attemptId===run.terminalSegment.firstAttemptId)return[]
  const index=attempts.findIndex(a=>a.id===run.terminalSegment!.firstAttemptId)
  if(index<0)throw Error('terminal segment history unavailable')
  return attempts.slice(index)
}
export function terminalCaptureElapsedMs(run:RunRecord):number|null {
  const values=[...terminalCaptureAttempts(run).map(a=>a.activeElapsedMs),run.attemptElapsedMs??null]
  return values.some(v=>v===null)?null:values.reduce<number>((sum,v)=>sum+v!,0)
}

export async function ensureTerminalCaptureIntent(root:string,runId:string):Promise<void>{
  await updateRun(root,runId,run=>{
    const {captureKey}=terminalCaptureDescriptor(run)
    return run.pendingDelivery.some(p=>p.kind==='telemetry-capture'&&'captureKey'in p.target&&p.target.captureKey===captureKey)?{}:{pendingDelivery:[...run.pendingDelivery,{id:randomUUID(),kind:'telemetry-capture',target:{captureKey},intentRef:null,status:'pending',attempts:0,lastError:null}]}
  })
}
export async function prepareTerminalCapture(root:string,runId:string,payload:import('./stats/record.ts').StatsRecord):Promise<PendingDelivery>{
  const {RECORD_FIELDS,serializeRecord}=await import('./stats/record.ts'),{sha256}=await import('./shared-claims.ts')
  if(!plain(payload)||Object.keys(payload).some(key=>!RECORD_FIELDS.includes(key as typeof RECORD_FIELDS[number]))||!closed(payload.tokens,['in','out','cache_read','cache_write'])||Object.values(payload.tokens).some(v=>!nullable(v,x=>typeof x==='number'&&Number.isFinite(x)&&x>=0))||!Array.isArray(payload.skills)||payload.skills.some(s=>!closed(s,['name','trigger','harness'])||!text(s.name)||!['model','typed','mention'].includes(s.trigger)||!text(s.harness)))throw Error('terminal capture schema refused')
  const serialized=serializeRecord(payload),payloadDigest=sha256(serialized)
  let selected:PendingDelivery|undefined
  await updateRun(root,runId,run=>{
    const {captureKey}=terminalCaptureDescriptor(run)
    if(run.state!=='terminal'||run.waitReason==='subscription-quota'||payload.repo!==run.repo||payload.issue!==run.issue||payload.session_id!==(run.vendorSessionId??null))throw Error('terminal capture identity unavailable')
    selected=run.pendingDelivery.find(p=>p.kind==='telemetry-capture'&&'captureKey'in p.target&&p.target.captureKey===captureKey)
    if(selected){if(selected.payloadDigest===undefined&&selected.payload===undefined&&selected.status==='pending'&&selected.attempts===0){selected={...selected,payload:serialized,payloadDigest};return{pendingDelivery:run.pendingDelivery.map(p=>p.id===selected!.id?selected!:p)}}if(selected.payloadDigest!==payloadDigest)throw Error('terminal capture key rebound');return{}}
    selected={id:randomUUID(),kind:'telemetry-capture',target:{captureKey},intentRef:null,status:'pending',attempts:0,lastError:null,payload:serialized,payloadDigest}
    return{pendingDelivery:[...run.pendingDelivery,selected]}
  })
  return selected!
}
export async function acknowledgeTerminalCapture(root:string,runId:string,captureKey:string,payloadDigest:string):Promise<void>{
  await updateRun(root,runId,run=>{
    const delivery=run.pendingDelivery.find(p=>p.kind==='telemetry-capture'&&'captureKey'in p.target&&p.target.captureKey===captureKey)
    if(!delivery||delivery.payloadDigest!==payloadDigest)throw Error('terminal capture readback differs')
    return{pendingDelivery:run.pendingDelivery.map(p=>p.id===delivery.id?{...p,status:'acknowledged',lastError:null}:p)}
  })
}

export interface EvidenceContext {
  run:RunRecord
  task?:import('./shared-claims.ts').TaskRecord
  verifyAuthority:()=>Promise<void>
  stopped?:()=>Promise<boolean>
  publishing?:boolean
  verifyOperatorInspection?:(ref:import('./shared-claims.ts').EvidenceRef|null,payload:Extract<import('./shared-claims.ts').RecoveryEvidencePayload,{kind:'effect-reconciliation'}>)=>Promise<void>
}
export async function verifyRunEvidencePayload(ref:import('./shared-claims.ts').EvidenceRef|null,payload:unknown,context:EvidenceContext):Promise<void>{
  const owner=await import('./shared-claims.ts'),{run,task}=context
  if(ref?.kind==='github-comment'){
    if(!run.approvalBindings.some(a=>owner.canonical(a.source)===owner.canonical(ref)))throw Error('evidence is not the original canonical authority')
    await context.verifyAuthority();return
  }
  const p=owner.parseRecoveryPayload(payload)
  if(p.kind==='execution-qualification'){
    if(context.publishing)throw Error('qualification publication belongs to its actual qualification producer')
    if(!run.execution||!run.runtimeBinding||!run.configurationDigest)throw Error('qualified runtime binding unavailable')
    verifyExecutionQualification(p,run.execution,run.runtimeBinding,run.configurationDigest);return
  }
  await context.verifyAuthority()
  if(p.kind==='effect-intent'||p.kind==='effect-outcome'){
    if(p.runId!==run.runId||owner.canonical(p.approvalBindings)!==owner.canonical(run.approvalBindings))throw Error('managed effect authority differs')
    const local=run.pendingDelivery.find(d=>d.id===p.effectId)?.effect
    const remote=task?.recovery?.effects.find(e=>e.operationId===p.effectId)
    const expected=local??remote
    if(!expected||p.generation!==expected.generation||p.effectKind!==(local?.kind??remote?.kind)||p.payloadDigest!==expected.payloadDigest||owner.canonical(p.target)!==owner.canonical(expected.target))throw Error('managed effect target/digest is not prepared')
    if(context.publishing&&p.kind==='effect-outcome'&&p.result==='ambiguous'&&(p.reasonCode!=='idempotent-source-ref-retry'||p.effectKind!=='checkpoint-push'||p.target.kind!=='source-ref'||p.observedDigest!==p.payloadDigest))throw Error('ambiguous effect is not an idempotent source retry')
    if(context.publishing&&p.kind==='effect-outcome'&&p.result==='cancelled-before-send')throw Error('cancellation before send needs adapter-specific proof')
    if(p.kind==='effect-outcome'&&p.result==='acknowledged'&&(p.observedDigest!==p.payloadDigest||!p.observedRemoteId))throw Error('managed effect lacks exact remote readback')
    return
  }
  if(p.kind==='effect-reconciliation'){
    if(p.runId!==run.runId||p.scopeDigest!==run.taskKey.scopeDigest||owner.canonical(p.approvalBindings)!==owner.canonical(run.approvalBindings)||p.inspector.kind==='qualified-adapter'&&p.inspector.identityRef!==run.machine?.id)throw Error('reconciliation identity differs')
    if(p.inspector.kind==='authorized-operator'){if(!context.verifyOperatorInspection)throw Error('authorized inspection evidence unavailable');await context.verifyOperatorInspection(ref,p)}
    const allowed=[...new Set([run.handbackIntent?.id,run.checkpointIntent?.id,run.authorityRequest?.kind==='consolidated'?run.authorityRequest.requested.actionId:null].filter((id):id is string=>!!id))].sort()
    if(owner.canonical([...p.allowedActionIds].sort())!==owner.canonical(allowed))throw Error('reconciled action scope differs')
    const effects=task?.recovery?.effects??[]
    const codeEffects=effects.filter(e=>e.kind!=='telemetry-push')
    if(p.result==='complete'&&(task?.recovery?.remoteEffectCoverage.kind==='unmanaged-possible'&&p.inspector.kind!=='authorized-operator'||codeEffects.some(e=>e.state!=='acknowledged'&&e.state!=='cancelled-before-send'||!p.checkedEffectIds.includes(e.operationId))))throw Error('unresolved code/control effects retain ownership')
    if(context.publishing&&(p.reasonCode!=='owned-process-group-stopped'||!await context.stopped?.()))throw Error('process-group stop is not verified')
    return
  }
  if(p.kind==='acceptance'){
    if(context.publishing)throw Error('acceptance publication requires its source-check owner')
    const child=task?.recovery?.children.find(c=>c.childRunId===p.runId)
    const known=task?.recovery?.completed.find(c=>c.taskId===p.taskId&&c.headSha===p.sourceSha)
    if(p.result!=='passed'||p.runId!==run.runId&&!child||p.scopeDigest!==(child?.scopeDigest??run.taskKey.scopeDigest)||p.sourceSha!==(child?.headSha??run.checkpoint?.headSha??run.headSha)&&!known)throw Error('acceptance source identity differs')
    if(p.acceptedScope){owner.parseAcceptedScope(p.acceptedScope);if(p.acceptedScope.repo!==run.repo||p.acceptedScope.issue!==run.issue||owner.canonical(p.acceptedScope.approvalBindings)!==owner.canonical(run.approvalBindings))throw Error('accepted scope authority differs')}
    return
  }
  if(p.kind==='join'){
    if(context.publishing)throw Error('join publication requires its integration owner')
    const joined=task?.recovery?.joins.find(j=>j.childRunId===p.childRunId&&j.generation===p.generation)
    if(!joined||joined.fromSha!==p.fromSha||joined.parentBefore!==p.parentBefore||joined.parentAfter!==p.parentAfter||joined.state!==p.state)throw Error('join source identity differs')
  }
}
export async function verifyLocalRunStopped(run:RunRecord):Promise<boolean>{
  const host=run.hostBindingDigest??run.machine?.hostBindingDigest
  if(!host)return false
  const {readHostBinding}=await import('./machine-identity.ts')
  if((await readHostBinding()).digest!==host)return false
  if(!run.processIdentity){if(run.state!=='terminal')return false;try{await lstat(runAttemptDirectory(roots.get(run.runId)??runsRoot(),run));return false}catch(error){return(error as NodeJS.ErrnoException).code==='ENOENT'}}
  const current=await processIdentity()
  if(current.bootId!==run.processIdentity.bootId)return true // Same host, a different verified boot.
  const {inspectOwnedGroup}=await import('./run-wrapper.ts')
  return(await inspectOwnedGroup(run.processIdentity)).kind==='absent'
}
export async function verifySharedStopProof(proof:import('./shared-claims.ts').StopProof,task:import('./shared-claims.ts').TaskRecord,target:import('./shared-claims.ts').CoordinationTarget,run:RunRecord):Promise<void>{
  const owner=await import('./shared-claims.ts')
  owner.parseStopProof(proof)
  if(run.runId!==task.runId||run.taskKey.scopeDigest!==task.scopeDigest||run.machine?.id!==proof.machineId||run.machine.installationId!==proof.installationId||run.machine.sessionId!==proof.sessionId||run.machine.hostBindingDigest!==proof.hostBindingDigest||proof.machineId!==task.machineId||proof.installationId!==task.installationId||proof.sessionId!==task.sessionId||proof.generation!==task.generation||!proof.runIds.includes(task.runId))throw Error('stop proof ownership differs')
  if(proof.evidenceRef.kind!=='state-receipt')throw Error('operator stop requires the verified recovery-owner adapter')
  const payload=await owner.resolveEvidence(target,proof.evidenceRef)
  const raw=await target.provider.read(target,proof.evidenceRef.commitSha,owner.operationPath(proof.evidenceRef.operationId))
  if(raw===null||owner.sha256(raw)!==proof.evidenceRef.blobSha256)throw Error('stop receipt changed')
  const receipt=JSON.parse(raw) as import('./shared-claims.ts').OperationReceipt
  if(receipt.operationId!==proof.evidenceRef.operationId||receipt.taskKey!==task.taskKey||receipt.resultOwner.ownerToken!==task.ownerToken||receipt.resultOwner.machineId!==proof.machineId||receipt.resultOwner.installationId!==proof.installationId||receipt.resultOwner.sessionId!==proof.sessionId||receipt.resultOwner.runId!==task.runId||receipt.generation!==proof.generation||!payload||payload.kind!=='effect-reconciliation'||payload.scopeDigest!==task.scopeDigest||owner.canonical(payload.approvalBindings)!==owner.canonical(run.approvalBindings)||payload.reasonCode!=='owned-process-group-stopped'||payload.runId!==task.runId)throw Error('stop attestation is incomplete')
  if(!await verifyLocalRunStopped(run))throw Error('original local process remains unconfirmed')
  if(run.processIdentity&&proof.bootIdDigest!==owner.sha256(`VegaFactory/boot/v1\n${run.processIdentity.bootId}`))throw Error('stop proof boot identity differs')
  if(proof.kind==='verified-reboot'&&run.processIdentity?.bootId===(await processIdentity()).bootId)throw Error('stop proof reboot is unconfirmed')
}

export interface QualifiedExecutionRecord {schemaVersion:1;execution:ExecutionIdentity;runtimeBinding:InstalledRuntimeBinding;configurationDigest:string}
export function parseQualifiedExecution(value:unknown):QualifiedExecutionRecord {
  if(!closed(value,['schemaVersion','execution','runtimeBinding','configurationDigest']))throw Error('qualification record schema refused')
  const record=value as QualifiedExecutionRecord
  if(record.schemaVersion!==1||!validExecution(record.execution)||!digest(record.configurationDigest))throw Error('qualification record identity refused')
  parseInstalledRuntimeBinding(record.runtimeBinding)
  return structuredClone(record)
}
export async function storeQualifiedExecution(root:string,record:QualifiedExecutionRecord):Promise<string>{
  const {canonical,sha256}=await import('./shared-claims.ts')
  parseQualifiedExecution(record)
  await mkdir(root,{recursive:true,mode:0o700});await privatePath(root,true)
  const directory=join(root,'qualifications');await mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error});await privatePath(directory,true)
  const id=sha256(canonical(record)),path=join(directory,id+'.json'),claim=await acquireClaim(join(root,'qualification-mutation'),await processIdentity())
  if(claim.kind!=='owned')throw Error('qualification registration busy')
  try{
    let exists=false
    try{if(canonical(parseStrictJson(await readPrivateRunFile(path)))!==canonical(record))throw Error('qualification record rebound');exists=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    if(!exists)await atomicRunFile(path,record)
    const pointerPath=join(root,'execution-evidence-index.json')
    let index:{schemaVersion:1;active:Record<string,string>}={schemaVersion:1,active:{}}
    try{index=parseStrictJson(await readPrivateRunFile(pointerPath))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    if(!closed(index,['schemaVersion','active'])||index.schemaVersion!==1||!plain(index.active)||Object.entries(index.active).some(([key,value])=>!digest(key)||!digest(value)))throw Error('execution evidence index refused')
    const key=sha256(canonical({harness:record.execution.harness,model:record.execution.model,effort:record.execution.effort,accountRef:record.execution.accountRef,configurationDigest:record.configurationDigest}))
    await atomicRunFile(pointerPath,{schemaVersion:1,active:{...index.active,[key]:id}})
    return id
  }finally{await releaseClaim(claim.claim)}
}
export async function readQualifiedExecutions(root:string):Promise<QualifiedExecutionRecord[]>{
  const {canonical,sha256}=await import('./shared-claims.ts'),directory=join(root,'qualifications')
  let index:{schemaVersion:1;active:Record<string,string>}
  try{index=parseStrictJson(await readPrivateRunFile(join(root,'execution-evidence-index.json')))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
  if(!closed(index,['schemaVersion','active'])||index.schemaVersion!==1||!plain(index.active)||Object.entries(index.active).some(([key,value])=>!digest(key)||!digest(value)))throw Error('execution evidence index refused')
  const result:QualifiedExecutionRecord[]=[]
  for(const [key,id] of Object.entries(index.active)){
    const record=parseQualifiedExecution(parseStrictJson(await readPrivateRunFile(join(directory,id+'.json'))))
    if(sha256(canonical(record))!==id||sha256(canonical({harness:record.execution.harness,model:record.execution.model,effort:record.execution.effort,accountRef:record.execution.accountRef,configurationDigest:record.configurationDigest}))!==key)throw Error('execution evidence identity changed')
    result.push(record)
  }
  return result
}

export async function approvedTaskSelection(bindings:ArtifactRef[],reads:unknown[],stage:string,deps:RunAuthorityDependencies={},selectedIds?:string[]):Promise<{taskId:string;approvedTaskIds:string[];scopeDigest:string;paths:string[]}>{
  const binding=bindings.find(b=>b.kind==='plan')??bindings.find(b=>b.kind==='brief')
  if(!binding)throw Error('approved task scope unavailable')
  const wire=await import('./shared-claims.ts')
  if(stage==='plan')return{taskId:'plan',approvedTaskIds:['plan'],scopeDigest:wire.sha256(wire.canonical({artifacts:bindings,taskIds:['plan']})),paths:[]}
  const {approval}=await approvalTools(deps)
  const candidates=reads.flat(Infinity).filter((row):row is {node_id:string;body:string}=>!!row&&typeof row==='object'&&(row as {node_id?:string}).node_id===binding.artifactId&&typeof(row as {body?:string}).body==='string')
  const bodies=[...new Set(candidates.map(c=>c.body))]
  if(bodies.length!==1||approval.scopeDigest(bodies[0],'plan')!==binding.digest)throw Error('canonical selected plan is unavailable')
  const ids:string[]=[],files=new Map<string,string[]>();let fence:string|null=null,current:string|null=null
  for(const line of bodies[0]!.split('\n')){
    const marker=/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if(marker){if(fence===null)fence=marker[1]!;else if(marker[1]![0]===fence[0]&&marker[1]!.length>=fence.length&&!marker[2]!.trim())fence=null;continue}
    if(fence!==null)continue
    if(/^(?: {4}|\t)/.test(line))continue
    const task=/^- \[[ xX]\] \*\*Task .*?<!-- task-id:([1-9]\d*-T[1-9]\d*) -->/.exec(line)
    if(task){current=task[1]!;ids.push(current);files.set(current,[]);continue}
    if(/^#{1,6}\s/.test(line)){current=null;continue}
    if(current&&/^\s*(?:- )?Files —/.test(line))files.get(current)!.push(...[...line.matchAll(/`([^`]+)`/g)].map(row=>row[1]!))
  }
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!id.startsWith(binding.issue+'-T')))throw Error('selected task identities unavailable')
  const selected=selectedIds??ids
  if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!ids.includes(id)))throw Error('requested task is outside canonical scope')
  const paths=[...new Set(selected.flatMap(id=>files.get(id)??[]))]
  if(!paths.length||paths.some(path=>!text(path,8192)||path.startsWith('/')||/[\\\x00-\x1f*?\[\]{}]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..')))throw Error('unverifiable task file scope')
  return{taskId:selected.length===1?selected[0]!:'whole-issue',approvedTaskIds:selected,scopeDigest:wire.sha256(wire.canonical({artifacts:bindings,taskIds:selected})),paths}
}

export async function worktreeFingerprint(checkout:string):Promise<string>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{createHash}=await import('node:crypto'),{readlink}=await import('node:fs/promises')
  const execute=promisify(execFile),hash=createHash('sha256')
  const git=async(args:string[])=> (await execute('git',args,{cwd:checkout,encoding:'buffer',timeout:5000,maxBuffer:32*1024*1024,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'}})).stdout
  hash.update(await git(['rev-parse','HEAD']));hash.update(await git(['symbolic-ref','HEAD']));hash.update(await git(['diff','HEAD','--binary','--no-ext-diff','--no-textconv']))
  const untracked=new TextDecoder('utf-8',{fatal:true}).decode(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).sort()
  for(const path of untracked){
    if(path.startsWith('/')||path.split('/').includes('..'))throw Error('untracked checkout path is unsafe')
    const absolute=join(checkout,path),stat=await lstat(absolute)
    hash.update(path+'\0'+String(stat.mode&0o777)+'\0')
    if(stat.isSymbolicLink())hash.update(await readlink(absolute))
    else if(stat.isFile()){
      if(stat.size>32*1024*1024)throw Error('untracked source snapshot exceeds bound')
      const fd=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);try{hash.update(await fd.readFile())}finally{await fd.close()}
    }else throw Error('untracked checkout object is unsupported')
  }
  return hash.digest('hex')
}

export async function reserveIdempotentSourceRetry(input:{claim:import('./shared-claims.ts').SharedClaim;run:RunRecord;effectId:string;observedRemoteHead:string|null}):Promise<import('./shared-claims.ts').SharedClaim>{
  const owner=await import('./shared-claims.ts'),root=roots.get(input.run.runId)??runsRoot()
  let run=await readRun(root,input.run.runId)
  const delivery=run.pendingDelivery.find(p=>p.id===input.effectId)
  const snapshot=await owner.readCoordination(input.claim.target),task=snapshot.tasks[input.claim.taskKey],effect=task?.recovery?.effects.find(e=>e.operationId===input.effectId)
  if(!delivery?.effect||!delivery.exportProof||!effect||effect.kind!=='checkpoint-push'||effect.target.kind!=='source-ref'||effect.state!=='ambiguous'||effect.outcome||task!.ownerToken!==input.claim.ownerToken||task!.generation!==input.claim.generation||task!.runId!==run.runId||task!.recovery!.remoteEffectCoverage.kind==='unmanaged-possible')throw Error('source retry ownership/intent unavailable')
  if(!('sha'in delivery.target)||effect.target.headSha!==delivery.target.sha||effect.target.branch!==run.branch||effect.payloadDigest!==owner.sha256(owner.canonical(effect.target))||effect.payloadDigest!==delivery.effect.payloadDigest||delivery.exportProof.headSha!==effect.target.headSha)throw Error('original exact source retry payload unavailable')
  await input.claim.target.verifyTransition(task!,{kind:'recovery',recovery:task!.recovery!})
  await owner.resolveEvidence(input.claim.target,effect.intent)
  await owner.resolveEvidence(input.claim.target,task!.recovery!.execution.qualification)
  const operationId=randomUUID()
  run=await updateRun(root,run.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===delivery.id?{...p,retryReceiptIds:[...(p.retryReceiptIds??[]),operationId]}:p)}))
  const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-outcome',effectId:effect.operationId,runId:effect.runId,generation:effect.generation,approvalBindings:run.approvalBindings,effectKind:effect.kind,target:effect.target,payloadDigest:effect.payloadDigest,result:'ambiguous',observedRemoteId:input.observedRemoteHead,observedDigest:effect.payloadDigest,reasonCode:'idempotent-source-ref-retry'}
  // This receipt acknowledges current ownership + the exact retry request, not cancellation
  // or success. The original effect remains ambiguous until source readback proves success.
  const receipt=await owner.publishRecoveryReceipt({claim:input.claim,operationId,payload})
  await updateRun(root,run.runId,r=>({sharedClaim:r.sharedClaim?{...r.sharedClaim,stateCommit:receipt.claim.stateCommit}:null}))
  return receipt.claim
}

function validateApprovalRequest(value:unknown):void{
  if(!closed(value,['parentRepo','parentIssue','approvalBinding','requested']))throw Error('invalid canonical approval request')
  const r=value as NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>
  if(!validRepo(r.parentRepo)||!number(r.parentIssue)||r.parentIssue<1||!closed(r.approvalBinding,['commentId','bodySha256'])||!number(r.approvalBinding.commentId)||r.approvalBinding.commentId<1||!digest(r.approvalBinding.bodySha256)||!closed(r.requested,['repo','issue','taskIds','actionId','branch','baseSha','paths','operation']))throw Error('invalid approval locator/selection')
  const q=r.requested
  if(!validRepo(q.repo)||!number(q.issue)||q.issue<1||!Array.isArray(q.taskIds)||!q.taskIds.length||q.taskIds.some(id=>typeof id!=='string'||!new RegExp(`^${q.issue}-T[1-9]\\d*$`).test(id))||!text(q.actionId)||!validBranch(q.branch)||!sha(q.baseSha)||!Array.isArray(q.paths)||q.paths.some(path=>!text(path,8192)||path.startsWith('/')||path.split('/').includes('..'))||!['edit','check','review','integrate','checkpoint'].includes(q.operation))throw Error('invalid approved action selection')
}
export function validateCheckpointIntentShape(value:unknown):void{
  const fields=['id','repo','repositoryId','remote','remoteUrl','branch','baseRef','baseSha','scopeDigest','paths','approvalBindings']
  if(!plain(value)||fields.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!fields.includes(k)&&!['approvalRequest','nativeApproval'].includes(k)))throw Error('checkpoint intent schema refused')
  const i=value as unknown as import('./checkpoints.ts').CheckpointIntent
  if(!text(i.id)||!validRepo(i.repo)||!text(i.repositoryId)||!text(i.remote)||!text(i.remoteUrl,8192)||!validBranch(i.branch)||!i.baseRef.startsWith('refs/heads/')||!validBranch(i.baseRef.slice(11))||!sha(i.baseSha)||!digest(i.scopeDigest)||!Array.isArray(i.paths)||!i.paths.length||i.paths.some(p=>!text(p,8192)||p.startsWith('/')||p.split('/').some(part=>part==='..'||part==='.')||/[\\*?\[\]{}]/.test(p))||!Array.isArray(i.approvalBindings)||!i.approvalBindings.length)throw Error('checkpoint intent identity refused')
  i.approvalBindings.forEach(validateAuthority)
  if(i.approvalRequest&&i.nativeApproval)throw Error('checkpoint authority form is ambiguous')
  if(i.approvalRequest){validateApprovalRequest(i.approvalRequest);if(i.approvalRequest.requested.operation!=='checkpoint')throw Error('checkpoint action kind differs')}
  if(i.nativeApproval){const n=i.nativeApproval,p=n.plan;if(!closed(n,['action','plan','taskIds','admittedHeadSha'])||n.action!=='task-branch'||!closed(p,['repo','issue','kind','artifactId','rev','digest'])||p.repo!==i.repo||!number(p.issue)||p.issue<1||p.kind!=='plan'||!text(p.artifactId)||!number(p.rev)||p.rev<1||!digest(p.digest)||!Array.isArray(n.taskIds)||!n.taskIds.length||new Set(n.taskIds).size!==n.taskIds.length||n.taskIds.some(id=>typeof id!=='string'||!new RegExp(`^${p.issue}-T[1-9]\\d*$`).test(id))||!sha(n.admittedHeadSha))throw Error('native checkpoint authority refused')}
}

export async function refreshAttemptCoverage(root:string,runId:string,target:import('./shared-claims.ts').CoordinationTarget):Promise<RunRecord>{
  const owner=await import('./shared-claims.ts')
  let run=await readRun(root,runId)
  if(run.state!=='prepared'||run.processIdentity||!run.execution||!run.runtimeBinding||!run.configurationDigest)throw Error('attempt evidence must precede vendor admission')
  const evidence=await owner.resolveEvidence(target,run.execution.qualification)
  verifyExecutionQualification(evidence,run.execution,run.runtimeBinding,run.configurationDigest)
  const coverage:RecoveryEnvelope['remoteEffectCoverage']=evidence?.kind==='execution-qualification'&&evidence.result==='qualified'?{kind:'qualified-managed-only',qualification:run.execution.qualification}:{kind:'unmanaged-possible',reasonCode:'execution-coverage-unqualified'}
  if(owner.canonical(run.remoteEffectCoverage)!==owner.canonical(coverage))run=await mutateRun(runId,run.generation,root,r=>({...r,remoteEffectCoverage:coverage}))
  if(run.sharedClaim){
    const snapshot=await owner.readCoordination(target),task=snapshot.tasks[run.sharedClaim.taskKey]
    if(!task?.recovery||task.runId!==runId||task.ownerToken!==run.sharedClaim.ownerToken||task.generation!==run.sharedClaim.generation)throw Error('attempt ownership differs')
    if(owner.canonical(task.recovery.remoteEffectCoverage)!==owner.canonical(coverage)){
      if(!run.attemptOperationIds)throw Error('attempt coverage intent unavailable')
      const claim={taskKey:task.taskKey,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId,runId:task.runId,stateCommit:snapshot.head,target}
      const changed=await owner.transitionSharedTask({claim,operationId:run.attemptOperationIds.coverage,transition:{kind:'recovery',recovery:{...task.recovery,remoteEffectCoverage:coverage}}})
      if(changed.kind!=='owned')throw Error('attempt coverage acknowledgment unavailable')
      run=await updateRun(root,runId,r=>({sharedClaim:{...r.sharedClaim!,stateCommit:changed.claim.stateCommit}}))
    }
  }
  return run
}

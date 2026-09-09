#!/usr/bin/env node
// Pure recovery decisions and bounded source reconciliation. Runtime owners alone
// perform ownership transitions, source fetches and execution.
import { validateLesson } from './learning.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { evaluateApprovals, readApprovalSources, readPages, scopeDigest, gatherConsolidatedApproval } from './lib/approval.mjs';
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const taskId = /^[1-9]\d*-T[1-9]\d*$/;
export const canonicalRecovery = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item);
const same = (a,b) => canonicalRecovery(a) === canonicalRecovery(b);
const hash = body => createHash('sha256').update(body).digest('hex');
const unique = values => Array.isArray(values) && new Set(values).size === values.length;
export function compareTaskIds(expected, actual) {
  return { missing: [...new Set(expected)].filter(id => !actual.includes(id)), unknown: [...new Set(actual)].filter(id => !expected.includes(id)) };
}
export function isPreparationSubset(ids, allowed) {
  return unique(ids) && ids.length > 0 && ids.every(id => taskId.test(id) && allowed.preparation.includes(id) && !allowed.live.includes(id));
}
export function localApprovalBinding(wire) {
  const source = wire?.source, n = Number(source?.commentId);
  if (!wire?.approvalId || source?.kind !== 'github-comment' || !source.repositoryId || !source.issueNodeId || !Number.isSafeInteger(n) || n <= 0 || String(n) !== source.commentId || !digest.test(source.bodySha256)) throw Error('invalid canonical approval source');
  return { approvalId:wire.approvalId, commentId:n, bodySha256:source.bodySha256 };
}
export function validateRecoveryPacket(packet) {
  const keys=['schemaVersion','repo','issue','briefRef','planRef','approvalIds','approvalBindings','recordBinding','taskIds','completed','lastVerifiedCommit','openFindings','rulings','commentCursor','pendingRunIds','learning'];
  if (!packet || Object.keys(packet).length!==keys.length || keys.some(key=>!Object.hasOwn(packet,key))) throw Error('unknown or missing recovery packet field');
  if (Buffer.byteLength(JSON.stringify(packet))>128*1024) throw Error('recovery packet exceeds bound');
  if (packet?.schemaVersion !== 3 || !/^[^/\s]+\/[^/\s]+$/.test(packet.repo) || !Number.isSafeInteger(packet.issue) || packet.issue <= 0) throw Error('unsupported recovery packet; regenerate from verified source');
  if (!unique(packet.taskIds) || !packet.taskIds.length || packet.taskIds.some(id => !taskId.test(id) || !id.startsWith(packet.issue + '-T'))) throw Error('invalid recovery task identities');
  if (!Array.isArray(packet.approvalBindings) || !packet.approvalBindings.length || !same(packet.approvalIds, packet.approvalBindings.map(row => row.approvalId))) throw Error('canonical authority unavailable');
  packet.approvalBindings.forEach(localApprovalBinding);
  if(new Set(packet.approvalBindings.map(canonicalRecovery)).size!==packet.approvalBindings.length)throw Error('duplicate recovery authority');
  if (packet.recordBinding !== null) localApprovalBinding(packet.recordBinding);
  for (const [key, kind] of [['briefRef','brief'],['planRef','plan']]) {
    const ref=packet[key];
    if (ref?.repo !== packet.repo || ref.issue !== packet.issue || ref.kind !== kind || !ref.artifactId || !Number.isSafeInteger(ref.rev) || !digest.test(ref.digest)) throw Error('invalid approved artifact');
  }
  if (!sha.test(packet.lastVerifiedCommit) || !Array.isArray(packet.completed) || !unique(packet.completed.map(row=>row.taskId)) || packet.completed.some(row=>!packet.taskIds.includes(row.taskId)||!sha.test(row.headSha)||typeof row.evidenceUrl!=='string'||!row.evidenceUrl)) throw Error('invalid completed recovery work');
  if (!packet.commentCursor?.id || !Number.isFinite(Date.parse(packet.commentCursor.updatedAt)) || !Array.isArray(packet.pendingRunIds) || !Array.isArray(packet.openFindings) || !Array.isArray(packet.rulings) || !Array.isArray(packet.learning) || packet.learning.length>32 || Buffer.byteLength(JSON.stringify(packet.learning))>16384) throw Error('invalid bounded recovery context');
  packet.learning.forEach(validateLesson);
  return packet;
}
export function reconcileRecovery(packet, current) {
  const blocks=[], sourceRefs=[];
  try { validateRecoveryPacket(packet); } catch(error) { return {outstandingTaskIds:[],blocks:[error.message],sourceRefs}; }
  const outstandingTaskIds=packet.taskIds.filter(id=>!packet.completed.some(row=>row.taskId===id));
  if (current.historyComplete !== true) blocks.push('complete current authority history unavailable');
  if (!current.approval || current.approval.blocks?.length || !same(current.approval.approvalBindings,packet.approvalBindings.map(localApprovalBinding))) blocks.push('canonical approval changed or unavailable');
  if (!same(current.briefRef,packet.briefRef)||!same(current.planRef,packet.planRef)||!same(current.taskIds,packet.taskIds)) blocks.push('approved scope changed; preserve prior completed work and reconcile');
  const comments=Array.isArray(current.comments)?current.comments:[];
  const cursor=comments.find(row=>String(row.id)===String(packet.commentCursor.id));
  if (!cursor || !Number.isFinite(Date.parse(cursor.updated_at))) blocks.push('comment cursor unavailable');
  for (const row of comments) {
    if (Date.parse(row.updated_at)>Date.parse(packet.commentCursor.updatedAt) || [packet.planRef.artifactId,packet.briefRef.artifactId].includes(row.node_id)) sourceRefs.push({id:String(row.id),updatedAt:row.updated_at,bodySha256:hash(row.body)});
    if (Date.parse(row.updated_at)>Date.parse(packet.commentCursor.updatedAt) && (/^<!-- vsk:v1 type=(correction|ruling|handback)\b/m.test(row.body) || (current.operators??[]).includes(row.user?.login) && !/^<!-- vsk:v1 type=(plan|approval)\b/m.test(row.body)) && !(current.reconciledComments??[]).some(pin=>String(pin.id)===String(row.id)&&pin.bodySha256===hash(row.body))) blocks.push('new or edited instruction requires reconciliation: '+row.id);
  }
  for (const row of packet.completed) if (!(current.verifiedCompleted??[]).some(verified=>same(row,verified))) blocks.push('completed commit/evidence unavailable: '+row.taskId);
  if (!current.verifiedCommit || current.verifiedCommit!==packet.lastVerifiedCommit) blocks.push('last verified commit missing or outside current ancestry');
  if (current.conflictingFindings?.length || current.conflictingRulings?.length) blocks.push('contradictory current findings or rulings');
  return {outstandingTaskIds,blocks,sourceRefs};
}
/** @param {{outstandingTaskIds?: string[], pendingDelivery?: unknown[], blocks?: string[]}} input */
export function chooseResumeAction({outstandingTaskIds=[],pendingDelivery=[],blocks=[]}) {
  if (blocks.length) return {action:'refuse',taskIds:[],reason:blocks.join('; ')};
  if (outstandingTaskIds.length) return {action:'resume-task',taskIds:[...outstandingTaskIds],reason:'verified-outstanding-work'};
  if (pendingDelivery.length) return {action:'retry-delivery',taskIds:[],reason:'pending-delivery'};
  return {action:'handback',taskIds:[],reason:'verified-work-complete'};
}
export function evaluateSharedRecovery({task,stopProof,checkpoint,targetMachine,policy,pendingEffects,recovery}) {
  const refuse=reason=>({action:'refuse',reason}), wait=reason=>({action:'wait',reason});
  if (!task || !recovery || recovery.schemaVersion!==2) return wait('verified remote recovery unavailable');
  if (task.state==='completed') return refuse('completed work cannot replay');
  if (!same(task.approvalBindings,recovery.approvalBindings)||task.taskKey!==recovery.taskKey||task.runId!==recovery.runId||task.generation!==recovery.generation||task.scopeDigest!==recovery.scopeDigest||task.approvalDigest!==recovery.approvalDigest) return refuse('recovery task identity differs');
  try { recovery.approvalBindings.forEach(localApprovalBinding); } catch { return refuse('canonical authority unavailable'); }
  if (!policy?.current || !same(policy.approvalBindings,recovery.approvalBindings)) return wait('fresh canonical authority and policy required');
  if (!targetMachine?.registered || !same(targetMachine.execution,recovery.execution)) return refuse('original qualified execution identity unavailable');
  if (!stopProof || !['process-exit','verified-reboot','operator-confirmed'].includes(stopProof.kind)) return wait('verified stop proof required');
  if (stopProof.machineId!==task.machineId||stopProof.installationId!==task.installationId||stopProof.sessionId!==task.sessionId||stopProof.generation!==task.generation||!stopProof.runIds?.includes(task.runId)) return refuse('stop proof owner or generation differs');
  if (!policy.ownerMachine || stopProof.hostBindingDigest!==policy.ownerMachine.hostBindingDigest || stopProof.sessionId===policy.ownerMachine.sessionId && stopProof.bootIdDigest!==policy.ownerMachine.bootIdDigest) return refuse('stop proof host or boot differs');
  if (!checkpoint || !same(checkpoint,task.checkpoint)||!same(checkpoint,recovery.checkpoint)||checkpoint.runId!==task.runId||checkpoint.scopeDigest!==task.scopeDigest||checkpoint.repo!==task.repo) return wait('exact available checkpoint required');
  if (!['qualified-managed-only','reconciled'].includes(recovery.remoteEffectCoverage?.kind)) return wait('remote effect coverage unresolved');
  const effects=[...(recovery.effects??[]),...(pendingEffects??[])];
  if (effects.some(row=>row.kind!=='telemetry-push'&&!['acknowledged','cancelled-before-send'].includes(row.state))) return wait('blocking remote effects unresolved');
  if (recovery.joins?.some(row=>row.state!=='accepted')) return wait('parent child integration unresolved');
  return {action:targetMachine.machineId===task.machineId&&targetMachine.installationId===task.installationId&&targetMachine.sessionId===task.sessionId?'resume-original':'transfer',reason:'verified-recovery-predicates'};
}
const stoppedGroupBinding = task => ({taskKey:task.taskKey,runId:task.runId,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId});
const stoppedGroupCandidate = task => ({host:task.host,repo:task.repo,issue:task.issue,repositoryNodeId:task.repositoryNodeId,issueNodeId:task.issueNodeId,scopeDigest:task.scopeDigest,approvalDigest:task.approvalDigest,approvalBindings:task.approvalBindings,runId:task.runId,stage:task.stage,paths:task.paths,resources:task.resources,independent:task.independent,parentTaskKey:task.parentTaskKey,parentBinding:task.parentBinding??null,approvedTaskIds:task.approvedTaskIds});
export function evaluateStoppedGroupRecovery(input) {
  const refuse=reason=>({action:'refuse',reason,request:null}),wait=reason=>({action:'wait',reason,request:null});
  if(!input||typeof input!=='object'||Array.isArray(input))return refuse('stopped group recovery input unavailable');
  const {operationId,expectedHead,parentTaskKey,groupPlan,groupsDigest,approvedGroups,members}=input;
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operationId)||!sha.test(expectedHead)||!digest.test(parentTaskKey)||!digest.test(groupsDigest)||groupPlan?.kind!=='plan'||!digest.test(groupPlan.digest))return refuse('stopped group recovery identity unavailable');
  if(!Array.isArray(approvedGroups)||!approvedGroups.length||!Array.isArray(members)||members.length!==approvedGroups.length+1)return refuse('complete approved stopped group required');
  if(hash(canonicalRecovery(approvedGroups))!==groupsDigest)return refuse('stopped group digest differs from approved groups');
  const expectedChildren=approvedGroups.map(group=>({issue:Number(/^#([1-9]\d*)$/.exec(group?.members?.length===1?group.members[0]:'')?.[1]),files:group?.files}));
  if(expectedChildren.some(row=>!Number.isSafeInteger(row.issue)||row.issue<=0||!Array.isArray(row.files)||!row.files.length||!unique(row.files)))return refuse('approved stopped group declaration unavailable');
  if(!unique(members.map(row=>row?.task?.taskKey))||!unique(members.map(row=>row?.task?.runId))||!unique(members.map(row=>row?.task?.issue)))return refuse('stopped group members must be unique');
  const parent=members.find(row=>row?.task?.taskKey===parentTaskKey);
  if(!parent||parent.task.parentTaskKey!==null||parent.task.parentBinding!=null)return refuse('one top-level stopped group parent required');
  const childIssues=members.filter(row=>row!==parent).map(row=>row.task.issue).sort((a,b)=>a-b),approvedIssues=expectedChildren.map(row=>row.issue).sort((a,b)=>a-b);
  if(!same(childIssues,approvedIssues))return refuse('stopped group omitted or added an approved child');
  for(const row of members){
    const task=row?.task,recovery=task?.recovery,verification=row?.verification;
    if(!row||Object.keys(row).sort().join(',')!=='candidate,expected,stateCommit,task,verification')return refuse('unknown or missing stopped group member field');
    if(!task||row.stateCommit!==expectedHead)return refuse('stopped group members do not share the expected head');
    if(!['stopped','blocked'].includes(task.state)||!task.stopProof)return wait('every stopped group member needs verified stop evidence');
    if(task.schemaVersion!==1&&task.schemaVersion!==2)return refuse('unsupported stopped group task schema');
    if(!recovery||recovery.schemaVersion!==2)return refuse('unsupported stopped group recovery schema');
    if(!same(row.expected,stoppedGroupBinding(task))||!same(row.candidate,stoppedGroupCandidate(task)))return refuse('stopped group owner or candidate changed');
    if(task.taskKey!==recovery.taskKey||task.runId!==recovery.runId||task.generation!==recovery.generation||task.scopeDigest!==recovery.scopeDigest||task.approvalDigest!==recovery.approvalDigest||!same(task.approvalBindings,recovery.approvalBindings))return refuse('stopped group recovery identity differs');
    const checkpoint=task.checkpoint,stop=task.stopProof;
    if(!checkpoint||!same(checkpoint,recovery.checkpoint)||checkpoint.runId!==task.runId||checkpoint.repo!==task.repo||checkpoint.scopeDigest!==task.scopeDigest)return wait('exact stopped group checkpoint unavailable');
    if(stop.machineId!==task.machineId||stop.installationId!==task.installationId||stop.sessionId!==task.sessionId||stop.generation!==task.generation||!stop.runIds?.includes(task.runId))return refuse('stopped group stop owner or generation differs');
    if(task.parentTaskKey!==null){
      if(task.parentTaskKey!==parentTaskKey||!same(task.parentBinding,stoppedGroupBinding(parent.task)))return refuse('stopped group child original parent differs');
      const approved=expectedChildren.find(group=>group.issue===task.issue);
      if(!approved||!same(task.paths,approved.files))return refuse('stopped group child scope differs from approved group');
    }
    const verified=['source','authority','checkpoint','stop','execution','effects','history','launch','check','join'];
    if(!verification||Object.keys(verification).sort().join(',')!==[...verified].sort().join(',')||verified.some(key=>verification[key]!==true))return wait('complete stopped group verification unavailable');
    if(recovery.remoteEffectCoverage?.kind==='unmanaged-possible'||[...(recovery.effects??[])].some(effect=>effect.kind!=='telemetry-push'&&!['acknowledged','cancelled-before-send'].includes(effect.state)))return wait('stopped group blocking effects unresolved');
    if((recovery.joins??[]).some(join=>!['accepted','prepared'].includes(join.state)))return refuse('stopped group join history is not recoverable');
  }
  const request={schemaVersion:1,kind:'recover-stopped-group',operationId,expectedHead,parentTaskKey,groupPlan,groupsDigest,members:members.map(({expected,candidate})=>({expected:structuredClone(expected),candidate:structuredClone(candidate)})).sort((a,b)=>a.expected.taskKey.localeCompare(b.expected.taskKey))};
  return {action:'recover-stopped-group',reason:'verified-complete-stopped-group',request};
}
// The provider reader is transport, not a cached approval verdict. Re-read old
// authoritative comments too: cursor filtering alone misses edited old records.
export async function readRecoverySources(packet,{readJson,operators,checkout,readCompletionEvidence,consolidatedRequest}) {
  validateRecoveryPacket(packet);
  const prefix='repos/'+packet.repo+'/issues/'+packet.issue;
  const brief=await readJson(['api',prefix]);
  const comments=await readPages(readJson,['api',prefix+'/comments']);
  const sourceComments=await readApprovalSources(comments,readJson);
  const approval=consolidatedRequest ? await gatherConsolidatedApproval({...consolidatedRequest,operators,readJson}) : evaluateApprovals({repo:packet.repo,issue:packet.issue,brief,comments,sourceComments,operators,requiredScope:'brief+plan'});
  const plan=comments.find(row=>row.node_id===packet.planRef.artifactId);
  const ref=(value,kind)=>value?{repo:packet.repo,issue:packet.issue,kind,artifactId:value.node_id,rev:Number(/\brev=(\d+)/.exec(value.body)?.[1]),digest:scopeDigest(value.body,kind)}:null;
  const git=args=>{const result=spawnSync('git',args,{cwd:checkout,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});return result.status===0&&!result.error;};
  const verifiedCompleted=[];
  for (const row of packet.completed) if (git(['cat-file','-e',row.headSha+'^{commit}'])&&git(['merge-base','--is-ancestor',row.headSha,packet.lastVerifiedCommit])&&await readCompletionEvidence(row,packet)) verifiedCompleted.push(row);
  return {historyComplete:true,approval,comments,operators,briefRef:ref(brief,'brief'),planRef:ref(plan,'plan'),taskIds:[...(plan?.body??'').matchAll(/<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->/g)].map(match=>match[1]),verifiedCompleted,verifiedCommit:git(['merge-base','--is-ancestor',packet.lastVerifiedCommit,'HEAD'])?packet.lastVerifiedCommit:null};
}

// A task's approved Interfaces/Consumes sentence defines its preparation
// prerequisites. Ambiguous prose refuses instead of falling back to the issue's
// full blocker list or caller-provided prerequisite counts.
export function preparationTaskContracts(planBody, ids, selectedFiles) {
  const rows=[...planBody.matchAll(/^-\s*\[[ x]\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->.*$/gim)];
  if(!unique(ids)||!ids.length)throw Error('exact preparation task IDs required');
  return ids.map(id=>{
    const index=rows.findIndex(row=>row[1]===id);
    if(index<0||rows.filter(row=>row[1]===id).length!==1)throw Error('preparation task missing or duplicate');
    const section=planBody.slice(rows[index].index,rows[index+1]?.index??planBody.length);
    const interfaces=/^\s*- Interfaces\s*[—–-]\s*(.*)$/m.exec(section)?.[1];
    if(!interfaces||!new RegExp('Preparation(?: task)?\\s*'+id.replace('-','\\-')+'\\b','i').test(interfaces))throw Error('task is not explicitly preparation');
    const consumes=/\bConsumes\s+(.+?)(?:\.\s+Produces|;\s*produces|$)/i.exec(interfaces)?.[1]??'';
    let prerequisites=[...consumes.matchAll(/#([1-9]\d*)\b/g)].map(row=>Number(row[1]));
    if(!prerequisites.length){
      const sentence=planBody.split(/\n\n/).find(part=>part.includes(id)&&/approved preparation with satisfied/.test(part));
      prerequisites=[...(sentence??'').matchAll(/satisfied\s+#([1-9]\d*)\s+code-contract/g)].map(row=>Number(row[1]));
    }
    if(!prerequisites.length)throw Error('approved preparation prerequisite mapping unavailable');
    const files=selectedFiles(planBody,[id]);
    if(!files.length)throw Error('approved preparation files unavailable');
    return {id,files,prerequisiteIssues:[...new Set(prerequisites)]};
  });
}
export function evaluatePreparation({parentApproval,childApproval,taskIds,taskPrerequisites,current}) {
  const blocks=[];
  if(!parentApproval?.ok||parentApproval.blocks?.length||!childApproval?.preparation||childApproval.blocks?.length)blocks.push('fresh evaluated preparation scope required');
  const expected=childApproval?.preparation, binding=expected?.approvalBinding;
  if(!binding||!same(childApproval.approvalBindings,[binding])||!same(childApproval.approvalIds,[binding.approvalId])||!same(parentApproval.approvalBindings,[binding]))blocks.push('canonical preparation authority differs');
  if(!unique(taskIds)||!taskIds.length||!same(taskIds,expected?.taskIds)||!same(taskPrerequisites?.approvalBinding,binding)||!same(taskPrerequisites?.parent,expected?.parent)||!same(taskPrerequisites?.plan,expected?.plan)||!same(taskPrerequisites?.tasks,expected?.tasks))blocks.push('exact preparation task contract differs');
  if(!current?.ownership||!current?.policyCurrent)blocks.push('preparation ownership or current policy unavailable');
  if(!Array.isArray(expected?.pendingEffects)||expected.pendingEffects.length)blocks.push('accepted preparation prerequisites unresolved');
  if(current?.operation&&!['edit','check','review','integrate'].includes(current.operation))blocks.push('preparation does not grant live operations');
  return {blocks,warns:[],mode:'preparation',approvalBindings:childApproval?.approvalBindings??[],recordBinding:childApproval?.recordBinding??null,taskIds:blocks.length?[]:taskIds};
}


export function readBoundedRecoveryInput(stream=process.stdin,maxBytes=65536,timeoutMs=350) {
 return new Promise((resolveInput,reject)=>{
  let bytes=0,finished=false;const chunks=[];
  const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);stream.removeListener('data',data);stream.removeListener('end',end);stream.removeListener('error',failed);stream.pause();if(error)reject(error);else{try{resolveInput(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch(error){reject(error);}}};
  const data=chunk=>{const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=value.length;if(bytes>maxBytes)done(Error('recovery input exceeds bound'));else chunks.push(value);};
  const end=()=>done(),failed=error=>done(error),timer=setTimeout(()=>done(Error('recovery input deadline exceeded')),timeoutMs);
  stream.on('data',data).once('end',end).once('error',failed);
 });
}

// The packaged dispatcher owns processes/private records. This helper never
// imports TypeScript source or accepts an arbitrary check command.
export function taskCheckpointArguments({runId,taskId: id,write=false}) {
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)||!taskId.test(id))throw Error('exact task checkpoint identities required');
 return ['dispatch','--checkpoint-task',id,'--run-id',runId,...(write?['--once']:['--dry-run']),'--json'];
}

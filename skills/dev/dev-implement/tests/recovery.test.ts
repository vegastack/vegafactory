import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { compareTaskIds, chooseResumeAction, isPreparationSubset, reconcileRecovery } from '../scripts/recovery.mjs'

test('equal counts cannot prove task completion', () => {
  expect(compareTaskIds(['144-T1','144-T2'], ['144-T1','144-T3'])).toEqual({ missing: ['144-T2'], unknown: ['144-T3'] })
})
test('delivery pending does not rerun completed work', () => {
  expect(chooseResumeAction({outstandingTaskIds:[],pendingDelivery:['event-1'],blocks:[]})).toEqual({action:'retry-delivery',taskIds:[],reason:'pending-delivery'})
  expect(isPreparationSubset(['156-T1','156-T2'], {preparation:['156-T1'],live:['156-T2']})).toBe(false)
})
test('unsupported saved authority cannot resume', () => {
  expect(reconcileRecovery({schemaVersion:2}, {}).blocks.length).toBeGreaterThan(0)
})
test('real completed commit is preserved when an interrupted subprocess resumes outstanding work', () => {
  const cwd=mkdtempSync(join(tmpdir(),'vsk-recovery-'))
  const git=(...args:string[])=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});expect(r.status).toBe(0);return r.stdout.trim()}
  git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.test')
  writeFileSync(join(cwd,'task1'),'complete');git('add','task1');git('commit','-qm','T1');const head=git('rev-parse','HEAD')
  const killed=spawnSync(process.execPath,['-e',"process.kill(process.pid, 'SIGTERM')"],{cwd});expect(killed.signal).toBe('SIGTERM')
  const decision=chooseResumeAction({outstandingTaskIds:['144-T2'],pendingDelivery:[],blocks:[]})
  expect(decision.taskIds).toEqual(['144-T2']); expect(git('rev-parse','HEAD')).toBe(head)
  expect(git('rev-list','--count','HEAD')).toBe('1')
})

import {createHash} from 'node:crypto'
import {readRecoverySources,evaluateSharedRecovery} from '../scripts/recovery.mjs'
import {scopeDigest} from '../scripts/lib/approval.mjs'
function sourceFixture(){
 const cwd=mkdtempSync(join(tmpdir(),'vsk-recovery-source-'))
 const git=(...args:string[])=>{const result=spawnSync('git',args,{cwd,encoding:'utf8'});if(result.status!==0)throw Error(result.stderr);return result.stdout.trim()}
 git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.test');writeFileSync(join(cwd,'first'),'one');git('add','.');git('commit','-qm','verified first task');const head=git('rev-parse','HEAD')
 const brief={number:144,node_id:'brief144',body:'<!-- vsk:v1 type=brief rev=1 scope=full-plan -->\nAn approved task.',title:'current title'}
 const plan={id:2,node_id:'plan144',body:'<!-- vsk:v1 type=plan rev=1 -->\n- [x] **Task 1** <!-- task-id:144-T1 -->\n- [ ] **Task 2** <!-- task-id:144-T2 -->',updated_at:'2026-09-08T01:00:00Z'}
 const refs=[{repo:'o/r',issue:144,kind:'brief',artifactId:brief.node_id,rev:1,digest:scopeDigest(brief.body,'brief')},{repo:'o/r',issue:144,kind:'plan',artifactId:plan.node_id,rev:1,digest:scopeDigest(plan.body,'plan')}]
 const approval={id:3,user:{login:'operator'},updated_at:'2026-09-08T01:01:00Z',body:'<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n'+JSON.stringify({schemaVersion:2,id:'approved',operator:'operator',scope:'brief+plan',source:{kind:'session',ref:'session:test',quote:'Approved these tasks.'},artifacts:refs,supersedes:[],revokes:[]})+'\n```'}
 const wire={approvalId:'approved',source:{kind:'github-comment',repositoryId:'R_repo',issueNodeId:'I_144',commentId:'3',bodySha256:createHash('sha256').update(approval.body).digest('hex')}}
 const completed={taskId:'144-T1',headSha:head,evidenceUrl:'fixture://accepted-first'}
 const packet={schemaVersion:3,repo:'o/r',issue:144,briefRef:refs[0],planRef:refs[1],approvalIds:['approved'],approvalBindings:[wire],recordBinding:null,taskIds:['144-T1','144-T2'],completed:[completed],lastVerifiedCommit:head,openFindings:[],rulings:[],commentCursor:{id:'3',updatedAt:approval.updated_at},pendingRunIds:['unfinished'],learning:[]}
 let comments:any[]=[plan,approval];const reads:string[]=[]
 const readJson=async(args:string[])=>{reads.push(args[1]!);if(args[1]==='repos/o/r/issues/144')return brief;if(args[1]==='repos/o/r/issues/144/comments')return [comments];throw Error('unexpected provider read')}
 const current=()=>readRecoverySources(packet,{readJson,operators:['operator'],checkout:cwd,readCompletionEvidence:async(row:any)=>row.evidenceUrl===completed.evidenceUrl&&row.headSha===head})
 return {cwd,git,head,packet,plan,approval,brief,reads,current,setComments:(rows:any[])=>comments=rows}
}
test('fresh full sources preserve task1 and inspect a later operator constraint',async()=>{
 const f=sourceFixture();const initial=reconcileRecovery(f.packet,await f.current());expect(initial.blocks).toEqual([]);expect(initial.outstandingTaskIds).toEqual(['144-T2'])
 f.setComments([f.plan,f.approval,{id:4,user:{login:'operator'},updated_at:'2026-09-08T01:02:00Z',body:'Keep the existing caller contract in task two.'}])
 const changed=reconcileRecovery(f.packet,await f.current());expect(changed.blocks.join()).toContain('instruction requires reconciliation: 4');expect(changed.sourceRefs.some((row:any)=>row.id==='4')).toBe(true);expect(f.git('rev-list','--count','HEAD')).toBe('1')
})
test('edited old canonical source and deleted ancestry block without rewriting prior packet',async()=>{
 const f=sourceFixture(),before=JSON.stringify(f.packet)
 f.approval.body+='\nChanged approval source.'
 expect(reconcileRecovery(f.packet,await f.current()).blocks.join()).toContain('canonical approval changed')
 expect(JSON.stringify(f.packet)).toBe(before)
 f.git('checkout','--orphan','replacement');f.git('rm','-f','first');writeFileSync(join(f.cwd,'second'),'unrelated');f.git('add','.');f.git('commit','-qm','new unrelated source')
 expect(reconcileRecovery(f.packet,await f.current()).blocks.join()).toContain('ancestry')
})
test('incomplete source pages and unknown packet keys are refused',async()=>{
 const f=sourceFixture()
 await expect(readRecoverySources(f.packet,{readJson:async()=>[],operators:['operator'],checkout:f.cwd,readCompletionEvidence:async()=>false})).rejects.toThrow()
 expect(reconcileRecovery({...f.packet,nativeMemory:'not allowed'},{}).blocks.join()).toContain('unknown')
})
test('shared recovery preserves nonblocking telemetry but rejects identity, effects, coverage and checkpoint gaps',()=>{
 const f=sourceFixture(),binding=f.packet.approvalBindings,checkpoint={repo:'o/r',runId:'run',scopeDigest:'scope',headSha:f.head}
 const task={state:'stopped',taskKey:'task',runId:'run',generation:2,scopeDigest:'scope',approvalDigest:'digest',repo:'o/r',machineId:'old',installationId:'install',sessionId:'session',approvalBindings:binding,checkpoint}
 const execution={providerMode:'subscription',harness:'codex',model:'same',effort:'high',accountRef:'same-account'}
 const recovery={schemaVersion:2,taskKey:'task',runId:'run',generation:2,scopeDigest:'scope',approvalDigest:'digest',approvalBindings:binding,checkpoint,execution,remoteEffectCoverage:{kind:'qualified-managed-only'},effects:[{kind:'telemetry-push',state:'ambiguous'}],joins:[]}
 const stopProof={kind:'process-exit',machineId:'old',installationId:'install',sessionId:'session',hostBindingDigest:'host',bootIdDigest:'boot',generation:2,runIds:['run']}
 const input={task,recovery,checkpoint,stopProof,targetMachine:{registered:true,machineId:'new',installationId:'other',sessionId:'new-session',execution},policy:{current:true,approvalBindings:binding,ownerMachine:{hostBindingDigest:'host',bootIdDigest:'boot',sessionId:'session'}},pendingEffects:[]}
 expect(evaluateSharedRecovery(input).action).toBe('transfer')
 expect(evaluateSharedRecovery({...input,checkpoint:null}).action).toBe('wait')
 expect(evaluateSharedRecovery({...input,stopProof:{...stopProof,generation:1}}).action).toBe('refuse')
 expect(evaluateSharedRecovery({...input,stopProof:{...stopProof,hostBindingDigest:'copied'}}).action).toBe('refuse')
 expect(evaluateSharedRecovery({...input,targetMachine:{...input.targetMachine,execution:{...execution,accountRef:'other'}}}).action).toBe('refuse')
 expect(evaluateSharedRecovery({...input,recovery:{...recovery,remoteEffectCoverage:{kind:'unmanaged-possible'}}}).action).toBe('wait')
 expect(evaluateSharedRecovery({...input,pendingEffects:[{kind:'handback',state:'ambiguous'}]}).action).toBe('wait')
})

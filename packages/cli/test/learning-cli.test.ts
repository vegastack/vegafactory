import {expect,test} from 'bun:test'
import {mkdtemp,mkdir,writeFile,readFile,realpath,cp,utimes,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {randomUUID,createHash} from 'node:crypto'
import {createRun,readRun,runsRoot,updateRun,atomicRunFile,type RunInput} from '../src/runs.ts'
import {executeRun} from '../src/dispatch.ts'
import {sourceCheck} from '../src/children.ts'
import {checkpointLessons,inspectLessons,revertLesson,runLearningCli,stageLesson,type Lesson} from '../src/learning.ts'
import {parseFactoryConfig} from '../src/config.ts'
import {loadSnapshotPolicy} from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import {scopeDigest} from '../../../skills/dev/dev-implement/scripts/lib/approval.mjs'
const wrapper=resolve('packages/cli/src/run-wrapper.ts')
function git(cwd:string,...args:string[]){const result=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}});if(result.status!==0)throw Error(result.stderr);return result.stdout.trim()}
async function fixture(options:{measurement?:boolean}={}){
 const home=await realpath(await mkdtemp(join(tmpdir(),'vf-learning-'))),tree=join(home,'repo'),room=join(home,'room')
 await mkdir(join(tree,'.vegastack'),{recursive:true});await mkdir(join(tree,'docs'));await mkdir(join(room,'groups/dev'),{recursive:true});await mkdir(join(home,'.vegastack'),{mode:0o700})
 const command=options.measurement?'sleep "$(cat docs/lesson.md)"':'test "$(cat docs/lesson.md)" = improved',devMd='repo: a/r\ncontrol-room: a/room#dev\nsync-max-age: 2h\ncommands: check `'+command+'`\n'
 await writeFile(join(tree,'.vegastack/dev.md'),devMd);await writeFile(join(tree,'docs/lesson.md'),options.measurement?'1\n':'before\n');await writeFile(join(tree,'unrelated'),'retained\n')
 git(tree,'init','-b','feat/lesson');git(tree,'remote','add','origin','https://github.com/a/r.git');git(tree,'add','.');git(tree,'commit','-m','baseline');const base=git(tree,'rev-parse','HEAD')
 await writeFile(join(room,'org.md'),'stats: on\nlearning: normal-work\nlearning-adoption: scoped-reversible\nsync-max-age: 2h\n');await writeFile(join(room,'groups/dev/group.md'),'review: subagent\n')
 await writeFile(join(room,'repos.md'),'| repo | group | owner | repository-id |\n|---|---|---|---|\n| a/r | dev | robot | R_app |\n');await writeFile(join(room,'people.csv'),'login,name,role,slack,timezone,groups\nrobot,Robot,member,,UTC,dev\n')
 git(room,'init','-b','main');git(room,'remote','add','origin','https://github.com/a/room.git');git(room,'add','.');git(room,'commit','-m','policy')
 const snapshot={schemaVersion:2,org:'a',group:'dev',repository:'a/room',origin:'https://github.com/a/room.git',sourceCommit:git(room,'rev-parse','HEAD'),policyDigest:'0'.repeat(64),validatedAt:new Date().toISOString(),contentPath:room}
 snapshot.policyDigest=loadSnapshotPolicy({snapshot,repo:'a/r',devMd}).policy.policyDigest
 expect(loadSnapshotPolicy({snapshot,repo:'a/r',devMd}).ok).toBe(true)
 await writeFile(join(home,'.vegastack/factory.json'),JSON.stringify({schemaVersion:2,revision:1,repos:[{repo:'a/r',path:tree,org:'a'}],controlRooms:{a:{repo:'a/room',path:room,branch:'main',remote:snapshot.origin,lastSyncedAt:snapshot.validatedAt,sha:snapshot.sourceCommit,snapshots:{'a/r':snapshot}}}}),{mode:0o600})
 const planBody='<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: documentation** <!-- task-id:1-T1 -->\n  - Files — Modify: `docs/lesson.md`\n',briefBody='<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\nImprove documentation.'
 const refs=[{repo:'a/r',issue:1,kind:'brief' as const,artifactId:'I_brief',rev:1,digest:scopeDigest(briefBody,'brief')},{repo:'a/r',issue:1,kind:'plan' as const,artifactId:'IC_plan',rev:1,digest:scopeDigest(planBody,'plan')}]
 const authority={approvalId:'fixture',source:{kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_brief',commentId:'12',bodySha256:'a'.repeat(64)}}
 const runInput:RunInput={root:runsRoot(home),repo:'a/r',issue:1,parent:null,checkout:tree,branch:'feat/lesson',baseSha:base,headSha:base,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution:null,approvalBindings:[authority],recordBinding:null,approvalRefs:refs,policyDigest:snapshot.policyDigest,claimToken:randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'a/r',issue:1,taskId:'1-T1',scopeDigest:'c'.repeat(64)},approvedTaskIds:['1-T1'],activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,hostBindingDigest:(await import('../src/machine-identity.ts').then(owner=>owner.readHostBinding())).digest,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'controlled-local-fixture'}}
 let run=await createRun(runInput);const config=parseFactoryConfig({repos:[{repo:'a/r',org:'a',path:tree}]},home)
 const failed=await sourceCheck(run,command,config,undefined,{wrapperPath:wrapper},'lesson-before');expect(failed.ok).toBe(options.measurement===true);expect((await readRun(runsRoot(home),failed.checkRunId)).terminationCause).toBe(options.measurement?'succeeded':'failed')
 await writeFile(join(tree,'docs/lesson.md'),options.measurement?'0.01\n':'improved\n');git(tree,'add','docs/lesson.md');git(tree,'commit','-m','ordinary approved documentation improvement');const head=git(tree,'rev-parse','HEAD')
 run=await updateRun(runsRoot(home),run.runId,()=>({headSha:head}))
 const passed=await sourceCheck(run,command,config,undefined,{wrapperPath:wrapper},'lesson-after');expect(passed.ok).toBe(true)
 const lesson:Lesson={id:'lesson-'+randomUUID().replaceAll('-',''),repo:'a/r',taskId:'1-T1',scopeDigest:run.taskKey.scopeDigest,sourceSha:head,statement:'Check the exact source before using a recovered task result.',evidenceRefs:[{kind:'check',ref:'check:'+run.runId+':lesson-before',sha:base,passed:false},{kind:'check',ref:'check:'+run.runId+':lesson-after',sha:head,passed:true}],targetPaths:['docs/lesson.md'],undoRef:'git:'+head,state:'validated',supersedes:[]}
 const packet={schemaVersion:3,repo:'a/r',issue:1,briefRef:refs[0],planRef:refs[1],approvalIds:['fixture'],approvalBindings:[authority],recordBinding:null,taskIds:['1-T1'],completed:[],lastVerifiedCommit:head,openFindings:[],rulings:[],commentCursor:{id:'12',updatedAt:new Date().toISOString()},pendingRunIds:[run.runId],learning:[lesson]}
 await atomicRunFile(join(runsRoot(home),run.runId,'recovery.json'),packet);await atomicRunFile(join(runsRoot(home),run.runId,'recovery-source.json'),{schemaVersion:1,planRef:refs[1],planBody})
 await mkdir(join(home,'.claude'),{mode:0o700});await mkdir(join(home,'.codex'),{mode:0o700});await writeFile(join(home,'.claude','MEMORY.md'),'CLAUDE_NATIVE_CANARY');await writeFile(join(home,'.codex','memory.md'),'CODEX_NATIVE_CANARY')
 return {home,tree,room,run,lesson,packet,head,base,config,runInput}
}
test('real failed then passed source checks qualify one bounded lesson and exact undo preserves unrelated edits',async()=>{
 const f=await fixture();await atomicRunFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),{...f.packet,learning:[]});expect(await stageLesson(f.home,f.run,f.lesson)).toEqual({id:f.lesson.id,state:'validated'});const result=await checkpointLessons(f.home,f.run);expect(result.adopted).toEqual([f.lesson.id]);expect((await inspectLessons(f.home,f.run))[0]?.statement).toBe(f.lesson.statement)
 expect((await checkpointLessons(f.home,f.run)).adopted).toEqual([]);expect((await inspectLessons(f.home,f.run))).toHaveLength(1)
 await writeFile(join(f.tree,'unrelated'),'unrelated user change\n')
 expect(await revertLesson(f.home,f.run,f.lesson.id,false)).toMatchObject({applied:false});expect(await readFile(join(f.tree,'docs/lesson.md'),'utf8')).toBe('improved\n')
 expect(await revertLesson(f.home,f.run,f.lesson.id,true)).toMatchObject({applied:true});expect(await readFile(join(f.tree,'docs/lesson.md'),'utf8')).toBe('before\n');expect(await readFile(join(f.tree,'unrelated'),'utf8')).toBe('unrelated user change\n')
 expect(await inspectLessons(f.home,f.run)).toEqual([])
 expect(await readFile(join(f.home,'.claude/MEMORY.md'),'utf8')).toBe('CLAUDE_NATIVE_CANARY');expect(await readFile(join(f.home,'.codex/memory.md'),'utf8')).toBe('CODEX_NATIVE_CANARY')
},30000)
test('forged check references, foreign scope and source drift cannot become reused context',async()=>{
 const f=await fixture();f.packet.learning[0]!.evidenceRefs[1]!.ref='check:'+randomUUID()+':lesson-after';await atomicRunFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),f.packet)
 expect((await checkpointLessons(f.home,f.run)).adopted).toEqual([])
 await atomicRunFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),{...f.packet,repo:'foreign/repo'})
 await expect(inspectLessons(f.home,f.run)).rejects.toThrow(/artifact|authority/)
 f.lesson.evidenceRefs[1]!.ref='check:'+f.run.runId+':lesson-after';f.lesson.state='validated'
 await atomicRunFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),{...f.packet,learning:[f.lesson]})
 expect((await checkpointLessons(f.home,f.run)).adopted).toEqual([f.lesson.id])
 await writeFile(join(f.tree,'unrelated'),'source drift');git(f.tree,'add','unrelated');git(f.tree,'commit','-m','changed source')
 expect(await inspectLessons(f.home,f.run)).toEqual([])
},30000)
test('normal learning CLI refuses outside an owned session before any change',async()=>{
 const f=await fixture();const before=await readFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),'utf8')
 expect(await runLearningCli(['revert','--run-id',f.run.runId,'--id',f.lesson.id,'--apply','--json'],f.home)).toBe(2)
 expect(await readFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),'utf8')).toBe(before)
},30000)

test('actual installed index routes owned SessionStart to verified lessons',async()=>{
 const f=await fixture(),installed=join(f.home,'installed'),hooks=join(f.tree,'.vegastack/hooks')
 await checkpointLessons(f.home,f.run)
 // Controlled local session: actual owned wrapper identity and terminal state,
 // without a vendor/platform qualification claim.
 const outcome=await executeRun({repo:'a/r',issue:1,title:'controlled session',stage:'implement',commentId:null,reactionId:null},{command:process.execPath,args:['-e','process.stdout.write("controlled-session")'],cwd:f.tree,env:{},prompt:''},f.config,{operator:null},{preparedRun:f.run,runInput:{...f.run,root:runsRoot(f.home)},wrapperPath:wrapper})
 expect(outcome.terminationCause).toBe('succeeded')
 const run=await updateRun(runsRoot(f.home),f.run.runId,()=>({vendorSessionId:'controlled-session'}))
 expect(run.processIdentity).not.toBeNull()
 await mkdir(join(installed,'dist'),{recursive:true});await mkdir(hooks,{recursive:true})
 for(const skill of ['dev-implement','dev-plan','dev-setup'])await cp(resolve('skills/dev/'+skill+'/scripts'),join(installed,'skill',skill,'scripts'),{recursive:true})
 await cp(resolve('skills/dev/dev-setup/scripts/effective-policy.mjs'),join(installed,'skill/dev-implement/scripts/effective-policy.mjs'))
 await mkdir(join(installed,'skill/dev-setup/assets/hooks'),{recursive:true})
 for(const name of ['session-start.mjs','session-end.mjs','stop-heartbeat.mjs'])await cp(resolve('skills/dev/dev-setup/assets/hooks/'+name),join(hooks,name))
 const shared=await readFile(join(hooks,'session-start.mjs'));await writeFile(join(installed,'skill/dev-setup/assets/hooks/session-start.mjs'),shared)
 await writeFile(join(installed,'package.json'),JSON.stringify({name:'@vegastack/vegafactory',version:'0.18.0',type:'module',bin:{vegafactory:'dist/index.js'}}))
 await writeFile(join(installed,'skill-integrity.json'),JSON.stringify({schemaVersion:2,skills:{'dev-setup':{files:{'assets/hooks/session-start.mjs':createHash('sha256').update(shared).digest('hex')}}}}))
 const built=await Bun.build({entrypoints:[resolve('packages/cli/src/index.ts')],outdir:join(installed,'dist'),target:'node',naming:'index.js'})
 expect(built.success,JSON.stringify(built.logs)).toBe(true)
 const invoke=(event:string,session='controlled-session',cwd=f.tree)=>spawnSync('node',[join(hooks,event==='SessionStart'?'session-start.mjs':event==='Stop'?'stop-heartbeat.mjs':'session-end.mjs'),'--harness','codex'],{encoding:'utf8',cwd:f.tree,input:JSON.stringify({session_id:session,cwd,hook_event_name:event}),env:{...process.env,HOME:f.home,VSK_VEGAFACTORY:join(installed,'dist/index.js')},timeout:2000})
 const indexes=[join(f.tree,'.git/index'),join(f.room,'.git/index')]
 const untouched=await Promise.all(indexes.map(async path=>({path,bytes:await readFile(path),mtime:(await stat(path)).mtimeMs})))
 // Force stale tracked-file stat caches. Read-only hook validation must not
 // refresh either Git index as a side effect of policy/source inspection.
 const touched=new Date(Date.now()+2000)
 await utimes(join(f.tree,'docs/lesson.md'),touched,touched);await utimes(join(f.room,'org.md'),touched,touched)
 expect(invoke('SessionStart','foreign-session').stdout).toBe('')
 const start=invoke('SessionStart');expect(start.status).toBe(0)
 for(const prior of untouched){expect(await readFile(prior.path)).toEqual(prior.bytes);expect((await stat(prior.path)).mtimeMs).toBe(prior.mtime)}
 // A separate controlled terminal record exercises the EXISTING143 capture
 // consumer through this compiled index. It is not vendor qualification.
 const captureInput={...f.runInput,headSha:f.head,execution:{providerMode:'subscription' as const,harness:'codex' as const,harnessVersion:'controlled-fixture',model:'fixture',effort:'high',accountRef:'controlled-account',qualification:f.run.approvalBindings[0]!.source},accountRef:'controlled-account'}
 const captureRun=await createRun(captureInput)
 const captureOutcome=await executeRun({repo:'a/r',issue:1,title:'controlled capture',stage:'implement',commentId:null,reactionId:null},{command:process.execPath,args:['-e','process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"capture-session"})+"\\n")'],cwd:f.tree,env:{},prompt:''},f.config,{operator:null},{preparedRun:captureRun,runInput:captureInput,wrapperPath:wrapper,gh:async()=>{throw Error('controlled fixture forbids network')}})
 expect(captureOutcome.terminationCause).toBe('succeeded')
 const captured=await readRun(runsRoot(f.home),captureRun.runId)
 expect(captured.vendorSessionId).toBe('capture-session')
 expect(captured.pendingDelivery.find(row=>row.kind==='telemetry-capture')?.payload).toBeDefined()
 expect(invoke('Stop','capture-session').stdout).toBe('');expect(invoke('SessionEnd','capture-session').stdout).toBe('')
 const spool=await import('../src/stats/outbox.ts')
 expect((await spool.inspectSpool(spool.spoolRoot(f.home))).events).toHaveLength(1)
 expect((await readRun(runsRoot(f.home),captured.runId)).pendingDelivery.find(row=>row.kind==='telemetry-capture')?.status).toBe('acknowledged')
 expect(start.stdout).toContain(f.lesson.statement)
 expect(start.stdout).not.toContain('NATIVE_CANARY')
 expect(invoke('Stop').stdout).toBe('');expect(invoke('SessionEnd').stdout).toBe('')
 expect(await readFile(join(f.home,'.claude/MEMORY.md'),'utf8')).toBe('CLAUDE_NATIVE_CANARY')
 expect(await readFile(join(f.home,'.codex/memory.md'),'utf8')).toBe('CODEX_NATIVE_CANARY')
},60000)


test('working-tree drift and native-memory targets cannot enter lesson context',async()=>{
 const f=await fixture();await checkpointLessons(f.home,f.run)
 await writeFile(join(f.tree,'docs/lesson.md'),'uncommitted source drift\n')
 await expect(inspectLessons(f.home,f.run)).rejects.toThrow('source-drift')
 await expect(stageLesson(f.home,f.run,{...f.lesson,id:'lesson-'+randomUUID().replaceAll('-',''),targetPaths:['.claude/MEMORY.md'],state:'observed'})).rejects.toThrow('reversible lesson')
 expect(await readFile(join(f.home,'.claude/MEMORY.md'),'utf8')).toBe('CLAUDE_NATIVE_CANARY')
},30000)


test('measured improvement comes from actual ordinary check elapsed records',async()=>{
 const f=await fixture({measurement:true})
 f.lesson.evidenceRefs=f.lesson.evidenceRefs.map(ref=>({...ref,kind:'measurement' as const,ref:ref.ref.replace(/^check:/,'measurement:'),passed:true}))
 await atomicRunFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),{...f.packet,learning:[]})
 expect(await stageLesson(f.home,f.run,f.lesson)).toEqual({id:f.lesson.id,state:'validated'})
 expect((await checkpointLessons(f.home,f.run)).adopted).toEqual([f.lesson.id])
 expect((await inspectLessons(f.home,f.run))[0]?.id).toBe(f.lesson.id)
},30000)

test('later Claude and Codex runs reuse only equivalent approved local lesson context',async()=>{
 const f=await fixture();await checkpointLessons(f.home,f.run)
 for(const harness of ['claude','codex']){
  const next=await createRun({...f.runInput,harness,headSha:f.head,claimToken:randomUUID(),startedAt:new Date().toISOString()})
  expect((await inspectLessons(f.home,next)).map(row=>row.id)).toEqual([f.lesson.id])
  const changed=await createRun({...f.runInput,harness,headSha:f.head,claimToken:randomUUID(),startedAt:new Date().toISOString(),taskKey:{...f.runInput.taskKey,scopeDigest:'d'.repeat(64)}})
  expect(await inspectLessons(f.home,changed)).toEqual([])
 }
 expect(await readFile(join(f.home,'.claude/MEMORY.md'),'utf8')).toBe('CLAUDE_NATIVE_CANARY')
 expect(await readFile(join(f.home,'.codex/memory.md'),'utf8')).toBe('CODEX_NATIVE_CANARY')
},30000)

test('ordinary review finding resolution verifies an improvement and a changed review pin is refused',async()=>{
 const f=await fixture(),sourcePath=join(runsRoot(f.home),f.run.runId,'recovery-source.json'),source=JSON.parse(await readFile(sourcePath,'utf8'))
 const before={sha:f.base,baseSha:f.base,scopeDigest:f.packet.planRef!.digest,verdict:'needs-fixes',findings:[{id:'clarify-recovery-step',status:'open'}]}
 const after={...before,sha:f.head,verdict:'clean',findings:[{id:'clarify-recovery-step',status:'resolved'}]}
 const bodies=[before,after].map(binding=>'<!-- vsk:v1 type=review agent=claude -->\n```json\n'+JSON.stringify({reviewBinding:binding})+'\n```')
 const reviews=[before,after].map((binding,index)=>({commentId:20+index,bodySha256:createHash('sha256').update(bodies[index]!).digest('hex'),agent:'claude',binding}))
 await atomicRunFile(sourcePath,{...source,reviews})
 f.lesson.evidenceRefs=reviews.map((review,index)=>({kind:'review' as const,ref:'review:'+review.commentId+':'+review.bodySha256,sha:index?f.head:f.base,passed:!!index}))
 await atomicRunFile(join(runsRoot(f.home),f.run.runId,'recovery.json'),{...f.packet,learning:[]})
 expect(await stageLesson(f.home,f.run,f.lesson)).toEqual({id:f.lesson.id,state:'validated'})
 expect((await checkpointLessons(f.home,f.run)).adopted).toEqual([f.lesson.id])
 expect((await inspectLessons(f.home,f.run)).map(row=>row.id)).toEqual([f.lesson.id])
 reviews[1]!.bodySha256='f'.repeat(64);await atomicRunFile(sourcePath,{...source,reviews})
 expect(await inspectLessons(f.home,f.run)).toEqual([])
},30000)

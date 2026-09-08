// VegaFactory-owned lesson context. Hook entrypoints stay entirely local and
// cannot initiate checks, models, network requests or native-memory reads.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { constants } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpath, readFile, open, lstat } from 'node:fs/promises'
import { acquireClaim, processIdentity, releaseClaim } from './claims.ts'
import { atomicRunFile, findOwnedRunSession, readPrivateRunFile, readRun, readRuns, runsRoot, type RunRecord } from './runs.ts'
import { canonical } from './shared-claims.ts'
import { consumeManagedHook, parseManagedHook } from './stats/record.ts'
import { loadConfiguredPolicy, parseControlRoomKnob } from './control-room.ts'
const sourceModule=fileURLToPath(import.meta.url).endsWith('.ts')
const helperRoot=new URL(sourceModule?'../../../skills/dev/dev-implement/scripts/':'../skill/dev-implement/scripts/',import.meta.url)
const core=await import(new URL('learning.mjs',helperRoot).href) as typeof import('../../../skills/dev/dev-implement/scripts/learning.mjs')
const recovery=await import(new URL('recovery.mjs',helperRoot).href) as typeof import('../../../skills/dev/dev-implement/scripts/recovery.mjs')
export interface Lesson {id:string;repo:string;taskId:string;scopeDigest:string;sourceSha:string;statement:string;evidenceRefs:Array<{kind:'check'|'review'|'measurement';ref:string;sha:string;passed:boolean}>;targetPaths:string[];undoRef:string;state:'observed'|'validated'|'adopted'|'rejected'|'reverted';supersedes:string[]}
interface Packet {schemaVersion:3;repo:string;issue:number;learning:Lesson[];[key:string]:unknown}
const lessonPath=(root:string,run:RunRecord)=>join(root,run.runId,'recovery.json')
function git(cwd:string,args:string[],input?:string):string {
 const result=spawnSync('git',args,{cwd,input,encoding:'utf8',timeout:3000,maxBuffer:128*1024})
 if(result.error||result.signal||result.status!==0)throw Error('lesson-source-unavailable')
 return result.stdout.trim()
}
async function ownedContext(home:string,raw:string):Promise<{run:RunRecord;policy:ReturnType<typeof loadConfiguredPolicy>}|null> {
 let owned:{run:RunRecord;policy:ReturnType<typeof loadConfiguredPolicy>}|null=null
 await consumeManagedHook(home,raw,async value=>{
  const current=await readRun(runsRoot(home),value.run.runId)
  if(current.repo===value.run.repo&&current.issue===value.run.issue&&current.checkout===value.input.cwd&&current.vendorSessionId===value.input.sessionId&&current.harness===value.input.harness)owned={run:current,policy:value.context.effectivePolicy}
 })
 return owned
}
async function packetFor(home:string,run:RunRecord):Promise<Packet> {
 const packet=recovery.validateRecoveryPacket(JSON.parse(await readPrivateRunFile(lessonPath(runsRoot(home),run),128*1024))) as Packet
 if(packet.repo!==run.repo||packet.issue!==run.issue||canonical(packet.approvalBindings)!==canonical(run.approvalBindings)||canonical(packet.recordBinding)!==canonical(run.recordBinding)||canonical(packet.taskIds)!==canonical(run.approvedTaskIds)||canonical([packet.briefRef,packet.planRef])!==canonical(run.approvalRefs))throw Error('lesson-recovery-authority-differs')
 return packet
}
async function verifyEvidence(home:string,run:RunRecord,lesson:Lesson,declared:string|undefined):Promise<{verified:Lesson['evidenceRefs'];measurements:Array<{sha:string;milliseconds:number;command:string}>;reviews:Array<{sha:string;clean:boolean;findings:Array<{id:string;status:string}>}>}> {
 const verified:Lesson['evidenceRefs']=[],measurements:Array<{sha:string;milliseconds:number;command:string}>=[],reviews:Array<{sha:string;clean:boolean;findings:Array<{id:string;status:string}>}>=[]
 for(const ref of lesson.evidenceRefs){
  if(ref.kind==='review'){
   const match=/^review:([1-9]\d*):([a-f0-9]{64})$/.exec(ref.ref)
   if(!match)continue
   const material=JSON.parse(await readPrivateRunFile(join(runsRoot(home),run.runId,'recovery-source.json'))) as {reviews?:Array<{commentId:number;bodySha256:string;agent:string;binding:unknown}>}
   const matches=(material.reviews??[]).filter(row=>String(row.commentId)===match[1]&&row.bodySha256===match[2])
   const gate=await import(new URL(sourceModule?'../../../skills/dev/dev-ship/scripts/ship-gate.mjs':'../skill/dev-ship/scripts/ship-gate.mjs',import.meta.url).href) as typeof import('../../../skills/dev/dev-ship/scripts/ship-gate.mjs')
   const reviewed=matches[0],binding=reviewed?.binding as {sha:string;baseSha:string;scopeDigest:string;verdict:string;findings:Array<{id:string;status:string}>}|undefined
   if(matches.length!==1||!gate.validReview(binding)||(binding!.verdict==='clean')!==ref.passed||binding!.sha!==ref.sha||binding!.baseSha!==run.baseSha||binding!.scopeDigest!==run.approvalRefs.find(row=>row.kind==='plan')?.digest||!['claude','codex'].includes(reviewed!.agent)||reviewed!.agent===run.harness)continue
   verified.push(ref);reviews.push({sha:ref.sha,clean:binding!.verdict==='clean',findings:binding!.findings});continue
  }
  // These are references to ordinary source-check records, not callback pass flags.
  // Unsupported review/measurement formats remain unverified.
  const match=/^(check|measurement):([a-f0-9-]{36}):([a-z0-9-]{1,100})$/.exec(ref.ref)
  if(!match||ref.kind!==match[1]||match[2]!==run.runId)continue
  const root=runsRoot(home),label=match[3]!,check=JSON.parse(await readPrivateRunFile(join(root,run.runId,label+'-acceptance.json'))) as import('./children.ts').ChildCheck
  const intent=JSON.parse(await readPrivateRunFile(join(root,run.runId,label+'-check-intent.json'))) as {schemaVersion:number;runId:string;checkRunId:string;headSha:string;command:string;validationId:string}
  const actual=await readRun(root,check.checkRunId)
  if(check.schemaVersion!==1||check.runId!==run.runId||check.scopeDigest!==run.taskKey.scopeDigest||check.headSha!==ref.sha||intent.runId!==run.runId||intent.checkRunId!==check.checkRunId||intent.headSha!==check.headSha||intent.command!==check.command||intent.validationId!==check.validationId||check.command!==declared)continue
  if(actual.state!=='terminal'||!actual.processIdentity||actual.stage!=='acceptance'||actual.repo!==run.repo||actual.issue!==run.issue||actual.parent!==run.issue||actual.baseSha!==ref.sha||actual.headSha!==ref.sha||actual.exitCode!==check.exitCode||check.ok!==ref.passed)continue
  if(ref.passed ? actual.terminationCause!=='succeeded'||actual.exitCode!==0 : actual.terminationCause!=='failed'||actual.exitCode===0)continue
  if(ref.kind==='measurement'){if(!ref.passed||typeof actual.attemptElapsedMs!=='number'||!Number.isFinite(actual.attemptElapsedMs)||actual.attemptElapsedMs<=0)continue;measurements.push({sha:ref.sha,milliseconds:actual.attemptElapsedMs,command:check.command})}
  verified.push(ref)
 }
 return {verified,measurements,reviews}
}
interface LearningSource {head:string;parents:string[];changed:string[];blobs:Map<string,{sha:string;mode:string}>}
function learningSource(cwd:string):LearningSource {
 const fields=git(cwd,['show','-1','--format=%H%n%P','--raw','--no-abbrev','--no-renames','-z','HEAD']).split('\0')
 const [head,...parentLines]=fields.shift()!.split('\n'),parents=parentLines.join(' ').split(' ').filter(Boolean),blobs=new Map<string,{sha:string;mode:string}>()
 if(!head||!/^[a-f0-9]{40}$/.test(head)||parents.some(parent=>!/^[a-f0-9]{40}$/.test(parent)))throw Error('lesson-source-unavailable')
 while(fields.length&&fields[0]){
  const header=/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/.exec(fields.shift()!.trim()),path=fields.shift()
  if(!header||!path||blobs.has(path))throw Error('lesson-source-tree-unavailable')
  blobs.set(path,{sha:header[4]!,mode:header[2]!})
 }
 return {head,parents,changed:[...blobs.keys()],blobs}
}
async function currentLessonBytes(cwd:string,paths:string[],source:LearningSource):Promise<boolean> {
 let total=0
 for(const path of paths){
  const expected=source.blobs.get(path);if(!expected)return false
  const file=join(cwd,path)
  if(expected.mode==='000000'){try{await lstat(file);return false}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}}
  if(!['100644','100755'].includes(expected.mode)||await realpath(dirname(file))!==dirname(file))return false
  const descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
   const stat=await descriptor.stat();if(!stat.isFile()||stat.size>1024*1024||(expected.mode==='100755')!==!!(stat.mode&0o111))return false
   const bytes=await descriptor.readFile();total+=bytes.length;if(bytes.length!==stat.size||total>2*1024*1024)return false
   if(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==expected.sha)return false
  }finally{await descriptor.close()}
 }
 return true
}
async function lessonContext(home:string,run:RunRecord,lesson:Lesson,checkedPolicy?:ReturnType<typeof loadConfiguredPolicy>,source=learningSource(run.checkout)) {
 const policy=checkedPolicy??loadConfiguredPolicy({home,repo:run.repo,devMd:await readFile(join(run.checkout,'.vegastack/dev.md'),'utf8')})
 if(!policy.ok||policy.policy.policyDigest!==run.policyDigest)throw Error('lesson-current-policy-unavailable')
 const undo=lesson.undoRef.slice(4),{head,parents,changed}=source
 if(head!==lesson.sourceSha||undo!==head)throw Error('lesson-source-drift')
 if(parents.length!==1)throw Error('lesson-reversible-patch-unavailable')
 if(!await currentLessonBytes(run.checkout,lesson.targetPaths,source))throw Error('lesson-source-drift')
 const approved=run.authorityRequest?.kind==='consolidated'?run.authorityRequest.requested.paths:await approvedLessonFiles(run,home)
 const declared=/^commands:.*?\bcheck\s+`([^`]+)`/m.exec(git(run.checkout,['show',run.baseSha+':.vegastack/dev.md']))?.[1]
 const {verified:verifiedEvidence,measurements,reviews}=await verifyEvidence(home,run,lesson,declared)
 return {repo:run.repo,scopeDigest:run.taskKey.scopeDigest,sourceSha:head,taskIds:run.approvedTaskIds??[],allowedFiles:approved,
   learningEnabled:policy.policy.values.learning!=='off',adoption:policy.policy.values['learning-adoption'],
   reversible:changed.length>0&&changed.every(path=>lesson.targetPaths.includes(path)&&approved.includes(path))&&lesson.targetPaths.every(path=>changed.includes(path)),
   improved:verifiedEvidence.some(ref=>ref.kind==='check'&&!ref.passed&&ref.sha===parents[0])&&verifiedEvidence.some(ref=>ref.kind==='check'&&ref.passed&&ref.sha===head)||measurements.some(before=>before.sha===parents[0]&&measurements.some(after=>after.sha===head&&after.command===before.command&&after.milliseconds<before.milliseconds))||reviews.some(before=>before.sha===parents[0]&&!before.clean&&before.findings.some(finding=>finding.status==='open'&&reviews.some(after=>after.sha===head&&after.clean&&after.findings.some(resolved=>resolved.id===finding.id&&resolved.status==='resolved')))),
   reviewRequired:lesson.targetPaths.some(path=>/\.(?:[cm]?[jt]sx?|py|sh|ya?ml|jsonc?)$/.test(path)||/^skills\//.test(path)||/(?:^|\/)SKILL\.md$/.test(path)),verifiedEvidence}
}
async function approvedLessonFiles(run:RunRecord,home:string):Promise<string[]> {
 // Native source context is pinned by the packet producer after fresh #135
 // admission. It is private, immutable to hooks and bound to this exact plan.
 const material=JSON.parse(await readPrivateRunFile(join(runsRoot(home),run.runId,'recovery-source.json'))) as {schemaVersion:number;planRef:unknown;planBody:string}
 const ref=run.approvalRefs.find(ref=>ref.kind==='plan')
 const approval=await import(new URL('lib/approval.mjs',helperRoot).href) as typeof import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs')
 if(material.schemaVersion!==1||canonical(material.planRef)!==canonical(ref)||approval.scopeDigest(material.planBody,'plan')!==ref?.digest)throw Error('lesson-approved-source-unavailable')
 const rows=[...material.planBody.matchAll(/^-\s*\[[ x]\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->.*$/gim)]
 return [...new Set(rows.flatMap((row,index)=>(run.approvedTaskIds??[]).includes(row[1]!)?[...(material.planBody.slice(row.index,rows[index+1]?.index).split('\n').find(line=>/^\s*- Files\s/.test(line))??'').matchAll(/`([^`]+)`/g)].map(match=>match[1]!):[]))]
}
export async function checkpointLessons(home:string,run:RunRecord,checkedPolicy?:ReturnType<typeof loadConfiguredPolicy>):Promise<{adopted:string[];proposals:string[]}> {
 // No mutation claim or fsync when there is nothing prepared to flush.
 const prepared=await packetFor(home,run)
 if(!prepared.learning.some(row=>row.state==='validated'))return {adopted:[],proposals:[]}
 const root=runsRoot(home),lock=await acquireClaim(join(root,run.runId,'learning-mutation'),await processIdentity())
 if(lock.kind!=='owned')throw Error('lesson-checkpoint-busy')
 try {
  const current=await readRun(root,run.runId)
  if(current.generation!==run.generation)throw Error('lesson-run-changed')
  const packet=await packetFor(home,current),adopted:string[]=[],proposals:string[]=[]
  for(const lesson of packet.learning){
   if(lesson.state!=='validated')continue
   const result=core.evaluateLesson(lesson,await lessonContext(home,current,lesson,checkedPolicy))
   if(result.action==='adopt'){lesson.state='adopted';adopted.push(lesson.id)}
   else if(result.action==='propose'){proposals.push(lesson.id);lesson.state='validated'}
   else lesson.state='rejected'
  }
  if((await readRun(root,run.runId)).generation!==run.generation)throw Error('lesson-run-changed')
  await atomicRunFile(lessonPath(root,run),packet)
  return {adopted,proposals}
 } finally {await releaseClaim(lock.claim)}
}
export async function inspectLessons(home:string,run:RunRecord,checkedPolicy?:ReturnType<typeof loadConfiguredPolicy>):Promise<Lesson[]> {
 const sourceFacts=learningSource(run.checkout),head=sourceFacts.head
 const policy=checkedPolicy??loadConfiguredPolicy({home,repo:run.repo,devMd:await readFile(join(run.checkout,'.vegastack/dev.md'),'utf8')})
 if(!policy.ok||policy.policy.policyDigest!==run.policyDigest||policy.policy.values.learning==='off')return []
 const prior=(await readRuns(runsRoot(home))).filter(row=>row.runId!==run.runId&&row.repo===run.repo&&row.issue===run.issue&&row.headSha===head&&row.taskKey.scopeDigest===run.taskKey.scopeDigest&&canonical(row.approvalRefs)===canonical(run.approvalRefs)&&canonical(row.approvalBindings)===canonical(run.approvalBindings)&&canonical(row.recordBinding)===canonical(run.recordBinding)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,31)
 const valid:Lesson[]=[]
 for(const source of [run,...prior]){
  let packet:Packet
  try{packet=await packetFor(home,source)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
  const selected=core.selectLessons(packet,{repo:run.repo,scopeDigest:run.taskKey.scopeDigest,sourceSha:head,maxItems:3,maxBytes:2048}) as Lesson[]
  for(const lesson of selected)if(valid.length<32&&core.evaluateLesson(lesson,await lessonContext(home,source,lesson,policy,sourceFacts)).action==='adopt')valid.push(lesson)
 }
 return core.selectLessons({learning:valid},{repo:run.repo,scopeDigest:run.taskKey.scopeDigest,sourceSha:head,maxItems:3,maxBytes:2048}) as Lesson[]
}
export async function revertLesson(home:string,run:RunRecord,id:string,apply=false):Promise<{id:string;applied:boolean;paths:string[]}> {
 if(!/^lesson-[a-f0-9]{32}$/.test(id))throw Error('invalid-lesson-id')
 const root=runsRoot(home),lock=await acquireClaim(join(root,run.runId,'learning-mutation'),await processIdentity())
 if(lock.kind!=='owned')throw Error('lesson-checkpoint-busy')
 try {
  const packet=await packetFor(home,run),lesson=packet.learning.find(row=>row.id===id)
  if(!lesson||lesson.state!=='adopted')throw Error('adopted-lesson-unavailable')
  const context=await lessonContext(home,run,lesson)
  if(core.evaluateLesson(lesson,context).action!=='adopt')throw Error('lesson-undo-authority-unavailable')
  // Exact inverse patch, checked against current bytes; no reset, checkout or
  // whole-file restoration that could erase unrelated edits.
  const patch=git(run.checkout,['diff',lesson.sourceSha+'^',lesson.sourceSha,'--',...lesson.targetPaths])+'\n'
  git(run.checkout,['apply','--reverse','--check','--whitespace=nowarn','-'],patch)
  if(apply){
   if((await readRun(root,run.runId)).generation!==run.generation)throw Error('lesson-run-changed')
   git(run.checkout,['apply','--reverse','--whitespace=nowarn','-'],patch)
   lesson.state='reverted';await atomicRunFile(lessonPath(root,run),packet)
  }
  return {id,applied:apply,paths:lesson.targetPaths}
 } finally {await releaseClaim(lock.claim)}
}
async function boundedStdin():Promise<string> { return String(await recovery.readBoundedRecoveryInput()) }
// Readiness is internal IPC only. The installed hook supervises this whole
// one-shot consumer and its process group; no Promise.race implies cancellation.
export async function withManagedHookPhase<T>(work:(beforeFlush:()=>Promise<void>)=>Promise<T>):Promise<T> {
 if(typeof process.send!=='function'||!process.connected)return work(async()=>{})
 // Pure module initialization stays inside the overall deadline, before any
 // payload, policy, registry or transcript read.
 await Promise.all([import('./stats/outbox.ts'),import('./stats/types.ts'),import('./stats/privacy.ts'),import('./stats/push.ts'),import('./run-wrapper.ts'),import('./machine-identity.ts')])
 let nonce:string|null=null,phase:'ready'|'validating'|'awaiting-flush'|'flushing'|'finished'='ready'
 const receive=(expected:'start'|'flush')=>new Promise<void>((resolve,reject)=>{
  const disconnected=()=>{process.removeListener('message',message);reject(Error('managed-hook-supervisor-disconnected'))}
  const message=(value:unknown)=>{
   process.removeListener('disconnect',disconnected)
   const row=value as {vskManagedHook?:unknown;phase?:unknown;nonce?:unknown}
   if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='nonce,phase,vskManagedHook'||row.vskManagedHook!==1||row.phase!==expected||typeof row.nonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.nonce)||expected==='flush'&&row.nonce!==nonce){reject(Error('managed-hook-grant-refused'));return}
   nonce=row.nonce;resolve()
  }
  process.once('message',message);process.once('disconnect',disconnected)
 })
 const started=receive('start')
 await new Promise<void>((resolve,reject)=>process.send!({vskManagedHook:1,phase:'ready'},(error:Error|null)=>error?reject(error):resolve()))
 await started;phase='validating'
 let granted:Promise<void>|null=null
 const beforeFlush=()=>{
  if(granted)return granted
  granted=(async()=>{
   if(phase!=='validating'||!process.connected)throw Error('managed-hook-flush-state-refused')
   phase='awaiting-flush'
   const reply=receive('flush')
   await new Promise<void>((resolve,reject)=>process.send!({vskManagedHook:1,phase:'validated',nonce},(error:Error|null)=>error?reject(error):resolve()))
   await reply;phase='flushing'
  })()
  return granted
 }
 try{return await work(beforeFlush)}
 finally{
  phase='finished'
  await new Promise<void>(done=>{if(!process.connected||!process.send)return done();process.send({vskManagedHook:1,phase:'finish',nonce},()=>done())})
  if(process.connected)process.disconnect()
 }
}

export async function runLearningCli(argv:string[],home=homedir()):Promise<number> {
 const verb=argv[0],managed=argv.includes('--source')
 try {
  if(managed){
   if(!['inspect','checkpoint'].includes(verb??'')||argv.length!==4||argv[1]!=='--source'||argv[2]!=='managed-hook'||argv[3]!=='--json')throw Error('learning-hook-arguments-refused')
   return await withManagedHookPhase(async beforeFlush=>{
   const raw=await boundedStdin(),input=parseManagedHook(raw);if(!input)return 0
   let lessons:Lesson[]=[]
   await consumeManagedHook(home,raw,async value=>{
    const current=await readRun(runsRoot(home),value.run.runId)
    if(current.repo!==value.run.repo||current.issue!==value.run.issue||current.checkout!==value.input.cwd||current.harness!==value.input.harness||current.vendorSessionId!==value.input.sessionId||canonical(current.approvalBindings)!==canonical(value.run.approvalBindings)||current.taskKey.scopeDigest!==value.run.taskKey.scopeDigest)return
    if(!current.approvedTaskIds?.length||!current.approvalRefs.some(ref=>ref.kind==='brief')||!current.approvalRefs.some(ref=>ref.kind==='plan'))return
    if(verb==='checkpoint'){
     try{await checkpointLessons(home,current,value.context.effectivePolicy)}catch{/* Prepared learning remains pending; capture's real ACK is untouched. */}
    }else if(value.input.event==='SessionStart')lessons=await inspectLessons(home,current,value.context.effectivePolicy)
   },beforeFlush)
   if(verb==='inspect'&&lessons.length)console.log(JSON.stringify({ok:true,contextPointer:'vsk-context:'+createHash('sha256').update(canonical(lessons)).digest('hex').slice(0,32),lessons:lessons.map(row=>({id:row.id,statement:row.statement}))}))
   return 0
   })
  }
  if(!['checkpoint','inspect','revert'].includes(verb??''))throw Error('usage: learning checkpoint|inspect|revert --run-id ID --json [--id ID --dry-run|--apply]')
  const flags:Record<string,string|boolean>={}
  for(let i=1;i<argv.length;i++){const key=argv[i]!;if(!['--run-id','--json','--id','--dry-run','--apply'].includes(key)||Object.hasOwn(flags,key))throw Error('learning-arguments-refused');flags[key]=['--json','--dry-run','--apply'].includes(key)?true:argv[++i]??''}
  if(typeof flags['--run-id']!=='string'||flags['--dry-run']&&flags['--apply'])throw Error('learning-arguments-refused')
  const run=await readRun(runsRoot(home),flags['--run-id'])
  if(process.env.VSK_RUN_ID!==run.runId||await realpath(process.cwd())!==run.checkout||!await ownedContext(home,JSON.stringify({harness:run.harness,event:'SessionStart',sessionId:run.vendorSessionId,cwd:run.checkout,stopHookActive:false})))throw Error('learning-owned-session-required')
  const result=verb==='inspect'?await inspectLessons(home,run):verb==='checkpoint'?await checkpointLessons(home,run):await revertLesson(home,run,String(flags['--id']??''),flags['--apply']===true)
  console.log(JSON.stringify(result));return 0
 } catch(error){if(managed)return 0;console.error((error as Error).message);return 2}
}

// Called by ordinary authorized work to prepare one observation. Hooks only
// flush these records; they never mine transcripts or start an experiment.
export async function stageLesson(home:string,run:RunRecord,candidate:Lesson):Promise<{id:string;state:Lesson['state']}> {
 core.validateLesson(candidate)
 if(candidate.state!=='observed'&&candidate.state!=='validated')throw Error('lesson-must-be-observed-or-validated')
 if(candidate.id==='lesson-'+run.runId.replaceAll('-','')||candidate.repo!==run.repo||candidate.scopeDigest!==run.taskKey.scopeDigest||!run.approvedTaskIds?.includes(candidate.taskId))throw Error('lesson-owned-scope-required')
 const policy=loadConfiguredPolicy({home,repo:run.repo,devMd:await readFile(join(run.checkout,'.vegastack/dev.md'),'utf8')})
 if(!policy.ok||policy.policy.values.learning==='off'||policy.policy.policyDigest!==run.policyDigest)throw Error('lesson-current-policy-unavailable')
 const files=run.authorityRequest?.kind==='consolidated'?run.authorityRequest.requested.paths:await approvedLessonFiles(run,home)
 if(candidate.targetPaths.some(path=>!files.includes(path)))throw Error('lesson-file-scope-differs')
 if(candidate.state==='validated'){
  const verdict=core.evaluateLesson(candidate,await lessonContext(home,run,candidate,policy))
  if(verdict.action==='reject')throw Error('lesson-evidence-unverified')
 }
 const root=runsRoot(home),held=await acquireClaim(join(root,run.runId,'learning-mutation'),await processIdentity())
 if(held.kind!=='owned')throw Error('lesson-checkpoint-busy')
 try{
  if((await readRun(root,run.runId)).generation!==run.generation)throw Error('lesson-run-changed')
  const packet=await packetFor(home,run),prior=packet.learning.find(row=>row.id===candidate.id)
  if(prior){if(canonical(prior)!==canonical(candidate))throw Error('lesson-identity-rebound');return{id:prior.id,state:prior.state}}
  if(candidate.supersedes.some(id=>!packet.learning.some(row=>row.id===id)))throw Error('lesson-supersession-source-unavailable')
  const next={...packet,learning:[...packet.learning,candidate]};recovery.validateRecoveryPacket(next)
  await atomicRunFile(lessonPath(root,run),next)
  return {id:candidate.id,state:candidate.state}
 }finally{await releaseClaim(held.claim)}
}

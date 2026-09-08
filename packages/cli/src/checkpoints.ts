import { canonical as canonicalWire } from './shared-claims.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { type RunRecord, transitionRun, readRun, type PendingDelivery, validateAuthority, validateCheckpointIntentShape, updateRun, withRunDelivery } from './runs.ts'
import { type ApprovalAuthorityRef, type CheckpointRef } from './shared-claims.ts'
const exec=promisify(execFile)
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
export interface CheckpointIntent {
  approvalRequest?:{parentRepo:string;parentIssue:number;approvalBinding:{commentId:number;bodySha256:string};requested:{repo:string;issue:number;taskIds:string[];actionId:string;branch:string;baseSha:string;paths:string[];operation:"checkpoint"}}
  id:string; repo:string; repositoryId:string; remote:string; remoteUrl:string; branch:string; baseRef:string; baseSha:string; scopeDigest:string; paths:string[]
  approvalBindings:ApprovalAuthorityRef[]
}
export interface CheckpointCandidate {
  run:RunRecord; approvedIntent:CheckpointIntent; headSha:string; treeSha:string; noChange:boolean
  exportProof:{repositoryId:string;remoteRef:string;verifiedRemoteHead:string|null;approvedBaseSha:string;headSha:string;closureDigest:string;validatorVersion:1}
}
export interface CheckpointController {
  root:string
  // The production authority owner must freshly validate activity, body AND containing history.
  verifyAuthority:(intent:CheckpointIntent)=>Promise<void>
  // Shared mode requires the acknowledged prepared effect before any send and verified outcome after.
  retryEffect?:(candidate:CheckpointCandidate,delivery:PendingDelivery)=>Promise<void>
  prepareEffect?:(candidate:CheckpointCandidate,delivery:PendingDelivery)=>Promise<void>
  acknowledgeEffect?:(candidate:CheckpointCandidate,delivery:PendingDelivery,checkpoint:CheckpointRef)=>Promise<void>
}
function gitEnvironment():NodeJS.ProcessEnv {
  const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_NAMESPACE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_REPLACE_REF_BASE','GIT_CONFIG_PARAMETERS','GIT_CONFIG_COUNT'])delete env[key as keyof typeof env]
  return env
}
async function gitBytes(cwd:string,args:string[]):Promise<Buffer>{
  try{return(await exec('git',args,{cwd,encoding:'buffer',timeout:10_000,maxBuffer:32*1024*1024,env:gitEnvironment()})).stdout}catch{throw Error('checkpoint-git-refused')}
}
async function git(cwd:string,args:string[]):Promise<string>{
  try{return new TextDecoder('utf-8',{fatal:true}).decode(await gitBytes(cwd,args))}catch(error){if((error as Error).message==='checkpoint-git-refused')throw error;throw Error('checkpoint-text-encoding-refused')}
}
async function validateGitSource(run:RunRecord,intent:CheckpointIntent):Promise<void>{
  const {readFile,lstat}=await import('node:fs/promises')
  if((await git(run.checkout,['rev-parse','--show-object-format'])).trim()!=='sha1'||(await git(run.checkout,['rev-parse','--is-shallow-repository'])).trim()!=='false')throw Error('checkpoint-incomplete-object-history')
  const grafts=(await git(run.checkout,['rev-parse','--path-format=absolute','--git-path','info/grafts'])).trim()
  try{const stat=await lstat(grafts);if(stat.isSymbolicLink()||!stat.isFile()||(await readFile(grafts)).length)throw Error('checkpoint-grafted-history-refused')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const config=await git(run.checkout,['config','--null','--list'])
  for(const row of config.split('\0')){
    const split=row.indexOf('\n'),key=row.slice(0,split).toLowerCase(),value=row.slice(split+1)
    if(/^url\..*\.(?:insteadof|pushinsteadof)$/.test(key)&&value&&intent.remoteUrl.startsWith(value))throw Error('checkpoint-remote-rewrite-refused')
  }
  const pushUrls=(await git(run.checkout,['remote','get-url','--push','--all',intent.remote])).trim().split('\n')
  if(pushUrls.length!==1||pushUrls[0]!==intent.remoteUrl)throw Error('checkpoint-push-target-differs')
}

const sha=/^[a-f0-9]{40}$/
const sensitive=/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})|(?:credential|secret|token)[-_ ]?canary|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,})/i
function permitted(path:string,paths:string[]){return paths.some(p=>path===p || p.endsWith('/')&&path.startsWith(p))}
async function remoteState(run:RunRecord,intent:CheckpointIntent){
  await validateGitSource(run,intent)
  if((await git(run.checkout,['remote','get-url',intent.remote])).trim()!==intent.remoteUrl)throw Error('checkpoint-remote-identity-mismatch')
  const advertised=await git(run.checkout,['ls-remote','--symref',intent.remoteUrl,'HEAD',intent.baseRef,`refs/heads/${intent.branch}`])
  const defaultRef=/^ref: (refs\/heads\/[^\t]+)\tHEAD$/m.exec(advertised)?.[1]
  if(!defaultRef || defaultRef===`refs/heads/${intent.branch}`)throw Error('checkpoint-default-branch-refused')
  const rows=advertised.split('\n').map(x=>x.split('\t'));const tip=rows.find(x=>x[1]===`refs/heads/${intent.branch}`)?.[0]??null
  const baseTip=rows.find(x=>x[1]===intent.baseRef)?.[0];if(!baseTip||!sha.test(baseTip))throw Error('checkpoint-base-unverified')
  await git(run.checkout,['fetch','--no-tags','--no-recurse-submodules',intent.remoteUrl,intent.baseRef])
  await git(run.checkout,['merge-base','--is-ancestor',intent.baseSha,baseTip])
  if(tip){if(!sha.test(tip))throw Error('checkpoint-remote-tip-invalid');await git(run.checkout,['fetch','--no-tags','--no-recurse-submodules',intent.remoteUrl,`refs/heads/${intent.branch}`])}
  return tip
}
export async function prepareCheckpoint(input:{run:RunRecord;approvedIntent:CheckpointIntent;headSha:string},controller:CheckpointController):Promise<CheckpointCandidate>{
  const {run,approvedIntent:i,headSha}=input
  validateCheckpointIntentShape(i)
  if(i.repo!==run.repo||i.branch!==run.branch||i.baseSha!==run.baseSha||i.scopeDigest!==run.taskKey.scopeDigest||!sha.test(headSha)||!sha.test(i.baseSha)||!i.id||!i.repositoryId||!i.approvalBindings.length||!i.paths.length||i.paths.some(p=>!p||p.startsWith('/')||p.split('/').includes('..')||/[\x00-\x1f*?\[\]{}]/.test(p))||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(i.branch)||i.branch.includes('..')||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(i.remote)||!i.baseRef.startsWith('refs/heads/'))throw Error('checkpoint-intent-refused')
  i.approvalBindings.forEach(validateAuthority)
  if(canonicalWire(i.approvalBindings)!==canonicalWire(run.approvalBindings))throw Error('checkpoint-authority-rebound')
  await controller.verifyAuthority(i)
  const tip=await remoteState(run,i)
  await git(run.checkout,['merge-base','--is-ancestor',i.baseSha,headSha])
  if(tip){try{await git(run.checkout,['merge-base','--is-ancestor',tip,headSha])}catch{await git(run.checkout,['merge-base','--is-ancestor',headSha,tip])}}
  const commits=(await git(run.checkout,['rev-list',headSha,`^${i.baseSha}`,...(tip?[`^${tip}`]:[])])).trim().split('\n').filter(Boolean)
  const closure:string[]=[]
  for(const commit of commits){
    const raw=await git(run.checkout,['cat-file','commit',commit]);if(sensitive.test(raw))throw Error('checkpoint-sensitive-commit')
    const paths=(await git(run.checkout,['diff-tree','--root','-m','--no-commit-id','--name-only','-r','-z',commit])).split('\0').filter(Boolean)
    if(paths.some(p=>!permitted(p,i.paths)||/(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials|\.vegastack\/(?:runs|state))(?:\/|$)/i.test(p)))throw Error('checkpoint-out-of-scope-history')
    const changed=(await git(run.checkout,['diff-tree','--root','-m','--no-commit-id','--raw','-r','-z',commit])).split('\0')
    for(let n=0;n<changed.length;n+=2){const mode=/^:\d{6} (\d{6}) /.exec(changed[n]??'')?.[1];if(mode==='160000')throw Error('checkpoint-new-gitlink-refused');if(mode==='120000'){const path=changed[n+1];if(!path)throw Error('checkpoint-symlink-path-unavailable');const target=(await git(run.checkout,['show',`${commit}:${path}`])).trim();if(target.startsWith('/')||target.split('/').includes('..'))throw Error('checkpoint-escaping-symlink-refused')}}
    closure.push(commit+':'+digest(raw))
  }
  const objects=(await git(run.checkout,['rev-list','--objects','--no-object-names',headSha,`^${i.baseSha}`,...(tip?[`^${tip}`]:[])])).trim().split('\n').filter(Boolean)
  for(const oid of objects){
    if(!sha.test(oid))throw Error('checkpoint-invalid-object-identity')
    const kind=(await git(run.checkout,['cat-file','-t',oid])).trim()
    const size=Number((await git(run.checkout,['cat-file','-s',oid])).trim())
    if(!['blob','tree','commit'].includes(kind)||!Number.isSafeInteger(size)||size>8*1024*1024)throw Error('checkpoint-object-bound')
    const content=await gitBytes(run.checkout,['cat-file',kind,oid])
    if(content.length!==size||createHash('sha1').update(`${kind} ${size}\0`).update(content).digest('hex')!==oid)throw Error('checkpoint-object-integrity-refused')
    if((kind==='blob'||kind==='commit')&&sensitive.test(content.toString('latin1')))throw Error('checkpoint-sensitive-history')
    closure.push(oid+':'+createHash('sha256').update(content).digest('hex'))
  }

  return{run,approvedIntent:i,headSha,treeSha:(await git(run.checkout,['rev-parse',`${headSha}^{tree}`])).trim(),noChange:tip===headSha||headSha===i.baseSha,exportProof:{repositoryId:i.repositoryId,remoteRef:`refs/heads/${i.branch}`,verifiedRemoteHead:tip,approvedBaseSha:i.baseSha,headSha,closureDigest:digest(closure.sort().join('\n')),validatorVersion:1}}
}
export async function publishCheckpoint(candidate:CheckpointCandidate,controller:CheckpointController):Promise<{kind:'acknowledged'|'pending'|'refused';checkpoint:CheckpointRef|null;reason:string|null}>{
  try{return await withRunDelivery(controller.root,candidate.run.runId,async()=>{
    let record=await readRun(controller.root,candidate.run.runId)
    try{
      const fresh=await prepareCheckpoint({run:record,approvedIntent:candidate.approvedIntent,headSha:candidate.headSha},controller),i=fresh.approvedIntent
      let delivery=record.pendingDelivery.find(p=>p.kind==='feature-push'&&'sha'in p.target&&p.target.sha===fresh.headSha&&p.intentRef===i.id)
      if(fresh.noChange&&delivery?.status==='acknowledged')return{kind:'acknowledged' as const,checkpoint:delivery.checkpoint??record.checkpoint,reason:null}
      if(fresh.noChange&&!delivery&&fresh.headSha===i.baseSha)return{kind:'acknowledged' as const,checkpoint:null,reason:'no-change'}
      if(!delivery){
        delivery={id:randomUUID(),kind:'feature-push',target:{repo:i.repo,remote:i.remote,branch:i.branch,sha:fresh.headSha},intentRef:i.id,exportProof:fresh.exportProof,approvalBindings:i.approvalBindings,status:'pending',attempts:0,lastError:null}
        const prepared=delivery
        record=await updateRun(controller.root,record.runId,r=>({pendingDelivery:[...r.pendingDelivery,prepared]}))
      }
      const id=delivery.id
      const update=async(patch:Partial<PendingDelivery>)=>{record=await updateRun(controller.root,record.runId,r=>({pendingDelivery:r.pendingDelivery.map(p=>p.id===id?{...p,...patch}:p)}));delivery=record.pendingDelivery.find(p=>p.id===id)!}
      await update({exportProof:fresh.exportProof,approvalBindings:i.approvalBindings})
      let present=false
      if(fresh.exportProof.verifiedRemoteHead)try{await git(record.checkout,['merge-base','--is-ancestor',fresh.headSha,fresh.exportProof.verifiedRemoteHead]);present=true}catch{}
      if(record.sharedClaim&&(!controller.prepareEffect||!controller.acknowledgeEffect))throw Error('checkpoint-shared-controller-unavailable')
      // An ambiguous source send is reconciled before reserving or retrying any operation.
      if(record.sharedClaim&&delivery.effect&&delivery.status==='ambiguous'&&!present){if(!controller.retryEffect){await update({lastError:'checkpoint-source-unconfirmed'});return{kind:'pending' as const,checkpoint:record.checkpoint,reason:'checkpoint-source-unconfirmed'}}await controller.retryEffect(fresh,delivery)}
      else if(!delivery.effect||!present){await controller.prepareEffect?.(fresh,delivery);record=await readRun(controller.root,record.runId);delivery=record.pendingDelivery.find(p=>p.id===id)!}
      try{
        if(!present){
          await controller.verifyAuthority(i)
          await validateGitSource(record,i)
          await update({status:'ambiguous',attempts:delivery.attempts+1,lastError:null})
          await git(record.checkout,['-c','push.followTags=false','push','--no-follow-tags','--recurse-submodules=no',i.remoteUrl,`${fresh.headSha}:refs/heads/${i.branch}`])
        }
        const tip=await remoteState(record,i);if(!tip)throw Error('checkpoint-readback-missing')
        await git(record.checkout,['merge-base','--is-ancestor',fresh.headSha,tip])
        const checkpoint:CheckpointRef=delivery.checkpoint??{schemaVersion:1,id:delivery.id,repo:i.repo,repositoryId:i.repositoryId,branch:i.branch,baseSha:i.baseSha,headSha:fresh.headSha,treeSha:fresh.treeSha,scopeDigest:i.scopeDigest,runId:record.runId,publishedAt:new Date().toISOString()}
        await update({sourceAcknowledged:true,checkpoint,status:'ambiguous',lastError:null})
        // Keep the verified source pointer even if publishing the private envelope fails.
        record=await updateRun(controller.root,record.runId,()=>({checkpoint,headSha:checkpoint.headSha}))
        await controller.acknowledgeEffect?.(fresh,delivery,checkpoint)
        await update({status:'acknowledged',lastError:null})
        return{kind:'acknowledged' as const,checkpoint,reason:null}
      }catch{await update({status:'ambiguous',lastError:delivery.sourceAcknowledged?'checkpoint-pointer-pending':'checkpoint-delivery-unconfirmed'});return{kind:'pending' as const,checkpoint:record.checkpoint,reason:delivery.lastError}}
    }catch(error){return{kind:'refused' as const,checkpoint:record.checkpoint,reason:(error as Error).message}}
  })}catch{return{kind:'pending',checkpoint:candidate.run.checkpoint,reason:'checkpoint-delivery-busy'}}
}

export async function configuredCheckpointController(run:RunRecord,config:import('./config.ts').FactoryConfig):Promise<CheckpointController>{
  const {loadConfiguredPolicy}=await import('./control-room.ts'),{readFile}=await import('node:fs/promises'),{join,dirname}=await import('node:path'),{fileURLToPath,pathToFileURL}=await import('node:url'),{ghText,boundedGhJson,readBudget}=await import('./gh.ts')
  const entry=config.repos.find(r=>r.repo===run.repo);if(!entry||run.checkout!==await (await import('node:fs/promises')).realpath(run.checkout))throw Error('checkpoint checkout unavailable')
  const verifyAuthority=async(intent:CheckpointIntent)=>{
    const request=intent.approvalRequest
    if(!request||request.requested.repo!==run.repo||request.requested.issue!==run.issue||request.requested.operation!=='checkpoint'||request.requested.branch!==run.branch||request.requested.baseSha!==run.baseSha||canonicalWire(request.requested.paths)!==canonicalWire(intent.paths))throw Error('checkpoint canonical approval request unavailable')
    const devMd=await readFile(join(entry.path,'.vegastack/dev.md'),'utf8')
    const policy=loadConfiguredPolicy({home:config.home,repo:run.repo,devMd,settingsPath:config.settingsPath});if(!policy.ok)throw Error('checkpoint current policy unavailable')
    const script=join(dirname(dirname(fileURLToPath(import.meta.url))),'skill','dev-implement','scripts','lib','approval.mjs')
    const owner=await import(pathToFileURL(script).href)
    const operators=String(policy.policy.values.operators??'').split(',').map(s=>s.trim()).filter(Boolean)
    const remote=await boundedGhJson<{node_id:string}>(ghText,['api',`repos/${intent.repo}`],readBudget())
    if(remote.node_id!==intent.repositoryId||!new Set([`https://github.com/${intent.repo}.git`,`git@github.com:${intent.repo}.git`,`https://github.com/${intent.repo}`]).has(intent.remoteUrl))throw Error('checkpoint remote repository identity refused')
    const verified=await owner.gatherConsolidatedApproval({...request,operators,readJson:(args:string[])=>boundedGhJson(ghText,args,readBudget())})
    if(!verified.ok||verified.action?.kind!=='checkpoint'||verified.action.branch!==intent.branch)throw Error('checkpoint source authority refused')
    const tuples=intent.approvalBindings.map(a=>({approvalId:a.approvalId,commentId:Number(a.source.commentId),bodySha256:a.source.bodySha256}))
    if(tuples.some(t=>!Number.isSafeInteger(t.commentId))||canonicalWire(tuples)!==canonicalWire(verified.approvalBindings))throw Error('checkpoint canonical authority changed')
  }
  const helpers=await import('./runs.ts'),dispatch=await import('./dispatch.ts'),owner=await import('./shared-claims.ts')
  const controller:CheckpointController={root:helpers.runsRoot(config.home),verifyAuthority:async intent=>{
    if(!await dispatch.checkpointPolicyEnabled(run.repo,config))throw Error('checkpoint-policy-disabled')
    await verifyAuthority(intent)
  }}
  if(run.sharedClaim){
    controller.prepareEffect=async(candidate,delivery)=>{
      const current=await helpers.readRun(controller.root,run.runId),claim=await dispatch.sharedClaimForRun(current,config)
      const target:import('./shared-claims.ts').EffectTarget={kind:'source-ref',repositoryId:candidate.approvedIntent.repositoryId,branch:candidate.approvedIntent.branch,headSha:candidate.headSha}
      await helpers.prepareManagedRunEffect({claim,run:current,effect:{operationId:delivery.id,runId:run.runId,generation:claim.generation,kind:'checkpoint-push',target,payloadDigest:owner.sha256(owner.canonical(target))}})
    }
    controller.retryEffect=async(candidate,delivery)=>{
      await controller.verifyAuthority(candidate.approvedIntent)
      const current=await helpers.readRun(controller.root,run.runId),claim=await dispatch.sharedClaimForRun(current,config)
      await helpers.reserveIdempotentSourceRetry({claim,run:current,effectId:delivery.id,observedRemoteHead:candidate.exportProof.verifiedRemoteHead})
    }
    controller.acknowledgeEffect=async(_candidate,delivery,checkpoint)=>{
      const current=await helpers.readRun(controller.root,run.runId),prepared=current.pendingDelivery.find(p=>p.id===delivery.id)
      if(!prepared?.effect||!prepared.receiptIds)throw Error('checkpoint-effect-identity-unavailable')
      let claim=await dispatch.sharedClaimForRun(current,config)
      claim=await helpers.acknowledgeManagedRunEffect({claim,run:current,effectId:delivery.id,observedRemoteId:checkpoint.headSha,observedDigest:prepared.effect.payloadDigest})
      const snapshot=await owner.readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
      if(!task?.recovery)throw Error('checkpoint-envelope-unavailable')
      if(owner.canonical(task.checkpoint)===owner.canonical(checkpoint)&&owner.canonical(task.recovery.checkpoint)===owner.canonical(checkpoint))return
      const linked=await owner.transitionSharedTask({claim,operationId:prepared.receiptIds.checkpointLink,transition:{kind:'checkpoint',checkpoint,recovery:{...task.recovery,checkpoint}}})
      if(linked.kind!=='owned')throw Error('checkpoint-pointer-unconfirmed')
      await helpers.updateRun(controller.root,run.runId,r=>({sharedClaim:r.sharedClaim?{...r.sharedClaim,stateCommit:linked.claim.stateCommit}:null}))
    }
  }
  return controller
}
export async function flushRunCheckpoint(run:RunRecord,config:import('./config.ts').FactoryConfig):Promise<void>{
  if(!run.checkpointIntent)return
  const controller=await configuredCheckpointController(run,config)
  const head=(await git(run.checkout,['rev-parse','HEAD'])).trim()
  const candidate=await prepareCheckpoint({run,approvedIntent:run.checkpointIntent,headSha:head},controller)
  await publishCheckpoint(candidate,controller)
}
export async function runCheckpointCli(args:string[],home:string):Promise<number>{
  const {loadFactoryConfig}=await import('./config.ts'),{readRun,runsRoot,readPrivateRunFile}=await import('./runs.ts')
  if(args.includes('--help')){console.log('vegafactory checkpoint --run-id ID [--json] [--write]\nInspect saved checkpoint by default. --write requires an existing exact approved intent.\nvegafactory checkpoint --register-execution FILE [--json] registers an existing verified qualification; it launches no task.');return 0}
  if(args.includes('--register-execution')){
    const at=args.indexOf('--register-execution'),file=args[at+1]
    if(!file||args.filter(a=>a==='--register-execution').length!==1||args.some((a,n)=>!['--register-execution','--json'].includes(a)&&n!==at+1)){console.error('registration requires one private request file');return 2}
    try{const {parseStrictJson}=await import('../../../skills/dev/dev-implement/scripts/lib/approval.mjs'),config=await loadFactoryConfig((await import('./control-room.ts')).factoryConfigPath(home),home),request=parseStrictJson(await readPrivateRunFile(file)),qualificationId=await(await import('./dispatch.ts')).registerExecutionRequest(request,config);console.log(JSON.stringify({registered:true,executionEvidenceId:qualificationId}));return 0}catch{console.error('execution registration refused; no task was launched');return 2}
  }
  const index=args.indexOf('--run-id'),id=args[index+1]
  if(index<0||!id||args.some((a,n)=>!['--run-id','--json','--write'].includes(a)&&n!==index+1)){console.error('checkpoint requires --run-id ID');return 2}
  try{const run=await readRun(runsRoot(home),id);if(!args.includes('--write')){console.log(JSON.stringify({runId:run.runId,state:run.state,checkpoint:run.checkpoint,pendingDelivery:run.pendingDelivery.filter(p=>p.kind==='feature-push').map(p=>({id:p.id,status:p.status,lastError:p.lastError})),canPrepare:!!run.checkpointIntent}));return 0}
    if(!run.checkpointIntent)throw Error('recorded checkpoint intent unavailable')
    const config=await loadFactoryConfig((await import('./control-room.ts')).factoryConfigPath(home),home),controller=await configuredCheckpointController(run,config),head=(await git(run.checkout,['rev-parse','HEAD'])).trim()
    const candidate=await prepareCheckpoint({run,approvedIntent:run.checkpointIntent,headSha:head},controller),result=await publishCheckpoint(candidate,controller);console.log(JSON.stringify(result));return result.kind==='acknowledged'?0:2
  }catch{console.error('checkpoint refused; saved local work is preserved');return 2}
}

// The producer reads a real canonical action from135; profile defaults alone never create intent.
export async function checkpointIntentFromApproval(run:RunRecord,config:import('./config.ts').FactoryConfig):Promise<CheckpointIntent|null>{
  if(run.authorityRequest?.kind!=='consolidated')return null
  const helpers=await import('./runs.ts'),{ghText,boundedGhJson,readBudget}=await import('./gh.ts'),{loadConfiguredPolicy}=await import('./control-room.ts'),{repoPolicyFromEffective}=await import('./config.ts'),{readFile}=await import('node:fs/promises'),{join}=await import('node:path')
  await helpers.verifyRunAuthority(run,config)
  const entry=config.repos.find(e=>e.repo===run.repo);if(!entry)throw Error('checkpoint repository unconfigured')
  const devMd=await readFile(join(entry.path,'.vegastack','dev.md'),'utf8'),policy=repoPolicyFromEffective(loadConfiguredPolicy({home:config.home,repo:run.repo,devMd,settingsPath:config.settingsPath})),{approval}=await helpers.approvalTools()
  const {kind:_,...source}=run.authorityRequest,readJson=(args:string[])=>boundedGhJson(ghText,args,readBudget())
  const validated=await approval.gatherConsolidatedApproval({...source,operators:policy.operators,readJson})
  if(!validated.ok)throw Error('original checkpoint source authority unavailable')
  const comment=await readJson(['api',`repos/${source.parentRepo}/issues/comments/${source.approvalBinding.commentId}`]) as {body:string;id:number;user:{login:string}}
  const event=approval.parseApproval(comment)
  if(event.kind!=='consolidated')throw Error('checkpoint source is not consolidated authority')
  const selected=event.items.find((item:{repo:string;issue:number})=>item.repo===run.repo&&item.issue===run.issue)
  const actions=event.actions.filter((action:{kind:string;id:string;branch?:string})=>action.kind==='checkpoint'&&selected?.actionIds.includes(action.id)&&action.branch===run.branch)
  if(!actions.length)return null
  if(actions.length!==1)throw Error('checkpoint action is ambiguous')
  const request:NonNullable<CheckpointIntent['approvalRequest']>={...source,requested:{...source.requested,actionId:actions[0].id,paths:validated.files,operation:'checkpoint'}}
  const allowed=await approval.gatherConsolidatedApproval({...request,operators:policy.operators,readJson})
  if(!allowed.ok||allowed.action.kind!=='checkpoint')throw Error('checkpoint action scope refused')
  const repository=await readJson(['api',`repos/${run.repo}`]) as {node_id:string;default_branch:string}
  const intent:CheckpointIntent={id:allowed.action.id,repo:run.repo,repositoryId:repository.node_id,remote:'origin',remoteUrl:(await git(run.checkout,['remote','get-url','origin'])).trim(),branch:run.branch,baseRef:`refs/heads/${repository.default_branch}`,baseSha:run.baseSha,scopeDigest:run.taskKey.scopeDigest,paths:allowed.files,approvalBindings:run.approvalBindings,approvalRequest:request}
  validateCheckpointIntentShape(intent)
  return intent
}

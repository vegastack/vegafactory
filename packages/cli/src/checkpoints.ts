import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { type RunRecord, transitionRun, readRun, type PendingDelivery, validateAuthority } from './runs.ts'
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
  prepareEffect?:(candidate:CheckpointCandidate,delivery:PendingDelivery)=>Promise<void>
  acknowledgeEffect?:(candidate:CheckpointCandidate,delivery:PendingDelivery,checkpoint:CheckpointRef)=>Promise<void>
}
async function git(cwd:string,args:string[]):Promise<string>{try{return(await exec('git',args,{cwd,encoding:'utf8',timeout:10_000,maxBuffer:16*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout}catch{throw Error('checkpoint-git-refused')}}
const sha=/^[a-f0-9]{40}$/
const sensitive=/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})|(?:credential|secret|token)[-_ ]?canary|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,})/i
function permitted(path:string,paths:string[]){return paths.some(p=>path===p || p.endsWith('/')&&path.startsWith(p))}
async function remoteState(run:RunRecord,intent:CheckpointIntent){
  if((await git(run.checkout,['remote','get-url',intent.remote])).trim()!==intent.remoteUrl)throw Error('checkpoint-remote-identity-mismatch')
  const advertised=await git(run.checkout,['ls-remote','--symref',intent.remote,'HEAD',intent.baseRef,`refs/heads/${intent.branch}`])
  const defaultRef=/^ref: (refs\/heads\/[^\t]+)\tHEAD$/m.exec(advertised)?.[1]
  if(!defaultRef || defaultRef===`refs/heads/${intent.branch}`)throw Error('checkpoint-default-branch-refused')
  const rows=advertised.split('\n').map(x=>x.split('\t'));const tip=rows.find(x=>x[1]===`refs/heads/${intent.branch}`)?.[0]??null
  const baseTip=rows.find(x=>x[1]===intent.baseRef)?.[0];if(!baseTip||!sha.test(baseTip))throw Error('checkpoint-base-unverified')
  await git(run.checkout,['fetch','--no-tags','--no-recurse-submodules',intent.remote,intent.baseRef])
  await git(run.checkout,['merge-base','--is-ancestor',intent.baseSha,baseTip])
  if(tip){if(!sha.test(tip))throw Error('checkpoint-remote-tip-invalid');await git(run.checkout,['fetch','--no-tags','--no-recurse-submodules',intent.remote,`refs/heads/${intent.branch}`])}
  return tip
}
export async function prepareCheckpoint(input:{run:RunRecord;approvedIntent:CheckpointIntent;headSha:string},controller:CheckpointController):Promise<CheckpointCandidate>{
  const {run,approvedIntent:i,headSha}=input
  if(i.repo!==run.repo||i.branch!==run.branch||i.baseSha!==run.baseSha||i.scopeDigest!==run.taskKey.scopeDigest||!sha.test(headSha)||!sha.test(i.baseSha)||!i.id||!i.repositoryId||!i.approvalBindings.length||!i.paths.length||i.paths.some(p=>!p||p.startsWith('/')||p.split('/').includes('..')||/[\x00-\x1f*?\[\]{}]/.test(p))||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(i.branch)||i.branch.includes('..')||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(i.remote)||!i.baseRef.startsWith('refs/heads/'))throw Error('checkpoint-intent-refused')
  i.approvalBindings.forEach(validateAuthority)
  if(JSON.stringify(i.approvalBindings)!==JSON.stringify(run.approvalBindings))throw Error('checkpoint-authority-rebound')
  await controller.verifyAuthority(i)
  const tip=await remoteState(run,i)
  await git(run.checkout,['merge-base','--is-ancestor',i.baseSha,headSha])
  if(tip){try{await git(run.checkout,['merge-base','--is-ancestor',tip,headSha])}catch{await git(run.checkout,['merge-base','--is-ancestor',headSha,tip])}}
  const commits=(await git(run.checkout,['rev-list',headSha,`^${i.baseSha}`])).trim().split('\n').filter(Boolean)
  const closure:string[]=[]
  for(const commit of commits){
    const raw=await git(run.checkout,['cat-file','commit',commit]);if(sensitive.test(raw))throw Error('checkpoint-sensitive-commit')
    const paths=(await git(run.checkout,['diff-tree','--root','-m','--no-commit-id','--name-only','-r','-z',commit])).split('\0').filter(Boolean)
    if(paths.some(p=>!permitted(p,i.paths)||/(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials|\.vegastack\/(?:runs|state))(?:\/|$)/i.test(p)))throw Error('checkpoint-out-of-scope-history')
    closure.push(commit+':'+digest(raw))
  }
  const objects=(await git(run.checkout,['rev-list','--objects',headSha,`^${i.baseSha}`])).trim().split('\n').filter(Boolean)
  for(const row of objects){const oid=row.split(' ')[0]!;const kind=(await git(run.checkout,['cat-file','-t',oid])).trim();const size=Number((await git(run.checkout,['cat-file','-s',oid])).trim());if(!Number.isSafeInteger(size)||size>8*1024*1024)throw Error('checkpoint-object-bound');if(kind==='blob'){const content=await git(run.checkout,['cat-file','blob',oid]);if(sensitive.test(content))throw Error('checkpoint-sensitive-history');closure.push(oid+':'+digest(content))}else if(!['commit','tree'].includes(kind))throw Error('checkpoint-unknown-object');else closure.push(oid+':'+kind)}
  return{run,approvedIntent:i,headSha,treeSha:(await git(run.checkout,['rev-parse',`${headSha}^{tree}`])).trim(),noChange:tip===headSha||headSha===i.baseSha,exportProof:{repositoryId:i.repositoryId,remoteRef:`refs/heads/${i.branch}`,verifiedRemoteHead:tip,approvedBaseSha:i.baseSha,headSha,closureDigest:digest(closure.sort().join('\n')),validatorVersion:1}}
}
export async function publishCheckpoint(candidate:CheckpointCandidate,controller:CheckpointController):Promise<{kind:'acknowledged'|'pending'|'refused';checkpoint:CheckpointRef|null;reason:string|null}>{
  let record=await readRun(controller.root,candidate.run.runId)
  try{
    const fresh=await prepareCheckpoint({run:record,approvedIntent:candidate.approvedIntent,headSha:candidate.headSha},controller)
    if(fresh.noChange && record.checkpoint?.headSha===candidate.headSha)return{kind:'acknowledged',checkpoint:record.checkpoint,reason:null}
    if(fresh.noChange && fresh.exportProof.verifiedRemoteHead!==candidate.headSha)return{kind:'acknowledged',checkpoint:null,reason:'no-change'}
    const i=fresh.approvedIntent
    let delivery=record.pendingDelivery.find(p=>p.kind==='feature-push'&&'sha'in p.target&&p.target.sha===fresh.headSha&&p.intentRef===i.id)
    if(!delivery){delivery={id:randomUUID(),kind:'feature-push',target:{repo:i.repo,remote:i.remote,branch:i.branch,sha:fresh.headSha},intentRef:i.id,exportProof:fresh.exportProof,approvalBindings:i.approvalBindings,status:'pending',attempts:0,lastError:null};record=await transitionRun(record.runId,record.generation,{pendingDelivery:[...record.pendingDelivery,delivery]},controller.root)}
    if(JSON.stringify(delivery.exportProof)!==JSON.stringify(fresh.exportProof)){delivery={...delivery,exportProof:fresh.exportProof,approvalBindings:i.approvalBindings};record=await transitionRun(record.runId,record.generation,{pendingDelivery:record.pendingDelivery.map(p=>p.id===delivery!.id?delivery!:p)},controller.root)}
    if(record.sharedClaim&&!controller.prepareEffect)throw Error('checkpoint-shared-intent-unavailable')
    await controller.prepareEffect?.(fresh,delivery)
    const update=async(status:PendingDelivery['status'],lastError:string|null)=>{delivery={...delivery!,status,lastError,attempts:delivery!.attempts+1};record=await transitionRun(record.runId,record.generation,{pendingDelivery:record.pendingDelivery.map(p=>p.id===delivery!.id?delivery!:p)},controller.root)}
    await update('ambiguous',null)
    try{
      let alreadyPresent=false
      if(fresh.exportProof.verifiedRemoteHead)try{await git(record.checkout,['merge-base','--is-ancestor',fresh.headSha,fresh.exportProof.verifiedRemoteHead]);alreadyPresent=true}catch{}
      if(!alreadyPresent)await git(record.checkout,['-c','push.followTags=false','push','--no-follow-tags','--recurse-submodules=no',i.remoteUrl,`${fresh.headSha}:refs/heads/${i.branch}`])
      const tip=await remoteState(record,i);if(!tip)throw Error('checkpoint-readback-missing');await git(record.checkout,['merge-base','--is-ancestor',fresh.headSha,tip])
      const checkpoint:CheckpointRef={schemaVersion:1,id:delivery.id,repo:i.repo,repositoryId:i.repositoryId,branch:i.branch,baseSha:i.baseSha,headSha:fresh.headSha,treeSha:fresh.treeSha,scopeDigest:i.scopeDigest,runId:record.runId,publishedAt:new Date().toISOString()}
      if(record.sharedClaim&&!controller.acknowledgeEffect)throw Error('checkpoint-shared-pointer-unavailable')
      await controller.acknowledgeEffect?.(fresh,delivery,checkpoint)
      await update('acknowledged',null);record=await transitionRun(record.runId,record.generation,{checkpoint},controller.root)
      return{kind:'acknowledged',checkpoint,reason:null}
    }catch{await update('ambiguous','checkpoint-delivery-unconfirmed');return{kind:'pending',checkpoint:record.checkpoint,reason:'checkpoint-delivery-unconfirmed'}}
  }catch(e){return{kind:'refused',checkpoint:record.checkpoint,reason:(e as Error).message}}
}

export async function configuredCheckpointController(run:RunRecord,config:import('./config.ts').FactoryConfig):Promise<CheckpointController>{
  const {loadConfiguredPolicy}=await import('./control-room.ts'),{readFile}=await import('node:fs/promises'),{join,dirname}=await import('node:path'),{fileURLToPath,pathToFileURL}=await import('node:url'),{ghText,boundedGhJson,readBudget}=await import('./gh.ts')
  const entry=config.repos.find(r=>r.repo===run.repo);if(!entry||run.checkout!==await (await import('node:fs/promises')).realpath(run.checkout))throw Error('checkpoint checkout unavailable')
  const verifyAuthority=async(intent:CheckpointIntent)=>{
    const request=intent.approvalRequest
    if(!request||request.requested.repo!==run.repo||request.requested.issue!==run.issue||request.requested.operation!=='checkpoint'||request.requested.branch!==run.branch||request.requested.baseSha!==run.baseSha||JSON.stringify(request.requested.paths)!==JSON.stringify(intent.paths))throw Error('checkpoint canonical approval request unavailable')
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
    if(tuples.some(t=>!Number.isSafeInteger(t.commentId))||JSON.stringify(tuples)!==JSON.stringify(verified.approvalBindings))throw Error('checkpoint canonical authority changed')
  }
  return{root:(await import('./runs.ts')).runsRoot(config.home),verifyAuthority}
}
export async function flushRunCheckpoint(run:RunRecord,config:import('./config.ts').FactoryConfig):Promise<void>{
  if(!run.checkpointIntent)return
  const controller=await configuredCheckpointController(run,config)
  const head=(await git(run.checkout,['rev-parse','HEAD'])).trim()
  const candidate=await prepareCheckpoint({run,approvedIntent:run.checkpointIntent,headSha:head},controller)
  await publishCheckpoint(candidate,controller)
}
export async function runCheckpointCli(args:string[],home:string):Promise<number>{
  const {loadFactoryConfig}=await import('./config.ts'),{readRun,runsRoot}=await import('./runs.ts')
  if(args.includes('--help')){console.log('vegafactory checkpoint --run-id ID [--json] [--write]\nInspect saved checkpoint by default. --write requires an existing exact approved intent.');return 0}
  const index=args.indexOf('--run-id'),id=args[index+1]
  if(index<0||!id||args.some((a,n)=>!['--run-id','--json','--write'].includes(a)&&n!==index+1)){console.error('checkpoint requires --run-id ID');return 2}
  try{const run=await readRun(runsRoot(home),id);if(!args.includes('--write')){console.log(JSON.stringify({runId:run.runId,state:run.state,checkpoint:run.checkpoint,pendingDelivery:run.pendingDelivery.filter(p=>p.kind==='feature-push').map(p=>({id:p.id,status:p.status,lastError:p.lastError})),canPrepare:!!run.checkpointIntent}));return 0}
    if(!run.checkpointIntent)throw Error('recorded checkpoint intent unavailable')
    const config=await loadFactoryConfig((await import('./control-room.ts')).factoryConfigPath(home),home),controller=await configuredCheckpointController(run,config),head=(await git(run.checkout,['rev-parse','HEAD'])).trim()
    const candidate=await prepareCheckpoint({run,approvedIntent:run.checkpointIntent,headSha:head},controller),result=await publishCheckpoint(candidate,controller);console.log(JSON.stringify(result));return result.kind==='acknowledged'?0:2
  }catch{console.error('checkpoint refused; saved local work is preserved');return 2}
}

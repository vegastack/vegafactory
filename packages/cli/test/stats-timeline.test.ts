import { expect, test } from 'bun:test'
import { fetchTimelines, timelineFromApi } from '../src/stats/timeline.ts'

const issue = { created_at: '2026-09-01T00:00:00.000Z' }
const events = [
  { event: 'labeled', label: { name: 'ready' }, created_at: '2026-09-01T00:00:00.000Z' },
  { event: 'commented', created_at: '2026-09-01T06:00:00.000Z' },
  { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-09-01T12:00:00.000Z' },
  { event: 'labeled', label: { name: 'working' }, created_at: '2026-09-01T12:00:00.000Z' },
  { event: 'closed', created_at: '2026-09-03T00:00:00.000Z' },
  { event: 'renamed', created_at: '2026-09-02T00:00:00.000Z' },
]

test('the API timeline becomes the rollup\'s events: created, labeled, unlabeled, closed, reopened — nothing else', () => {
  expect(timelineFromApi(121, issue, events)).toEqual([
    { issue: 121, event: 'created', label: null, created_at: '2026-09-01T00:00:00.000Z' },
    { issue: 121, event: 'labeled', label: 'ready', created_at: '2026-09-01T00:00:00.000Z' },
    { issue: 121, event: 'unlabeled', label: 'ready', created_at: '2026-09-01T12:00:00.000Z' },
    { issue: 121, event: 'labeled', label: 'working', created_at: '2026-09-01T12:00:00.000Z' },
    { issue: 121, event: 'closed', label: null, created_at: '2026-09-03T00:00:00.000Z' },
  ])
  expect(timelineFromApi(5, {}, 'not a list' as never)).toEqual([])
})

test('fetchTimelines reads each issue once and fails closed as a whole when gh cannot answer', async () => {
  const calls: string[][] = []
  const gh = async (args: string[]): Promise<unknown> => {
    calls.push(args)
    if (args[1]!.endsWith('/timeline')) return events
    return issue
  }
  const result = await fetchTimelines('vegastack/vegafactory', [122, 121, 121], gh)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(result.events.map((event) => event.issue)).toEqual([121, 121, 121, 121, 121, 122, 122, 122, 122, 122])
  expect(calls.map((args) => args[1])).toEqual([
    'repos/vegastack/vegafactory/issues/121', 'repos/vegastack/vegafactory/issues/121/timeline',
    'repos/vegastack/vegafactory/issues/122', 'repos/vegastack/vegafactory/issues/122/timeline',
  ])
  const refused = await fetchTimelines('vegastack/vegafactory', [121], async () => { throw new Error('HTTP 403: rate limited') })
  expect(refused).toEqual({ ok: false, reason: 'HTTP 403: rate limited' })
})

test('activity discovery refuses incomplete all-state enumeration and retains the last complete observation', async () => {
  const { collectTaskActivities } = await import('../src/stats/timeline.ts')
  const prior = { activities: [], snapshots: [], complete: true, reason: null, observedAt: '2026-09-01T00:00:00.000Z', sourceDigest: 'a'.repeat(64) }
  const paths: string[] = []
  const result = await collectTaskActivities({ repo: 'o/project.docs', period: '2026-09', prior, gh: async args => {
    paths.push(args[1]!)
    if(args[1] === 'repos/o/project.docs')return JSON.stringify({node_id:'R_one',full_name:'o/project.docs',default_branch:'main'})
    return 'HTTP/2.0 200 OK\nLink: <https://api.github.com/repos/o/project.docs/issues?page=2>; rel="next"\n\n[]'
  } })
  expect(paths).toContain('repos/o/project.docs/issues?state=all&sort=created&direction=asc&per_page=100')
  expect(result.complete).toBe(false)
  expect(result.observedAt).toBe(prior.observedAt)
  expect(result.sourceDigest).toBe(prior.sourceDigest)
  expect(result.reason).toBeTruthy()
})

async function acceptedFixture(options: {truncated?:boolean;tamper?:boolean;changed?:boolean;commits?:number;transform?:boolean;badTree?:boolean;partial?:boolean;omitReceipt?:boolean;release?:boolean;tagDrift?:boolean} = {}) {
  const { canonicalJson, hashBytes } = await import('../src/stats/types.ts')
  const { taskKey, operationPath } = await import('../src/shared-claims.ts')
  const { acceptedDeliveryProjection } = await import('../src/children.ts')
  const { mkdtemp } = await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
  const root=await mkdtemp(join(tmpdir(),'metric-activities-'))
  const repo='o/project.docs',codeRepoId='R_code',issueNode='I_child',parentNode='I_parent'
  const oid=(n:number)=>n.toString(16).padStart(40,'0'),uuid=(n:number)=>`10000000-0000-4000-8000-${n.toString().padStart(12,'0')}`
  const stateHead=oid(1),receiptHead=oid(2),stateRoot=oid(3),childHead=oid(4),parentHead=oid(5),mergedHead=oid(6),treeId=oid(7)
  const scopeDigest='a'.repeat(64),key=taskKey('github.com',codeRepoId,issueNode)
  const approvals=[{approvalId:'approved',source:{kind:'github-comment' as const,repositoryId:codeRepoId,issueNodeId:issueNode,commentId:'100',bodySha256:'b'.repeat(64)}}]
  const scope={schemaVersion:2 as const,repo,issue:1,artifacts:[{repo,issue:1,kind:'plan' as const,artifactId:'IC_plan',rev:1,digest:'c'.repeat(64)}],approvalBindings:approvals,approvedTaskIds:['148-T1','148-T2'],completedTaskIds:options.partial?['148-T1']:['148-T1','148-T2'],parentRepo:repo,parentIssue:2,parentBefore:oid(8),parentAfter:parentHead,acceptedAt:'2026-08-20T00:00:00.000Z'}
  const payload={schemaVersion:2,kind:'acceptance',taskId:'148-T1',runId:uuid(1),sourceSha:childHead,scopeDigest,validationId:'fixture/check/'+ '1'.repeat(64),commandDigest:'d'.repeat(64),result:'passed',acceptedScope:scope}
  const owner={ownerToken:uuid(2),machineId:'machine-one',installationId:uuid(3),sessionId:uuid(4),runId:uuid(1)}
  const receipt={schemaVersion:1,operationId:uuid(5),type:'receipt',taskKey:key,generation:1,previousHead:stateRoot,requestDigest:'e'.repeat(64),resultOwner:owner,recoveryPayload:payload}
  const receiptBytes=canonicalJson(receipt),ref={kind:'state-receipt' as const,operationId:uuid(5),commitSha:receiptHead,blobSha256:hashBytes(receiptBytes)}
  const task={schemaVersion:1,taskKey:key,host:'github.com',repo,issue:1,repositoryNodeId:codeRepoId,issueNodeId:issueNode,scopeDigest,approvalDigest:'f'.repeat(64),approvalBindings:approvals,generation:1,...owner,stage:'implement',state:'completed',paths:[],resources:[],independent:false,parentTaskKey:null,approvedTaskIds:scope.approvedTaskIds,checkpoint:null,stopProof:null,unresolvedEffects:[],recovery:null,acceptedScopes:options.omitReceipt?[]:[{scopeDigest,receipt:ref}]}
  const index={schemaVersion:1,installationId:uuid(9),revision:1,active:[],machines:[]}
  const deliveryRows=acceptedDeliveryProjection(scope,childHead,scopeDigest)
  const block=(name:string,value:unknown)=>'```json\n'+JSON.stringify({[name]:value})+'\n```'
  const pr={number:3,node_id:'PR_delivery',merged:true,merged_at:'2026-09-10T00:00:00.000Z',merge_commit_sha:mergedHead,commits:options.commits??1,head:{sha:parentHead,repo:{full_name:repo}},base:{sha:oid(8),ref:'main',repo:{full_name:repo}}}
  let body=block('acceptedDeliveries',deliveryRows)
  if(options.transform){
    const evidenceRef=`https://github.com/${repo}/issues/2#issuecomment-200`
    body+='\n'+block('parentDelivery',{repo,parentIssue:2,pr:3,prNodeId:pr.node_id,acceptedParentHead:parentHead,baseRepo:repo,baseRef:'main',mergedAt:pr.merged_at,mergedCommit:mergedHead,transformation:{kind:'squash',reviewedHead:parentHead,mergedHead,evidenceRef}})
    body+='\n'+block('deliveryVerification',{reviewedHead:parentHead,mergedHead,baseSha:oid(8),acceptedTree:treeId,mergedTree:treeId,check:{sha:mergedHead,exit:0},rangeHead:mergedHead,evidenceRef})
  }
  const comment={id:200,node_id:'IC_delivery',body,created_at:'2026-08-20T00:00:00.000Z',updated_at:'2026-09-10T01:00:00.000Z'}
  const issue=(number:number,node_id:string)=>({id:number,node_id,number,body:'Current edited brief does not contain old scope',created_at:'2026-08-01T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'})
  const issues=[issue(1,issueNode),issue(2,parentNode)]
  const calls:string[]=[]
  const http=(value:unknown,link?:string)=>'HTTP/2.0 200 OK\nContent-Type: application/json\n'+(link?'Link: <'+link+'>; rel="next"\n':'')+'\n'+JSON.stringify(value)
  const gh:import('../src/gh.ts').GhReader=async args=>{
    const path=args[1]!,url=new URL(path,'https://api.github.com/');calls.push(path)
    if(url.pathname===`/repos/${repo}/releases`)return http(options.release?[{id:401,node_id:'RE_first',draft:false,tag_name:'v1.0.0',published_at:'2026-09-11T00:00:00.000Z',body:'release'},{id:402,node_id:'RE_later',draft:false,tag_name:'v1.1.0',published_at:'2026-09-20T00:00:00.000Z',body:'later'}]:[])
    if(path===`repos/${repo}/releases/401`)return JSON.stringify({id:401,node_id:'RE_first',draft:false,tag_name:'v1.0.0',published_at:'2026-09-11T00:00:00.000Z',body:'release'})
    if(path===`repos/${repo}/releases/402`)return JSON.stringify({id:402,node_id:'RE_later',draft:false,tag_name:'v1.1.0',published_at:'2026-09-20T00:00:00.000Z',body:'later'})
    if(path.startsWith(`repos/${repo}/git/ref/tags/`)){const name=path.split('/tags/')[1]!;return JSON.stringify({ref:'refs/tags/'+name,object:{type:'commit',sha:options.tagDrift&&calls.filter(call=>call===path).length>1?oid(99):mergedHead}})}
    if(path===`repos/${repo}`)return JSON.stringify({node_id:codeRepoId,full_name:repo,default_branch:'main'})
    if(url.pathname===`/repos/${repo}/issues`)return http([...issues,{id:3,node_id:'PR_delivery',number:3,pull_request:{}}])
    if(url.pathname===`/repos/${repo}/issues/1/comments`)return http([])
    if(url.pathname===`/repos/${repo}/issues/2/comments`)return http([comment])
    if(url.pathname===`/repos/${repo}/issues/1/timeline`)return http([{id:1,node_id:'EV_closed',event:'closed',created_at:'2026-10-01T00:00:00Z'}])
    if(url.pathname===`/repos/${repo}/issues/2/timeline`)return http([{id:2,node_id:'EV_cross',event:'cross-referenced',source:{issue:{number:3,pull_request:{url:`https://api.github.com/repos/${repo}/pulls/3`}}}}])
    if(path===`repos/${repo}/issues/1`)return JSON.stringify(issues[0])
    if(path===`repos/${repo}/issues/2`)return JSON.stringify(issues[1])
    if(path===`repos/${repo}/issues/comments/200`)return JSON.stringify({...comment,...(options.changed?{body:body+'edited'}:{})})
    if(path===`repos/${repo}/pulls/3`)return JSON.stringify(pr)
    if(url.pathname===`/repos/${repo}/pulls/3/commits`){
      const page=Number(url.searchParams.get('page')??1),count=Math.min(pr.commits,250),start=(page-1)*100
      return http(Array.from({length:Math.min(100,count-start)},(_,i)=>({node_id:'C_'+(start+i),sha:start+i===0?parentHead:oid(100+start+i)})),start+100<count?`https://api.github.com/repos/${repo}/pulls/3/commits?page=${page+1}`:undefined)
    }
    if(path.startsWith(`repos/${repo}/compare/`))return JSON.stringify({status:'ahead',base_commit:{sha:path.split('/compare/')[1]!.split('...')[0]}})
    if(path===`repos/o/private/git/commits/${stateHead}`)return JSON.stringify({sha:stateHead,tree:{sha:oid(10)}})
    if(path===`repos/o/private/git/trees/${oid(10)}`)return JSON.stringify({sha:oid(10),truncated:false,tree:[{path:'coordination',mode:'040000',type:'tree',sha:oid(11)}]})
    if(path===`repos/o/private/git/trees/${oid(11)}`)return JSON.stringify({sha:oid(11),truncated:false,tree:[{path:'tasks',mode:'040000',type:'tree',sha:oid(12)}]})
    if(path===`repos/o/private/git/trees/${oid(12)}`)return JSON.stringify({sha:oid(12),truncated:options.truncated??false,tree:[{path:key+'.json',mode:'100644',type:'blob',sha:oid(13)}]})
    if(path===`repos/${repo}/git/commits/${parentHead}`)return JSON.stringify({sha:parentHead,tree:{sha:treeId}})
    if(path===`repos/${repo}/git/commits/${mergedHead}`)return JSON.stringify({sha:mergedHead,tree:{sha:options.badTree?oid(99):treeId}})
    throw Error('Unexpected read '+path)
  }
  const target:import('../src/shared-claims.ts').CoordinationTarget={host:'github.com',repository:'o/private',repositoryId:'R_state',branch:'coordination',rootCommit:stateRoot,installationId:uuid(9),localRoot:root,provider:{branch:async()=>({id:'REF_state',head:stateHead,repositoryId:'R_state',private:true,defaultBranch:'main'}),compare:async()=> 'ahead',read:async(_t,_commit,path)=>{
    if(path==='coordination/index.json')return canonicalJson(index)
    if(path===`coordination/tasks/${key}.json`)return canonicalJson(task)
    if(path===operationPath(ref.operationId))return options.tamper?receiptBytes+' ':receiptBytes
    return null
  },commit:async()=>{throw Error('no writes')}},verifyCandidate:async()=>{throw Error('no execution')},verifyTransition:async()=>{throw Error('no execution')},verifyEvidence:async()=>{throw Error('old private home unavailable')}}
  return {root,repo,gh,target,calls,deliveryRows}
}

test('complete immutable accepted scope reports September parent delivery with no runs and edited current brief', async () => {
  const {collectTaskActivities}=await import('../src/stats/timeline.ts'),{summarizeIssueMonth}=await import('../src/stats/metrics.ts'),{rm}=await import('node:fs/promises')
  const f=await acceptedFixture()
  try{
    const result=await collectTaskActivities({repo:f.repo,period:'2026-09',gh:f.gh,coordination:f.target})
    expect(result.reason).toBeNull()
    expect(result.complete).toBe(true)
    expect(summarizeIssueMonth(result.activities,'2026-09')).toMatchObject({mergedIssues:1,mergedTasks:2,implementedTasks:0})
    expect(result.activities.filter(a=>a.kind==='implemented')).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('state-receipt')
    expect(JSON.stringify(result)).not.toContain('ownerToken')
    expect(f.calls.some(path=>path.includes('state=all'))).toBe(true)
  }finally{await rm(f.root,{recursive:true,force:true})}
})

test('missing/tampered receipt, truncated tree and changed public container refuse the generation', async () => {
  const {collectTaskActivities}=await import('../src/stats/timeline.ts'),{rm}=await import('node:fs/promises')
  for(const options of [{tamper:true},{truncated:true},{changed:true},{omitReceipt:true},{partial:true}]){
    const f=await acceptedFixture(options)
    try{const result=await collectTaskActivities({repo:f.repo,period:'2026-09',gh:f.gh,coordination:f.target});expect(result.complete).toBe(false);expect(result.activities).toEqual([])}finally{await rm(f.root,{recursive:true,force:true})}
  }
})

test('251-commit cap requires independent exact parent delivery proof and matching actual trees', async () => {
  const {collectTaskActivities}=await import('../src/stats/timeline.ts'),{rm}=await import('node:fs/promises')
  for(const [options,complete] of [[{commits:251},false],[{commits:251,transform:true},true],[{commits:251,transform:true,badTree:true},false]] as const){
    const f=await acceptedFixture(options)
    try{const result=await collectTaskActivities({repo:f.repo,period:'2026-09',gh:f.gh,coordination:f.target});expect({complete:result.complete,reason:result.reason}).toMatchObject({complete});if(complete)expect(result.activities.filter(a=>a.kind==='merged')).toHaveLength(2)}finally{await rm(f.root,{recursive:true,force:true})}
  }
})

test('actual CLI rollup/activity/show discover September delivery independently of August-only records', async () => {
  const {runStats,parseStatsArgs}=await import('../src/stats/cli.ts'),{resolvePolicy}=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  const fs=await import('node:fs/promises'),{join}=await import('node:path'),f=await acceptedFixture(),lines:string[]=[]
  try{
    const org='stats: on\nstats-people: on\nstats-export: attributed\n```vsk-policy\n'+JSON.stringify({schemaVersion:2,administration:{orgAdmins:['reader'],groupAdmins:{},groupAdminCapabilities:{}}})+'\n```'
    const effective=resolvePolicy({org,identity:{org:'o',repo:f.repo,group:'dev',peopleByScope:{org:[{login:'reader',groups:['dev']}]},repoGroups:{[f.repo]:'dev'}}})
    expect(effective.ok).toBe(true)
    const base:import('../src/stats/cli.ts').StatsDeps={home:f.root,cloneRoot:join(f.root,'clone'),hostname:'fixture',ghUser:'reader',login:'reader',viewerVerified:true,isLead:false,org:'o',repo:f.repo,policy:{enabled:true,people:true,source:'org',refusal:null},effectivePolicy:effective.policy,git:async()=>{throw Error('read only')},gh:async()=>{throw Error('legacy discovery forbidden')},readGh:f.gh,activityTarget:async()=>f.target,readStdin:async()=>'',readTranscript:async()=>[],now:()=>new Date('2026-09-15T00:00:00Z'),log:line=>lines.push(line)}
    const path=join(base.cloneRoot,'stats','o__project.docs','AUG-2026');await fs.mkdir(path,{recursive:true});await fs.writeFile(join(path,'legacy.jsonl'),JSON.stringify({repo:f.repo,ts:'2026-08-01T00:00:00Z',stage:'implement',cost_usd:1})+'\n')
    expect(await runStats(parseStatsArgs(['rollup','--json']),base)).toBe(0)
    expect(JSON.parse(lines.at(-1)!).report.repos[0]).toMatchObject({runs:0,taskActivity:{mergedIssues:1,mergedTasks:2}})
    lines.length=0
    expect(await runStats(parseStatsArgs(['activity','--org','o','--repo',f.repo,'--month','2026-09','--json']),base)).toBe(0)
    expect(JSON.parse(lines.at(-1)!).activities.filter((a:{kind:string})=>a.kind==='merged')).toHaveLength(2)
    lines.length=0
    expect(await runStats(parseStatsArgs(['--json']),{...base,readGh:async()=>{throw Error('show is local')}})).toBe(0)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({runs:0,taskActivity:{mergedIssues:1,mergedTasks:2}})
    const before=f.calls.length
    expect(await runStats(parseStatsArgs(['activity','--org','other','--repo','other/private','--month','2026-09','--json']),base)).toBe(2)
    expect(f.calls.length).toBe(before)
  }finally{await fs.rm(f.root,{recursive:true,force:true})}
})

test('release linkage counts each accepted task in its first verified published tag and refuses tag drift', async () => {
  const {collectTaskActivities}=await import('../src/stats/timeline.ts'),{summarizeIssueMonth}=await import('../src/stats/metrics.ts'),{rm}=await import('node:fs/promises')
  for(const drift of [false,true]){
    const f=await acceptedFixture({release:true,tagDrift:drift})
    try{
      const result=await collectTaskActivities({repo:f.repo,period:'2026-09',gh:f.gh,coordination:f.target})
      expect(result.complete).toBe(!drift)
      if(!drift){expect(summarizeIssueMonth(result.activities,'2026-09').releasedTasks).toBe(2);expect(result.activities.filter(a=>a.kind==='released').map(a=>a.sourceRef.nodeId)).toEqual(['RE_first','RE_first'])}
    }finally{await rm(f.root,{recursive:true,force:true})}
  }
})

test('a genuinely empty issue/task universe is complete only after the real retained-index validator', async () => {
  const {collectTaskActivities}=await import('../src/stats/timeline.ts'),{rm}=await import('node:fs/promises')
  const f=await acceptedFixture(),read=f.gh
  try{
    const result=await collectTaskActivities({repo:f.repo,period:'2026-09',coordination:{...f.target,provider:{...f.target.provider,read:async(t,c,path)=>path.startsWith('coordination/tasks/')?null:f.target.provider.read(t,c,path)}},gh:async(args,options)=>{
      if(args[1]!.includes('/issues?'))return 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n[]'
      const bytes=await read(args,options)
      if(args[1]!.endsWith('/git/trees/'+(12).toString(16).padStart(40,'0'))){const row=JSON.parse(bytes);row.tree=[];return JSON.stringify(row)}
      return bytes
    }})
    expect(result).toMatchObject({complete:true,activities:[],snapshots:[]})
  }finally{await rm(f.root,{recursive:true,force:true})}
})

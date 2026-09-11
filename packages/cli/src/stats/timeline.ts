// Issue timelines — the one place the statistics touch the GitHub API, and only at rollup.
//
// A run knows how long it took; it does not know how long its issue waited in `ready`, sat in
// `working`, or took from creation to close. Those spans live in the issue's label timeline, so
// the rollup reads them once per issue touched in the month and writes the events beside the
// summary as `<MON-YYYY>.timeline.json` — regenerated, never appended, like the summaries.
//
// The read fails closed as a whole: a month whose timelines cannot be fetched keeps whatever
// timeline file it already had and reports lead and cycle time from that, and the rollup says
// why. It never writes a partial file, which would make one month's lead time a lie about a
// subset of its issues.

import type { TimelineEvent } from './rollup.ts'

export type GhJson = (args: string[]) => Promise<unknown>

const KEPT = new Set(['labeled', 'unlabeled', 'closed', 'reopened'])

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

// The issue's own `created_at` is the `created` event; the timeline endpoint carries the rest.
// Every other event kind (comments, renames, references) is dropped here so the file holds only
// what `rollupRepo` reads.
export function timelineFromApi(issue: number, issueDoc: unknown, events: unknown): TimelineEvent[] {
  const out: TimelineEvent[] = []
  const created = asObject(issueDoc).created_at
  if (typeof created === 'string') out.push({ issue, event: 'created', label: null, created_at: created })
  for (const raw of Array.isArray(events) ? events : []) {
    const event = asObject(raw)
    const kind = typeof event.event === 'string' ? event.event : ''
    const at = typeof event.created_at === 'string' ? event.created_at : null
    if (!KEPT.has(kind) || at === null) continue
    const label = asObject(event.label).name
    out.push({ issue, event: kind, label: typeof label === 'string' ? label : null, created_at: at })
  }
  // Stable on time alone: two events at one instant keep the API's order, which is the order
  // GitHub recorded them in.
  return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
}

export type TimelineFetch = { ok: true; events: TimelineEvent[] } | { ok: false; reason: string }

export async function fetchTimelines(repo: string, issues: number[], gh: GhJson): Promise<TimelineFetch> {
  const events: TimelineEvent[] = []
  for (const issue of [...new Set(issues)].sort((a, b) => a - b)) {
    try {
      const doc = await gh(['api', `repos/${repo}/issues/${issue}`])
      const timeline = await gh(['api', `repos/${repo}/issues/${issue}/timeline`, '--paginate'])
      events.push(...timelineFromApi(issue, doc, timeline))
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
  }
  return { ok: true, events }
}

// Metric-v2 collection owns transport enumeration; the coordination owner still
// validates every retained task and immutable receipt. No state pointer is written.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundedGhJson, fetchGhPages, readBudget, withinRead, type GhReader } from '../gh.ts'
import { acceptedDeliveryProjection } from '../children.ts'
import { githubCoordinationProvider, inspectCoordinationTask, inspectHistoricalCoordinationTask, resolveEvidence, parseAcceptedScope, parseRecoveryPayload, operationPath, taskKey, type CoordinationTarget, type TaskRecord, type OperationReceipt } from '../shared-claims.ts'
import { canonicalJson, hashBytes, type TaskActivity, type ReworkSnapshot, type StatsEvidenceRef } from './types.ts'
import { inMonth, uniqueActivities, utcMonthBounds } from './metrics.ts'

export interface TaskActivityCollection {
  activities: TaskActivity[]
  snapshots: ReworkSnapshot[]
  complete: boolean
  reason: string | null
  observedAt: string
  sourceDigest: string
}
interface GitHubIssue { id:number;node_id:string;number:number;body:string|null;created_at:string;updated_at:string;pull_request?:unknown }
interface GitHubComment { id:number;node_id:string;body:string;created_at:string;updated_at:string;issue_url?:string }
const oid = (value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)
const stableId = (value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_=-]{3,200}$/.test(value)
const positive = (value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
const iso = (value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/^\d{4}-\d\d-\d\dT/.test(value)
const insist = (value:unknown,reason:string):void=>{if(!value)throw Error(reason)}
const same = (a:unknown,b:unknown):boolean=>canonicalJson(a)===canonicalJson(b)

/** Current policy supplied by the configured owner, after viewer/repo authorization.
 * Fleet identity supplies read coordinates, never an execution permission grant. */
export function activityCoordinationTarget(home:string,policy:{repo?:string;blocks?:string[];fleet?:unknown},gh:GhReader):CoordinationTarget {
  const fleet=asObject(policy.fleet),coordination=asObject(fleet.coordination)
  insist(policy.blocks?.length===0&&policy.repo&&fleet.schemaVersion===1,'activity-current-coordination-policy-unavailable')
  insist(typeof coordination.repository==='string'&&stableId(coordination.repositoryId)&&typeof coordination.branch==='string'&&oid(coordination.rootCommit)&&typeof coordination.installationId==='string','activity-coordination-identity-unavailable')
  const refuse=async()=>{throw Error('activity-reader-is-read-only')}
  return {host:'github.com',repository:coordination.repository as string,repositoryId:coordination.repositoryId as string,branch:coordination.branch as string,rootCommit:coordination.rootCommit as string,installationId:coordination.installationId as string,localRoot:join(home,'.vegastack','coordination'),provider:githubCoordinationProvider(gh),verifyCandidate:refuse,verifyTransition:refuse,verifyEvidence:refuse}
}

export async function collectTaskActivities(input:{repo:string;period:string;gh:GhReader;signal?:AbortSignal;prior?:TaskActivityCollection|null;coordination?:CoordinationTarget|((gh:GhReader)=>Promise<CoordinationTarget>)}):Promise<TaskActivityCollection> {
  const observedAt=new Date().toISOString(),budget=readBudget(input.signal),sourcePins:unknown[]=[]
  let bytes=0,work=0
  let previous:TaskActivityCollection|null=null
  if(input.prior)try{previous=(await import('./metrics.ts')).parseActivityCollection(input.prior,input.repo)}catch{/* A foreign or malformed fallback is never published. */}
  // Sequential reads stay below the three-reader ceiling. One byte/work bound
  // spans GitHub pages and every delegated coordination read, including receipts.
  const bounded=async<T>(call:()=>Promise<T>):Promise<T>=>{
    if(++work>100)throw Error('activity-collection-work-limit')
    const result=await withinRead(budget,()=>call())
    bytes+=Buffer.byteLength(typeof result==='string'?result:canonicalJson(result))
    if(bytes>8*1024*1024)throw Error('activity-collection-byte-limit')
    return result
  }
  const gh:GhReader=(args,options)=>bounded(()=>input.gh(args,{...options,signal:options?.signal??input.signal,timeoutMs:Math.min(10_000,budget.deadline-Date.now()),maxOutputBytes:Math.max(1,8*1024*1024-bytes)}))
  const json=async<T=Record<string,unknown>>(path:string):Promise<T>=>boundedGhJson<T>(gh,['api',path],budget)
  const pages=async<T>(path:string):Promise<T[]>=>{
    const result=await fetchGhPages<T>(gh,path,budget)
    if(!result.complete)throw Error('activity-incomplete-pages')
    return result.items
  }
  try {
    insist(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(input.repo),'activity-invalid-repository')
    utcMonthBounds(input.period)
    const shipGateUrl=new URL(fileURLToPath(import.meta.url).endsWith('.ts')?'../../../../skills/dev/dev-ship/scripts/ship-gate.mjs':'../skill/dev-ship/scripts/ship-gate.mjs',import.meta.url)
    const {typedSection,evaluateParentDelivery}=await import(shipGateUrl.href) as typeof import('../../../../skills/dev/dev-ship/scripts/ship-gate.mjs')
    const repository=await json(`repos/${input.repo}`)
    insist(repository.full_name===input.repo&&stableId(repository.node_id),'activity-repository-identity-changed')
    // PR rows are removed only after the full all-state issue enumeration.
    const universe=await pages<GitHubIssue>(`repos/${input.repo}/issues?state=all&sort=created&direction=asc&per_page=100`)
    const issues=universe.filter(row=>!row.pull_request)
    const issueMap=new Map<number,GitHubIssue>(),comments=new Map<number,GitHubComment[]>(),timelines=new Map<number,Record<string,unknown>[]>()
    for(const issue of issues){
      insist(positive(issue.number)&&stableId(issue.node_id)&&positive(issue.id)&&iso(issue.created_at)&&iso(issue.updated_at)&&(issue.body===null||typeof issue.body==='string')&&!issueMap.has(issue.number),'activity-invalid-issue-identity')
      issueMap.set(issue.number,issue)
      sourcePins.push([issue.node_id,issue.updated_at,hashBytes(issue.body??'')])
      const rows=await pages<GitHubComment>(`repos/${input.repo}/issues/${issue.number}/comments`)
      for(const comment of rows)insist(positive(comment.id)&&stableId(comment.node_id)&&typeof comment.body==='string'&&iso(comment.created_at)&&iso(comment.updated_at),'activity-invalid-comment-identity')
      comments.set(issue.number,rows)
      timelines.set(issue.number,await pages<Record<string,unknown>>(`repos/${input.repo}/issues/${issue.number}/timeline`))
    }
    const target=typeof input.coordination==='function'?await input.coordination(gh):input.coordination
    insist(target,'activity-coordination-unavailable')
    const real=target!,branch=await bounded(()=>real.provider.branch(real))
    const readCache=new Map<string,Promise<string|null>>(),compareCache=new Map<string,Promise<'ahead'|'identical'|'behind'|'diverged'>>()
    const pinned:CoordinationTarget={...real,provider:{
      branch:async()=>branch,
      read:(_target,commit,path)=>{
        const key=canonicalJson([commit,path]);let value=readCache.get(key)
        if(!value){value=bounded(()=>real.provider.read(real,commit,path));readCache.set(key,value)}
        return value
      },
      compare:(_target,base,head)=>{
        const key=canonicalJson([base,head]);let value=compareCache.get(key)
        if(!value){value=bounded(()=>real.provider.compare(real,base,head));compareCache.set(key,value)}
        return value
      },
      commit:async()=>{throw Error('activity-reader-is-read-only')},
    },verifyCandidate:async()=>{throw Error('activity-reader-is-read-only')},verifyTransition:async()=>{throw Error('activity-reader-is-read-only')}}
    insist(oid(branch.head),'activity-invalid-coordination-head')
    sourcePins.push(['coordination',branch.head])
    const commit=await json(`repos/${real.repository}/git/commits/${branch.head}`)
    insist(commit.sha===branch.head&&oid(asObject(commit.tree).sha),'activity-coordination-tree-mismatch')
    const tree=async(sha:string)=>{
      const value=await json(`repos/${real.repository}/git/trees/${sha}`)
      insist(value.sha===sha&&value.truncated===false&&Array.isArray(value.tree),'activity-incomplete-coordination-tree')
      const entries=value.tree as Array<{path:string;type:string;mode:string;sha:string}>,seen=new Set<string>()
      for(const entry of entries){insist(typeof entry.path==='string'&&!entry.path.includes('/')&&!seen.has(entry.path)&&oid(entry.sha),'activity-ambiguous-coordination-tree');seen.add(entry.path)}
      return entries
    }
    const descend=async(sha:string,name:string)=>{
      const entry=(await tree(sha)).find(e=>e.path===name)
      insist(entry?.type==='tree'&&entry.mode==='040000','activity-missing-coordination-tree')
      return entry!.sha
    }
    const coordinationTree=await descend(asObject(commit.tree).sha as string,'coordination')
    const taskTree=await descend(coordinationTree,'tasks'),entries=await tree(taskTree)
    for(const entry of entries)insist(entry.type==='blob'&&entry.mode==='100644'&&/^[a-f0-9]{64}\.json$/.test(entry.path),'activity-invalid-task-tree-entry')
    const listed=new Set(entries.map(entry=>entry.path.slice(0,-5)))
    // An absent computed key is an inspection, not fabricated task authority. It
    // still runs the owner's complete index/installation/machine checks for zero.
    // With no issues, a private absent-key probe grants no task identity or authority.
    const probe=issues[0]?taskKey(real.host,repository.node_id as string,issues[0].node_id):hashBytes('activity-empty-index-probe')
    if(!entries.length){
      const checked=await inspectCoordinationTask(pinned,probe!)
      insist(checked.kind==='absent'&&checked.head===branch.head,'activity-unlisted-coordination-task')
    }
    const tasks:TaskRecord[]=[]
    for(const entry of entries){
      const result=await inspectCoordinationTask(pinned,entry.path.slice(0,-5))
      insist((result.kind==='active'||result.kind==='completed')&&result.head===branch.head,'activity-retained-task-unavailable')
      if(result.kind!=='active'&&result.kind!=='completed')throw Error('activity-retained-task-unavailable')
      // The full tree can contain other authorized installation repos. Their
      // private records never enter this repository's public metric projection.
      if(result.task.repo!==input.repo)continue
      const issue=issueMap.get(result.task.issue)
      insist(issue&&result.task.repositoryNodeId===repository.node_id&&result.task.issueNodeId===issue.node_id&&result.task.taskKey===taskKey(real.host,repository.node_id as string,issue.node_id),'activity-task-issue-identity-mismatch')
      tasks.push(result.task)
    }
    // Every indexed task must also occur in the complete nonrecursive tree.
    const indexRaw=await pinned.provider.read(pinned,branch.head,'coordination/index.json')
    insist(indexRaw,'activity-coordination-index-unavailable')
    const index=JSON.parse(indexRaw!) as {active:Array<{taskKey:string}>}
    insist(Array.isArray(index.active)&&index.active.every(row=>listed.has(row.taskKey)),'activity-task-tree-index-mismatch')
    const activities:TaskActivity[]=[],snapshots:ReworkSnapshot[]=[]
    const usedComments=new Map<number,{issue:number;comment:GitHubComment}>()
    const accepted:Array<{projection:ReturnType<typeof acceptedDeliveryProjection>[number];at:string;source:StatsEvidenceRef}>=[]
    for(const task of tasks)for(const link of task.acceptedScopes){
      const raw=await pinned.provider.read(pinned,link.receipt.commitSha,operationPath(link.receipt.operationId))
      insist(raw&&hashBytes(raw)===link.receipt.blobSha256,'activity-accepted-receipt-unavailable')
      // Parsing here only obtains an expected binding. The owner below validates
      // the closed receipt, its immutable ancestry/hash and historical owner.
      const receipt=JSON.parse(raw!) as OperationReceipt,payload=parseRecoveryPayload(receipt.recoveryPayload)
      insist(receipt.taskKey===task.taskKey&&payload.kind==='acceptance'&&payload.result==='passed'&&payload.scopeDigest===link.scopeDigest&&payload.runId===receipt.resultOwner?.runId,'activity-accepted-receipt-binding-mismatch')
      if(payload.kind!=='acceptance'||!payload.acceptedScope)throw Error('activity-accepted-scope-unavailable')
      const scope=parseAcceptedScope(payload.acceptedScope)
      insist(scope.repo===task.repo&&scope.issue===task.issue&&scope.parentRepo===input.repo&&issueMap.has(scope.parentIssue),'activity-accepted-parent-unavailable')
      const reader:CoordinationTarget={...pinned,verifyEvidence:async(ref,actual)=>{
        insist(same(ref,link.receipt)&&same(actual,payload),'activity-historical-receipt-binding-mismatch')
      }}
      const resolved=await resolveEvidence(reader,link.receipt)
      insist(same(resolved,payload),'activity-accepted-receipt-readback-mismatch')
      const original=await inspectHistoricalCoordinationTask(reader,{taskKey:task.taskKey,expected:{taskKey:task.taskKey,generation:receipt.generation,...receipt.resultOwner},evidence:link.receipt,at:'receipt'})
      insist(original.kind==='historical','activity-historical-owner-unavailable')
      if(original.kind!=='historical')throw Error('activity-historical-owner-unavailable')
      insist(original.task.scopeDigest===link.scopeDigest&&same(original.task.approvalBindings,scope.approvalBindings)&&scope.completedTaskIds.every(id=>original.task.approvedTaskIds.includes(id))&&['implement','corrections'].includes(original.task.stage),'activity-historical-scope-mismatch')
      insist(scope.completedTaskIds.length===scope.approvedTaskIds.length,'activity-partial-accepted-scope')
      const relation=await json(`repos/${input.repo}/compare/${payload.sourceSha}...${scope.parentAfter}`)
      insist(['ahead','identical'].includes(String(relation.status))&&asObject(relation.base_commit).sha===payload.sourceSha,'activity-child-parent-relationship-unavailable')
      const projections=acceptedDeliveryProjection(scope,payload.sourceSha,link.scopeDigest)
      for(const projection of projections){
        const matches=(comments.get(scope.parentIssue)??[]).filter(comment=>{
          const rows=typedSection(comment.body,'acceptedDeliveries')
          return Array.isArray(rows)&&rows.some(row=>same(row,projection))
        })
        insist(matches.length===1,'activity-public-accepted-container-unavailable')
        const comment=matches[0]!,source:StatsEvidenceRef={repo:input.repo,issue:scope.parentIssue,commentId:comment.id,nodeId:comment.node_id,bodySha256:hashBytes(comment.body)}
        usedComments.set(comment.id,{issue:scope.parentIssue,comment})
        accepted.push({projection,at:scope.acceptedAt,source})
        activities.push({taskRef:projection.taskRef,activityId:`${comment.node_id}:implemented:${projection.taskRef.taskId}`,kind:'implemented',occurredAt:scope.acceptedAt,deliveryRef:null,sourceRef:source})
      }
    }
    const candidates=new Map<number,Set<number>>()
    for(const [issue,events] of timelines)for(const event of events){
      if(event.event!=='cross-referenced')continue
      const source=asObject(asObject(event.source).issue),pr=asObject(source.pull_request)
      if(!positive(source.number)||typeof pr.url!=='string')continue
      if(pr.url!==`https://api.github.com/repos/${input.repo}/pulls/${source.number}`)continue
      const linked=candidates.get(source.number)??new Set<number>();linked.add(issue);candidates.set(source.number,linked)
    }
    // Public parentDelivery sections are another discovery source; their claims
    // are verified against the actual PR and exact transformation facts below.
    for(const [issue,rows] of comments)for(const comment of rows){
      const delivery=asObject(typedSection(comment.body,'parentDelivery'))
      if(delivery.repo===input.repo&&positive(delivery.pr)&&delivery.parentIssue===issue){const linked=candidates.get(delivery.pr)??new Set<number>();linked.add(issue);candidates.set(delivery.pr,linked)}
    }
    for(const [number,linked] of candidates){
      const pr=await json(`repos/${input.repo}/pulls/${number}`)
      insist(pr.number===number&&stableId(pr.node_id),'activity-pr-identity-mismatch')
      // All candidates are read, including unmerged/out-of-period ones, before
      // deciding whether their actual delivery belongs to this month.
      const commits=await pages<{sha:string;node_id?:string}>(`repos/${input.repo}/pulls/${number}/commits`)
      const unique=new Set(commits.map(row=>row.sha))
      insist(commits.every(row=>oid(row.sha))&&unique.size===commits.length,'activity-pr-commit-identity-mismatch')
      if(pr.merged!==true||!iso(pr.merged_at))continue
      if(asObject(asObject(pr.base).repo).full_name!==input.repo||asObject(pr.base).ref!=='main')continue
      insist(oid(pr.merge_commit_sha)&&oid(asObject(pr.head).sha),'activity-pr-source-unavailable')
      const deliveries=accepted.filter(row=>linked.has(row.projection.parentIssue)||linked.has(row.projection.taskRef.issue))
      if(!deliveries.length)throw Error('activity-merged-accepted-scope-unavailable')
      for(const row of deliveries){
        const projection=row.projection,head=asObject(pr.head).sha as string
        const relation=await json(`repos/${input.repo}/compare/${projection.parentHead}...${head}`)
        const direct=['ahead','identical'].includes(String(relation.status))&&asObject(relation.base_commit).sha===projection.parentHead
        const completeCommits=Number.isSafeInteger(pr.commits)&&Number(pr.commits)<=250&&Number(pr.commits)===unique.size
        if(!direct||!completeCommits){
          let verified=false
          for(const comment of comments.get(projection.parentIssue)??[]){
            const delivery=typedSection(comment.body,'parentDelivery'),verification=typedSection(comment.body,'deliveryVerification')
            if(!delivery||!verification)continue
            const acceptedRows=typedSection(comment.body,'acceptedDeliveries'),scopeMatrix=typedSection(comment.body,'scopeMatrix'),requiredScopeMatrix=typedSection(comment.body,'requiredScopeMatrix')
            const expected={repo:input.repo,parentIssue:projection.parentIssue,pr:number,prNodeId:pr.node_id,acceptedParentHead:projection.parentHead,baseRepo:input.repo,baseRef:'main',baseSha:asObject(pr.base).sha}
            const required=accepted.filter(a=>a.projection.parentIssue===projection.parentIssue&&a.projection.parentHead===projection.parentHead).map(a=>a.projection)
            const check=evaluateParentDelivery({parentDelivery:delivery,pr,expected,acceptedDeliveries:acceptedRows,requiredDeliveries:required,scopeMatrix,requiredScopeMatrix,verification})
            if(check.blocks.length)continue
            // Independent API tree/readback establishes the claimed equality;
            // a typed object asserting a successful check is not enough alone.
            const from=await json(`repos/${input.repo}/git/commits/${projection.parentHead}`),to=await json(`repos/${input.repo}/git/commits/${pr.merge_commit_sha}`)
            const proof=asObject(verification)
            if(from.sha!==projection.parentHead||to.sha!==pr.merge_commit_sha||asObject(from.tree).sha!==proof.acceptedTree||asObject(to.tree).sha!==proof.mergedTree)continue
            usedComments.set(comment.id,{issue:projection.parentIssue,comment});verified=true
          }
          insist(verified,'activity-exact-delivery-relationship-unavailable')
        }
        activities.push({taskRef:projection.taskRef,activityId:`${pr.node_id}:merged`,kind:'merged',occurredAt:pr.merged_at,deliveryRef:{repo:input.repo,pr:number,prNodeId:pr.node_id as string,acceptedParentHead:projection.parentHead,mergedCommit:pr.merge_commit_sha as string},sourceRef:row.source})
        sourcePins.push(['pr',pr.node_id,pr.merged_at,pr.merge_commit_sha,head])
      }
    }
    // Complete release history is required to identify the FIRST published
    // release for a task. Later tags containing the same commit are not new work.
    const releases=await pages<Record<string,unknown>>(`repos/${input.repo}/releases`)
    const published=releases.filter(row=>row.draft===false)
    for(const release of published)insist(positive(release.id)&&stableId(release.node_id)&&iso(release.published_at)&&typeof release.tag_name==='string'&&release.tag_name.length<=200&&!/[\s~^:?*\[\\]/.test(release.tag_name)&&!release.tag_name.includes('..')&&!release.tag_name.includes('@{')&&release.tag_name.split('/').every(part=>part&&!part.startsWith('.')&&!part.endsWith('.lock')),'activity-invalid-release-identity')
    published.sort((a,b)=>Date.parse(a.published_at as string)-Date.parse(b.published_at as string)||Number(a.id)-Number(b.id))
    const released=new Set<string>(),releasePins:Array<{release:Record<string,unknown>;tagPath:string;tag:Record<string,unknown>}>=[]
    const merged=activities.filter(a=>a.kind==='merged')
    for(const release of published){
      const tagPath=`repos/${input.repo}/git/ref/tags/${encodeURIComponent(release.tag_name as string)}`,tag=await json(tagPath)
      insist(tag.ref===`refs/tags/${release.tag_name}`,'activity-release-tag-mismatch')
      let object=asObject(tag.object),depth=0
      const visited=new Set<string>()
      while(object.type==='tag'){
        insist(oid(object.sha)&&!visited.has(object.sha)&&++depth<=8,'activity-release-tag-chain-unavailable')
        visited.add(object.sha as string)
        const annotated=await json(`repos/${input.repo}/git/tags/${object.sha}`)
        insist(annotated.sha===object.sha,'activity-release-tag-object-mismatch')
        object=asObject(annotated.object)
      }
      insist(object.type==='commit'&&oid(object.sha),'activity-release-commit-unavailable')
      const tagCommit=await json(`repos/${input.repo}/git/commits/${object.sha}`)
      insist(tagCommit.sha===object.sha&&oid(asObject(tagCommit.tree).sha),'activity-release-commit-mismatch')
      for(const delivery of merged){
        const identity=canonicalJson(delivery.taskRef)
        if(released.has(identity)||Date.parse(release.published_at as string)<Date.parse(delivery.occurredAt))continue
        const relation=await json(`repos/${input.repo}/compare/${delivery.deliveryRef!.mergedCommit}...${object.sha}`)
        if(!['ahead','identical'].includes(String(relation.status))||asObject(relation.base_commit).sha!==delivery.deliveryRef!.mergedCommit)continue
        activities.push({taskRef:delivery.taskRef,activityId:`${release.node_id}:released`,kind:'released',occurredAt:release.published_at as string,deliveryRef:delivery.deliveryRef,sourceRef:{repo:input.repo,issue:null,commentId:null,nodeId:release.node_id as string,bodySha256:typeof release.body==='string'?hashBytes(release.body):null}})
        released.add(identity)
      }
      releasePins.push({release,tagPath,tag})
    }
    for(const pin of releasePins){
      const release=await json(`repos/${input.repo}/releases/${pin.release.id}`),tag=await json(pin.tagPath)
      for(const key of ['id','node_id','draft','tag_name','published_at','body'])insist(same(release[key]??null,pin.release[key]??null),'activity-release-changed-during-read')
      insist(same(tag,pin.tag),'activity-release-tag-changed-during-read')
      sourcePins.push(['release',pin.release.node_id,pin.release.published_at,asObject(pin.tag.object).sha])
    }
    // Rework/activity supplied in typed source sections is not inferred from the
    // number of comments. Raw bodies and private receipt references never leave.
    for(const [issue,rows] of comments)for(const comment of rows){
      const supplied=typedSection(comment.body,'taskActivities')
      if(supplied===null)continue
      insist(Array.isArray(supplied),'activity-invalid-typed-activities')
      for(const value of supplied){
        const activity=value as TaskActivity
        insist(activity&&Object.keys(activity).sort().join(',')==='activityId,deliveryRef,kind,occurredAt,sourceRef,taskRef'&&activity.taskRef?.repo===input.repo&&activity.taskRef.issue===issue&&['review','fix','handback'].includes(activity.kind)&&iso(activity.occurredAt)&&activity.deliveryRef===null&&activity.activityId===`${comment.node_id}:${activity.kind}`,'activity-invalid-typed-activity')
        insist(tasks.some(task=>task.issue===issue&&(activity.taskRef.taskId===null||task.approvedTaskIds.includes(activity.taskRef.taskId)))&&Date.parse(activity.occurredAt)===Date.parse(comment.created_at),'activity-invalid-task-identity')
        const source:StatsEvidenceRef={repo:input.repo,issue,commentId:comment.id,nodeId:comment.node_id,bodySha256:hashBytes(comment.body)}
        activities.push({...activity,taskRef:{repo:input.repo,issue,taskId:activity.taskRef.taskId},sourceRef:source})
        usedComments.set(comment.id,{issue,comment})
      }
    }
    for(const [issue,rows] of comments)for(const comment of rows){
      const supplied=typedSection(comment.body,'reworkSnapshots')
      if(supplied===null)continue
      insist(Array.isArray(supplied),'activity-invalid-typed-snapshots')
      for(const value of supplied){
        const snapshot=value as ReworkSnapshot
        insist(snapshot&&snapshot.taskRef?.repo===input.repo&&snapshot.taskRef.issue===issue&&iso(snapshot.asOf)&&Date.parse(snapshot.asOf)===Date.parse(comment.updated_at)&&tasks.some(task=>task.issue===issue&&(snapshot.taskRef.taskId===null||task.approvedTaskIds.includes(snapshot.taskRef.taskId))&&task.acceptedScopes.some(link=>snapshot.counterEpoch===link.scopeDigest+':v2')),'activity-invalid-snapshot-identity')
        const sourceRef:StatsEvidenceRef={repo:input.repo,issue,commentId:comment.id,nodeId:comment.node_id,bodySha256:hashBytes(comment.body)}
        snapshots.push({...snapshot,taskRef:{repo:input.repo,issue,taskId:snapshot.taskRef.taskId},sourceRef})
        usedComments.set(comment.id,{issue,comment})
      }
    }
    // Legacy mutable counters do not contain event-time history. Preserve a
    // dated unknown snapshot rather than silently reporting a complete zero or
    // assigning old review/fix/handback totals to the requested month.
    for(const task of tasks){
      const legacy=(comments.get(task.issue)??[]).filter(comment=>/^<!--\s*vsk:v1\s+[^>]*\btype=(review|handback|ledger)\b/m.test(comment.body)&&typedSection(comment.body,'taskActivities')===null&&typedSection(comment.body,'reworkSnapshots')===null)
      if(!legacy.length)continue
      const comment=[...legacy].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at))[0]!
      snapshots.push({taskRef:{repo:input.repo,issue:task.issue,taskId:null},asOf:comment.updated_at,sourceRef:{repo:input.repo,issue:task.issue,commentId:comment.id,nodeId:comment.node_id,bodySha256:hashBytes(comment.body)},counterEpoch:task.scopeDigest+':v2',reviewRounds:null,fixRounds:null,handbacks:null,historyComplete:false,historyStart:null})
      for(const row of legacy)usedComments.set(row.id,{issue:task.issue,comment:row})
    }
    for(const issue of issues){
      const reread=await json<GitHubIssue>(`repos/${input.repo}/issues/${issue.number}`)
      insist(reread.node_id===issue.node_id&&reread.updated_at===issue.updated_at&&hashBytes(reread.body??'')===hashBytes(issue.body??''),'activity-issue-changed-during-read')
    }
    for(const {comment} of usedComments.values()){
      const reread=await json<GitHubComment>(`repos/${input.repo}/issues/comments/${comment.id}`)
      insist(reread.id===comment.id&&reread.node_id===comment.node_id&&reread.updated_at===comment.updated_at&&hashBytes(reread.body)===hashBytes(comment.body),'activity-comment-changed-during-read')
      sourcePins.push([comment.node_id,comment.updated_at,hashBytes(comment.body)])
    }
    return (await import('./metrics.ts')).parseActivityCollection({activities:uniqueActivities(activities),snapshots,complete:true,reason:null,observedAt,sourceDigest:hashBytes(canonicalJson(sourcePins))},input.repo)
  }catch(error){
    const prior=previous
    return {activities:prior?.activities??[],snapshots:prior?.snapshots??[],complete:false,reason:error instanceof Error&&/^activity-[a-z-]+$/.test(error.message)?error.message:'activity-source-unavailable',observedAt:prior?.observedAt??observedAt,sourceDigest:prior?.sourceDigest??hashBytes(canonicalJson([]))}
  }
}

export { parseActivityCollection } from './metrics.ts'

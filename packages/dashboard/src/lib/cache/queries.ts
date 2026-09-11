import type { Db } from './build'
import { whereClause, type Filters } from './filters'
import { summarizeExecutions, summarizeMeasured, summarizeIssueMonth, metricValue, type MetricValue, type SubscriptionFee } from '../../../../cli/src/stats/metrics'
import { readExport } from '../stats/record'
import { serializeExport } from '../../../../cli/src/stats/privacy'
import type { ExportedEvent, TaskActivity, ReworkSnapshot } from '../../../../cli/src/stats/types'

export interface Totals {
  runs:number
  costUsd:number|null
  durationS:number|null
  tokensIn:number|null
  tokensOut:number|null
  cacheRead:number|null
  cacheWrite:number|null
  handbacks:number|null
  reviewRounds:number|null
  fixRounds:number|null
  /** Retained nullable compatibility field. Process counts are never human effort. */
  humanTouchpoints:null
  operatorMinutes:number|null
  apiEquivalentUsd:number|null
  metricVersion:1|2
  coverage:Record<string,MetricValue>
  mergedIssues:number|null
  mergedTasks:number|null
  implementedTasks:number|null
  releasedTasks:number|null
  logicalExecutions:number|null
  unknownExecutionIdentity:number
  outcomes:Record<string,number>
  estimateBases:ReturnType<typeof summarizeExecutions>['estimateBases']
  lifetime:ReturnType<typeof summarizeIssueMonth>['lifetime']
  subscriptionFee:SubscriptionFee|null
  taskMetricSource?:'attributed-records'|'repository-discovery'|'unavailable'
}
const columns={costUsd:'cost_usd',durationS:'duration_s',tokensIn:'tokens_in',tokensOut:'tokens_out',cacheRead:'cache_read',cacheWrite:'cache_write'} as const
const mapped={costUsd:'costUsd',durationS:'durationSeconds',tokensIn:'tokensIn',tokensOut:'tokensOut',cacheRead:'cacheReadTokens',cacheWrite:'cacheWriteTokens'} as const
interface LegacyRow {repo:string;issue:number|null;human:string|null;stage:string|null;outcome:string|null;cost_usd:number|null;duration_s:number|null;tokens_in:number|null;tokens_out:number|null;cache_read:number|null;cache_write:number|null;id:number}
function selectedRepo(repo:string,filters:Filters):boolean {
  return (filters.allowedRepos===null||filters.allowedRepos?.includes(repo)===true)&&(!filters.group||filters.repos.length>0)&&(!filters.repos.length||filters.repos.includes(repo))
}
function period(month:string):string {
  const names=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'],match=/^([A-Z]{3})-(\d{4})$/.exec(month)
  return match?`${match[2]}-${String(names.indexOf(match[1]!)+1).padStart(2,'0')}`:month
}
export function cachedExecutionEvents(db:Db,filters:Filters,person?:{login:string;dimension:'task-owner'|'account-owner'}):ExportedEvent[]{
  const {sql,values}=whereClause(person?{...filters,allowedRepos:(filters.attributedRepos??[]).filter(repo=>selectedRepo(repo,filters))}:filters,'',person)
  const condition=person?` and ${person.dimension==='task-owner'?'task_owner':'agent_account_owner'} = ?`:''
  return db.query<{destination:string;event_id:string;payload_json:string}>(`select destination,event_id,payload_json from measurements where ${sql}${condition}`).all(...values,...(person?[person.login]:[])).map(row=>{
    const payload=JSON.parse(row.payload_json) as Record<string,unknown>
    const {historicalNonAttributed:_legacy,...wire}=payload
    const event=readExport(JSON.stringify({...wire,schemaVersion:2,metricVersion:2,eventId:row.event_id,destination:JSON.parse(row.destination)}))
    if(filters.attributedRepos?.includes(event.destination.repo))return event
    return readExport(JSON.stringify(serializeExport(event.payload,event.destination,event.eventId,{values:{'stats-export':'non-attributed'}})))
  })
}
function legacyRows(db:Db,filters:Filters,person?:string):LegacyRow[]{
  const {sql,values}=whereClause(filters,'',person?{login:person,dimension:'task-owner'}:undefined)
  const rows=db.query<LegacyRow>(`select * from runs where ${sql}${person?' and human = ?':''}`).all(...values,...(person?[person]:[]))
  return rows.filter(row=>!person||filters.attributedRepos?.includes(row.repo)).map(row=>filters.attributedRepos?.includes(row.repo)?row:{...row,human:null,issue:null})
}
export function taskMetrics(db:Db,filters:Filters,issue?:number) {
  const month=period(filters.month)
  if(filters.access?.kind==='person'||!filters.attributedRepos?.length)return summarizeIssueMonth([],month,{complete:false})
  const activity=db.query<{repo:string;issue:number;payload_json:string}>('select repo,issue,payload_json from activity_measurements').all().filter(row=>selectedRepo(row.repo,filters)&&filters.attributedRepos!.includes(row.repo)&&(issue===undefined||row.issue===issue)).map(row=>JSON.parse(row.payload_json) as TaskActivity)
  const snapshots=db.query<{repo:string;issue:number;payload_json:string}>('select repo,issue,payload_json from rework_snapshots').all().filter(row=>selectedRepo(row.repo,filters)&&filters.attributedRepos!.includes(row.repo)&&(issue===undefined||row.issue===issue)).map(row=>JSON.parse(row.payload_json) as ReworkSnapshot)
  const collections=db.query<{repo:string;period:string;payload_json:string}>('select repo,period,payload_json from activity_collections').all().filter(row=>row.period===month&&selectedRepo(row.repo,filters)&&filters.attributedRepos!.includes(row.repo))
  const repos=filters.repos.length?filters.repos:filters.allowedRepos??[...new Set([...activity.map(row=>row.taskRef.repo),...collections.map(row=>row.repo)])]
  const complete=!filters.harness&&!filters.model&&repos.length>0&&repos.every(repo=>collections.some(row=>row.repo===repo&&JSON.parse(row.payload_json).complete===true))
  try{return summarizeIssueMonth(activity,month,{complete,snapshots})}catch{return summarizeIssueMonth([],month,{complete:false})}
}
function measuredTotals(events:ExportedEvent[],tasks:ReturnType<typeof summarizeIssueMonth>):Totals {
  const summary=summarizeExecutions(events),coverage:Record<string,MetricValue>={}
  const totals:Totals={runs:summary.executionEvents,costUsd:null,durationS:null,tokensIn:null,tokensOut:null,cacheRead:null,cacheWrite:null,handbacks:tasks.handbacks,reviewRounds:tasks.reviewRounds,fixRounds:tasks.fixRounds,humanTouchpoints:null,operatorMinutes:summary.operatorMinutes.value,apiEquivalentUsd:summary.apiEquivalentUsd.value,metricVersion:2,coverage,mergedIssues:tasks.mergedIssues,mergedTasks:tasks.mergedTasks,implementedTasks:tasks.implementedTasks,releasedTasks:tasks.releasedTasks,logicalExecutions:summary.logicalExecutions,unknownExecutionIdentity:summary.unknownExecutionIdentity,outcomes:summary.outcomes,estimateBases:summary.estimateBases,lifetime:tasks.lifetime,subscriptionFee:null}
  for(const [field,key] of Object.entries(mapped) as Array<[keyof typeof mapped,typeof mapped[keyof typeof mapped]]>){totals[field]=summary.values[key].value;coverage[field]=summary.values[key]}
  for(const field of ['mergedIssues','mergedTasks','implementedTasks','releasedTasks','reviewRounds','fixRounds','handbacks'] as const)coverage[field]=metricValue(summarizeMeasured([tasks[field]]))
  coverage.operatorMinutes=summary.operatorMinutes;coverage.apiEquivalentUsd=summary.apiEquivalentUsd
  return totals
}
function legacyTotals(rows:LegacyRow[]):Totals {
  const total=measuredTotals([],summarizeIssueMonth([],'2000-01',{complete:false}))
  total.metricVersion=1;total.runs=rows.length;total.logicalExecutions=null
  for(const [field,column] of Object.entries(columns) as Array<[keyof typeof columns,typeof columns[keyof typeof columns]]>){const value=summarizeMeasured(rows.map(row=>row[column]));total[field]=value.total;total.coverage[field]=metricValue({total:null,known:0,unknown:rows.length})}
  for(const row of rows)if(row.outcome)total.outcomes[row.outcome]=(total.outcomes[row.outcome]??0)+1
  return total
}
function hasV2(db:Db,filters:Filters,person?:{login:string;dimension:'task-owner'|'account-owner'}):boolean {
  const month=period(filters.month)
  const {sql,values}=whereClause({...filters,harness:null,model:null},'',person)
  if(db.query<{n:number}>(`select count(*) as n from measurements where ${sql}`).get(...values)?.n)return true
  if(filters.access?.kind==='person')return false
  return db.query<{repo:string;period:string}>('select repo,period from activity_collections union select repo,substr(occurred_at,1,7) as period from activity_measurements union select repo,substr(as_of,1,7) as period from rework_snapshots').all().some(row=>row.period===month&&selectedRepo(row.repo,filters))
}
export function orgTotals(db:Db,filters:Filters):Totals {
  const total=hasV2(db,filters)?measuredTotals(cachedExecutionEvents(db,filters),taskMetrics(db,filters)):legacyTotals(legacyRows(db,filters))
  const fee=db.query<{value_json:string}>("select value_json from metric_metadata where key='subscriptionFee'").get()
  const scope=db.query<{value_json:string}>("select value_json from metric_metadata where key='allowedRepos'").get()
  const sameScope=scope&&JSON.stringify(JSON.parse(scope.value_json))===JSON.stringify(filters.allowedRepos)
  if(fee&&sameScope&&(filters.allowedRepos===null||!!filters.allowedRepos?.length)&&filters.access?.kind!=='person'){const value=JSON.parse(fee.value_json) as SubscriptionFee|null;if(value?.period===period(filters.month))total.subscriptionFee=value}
  return total
}
function grouped<K extends 'repo'|'stage'|'human'>(db:Db,filters:Filters,key:K):Array<Record<K,string>&Totals>{
  const events=cachedExecutionEvents(db,filters),legacy=legacyRows(db,filters),v2=hasV2(db,filters)
  const keys=new Set<string>()
  for(const event of events)if(event.payload.recordKind==='execution')keys.add(key==='repo'?event.destination.repo:key==='stage'?event.payload.stage:event.payload.taskOwner??'unknown')
  if(!v2)for(const row of legacy)keys.add(row[key]??'unknown')
  if(key==='repo'&&filters.access?.kind!=='person')for(const row of db.query<{repo:string;period:string}>('select repo,period from activity_collections').all())if(row.period===period(filters.month)&&selectedRepo(row.repo,filters))keys.add(row.repo)
  return [...keys].sort().map(value=>{
    const selected=events.filter(e=>e.payload.recordKind==='execution'&&(key==='repo'?e.destination.repo:key==='stage'?e.payload.stage:e.payload.taskOwner??'unknown')===value)
    const tasks=key==='repo'?taskMetrics(db,{...filters,repos:[value]}):summarizeIssueMonth([],period(filters.month),{complete:false})
    return {[key]:value,...(v2?measuredTotals(selected,tasks):legacyTotals(legacy.filter(row=>(row[key]??'unknown')===value)))} as Record<K,string>&Totals
  })
}
export const perRepo=(db:Db,filters:Filters)=>grouped(db,filters,'repo')
export const perStage=(db:Db,filters:Filters)=>grouped(db,filters,'stage')
export const perPerson=(db:Db,filters:Filters)=>grouped(db,filters,'human')
export function perIssue(db:Db,filters:Filters):Array<{issue:number;repo:string}&Totals>{
  const events=cachedExecutionEvents(db,filters),legacy=legacyRows(db,filters),v2=hasV2(db,filters),keys=new Map<string,{repo:string;issue:number}>()
  for(const event of events)if(event.payload.recordKind==='execution'&&event.payload.taskRef&&typeof event.payload.taskRef==='object')keys.set(JSON.stringify([event.destination.repo,event.payload.taskRef.issue]),{repo:event.destination.repo,issue:event.payload.taskRef.issue})
  if(!v2)for(const row of legacy)if(row.issue!==null)keys.set(JSON.stringify([row.repo,row.issue]),{repo:row.repo,issue:row.issue})
  for(const row of db.query<{repo:string;issue:number;at:string}>('select repo,issue,occurred_at as at from activity_measurements').all())if(filters.access?.kind!=='person'&&selectedRepo(row.repo,filters)&&filters.attributedRepos?.includes(row.repo)&&row.at.slice(0,7)===period(filters.month))keys.set(JSON.stringify([row.repo,row.issue]),{repo:row.repo,issue:row.issue})
  return [...keys.values()].sort((a,b)=>a.repo.localeCompare(b.repo)||a.issue-b.issue).map(key=>({...key,...(v2?measuredTotals(events.filter(event=>event.destination.repo===key.repo&&event.payload.recordKind==='execution'&&typeof event.payload.taskRef==='object'&&event.payload.taskRef?.issue===key.issue),taskMetrics(db,{...filters,repos:[key.repo]},key.issue)):legacyTotals(legacy.filter(row=>row.repo===key.repo&&row.issue===key.issue)))}))
}
function ownerTaskMetrics(db:Db,filters:Filters,subject:string|null,dimension:'task-owner'|'account-owner') {
  if(filters.harness||filters.model||filters.access?.kind==='person'&&(subject!==filters.access.subject||dimension!==filters.access.dimension))return summarizeIssueMonth([],period(filters.month),{complete:false})
  const repos=(filters.attributedRepos??[]).filter(repo=>selectedRepo(repo,filters))
  if(!repos.length)return summarizeIssueMonth([],period(filters.month),{complete:false})
  const values=[...repos,...(subject===null?[]:[subject])]
  // Collector rows deliberately have no ownership and are excluded by source.
  // Only the enclosing attributed transport supplies a person's identity.
  const activity=db.query<{payload_json:string}>(`select json_extract(e.payload_json,'$.activity') as payload_json from events e where json_extract(e.destination,'$.repo') in (${repos.map(()=>'?').join(',')}) and json_extract(e.payload_json,'$.recordKind')='activity' and json_extract(e.payload_json,'$.${dimension==='task-owner'?'taskOwner':'agentAccountOwner'}') ${subject===null?'is null':'= ?'}`).all(...values).map(row=>JSON.parse(row.payload_json) as TaskActivity)
  const snapshots=dimension==='task-owner'?db.query<{payload_json:string}>(`select json_extract(e.payload_json,'$.reworkSnapshot') as payload_json from events e where json_extract(e.destination,'$.repo') in (${repos.map(()=>'?').join(',')}) and json_extract(e.payload_json,'$.recordKind')='rework-snapshot' and json_extract(e.payload_json,'$.taskOwner') ${subject===null?'is null':'= ?'}`).all(...values).map(row=>JSON.parse(row.payload_json) as ReworkSnapshot):[]
  try{return summarizeIssueMonth(activity,period(filters.month),{complete:activity.length>0||snapshots.length>0,snapshots})}catch{return summarizeIssueMonth([],period(filters.month),{complete:false})}
}
export function unknownOwnerTotals(db:Db,filters:Filters,dimension:'task-owner'|'account-owner'):Totals|null {
  if(filters.access?.kind==='person')return null
  const events=cachedExecutionEvents(db,filters).filter(e=>filters.attributedRepos?.includes(e.destination.repo)&&e.payload.recordKind==='execution'&&e.payload.executionRef&&(dimension==='task-owner'?e.payload.taskOwner:e.payload.agentAccountOwner)===null)
  const tasks=ownerTaskMetrics(db,filters,null,dimension)
  if(!events.length&&tasks.mergedIssues===null)return null
  return {...measuredTotals(events,tasks),taskMetricSource:'attributed-records'}
}
export function personTotals(db:Db,filters:Filters,human:string,dimension:'task-owner'|'account-owner'='task-owner'):Totals|null {
  const events=cachedExecutionEvents(db,filters,{login:human,dimension})
  const tasks=ownerTaskMetrics(db,filters,human,dimension)
  if(hasV2(db,filters,{login:human,dimension})||tasks.mergedIssues!==null)return events.length||tasks.mergedIssues!==null?{...measuredTotals(events,tasks),taskMetricSource:'attributed-records'}:null
  const rows=dimension==='task-owner'?legacyRows(db,filters,human):[]
  return rows.length?legacyTotals(rows):null
}
export function perStageForPerson(db:Db,filters:Filters,human:string,dimension:'task-owner'|'account-owner'='task-owner'):Array<{stage:string}&Totals>{
  const events=cachedExecutionEvents(db,filters,{login:human,dimension}),rows=dimension==='task-owner'?legacyRows(db,filters,human):[],v2=hasV2(db,filters,{login:human,dimension})
  const stages=[...new Set(v2?events.map(event=>event.payload.recordKind==='execution'?event.payload.stage:'unknown'):rows.map(row=>row.stage??'unknown'))].sort()
  return stages.map(stage=>({stage,...(v2?measuredTotals(events.filter(event=>event.payload.recordKind==='execution'&&event.payload.stage===stage),summarizeIssueMonth([],period(filters.month),{complete:false})):legacyTotals(rows.filter(row=>(row.stage??'unknown')===stage)))}))
}
export interface SkillRow {name:string;invocations:number;triggers:Record<string,number>;outcomes:Record<string,number>;costUsd:number|null;costPerInvocation:number|null;meanAssociatedRunCostUsd:number|null;coverage:MetricValue;association:'nonadditive';metricVersion:1|2}
export function perSkill(db:Db,filters:Filters):SkillRow[]{
  const events=cachedExecutionEvents(db,filters),v2=hasV2(db,filters),hits:Array<{name:string;trigger:string|null;outcome:string|null;cost:number|null;identity:string}>=[]
  if(v2)for(const event of events){const p=event.payload;if(p.recordKind!=='execution')continue;for(const skill of p.skills??[])hits.push({name:skill.name,trigger:skill.trigger,outcome:p.outcome,cost:p.costUsd??null,identity:event.eventId})}
  else{
    const {sql,values}=whereClause(filters,'r')
    hits.push(...db.query<{name:string;trigger:string|null;outcome:string|null;cost:number|null;identity:string}>(`select s.name,s.trigger,r.outcome,r.cost_usd as cost,cast(r.id as text) as identity from skill_invocations s join runs r on r.id=s.run_id where ${sql}`).all(...values))
  }
  const grouped=new Map<string,typeof hits>()
  for(const hit of hits)grouped.set(hit.name,[...(grouped.get(hit.name)??[]),hit])
  return [...grouped].map(([name,rows])=>{
    const associated=[...new Map(rows.map(row=>[row.identity,row.cost])).values()],measured=summarizeMeasured(associated),triggers:Record<string,number>={},outcomes:Record<string,number>={}
    for(const row of rows){if(row.trigger)triggers[row.trigger]=(triggers[row.trigger]??0)+1;if(row.outcome)outcomes[row.outcome]=(outcomes[row.outcome]??0)+1}
    return {name,invocations:rows.length,triggers,outcomes,costUsd:measured.total,costPerInvocation:measured.known?measured.total!/measured.known:null,meanAssociatedRunCostUsd:measured.known?measured.total!/measured.known:null,coverage:metricValue(measured),association:'nonadditive' as const,metricVersion:v2?2 as const:1 as const}
  }).sort((a,b)=>b.invocations-a.invocations||a.name.localeCompare(b.name))
}

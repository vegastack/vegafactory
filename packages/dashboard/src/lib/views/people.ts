import { whereClause, type Filters } from '../cache/filters'
import type { Db } from '../cache/build'
import type { PageContext } from '../context'
import { perStageForPerson, type Totals } from '../cache/queries'
import { resolvePeopleReadScope, type Gate, type Person } from '../control-room/people'
import { readValidatedPolicies } from '../control-room/policy'
import { exportMode, validateExport, privacyReason, type ExportPolicy } from '../../../../cli/src/stats/privacy'
import type { ExportedEvent } from '../../../../cli/src/stats/types'

export type PeopleDimension = 'task-owner' | 'account-owner'
export interface PeopleRow extends Totals {login:string;name:string;role:string}
export interface PeopleView {viewer:string|null;rows:PeopleRow[];gated:boolean;refusal:string|null}
export interface PersonView {gate:Gate;person:Person|null;totals:Totals|null;stages:Array<{stage:string}&Totals>;dimension?:PeopleDimension}
export type PeoplePolicies = Map<string,Record<string,any>>
export type PeoplePolicyLoader = (context:PageContext)=>Promise<PeoplePolicies>
const describe=(login:string,people:Person[])=>{const person=people.find(p=>p.login===login);return{name:person?.name??login,role:person?.role??''}}

export const currentPeoplePolicies:PeoplePolicyLoader=async context=>{
  const current=await readValidatedPolicies({settingsPath:context.env.stateFile,org:context.env.org,repos:context.env.repos,now:Date.now()})
  if(current.policy.refusal)throw Error('privacy-current-policy-unavailable')
  return new Map(current.snapshots.map(snapshot=>[snapshot.policy.policy.repo,snapshot.policy.policy]))
}
function allowedRepos(context:PageContext,policies:PeoplePolicies,subject:string|null):string[]{
  if(!context.env.viewer)throw Error('privacy-viewer-unavailable')
  const requested=context.filters.repos.length?context.filters.repos:context.env.repos
  if(!requested.length)throw Error('privacy-repository-scope-unavailable')
  const allowed:string[]=[]
  for(const repo of requested){
    const policy=policies.get(repo)
    if(!policy||policy.repo!==repo||policy.registry.org!==context.env.org)throw Error('privacy-current-policy-unavailable')
    if(exportMode(policy as ExportPolicy)!=='attributed')continue
    const scope=resolvePeopleReadScope({viewer:{login:context.env.viewer,verified:true},subject,requestedRepos:[repo],policy,administration:policy.administration,repoGroups:policy.registry.repoGroups})
    if(!scope.refusal&&scope.allowedRepos.includes(repo))allowed.push(repo)
  }
  if(!allowed.length)throw Error('privacy-person-scope-unavailable')
  return allowed
}
// This adapter is also consumed by #148 metrics. Select the dimension before aggregation;
// ownership of a task never confers access to another person's account-owner row.
export function scopePeopleEvents(events:ExportedEvent[],context:PageContext,policies:PeoplePolicies,subject:string,dimension:PeopleDimension):ExportedEvent[]{
  const allowed=new Set(allowedRepos(context,policies,subject))
  return events.filter(event=>{
    if(!allowed.has(event.destination.repo))return false
    const payload=event.payload
    const owner=dimension==='task-owner'?payload.taskOwner:payload.recordKind==='rework-snapshot'?null:payload.agentAccountOwner
    return owner===subject
  })
}
function typedEvents(context:PageContext):ExportedEvent[]{
  return context.db.query<{destination:string;eventId:string;payload:string}>('select destination,event_id as eventId,payload_json as payload from events').all().map(row=>{
    const destination=JSON.parse(row.destination),payload=JSON.parse(row.payload)
    // Cached local provenance flags are not accepted as shared fields.
    const {historicalNonAttributed:_historical,...measurement}=payload
    const wire=validateExport({...measurement,schemaVersion:2,metricVersion:2,eventId:row.eventId,destination})
    const {metricVersion:_version,eventId,destination:target,...local}=wire
    return {eventId,destination:target,payload:local}
  })
}
function executionTotals(events:ExportedEvent[],context:PageContext):{totals:Totals|null;stages:Array<{stage:string}&Totals>}{
  const empty=():Totals=>({runs:0,costUsd:0,durationS:0,tokensIn:0,tokensOut:0,cacheRead:0,cacheWrite:0,handbacks:0,reviewRounds:0,fixRounds:0,humanTouchpoints:0})
  const byStage=new Map<string,Totals>(),totals=empty()
  for(const event of events){
    const p=event.payload
    if(p.recordKind!=='execution')continue
    const month=new Date(p.utcDay).toLocaleString('en-US',{month:'short',timeZone:'UTC'}).toUpperCase()+'-'+p.utcDay.slice(0,4)
    if(month!==context.filters.month||context.filters.harness&&p.harness!==context.filters.harness||context.filters.model&&p.model!==context.filters.model)continue
    const stage=byStage.get(p.stage)??empty()
    for(const target of [totals,stage]){target.runs++;for(const [key,value]of Object.entries({costUsd:p.costUsd,durationS:p.durationSeconds,tokensIn:p.tokensIn,tokensOut:p.tokensOut,cacheRead:p.cacheReadTokens,cacheWrite:p.cacheWriteTokens}))if(typeof value==='number')target[key as keyof Totals]+=value}
    byStage.set(p.stage,stage)
  }
  return{totals:totals.runs?totals:null,stages:[...byStage].map(([stage,value])=>({stage,...value}))}
}
function personTotals(db:Db,filters:Filters,subject:string):Totals|null{
  const {sql,values}=whereClause(filters)
  const columns={costUsd:'cost_usd',durationS:'duration_s',tokensIn:'tokens_in',tokensOut:'tokens_out',cacheRead:'cache_read',cacheWrite:'cache_write',handbacks:'handbacks',reviewRounds:'review_rounds',fixRounds:'fix_rounds'}
  const sums=Object.entries(columns).map(([key,column])=>`coalesce(sum(${column}),0) as ${key}`).join(',')
  const row=db.query<Omit<Totals,'humanTouchpoints'>>(`select count(*) as runs,${sums} from runs where ${sql} and human=?`).get(...values,subject)
  return row&&row.runs?{...row,humanTouchpoints:row.handbacks+row.reviewRounds+row.fixRounds}:null
}
function combineTotals(left:Totals|null,right:Totals|null):Totals|null{
  if(!left)return right;if(!right)return left
  return Object.fromEntries((['runs','costUsd','durationS','tokensIn','tokensOut','cacheRead','cacheWrite','handbacks','reviewRounds','fixRounds','humanTouchpoints'] as const).map(key=>[key,left[key as keyof Totals]+right[key as keyof Totals]])) as unknown as Totals
}
export async function buildPeopleView({context,loadPolicies=currentPeoplePolicies}:{context:PageContext;loadPolicies?:PeoplePolicyLoader}):Promise<PeopleView>{
  const viewer=context.env.viewer
  try{
    const policies=await loadPolicies(context),rows:PeopleRow[]=[],events=typedEvents(context)
    let permitted=false
    for(const person of context.people){
      let repos:string[];try{repos=allowedRepos(context,policies,person.login)}catch{continue}
      permitted=true
      // Every query binds the allowed repository set before SQL aggregation.
      const row=personTotals(context.db,{...context.filters,repos},person.login)
      const measured=executionTotals(scopePeopleEvents(events,context,policies,person.login,'task-owner'),context).totals
      const total=combineTotals(row??null,measured)
      if(total)rows.push({...total,login:person.login,...describe(person.login,context.people)})
    }
    let whole=false;try{whole=allowedRepos(context,policies,null).length===(context.filters.repos.length?context.filters.repos:context.env.repos).length}catch{/* no full-org grant */}
    return{viewer,rows,gated:!whole,refusal:permitted?null:'privacy-person-reporting-unavailable'}
  }catch{return{viewer,rows:[],gated:true,refusal:'privacy-current-policy-unavailable'}}
}
export async function buildPersonView({context,login,dimension='task-owner',loadPolicies=currentPeoplePolicies}:{context:PageContext;login:string;dimension?:PeopleDimension;loadPolicies?:PeoplePolicyLoader}):Promise<PersonView>{
  try{
    const policies=await loadPolicies(context),repos=allowedRepos(context,policies,login)
    const person=context.people.find(person=>person.login===login)??null
    if(!person)throw Error('privacy-person-unknown')
    if(dimension==='account-owner'){
      const selected=scopePeopleEvents(typedEvents(context),context,policies,login,dimension)
      return{gate:{allowed:true,reason:null},person,dimension,...executionTotals(selected,context)}
    }
    const filters={...context.filters,repos},legacy=personTotals(context.db,filters,login)
    const measured=executionTotals(scopePeopleEvents(typedEvents(context),context,policies,login,dimension),context)
    const stages=new Map(perStageForPerson(context.db,filters,login).map(row=>[row.stage,row]))
    for(const row of measured.stages)stages.set(row.stage,{stage:row.stage,...combineTotals(stages.get(row.stage)??null,row)!})
    return{gate:{allowed:true,reason:null},person,totals:combineTotals(legacy,measured.totals),stages:[...stages.values()],dimension}
  }catch(error){const code=privacyReason(error),reason=code==='operation-unavailable'?'privacy-person-scope-unavailable':code;return{gate:{allowed:false,reason},person:null,totals:null,stages:[],dimension}}
}

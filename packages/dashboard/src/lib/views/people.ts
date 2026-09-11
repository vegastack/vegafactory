import { whereClause, type Filters } from '../cache/filters'
import type { Db } from '../cache/build'
import type { PageContext } from '../context'
import { perStageForPerson, personTotals, unknownOwnerTotals, type Totals } from '../cache/queries'
import { resolvePeopleReadScope, type Gate, type Person } from '../control-room/people'
import { readValidatedPolicies } from '../control-room/policy'
import { exportMode, validateExport, privacyReason, type ExportPolicy } from '../../../../cli/src/stats/privacy'
import type { ExportedEvent } from '../../../../cli/src/stats/types'

export type PeopleDimension = 'task-owner' | 'account-owner'
export interface PeopleRow extends Totals {login:string;name:string;role:string}
export interface PeopleView {viewer:string|null;rows:PeopleRow[];gated:boolean;refusal:string|null;unknownOwners?:{taskOwner:Totals|null;agentAccountOwner:Totals|null}}
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
  if(context.access?.kind==='person'&&subject!==context.access.subject)throw Error('privacy-person-scope-unavailable')
  const requested=context.filters.repos.length?context.filters.repos:context.env.repos
  if(!requested.length)throw Error('privacy-repository-scope-unavailable')
  const allowed:string[]=[]
  for(const repo of requested){
    const policy=policies.get(repo)
    if(!policy||policy.repo!==repo||policy.registry.org!==context.env.org)throw Error('privacy-current-policy-unavailable')
    if(exportMode(policy as ExportPolicy)!=='attributed')continue
    const scope=resolvePeopleReadScope({viewer:{login:context.env.viewer,verified:true},subject,requestedRepos:[repo],policy,administration:policy.administration,repoGroups:policy.registry.repoGroups})
    if(!scope.refusal&&scope.allowedRepos.includes(repo)&&(context.allowedRepos===undefined||context.allowedRepos.includes(repo)))allowed.push(repo)
  }
  if(!allowed.length)throw Error('privacy-person-scope-unavailable')
  return allowed
}
// This adapter is also consumed by #148 metrics. Select the dimension before aggregation;
// ownership of a task never confers access to another person's account-owner row.
export function scopePeopleEvents(events:ExportedEvent[],context:PageContext,policies:PeoplePolicies,subject:string,dimension:PeopleDimension):ExportedEvent[]{
  if(context.access?.kind==='person'&&dimension!==context.access.dimension)return []
  const allowed=new Set(allowedRepos(context,policies,subject))
  return events.filter(event=>{
    if(!allowed.has(event.destination.repo))return false
    const payload=event.payload
    const owner=dimension==='task-owner'?payload.taskOwner:payload.recordKind==='rework-snapshot'?null:payload.agentAccountOwner
    return owner===subject
  })
}
function personFilters(context:PageContext,repos:string[]):Filters {
  return {...context.filters,repos,allowedRepos:repos,attributedRepos:repos}
}
export async function buildPeopleView({context,loadPolicies=currentPeoplePolicies}:{context:PageContext;loadPolicies?:PeoplePolicyLoader}):Promise<PeopleView>{
  const viewer=context.env.viewer
  try{
    const policies=await loadPolicies(context),rows:PeopleRow[]=[]
    let permitted=false
    for(const person of context.people){
      let repos:string[];try{repos=allowedRepos(context,policies,person.login)}catch{continue}
      permitted=true
      // Every query binds the allowed repository set before SQL aggregation.
      const total=personTotals(context.db,personFilters(context,repos),person.login)
      if(total)rows.push({...total,login:person.login,...describe(person.login,context.people)})
    }
    let whole=false;try{whole=allowedRepos(context,policies,null).length===(context.filters.repos.length?context.filters.repos:context.env.repos).length}catch{/* no full-org grant */}
    let unknownOwners:PeopleView['unknownOwners']
    if(context.access?.kind!=='person')try{const repos=allowedRepos(context,policies,null),filters=personFilters(context,repos);unknownOwners={taskOwner:unknownOwnerTotals(context.db,filters,'task-owner'),agentAccountOwner:unknownOwnerTotals(context.db,filters,'account-owner')}}catch{/* No aggregate owner grant. */}
    return{viewer,rows,gated:!whole,refusal:permitted?null:'privacy-person-reporting-unavailable',...(unknownOwners?{unknownOwners}:{})}
  }catch{return{viewer,rows:[],gated:true,refusal:'privacy-current-policy-unavailable'}}
}
export async function buildPersonView({context,login,dimension='task-owner',loadPolicies=currentPeoplePolicies}:{context:PageContext;login:string;dimension?:PeopleDimension;loadPolicies?:PeoplePolicyLoader}):Promise<PersonView>{
  try{
    if(context.access?.kind==='person'&&(context.access.subject!==login||context.access.dimension!==dimension))throw Error('privacy-person-scope-unavailable')
    const policies=await loadPolicies(context),repos=allowedRepos(context,policies,login)
    const person=context.people.find(person=>person.login===login)??null
    if(!person)throw Error('privacy-person-unknown')
    const filters=personFilters(context,repos)
    return {gate:{allowed:true,reason:null},person,totals:personTotals(context.db,filters,login,dimension),stages:perStageForPerson(context.db,filters,login,dimension),dimension}
  }catch(error){const code=privacyReason(error),reason=code==='operation-unavailable'?'privacy-person-scope-unavailable':code;return{gate:{allowed:false,reason},person:null,totals:null,stages:[],dimension}}
}

import { readFile } from 'node:fs/promises'
import { hashBytes } from '../../../cli/src/stats/types'
import { retainedGenerationProvenance, withCacheGeneration, refreshCache, type Db, type GenerationMetadata } from './cache/build'
import { filterOptions, parseFilters, type FilterOptions, type Filters, type ReportAccess } from './cache/filters'
import { readPeople, type Person } from './control-room/people'
import { readValidatedPolicies, type Policy } from './control-room/policy'
import { readEnv, type ServerEnv } from './env'
import { type Freshness } from './freshness'
import { resolvePeopleReadScope } from './control-room/people'
import { readExport, serializeExport, exportMode, type ExportPolicy } from '../../../cli/src/stats/privacy'
import { readActivityRepositories } from './live/status'
import { parseActivityCollection } from '../../../cli/src/stats/metrics'
import { monthToken } from './stats/month'

export type ContextAccessRequest={kind:'aggregate'}|{kind:'person';subject:string;dimension?:'task-owner'|'account-owner'}
export interface PageContext {
  generation?: GenerationMetadata
  access?: ReportAccess
  env: Omit<ServerEnv, 'instanceId' | 'cacheSchema'>
  db: Db
  options: FilterOptions
  filters: Filters
  repoGroups: Record<string, string>
  people: Person[]
  policy: Policy
  freshness: Freshness
  knowledgeWarning?: string | null
  allowedRepos?: string[]
}

// The callback must await every query/render that uses this database. Its persistent reader pin
// is released only after the callback settles, including rejection and async rendering failures.
export async function withContext<T>(
  searchParams: Record<string, string | string[] | undefined>,
  consume: (context: PageContext) => Promise<T>,
  request: ContextAccessRequest = { kind: 'aggregate' },
): Promise<T> {
  const result = readEnv(process.env as Record<string, string | undefined>)
  if (!result.ok) {
    throw new Error(`the dashboard server is missing ${result.missing.join(', ')} — it is launched by \`vegafactory dashboard\``)
  }
  const env = result.env
  const access:ReportAccess=request.kind==='person'?{kind:'person',subject:request.subject.toLowerCase(),dimension:request.dimension??'task-owner'}:{kind:'aggregate'}

  const validated = await readValidatedPolicies({ settingsPath: env.stateFile, org: env.org, repos: env.repos, now: Date.now() })
  const repoGroups = validated.policy.effective?.registry.repoGroups ?? {}
  const flat: Record<string, string | undefined> = {}
  for (const [key, raw] of Object.entries(searchParams)) flat[key] = Array.isArray(raw) ? raw[0] : raw

  const policies=new Map(validated.snapshots.map(row=>[row.policy.policy.repo,row.policy.policy]))
  const allowedRepos:string[]=[]
  if(!validated.policy.refusal&&env.viewer)for(const [repo,policy] of policies){
    if(exportMode(policy as ExportPolicy)==='off'||access.kind==='person'&&exportMode(policy as ExportPolicy)!=='attributed')continue
    const scope=resolvePeopleReadScope({viewer:{login:env.viewer,verified:true},subject:access.kind==='person'?access.subject:null,requestedRepos:[repo],policy,administration:policy.administration,repoGroups:policy.registry.repoGroups})
    if(!scope.refusal&&scope.allowedRepos.includes(repo))allowedRepos.push(repo)
  }
  const requestedMonth=flat.month??monthToken(new Date())
  const match=/^([A-Z]{3})-(\d{4})$/.exec(requestedMonth),names=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const period=match&&names.includes(match[1]!)?`${match[2]}-${String(names.indexOf(match[1]!)+1).padStart(2,'0')}`:new Date().toISOString().slice(0,7)
  const activity=await readActivityRepositories({bin:env.bin,configPath:env.stateFile,org:env.org,repos:access.kind==='person'?[]:allowedRepos.filter(repo=>exportMode(policies.get(repo) as ExportPolicy)==='attributed'),month:period})
  const collections=activity.map(({repo,result})=>({repo,period,collection:result.ok?parseActivityCollection({activities:result.data.activities,snapshots:result.data.snapshots,complete:result.data.complete,reason:result.data.reason,observedAt:result.data.observedAt,sourceDigest:result.data.sourceDigest},repo):{activities:[],snapshots:[],complete:false,reason:'activity-source-unavailable',observedAt:new Date().toISOString(),sourceDigest:'0'.repeat(64)}}))
  const configurationDigest = await readFile(env.stateFile, 'utf8').then(hashBytes, () => null)
  return withCacheGeneration({ namespace: env.cacheFile, org: env.org,
    compatibility: { org: env.org, schema: env.cacheSchema, metricVersion: 2, configurationDigest,
      controlRoom: env.controlRoom, access, viewer: env.viewer, allowedRepos: [...allowedRepos].sort(),
      policies: [...policies].sort(([a],[b]) => a.localeCompare(b)),
      snapshots: validated.snapshots.map(row => row.snapshot), period },
    refresh: async db => {
      const refreshed = await refreshCache(db,env.controlRoom,{org:env.org,allowedRepos,activityCollections:collections,readExport,projectEvent:event=>{
    const policy=policies.get(event.destination.repo)
    if(!policy||!allowedRepos.includes(event.destination.repo))throw Error('privacy-read-scope-refused')
    if(access.kind==='person'){const p=event.payload,owner=access.dimension==='task-owner'?p.taskOwner:p.recordKind==='rework-snapshot'?null:p.agentAccountOwner;if(owner!==access.subject)return null}
    const wire=serializeExport(event.payload,event.destination,event.eventId,policy as ExportPolicy)
    return wire?readExport(JSON.stringify(wire)):null
  },legacyRecord:record=>{
    const policy=policies.get(record.repo)
    if(!policy||access.kind==='person'&&(access.dimension!=='task-owner'||record.human!==access.subject))return null
    return exportMode(policy as ExportPolicy)==='attributed'?record:{...record,issue:null,parent:null,human:null,reviewRounds:null,fixRounds:null,handbacks:null}
  }})
      // #148 can retain a previous complete collection on a failed live read. Its persisted
      // provenance, not this request's failed-fetch timestamp, determines source age and identity.
      const provenance = retainedGenerationProvenance(db, refreshed.sourceDigest, validated.freshness.syncedAt)
      const total = refreshed.total + refreshed.eventTotal + provenance.activityTotal
      return { sourceDigest: provenance.sourceDigest, sourceObservedAt: provenance.sourceObservedAt,
        total, dataState: total > 0 ? 'ready' : provenance.activityUnavailable ? 'unavailable' : 'empty' }

    },
  }, async (db, generation, metricFailure) => {
  const options = filterOptions(db, repoGroups,allowedRepos,access)
  const filters = {access,...parseFilters(flat, options, repoGroups,allowedRepos),attributedRepos:allowedRepos.filter(repo=>exportMode(policies.get(repo) as ExportPolicy)==='attributed')}
  const group = filters.group ?? (filters.repo ? repoGroups[filters.repo] ?? null : null)
  const visibleGroups=new Set((filters.repos.length?filters.repos:allowedRepos).map(repo=>repoGroups[repo]).filter(Boolean))

  return consume({
    generation,
    env,
    access,
    db,
    options,
    filters,
    repoGroups,
    allowedRepos,
    people: validated.contentPath && !validated.policy.refusal ? (await readPeople(validated.contentPath, group)).filter(person=>access.kind==='person'?person.login===access.subject:allowedRepos.length>0&&person.groups.some(group=>visibleGroups.has(group))) : [],
    policy: validated.policy,
    knowledgeWarning: validated.knowledgeWarning,
    freshness: metricFailure || generation.dataState === 'unavailable'?{...validated.freshness,label:validated.freshness.label+' · metrics refresh unavailable',offline:true}:validated.freshness,
  })
  })
}

import { calendarExpiry } from './privacy.ts'
import { canonicalJson, MEASUREMENT_KEYS, type ExportedEvent, type LocalMeasurement, type MeasurementKey, type ReworkSnapshot, type TaskActivity } from './types.ts'

export const METRIC_VERSION = 2 as const
export interface Measured { total: number | null; known: number; unknown: number }
export interface MetricValue { value: number | null; known: number; unknown: number; availability: 'available' | 'partial' | 'unavailable'; definitionVersion: 2 }
export function summarizeMeasured(values: readonly (number | null)[]): Measured {
  const measured=values.filter((value):value is number=>value!==null&&Number.isFinite(value)).sort((a,b)=>Math.abs(a)-Math.abs(b)||a-b)
  const total=measured.reduce((sum,value)=>sum+value,0),known=measured.length
  if(!Number.isFinite(total))throw Error('metric-measurement-overflow')
  return { total: known ? total : null, known, unknown: values.length - known }
}
export function metricValue(measured: Measured, complete = true): MetricValue {
  return { value: complete ? measured.total : null, known: measured.known, unknown: measured.unknown,
    availability: !complete || !measured.known ? 'unavailable' : measured.unknown ? 'partial' : 'available', definitionVersion: 2 }
}
export function utcMonthBounds(month: string): {start:string;end:string} {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('metric-invalid-month')
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}
export function inMonth(at: string, month: string): boolean {
  const { start, end } = utcMonthBounds(month), time = Date.parse(at)
  return Number.isFinite(time) && time >= Date.parse(start) && time < Date.parse(end)
}
export const METRIC_DICTIONARY = {
  metricVersion: 2,
  executionCount: 'Terminal segment events; distinct from logical executionRef and task identity.',
  costUsd: 'Reported USD; partial sums include known/unknown measurement coverage.',
  tokens: 'Raw reported input/output/cache fields separately; cache inclusion unknown until harness qualification.',
  durationSeconds: 'Reported runtime seconds per terminal segment.',
  operatorMinutes: 'Explicitly supplied human minutes; never inferred from runtime or rework.',
  mergedIssues: 'Unique accepted issues delivered by a verified PR merged into main during the UTC month.',
  corrections: 'Unique fix activities in the UTC month; review and handback are separate.',
  lifetime: 'Latest authoritative as-of snapshot; not summed across retained files.',
  skills: 'Whole-run association, nonadditive; no marginal cost or ROI.',
  subscriptionFee: 'One supplied report-level fee in its stated currency and billing period; never allocated to tasks.',
} as const
export interface SubscriptionFee { amount:number; currency:string; period:string; source:'operator-supplied'|'account-evidence' }
export function subscriptionFee(value: SubscriptionFee | null | undefined): SubscriptionFee | null {
  if (value == null) return null
  if (Object.keys(value).sort().join(',') !== 'amount,currency,period,source' || !Number.isFinite(value.amount) || value.amount < 0 || !/^[A-Z]{3}$/.test(value.currency) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period) || !['operator-supplied','account-evidence'].includes(value.source)) throw Error('metric-invalid-subscription-fee')
  return {amount:value.amount,currency:value.currency,period:value.period,source:value.source}
}
const taskKey = (task: TaskActivity['taskRef']): string => canonicalJson(task)
export function uniqueActivities(activities: readonly TaskActivity[]): TaskActivity[] {
  const seen = new Map<string,TaskActivity>()
  for (const activity of activities) {
    const key = canonicalJson([taskKey(activity.taskRef),activity.activityId]), prior = seen.get(key)
    if (prior && canonicalJson(prior) !== canonicalJson(activity)) throw Error('metric-conflicting-activity')
    seen.set(key,activity)
  }
  return [...seen.values()]
}
const reworkFields = ['reviewRounds','fixRounds','handbacks'] as const
export function summarizeIssueMonth(activities: readonly TaskActivity[], month: string, options: {complete?:boolean;snapshots?:readonly ReworkSnapshot[];observedAt?:string} = {}) {
  const {start,end} = utcMonthBounds(month)
  const complete = options.complete !== false
  const cutoff=options.observedAt&&Date.parse(options.observedAt)<Date.parse(end)?options.observedAt:end
  const observedAt=Date.parse(options.observedAt??end)
  const events = uniqueActivities(activities).filter(a=>inMonth(a.occurredAt,month))
  const count = (kind:TaskActivity['kind']) => complete ? events.filter(a=>a.kind===kind).length : null
  const merged = events.filter(a=>a.kind==='merged' && a.deliveryRef)
  const result = {
    mergedIssues: complete ? new Set(merged.map(a=>canonicalJson([a.taskRef.repo,a.taskRef.issue]))).size : null,
    mergedTasks: complete ? new Set(merged.map(a=>taskKey(a.taskRef))).size : null,
    implementedTasks: complete ? new Set(events.filter(a=>a.kind==='implemented').map(a=>taskKey(a.taskRef))).size : null,
    releasedTasks: complete ? new Set(events.filter(a=>a.kind==='released').map(a=>taskKey(a.taskRef))).size : null,
    reviewRounds:count('review'),fixRounds:count('fix'),handbacks:count('handback'),
    lifetime: [] as Array<{taskRef:ReworkSnapshot['taskRef'];asOf:string;reviewRounds:number|null;fixRounds:number|null;handbacks:number|null}>,
  }
  const snapshots = new Map<string,ReworkSnapshot[]>()
  for(const snapshot of options.snapshots??[]) {
    if(Date.parse(snapshot.asOf)>Date.parse(cutoff))continue
    const key=taskKey(snapshot.taskRef);snapshots.set(key,[...(snapshots.get(key)??[]),snapshot])
  }
  for(const rows of snapshots.values()) {
    rows.sort((a,b)=>Date.parse(a.asOf)-Date.parse(b.asOf))
    const latest=rows.at(-1)!
    const lifetimeKnown=latest.historyComplete&&calendarExpiry(new Date(latest.asOf),12).getTime()>observedAt
    result.lifetime.push({taskRef:latest.taskRef,asOf:latest.asOf,reviewRounds:lifetimeKnown?latest.reviewRounds:null,fixRounds:lifetimeKnown?latest.fixRounds:null,handbacks:lifetimeKnown?latest.handbacks:null})
    const baseline=rows.filter(s=>Date.parse(s.asOf)<=Date.parse(start)).at(-1)
    for(const field of reworkFields) {
      const kind=field==='reviewRounds'?'review':field==='fixRounds'?'fix':'handback'
      if(events.some(a=>taskKey(a.taskRef)===taskKey(latest.taskRef)&&a.kind===kind))continue
      const valid=baseline&&Date.parse(latest.asOf)===Date.parse(cutoff)&&latest.historyComplete&&baseline.historyComplete&&latest.historyStart&&Date.parse(latest.historyStart)<=Date.parse(start)&&latest.counterEpoch===baseline.counterEpoch&&latest[field]!==null&&baseline[field]!==null&&rows.filter(s=>Date.parse(s.asOf)>=Date.parse(baseline.asOf)).every((s,i,list)=>s.counterEpoch===baseline.counterEpoch&&s.historyComplete&&s[field]!==null&&(i===0||s[field]!>=list[i-1]![field]!))
      if(!valid)result[field]=null
      else if(result[field]!==null)result[field]!+=latest[field]!-baseline[field]!
    }
  }
  return result
}
export type ExecutionInput = Extract<LocalMeasurement,{recordKind:'execution'}>
export function summarizeExecutions(events: readonly ExportedEvent[], fee?:SubscriptionFee|null) {
  const executions=events.filter((e):e is ExportedEvent & {payload:ExecutionInput}=>e.payload.recordKind==='execution')
  const values={} as Record<MeasurementKey,MetricValue>
  for(const key of MEASUREMENT_KEYS) {
    const measured=summarizeMeasured(executions.map(e=>e.payload[key]??null))
    // Coverage describes actual observations, including partial producer measurements.
    const counts=executions.reduce((sum,e)=>({known:sum.known+(e.payload.coverage?.[key].known??(e.payload[key]==null?0:1)),unknown:sum.unknown+(e.payload.coverage?.[key].unknown??(e.payload[key]==null?1:0))}),{known:0,unknown:0})
    values[key]=metricValue({...measured,...counts})
  }
  const byDay:Record<string,{executionEvents:number;values:Record<MeasurementKey,Measured>}>={}
  for(const day of [...new Set(executions.map(e=>e.payload.utcDay))].sort()){const rows=executions.filter(e=>e.payload.utcDay===day);byDay[day]={executionEvents:rows.length,values:Object.fromEntries(MEASUREMENT_KEYS.map(key=>[key,summarizeMeasured(rows.map(e=>e.payload[key]??null))])) as Record<MeasurementKey,Measured>}}
  const outcomes:Record<string,number>={}
  for(const {payload} of executions)outcomes[payload.outcome]=(outcomes[payload.outcome]??0)+1
  const owners=(field:'taskOwner'|'agentAccountOwner')=>{
    const groups=new Map<string|null,number>()
    for(const {payload} of executions){const owner=payload[field]??null;groups.set(owner,(groups.get(owner)??0)+1)}
    return [...groups].sort(([a],[b])=>(a??'').localeCompare(b??'')).map(([owner,events])=>({owner,events}))
  }
  return {metricVersion:METRIC_VERSION,executionEvents:executions.length,logicalExecutions:new Set(executions.map(e=>e.payload.executionRef).filter(Boolean)).size,unknownExecutionIdentity:executions.filter(e=>!e.payload.executionRef).length,values,outcomes,byDay,estimateBases:[...new Map(executions.filter(e=>e.payload.apiEquivalentUsd!==null&&e.payload.apiEquivalentUsd!==undefined&&e.payload.estimateBasis).map(e=>[canonicalJson(e.payload.estimateBasis),e.payload.estimateBasis!])).values()],taskOwners:owners('taskOwner'),agentAccountOwners:owners('agentAccountOwner'),operatorMinutes:metricValue(summarizeMeasured(executions.map(e=>e.payload.operatorMinutes??null))),apiEquivalentUsd:metricValue(summarizeMeasured(executions.map(e=>e.payload.apiEquivalentUsd??null))),subscriptionFee:subscriptionFee(fee),cacheInclusion:'unknown' as const}
}

/** This derived wire contains permitted metric fields only, never source bodies
 * or coordination receipts. Shared by cache ingestion and CLI fallback reads. */
export function parseActivityCollection(value:unknown,repo:string):import('./timeline.ts').TaskActivityCollection {
  const fail=()=>{throw Error('activity-invalid-cached-collection')}
  const object=(v:unknown,keys:string[]):Record<string,unknown>=>{
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))return fail()
    return v as Record<string,unknown>
  }
  const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.replace(/Z$/,v.includes('.')?'Z':'.000Z')
  const count=(v:unknown)=>v===null||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
  const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
  const task=(v:unknown)=>{const row=object(v,['repo','issue','taskId']);if(row.repo!==repo||!count(row.issue)||!row.issue||row.taskId!==null&&!id(row.taskId))fail()}
  const evidence=(v:unknown)=>{const row=object(v,['repo','issue','commentId','nodeId','bodySha256']);if(row.repo!==repo||!count(row.issue)||!count(row.commentId)||row.issue===0||row.commentId===0||row.nodeId!==null&&(typeof row.nodeId!=='string'||!/^[A-Za-z0-9_=-]{1,128}$/.test(row.nodeId))||row.bodySha256!==null&&(typeof row.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(row.bodySha256))||[row.issue,row.commentId,row.nodeId,row.bodySha256].every(v=>v===null))fail()}
  const row=object(value,['activities','snapshots','complete','reason','observedAt','sourceDigest'])
  if(!Array.isArray(row.activities)||!Array.isArray(row.snapshots)||row.activities.length+row.snapshots.length>10000||typeof row.complete!=='boolean'||row.reason!==null&&(typeof row.reason!=='string'||!/^activity-[a-z-]{1,100}$/.test(row.reason))||row.complete&&row.reason!==null||!date(row.observedAt)||typeof row.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceDigest))fail()
  for(const value of row.activities as unknown[]){
    const a=object(value,['taskRef','activityId','kind','occurredAt','deliveryRef','sourceRef']);task(a.taskRef);evidence(a.sourceRef)
    if(!id(a.activityId)||!date(a.occurredAt)||!['implemented','merged','released','review','fix','handback'].includes(String(a.kind)))fail()
    if(a.deliveryRef!==null){const d=object(a.deliveryRef,['repo','pr','prNodeId','acceptedParentHead','mergedCommit']);if(d.repo!==repo||!count(d.pr)||!d.pr||typeof d.prNodeId!=='string'||!/^[A-Za-z0-9_=-]{1,128}$/.test(d.prNodeId)||typeof d.acceptedParentHead!=='string'||!/^[a-f0-9]{40}$/.test(d.acceptedParentHead)||d.mergedCommit!==null&&(typeof d.mergedCommit!=='string'||!/^[a-f0-9]{40}$/.test(d.mergedCommit)))fail()}
    if((a.kind==='merged'||a.kind==='released')&&a.deliveryRef===null)fail()
  }
  for(const value of row.snapshots as unknown[]){const s=object(value,['taskRef','asOf','sourceRef','counterEpoch','reviewRounds','fixRounds','handbacks','historyComplete','historyStart']);task(s.taskRef);evidence(s.sourceRef);if(!date(s.asOf)||typeof s.counterEpoch!=='string'||!/^[a-f0-9]{64}:v2$/.test(s.counterEpoch)||!['reviewRounds','fixRounds','handbacks'].every(key=>count(s[key]))||typeof s.historyComplete!=='boolean'||s.historyStart!==null&&!date(s.historyStart)||s.historyComplete&&s.historyStart===null||s.historyStart!==null&&Date.parse(s.historyStart as string)>Date.parse(s.asOf as string))fail()}
  return JSON.parse(canonicalJson(row)) as import('./timeline.ts').TaskActivityCollection
}

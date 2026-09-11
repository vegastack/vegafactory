import { parseStrictJson } from '../../../../skills/dev/dev-implement/scripts/lib/approval.mjs'
// The single reporting schema owner. Local capture, private recovery and shared reports
// are separate contracts; only explicitly constructed fields may cross this boundary.
import { randomUUID } from 'node:crypto'
import { readFile, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfiguredPolicy, resolvePolicy } from '../../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { canonicalJson, validateDestination, validateMeasurement, UUID, MEASUREMENT_KEYS, hashBytes, destinationId, parseTerminalCaptureKey, terminalCaptureKey,
  type Destination, type ExportMeasurement, type LocalMeasurement, type ExportReader, type ExportSerializer,
  type Coverage, type ExecutionAttribution, type MeasurementKey } from './types.ts'

export type ExportMode = 'off' | 'non-attributed' | 'attributed'
export interface ExportPolicy { values: Record<string, unknown>; policyDigest?: string; blocks?: string[] }
export const BASE_FIELDS = ['schemaVersion','metricVersion','recordKind','eventId','destination','utcDay'] as const
export const EXECUTION_FIELDS = ['stage','harness','model','mode','outcome','durationSeconds','turns','toolCalls','subagents','tokensIn','tokensOut','cacheReadTokens','cacheWriteTokens','costUsd','coverage','skills'] as const
export const ATTRIBUTION_FIELDS = ['taskRef','taskOwner','agentAccountOwner','executionRef','attempt','startedAt','endedAt','operatorMinutes','apiEquivalentUsd','estimateBasis'] as const
const STAGES = ['intake','plan','implement','review','status','chronicle']
const OUTCOMES = ['succeeded','failed','spawn-failed','timed-out','cancelled','interrupted','termination-unconfirmed']
const LEGACY_STAGES = [...STAGES,'corrections','ship']
const LEGACY_OUTCOMES = ['complete','handback','failed']
const HEX = /^[a-f0-9]{64}$/
const GIT = /^[a-f0-9]{40}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SENSITIVE = /(?:gh[pousr]_[A-Za-z0-9]|github_pat_|sk-(?:ant-|proj-)?[A-Za-z0-9]{12}|Bearer\s|-----BEGIN|(?:^|\s)(?:\/Users\/|\/home\/|[A-Z]:\\)|[\r\n\0])/i
const COUNTERS = new Set<string>(['turns','toolCalls','subagents','tokensIn','tokensOut','cacheReadTokens','cacheWriteTokens'])
const fail = (reason:string):never => {throw Error(reason)}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('privacy-invalid-object')
  return value as Record<string,unknown>
}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown> {
  const row=object(value)
  if(Object.keys(row).sort().join(',')!==[...keys].sort().join(','))fail('privacy-unknown-or-missing-field')
  return row
}
function sensitive(value:string):boolean {
  let decoded=value
  for(let n=0;n<3;n++){try{const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next}catch{return true}}
  let encoded=decoded
  for(let n=0;n<3&&/^[A-Za-z0-9+/_=-]{16,}$/.test(encoded);n++){
    try{const raw=Buffer.from(encoded,'base64').toString('utf8');if(SENSITIVE.test(raw))return true;if(raw===encoded)break;encoded=raw}catch{break}
  }
  return SENSITIVE.test(decoded)
}
function identifier(value:unknown,nullable=false,pattern=ID):void {
  if(nullable&&value===null)return
  if(typeof value!=='string'||!pattern.test(value)||sensitive(value))fail('privacy-invalid-identifier')
}
function numeric(value:unknown,counter=false,nullable=true):void {
  if(nullable&&value===null)return
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||counter&&!Number.isSafeInteger(value))fail('privacy-invalid-number')
}
function timestamp(value:unknown,nullable=false):void {
  if(nullable&&value===null)return
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value.replace(/Z$/,value.includes('.')?'Z':'.000Z'))fail('privacy-invalid-timestamp')
}
function task(value:unknown,destination:Destination,nullable=false):void {
  if(nullable&&value===null)return
  const row=closed(value,['repo','issue','taskId'])
  if(row.repo!==destination.repo)fail('privacy-foreign-task-repository')
  numeric(row.issue,true,false);if(row.issue===0)fail('privacy-invalid-issue');identifier(row.taskId,true)
}
function evidence(value:unknown,destination:Destination):void {
  const row=closed(value,['repo','issue','commentId','nodeId','bodySha256'])
  if(row.repo!==destination.repo)fail('privacy-foreign-evidence-repository')
  for(const key of ['issue','commentId']){numeric(row[key],true);if(row[key]===0)fail('privacy-invalid-evidence-id')}
  identifier(row.nodeId,true,/^[A-Za-z0-9_=-]{1,128}$/);identifier(row.bodySha256,true,HEX)
  if(row.issue===null&&row.commentId===null&&row.nodeId===null&&row.bodySha256===null)fail('privacy-evidence-unavailable')
}
function sameTask(outer:unknown,inner:unknown):void {if(canonicalJson(outer)!==canonicalJson(inner))fail('privacy-task-reference-mismatch')}

export interface LegacyStatsSkill {
  name:string
  trigger:string|null
  harness:string|null
}
export interface LegacyStatsProjection {
  ts:string
  repo:string
  stage:string|null
  harness:string|null
  model:string|null
  effort:string|null
  mode:string|null
  human:string|null
  outcome:string|null
  skills:LegacyStatsSkill[]
}

// Legacy JSONL remains source data, but only this closed compatibility projection may enter
// dashboard caches. Legacy-only stage and outcome compatibility never widens schema2 exports.
export function projectLegacyStats(value:unknown):LegacyStatsProjection {
  const row=closed(value,['ts','repo','stage','harness','model','effort','mode','human','outcome','skills'])
  timestamp(row.ts);identifier(row.repo,false,REPOSITORY)
  for(const segment of (row.repo as string).split('/'))if(sensitive(segment))fail('privacy-invalid-identifier')
  if(row.stage!==null&&!LEGACY_STAGES.includes(row.stage as string))fail('privacy-invalid-legacy-stage')
  identifier(row.harness,true);identifier(row.model,true);identifier(row.effort,true);identifier(row.human,true,LOGIN)
  if(row.mode!==null&&!['headless','interactive'].includes(row.mode as string))fail('privacy-invalid-mode')
  const outcome=row.outcome==='for-operator'?'handback':row.outcome
  if(outcome!==null&&!LEGACY_OUTCOMES.includes(outcome as string))fail('privacy-invalid-legacy-outcome')
  if(!Array.isArray(row.skills)||row.skills.length>128)fail('privacy-invalid-skills')
  const skills=(row.skills as unknown[]).map(raw=>{
    const skill=closed(raw,['name','trigger','harness'])
    identifier(skill.name);identifier(skill.harness,true)
    if(skill.trigger!==null&&!['model','typed','mention'].includes(skill.trigger as string))fail('privacy-invalid-skill-trigger')
    return {name:skill.name as string,trigger:skill.trigger as string|null,harness:skill.harness as string|null}
  })
  return {ts:row.ts as string,repo:row.repo as string,stage:row.stage as string|null,harness:row.harness as string|null,model:row.model as string|null,effort:row.effort as string|null,mode:row.mode as string|null,human:row.human as string|null,outcome:outcome as string|null,skills}
}

export function exportMode(policy:ExportPolicy | {org?:Record<string,unknown>;repo?:Record<string,unknown>;delegations?:unknown[]}):ExportMode {
  if(!('values' in policy)){
    const layer=(value:Record<string,unknown>|undefined)=>Object.entries(value??{}).map(([k,v])=>`${k}: ${v}`).join('\n')
    const resolved=resolvePolicy({org:layer(policy.org),repo:layer(policy.repo)})
    if(!resolved.ok)fail('privacy-policy-refused')
    return exportMode(resolved.policy)
  }
  if(policy.blocks?.length)fail('privacy-policy-refused')
  if(policy.values.stats==='off')return 'off'
  const mode=policy.values['stats-export']
  if(!['off','non-attributed','attributed'].includes(mode as string))fail('privacy-export-mode-unconfirmed')
  return mode as ExportMode
}

export function validateExport(value:unknown):ExportMeasurement {
  const row=object(value),kind=row.recordKind
  const attributed=kind==='execution'&&ATTRIBUTION_FIELDS.some(key=>Object.hasOwn(row,key))
  const fields=kind==='execution'?[...BASE_FIELDS,...EXECUTION_FIELDS,...(attributed?ATTRIBUTION_FIELDS:[])]:kind==='activity'?[...BASE_FIELDS,'taskRef','taskOwner','agentAccountOwner','activity']:kind==='rework-snapshot'?[...BASE_FIELDS,'taskRef','taskOwner','reworkSnapshot']:fail('privacy-unknown-record-kind')
  closed(row,fields)
  if(row.schemaVersion!==2||row.metricVersion!==2)fail('privacy-unknown-schema')
  identifier(row.eventId,false,UUID)
  const destination=validateDestination(row.destination)
  const day=row.utcDay
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)fail('privacy-invalid-day')
  if(kind==='execution'){
    if(!STAGES.includes(row.stage as string)||!OUTCOMES.includes(row.outcome as string))fail('privacy-invalid-execution-state')
    identifier(row.harness,true);identifier(row.model,true)
    if(row.mode!==null&&!['headless','interactive'].includes(row.mode as string))fail('privacy-invalid-mode')
    for(const key of MEASUREMENT_KEYS)numeric(row[key],COUNTERS.has(key))
    const coverage=closed(row.coverage,MEASUREMENT_KEYS)
    for(const key of MEASUREMENT_KEYS){const count=closed(coverage[key],['known','unknown']);numeric(count.known,true,false);numeric(count.unknown,true,false)}
    if(!Array.isArray(row.skills)||row.skills.length>128)fail('privacy-invalid-skills')
    for(const raw of row.skills as unknown[]){const skill=closed(raw,['name','trigger','harness']);identifier(skill.name);identifier(skill.harness);if(!['model','typed','mention'].includes(skill.trigger as string))fail('privacy-invalid-skill-trigger')}
    if(attributed){
      task(row.taskRef,destination,true);identifier(row.taskOwner,true,LOGIN);identifier(row.agentAccountOwner,true,LOGIN);identifier(row.executionRef,false,UUID)
      numeric(row.attempt,true,false);if(row.attempt===0)fail('privacy-invalid-attempt')
      timestamp(row.startedAt,true);timestamp(row.endedAt,true)
      if(row.startedAt!==null&&row.endedAt!==null&&Date.parse(row.startedAt as string)>Date.parse(row.endedAt as string))fail('privacy-invalid-execution-time')
      numeric(row.operatorMinutes);numeric(row.apiEquivalentUsd)
      if(row.estimateBasis!==null){
        const basis=closed(row.estimateBasis,['sourceUrl','checkedAt','priceDigest','currency','model'])
        if(typeof basis.sourceUrl!=='string'||basis.sourceUrl.length>2048||sensitive(basis.sourceUrl))fail('privacy-invalid-price-source')
        let url:URL;try{url=new URL(basis.sourceUrl as string)}catch{fail('privacy-invalid-price-source')}
        if(url!.protocol!=='https:'||url!.username||url!.password||url!.search||url!.hash||!url!.hostname.includes('.')||url!.hostname==='localhost')fail('privacy-invalid-price-source')
        timestamp(basis.checkedAt);identifier(basis.priceDigest,false,HEX);identifier(basis.currency,false,/^[A-Z]{3}$/);identifier(basis.model)
      }
      if((row.apiEquivalentUsd===null)!==(row.estimateBasis===null))fail('privacy-estimate-basis-required')
    }
  }else{
    task(row.taskRef,destination);identifier(row.taskOwner,true,LOGIN)
    if(kind==='activity'){
      identifier(row.agentAccountOwner,true,LOGIN)
      const activity=closed(row.activity,['taskRef','activityId','kind','occurredAt','deliveryRef','sourceRef'])
      task(activity.taskRef,destination);sameTask(row.taskRef,activity.taskRef);identifier(activity.activityId);timestamp(activity.occurredAt)
      if(!['implemented','merged','released','review','fix','handback'].includes(activity.kind as string))fail('privacy-invalid-activity-kind')
      evidence(activity.sourceRef,destination)
      if(activity.deliveryRef!==null){const delivery=closed(activity.deliveryRef,['repo','pr','prNodeId','acceptedParentHead','mergedCommit']);if(delivery.repo!==destination.repo)fail('privacy-foreign-delivery-repository');numeric(delivery.pr,true,false);if(delivery.pr===0)fail('privacy-invalid-pr');identifier(delivery.prNodeId,false,/^[A-Za-z0-9_=-]{1,128}$/);identifier(delivery.acceptedParentHead,false,GIT);identifier(delivery.mergedCommit,true,GIT)}
    }else{
      const snapshot=closed(row.reworkSnapshot,['taskRef','asOf','sourceRef','counterEpoch','reviewRounds','fixRounds','handbacks','historyComplete','historyStart'])
      task(snapshot.taskRef,destination);sameTask(row.taskRef,snapshot.taskRef);timestamp(snapshot.asOf);evidence(snapshot.sourceRef,destination)
      identifier(snapshot.counterEpoch,false,/^[a-f0-9]{64}:v2$/)
      for(const key of ['reviewRounds','fixRounds','handbacks'])numeric(snapshot[key],true)
      if(typeof snapshot.historyComplete!=='boolean')fail('privacy-invalid-history-coverage')
      timestamp(snapshot.historyStart,true)
      if(snapshot.historyComplete&&snapshot.historyStart===null||snapshot.historyStart!==null&&Date.parse(snapshot.historyStart as string)>Date.parse(snapshot.asOf as string))fail('privacy-invalid-history-boundary')
    }
  }
  if(Buffer.byteLength(canonicalJson(row))>256*1024)fail('privacy-export-too-large')
  return row as unknown as ExportMeasurement
}

// Missing measurements become explicit unknown; invalid supplied measurements never become null.
function historicalExecution(local:LocalMeasurement):boolean{return local.recordKind==='execution'&&(local.historicalNonAttributed===true||!!local.values&&!local.localRunId&&!local.executionRef)}
export function serializeExport(local:LocalMeasurement,destination:Destination,eventId:string,policy:ExportPolicy):ExportMeasurement|null {
  validateMeasurement(local);validateDestination(destination);identifier(eventId,false,UUID)
  const mode=exportMode(policy)
  const base={schemaVersion:2,metricVersion:2,recordKind:local.recordKind,eventId,destination,utcDay:local.utcDay}
  let candidate:Record<string,unknown>
  if(local.recordKind==='execution'){
    const legacy=local.values??{},tokens=legacy.tokens===undefined?{}:object(legacy.tokens)
    const names:Record<MeasurementKey,unknown>={durationSeconds:legacy.duration_s,turns:legacy.turns,toolCalls:legacy.tool_calls,subagents:legacy.subagents,tokensIn:tokens.in,tokensOut:tokens.out,cacheReadTokens:tokens.cache_read,cacheWriteTokens:tokens.cache_write,costUsd:legacy.cost_usd}
    const measurements={} as Record<MeasurementKey,number|null>,coverage={} as Coverage
    for(const key of MEASUREMENT_KEYS){const value=Object.hasOwn(local,key)?local[key]:names[key];measurements[key]=value===undefined?null:value as number|null;coverage[key]={known:measurements[key]===null?0:1,unknown:measurements[key]===null?1:0}}
    const supplied=(key:string,fallback:unknown)=>Object.hasOwn(local,key)?(local as unknown as Record<string,unknown>)[key]:fallback
    candidate={...base,stage:local.stage==='corrections'?'implement':local.stage,outcome:local.outcome==='complete'?'succeeded':local.outcome==='handback'?'failed':local.outcome,harness:supplied('harness',legacy.harness??null),model:supplied('model',legacy.model??null),mode:supplied('mode',legacy.mode??null),...measurements,coverage:supplied('coverage',coverage),skills:supplied('skills',legacy.skills??[])}
    if(mode==='attributed'&&!historicalExecution(local)){
      const extension:ExecutionAttribution={taskRef:local.taskRef??null,taskOwner:local.taskOwner??null,agentAccountOwner:local.agentAccountOwner??null,executionRef:local.executionRef??fail('privacy-reporting-identity-unavailable'),attempt:local.attempt??1,startedAt:local.startedAt??null,endedAt:local.endedAt??null,operatorMinutes:local.operatorMinutes??null,apiEquivalentUsd:local.apiEquivalentUsd??null,estimateBasis:local.estimateBasis??null}
      candidate={...candidate,...extension}
    }
  }else if(local.recordKind==='activity')candidate={...base,taskRef:local.taskRef,taskOwner:local.taskOwner??null,agentAccountOwner:local.agentAccountOwner??null,activity:local.activity}
  else candidate={...base,taskRef:local.taskRef,taskOwner:local.taskOwner??null,reworkSnapshot:local.reworkSnapshot}
  // Validate even suppressed data: malformed and policy-suppressed are different dispositions.
  const checked=validateExport(candidate)
  return mode==='off'||mode!=='attributed'&&local.recordKind!=='execution'?null:checked
}

export const readExport:ExportReader=(bytes)=>{
  if(typeof bytes!=='string'||Buffer.byteLength(bytes)>256*1024)fail('privacy-export-too-large')
  let parsed:unknown;try{parsed=parseStrictJson(bytes)}catch{fail('privacy-invalid-json')}
  const wire=validateExport(parsed)
  const {eventId,destination,metricVersion:_metric,...payload}=wire
  return {eventId,destination,payload:{...payload,...(wire.recordKind==='execution'&&!Object.hasOwn(wire,'executionRef')?{historicalNonAttributed:true}:{})} as LocalMeasurement}
}

// A destination is policy-bound per event, never by the first repository in a batch.
export async function configuredExportPolicy(home:string,destination:Destination):Promise<ExportPolicy> {
  validateDestination(destination)
  const {readPrivateRunFile}=await import('../runs.ts')
  let raw:string;try{raw=await readPrivateRunFile(join(home,'.vegastack','factory.json'))}catch{fail('privacy-current-policy-unavailable')}
  const settings=JSON.parse(raw!) as {repos?:Array<{repo:string;org:string;path:string}>;controlRooms?:Record<string,{repo:string}>}
  const rows=settings.repos?.filter(row=>row.repo===destination.repo&&row.org===destination.org)??[]
  if(rows.length!==1||settings.controlRooms?.[destination.org]?.repo!==destination.controlRoom)fail('privacy-destination-unregistered')
  const devMd=await readFile(join(rows[0]!.path,'.vegastack','dev.md'),'utf8')
  const resolved=loadConfiguredPolicy({home,repo:destination.repo,devMd})
  if(!resolved.ok||resolved.policy.repo!==destination.repo)fail('privacy-current-policy-unavailable')
  exportMode(resolved.policy)
  return resolved.policy as ExportPolicy
}
export function currentPolicySerializer(home:string,policyFor:(destination:Destination)=>Promise<ExportPolicy>=d=>configuredExportPolicy(home,d)):ExportSerializer {
  return async event=>{
    const policy=await policyFor(event.destination)
    if(!policy.policyDigest||!HEX.test(policy.policyDigest))fail('privacy-policy-digest-unavailable')
    if(event.payload.recordKind==='execution'&&exportMode(policy)==='attributed'&&!historicalExecution(event.payload)){
      const runId=event.payload.localRunId
      const segment=parseTerminalCaptureKey(event.captureKey)
      if(!runId||!segment||segment.runId!==runId)fail('privacy-reporting-identity-unavailable')
      const {readSpoolJson,spoolRoot}=await import('./outbox.ts')
      const capture=hashBytes(canonicalJson([destinationId(event.destination),event.captureKey]))
      const mapping=await readSpoolJson<{executionRef:string;eventId:string;payloadDigest:string;destination:string;captureKey:string}>(join(spoolRoot(home),'captures',capture+'.json'))
      if(!mapping||mapping.executionRef!==event.payload.executionRef||mapping.executionRef===runId||mapping.eventId!==event.eventId||mapping.payloadDigest!==hashBytes(canonicalJson(event.payload))||mapping.destination!==destinationId(event.destination)||mapping.captureKey!==event.captureKey)fail('privacy-reporting-identity-unavailable')
      if(segment!.sequence!=='0'){
        // Export only reads the logical identity already published by capture. A
        // forged segment map must never create or repair a reporting identity.
        const logicalKey=terminalCaptureKey(runId!),logical=hashBytes(canonicalJson([destinationId(event.destination),logicalKey]))
        const original=await readSpoolJson<{executionRef:string;eventId:string;destination:string;captureKey:string}>(join(spoolRoot(home),'captures',logical+'.json'))
        const prepared=await readSpoolJson<{executionRef:string}>(join(spoolRoot(home),'reporting-identities',logical+'.json'))
        if(original&&(original.destination!==destinationId(event.destination)||original.captureKey!==logicalKey||!UUID.test(original.eventId)||original.executionRef!==mapping!.executionRef)||prepared&&(Object.keys(prepared).join(',')!=='executionRef'||prepared.executionRef!==mapping!.executionRef)||!original&&!prepared)fail('privacy-reporting-identity-unavailable')
      }
    }
    const measurement=serializeExport(event.payload,event.destination,event.eventId,policy)
    return measurement===null?null:{bytes:canonicalJson(measurement)+'\n',policyDigest:policy.policyDigest!}
  }
}

export async function reportingExecutionRef(root:string,logicalExecution:string,destination:Destination):Promise<string> {
  identifier(logicalExecution,false,UUID);validateDestination(destination)
  const {withSpoolClaim,readSpoolJson,writeSpoolJson}=await import('./outbox.ts')
  const capture=hashBytes(canonicalJson([destinationId(destination),logicalExecution+':terminal:0']))
  const file=join(root,'reporting-identities',capture+'.json')
  return withSpoolClaim(root,'capture:'+capture,async()=>{
    const captured=await readSpoolJson<{executionRef?:string}>(join(root,'captures',capture+'.json'))
    const prepared=await readSpoolJson<{executionRef:string}>(file)
    if(prepared)closed(prepared,['executionRef'])
    const saved=captured?.executionRef??prepared?.executionRef
    if(saved){identifier(saved,false,UUID);if(saved===logicalExecution||captured?.executionRef&&prepared?.executionRef&&captured.executionRef!==prepared.executionRef)fail('privacy-reporting-identity-rebound');return saved}
    if(captured)fail('privacy-reporting-identity-unavailable')
    const executionRef=randomUUID();await writeSpoolJson(file,{executionRef});return executionRef
  })
}

export interface RetentionFile {
  path:string;kind:string;createdAt:string;bytes:number;active?:boolean;delivered?:boolean
  ambiguous?:boolean;recovery?:boolean;dedup?:boolean;authority?:boolean;quarantined?:boolean
}
export interface RetentionPlan {deleteCandidates:RetentionFile[];held:Array<RetentionFile&{reason:string}>;bytes:number}
export function calendarExpiry(at:Date,months:number):Date {
  const result=new Date(at),day=result.getUTCDate()
  result.setUTCDate(1);result.setUTCMonth(result.getUTCMonth()+months)
  const end=new Date(result);end.setUTCMonth(end.getUTCMonth()+1,0)
  result.setUTCDate(Math.min(day,end.getUTCDate()));return result
}
export function planRetention(input:{now:string;files:RetentionFile[];policy:{diagnosticDays:number;sharedMonths:number}}):RetentionPlan {
  timestamp(input.now)
  if(input.policy.diagnosticDays!==14||input.policy.sharedMonths!==12)fail('retention-policy-unconfirmed')
  const now=Date.parse(input.now),result:RetentionPlan={deleteCandidates:[],held:[],bytes:0}
  for(const file of input.files){
    let reason:string|null=null
    if(!['basic-diagnostic','delivered-report'].includes(file.kind))reason='retention-class-protected'
    else if(file.active!==false)reason='retention-active-or-unknown'
    else if(file.delivered!==true)reason='retention-undelivered-or-unknown'
    else if(file.ambiguous||file.recovery||file.dedup||file.authority||file.quarantined)reason='retention-recovery-held'
    else if(!Number.isSafeInteger(file.bytes)||file.bytes<0||!Number.isFinite(Date.parse(file.createdAt)))reason='retention-metadata-unavailable'
    else{
      try{timestamp(file.createdAt)}catch{reason='retention-metadata-unavailable'}
      const expiry=file.kind==='basic-diagnostic'?Date.parse(file.createdAt)+14*86400000:calendarExpiry(new Date(file.createdAt),12).getTime()
      if(!reason&&(expiry>now||Date.parse(file.createdAt)>now))reason='retention-not-expired'
    }
    if(reason)result.held.push({...file,reason});else{result.deleteCandidates.push(file);result.bytes+=file.bytes}
  }
  return result
}
export interface Pressure {freeBytes:number|null;paused:boolean;queueWarning:boolean;reason:'disk-low'|'disk-recovery-pending'|'disk-probe-unavailable'|'capacity-safe'}
export function diskPressure(freeBytes:number|null,previouslyPaused:boolean,pendingBytes:number):Pressure {
  const queueWarning=pendingBytes>=1024**3
  if(freeBytes===null||!Number.isSafeInteger(freeBytes)||freeBytes<0)return{freeBytes:null,paused:true,queueWarning,reason:'disk-probe-unavailable'}
  const paused=freeBytes<1024**3||previouslyPaused&&freeBytes<2*1024**3
  return{freeBytes,paused,queueWarning,reason:freeBytes<1024**3?'disk-low':paused?'disk-recovery-pending':'capacity-safe'}
}
export async function probePressure(home:string,pendingBytes:number,probe:()=>Promise<number>=async()=>{const info=await statfs(home);return info.bavail*info.bsize}):Promise<Pressure> {
  const {spoolRoot,withSpoolClaim,readSpoolJson,writeSpoolJson}=await import('./outbox.ts'),root=spoolRoot(home)
  try{return await withSpoolClaim(root,'disk-pressure',async()=>{
    const file=join(root,'disk-pressure.json'),prior=await readSpoolJson<{paused:boolean}>(file)
    if(prior){closed(prior,['paused']);if(typeof prior.paused!=='boolean')fail('disk-pressure-state-invalid')}
    let free:number|null=null;try{free=await probe()}catch{/* unavailable is a pause, never sufficient space */}
    const pressure=diskPressure(free,prior?.paused??false,pendingBytes)
    await writeSpoolJson(file,{paused:pressure.paused});return pressure
  })}catch{return diskPressure(null,true,pendingBytes)}
}
export interface PrivacyStatus {
  repo:string|null;mode:ExportMode|'unavailable';allowedFields:string[];pendingCount:number;pendingBytes:number;oldestPendingAt:string|null;diagnosticBytes:number;pressure:Pressure
  recipient:string;history:string;quarantinedCount:number;suppressedCount:number;deliveredCount:number
}
export async function privacyStatus(home:string,policy?:ExportPolicy,repo?:string):Promise<PrivacyStatus> {
  const {inspectSpool,spoolRoot}=await import('./outbox.ts'),spool=await inspectSpool(spoolRoot(home))
  const {lstat}=await import('node:fs/promises'),{readRuns,runsRoot}=await import('../runs.ts')
  const {readDeliveryReceipt}=await import('./push.ts'),{spoolEventFile,readSpoolJson}=await import('./outbox.ts')
  let pendingCount=0,pendingBytes=0,oldestPendingAt:string|null=null,deliveredCount=0,suppressedCount=0
  for(const event of spool.events.filter(event=>!repo||event.destination.repo===repo)){
    if(await readDeliveryReceipt(spoolRoot(home),event)){deliveredCount++;continue}
    const {destinationId}=await import('./types.ts')
    if(await readSpoolJson(join(spoolRoot(home),'suppressed',destinationId(event.destination),event.eventId+'.json'))){suppressedCount++;continue}
    const info=await lstat(spoolEventFile(spoolRoot(home),event));pendingCount++;pendingBytes+=info.size
    const at=info.mtime.toISOString();if(oldestPendingAt===null||at<oldestPendingAt)oldestPendingAt=at
  }
  let diagnosticBytes=0
  for(const run of (await readRuns(runsRoot(home))).filter(run=>!repo||run.repo===repo)){try{const info=await lstat(join(runsRoot(home),run.runId,'events.jsonl'));if(info.isFile()&&!info.isSymbolicLink())diagnosticBytes+=info.size}catch{/* missing log has no bytes */}}
  let mode:PrivacyStatus['mode']='unavailable';try{if(policy)mode=exportMode(policy)}catch{/* report no policy grant */}
  return{repo:repo??null,mode,allowedFields:mode==='off'||mode==='unavailable'?[]:[...BASE_FIELDS,...EXECUTION_FIELDS,...(mode==='attributed'?[...ATTRIBUTION_FIELDS,'activity','reworkSnapshot']:[])],pendingCount,pendingBytes,oldestPendingAt,diagnosticBytes,pressure:await probePressure(home,spool.pendingBytes),recipient:'Confirmed private control-room repository readers, including existing clones.',history:'Removing active reports does not erase Git history, historical clones or platform actor metadata. Source checkpoint branches have their code repository visibility and are not report-retention candidates.',quarantinedCount:spool.quarantine.length,suppressedCount,deliveredCount}
}

// Only closed basic diagnostics; no caller text, argv, output or local identities.
export function basicDiagnostic(at:string,event:string,fields:Record<string,unknown>={}):Record<string,unknown> {
  timestamp(at)
  if(!['prepared','launch-refused','start','exit','checkpoint-pending','handback-pending','capture-pending','storage-pressure'].includes(event))fail('diagnostic-event-invalid')
  const result:Record<string,unknown>={at,event}
  if(fields.durationSeconds!==undefined){numeric(fields.durationSeconds,false,false);result.durationSeconds=fields.durationSeconds}
  if(fields.exitCode!==undefined){if(fields.exitCode!==null&&(typeof fields.exitCode!=='number'||!Number.isSafeInteger(fields.exitCode)))fail('diagnostic-exit-invalid');result.exitCode=fields.exitCode}
  if(fields.terminationCause!==undefined){if(!OUTCOMES.includes(fields.terminationCause as string))fail('diagnostic-cause-invalid');result.terminationCause=fields.terminationCause}
  if(fields.reasonCode!==undefined){if(!['launch-refused','checkpoint-unavailable','handback-unavailable','capture-unavailable','disk-low','disk-recovery-pending','disk-probe-unavailable'].includes(fields.reasonCode as string))fail('diagnostic-reason-invalid');result.reasonCode=fields.reasonCode}
  return result
}
const OUTWARD_REASONS=new Set([
  'retention-task-absent','retention-task-unverified',
  'capture-payload-conflict','capture-pending','capture-unavailable','diagnostic-cause-invalid',
  'diagnostic-event-invalid','diagnostic-exit-invalid','diagnostic-reason-invalid','disk-low',
  'disk-pressure','disk-pressure-state-invalid','disk-probe-unavailable','disk-recovery-pending',
  'invalid-attempt-history','invalid-delivery-receipt','invalid-event-id','invalid-git-blob',
  'invalid-git-commit','invalid-legacy-record','invalid-serialized-export','invalid-spool-file',
  'legacy-migration','legacy-push-lock-requires-inspection','legacy-snapshots','legacy-source-changing',
  'legacy-source-too-large','legacy-sources','legacy-spool-deletion-refused','legacy-spool-requires-explicit-migration',
  'legacy-symlink-refused','privacy-current-policy-unavailable','privacy-destination-unregistered','privacy-estimate-basis-required',
  'privacy-evidence-unavailable','privacy-export-invalid-records','privacy-export-mode-unconfirmed','privacy-export-output-required',
  'privacy-export-too-large','privacy-foreign-delivery-repository','privacy-foreign-evidence-repository','privacy-foreign-task-repository',
  'privacy-invalid-activity-kind','privacy-invalid-attempt','privacy-invalid-day','privacy-invalid-evidence-id',
  'privacy-invalid-execution-state','privacy-invalid-execution-time','privacy-invalid-history-boundary','privacy-invalid-history-coverage',
  'privacy-invalid-identifier','privacy-invalid-issue','privacy-invalid-json','privacy-invalid-mode',
  'privacy-invalid-number','privacy-invalid-object','privacy-invalid-pr','privacy-invalid-price-source',
  'privacy-invalid-skill-trigger','privacy-invalid-skills','privacy-invalid-timestamp','privacy-person-reporting-unavailable',
  'privacy-person-scope-unavailable','privacy-person-unknown','privacy-policy-digest-unavailable','privacy-policy-refused',
  'privacy-read-scope-refused','privacy-reporting-identity-rebound','privacy-reporting-identity-unavailable','privacy-repository-scope-unavailable',
  'privacy-task-reference-mismatch','privacy-unknown-or-missing-field','privacy-unknown-record-kind','privacy-unknown-schema',
  'privacy-viewer-unavailable','remote-commit-unavailable','remote-event-not-regular','remote-event-payload-conflict',
  'remote-event-read-unavailable','retention-acknowledgment-unproven','retention-active-after-shared-removal','retention-active-or-unknown',
  'retention-active-reference-held','retention-active-reference-unavailable','retention-archived-state-reader-unavailable','retention-class-protected',
  'retention-commit-unavailable','retention-diagnostic-changed','retention-dry-run-removal-refused','retention-invalid-removal-receipt',
  'retention-metadata-unavailable','retention-nonbasic-diagnostic-held','retention-not-expired','retention-pending-policy-changed',
  'retention-policy-unavailable','retention-policy-unconfirmed','retention-receipt-unavailable','retention-recovery-held',
  'retention-remote-payload-diverged','retention-remote-report-reappeared','retention-removal-unconfirmed','retention-run-mutation-unavailable',
  'retention-shared-removal-unavailable','retention-undelivered-or-unknown','retention-unsafe-diagnostic','retention-unsafe-event',
  'spool-claim-unavailable','spool-file-changed','spool-record-too-large','suppressed-payload-conflict',
  'telemetry-attempt-rebound','telemetry-capture','telemetry-destination-proof-unavailable','telemetry-git-',
  'telemetry-push','telemetry-run-destination-mismatch','unsafe-legacy-root','unsafe-private-spool',
  'unsafe-spool-ancestor','unsafe-spool-file','unsafe-spool-root','writer-default-ref-unavailable',
  'writer-destination-mismatch','writer-dirty-preserved','writer-diverged-preserved','writer-has-no-matching-destination',
  'writer-url-policy-unavailable','writer-url-rewrite-refused','telemetry-git-status-failed','telemetry-git-config-failed',
  'telemetry-git-ls-remote-failed','telemetry-git-fetch-failed','telemetry-git-rev-parse-failed','telemetry-git-merge-base-failed',
  'telemetry-git-ls-tree-failed','telemetry-git-show-failed','telemetry-git-read-tree-failed','telemetry-git-hash-object-failed',
  'telemetry-git-update-index-failed','telemetry-git-write-tree-failed','telemetry-git-commit-tree-failed',
])
export function privacyReason(error:unknown):string {
  const code=(error as NodeJS.ErrnoException)?.code
  if(code==='ENOSPC')return 'storage-full'
  if(code==='EACCES'||code==='EPERM')return 'storage-permission-denied'
  const message=error instanceof Error?error.message:''
  const reason=message.split(':')[0]??''
  return OUTWARD_REASONS.has(reason)?reason:'operation-unavailable'
}

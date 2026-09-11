// Transport owns local event identity. #149 owns production validation and serialization
// in this same boundary; a missing privacy serializer/reader must never export raw data.
import { createHash } from 'node:crypto'
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface Destination { host: 'github.com'; org: string; repo: string; controlRoom: string }
export interface TaskRef { repo: string; issue: number; taskId: string | null }
export interface StatsEvidenceRef { repo: string; issue: number | null; commentId: number | null; nodeId: string | null; bodySha256: string | null }
export interface DeliveryRef { repo: string; pr: number; prNodeId: string; acceptedParentHead: string; mergedCommit: string | null }
export interface TaskActivity { taskRef: TaskRef; activityId: string; kind: 'implemented' | 'merged' | 'released' | 'review' | 'fix' | 'handback'; occurredAt: string; deliveryRef: DeliveryRef | null; sourceRef: StatsEvidenceRef }
export interface ReworkSnapshot { taskRef: TaskRef; asOf: string; sourceRef: StatsEvidenceRef; counterEpoch: string; reviewRounds: number | null; fixRounds: number | null; handbacks: number | null; historyComplete: boolean; historyStart: string | null }
export interface EstimateBasis { sourceUrl: string; checkedAt: string; priceDigest: string; currency: string; model: string }
export const MEASUREMENT_KEYS = ['durationSeconds','turns','toolCalls','subagents','tokensIn','tokensOut','cacheReadTokens','cacheWriteTokens','costUsd'] as const
export type MeasurementKey = typeof MEASUREMENT_KEYS[number]
export type Coverage = Record<MeasurementKey, {known:number;unknown:number}>
export interface ExecutionMeasurements {
  stage: string; harness: string | null; model: string | null; mode: 'headless' | 'interactive' | null; outcome: string
  durationSeconds: number | null; turns: number | null; toolCalls: number | null; subagents: number | null
  tokensIn: number | null; tokensOut: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null
  coverage: Coverage; skills: Array<{name:string;trigger:'model'|'typed'|'mention';harness:string}>
}
export interface ExecutionAttribution {
  taskRef: TaskRef | null; taskOwner: string | null; agentAccountOwner: string | null; executionRef: string; attempt: number
  startedAt: string | null; endedAt: string | null; operatorMinutes: number | null; apiEquivalentUsd: number | null; estimateBasis: EstimateBasis | null
}
interface ExportBase { schemaVersion: 2; metricVersion: 2; eventId: string; destination: Destination; utcDay: string }
export type ExportMeasurement =
  | (ExportBase & {recordKind:'execution'} & ExecutionMeasurements & (ExecutionAttribution | {[K in keyof ExecutionAttribution]?:never}))
  | (ExportBase & {recordKind:'activity';taskRef:TaskRef;taskOwner:string|null;agentAccountOwner:string|null;activity:TaskActivity})
  | (ExportBase & {recordKind:'rework-snapshot';taskRef:TaskRef;taskOwner:string|null;reworkSnapshot:ReworkSnapshot})
// Local compatibility input remains private. New collectors use the camelCase fields;
// values is exclusively the explicit legacy capture adapter, never a shared object spread.
interface MeasurementBase { schemaVersion: 2; utcDay: string; values?: { [key: string]: JsonValue } }
export type LocalMeasurement =
  | (MeasurementBase & { recordKind:'execution';stage:string;outcome:string;localRunId?:string;historicalNonAttributed?:boolean } & Partial<Omit<ExecutionMeasurements,'stage'|'outcome'>> & Partial<ExecutionAttribution>)
  | (MeasurementBase & { recordKind:'activity';taskRef:TaskRef|string;activityId?:string;taskOwner?:string|null;agentAccountOwner?:string|null;activity?:TaskActivity })
  | (MeasurementBase & { recordKind:'rework-snapshot';taskRef:TaskRef|string;counterEpoch?:string;asOf?:string;sourceRef?:string;taskOwner?:string|null;reworkSnapshot?:ReworkSnapshot })
export interface SpoolEnvelope { schemaVersion: 2; eventId: string; destination: Destination; payload: LocalMeasurement; captureKey: string }
export interface SerializedExport { bytes: string; policyDigest: string }
export type ExportSerializer = (event: Readonly<SpoolEnvelope>) => Promise<SerializedExport | null>
// A reader returns validated transport identity plus owner-defined measurement. #148 builds metrics.
export interface ExportedEvent { eventId: string; destination: Destination; payload: LocalMeasurement }
export type ExportReader = (bytes: string) => ExportedEvent
export const serializeExport: ExportSerializer = async () => { throw Error('current-export-policy-required') }
export { readExport } from './privacy.ts'
import { readExport } from './privacy.ts'
export const hashBytes = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
  }
  throw Error('non-json-measurement')
}
export function validateDestination(value: unknown): Destination {
  const d = value as Destination
  const segment = /^[a-z0-9][a-z0-9._-]{0,99}$/
  if (!d || Object.keys(d).sort().join(',') !== 'controlRoom,host,org,repo' || d.host !== 'github.com' || !segment.test(d.org)) throw Error('invalid-destination')
  for (const repo of [d.repo, d.controlRoom]) {
    if (typeof repo !== 'string' || repo.split('/').length !== 2 || repo.split('/')[0] !== d.org || !repo.split('/').every(p => segment.test(p) && !p.endsWith('.git'))) throw Error('invalid-destination')
  }
  return d
}
export const destinationKey = (d: Destination): string => canonicalJson(validateDestination(d))
export const destinationId = (d: Destination): string => hashBytes(destinationKey(d))
export function validateMeasurement(value: unknown): LocalMeasurement {
  const p = value as LocalMeasurement
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.schemaVersion !== 2 || !['execution','activity','rework-snapshot'].includes(p.recordKind) || !/^\d{4}-\d{2}-\d{2}$/.test(p.utcDay) || !Number.isFinite(Date.parse(p.utcDay)) || new Date(p.utcDay).toISOString().slice(0,10) !== p.utcDay) throw Error('invalid-measurement')
  if(p.recordKind==='execution' && (typeof p.stage!=='string'||!p.stage||typeof p.outcome!=='string'||!p.outcome))throw Error('invalid-measurement-identity')
  if(p.recordKind!=='execution' && (!p.taskRef || p.recordKind==='activity' && !(p.activity?.activityId??p.activityId) || p.recordKind==='rework-snapshot' && !(p.reworkSnapshot?.counterEpoch??p.counterEpoch)))throw Error('invalid-measurement-identity')
  if (canonicalJson(p).length > 256 * 1024) throw Error('measurement-too-large')
  return p
}
// Private capture identity only: opaque exported event/execution IDs never contain these keys.
export function terminalCaptureKey(runId:string,sequence='0'):string {
  if(!UUID.test(runId)||(sequence!=='0'&&!UUID.test(sequence)))throw Error('run-identity-unavailable')
  return `${runId}:terminal:${sequence}`
}
export function parseTerminalCaptureKey(key:string):{runId:string;sequence:string}|null {
  const parts=key.split(':')
  if(parts.length!==3||parts[1]!=='terminal'||!UUID.test(parts[0]!)||(parts[2]!=='0'&&!UUID.test(parts[2]!)))return null
  return{runId:parts[0]!,sequence:parts[2]!}
}
export function semanticCaptureKey(destination: Destination, payload: LocalMeasurement, runId?: string, terminalSequence='0'): string {
  validateMeasurement(payload)
  if (payload.recordKind === 'execution') { if (!runId) throw Error('run-identity-unavailable'); return terminalCaptureKey(runId,terminalSequence) }
  return payload.recordKind === 'activity'
    ? 'activity:' + hashBytes(canonicalJson([destinationKey(destination), payload.taskRef, payload.activity?.activityId ?? payload.activityId]))
    : 'snapshot:' + hashBytes(canonicalJson([destinationKey(destination), payload.taskRef, payload.reworkSnapshot?.counterEpoch ?? payload.counterEpoch, payload.reworkSnapshot?.asOf ?? payload.asOf, payload.reworkSnapshot?.sourceRef ?? payload.sourceRef]))
}
export function validateEnvelope(value: unknown): SpoolEnvelope {
  const e = value as SpoolEnvelope
  if (!e || Object.keys(e).sort().join(',') !== 'captureKey,destination,eventId,payload,schemaVersion' || e.schemaVersion !== 2 || !UUID.test(e.eventId) || typeof e.captureKey !== 'string' || !e.captureKey.length || e.captureKey.length > 1024 || /[\r\n\0]/.test(e.captureKey)) throw Error('invalid-envelope')
  if(e.captureKey.startsWith(e.eventId+':'))throw Error('local-run-id-cannot-be-export-event-id')
  validateDestination(e.destination); validateMeasurement(e.payload)
  if(e.payload.recordKind!=='execution'&&e.captureKey!==semanticCaptureKey(e.destination,e.payload))throw Error('semantic-capture-key-mismatch')
  return e
}
export const eventPath = (e: Pick<SpoolEnvelope,'destination'|'payload'|'eventId'>): string => {
  validateDestination(e.destination); validateMeasurement(e.payload)
  if (!UUID.test(e.eventId)) throw Error('invalid-event-id')
  return `stats/${e.destination.repo.replace('/', '__')}-${hashBytes(e.destination.repo).slice(0,12)}/${e.payload.utcDay.slice(0,7)}/events/${e.eventId}.json`
}

export interface IngestedEvent { source:string; event:ExportedEvent; payloadSha256:string; semanticKey:string|null }
export interface InvalidEvent {source:string;reason:string;bytes:number}
export interface EventBatch {events:IngestedEvent[];invalid:InvalidEvent[];duplicates:number}
export function readEventBatch(inputs:Array<{source:string;bytes:string}>,reader:ExportReader=readExport):EventBatch {
  const rows:IngestedEvent[]=[],invalid:InvalidEvent[]=[]
  for(const input of inputs){try{
    const event=reader(input.bytes)
    validateDestination(event.destination);validateMeasurement(event.payload)
    if(!UUID.test(event.eventId))throw Error('invalid-export-event-id')
    rows.push({source:input.source,event,payloadSha256:hashBytes(input.bytes),semanticKey:event.payload.recordKind!=='execution'?semanticCaptureKey(event.destination,event.payload):null})
  }catch(error){invalid.push({source:input.source,reason:(error as Error).message,bytes:Buffer.byteLength(input.bytes)})}}
  const ids=new Map<string,IngestedEvent[]>(),result:IngestedEvent[]=[]
  for(const row of rows){const key=canonicalJson([destinationKey(row.event.destination),row.event.eventId]);ids.set(key,[...(ids.get(key)??[]),row])}
  let duplicates=0
  for(const group of ids.values()){
    if(new Set(group.map(row=>row.payloadSha256)).size>1){for(const row of group)invalid.push({source:row.source,reason:'conflicting-event-id',bytes:Buffer.byteLength(inputs.find(i=>i.source===row.source)?.bytes??'')});continue}
    result.push(group[0]!);duplicates+=group.length-1
  }
  const semantic=new Map<string,IngestedEvent[]>(),events:IngestedEvent[]=[]
  for(const row of result){if(row.semanticKey){const key=canonicalJson([destinationKey(row.event.destination),row.semanticKey]);semantic.set(key,[...(semantic.get(key)??[]),row])}else events.push(row)}
  for(const group of semantic.values()){
    if(new Set(group.map(row=>canonicalJson(row.event.payload))).size>1){for(const row of group)invalid.push({source:row.source,reason:row.event.payload.recordKind==='activity'?'conflicting-semantic-activity':'conflicting-semantic-snapshot',bytes:0});continue}
    events.push(group[0]!);duplicates+=group.length-1
  }
  return{events,invalid,duplicates}
}

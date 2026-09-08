import { execFile } from 'node:child_process'

import type { Live } from './github'

// `vegafactory status --json`'s document, re-declared field for field: the dashboard ships as
// its own tarball onto machines with no CLI source tree, so it cannot import the CLI's types.
// Everything is optional-shaped at the parse boundary and read defensively below.
export interface StatusWorktree {
  path: string
  branch: string
  issue: number | null
  state: string
}

export interface StatusRun {
  runId?: string | null
  recovery?: DurableRecoverySummary | null
  state?: string
  terminationCause?: string | null
  pendingDelivery?: number | null
  lastError?: string | null
  issue: number | null
  stage: string
  startedAt: string
  exitCode: number | null
  lastMessage: string
  logFile: string
}

export const WORKFLOW_STATES = ['needsOperator', 'needsPlan', 'ready', 'working', 'forOperator'] as const
export type WorkflowState = typeof WORKFLOW_STATES[number]
export interface WorkflowStateSnapshot {
  repo: string; policyDigest: string; observedAt: string; complete: boolean
  labelMap: Record<WorkflowState, string> | null; blocks: string[]
  issues: Array<{ number: number; nodeId: string; labelsDigest: string; state: WorkflowState | null; blocks: string[] }>
}

// Validate the wire contract only. Label-to-state interpretation belongs to the CLI.
function workflowSnapshot(value: unknown, repo: string): WorkflowStateSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const row = value as WorkflowStateSnapshot
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
  if (row.repo !== repo || !/^[a-f0-9]{64}$/.test(row.policyDigest) || typeof row.observedAt !== 'string'
    || !Number.isFinite(Date.parse(row.observedAt)) || typeof row.complete !== 'boolean' || !strings(row.blocks)
    || !Array.isArray(row.issues)) return null
  if (row.labelMap !== null && (!row.labelMap || typeof row.labelMap !== 'object'
    || Object.keys(row.labelMap).length !== 5 || !WORKFLOW_STATES.every(key => typeof row.labelMap?.[key] === 'string' && row.labelMap[key].trim())
    || new Set(Object.values(row.labelMap).map(label => label.toLowerCase())).size !== 5)) return null
  if (row.complete && (!row.labelMap || row.blocks.length)) return null
  const ids = new Set<string>()
  for (const issue of row.issues) {
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.nodeId !== 'string' || !issue.nodeId
      || ids.has(issue.nodeId) || !/^[a-f0-9]{64}$/.test(issue.labelsDigest) || !strings(issue.blocks)
      || (issue.state !== null && !WORKFLOW_STATES.includes(issue.state))
      || (issue.state !== null && issue.blocks.length)) return null
    ids.add(issue.nodeId)
  }
  return row
}

export interface DurableRecoverySummary {action:'wait'|'retry-delivery'|'inspect';reason:string;checkpointHead:string|null;unbackedTail:boolean;terminalCapturePreserved:boolean}
export type SharedHistoryCoverage='complete'|'partial'|'unsupported'|'unavailable'|'bounded'
export type SharedTransitionKind='acquire'|'start'|'checkpoint'|'stop'|'handoff'|'complete'|'block'|'recovery'|'receipt'|'effect-send'|'accept-scope'
export interface SharedTaskStatus {taskKey:string;repo:string;issue:number;state:string;machineId:string;generation:number;sourceCommit?:string;originMachineId?:string|null;lastTransitionObservedAt?:string|null;checkpoint?:{headSha:string;publishedAt:string;sourceCommit:string;availability:'unknown'}|null;history?:{coverage:SharedHistoryCoverage;events:Array<{kind:SharedTransitionKind;generation:number;machineId:string;previousMachineId:string|null;sourceCommit:string;observedAt:string|null}>}}
export interface SharedStatus {head:string|null;tasks:SharedTaskStatus[];refusal:string|null;history?:{coverage:SharedHistoryCoverage;archiveCoverage:'active-only'|'partial';sourceCommit:string}}
export interface PolicySnapshotStatus {state:string;sourceCommit:string|null;policyDigest:string|null;validatedAt:string|null;ageSeconds:number|null;reason:string|null;machine?:{id:string|null;state:string;reason:string|null;executionIdentityVerified:boolean;sourceCommit:string|null}|null}
export interface StatusRepo {
  shared?: SharedStatus | null
  snapshot?: PolicySnapshotStatus | null
  workflow?: WorkflowStateSnapshot | null
  repo: string
  dispatch: string
  board: { needsPlan: number; ready: number; working: number; forOperator: number }
  worktrees: StatusWorktree[]
  runs: StatusRun[]
}

export interface StatusReport {
  dispatcher: { running: boolean; pid: number | null; lastTick: string | null; interval: number | null }
  repos: StatusRepo[]
}

// Spawned through execFile with an argument array, never a shell: the bin path comes from the
// CLI's own environment, and a shell would make any character in it executable.
function run(bin: string, timeoutMs: number, configPath?:string): Promise<Live<string>> {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json',...(configPath?['--config',configPath]:[])], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) resolve({ ok: false, reason: 'vegafactory status is unavailable' })
      else resolve({ ok: true, data: stdout })
    })
  })
}

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => number(value) ?? 0

export function parseStatusReport(parsed: unknown): StatusReport | null {
  if (!parsed || typeof parsed !== 'object') return null
  const document = parsed as Record<string, unknown>
  if(!document.dispatcher||typeof document.dispatcher!=='object'||!Array.isArray(document.repos)||typeof (document.dispatcher as Record<string,unknown>).running!=='boolean')return null
  const dispatcher = (document.dispatcher && typeof document.dispatcher === 'object' ? document.dispatcher : {}) as Record<string, unknown>
  const repos: StatusRepo[] = []
  if (Array.isArray(document.repos)) {
    for (const entry of document.repos) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const board = (row.board && typeof row.board === 'object' ? row.board : {}) as Record<string, unknown>
      repos.push({
        repo: text(row.repo),
        workflow: workflowSnapshot(row.workflow, text(row.repo)),
        dispatch: text(row.dispatch),
        shared: sharedStatus(row.shared,text(row.repo)),
        snapshot: policySnapshot(row.snapshot),
        board: {
          needsPlan: count(board.needsPlan), ready: count(board.ready),
          working: count(board.working), forOperator: count(board.forOperator),
        },
        worktrees: (Array.isArray(row.worktrees) ? row.worktrees : []).map((tree) => {
          const w = (tree ?? {}) as Record<string, unknown>
          return { path: text(w.path), branch: text(w.branch), issue: number(w.issue), state: text(w.state) }
        }),
        runs: (Array.isArray(row.runs) ? row.runs : []).map((entryRun) => {
          const r = (entryRun ?? {}) as Record<string, unknown>
          return {
            runId:uuidValue(r.runId),recovery:recoverySummary(r.recovery),state:text(r.state),terminationCause:typeof r.terminationCause==='string'?r.terminationCause:null,pendingDelivery:number(r.pendingDelivery),lastError:safeReason(r.lastError),
            issue: number(r.issue), stage: text(r.stage), startedAt: text(r.startedAt),
            exitCode: number(r.exitCode), lastMessage: text(r.lastMessage), logFile: text(r.logFile),
          }
        }),
      })
    }
  }
  return {
    dispatcher: {
      running: dispatcher.running === true,
      pid: number(dispatcher.pid),
      lastTick: typeof dispatcher.lastTick === 'string' ? dispatcher.lastTick : null,
      interval: number(dispatcher.interval),
    },
    repos,
  }
}

export async function readStatus(input: { bin: string | null; configPath?:string; org?:string; repos?:string[]; timeoutMs?: number }): Promise<Live<StatusReport>> {
  if (!input.bin) return { ok: false, reason: 'no vegafactory binary was passed to the dashboard' }
  const result = await run(input.bin, input.timeoutMs ?? 10_000,input.configPath)
  if (!result.ok) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(result.data)
  } catch {
    return { ok: false, reason: 'vegafactory status --json printed something that is not JSON' }
  }
  const report = parseStatusReport(parsed)
  if (!report) return { ok: false, reason: 'vegafactory status --json printed no status document' }
  if(input.org)report.repos=report.repos.filter(row=>row.repo.split('/')[0]===input.org)
  if(input.repos)report.repos=report.repos.filter(row=>input.repos!.includes(row.repo))
  return { ok: true, data: report }
}

const shaValue=(v:unknown):string|null=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)?v:null
const uuidValue=(v:unknown):string|null=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)?v:null
const safeReason=(v:unknown):string|null=>typeof v==='string'&&v.length<=300&&!/[\r\n\0]|\/Users\/|\/home\/|gh[pousr]_|github_pat_|Bearer |sk-(?:ant-|proj-)/i.test(v)?v:null
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
function recoverySummary(value:unknown):DurableRecoverySummary|null {
  if(value===null||value===undefined)return null
  const r=object(value),reason=safeReason(r.reason)
  if(!['wait','retry-delivery','inspect'].includes(String(r.action))||reason===null||r.checkpointHead!==null&&!shaValue(r.checkpointHead)||typeof r.unbackedTail!=='boolean'||typeof r.terminalCapturePreserved!=='boolean')return null
  return {action:r.action as DurableRecoverySummary['action'],reason,checkpointHead:shaValue(r.checkpointHead),unbackedTail:r.unbackedTail,terminalCapturePreserved:r.terminalCapturePreserved}
}
function sharedStatus(value:unknown,repo:string):SharedStatus|null {
  if(value===null||value===undefined)return null
  const r=object(value)
  if(r.head!==null&&!shaValue(r.head)||!Array.isArray(r.tasks)||r.refusal!==null&&safeReason(r.refusal)===null)return null
  const tasks:SharedStatus['tasks']=[],seen=new Set<string>()
  for(const item of r.tasks){const t=object(item);if(t.repo!==repo)continue
    if(typeof t.taskKey!=='string'||!/^[a-f0-9]{64}$/.test(t.taskKey)||seen.has(t.taskKey)||!Number.isSafeInteger(t.issue)||Number(t.issue)<1||!['claimed','running','stopped','blocked','completed'].includes(String(t.state))||typeof t.machineId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(t.machineId)||!Number.isSafeInteger(t.generation)||Number(t.generation)<1)return null
    const row:SharedTaskStatus={taskKey:t.taskKey,repo,issue:Number(t.issue),state:String(t.state),machineId:t.machineId,generation:Number(t.generation)}
    if(Object.hasOwn(t,'history')){const extra=sharedTaskProjection(t,r.head);if(extra)Object.assign(row,extra)}
    seen.add(t.taskKey);tasks.push(row)
  }
  const metadata=object(r.history)
  const history=historyCoverage(metadata.coverage)&&['active-only','partial'].includes(String(metadata.archiveCoverage))&&metadata.sourceCommit===r.head&&shaValue(metadata.sourceCommit)?{coverage:metadata.coverage as SharedHistoryCoverage,archiveCoverage:metadata.archiveCoverage as 'active-only'|'partial',sourceCommit:metadata.sourceCommit as string}:undefined
  return {head:shaValue(r.head),tasks,refusal:safeReason(r.refusal),...(history?{history}:{})}
}
function policySnapshot(value:unknown):PolicySnapshotStatus|null {
  if(value===null||value===undefined)return null
  const r=object(value)
  if(typeof r.state!=='string'||!['fresh','stale','unavailable'].includes(r.state)||r.sourceCommit!==null&&!shaValue(r.sourceCommit)||r.policyDigest!==null&&(typeof r.policyDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.policyDigest))||r.validatedAt!==null&&(typeof r.validatedAt!=='string'||!Number.isFinite(Date.parse(r.validatedAt)))||r.ageSeconds!==null&&(number(r.ageSeconds)===null||Number(r.ageSeconds)<0)||r.reason!==null&&safeReason(r.reason)===null)return null
  const m=object(r.machine),machine=r.machine&&['configured','unavailable'].includes(String(m.state))&&typeof m.executionIdentityVerified==='boolean'?{id:typeof m.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(m.id)?m.id:null,state:String(m.state),reason:safeReason(m.reason),executionIdentityVerified:m.executionIdentityVerified,sourceCommit:shaValue(m.sourceCommit)}:null
  return {state:r.state,sourceCommit:shaValue(r.sourceCommit),policyDigest:r.policyDigest as string|null,validatedAt:r.validatedAt as string|null,ageSeconds:number(r.ageSeconds),reason:safeReason(r.reason),machine}
}

export interface ActivityCollection {
  activities:Array<{taskRef:{repo:string;issue:number;taskId:string|null};activityId:string;kind:'implemented'|'merged'|'released'|'review'|'fix'|'handback';occurredAt:string;deliveryRef:{repo:string;pr:number;prNodeId:string;acceptedParentHead:string;mergedCommit:string|null}|null;sourceRef:{repo:string;issue:number|null;commentId:number|null;nodeId:string|null;bodySha256:string|null}}>
  snapshots:Array<{taskRef:{repo:string;issue:number;taskId:string|null};asOf:string;sourceRef:ActivityCollection['activities'][number]['sourceRef'];counterEpoch:string;reviewRounds:number|null;fixRounds:number|null;handbacks:number|null;historyComplete:boolean;historyStart:string|null}>
  complete:boolean;reason:string|null;observedAt:string;sourceDigest:string
}
export interface ActivityReport extends ActivityCollection {schemaVersion:2;metricVersion:2;org:string;repo:string;period:string}
// This is the CLI wire bridge only. GitHub discovery and evidence interpretation
// have exactly one implementation, in the CLI collector.
export async function readActivities(input:{bin:string|null;configPath?:string;org:string;repo:string;month:string;timeoutMs?:number}):Promise<Live<ActivityReport>> {
  if(!input.bin)return {ok:false,reason:'activity-binary-unavailable'}
  if(!/^[a-z0-9][a-z0-9._-]*$/i.test(input.org)||input.repo.split('/')[0]!==input.org||!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(input.repo)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month))return {ok:false,reason:'activity-invalid-scope'}
  if(input.timeoutMs!==undefined&&(!Number.isFinite(input.timeoutMs)||input.timeoutMs<=0))return {ok:false,reason:'activity-invalid-deadline'}
  const release=await acquireActivitySlot()
  return new Promise(resolve=>{
    execFile(input.bin!,['stats','activity','--org',input.org,'--repo',input.repo,'--month',input.month,'--json',...(input.configPath?['--config',input.configPath]:[])],{timeout:Math.min(input.timeoutMs??65_000,65_000),maxBuffer:8*1024*1024},(error,stdout)=>{
      release()
      if(error&&error.code!==1){resolve({ok:false,reason:'activity-source-unavailable'});return}
      try{
        const row=JSON.parse(stdout) as ActivityReport
        if(Object.keys(row).sort().join(',')!=='activities,complete,metricVersion,observedAt,org,period,reason,repo,schemaVersion,snapshots,sourceDigest')throw Error('invalid')
        if(row.schemaVersion!==2||row.metricVersion!==2||row.org!==input.org||row.repo!==input.repo||row.period!==input.month||typeof row.complete!=='boolean'||row.reason!==null&&(typeof row.reason!=='string'||!/^activity-[a-z-]+$/.test(row.reason))||typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt))||!/^[a-f0-9]{64}$/.test(row.sourceDigest)||!Array.isArray(row.activities)||!Array.isArray(row.snapshots)||row.activities.some(a=>a.taskRef?.repo!==input.repo)||row.snapshots.some(s=>s.taskRef?.repo!==input.repo))throw Error('invalid')
        if(row.complete&&row.reason!==null||row.activities.length+row.snapshots.length>10000)throw Error('invalid')
        for(const activity of row.activities)validateActivityWire(activity,input.repo)
        for(const snapshot of row.snapshots)validateSnapshotWire(snapshot,input.repo)
        resolve({ok:true,data:row})
      }catch{resolve({ok:false,reason:'activity-invalid-report'})}
    })
  })
}
export async function readActivityRepositories(input:{bin:string|null;configPath?:string;org:string;repos:string[];month:string}):Promise<Array<{repo:string;result:Live<ActivityReport>}>> {
  const repos=[...new Set(input.repos)],out:Array<{repo:string;result:Live<ActivityReport>}>=[]
  let next=0
  await Promise.all(Array.from({length:Math.min(3,repos.length)},async()=>{
    for(;;){const index=next++;if(index>=repos.length)return;const repo=repos[index]!;out[index]={repo,result:await readActivities({...input,repo})}}
  }))
  return out
}

let activityRunning=0
const activityWaiters:Array<()=>void>=[]
async function acquireActivitySlot():Promise<()=>void>{
  if(activityRunning>=3)await new Promise<void>(resolve=>activityWaiters.push(resolve))
  else activityRunning++
  return ()=>{const next=activityWaiters.shift();if(next)next();else activityRunning--}
}
function closedWire(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('invalid activity wire')
  return value as Record<string,unknown>
}
const wireDate=(value:unknown):boolean=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value.replace(/Z$/,value.includes('.')?'Z':'.000Z')
const wireCount=(value:unknown):boolean=>value===null||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
function taskWire(value:unknown,repo:string):void{const row=closedWire(value,['repo','issue','taskId']);if(row.repo!==repo||!wireCount(row.issue)||!row.issue||row.taskId!==null&&(typeof row.taskId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.taskId)))throw Error('invalid task wire')}
function evidenceWire(value:unknown,repo:string):void{
  const row=closedWire(value,['repo','issue','commentId','nodeId','bodySha256'])
  if(row.repo!==repo||!wireCount(row.issue)||!wireCount(row.commentId)||row.issue===0||row.commentId===0||row.nodeId!==null&&(typeof row.nodeId!=='string'||!/^[A-Za-z0-9_=-]{1,128}$/.test(row.nodeId))||row.bodySha256!==null&&(typeof row.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(row.bodySha256))||[row.issue,row.commentId,row.nodeId,row.bodySha256].every(v=>v===null))throw Error('invalid evidence wire')
}
function validateActivityWire(value:unknown,repo:string):void{
  const row=closedWire(value,['taskRef','activityId','kind','occurredAt','deliveryRef','sourceRef']);taskWire(row.taskRef,repo);evidenceWire(row.sourceRef,repo)
  if(typeof row.activityId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.activityId)||!['implemented','merged','released','review','fix','handback'].includes(String(row.kind))||!wireDate(row.occurredAt))throw Error('invalid activity wire')
  if(row.deliveryRef!==null){const d=closedWire(row.deliveryRef,['repo','pr','prNodeId','acceptedParentHead','mergedCommit']);if(d.repo!==repo||!wireCount(d.pr)||!d.pr||typeof d.prNodeId!=='string'||!/^[A-Za-z0-9_=-]{1,128}$/.test(d.prNodeId)||!shaValue(d.acceptedParentHead)||d.mergedCommit!==null&&!shaValue(d.mergedCommit))throw Error('invalid delivery wire')}
  if(['merged','released'].includes(String(row.kind))&&row.deliveryRef===null)throw Error('missing delivery wire')
}
function validateSnapshotWire(value:unknown,repo:string):void{
  const row=closedWire(value,['taskRef','asOf','sourceRef','counterEpoch','reviewRounds','fixRounds','handbacks','historyComplete','historyStart']);taskWire(row.taskRef,repo);evidenceWire(row.sourceRef,repo)
  if(!wireDate(row.asOf)||typeof row.counterEpoch!=='string'||!/^[a-f0-9]{64}:v2$/.test(row.counterEpoch)||!['reviewRounds','fixRounds','handbacks'].every(key=>wireCount(row[key]))||typeof row.historyComplete!=='boolean'||row.historyStart!==null&&!wireDate(row.historyStart)||row.historyComplete&&row.historyStart===null||row.historyStart!==null&&Date.parse(row.historyStart as string)>Date.parse(row.asOf as string))throw Error('invalid snapshot wire')
}

const historyCoverage=(value:unknown):value is SharedHistoryCoverage=>['complete','partial','unsupported','unavailable','bounded'].includes(String(value))
const machineId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)
function sharedTaskProjection(row:Record<string,unknown>,head:unknown):Pick<SharedTaskStatus,'sourceCommit'|'originMachineId'|'lastTransitionObservedAt'|'checkpoint'|'history'>|null {
  const history=object(row.history)
  if(!shaValue(row.sourceCommit)||row.sourceCommit!==head||!historyCoverage(history.coverage)||!Array.isArray(history.events)||history.events.length>100||row.originMachineId!==null&&!machineId(row.originMachineId)||history.coverage!=='complete'&&row.originMachineId!==null||row.lastTransitionObservedAt!==null&&!wireDate(row.lastTransitionObservedAt))return null
  const events:NonNullable<SharedTaskStatus['history']>['events']=[]
  for(const value of history.events){const event=object(value)
    if(!['acquire','start','checkpoint','stop','handoff','complete','block','recovery','receipt','effect-send','accept-scope'].includes(String(event.kind))||!Number.isSafeInteger(event.generation)||Number(event.generation)<1||!machineId(event.machineId)||event.previousMachineId!==null&&!machineId(event.previousMachineId)||!shaValue(event.sourceCommit)||event.observedAt!==null&&!wireDate(event.observedAt))return null
    events.push({kind:event.kind as SharedTransitionKind,generation:Number(event.generation),machineId:event.machineId,previousMachineId:event.previousMachineId as string|null,sourceCommit:event.sourceCommit as string,observedAt:event.observedAt as string|null})
  }
  let checkpoint:SharedTaskStatus['checkpoint']=null
  if(row.checkpoint!==null){const value=object(row.checkpoint);if(!shaValue(value.headSha)||!wireDate(value.publishedAt)||value.sourceCommit!==head||value.availability!=='unknown')return null;checkpoint={headSha:value.headSha as string,publishedAt:value.publishedAt as string,sourceCommit:value.sourceCommit as string,availability:'unknown'}}
  return {sourceCommit:row.sourceCommit as string,originMachineId:row.originMachineId as string|null,lastTransitionObservedAt:row.lastTransitionObservedAt as string|null,checkpoint,history:{coverage:history.coverage,events}}
}

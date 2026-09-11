// Child execution and integration belong to this controller. The packaged helper
// only parses/plans; buildLaunchPlan and executeApprovedRun own every child process.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireClaim, releaseClaim, processIdentity, type Claim } from './claims.ts'
import { loadFactoryConfig, repoPolicyFromEffective, stagePolicy, type FactoryConfig, type RepoPolicy } from './config.ts'
import { loadConfiguredPolicy } from './control-room.ts'
import { ghText, boundedGhJson, fetchGhPages, readBudget } from './gh.ts'
import { buildLaunchPlan, validateManagedLaunch, type LaunchPlan } from './launch.ts'
import { atomicRunFile, readPrivateRunFile, readRun, readRuns, runsRoot, verifyRunAuthority, approvalTools, type RunAuthorityRequest, type RunRecord } from './runs.ts'
import { acquireSharedTask, transitionSharedTask, publishRecoveryReceipt, readCoordination, inspectGroupSuccession, canonical, parseAcceptedScope, type ParentClaimBinding, type TaskRecord, type SharedClaim, type TaskTransition, type RecoveryEvidencePayload, type AcceptanceRef, type ChildAcceptance, type JoinRef } from './shared-claims.ts'
import { executeApprovedRun, inspectManagedHarness, shipGuardWired, sharedClaimForRun, sharedRunAdapters, prepareDispatchRun, verifyDispatchRunAuthority, stableGroupRequestId, type PlannedRun, type ExecuteDeps } from './dispatch.ts'
// Load executable helpers as packaged files, never inline their CLI entrypoints
// into dist/index.js. Source tests use the same authored files before packaging.
const sourceModule = fileURLToPath(import.meta.url).endsWith('.ts')
const implementRoot = fileURLToPath(new URL(sourceModule ? '../../../skills/dev/dev-implement/' : '../skill/dev-implement/', import.meta.url))
const planRoot = fileURLToPath(new URL(sourceModule ? '../../../skills/dev/dev-plan/' : '../skill/dev-plan/', import.meta.url))
const { readGroupsReport, planParallelRun, scopeViolations, validateChildResult: validateResult } = await import(pathToFileURL(join(implementRoot, 'scripts/children.mjs')).href) as typeof import('../../../skills/dev/dev-implement/scripts/children.mjs')
const { createChildWorktree } = await import(pathToFileURL(join(implementRoot, 'scripts/worktree.mjs')).href) as typeof import('../../../skills/dev/dev-implement/scripts/worktree.mjs')
const { lintPlan, parseIndependentGroups } = await import(pathToFileURL(join(planRoot, 'scripts/plan-lint.mjs')).href) as typeof import('../../../skills/dev/dev-plan/scripts/plan-lint.mjs')

export interface ChildGroup { id: string; members: string[]; files: string[] }
export interface ChildResult {
  schemaVersion: 1; runId: string; repo: string; issue: number; baseSha: string; headSha: string; branch: string; scopeDigest: string
  terminationCause: 'succeeded'; acceptance: { ok: true; command: string; sha: string }; noChange: boolean
  machine: RunRecord['machine']; sharedGeneration: number | null; checkpoint: RunRecord['checkpoint']
}
export interface ChildCheck {
  schemaVersion: 1; runId: string; baseSha: string; headSha: string; scopeDigest: string; command: string
  ok: boolean; exitCode: number | null; validationId: string; checkRunId: string; startedAt: string; finishedAt: string
}
export interface ChildLaunch {
  group: string; issue: number; title: string; type: string; branch: string; path: string; files: string[]; resources: string[]
  baseSha: string; runId: string | null; scopeDigest: string | null; taskIds: string[]; acceptanceCommand: string
  parentBinding?: ParentClaimBinding | null
  recoveryDisposition?: 'retained'|'completed'|'no-shared-task'
}
export interface ChildrenRecord {
  schemaVersion: 1 | 2 | 3; parentRunId: string; parentIssue: number; repo: string; parentBranch: string; baseSha: string
  parentBinding: ParentClaimBinding; concurrency: number; groups: ChildGroup[]; children: ChildLaunch[]
}
export interface IntegrationRecord {
  schemaVersion: 1; operationId: string; issue: number; runId: string; generation: number; fromSha: string
  baseSha: string; parentBefore: string; parentAfter: string | null; accepted: boolean; reason: string
  receiptIds: { preparedLink: string; accepted: string; acceptedLink: string; acceptance: string }
  state: 'prepared' | 'applied' | 'accepted' | 'refused'; preparedRef: JoinRef | null; acceptedRef: JoinRef | null
}
const sha = /^[a-f0-9]{40}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const closed = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const planned = (repo: string, child: ChildLaunch): PlannedRun => ({ repo, issue: child.issue, title: child.title, stage: 'implement', commentId: null, reactionId: null })
const recordPath = (root: string, parentRunId: string) => join(root, parentRunId, 'children.json')
const resultPath = (root: string, runId: string) => join(root, runId, 'child-result.json')
const checkPath = (root: string, runId: string) => join(root, runId, 'child-acceptance.json')
const joinPath = (root: string, parentRunId: string, childRunId: string) => join(root, parentRunId, 'join-' + childRunId + '.json')
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0 || result.error || result.signal) throw Error('git ' + args[0] + ' failed: ' + (result.stderr?.trim() || result.error?.message || result.signal))
  return result.stdout.trim()
}
function clean(cwd: string): void {
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) throw Error('checkout has uncommitted work')
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(resolve(cwd, git(cwd, ['rev-parse', '--git-path', name])))) throw Error('checkout has an existing Git operation')
  }
}
export function parentClaimBinding(claim: SharedClaim): ParentClaimBinding {
  return { taskKey: claim.taskKey, runId: claim.runId, generation: claim.generation, ownerToken: claim.ownerToken,
    machineId: claim.machineId, installationId: claim.installationId, sessionId: claim.sessionId }
}
export function validateChildResult(value: unknown, expected: { issue: number; scopeDigest: string; run: RunRecord | null; acceptance?: ChildCheck | null }): { ok: boolean; reason: string } {
  return validateResult(value, expected)
}
function checkedGroups(value: unknown): ChildGroup[] {
  const report = value as { guard?: unknown; ok?: unknown }
  if (report?.guard !== 'plan-lint' || report.ok !== true) throw Error('validated plan-lint --groups report required')
  const groups = readGroupsReport(value) as ChildGroup[]
  const ids = new Set<string>(), issues = new Set<string>()
  for (const group of groups) {
    if (ids.has(group.id) || !group.id || group.members.length !== 1 || !/^#[1-9]\d*$/.test(group.members[0]!)) throw Error('one distinct child per independent group required')
    ids.add(group.id)
    if (issues.has(group.members[0]!)) throw Error('duplicate child group')
    issues.add(group.members[0]!)
    if (new Set(group.files).size !== group.files.length || group.files.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.startsWith('-') || path.includes('\\') || /[\x00-\x1f*?\[\]]/.test(path) || path.split('/').some(part => part === '..' || part === '.'))) throw Error('literal repository-relative child scope required')
  }
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    if (groups[i]!.files.some(a => groups[j]!.files.some(b => a === b || b.startsWith(a.replace(/\/$/, '') + '/') || a.startsWith(b.replace(/\/$/, '') + '/')))) throw Error('overlapping groups require serial work')
  }
  if (!groups.length) throw Error('no independent children declared')
  return groups.map(group => ({ id: group.id, members: [...group.members], files: [...group.files] }))
}
function parseChildrenRecord(value: unknown): ChildrenRecord {
  const record = value as ChildrenRecord
  if (!closed(record, ['schemaVersion','parentRunId','parentIssue','repo','parentBranch','baseSha','parentBinding','concurrency','groups','children']) || !uuid.test(record.parentRunId) || ![1,2,3].includes(record.schemaVersion) || !sha.test(record.baseSha) || !Array.isArray(record.children) || !Number.isSafeInteger(record.concurrency) || record.concurrency < 1 || record.concurrency > 3) throw Error('invalid saved child launch')
  const parent=record.parentBinding
  if(!closed(parent,['taskKey','runId','generation','ownerToken','machineId','installationId','sessionId'])||!/^[a-f0-9]{64}$/.test(parent.taskKey)||!uuid.test(parent.runId)||!Number.isSafeInteger(parent.generation)||parent.generation<1||![parent.ownerToken,parent.installationId,parent.sessionId].every(id=>uuid.test(id))||typeof parent.machineId!=='string'||!parent.machineId)throw Error('saved parent provenance differs')
  const groups = checkedGroups({ guard: 'plan-lint', ok: true, groups: record.groups })
  if (groups.length !== record.children.length || record.parentBinding?.runId !== record.parentRunId) throw Error('saved parent/group identity differs')
  for (let i = 0; i < groups.length; i++) {
    const child = record.children[i]!, group = groups[i]!
    const fields = ['group','issue','title','type','branch','path','files','resources','baseSha','runId','scopeDigest','taskIds','acceptanceCommand',...(record.schemaVersion>=2?['parentBinding']:[]),...(record.schemaVersion===3?['recoveryDisposition']:[])]
    if (!closed(child, fields) || record.schemaVersion===1&&Object.hasOwn(child,'parentBinding') || child.runId !== null && !uuid.test(child.runId) || child.scopeDigest !== null && !/^[a-f0-9]{64}$/.test(child.scopeDigest) || child.group !== group.id || '#' + child.issue !== group.members[0] || !same(child.files, group.files) || child.baseSha !== record.baseSha || !Array.isArray(child.resources) || child.resources.length || !Array.isArray(child.taskIds) || !child.acceptanceCommand) throw Error('saved child scope differs')
    if(record.schemaVersion>=2){const binding=child.parentBinding;if(binding!=null&&(!closed(binding,['taskKey','runId','generation','ownerToken','machineId','installationId','sessionId'])||!/^[a-f0-9]{64}$/.test(binding.taskKey)||!uuid.test(binding.runId)||!Number.isSafeInteger(binding.generation)||binding.generation<1||![binding.ownerToken,binding.installationId,binding.sessionId].every(id=>uuid.test(id))||typeof binding.machineId!=='string'||!binding.machineId))throw Error('saved child parent provenance differs')}
    if(record.schemaVersion===3&&(!['retained','completed','no-shared-task'].includes(child.recoveryDisposition!)||child.recoveryDisposition==='retained'&&(!child.runId||!child.parentBinding)||child.recoveryDisposition==='completed'&&(!child.runId||!child.parentBinding)||child.recoveryDisposition==='no-shared-task'&&(child.runId!==null||child.scopeDigest!==null||child.taskIds.length||child.parentBinding!==null)))throw Error('saved recovered child disposition differs')
  }
  return record
}
export async function readChildrenRecord(root: string, parentRunId: string): Promise<ChildrenRecord> {
  return parseChildrenRecord(JSON.parse(await readPrivateRunFile(recordPath(root, parentRunId))))
}
async function readOptional<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readPrivateRunFile(path)) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function canonicalPlan(run: RunRecord, gh: typeof ghText = ghText): Promise<string> {
  const binding = run.approvalRefs.find(ref => ref.kind === 'plan')
  if (!binding) throw Error('approved parent plan unavailable')
  const comments = await fetchGhPages<{ node_id: string; body: string }>(gh, `repos/${run.repo}/issues/${run.issue}/comments`, readBudget())
  if (!comments.complete) throw Error('complete canonical plan history unavailable')
  const rows = comments.items.filter(row => row.node_id === binding.artifactId)
  const { approval } = await approvalTools()
  if (rows.length !== 1 || approval.scopeDigest(rows[0]!.body, 'plan') !== binding.digest) throw Error('canonical approved plan changed')
  return rows[0]!.body
}
async function currentPolicy(config: FactoryConfig, repo: string): Promise<{ policy: RepoPolicy; devMd: string; resolved: ReturnType<typeof loadConfiguredPolicy> }> {
  const entry = config.repos.find(row => row.repo === repo)
  if (!entry) throw Error('child repository is not configured')
  const devMd = await readFile(join(entry.path, '.vegastack/dev.md'), 'utf8')
  const resolved = loadConfiguredPolicy({ home: config.home, repo, devMd, settingsPath: config.settingsPath })
  if (!resolved.ok) throw Error('current child policy unavailable')
  return { policy: repoPolicyFromEffective(resolved), devMd, resolved }
}
async function currentParentContext(parent:RunRecord,record:ChildrenRecord,config:FactoryConfig,gh:typeof ghText=ghText):Promise<{claim:SharedClaim;task:TaskRecord;binding:ParentClaimBinding;succession:Extract<import('./shared-claims.ts').GroupSuccessionInspection,{kind:'verified'}>|null}> {
  const claim=await sharedClaimForRun(parent,config,gh),binding=parentClaimBinding(claim),snapshot=await readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
  if(!task||task.runId!==claim.runId||task.generation!==claim.generation||task.ownerToken!==claim.ownerToken||task.machineId!==claim.machineId||task.installationId!==claim.installationId||task.sessionId!==claim.sessionId||task.parentTaskKey!==null)throw Error('current parent coordination owner differs')
  let succession:Extract<import('./shared-claims.ts').GroupSuccessionInspection,{kind:'verified'}>|null=null
  if(!same(binding,record.parentBinding)){
    if(task.schemaVersion!==2)throw Error('changed parent owner lacks verified group succession')
    const inspected=await inspectGroupSuccession(claim.target,{operationId:task.successionOperationId,parent:binding})
    if(inspected.kind!=='verified')throw Error(inspected.reason)
    succession=inspected
    const current=inspected.currentMembers.find(row=>row.current.taskKey===task.taskKey)
    const receipt=inspected.receipt.members.find(row=>row.after.taskKey===task.taskKey)
    if(!current||!receipt||!same(receipt.before,record.parentBinding)||!same(current.current,task)||current.initial.successionOperationId!==task.successionOperationId)throw Error('current parent succession member differs')
  }
  return{claim,task,binding,succession}
}
async function activeParentLifecycle(parent:RunRecord,config:FactoryConfig):Promise<boolean>{
  if(parent.state==='running')return true
  const barrier=await readOptional<{schemaVersion:number;runId:string;attemptId:string;state:string}>(join(runsRoot(config.home),parent.runId,'controller-barrier.json'))
  return parent.state==='prepared'&&!parent.processIdentity&&parent.parent===null&&(parent.remoteRecovery?.kind==='receiving-group'&&parent.remoteRecovery.role==='parent'||!!parent.continuations?.length)&&barrier?.schemaVersion===1&&barrier.runId===parent.runId&&barrier.attemptId===(parent.attemptId??parent.runId)&&barrier.state==='active'&&!existsSync(join(runsRoot(config.home),parent.runId,'attempts',parent.attemptId??parent.runId))
}
export async function readExecutableChildrenRecord(parent:RunRecord,config:FactoryConfig):Promise<ChildrenRecord>{
  const root=runsRoot(config.home),path=recordPath(root,parent.runId),raw=await readPrivateRunFile(path),parsed=parseChildrenRecord(JSON.parse(raw))
  if(parsed.schemaVersion>=2)return parsed
  const children:ChildLaunch[]=[]
  for(const child of parsed.children){
    if(!child.runId){children.push({...child,parentBinding:null});continue}
    const run=await readRun(root,child.runId)
    if(!run.sharedClaim)throw Error('v1 child original shared parent facts unavailable')
    const claim=await sharedClaimForRun(run,config),snapshot=await readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
    if(!task||task.runId!==run.runId||task.issue!==child.issue||task.scopeDigest!==child.scopeDigest||!task.parentBinding)throw Error('v1 child original shared parent facts unavailable')
    children.push({...child,parentBinding:task.parentBinding})
  }
  const upgraded=parseChildrenRecord({...parsed,schemaVersion:2,children}),lock=await acquireClaim(join(root,parent.runId,'children-upgrade.lock'),await processIdentity())
  if(lock.kind!=='owned')throw Error('child record upgrade is owned by another operation')
  try{
    const current=await readPrivateRunFile(path)
    if(current!==raw){const winner=parseChildrenRecord(JSON.parse(current));if(winner.schemaVersion!==2||!same(winner,upgraded))throw Error('child record changed during v1 upgrade');return winner}
    const archive=join(root,parent.runId,'children-v1-'+hash(raw)+'.json'),copy=await readOptional<{schemaVersion:number;kind:string;sha256:string;bytes:string}>(archive)
    const exact={schemaVersion:1,kind:'children-v1-original',sha256:hash(raw),bytes:raw}
    if(copy&&!same(copy,exact))throw Error('preserved v1 child bytes differ')
    if(!copy)await atomicRunFile(archive,exact)
    const readback=await readOptional<typeof exact>(archive)
    if(!readback||readback.bytes!==raw||readback.sha256!==hash(raw))throw Error('preserved v1 child bytes unavailable')
    await atomicRunFile(path,upgraded)
    return parseChildrenRecord(JSON.parse(await readPrivateRunFile(path)))
  }finally{await releaseClaim(lock.claim)}
}
async function authoritativeGroups(parent: RunRecord, config: FactoryConfig,gh:typeof ghText=ghText): Promise<ChildGroup[]> {
  await verifyRunAuthority(parent, config, 'launch',{gh})
  const body = await canonicalPlan(parent,gh), lint = lintPlan(body)
  if (lint.blocks.length) throw Error('approved independent plan is invalid: ' + lint.blocks.join('; '))
  return checkedGroups({ guard: 'plan-lint', ok: true, groups: parseIndependentGroups(body).map(group => ({ id: group.id, members: group.members, files: group.files })) })
}

// Called by #137 inside each pinned transaction, including ambiguous readback.
// Resolve the ORIGINAL launch binding; a latest-owner lookup cannot authorize it.
export async function verifyChildRelationship(input: { parent: TaskRecord; child: TaskRecord }, config: FactoryConfig,gh:typeof ghText=ghText): Promise<{ maxChildren: number }> {
  const root = runsRoot(config.home), parent = await readRun(root, input.parent.runId)
  const launch = await readExecutableChildrenRecord(parent,config)
  validateRecordedSource(parent, launch)
  const current=await currentParentContext(parent,launch,config,gh),expected=current.binding
  const actual = { taskKey: input.parent.taskKey, runId: input.parent.runId, generation: input.parent.generation, ownerToken: input.parent.ownerToken, machineId: input.parent.machineId, installationId: input.parent.installationId, sessionId: input.parent.sessionId }
  if (!same(actual, expected) || input.child.parentTaskKey !== expected.taskKey
    || parent.sharedClaim?.taskKey !== expected.taskKey || parent.sharedClaim.ownerToken !== expected.ownerToken || parent.sharedClaim.generation !== expected.generation
    || parent.machine?.id !== expected.machineId || parent.machine.installationId !== expected.installationId || parent.machine.sessionId !== expected.sessionId
    || !await activeParentLifecycle(parent,config) || parent.cancelRequestedAt || parent.terminationRequest || parent.parent !== null) throw Error('original parent coordination authority differs')
  clean(parent.checkout)
  if (git(parent.checkout, ['rev-parse', 'HEAD']) !== launch.baseSha) throw Error('parent source edits cannot overlap child reservations')
  const groups = await authoritativeGroups(parent, config,gh)
  if (!same(groups, launch.groups)) throw Error('approved parent groups changed')
  const { policy } = await currentPolicy(config, parent.repo)
  if (policy.effective?.policyDigest !== parent.policyDigest) throw Error('parent policy changed')
  const child = launch.children.find(row => row.issue === input.child.issue && row.runId === input.child.runId)
  if (!child || child.recoveryDisposition&&child.recoveryDisposition!=='retained' || !child.parentBinding || !same(input.child.parentBinding,child.parentBinding) || input.child.repo !== launch.repo || input.child.scopeDigest !== child.scopeDigest || !same(input.child.paths, child.files)
    || !same(input.child.resources, child.resources) || !input.child.independent || !same(input.child.approvedTaskIds, child.taskIds)) throw Error('child is outside exact approved parent group')
  const childRun = await readRun(root, input.child.runId)
  if (childRun.parent !== parent.issue || childRun.baseSha !== launch.baseSha || childRun.branch !== child.branch || childRun.checkout !== child.path || childRun.taskKey.scopeDigest !== child.scopeDigest || !same(childRun.approvedTaskIds, child.taskIds)) throw Error('child run differs from selected group')
  await verifyDispatchRunAuthority(childRun, config, 'launch',{gh})
  return { maxChildren: Math.min(launch.concurrency, config.subagents.concurrent, 3) }
}

export interface PreparedChild { run: RunRecord; plan: LaunchPlan; localClaim: Claim | null }
// Injection is limited to controller/provider boundaries for offline process tests.
// The public CLI has no alternate authority, command, or qualification switches.
export interface ChildrenDependencies {
  groups?: (parent: RunRecord, config: FactoryConfig) => Promise<ChildGroup[]>
  parentClaim?: (parent: RunRecord, config: FactoryConfig) => Promise<SharedClaim>
  issue?: (repo: string, issue: number) => Promise<{ number: number; title: string }>
  prepare?: (child: ChildLaunch, record: ChildrenRecord, parent: RunRecord, config: FactoryConfig) => Promise<PreparedChild>
  acquire?: (child: ChildLaunch, record: ChildrenRecord, prepared: PreparedChild, config: FactoryConfig) => Promise<SharedClaim | null>
  finish?: (claim: SharedClaim | null, run: RunRecord, config: FactoryConfig) => Promise<void>
  verifyParent?: (record: ChildrenRecord, config: FactoryConfig) => Promise<void>
  verifyChild?: (run: RunRecord, config: FactoryConfig) => Promise<void>
  processDeps?: Partial<ExecuteDeps>
  gh?: typeof ghText
}
export interface ChildrenOutcome { results: ChildResult[]; blocked: Array<{ issue: number; reason: string }>; plan: ChildrenRecord; wrote: boolean }

type RecoveredStartMember={task:TaskRecord;claim:SharedClaim;startOperationId:string}
// Succession transfers reservations; it does not launch anything. Once the
// exact current set has been reconstructed, start the parent first, then only
// queued children without an already accepted historical join.
export async function startRecoveredGroupMembers(input:{parent:RecoveredStartMember;children:RecoveredStartMember[];deferChildren?:boolean},transition:(input:{claim:SharedClaim;operationId:string;transition:TaskTransition})=>Promise<import('./shared-claims.ts').SharedClaimResult>=transitionSharedTask):Promise<{parent:SharedClaim;children:SharedClaim[];acceptedRunIds:string[]}>{
 const parent=input.parent,operation=parent.task.schemaVersion===2?parent.task.successionOperationId:null
 const binding=(task:TaskRecord)=>({taskKey:task.taskKey,runId:task.runId,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId})
 const claimBinding=(claim:SharedClaim)=>({taskKey:claim.taskKey,runId:claim.runId,generation:claim.generation,ownerToken:claim.ownerToken,machineId:claim.machineId,installationId:claim.installationId,sessionId:claim.sessionId})
 if(parent.task.schemaVersion!==2||!['claimed','running'].includes(parent.task.state)||parent.task.parentTaskKey!==null||!operation||!same(binding(parent.task),claimBinding(parent.claim)))throw Error('recovered parent is not an exact claimed successor')
 if(new Set(input.children.map(row=>row.task.taskKey)).size!==input.children.length||new Set(input.children.map(row=>row.task.runId)).size!==input.children.length)throw Error('recovered children are not unique')
 const acceptedRunIds=[...new Set((parent.task.recovery?.joins??[]).filter(join=>join.state==='accepted').map(join=>join.childRunId))]
 if(acceptedRunIds.some(runId=>!input.children.some(row=>row.task.runId===runId)))throw Error('accepted recovered join names a missing child')
 for(const row of input.children)if(row.task.schemaVersion!==2||!['recovery-queued','running','stopped','completed'].includes(row.task.state)||row.task.parentTaskKey!==parent.task.taskKey||row.task.successionOperationId!==operation||!row.task.parentBinding||!same(binding(row.task),claimBinding(row.claim)))throw Error('recovered child is not an exact recovery-queued successor')
 const outstanding=input.children.filter(row=>!acceptedRunIds.includes(row.task.runId))
 const parentStarted=await transition({claim:parent.claim,operationId:parent.startOperationId,transition:{kind:'start'}})
 if(parentStarted.kind!=='owned')throw Error('recovered parent start not acknowledged: '+parentStarted.reason)
 const children:SharedClaim[]=[]
 if(input.deferChildren)return{parent:parentStarted.claim,children,acceptedRunIds}
 for(const row of outstanding){
  if(['stopped','completed'].includes(row.task.state))continue
  const started=await transition({claim:row.claim,operationId:row.startOperationId,transition:{kind:'start'}});if(started.kind!=='owned')throw Error('recovery-queued child start not acknowledged: '+started.reason);children.push(started.claim)
 }
 return{parent:parentStarted.claim,children,acceptedRunIds}
}
async function verifyParent(record: ChildrenRecord, config: FactoryConfig, unchangedSource = false, gh:typeof ghText=ghText): Promise<void> {
  const parent = await readRun(runsRoot(config.home), record.parentRunId)
  validateRecordedSource(parent, record)
  if (!await activeParentLifecycle(parent,config) || parent.cancelRequestedAt || parent.terminationRequest) throw Error('parent stopped, cancelled or lacks its active recovery-controller barrier')
  const current=await currentParentContext(parent,record,config,gh),{claim}=current
  const snapshot = await readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
  if (!task || task.state !== 'running' || task.stopProof || !snapshot.index.active.some(row => row.taskKey === task.taskKey)) throw Error('parent no longer owns active coordination')
  if (!same(await authoritativeGroups(parent, config,gh), record.groups)) throw Error('approved independent groups changed')
  if (git(parent.checkout, ['symbolic-ref', '--short', 'HEAD']) !== record.parentBranch) throw Error('parent checkout branch changed')
  if (unchangedSource) { clean(parent.checkout); if (git(parent.checkout, ['rev-parse', 'HEAD']) !== record.baseSha) throw Error('parent source changed during independent child execution') }
}
async function issueDetails(repo: string, issue: number): Promise<{ number: number; title: string }> {
  return boundedGhJson(ghText, ['api', `repos/${repo}/issues/${issue}`], readBudget())
}
type ConsolidatedExecutionRequest = Extract<RunAuthorityRequest, { kind: 'consolidated' }>
type ChildCheckpointRequest = NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>
export interface ConsolidatedChildRequests {
  executionRequest: ConsolidatedExecutionRequest
  checkpointRequest: ChildCheckpointRequest
  policy: RepoPolicy
  reads: unknown[]
  checked: {
    bindings: import('./shared-claims.ts').ArtifactRef[]
    approvalBindings: Array<{ approvalId: string; commentId: number; bodySha256: string }>
    recordBinding?: { approvalId: string; commentId: number; bodySha256: string }
    files: string[]
  }
  taskIds: string[]
}

// A child has no independent approval event. Both permissions are selected from
// one freshly read, pinned parent record and evaluated by the approval owner.
export async function deriveConsolidatedChildRequests(
  parent: RunRecord,
  child: ChildLaunch,
  record: ChildrenRecord,
  config: FactoryConfig,
  transport: { gh?: typeof ghText } = {},
): Promise<ConsolidatedChildRequests> {
  const saved=parseChildrenRecord(record),matchesSaved=saved.children.filter(row=>row.issue===child.issue&&row.group===child.group)
  if(saved.schemaVersion<2||matchesSaved.length!==1||!same(matchesSaved[0],child)||child.baseSha!==saved.baseSha||!same(child.files,saved.groups.find(group=>group.id===child.group)?.files))throw Error('prepared child differs from canonical launch record')
  const source = parent.authorityRequest
  if (source?.kind !== 'consolidated' || parent.parent !== null || source.parentRepo !== record.repo || source.parentIssue!==parent.issue || source.requested.repo !== record.repo
    || source.requested.issue !== parent.issue || source.requested.branch !== record.parentBranch || source.requested.baseSha !== record.baseSha
    || record.parentRunId !== parent.runId || record.parentIssue !== parent.issue) throw Error('consolidated parent execution locator differs')
  const gh = transport.gh ?? ghText, current = await currentPolicy(config, record.repo), reads: unknown[] = [], { approval } = await approvalTools()
  const readJson = async (args: string[]) => { const value = await boundedGhJson(gh, args, readBudget()); reads.push(value); return value }
  const history = await approval.readPages(readJson, ['api', `repos/${source.parentRepo}/issues/${source.parentIssue}/comments`])
  const matches = history.filter((row: { id?: number; body?: string }) => row.id === source.approvalBinding.commentId && typeof row.body === 'string' && hash(row.body) === source.approvalBinding.bodySha256)
  if (matches.length !== 1) throw Error('pinned consolidated parent record is absent, duplicate or changed')
  const grant = approval.parseApproval(matches[0])
  if (grant.kind !== 'consolidated') throw Error('pinned parent record is not consolidated authority')
  const selections = grant.items.filter((item: { repo: string; issue: number }) => item.repo === record.repo && item.issue === child.issue)
  if (selections.length !== 1 || selections[0]!.mode !== 'code') throw Error('exactly one consolidated code child is required')
  const selected = selections[0]!, taskIds = [...selected.taskIds]
  if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw Error('exact consolidated child task set unavailable')
  const selectedActions = grant.actions.filter((action: { id: string }) => selected.actionIds.includes(action.id))
  const local = selectedActions.filter((action: { kind: string; operations?: string[] }) => action.kind === 'local' && action.operations?.includes('edit'))
  if (local.length !== 1) throw Error('unique selected child edit action unavailable')
  const checkpoints = selectedActions.filter((action: { kind: string }) => action.kind === 'child-source-checkpoint')
  if (checkpoints.length !== 1) throw Error('unique selected child-source-checkpoint action unavailable')
  const checkpoint = checkpoints[0] as { id: string; kind: 'child-source-checkpoint'; repo: string; parent: { issue: number; branch: string; baseSha: string }; child: { issue: number; branch: string; ref: string; baseSha: string; taskIds: string[]; paths: string[] } }
  const parentTuple = { issue: source.parentIssue, branch: record.parentBranch, baseSha: record.baseSha }
  const childTuple = { issue: child.issue, branch: child.branch, ref: `refs/heads/${child.branch}`, baseSha: record.baseSha, taskIds, paths: child.files }
  if (checkpoint.repo !== record.repo || !same(checkpoint.parent, parentTuple) || !same(checkpoint.child, childTuple)) throw Error('selected child checkpoint action differs from prepared child tuple')
  const request = { parentRepo: source.parentRepo, parentIssue: source.parentIssue, approvalBinding: source.approvalBinding }
  const executionRequest: ConsolidatedExecutionRequest = { kind: 'consolidated', ...request, requested: { repo: record.repo, issue: child.issue, taskIds, actionId: local[0]!.id,
    branch: record.parentBranch, baseSha: record.baseSha, paths: [...child.files], operation: 'edit' } }
  const checkpointRequest: ChildCheckpointRequest = { ...request, requested: { repo: record.repo, issue: child.issue, taskIds, actionId: checkpoint.id,
    branch: child.branch, ref: `refs/heads/${child.branch}`, baseSha: record.baseSha, paths: [...child.files], operation: 'checkpoint' } }
  const execution = await approval.gatherConsolidatedApproval({ ...executionRequest, operators: current.policy.operators, readJson })
  const checkpointScope = await approval.gatherConsolidatedApproval({ ...checkpointRequest, operators: current.policy.operators, readJson })
  if (!execution.ok || execution.blocks.length || execution.action?.kind !== 'local' || !execution.action.operations.includes('edit')
    || !same(execution.taskIds, taskIds) || !same([...execution.files].sort(), [...child.files].sort())) throw Error('consolidated child execution authority refused')
  if (!checkpointScope.ok || checkpointScope.blocks.length || checkpointScope.action?.kind !== 'child-source-checkpoint'
    || !same(checkpointScope.taskIds, taskIds) || !same(checkpointScope.files, child.files)
    || !same(checkpointScope.bindings, execution.bindings) || !same(checkpointScope.approvalBindings, execution.approvalBindings)
    || !same(checkpointScope.recordBinding ?? null, execution.recordBinding ?? null)) throw Error('consolidated child checkpoint authority refused')
  return { executionRequest, checkpointRequest, policy: current.policy, reads, checked: execution, taskIds }
}

async function prepareChild(child: ChildLaunch, record: ChildrenRecord, parent: RunRecord, config: FactoryConfig, gh:typeof ghText=ghText): Promise<PreparedChild> {
  const policy=await currentPolicy(config,record.repo),stage = stagePolicy(policy.policy, 'implement')
  if (stage.harness !== parent.harness || stage.model !== parent.model || stage.effort !== parent.effort) throw Error('child must retain the selected parent subscription setup')
  const localPath = join(runsRoot(config.home), parent.runId, 'child-' + child.issue + '.lock')
  const acquired = await acquireClaim(localPath, await processIdentity())
  if (acquired.kind !== 'owned') throw Error('child local preparation is owned or unavailable')
  try {
    if (!child.runId) {
      const prepared = createChildWorktree({ repoRoot: parent.checkout, issue: child.issue, slug: child.title, type: child.type, baseSha: record.baseSha,
        devMd: git(parent.checkout, ['show', record.baseSha + ':.vegastack/dev.md']), home: config.home, write: true })
      if (prepared.blocks.length) throw Error(prepared.blocks.join('; '))
      if (await realpath(prepared.path) !== child.path || prepared.branch !== child.branch) throw Error('prepared child checkout differs')
    }
    clean(child.path)
    if (git(child.path, ['rev-parse', 'HEAD']) !== record.baseSha || git(child.path, ['symbolic-ref', '--short', 'HEAD']) !== child.branch) throw Error('prepared child base/branch differs')
    const admission = await deriveConsolidatedChildRequests(parent, child, record, config,{gh})
    const plan = buildLaunchPlan({ harness: stage.harness, model: stage.model, effort: stage.effort, stage: 'implement', worktree: child.path,
      issue: { number: child.issue, title: child.title }, operator: admission.policy.operators[0] ?? 'the operator',
      outcome: 'Complete the approved child scope. Only these paths are owned: ' + child.files.join(', ') + '. Commit the result and leave integration to the parent CLI.',
      stopList: [], resume: false, skillPath: null, subagents: config.subagents })
    const metadata = await inspectManagedHarness(plan), managed = validateManagedLaunch(plan, metadata)
    if (!managed.ok) throw Error('prepared child managed configuration refused: ' + managed.problems.join('; '))
    const guard = await shipGuardWired(child.path, stage.harness, { home: config.home, repo: record.repo, policyDigest: admission.policy.effective?.policyDigest })
    if (!guard.wired) throw Error('prepared child hooks refused: ' + guard.detail)
    if (guard.policyDigest) plan.guardPolicyDigest = guard.policyDigest
    const coordinator=(await currentParentContext(parent,record,config,gh)).binding
    if(child.runId){if(!child.parentBinding)throw Error('existing child launch provenance unavailable')}
    else child.parentBinding=coordinator
    const run = child.runId ? await readRun(runsRoot(config.home), child.runId) : await prepareDispatchRun({
      run: planned(record.repo, child), plan, config, policy: admission.policy, approvalBindings: admission.checked.approvalBindings,
      bindings: admission.checked.bindings, recordBinding: admission.checked.recordBinding, authorityReads: admission.reads,
      gh: ghText, metadata, claim: acquired.claim, parent: { run: parent, binding: child.parentBinding!, childIssue: child.issue },
      authorityRequest: admission.executionRequest, checkpointRequest: admission.checkpointRequest,
    })
    if (run.parent !== parent.issue || run.branch !== child.branch || run.baseSha !== record.baseSha || run.checkout !== child.path
      || run.execution?.accountRef !== parent.execution?.accountRef) throw Error('prepared child execution identity differs')
    await verifyDispatchRunAuthority(run, config, 'launch',{gh})
    plan.approvedRunInput = { ...run, root: runsRoot(config.home) }
    return { run, plan, localClaim: acquired.claim }
  } catch (error) { await releaseClaim(acquired.claim); throw error }
}
async function acquireChild(child: ChildLaunch, record: ChildrenRecord, prepared: PreparedChild, config: FactoryConfig, gh:typeof ghText=ghText): Promise<SharedClaim> {
  const parent = await readRun(runsRoot(config.home), record.parentRunId)
  const admission = await deriveConsolidatedChildRequests(parent, child, record, config,{gh}), adapters = sharedRunAdapters(config,undefined,gh)
  if (!same(prepared.run.authorityRequest, admission.executionRequest) || !same(prepared.run.checkpointIntent?.approvalRequest, admission.checkpointRequest)) throw Error('prepared child authority requests changed before acquisition')
  if(prepared.run.sharedClaim){
    const claim=await sharedClaimForRun(prepared.run,config,gh),snapshot=await readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
    if(task?.schemaVersion!==2||!child.parentBinding||!same(task.parentBinding,child.parentBinding))throw Error('existing child is not a verified recovery-queued successor')
    await verifyDispatchRunAuthority(prepared.run,config,'launch',{gh})
    if(task.state==='running'){
      const provenance=prepared.run.remoteRecovery,owner=await import('./shared-claims.ts'),operationId=prepared.run.attemptOperationIds?.start
      const requestId=stableGroupRequestId(task.successionOperationId,task.taskKey),continuations=prepared.run.continuations?.filter(row=>row.requestId===requestId)??[]
      const receiving=provenance?.kind==='receiving-group'&&provenance.role==='child'&&provenance.parentTaskKey===task.parentTaskKey&&provenance.succession.operationId===task.successionOperationId
      const sameHome=!provenance&&continuations.length===1&&continuations[0]!.attemptId===prepared.run.attemptId&&prepared.run.sharedClaim?.taskKey===task.taskKey&&prepared.run.sharedClaim.generation===task.generation&&prepared.run.sharedClaim.ownerToken===task.ownerToken
      if((!receiving&&!sameHome)||!operationId)throw Error('running recovered child lacks exact group provenance')
      const raw=await claim.target.provider.read(claim.target,snapshot.head,owner.operationPath(operationId))
      if(!raw)throw Error('running recovered child start receipt unavailable')
      const receipt=owner.parseOperationReceiptBytes(raw)
      if(receipt.operationId!==operationId||receipt.type!=='start'||receipt.taskKey!==task.taskKey||receipt.generation!==task.generation||receipt.requestDigest!==owner.sha256(owner.canonical({kind:'start'}))||!same(receipt.resultOwner,{ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId,runId:task.runId}))throw Error('running recovered child start receipt differs')
      return claim
    }
    if(task.state!=='recovery-queued')throw Error('existing child is not a verified recovery-queued successor')
    const started=await transitionSharedTask({claim,operationId:prepared.run.attemptOperationIds!.start,transition:{kind:'start'}})
    if(started.kind!=='owned')throw Error('recovery-queued child start not acknowledged: '+started.reason)
    return started.claim
  }
  const entry = config.repos.find(row => row.repo === record.repo)!
  const request = await adapters.sharedAdmission!({ run: planned(record.repo, child), entry, policy: admission.policy,
    approvalBindings: admission.checked.approvalBindings, bindings: admission.checked.bindings, recordBinding: admission.checked.recordBinding })
  const result = await acquireSharedTask(request)
  if (result.kind !== 'owned') {
    if (['parent child capacity busy','machine child capacity busy'].includes(result.reason)) {
      const snapshot = await readCoordination(request.session.target)
      const occupied = snapshot.index.active.filter(row => row.parentTaskKey === record.parentBinding.taskKey || result.reason === 'machine child capacity busy' && row.machineId === request.machine.id && row.parentTaskKey !== null)
      if (occupied.length && occupied.every(row => ['claimed','running'].includes(snapshot.tasks[row.taskKey]?.state ?? '') && !snapshot.tasks[row.taskKey]?.stopProof)) throw new ChildCapacityWait(result.reason)
    }
    throw Error(result.kind + ': ' + result.reason)
  }
  const claim = result.claim
  await verifyDispatchRunAuthority(prepared.run, config, 'launch',{gh})
  await adapters.persistSharedRun!(claim, planned(record.repo, child), prepared.plan)
  const current = await readRun(runsRoot(config.home), prepared.run.runId)
  const snapshot = await readCoordination(claim.target), task = snapshot.tasks[claim.taskKey]
  if (task?.state !== 'claimed') throw Error('child already started; reconcile original execution instead of replaying')
  const started = await transitionSharedTask({ claim, operationId: current.attemptOperationIds!.start, transition: { kind: 'start' } })
  if (started.kind !== 'owned') throw Error('child start not acknowledged: ' + started.reason)
  return started.claim
}
async function finishChild(claim: SharedClaim | null, run: RunRecord, config: FactoryConfig, gh:typeof ghText=ghText): Promise<void> {
  if (!claim) throw Error('shared child owner unavailable')
  const adapters = sharedRunAdapters(config,undefined,gh), transition = await adapters.finishSharedRun!(claim, {
    runId: run.runId, terminationCause: run.terminationCause ?? 'failed', exitCode: run.exitCode, timedOut: false, logFile: '', pushed: false, handedBack: false,
  })
  const result = await transitionSharedTask({ claim, operationId: transition.kind === 'stop' ? (await readRun(runsRoot(config.home), run.runId)).stopReceiptIds!.transition : randomUUID(), transition })
  if (result.kind !== 'owned' || transition.kind === 'block') throw Error('child reservation retained pending verified termination/effect recovery')
}
export async function sourceCheck(run: RunRecord, command: string, config: FactoryConfig, signal?: AbortSignal, processDeps?: Partial<ExecuteDeps>, label = 'child'): Promise<ChildCheck> {
  if (!run.headSha || !sha.test(run.headSha)) throw Error('acceptance source unavailable')
  clean(run.checkout)
  if (git(run.checkout, ['rev-parse', 'HEAD']) !== run.headSha) throw Error('acceptance source changed')
  const root = runsRoot(config.home)
  const previous = await readOptional<ChildCheck>(join(root, run.runId, label + '-acceptance.json'))
  if (previous?.ok && previous.headSha === run.headSha && previous.command === command && previous.scopeDigest === run.taskKey.scopeDigest) {
    await verifyExecutedCheck(run, previous, config, label); return previous
  }
  const checkRunId = randomUUID(), startedAt = new Date().toISOString()
  const validationId = run.taskKey.taskId + '/check/' + hash(canonical({ command, headSha: run.headSha, checkRunId }))
  // Save intent before starting the check; the check uses the same owned wrapper
  // and cancellation protocol as a harness, with no subscription or remote effects.
  await atomicRunFile(join(root, run.runId, label + '-check-intent.json'), { schemaVersion: 1, checkRunId, runId: run.runId, headSha: run.headSha, command, validationId })
  const { executeRun } = await import('./dispatch.ts')
  const outcome = await executeRun({ repo: run.repo, issue: run.issue, title: 'child acceptance', stage: 'implement', commentId: null, reactionId: null },
    { command: 'sh', args: ['-c', command], cwd: run.checkout, env: {}, prompt: '' }, config, { operator: null, signal }, {
      ...processDeps, preparedRun: undefined,
      runInput: { root, runId: checkRunId, repo: run.repo, issue: run.issue, parent: run.issue, checkout: run.checkout, branch: run.branch, baseSha: run.headSha, headSha: run.headSha,
        stage: 'acceptance', harness: 'sh', model: 'none', effort: 'none', execution: null, approvalBindings: [], recordBinding: null, approvalRefs: [], policyDigest: '', claimToken: randomUUID(),
        startedAt, taskKey: { repo: run.repo, issue: run.issue, taskId: 'acceptance', scopeDigest: run.taskKey.scopeDigest }, activeElapsedMs: null, taskOwner: null, agentAccountOwner: null,
        accountRef: null, waitReason: null, machine: null, sharedClaim: null, checkpoint: null, remoteEffectCoverage: { kind: 'unmanaged-possible', reasonCode: 'local-source-check' } },
    })
  const actual = await readRun(root, checkRunId)
  const check: ChildCheck = { schemaVersion: 1, runId: run.runId, baseSha: run.baseSha, headSha: run.headSha, scopeDigest: run.taskKey.scopeDigest,
    command, validationId, checkRunId, startedAt, finishedAt: new Date().toISOString(), ok: outcome.terminationCause === 'succeeded' && actual.state === 'terminal' && actual.headSha === run.headSha && !signal?.aborted, exitCode: outcome.exitCode }
  try { clean(run.checkout); if (git(run.checkout, ['rev-parse', 'HEAD']) !== run.headSha) check.ok = false } catch { check.ok = false }
  await atomicRunFile(join(root, run.runId, label + '-acceptance.json'), check)
  return check
}
async function verifiedResult(run: RunRecord, child: ChildLaunch, config: FactoryConfig): Promise<ChildResult> {
  if(run.parent!==null&&run.authorityRequest?.kind==='consolidated'&&(!run.checkpoint||run.checkpoint.headSha!==run.headSha||run.checkpoint.branch!==run.branch||run.checkpoint.baseSha!==run.checkpointIntent?.baseSha))throw Error('exact child checkpoint result unavailable')
  const check = await readOptional<ChildCheck>(checkPath(runsRoot(config.home), run.runId))
  if (check) await verifyExecutedCheck(run, check, config)
  const result: ChildResult = { schemaVersion: 1, runId: run.runId, repo: run.repo, issue: run.issue, baseSha: run.baseSha, headSha: run.headSha ?? '', branch: run.branch,
    scopeDigest: run.taskKey.scopeDigest, terminationCause: 'succeeded', acceptance: { ok: true, command: child.acceptanceCommand, sha: run.headSha ?? '' }, noChange: run.headSha === run.baseSha,
    machine: run.machine, sharedGeneration: run.sharedClaim?.generation ?? null, checkpoint: run.checkpoint }
  const valid = validateChildResult(result, { issue: child.issue, scopeDigest: child.scopeDigest!, run, acceptance: check })
  if (!valid.ok) throw Error(valid.reason)
  clean(child.path)
  if (git(child.path, ['rev-parse', 'HEAD']) !== result.headSha || git(child.path, ['symbolic-ref', '--short', 'HEAD']) !== child.branch) throw Error('child source moved after execution')
  git(child.path, ['merge-base', '--is-ancestor', result.baseSha, result.headSha])
  const commits = git(child.path, ['rev-list', result.baseSha + '..' + result.headSha]).split('\n').filter(Boolean)
  const changed = [...new Set(commits.flatMap(commit => git(child.path, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', '-z', commit]).split('\0').filter(Boolean)))]
  const outside = scopeViolations(changed, child.files)
  if (outside.length) throw Error('child escaped declared scope: ' + outside.join(', '))
  return result
}

export async function executeChildren(input: { parent: RunRecord; groups: unknown; config: FactoryConfig; write?: boolean; signal?: AbortSignal }, deps: ChildrenDependencies = {}): Promise<ChildrenOutcome> {
  const { parent, config } = input, root = runsRoot(config.home), groups = checkedGroups(input.groups)
  const currentGroups=deps.groups?await deps.groups(parent,config):await authoritativeGroups(parent,config,deps.gh)
  if (!same(currentGroups, groups)) throw Error('groups file differs from canonical approved parent plan')
  const parentClaim=deps.parentClaim?await deps.parentClaim(parent,config):await sharedClaimForRun(parent,config,deps.gh)
  const retainedAccepted=new Map<string,ChildAcceptance>()
  let record = await readOptional<ChildrenRecord>(recordPath(root, parent.runId))
  if (record) {
    record = parseChildrenRecord(record)
    if(record.schemaVersion===1)record=await readExecutableChildrenRecord(parent,config)
    if(!deps.parentClaim){
      const context=await currentParentContext(parent,record,config,deps.gh)
      if(context.succession&&context.task.recovery){
        const settled=new Set<string>(),started=new Set<string>()
        for(const child of record.children){
          if(child.recoveryDisposition&&child.recoveryDisposition!=='retained')continue
          if(!child.runId)continue
          const run=await readRun(root,child.runId),saved=await readOptional<ChildResult>(resultPath(root,child.runId))
          if(run.state==='terminal'&&run.terminationCause==='succeeded'&&saved?.runId===run.runId&&saved.repo===run.repo&&saved.issue===run.issue&&saved.headSha===run.headSha&&saved.scopeDigest===run.taskKey.scopeDigest)settled.add(child.runId)
          if(run.state==='prepared'||run.state==='running')started.add(child.runId)
        }
        const classified=reconcileProgressedChildrenState(context.succession,context.task.recovery,settled,started)
        for(const joined of classified.accepted){
          const accepted=context.task.recovery.children.find(row=>row.childRunId===joined.childRunId)
          if(!accepted)throw Error('retained accepted child result unavailable')
          retainedAccepted.set(accepted.childRunId,accepted)
        }
      }
    }
    if (!same(record.groups, groups) || record.parentBranch !== parent.branch || record.repo !== parent.repo) throw Error('saved original parent launch differs')
  } else {
    clean(parent.checkout)
    const baseSha = git(parent.checkout, ['rev-parse', 'HEAD'])
    if (baseSha !== parent.headSha) throw Error('parent source changed before child preparation')
    const issues: Record<number, { number: number; title: string; type: string }> = {}
    for (const group of groups) {
      const number = Number(group.members[0]!.slice(1)), issue = await (deps.issue ?? issueDetails)(parent.repo, number)
      if (issue.number !== number) throw Error('child issue identity differs')
      const type = /^([a-z]+):/.exec(issue.title)?.[1] ?? 'feat'
      issues[number] = { number, title: issue.title.replace(/^[a-z]+:\s*/, ''), type }
    }
    const plan = planParallelRun({ groups, issues, parentBranch: parent.branch, parentHead: baseSha, repoRoot: parent.checkout, parentIssue: parent.issue })
    const devMd = git(parent.checkout, ['show', baseSha + ':.vegastack/dev.md'])
    const command = /^commands:.*?\bcheck\s+`([^`]+)`/m.exec(devMd)?.[1]
    if (!command) throw Error('approved base lacks an explicit check command')
    record = { schemaVersion: 2, parentRunId: parent.runId, parentIssue: parent.issue, repo: parent.repo, parentBranch: parent.branch, baseSha,
      parentBinding: parentClaimBinding(parentClaim), concurrency: Math.min(3, config.subagents.concurrent, groups.length), groups,
      children: plan.children.map(child => ({ ...child, resources: [], runId: null, scopeDigest: null, taskIds: [], acceptanceCommand: command, parentBinding:null })) }
  }
  const result: ChildrenOutcome = { results: [], blocked: [], plan: record, wrote: false }
  if (!input.write) return result
  const acquired = await acquireClaim(join(root, parent.runId, 'children.lock'), await processIdentity())
  if (acquired.kind !== 'owned') throw Error('another child gateway owns this parent')
  const stop = new AbortController(), onAbort = () => stop.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted) stop.abort()
  let metadata = Promise.resolve()
  const controlled = <T>(work: () => Promise<T>): Promise<T> => {
    const result = metadata.then(work)
    metadata = result.then(() => {}, () => {})
    return result
  }
  let monitorBusy = false, parentFailure: string | null = null
  const verify = () => controlled(() => deps.verifyParent ? deps.verifyParent(record!, config) : verifyParent(record!, config, true,deps.gh)).catch(error=>{throw Error('current parent verification: '+(error as Error).message)})
  const monitor = setInterval(() => {
    if (monitorBusy) return
    monitorBusy = true
    void verify().catch(error => { parentFailure = (error as Error).message; stop.abort() }).finally(() => { monitorBusy = false })
  }, 1000)
  let writes = Promise.resolve()
  const save = () => { writes = writes.then(() => atomicRunFile(recordPath(root, parent.runId), record)); return writes }
  try {
    await verify(); await save(); result.wrote = true
    let next = 0
    const worker = async () => {
      while (!stop.signal.aborted) {
        const child = record!.children[next++]
        if (!child) return
        let prepared: PreparedChild | null = null, shared: SharedClaim | null = null
        try {
          await verify()
          if(child.recoveryDisposition&&child.recoveryDisposition!=='retained')continue
          const retained=child.runId?retainedAccepted.get(child.runId):undefined
          if(retained){
            const run=await readRun(root,retained.childRunId)
            if(!child.scopeDigest||run.runId!==retained.childRunId||run.repo!==record!.repo||run.issue!==child.issue||run.branch!==child.branch||run.baseSha!==retained.baseSha||run.headSha!==retained.headSha||run.taskKey.scopeDigest!==retained.scopeDigest||!same(run.checkpoint,retained.checkpoint)||!run.machine)throw Error('retained accepted child runtime differs')
            const acceptedResult:ChildResult={schemaVersion:1,runId:run.runId,repo:run.repo,issue:run.issue,baseSha:retained.baseSha,headSha:retained.headSha,branch:run.branch,scopeDigest:retained.scopeDigest,terminationCause:'succeeded',acceptance:{ok:true,command:child.acceptanceCommand,sha:retained.headSha},noChange:retained.noChange,machine:run.machine,sharedGeneration:retained.generation,checkpoint:retained.checkpoint}
            const saved=await readOptional<ChildResult>(resultPath(root,run.runId));if(saved&&!same(saved,acceptedResult))throw Error('retained accepted child result differs');if(!saved)await atomicRunFile(resultPath(root,run.runId),acceptedResult);result.results.push(acceptedResult);continue
          }
          if (child.runId) {
            const run = await readRun(root, child.runId)
            if (run.state === 'terminal') {
              if (run.terminationCause !== 'succeeded') throw Error('terminal child failed; execution will not be replayed')
              if(deps.verifyChild)await deps.verifyChild(run,config);else await verifyDispatchRunAuthority(run,config,'effect',{gh:deps.gh})
              if(run.parent!==null&&run.authorityRequest?.kind==='consolidated'&&(!run.checkpoint||run.checkpoint.headSha!==run.headSha))await controlled(async()=>{await (await import('./checkpoints.ts')).flushRunCheckpoint(run,config)})
              const checkpointed=await readRun(root,run.runId)
              const saved = await readOptional<ChildResult>(resultPath(root, run.runId))
              if (!saved) await sourceCheck(checkpointed, child.acceptanceCommand, config, stop.signal, deps.processDeps)
              const verified = await verifiedResult(checkpointed, child, config)
              if (saved && !same(saved, verified)) throw Error('saved terminal result differs')
              if (!saved) await atomicRunFile(resultPath(root, run.runId), verified)
              result.results.push(verified); continue
            }
            if (run.state !== 'prepared' || run.processIdentity || existsSync(join(root, run.runId, 'events.jsonl'))) throw Error('child execution already exists; verified recovery required')
          } else {
            const prior = (await readRuns(root)).filter(run => run.parent === parent.issue && run.repo === parent.repo && run.branch === child.branch && run.stage === 'implement')
            if (prior.length) throw Error('unlinked original child execution requires reconciliation; duplicate refused')
          }
          const preparingNew=!child.runId
          if(!preparingNew){if(!child.parentBinding)throw Error('existing child launch provenance unavailable')}
          else child.parentBinding=parentClaimBinding(parentClaim)
          prepared = await controlled(() => deps.prepare?deps.prepare(child,record!,parent,config):prepareChild(child,record!,parent,config,deps.gh))
          if(preparingNew&&!same(child.parentBinding,parentClaimBinding(parentClaim)))throw Error('parent changed during child preparation')
          child.runId = prepared.run.runId; child.scopeDigest = prepared.run.taskKey.scopeDigest; child.taskIds = prepared.run.approvedTaskIds ?? [prepared.run.taskKey.taskId]
          await save() // original parent binding + child run identity precede any shared acquisition
          for (;;) {
            if (stop.signal.aborted) throw Error('parent cancelled before child admission')
            try { shared = await controlled(() => deps.acquire?deps.acquire(child,record!,prepared!,config):acquireChild(child,record!,prepared!,config,deps.gh)); break }
            catch (error) {
              if (!(error instanceof ChildCapacityWait)) throw error
              if (result.blocked.length) throw Error('child capacity retained by affected work; recovery required')
              await verify(); await waitForChildSlot(stop.signal)
            }
          }
          await verify()
          const run = await readRun(root, child.runId)
          try{await executeApprovedRun(planned(parent.repo,child),prepared.plan,config,{operator:null,signal:stop.signal,...(shared?{sharedClaim:shared}:{})},
            {...deps.processDeps,gh:deps.gh,checkpoint:'deferred',preparedRun:run,runInput:{...run,root}})}catch(error){throw Error('recovered child process: '+(error as Error).message)}
          let terminal = await readRun(root, child.runId)
          if (terminal.terminationCause !== 'succeeded' || terminal.state !== 'terminal') throw Error('child execution ended: ' + terminal.terminationCause)
          await verify();try{if(deps.verifyChild)await deps.verifyChild(terminal,config);else await verifyDispatchRunAuthority(terminal,config,'effect',{gh:deps.gh})}catch(error){throw Error('recovered child authority: '+(error as Error).message)}
          if(terminal.parent!==null&&terminal.authorityRequest?.kind==='consolidated'){
            if(!terminal.checkpoint||terminal.checkpoint.headSha!==terminal.headSha)try{await controlled(async()=>{await(await import('./checkpoints.ts')).flushRunCheckpoint(terminal,config)})}catch(error){throw Error('recovered child checkpoint: '+(error as Error).message)}
            terminal=await readRun(root,child.runId)
            if(!terminal.checkpoint||terminal.checkpoint.headSha!==terminal.headSha||terminal.checkpoint.branch!==terminal.branch)throw Error('child checkpoint readback unavailable')
          }
          let check:ChildCheck;try{check=await sourceCheck(terminal,child.acceptanceCommand,config,stop.signal,deps.processDeps)}catch(error){throw Error('recovered child source check: '+(error as Error).message)}
          if (!check.ok) throw Error('child acceptance failed: '+(stop.signal.aborted?(parentFailure??'parent cancelled'):'exit '+String(check.exitCode)))
          terminal = await readRun(root, child.runId)
          let verified:ChildResult;try{verified=await verifiedResult(terminal,child,config)}catch(error){throw Error('recovered child result verification: '+(error as Error).message)}
          await atomicRunFile(resultPath(root, child.runId), verified)
          result.results.push(verified)
        } catch (error) { result.blocked.push({ issue: child.issue, reason: (error as Error).message }) }
        finally {
          if (prepared) {
            try { await controlled(async () => deps.finish?deps.finish(shared,await readRun(root,prepared!.run.runId),config):finishChild(shared,await readRun(root,prepared!.run.runId),config,deps.gh)) }
            catch (error) { result.blocked.push({ issue: child.issue, reason: 'child finalization: '+(error as Error).message }) }
            if (prepared.localClaim) await releaseClaim(prepared.localClaim)
          }
        }
      }
    }
    await Promise.all(Array.from({ length: record.concurrency }, worker))
    await writes
    if (stop.signal.aborted) for (const child of record.children) if (!result.results.some(row => row.issue === child.issue) && !result.blocked.some(row => row.issue === child.issue)) result.blocked.push({ issue: child.issue, reason: parentFailure ?? 'parent cancelled' })
    result.results.sort((a, b) => record!.children.findIndex(child => child.issue === a.issue) - record!.children.findIndex(child => child.issue === b.issue))
    return result
  } finally { clearInterval(monitor); input.signal?.removeEventListener('abort', onAbort); await metadata; await releaseClaim(acquired.claim) }
}

async function verifyExecutedCheck(run: RunRecord, check: ChildCheck, config: FactoryConfig, label = 'child'): Promise<void> {
  const root = runsRoot(config.home)
  const intent = await readOptional<{ runId: string; checkRunId: string; command: string; validationId: string; headSha: string }>(join(root, run.runId, label + '-check-intent.json'))
  if (!closed(check, ['schemaVersion','runId','baseSha','headSha','scopeDigest','command','ok','exitCode','validationId','checkRunId','startedAt','finishedAt']) || check.schemaVersion !== 1 || !uuid.test(check.checkRunId)) throw Error('invalid source-check record')
  if (!intent || intent.checkRunId !== check.checkRunId || intent.runId !== run.runId || intent.command !== check.command || intent.validationId !== check.validationId || intent.headSha !== check.headSha) throw Error('acceptance execution intent differs')
  const executed = await readRun(root, check.checkRunId)
  if (executed.parent !== run.issue || executed.repo !== run.repo || executed.issue !== run.issue || executed.stage !== 'acceptance' || executed.state !== 'terminal'
    || executed.terminationCause !== 'succeeded' || executed.exitCode !== 0 || !executed.processIdentity || executed.baseSha !== check.headSha || executed.headSha !== check.headSha || !check.ok) throw Error('acceptance process did not verify this source')
}
async function verifyIntegrationAuthority(parent: RunRecord, record: ChildrenRecord, config: FactoryConfig,gh:typeof ghText=ghText): Promise<void> {
  if (parent.authorityRequest?.kind !== 'consolidated') throw Error('explicit canonical integration action required; ordinary implementation approval is insufficient')
  await verifyRunAuthority({ ...parent, authorityRequest: { ...parent.authorityRequest, requested: { ...parent.authorityRequest.requested,
    operation: 'integrate', paths: [...new Set(record.children.flatMap(child => child.files))] } } }, config,'effect',{gh})
}

// #137 invokes this producer verifier before publishing or consuming immutable
// acceptance/join receipts. It checks the actual local source-check execution;
// the wire payload cannot assert that a check ran by itself.
export async function verifyChildrenEvidence(input: { run: RunRecord; task?: TaskRecord; payload: RecoveryEvidencePayload; publishing: boolean; ref?: import('./shared-claims.ts').EvidenceRef | null }, config: FactoryConfig,gh:typeof ghText=ghText): Promise<void> {
  const { payload, run } = input, root = runsRoot(config.home)
  if (payload.kind === 'acceptance') {
    const subject = payload.runId === run.runId ? run : await readRun(root, payload.runId)
    if (subject.repo !== run.repo || subject.parent !== run.issue && subject.runId !== run.runId) throw Error('foreign child acceptance')
    await verifyDispatchRunAuthority(subject, config,'effect',{gh})
    if (subject.runId !== run.runId) {
      const launch = await readExecutableChildrenRecord(run,config)
      validateRecordedSource(run, launch)
      const child = launch.children.find(row => row.runId === subject.runId)
      if (!child || child.issue !== subject.issue || child.scopeDigest !== subject.taskKey.scopeDigest || child.baseSha !== subject.baseSha || child.branch !== subject.branch) throw Error('acceptance is outside selected parent group')
    }
    if (!input.publishing && input.ref && input.task?.recovery) {
      const accepted = [...input.task.recovery.children.map(row => row.acceptance), ...input.task.recovery.joins.flatMap(row => row.acceptance ? [row.acceptance] : [])]
        .find(row => same(row.evidence, input.ref))
      if (accepted && payload.acceptedScope === null && payload.result === 'passed' && accepted.sourceSha === payload.sourceSha
        && accepted.validationId === payload.validationId && accepted.commandDigest === payload.commandDigest && payload.scopeDigest === subject.taskKey.scopeDigest) return
    }
    if(!input.publishing&&input.ref&&input.task?.acceptedScopes.some(row=>same(row.receipt,input.ref)&&row.scopeDigest===payload.scopeDigest)&&payload.acceptedScope){
      const retained=parseAcceptedScope(payload.acceptedScope)
      if(payload.result!=='passed'||payload.runId!==subject.runId||payload.sourceSha!==subject.headSha||payload.scopeDigest!==subject.taskKey.scopeDigest||retained.repo!==subject.repo||retained.issue!==subject.issue||!same(retained.artifacts,subject.approvalRefs)||!same(retained.approvalBindings,subject.approvalBindings)||!same([...retained.approvedTaskIds].sort(),[...(subject.approvedTaskIds??[])].sort())||!same([...retained.completedTaskIds].sort(),[...retained.approvedTaskIds].sort()))throw Error('retained accepted scope identity differs')
      return
    }
    let label = 'child'
    if (subject.parent === null) {
      const record = await readExecutableChildrenRecord(subject,config)
      const matches = []
      for (const child of record.children) {
        if (!child.runId) continue
        const joined = await readOptional<IntegrationRecord>(joinPath(root, subject.runId, child.runId))
        if (joined?.parentAfter === payload.sourceSha) {
          const check = await readOptional<ChildCheck>(join(root, subject.runId, 'join-' + child.runId + '-acceptance.json'))
          if (check?.validationId === payload.validationId) matches.push(child.runId)
        }
      }
      if (matches.length !== 1) throw Error('ambiguous parent acceptance source')
      label = 'join-' + matches[0]!
    }
    const check = await readOptional<ChildCheck>(join(root, subject.runId, label + '-acceptance.json'))
    if (!check || payload.sourceSha !== check.headSha || payload.scopeDigest !== subject.taskKey.scopeDigest || payload.validationId !== check.validationId
      || payload.commandDigest !== hash(check.command) || payload.result !== 'passed') throw Error('receipt differs from executed source acceptance')
    if(payload.acceptedScope) await verifyAcceptedScopePayload(subject,payload,config,gh)
    await verifyExecutedCheck(subject, check, config, label)
    return
  }
  if (payload.kind !== 'join') throw Error('unsupported child evidence kind')
  const record = await readExecutableChildrenRecord(run,config), child = record.children.find(row => row.runId === payload.childRunId)
  if (!child) throw Error('join is outside the original parent group')
  await verifyIntegrationAuthority(run, record, config,gh)
  if (!input.publishing && input.ref && input.task?.recovery) {
    const known = input.task.recovery.joins.find(row => same(row.evidence, input.ref))
    if (known && known.childRunId === payload.childRunId && known.generation === payload.generation && known.fromSha === payload.fromSha
      && known.parentBefore === payload.parentBefore && known.parentAfter === payload.parentAfter && known.state === payload.state) {
      if (known.state === 'accepted') {
        if (!known.acceptance || known.acceptance.sourceSha !== known.parentAfter || known.acceptance.validationId !== payload.validationId
          || known.acceptance.commandDigest !== payload.commandDigest || payload.result !== 'passed' || same(known.acceptance.evidence, known.evidence)) throw Error('retained join acceptance identity differs')
        if (!run.checkpoint || !known.parentAfter) throw Error('accepted parent checkpoint unavailable')
        git(run.checkout, ['merge-base','--is-ancestor',known.parentAfter,run.checkpoint.headSha])
      }
      return
    }
  }
  const joined = await readOptional<IntegrationRecord>(joinPath(root, run.runId, payload.childRunId))
  if (!joined || payload.generation !== joined.generation || payload.fromSha !== joined.fromSha || payload.parentBefore !== joined.parentBefore
    || payload.state === 'prepared' && payload.parentAfter !== null || payload.state === 'accepted' && (payload.parentAfter !== joined.parentAfter || !joined.accepted)) throw Error('join receipt differs from integration intent')
  if (payload.state === 'accepted') {
    const check = await readOptional<ChildCheck>(join(root, run.runId, 'join-' + child.runId + '-acceptance.json'))
    if (!check || payload.validationId !== check.validationId || payload.commandDigest !== hash(check.command) || payload.result !== 'passed') throw Error('join acceptance differs')
    await verifyExecutedCheck(run, check, config, 'join-' + child.runId)
    // Completed cross-host integration requires the exact parent source backup.
    if (!run.checkpoint || run.checkpoint.headSha !== joined.parentAfter) throw Error('accepted parent checkpoint unavailable')
  }
}
async function acceptanceReceipt(claim: SharedClaim, run: RunRecord, check: ChildCheck, operationId: string): Promise<{ claim: SharedClaim; acceptance: AcceptanceRef }> {
  const payload: RecoveryEvidencePayload = { schemaVersion: 2, kind: 'acceptance', taskId: run.taskKey.taskId, runId: run.runId, sourceSha: check.headSha,
    scopeDigest: run.taskKey.scopeDigest, validationId: check.validationId, commandDigest: hash(check.command), result: 'passed', acceptedScope: null }
  const saved = await publishRecoveryReceipt({ claim, operationId, payload })
  return { claim: saved.claim, acceptance: { sourceSha: check.headSha, validationId: check.validationId, commandDigest: hash(check.command), evidence: saved.reference } }
}
export async function linkChildAcceptance(parentClaim: SharedClaim, childRun: RunRecord, check: ChildCheck, config: FactoryConfig): Promise<SharedClaim> {
  if (!childRun.checkpoint || childRun.checkpoint.headSha !== childRun.headSha || !childRun.machine || !childRun.sharedClaim) throw Error('child immutable checkpoint/owner unavailable for remote acceptance')
  const root = runsRoot(config.home), path = join(root, childRun.runId, 'child-receipt-ids.json')
  let ids = await readOptional<{ acceptance: string; link: string }>(path)
  if (!ids) { ids = { acceptance: randomUUID(), link: randomUUID() }; await atomicRunFile(path, ids) }
  const published = await acceptanceReceipt(parentClaim, childRun, check, ids.acceptance)
  const snapshot = await readCoordination(published.claim.target), task = snapshot.tasks[published.claim.taskKey]
  if (!task?.recovery) throw Error('parent recovery envelope unavailable')
  const accepted: ChildAcceptance = { childTaskKey: childRun.sharedClaim.taskKey, childRunId: childRun.runId, generation: childRun.sharedClaim.generation,
    baseSha: childRun.baseSha, headSha: childRun.headSha!, scopeDigest: childRun.taskKey.scopeDigest, machineId: childRun.machine.id,
    installationId: childRun.machine.installationId, sessionId: childRun.machine.sessionId, terminationCause: 'succeeded', noChange: childRun.baseSha === childRun.headSha,
    checkpoint: childRun.checkpoint, acceptance: published.acceptance }
  const prior = task.recovery.children.find(row => row.childRunId === childRun.runId)
  if (prior && !same(prior, accepted)) throw Error('existing child acceptance differs')
  if (prior) return published.claim
  const linked = await transitionSharedTask({ claim: published.claim, operationId: ids.link, transition: { kind: 'recovery', recovery: { ...task.recovery, children: [...task.recovery.children, accepted] } } })
  if (linked.kind !== 'owned') throw Error('child acceptance was not linked: '+linked.kind+': '+linked.reason)
  return linked.claim
}
export async function publishJoin(claim: SharedClaim, receipt: IntegrationRecord, check: ChildCheck | null, config: FactoryConfig): Promise<{ claim: SharedClaim; reference: JoinRef }> {
  const state = check ? 'accepted' as const : 'prepared' as const
  const payload: RecoveryEvidencePayload = { schemaVersion: 2, kind: 'join', childRunId: receipt.runId, generation: receipt.generation, fromSha: receipt.fromSha,
    parentBefore: receipt.parentBefore, parentAfter: check ? receipt.parentAfter : null, state, validationId: check?.validationId ?? null,
    commandDigest: check ? hash(check.command) : null, result: check ? 'passed' : null }
  // Distinct immutable operation IDs for prepared and accepted observations.
  const operationId = check ? receipt.receiptIds.accepted : receipt.operationId
  const published = await publishRecoveryReceipt({ claim, operationId, payload })
  const reference: JoinRef = { operationId: receipt.operationId, childRunId: receipt.runId, generation: receipt.generation, fromSha: receipt.fromSha,
    parentBefore: receipt.parentBefore, parentAfter: check ? receipt.parentAfter : null, state, acceptance: check ? { sourceSha: check.headSha, validationId: check.validationId, commandDigest: hash(check.command), evidence: published.reference } : null,
    evidence: published.reference }
  // A JoinRef acceptance must reference an acceptance payload, not the join payload.
  if (check) {
    const run = await readRun(runsRoot(config.home), claim.runId)
    const accepted = await acceptanceReceipt(published.claim, run, check, receipt.receiptIds.acceptance)
    reference.acceptance = accepted.acceptance; claim = accepted.claim
  } else claim = published.claim
  const snapshot = await readCoordination(claim.target), task = snapshot.tasks[claim.taskKey]
  if (!task?.recovery) throw Error('parent recovery envelope unavailable')
  const joins = task.recovery.joins.filter(row => row.operationId !== reference.operationId)
  const linked = await transitionSharedTask({ claim, operationId: check ? receipt.receiptIds.acceptedLink : receipt.receiptIds.preparedLink, transition: { kind: 'recovery', recovery: { ...task.recovery, joins: [...joins, reference] } } })
  if (linked.kind !== 'owned') throw Error('join receipt was not linked')
  return { claim: linked.claim, reference }
}
export interface JoinDependencies {
  verifyParent?: ChildrenDependencies['verifyParent']
  verifyAuthority?: (parent: RunRecord, record: ChildrenRecord, config: FactoryConfig) => Promise<void>
  parentClaim?: ChildrenDependencies['parentClaim']
  verifyChild?: ChildrenDependencies['verifyChild']
  persistChild?: typeof linkChildAcceptance
  persistJoin?: typeof publishJoin
  processDeps?: Partial<ExecuteDeps>
  gh?: typeof ghText
}
export async function joinChildren(input: { parent: RunRecord; groups: unknown; config: FactoryConfig; write?: boolean; signal?: AbortSignal }, deps: JoinDependencies = {}): Promise<{ receipts: IntegrationRecord[]; acceptedDeliveries:AcceptedDelivery[]; blocked: Array<{ issue: number; reason: string }>; wrote: boolean }> {
  const { parent, config } = input, root = runsRoot(config.home), record = await readExecutableChildrenRecord(parent,config)
  const verifyAuthority=(run:RunRecord)=>deps.verifyAuthority?deps.verifyAuthority(run,record,config):verifyIntegrationAuthority(run,record,config,deps.gh)
  const verifyCurrentParent=()=>deps.verifyParent?deps.verifyParent(record,config):verifyParent(record,config,false,deps.gh)
  if (!same(checkedGroups(input.groups), record.groups)) throw Error('join groups differ from original launch')
  await verifyAuthority(parent)
  await verifyCurrentParent()
  let claim=deps.parentClaim?await deps.parentClaim(parent,config):await sharedClaimForRun(parent,config,deps.gh)
  if(deps.parentClaim){if(!record.children.every(child=>!child.runId||child.parentBinding))throw Error('integration child provenance unavailable')}
  else await currentParentContext(parent,record,config,deps.gh)
  const lock = input.write ? await acquireClaim(join(root, parent.runId, 'children.lock'), await processIdentity()) : null
  if (lock && lock.kind !== 'owned') throw Error('child execution or another integration owns this parent')
  const output = { receipts: [] as IntegrationRecord[], acceptedDeliveries: [] as AcceptedDelivery[], blocked: [] as Array<{ issue: number; reason: string }>, wrote: false }
  try {
    for (const child of record.children) {
      try {
        if (input.signal?.aborted) throw Error('parent integration cancelled')
        if(child.recoveryDisposition==='no-shared-task')continue
        await verifyCurrentParent()
        const currentParentRun=await readRun(root,parent.runId)
        await verifyAuthority(currentParentRun)
        if(child.runId&&(currentParentRun.remoteRecovery||child.recoveryDisposition==='completed')){
          const retained=await readOptional<IntegrationRecord>(joinPath(root,parent.runId,child.runId))
          if(retained?.state==='accepted'){
            validateIntegrationRecord(retained)
            if(!retained.acceptedRef||retained.runId!==child.runId||retained.issue!==child.issue||retained.baseSha!==record.baseSha||!retained.parentAfter||retained.fromSha!==retained.acceptedRef.fromSha)throw Error('historical accepted join identity differs')
            const snapshot=await readCoordination(claim.target),task=snapshot.tasks[claim.taskKey],known=task?.recovery?.joins.find(join=>same(join,retained.acceptedRef))
            if(!task||!known||known.state!=='accepted'||!known.acceptance)throw Error('historical accepted join receipt unavailable')
            const payload:Extract<RecoveryEvidencePayload,{kind:'join'}>={schemaVersion:2,kind:'join',childRunId:known.childRunId,generation:known.generation,fromSha:known.fromSha,parentBefore:known.parentBefore,parentAfter:known.parentAfter,state:'accepted',validationId:known.acceptance.validationId,commandDigest:known.acceptance.commandDigest,result:'passed'}
            await verifyChildrenEvidence({run:currentParentRun,task,payload,publishing:false,ref:known.evidence},config,deps.gh)
            const head=git(parent.checkout,['rev-parse','HEAD']);git(parent.checkout,['merge-base','--is-ancestor',retained.parentAfter,head])
            output.receipts.push(retained);continue
          }
        }
        const resolved = await resolveJoinChild(child, parent, config, deps).catch(error => {
          output.blocked.push({ issue: child.issue, reason: (error as Error).message }); return null
        })
        if (!resolved) continue // unrelated declared groups can still produce partial success
        const { run, result, check } = resolved
        if (!child.runId) throw Error('resolved child identity unavailable')
        clean(parent.checkout)
        let receipt = await readOptional<IntegrationRecord>(joinPath(root, parent.runId, child.runId))
        const head = git(parent.checkout, ['rev-parse', 'HEAD'])
        if (receipt) {
          validateIntegrationRecord(receipt)
          if (receipt.runId !== child.runId || receipt.fromSha !== result.headSha || receipt.baseSha !== record.baseSha || receipt.generation !== (run.sharedClaim?.generation ?? run.generation)) throw Error('saved join identity differs')
          if (receipt.state === 'accepted') {
            if (!receipt.parentAfter || !receipt.accepted) throw Error('incomplete accepted join receipt')
            git(parent.checkout, ['merge-base', '--is-ancestor', receipt.parentAfter, head])
            // This join was accepted under the retained predecessor evidence.
            // Recovery consumes it; it does not replay review or create a newer
            // accepted-scope publication from historical success.
            output.receipts.push(receipt);continue
          }
          if (receipt.state === 'refused') throw Error('prior integration requires conflict/check recovery: ' + receipt.reason)
          if (head !== receipt.parentBefore) {
            // Only these exact Git facts can reconcile a death after merge but
            // before the applied receipt was saved. A later unrelated head refuses.
            const parents = git(parent.checkout, ['show', '-s', '--format=%P', head]).split(' ')
            if (head !== receipt.fromSha && !same(parents, [receipt.parentBefore, receipt.fromSha])) throw Error('prepared join cannot be reconciled with current Git head')
            git(parent.checkout, ['merge-base', '--is-ancestor', receipt.parentBefore, head])
            receipt.parentAfter = head; receipt.state = 'applied'
          }
        } else {
          const previous = output.receipts.at(-1)
          const expectedHead = previous?.parentAfter ?? record.baseSha
          if (head !== expectedHead) throw Error('parent changed outside declared join order')
          receipt = { schemaVersion: 1, operationId: randomUUID(), issue: child.issue, runId: child.runId, generation: run.sharedClaim?.generation ?? run.generation,
            fromSha: result.headSha, baseSha: record.baseSha, parentBefore: head, parentAfter: null, accepted: false, reason: '', receiptIds: { preparedLink: randomUUID(), accepted: randomUUID(), acceptedLink: randomUUID(), acceptance: randomUUID() }, state: 'prepared', preparedRef: null, acceptedRef: null }
        }
        if (!input.write) { output.receipts.push(receipt); if(input.write && run.execution) output.acceptedDeliveries.push(...await publishAcceptedChildScope(parent,run,receipt,config,deps.gh)); continue }
        await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt)
        claim = await (deps.persistChild ?? linkChildAcceptance)(claim, run, check, config)
        if (!receipt.preparedRef) {
          const prepared = await (deps.persistJoin ?? publishJoin)(claim, receipt, null, config)
          claim = prepared.claim; receipt.preparedRef = prepared.reference
          await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt)
        }
        await verifyCurrentParent()
        await verifyAuthority(await readRun(root,parent.runId))
        if (receipt.state === 'prepared') {
          clean(parent.checkout)
          if (git(parent.checkout, ['rev-parse','HEAD']) !== receipt.parentBefore) throw Error('parent changed after prepared integration intent')
          await verifiedResult(await readRun(root, child.runId), child, config)
          try {
            if (result.noChange) receipt.parentAfter = receipt.parentBefore
            else {
              // Merge an immutable local commit; never reset/rebase the child's
              // published branch. Ordered receipts retain both source histories.
              git(parent.checkout, ['merge', '--no-ff', '--no-edit', result.headSha])
              receipt.parentAfter = git(parent.checkout, ['rev-parse', 'HEAD'])
            }
            receipt.state = 'applied'; output.wrote ||= receipt.parentAfter !== receipt.parentBefore
            await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt)
          } catch (error) {
            receipt.state = 'refused'; receipt.reason = 'integration conflict; owned Git state and prior successes preserved'
            await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt)
            throw error
          }
        }
        const currentParent = { ...await readRun(root, parent.runId), headSha: receipt.parentAfter }
        const parentCheck = await sourceCheck(currentParent, child.acceptanceCommand, config, input.signal, {...deps.processDeps,gh:deps.gh}, 'join-' + child.runId)
        if (!parentCheck.ok) {
          receipt.state = 'refused'; receipt.reason = 'assembled parent acceptance failed'
          await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt); throw Error(receipt.reason)
        }
        receipt.accepted = true
        await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt)
        // Record local success first. Remote accepted state additionally requires
        // #138 to acknowledge the exact new parent checkpoint; no placeholder.
        const helpers = await import('./runs.ts')
        let savedParent=await readRun(root,parent.runId)
        if(savedParent.headSha!==receipt.parentAfter)savedParent=await helpers.updateRun(root,parent.runId,()=>({headSha:receipt!.parentAfter}))
        try {
          if(savedParent.checkpoint?.headSha!==receipt.parentAfter)await (await import('./checkpoints.ts')).flushRunCheckpoint(savedParent,config)
          const accepted = await (deps.persistJoin ?? publishJoin)(claim, receipt, parentCheck, config)
          claim = accepted.claim; receipt.acceptedRef = accepted.reference
          receipt.state = 'accepted'
        } catch (error) {
          receipt.reason = 'local join accepted; remote checkpoint/receipt pending: ' + (error as Error).message
        }
        await atomicRunFile(joinPath(root, parent.runId, child.runId), receipt)
        await appendFile(join(root, parent.runId, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event: 'child-integration', operationId: receipt.operationId, childRunId: receipt.runId, generation: receipt.generation, fromSha: receipt.fromSha, parentBefore: receipt.parentBefore, parentAfter: receipt.parentAfter, accepted: receipt.accepted, remoteAccepted: !!receipt.acceptedRef }) + '\n', { mode: 0o600 })
        output.receipts.push(receipt)
        if (!receipt.acceptedRef) { output.blocked.push({ issue: child.issue, reason: receipt.reason }); break }
        if(run.execution) output.acceptedDeliveries.push(...await publishAcceptedChildScope(parent,run,receipt,config,deps.gh))
      } catch (error) { output.blocked.push({ issue: child.issue, reason: (error as Error).message }); break }
    }
    return output
  } finally { if (lock?.kind === 'owned') await releaseClaim(lock.claim) }
}

export const childrenUsage = () => 'vegafactory children run|join --parent N --groups FILE --repo owner/name [--write] [--json] [--config FILE]'
export interface ChildrenCliDependencies { config?: FactoryConfig; execution?: ChildrenDependencies; integration?: JoinDependencies; parent?: (repo: string, issue: number, config: FactoryConfig) => Promise<RunRecord> }
export async function runChildrenCli(argv: string[], home: string, deps: ChildrenCliDependencies = {}): Promise<number> {
  if (argv.length === 0 || argv.some(arg => ['--help', '-h', 'help'].includes(arg))) { console.log(childrenUsage()); return 0 }
  const flags: Record<string, string | boolean> = {}, verb = argv[0]
  try {
    if(verb==='inspect-preparation') {
      if(argv.length!==2||argv[1]!=='--json')throw Error('inspect-preparation requires --json and bounded stdin')
      const helper=await import(pathToFileURL(join(implementRoot,'scripts/recovery.mjs')).href) as typeof import('../../../skills/dev/dev-implement/scripts/recovery.mjs')
      const raw=String(await helper.readBoundedRecoveryInput())
      const config=deps.config??await loadFactoryConfig(join(home,'.vegastack/factory.json'),home)
      console.log(JSON.stringify(await inspectAcceptedPreparationIntegration(JSON.parse(raw),config)));return 0
    }
    if (verb !== 'run' && verb !== 'join') throw Error(childrenUsage())
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i]!
      if (!['--parent', '--groups', '--repo', '--write', '--json', '--config'].includes(flag) || Object.hasOwn(flags, flag)) throw Error('unknown or duplicate children argument: ' + flag)
      if (flag === '--write' || flag === '--json') flags[flag] = true
      else { const value = argv[++i]; if (!value || value.startsWith('--')) throw Error('missing value: ' + flag); flags[flag] = value }
    }
    const issue = Number(flags['--parent']), repo = flags['--repo']
    if (!Number.isSafeInteger(issue) || issue < 1 || typeof repo !== 'string' || !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo) || typeof flags['--groups'] !== 'string') throw Error(childrenUsage())
    const config = deps.config ?? await loadFactoryConfig(typeof flags['--config'] === 'string' ? flags['--config'] : join(home, '.vegastack/factory.json'), home)
    const groupsPath = resolve(flags['--groups'])
    if (await realpath(groupsPath) !== groupsPath) throw Error('groups report must be a canonical regular path')
    const groups = JSON.parse(await readFile(groupsPath, 'utf8'))
    let parent: RunRecord
    if (deps.parent) parent = await deps.parent(repo, issue, config)
    else {
      const records = (await readRuns(runsRoot(config.home))).filter(run => run.repo === repo && run.issue === issue && run.parent === null && run.state === 'running')
      if (records.length !== 1) throw Error('unique active owned parent run required; preparation is not execution')
      parent = records[0]!
      // The actual managed parent run identity is injected by executeRun. A shell
      // elsewhere cannot select another active parent just by knowing its issue.
      if (process.env.VSK_RUN_ID !== parent.runId || !await belongsToParentProcess(parent) || await realpath(process.cwd()) !== parent.checkout) throw Error('children command must run inside its registered parent session')
    }
    const stop = new AbortController(), cancel = () => stop.abort()
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
      const input = { parent, groups, config, write: flags['--write'] === true, signal: stop.signal }
      const outcome = verb === 'run' ? await executeChildren(input, deps.execution) : await joinChildren(input, deps.integration)
      console.log(flags['--json'] ? JSON.stringify(outcome) : `${verb}: ${outcome.blocked.length ? outcome.blocked.map(row => '#' + row.issue + ': ' + row.reason).join('; ') : 'verified'}`)
      return outcome.blocked.length ? 2 : 0
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
  } catch (error) {
    console.log(flags['--json'] ? JSON.stringify({ blocked: [{ reason: (error as Error).message }], wrote: false }) : (error as Error).message)
    return 2
  }
}

export async function validateParallelCoordinator(planned: PlannedRun, parent: RunRecord, config: FactoryConfig): Promise<void> {
  if (!planned.parallel?.length || parent.parent !== null || parent.issue !== planned.issue || parent.repo !== planned.repo || !parent.execution || !parent.sharedClaim) throw Error('parallel coordinator lacks its own qualified shared run')
  const groups = await authoritativeGroups(parent, config)
  const children = groups.map(group => Number(group.members[0]!.slice(1)))
  if (!same(children, planned.parallel)) throw Error('coordinator children differ from declared canonical order')
}

function validateIntegrationRecord(receipt: IntegrationRecord): void {
  if (!closed(receipt, ['schemaVersion','operationId','issue','runId','generation','fromSha','baseSha','parentBefore','parentAfter','accepted','reason','receiptIds','state','preparedRef','acceptedRef'])
    || receipt.schemaVersion !== 1 || !uuid.test(receipt.operationId) || !uuid.test(receipt.runId) || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
    || ![receipt.fromSha, receipt.baseSha, receipt.parentBefore].every(value => sha.test(value)) || receipt.parentAfter !== null && !sha.test(receipt.parentAfter)
    || typeof receipt.accepted !== 'boolean' || typeof receipt.reason !== 'string' || !['prepared','applied','accepted','refused'].includes(receipt.state)
    || !closed(receipt.receiptIds, ['preparedLink','accepted','acceptedLink','acceptance']) || Object.values(receipt.receiptIds).some(value => !uuid.test(value))
    || receipt.state === 'accepted' && (!receipt.accepted || !receipt.parentAfter || !receipt.acceptedRef)
    || receipt.state === 'applied' && !receipt.parentAfter || receipt.state === 'prepared' && receipt.parentAfter !== null) throw Error('invalid durable join receipt')
}

// #144 supplies its verified original RunRecord/private launch reconstruction.
// This consumer fetches only its immutable checkpoint commit; it neither rewrites
// the published child branch nor invents an accepted result from that branch.
export async function fetchChildCheckpoint(input: { checkout: string; run: Pick<RunRecord,'repo'|'runId'|'branch'|'baseSha'|'headSha'|'taskKey'|'checkpoint'>; config: FactoryConfig }, transport: {
  repository?: (repo: string) => Promise<{ node_id: string }>
  fetch?: (checkout: string, repo: string, headSha: string) => Promise<void>
} = {}): Promise<void> {
  const { run } = input, checkpoint = run.checkpoint
  if (!checkpoint || checkpoint.repo !== run.repo || checkpoint.runId !== run.runId || checkpoint.branch !== run.branch || checkpoint.baseSha !== run.baseSha
    || checkpoint.headSha !== run.headSha || checkpoint.scopeDigest !== run.taskKey.scopeDigest) throw Error('child immutable checkpoint identity differs')
  const repository = await (transport.repository ?? (repo => boundedGhJson<{ node_id: string }>(ghText, ['api', 'repos/' + repo], readBudget())))(run.repo)
  if (repository.node_id !== checkpoint.repositoryId) throw Error('checkpoint repository identity changed')
  await (transport.fetch ?? (async (checkout, repo, headSha) => {
    const fetched = spawnSync('git', ['-c','credential.interactive=false','fetch','--no-tags','--no-recurse-submodules','https://github.com/' + repo + '.git', headSha],
      { cwd: checkout, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    if (fetched.status !== 0 || fetched.signal || fetched.error) throw Error('exact checkpoint commit fetch unavailable')
  }))(input.checkout, run.repo, checkpoint.headSha)
  if (git(input.checkout, ['rev-parse', checkpoint.headSha + '^{commit}']) !== checkpoint.headSha
    || git(input.checkout, ['rev-parse', checkpoint.headSha + '^{tree}']) !== checkpoint.treeSha) throw Error('fetched checkpoint source identity differs')
  git(input.checkout, ['merge-base', '--is-ancestor', checkpoint.baseSha, checkpoint.headSha])
}

async function belongsToParentProcess(parent: RunRecord): Promise<boolean> {
  if (!parent.processIdentity) return false
  try {
    if (!same(await processIdentity(parent.processIdentity.pid), parent.processIdentity)) return false
    const listing = spawnSync('/bin/ps', ['-ax','-o','pid=,ppid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 })
    if (listing.status !== 0) return false
    const parents = new Map(listing.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number) as [number,number]))
    let pid = process.pid
    for (let depth = 0; depth < 128; depth++) { if (pid === parent.processIdentity.pid) return true; const next = parents.get(pid); if (!next || next === pid) return false; pid = next }
  } catch { return false }
  return false
}

function validateRecordedSource(parent: RunRecord, record: ChildrenRecord): void {
  if (record.parentRunId !== parent.runId || record.parentIssue !== parent.issue || record.repo !== parent.repo || record.parentBranch !== parent.branch) throw Error('saved parent identity differs')
  const devMd = git(parent.checkout, ['show', record.baseSha + ':.vegastack/dev.md'])
  const command = /^commands:.*?\bcheck\s+`([^`]+)`/m.exec(devMd)?.[1]
  if (!command || record.children.some(child => child.acceptanceCommand !== command)) throw Error('acceptance command differs from approved parent source')
  const issues = Object.fromEntries(record.children.map(child => [child.issue, { number: child.issue, title: child.title, type: child.type }]))
  const prepared = planParallelRun({ groups: record.groups, issues, parentBranch: parent.branch, parentHead: record.baseSha, repoRoot: parent.checkout, parentIssue: parent.issue })
  for (let i = 0; i < prepared.children.length; i++) {
    const child = prepared.children[i]!, saved = record.children[i]!
    if (child.branch !== saved.branch || child.path !== saved.path || child.baseSha !== saved.baseSha) throw Error('saved prepared child checkout differs')
  }
}

export class ChildCapacityWait extends Error {}
async function waitForChildSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw Error('parent cancelled while awaiting child capacity')
  await new Promise<void>((resolveWait,reject) => {
    const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort',cancelled); reject(Error('parent cancelled while awaiting child capacity')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort',cancelled); resolveWait() },1000)
    signal.addEventListener('abort',cancelled,{once:true})
  })
}

async function resolveJoinChild(child: ChildLaunch, parent: RunRecord, config: FactoryConfig, deps: JoinDependencies): Promise<{ run: RunRecord; result: ChildResult; check: ChildCheck }> {
  if (!child.runId || !child.scopeDigest) throw Error('child has no executed result')
  const root = runsRoot(config.home), run = await readRun(root, child.runId), saved = await readOptional<ChildResult>(resultPath(root, child.runId))
  if (!saved) throw Error('child has no durable accepted result')
  const result = await verifiedResult(run, child, config)
  if (!same(result, saved)) throw Error('child result changed')
  if(deps.verifyChild)await deps.verifyChild(run,config);else await verifyDispatchRunAuthority(run,config,'effect',{gh:deps.gh})
  if (spawnSync('git', ['cat-file','-e',result.headSha + '^{commit}'], { cwd: parent.checkout, stdio: 'ignore' }).status !== 0) await fetchChildCheckpoint({ checkout: parent.checkout, run, config })
  const check = await readOptional<ChildCheck>(checkPath(root, run.runId))
  if (!check) throw Error('source-bound acceptance unavailable')
  return { run, result, check }
}

export interface AcceptedDelivery {
  taskRef:{repo:string;issue:number;taskId:string|null};scopeDigest:string;childHead:string
  parentRepo:string;parentIssue:number;parentHead:string;acceptance:'implemented'
}
interface TrustedReviewSource {commentId:number;bodySha256:string;publisher:string}
interface AcceptedScopeProgress {
  schemaVersion:2;joinOperationId:string;receiptId:string;linkId:string;review:TrustedReviewSource
  payload:Extract<RecoveryEvidencePayload,{kind:'acceptance'}>
  reference:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>|null
  state:'prepared'|'published'|'linked'
}
async function trustedReviewedChildSource(run:RunRecord,config:FactoryConfig,gh:typeof ghText=ghText):Promise<TrustedReviewSource> {
  const comments=await fetchGhPages<{id:number;body:string;user:{login:string}}>(gh,`repos/${run.repo}/issues/${run.issue}/comments`,readBudget())
  const shipUrl=new URL(sourceModule?'../../../skills/dev/dev-ship/scripts/ship-gate.mjs':'../skill/dev-ship/scripts/ship-gate.mjs',import.meta.url)
  const {selectCurrentTrustedReview}=await import(shipUrl.href) as typeof import('../../../skills/dev/dev-ship/scripts/ship-gate.mjs')
  const plan=run.approvalRefs.find(ref=>ref.kind==='plan')
  if(!run.headSha||!plan)throw Error('exact complete child review unavailable')
  const {policy}=await currentPolicy(config,run.repo)
  const selected=selectCurrentTrustedReview(comments.items,{complete:comments.complete,operators:policy.operators,
    sha:run.headSha,baseSha:run.baseSha,scopeDigest:plan.digest})
  if(!selected)throw Error('exact complete child review unavailable')
  if(selected.binding.verdict!=='clean'){
    const open=selected.binding.findings.filter((finding:{id:string;status:string})=>finding.status==='open').map((finding:{id:string})=>finding.id)
    throw Error('child review requires fixes'+(open.length?': '+open.join(', '):''))
  }
  await verifyDispatchRunAuthority(run,config,'effect',{gh})
  return selected.source
}
export async function exactReviewedChild(run:RunRecord,config:FactoryConfig,gh:typeof ghText=ghText):Promise<void> {await trustedReviewedChildSource(run,config,gh)}
export function acceptedDeliveryProjection(snapshot:import('./shared-claims.ts').AcceptedScopeSnapshot,childHead:string,scopeDigest:string):AcceptedDelivery[] {
  parseAcceptedScope(snapshot)
  if(!/^[a-f0-9]{64}$/.test(scopeDigest)||snapshot.schemaVersion!==2||!sha.test(childHead)||!snapshot.completedTaskIds.length||snapshot.completedTaskIds.some(id=>!snapshot.approvedTaskIds.includes(id))||new Set(snapshot.completedTaskIds).size!==snapshot.completedTaskIds.length)throw Error('accepted task projection differs')
  return snapshot.completedTaskIds.map(taskId=>({taskRef:{repo:snapshot.repo,issue:snapshot.issue,taskId},scopeDigest,childHead,parentRepo:snapshot.parentRepo,parentIssue:snapshot.parentIssue,parentHead:snapshot.parentAfter,acceptance:'implemented'}))
}
// Read back immutable accepted scope before linking it. A pending receipt is not
// an implemented-delivery row; no parent completion is fabricated to link it.
export async function publishAcceptedChildScope(parent:RunRecord,child:RunRecord,joined:IntegrationRecord,config:FactoryConfig,gh:typeof ghText=ghText):Promise<AcceptedDelivery[]> {
  if(joined.state!=='accepted'||!joined.acceptedRef||!joined.accepted||joined.runId!==child.runId||joined.fromSha!==child.headSha||!joined.parentAfter)throw Error('accepted parent join unavailable')
  const record=await readExecutableChildrenRecord(parent,config)
  await verifyIntegrationAuthority(parent,record,config,gh)
  const review=await trustedReviewedChildSource(child,config,gh)
  const plan=await canonicalPlan(child,gh)
  const completed=[...plan.matchAll(/^-\s*\[x\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->/gim)].map(row=>row[1]!)
  if(!child.approvedTaskIds?.length||!same([...completed].sort(),[...child.approvedTaskIds].sort()))throw Error('unchecked or partial child scope cannot be reported implemented')
  if(child.authorityRequest?.kind==='consolidated'){
    const request=child.authorityRequest,comment=await boundedGhJson<{body:string}>(gh,['api',`repos/${request.parentRepo}/issues/comments/${request.approvalBinding.commentId}`],readBudget())
    const {approval}=await approvalTools(),grant=approval.parseApproval(comment)
    if(grant.kind!=='consolidated'||grant.items.find((item:{repo:string;issue:number})=>item.repo===child.repo&&item.issue===child.issue)?.mode!=='code')throw Error('preparation scope is not implemented code')
  }
  const check=await readOptional<ChildCheck>(checkPath(runsRoot(config.home),child.runId))
  if(!check)throw Error('executed child acceptance unavailable')
  await verifyExecutedCheck(child,check,config)
  const path=join(runsRoot(config.home),parent.runId,'accepted-scope-'+child.runId+'.json')
  let progress=await readOptional<AcceptedScopeProgress>(path)
  if(!progress){
    const acceptedScope:import('./shared-claims.ts').AcceptedScopeSnapshot={schemaVersion:2,repo:child.repo,issue:child.issue,artifacts:child.approvalRefs,approvalBindings:child.approvalBindings,approvedTaskIds:child.approvedTaskIds,completedTaskIds:completed,parentRepo:parent.repo,parentIssue:parent.issue,parentBefore:joined.parentBefore,parentAfter:joined.parentAfter,acceptedAt:new Date().toISOString()}
    progress={schemaVersion:2,joinOperationId:joined.operationId,receiptId:randomUUID(),linkId:randomUUID(),review,reference:null,state:'prepared',payload:{schemaVersion:2,kind:'acceptance',taskId:completed[0]!,runId:child.runId,sourceSha:child.headSha!,scopeDigest:child.taskKey.scopeDigest,validationId:check.validationId,commandDigest:hash(check.command),result:'passed',acceptedScope}}
    await atomicRunFile(path,progress)
  }
  if(!closed(progress,['schemaVersion','joinOperationId','receiptId','linkId','payload','reference','review','state'])||progress.schemaVersion!==2||progress.joinOperationId!==joined.operationId||!uuid.test(progress.receiptId)||!uuid.test(progress.linkId)||!same(progress.review,review)||progress.payload.sourceSha!==child.headSha||progress.payload.acceptedScope?.parentAfter!==joined.parentAfter||!same(progress.payload.acceptedScope?.approvalBindings,child.approvalBindings))throw Error('accepted scope persistence identity changed')
  const owner=await import('./shared-claims.ts');owner.parseRecoveryPayload(progress.payload)
  let claim=await sharedClaimForRun(child,config,gh)
  if(!progress.reference){const published=await publishRecoveryReceipt({claim,operationId:progress.receiptId,payload:progress.payload});claim=published.claim;progress.reference=published.reference;progress.state='published';await atomicRunFile(path,progress)}
  const readback=await owner.resolveEvidence(claim.target,progress.reference)
  if(!same(readback,progress.payload))throw Error('accepted scope readback differs')
  const inspection=await owner.inspectCoordinationTask(claim.target,claim.taskKey,{runId:claim.runId,generation:claim.generation,ownerToken:claim.ownerToken})
  if(inspection.kind!=='active'&&inspection.kind!=='completed')throw Error('accepted scope owner unavailable')
  if(!inspection.task.acceptedScopes.some(row=>same(row.receipt,progress!.reference)&&row.scopeDigest===child.taskKey.scopeDigest)){
    // The shared owner links this exact child-published receipt without
    // changing task state or treating parent acceptance as child ownership.
    const linked=await owner.linkAcceptedScope({claim,operationId:progress.linkId,acceptedScope:progress.reference})
    if(linked.kind!=='owned')throw Error('accepted scope link pending: '+linked.reason)
    const current=await owner.inspectCoordinationTask(linked.claim.target,linked.claim.taskKey,{runId:claim.runId,generation:claim.generation,ownerToken:claim.ownerToken})
    if((current.kind!=='active'&&current.kind!=='completed')||!current.task.acceptedScopes.some(row=>same(row.receipt,progress!.reference)))throw Error('accepted scope link not acknowledged')
  }
  progress.state='linked';await atomicRunFile(path,progress)
  return acceptedDeliveryProjection(progress.payload.acceptedScope!,child.headSha!,child.taskKey.scopeDigest)
}

export interface PreparationContract {repo:string;issue:number;plan:import('./shared-claims.ts').ArtifactRef;childHead:string;parentHead:string;acceptance:'implemented';evidence:{commentId:number;bodySha256:string}}
export async function inspectAcceptedPreparationIntegration(contract:PreparationContract,config:FactoryConfig):Promise<{contract:PreparationContract;ancestorShas:string[];reviewedHead:string;acceptedTaskIds:string[]}> {
 if(!closed(contract,['repo','issue','plan','childHead','parentHead','acceptance','evidence'])||contract.acceptance!=='implemented'||!sha.test(contract.childHead)||!sha.test(contract.parentHead)||!Number.isSafeInteger(contract.evidence?.commentId)||contract.evidence.commentId<=0)throw Error('invalid preparation accepted contract')
 const entry=config.repos.find(row=>row.repo===contract.repo);if(!entry)throw Error('preparation repository is not configured')
 const comment=await boundedGhJson<{id:number;body:string;issue_url:string}>(ghText,['api',`repos/${contract.repo}/issues/comments/${contract.evidence.commentId}`],readBudget())
 if(comment.id!==contract.evidence.commentId||hash(comment.body)!==contract.evidence.bodySha256||comment.issue_url!==`https://api.github.com/repos/${contract.repo}/issues/${contract.issue}`)throw Error('accepted contract source changed')
 const owner=await import('./shared-claims.ts'),repository=await boundedGhJson<{node_id:string}>(ghText,['api','repos/'+contract.repo],readBudget()),issue=await boundedGhJson<{node_id:string}>(ghText,['api',`repos/${contract.repo}/issues/${contract.issue}`],readBudget())
 const target=await (await import('./dispatch.ts')).verifiedSharedTarget(contract.repo,config)
 const key=owner.taskKey(target.host,repository.node_id,issue.node_id),inspected=await owner.inspectCoordinationTask(target,key)
 if(inspected.kind!=='active'&&inspected.kind!=='completed')throw Error('accepted private scope unavailable')
 const matches:import('./shared-claims.ts').AcceptedScopeSnapshot[]=[]
 for(const row of inspected.task.acceptedScopes){
  const reader={...target,verifyEvidence:async(ref:import('./shared-claims.ts').EvidenceRef,payload:RecoveryEvidencePayload|null)=>{
   if(!same(ref,row.receipt)||payload?.kind!=='acceptance'||payload.result!=='passed'||!payload.acceptedScope||payload.scopeDigest!==row.scopeDigest||payload.sourceSha!==contract.childHead)throw Error('accepted scope receipt differs')
   const accepted=owner.parseAcceptedScope(payload.acceptedScope)
   if(accepted.repo!==contract.repo||accepted.issue!==contract.issue||accepted.parentRepo!==contract.repo||accepted.parentAfter!==contract.parentHead||!accepted.artifacts.some(ref=>same(ref,contract.plan))||!same([...accepted.approvedTaskIds].sort(),[...accepted.completedTaskIds].sort()))throw Error('accepted contract is incomplete or foreign')
  }}
  try{const payload=await owner.resolveEvidence(reader,row.receipt);if(payload?.kind==='acceptance'&&payload.acceptedScope)matches.push(payload.acceptedScope)}catch{/* A different historical scope is not this contract. */}
 }
 if(matches.length!==1)throw Error('unique exact accepted scope receipt required')
 const ancestors=git(entry.path,['rev-list',contract.parentHead]).split('\n')
 if(ancestors[0]!==contract.parentHead||!ancestors.includes(contract.childHead)||!ancestors.includes(matches[0]!.parentBefore))throw Error('accepted code ancestry unavailable')
 return {contract,ancestorShas:ancestors,reviewedHead:contract.childHead,acceptedTaskIds:matches[0]!.completedTaskIds}
}

async function verifyAcceptedScopePayload(child:RunRecord,payload:Extract<RecoveryEvidencePayload,{kind:'acceptance'}>,config:FactoryConfig,gh:typeof ghText=ghText):Promise<void> {
 const owner=await import('./shared-claims.ts'),snapshot=owner.parseAcceptedScope(payload.acceptedScope)
 if(snapshot.repo!==child.repo||snapshot.issue!==child.issue||snapshot.parentRepo!==child.repo||snapshot.parentIssue!==child.parent||!same(snapshot.artifacts,child.approvalRefs)||!same(snapshot.approvalBindings,child.approvalBindings)||!same([...snapshot.approvedTaskIds].sort(),[...(child.approvedTaskIds??[])].sort())||!same([...snapshot.completedTaskIds].sort(),[...snapshot.approvedTaskIds].sort()))throw Error('accepted scope differs from complete approved child')
 const parents=(await readRuns(runsRoot(config.home))).filter(run=>run.repo===snapshot.parentRepo&&run.issue===snapshot.parentIssue&&run.parent===null)
 const matches=[]
 for(const parent of parents){
  const record=await readExecutableChildrenRecord(parent,config).catch(()=>null);if(!record?.children.some(row=>row.runId===child.runId))continue
  const joined=await readOptional<IntegrationRecord>(joinPath(runsRoot(config.home),parent.runId,child.runId))
  if(!joined||joined.state!=='accepted'||joined.fromSha!==payload.sourceSha||joined.parentBefore!==snapshot.parentBefore||joined.parentAfter!==snapshot.parentAfter)continue
  await verifyIntegrationAuthority(parent,record,config,gh);await exactReviewedChild(child,config,gh)
  const progress=await readOptional<AcceptedScopeProgress>(join(runsRoot(config.home),parent.runId,'accepted-scope-'+child.runId+'.json'))
  if(!progress||!same(progress.payload,payload))throw Error('accepted scope publication intent differs')
  matches.push(parent.runId)
 }
 if(matches.length!==1)throw Error('unique original accepted parent integration unavailable')
}

export interface RecoveredChildrenContext {
 record:ChildrenRecord
 existing:Array<{task:TaskRecord;stateCommit:string;checkpoint:NonNullable<RunRecord['checkpoint']>;authorityRequest:RunAuthorityRequest;checkpointRequest:NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>}>
 newPreparations:number[]
 currentTitles:Array<{issue:number;title:string}>
}
function reconcileProgressedChildrenState(inspection:import('./shared-claims.ts').GroupSuccessionInspection,recovery:import('./shared-claims.ts').RecoveryEnvelope,settledRunIds:ReadonlySet<string>,startedRunIds:ReadonlySet<string>=new Set()):{accepted:JoinRef[];unfinished:TaskRecord[]} {
 if(inspection.kind!=='verified')throw Error(inspection.reason)
 const children=inspection.currentMembers.filter(row=>row.initial.parentTaskKey!==null),runs=new Set<string>(),accepted:JoinRef[]=[]
 for(const joined of recovery.joins.filter(row=>row.state==='accepted')){
  const member=children.find(row=>row.initial.runId===joined.childRunId),result=recovery.children.find(row=>row.childRunId===joined.childRunId)
  if(!member||runs.has(joined.childRunId)||!joined.parentAfter||!joined.acceptance||!result||result.generation!==joined.generation||result.headSha!==joined.fromSha||result.acceptance.sourceSha!==joined.fromSha)throw Error('accepted progressed child/join identity differs')
  runs.add(joined.childRunId);accepted.push(joined)
 }
 const unfinished=children.filter(row=>!runs.has(row.initial.runId)).map(row=>row.current)
 // Reconstruction supplies no settled IDs and remains queued-only. Execution
 // replay may consume its exact local result after the successor is stopped.
 if(unfinished.some(task=>task.schemaVersion!==2||task.state!=='recovery-queued'&&!(startedRunIds.has(task.runId)&&task.state==='running')&&!(settledRunIds.has(task.runId)&&task.state==='stopped'&&!!task.stopProof)))throw Error('progressed unfinished child is not recovery-queued, exactly started or durably settled')
 return{accepted,unfinished}
}
export function reconcileProgressedChildren(inspection:import('./shared-claims.ts').GroupSuccessionInspection,recovery:import('./shared-claims.ts').RecoveryEnvelope):{accepted:JoinRef[];unfinished:TaskRecord[]} {
 return reconcileProgressedChildrenState(inspection,recovery,new Set())
}
// Reconstruct authority/source facts, not old process results. Missing retained
// tasks become explicitly NEW preparation only after the full owner reader says
// absent and no accepted/checkpoint reference names that task.
export async function reconstructChildrenContext(input:{parent:RunRecord;material:import('./dispatch.ts').RemoteRecoveryMaterial;classifications?:import('./dispatch.ts').StoppedGroupClassification[];config:FactoryConfig},transport:{gh?:typeof ghText;target?:import('./shared-claims.ts').CoordinationTarget}={}):Promise<RecoveredChildrenContext> {
 const {parent,material,config}=input,dispatch=await import('./dispatch.ts'),owner=await import('./shared-claims.ts')
 dispatch.assertRemoteRecoveryMaterial(material)
 if(parent.runId!==material.task.runId||parent.repo!==material.task.repo||parent.issue!==material.task.issue||parent.parent!==null||parent.branch!==material.task.checkpoint?.branch||parent.headSha!==material.task.checkpoint?.headSha||!same(parent.approvalRefs,material.artifacts)||!same(parent.approvalBindings,material.task.approvalBindings))throw Error('recovered parent source context differs')
 const declaredGroups=checkedGroups({guard:'plan-lint',ok:lintPlan(material.planBody).blocks.length===0,groups:parseIndependentGroups(material.planBody).map(group=>({id:group.id,members:group.members,files:group.files}))}),classifications=input.classifications
 if(classifications&&(classifications.length!==declaredGroups.length||classifications.some((row,index)=>row.groupId!==declaredGroups[index]!.id||row.issue!==Number(declaredGroups[index]!.members[0]!.slice(1)))))throw Error('stopped group classification differs from canonical plan')
 const groups=declaredGroups
 const target=transport.target??await dispatch.verifiedSharedTarget(parent.repo,config),gh=transport.gh??ghText
 const observedParent=await owner.inspectCoordinationTask(target,material.task.taskKey)
 if(observedParent.kind!=='active'&&observedParent.kind!=='completed'||observedParent.task.runId!==material.task.runId||observedParent.task.scopeDigest!==material.task.scopeDigest)throw Error('current recovered parent state unavailable')
 const current:ParentClaimBinding={taskKey:observedParent.task.taskKey,runId:observedParent.task.runId,generation:observedParent.task.generation,ownerToken:observedParent.task.ownerToken,machineId:observedParent.task.machineId,installationId:observedParent.task.installationId,sessionId:observedParent.task.sessionId}
 let original=current,succession:Extract<import('./shared-claims.ts').GroupSuccessionInspection,{kind:'verified'}>|null=null
 if(observedParent.task.schemaVersion===2){
  const inspected=await owner.inspectGroupSuccession(target,{operationId:observedParent.task.successionOperationId,parent:current})
  if(inspected.kind!=='verified')throw Error(inspected.reason)
  succession=inspected
  const row=inspected.receipt.members.find(row=>same(row.after,current))
  if(!row)throw Error('group succession origin parent unavailable')
  original=row.before
 }
 const known:Array<{group:ChildGroup;task:TaskRecord;stateCommit:string;title:string;authorityRequest:RunAuthorityRequest;checkpointRequest:NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>;local:boolean}>=[],fresh:Array<{group:ChildGroup;title:string}>=[],deferred:Array<{group:ChildGroup;title:string}>=[]
 for(const group of declaredGroups){
  const issue=Number(group.members[0]!.slice(1)),subject=await boundedGhJson<{number:number;node_id:string;title:string}>(gh,['api',`repos/${parent.repo}/issues/${issue}`],readBudget())
  if(subject.number!==issue||typeof subject.title!=='string'||!subject.title.trim()||subject.title.length>512)throw Error('current child identity unavailable')
  const key=owner.taskKey(target.host,material.task.repositoryNodeId,subject.node_id),historical=material.children.filter(row=>row.task.taskKey===key),classification=classifications?.find(row=>row.issue===issue)
  if(classification&&(classification.issueNodeId!==subject.node_id||classification.taskKey!==key))throw Error('stopped group classification task identity differs')
  if(historical.length>1)throw Error('ambiguous original child record')
  const retained=await owner.inspectCoordinationTask(target,key)
  if(classification?.classification.kind==='no-shared-task'){
   if(retained.kind!=='absent'||historical.length||material.task.recovery!.children.some(row=>row.childTaskKey===key))throw Error('no-task stopped group gained execution evidence')
   deferred.push({group,title:subject.title})
   continue
  }
  if(retained.kind==='absent'){
   if(classification)throw Error('classified stopped group task became absent')
   if(historical.length||material.task.recovery!.children.some(row=>row.childTaskKey===key)||material.task.recovery!.joins.some(row=>historical.some(child=>child.task.runId===row.childRunId)))throw Error('absent current child still has original work evidence')
   fresh.push({group,title:subject.title});continue
  }
  if(retained.kind==='invalid-or-unavailable')throw Error('child retained state unavailable; absence cannot be inferred')
  const progressed=succession?.currentMembers.find(row=>row.current.taskKey===key)
  if(progressed&&!same(progressed.current,retained.task))throw Error('current child differs from verified succession history')
  const verified=historical[0],checkpointRequest=verified?.checkpointRequest
  if(!verified||!checkpointRequest)throw Error('exact child checkpoint request unavailable')
  const source=progressed?{...verified,task:progressed.current,stateCommit:retained.head}:verified,child=source.task
  if(child.repo!==parent.repo||child.issue!==issue||child.parentTaskKey!==original.taskKey||!child.parentBinding||!same(child.paths,group.files)||child.resources.length||!child.checkpoint||!child.recovery||!same(child.checkpoint,child.recovery.checkpoint))throw Error('original child binding or exact checkpoint unavailable')
  if(retained.task.runId!==child.runId||retained.task.generation!==child.generation||retained.task.ownerToken!==child.ownerToken)throw Error('child now has another owner; historical facts cannot authorize recovery')
  const completedClassification=classification?.classification.kind==='completed'?classification.classification:null,completed=!!completedClassification
  if(classification?.classification.kind==='retained'){const before=succession?.receipt.members.find(row=>row.before.taskKey===child.taskKey)?.before??{taskKey:verified.task.taskKey,runId:verified.task.runId,generation:verified.task.generation,ownerToken:verified.task.ownerToken,machineId:verified.task.machineId,installationId:verified.task.installationId,sessionId:verified.task.sessionId};if(retained.kind!=='active'||!same(classification.classification.expected,before))throw Error('retained stopped group owner differs')}
  if(completedClassification&&(retained.kind!=='completed'||!child.acceptedScopes.some(row=>same(row.receipt,completedClassification.acceptedScope))||!material.task.recovery!.joins.some(row=>row.childRunId===child.runId&&row.state==='accepted'&&same(row.evidence,completedClassification.joinEvidence))))throw Error('completed stopped group evidence changed before reconstruction')
  known.push({group,task:child,stateCommit:source.stateCommit,title:subject.title,authorityRequest:source.authorityRequest,checkpointRequest,local:!completed})
 }
 const bases=[...new Set([...known.map(row=>row.task.checkpoint!.baseSha),...material.task.recovery!.children.map(row=>row.baseSha)])]
 if(bases.length>1)throw Error('original child base is ambiguous')
 const baseSha=bases[0]??parent.headSha!
 if(!sha.test(baseSha))throw Error('exact child preparation base unavailable')
 git(parent.checkout,['merge-base','--is-ancestor',baseSha,parent.headSha!])
 const devMd=git(parent.checkout,['show',baseSha+':.vegastack/dev.md']),command=/^commands:.*?\bcheck\s+`([^`]+)`/m.exec(devMd)?.[1]
 if(!command)throw Error('original approved source check command unavailable')
 const issues=Object.fromEntries([...known.map(row=>({issue:row.task.issue,title:row.title})),...fresh.map(row=>({issue:Number(row.group.members[0]!.slice(1)),title:row.title})),...deferred.map(row=>({issue:Number(row.group.members[0]!.slice(1)),title:row.title}))].map(row=>[row.issue,{number:row.issue,title:row.title.replace(/^[a-z]+:\s*/,''),type:/^([a-z]+):/.exec(row.title)?.[1]??'feat'}]))
 const generated=planParallelRun({groups,issues,parentBranch:parent.branch,parentHead:baseSha,repoRoot:parent.checkout,parentIssue:parent.issue})
 const children:ChildLaunch[]=groups.map(group=>{
  const issue=Number(group.members[0]!.slice(1)),old=known.find(row=>row.task.issue===issue),classification=classifications?.find(row=>row.issue===issue),planned=generated.children.find(row=>row.issue===issue)!,recoveryDisposition=classification?.classification.kind
  if(!old)return {...planned,resources:[],runId:null,scopeDigest:null,taskIds:[],acceptanceCommand:command,parentBinding:null,...(recoveryDisposition?{recoveryDisposition}: {})}
  // Paths and titles describe this new local context; branch/base/source/run and
  // original parent binding come only from the retained verified task.
  return {...planned,branch:old.task.checkpoint!.branch,baseSha:old.task.checkpoint!.baseSha,resources:[...old.task.resources],runId:old.task.runId,scopeDigest:old.task.scopeDigest,taskIds:[...old.task.approvedTaskIds],acceptanceCommand:command,parentBinding:old.task.parentBinding!,...(recoveryDisposition?{recoveryDisposition}: {})}
 })
 if(succession){const completedRuns=new Set(known.filter(row=>!row.local).map(row=>row.task.runId)),recovery={...material.task.recovery!,children:material.task.recovery!.children.filter(row=>!completedRuns.has(row.childRunId)),joins:material.task.recovery!.joins.filter(row=>!completedRuns.has(row.childRunId))},reconciled=reconcileProgressedChildren(succession,recovery);if(reconciled.unfinished.some(task=>!children.some(child=>child.runId===task.runId))||reconciled.accepted.some(join=>!children.some(child=>child.runId===join.childRunId)))throw Error('recovered succession member classification differs')}
 const retainedJoins=material.task.recovery!.joins
 if(retainedJoins.some(join=>!children.some(child=>child.runId===join.childRunId)))throw Error('retained join names a child outside the recovered group')
 let explainedHead=baseSha
 if(new Set(retainedJoins.map(join=>join.childRunId)).size!==retainedJoins.length)throw Error('ambiguous retained child join history')
 for(const joined of retainedJoins){
  const sourceHead=known.find(row=>row.task.runId===joined.childRunId)?.task.checkpoint?.headSha
  if(joined.parentBefore!==explainedHead||joined.fromSha!==sourceHead)throw Error('retained join order or source differs')
  if(joined.state==='accepted'){
   if(!joined.parentAfter||!joined.acceptance||joined.acceptance.sourceSha!==joined.parentAfter)throw Error('retained accepted join is incomplete')
   explainedHead=joined.parentAfter
  }else if(joined.state!=='prepared'||joined.parentAfter!==null||joined.acceptance!==null)throw Error('retained join state is ambiguous')
 }
 if(retainedJoins.some(join=>join.state==='accepted')&&explainedHead!==parent.headSha)throw Error('recovered parent head is not fully explained by ordered accepted joins')
 const record=parseChildrenRecord({schemaVersion:classifications?3:2,parentRunId:parent.runId,parentIssue:parent.issue,repo:parent.repo,parentBranch:parent.branch,baseSha,parentBinding:original,concurrency:Math.min(3,config.subagents.concurrent,groups.length),groups,children})
 return {record,existing:known.filter(row=>row.local).map(row=>({task:row.task,stateCommit:row.stateCommit,checkpoint:row.task.checkpoint!,authorityRequest:row.authorityRequest,checkpointRequest:row.checkpointRequest})),newPreparations:fresh.map(row=>Number(row.group.members[0]!.slice(1))),currentTitles:[...known.map(row=>({issue:row.task.issue,title:row.title})),...fresh.map(row=>({issue:Number(row.group.members[0]!.slice(1)),title:row.title})),...deferred.map(row=>({issue:Number(row.group.members[0]!.slice(1)),title:row.title}))]}
}
export async function installRecoveredChildrenContext(input:{parent:RunRecord;material:import('./dispatch.ts').RemoteRecoveryMaterial;classifications?:import('./dispatch.ts').StoppedGroupClassification[];config:FactoryConfig},transport:{gh?:typeof ghText;target?:import('./shared-claims.ts').CoordinationTarget}={}):Promise<RecoveredChildrenContext> {
  const reconstructed=await reconstructChildrenContext(input,transport),root=runsRoot(input.config.home)
  await currentParentContext(input.parent,reconstructed.record,input.config,transport.gh)
 for(const child of reconstructed.existing){
  const run=await readRun(root,child.task.runId)
  if(run.repo!==child.task.repo||run.issue!==child.task.issue||run.parent!==input.parent.issue||!same(run.execution,child.task.recovery?.execution)||await realpath(run.checkout)!==run.checkout||run.headSha!==child.checkpoint.headSha||run.branch!==child.checkpoint.branch||run.baseSha!==child.checkpoint.baseSha||!same(run.approvalBindings,child.task.approvalBindings)||run.taskKey.scopeDigest!==child.task.scopeDigest||!same(run.authorityRequest,child.authorityRequest)||!same(run.checkpointIntent?.approvalRequest,child.checkpointRequest))throw Error('runtime owner has not reconstructed original child source and checkpoint authority')
  reconstructed.record.children.find(row=>row.runId===run.runId)!.path=run.checkout
 }
 const restoreAcceptedJoins=async()=>{
  for(const joined of input.material.task.recovery!.joins.filter(join=>join.state==='accepted')){
   const child=reconstructed.record.children.find(row=>row.runId===joined.childRunId)
   if(!child){const classified=input.classifications?.find(row=>row.classification.kind==='completed'&&row.classification.joinEvidence.kind==='state-receipt'&&same(row.classification.joinEvidence,joined.evidence));if(classified)continue;throw Error('retained accepted join child unavailable')}
   if(!joined.parentAfter||!joined.acceptance||joined.evidence.kind!=='state-receipt'||joined.acceptance.evidence.kind!=='state-receipt')throw Error('retained accepted join child unavailable')
   const path=joinPath(root,input.parent.runId,joined.childRunId),existing=await readOptional<IntegrationRecord>(path)
   const restored:IntegrationRecord={schemaVersion:1,operationId:joined.operationId,issue:child.issue,runId:joined.childRunId,generation:joined.generation,fromSha:joined.fromSha,baseSha:reconstructed.record.baseSha,parentBefore:joined.parentBefore,parentAfter:joined.parentAfter,accepted:true,reason:'verified historical accepted join',receiptIds:{preparedLink:joined.operationId,accepted:joined.evidence.operationId,acceptedLink:joined.evidence.operationId,acceptance:joined.acceptance.evidence.operationId},state:'accepted',preparedRef:null,acceptedRef:joined}
   validateIntegrationRecord(restored)
   if(existing&&!same(existing,restored))throw Error('retained accepted join differs from local receipt')
   if(!existing)await atomicRunFile(path,restored)
  }
 }
  let existingRecord=await readOptional<ChildrenRecord>(recordPath(root,input.parent.runId))
  if(existingRecord?.schemaVersion===1)existingRecord=await readExecutableChildrenRecord(input.parent,input.config)
  const held=await acquireClaim(join(root,input.parent.runId,'children.lock'),await processIdentity())
 if(held.kind!=='owned')throw Error('child context is owned by another operation')
 try{
  const path=recordPath(root,input.parent.runId),previous=existingRecord??await readOptional<ChildrenRecord>(path)
  if(previous){if(!same(parseChildrenRecord(previous),reconstructed.record))throw Error('existing private child context retained for reconciliation');await restoreAcceptedJoins();return reconstructed}
  await currentParentContext(input.parent,reconstructed.record,input.config,transport.gh)
  await atomicRunFile(path,reconstructed.record)
  await restoreAcceptedJoins()
  return reconstructed
 }finally{await releaseClaim(held.claim)}
}

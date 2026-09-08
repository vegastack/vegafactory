import { configuredExportPolicy, currentPolicySerializer, exportMode, privacyStatus, privacyReason, serializeExport as serializeMeasurement } from './privacy.ts'
// `vegafactory stats` — the four verbs, and the only place the pieces are wired together.
//
// `record` is what the hooks call, so it is built to be uninteresting: it reads one JSON payload on
// stdin, hands it to the parser its `--source` names, and appends. It never prints to a session, it
// never asks a question, and with the policy off it does nothing at all and says so with exit 0.
//
// `push` is dry-run by default — printing what it would copy and the commit it would make — because
// it writes to a shared repository under the operator's own credentials, and a verb that pushes
// just because it was typed is a verb people learn to fear. The automatic callers pass `--commit`.
//
// `show` and `rollup` read the control-room clone and are pure reporting. People-level views are
// gated: your own rows, or a `lead`'s. Everyone can see org totals.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { loadConfiguredPolicy, resolvePeopleReadScope, resolvePolicy } from '../../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { dirname, join, resolve, basename } from 'node:path'
import { parseControlRoomKnob, getPolicySnapshot } from '../control-room.ts'
import { ghJson, ghText, type GhReader } from '../gh.ts'
import { GIT_CREDENTIAL_ARGS } from '../sync.ts'
import {
  fromClaudeSessionEnd, fromCodexSessionEnd, fromSkillHook,
  type CaptureContext, type SkillHookSource,
} from './capture.ts'
import { appendRecord, appendSkillInvocations, takeSkillInvocations, inspectSpool, spoolRoot, outboxRoot, inspectLegacySpool, migrateLegacySpool, type MigrationReport } from './outbox.ts'
import { monthToken, parseMonthToken, repoSegment, statsPolicyFromEffective, type StatsPolicy, type StatsRecord } from './record.ts'
import { pushOutbox, statsClonePath, boundedTelemetryGit, type GitRunner } from './push.ts'
import {
  rollupOrg, rollupRepo, rollupSkills, stableStringify,
  type OrgSummary, type RepoSummary, type SkillsSummary, type TimelineEvent,
} from './rollup.ts'
import { fetchTimelines, collectTaskActivities, activityCoordinationTarget, type TaskActivityCollection, type GhJson } from './timeline.ts'
import { rollupMeasuredRepo, type MeasuredRepoSummary } from './rollup.ts'
import { summarizeExecutions, utcMonthBounds, type SubscriptionFee } from './metrics.ts'
import type { ExportedEvent } from './types.ts'

export type StatsSource = 'managed-hook' | 'claude-session-end' | 'codex-session-end' | 'claude-post-tool' | 'claude-prompt-expansion' | 'codex-prompt'

const SOURCES: readonly StatsSource[] = [
  'managed-hook',
  'claude-session-end', 'codex-session-end', 'claude-post-tool', 'claude-prompt-expansion', 'codex-prompt',
] as const

export interface StatsArgs {
  verb: 'show' | 'record' | 'push' | 'rollup' | 'inspect' | 'migrate' | 'cleanup' | 'export' | 'privacy' | 'activity'
  output?: string
  configPath?: string
  org?: string
  repository?: string
  month?: string
  dryRun?: boolean
  apply?: boolean
  mapping?: string
  report?: string
  scope: 'repo' | 'me' | 'org' | 'skills'
  since: string | null
  json: boolean
  commit: boolean
  source: StatsSource | null
}

export function parseStatsArgs(argv: string[]): StatsArgs {
  const args: StatsArgs = { verb: 'show', scope: 'repo', since: null, json: false, commit: false, source: null }
  const rest = [...argv]
  let scopeSet = false
  const setScope = (scope: StatsArgs['scope']): void => {
    if (scopeSet && args.scope !== scope) throw new Error(`stats takes one of --repo, --me, --org or skills, not both --${args.scope} and --${scope}`)
    args.scope = scope
    scopeSet = true
  }
  if (rest[0] && !rest[0].startsWith('-')) {
    const head = rest.shift()!
    if (head === 'skills') setScope('skills')
    else if (head === 'show' || head === 'record' || head === 'push' || head === 'rollup' || head === 'inspect' || head === 'migrate' || head === 'cleanup' || head === 'export' || head === 'privacy' || head === 'activity') args.verb = head
    else throw new Error(`Unknown stats verb: ${head}`)
  }
  while (rest.length) {
    const flag = rest.shift()!
    if (args.verb === 'activity' && ['--org','--repo','--month'].includes(flag)) {
      const value=rest.shift();if(!value||value.startsWith('-'))throw Error('activity-explicit-scope-required')
      if(flag==='--org')args.org=value;else if(flag==='--repo')args.repository=value;else {utcMonthBounds(value);args.month=value}
    }
    else if (flag === '--repo') setScope('repo')
    else if (flag === '--me') setScope('me')
    else if (flag === '--org') setScope('org')
    else if (flag === '--skills') setScope('skills')
    else if (flag === '--json') args.json = true
    else if (flag === '--commit') args.commit = true
    else if (flag === '--apply') args.apply = true
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--config') {if(args.verb!=='activity')throw Error('activity-config-only');const value=rest.shift();if(!value||value.startsWith('-'))throw Error('activity-config-required');args.configPath=resolve(value)}
    else if (flag === '--output') {const value=rest.shift();if(!value||value.startsWith('--'))throw Error('export-output-required');args.output=value}
    else if (flag === '--mapping' || flag === '--report') {const value=rest.shift();if(!value||value.startsWith('--'))throw Error(flag+' requires a JSON file');args[flag.slice(2) as 'mapping'|'report']=value}
    else if (flag === '--since') {
      const value = rest.shift()
      if (!value || !parseMonthToken(value)) throw new Error(`--since takes a month token in MON-YYYY form, e.g. SEP-2026 — got ${JSON.stringify(value ?? '')}`)
      args.since = value
    }
    else if (flag === '--source') {
      const value = rest.shift() as StatsSource | undefined
      if (!value || !SOURCES.includes(value)) throw new Error(`--source takes one of ${SOURCES.join(', ')} — got ${JSON.stringify(value ?? '')}`)
      args.source = value
    }
    else throw new Error(`Unknown option: ${flag}`)
  }
  if(args.verb==='activity'&&(!args.org||!args.repository||!args.month||args.repository.split('/')[0]!==args.org))throw Error('activity-explicit-scope-required')
  if(args.apply&&args.dryRun)throw Error('cleanup-mode-conflict')
  if(args.verb==='export'&&!args.output)throw Error('export-output-required')
  return args
}

export interface StatsDeps {
  home: string
  exportReader?: import('./types.ts').ExportReader
  measurementRecord?: (event:import('./types.ts').ExportedEvent)=>StatsRecord|null
  readGh?: GhReader
  activityTarget?: (repo:string,gh:GhReader)=>Promise<import('../shared-claims.ts').CoordinationTarget>
  subscriptionFee?: SubscriptionFee | null
  org?: string
  registeredRepos?: string[]
  hostname: string
  ghUser: string
  login: string
  isLead: boolean // descriptive legacy input only; never an authority grant
  policyForRepo?: (repo:string)=>Promise<ReturnType<typeof resolvePolicy>['policy']>
  effectivePolicy?: ReturnType<typeof resolvePolicy>['policy']
  viewerVerified?: boolean
  policy: StatsPolicy
  repo: string | null
  cloneRoot: string
  git: GitRunner
  // The one GitHub API seam: issue timelines, read by `rollup` and by nothing else.
  gh: GhJson
  readStdin: () => Promise<string>
  readTranscript: (path: string) => Promise<string[]>
  now: () => Date
  log: (line: string) => void
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (cells: string[]): string => cells.map((cell, index) => pad(cell, widths[index]!)).join('  ').trimEnd()
  return [line(headers), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)].join('\n')
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

export function renderStatsTable(summary: RepoSummary | OrgSummary | SkillsSummary, scope: StatsArgs['scope']): string {
  if (scope === 'skills') {
    const skills = (summary as SkillsSummary).skills
    const rows = Object.keys(skills).sort().map(name => {
      const entry = skills[name]!
      const triggers = Object.keys(entry.by_trigger).sort().map(key => `${key} ${entry.by_trigger[key]}`).join(', ')
      const harnesses = Object.keys(entry.by_harness).sort().map(key => `${key} ${entry.by_harness[key]}`).join(', ')
      return [name, String(entry.invocations), triggers, harnesses]
    })
    return `skills — ${summary.month}\n${table(['skill', 'runs', 'trigger', 'harness'], rows)}`
  }
  const runs = summary as RepoSummary | OrgSummary
  const stages = runs.by_stage
  const rows = Object.keys(stages).sort().map(stage => {
    const stats = stages[stage]!
    const outcomes = Object.keys(stats.outcomes).sort().map(key => `${key} ${stats.outcomes[key]}`).join(', ')
    return [stage, String(stats.runs), `${Math.round(stats.duration_s / 60)}m`, String(stats.tokens), money(stats.cost_usd), outcomes]
  })
  const heading = 'repo' in runs
    ? `${runs.repo} — ${runs.month} · ${runs.runs} runs · legacy definitions`
    : `org — ${runs.month} · ${runs.runs} runs across ${runs.repos.length} repos · legacy definitions`
  const body = table(['stage', 'runs', 'time', 'tokens', 'cost', 'outcomes'], rows)
  if (!('repo' in runs)) return `${heading}\n${body}`
  const repo = runs
  const lead = repo.lead_time_h.p50 === null ? '—' : `${repo.lead_time_h.p50}h`
  const count = (value: number | null): string => (value === null ? '—' : String(value))
  return `${heading}\n${body}\n\nlead time p50 ${lead} · issues touched ${repo.throughput.issues_touched} · closed ${repo.throughput.issues_closed} · rework: ${count(repo.rework.review_rounds)} review, ${count(repo.rework.fix_rounds)} fix, ${count(repo.rework.handbacks)} handbacks`
}

// --- reading the control room ------------------------------------------------------------

async function monthsUnder(root: string, repoDir: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'stats', repoDir))).filter(entry => parseMonthToken(entry) !== null).sort()
  } catch {
    return []
  }
}

async function readMonth(cloneRoot: string, repoDir: string, month: string): Promise<StatsRecord[]> {
  const dir = join(cloneRoot, 'stats', repoDir, month)
  const records: StatsRecord[] = []
  let files: string[]
  try {
    files = (await readdir(dir)).sort()
  } catch {
    return records
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    let text: string
    try {
      text = await readFile(join(dir, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push((await import('./record.ts')).parseLocalRecord(JSON.parse(line)))
      } catch {
        // one unreadable line never costs the month its summary
      }
    }
  }
  return records
}

async function readTimelines(cloneRoot: string, repoDir: string, month: string): Promise<TimelineEvent[]> {
  const file = join(cloneRoot, 'stats', repoDir, `${month}.timeline.json`)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed) ? parsed as TimelineEvent[] : []
  } catch {
    // Lead and cycle time need issue timelines. Absent, they are reported as null rather than
    // guessed from run timestamps — a run knows nothing about how long its issue waited.
    return []
  }
}

async function repoDirs(cloneRoot: string): Promise<string[]> {
  try {
    return (await readdir(join(cloneRoot, 'stats'),{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name!=='org').map(entry=>entry.name).sort()
  } catch {
    return []
  }
}

function monthsInWindow(months: string[], since: string | null): string[] {
  if (!since) return months
  const from = parseMonthToken(since)
  if (!from) return months
  return months.filter(month => {
    const at = parseMonthToken(month)
    return at !== null && (at.year > from.year || (at.year === from.year && at.month >= from.month))
  })
}

// --- the verbs ---------------------------------------------------------------------------

async function runRecord(args: StatsArgs, deps: StatsDeps): Promise<number> {
  if(args.source === 'managed-hook'){ await (await import('./record.ts')).consumeManagedHook(deps.home,await deps.readStdin()); return 0 }
  if (!deps.policy.enabled) {
    // Not an error and not a warning: the org (or this repo) turned statistics off, and a hook that
    // shouted about it every time a session ended would be its own kind of telemetry.
    return 0
  }
  if (!args.source) {
    deps.log('stats record needs --source <kind>')
    return 2
  }
  const raw = await deps.readStdin()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    deps.log('stats record: the hook payload on stdin is not JSON — nothing was written')
    return 2
  }

  if (args.source === 'claude-post-tool' || args.source === 'claude-prompt-expansion' || args.source === 'codex-prompt') {
    const { sessionId, invocations } = fromSkillHook(payload, args.source as SkillHookSource)
    if (!sessionId || invocations.length === 0) return 0
    await appendSkillInvocations(deps.home, sessionId, invocations)
    return 0
  }

  if (!deps.repo) {
    deps.log('stats record: this working copy names no repo (no .vegastack/dev.md repo: line) — the record was not filed')
    return 1
  }
  const context: CaptureContext = { repo: deps.repo, ts: deps.now().toISOString(), human: deps.ghUser }
  const record = args.source === 'claude-session-end'
    ? fromClaudeSessionEnd(payload, [], context)
    : fromCodexSessionEnd(payload, context)
  if (record.session_id) record.skills = await takeSkillInvocations(deps.home, record.session_id)
  await appendRecord(deps.home, record, deps.hostname)
  return 0
}

async function runPush(args: StatsArgs, deps: StatsDeps): Promise<number> {
  const result = await pushOutbox({
    home: deps.home,
    cloneRoot: deps.cloneRoot,
    ghUser: deps.ghUser,
    hostname: deps.hostname,
    commit: args.commit,
    git: deps.git,
    serialize: currentPolicySerializer(deps.home),
  })
  if (args.json) {
    deps.log(JSON.stringify({ guard: 'stats-push', commit: args.commit, ...result }))
  } else if (!args.commit) {
    const spool=await inspectSpool(spoolRoot(deps.home))
    deps.log(`stats push (dry run): ${spool.events.length} immutable event(s), ${spool.quarantine.length} quarantined; pass --commit for verified delivery`)
  } else if (result.locked) {
    deps.log(`stats push: another push is running on this machine — ${result.deferred.length} file(s) deferred to the next attempt`)
  } else {
    deps.log(`stats push: ${result.pushed} records, ${result.retries} rebase retries, ${result.deferred.length} deferred`)
  }
  for (const refusal of result.refusals) deps.log(refusal)
  if (result.refusals.length > 0) return 2
  return result.ok ? 0 : 1
}

interface WindowBucket { dir: string; repo: string; month: string; records: StatsRecord[]; events: ExportedEvent[]; history?:ExportedEvent[]; timelines: TimelineEvent[] }

// Every (repo, month) bucket in the window. `--since SEP-2026` means "September onward", so a
// window can hold several months and several repos, and a caller that wants one repo filters here
// rather than picking the first bucket and hoping.
async function windowBuckets(deps: StatsDeps, since: string | null): Promise<WindowBucket[]> {
  const buckets: WindowBucket[] = []
  for (const dir of await repoDirs(deps.cloneRoot)) {
    for (const month of monthsInWindow(await monthsUnder(deps.cloneRoot, dir), since)) {
      const records = await readMonth(deps.cloneRoot, dir, month)
      if (records.length === 0) continue
      buckets.push({
        dir,
        repo: records[0]?.repo ?? dir,
        month,
        records,
        events: [],
        timelines: await readTimelines(deps.cloneRoot, dir, month),
      })
    }
  }
  const batch=await(await import('./rollup.ts')).readControlRoomEvents(deps.cloneRoot,deps.exportReader)
  if(batch.invalid.length)throw Error(`stats events refused: ${batch.invalid.length} invalid; ${batch.invalid[0]!.reason}`)
  for(const row of batch.events){
    const event=row.event,month=monthToken(new Date(event.payload.utcDay)),repo=event.destination.repo
    if(!monthsInWindow([month],since).length)continue
    const dir=basename(dirname(dirname(dirname(row.source))))
    let bucket=buckets.find(b=>b.repo===repo&&b.month===month)
    if(!bucket){bucket={dir,repo,month,records:[],events:[],timelines:await readTimelines(deps.cloneRoot,dir,month)};buckets.push(bucket)}
    bucket.events.push(event)
  }
  for(const bucket of buckets)bucket.history=batch.events.filter(row=>row.event.destination.repo===bucket.repo&&row.event.payload.recordKind!=='execution').map(row=>row.event)
  return buckets
}

// The label a summary carries when the window is more than one month: a table headed "SEP-2026"
// while it totals three months would be a lie in the one place a reader looks first.
function windowLabel(buckets: WindowBucket[], fallback: string): string {
  // Chronological, never alphabetical: sorting the tokens as strings puts AUG before SEP before
  // OCT of the same year only by luck, and reads "OCT-2026…SEP-2026" the rest of the time.
  const months = [...new Set(buckets.map(bucket => bucket.month))].sort((a, b) => {
    const left = parseMonthToken(a)
    const right = parseMonthToken(b)
    if (!left || !right) return a.localeCompare(b)
    return left.year - right.year || left.month - right.month
  })
  if (months.length === 0) return fallback
  if (months.length === 1) return months[0]!
  return `${months[0]}…${months[months.length - 1]}`
}

// One summary per repo across the whole window, so `--since` totals rather than picks.
function summariesByRepo(buckets: WindowBucket[], people: boolean, fallback: string): RepoSummary[] {
  const byRepo = new Map<string, WindowBucket[]>()
  for (const bucket of buckets) byRepo.set(bucket.repo, [...(byRepo.get(bucket.repo) ?? []), bucket])
  return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repo, group]) => rollupRepo(
    group.flatMap(bucket => bucket.records),
    group.flatMap(bucket => bucket.timelines),
    { repo, month: windowLabel(group, fallback), people },
  ))
}

function calendarMonth(token:string):string {
  const parsed=parseMonthToken(token)
  if(!parsed){utcMonthBounds(token);return token}
  return `${parsed.year}-${String(parsed.month).padStart(2,'0')}`
}
async function readActivities(deps:StatsDeps,repo:string,period:string):Promise<TaskActivityCollection|null>{
  try{
    const {parseActivityCollection}=await import('./timeline.ts')
    return parseActivityCollection(JSON.parse(await readFile(join(deps.cloneRoot,'stats',repoSegment(repo),`${period}.activity.json`),'utf8')),repo)
  }catch{return null}
}
async function authorizedActivity(repo:string,org:string,deps:StatsDeps):Promise<ReturnType<typeof resolvePolicy>['policy']>{
  if(!deps.login||deps.viewerVerified!==true)throw Error('privacy-viewer-unavailable')
  const policy=await currentReadPolicy(deps,repo)
  if(policy.registry.org!==org||repo.split('/')[0]!==org)throw Error('privacy-selected-organization-mismatch')
  const scope=resolvePeopleReadScope({viewer:{login:deps.login,verified:true},subject:null,policy,administration:policy.administration,repoGroups:policy.registry.repoGroups,requestedRepos:[repo]})
  if(scope.refusal||!scope.allowedRepos.includes(repo))throw Error('privacy-read-scope-refused')
  if(exportMode(policy as import('./privacy.ts').ExportPolicy)!=='attributed')throw Error('privacy-task-reporting-unavailable')
  return policy
}
async function collectForRepo(repo:string,period:string,deps:StatsDeps):Promise<TaskActivityCollection>{
  const policy=await authorizedActivity(repo,repo.split('/')[0]!,deps)
  return collectTaskActivities({repo,period,gh:deps.readGh??ghText,prior:await readActivities(deps,repo,period),coordination:async gh=>deps.activityTarget?deps.activityTarget(repo,gh):activityCoordinationTarget(deps.home,policy,gh)})
}
async function runActivity(args:StatsArgs,deps:StatsDeps):Promise<number>{
  if(!args.org||!args.repository||!args.month)throw Error('activity-explicit-scope-required')
  await authorizedActivity(args.repository,args.org,deps)
  const collection=await collectForRepo(args.repository,args.month,deps)
  deps.log(JSON.stringify({schemaVersion:2,metricVersion:2,org:args.org,repo:args.repository,period:args.month,...collection}))
  return collection.complete?0:1
}
function renderMeasured(summary:MeasuredRepoSummary):string {
  const display=(value:number|null)=>value===null?'unavailable':String(value)
  const cost=summary.execution.values.costUsd
  return `${summary.repo} — ${summary.month} · metric v2\n${summary.runs} terminal segments · ${summary.execution.logicalExecutions} logical executions\nMerged into main: ${display(summary.taskActivity.mergedIssues)} issues / ${display(summary.taskActivity.mergedTasks)} tasks · implemented: ${display(summary.taskActivity.implementedTasks)} · released: ${display(summary.taskActivity.releasedTasks)}\nReported cost USD ${display(cost.value)} (${cost.known} known, ${cost.unknown} unknown) · operator minutes ${display(summary.execution.operatorMinutes.value)}\nMonthly rework: ${display(summary.taskActivity.reviewRounds)} review, ${display(summary.taskActivity.fixRounds)} corrections, ${display(summary.taskActivity.handbacks)} handbacks\nAPI-equivalent estimate USD ${display(summary.execution.apiEquivalentUsd.value)} · subscription fee ${summary.execution.subscriptionFee?`${summary.execution.subscriptionFee.amount} ${summary.execution.subscriptionFee.currency} / ${summary.execution.subscriptionFee.period}`:'unavailable'}\n${summary.discovery.complete?'Complete source discovery':`Task coverage unavailable; observed ${summary.discovery.observedAt??'never'}`} · cache-token inclusion unknown · skill costs nonadditive${summary.legacy?'\nHistorical legacy definitions are reported separately.':''}`
}

async function runRollup(args: StatsArgs, deps: StatsDeps): Promise<number> {
  if(!deps.login||deps.viewerVerified!==true)throw Error('privacy-viewer-unavailable')
  const month=args.since??monthToken(deps.now()),period=calendarMonth(month),written:string[]=[],unreachable:string[]=[]
  const raw=await windowBuckets(deps,month)
  const repoSet=new Set(raw.map(bucket=>bucket.repo))
  for(const repo of deps.registeredRepos??[])repoSet.add(repo)
  if(deps.repo)repoSet.add(deps.repo)
  for(const repo of repoSet)if(!raw.some(bucket=>bucket.repo===repo&&bucket.month===month))raw.push({dir:repoSegment(repo),repo,month,records:[],events:[],timelines:[]})
  const buckets=(await scopedBuckets(raw,args,deps)).filter(bucket=>bucket.month===month)
  if(!buckets.length)throw Error('privacy-read-scope-refused')
  const summaries:MeasuredRepoSummary[]=[]
  for(const bucket of buckets){
    let collection:TaskActivityCollection|null=null
    try{collection=await collectForRepo(bucket.repo,period,deps)}catch{unreachable.push(`${bucket.repo}: activity-source-unavailable`)}
    if(collection&&!collection.complete)unreachable.push(`${bucket.repo}: ${collection.reason}`)
    const summary=rollupMeasuredRepo([...bucket.events,...(bucket.history??[])],{repo:bucket.repo,month:period,collection,legacy:bucket.records})
    summaries.push(summary)
    const directory=join(deps.cloneRoot,'stats',repoSegment(bucket.repo))
    await mkdir(directory,{recursive:true})
    if(collection){const path=join(directory,`${period}.activity.json`);await writeFile(path,stableStringify(collection)+'\n');written.push(path)}
    const path=join(directory,`${month}.summary.json`);await writeFile(path,stableStringify(summary)+'\n');written.push(path)
  }
  // An organization summary belongs to this authorized scope; scope metadata
  // prevents a cached fallback from presenting it as an unbounded total.
  const report={schemaVersion:2,metricVersion:2,month:period,allowedRepos:buckets.map(b=>b.repo).sort(),execution:summarizeExecutions(buckets.flatMap(b=>b.events),deps.subscriptionFee),repos:summaries}
  const orgPath=join(deps.cloneRoot,'stats','org',`${month}.summary.json`)
  await mkdir(dirname(orgPath),{recursive:true});await writeFile(orgPath,stableStringify(report)+'\n');written.push(orgPath)
  deps.log(args.json?JSON.stringify({guard:'stats-rollup',month,written,unreachable,report}):`stats rollup ${month}: ${written.length} files regenerated; ${unreachable.length} unavailable source(s)`)
  return unreachable.length?1:0
}

async function currentReadPolicy(deps:StatsDeps,repo:string):Promise<ReturnType<typeof resolvePolicy>['policy']>{
  const policy=deps.policyForRepo?await deps.policyForRepo(repo):deps.effectivePolicy
  if(!policy||policy.repo!==repo)throw Error('privacy-current-policy-unavailable')
  return policy
}
async function scopedBuckets(buckets:WindowBucket[],args:StatsArgs,deps:StatsDeps):Promise<WindowBucket[]>{
  const result:WindowBucket[]=[]
  for(const repo of [...new Set(buckets.map(b=>b.repo))]){
    if(deps.repo&&['repo','me'].includes(args.scope)&&repo!==deps.repo)continue
    const policy=await currentReadPolicy(deps,repo),mode=exportMode(policy as import('./privacy.ts').ExportPolicy)
    if(mode==='off')continue
    if(args.scope==='me'&&mode!=='attributed')throw Error('privacy-person-reporting-unavailable')
    const scope=resolvePeopleReadScope({viewer:{login:deps.login,verified:deps.viewerVerified===true},subject:args.scope==='me'?deps.login:null,policy,administration:policy.administration,repoGroups:policy.registry.repoGroups,requestedRepos:[repo]})
    if(scope.refusal||!scope.allowedRepos.includes(repo)){if(args.scope==='org'||args.scope==='skills')continue;throw Error('privacy-read-scope-refused')}
    for(const bucket of buckets.filter(b=>b.repo===repo)){
      const events:ExportedEvent[]=[],history:ExportedEvent[]=[]
      for(const event of [...bucket.events,...(bucket.history??[])]){
        if(args.scope==='me'&&event.payload.taskOwner!==deps.login)continue
        const wire=serializeMeasurement(event.payload,event.destination,event.eventId,policy as import('./privacy.ts').ExportPolicy)
        if(wire){const projected=(await import('./privacy.ts')).readExport(JSON.stringify(wire));if(bucket.events.includes(event))events.push(projected);else history.push(projected)}
      }
      result.push({...bucket,events,history,records:bucket.records.filter(r=>r.repo===repo&&(args.scope!=='me'||r.human===deps.login)).map(r=>mode==='attributed'?r:{...r,issue:null,parent:null,human:null,review_rounds:null,fix_rounds:null,handbacks:null})})
    }
  }
  return result
}
async function runCleanup(args:StatsArgs,deps:StatsDeps):Promise<number>{
  try{
    const {cleanupDelivered,cleanupBasicLogs,configuredRetentionActive}=await import('./push.ts')
    const spool=await inspectSpool(spoolRoot(deps.home)),destinations=spool.events.filter(e=>!deps.repo||e.destination.repo===deps.repo).map(e=>e.destination)
    const now=deps.now()
    if(!args.apply){
      const reports=await cleanupDelivered(spoolRoot(deps.home),{now,dryRun:true,destinations,controller:{active:configuredRetentionActive(deps.home),removeActiveReport:async()=>{throw Error('retention-dry-run-removal-refused')}}})
      const diagnostics=await cleanupBasicLogs(deps.home,now,{dryRun:true})
      deps.log(JSON.stringify({mode:'dry-run',reports,diagnostics,history:'Git history, clones, source checkpoints and recovery identity are retained.'}));return 0
    }
    const results=[]
    const unique=new Map(destinations.map(d=>[JSON.stringify(d),d]))
    for(const destination of unique.values())results.push(await pushOutbox({home:deps.home,cloneRoot:deps.cloneRoot,ghUser:deps.ghUser,hostname:deps.hostname,commit:true,git:deps.git,cleanupOnly:true,destination,now:deps.now}))
    const diagnostics=await cleanupBasicLogs(deps.home,now)
    deps.log(JSON.stringify({mode:'apply',reports:results,diagnostics,history:'Active-file removal does not erase Git history or clones.'}))
    return results.every(result=>result.ok)?0:2
  }catch(error){deps.log(privacyReason(error));return 2}
}
async function runExport(args:StatsArgs,deps:StatsDeps):Promise<number>{
  try{
    if(!args.output)throw Error('privacy-export-output-required')
    if(!deps.login||deps.viewerVerified!==true)throw Error('privacy-viewer-unavailable')
    const batch=await(await import('./rollup.ts')).readControlRoomEvents(deps.cloneRoot,deps.exportReader)
    if(batch.invalid.length)throw Error('privacy-export-invalid-records')
    const lines:string[]=[]
    for(const row of batch.events){
      const event=row.event,repo=event.destination.repo
      if(args.since&&!monthsInWindow([monthToken(new Date(event.payload.utcDay))],args.since).length)continue
      if(deps.repo&&['repo','me'].includes(args.scope)&&repo!==deps.repo)continue
      const policy=await currentReadPolicy(deps,repo)
      const scope=resolvePeopleReadScope({viewer:{login:deps.login,verified:deps.viewerVerified===true},subject:args.scope==='me'?deps.login:null,policy,administration:policy.administration,repoGroups:policy.registry.repoGroups,requestedRepos:[repo]})
      if(scope.refusal||!scope.allowedRepos.includes(repo))throw Error('privacy-read-scope-refused')
      if(args.scope==='me'&&event.payload.taskOwner!==deps.login)continue
      const wire=serializeMeasurement(event.payload,event.destination,event.eventId,policy as import('./privacy.ts').ExportPolicy)
      if(wire)lines.push(JSON.stringify(wire))
    }
    const {open}=await import('node:fs/promises'),file=await open(resolve(args.output),'wx',0o600)
    try{await file.writeFile(lines.join('\n')+(lines.length?'\n':''));await file.sync()}finally{await file.close()}
    deps.log(JSON.stringify({exported:lines.length,mode:'private-file',history:'Existing Git history and clones are unchanged.'}));return 0
  }catch(error){deps.log(privacyReason(error));return 2}
}

async function runShow(args: StatsArgs, deps: StatsDeps): Promise<number> {
  if(!deps.login||deps.viewerVerified!==true)throw Error('privacy-viewer-unavailable')
  const fallback = args.since ?? monthToken(deps.now())
  const subject = deps.login
  if(deps.repo)await scopedBuckets([{dir:repoSegment(deps.repo),repo:deps.repo,month:fallback,records:[],events:[],timelines:[]}],args,deps)
  let people = false
  let buckets = await windowBuckets(deps, args.since ?? fallback)
  if(!args.since)buckets=buckets.filter(bucket=>bucket.month===fallback)
  for(const repo of new Set([...(deps.registeredRepos??[]),...(deps.repo?[deps.repo]:[])]))if(!buckets.some(bucket=>bucket.repo===repo&&bucket.month===fallback))buckets.push({dir:repoSegment(repo),repo,month:fallback,records:[],events:[],timelines:[]})
  buckets = await scopedBuckets(buckets,args,deps)
  if(!buckets.length)throw Error('privacy-read-scope-refused')
  people = args.scope === 'me'
  const label = windowLabel(buckets, fallback)
  const typed=buckets.flatMap(bucket=>bucket.events)
  const cached=new Map<string,TaskActivityCollection>()
  if(args.scope!=='me')for(const bucket of buckets)try{await authorizedActivity(bucket.repo,bucket.repo.split('/')[0]!,deps);const c=await readActivities(deps,bucket.repo,calendarMonth(bucket.month));if(c)cached.set(bucket.repo+'@'+bucket.month,c)}catch{/* No current task read authority. */}
  if(typed.length||cached.size){
    const reports:MeasuredRepoSummary[]=[]
    for(const bucket of buckets){
      const period=calendarMonth(bucket.month)
      const collection=cached.get(bucket.repo+'@'+bucket.month)??null
      reports.push(rollupMeasuredRepo([...bucket.events,...(bucket.history??[])],{repo:bucket.repo,month:period,collection,legacy:bucket.records,person:args.scope==='me'}))
    }
    if(args.scope==='skills'){
      const skills:Record<string,{executionEvents:number;costUsd:ReturnType<typeof import('./metrics.ts').summarizeMeasured>;association:'nonadditive'}>={}
      const names=new Set(typed.flatMap(event=>event.payload.recordKind==='execution'?(event.payload.skills??[]).map(hit=>hit.name):[]))
      for(const name of names){const associated=typed.filter(event=>event.payload.recordKind==='execution'&&event.payload.skills?.some(hit=>hit.name===name));const measured=summarizeExecutions(associated);skills[name]={executionEvents:associated.length,costUsd:{total:measured.values.costUsd.value,known:measured.values.costUsd.known,unknown:measured.values.costUsd.unknown},association:'nonadditive'}}
      deps.log(JSON.stringify({schemaVersion:2,metricVersion:2,month:label,skills}));return 0
    }
    const report=reports.length===1&&args.scope!=='org'?reports[0]!:{schemaVersion:2,metricVersion:2,month:label,execution:summarizeExecutions(typed,deps.subscriptionFee),repos:reports}
    deps.log(args.json?stableStringify(args.scope==='me'?{...report,subject:deps.login,dimension:'task-owner'}:report):reports.map(renderMeasured).join('\n\n'));return 0
  }

  if (args.scope === 'skills') {
    const summary = rollupSkills(buckets.flatMap(bucket => bucket.records), { month: label })
    deps.log(args.json ? stableStringify({...summary,metricVersion:1,definitionLabel:'legacy definitions'}) : renderStatsTable(summary, 'skills'))
    return 0
  }
  if (args.scope === 'org') {
    const summary = rollupOrg(summariesByRepo(buckets, people, fallback), { month: label, people })
    deps.log(args.json ? stableStringify({...summary,metricVersion:1,definitionLabel:'legacy definitions'}) : renderStatsTable(summary, 'org'))
    return 0
  }

  // repo and me: this repo when the working copy names one, and for `--me` only the rows whose
  // `human` is the subject — a `--me` table showing the whole repo would be the wrong answer
  // delivered confidently.
  const mine = deps.repo ? buckets.filter(bucket => bucket.repo === deps.repo) : buckets
  const scoped = args.scope === 'me'
    ? mine.map(bucket => ({ ...bucket, records: bucket.records.filter(record => record.human === subject) }))
    : mine
  const records = scoped.flatMap(bucket => bucket.records)
  if (records.length === 0) {
    const what = args.scope === 'me' ? `no runs of yours (${subject})` : 'no records'
    deps.log(args.json
      ? JSON.stringify({ guard: 'stats-show', month: label, scope: args.scope, records: 0 })
      : `${what} for ${label} in ${deps.cloneRoot}`)
    return 0
  }
  const summary = rollupRepo(records, scoped.flatMap(bucket => bucket.timelines), {
    repo: args.scope === 'me' ? `${subject} · ${deps.repo ?? 'every repo'}` : (deps.repo ?? scoped[0]!.repo),
    month: label,
    people: people || args.scope === 'me',
  })
  deps.log(args.json ? stableStringify({...summary,metricVersion:1,definitionLabel:'legacy definitions'}) : renderStatsTable(summary, args.scope))
  return 0
}

export async function runStats(args: StatsArgs, deps: StatsDeps): Promise<number> {
  if (deps.policy.refusal) {
    deps.log('privacy-policy-refused')
    return 2
  }
  try {
  if (args.verb === 'activity') return await runActivity(args,deps)
  if (args.verb === 'privacy') {deps.log(JSON.stringify(await privacyStatus(deps.home,deps.effectivePolicy as import('./privacy.ts').ExportPolicy|undefined,deps.repo??undefined)));return 0}
  if (args.verb === 'export') return runExport(args,deps)
  if (args.verb === 'cleanup') return runCleanup(args,deps)
  if (args.verb === 'record') return await runRecord(args, deps)
  if (args.verb === 'push') return await runPush(args, deps)
  if (args.verb === 'inspect' || args.verb === 'migrate') return runStatsMaintenance(args,deps.home,deps.log)
    if (args.verb === 'rollup') return await runRollup(args, deps)
    return await runShow(args, deps)
  } catch(error) {deps.log(privacyReason(error));return 2}
}

export function statsUsage(): string {
  return `Usage: vegafactory stats [--repo|--me|--org|skills] [--since MON-YYYY] [--json]
       vegafactory stats push [--commit] [--json]
       vegafactory stats rollup [--since MON-YYYY] [--json]   (reads issue timelines through gh)
       vegafactory stats activity --org ORG --repo OWNER/NAME --month YYYY-MM --json [--config PATH]
       vegafactory stats record --source <kind>      (called by the harness hooks)
       vegafactory stats inspect [--json]
       vegafactory stats migrate [--json]
       vegafactory stats migrate --apply --report <JSON-file> --mapping <JSON-file>

Where agent time and money went, from the org's own control room. Records are counts and
identifiers only — no prompt text, no assistant text, no tool arguments, ever.

  --repo         this repository's month (the default)
  --me           your own rows; explicit org administration controls scoped people reads
  --org          every repo in the org, totalled
  skills         invocations per skill, by trigger and harness
  --since        the month to report, e.g. SEP-2026 (default: this month, UTC)

push is a dry run until --commit. Whether anything is recorded at all is org policy:
stats: / stats-people: in org.md or group.md, and a repo opt-out only under
stats-override: allowed. There is no machine-level knob.

Exit 0 done · 1 deferred (a push that will retry) · 2 a refusal.
Outbox: ~/.vegastack/stats/events-v2 (immutable private envelopes and receipts).
Legacy JSONL stays unchanged. migrate prints a dry-run report; applying requires the saved
exact report and an explicit JSON mapping from code repository to Destination.
stats privacy --json reports current mode, recipients, pending bytes and disk pressure.
stats export --output <file> writes a scoped current-policy export privately and exclusively.
stats cleanup --dry-run|--apply selects inactive basic logs after14days and acknowledged
reports after12calendar months; pending/recovery identities are held. Shared report removal
requires an authorized writer; historical Git data and clones are not erased.
Managed hooks use --source managed-hook and silently refuse unknown cwd/session identity.
`
}

// --- wiring ------------------------------------------------------------------------------
//
// The effectful half: where the project is, which control room it belongs to, who is asking, and
// how git is run. Kept below the pure surface above so every branch that decides anything stays
// unit-testable, and this part stays small enough to read as configuration.

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// Walks up from the working directory, the way every other verb finds the project.
export async function findDevMd(from: string): Promise<{ path: string; text: string } | null> {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, '.vegastack', 'dev.md')
    const text = await readIfPresent(candidate)
    if (text !== null) return { path: candidate, text }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function repoFromDevMd(text: string): string | null {
  const match = /^repo:\s*([^\s·#]+)/m.exec(text ?? '')
  return match?.[1] && match[1].includes('/') ? match[1] : null
}

// A `lead` in the org's people.csv may read another person's rows. The header names the columns, so
// a control room that adds one does not silently move the role into a different position.
export function isLeadIn(peopleCsv: string | null, login: string): boolean {
  if (!peopleCsv) return false
  const lines = peopleCsv.trim().split('\n')
  const header = (lines.shift() ?? '').split(',').map(cell => cell.trim().toLowerCase())
  const loginAt = header.indexOf('login')
  const roleAt = header.indexOf('role')
  if (loginAt < 0 || roleAt < 0) return false
  for (const line of lines) {
    const cells = line.split(',').map(cell => cell.trim())
    if (cells[loginAt] === login) return cells[roleAt]?.toLowerCase() === 'lead'
  }
  return false
}

function defaultGit(): GitRunner { return boundedTelemetryGit(GIT_CREDENTIAL_ARGS) }

export async function buildStatsDeps(home: string, cwd: string, log: (line: string) => void, githubIdentity: () => Promise<{ login?: unknown; id?: unknown }> = () => ghJson(['api', 'user']), settingsPath=join(home,'.vegastack','factory.json')): Promise<StatsDeps> {
  const project = await findDevMd(cwd)
  const devMd = project?.text ?? ''
  const knob = parseControlRoomKnob(devMd)
  // Requester authority comes from the authenticated GitHub context, never an env override,
  // operators prose, display role or OS account. An unavailable identity remains unknown.
  let ghUser = ''
  try {
    const user = await githubIdentity()
    if (typeof user.login === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(user.login)
      && typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0) ghUser = user.login.toLowerCase()
  } catch { /* No requester authority while identity cannot be verified. */ }
  const effective = knob?(await getPolicySnapshot(knob.org,repoFromDevMd(devMd)??'',Date.now(),{settingsPath,devMd})).policy:loadConfiguredPolicy({home,repo:repoFromDevMd(devMd)??'',devMd})
  const configuredPolicyFor=async (repo:string)=>{
    const {readPrivateRunFile}=await import('../runs.ts')
    const settings=JSON.parse(await readPrivateRunFile(settingsPath)) as {repos?:Array<{repo:string;org:string;path:string}>;controlRooms?:Record<string,{repo:string}>}
    const rows=settings.repos?.filter(row=>row.repo===repo)??[],row=rows[0],room=row?settings.controlRooms?.[row.org]:null
    if(rows.length!==1||!row||!room||room.repo.split('/')[0]!==row.org||repo.split('/')[0]!==row.org)throw Error('privacy-destination-unregistered')
    const snapshot=await getPolicySnapshot(row.org,repo,Date.now(),{settingsPath,devMd:await readFile(join(row.path,'.vegastack','dev.md'),'utf8')}),resolved=snapshot.policy
    if(snapshot.state!=='fresh'||!resolved.ok||resolved.policy.repo!==repo)throw Error('privacy-current-policy-unavailable')
    exportMode(resolved.policy as import('./privacy.ts').ExportPolicy)
    return resolved.policy
  }
  return {
    home,
    org: knob?.org,
    measurementRecord: (await import('./record.ts')).measurementRecord,
    readGh: ghText,
    activityTarget: async (repo,gh)=>activityCoordinationTarget(home,await configuredPolicyFor(repo),gh),
    hostname: hostname(),
    ghUser,
    login: ghUser,
    isLead: false,
    viewerVerified: ghUser !== '',
    effectivePolicy: knob ? effective.policy : undefined,
    policyForRepo: configuredPolicyFor,
    policy: statsPolicyFromEffective(effective),
    repo: repoFromDevMd(devMd),
    cloneRoot: statsClonePath(home, knob?.org ?? 'org'),
    git: defaultGit(),
    gh: args => ghJson(args),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    },
    readTranscript: async (path: string) => (await readIfPresent(path))?.split('\n') ?? [],
    now: () => new Date(),
    log,
  }
}

export async function runStatsCli(argv: string[], home: string): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(statsUsage())
    return 0
  }
  let args: StatsArgs
  try {
    args = parseStatsArgs(argv)
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    return 2
  }
  if(args.verb === 'inspect' || args.verb === 'migrate') return runStatsMaintenance(args,home,line=>console.log(line))
  if(args.verb === 'record' && args.source === 'managed-hook') {
    // Branch before identity/network, transcript readers, or caller-cwd configuration discovery.
    const raw = await new Promise<string|null>(resolveInput => {
      let bytes=0; const chunks:Buffer[]=[]
      const finish=(value:string|null)=>{clearTimeout(timer);process.stdin.off('data',data);process.stdin.off('end',end);process.stdin.off('error',error);process.stdin.pause();resolveInput(value)}
      const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>64*1024)finish(null);else chunks.push(chunk)}
      const end=()=>finish(Buffer.concat(chunks).toString('utf8')),error=()=>finish(null)
      const timer=setTimeout(()=>finish(null),350)
      process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.once('error',error)
    })
    if(raw===null)return 0
    let timer:ReturnType<typeof setTimeout>|undefined
    try { await Promise.race([(await import('./record.ts')).consumeManagedHook(home,raw),new Promise(resolveFlush=>{timer=setTimeout(resolveFlush,500)})]) } catch { /* Hooks refuse silently; timeout is not a persistence receipt. */ } finally {if(timer)clearTimeout(timer)}
    return 0
  }
  let cwd=process.cwd()
  if(args.verb==='activity'){
    try{
      const {readPrivateRunFile}=await import('../runs.ts')
      const settings=JSON.parse(await readPrivateRunFile(args.configPath??join(home,'.vegastack','factory.json'))) as {repos?:Array<{repo:string;org:string;path:string}>}
      const row=settings.repos?.find(row=>row.repo===args.repository&&row.org===args.org)
      if(!row)throw Error('privacy-destination-unregistered')
      cwd=row.path
    }catch{console.log('privacy-destination-unregistered');return 2}
  }
  const deps = await buildStatsDeps(home, cwd, line => console.log(line),undefined,args.configPath)
  return runStats(args, deps)
}

export async function runStatsMaintenance(args:StatsArgs,home:string,log:(line:string)=>void):Promise<number>{
  try{
    if(args.verb==='inspect'){
      const spool=await inspectSpool(spoolRoot(home))
      const {readDeliveryReceipt}=await import('./push.ts')
      const dispositions=await Promise.all(spool.events.map(async e=>({eventId:e.eventId,destination:e.destination,delivered:!!await readDeliveryReceipt(spoolRoot(home),e)})))
      log(JSON.stringify({schemaVersion:2,events:dispositions,pendingBytes:spool.pendingBytes,oldestAgeMs:spool.oldestAgeMs,quarantine:spool.quarantine}))
      return 0
    }
    if(args.apply){
      if(!args.report||!args.mapping)throw Error('migration apply requires --report and --mapping JSON files')
      const report=JSON.parse(await readFile(args.report,'utf8')) as MigrationReport
      if(report.sourceRoot!==resolve(outboxRoot(home)))throw Error('migration report belongs to another local spool')
      const mapping=JSON.parse(await readFile(args.mapping,'utf8')) as Record<string,import('./types.ts').Destination>
      log(JSON.stringify(await migrateLegacySpool(report,mapping,{root:spoolRoot(home),apply:true})))
    }else log(JSON.stringify(await inspectLegacySpool(outboxRoot(home))))
    return 0
  }catch(error){log(privacyReason(error));return 2}
}

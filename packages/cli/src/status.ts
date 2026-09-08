import { privacyStatus, privacyReason, type PrivacyStatus } from './stats/privacy.ts'
import { verifiedSharedTarget, durableRecoverySummary } from './dispatch.ts'
import { readRuns, runsRoot, type RunRecord, type TerminalCause } from './runs.ts'
import { readSharedStatus, type CoordinationTarget, type SharedStatus } from './shared-claims.ts'
import { labelsDigest, resolveState, resolveLabels } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { boundedGhJson, readBudget } from './gh.ts'
import type { LabelMap, State } from './config.ts'
// `vegafactory status` — one screen answering "is the factory running, and what is it doing?".
// Four sources, none of them authoritative on its own: the dispatcher's lock and state file say
// whether it is alive and when it last ticked, the board says what is waiting, the worktrees say
// what is checked out, and the run logs say how the last runs ended.
//
// The report is built as data and rendered separately, so `--json` and the human view can never
// disagree about what was found.
import { getPolicySnapshot, parseControlRoomKnob } from './control-room.ts'
import { repoPolicyFromEffective } from './config.ts'
import type { BoardIssue, DispatchState } from './dispatch.ts'
import type { FactoryConfig, RepoPolicy, Stage } from './config.ts'

export interface WorktreeRow { path: string; branch: string; issue: number | null; state: string }

export interface RunSummary {
  recovery?:ReturnType<typeof durableRecoverySummary>
  runId?: string
  state?: string
  terminationCause?: TerminalCause | null
  pendingDelivery?: number
  lastError?: string | null
  issue: number
  stage: Stage
  startedAt: string
  exitCode: number | null
  lastMessage: string
  logFile: string
}

export interface WorkflowStateSnapshot {
  repo: string
  policyDigest: string
  observedAt: string
  complete: boolean
  labelMap: LabelMap | null
  blocks: string[]
  issues: { number: number; nodeId: string; labelsDigest: string; state: State | null; blocks: string[] }[]
}

export interface RepoStatus {
  shared?: SharedStatus
  workflow?: WorkflowStateSnapshot
  repo: string
  dispatch: 'off' | 'local'
  board: { needsPlan: number; ready: number; working: number; forOperator: number }
  worktrees: WorktreeRow[]
  runs: RunSummary[]
  snapshot?: { state: string; sourceCommit: string | null; policyDigest: string | null; validatedAt: string | null; ageSeconds: number | null; reason: string | null; machine?: Awaited<ReturnType<typeof getPolicySnapshot>>['machine'] }
}

export interface StatusReport {
  privacy?: PrivacyStatus[]
  dispatcher: { running: boolean; pid: number | null; lastTick: string | null; interval: number; refusal?: string }
  repos: RepoStatus[]
}

interface LogRow {
  at?: string
  event?: string
  stream?: string
  text?: string
  exitCode?: number | null
  issue?: number
  stage?: Stage
}

function rowsOf(jsonl: string): LogRow[] {
  const rows: LogRow[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line) as LogRow)
    } catch {
      // A truncated last line is normal for a log still being written; skipping it is the whole
      // reason status reads the file line by line rather than parsing it as one document.
    }
  }
  return rows
}

export function summariseLog(jsonl: string): { exitCode: number | null; lastMessage: string } {
  const rows = rowsOf(jsonl)
  const exit = [...rows].reverse().find(row => row.event === 'exit')
  const message = [...rows].reverse().find(row => typeof row.text === 'string' && row.text.trim() !== '')
  return { exitCode: exit ? exit.exitCode ?? null : null, lastMessage: (message?.text ?? '').trim() }
}

export function buildStatus(input: {
  config: FactoryConfig
  state: DispatchState
  lockPid: number | null
  lockRefusal?: string
  repos: { repo: string; policy: RepoPolicy; shared?: SharedStatus; snapshot?: RepoStatus['snapshot']; boardComplete?: boolean; boardReason?: string | null; observedAt?: string; board: BoardIssue[]; worktrees: WorktreeRow[]; logs: { file: string; body: string }[]; durableRuns?: RunRecord[]; runRefusal?: string }[]
}): StatusReport {
  const repos: RepoStatus[] = input.repos.map(entry => {
    let labelMap: LabelMap | null = null
    const blocks = [entry.policy.refusal, entry.boardReason, entry.snapshot?.reason, entry.runRefusal].filter((reason): reason is string => Boolean(reason))
    try { labelMap = resolveLabels(entry.policy.labelMap ?? entry.policy.effective?.values['workflow-labels']) } catch (error) { blocks.push((error as Error).message) }
    const workflow: WorkflowStateSnapshot = {
      repo: entry.repo, policyDigest: entry.policy.effective?.policyDigest ?? '',
      observedAt: entry.observedAt ?? new Date().toISOString(), complete: entry.boardComplete === true && blocks.length === 0,
      labelMap, blocks,
      issues: entry.board.map(issue => {
        const result = labelMap ? resolveState(issue.labels, labelMap) : { state: null, blocks: ['workflow label map unavailable'] }
        return { number: issue.number, nodeId: issue.nodeId ?? '', labelsDigest: labelsDigest(issue.labels),
          state: blocks.length ? null : result.state, blocks: [...blocks, ...result.blocks] }
      }),
    }
    const count = (state: State): number => workflow.issues.filter(issue => issue.state === state).length
    const runs: RunSummary[] = [...(entry.durableRuns ?? [])].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map(run => ({
      runId:run.runId,state:run.state,terminationCause:run.terminationCause,recovery:durableRecoverySummary(run),
      pendingDelivery:run.pendingDelivery.filter(p=>p.status!=='acknowledged').length,
      lastError:run.pendingDelivery.find(p=>p.lastError)?privacyReason(new Error(run.pendingDelivery.find(p=>p.lastError)!.lastError!)):null,
      issue:run.issue,stage:run.stage as Stage,startedAt:run.startedAt,exitCode:run.exitCode,
      lastMessage:run.terminationCause??run.state,logFile:'',
    }))
    runs.push(...entry.logs.map(log => {
      const rows = rowsOf(log.body)
      const start = rows.find(row => row.event === 'start')
      const summary = summariseLog(log.body)
      return {
        issue: start?.issue ?? 0,
        stage: start?.stage ?? 'implement',
        startedAt: start?.at ?? '',
        exitCode: summary.exitCode,
        lastMessage: 'legacy unverified run',
        logFile: log.file,
      }
    }))
    return {
      repo: entry.repo,
      ...(entry.shared ? { shared: entry.shared } : {}),
      dispatch: entry.policy.dispatch,
      ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
      workflow,
      board: { needsPlan: count('needsPlan'), ready: count('ready'), working: count('working'), forOperator: count('forOperator') },
      worktrees: entry.worktrees,
      runs,
    }
  })
  return {
    dispatcher: {
      running: input.lockPid !== null,
      ...(input.lockRefusal ? { refusal: input.lockRefusal } : {}),
      pid: input.lockPid,
      lastTick: Object.values(input.state.lastTick).sort().at(-1) ?? null,
      interval: input.config.interval,
    },
    repos,
  }
}

export function renderStatus(report: StatusReport): string {
  const lines: string[] = []
  const dispatcher = report.dispatcher
  lines.push(dispatcher.refusal ? `dispatcher: ownership unavailable — ${dispatcher.refusal}` : dispatcher.running
    ? `dispatcher: running (pid ${dispatcher.pid}), every ${dispatcher.interval}s, last tick ${dispatcher.lastTick ?? 'never'}`
    : 'dispatcher: not running')
  for (const repo of report.repos) {
    lines.push(`${repo.repo} — dispatch: ${repo.dispatch}`)
    if (repo.shared) lines.push(`  ownership: ${repo.shared.refusal ?? `${repo.shared.tasks.length} recorded tasks at ${repo.shared.head}`}; observed state is not liveness proof`)
    if (repo.snapshot) lines.push(`  policy: ${repo.snapshot.state} · ${repo.snapshot.sourceCommit ?? 'no validated source'}${repo.snapshot.reason ? ` · ${repo.snapshot.reason}` : ''}`)
    lines.push(`  board: ${repo.board.needsPlan} needs-plan · ${repo.board.ready} ready · ${repo.board.working} working · ${repo.board.forOperator} for-operator`)
    if (repo.workflow) lines.push(`  workflow: ${repo.workflow.complete ? 'complete' : 'incomplete'} · observed ${repo.workflow.observedAt}${repo.workflow.blocks.length ? ' · ' + repo.workflow.blocks.join('; ') : ''}`)
    for (const worktree of repo.worktrees) {
      lines.push(`  worktree ${worktree.branch} (${worktree.state}) ${worktree.path}`)
    }
    for (const run of repo.runs) {
      const how = run.state ? `${run.terminationCause ?? run.state}${run.pendingDelivery ? ` · ${run.pendingDelivery} deliveries pending` : ''}${run.recovery ? ` · ${run.recovery.reason}` : ''}` : 'legacy unverified'
      lines.push(`  run #${run.issue} ${run.stage} — ${how}${run.lastMessage ? ` — ${run.lastMessage}` : ''}`)
    }
  }
  for(const privacy of report.privacy??[])lines.push(`reporting ${privacy.repo??'local'}: ${privacy.mode} · ${privacy.pendingCount} pending (${privacy.pendingBytes} bytes) · ${privacy.pressure.reason}`,`  ${privacy.recipient}`,`  ${privacy.history}`)
  return lines.join('\n')
}

// --- the verb ---------------------------------------------------------------

export function statusUsage(): string {
  return `Usage: vegafactory status [--json] [--config PATH]

The board, the worktrees, the last tick, the runs in flight and the dispatcher's own
health, for every repo in factory.json. Exit 0 always, except 2 when the config cannot
be read — a status command that invents an empty board is worse than none.
`
}

export interface StatusDeps {
  gh: (args: string[]) => Promise<string>
  worktrees: (repoPath: string) => Promise<WorktreeRow[]>
  logs: (config: FactoryConfig, repo: string) => Promise<{ file: string; body: string }[]>
  readLock: (path: string) => Promise<{ held: boolean; pid: number | null; reason?: string }>
  sharedTarget?: (repo: string, config: FactoryConfig) => Promise<CoordinationTarget>
}

export async function runStatusCli(argv: string[], home: string, deps?: Partial<StatusDeps>): Promise<number> {
  let json = false
  let configPath: string | null = null
  const rest = [...argv]
  while (rest.length) {
    const token = rest.shift()!
    if (token === '--json') json = true
    else if (token === '--config') {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) {
        console.error(`--config requires a path\n\n${statusUsage()}`)
        return 2
      }
      configPath = value
    }
    else if (token === '--help' || token === '-h') {
      console.log(statusUsage())
      return 0
    }
    else {
      console.error(`Unknown option: ${token}\n\n${statusUsage()}`)
      return 2
    }
  }

  const { loadFactoryConfig, mergeRepoPolicy, parseRepoPolicy } = await import('./config.ts')
  const { ghText } = await import('./gh.ts')
  const { readLock, readState } = await import('./dispatch.ts')
  const { readFile } = await import('node:fs/promises')

  let config: FactoryConfig
  try {
    config = await loadFactoryConfig(configPath ?? `${home}/.vegastack/factory.json`, home)
  } catch (error) {
    console.error(privacyReason(error))
    return 2
  }

  const gh = deps?.gh ?? ((args: string[]) => ghText(args))
  const worktreesOf = deps?.worktrees ?? defaultWorktrees
  const logsOf = deps?.logs ?? defaultLogs
  const lockOf = deps?.readLock ?? readLock

  const state = await readState(config.stateFile)
  const lock = await lockOf(config.dispatcherLock)
  const repos: Parameters<typeof buildStatus>[0]['repos'] = []
  for (const entry of config.repos) {
    let devMd = ''
    try {
      devMd = await readFile(`${entry.path}/.vegastack/dev.md`, 'utf8')
    } catch {
      // A repo with no profile still shows on the board as dispatch: off, which is the truth.
    }
    let board: BoardIssue[] = []
    let boardComplete = false, boardReason: string | null = null
    const observedAt = new Date().toISOString()
    try {
      const parsed = await boundedGhJson(gh, ['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${entry.repo} is:issue is:open`, '-f', 'per_page=100', '--cache', '0'], readBudget()) as { items?: { node_id?: string; number: number; title: string; labels?: { name: string }[]; assignees?: { login: string }[]; updated_at?: string }[] }
      if (parsed.items?.some(row => !Number.isSafeInteger(row.number) || row.number < 1 || typeof row.node_id !== 'string' || !row.node_id || typeof row.title !== 'string' || !Array.isArray(row.labels) || row.labels.some(label => typeof label?.name !== 'string'))) throw new Error('GitHub returned unreadable workflow issue identity or labels')
      board = (parsed.items ?? []).map(row => ({
        number: row.number,
        nodeId: row.node_id,
        title: row.title,
        labels: (row.labels ?? []).map(label => label.name),
        assignees: (row.assignees ?? []).map(assignee => assignee.login),
        updatedAt: row.updated_at ?? '',
      }))
      boardComplete = true
    } catch (error) {
      boardReason = (error as Error).message
    }
    let snapshot: RepoStatus['snapshot']
    let policy = devMd ? mergeRepoPolicy(null, devMd) : parseRepoPolicy('')
    const room = parseControlRoomKnob(devMd)
    if (room) {
      try {
        const result = await getPolicySnapshot(room.org, entry.repo, Date.now(), { settingsPath: config.settingsPath ?? `${home}/.vegastack/factory.json`, devMd })
        policy = repoPolicyFromEffective(result.policy)
        snapshot = { state: result.state, sourceCommit: result.snapshot?.sourceCommit ?? null, policyDigest: result.snapshot?.policyDigest ?? null, validatedAt: result.snapshot?.validatedAt ?? null, ageSeconds: result.ageSeconds, reason: result.reason, machine: result.machine }
      } catch (error) { policy = { ...policy, refusal: privacyReason(error) }; snapshot = { state: 'unavailable', sourceCommit: null, policyDigest: null, validatedAt: null, ageSeconds: null, reason: privacyReason(error) } }
    }
    const shared = config.executionMode === 'shared'
      ? await (async()=>{try{return await readSharedStatus(await (deps?.sharedTarget??verifiedSharedTarget)(entry.repo,config),[entry.repo])}catch{return{head:null,tasks:[],refusal:'verified coordination reader unavailable'}}})()
      : undefined
    let durableRuns:RunRecord[]=[],runRefusal:string|undefined
    try { durableRuns=(await readRuns(runsRoot(home))).filter(run=>run.repo===entry.repo) } catch { runRefusal='durable run records unavailable; preserved for reconciliation' }
    repos.push({
      durableRuns,runRefusal,
      shared,
      snapshot,
      repo: entry.repo,
      policy,
      board, boardComplete, boardReason, observedAt,
      worktrees: await worktreesOf(entry.path).catch(() => []),
      logs: await logsOf(config, entry.repo).catch(() => []),
    })
  }

  const report = buildStatus({ config, state, lockPid: lock.held ? lock.pid : null, lockRefusal: lock.reason, repos })
  report.privacy=await Promise.all(repos.map(entry=>privacyStatus(home,entry.policy.effective as import('./stats/privacy.ts').ExportPolicy|undefined,entry.repo)))
  console.log(json ? JSON.stringify({ command: 'status', ...report }, null, 2) : renderStatus(report))
  return 0
}

async function defaultWorktrees(repoPath: string): Promise<WorktreeRow[]> {
  const { spawnSync } = await import('node:child_process')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const script = process.env.VSK_WORKTREE_SCRIPT
    || join(dirname(dirname(fileURLToPath(import.meta.url))), 'skill', 'dev-implement', 'scripts', 'worktree.mjs')
  const result = spawnSync(process.execPath, [script, 'list', '--json'], { cwd: repoPath, encoding: 'utf8' })
  const parsed = JSON.parse(result.stdout || '{}') as { entries?: { name: string; branch: string | null; state: string }[] }
  return (parsed.entries ?? []).map(entry => ({
    path: `${repoPath}/.vegastack/.worktrees/${entry.name}`,
    branch: entry.branch ?? 'detached',
    issue: Number.parseInt(entry.name, 10) || null,
    state: entry.state,
  }))
}

// The five most recent run logs per repo: enough to show what is in flight and how the last few
// ended, without reading a directory that grows for the life of the machine.
async function defaultLogs(config: FactoryConfig, repo: string): Promise<{ file: string; body: string }[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const [org, name] = repo.split('/')
  const directory = join(config.logRoot, org ?? repo, name ?? repo)
  let files: string[]
  try {
    files = (await readdir(directory)).filter(file => file.endsWith('.jsonl')).sort().slice(-5)
  } catch {
    return []
  }
  const logs: { file: string; body: string }[] = []
  for (const file of files) {
    const path = join(directory, file)
    logs.push({ file: path, body: await readFile(path, 'utf8').catch(() => '') })
  }
  return logs
}

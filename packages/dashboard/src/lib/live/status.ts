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

export interface StatusRepo {
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
function run(bin: string, timeoutMs: number): Promise<Live<string>> {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) resolve({ ok: false, reason: `vegafactory status --json failed: ${error.message}` })
      else resolve({ ok: true, data: stdout })
    })
  })
}

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => number(value) ?? 0

function toReport(parsed: unknown): StatusReport | null {
  if (!parsed || typeof parsed !== 'object') return null
  const document = parsed as Record<string, unknown>
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

export async function readStatus(input: { bin: string | null; timeoutMs?: number }): Promise<Live<StatusReport>> {
  if (!input.bin) return { ok: false, reason: 'no vegafactory binary was passed to the dashboard' }
  const result = await run(input.bin, input.timeoutMs ?? 10_000)
  if (!result.ok) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(result.data)
  } catch {
    return { ok: false, reason: 'vegafactory status --json printed something that is not JSON' }
  }
  const report = toReport(parsed)
  if (!report) return { ok: false, reason: 'vegafactory status --json printed no status document' }
  return { ok: true, data: report }
}

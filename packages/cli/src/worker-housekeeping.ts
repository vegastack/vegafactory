// Preview-only worktree advice. The worker starts one bounded copy of this route after a poll;
// each repository is read with its own App token and a shorter subprocess deadline.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appIdentityConfig } from './claim.ts'
import { appKeyPath, workerDirectory, workerRepositoriesDirectory } from './home.ts'
import { canonicalRepository } from './worker-repo.ts'

export const HOUSEKEEPING_DEADLINE_MS = 20_000
const BOARD_DEADLINE_MS = 6_000
const INPUT_LIMIT = 64 * 1024
const OUTPUT_LIMIT = 128 * 1024
export const MAX_ADVISORIES = 50
const MAX_BOARDS = 20
const MAX_EXCLUSIONS = 500

export interface PreviewGroupHooks { started: (pid: number, deadlineAt: number) => void; finished: (pid: number) => void }

export interface HousekeepingBoard { repo: string; root: string; excludeIssues: number[] }
export interface HousekeepingRequest { schema: 1; deadlineAt: number; boards: HousekeepingBoard[] }
export interface HousekeepingAdvisory { repo: string; issue: number; worktree: string; reason: 'merged' | 'closed' | 'idle'; ageDays: number | null }
export interface HousekeepingDocument { schema: 1; complete: boolean; advisories: HousekeepingAdvisory[]; unavailable: Array<{ repo: string; reason: string }> }
interface PreviewResult { candidates?: Array<Record<string, unknown>>; blocks?: string[]; warns?: string[] }

const exactKeys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).sort().join(',') === [...names].sort().join(',')
const boundedReason = (value: unknown) => String(value ?? 'unavailable').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400) || 'unavailable'

export function parseHousekeepingRequest(raw: string, now = Date.now()): HousekeepingRequest {
  if (Buffer.byteLength(raw) > INPUT_LIMIT) throw new Error('housekeeping request is too large')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('housekeeping request is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('housekeeping request is not an object')
  const request = value as Record<string, unknown>
  if (!exactKeys(request, ['schema', 'deadlineAt', 'boards']) || request.schema !== 1
    || !Number.isSafeInteger(request.deadlineAt) || Number(request.deadlineAt) <= now
    || Number(request.deadlineAt) > now + HOUSEKEEPING_DEADLINE_MS
    || !Array.isArray(request.boards) || request.boards.length > MAX_BOARDS) {
    throw new Error('housekeeping request has an invalid schema, deadline, or board list')
  }
  const boards = new Map<string, HousekeepingBoard>()
  for (const rawBoard of request.boards) {
    if (!rawBoard || typeof rawBoard !== 'object' || Array.isArray(rawBoard)) throw new Error('invalid housekeeping board')
    const board = rawBoard as Record<string, unknown>
    if (!exactKeys(board, ['repo', 'root', 'excludeIssues']) || typeof board.repo !== 'string'
      || typeof board.root !== 'string' || !isAbsolute(board.root) || resolve(board.root) !== board.root
      || basename(board.root) !== 'repo' || !Array.isArray(board.excludeIssues)
      || board.excludeIssues.length > MAX_EXCLUSIONS
      || board.excludeIssues.some((issue) => !Number.isSafeInteger(issue) || issue <= 0)) {
      throw new Error('invalid housekeeping board or exclusion set')
    }
    const repo = canonicalRepository(board.repo)
    const prior = boards.get(repo)
    if (prior && prior.root !== board.root) throw new Error(`housekeeping received two roots for ${repo}`)
    boards.set(repo, { repo, root: board.root, excludeIssues: [...new Set([...(prior?.excludeIssues ?? []), ...board.excludeIssues as number[]])].sort((a, b) => a - b) })
  }
  return { schema: 1, deadlineAt: request.deadlineAt as number, boards: [...boards.values()] }
}

export function parseHousekeepingDocument(raw: string): HousekeepingDocument {
  if (Buffer.byteLength(raw) > OUTPUT_LIMIT) throw new Error('housekeeping reply is too large')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('housekeeping reply is not one JSON document') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('housekeeping reply is not an object')
  const doc = value as Record<string, unknown>
  if (!exactKeys(doc, ['schema', 'complete', 'advisories', 'unavailable']) || doc.schema !== 1
    || typeof doc.complete !== 'boolean' || !Array.isArray(doc.advisories) || doc.advisories.length > MAX_ADVISORIES
    || !Array.isArray(doc.unavailable) || doc.unavailable.length > MAX_BOARDS) throw new Error('housekeeping reply has an invalid schema')
  const seen = new Set<string>()
  for (const rawRow of doc.advisories) {
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) throw new Error('invalid housekeeping advisory')
    const row = rawRow as Record<string, unknown>
    if (!exactKeys(row, ['repo', 'issue', 'worktree', 'reason', 'ageDays']) || typeof row.repo !== 'string'
      || canonicalRepository(row.repo) !== row.repo || !Number.isSafeInteger(row.issue) || Number(row.issue) <= 0
      || row.worktree !== String(row.issue) || !['merged', 'closed', 'idle'].includes(String(row.reason))
      || !(row.ageDays === null || Number.isSafeInteger(row.ageDays) && Number(row.ageDays) >= 0)) {
      throw new Error('invalid housekeeping advisory')
    }
    const key = `${row.repo}#${row.issue}`
    if (seen.has(key)) throw new Error('duplicate housekeeping advisory')
    seen.add(key)
  }
  for (const rawRow of doc.unavailable) {
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) throw new Error('invalid housekeeping unavailable row')
    const row = rawRow as Record<string, unknown>
    if (!exactKeys(row, ['repo', 'reason']) || typeof row.repo !== 'string' || canonicalRepository(row.repo) !== row.repo
      || typeof row.reason !== 'string' || !row.reason || row.reason.length > 400) throw new Error('invalid housekeeping unavailable row')
    const key = `unavailable:${row.repo}`
    if (seen.has(key)) throw new Error('duplicate housekeeping unavailable row')
    seen.add(key)
  }
  if (doc.complete && doc.unavailable.length) throw new Error('complete housekeeping reply contains unavailable boards')
  return doc as unknown as HousekeepingDocument
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function worktreeScript(): string {
  const packaged = join(packageRoot, 'skill', 'dev-implement', 'scripts', 'worktree.mjs')
  const authored = resolve(packageRoot, '..', '..', 'skills', 'dev', 'dev-implement', 'scripts', 'worktree.mjs')
  if (existsSync(packaged)) return packaged
  if (existsSync(authored)) return authored
  throw new Error('the worktree preview script is unavailable')
}

export function housekeepingPreviewArgs(board: HousekeepingBoard, script = worktreeScript()): string[] {
  return [script, 'prune', '--dry-run', '--worker-layout', '--repo-root', board.root, '--repo', board.repo,
    ...(board.excludeIssues.length ? ['--exclude-issues', board.excludeIssues.join(',')] : []), '--json']
}

// A repository preview is its own bounded process group. The parent records its identity before
// sending the one-byte go signal; the group guard still kills git/gh if the parent disappears.
const BOARD_WATCHDOG = `read ready || exit 2; "$@" </dev/null & job=$!; { trap 'kill "$dog" 2>/dev/null; exit 0' TERM INT; sleep "$VF_LIMIT" & dog=$!; wait "$dog"; kill -KILL 0; } </dev/null >/dev/null 2>&1 & guard=$!; wait "$job"; code=$?; kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; exit "$code"`

export async function previewHousekeepingBoard(board: HousekeepingBoard, env: NodeJS.ProcessEnv, budgetMs: number, script = worktreeScript(), hooks?: PreviewGroupHooks): Promise<PreviewResult> {
  const args = housekeepingPreviewArgs(board, script)
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sh', ['-c', BOARD_WATCHDOG, 'vegafactory-board-preview', process.execPath, ...args], {
      cwd: board.root,
      env: { ...env, VF_LIMIT: String(Math.ceil(budgetMs / 1000) + 1),
        VSK_WORKTREE_GH_TIMEOUT_MS: String(Math.max(1, budgetMs - 100)), VSK_WORKTREE_GIT_TIMEOUT_MS: String(Math.max(1, budgetMs - 100)) },
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    })
    child.on('error', () => {})
    if (!child.pid) return reject(new Error('preview process did not start'))
    const pid = child.pid
    const killGroup = () => { try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    try { hooks?.started(pid, Date.now() + budgetMs + 1500) }
    catch (error) { killGroup(); return reject(error) }
    let stdout = ''
    let stderr = ''
    let oversized = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killGroup() }, budgetMs)
    child.stdout.on('data', chunk => { stdout += String(chunk); if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) { oversized = true; killGroup() } })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-400) })
    child.stdin.on('error', () => {})
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      try { hooks?.finished(pid) } catch (error) { return reject(error) }
      if (timedOut) return reject(new Error('preview timed out'))
      if (oversized) return reject(new Error('preview output exceeded its bound'))
      let result: PreviewResult
      try { result = JSON.parse(stdout) as PreviewResult } catch { return reject(new Error(`preview returned invalid JSON: ${boundedReason(stderr)}`)) }
      if (!result || !Array.isArray(result.candidates) || !Array.isArray(result.blocks) || !Array.isArray(result.warns)) {
        return reject(new Error('preview returned an invalid result'))
      }
      if (code !== 0 && !result.blocks.length && !result.warns.length) return reject(new Error(`preview exited ${code}`))
      resolvePromise(result)
    })
    child.stdin.end('go\n')
  })
}

export async function runWorkerHousekeeping(request: HousekeepingRequest, deps: {
  now?: () => number
  reposRoot?: string
  tokenFor: (repo: string, budgetMs: number) => Promise<string>
  envForToken: (token: string) => NodeJS.ProcessEnv
  preview?: (board: HousekeepingBoard, env: NodeJS.ProcessEnv, budgetMs: number) => Promise<PreviewResult>
  previewGroups?: PreviewGroupHooks
}): Promise<HousekeepingDocument> {
  const now = deps.now ?? Date.now
  const advisories: HousekeepingAdvisory[] = []
  const unavailable: HousekeepingDocument['unavailable'] = []
  const markUnavailable = (repo: string, reason: unknown) => {
    const text = boundedReason(reason)
    const prior = unavailable.find(row => row.repo === repo)
    if (prior) prior.reason = boundedReason(`${prior.reason}; ${text}`)
    else unavailable.push({ repo, reason: text })
  }
  const seen = new Set<string>()
  const preview = deps.preview ?? ((board: HousekeepingBoard, env: NodeJS.ProcessEnv, budgetMs: number) =>
    previewHousekeepingBoard(board, env, budgetMs, worktreeScript(), deps.previewGroups))
  for (const board of request.boards) {
    if (now() >= request.deadlineAt) { markUnavailable(board.repo, 'deadline expired before preview'); continue }
    if (deps.reposRoot && board.root !== join(deps.reposRoot, board.repo.replace('/', '__'), 'repo')) {
      markUnavailable(board.repo, 'board root does not match the managed repository'); continue
    }
    try {
      const boardDeadline = Math.min(request.deadlineAt, now() + BOARD_DEADLINE_MS)
      const token = await deps.tokenFor(board.repo, Math.max(1, boardDeadline - now()))
      if (!token) throw new Error('repository App token is unavailable')
      const remaining = boardDeadline - now()
      if (remaining <= 0) throw new Error('deadline expired before preview')
      const result = await preview(board, deps.envForToken(token), Math.min(BOARD_DEADLINE_MS, remaining))
      if (result.blocks?.length) { markUnavailable(board.repo, result.blocks[0]); continue }
      if (result.warns?.length) markUnavailable(board.repo, result.warns[0])
      for (const candidate of result.candidates ?? []) {
        const issue = Number(candidate.name)
        if (!candidate.removable || !Number.isSafeInteger(issue) || issue <= 0
          || String(issue) !== candidate.name || board.excludeIssues.includes(issue)
          || !['merged', 'closed', 'idle'].includes(String(candidate.reasonCode))) continue
        const key = `${board.repo}#${issue}`
        if (seen.has(key)) continue
        seen.add(key)
        if (advisories.length === MAX_ADVISORIES) {
          markUnavailable(board.repo, 'advisory limit reached')
          break
        }
        advisories.push({ repo: board.repo, issue, worktree: candidate.name as string,
          reason: candidate.reasonCode as HousekeepingAdvisory['reason'],
          ageDays: Number.isSafeInteger(candidate.ageDays) && Number(candidate.ageDays) >= 0 ? Number(candidate.ageDays) : null })
      }
    } catch (error) { markUnavailable(board.repo, (error as Error).message) }
  }
  return { schema: 1, complete: unavailable.length === 0, advisories, unavailable }
}

async function readBoundedStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += String(chunk)
    if (Buffer.byteLength(text) > INPUT_LIMIT) throw new Error('housekeeping request is too large')
  }
  return text
}

export async function runHousekeepingCli(): Promise<number> {
  let request: HousekeepingRequest | null = null
  try {
    request = parseHousekeepingRequest(await readBoundedStdin())
    const env = process.env
    const app = appIdentityConfig(env)
    const { appIdentity, childRunEnvironment, processStart, readHousekeeping, writeHousekeeping } = await import('./worker.ts')
    const stateRoot = workerDirectory({ env })
    const result = await runWorkerHousekeeping(request, {
      reposRoot: workerRepositoriesDirectory({ env }),
      previewGroups: {
        started: (pid, deadlineAt) => {
          const startedAt = processStart(pid)
          if (!startedAt) throw new Error('board preview process identity could not be proved')
          const state = readHousekeeping(stateRoot)
          if (!state.running || state.running.board) throw new Error('another board preview is still recorded')
          writeHousekeeping(stateRoot, state, { ...state, running: { ...state.running, board: { pid, startedAt, deadlineAt } } })
        },
        finished: pid => {
          const state = readHousekeeping(stateRoot)
          if (state.running?.board?.pid === pid) writeHousekeeping(stateRoot, state, { ...state, running: { ...state.running, board: null } })
        },
      },
      tokenFor: async (repo, budgetMs) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), budgetMs)
        try {
          const identity = appIdentity({ repo, keyPath: appKeyPath({ env }), appId: app.appId,
            fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }) })
          await identity.freshen()
          return identity.token() ?? ''
        } finally { clearTimeout(timer) }
      },
      envForToken: token => childRunEnvironment(env, token, true),
    })
    process.stdout.write(JSON.stringify(result) + '\n')
    return result.complete ? 0 : 1
  } catch (error) {
    const repos = request?.boards.map(board => board.repo) ?? ['unknown/unknown']
    process.stdout.write(JSON.stringify({ schema: 1, complete: false, advisories: [],
      unavailable: repos.map(repo => ({ repo, reason: boundedReason((error as Error).message) })) }) + '\n')
    return 2
  }
}

// The async `gh` client the vegafactory CLI uses. It mirrors the contract of the packaged
// `skills/dev/dev-implement/scripts/lib/gh.mjs` — explicit argv, never a shell, fail closed on
// anything unparseable, and a `VSK_GH` seam so tests can point at a stub — but it is a separate
// file on purpose: that one is `execFileSync`, and a synchronous call would stall the dispatcher's
// watch loop for the length of every API round trip.
import { spawn } from 'node:child_process'

export interface GhOptions {
  gh?: string
  input?: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

// A named failure, never a null result: a caller that cannot tell "no rows" from "the API refused"
// will eventually treat a 403 as an empty board and act on it.
export class GhUnavailable extends Error {
  readonly httpStatus: number | null
  readonly headers: Headers
  constructor(message: string, httpStatus: number | null = null, headers = new Headers()) {
    super(message)
    this.name = 'GhUnavailable'
    this.httpStatus = httpStatus
    this.headers = headers
  }
}

function binary(options: GhOptions | undefined): string {
  return options?.gh ?? process.env.VSK_GH ?? 'gh'
}

// gh prints its HTTP failures as `HTTP 403: …` or `… (HTTP 404)`; both shapes are read so a caller
// can distinguish a rate limit from a missing repo without re-running the call.
function statusOf(text: string): number | null {
  const match = /HTTP (\d{3})/.exec(text)
  return match ? Number(match[1]) : null
}

// `spawn` rather than `execFile`, because stdin is part of the contract: `execFile` has no `input`
// option, and a caller that needs to POST a body would otherwise have to build a shell pipeline.
export function ghText(args: string[], options: GhOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new GhUnavailable('GitHub read cancelled'))
    const timeoutMs = Math.min(options.timeoutMs ?? 10_000, 60_000)
    const maxOutputBytes = Math.min(options.maxOutputBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      return reject(new GhUnavailable('Invalid GitHub process bounds'))
    }
    const child = spawn(binary(options), args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let bytes = 0
    let failure: GhUnavailable | null = null
    const stop = (reason: string): void => {
      if (failure) return
      failure = new GhUnavailable(reason)
      child.kill('SIGKILL')
    }
    const abort = (): void => stop('GitHub read cancelled')
    const timer = setTimeout(() => stop('GitHub request deadline exceeded'), timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) { stop('GitHub output limit exceeded'); return }
      if (!failure) target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.stdin.on('error', () => { /* close/error determines the result; an early exit may close stdin */ })
    child.on('error', error => { cleanup(); reject(new GhUnavailable(`gh could not be run: ${error.message}`)) })
    child.on('close', code => {
      cleanup()
      if (failure) return reject(failure)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) {
        let response: ReturnType<typeof parseGhResponse> | null = null
        try { response = parseGhResponse(out) } catch { /* gh may fail before receiving a response */ }
        return reject(new GhUnavailable(`gh failed: ${err.trim() || `exit ${code}`}`, response?.status ?? statusOf(err), response?.headers))
      }
      // Remaining search callers must refuse a truncated result even when they use ghText.
      if (args.some(arg => arg === 'search/issues' || arg.startsWith('search/issues?'))) {
        try { assertCompleteSearch(JSON.parse(out)) } catch (error) { return reject(error) }
      }
      resolve(out)
    })
    if (typeof options.input === 'string') child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export async function ghJson<T>(args: string[], options?: GhOptions): Promise<T> {
  const stdout = await ghText(args, options)
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new GhUnavailable(`gh ${args.join(' ')} returned output that is not JSON: ${stdout.trim().slice(0, 200)}`)
  }
}

export interface PagedResult<T> { items: T[]; complete: boolean; reason: string | null; observedAt: string }
export interface ReadBudget { deadline: number; pages: number; records: number; signal?: AbortSignal }
export type GhReader = (args: string[], options?: GhOptions) => Promise<string>

export function readBudget(signal?: AbortSignal, timeoutMs = 60_000): ReadBudget {
  return { deadline: Date.now() + Math.min(timeoutMs, 60_000), pages: 0, records: 0, signal }
}

export function assertCompleteSearch(value: unknown): void {
  const row = value as { items?: unknown; total_count?: unknown; incomplete_results?: unknown } | null
  if (!row || !Array.isArray(row.items) || row.incomplete_results !== false ||
      typeof row.total_count !== 'number' || row.total_count > 1000 || row.total_count !== row.items.length) {
    throw new GhUnavailable('GitHub search is incomplete; use paginated repository enumeration')
  }
}

function githubUrl(path: string): URL {
  const url = new URL(path, 'https://api.github.com/')
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) {
    throw new GhUnavailable('Refused unsafe GitHub pagination URL')
  }
  return url
}

function parseGhResponse(raw: string): { status: number; headers: Headers; body: string } {
  const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(raw)
  if (!match) throw new GhUnavailable('GitHub response headers are unavailable')
  const headers = new Headers()
  for (const line of match[2]!.split(/\r?\n/)) {
    const split = line.indexOf(':')
    if (split <= 0) throw new GhUnavailable('GitHub response headers are unreadable')
    headers.append(line.slice(0, split), line.slice(split + 1).trim())
  }
  return { status: Number(match[1]), headers, body: match[3]! }
}

// A dependency seam is bounded too: a non-cooperative injected reader cannot hold a tick forever.
async function withinRead<T>(budget: ReadBudget, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = Math.min(10_000, budget.deadline - Date.now())
  if (budget.signal?.aborted || remaining <= 0) throw new GhUnavailable(budget.signal?.aborted ? 'GitHub read cancelled' : 'GitHub repository deadline exceeded')
  const controller = new AbortController()
  let rejectBound!: (error: Error) => void
  const bound = new Promise<never>((_, reject) => { rejectBound = reject })
  const stop = (reason: string): void => { controller.abort(); rejectBound(new GhUnavailable(reason)) }
  const abort = (): void => stop('GitHub read cancelled')
  const timer = setTimeout(() => stop('GitHub request deadline exceeded'), remaining)
  budget.signal?.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([call(controller.signal), bound]) }
  finally { clearTimeout(timer); budget.signal?.removeEventListener('abort', abort) }
}

async function waitRetry(ms: number, budget: ReadBudget): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0 || ms >= budget.deadline - Date.now()) throw new GhUnavailable('GitHub retry delay exceeds repository deadline')
  if (budget.signal?.aborted) throw new GhUnavailable('GitHub read cancelled')
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(new GhUnavailable('GitHub read cancelled')) }
    const timer = setTimeout(() => { budget.signal?.removeEventListener('abort', abort); resolve() }, ms)
    budget.signal?.addEventListener('abort', abort, { once: true })
  })
}

async function page(gh: GhReader, url: URL, budget: ReadBudget): Promise<ReturnType<typeof parseGhResponse>> {
  for (let attempt = 0; ; attempt++) {
    let response: ReturnType<typeof parseGhResponse>
    try {
      response = await withinRead(budget, signal => gh(['api', `${url.pathname.slice(1)}${url.search}`, '--method', 'GET', '--include'], { signal, timeoutMs: Math.min(10_000, budget.deadline - Date.now()) }).then(parseGhResponse))
    } catch (error) {
      if (!(error instanceof GhUnavailable) || error.httpStatus === null) throw error
      response = { status: error.httpStatus, headers: error.headers, body: '' }
    }
    if (response.status >= 200 && response.status < 300) return response
    const rate = response.status === 429 || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))
    const retry = rate || response.status >= 500
    if (!retry || attempt >= 2) throw new GhUnavailable(`GitHub returned HTTP ${response.status}`, response.status, response.headers)
    const after = response.headers.get('retry-after')
    const reset = response.headers.get('x-ratelimit-reset')
    const delay = after !== null ? (/^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now())
      : rate && reset !== null ? Math.max(0, Number(reset) * 1000 - Date.now()) : (attempt + 1) * 1000
    await waitRetry(delay, budget)
  }
}

export async function fetchGhPages<T>(gh: GhReader, path: string, budget = readBudget()): Promise<PagedResult<T>> {
  const items: T[] = [], ids = new Set<string>(), visited = new Set<string>()
  const result = (reason: string | null): PagedResult<T> => ({ items, complete: reason === null, reason, observedAt: new Date().toISOString() })
  try {
    let url = githubUrl(path)
    url.searchParams.set('per_page', '100')
    while (true) {
      if (budget.signal?.aborted) throw new GhUnavailable('GitHub read cancelled')
      if (Date.now() >= budget.deadline) throw new GhUnavailable('GitHub repository deadline exceeded')
      if (budget.pages >= 100) throw new GhUnavailable('GitHub page limit reached (100 pages)')
      if (visited.has(url.href)) throw new GhUnavailable('GitHub pagination loop detected')
      visited.add(url.href)
      const response = await page(gh, url, budget)
      budget.pages++
      const rows: unknown = JSON.parse(response.body)
      if (!Array.isArray(rows)) throw new GhUnavailable('GitHub returned an unreadable list')
      if (rows.length > 100 || budget.records + rows.length > 10_000) throw new GhUnavailable('GitHub record limit reached (10000 records)')
      budget.records += rows.length
      for (const row of rows) {
        const value = row as { node_id?: unknown; id?: unknown } | null
        const id = typeof value?.node_id === 'string' ? `node:${value.node_id}` : typeof value?.id === 'number' ? `id:${value.id}` : null
        if (id === null) throw new GhUnavailable('GitHub row has no stable ID')
        if (!ids.has(id)) { ids.add(id); items.push(row as T) }
      }
      const link = response.headers.get('link')
      if (!link) return result(null)
      const links = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)]
      if (links.length === 0) throw new GhUnavailable('GitHub pagination link is unreadable')
      const next = links.filter(match => match[2]!.split(/\s+/).includes('next'))
      if (next.length === 0) return result(null)
      if (next.length !== 1) throw new GhUnavailable('GitHub pagination has ambiguous next links')
      url = githubUrl(next[0]![1]!)
    }
  } catch (error) { return result(error instanceof Error ? error.message : 'GitHub read failed') }
}

// Keep the complete-history owner's --paginate/--slurp JSON contract while taking control
// of each request's limits. A failure throws; it can never become an empty dependency list.
export async function boundedGhJson<T>(gh: GhReader, args: string[], budget = readBudget()): Promise<T> {
  if (args.includes('--paginate')) {
    if (args[0] !== 'api' || !args[1] || args[1].startsWith('-') || args.some(arg => ['-f', '-F', '--field', '--raw-field', '--input', '-X', '--method'].includes(arg))) {
      throw new GhUnavailable('Unsupported paginated read arguments')
    }
    const result = await fetchGhPages<unknown>(gh, args[1], budget)
    if (!result.complete) throw new GhUnavailable(result.reason!)
    return (args.includes('--slurp') ? [result.items] : result.items) as T
  }
  const stdout = await withinRead(budget, signal => gh(args, { signal, timeoutMs: Math.min(10_000, budget.deadline - Date.now()) }))
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw new GhUnavailable('GitHub returned output that is not JSON') }
  if (args.some(arg => arg === 'search/issues' || arg.startsWith('search/issues?'))) assertCompleteSearch(value)
  return value as T
}

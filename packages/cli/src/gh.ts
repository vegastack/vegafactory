// A thin layer over `gh api`: one request, its status, headers and JSON body.
// Conditional requests (ETag) let callers ask "changed since?" for free — GitHub
// does not count a 304 against the rate limit.
import { spawnSync } from 'node:child_process'

export interface GhResult { code: number; stdout: string; stderr: string }
export type GhRunner = (args: string[], input?: string) => GhResult

export interface GhResponse<T = unknown> { status: number; headers: Record<string, string>; body: T }

export class GhError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
  }
}

export const defaultRunner: GhRunner = (args, input) => {
  const result = spawnSync(process.env.VEGAFACTORY_GH || 'gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw new GhError(`gh could not start: ${result.error.message} — install the GitHub CLI and run gh auth login`)
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// `gh api -i` prints the status line and headers, a blank line, then the body.
export function parseResponse(raw: string): GhResponse {
  const split = raw.search(/\r?\n\r?\n/)
  const head = split === -1 ? raw : raw.slice(0, split)
  const rest = split === -1 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '')
  const [statusLine = '', ...lines] = head.split(/\r?\n/)
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1] ?? NaN)
  if (!Number.isInteger(status)) throw new GhError(`unexpected gh output: ${statusLine.slice(0, 120) || 'empty'}`)
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  const text = rest.trim()
  let body: unknown = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status, headers, body }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  etag?: string | null
  body?: unknown
  runner?: GhRunner
}

export function ghRequest<T = unknown>(path: string, options: RequestOptions = {}): GhResponse<T> {
  const { method = 'GET', etag, body, runner = defaultRunner } = options
  const args = ['api', '-i', '-X', method, path]
  if (etag) args.push('-H', `If-None-Match: ${etag}`)
  if (body !== undefined) args.push('--input', '-')
  const result = runner(args, body === undefined ? undefined : JSON.stringify(body))
  let response: GhResponse
  try {
    response = parseResponse(result.stdout)
  } catch {
    throw new GhError(`gh api ${method} ${path} failed: ${(result.stderr || result.stdout).trim().slice(0, 300) || `exit ${result.code}`}`)
  }
  if (response.status >= 400) {
    const message = (response.body as { message?: string } | null)?.message ?? (result.stderr.trim() || 'request failed')
    throw new GhError(`GitHub ${response.status} on ${method} ${path}: ${message}`, response.status)
  }
  return response as GhResponse<T>
}

// Every page of a list endpoint. Stops at a short page, so a list of exactly N*100 costs one extra request.
export function ghList<T>(path: string, runner: GhRunner = defaultRunner, perPage = 100): T[] {
  const items: T[] = []
  const join = path.includes('?') ? '&' : '?'
  for (let page = 1; ; page++) {
    const { body } = ghRequest<T[]>(`${path}${join}per_page=${perPage}&page=${page}`, { runner })
    if (!Array.isArray(body)) throw new GhError(`expected a list from ${path}`)
    items.push(...body)
    if (body.length < perPage) return items
  }
}

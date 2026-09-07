// Every live read returns a value, never a throw: a page whose GitHub half failed renders the
// offline banner and its cached half, and a reason the reader can act on.
export type Live<T> = { ok: true; data: T } | { ok: false; reason: string }

export interface LiveIssue {
  repo?: string
  nodeId?: string
  number: number
  title: string
  updatedAt: string
  url: string
  labels: string[]
  assignees: string[]
}

export interface LivePull {
  repo?: string
  nodeId?: string
  number: number
  title: string
  url: string
  draft: boolean
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

interface LiveInput {
  repo: string
  token: string | null
  fetchImpl?: FetchImpl
  budget?: ReadBudget
  signal?: AbortSignal
}

const API = 'https://api.github.com'

export interface PagedResult<T> { items: T[]; complete: boolean; reason: string | null; observedAt: string }
export interface ReadBudget { deadline: number; pages: number; records: number; signal?: AbortSignal }
export function readBudget(signal?: AbortSignal, timeoutMs = 60_000): ReadBudget {
  return { deadline: Date.now() + Math.min(timeoutMs, 60_000), pages: 0, records: 0, signal }
}
export interface PageOptions {
  fetch?: FetchImpl
  token?: string | null
  signal?: AbortSignal
  budget?: ReadBudget
}

function githubUrl(path: string): URL {
  const url = new URL(path)
  if (url.origin !== API || url.username || url.password || url.hash) throw new Error('Refused unsafe GitHub pagination URL')
  return url
}

async function retryDelay(ms: number, budget: ReadBudget): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0 || ms >= budget.deadline - Date.now()) throw new Error('GitHub retry delay exceeds repository deadline')
  if (budget.signal?.aborted) throw new Error('GitHub read cancelled')
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(new Error('GitHub read cancelled')) }
    const timer = setTimeout(() => { budget.signal?.removeEventListener('abort', abort); resolve() }, ms)
    budget.signal?.addEventListener('abort', abort, { once: true })
  })
}

// The deadline includes the body, not just arrival of response headers. Redirects are refused
// before following them, so the token never leaves the approved GitHub origin.
async function page(url: URL, options: PageOptions, budget: ReadBudget): Promise<{ headers: Headers; rows: unknown }> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  for (let attempt = 0; ; attempt++) {
    const remaining = Math.min(10_000, budget.deadline - Date.now())
    if (budget.signal?.aborted || remaining <= 0) throw new Error(budget.signal?.aborted ? 'GitHub read cancelled' : 'GitHub repository deadline exceeded')
    const controller = new AbortController()
    let rejectBound!: (error: Error) => void
    const bound = new Promise<never>((_, reject) => { rejectBound = reject })
    const stop = (reason: string): void => { controller.abort(); rejectBound(new Error(reason)) }
    const abort = (): void => stop('GitHub read cancelled')
    const timer = setTimeout(() => stop('GitHub request deadline exceeded'), remaining)
    budget.signal?.addEventListener('abort', abort, { once: true })
    let response: { status: number; headers: Headers; rows: unknown }
    try {
      response = await Promise.race([(async () => {
        const result = await (options.fetch ?? fetch)(url.href, { headers, cache: 'no-store', redirect: 'error', signal: controller.signal })
        if (result.redirected || (result.url && githubUrl(result.url).origin !== API)) throw new Error('Refused GitHub redirect')
        if (result.status < 200 || result.status >= 300) {
          await result.body?.cancel()
          return { status: result.status, headers: result.headers, rows: null }
        }
        const reader = result.body?.getReader()
        if (!reader) throw new Error('GitHub returned an unreadable body')
        const cancel = (): void => { void reader.cancel().catch(() => {}) }
        controller.signal.addEventListener('abort', cancel, { once: true })
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > 8 * 1024 * 1024) throw new Error('GitHub output limit exceeded')
            chunks.push(next.value)
          }
        } finally { controller.signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock() }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        let rows: unknown
        try { rows = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error('GitHub returned an unreadable body') }
        return { status: result.status, headers: result.headers, rows }
      })(), bound])
    } finally { clearTimeout(timer); budget.signal?.removeEventListener('abort', abort) }
    if (response.status >= 200 && response.status < 300) return response
    const rate = response.status === 429 || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))
    if ((!rate && response.status < 500) || attempt >= 2) throw new Error(`GitHub returned HTTP ${response.status}`)
    const after = response.headers.get('retry-after'), reset = response.headers.get('x-ratelimit-reset')
    const delay = after !== null ? (/^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now())
      : rate && reset !== null ? Math.max(0, Number(reset) * 1000 - Date.now()) : (attempt + 1) * 1000
    await retryDelay(delay, budget)
  }
}

export async function fetchPages<T>(path: string, options: PageOptions = {}): Promise<PagedResult<T>> {
  const budget = options.budget ?? readBudget(options.signal)
  const items: T[] = [], ids = new Set<string>(), visited = new Set<string>()
  const result = (reason: string | null): PagedResult<T> => ({ items, complete: reason === null, reason, observedAt: new Date().toISOString() })
  try {
    let url = githubUrl(path)
    url.searchParams.set('per_page', '100')
    while (true) {
      if (budget.signal?.aborted) throw new Error('GitHub read cancelled')
      if (Date.now() >= budget.deadline) throw new Error('GitHub repository deadline exceeded')
      if (budget.pages >= 100) throw new Error('GitHub page limit reached (100 pages)')
      if (visited.has(url.href)) throw new Error('GitHub pagination loop detected')
      visited.add(url.href)
      const response = await page(url, options, budget)
      budget.pages++
      const rows = response.rows
      if (!Array.isArray(rows)) throw new Error('GitHub returned an unreadable list')
      if (rows.length > 100 || budget.records + rows.length > 10_000) throw new Error('GitHub record limit reached (10000 records)')
      budget.records += rows.length
      for (const row of rows) {
        const value = row as { node_id?: unknown; id?: unknown } | null
        const id = typeof value?.node_id === 'string' ? `node:${value.node_id}` : typeof value?.id === 'number' ? `id:${value.id}` : null
        if (id === null) throw new Error('GitHub row has no stable ID')
        if (!ids.has(id)) { ids.add(id); items.push(row as T) }
      }
      const link = response.headers.get('link')
      if (!link) return result(null)
      const links = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)]
      if (links.length === 0) throw new Error('GitHub pagination link is unreadable')
      const next = links.filter(match => match[2]!.split(/\s+/).includes('next'))
      if (next.length === 0) return result(null)
      if (next.length !== 1) throw new Error('GitHub pagination has ambiguous next links')
      url = githubUrl(next[0]![1]!)
    }
  } catch (error) { return result(error instanceof Error ? error.message : 'GitHub read failed') }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const names = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry : text((entry as Record<string, unknown> | null)?.name ?? (entry as Record<string, unknown> | null)?.login)))
    .filter((name) => name !== '')
}

export type PagedLive<T> = Live<T[]> & { snapshot: PagedResult<T> }
export interface RepoCompleteness { repo: string; complete: boolean; reason: string | null; observedAt: string }
export interface RepoAggregate<T> { live: Live<T[]>; reasons: string[]; repositories: RepoCompleteness[] }

function project<T>(result: PagedResult<Record<string, unknown>>, input: LiveInput, convert: (row: Record<string, unknown>) => T | null): PagedLive<T> {
  const rows: T[] = []
  let reason = result.reason
  for (const row of result.items) {
    if (typeof row.number !== 'number') { reason ??= 'GitHub returned an unreadable row'; continue }
    const value = convert(row)
    if (value !== null) rows.push(value)
  }
  if (reason) reason = `${reason} for ${input.repo}`
  const snapshot: PagedResult<T> = { items: rows, complete: reason === null, reason, observedAt: result.observedAt }
  return rows.length || snapshot.complete
    ? { ok: true, data: rows, snapshot }
    : { ok: false, reason: reason!, snapshot }
}

export async function fetchOpenIssues(input: LiveInput): Promise<PagedLive<LiveIssue>> {
  const result = await fetchPages<Record<string, unknown>>(`${API}/repos/${input.repo}/issues?state=open`, { fetch: input.fetchImpl, token: input.token, budget: input.budget, signal: input.signal })
  return project(result, input, row => row.pull_request ? null : ({
    number: row.number as number, title: text(row.title), labels: names(row.labels), assignees: names(row.assignees),
    updatedAt: text(row.updated_at), url: text(row.html_url), repo: input.repo, nodeId: text(row.node_id),
  }))
}

export async function fetchOpenPulls(input: LiveInput): Promise<PagedLive<LivePull>> {
  const result = await fetchPages<Record<string, unknown>>(`${API}/repos/${input.repo}/pulls?state=open`, { fetch: input.fetchImpl, token: input.token, budget: input.budget, signal: input.signal })
  return project(result, input, row => ({ number: row.number as number, title: text(row.title), url: text(row.html_url), draft: row.draft === true, repo: input.repo, nodeId: text(row.node_id) }))
}

async function mapRepos<T>(repos: string[], read: (repo: string) => Promise<T>): Promise<T[]> {
  const values = new Array<T>(repos.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(3, repos.length) }, async () => {
    while (cursor < repos.length) { const index = cursor++; values[index] = await read(repos[index]!) }
  }))
  return values
}

function aggregate<T>(repos: string[], results: Array<Live<T[]> & { snapshot?: PagedResult<T> }>): RepoAggregate<T> {
  const repositories = results.map((result, index) => ({ repo: repos[index]!, complete: result.snapshot?.complete ?? result.ok,
    reason: result.snapshot?.reason ?? (result.ok ? null : result.reason), observedAt: result.snapshot?.observedAt ?? new Date().toISOString() }))
  const reasons = repositories.flatMap(row => row.reason ? [row.reason] : [])
  if (repos.length === 0) reasons.push('no repos were passed to the dashboard')
  const successful = results.some(result => result.ok)
  return { live: successful ? { ok: true, data: results.flatMap(result => result.ok ? result.data : []) } : { ok: false, reason: reasons.join('; ') }, reasons, repositories }
}

export async function acrossRepos<T>(repos: string[], token: string | null,
  read: (input: { repo: string; token: string | null }) => Promise<Live<T[]> & { snapshot?: PagedResult<T> }>,
): Promise<RepoAggregate<T>> {
  const results = await mapRepos(repos, async repo => {
    try { return await read({ repo, token }) } catch { return { ok: false as const, reason: `GitHub read failed for ${repo}` } }
  })
  return aggregate(repos, results)
}

// The page has one repository pool, shared by both endpoints, and one budget per repository.
export async function fetchBoardRepositories(repos: string[], token: string | null, fetchImpl?: FetchImpl, signal?: AbortSignal): Promise<{ issues: RepoAggregate<LiveIssue>; pulls: RepoAggregate<LivePull> }> {
  const results = await mapRepos(repos, async repo => {
    const input = { repo, token, fetchImpl, signal, budget: readBudget(signal) }
    return { issues: await fetchOpenIssues(input), pulls: await fetchOpenPulls(input) }
  })
  return { issues: aggregate(repos, results.map(row => row.issues)), pulls: aggregate(repos, results.map(row => row.pulls)) }
}

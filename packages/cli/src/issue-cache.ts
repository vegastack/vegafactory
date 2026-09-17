// The agent-side issue cache: one folder per issue under .vegastack/.tmp/issues/.
// Agents read files, not the API. `syncIssue` asks GitHub "changed?" with ETags and
// reports only what changed since the caller's cursor; writes go to GitHub first and
// the cache is updated from GitHub's reply.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GhError, ghList, ghRequest, type GhRunner, defaultRunner } from './gh.ts'

export interface GhUser { login: string; type?: string }
export interface GhIssue {
  number: number
  title: string
  state: string
  body: string | null
  labels: Array<{ name: string } | string>
  assignees?: GhUser[]
  user?: GhUser
  comments: number
  updated_at: string
  html_url: string
  node_id?: string
}
export interface GhComment {
  id: number
  body: string
  user: GhUser | null
  created_at: string
  updated_at: string
  html_url: string
}

export interface CommentEntry {
  id: number
  file: string
  type: string
  author: string
  authorType: string
  createdAt: string
  updatedAt: string
  url: string
  sha: string
  rev: number
}
export interface IssueEntry {
  title: string
  state: string
  labels: string[]
  assignees: string[]
  author: string
  updatedAt: string
  url: string
  parent: number | null
  subIssues: number[]
  blockedBy: number[]
  sha: string
  bodySha: string
  rev: number
}
export interface CacheState {
  schema: 1
  repo: string
  number: number
  rev: number
  issueEtag: string | null
  commentsEtag: string | null
  fetchedAt: string
  issue: IssueEntry | null
  comments: Record<string, CommentEntry>
  removed: Array<{ id: number; file: string; rev: number }>
}
export interface Change { kind: 'issue' | 'comment' | 'removed'; file: string; rev: number; id?: number; type?: string }
export interface SyncResult { dir: string; cursor: number; changes: Change[]; requests: number }

const CLAIM_LINE = /<!--\s*vsk:claim\b[^>]*-->\r?\n?/g
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export function cacheDir(root: string, repo: string, number: number): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repository: ${repo}`)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid issue number: ${number}`)
  return join(root, '.vegastack', '.tmp', 'issues', repo.replace('/', '__'), String(number))
}

// The `type` from a comment's `<!-- vsk:v1 type=… -->` top line; `human` when there is none.
export function commentType(body: string): string {
  const marker = /^\s*<!--\s*vsk:v1\s+([^>]*?)\s*-->/.exec(body ?? '')
  const type = marker ? /(?:^|\s)type=([\w-]+)/.exec(marker[1]!)?.[1] : null
  return type ?? 'human'
}

// Heartbeat edits only touch the claim line; they are not a change worth re-reading.
export const meaningfulSha = (body: string) => sha((body ?? '').replace(CLAIM_LINE, ''))

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/Z$/, '')
export const commentFile = (comment: GhComment, type: string) => `comments/${stamp(comment.created_at)}-${type}-${comment.id}.md`

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

export function readState(dir: string): CacheState | null {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8')) as CacheState
  if (state.schema !== 1) throw new Error(`unsupported cache schema in ${path} — delete the folder and sync again`)
  return state
}

// One writer per issue at a time. A lock older than `staleMs` belongs to a dead process.
export function withLock<T>(dir: string, fn: () => T, { timeoutMs = 10_000, staleMs = 60_000 } = {}): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.lock')
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { recursive: true, force: true }); continue }
      } catch { continue }
      if (Date.now() - started > timeoutMs) throw new Error(`issue cache is locked by another process: ${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function labelNames(issue: GhIssue): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).sort()
}

function optionalList(path: string, runner: GhRunner): Array<{ number: number; state?: string }> {
  try {
    return ghList<{ number: number; state?: string }>(path, runner)
  } catch (error) {
    if (error instanceof GhError && error.status === 404) return []
    throw error
  }
}

function optionalParent(repo: string, number: number, runner: GhRunner): number | null {
  try {
    return ghRequest<{ number: number }>(`repos/${repo}/issues/${number}/parent`, { runner }).body.number
  } catch (error) {
    if (error instanceof GhError && error.status === 404) return null
    throw error
  }
}

export interface SyncOptions {
  root: string
  repo: string
  number: number
  since?: number
  runner?: GhRunner
  now?: () => Date
}

export function syncIssue(options: SyncOptions): SyncResult {
  const { root, repo, number, since = 0, runner = defaultRunner, now = () => new Date() } = options
  const dir = cacheDir(root, repo, number)
  return withLock(dir, () => {
    let requests = 0
    const previous = readState(dir)
    const state: CacheState = previous ?? {
      schema: 1, repo, number, rev: 0, issueEtag: null, commentsEtag: null, fetchedAt: '', issue: null, comments: {}, removed: [],
    }

    const issueResponse = ghRequest<GhIssue>(`repos/${repo}/issues/${number}`, { etag: state.issue ? state.issueEtag : null, runner })
    requests++
    const commentsPath = `repos/${repo}/issues/${number}/comments?per_page=100&page=1`
    const firstPage = ghRequest<GhComment[]>(commentsPath, { etag: previous ? state.commentsEtag : null, runner })
    requests++

    if (issueResponse.status !== 304) {
      const issue = issueResponse.body
      const subIssues = optionalList(`repos/${repo}/issues/${number}/sub_issues`, runner).map((item) => item.number).sort((a, b) => a - b)
      const blockedBy = optionalList(`repos/${repo}/issues/${number}/dependencies/blocked_by`, runner)
        .filter((item) => item.state !== 'closed').map((item) => item.number).sort((a, b) => a - b)
      const parent = optionalParent(repo, number, runner)
      requests += 3
      const fields = {
        title: issue.title, state: issue.state, labels: labelNames(issue), assignees: (issue.assignees ?? []).map((user) => user.login).sort(),
        author: issue.user?.login ?? '', updatedAt: issue.updated_at, url: issue.html_url, parent, subIssues, blockedBy,
      }
      const body = issue.body ?? ''
      const { updatedAt, ...stable } = fields
      const nextSha = sha(JSON.stringify(stable) + '\n' + body)
      if (state.issue?.sha !== nextSha) {
        state.rev++
        atomicWrite(join(dir, 'issue.md'), frontmatter({ repo, number, ...fields }) + body)
        state.issue = { ...fields, sha: nextSha, bodySha: meaningfulSha(body), rev: state.rev }
      } else {
        state.issue = { ...state.issue, updatedAt }
      }
      state.issueEtag = issueResponse.headers.etag ?? null
    }

    if (firstPage.status !== 304) {
      const pages = firstPage.body.length < 100
        ? firstPage.body
        : [...firstPage.body, ...ghList<GhComment>(`repos/${repo}/issues/${number}/comments`, runner).slice(100)]
      if (firstPage.body.length >= 100) requests++
      const expected = issueResponse.status === 304 ? null : issueResponse.body.comments
      if (expected !== null && expected !== pages.length) {
        throw new Error(`issue #${number} reports ${expected} comments but ${pages.length} were read — sync again`)
      }
      const seen = new Set<string>()
      for (const comment of pages) {
        const key = String(comment.id)
        seen.add(key)
        const type = commentType(comment.body)
        const file = commentFile(comment, type)
        const old = state.comments[key]
        const nextSha = meaningfulSha(comment.body)
        const content = frontmatter({
          id: comment.id, type, author: comment.user?.login ?? '', authorType: comment.user?.type ?? 'User',
          createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url,
        }) + comment.body
        if (old && old.file !== file) rmSync(join(dir, old.file), { force: true })
        atomicWrite(join(dir, file), content)
        const changed = !old || old.sha !== nextSha || old.type !== type
        if (changed) state.rev++
        state.comments[key] = {
          id: comment.id, file, type, author: comment.user?.login ?? '', authorType: comment.user?.type ?? 'User',
          createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url, sha: nextSha,
          rev: changed ? state.rev : old!.rev,
        }
      }
      for (const [key, entry] of Object.entries(state.comments)) {
        if (seen.has(key)) continue
        rmSync(join(dir, entry.file), { force: true })
        delete state.comments[key]
        state.rev++
        state.removed.push({ id: entry.id, file: entry.file, rev: state.rev })
      }
      state.commentsEtag = firstPage.headers.etag ?? null
    }

    state.fetchedAt = now().toISOString()
    atomicWrite(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n')
    return { dir, cursor: state.rev, changes: changesSince(state, since), requests }
  })
}

export function changesSince(state: CacheState, since: number): Change[] {
  const changes: Change[] = []
  if (state.issue && state.issue.rev > since) changes.push({ kind: 'issue', file: 'issue.md', rev: state.issue.rev })
  for (const entry of Object.values(state.comments)) {
    if (entry.rev > since) changes.push({ kind: 'comment', file: entry.file, rev: entry.rev, id: entry.id, type: entry.type })
  }
  for (const removed of state.removed) {
    if (removed.rev > since) changes.push({ kind: 'removed', file: removed.file, rev: removed.rev, id: removed.id })
  }
  return changes.sort((a, b) => a.rev - b.rev)
}

export function readBody(dir: string, file: string): string {
  const text = readFileSync(join(dir, file), 'utf8')
  const end = text.indexOf('\n---\n', 4)
  return end === -1 ? text : text.slice(end + 5)
}

// Deletes an issue's cache folder (after merge or close).
export function dropIssue(root: string, repo: string, number: number) {
  rmSync(cacheDir(root, repo, number), { recursive: true, force: true })
}

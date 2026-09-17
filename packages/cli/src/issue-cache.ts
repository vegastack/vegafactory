// The agent-side issue cache: one folder per issue under .vegastack/.tmp/issues/.
// Agents read files, not the API. `syncIssue` asks GitHub "changed?" with ETags and
// reports only what changed since the caller's cursor; writes go to GitHub first and
// the cache is updated from GitHub's reply.
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
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
  artifact: string
  // When `artifact` last changed: ticked boxes, heartbeats and progress edits do not count.
  changedAt: string
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
  commentCount: number
  sha: string
  bodySha: string
  // When the body last changed in a way an ack cares about (GitHub keeps no separate edit time).
  bodyChangedAt: string
  rev: number
}
// One entry per comments page: its ETag and the comment ids it held.
export interface CommentPage { etag: string | null; ids: number[] }
export interface CacheState {
  schema: 1
  repo: string
  number: number
  rev: number
  issueEtag: string | null
  commentPages: CommentPage[]
  fetchedAt: string
  issue: IssueEntry | null
  comments: Record<string, CommentEntry>
  removed: Array<{ id: number; file: string; rev: number }>
}
export interface Change { kind: 'issue' | 'comment' | 'removed'; file: string; rev: number; id?: number; type?: string }
export interface SyncResult { dir: string; cursor: number; changes: Change[]; requests: number }

const CLAIM_LINE = /<!--\s*vsk:claim\b[^>]*-->\r?\n?/g
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// OWNER/NAME, checked before the value reaches any API path.
export function assertRepo(repo: string): string {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || /(^|\/)\.\.?$/.test(repo)) throw new Error(`invalid repository: ${repo} — use OWNER/NAME`)
  return repo
}

export function cacheDir(root: string, repo: string, number: number): string {
  assertRepo(repo)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid issue number: ${number}`)
  return join(root, '.vegastack', '.tmp', 'issues', repo.replace('/', '__'), String(number))
}

export const WRITE_ROLES = new Set(['admin', 'maintain', 'write'])
export type PermissionLookup = (login: string) => string
const PERMISSION_TTL_MS = 10 * 60_000

// A login's role on the repository. Each process asks GitHub once per login; with `root` the
// answers are also kept on disk for ten minutes, so a hook on every tool call stays cheap.
export function permissionLookup(repo: string, runner: GhRunner, { root, now = Date.now }: { root?: string; now?: () => number } = {}): PermissionLookup {
  const memory = new Map<string, string>()
  const file = root ? join(root, '.vegastack', '.tmp', 'issues', assertRepo(repo).replace('/', '__'), 'permissions.json') : null
  const load = (): Record<string, { permission: string; at: number }> => {
    try { return file ? JSON.parse(readFileSync(file, 'utf8')) : {} } catch { return {} }
  }
  return (login) => {
    if (memory.has(login)) return memory.get(login)!
    const saved = load()[login]
    if (saved && now() - saved.at < PERMISSION_TTL_MS && now() >= saved.at) {
      memory.set(login, saved.permission)
      return saved.permission
    }
    let permission = 'none'
    try {
      permission = ghRequest<{ permission: string }>(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { runner }).body.permission
      if (file) {
        try { atomicWrite(file, JSON.stringify({ ...load(), [login]: { permission, at: now() } })) } catch { /* the disk copy is only a cache */ }
      }
    } catch { /* unknown logins and failed lookups have no access */ }
    memory.set(login, permission)
    return permission
  }
}

// The `type` from a comment's `<!-- vsk:v1 type=… -->` top line; `human` when there is none.
export function commentType(body: string): string {
  const marker = /^\s*<!--\s*vsk:v1\s+([^>]*?)\s*-->/.exec(body ?? '')
  const type = marker ? /(?:^|\s)type=([\w-]+)/.exec(marker[1]!)?.[1] : null
  return type ?? 'human'
}

// Heartbeat edits only touch the claim line; they are not a change worth re-reading.
export const meaningfulSha = (body: string) => sha((body ?? '').replace(CLAIM_LINE, ''))

// The 12-hex hash an ack binds to. Ticking plan checkboxes, heartbeats and the progress block do not change it.
export function artifactHash(text: string): string {
  const normalized = (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*vsk:claim\b[^>]*-->\n?/g, '')
    .replace(/<!--\s*vsk:progress:start\s*-->[\s\S]*?<!--\s*vsk:progress:end\s*-->\n?/g, '')
    .replace(/^(\s*[-*] )\[[xX]\]/gm, '$1[ ]')
    .trim()
  return sha(normalized).slice(0, 12)
}

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/Z$/, '')
export const commentFile = (comment: GhComment, type: string) => `comments/${stamp(comment.created_at)}-${type}-${comment.id}.md`

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

// Creates the file or fails. `wx` is O_CREAT|O_EXCL, which refuses a name that already exists —
// a symbolic link included, dangling or not — so a planted link can never be written through.
export function writeNew(path: string, text: string) {
  writeFileSync(path, text, { flag: 'wx' })
}

// Replaces a file without ever following a link: the temporary name is unguessable and created
// exclusively, and rename replaces the target name itself. A failed write leaves nothing behind.
export function replaceFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeNew(temp, text)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const atomicWrite = replaceFile

export function readState(dir: string): CacheState | null {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8')) as CacheState
  if (state.schema !== 1 || !Array.isArray(state.commentPages)) throw new Error(`unsupported cache schema in ${path} — delete the folder and sync again`)
  return state
}

// One writer per issue at a time, across processes. The lock records its owner; another
// process takes it over only when that owner is provably gone, and only the owner removes it.
// Re-entrant inside one process, so a write can sync while it holds the lock.
const held = new Map<string, string>()
interface LockOwner { token: string; pid: number; host: string; at: number }

function ownerGone(owner: LockOwner | null, lockDir: string, staleMs: number): boolean {
  if (!owner) {
    // Created but not yet written, or written by a crashed process: judge by age.
    try { return Date.now() - statSync(lockDir).mtimeMs > staleMs } catch { return true }
  }
  if (owner.host !== hostname()) return Date.now() - owner.at > staleMs
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function readOwner(lockDir: string): LockOwner | null {
  try { return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as LockOwner } catch { return null }
}

// Creates `dir` as a lock owned by `token`; false when someone else holds it.
function acquire(dir: string, token: string): boolean {
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() }))
  return true
}

// Removes `dir` only while `token` still owns it.
function release(dir: string, token: string) {
  if (readOwner(dir)?.token === token) rmSync(dir, { recursive: true, force: true })
}

// Removing a dead owner's lock happens under a second lock with the same owner rules, and only
// after re-reading that the issue lock still belongs to the owner judged dead. While `.lock`
// exists nobody else can create it, so the re-read and the removal see the same owner. A dead
// stealer's mutex is never removed automatically. Returns false when the takeover could not run now.
export function takeOver(lock: string, deadToken: string | null, staleMs: number): boolean {
  const steal = `${lock}.steal`
  const token = randomUUID()
  if (!acquire(steal, token)) {
    // Freeing another process's mutex cannot be made atomic here, so a dead stealer is left for a person.
    if (ownerGone(readOwner(steal), steal, staleMs)) {
      throw new Error(`a crashed process left a takeover lock behind — check no vegafactory command is running, then delete this directory: ${JSON.stringify(steal)}`)
    }
    return false
  }
  try {
    const current = readOwner(lock)
    if ((current?.token ?? null) === deadToken && ownerGone(current, lock, staleMs)) {
      rmSync(lock, { recursive: true, force: true })
      return true
    }
    return false
  } finally {
    release(steal, token)
  }
}

export function withLock<T>(dir: string, fn: () => T, { timeoutMs = 10_000, staleMs = 10 * 60_000, what = 'issue cache' } = {}): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.lock')
  if (held.has(lock)) return fn()
  const token = randomUUID()
  const started = Date.now()
  for (;;) {
    if (acquire(lock, token)) break
    const owner = readOwner(lock)
    if (ownerGone(owner, lock, staleMs) && takeOver(lock, owner?.token ?? null, staleMs)) continue
    if (Date.now() - started > timeoutMs) throw new Error(`${what} is locked by pid ${owner?.pid ?? '?'} on ${owner?.host ?? '?'}: ${lock}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  held.set(lock, token)
  try {
    return fn()
  } finally {
    held.delete(lock)
    release(lock, token)
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

// GitHub's REST issue has no body-edit time (updated_at moves on every comment); GraphQL does.
function lastEditedAt(repo: string, number: number, runner: GhRunner): string {
  const [owner, name] = repo.split('/')
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){createdAt lastEditedAt}}}'
  const { body } = ghRequest<{ data?: { repository?: { issue?: { createdAt: string; lastEditedAt: string | null } } } }>('graphql', {
    method: 'POST', body: { query, variables: { owner, name, number } }, runner,
  })
  const issue = body.data?.repository?.issue
  if (!issue) throw new GhError(`could not read the edit time of issue #${number}`)
  return issue.lastEditedAt ?? issue.createdAt
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
  return withLock(cacheDir(options.root, options.repo, options.number), () => syncLocked(options))
}

const PAGE = 100

function syncLocked(options: SyncOptions): SyncResult {
  const { root, repo, number, since = 0, runner = defaultRunner, now = () => new Date() } = options
  const dir = cacheDir(root, repo, number)
  let requests = 0
  const previous = readState(dir)
  const state: CacheState = previous ?? {
    schema: 1, repo, number, rev: 0, issueEtag: null, commentPages: [], fetchedAt: '', issue: null, comments: {}, removed: [],
  }

  const issueResponse = ghRequest<GhIssue>(`repos/${repo}/issues/${number}`, { etag: state.issue ? state.issueEtag : null, runner })
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
    const bodySha = meaningfulSha(body)
    let bodyChangedAt = state.issue?.bodyChangedAt ?? ''
    if (state.issue?.bodySha !== bodySha) {
      bodyChangedAt = lastEditedAt(repo, number, runner)
      requests++
    }
    if (state.issue?.sha !== nextSha) {
      state.rev++
      atomicWrite(join(dir, 'issue.md'), frontmatter({ repo, number, ...fields }) + body)
      state.issue = { ...fields, commentCount: issue.comments, sha: nextSha, bodySha, bodyChangedAt, rev: state.rev }
    } else {
      state.issue = { ...state.issue!, updatedAt, commentCount: issue.comments, bodyChangedAt }
    }
    state.issueEtag = issueResponse.headers.etag ?? null
  }

  // Every page is asked conditionally (a 304 is free); an unchanged page keeps its cached ids.
  const pages: CommentPage[] = []
  const fresh: GhComment[] = []
  let changed = false
  for (let page = 1; ; page++) {
    const cached = state.commentPages[page - 1]
    const response = ghRequest<GhComment[]>(`repos/${repo}/issues/${number}/comments?per_page=${PAGE}&page=${page}`, { etag: cached?.etag ?? null, runner })
    requests++
    if (response.status === 304 && cached) {
      pages.push(cached)
    } else {
      if (!Array.isArray(response.body)) throw new GhError(`expected a list of comments for issue #${number}`)
      changed = true
      fresh.push(...response.body)
      pages.push({ etag: response.headers.etag ?? null, ids: response.body.map((comment) => comment.id) })
    }
    if (pages.at(-1)!.ids.length < PAGE) break
  }
  if (pages.length !== state.commentPages.length) changed = true

  if (changed) {
    const seen = new Set(pages.flatMap((page) => page.ids).map(String))
    const expected = state.issue?.commentCount ?? seen.size
    if (expected !== seen.size) {
      throw new Error(`issue #${number} reports ${expected} comments but ${seen.size} were read — sync again`)
    }
    for (const comment of fresh) {
      const key = String(comment.id)
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
      const isChange = !old || old.sha !== nextSha || old.type !== type
      const artifact = artifactHash(comment.body)
      const meaningfulChange = !old || old.type !== type || old.artifact !== artifact
      if (isChange) state.rev++
      state.comments[key] = {
        id: comment.id, file, type, author: comment.user?.login ?? '', authorType: comment.user?.type ?? 'User',
        createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url, sha: nextSha, artifact,
        changedAt: meaningfulChange ? comment.updated_at : old!.changedAt,
        rev: isChange ? state.rev : old!.rev,
      }
    }
    for (const [key, entry] of Object.entries(state.comments)) {
      if (seen.has(key)) continue
      rmSync(join(dir, entry.file), { force: true })
      delete state.comments[key]
      state.rev++
      state.removed.push({ id: entry.id, file: entry.file, rev: state.rev })
    }
    state.commentPages = pages
  }

  state.fetchedAt = now().toISOString()
  atomicWrite(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n')
  return { dir, cursor: state.rev, changes: changesSince(state, since), requests }
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
  const dir = cacheDir(root, repo, number)
  withLock(dir, () => {
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) if (entry !== '.lock') rmSync(join(dir, entry), { recursive: true, force: true })
  })
  rmSync(dir, { recursive: true, force: true })
}

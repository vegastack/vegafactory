// `vegafactory hook <event> --harness claude|codex` — one command behind every harness hook.
//
// The issue comes from the worktree folder (.vegastack/.worktrees/<n>-…) or the branch
// (<type>/<n>-…). With no issue only the ship guard runs. Advisory events never block and
// exit 0 on any error; only pre-tool can deny, and its guard fails closed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { claimsOf, holderOf, ownerId, trustedFactory, HEARTBEAT_EVERY_MS, type Holder } from './claim.ts'
import { defaultRunner, type GhRunner } from './gh.ts'
import { canCommit, classifyCommand, extractCommand, isShellTool, loadPolicy, mergeTarget, type Decision, type MergeCheck } from './guard-rules.ts'
import { cacheDir, readBody, readState, replaceFile, syncIssue, withLock } from './issue-cache.ts'
import { askText, learningsPath, pendingNote } from './learning.ts'
import { detectRepo, evidenceChangedAt, findValidAck, latestOfType, permissionLookup, repoRoot, snapshot } from './issue.ts'
import { stateOf } from './labels.ts'
import { effectiveUpdateMode, installArgs, latestPublishedVersion, maintainSelfUpdate, packageVersion, readUpdateNote, SELF_UPDATE_LIMIT_S, writeUpdateNote, type LatestVersion } from './self-update.ts'

export const HOOK_EVENTS = ['session-start', 'prompt', 'pre-tool', 'post-tool', 'stop', 'session-end'] as const
export type HookEvent = typeof HOOK_EVENTS[number]
type Harness = 'claude' | 'codex'

export const MAX_INPUT_BYTES = 64 * 1024
const INPUT_WAIT_MS = 350
const REFRESH_EVERY_MS = 60_000
// A gap longer than this between tool calls is idle time, not work.
const ACTIVE_GAP_MS = 5 * 60_000
// Tools that change files; they and the shell tools stop once the claim is lost.
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

export function hookUsage(): string {
  return `Usage: vegafactory hook <event> --harness claude|codex   (reads the hook payload on stdin)

Events and the harness hooks they belong on:
  session-start   SessionStart         the issue, its holder, where its local copy lives, and any lessons waiting for dev.md
  prompt          UserPromptSubmit     a warning when someone else holds the issue
  pre-tool        PreToolUse           the ship guard; stops file and shell tools after the claim is lost
  post-tool       PostToolUse, SubagentStop   the heartbeat
  stop            Stop                 commits and pushes a WIP checkpoint of the turn, and asks a
                                       working session once for the general lessons it taught
  session-end     SessionEnd           a last heartbeat (the claim is kept, the session may resume)

Session start, stop and session end also collect usage numbers from the harness session logs in
the background, and a session start asks to share them (at most once an hour).
`
}

// ---------------------------------------------------------------------------------------------
// Input

export interface HookInput { payload: Record<string, unknown> | null; head: string }

// Reads stdin up to the byte bound and the wait. An oversized or late payload is null, with the
// first bytes kept so pre-tool can still tell which tool it was.
export function readHookInput(stream: NodeJS.ReadableStream = process.stdin, { maxBytes = MAX_INPUT_BYTES, waitMs = INPUT_WAIT_MS } = {}): Promise<HookInput> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let finished = false
    const head = () => Buffer.concat(chunks).subarray(0, 4096).toString('utf8')
    const done = (payload: Record<string, unknown> | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stream.removeAllListeners('data')
      stream.pause()
      resolve({ payload, head: head() })
    }
    const timer = setTimeout(() => done(null), waitMs)
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > maxBytes) { chunks.push(bytes); return done(null) }
      chunks.push(bytes)
    })
    stream.once('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        done(value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)
      } catch { done(null) }
    })
    stream.once('error', () => done(null))
  })
}

// ---------------------------------------------------------------------------------------------
// Where we are

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() || (result.stderr ?? '').trim() }
}

export function issueFromWorktree(top: string): number | null {
  const attended = /[/\\]\.vegastack[/\\]\.worktrees[/\\](\d+)(?:-[^/\\]+)?$/.exec(top)
  if (attended) return Number(attended[1])
  const worker = /[/\\]worker[/\\]repos[/\\][a-z0-9_.-]+__[a-z0-9_.-]+[/\\]issues[/\\](\d+)$/.exec(top)
  const match = worker
  return match ? Number(match[1]) : null
}

export function issueFromBranch(branch: string): number | null {
  const match = /^[\w.-]+\/(\d+)-/.exec(branch)
  return match ? Number(match[1]) : null
}

function headOf(cwd: string): string | null {
  const head = git(cwd, ['rev-parse', 'HEAD'])
  return head.ok ? head.out : null
}

export interface Where { cwd: string; top: string; root: string; repo: string; number: number; owner: string; branch: string }

export function locate(cwd: string, host = hostname()): Where | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const branch = git(cwd, ['branch', '--show-current']).out
  const number = issueFromWorktree(top.out) ?? issueFromBranch(branch)
  if (!number) return null
  const root = repoRoot(cwd)
  return { cwd, top: top.out, root, repo: detectRepo(root), number, owner: ownerId(basename(top.out), host), branch }
}

// ---------------------------------------------------------------------------------------------
// The local claim file: checked on every call, refreshed from GitHub at most once a minute.

export interface LocalClaim {
  owner: string
  lastActive: number | null
  activeMs: number
  lastPush: number | null
  checkedAt: number | null
  held: boolean
  holder: string | null
  // Set when another session holds the issue after this worktree had claimed it.
  lostTo: string | null
  // The claim comment of the holder this worktree already saved its work for.
  rescuedFor: number | null
}

export const localPath = (where: Where) => join(where.top, '.vegastack', '.tmp', 'claims', `${where.number}.json`)

export function readLocal(where: Where): LocalClaim {
  const blank: LocalClaim = { owner: where.owner, lastActive: null, activeMs: 0, lastPush: null, checkedAt: null, held: false, holder: null, lostTo: null, rescuedFor: null }
  try {
    const saved = JSON.parse(readFileSync(localPath(where), 'utf8')) as LocalClaim
    return saved.owner === where.owner ? { ...blank, ...saved } : blank
  } catch { return blank }
}

function writeLocal(where: Where, local: LocalClaim) {
  replaceFile(localPath(where), JSON.stringify(local, null, 2) + '\n')
}

// One mark per harness session: the HEAD that session last saw at an event of its own, whether it
// has been seen to do work, and whether the lessons request already went out. Two sessions can
// share a worktree, so this is keyed by session id and kept apart from the claim file, which every
// tool call rewrites — a shared field there would clobber a neighbour's baseline. Every change
// takes the lock, re-reads and replaces the file, so the change is the whole read-modify-write and
// not just the write. No event ever writes another session's mark: a worktree's HEAD is shared, so
// a HEAD that moved is only this session's work when this session's own events bracket the move.
export interface SessionMark {
  head: string | null
  worked: boolean
  asked: boolean
  at: number
  // Set while one of this session's own shell tools is running: the HEAD it began at, when, and
  // whether the command in it could produce a commit at all.
  pending?: { head: string | null; at: number; commits: boolean }
  // The commit this session was credited with, and the commit this mark has already ruled on.
  // A commit is ruled on once, by whichever window closes over it first, and never again.
  credited?: string
  judged?: string
}

export const sessionsPath = (where: Where) => join(where.top, '.vegastack', '.tmp', 'claims', `${where.number}.sessions.json`)

// Only the most recent sessions are kept; the file is a working note, not a record.
const SESSIONS_KEPT = 8

function updateSessions<T>(where: Where, change: (marks: Record<string, SessionMark>) => T): T {
  const path = sessionsPath(where)
  return withLock(dirname(path), () => {
    let marks: Record<string, SessionMark> = {}
    try { marks = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SessionMark> } catch { /* the first session of this worktree */ }
    const result = change(marks)
    const kept = Object.entries(marks).sort(([, a], [, b]) => b.at - a.at).slice(0, SESSIONS_KEPT)
    replaceFile(path, JSON.stringify(Object.fromEntries(kept), null, 2) + '\n')
    return result
  }, { what: 'the session marks' })
}

// What an event tells us about the session it belongs to:
//   'idle'        only where its HEAD stands now — a session start, a prompt, the end of a session
//   'tool-start'  one of its own shell tools is about to run, from the HEAD recorded now, with
//                 whether the command in it could commit at all
//   'tool-end'    that tool finished; a commit made while it ran may be this session's work
//   'commit'      its own Stop checkpoint made the commit, which is its work by construction
// A worktree's HEAD is shared, so a HEAD that simply differs proves nothing: a neighbour may have
// moved it. Only a shell tool can produce a commit, so only a shell tool opens a window — a file
// tool cannot commit and would be pure guessing surface — and only a window whose command could
// commit counts for anything. Where the evidence is unclear the session goes unasked rather than
// credited with someone else's commit.
type Observed = 'idle' | 'tool-start' | 'tool-end' | 'commit'

// When the commit now at HEAD was made. Git keeps seconds, so callers give the window a second's
// room at each end.
function committedAt(cwd: string): number | null {
  const at = git(cwd, ['log', '-1', '--format=%ct'])
  if (!at.ok) return null
  const made = Number(at.out) * 1000
  return Number.isFinite(made) ? made : null
}

// One commit, one ruling. A window can own the commit only when it was open across it and the
// command in it could have made one — a `sleep` is neither a claimant nor a rival. One candidate
// is credited; two mean either could have made it, so neither is, and neither may claim it later.
// The commit is named in the ruling, so a window closing afterwards cannot re-open a settled
// question. A window from an older build says nothing about its command, so it is taken as capable.
function rule(where: Where, marks: Record<string, SessionMark>, session: string, head: string, now: number) {
  const mark = marks[session]!
  const made = committedAt(where.top)
  if (made === null) return
  const covers = (window: SessionMark['pending']) => !!window && window.commits !== false && made >= window.at - 1000 && made <= now + 1000
  if (!covers(mark.pending)) return
  if (Object.values(marks).some((other) => other.judged === head)) return
  const rivals = Object.entries(marks).filter(([id, other]) => id !== session && covers(other.pending))
  mark.judged = head
  if (rivals.length) {
    for (const [, other] of rivals) other.judged = head
    return
  }
  mark.worked = true
  mark.credited = head
}

// Written the first time any of that session's events is seen, and before anything that can fail,
// so a refresh that throws still leaves the session able to tell work from talk.
function observe(where: Where, session: string | null, now: number, kind: Observed = 'idle', commits = true) {
  if (!session) return
  updateSessions(where, (marks) => {
    const head = headOf(where.top)
    const mark = marks[session] ?? (marks[session] = { head, worked: false, asked: false, at: now })
    if (kind === 'commit' && head !== null) {
      // commitWork knows it made this one, so no window and no rival can put it elsewhere.
      mark.worked = true
      mark.credited = head
      mark.judged = head
    }
    if (kind === 'tool-end' && head !== null && mark.pending?.head != null && mark.pending.head !== head) rule(where, marks, session, head, now)
    // A window belongs to the one tool that opened it; anything else closes it unused.
    if (kind === 'tool-start') mark.pending = { head, at: now, commits }
    else delete mark.pending
    mark.head = head
    mark.at = now
  })
}

// True once per session, and only for a session seen to do work: a session that only talked has no
// lessons to give. The decision and the record of it happen inside the same lock.
function claimAsk(where: Where, session: string | null, now: number): boolean {
  if (!session) return false
  return updateSessions(where, (marks) => {
    const mark = marks[session]
    if (!mark || mark.asked || !mark.worked) return false
    mark.asked = true
    mark.at = now
    return true
  })
}

const label = (h: Holder) => `${h.owner} (${h.harness}${h.model ? ` · ${h.model}` : ''})`

function refresh(where: Where, local: LocalClaim, deps: HookDeps, force = false): { holder: Holder | null; state: string | null } {
  const dir = cacheDir(where.root, where.repo, where.number)
  if (force || !local.checkedAt || deps.now() - local.checkedAt >= REFRESH_EVERY_MS) {
    syncIssue({ root: where.root, repo: where.repo, number: where.number, runner: deps.runner })
    local.checkedAt = deps.now()
  }
  const cached = readState(dir)
  if (!cached?.issue) return { holder: null, state: null }
  const body = (entry: { file: string }) => readBody(dir, entry.file)
  const trusted = trustedFactory({ repo: where.repo, runner: deps.runner, root: where.root })
  const { holder } = holderOf(cached, body, deps.now(), trusted)
  const everClaimed = claimsOf(cached, body, trusted).history.some((c) => c.owner === where.owner)
  local.held = holder?.owner === where.owner
  local.holder = holder ? label(holder) : null
  local.lostTo = holder && !local.held && everClaimed ? local.holder : null
  if (local.lostTo === null) local.rescuedFor = null
  return { holder, state: stateOf(cached.issue.labels).state }
}

function recordActivity(local: LocalClaim, now: number) {
  if (local.lastActive !== null) {
    const gap = now - local.lastActive
    if (gap > 0 && gap < ACTIVE_GAP_MS) local.activeMs += gap
  }
  local.lastActive = now
}

// ---------------------------------------------------------------------------------------------
// Output

// Both harnesses document this shape for SessionStart and UserPromptSubmit.
function context(event: 'SessionStart' | 'UserPromptSubmit', text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })
}

// The Stop continuation each harness documents: Claude Code takes additionalContext as non-error
// hook feedback, Codex turns a blocking reason into the next prompt. Both keep the turn going.
function continuation(harness: Harness, text: string): Record<string, unknown> {
  return harness === 'claude'
    ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } }
    : { decision: 'block', reason: text }
}

// Codex parses permissionDecision "ask" but does not support it, so an ask is a deny there
// and the operator runs the command by hand.
export function renderDecision(harness: Harness, decision: 'ask' | 'deny', reason: string): string {
  const permission = harness === 'claude' ? decision : 'deny'
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: permission, permissionDecisionReason: reason } })
}

// ---------------------------------------------------------------------------------------------
// Side effects

export interface HookDeps {
  runner: GhRunner
  now: () => number
  out: (text: string) => void
  // Starts a process that outlives the hook; returns its pid when known.
  detach: (command: string[], cwd: string, limitSeconds?: number) => number | undefined | void
  // How to run this CLI again: the runtime and the entry file.
  cli: string[]
  host: string
  latest: LatestVersion
  // Where this machine keeps its own files. Injected so a test can point it somewhere harmless:
  // the update note lives here, and a test that reached the real home would rewrite what the
  // operator's own machine believes about the last registry check.
  home: string
}

export const DETACHED_LIMIT_S = 60
// Runs the command in its own process group and kills the whole group when the limit passes.
const WATCHDOG = '"$@" & job=$!; (sleep "$VF_LIMIT"; kill -KILL 0) & dog=$!; wait "$job"; code=$?; kill "$dog" 2>/dev/null; exit "$code"'

export function detachBounded(command: string[], cwd: string, limitSeconds = DETACHED_LIMIT_S): number | undefined {
  const child = spawn('sh', ['-c', WATCHDOG, 'vegafactory-detached', ...command], {
    cwd, detached: true, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', VF_LIMIT: String(limitSeconds) },
  })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

export const defaultDeps = (): HookDeps => ({
  runner: defaultRunner, now: Date.now, out: (text) => process.stdout.write(text + '\n'), detach: (command, cwd, limit) => detachBounded(command, cwd, limit),
  cli: [process.execPath, process.argv[1]!], host: hostname(), latest: latestPublishedVersion, home: homedir(),
})

// Secrets never leave the machine in an automatic commit: file names, then the added lines.
const SECRET_NAMES: Array<[RegExp, string]> = [
  [/^\.env(\..+)?$/, 'an env file'], [/\.(pem|key|p12)$/, 'a key file'], [/^id_rsa/, 'an SSH key'],
]
const SECRET_TEXT: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic key'],
  [/\bsk-[A-Za-z0-9_-]{32,}/, 'an API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/_auth(?:Token)?\s*=\s*(?!\$\{)\S/, 'a registry token'],
]

// The staged files that look like they carry a secret, as "path (what)".
export function stagedSecrets(cwd: string): string[] {
  const hits = new Map<string, string>()
  const names = git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).out.split('\n').filter(Boolean)
  for (const file of names) {
    const name = basename(file)
    if (name === '.env.example') continue
    const match = SECRET_NAMES.find(([pattern]) => pattern.test(name))
    if (match) hits.set(file, match[1])
  }
  const diff = spawnSync('git', ['diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10_000 })
  if (diff.status !== 0) return ['(the staged changes could not be read)']
  let file = ''
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue }
    if (!line.startsWith('+') || hits.has(file)) continue
    const match = SECRET_TEXT.find(([pattern]) => pattern.test(line))
    if (match) hits.set(file, match[1])
  }
  return [...hits].map(([path, what]) => `${path} (${what})`)
}

export interface Checkpoint { committed: boolean; secrets: string[]; reason: string | null }

// Commits every change as one `wip:` commit on the current branch. Staged secrets stop it:
// the work stays uncommitted and the files are named.
export function commitWork(cwd: string, message: string): Checkpoint {
  if (!git(cwd, ['status', '--porcelain']).out) return { committed: false, secrets: [], reason: null }
  if (midOperation(cwd)) return { committed: false, secrets: [], reason: 'a merge or rebase is in progress' }
  if (!git(cwd, ['add', '--all']).ok) return { committed: false, secrets: [], reason: 'git add failed' }
  const secrets = stagedSecrets(cwd)
  if (secrets.length) {
    git(cwd, ['reset', '--quiet'])
    return { committed: false, secrets, reason: `possible secrets, so nothing was committed: ${secrets.join(', ')}` }
  }
  const commit = git(cwd, ['commit', '--quiet', '-m', message])
  return commit.ok ? { committed: true, secrets: [], reason: null } : { committed: false, secrets: [], reason: `git commit failed: ${commit.out}` }
}

// After the claim is lost: commit the work on the issue branch and push it, never forced.
// A rejected push (the remote moved) keeps the commit local.
export function rescueWork(where: Where): string {
  if (!where.branch || issueFromBranch(where.branch) !== where.number) return ' Uncommitted work (if any) was not saved: this checkout is not on the issue branch.'
  const saved = commitWork(where.top, `wip: #${where.number} rescued uncommitted work from ${basename(where.top)}`)
  if (saved.reason) return ` Uncommitted work was not saved: ${saved.reason}.`
  if (!saved.committed) return ''
  const push = git(where.top, ['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${where.branch}`])
  if (!push.ok) return ` Uncommitted work was committed on ${where.branch} but the push was rejected (${push.out.split('\n')[0]}), so the commit stays local — pull and push by hand.`
  return ` Uncommitted work was committed and pushed to ${where.branch}.`
}

const pushFailurePath = (where: Where) => join(where.top, '.vegastack', '.tmp', 'claims', `${where.number}.push-failed`)

// The last background checkpoint push, when it was rejected.
function pushFailure(where: Where): string | null {
  try {
    const text = readFileSync(pushFailurePath(where), 'utf8').trim()
    return `The last WIP push of ${where.branch} was rejected (${text.split('\n')[0] || 'no reason given'}); the commit stays local — pull and push by hand, never forced.`
  } catch { return null }
}

const heartbeatPidPath = (where: Where) => join(where.top, '.vegastack', '.tmp', 'claims', `${where.number}.heartbeat.pid`)

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

// One background heartbeat at a time: a running one (younger than its lifetime) suppresses the next.
function pushHeartbeat(where: Where, local: LocalClaim, deps: HookDeps) {
  const pidFile = heartbeatPidPath(where)
  try {
    const running = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; at: number }
    if (deps.now() - running.at < DETACHED_LIMIT_S * 1000 && alive(running.pid)) return
  } catch { /* no heartbeat running */ }
  const pid = deps.detach([...deps.cli, 'issue', 'heartbeat', String(where.number), '--repo', where.repo, '--active', String(Math.round(local.activeMs / 60_000))], where.cwd)
  if (typeof pid === 'number') {
    replaceFile(pidFile, JSON.stringify({ pid, at: deps.now() }))
  }
  local.lastPush = deps.now()
}

function midOperation(cwd: string): boolean {
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((name) => {
    const path = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', name])
    return path.ok && existsSync(path.out)
  })
}

// ---------------------------------------------------------------------------------------------
// Events

// Allows `gh pr merge` when the PR's branch names issue n and n has a valid "ship it" after its latest evidence.
function mergeCheck(cwd: string, root: string, repo: string, deps: HookDeps): MergeCheck {
  return (words, raw) => {
    if (raw.some((word) => word === '-R' || word.startsWith('--repo')) || words.includes('--admin')) return false
    // With no argument gh merges the current branch's PR.
    const target = mergeTarget(words) ?? git(cwd, ['branch', '--show-current']).out
    if (!target) return false
    const view = deps.runner(['pr', 'view', target, '--repo', repo, '--json', 'headRefName'])
    if (view.code !== 0) return false
    const number = issueFromBranch((JSON.parse(view.stdout) as { headRefName?: string }).headRefName ?? '')
    if (!number) return false
    syncIssue({ root, repo, number, runner: deps.runner })
    const snap = snapshot(cacheDir(root, repo, number))
    const evidence = latestOfType(snap, 'evidence')
    return !!evidence && findValidAck(snap, 'ship', permissionLookup(repo, deps.runner), evidenceChangedAt(evidence)).ok
  }
}

function guard(payload: Record<string, unknown>, cwd: string, where: Where | null, deps: HookDeps): Decision {
  const command = extractCommand(payload)
  if (command === null) {
    if (isShellTool(String(payload.tool_name ?? ''))) return { decision: 'ask', reason: 'the ship guard cannot read this tool\'s command — run it by hand', rule: 'unreadable' }
    return { decision: 'allow', reason: null, rule: 'not-guarded' }
  }
  const policy = loadPolicy(cwd)
  let check: MergeCheck | undefined
  try {
    const root = where?.root ?? repoRoot(cwd)
    const repo = where?.repo ?? detectRepo(root)
    const inner = mergeCheck(cwd, root, repo, deps)
    check = (words, raw) => { try { return inner(words, raw) } catch { return false } }
  } catch { check = undefined }
  return classifyCommand(command, policy, check)
}

// After the claim is lost: the denial for a tool that changes files, saving the work once.
function ownership(harness: Harness, where: Where, deps: HookDeps): string | null {
  try {
    const local = readLocal(where)
    refresh(where, local, deps)
    if (local.lostTo) {
      const holder = refresh(where, local, deps, true).holder
      if (local.lostTo && holder) {
        let saved = ''
        if (local.rescuedFor !== holder.commentId) {
          saved = rescueWork(where)
          local.rescuedFor = holder.commentId
        }
        writeLocal(where, local)
        return renderDecision(harness, 'deny', `issue #${where.number} is now held by ${local.lostTo}, so this session must stop changing files.${saved} To take it back: vegafactory issue claim ${where.number} --harness ${harness} --model <model> --take-back-by <login>`)
      }
    }
    writeLocal(where, local)
  } catch { /* a failed ownership check never blocks */ }
  return null
}

const whereAt = (cwd: string, deps: HookDeps): Where | null => {
  try { return locate(cwd, deps.host) } catch { return null }
}

// Tools that only read; they pass even when the payload cannot be read.
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'view_image'])

function preTool(harness: Harness, input: HookInput, deps: HookDeps): void {
  const payload = input.payload
  if (!payload) {
    // Too big or unreadable: a read-only tool passes, a file tool still gets the ownership
    // check (from the hook's own cwd), anything else asks.
    const tool = /"tool_name"\s*:\s*"([^"]+)"/.exec(input.head)?.[1] ?? ''
    if (READ_ONLY_TOOLS.has(tool)) return
    if (FILE_TOOLS.has(tool)) {
      const here = whereAt(process.cwd(), deps)
      const denied = here ? ownership(harness, here, deps) : null
      if (denied) deps.out(denied)
      return
    }
    return deps.out(renderDecision(harness, 'ask', 'the ship guard could not read the hook payload — run the command by hand'))
  }
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  const here = whereAt(cwd, deps)
  const tool = String(payload.tool_name ?? '')
  if (here && (FILE_TOOLS.has(tool) || isShellTool(tool))) {
    // Only a shell tool can produce a commit, so only a shell tool opens a window this session may
    // later be credited for. A file tool writes files; the Stop checkpoint is what commits them.
    const session = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null
    if (isShellTool(tool)) try { observe(here, session, deps.now(), 'tool-start', canCommit(extractCommand(payload))) } catch { /* attribution is never a gate */ }
    const denied = ownership(harness, here, deps)
    if (denied) return deps.out(denied)
  }

  let decision: Decision
  try {
    decision = guard(payload, cwd, here, deps)
  } catch (error) {
    decision = { decision: 'ask', reason: `the ship guard failed (${(error as Error).message}) — run the command by hand`, rule: 'guard-error' }
  }
  if (decision.decision === 'ask') deps.out(renderDecision(harness, 'ask', decision.reason!))
}

function takeBack(where: Where, harness: Harness, model: string) {
  return `vegafactory issue claim ${where.number} --harness ${harness} --model ${model} --take-back-by <login>`
}

// Usage numbers are read from the harnesses' own session logs, in the background, at turn
// boundaries — never in the session's way, and a failure is silent. The push is bounded to once
// an hour by the command itself, so a session start can always ask for it.
function collectStats(event: HookEvent, cwd: string, deps: HookDeps) {
  if (event !== 'session-start' && event !== 'stop' && event !== 'session-end') return
  deps.detach([...deps.cli, 'stats', 'collect'], cwd)
  if (event === 'session-start') deps.detach([...deps.cli, 'stats', 'push'], cwd)
}

// A background install finishes after the session that started it has moved on, so the session
// that comes next is the one that can say whether it worked. The note records what was being
// attempted; this reads it back against the version actually running now.
function finishedUpdate(now: number, home: { home: string }): string | null {
  const note = readUpdateNote(home)
  if (!note.startedFrom || typeof note.startedAt !== 'number') return null
  // Only the attempt is consumed. Clearing the whole note would drop `checkedAt` and `latest`
  // too, and the very next session would ask npm again inside the hour this note exists to hold.
  const keep = () => writeUpdateNote({ checkedAt: note.checkedAt, latest: note.latest, attemptedAt: note.attemptedAt }, home)
  if (packageVersion !== note.startedFrom) {
    keep()
    return `vegafactory updated ${note.startedFrom} → ${packageVersion} in the background since the last session`
  }
  // Still on the old version well past npm's own bound: the install did not land. Say so once
  // rather than every session forever, and let the next check start again from scratch.
  if (now - note.startedAt > SELF_UPDATE_LIMIT_S * 2 * 1000) {
    keep()
    return `a background update to vegafactory ${note.startedTo ?? 'a newer version'} did not finish; still on ${packageVersion} — run: vegafactory update`
  }
  return null
}

async function attendedUpdate(cwd: string, deps: HookDeps): Promise<string | null> {
  try {
    const root = repoRoot(cwd)
    let devMd: string | null = null
    try {
      devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8')
    } catch (error) {
      // No profile at all is a project that predates the knob, and it gets the shipped default.
      // A profile that exists and cannot be read is different: it may be the one saying `off`,
      // and reading it as "auto" would start a networked global install the operator refused.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    const mode = effectiveUpdateMode({ home: deps.home, devMd })
    if (mode === 'off') return null
    const settled = finishedUpdate(deps.now(), { home: deps.home })
    if (settled) return settled
    // One attempt at a time. Two sessions opened a minute apart would otherwise each start their
    // own global install of the same package, over each other, and each reset the clock the
    // failure report is measured from — so the second is told what the first is doing instead.
    const claim = readUpdateNote({ home: deps.home })
    if (claim.startedFrom && typeof claim.startedAt === 'number') {
      return `vegafactory ${claim.startedTo ?? 'a newer version'} is already installing in the background; this session continues with ${packageVersion}`
    }
    const result = await maintainSelfUpdate({ mode: 'notify', latest: deps.latest, home: { home: deps.home }, now: deps.now() })
    if (result.action !== 'available' || mode !== 'auto') return result.message
    // npm gets its own bound and executable. Calling this entry file again races the global
    // install replacing that file, and ordinary hook work has a deliberately shorter watchdog.
    deps.detach(['npm', ...installArgs()], cwd, SELF_UPDATE_LIMIT_S)
    // Stamped as an attempt, like any other install. Without it the hour only covers what the
    // worker installs, and a background install that failed could be started again on the very
    // next session — each one holding its own five-minute bound.
    writeUpdateNote({ ...readUpdateNote({ home: deps.home }), attemptedAt: deps.now(), startedFrom: result.before, startedTo: result.latest ?? undefined, startedAt: deps.now() }, { home: deps.home })
    return `updating vegafactory ${result.before} → ${result.latest} in the background; this session continues with ${result.before}`
  } catch {
    return `could not check npm; continuing with vegafactory ${packageVersion}`
  }
}

async function advisory(event: HookEvent, harness: Harness, payload: Record<string, unknown>, deps: HookDeps, update: string | null): Promise<void> {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  try { collectStats(event, cwd, deps) } catch { /* stats never affect a session */ }
  const where = locate(cwd, deps.host)
  if (!where) {
    if (update) deps.out(context('SessionStart', update))
    return
  }
  const local = readLocal(where)
  const model = typeof payload.model === 'string' && payload.model ? payload.model : '<model>'
  const session = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null

  if (event === 'session-start') {
    // Before the refresh, which talks to GitHub and can throw.
    observe(where, session, deps.now())
    const { holder, state } = refresh(where, local, deps, true)
    writeLocal(where, local)
    const lines = [
      ...(update ? [update] : []),
      `This worktree works issue #${where.number} (${where.repo}), state ${state ?? 'unknown'}, held by ${holder ? `${label(holder)}${local.held ? ' — this worktree' : ''}` : 'nobody'}.`,
      `Its local copy is ${cacheDir(where.root, where.repo, where.number)}; read it with \`vegafactory issue sync ${where.number}\` first.`,
    ]
    if (holder && !local.held) lines.push(`Someone else holds it. Do not change files; to take it back: \`${takeBack(where, harness, model)}\`.`)
    else if (!holder) lines.push(`Nobody holds it; claim it before working: \`vegafactory issue claim ${where.number} --harness ${harness} --model ${model}\`.`)
    const pending = pendingNote(where.root)
    if (pending) lines.push(pending)
    return deps.out(context('SessionStart', lines.join('\n')))
  }
  if (event === 'prompt') {
    observe(where, session, deps.now())
    const { holder } = refresh(where, local, deps)
    writeLocal(where, local)
    const notes: string[] = []
    if (holder && !local.held) notes.push(`Issue #${where.number} is held by ${label(holder)}, not this worktree (${where.owner}). Do not change files; to take it back: \`${takeBack(where, harness, model)}\`.`)
    const rejected = pushFailure(where)
    if (rejected) notes.push(rejected)
    if (notes.length) deps.out(context('UserPromptSubmit', notes.join('\n')))
    return
  }
  if (event === 'post-tool') {
    recordActivity(local, deps.now())
    observe(where, session, deps.now(), 'tool-end')
    if (local.held && (local.lastPush === null || deps.now() - local.lastPush >= HEARTBEAT_EVERY_MS)) pushHeartbeat(where, local, deps)
    return writeLocal(where, local)
  }
  if (event === 'session-end') {
    recordActivity(local, deps.now())
    observe(where, session, deps.now())
    if (local.held) pushHeartbeat(where, local, deps)
    return writeLocal(where, local)
  }
  if (event === 'stop') {
    recordActivity(local, deps.now())
    observe(where, session, deps.now())
    writeLocal(where, local)
    if (local.lostTo || !where.branch || issueFromBranch(where.branch) !== where.number) return
    const notes: string[] = []
    const rejected = pushFailure(where)
    if (rejected) notes.push(rejected)
    const saved = commitWork(where.top, `wip: #${where.number} turn checkpoint`)
    // This session's own turn produced that commit, so the work is this session's.
    if (saved.committed) observe(where, session, deps.now(), 'commit')
    if (saved.secrets.length) notes.push(`The WIP checkpoint was skipped: ${saved.reason}. Move them out of the worktree or ignore them.`)
    if (saved.committed) {
      // The push runs in the background; a rejection is written down and reported on the next prompt or stop.
      const failed = pushFailurePath(where)
      rmSync(failed, { force: true })
      deps.detach(['sh', '-c', 'git push --quiet -u origin "HEAD:refs/heads/$1" 2>"$2.tmp" || { mv "$2.tmp" "$2"; exit 1; }; rm -f "$2.tmp"', 'push', where.branch, failed], where.top)
    }
    // The lessons request, once per session that committed something: a chat-only session has none.
    // A queue that fails its own checks asks for nothing rather than pointing a session at it.
    let ask: string | null = null
    try {
      // The queue's own checks run before the session is marked asked, so a refusal here leaves
      // the request to the next turn rather than spending it. The text comes after, because
      // writing it sets up a draft folder and only a session that is really being asked needs one.
      learningsPath(where.root)
      if (claimAsk(where, session, deps.now())) ask = askText(where.root, where.number)
    } catch { /* no request is better than a bad one */ }
    // Both harnesses show a Stop hook's systemMessage to the user as a warning, and one Stop hook
    // prints one JSON object, so the warning and the request travel together.
    const output = { ...(notes.length ? { systemMessage: notes.join('\n') } : {}), ...(ask ? continuation(harness, ask) : {}) }
    if (Object.keys(output).length) deps.out(JSON.stringify(output))
  }
}

export function parseHookArgs(argv: string[]): { event: HookEvent; harness: Harness | null } {
  const [event, ...rest] = argv
  if (!HOOK_EVENTS.includes(event as HookEvent)) throw new Error(`unknown hook event: ${event ?? '(none)'} — run vegafactory hook --help`)
  const at = rest.indexOf('--harness')
  const harness = at === -1 ? null : rest[at + 1]
  return { event: event as HookEvent, harness: harness === 'claude' || harness === 'codex' ? harness : null }
}

export async function runHook(argv: string[], deps: HookDeps = defaultDeps(), stdin: NodeJS.ReadableStream = process.stdin): Promise<number> {
  const { event, harness } = parseHookArgs(argv)
  const input = await readHookInput(stdin)
  if (event === 'pre-tool') {
    if (!harness) {
      // Both harnesses understand the legacy block; a mis-wired guard must not pass silently.
      deps.out(JSON.stringify({ decision: 'block', reason: 'the ship guard is wired without --harness claude|codex — fix the hook command' }))
      return 0
    }
    preTool(harness, input, deps)
    return 0
  }
  if (!harness || !input.payload) return 0
  // The update runs first and its line is held right here, because the rest of the advisory talks
  // to GitHub and can throw. Re-deriving the line after a failure was not enough: the update may
  // already have cleared the note it would have been read from, and the session would be told
  // nothing about an install that had started.
  const update = event === 'session-start'
    ? await attendedUpdate(typeof input.payload.cwd === 'string' ? input.payload.cwd : process.cwd(), deps).catch(() => null)
    : null
  try {
    await advisory(event, harness, input.payload, deps, update)
  } catch {
    if (update) deps.out(context('SessionStart', update))
  }
  return 0
}

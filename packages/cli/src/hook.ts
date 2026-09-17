// `vegafactory hook <event> --harness claude|codex` — one command behind every harness hook.
//
// The issue comes from the worktree folder (.vegastack/.worktrees/<n>-…) or the branch
// (<type>/<n>-…). With no issue only the ship guard runs. Advisory events never block and
// exit 0 on any error; only pre-tool can deny, and its guard fails closed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { claimsOf, holderOf, ownerId, trustedAuthors, HEARTBEAT_EVERY_MS, type Holder } from './claim.ts'
import { defaultRunner, type GhRunner } from './gh.ts'
import { classifyCommand, extractCommand, isShellTool, loadPolicy, mergeTarget, type Decision, type MergeCheck } from './guard-rules.ts'
import { cacheDir, readBody, readState, syncIssue } from './issue-cache.ts'
import { detectRepo, findValidAck, latestOfType, permissionLookup, repoRoot, snapshot } from './issue.ts'
import { stateOf } from './labels.ts'

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
  session-start   SessionStart         the issue, its holder and where its local copy lives
  prompt          UserPromptSubmit     a warning when someone else holds the issue
  pre-tool        PreToolUse           the ship guard; stops file and shell tools after the claim is lost
  post-tool       PostToolUse, SubagentStop   the heartbeat
  stop            Stop                 commits and pushes a WIP checkpoint of the turn
  session-end     SessionEnd           a last heartbeat (the claim is kept, the session may resume)
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
  const match = /[/\\]\.vegastack[/\\]\.worktrees[/\\](\d+)-[^/\\]*$/.exec(top)
  return match ? Number(match[1]) : null
}

export function issueFromBranch(branch: string): number | null {
  const match = /^[\w.-]+\/(\d+)-/.exec(branch)
  return match ? Number(match[1]) : null
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
  const path = localPath(where)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(local, null, 2) + '\n')
  renameSync(temp, path)
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
  const trusted = trustedAuthors({ repo: where.repo, runner: deps.runner, root: where.root })
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
  detach: (command: string[], cwd: string) => number | undefined | void
  // How to run this CLI again: the runtime and the entry file.
  cli: string[]
  host: string
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
  runner: defaultRunner, now: Date.now, out: (text) => process.stdout.write(text + '\n'), detach: (command, cwd) => detachBounded(command, cwd),
  cli: [process.execPath, process.argv[1]!], host: hostname(),
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
  const pid = deps.detach([...deps.cli, 'issue', 'heartbeat', String(where.number), '--repo', where.repo, '--owner', where.owner, '--active', String(Math.round(local.activeMs / 60_000))], where.cwd)
  if (typeof pid === 'number') {
    mkdirSync(dirname(pidFile), { recursive: true })
    writeFileSync(pidFile, JSON.stringify({ pid, at: deps.now() }))
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
    return !!evidence && findValidAck(snap, 'ship', permissionLookup(repo, deps.runner), evidence.createdAt).ok
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

function advisory(event: HookEvent, harness: Harness, payload: Record<string, unknown>, deps: HookDeps): void {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  const where = locate(cwd, deps.host)
  if (!where) return
  const local = readLocal(where)
  const model = typeof payload.model === 'string' && payload.model ? payload.model : '<model>'

  if (event === 'session-start') {
    const { holder, state } = refresh(where, local, deps, true)
    writeLocal(where, local)
    const lines = [
      `This worktree works issue #${where.number} (${where.repo}), state ${state ?? 'unknown'}, held by ${holder ? `${label(holder)}${local.held ? ' — this worktree' : ''}` : 'nobody'}.`,
      `Its local copy is ${cacheDir(where.root, where.repo, where.number)}; read it with \`vegafactory issue sync ${where.number}\` first.`,
    ]
    if (holder && !local.held) lines.push(`Someone else holds it. Do not change files; to take it back: \`${takeBack(where, harness, model)}\`.`)
    else if (!holder) lines.push(`Nobody holds it; claim it before working: \`vegafactory issue claim ${where.number} --harness ${harness} --model ${model}\`.`)
    return deps.out(context('SessionStart', lines.join('\n')))
  }
  if (event === 'prompt') {
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
    if (local.held && (local.lastPush === null || deps.now() - local.lastPush >= HEARTBEAT_EVERY_MS)) pushHeartbeat(where, local, deps)
    return writeLocal(where, local)
  }
  if (event === 'session-end') {
    recordActivity(local, deps.now())
    if (local.held) pushHeartbeat(where, local, deps)
    return writeLocal(where, local)
  }
  if (event === 'stop') {
    recordActivity(local, deps.now())
    writeLocal(where, local)
    if (local.lostTo || !where.branch || issueFromBranch(where.branch) !== where.number) return
    const notes: string[] = []
    const rejected = pushFailure(where)
    if (rejected) notes.push(rejected)
    const saved = commitWork(where.top, `wip: #${where.number} turn checkpoint`)
    if (saved.secrets.length) notes.push(`The WIP checkpoint was skipped: ${saved.reason}. Move them out of the worktree or ignore them.`)
    if (saved.committed) {
      // The push runs in the background; a rejection is written down and reported on the next prompt or stop.
      const failed = pushFailurePath(where)
      rmSync(failed, { force: true })
      deps.detach(['sh', '-c', 'git push --quiet -u origin "HEAD:refs/heads/$1" 2>"$2.tmp" || { mv "$2.tmp" "$2"; exit 1; }; rm -f "$2.tmp"', 'push', where.branch, failed], where.top)
    }
    // Both harnesses show a Stop hook's systemMessage to the user as a warning.
    if (notes.length) deps.out(JSON.stringify({ systemMessage: notes.join('\n') }))
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
  try { advisory(event, harness, input.payload, deps) } catch { /* advisory only */ }
  return 0
}

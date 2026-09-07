// The dispatcher: what a tick would do, and then doing it. Everything that decides is a pure
// function over data — a board, a set of reactions, a policy, the state file — so the whole
// decision surface is unit-testable without a network, a clock, or a running loop. The effectful
// half (searching, spawning, logging, handing back) is at the bottom and does no thinking.
//
// Refusals are first-class output, never silence: a repo that is skipped says why, in the JSON and
// in the log, because "nothing happened" and "the ship guard is unwired" look identical otherwise.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { parseControlRoomKnob, loadConfiguredPolicy } from './control-room.ts'
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { loadFactoryConfig, repoPolicyFromEffective, stagePolicy, type FactoryConfig, type Harness, type RepoEntry, type RepoPolicy, type Stage, type Subagents } from './config.ts'
import { buildLaunchPlan, type LaunchPlan } from './launch.ts'
import { validateRegistration } from './hook-registration.ts'
import { GhUnavailable, ghText } from './gh.ts'
import { GIT_CREDENTIAL_ARGS } from './sync.ts'
import { fromClaudeHeadless, fromCodexExec, reworkFromComments, type ReworkCounts } from './stats/capture.ts'
import { appendRecord, takeSkillInvocations } from './stats/outbox.ts'
import { pushOutbox, statsClonePath, type GitRunner, type PushResult } from './stats/push.ts'
import { normalizeRecord, statsPolicyFromEffective, type StatsPolicy, type StatsRecord } from './stats/record.ts'

export interface BoardIssue {
  number: number
  title: string
  labels: string[]
  assignees: string[]
  updatedAt: string
}

export interface PlannedRun {
  repo: string
  issue: number
  title: string
  stage: Stage
  commentId: number | null
  reactionId: number | null
  // Set only on a parent-parallel run: the children this one run covers, in plan order. The
  // ordinary path leaves it undefined, and every existing caller keeps its behaviour.
  parallel?: number[]
}

// A ready child as the parallel decision sees it: which parent it hangs off, and whether anybody
// has claimed it. Deliberately narrower than BoardIssue — this decision needs nothing else.
export interface ReadyChild {
  number: number
  parent: number | null
  assignee: string | null
  labels: string[]
}

// One validated `plan-lint --groups` entry. The grammar is parsed in exactly one place (dev-plan's
// plan-lint); this type is the shape that arrives here, never a second parser.
export interface IndependentGroup {
  id: string
  members: string[]
  files: string[]
}

export interface ParentContext {
  issue: number
  branch: string
  head: string
  worktree: string
}

export interface ParentParallelRun {
  kind: 'parent-parallel'
  parent: number
  children: number[]
}

// One parent's parallel candidacy, as the tick receives it.
export interface ParentCandidate {
  parent: ParentContext
  groups: IndependentGroup[]
  children: ReadyChild[]
}

export interface Refusal {
  repo: string
  issue: number | null
  reason: string
}

export interface TickPlan {
  runs: PlannedRun[]
  refusals: Refusal[]
}

// The state labels are exactly the ones conventions.md defines; an issue wearing two of them is a
// board in a state no skill produced, and guessing which one wins is how a plan run lands on an
// issue somebody is already implementing.
const STATE_LABELS = ['needs-operator', 'needs-plan', 'ready', 'working', 'for-operator']

// `no:assignee` is in the query and checked again here: search indexes lag, and a stale index is
// exactly how two runs start on one issue.
//
// The corrections query carries no `updated:>=` window on purpose. A reaction does not move an
// issue's `updated_at`, so a 🚀 on an existing hand-back comment would never re-enter a window; and
// a comment posted while a run was in flight lands before the next window opens. Every
// for-operator issue is read on every tick, and the handled list is what stops the repeats.
export function searchQueries(repo: string): { needsPlan: string; ready: string; corrections: string } {
  const scope = `repo:${repo} is:issue is:open`
  return {
    needsPlan: `${scope} label:needs-plan`,
    ready: `${scope} label:ready no:assignee`,
    corrections: `${scope} label:for-operator`,
  }
}

function stateLabelRefusal(repo: string, issue: BoardIssue): Refusal | null {
  const states = issue.labels.filter(label => STATE_LABELS.includes(label))
  if (states.length > 1) {
    return { repo, issue: issue.number, reason: `#${issue.number} carries two state labels (${states.join(', ')}) — the board says nothing a run could act on` }
  }
  if (issue.labels.includes('epic')) {
    return { repo, issue: issue.number, reason: `#${issue.number} is an epic — epics are maps, and only their children ever run` }
  }
  return null
}

export function planLabelRuns(input: { repo: string; needsPlan: BoardIssue[]; ready: BoardIssue[] }): TickPlan {
  const runs: PlannedRun[] = []
  const refusals: Refusal[] = []
  const consider = (issue: BoardIssue, stage: Stage): void => {
    const refusal = stateLabelRefusal(input.repo, issue)
    if (refusal) {
      refusals.push(refusal)
      return
    }
    if (issue.assignees.length > 0) {
      refusals.push({
        repo: input.repo,
        issue: issue.number,
        reason: `#${issue.number} is assigned to ${issue.assignees.join(', ')} — somebody may be mid-claim`,
      })
      return
    }
    runs.push({ repo: input.repo, issue: issue.number, title: issue.title, stage, commentId: null, reactionId: null })
  }
  for (const issue of input.needsPlan) consider(issue, 'plan')
  for (const issue of input.ready) consider(issue, 'implement')
  return { runs, refusals }
}

export interface Rocket {
  issue: number
  commentId: number
  reactionId: number
  login: string
}

export interface HandledRun {
  repo: string
  issue: number
  commentId: number | null
  reactionId: number | null
}

export interface DispatchState {
  lastTick: Record<string, string>
  handled: HandledRun[]
}

function handledKey(run: HandledRun): string {
  return `${run.repo}#${run.issue}#${run.commentId ?? '-'}#${run.reactionId ?? '-'}`
}

// A rocket is a start signal from a named human, and nothing else is. Three things have to hold
// before a corrections run exists: the issue is still `for-operator` (the board moved while the
// tick was reading), the reacting login is in the repo's `operators:` list, and this exact reaction
// id has never been handled. The last one is why the state file exists at all — reactions have no
// "seen" bit, so a restart would otherwise re-run every correction ever asked for.
export function planRocketRuns(input: {
  repo: string
  corrections: BoardIssue[]
  rockets: Rocket[]
  operators: string[]
  state: DispatchState
}): TickPlan {
  const runs: PlannedRun[] = []
  const refusals: Refusal[] = []
  const handled = new Set(input.state.handled.map(handledKey))
  const byIssue = new Map(input.corrections.map(issue => [issue.number, issue]))
  const newestByIssue = new Map<number, Rocket>()

  for (const rocket of input.rockets) {
    if (handled.has(handledKey({ repo: input.repo, issue: rocket.issue, commentId: rocket.commentId, reactionId: rocket.reactionId }))) continue
    const issue = byIssue.get(rocket.issue)
    if (!issue) {
      refusals.push({ repo: input.repo, issue: rocket.issue, reason: `#${rocket.issue} is no longer for-operator — the reaction is left for the next tick to re-read` })
      continue
    }
    if (input.operators.length === 0) {
      refusals.push({ repo: input.repo, issue: rocket.issue, reason: `#${rocket.issue} has a rocket but the profile lists no operators: — nobody is trusted to start a run` })
      continue
    }
    if (!input.operators.includes(rocket.login)) {
      refusals.push({ repo: input.repo, issue: rocket.issue, reason: `the rocket on #${rocket.issue} is from ${rocket.login}, who is not in operators: — only a listed operator starts a run` })
      continue
    }
    const current = newestByIssue.get(rocket.issue)
    // One run per issue: the newest reacted comment wins, because that is the correction the
    // operator wrote last and it is the one the run is told to read from.
    if (!current || rocket.commentId > current.commentId) newestByIssue.set(rocket.issue, rocket)
  }

  for (const rocket of newestByIssue.values()) {
    const issue = byIssue.get(rocket.issue)!
    runs.push({ repo: input.repo, issue: issue.number, title: issue.title, stage: 'corrections', commentId: rocket.commentId, reactionId: rocket.reactionId })
  }
  return { runs, refusals }
}

export function recordHandled(state: DispatchState, run: PlannedRun): DispatchState {
  const entry: HandledRun = { repo: run.repo, issue: run.issue, commentId: run.commentId, reactionId: run.reactionId }
  if (state.handled.some(existing => handledKey(existing) === handledKey(entry))) return state
  return { lastTick: { ...state.lastTick }, handled: [...state.handled, entry] }
}

export function withLastTick(state: DispatchState, repo: string, at: string): DispatchState {
  return { lastTick: { ...state.lastTick, [repo]: at }, handled: state.handled }
}

// A state file that cannot be read is an empty state on purpose: the worst it costs is one repeated
// corrections run, while throwing would stop a service whose whole job is to keep ticking. The
// write is the opposite — temp file plus rename, and a symlinked target is refused, because that
// path is attacker-controlled the moment somebody else can write the home directory.
export async function readState(path: string): Promise<DispatchState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { lastTick: {}, handled: [] }
  }
  const document = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
  const lastTick: Record<string, string> = {}
  if (document.lastTick && typeof document.lastTick === 'object') {
    for (const [repo, at] of Object.entries(document.lastTick as Record<string, unknown>)) {
      if (typeof at === 'string') lastTick[repo] = at
    }
  }
  const handled: HandledRun[] = []
  if (Array.isArray(document.handled)) {
    for (const entry of document.handled) {
      const row = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      if (typeof row.repo === 'string' && typeof row.issue === 'number') {
        handled.push({
          repo: row.repo,
          issue: row.issue,
          commentId: typeof row.commentId === 'number' ? row.commentId : null,
          reactionId: typeof row.reactionId === 'number' ? row.reactionId : null,
        })
      }
    }
  }
  return { lastTick, handled }
}

export async function writeState(path: string, state: DispatchState): Promise<void> {
  await refuseSymlink(path)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({ lastTick: state.lastTick, handled: state.handled }, null, 2)}\n`)
  await rename(temp, path)
}

export async function refuseSymlink(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`refusing to write ${path}: it is a symlink`)
  } catch (error) {
    if ((error as Error).message.startsWith('refusing to write')) throw error
  }
}

export interface GuardState {
  shipGuard: { wired: boolean; detail: string }
  lock: { held: boolean; pid: number | null }
  activeRuns: number
}

// The four things that must all be true before a repo may start anything. Each returns its own
// refusal so the operator reads a reason and not a silence; a non-empty result means nothing
// launches for that repo this tick.
export function evaluateGuards(input: { repo: string; policy: RepoPolicy; guards: GuardState; maxRuns: number }): Refusal[] {
  const refusals: Refusal[] = []
  const at = (reason: string): Refusal => ({ repo: input.repo, issue: null, reason })
  if (input.policy.refusal) refusals.push(at(input.policy.refusal))
  if (input.policy.dispatch !== 'local') {
    refusals.push(at(`${input.repo} has dispatch: off — a repo runs dark builds only once its operator opts in`))
  }
  if (!input.guards.shipGuard.wired) {
    refusals.push(at(`${input.repo} has no wired ship guard: ${input.guards.shipGuard.detail} — dark builds run under bypass, and the guard is what bounds them`))
  }
  if (input.guards.lock.held) {
    refusals.push(at(`${input.repo} is locked by pid ${input.guards.lock.pid ?? 'unknown'} — another run holds it`))
  }
  if (input.guards.activeRuns >= input.maxRuns) {
    refusals.push(at(`${input.repo} is at maxRuns ${input.maxRuns} with ${input.guards.activeRuns} in flight`))
  }
  return refusals
}

// Wired means three files agree: the guard script exists, this harness's hook config actually
// calls it, and — when the caller names the repo and home — the compiled policy the guard reads
// exists for that repo. Any one missing or unreadable is unwired; the whole point of the check is
// that a repo whose guard state cannot be established never starts an unattended run. The policy
// lives in the home directory, not the checkout, so a run cannot edit it into permission.
export async function shipGuardWired(repoPath: string, harness: Harness, policy?: { home: string; repo: string }): Promise<{ wired: boolean; detail: string }> {
  const guardPath = join(repoPath, '.vegastack', 'hooks', 'ship-guard.mjs')
  try {
    await readFile(guardPath, 'utf8')
  } catch {
    return { wired: false, detail: `no ${join('.vegastack', 'hooks', 'ship-guard.mjs')} in ${repoPath}` }
  }
  const wiringPath = harness === 'claude'
    ? join(repoPath, '.claude', 'settings.json')
    : join(repoPath, '.codex', 'hooks.json')
  const relative = harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'
  let text: string
  try {
    text = await readFile(wiringPath, 'utf8')
  } catch {
    return { wired: false, detail: `${relative} is missing — the guard script is there but nothing calls it` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { wired: false, detail: `${relative} is not valid JSON — the wiring cannot be read, so it counts as unwired` }
  }
  const registration = validateRegistration({ config: parsed, harness, checkout: repoPath, guardPath })
  if (!registration.ok) return { wired: false, detail: `${relative}: ${registration.problems.join('; ')}` }
  if (policy) {
    const policyFile = join(policy.home, '.vegastack', 'guard', `${policy.repo.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')}.json`)
    const shown = `~/.vegastack/guard/${policyFile.split('/').pop()}`
    let stored: unknown
    try {
      stored = JSON.parse(await readFile(policyFile, 'utf8'))
    } catch {
      return { wired: false, detail: `no compiled guard policy at ${shown} — run \`vegafactory guard sync\` in ${repoPath}` }
    }
    const record = stored && typeof stored === 'object' ? stored as { schemaVersion?: unknown; repo?: unknown } : {}
    if (record.schemaVersion !== 1 || record.repo !== policy.repo) {
      return { wired: false, detail: `the compiled guard policy at ${shown} is not for ${policy.repo} (schemaVersion 1) — run \`vegafactory guard sync\` in ${repoPath}` }
    }
  }
  return { wired: true, detail: `.vegastack/hooks/ship-guard.mjs wired for ${harness} in ${relative}${policy ? ', policy compiled' : ''}` }
}

// Guards first, then the board, then the reactions, then the budget. Truncation is loud: every run
// the budget drops is named, because a silently dropped correction looks to the operator exactly
// like a dispatcher that ignored them.
// Two or more ready, unassigned children of the same parent, each in a group of its own, become one
// parent run instead of one run per child. Anything less keeps the ordinary one-issue-at-a-time
// path: a child nobody declared a file set for has no contract to be checked against afterwards,
// and a claimed child may already be mid-run somewhere.
export function parentParallelLaunch(
  ready: ReadyChild[],
  groups: IndependentGroup[],
  parent: ParentContext,
): ParentParallelRun | null {
  const eligible = ready.filter(child => child.parent === parent.issue && !child.assignee && child.labels.includes('ready'))
  if (eligible.length < 2) return null
  const claimed = new Map<number, string>()
  for (const child of eligible) {
    const owner = groups.find(group => group.members.includes(`#${child.number}`))
    if (!owner) return null
    if (claimed.has(child.number)) return null
    claimed.set(child.number, owner.id)
  }
  if (new Set(claimed.values()).size !== claimed.size) return null
  return { kind: 'parent-parallel', parent: parent.issue, children: eligible.map(child => child.number) }
}

// The parent's whole first turn, per harness. On Claude the `ultracode` keyword is ignored in a
// `-p` prompt, so the saved workflow is asked for in plain words; `--allowed-tools Workflow` sits
// beside bypass because whether bypass alone reaches the tool is the one fact this design has not
// observed on the box. On Codex there is no saved workflow and no Workflow tool: the parent drives
// children.mjs, whose Codex path is one `codex exec -C <child worktree>` per child.
export function parentParallelPrompt(run: ParentParallelRun, parent: ParentContext, harness: Harness = 'claude'): string {
  const children = run.children.map(n => `#${n}`).join(', ')
  const opening = harness === 'codex'
    ? [
        `Run the independent children of #${run.parent} at the same time: ${children}.`,
        `You are in ${parent.worktree} on ${parent.branch}. Drive it with children.mjs — plan, then launch --harness codex --write, then join — and never merge a child by hand. Each child is one codex exec in its own worktree, started by the launch; wait for every one to finish before the join.`,
      ]
    : [
        `Run the saved workflow implement-children for the independent children of #${run.parent}: ${children}.`,
        `You are in ${parent.worktree} on ${parent.branch}. Build the workflow's arguments with children.mjs — plan, then launch, then join — and never merge a child by hand.`,
      ]
  return [
    ...opening,
    'Each child runs in its own worktree branched from this branch\'s HEAD sha and may touch only the files its group declared. After the join, run the project\'s check command once and hand back.',
  ].join('\n\n')
}

export function parentParallelLaunchPlan(
  run: ParentParallelRun,
  parent: ParentContext,
  options: { harness: Harness; model: string; effort: string; operator: string; subagents: Subagents; stopList?: string[] },
): LaunchPlan {
  const prompt = parentParallelPrompt(run, parent, options.harness)
  // The launch table stays the one home of the argv: this reuses it and appends only the Claude
  // allowance, so the two can never drift. The harness is the repo's implement harness — the same
  // one the ship guard was verified for.
  const base = buildLaunchPlan({
    harness: options.harness,
    model: options.model,
    effort: options.effort,
    stage: 'implement',
    worktree: parent.worktree,
    issue: { number: run.parent, title: `parallel children of #${run.parent}` },
    operator: options.operator,
    outcome: `the independent children of #${run.parent}, built at the same time and joined in plan order`,
    stopList: options.stopList ?? [],
    resume: false,
    skillPath: null,
    subagents: options.subagents,
  })
  const args = base.args.map(arg => (arg === base.prompt ? prompt : arg))
  if (options.harness === 'claude') args.push('--allowed-tools', 'Workflow')
  return { ...base, args, prompt }
}

export function planTick(input: {
  repo: string
  policy: RepoPolicy
  board: { needsPlan: BoardIssue[]; ready: BoardIssue[]; corrections: BoardIssue[] }
  rockets: Rocket[]
  state: DispatchState
  guards: GuardState
  maxRuns: number
  parents?: ParentCandidate[]
  // Issues this process already has a run on. A run that has started has not necessarily moved
  // its label yet, so the board alone would plan it a second time.
  inFlight?: number[]
}): TickPlan {
  const guardRefusals = evaluateGuards({ repo: input.repo, policy: input.policy, guards: input.guards, maxRuns: input.maxRuns })
  if (guardRefusals.length > 0) return { runs: [], refusals: guardRefusals }

  const labels = planLabelRuns({ repo: input.repo, needsPlan: input.board.needsPlan, ready: input.board.ready })
  const rockets = planRocketRuns({
    repo: input.repo,
    corrections: input.board.corrections,
    rockets: input.rockets,
    operators: input.policy.operators,
    state: input.state,
  })
  // A parent whose children can run at the same time replaces those children in the candidate
  // list: one run, one join, one verify — instead of one run per child and no join at all.
  const parallelRuns: PlannedRun[] = []
  const covered = new Set<number>()
  for (const candidate of input.parents ?? []) {
    const parallel = parentParallelLaunch(candidate.children, candidate.groups, candidate.parent)
    if (!parallel) continue
    if (parallel.children.some(child => covered.has(child))) continue
    for (const child of parallel.children) covered.add(child)
    parallelRuns.push({
      repo: input.repo,
      issue: parallel.parent,
      title: `parallel children of #${parallel.parent}`,
      stage: 'implement',
      commentId: null,
      reactionId: null,
      parallel: parallel.children,
    })
  }
  const inFlight = new Set(input.inFlight ?? [])
  const busy = (run: PlannedRun): boolean => inFlight.has(run.issue) || (run.parallel ?? []).some(child => inFlight.has(child))
  const all = [...parallelRuns, ...labels.runs.filter(run => !covered.has(run.issue)), ...rockets.runs]
  const candidates = all.filter(run => !busy(run))
  const running = all.filter(busy).map(run => ({
    repo: input.repo,
    issue: run.issue,
    reason: `#${run.issue} already has a run in flight — the label has not moved yet, and a second run on it is how two sessions collide`,
  }))
  const budget = Math.max(0, input.maxRuns - input.guards.activeRuns)
  const runs = candidates.slice(0, budget)
  const dropped = candidates.slice(budget).map(run => ({
    repo: input.repo,
    issue: run.issue,
    reason: `#${run.issue} (${run.stage}) waits for the next tick — maxRuns ${input.maxRuns} is already committed`,
  }))
  return { runs, refusals: [...labels.refusals, ...rockets.refusals, ...running, ...dropped] }
}

// One log file per run, named so `ls` sorts by issue then time and two runs of the same issue never
// collide.
export function logPath(config: FactoryConfig, repo: string, issue: number, at: Date): string {
  const [org, name] = repo.split('/')
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return join(config.logRoot, org ?? repo, name ?? repo, `${issue}-${stamp}.jsonl`)
}

// Pattern-based, and deliberately broad: this text goes into a public issue comment, so a shape
// that merely looks like a credential is redacted rather than reasoned about.
const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgho_[A-Za-z0-9]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{16,}/g,
  // The header label and an optional scheme are kept; whatever one token follows them, on the same
  // line, is the credential. Quotes end the token, so a JSON-shaped or curl-quoted header loses only
  // its value, and the pattern never reaches across a line break to the next header.
  /(Authorization["']?:[ \t]*["']?(?:(?:Bearer|Basic|Token|Digest)[ \t]+)?)[^\s"']+/gi,
  /((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[=:]\s*)\S+/g,
]

export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args) => {
      const groups = args.slice(1, -2)
      return typeof groups[0] === 'string' ? `${groups[0]}[redacted]` : '[redacted]'
    })
  }
  return out
}

export function tailLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n')
}

export function failureComment(input: {
  issue: number
  stage: Stage
  exitCode: number | null
  timedOut: boolean
  log: string
  worktree: string
  at: string
}): string {
  const how = input.timedOut ? 'timed out' : `failed with exit ${input.exitCode ?? 'unknown'}`
  return [
    '<!-- vsk:v1 type=handback -->',
    '## Hand-back',
    '',
    `The headless ${input.stage} run ${how} at ${input.at}. Nothing was handed back as finished, and no label beyond this one was moved.`,
    '',
    `The worktree is left in place at \`${input.worktree}\` — whatever the run had done is still there, and the ledger comment is the last checkpoint it reached.`,
    '',
    'Last 40 log lines (secrets redacted by pattern):',
    '',
    '```',
    redact(tailLines(input.log, 40)),
    '```',
  ].join('\n')
}

export interface RunOutcome {
  exitCode: number | null
  timedOut: boolean
  logFile: string
  pushed: boolean
  handedBack: boolean
  // What the stats record is built from. Optional because the tick's `execute` seam is stubbed in
  // several tests; a run with no stdout still produces a record, just a context-only one.
  stdout?: string
  startedAt?: string
  finishedAt?: string
}

export interface ExecuteDeps {
  now: () => Date
  gh: (args: string[], options?: { cwd?: string; input?: string }) => Promise<string>
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; message: string }>
  timeoutMs: number
}

function defaultGit(args: string[], cwd: string): Promise<{ ok: boolean; message: string }> {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let message = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { message += chunk })
    child.stderr.on('data', (chunk: string) => { message += chunk })
    child.on('error', error => resolve({ ok: false, message: (error as Error).message }))
    child.on('close', code => resolve({ ok: code === 0, message: message.trim() }))
  })
}

// The effectful half, and the only place in this file that spawns a harness. Both pipes are
// streamed to the log as they arrive rather than buffered, so a dispatcher that dies still leaves a
// readable record of how far the run got, and a run that prints megabytes cannot exhaust memory.
//
// A run that fails is not retried and is never left looking finished: the branch is pushed anyway
// (an evidence sha only resolves once the commit is on the remote), a hand-back comment carrying
// the redacted tail is posted, the issue goes back to `needs-operator` assigned to its operator,
// and the worktree is left exactly as the run left it.
export async function executeRun(
  run: PlannedRun,
  plan: LaunchPlan,
  config: FactoryConfig,
  options: { operator: string | null },
  deps?: Partial<ExecuteDeps>,
): Promise<RunOutcome> {
  const now = deps?.now ?? (() => new Date())
  const gh = deps?.gh ?? ((args: string[], ghOptions?: { cwd?: string; input?: string }) => ghText(args, ghOptions))
  const git = deps?.git ?? defaultGit
  const timeoutMs = deps?.timeoutMs ?? 6 * 60 * 60 * 1000
  const startedAt = now()
  const file = logPath(config, run.repo, run.issue, startedAt)
  await mkdir(dirname(file), { recursive: true })
  await refuseSymlink(file)
  const lines: string[] = []
  const record = (row: Record<string, unknown>): void => { lines.push(JSON.stringify(row)) }
  // One append at a time, chained: two concurrent appends can land out of order, and a log whose
  // lines are shuffled is worse than one that lags.
  let writing: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => {
    writing = writing.then(async () => {
      if (lines.length === 0) return
      const pending = lines.splice(0, lines.length)
      await appendFile(file, `${pending.join('\n')}\n`)
    })
    return writing
  }
  record({ at: startedAt.toISOString(), event: 'start', repo: run.repo, issue: run.issue, stage: run.stage, command: plan.command, args: plan.args, cwd: plan.cwd })
  await flush()

  let tail = ''
  // The harness's own machine-readable result: `claude -p --output-format json` prints one object,
  // `codex exec --json` one event per line. Capped at 2 MB, keeping the END, because both formats
  // put what the record needs last.
  let stdout = ''
  const outcome = await new Promise<{ exitCode: number | null; timedOut: boolean }>(resolve => {
    const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].setEncoding('utf8')
      child[stream].on('data', (chunk: string) => {
        if (stream === 'stdout') {
          stdout = `${stdout}${chunk}`
          if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000)
        }
        tail = `${tail}${chunk}`.split('\n').slice(-200).join('\n')
        record({ at: new Date().toISOString(), stream, text: chunk })
        void flush()
      })
    }
    child.on('error', error => {
      clearTimeout(timer)
      record({ at: new Date().toISOString(), stream: 'stderr', text: `could not start ${plan.command}: ${(error as Error).message}` })
      resolve({ exitCode: null, timedOut })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code, timedOut })
    })
  })

  const push = await git(['push', '-u', 'origin', 'HEAD'], plan.cwd)
  if (!push.ok) record({ at: new Date().toISOString(), event: 'push-failed', message: redact(push.message) })

  let handedBack = false
  const failed = outcome.timedOut || outcome.exitCode !== 0
  if (failed) {
    const body = failureComment({
      issue: run.issue,
      stage: run.stage,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      log: tail,
      worktree: plan.cwd,
      at: new Date().toISOString(),
    })
    try {
      await gh(['issue', 'comment', String(run.issue), '--repo', run.repo, '--body-file', '-'], { input: body })
      const edit = ['issue', 'edit', String(run.issue), '--repo', run.repo, '--add-label', 'needs-operator', '--remove-label', 'working']
      if (options.operator) edit.push('--add-assignee', options.operator)
      await gh(edit)
      handedBack = true
    } catch (error) {
      // A hand-back that cannot be posted must not take the dispatcher down with it; the log is
      // then the only record, and `vegafactory status` surfaces the run as failed either way.
      record({ at: new Date().toISOString(), event: 'handback-failed', message: redact((error as Error).message) })
    }
  }
  record({ at: new Date().toISOString(), event: 'exit', exitCode: outcome.exitCode, timedOut: outcome.timedOut, pushed: push.ok, handedBack })
  await flush()
  return {
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    logFile: file,
    pushed: push.ok,
    handedBack,
    stdout,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  }
}

// --- statistics -------------------------------------------------------------------------
//
// One record per headless run, written to the machine-local outbox the moment the run ends. It is
// deliberately the last thing the run does and deliberately cannot fail into the tick: a run that
// finished is a run that finished, whether or not anyone was counting.

export interface RunOutcomeInput {
  harness: Harness
  stdout: string
  exitCode: number
  startedAt: string
  finishedAt: string
  repo: string
  issue: number | null
  parent: number | null
  stage: string
  model: string | null
  effort: string | null
  human: string
  worktree: string
}

function elapsedSeconds(startedAt: string, finishedAt: string): number | null {
  const from = Date.parse(startedAt)
  const to = Date.parse(finishedAt)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return Math.round((to - from) / 1000)
}

// The issue's rework, read after the run from its workflow comments. A read that fails leaves the
// three fields null — a run whose rework could not be looked up is still a run, and the rollup
// reports null rather than a zero nobody measured.
export async function issueRework(gh: TickDeps['gh'], repo: string, issue: number): Promise<ReworkCounts> {
  const comments = await ghJsonVia<{ body?: unknown }[]>(gh, ['api', `repos/${repo}/issues/${issue}/comments`, '--paginate'])
  return reworkFromComments((Array.isArray(comments) ? comments : []).map(comment => (typeof comment?.body === 'string' ? comment.body : '')))
}

export async function recordRun(
  input: RunOutcomeInput,
  deps: { home: string; hostname: string; policy: StatsPolicy; rework?: (repo: string, issue: number) => Promise<ReworkCounts | null> },
): Promise<string | null> {
  if (!deps.policy.enabled || deps.policy.refusal) return null
  let rework: ReworkCounts | null = null
  if (deps.rework && input.issue !== null) {
    try {
      rework = await deps.rework(input.repo, input.issue)
    } catch {
      rework = null
    }
  }
  const context = {
    review_rounds: rework?.review_rounds ?? null,
    fix_rounds: rework?.fix_rounds ?? null,
    handbacks: rework?.handbacks ?? null,
    repo: input.repo,
    ts: input.finishedAt,
    stage: input.stage,
    model: input.model,
    effort: input.effort,
    human: input.human,
    worktree: input.worktree,
    parent: input.parent,
    // The exit code is the authority on failure: a harness that printed a happy result object and
    // then died is a failed run, whatever its own JSON claims.
    outcome: input.exitCode !== 0 ? ('failed' as const) : undefined,
  }
  let record: StatsRecord
  try {
    record = input.harness === 'claude'
      ? fromClaudeHeadless(JSON.parse(input.stdout), context)
      : fromCodexExec(input.stdout.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)), context)
  } catch {
    // Unparseable stdout is still a run that happened: the context-only record keeps the duration,
    // the issue and the stage, and leaves every counter null rather than inventing one.
    record = normalizeRecord({
      ...context,
      outcome: input.exitCode !== 0 ? 'failed' : null,
      issue: input.issue,
      harness: input.harness,
      mode: 'headless',
    })
  }
  if (record.issue === null) record.issue = input.issue
  if (record.duration_s === null) record.duration_s = elapsedSeconds(input.startedAt, input.finishedAt)
  if (record.session_id) record.skills = await takeSkillInvocations(deps.home, record.session_id)
  try {
    return await appendRecord(deps.home, record, deps.hostname)
  } catch {
    // A refused or unwritable outbox must never take a finished run down with it.
    return null
  }
}

export async function flushStats(deps: {
  home: string
  cloneRoot: string
  ghUser: string
  hostname: string
  git: GitRunner
}): Promise<PushResult> {
  try {
    return await pushOutbox({ ...deps, commit: true })
  } catch {
    return { ok: false, pushed: 0, retries: 0, deferred: [], refusals: [], locked: false }
  }
}

// --- the tick ---------------------------------------------------------------

export interface WorktreeTarget { path: string; branch: string; slug: string; type: string }

const BRANCH_TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor']
const SLUG_MAX = 40

// The same naming the packaged worktree script uses, and deliberately a copy of nothing else: this
// predicts where the run will happen so `--dry-run` can print a real cwd without creating anything.
// The script remains the only thing that makes a worktree.
export function worktreeFor(repoPath: string, issue: number, title: string): WorktreeTarget {
  const [prefix, ...rest] = title.split(':')
  const hasType = rest.length > 0 && BRANCH_TYPES.includes(prefix!.trim())
  const type = hasType ? prefix!.trim() : 'feat'
  const subject = hasType ? rest.join(':') : title
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  const name = `${issue}-${slug}`
  return { path: join(repoPath, '.vegastack', '.worktrees', name), branch: `${type}/${name}`, slug, type }
}

interface SearchIssue {
  number: number
  title: string
  labels?: { name: string }[]
  assignees?: { login: string }[]
  updated_at?: string
}

function toBoardIssue(row: SearchIssue): BoardIssue {
  return {
    number: row.number,
    title: row.title,
    labels: (row.labels ?? []).map(label => label.name),
    assignees: (row.assignees ?? []).map(assignee => assignee.login),
    updatedAt: row.updated_at ?? '',
  }
}

// The runs this process has started and not yet seen finish, keyed `<repo>#<issue>`. A tick
// starts a run and moves on; the tracker is what the next tick reads to count a repo's active runs,
// to keep a second run off an issue whose first has not moved the label yet, and what `--once` and
// the watch loop wait on before they exit. It lives for the process, not the tick.
export interface InFlightRun { repo: string; issue: number; done: Promise<void> }
export type RunTracker = Map<string, InFlightRun>

const processTracker: RunTracker = new Map()

export function inFlightIssues(tracker: RunTracker, repo: string): number[] {
  return [...tracker.values()].filter(run => run.repo === repo).map(run => run.issue)
}

// Every run started so far has finished. Runs started while waiting are waited for too.
export async function settleRuns(tracker: RunTracker = processTracker): Promise<void> {
  while (tracker.size > 0) {
    await Promise.all([...tracker.values()].map(run => run.done))
  }
}

// Stats pushes share one control-room clone, so two runs finishing together must not both run git
// in it: pushes are chained, one after another, whatever order the runs end in.
let statsPushChain: Promise<unknown> = Promise.resolve()

export interface TickDeps {
  issueBody: (repo: string, issue: number) => Promise<string>
  gh: (args: string[], options?: { cwd?: string; input?: string }) => Promise<string>
  now: () => Date
  shipGuard: (repoPath: string, harness: Harness, policy?: { home: string; repo: string }) => Promise<{ wired: boolean; detail: string }>
  ensureWorktree: (repoPath: string, issue: number, title: string) => Promise<WorktreeTarget>
  execute: (run: PlannedRun, plan: LaunchPlan, config: FactoryConfig, options: { operator: string | null }) => Promise<RunOutcome>
  // Which parents could run their children at the same time. Reading a plan's independent groups
  // means running dev-plan's plan-lint, the one parser of that grammar, so it lives behind this
  // dependency rather than in a second copy here.
  parentCandidates: (repo: string, repoPath: string, ready: BoardIssue[], operators: string[]) => Promise<ParentCandidate[]>
  tracker: RunTracker
}

async function ghJsonVia<T>(gh: TickDeps['gh'], args: string[]): Promise<T> {
  const stdout = await gh(args)
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new GhUnavailable(`gh ${args.join(' ')} returned output that is not JSON`)
  }
}

export async function fetchBoard(gh: TickDeps['gh'], repo: string): Promise<{
  needsPlan: BoardIssue[]
  ready: BoardIssue[]
  corrections: BoardIssue[]
}> {
  const queries = searchQueries(repo)
  const search = async (q: string): Promise<BoardIssue[]> => {
    const result = await ghJsonVia<{ items?: SearchIssue[] }>(gh, ['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '--cache', '0'])
    return (result.items ?? []).map(toBoardIssue)
  }
  return {
    needsPlan: await search(queries.needsPlan),
    ready: await search(queries.ready),
    corrections: await search(queries.corrections),
  }
}

// Reactions cost one call per comment, so only comments that actually carry a rocket are followed
// up, and a comment whose rocket count is already covered by the handled list is not read again:
// the count in the comment row is what says whether a reaction this tick has not seen exists.
export async function fetchRockets(gh: TickDeps['gh'], repo: string, corrections: BoardIssue[], handled: HandledRun[] = []): Promise<Rocket[]> {
  const rockets: Rocket[] = []
  const handledByComment = new Map<string, number>()
  for (const entry of handled) {
    if (entry.repo !== repo || entry.commentId === null || entry.reactionId === null) continue
    const key = `${entry.issue}#${entry.commentId}`
    handledByComment.set(key, (handledByComment.get(key) ?? 0) + 1)
  }
  for (const issue of corrections) {
    const comments = await ghJsonVia<{ id: number; reactions?: { rocket?: number } }[]>(
      gh, ['api', `repos/${repo}/issues/${issue.number}/comments`, '--paginate'],
    )
    for (const comment of comments) {
      if (!comment.reactions?.rocket) continue
      if ((handledByComment.get(`${issue.number}#${comment.id}`) ?? 0) >= comment.reactions.rocket) continue
      const reactions = await ghJsonVia<{ id: number; content: string; user?: { login: string } }[]>(
        gh, ['api', `repos/${repo}/issues/comments/${comment.id}/reactions`, '--paginate'],
      )
      for (const reaction of reactions) {
        if (reaction.content !== 'rocket') continue
        rockets.push({ issue: issue.number, commentId: comment.id, reactionId: reaction.id, login: reaction.user?.login ?? '' })
      }
    }
  }
  return rockets
}

export interface LockState { held: boolean; pid: number | null }

export function repoLockPath(config: FactoryConfig, repo: string): string {
  return join(config.lockRoot, `${repo.replace('/', '-')}.lock`)
}

// A pid that no longer exists never keeps a lock: a dispatcher killed mid-run would otherwise wedge
// its repo until somebody deleted a file they have no reason to know about.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readLock(path: string): Promise<LockState> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { held: false, pid: null }
  }
  let pid: number | null = null
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown }
    if (typeof parsed.pid === 'number') pid = parsed.pid
  } catch {
    // A lock file nobody can parse is a lock nobody can clear; treat it as stale rather than
    // wedging the repo forever, and say so through the pid being unknown.
    return { held: false, pid: null }
  }
  if (pid === null || !pidAlive(pid)) return { held: false, pid }
  return { held: true, pid }
}

export async function holdLock(path: string, pid: number): Promise<void> {
  await refuseSymlink(path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`)
}

export async function releaseLock(path: string): Promise<void> {
  try {
    await rm(path)
  } catch {
    // Already gone is the outcome we wanted.
  }
}

// The worktree the run will happen in. Creating it is the packaged script's job — the CLI is a
// caller here, exactly as `vegafactory worktree` is, so one removal and creation rule exists.
export function defaultEnsureWorktree(repoPath: string, issue: number, title: string): Promise<WorktreeTarget> {
  const target = worktreeFor(repoPath, issue, title)
  const script = process.env.VSK_WORKTREE_SCRIPT
    || join(dirname(dirname(fileURLToPath(import.meta.url))), 'skill', 'dev-implement', 'scripts', 'worktree.mjs')
  const verb = existsSync(target.path) ? 'restore' : 'create'
  const result = spawnSync(process.execPath, [script, verb, '--json', '--issue', String(issue), '--slug', target.slug, '--type', target.type, '--write'], {
    cwd: repoPath,
    encoding: 'utf8',
  })
  if ((result.status ?? 2) !== 0) {
    throw new Error(`worktree ${verb} for #${issue} failed: ${(result.stdout ?? '').trim() || (result.stderr ?? '').trim()}`)
  }
  return Promise.resolve(target)
}

// Read the independent groups of every ready issue's parent, by running the packaged plan-lint —
// exactly as the worktree helpers run the packaged worktree.mjs. A parent whose plan declares no
// groups, or whose plan is blocked, simply yields nothing and the tick keeps its ordinary path.
//
// The plan comment is trusted only from a listed operator, as a rocket is: it decides whether an
// unattended bypass run launches and what its children are told they may touch, and anyone who can
// comment on the epic could otherwise post a newer one. No operators, no plan.
export async function defaultParentCandidates(
  gh: TickDeps['gh'],
  repo: string,
  repoPath: string,
  ready: BoardIssue[],
  operators: string[],
): Promise<ParentCandidate[]> {
  if (ready.length < 2 || operators.length === 0) return []
  const script = process.env.VSK_PLAN_LINT_SCRIPT
    || join(dirname(dirname(fileURLToPath(import.meta.url))), 'skill', 'dev-plan', 'scripts', 'plan-lint.mjs')
  if (!existsSync(script)) return []
  const byParent = new Map<number, ReadyChild[]>()
  for (const child of ready) {
    let parent: number | null = null
    try {
      const view = JSON.parse(await gh(['issue', 'view', String(child.number), '--repo', repo, '--json', 'parent'])) as { parent?: { number?: number } }
      parent = view.parent?.number ?? null
    } catch {
      parent = null
    }
    if (parent === null) continue
    const list = byParent.get(parent) ?? []
    list.push({ number: child.number, parent, assignee: child.assignees[0] ?? null, labels: child.labels })
    byParent.set(parent, list)
  }
  const candidates: ParentCandidate[] = []
  for (const [parent, children] of byParent) {
    if (children.length < 2) continue
    let comments: Array<{ body: string; user?: { login?: string } }>
    try {
      comments = JSON.parse(await gh(['api', `repos/${repo}/issues/${parent}/comments`, '--paginate'])) as Array<{ body: string; user?: { login?: string } }>
    } catch {
      continue
    }
    const planComment = comments
      .filter(comment => typeof comment.body === 'string' && /<!--\s*vsk:v1\s+type=plan\b/.test(comment.body))
      .filter(comment => operators.includes(comment.user?.login ?? ''))
      .pop()
    if (!planComment) continue
    const file = join(tmpdir(), `vf-plan-${parent}-${process.pid}.md`)
    let groups: IndependentGroup[] = []
    try {
      writeFileSync(file, planComment.body)
      const result = spawnSync(process.execPath, [script, '--file', file, '--groups', '--json'], { encoding: 'utf8' })
      if ((result.status ?? 2) !== 0) continue
      groups = (JSON.parse(result.stdout) as { groups?: IndependentGroup[] }).groups ?? []
    } catch {
      continue
    } finally {
      try {
        rmSync(file, { force: true })
      } catch {
        // A leftover temp plan is harmless; failing the tick over it is not.
      }
    }
    if (groups.length < 2) continue
    // The parent worktree is named from the parent's real title, exactly as the parent's own run
    // named it. A placeholder here would point every parallel launch at a directory that does not
    // exist.
    let parentTitle: string
    try {
      parentTitle = (JSON.parse(await gh(['issue', 'view', String(parent), '--repo', repo, '--json', 'title'])) as { title?: string }).title ?? ''
    } catch {
      continue
    }
    if (!parentTitle) continue
    const target = worktreeFor(repoPath, parent, parentTitle)
    // The parallel run happens in the parent's own worktree. One that is gone is not a candidate:
    // the children run one at a time, instead of a run whose cwd does not exist being re-planned
    // and failed on every tick.
    if (!existsSync(target.path)) continue
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target.path, encoding: 'utf8' })
    candidates.push({
      parent: { issue: parent, branch: target.branch, head: (head.stdout ?? '').trim(), worktree: target.path },
      groups,
      children,
    })
  }
  return candidates
}

export interface RunReport {
  repo: string
  issue: number
  title: string
  stage: Stage
  launch: { command: string; args: string[]; env: Record<string, string>; cwd: string }
  launched: boolean
  approvalIds?: string[]
  approvalChecked?: boolean
  bindings?: Array<{ repo: string; issue: number; kind: string; artifactId: string; rev: number; digest: string }>
  exitCode?: number | null
  logFile?: string
}

export interface TickResult {
  ok: boolean
  dryRun: boolean
  runs: RunReport[]
  refusals: Refusal[]
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function runTick(
  config: FactoryConfig,
  options: { dryRun: boolean },
  deps?: Partial<TickDeps>,
): Promise<TickResult> {
  const gh = deps?.gh ?? ((args: string[], ghOptions?: { cwd?: string; input?: string }) => ghText(args, ghOptions))
  const now = deps?.now ?? (() => new Date())
  const shipGuard = deps?.shipGuard ?? shipGuardWired
  const ensure = deps?.ensureWorktree ?? defaultEnsureWorktree
  const execute = deps?.execute ?? ((run, plan, cfg, opts) => executeRun(run, plan, cfg, opts))
  const parentCandidates = deps?.parentCandidates
    ?? ((repo: string, repoPath: string, ready: BoardIssue[], operators: string[]) => defaultParentCandidates(gh, repo, repoPath, ready, operators))
  const issueBody = deps?.issueBody ?? (async (repo: string, issue: number) => {
    const raw = await gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'body'])
    return (JSON.parse(raw) as { body?: string }).body ?? ''
  })
  const tracker = deps?.tracker ?? processTracker

  let state = await readState(config.stateFile)
  const runs: RunReport[] = []
  const refusals: Refusal[] = []

  for (const entry of config.repos) {
    if (config.executionMode === 'shared') {
      refusals.push({ repo: entry.repo, issue: null, reason: 'shared machine requires validated registration and shared ownership; legacy local locks cannot authorize launch' })
      continue
    }
    const devMd = await readIfPresent(join(entry.path, '.vegastack', 'dev.md'))
    if (devMd === null) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: no .vegastack/dev.md at ${entry.path} — the dispatcher reads its policy from the repo, and an absent profile is off` })
      continue
    }
    const resolved = loadConfiguredPolicy({ home: config.home, repo: entry.repo, devMd, now: now().toISOString() })
    const policy = repoPolicyFromEffective(resolved)
    const statsPolicy = statsPolicyFromEffective(resolved)
    let harness: Harness
    try {
      harness = stagePolicy(policy, 'implement').harness
    } catch (error) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: ${(error as Error).message}` })
      continue
    }
    const lockPath = repoLockPath(config, entry.repo)
    const inFlight = inFlightIssues(tracker, entry.repo)
    // This process holds the repo lock for as long as it has a run in flight there; its own lock is
    // not "another run", and maxRuns against the in-flight count is what bounds it.
    const lock = await readLock(lockPath)
    const guards: GuardState = {
      shipGuard: await shipGuard(entry.path, harness, { home: config.home, repo: entry.repo }),
      lock: lock.held && lock.pid === process.pid ? { held: false, pid: null } : lock,
      activeRuns: inFlight.length,
    }
    const guardRefusals = evaluateGuards({ repo: entry.repo, policy, guards, maxRuns: config.maxRuns })
    if (guardRefusals.length > 0) {
      refusals.push(...guardRefusals)
      continue
    }

    // The tick's time is the moment the board is read, stamped before any run: a run can take hours,
    // and a stamp taken after it would say the dispatcher went quiet for exactly that long.
    const readAt = now().toISOString().replace(/\.\d+Z$/, 'Z')
    let board: Awaited<ReturnType<typeof fetchBoard>>
    let rockets: Rocket[]
    try {
      board = await fetchBoard(gh, entry.repo)
      rockets = await fetchRockets(gh, entry.repo, board.corrections, state.handled)
    } catch (error) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: the board could not be read — ${(error as Error).message}` })
      continue
    }

    let parents: ParentCandidate[] = []
    try {
      parents = await parentCandidates(entry.repo, entry.path, board.ready, policy.operators)
    } catch (error) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: the parents' independent groups could not be read, so the children run one at a time — ${(error as Error).message}` })
    }
    const plan = planTick({ repo: entry.repo, policy, board, rockets, state, guards, maxRuns: config.maxRuns, parents, inFlight })
    refusals.push(...plan.refusals)

    // The repo-level check above read the implement harness's wiring. A plan run may name another
    // harness, whose wiring is a different file; it is checked once per harness, in the main
    // checkout, before any run on it is considered.
    const wiredInCheckout = new Map<Harness, { wired: boolean; detail: string }>([[harness, guards.shipGuard]])
    const guardFor = async (stageHarness: Harness): Promise<{ wired: boolean; detail: string }> => {
      let known = wiredInCheckout.get(stageHarness)
      if (!known) {
        known = await shipGuard(entry.path, stageHarness, { home: config.home, repo: entry.repo })
        wiredInCheckout.set(stageHarness, known)
      }
      return known
    }

    for (const run of plan.runs) {
      let stage: ReturnType<typeof stagePolicy>
      try {
        stage = stagePolicy(policy, run.stage)
      } catch (error) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: ${(error as Error).message}` })
        continue
      }
      const checkoutGuard = await guardFor(stage.harness)
      if (!checkoutGuard.wired) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue} would run on ${stage.harness}, and the ship guard is not wired for it: ${checkoutGuard.detail} — dark builds run under bypass, and the guard is what bounds them` })
        continue
      }
      // Re-read complete live scope immediately before any worktree or harness
      // effect. The packaged dev-implement parser owns both approval and native
      // prerequisite semantics; a board label or rocket is only a start signal.
      let admission: { blocks: string[]; approvalIds: string[]; bindings: NonNullable<RunReport['bindings']> } = { blocks: [], approvalIds: [], bindings: [] }
      // A dry run previews a command only; it never reports approved bindings.
      if (!options.dryRun) try {
        const script = process.env.VSK_PREFLIGHT_SCRIPT
          || join(dirname(dirname(fileURLToPath(import.meta.url))), 'skill', 'dev-implement', 'scripts', 'preflight.mjs')
        const owner = await import(pathToFileURL(script).href)
        const subjects = run.parallel ?? [run.issue]
        const results = []
        for (const issue of subjects) {
          results.push(await owner.gatherAndEvaluate({ repo: entry.repo, issue: String(issue),
            stage: run.stage === 'plan' ? 'plan' : 'implement',
            expect: run.stage === 'plan' ? 'needs-plan' : run.stage === 'corrections' ? 'for-operator' : 'ready',
          }, { readJson: (args: string[]) => ghJsonVia(gh, args), devMd }))
        }
        admission = { blocks: results.flatMap(result => result.blocks),
          approvalIds: [...new Set<string>(results.flatMap(result => result.approvalIds))],
          bindings: results.flatMap(result => result.bindings) }
        if (admission.blocks.length) throw new Error(admission.blocks.join('; '))
      } catch (error) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: launch preflight refused — ${(error as Error).message}` })
        continue
      }
      const parentOf = run.parallel ? parents.find(candidate => candidate.parent.issue === run.issue) : undefined
      if (run.parallel && !parentOf) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: the parent worktree for a parallel run could not be resolved — its children run one at a time next tick` })
        continue
      }
      // A parallel run happens in the parent's OWN worktree, which already exists — the children
      // get their checkouts from the harness or from children.mjs, never from the tick.
      const target: WorktreeTarget = parentOf
        ? { path: parentOf.parent.worktree, branch: parentOf.parent.branch, slug: '', type: 'feat' }
        : options.dryRun
          ? worktreeFor(entry.path, run.issue, run.title)
          : await ensure(entry.path, run.issue, run.title)
      // The harness reads its hook config from the directory it is started in, and that is the
      // worktree — a fresh checkout of tracked files, where a gitignored .claude/ or .codex/ does
      // not exist. So the wiring is verified again where the run will actually happen; a dry run
      // checks a worktree that already exists and says nothing about one it would create.
      if (!options.dryRun || existsSync(target.path)) {
        const worktreeGuard = await shipGuard(target.path, stage.harness, { home: config.home, repo: entry.repo })
        if (!worktreeGuard.wired) {
          refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: the ship guard is not wired for ${stage.harness} in the worktree ${target.path} (${worktreeGuard.detail}) — the run would start there under bypass with nothing bounding it; commit the harness wiring or list it in dev.md's worktree-include:` })
          continue
        }
      }
      const launch = run.parallel && parentOf
        ? parentParallelLaunchPlan(
            { kind: 'parent-parallel', parent: run.issue, children: run.parallel },
            parentOf.parent,
            {
              harness: stage.harness,
              model: stage.model,
              effort: stage.effort,
              operator: policy.operators[0] ?? 'the operator',
              subagents: config.subagents,
              stopList: stopList(devMd),
            },
          )
        : buildLaunchPlan({
            harness: stage.harness,
            model: stage.model,
            effort: stage.effort,
            stage: run.stage,
            worktree: target.path,
            issue: { number: run.issue, title: run.title },
            operator: policy.operators[0] ?? 'the operator',
            outcome: (await issueBody(entry.repo, run.issue).then(outcomeOf).catch(() => '')) || run.title,
            stopList: stopList(devMd),
            resume: run.stage === 'corrections',
            skillPath: null,
            subagents: config.subagents,
          })
      const report: RunReport = {
        repo: entry.repo,
        issue: run.issue,
        title: run.title,
        stage: run.stage,
        launch: { command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd },
        launched: false,
        approvalChecked: !options.dryRun,
        approvalIds: admission.approvalIds,
        bindings: admission.bindings,
      }
      if (options.dryRun) {
        runs.push(report)
        continue
      }
      // The run is started here and finished elsewhere: the tick moves on to the next run and the
      // next repo, and the loop keeps its interval, however long this run takes. The repo lock is
      // held from the first run in flight to the last one out, and the report the tick returns is
      // completed in place when the run ends — `--once` waits for that, the watch loop does not.
      if (inFlightIssues(tracker, entry.repo).length === 0) await holdLock(lockPath, process.pid)
      const key = `${entry.repo}#${run.issue}`
      const runStage = stage
      const runTarget = target
      const runParent = parentOf
      const done = (async () => {
        try {
          const outcome = await execute(run, launch, config, { operator: policy.operators[0] ?? null })
          report.exitCode = outcome.exitCode
          report.logFile = outcome.logFile
          const written = await recordRun({
            harness: runStage.harness,
            stdout: outcome.stdout ?? '',
            exitCode: outcome.exitCode ?? 1,
            startedAt: outcome.startedAt ?? now().toISOString(),
            finishedAt: outcome.finishedAt ?? now().toISOString(),
            repo: entry.repo,
            issue: run.issue,
            parent: runParent?.parent.issue ?? null,
            stage: run.stage,
            model: runStage.model,
            effort: runStage.effort,
            human: policy.operators[0] ?? 'unknown',
            worktree: runTarget.path,
          }, { home: config.home, hostname: hostname(), policy: statsPolicy, rework: (repo, issue) => issueRework(gh, repo, issue) })
          // Never allowed to fail into the run: a control room that is unreachable costs the org a
          // delay, not a run.
          if (written) {
            statsPushChain = statsPushChain.then(() => flushStats({
              home: config.home,
              cloneRoot: statsClonePath(config.home, entry.org),
              ghUser: policy.operators[0] ?? 'unknown',
              hostname: hostname(),
              git: defaultStatsGit,
            }))
            await statsPushChain
          }
        } catch (error) {
          // executeRun does not throw; a stub or a future edit that does must still release the
          // lock and leave the tracker, or the repo is wedged for the life of the process.
          report.exitCode = null
          process.stderr.write(`run on ${key} failed outside the harness: ${(error as Error).message}\n`)
        } finally {
          tracker.delete(key)
          if (inFlightIssues(tracker, entry.repo).length === 0) await releaseLock(lockPath)
        }
      })()
      tracker.set(key, { repo: entry.repo, issue: run.issue, done })
      report.launched = true
      // Only reactions need dedupe, and they are recorded the moment the run starts: the board
      // itself is the record for a label run once the run moves the label, and recording label
      // runs here would grow the state file forever for no gain.
      if (run.reactionId !== null) state = recordHandled(state, run)
      runs.push(report)
    }
    state = withLastTick(state, entry.repo, readAt)
  }

  if (!options.dryRun) await writeState(config.stateFile, state)
  return { ok: runs.length > 0, dryRun: options.dryRun, runs, refusals }
}

// The brief's own Outcome paragraph is what the operator actually needs; the title is only its
// label. A brief with no Outcome section falls back to the title rather than to silence.
export function outcomeOf(body: string): string {
  const section = body.split(/^## Outcome\s*$/m)[1]
  if (!section) return ''
  const text = (section.split(/^## /m)[0] ?? '').trim()
  return text === '' ? '' : text.split('\n\n')[0]!.trim()
}

// The profile's own stop-list, handed to every run verbatim: the operator wrote those lines, and a
// dispatcher that paraphrased them would be editing policy.
export function stopList(devMd: string): string[] {
  const section = devMd.split(/^## Stop and ask.*$/m)[1]
  if (!section) return []
  const body = section.split(/^## /m)[0] ?? ''
  const lines = body.split('\n').map(line => line.trim()).filter(line => line !== '')
  const bullets = lines.filter(line => line.startsWith('- ')).map(line => line.slice(2).trim())
  // Most profiles write the section as prose, not a list — taking only bullets would hand a run an
  // empty stop-list on exactly the repos that wrote theirs most carefully.
  return bullets.length > 0 ? bullets : lines
}

// `--once`: one tick, then wait for every run it started, so the process that asked for one tick
// gets one tick's runs finished and reported before it exits.
export async function runOnce(
  config: FactoryConfig,
  options: { dryRun: boolean },
  deps?: Partial<TickDeps>,
): Promise<TickResult> {
  const result = await runTick(config, options, deps)
  await settleRuns(deps?.tracker ?? processTracker)
  return result
}

// One dispatcher per machine, and it never exits on its own: a tick that throws is logged through
// the refusal list and the loop continues, because a service that dies on one bad repo stops
// watching every other one. Stopping waits for the runs in flight — a run is never orphaned by the
// dispatcher that started it.
export async function watch(
  config: FactoryConfig,
  options: { dryRun: boolean; onTick?: (result: TickResult) => void; ticks?: number },
  deps?: Partial<TickDeps>,
): Promise<void> {
  const existing = await readLock(config.dispatcherLock)
  if (existing.held) throw new Error(`a dispatcher is already running on this machine (pid ${existing.pid}) — stop it before starting another`)
  await holdLock(config.dispatcherLock, process.pid)
  let stopping = false
  const stop = (): void => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    for (let tick = 0; !stopping && (options.ticks === undefined || tick < options.ticks); tick += 1) {
      const result = await runTick(config, { dryRun: options.dryRun }, deps).catch((error: Error) => ({
        ok: false,
        dryRun: options.dryRun,
        runs: [],
        refusals: [{ repo: '*', issue: null, reason: `the tick failed: ${error.message}` }],
      } satisfies TickResult))
      options.onTick?.(result)
      if (stopping) break
      await new Promise(resolve => setTimeout(resolve, config.interval * 1000))
    }
  } finally {
    await settleRuns(deps?.tracker ?? processTracker)
    await releaseLock(config.dispatcherLock)
  }
}

// --- the verb ---------------------------------------------------------------

export function dispatchUsage(): string {
  return `Usage: vegafactory dispatch [--once] [--watch] [--dry-run] [--json] [--config PATH]

  --once        run exactly one tick and wait for the runs it started
  --watch       tick every interval seconds until stopped (the service form); runs
                finish out-of-band, and stopping waits for the ones in flight
  --dry-run     print the launch plan and launch nothing; the default when neither
                --once nor --watch is given
  --json        machine-readable output
  --config      path to factory.json (default ~/.vegastack/factory.json)

Exit 0 runs planned or launched · 1 nothing ran and every candidate was refused ·
2 a usage error or a config that cannot be read.
`
}

export interface DispatchArgs { once: boolean; watch: boolean; dryRun: boolean; json: boolean; config: string | null; help: boolean }

export function parseDispatchArgs(argv: string[]): DispatchArgs {
  const args: DispatchArgs = { once: false, watch: false, dryRun: false, json: false, config: null, help: false }
  const rest = [...argv]
  while (rest.length) {
    const token = rest.shift()!
    if (token === '--once') args.once = true
    else if (token === '--watch') args.watch = true
    else if (token === '--dry-run') args.dryRun = true
    else if (token === '--json') args.json = true
    else if (token === '--help' || token === '-h' || token === 'help') args.help = true
    else if (token === '--config') {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) throw new Error('--config requires a path')
      args.config = value
    }
    else throw new Error(`Unknown option: ${token}`)
  }
  if (args.once && args.watch) throw new Error('--once and --watch are mutually exclusive: one tick, or the loop')
  // Anything that can start a dark build is dry-run until asked for explicitly.
  if (!args.once && !args.watch) args.dryRun = true
  return args
}

function renderTick(result: TickResult): string {
  const lines: string[] = []
  for (const run of result.runs) {
    lines.push(`  ${run.launched ? 'launched' : 'would launch'} ${run.stage} on ${run.repo}#${run.issue} — ${run.launch.command} in ${run.launch.cwd}`)
  }
  for (const refusal of result.refusals) lines.push(`  refused: ${refusal.reason}`)
  return lines.length > 0 ? lines.join('\n') : '  nothing to do'
}

export async function runDispatchCli(argv: string[], home: string): Promise<number> {
  let args: DispatchArgs
  try {
    args = parseDispatchArgs(argv)
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${dispatchUsage()}`)
    return 2
  }
  if (args.help) {
    console.log(dispatchUsage())
    return 0
  }
  const configPath = args.config ?? join(home, '.vegastack', 'factory.json')
  let config: FactoryConfig
  try {
    config = await loadFactoryConfig(configPath, home)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }

  const emit = (result: TickResult): void => {
    if (args.json) console.log(JSON.stringify({ command: 'dispatch', ...result }, null, 2))
    else console.log(renderTick(result))
  }

  if (args.watch) {
    await watch(config, { dryRun: args.dryRun, onTick: emit })
    return 0
  }
  const result = await runOnce(config, { dryRun: args.dryRun })
  emit(result)
  return result.runs.length > 0 ? 0 : 1
}

// The tick's own git runner for the stats push: the operator's existing gh credential, injected per
// invocation exactly as `sync.ts` does, and never a token in argv or in the clone's config.
const defaultStatsGit: GitRunner = (args, cwd) => new Promise(resolve => {
  const child = spawn('git', [...GIT_CREDENTIAL_ARGS, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}${(error as Error).message}` }))
  child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
})

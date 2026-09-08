import { canonical as canonicalWire } from './shared-claims.ts'
import { createRun, readRun, transitionRun, runsRoot, type RunRecord, type TerminalCause, type RunInput, prepareRunAttemptDirectory } from './runs.ts'
import { resolveLabels, resolveState } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import type { LabelMap } from './config.ts'
// The dispatcher: what a tick would do, and then doing it. Everything that decides is a pure
// function over data — a board, a set of reactions, a policy, the state file — so the whole
// decision surface is unit-testable without a network, a clock, or a running loop. The effectful
// half (searching, spawning, logging, handing back) is at the bottom and does no thinking.
//
// Refusals are first-class output, never silence: a repo that is skipped says why, in the JSON and
// in the log, because "nothing happened" and "the ship guard is unwired" look identical otherwise.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { acquireClaim, releaseClaim, inspectClaim, processIdentity, type Claim } from './claims.ts'
import { acquireSharedTask, transitionSharedTask, type EffectiveMachine, type MachineSession, type VerifiedCandidate, type SharedClaim, type TaskTransition } from './shared-claims.ts'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolveTarget, syncControlRoom } from './sync.ts'
import { parseControlRoomKnob, loadConfiguredPolicy, readSettingsFile, factoryConfigPath } from './control-room.ts'
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { loadFactoryConfig, repoPolicyFromEffective, stagePolicy, type FactoryConfig, type Harness, type RepoEntry, type RepoPolicy, type Stage, type Subagents } from './config.ts'
import { buildLaunchPlan, validateManagedLaunch, observeVendorEvent, inspectSubscription, resumeLaunchPlan, type HarnessMetadata, type LaunchPlan } from './launch.ts'
import { checkoutFile, inspectCodexConfiguration, readHookConfiguration, validateRegistration } from './hook-registration.ts'
import { checkCompiledGuard, shipPolicyScript } from './guard.ts'
import { GhUnavailable, ghText, withinRead, assertReadActive, boundedGhJson, fetchGhPages, readBudget, type ReadBudget, type PagedResult, type GhOptions } from './gh.ts'
import { GIT_CREDENTIAL_ARGS } from './sync.ts'
import { fromClaudeHeadless, fromCodexExec, claudeHeadlessResult, reworkFromComments, type ReworkCounts } from './stats/capture.ts'
import { appendRecord, takeSkillInvocations } from './stats/outbox.ts'
import { pushOutbox, statsClonePath, type GitRunner, type PushResult } from './stats/push.ts'
import { normalizeRecord, statsPolicyFromEffective, type StatsPolicy, type StatsRecord } from './stats/record.ts'

export interface BoardIssue {
  nodeId?: string
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
const defaultMap = resolveLabels(undefined)

// `no:assignee` is in the query and checked again here: search indexes lag, and a stale index is
// exactly how two runs start on one issue.
//
// The corrections query carries no `updated:>=` window on purpose. A reaction does not move an
// issue's `updated_at`, so a 🚀 on an existing hand-back comment would never re-enter a window; and
// a comment posted while a run was in flight lands before the next window opens. Every
// for-operator issue is read on every tick, and the handled list is what stops the repeats.
export function searchQueries(repo: string, map: LabelMap = defaultMap): { needsPlan: string; ready: string; corrections: string } {
  const scope = `repo:${repo} is:issue is:open`
  return {
    needsPlan: `${scope} label:${JSON.stringify(map.needsPlan)}`,
    ready: `${scope} label:${JSON.stringify(map.ready)} no:assignee`,
    corrections: `${scope} label:${JSON.stringify(map.forOperator)}`,
  }
}

function stateLabelRefusal(repo: string, issue: BoardIssue, map: LabelMap = defaultMap, expected?: string): Refusal | null {
  const result = resolveState(issue.labels, map)
  if (result.blocks.length || (expected && result.state !== expected)) {
    return { repo, issue: issue.number, reason: `#${issue.number}: ${result.blocks.join('; ') || 'workflow state changed; expected ' + expected}` }
  }
  if (issue.labels.includes('epic')) {
    return { repo, issue: issue.number, reason: `#${issue.number} is an epic — epics are maps, and only their children ever run` }
  }
  return null
}

export function planLabelRuns(input: { repo: string; needsPlan: BoardIssue[]; ready: BoardIssue[]; labelMap?: LabelMap }): TickPlan {
  const runs: PlannedRun[] = []
  const refusals: Refusal[] = []
  const consider = (issue: BoardIssue, stage: Stage): void => {
    const refusal = stateLabelRefusal(input.repo, issue, input.labelMap, stage === 'plan' ? 'needsPlan' : 'ready')
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
  labelMap?: LabelMap
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
    const refusal = stateLabelRefusal(input.repo, issue, input.labelMap, 'forOperator')
    if (refusal) { refusals.push(refusal); continue }
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
export async function shipGuardWired(repoPath: string, harness: Harness, policy?: { home: string; repo: string; policyDigest?: string }): Promise<{ wired: boolean; detail: string; policyDigest?: string | null }> {
  const guardPath = join(repoPath, '.vegastack', 'hooks', 'ship-guard.mjs')
  try {
    await readFile(guardPath, 'utf8')
  } catch {
    return { wired: false, detail: `no ${join('.vegastack', 'hooks', 'ship-guard.mjs')} in ${repoPath}` }
  }
  const relative = harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'
  let parsed: unknown
  try { parsed = readHookConfiguration(repoPath, harness, policy?.home).config }
  catch (error) { return { wired: false, detail: `${relative}: ${(error as Error).message}`, policyDigest: null } }
  const registration = validateRegistration({ config: parsed, harness, checkout: repoPath, guardPath })
  if (!registration.ok) return { wired: false, detail: `${relative}: ${registration.problems.join('; ')}` }
  // Trust the installed package's exact asset, not an arbitrary same-named script.
  try {
    const actual = await readFile(checkoutFile(repoPath, guardPath))
    const expected = await readFile(join(dirname(shipPolicyScript()), '../assets/hooks/ship-guard.mjs'))
    if (!actual.equals(expected)) return { wired: false, detail: 'ship-guard.mjs differs from the installed package asset', policyDigest: null }
  } catch { return { wired: false, detail: 'the installed guard package asset could not be verified', policyDigest: null } }
  if (policy) {
    const checked = checkCompiledGuard({ checkout: repoPath, ...policy })
    if (!checked.wired) return checked
    // Consult the actual trusted reader's version contract; a current compiler cannot make
    // an older guard understand a new policy. This is not a second policy parser.
    try {
      const reader = await import(pathToFileURL(join(dirname(shipPolicyScript()), '../assets/hooks/ship-guard.mjs')).href)
      if (reader.SCHEMA_VERSION !== 2 || typeof reader.readPolicyFile !== 'function') {
        return { wired: false, policyDigest: null, detail: `installed guard reader schema ${reader.SCHEMA_VERSION ?? 'unknown'} cannot consume compiled policy schema 2; upgrade the guard and compiler together` }
      }
    } catch { return { wired: false, policyDigest: null, detail: 'installed guard reader contract is unavailable' } }
    return { ...checked, detail: `${relative}: configured guard and ${checked.detail}; invocation/coverage remain unqualified` }
  }
  return { wired: true, detail: `${relative}: configured guard; compiled policy and invocation not checked`, policyDigest: null }
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
  labelMap: LabelMap = defaultMap,
): ParentParallelRun | null {
  const eligible = ready.filter(child => child.parent === parent.issue && !child.assignee && resolveState(child.labels, labelMap).state === 'ready')
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

  const labels = planLabelRuns({ repo: input.repo, needsPlan: input.board.needsPlan, ready: input.board.ready, labelMap: input.policy.labelMap })
  const rockets = planRocketRuns({
    repo: input.repo,
    corrections: input.board.corrections,
    labelMap: input.policy.labelMap,
    rockets: input.rockets,
    operators: input.policy.operators,
    state: input.state,
  })
  // A parent whose children can run at the same time replaces those children in the candidate
  // list: one run, one join, one verify — instead of one run per child and no join at all.
  const parallelRuns: PlannedRun[] = []
  const covered = new Set<number>()
  for (const candidate of input.parents ?? []) {
    const parallel = parentParallelLaunch(candidate.children, candidate.groups, candidate.parent, input.policy.labelMap)
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
  runId?: string
  terminationCause?: TerminalCause
  exitCode: number | null
  timedOut: boolean
  log: string
  worktree: string
  at: string
}): string {
  const how = input.timedOut ? 'timed out' : `failed with exit ${input.exitCode ?? 'unknown'}`
  return ['<!-- vsk:v1 type=handback -->','## Hand-back','',`The ${input.stage} execution ${how}. Saved work is preserved; reconciliation is required.`].join('\n')
}

export interface RunOutcome {
  runId?: string
  terminationCause?: TerminalCause
  waitReason?: 'subscription-quota' | null
  attemptId?: string
  exitCode: number | null
  timedOut: boolean
  logFile: string
  pushed: boolean
  handedBack: boolean
  started?: boolean
  refusal?: string
  // What the stats record is built from. Optional because the tick's `execute` seam is stubbed in
  // several tests; a run with no stdout still produces a record, just a context-only one.
  stdout?: string
  startedAt?: string
  finishedAt?: string
}

export interface ExecuteDeps {
  now: () => Date
  gh: (args: string[], options?: GhOptions) => Promise<string>
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; message: string }>
  timeoutMs: number | null
  wrapperPath: string
  runInput: RunInput
  preparedRun: RunRecord
  monotonic: () => number
  subscriptionMetadata: import('./launch.ts').SubscriptionMetadataReader
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
// Metadata only: version and allowlisted config/hook RPCs start no task or turn.
export async function inspectManagedHarness(plan: LaunchPlan): Promise<HarnessMetadata> {
  try { if (realpathSync(plan.cwd) !== plan.cwd) return { version: '', problems: ['prepared checkout must be canonical before managed launch'] } }
  catch { return { version: '', problems: ['prepared checkout is unavailable'] } }
  const options = { cwd: plan.cwd, env: { ...process.env, ...plan.env }, encoding: 'utf8' as const, timeout: 5000, killSignal: 'SIGKILL' as const, maxBuffer: 128 * 1024 }
  const version = spawnSync(plan.command, ['--version'], options)
  if (version.status !== 0 || version.error || version.signal) return { version: '' }
  const metadata: HarnessMetadata = { version: version.stdout.trim() }
  if (plan.command === 'codex' && metadata.version === 'codex-cli 0.153.4') {
    const inspected = await inspectCodexConfiguration({ command: plan.command, cwd: plan.cwd, env: options.env,
      args: plan.args.flatMap((arg, index) => arg === '--strict-config' ? [arg] : ['-c', '--config', '--enable', '--disable'].includes(arg)
        ? [arg, plan.args[index + 1] ?? ''] : []) })
    return { ...metadata, ...inspected }
  }
  // CLI version/help and a raw/cached settings cascade do not prove which managed Claude
  // restrictions apply. Until a supported effective inspection is available, refuse instead
  // of assuming project hooks or memory overrides beat administrator policy.
  return { ...metadata, hookApplicable: false, memoryRetrievalDisabled: false, memoryGenerationDisabled: false,
    problems: ['effective Claude hook and memory configuration inspection is unavailable'] }
}

export async function executeRun(
  run: PlannedRun,
  plan: LaunchPlan,
  config: FactoryConfig,
  options: { operator: string | null; onSpawn?: () => void; onWait?: () => void; signal?: AbortSignal; sharedClaim?: SharedClaim },
  deps?: Partial<ExecuteDeps>,
): Promise<RunOutcome> {
  const now = deps?.now ?? (() => new Date())
  const timeoutMs = deps?.timeoutMs
  if(timeoutMs != null && (!Number.isFinite(timeoutMs)||timeoutMs<=0))throw Error('invalid explicit execution timeout')
  const root=runsRoot(config.home),startedAt=now().toISOString()
  const gitHead=spawnSync('git',['rev-parse','HEAD'],{cwd:plan.cwd,encoding:'utf8'}).stdout?.trim()??''
  const branch=spawnSync('git',['symbolic-ref','--short','HEAD'],{cwd:plan.cwd,encoding:'utf8'}).stdout?.trim()??''
  const hostBindingDigest=(await (await import('./machine-identity.ts')).readHostBinding()).digest
  let record:RunRecord=deps?.preparedRun??await createRun(deps?.runInput??{root,hostBindingDigest,repo:run.repo,issue:run.issue,parent:null,checkout:plan.cwd,branch,baseSha:gitHead,headSha:gitHead||null,stage:run.stage,harness:plan.command,model:'unknown',effort:'unknown',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:plan.guardPolicyDigest??'',claimToken:randomUUID(),startedAt,taskKey:{repo:run.repo,issue:run.issue,taskId:'unknown',scopeDigest:''},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:plan.remoteEffectCoverage??{kind:'unmanaged-possible',reasonCode:'unqualified-local-attempt'}})
  const recordRoot=deps?.runInput?.root??root
  const file=join(recordRoot,record.runId,'events.jsonl')
  const event=async(event:string,fields:Record<string,unknown>={})=>{await appendFile(file,JSON.stringify({at:now().toISOString(),event,...fields})+'\n',{mode:0o600})}
  let mutations=Promise.resolve()
  const transition=(patch:Parameters<typeof transitionRun>[2])=>{mutations=mutations.then(async()=>{record=await transitionRun(record.runId,record.generation,patch,recordRoot)});return mutations}
  await event('prepared')
  const refuse=async(reason:string):Promise<RunOutcome>=>{await transition({state:'terminal',terminationCause:'spawn-failed',finishedAt:now().toISOString()});await event('launch-refused',{reasonCode:'launch-refused'});return{runId:record.runId,started:false,refusal:reason,terminationCause:'spawn-failed',exitCode:null,timedOut:false,logFile:file,pushed:false,handedBack:false}}
  if(options.signal?.aborted)return refuse('cancelled before launch')
  if(run.parallel?.length)return refuse('parallel launch requires child gateway')
  if(!['darwin','linux'].includes(process.platform))return refuse('owned process cancellation unsupported on this platform')
  if(plan.command==='claude'||plan.command==='codex'){
    const controls=validateManagedLaunch(plan,await inspectManagedHarness(plan));if(!controls.ok)return refuse('managed launch configuration refused')
    const guard=await shipGuardWired(plan.cwd,plan.command,{home:config.home,repo:run.repo,policyDigest:plan.guardPolicyDigest});if(!guard.wired)return refuse('prepared guard refused')
    if(!record.execution || !record.approvalBindings.length)return refuse('verified execution and approval provenance unavailable')
    const runtime=await import('./runs.ts')
    try{
      if(!record.runtimeBinding||!record.configurationDigest)throw Error('runtime binding unavailable')
      await runtime.verifyInstalledRuntimeBinding(record.runtimeBinding,dirname(dirname(fileURLToPath(import.meta.url))),fileURLToPath(import.meta.url))
      const currentDigest=await runtime.executionConfigurationDigest({binding:record.runtimeBinding,execution:record.execution,plan,metadata:await inspectManagedHarness(plan)})
      if(currentDigest!==record.configurationDigest)throw Error('qualified configuration changed')
      await runtime.verifyRunAuthority(record,config,'launch')
      const target=options.sharedClaim?.target??await verifiedSharedTarget(record.repo,config,record.runId)
      sharedRunContexts.set(target,record.runId)
      record=await runtime.refreshAttemptCoverage(recordRoot,record.runId,target)
    }catch{return refuse('current source or runtime qualification unavailable')}

    let subscription:Awaited<ReturnType<typeof inspectSubscription>>
    try{subscription=await inspectSubscription(plan,record.execution!.accountRef,deps?.subscriptionMetadata)}catch{return refuse('subscription identity or configuration unavailable')}
    if(subscription.available===false){
      const {nextQuotaCheck}=await import('./runs.ts')
      await transition({state:'terminal',terminationCause:'failed',finishedAt:now().toISOString(),waitReason:'subscription-quota',quotaWait:{checks:record.quotaChecks??0,nextCheckAt:new Date(nextQuotaCheck(record.quotaChecks??0,now().getTime(),subscription.retryAt??undefined)).toISOString()}})
      try{await transition({worktreeDigest:await runtime.worktreeFingerprint(record.checkout),attemptElapsedMs:0,activeElapsedMs:record.activeElapsedMs??0})}catch{}
      return{runId:record.runId,attemptId:record.attemptId,started:false,terminationCause:'failed',waitReason:'subscription-quota',exitCode:null,timedOut:false,logFile:file,pushed:false,handedBack:false}
    }
  }
  const wrapperPath=deps?.wrapperPath??join(dirname(fileURLToPath(import.meta.url)),'run-wrapper.js')
  if(!existsSync(wrapperPath))return refuse('packaged run wrapper unavailable')
  if(record.cancelRequestedAt)throw Error('run was explicitly cancelled; fresh resume authority required')
  const {inspectOwnedGroup,signalOwnedGroup}=await import('./run-wrapper.ts')
  const directory=await prepareRunAttemptDirectory(recordRoot,record),attemptId=record.attemptId??record.runId
  const monotonic=deps?.monotonic??(()=>performance.now())
  let started=false,stdout='',cause:TerminalCause|null=null,exitCode:number|null=null,identity:Awaited<ReturnType<typeof processIdentity>>|null=null
  const historicalElapsed=(record.attempts??[]).some(a=>a.activeElapsedMs===null)?null:(record.attempts??[]).reduce((sum,a)=>sum+a.activeElapsedMs!,0)
  let activeStart=monotonic(),elapsed=0,quota:{retryAt:number|null}|null=null,vendorFailed=false
  await new Promise<void>((resolveOutcome,rejectOutcome)=>{
    const child=spawn(process.execPath,[wrapperPath,directory,record.runId,attemptId],{cwd:plan.cwd,env:{...process.env},detached:true,stdio:['ignore','pipe','pipe','ipc']})
    let settled=false,exited=false,resultReceived=false,cleanupStarted=false,stopAt:number|null=null
    let timeout:ReturnType<typeof setTimeout>|undefined,escalation:ReturnType<typeof setTimeout>|undefined
    let messages=Promise.resolve()
    const send=(message:unknown)=>{if(child.connected)child.send(message as Parameters<typeof child.send>[0],()=>{})}
    const failCause=(reason:TerminalCause)=>{if(reason==='termination-unconfirmed'||cause===null||!['timed-out','cancelled'].includes(cause))cause=reason}
    const stop=(reason:TerminalCause)=>{
      failCause(reason)
      if(['timed-out','cancelled','interrupted','failed'].includes(reason)&&(!record.terminationRequest||['timed-out','cancelled'].includes(reason)&&!['timed-out','cancelled'].includes(record.terminationRequest.cause)))void transition({terminationRequest:{cause:reason as 'timed-out'|'cancelled'|'interrupted'|'failed',at:now().toISOString()}}).catch(()=>{})
      if(stopAt!==null)return
      stopAt=monotonic()
      send({kind:'cancel'})
      if(identity)void signalOwnedGroup(identity,'SIGTERM').then(ok=>{if(!ok)cause='termination-unconfirmed'})
      escalation=setTimeout(()=>{if(identity)void signalOwnedGroup(identity,'SIGKILL').then(ok=>{if(!ok)cause='termination-unconfirmed'})},5000)
    }
    const aborted=()=>{void transition({cancelRequestedAt:now().toISOString()}).catch(()=>{});stop('cancelled')}
    options.signal?.addEventListener('abort',aborted,{once:true})
    const handshakeTimer=setTimeout(()=>stop('spawn-failed'),6000)
    const heartbeat=setInterval(()=>{
      send({kind:'heartbeat'})
      if(started&&!exited){elapsed=Math.max(elapsed,monotonic()-activeStart);void transition({attemptElapsedMs:elapsed,activeElapsedMs:historicalElapsed===null?null:historicalElapsed+elapsed}).catch(()=>stop('termination-unconfirmed'))}
    },5000)
    const settle=async()=>{
      if(settled)return
      settled=true
      clearTimeout(handshakeTimer);clearInterval(heartbeat);if(timeout)clearTimeout(timeout);if(escalation)clearTimeout(escalation)
      options.signal?.removeEventListener('abort',aborted)
      await mutations
      elapsed=started?Math.max(elapsed,monotonic()-activeStart):0
      resolveOutcome()
    }
    const cleanup=async()=>{
      if(cleanupStarted)return
      cleanupStarted=true
      if(identity){
        let observed=await inspectOwnedGroup(identity)
        if(!exited&&resultReceived&&observed.kind==='owned'&&observed.members.every(pid=>pid===identity!.pid))send({kind:'release'})
        else if(observed.kind==='owned'&&!exited)stop(cause??'interrupted')
        else if(observed.kind!=='absent')cause='termination-unconfirmed'
        // TERM + KILL verification share one deadline, including a root that exits early.
        const deadline=(stopAt??monotonic())+(stopAt===null?2000:7000)
        while(monotonic()<deadline){
          observed=await inspectOwnedGroup(identity)
          if(observed.kind==='absent')break
          if(observed.kind==='foreign'){cause='termination-unconfirmed';break}
          await new Promise(resolve=>setTimeout(resolve,25))
        }
        if((await inspectOwnedGroup(identity)).kind!=='absent')cause='termination-unconfirmed'
      }else if(started)cause='termination-unconfirmed'
      if(!exited&&child.connected&&cause==='termination-unconfirmed')child.disconnect()
      await settle()
    }
    child.once('spawn',()=>{
      messages=messages.then(async()=>{
        // This identity is tied to the child object we just spawned, even if handshake I/O fails.
        identity=await processIdentity(child.pid!)
        await transition({pid:identity.pid,processStartId:identity.startId,processGroupId:identity.pid,processIdentity:identity})
      }).catch(()=>stop('termination-unconfirmed'))
    })
    child.on('message',(message:unknown)=>{
      messages=messages.then(async()=>{
        const m=message as {kind:string;schemaVersion:number;runId:string;attemptId:string;identity:Awaited<ReturnType<typeof processIdentity>>;pgid:number;exitCode:number|null;cause:TerminalCause}
        if(!m||m.runId!==record.runId||m.attemptId!==attemptId)throw Error('wrapper message identity mismatch')
        if(m.kind==='handshake'){
          if(m.schemaVersion!==1||m.identity.pid!==child.pid||m.pgid!==child.pid||!identity||canonicalWire(identity)!==canonicalWire(m.identity))throw Error('wrapper handshake mismatch')
          clearTimeout(handshakeTimer)
          if(options.signal?.aborted||stopAt!==null){stop('cancelled');return}
          send({kind:'acknowledge',runId:record.runId,attemptId,command:plan.command,args:plan.args,cwd:plan.cwd,env:{...process.env,...plan.env}})
        }else if(m.kind==='spawn'){
          if(started)throw Error('duplicate vendor spawn')
          started=true;activeStart=monotonic()
          await transition({state:'running'});await event('start');options.onSpawn?.()
          if(timeoutMs!=null)timeout=setTimeout(()=>stop('timed-out'),timeoutMs)
        }else if(m.kind==='result'){
          if(resultReceived||m.schemaVersion!==1||!['succeeded','failed','spawn-failed','interrupted'].includes(m.cause))throw Error('invalid wrapper terminal result')
          resultReceived=true;exitCode=m.exitCode;cause??=m.cause
          void cleanup().catch(rejectOutcome)
        }else throw Error('unknown wrapper event')
      }).catch(()=>{stop('termination-unconfirmed');void cleanup().catch(rejectOutcome)})
    })
    child.stdout!.setEncoding('utf8')
    let eventBuffer=''
    child.stdout!.on('data',(chunk:string)=>{
      stdout=(stdout+chunk).slice(-2_000_000)
      eventBuffer+=chunk
      if(eventBuffer.length>2_000_000){eventBuffer='';return}
      while(eventBuffer.includes('\n')){
        const end=eventBuffer.indexOf('\n'),line=eventBuffer.slice(0,end);eventBuffer=eventBuffer.slice(end+1)
        let observation:ReturnType<typeof observeVendorEvent>
        try{observation=observeVendorEvent(record.execution?.harness??plan.command,JSON.parse(line))}catch{continue}
        if(observation.failed)vendorFailed=true
        if(observation.sessionId)void transition({vendorSessionId:observation.sessionId}).catch(()=>stop('termination-unconfirmed'))
        if(observation.quota){quota=observation.quota;stop('failed')}
      }
    })
    child.stderr!.resume()
    child.once('error',()=>{cause='spawn-failed';exited=true;void messages.then(cleanup).catch(rejectOutcome)})
    child.once('exit',()=>{exited=true;void messages.then(()=>{cause??=started?'interrupted':'spawn-failed';return cleanup()}).catch(rejectOutcome)})
    // Even a broken wrapper that never sends a result is terminated on explicit cancellation.
    const cancellationWatch=setInterval(()=>{if(settled){clearInterval(cancellationWatch);return}if(stopAt!==null&&monotonic()-stopAt>=7000)void cleanup().catch(rejectOutcome)},100)
    cancellationWatch.unref()
  })

  if(vendorFailed&&cause==='succeeded')cause='failed'
  if(cause==='failed'&&record.execution&&!quota){
    try{const subscription=await inspectSubscription(plan,record.execution!.accountRef,deps?.subscriptionMetadata);if(subscription.available===false)quota={retryAt:subscription.retryAt}}catch{/* Failure remains distinct from unverified quota. */}
  }
  const terminalCause:TerminalCause=(cause as TerminalCause|null)??'interrupted'
  if(record.execution&&started&&!quota) {await(await import('./runs.ts')).ensureTerminalCaptureIntent(recordRoot,record.runId);record=await readRun(recordRoot,record.runId)}
  await transition({state:'terminal',terminationCause:terminalCause,exitCode,finishedAt:now().toISOString(),attemptElapsedMs:elapsed,activeElapsedMs:historicalElapsed===null?null:historicalElapsed+elapsed})
  if(quota&&terminalCause!=='termination-unconfirmed'&&terminalCause!=='cancelled'&&terminalCause!=='timed-out'){
    const {nextQuotaCheck}=await import('./runs.ts')
    await transition({waitReason:'subscription-quota',quotaWait:{checks:record.quotaChecks??0,nextCheckAt:new Date(nextQuotaCheck(record.quotaChecks??0,now().getTime(),quota.retryAt??undefined)).toISOString()}})
  }
  try{const helpers=await import('./runs.ts');await transition({headSha:spawnSync('git',['rev-parse','HEAD'],{cwd:record.checkout,encoding:'utf8'}).stdout?.trim()||record.headSha,worktreeDigest:await helpers.worktreeFingerprint(record.checkout)})}catch{/* Unverifiable saved work cannot be automatically resumed. */}
  await persistAttemptCapture(record,stdout,recordRoot,terminalCause)
  await event('exit',{terminationCause:terminalCause,exitCode})
  try { await (await import('./checkpoints.ts')).flushRunCheckpoint(record,config) } catch { await event('checkpoint-pending',{reasonCode:'checkpoint-unavailable'}) }
  try{await flushRunHandback(record,config)}catch{await event('handback-pending',{reasonCode:'handback-unavailable'})}
  // Source and public delivery require a separately durable, exact action intent. Process completion grants none.
  return{runId:record.runId,attemptId:record.attemptId,waitReason:record.waitReason,started,terminationCause:terminalCause,exitCode,timedOut:terminalCause==='timed-out',logFile:file,pushed:false,handedBack:false,stdout,startedAt,finishedAt:record.finishedAt!}

}

// --- statistics -------------------------------------------------------------------------
//
// One record per headless run, written to the machine-local outbox the moment the run ends. It is
// deliberately the last thing the run does and deliberately cannot fail into the tick: a run that
// finished is a run that finished, whether or not anyone was counting.

export interface RunOutcomeInput {
  harness: Harness
  stdout: string
  runId?:string
  attemptId?:string
  exitCode: number
  terminationCause?: TerminalCause
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
  if(input.runId){
    const saved=await readRun(runsRoot(deps.home),input.runId)
    if(saved.repo!==input.repo||saved.issue!==input.issue||input.attemptId&&saved.attemptId!==input.attemptId)throw Error('durable capture run identity differs')
    try {
      const {registeredCaptureContext,captureTerminalRun}=await import('./stats/record.ts')
      const context=await registeredCaptureContext(deps.home,saved.repo,saved.checkout)
      return context ? await captureTerminalRun(deps.home,saved.runId,context.destination,context.policy) : null
    } catch { return null } // The durable run retains its pending capture; task success is independent.
  }
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
    outcome: input.terminationCause && input.terminationCause !== 'succeeded' || input.exitCode !== 0 ? ('failed' as const) : undefined,
  }
  let record: StatsRecord
  try {
    record = input.harness === 'claude'
      ? fromClaudeHeadless(claudeHeadlessResult(input.stdout), context)
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
  node_id?: string
  pull_request?: unknown
  number: number
  title: string
  labels?: { name: string }[]
  assignees?: { login: string }[]
  updated_at?: string
}

function toBoardIssue(row: SearchIssue): BoardIssue {
  return {
    number: row.number,
    nodeId: row.node_id,
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
  issueBody: (repo: string, issue: number, options?: GhOptions) => Promise<string>
  gh: (args: string[], options?: GhOptions) => Promise<string>
  now: () => Date
  shipGuard: (repoPath: string, harness: Harness, policy?: { home: string; repo: string; policyDigest?: string }) => Promise<{ wired: boolean; detail: string; policyDigest?: string | null }>
  ensureWorktree: (repoPath: string, issue: number, title: string) => Promise<WorktreeTarget>
  execute: (run: PlannedRun, plan: LaunchPlan, config: FactoryConfig, options: { operator: string | null; onSpawn?: () => void; onWait?: () => void; signal?: AbortSignal; sharedClaim?: SharedClaim }) => Promise<RunOutcome>
  // Which parents could run their children at the same time. Reading a plan's independent groups
  // means running dev-plan's plan-lint, the one parser of that grammar, so it lives behind this
  // dependency rather than in a second copy here.
  parentCandidates: (repo: string, repoPath: string, ready: BoardIssue[], operators: string[]) => Promise<ParentCandidate[]>
  tracker: RunTracker
  processDeps?:Pick<ExecuteDeps,'wrapperPath'>
  quotaRecovery?: import('./runs.ts').QuotaRecoveryController
  harnessMetadata: (plan: LaunchPlan) => HarnessMetadata | Promise<HarnessMetadata>
  // #138 supplies fresh authority locators and the durable wrapper; missing adapters refuse.
  sharedAdmission?: (input: { run: PlannedRun; entry: RepoEntry; policy: RepoPolicy; approvalBindings: NonNullable<RunReport['approvalBindings']>; bindings: NonNullable<RunReport['bindings']>;recordBinding?:{approvalId:string;commentId:number;bodySha256:string}|null }) => Promise<{ machine: EffectiveMachine; session: MachineSession; candidate: VerifiedCandidate; operationId: string }>
  executeShared?: TickDeps['execute']
  persistSharedRun?: (claim: SharedClaim, run: PlannedRun, plan: LaunchPlan) => Promise<void>
  finishSharedRun?: (claim: SharedClaim, outcome: RunOutcome | null) => Promise<TaskTransition>
}

async function ghJsonVia<T>(gh: TickDeps['gh'], args: string[], budget?: ReadBudget): Promise<T> {
  return boundedGhJson<T>(gh, args, budget)
}

export async function fetchBoard(gh: TickDeps['gh'], repo: string, budget?: ReadBudget): Promise<PagedResult<BoardIssue>> {
  const snapshot = await fetchGhPages<SearchIssue>(gh, `repos/${repo}/issues?state=open`, budget)
  const items: BoardIssue[] = []
  let reason = snapshot.reason
  // Enumerate first: the REST issue collection also contains PRs, which still consume pages.
  for (const row of snapshot.items) {
    if (row.pull_request) continue
    if (!Number.isSafeInteger(row.number) || row.number <= 0 || typeof row.title !== 'string' ||
        !Array.isArray(row.labels) || row.labels.some(label => !label || typeof label.name !== 'string') ||
        !Array.isArray(row.assignees) || row.assignees.some(person => !person || typeof person.login !== 'string')) {
      reason ??= 'GitHub returned an unreadable issue row'
      continue
    }
    items.push(toBoardIssue(row))
  }
  return { items, complete: reason === null, reason, observedAt: snapshot.observedAt }
}

// Reactions cost one call per comment, so only comments that actually carry a rocket are followed
// up, and a comment whose rocket count is already covered by the handled list is not read again:
// the count in the comment row is what says whether a reaction this tick has not seen exists.
export async function fetchRockets(gh: TickDeps['gh'], repo: string, corrections: BoardIssue[], handled: HandledRun[] = [], budget = readBudget()): Promise<Rocket[]> {
  const rockets: Rocket[] = []
  const handledByComment = new Map<string, number>()
  for (const entry of handled) {
    if (entry.repo !== repo || entry.commentId === null || entry.reactionId === null) continue
    const key = `${entry.issue}#${entry.commentId}`
    handledByComment.set(key, (handledByComment.get(key) ?? 0) + 1)
  }
  for (const issue of corrections) {
    const comments = await ghJsonVia<{ id: number; reactions?: { rocket?: number } }[]>(
      gh, ['api', `repos/${repo}/issues/${issue.number}/comments`, '--paginate'], budget,
    )
    for (const comment of comments) {
      if (!comment.reactions?.rocket) continue
      if ((handledByComment.get(`${issue.number}#${comment.id}`) ?? 0) >= comment.reactions.rocket) continue
      const reactions = await ghJsonVia<{ id: number; content: string; user?: { login: string } }[]>(
        gh, ['api', `repos/${repo}/issues/comments/${comment.id}/reactions`, '--paginate'], budget,
      )
      for (const reaction of reactions) {
        if (reaction.content !== 'rocket') continue
        rockets.push({ issue: issue.number, commentId: comment.id, reactionId: reaction.id, login: reaction.user?.login ?? '' })
      }
    }
  }
  return rockets
}

export interface LockState { held: boolean; pid: number | null; reason?: string; token?: string }

export function repoLockPath(config: FactoryConfig, repo: string): string {
  return join(config.lockRoot, `${createHash('sha256').update(`github.com/${repo.toLowerCase()}`).digest('hex')}.lock`)
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

// Compatibility readers expose refusals as held. Tokens, never PID equality, prove ownership.
export async function readLock(path: string): Promise<LockState> {
  const value = await inspectClaim(path)
  return { held: value.kind === 'held' || value.kind === 'refused', pid: value.pid,
    ...(value.reason ? { reason: value.reason } : {}) }
}
const ownedLocks = new Map<string, Claim>()
export async function holdLock(path: string, pid: number): Promise<Claim> {
  if (pid !== process.pid) throw new Error('only this process may acquire its claim')
  const result = await acquireClaim(path, await processIdentity())
  if (result.kind !== 'owned') throw new Error(result.reason)
  ownedLocks.set(path, result.claim)
  return result.claim
}
export async function releaseLock(path: string, expected?: Claim): Promise<void> {
  const claim = expected ?? ownedLocks.get(path)
  if (!claim) return
  await releaseClaim(claim)
  if (ownedLocks.get(path)?.token === claim.token) ownedLocks.delete(path)
}

// The worktree the run will happen in. Creating it is the packaged script's job — the CLI is a
// caller here, exactly as `vegafactory worktree` is, so one removal and creation rule exists.
export function defaultEnsureWorktree(repoPath: string, issue: number, title: string): Promise<WorktreeTarget> {
  const inventory = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, encoding: 'utf8' })
  if (inventory.status !== 0) throw Error('worktree inventory unavailable')
  const matches = inventory.stdout.split('\n\n').map(block => ({ path: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] }))
    .filter(row => row.path && row.branch && new RegExp(`(?:^|/)${issue}-`).test(row.branch))
  if (matches.length > 1) throw Error('multiple worktrees match repository and issue; takeover requires reconciliation')
  if (matches.length === 1) {
    const row=matches[0]!, inferred=worktreeFor(repoPath,issue,title)
    const dirty=spawnSync('git',['status','--porcelain'],{cwd:row.path!,encoding:'utf8'})
    if(dirty.status!==0||dirty.stdout.trim())throw Error('existing checkout has user edits; verified takeover handover required')
    return Promise.resolve({...inferred,path:row.path!,branch:row.branch!,slug:row.branch!.replace(new RegExp(`^.*?${issue}-`),'')})
  }
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
  budget = readBudget(),
): Promise<ParentCandidate[]> {
  if (ready.length < 2 || operators.length === 0) return []
  const script = process.env.VSK_PLAN_LINT_SCRIPT
    || join(dirname(dirname(fileURLToPath(import.meta.url))), 'skill', 'dev-plan', 'scripts', 'plan-lint.mjs')
  if (!existsSync(script)) return []
  const byParent = new Map<number, ReadyChild[]>()
  for (const child of ready) {
    const view = await ghJsonVia<{ parent?: { number?: number } }>(gh, ['issue', 'view', String(child.number), '--repo', repo, '--json', 'parent'], budget)
    const parent = view.parent?.number ?? null
    if (parent === null) continue
    const list = byParent.get(parent) ?? []
    list.push({ number: child.number, parent, assignee: child.assignees[0] ?? null, labels: child.labels })
    byParent.set(parent, list)
  }
  const candidates: ParentCandidate[] = []
  for (const [parent, children] of byParent) {
    if (children.length < 2) continue
    const comments = await ghJsonVia<Array<{ body: string; user?: { login?: string } }>>(gh, ['api', `repos/${repo}/issues/${parent}/comments`, '--paginate'], budget)
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
    const parentTitle = (await ghJsonVia<{ title?: string }>(gh, ['issue', 'view', String(parent), '--repo', repo, '--json', 'title'], budget)).title ?? ''
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
  remoteEffectCoverage: NonNullable<LaunchPlan['remoteEffectCoverage']>
  waitReason?: 'subscription-quota' | null
  approvalIds?: string[]
  approvalBindings?: Array<{ approvalId: string; commentId: number; bodySha256: string }>
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
  options: { dryRun: boolean; signal?: AbortSignal },
  deps?: Partial<TickDeps>,
): Promise<TickResult> {
  const gh = deps?.gh ?? ((args: string[], ghOptions?: GhOptions) => ghText(args, ghOptions))
  const now = deps?.now ?? (() => new Date())
  const shipGuard = deps?.shipGuard ?? shipGuardWired
  const suppliedExecutor=!!(deps?.execute||deps?.executeShared)
  if (config.executionMode === 'shared') deps = { ...sharedRunAdapters(config,deps?.processDeps), ...deps }
  if(!options.dryRun) { const {readRuns}=await import('./runs.ts');const {flushRunCheckpoint}=await import('./checkpoints.ts');for(const record of await readRuns(runsRoot(config.home))){if(record.checkpointIntent)try{await flushRunCheckpoint(record,config)}catch{/* Preserve current local source and its durable pending intent. */}if(record.handbackIntent)try{await flushRunHandback(record,config)}catch{/* The stable pending marker remains private and retryable. */}} }

  const ensure = deps?.ensureWorktree ?? defaultEnsureWorktree
  const execute = deps?.execute ?? (async(run, plan, cfg, opts) => executeApprovedRun(run, plan, cfg, opts,plan.approvedRunInput?.runId?{...deps?.processDeps,preparedRun:await readRun(runsRoot(cfg.home),plan.approvedRunInput.runId),runInput:plan.approvedRunInput}:deps?.processDeps))
  const tracker = deps?.tracker ?? processTracker

  let state = await withinRead(readBudget(options.signal), () => readState(config.stateFile))
  const runs: RunReport[] = []
  const refusals: Refusal[] = []
  if(!options.dryRun&&!suppliedExecutor)await scheduleSavedQuotaRuns(config,options,tracker,runs,refusals)

  for (const entry of config.repos) {
    const budget = readBudget(options.signal)
    const active = (issue: number | null = null): boolean => {
      try { assertReadActive(budget); return true }
      catch (error) { refusals.push({ repo: entry.repo, issue, reason: (error as Error).message }); return false }
    }
    if (!active()) break
    let devMd: string | null
    try { devMd = await withinRead(budget, () => readIfPresent(join(entry.path, '.vegastack', 'dev.md'))) }
    catch (error) { refusals.push({ repo: entry.repo, issue: null, reason: (error as Error).message }); continue }
    if (devMd === null) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: no .vegastack/dev.md at ${entry.path} — the dispatcher reads its policy from the repo, and an absent profile is off` })
      continue
    }
    const settingsPath = config.settingsPath ?? factoryConfigPath(config.home)
    if (parseControlRoomKnob(devMd)) {
      try {
        const settings = await readSettingsFile(settingsPath)
        const target = resolveTarget({ devMdText: devMd, config: settings, home: config.home, settingsPath, repoPath: entry.path })
        if (target) await syncControlRoom({ target, config: settings, now: now().getTime() })
      } catch { /* The canonical reader below keeps missing/stale authority fail closed. */ }
    }
    const resolved = loadConfiguredPolicy({ home: config.home, repo: entry.repo, devMd, settingsPath, now: now().toISOString() })
    if (config.executionMode === 'shared' && (!deps?.sharedAdmission || !deps.persistSharedRun || !deps.finishSharedRun || !deps.executeShared)) {
      refusals.push({ repo: entry.repo, issue: null, reason: resolved.ok ? 'shared machine requires verified candidate, shared ownership and durable run adapters; legacy local locks cannot authorize launch' : resolved.blocks.join('; ') })
      continue
    }
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
    // A new hashed key cannot silently bypass the PID-only predecessor pathname.
    try {
      await lstat(join(config.lockRoot, `${entry.repo.replace('/', '-')}.lock`))
      refusals.push({ repo: entry.repo, issue: null, reason: 'legacy repository claim preserved; stop all dispatchers and reconcile its exact owner before migration' })
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { refusals.push({ repo: entry.repo, issue: null, reason: 'legacy claim cannot be inspected; ownership unavailable' }); continue }
    }
    const protectedRuns=(await (await import('./runs.ts')).readRuns(runsRoot(config.home))).filter(r=>r.repo===entry.repo&&(r.terminationCause==='termination-unconfirmed'||['prepared','running','interrupted'].includes(r.state)&&r.processIdentity&&!tracker.has(`${r.repo}#${r.issue}`)))
    if(protectedRuns.length){refusals.push({repo:entry.repo,issue:null,reason:'owned execution termination is unconfirmed; repository protection retained'});continue}
    const inFlight = inFlightIssues(tracker, entry.repo)
    // This process holds the repo lock for as long as it has a run in flight there; its own lock is
    // not "another run", and maxRuns against the in-flight count is what bounds it.
    const lock = await readLock(lockPath)
    const guards: GuardState = {
      shipGuard: await withinRead(budget, () => shipGuard(entry.path, harness, { home: config.home, repo: entry.repo, policyDigest: resolved.policy?.policyDigest })).catch(error => ({ wired: false, detail: (error as Error).message })),
      lock: lock.held && (await inspectClaim(lockPath)).token === ownedLocks.get(lockPath)?.token && ownedLocks.has(lockPath) ? { held: false, pid: null } : lock,
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
    let board: { needsPlan: BoardIssue[]; ready: BoardIssue[]; corrections: BoardIssue[] }
    let rockets: Rocket[]
    try {
      const snapshot = await fetchBoard(gh, entry.repo, budget)
      if (!snapshot.complete) throw new GhUnavailable(snapshot.reason!)
      const map = policy.labelMap ?? defaultMap
      board = { needsPlan: snapshot.items.filter(row => row.labels.includes(map.needsPlan)), ready: snapshot.items.filter(row => row.labels.includes(map.ready)), corrections: snapshot.items.filter(row => row.labels.includes(map.forOperator)) }
      rockets = await fetchRockets(gh, entry.repo, board.corrections, state.handled, budget)
    } catch (error) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: the board could not be read — ${(error as Error).message}` })
      continue
    }

    let parents: ParentCandidate[] = []
    try {
      parents = deps?.parentCandidates ? await withinRead(budget, () => deps.parentCandidates!(entry.repo, entry.path, board.ready, policy.operators)) : await defaultParentCandidates(gh, entry.repo, entry.path, board.ready, policy.operators, budget)
    } catch (error) {
      refusals.push({ repo: entry.repo, issue: null, reason: `${entry.repo}: the parents' independent groups could not be read; repository dispatch refused — ${(error as Error).message}` })
      continue
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
        known = await shipGuard(entry.path, stageHarness, { home: config.home, repo: entry.repo, policyDigest: resolved.policy?.policyDigest })
        wiredInCheckout.set(stageHarness, known)
      }
      return known
    }

    for (const run of plan.runs) {
      if (!active(run.issue)) break
      if (run.parallel?.length) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: 'parallel child execution requires the checked child gateway; preparation-only launch descriptions do not qualify' })
        continue
      }
      let stage: ReturnType<typeof stagePolicy>
      try {
        stage = stagePolicy(policy, run.stage)
      } catch (error) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: ${(error as Error).message}` })
        continue
      }
      const checkoutGuard = await withinRead(budget, () => guardFor(stage.harness)).catch(error => ({ wired: false, detail: (error as Error).message }))
      if (!checkoutGuard.wired) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue} would run on ${stage.harness}, and the ship guard is not wired for it: ${checkoutGuard.detail} — dark builds run under bypass, and the guard is what bounds them` })
        continue
      }
      // Re-read complete live scope immediately before any worktree or harness
      // effect. The packaged dev-implement parser owns both approval and native
      // prerequisite semantics; a board label or rocket is only a start signal.
      const authorityReads:unknown[]=[]
      let admission: { recordBinding?:{approvalId:string;commentId:number;bodySha256:string}|null;blocks: string[]; approvalIds: string[]; approvalBindings: NonNullable<RunReport['approvalBindings']>; bindings: NonNullable<RunReport['bindings']> } = { blocks: [], approvalIds: [], approvalBindings: [], bindings: [] }
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
          }, { readJson: async(args: string[]) => {const value=await ghJsonVia(gh,args,budget);authorityReads.push(value);return value}, devMd, configuredPolicy: resolved }))
        }
        const recordBindings=results.flatMap(result=>result.recordBinding?[result.recordBinding]:[])
        if(new Set(recordBindings.map(value=>JSON.stringify(value))).size>1)throw Error('selected records have ambiguous relay provenance')
        admission = { recordBinding:recordBindings[0]??null,blocks: results.flatMap(result => result.blocks),
          approvalIds: [...new Set<string>(results.flatMap(result => result.approvalIds))],
          approvalBindings: results.flatMap(result => result.approvalBindings),
          bindings: results.flatMap(result => result.bindings) }
        if (admission.blocks.length) throw new Error(admission.blocks.join('; '))
      } catch (error) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: launch preflight refused — ${(error as Error).message}` })
        continue
      }
      if(!options.dryRun){
        const {reconcileRuns}=await import('./runs.ts')
        const existing=(await reconcileRuns(runsRoot(config.home))).filter(r=>r.repo===run.repo&&r.issue===run.issue&&(r.state==='running'||r.state==='interrupted'||r.state==='prepared'&&(r.pid!==null||existsSync(join(runsRoot(config.home),r.runId,'events.jsonl'))||existsSync(join(runsRoot(config.home),r.runId,'handshake.json')))))
        if(existing.length){refusals.push({repo:run.repo,issue:run.issue,reason:'saved unfinished execution requires verified recovery; duplicate launch refused'});continue}
      }
      if(!options.dryRun&&!suppliedExecutor){
        const previous=(await(await import('./runs.ts')).readRuns(runsRoot(config.home))).find(r=>r.repo===run.repo&&r.issue===run.issue&&r.state==='terminal'&&canonicalWire(r.approvalRefs)===canonicalWire(admission.bindings)&&canonicalWire(r.dispatchRequest??{commentId:null,reactionId:null})===canonicalWire({commentId:run.commentId,reactionId:run.reactionId}))
        if(previous){refusals.push({repo:run.repo,issue:run.issue,reason:'recorded execution requires acceptance or verified recovery; completed work is not replayed'});continue}
      }
      let issueOutcome: string
      try {
        const body = await withinRead(budget, async signal => {
          if (deps?.issueBody) return deps.issueBody(entry.repo, run.issue, { signal, timeoutMs: Math.min(10_000, budget.deadline - Date.now()) })
          const value = await ghJsonVia<{ body?: unknown }>(gh, ['issue', 'view', String(run.issue), '--repo', entry.repo, '--json', 'body'], { ...budget, signal })
          if (typeof value.body !== 'string') throw new GhUnavailable('GitHub returned an unreadable issue body')
          return value.body
        })
        issueOutcome = outcomeOf(body) || run.title
      } catch (error) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `issue body unavailable: ${(error as Error).message}` })
        continue
      }
      if (!active(run.issue)) break
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
      if (!active(run.issue)) break
      // The harness reads its hook config from the directory it is started in, and that is the
      // worktree — a fresh checkout of tracked files, where a gitignored .claude/ or .codex/ does
      // not exist. So the wiring is verified again where the run will actually happen; a dry run
      // checks a worktree that already exists and says nothing about one it would create.
      if (!options.dryRun || existsSync(target.path)) {
        try { target.path = realpathSync(target.path) }
        catch { refusals.push({ repo: entry.repo, issue: run.issue, reason: 'prepared checkout could not be canonicalized' }); continue }
        const worktreeGuard = await withinRead(budget, () => shipGuard(target.path, stage.harness, { home: config.home, repo: entry.repo, policyDigest: resolved.policy?.policyDigest })).catch(error => ({ wired: false, detail: (error as Error).message }))
        if (!worktreeGuard.wired) {
          refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: the ship guard is not wired for ${stage.harness} in the worktree ${target.path} (${worktreeGuard.detail}) — the run would start there under bypass with nothing bounding it; commit the harness wiring or list it in dev.md's worktree-include:` })
          continue
        }
      }
      if (!active(run.issue)) break
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
            outcome: issueOutcome,
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
        remoteEffectCoverage: launch.remoteEffectCoverage ?? { kind: 'unmanaged-possible', reasonCode: 'hook-configuration-only' },
        approvalChecked: !options.dryRun,
        approvalIds: admission.approvalIds,
        approvalBindings: admission.approvalBindings,
        bindings: admission.bindings,
      }
      if (options.dryRun) {
        runs.push(report)
        continue
      }
      const metadata = await withinRead(budget, async () => (deps?.harnessMetadata ?? inspectManagedHarness)(launch)).catch(error => ({ version: 'unavailable', problems: [(error as Error).message] }))
      if (!active(run.issue)) break
      const controls = validateManagedLaunch(launch, metadata)
      if (!controls.ok) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: managed launch refused: ${controls.problems.join('; ')}` })
        continue
      }
      const beforeSpawn = await withinRead(budget, () => shipGuard(target.path, stage.harness, { home: config.home, repo: entry.repo, policyDigest: resolved.policy?.policyDigest })).catch(error => ({ wired: false, detail: (error as Error).message, policyDigest: null }))
      if (!beforeSpawn.wired) {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: `#${run.issue}: final prepared-checkout check refused: ${beforeSpawn.detail}` })
        continue
      }
      if (!active(run.issue)) break
      if (beforeSpawn.policyDigest) launch.guardPolicyDigest = beforeSpawn.policyDigest
      // The run is started here and finished elsewhere: the tick moves on to the next run and the
      // next repo, and the loop keeps its interval, however long this run takes. The repo lock is
      // held from the first run in flight to the last one out, and the report the tick returns is
      // completed in place when the run ends — `--once` waits for that, the watch loop does not.
      const acquiredLock = inFlightIssues(tracker, entry.repo).length === 0
      let ownedClaim = ownedLocks.get(lockPath)
      if (acquiredLock) {
        try { ownedClaim = await holdLock(lockPath, process.pid) }
        catch (error) { refusals.push({ repo: entry.repo, issue: run.issue, reason: (error as Error).message }); continue }
      }
      if (!active(run.issue)) { if (acquiredLock) await releaseLock(lockPath, ownedClaim); break }
      if(!suppliedExecutor){
        try{const prepared=await prepareDispatchRun({run,plan:launch,config,policy,approvalBindings:admission.approvalBindings,bindings:admission.bindings,recordBinding:admission.recordBinding,authorityReads,gh,metadata,claim:ownedClaim??ownedLocks.get(lockPath)!});launch.approvedRunInput={...prepared,root:runsRoot(config.home)} }
        catch(error){refusals.push({repo:run.repo,issue:run.issue,reason:(error as Error).message});if(acquiredLock)await releaseLock(lockPath,ownedClaim);continue}
      }
      let sharedClaim: SharedClaim | undefined
      if (config.executionMode === 'shared') {
        try {
          const input = await deps!.sharedAdmission!({ run, entry, policy, approvalBindings: admission.approvalBindings, bindings: admission.bindings,recordBinding:admission.recordBinding })
          const shared = await acquireSharedTask(input)
          if (shared.kind !== 'owned') throw new Error(shared.reason)
          sharedClaim = shared.claim
          const sharedSnapshot=await(await import('./shared-claims.ts')).readCoordination(sharedClaim.target)
          if(sharedSnapshot.machines[input.machine.id]?.bootIdDigest!==input.session.bootIdDigest)throw Error('acquired machine boot requires verified recovery')
          // The native gate is unchanged and repeated after shared acquisition. No stale
          // search, claim, or coordinator-only source instruction authorizes this launch.
          const script = process.env.VSK_PREFLIGHT_SCRIPT || join(dirname(dirname(fileURLToPath(import.meta.url))), 'skill', 'dev-implement', 'scripts', 'preflight.mjs')
          const owner = await import(pathToFileURL(script).href)
          const fresh = await owner.gatherAndEvaluate({ repo: entry.repo, issue: String(run.issue), stage: run.stage === 'plan' ? 'plan' : 'implement', expect: run.stage === 'plan' ? 'needs-plan' : run.stage === 'corrections' ? 'for-operator' : 'ready' }, { readJson: (args: string[]) => ghJsonVia(gh, args, budget), devMd, configuredPolicy: loadConfiguredPolicy({ home: config.home, repo: entry.repo, devMd, settingsPath, now: now().toISOString() }) })
          if (fresh.blocks.length || canonicalWire(fresh.approvalBindings) !== canonicalWire(admission.approvalBindings) || canonicalWire(fresh.bindings) !== canonicalWire(admission.bindings)||canonicalWire(fresh.recordBinding??null)!==canonicalWire(admission.recordBinding??null)) throw new Error('approval changed after shared acquisition')
          if (!active(run.issue)) throw new Error('shared launch cancelled before durable preparation')
          await deps!.persistSharedRun!(sharedClaim, run, launch)
          const preparedRun=!suppliedExecutor?await readRun(runsRoot(config.home),sharedClaim.runId):null
          const beforeStart=await(await import('./shared-claims.ts')).readCoordination(sharedClaim.target)
          if(beforeStart.tasks[sharedClaim.taskKey]?.state==='claimed'){const started = await transitionSharedTask({ claim: sharedClaim, operationId: preparedRun?.attemptOperationIds?.start??crypto.randomUUID(), transition: { kind: 'start' } });if(started.kind!=='owned')throw Error(started.reason);sharedClaim=started.claim}else if(beforeStart.tasks[sharedClaim.taskKey]?.state!=='running')throw Error('shared start requires verified recovery')
        } catch (error) {
          // Unknown termination/effects retain the shared reservation. Recovery owns it.
          refusals.push({ repo: entry.repo, issue: run.issue, reason: `shared admission refused: ${(error as Error).message}` })
          if (acquiredLock) await releaseLock(lockPath, ownedClaim)
          continue
        }
      }
      const key = `${entry.repo}#${run.issue}`
      const runStage = stage
      const runTarget = target
      const runParent = parentOf
      let resolveStart!: (started: boolean) => void
      const startAcknowledged = new Promise<boolean>(resolve => { resolveStart = resolve })
      let acknowledged = false
      const onSpawn = (): void => { acknowledged = true;report.launched=true;report.waitReason=null;resolveStart(true) }
      const onWait = ():void => {report.waitReason='subscription-quota';resolveStart(false)}
      let sharedOutcome: RunOutcome | null = null
      const done = (async () => {
        try {
          const outcome = await (sharedClaim ? deps!.executeShared! : execute)(run, launch, config, { operator: policy.operators[0] ?? null, onSpawn, onWait, signal: options.signal, sharedClaim })
          sharedOutcome = outcome
          if (outcome.started === false || outcome.refusal) {
            refusals.push({ repo: entry.repo, issue: run.issue, reason: outcome.refusal ?? 'harness did not start' })
            resolveStart(false)
            return
          }
          if (!acknowledged && outcome.started === true) onSpawn()
          if (!acknowledged) {
            refusals.push({ repo: entry.repo, issue: run.issue, reason: 'executor supplied no actual-spawn acknowledgement' })
            resolveStart(false)
            return
          }
          report.exitCode = outcome.exitCode
          report.logFile = outcome.logFile
          const written = await recordRun({
            runId:outcome.runId,attemptId:outcome.attemptId,
            harness: runStage.harness,
            stdout: outcome.stdout ?? '',
            exitCode: outcome.exitCode ?? 1,
            terminationCause: outcome.terminationCause,
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
          // A preparation/metadata failure is not a launch and must not consume corrections.
          if (!acknowledged) {
            refusals.push({ repo: entry.repo, issue: run.issue, reason: `launch refused before spawn: ${(error as Error).message}` })
            resolveStart(false)
          }
          report.exitCode = null
          process.stderr.write(`run on ${key} failed outside the harness: ${(error as Error).message}\n`)
        } finally {
          resolveStart(false)
          tracker.delete(key)
          if (sharedClaim) {
            try {
              const transition = await deps!.finishSharedRun!(sharedClaim, sharedOutcome)
              const finalRun=sharedOutcome?.runId?await readRun(runsRoot(config.home),sharedOutcome.runId):null
              const result = await transitionSharedTask({ claim: sharedClaim, operationId: transition.kind==='stop'?finalRun?.stopReceiptIds?.transition??crypto.randomUUID():crypto.randomUUID(), transition })
              if (result.kind !== 'owned') throw new Error(result.reason)
            } catch (error) { refusals.push({ repo: entry.repo, issue: run.issue, reason: `shared reservation retained: ${(error as Error).message}` }) }
          }
          if (inFlightIssues(tracker, entry.repo).length === 0&&sharedOutcome?.terminationCause!=='termination-unconfirmed') await releaseLock(lockPath, ownedClaim)
        }
      })()
      tracker.set(key, { repo: entry.repo, issue: run.issue, done })
      report.launched = await startAcknowledged
      if (!report.launched) {if(report.waitReason){runs.push(report);continue}await done;continue}
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

// HTTP Retry-After/reset is honored inside the canonical GitHub read adapter. Between
// discovery ticks, network refusals back off and each machine spreads its polling independently.
export function discoveryDelayMs(interval: number, networkFailures: number, random = Math.random()): number {
  const normal = interval * 1000
  const delay = Math.max(normal, Math.min(300000, normal * 2 ** Math.min(5, Math.max(0, networkFailures))))
  return delay + Math.floor(Math.max(0, Math.min(1, random)) * Math.min(normal / 10, 30000))
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
  const dispatcherClaim = await holdLock(config.dispatcherLock, process.pid)
  let stopping = false
  let networkFailures = 0
  const controller = new AbortController()
  const stop = (): void => { stopping = true; controller.abort() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    for (let tick = 0; !stopping && (options.ticks === undefined || tick < options.ticks); tick += 1) {
      const result = await runTick(config, { dryRun: options.dryRun, signal: controller.signal }, deps).catch((error: Error) => ({
        ok: false,
        dryRun: options.dryRun,
        runs: [],
        refusals: [{ repo: '*', issue: null, reason: `the tick failed: ${error.message}` }],
      } satisfies TickResult))
      options.onTick?.(result)
      networkFailures = result.refusals.some(row => /GitHub|fetch failed|network|HTTP (?:429|5\d\d)/i.test(row.reason)) ? networkFailures + 1 : 0
      if (stopping) break
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, discoveryDelayMs(config.interval, networkFailures))
        controller.signal.addEventListener('abort', done, { once: true })
        if (controller.signal.aborted) done()
      })
    }
  } finally {
    try { await settleRuns(deps?.tracker ?? processTracker) }
    finally {
      try { await releaseLock(config.dispatcherLock, dispatcherClaim) }
      finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    }
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
const defaultStatsGit: GitRunner = async (args,cwd,options) => (await import('./stats/push.ts')).boundedTelemetryGit(GIT_CREDENTIAL_ARGS)(args,cwd,options)

// Production shared adapters consume the configured immutable policy. Missing qualification
// remains a refusal before acquisition; controlled transaction fixtures do not activate a fleet.
const sharedAuthorityContexts=new WeakMap<import('./shared-claims.ts').CoordinationTarget,string>()
const sharedRunContexts=new WeakMap<import('./shared-claims.ts').CoordinationTarget,string>()
const sharedTaskContexts=new WeakMap<import('./shared-claims.ts').CoordinationTarget,import('./shared-claims.ts').TaskRecord>()
const sharedMachineContexts=new WeakMap<import('./shared-claims.ts').CoordinationTarget,EffectiveMachine>()
export async function verifiedSharedTarget(repo:string,config:FactoryConfig,runId?:string):Promise<import('./shared-claims.ts').CoordinationTarget>{
  const {resolveMachinePolicy}=await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  const {readHostBinding}=await import('./machine-identity.ts')
  const {githubCoordinationProvider}=await import('./shared-claims.ts')
  const entry=config.repos.find(row=>row.repo===repo);if(!entry)throw Error('repository is not configured')
  const devMd=await readFile(join(entry.path,'.vegastack/dev.md'),'utf8')
  const settingsPath=config.settingsPath??factoryConfigPath(config.home)
  const policy=loadConfiguredPolicy({home:config.home,repo,devMd,settingsPath})
  if(!policy.ok)throw Error('current machine policy unavailable')
  const settings=await readSettingsFile(settingsPath)
  const bootstrap=settings.settings.machine as {id?:string;installationId?:string;group?:string}|undefined
  if(!bootstrap)throw Error('machine registration unavailable')
  const login=JSON.parse(await ghText(['api','user'],{timeoutMs:10_000})) as {login:string}
  const host=await readHostBinding()
  const resolution=resolveMachinePolicy({policy:policy.policy,machineId:bootstrap.id,installationId:bootstrap.installationId,hostBindingDigest:host.digest,executionLogin:login.login})
  if(!resolution.ok||!resolution.machine?.allowedRepositories.includes(repo)||resolution.machine.group!==bootstrap.group)throw Error('machine identity or repository scope refused')
  const machine=resolution.machine as EffectiveMachine
  const target:import('./shared-claims.ts').CoordinationTarget={host:'github.com',...machine.coordination,localRoot:join(config.home,'.vegastack','coordination'),provider:githubCoordinationProvider(),
    verifyCandidate:async(candidate,current,session)=>{
      if(current.id!==machine.id||current.policyDigest!==machine.policyDigest||session.hostBindingDigest!==host.digest||candidate.repo!==repo||candidate.repositoryNodeId!==machine.repositoryIds[repo])throw Error('shared candidate identity mismatch')
      sharedRunContexts.set(target,candidate.runId)
      const record=await readRun(runsRoot(config.home),candidate.runId)
      if(!record.execution||record.state!=='prepared'||record.pid!==null||existsSync((await import('./runs.ts')).runAttemptDirectory(runsRoot(config.home),record))||canonicalWire(record.approvalBindings)!==canonicalWire(candidate.approvalBindings)||record.taskKey.scopeDigest!==candidate.scopeDigest)throw Error('shared prepared candidate differs')
      if(canonicalWire(await processIdentity())!==canonicalWire(session.identity))throw Error('shared session process identity differs')
      await(await import('./runs.ts')).verifyRunAuthority(record,config,'launch')
      await (await import('./shared-claims.ts')).resolveEvidence(target,record.execution.qualification)
    },
    verifySession:async(previous,current,session)=>{
      if(previous.machineId!==current.id||previous.installationId!==current.installationId||previous.hostBindingDigest!==session.hostBindingDigest)throw Error('machine session identity differs')
      const helpers=await import('./runs.ts'),prior=(await helpers.readRuns(runsRoot(config.home))).filter(r=>r.machine?.sessionId===previous.sessionId)
      if(!prior.length||!(await Promise.all(prior.map(helpers.verifyLocalRunStopped))).every(Boolean))throw Error('previous machine session execution is unconfirmed')
    },
    verifyTransition:async(task,transition)=>{
      if(task.repo!==repo)throw Error('shared transition repository mismatch')
      const helpers=await import('./runs.ts'),run=await helpers.readRun(runsRoot(config.home),task.runId)
      if(run.repo!==task.repo||run.issue!==task.issue||run.taskKey.scopeDigest!==task.scopeDigest||canonicalWire(run.approvalBindings)!==canonicalWire(task.approvalBindings))throw Error('shared transition scope differs')
      if(transition.kind!=='handoff'&&(task.machineId!==machine.id||task.installationId!==machine.installationId||run.machine?.sessionId!==task.sessionId))throw Error('shared transition owner mismatch')
      sharedRunContexts.set(target,run.runId);sharedTaskContexts.set(target,task)
      sharedAuthorityContexts.delete(target)
      await helpers.verifyRunAuthority(run,config)
      sharedAuthorityContexts.set(target,canonicalWire({runId:run.runId,bindings:run.approvalBindings,recordBinding:run.recordBinding}))
      if(transition.kind==='receipt')await helpers.verifyRunEvidencePayload(null,transition.payload,{run,task,publishing:true,verifyAuthority:()=>helpers.verifyRunAuthority(run,config),stopped:()=>helpers.verifyLocalRunStopped(run)})
      if(transition.kind==='start'&&(run.state!=='prepared'||!run.execution||!run.runtimeBinding))throw Error('shared durable preparation unavailable')
      if((transition.kind==='stop'||transition.kind==='complete'||transition.kind==='handoff'||transition.kind==='block')&&transition.stopProof)await helpers.verifySharedStopProof(transition.stopProof,task,target,run)
      if(transition.kind==='handoff'&&(!transition.recovery.checkpoint||transition.machine.id!==machine.id))throw Error('verified recovery target unavailable')
    },
    verifyEvidence:async(ref,payload)=>{
      const helpers=await import('./runs.ts')
      let runId=sharedRunContexts.get(target)
      if(!runId&&payload&&'runId'in payload)runId=payload.runId
      if(!runId)throw Error('evidence lacks a bound run context')
      const run=await helpers.readRun(runsRoot(config.home),runId)
      await helpers.verifyRunEvidencePayload(ref,payload,{run,task:sharedTaskContexts.get(target),verifyAuthority:async()=>{if(sharedAuthorityContexts.get(target)!==canonicalWire({runId:run.runId,bindings:run.approvalBindings,recordBinding:run.recordBinding}))await helpers.verifyRunAuthority(run,config)}})
    },
  }
  sharedMachineContexts.set(target,machine)
  if(runId)sharedRunContexts.set(target,runId)
  return target
}
export function sharedRunAdapters(config:FactoryConfig,processDeps?:Pick<ExecuteDeps,'wrapperPath'>):Pick<TickDeps,'sharedAdmission'|'persistSharedRun'|'executeShared'|'finishSharedRun'>{
  return{
    sharedAdmission:async input=>{
      const target=await verifiedSharedTarget(input.entry.repo,config)
      const helpers=await import('./runs.ts')
      const coordination=await import('./shared-claims.ts'),{readRuns}=await import('./runs.ts'),{readBootIdentityDigest}=await import('./machine-identity.ts')
      const stage=stagePolicy(input.policy,input.run.stage),machine=sharedMachineContexts.get(target)!
      const records=(await readRuns(runsRoot(config.home))).filter(r=>r.repo===input.run.repo&&r.issue===input.run.issue&&r.state==='prepared'&&r.execution&&r.harness===stage.harness&&r.model===stage.model&&r.effort===stage.effort&&canonicalWire(r.approvalBindings.map(a=>({approvalId:a.approvalId,commentId:Number(a.source.commentId),bodySha256:a.source.bodySha256})))===canonicalWire(input.approvalBindings)&&canonicalWire(r.recordBinding?{approvalId:r.recordBinding.approvalId,commentId:Number(r.recordBinding.source.commentId),bodySha256:r.recordBinding.source.bodySha256}:null)===canonicalWire(input.recordBinding??null)&&canonicalWire(r.approvalRefs)===canonicalWire(input.bindings))
      if(records.length!==1)throw Error('unique qualified subscription run preparation unavailable; shared acquisition deferred')
      const record=records[0]!,authorities=record.approvalBindings
      await helpers.verifyRunAuthority(record,config,'launch')
      sharedRunContexts.set(target,record.runId)
      await coordination.resolveEvidence(target,record.execution!.qualification)
      if(!record.machine||record.machine.id!==machine.id||record.machine.installationId!==machine.installationId||record.machine.hostBindingDigest!==machine.hostBindingDigest)throw Error('prepared machine identity differs')
      const subject=await boundedGhJson(ghText,['api',`repos/${input.run.repo}/issues/${input.run.issue}`],readBudget()) as {node_id:string}
      const session:MachineSession={target,localRoot:target.localRoot,machineId:machine.id,installationId:machine.installationId,sessionId:record.machine.sessionId,hostBindingDigest:machine.hostBindingDigest,bootIdDigest:await readBootIdentityDigest(),identity:await processIdentity()}
      const candidate:VerifiedCandidate={host:target.host,repo:record.repo,issue:record.issue,repositoryNodeId:machine.repositoryIds[record.repo]!,issueNodeId:subject.node_id,scopeDigest:record.taskKey.scopeDigest,approvalDigest:createHash('sha256').update(coordination.canonical(authorities)).digest('hex'),approvalBindings:authorities,runId:record.runId,stage:record.stage,paths:[],resources:[],independent:false,parentTaskKey:null,approvedTaskIds:record.approvedTaskIds??[record.taskKey.taskId]}
      if(!record.claimOperationId)throw Error('durable shared acquisition operation identity unavailable')
      return{machine,session,candidate,operationId:record.claimOperationId}
    },
    persistSharedRun:async(claim,planned,plan)=>{
      const existing=await readRun(runsRoot(config.home),claim.runId)
      const input=plan.approvedRunInput??{...existing,root:runsRoot(config.home)}
      if(!input?.execution||!input.approvalBindings.length||input.repo!==planned.repo||input.issue!==planned.issue||input.checkout!==plan.cwd||input.execution.harness!==plan.command||input.root!==runsRoot(config.home))throw Error('verified shared run preparation unavailable')
      const owner=await import('./shared-claims.ts')
      const remote=await owner.readCoordination(claim.target),task=remote.tasks[claim.taskKey]
      if(!task||task.ownerToken!==claim.ownerToken||task.runId!==claim.runId||task.generation!==claim.generation||canonicalWire(task.approvalBindings)!==canonicalWire(input.approvalBindings))throw Error('shared acquisition cannot be reconciled')
      let record:RunRecord
      try{record=await readRun(input.root,claim.runId);if(record.state!=='prepared'||record.sharedClaim&&record.sharedClaim.ownerToken!==claim.ownerToken||canonicalWire(record.execution)!==canonicalWire(input.execution))throw Error('shared run already attempted or differs')}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;record=await createRun({...input,runId:claim.runId,sharedClaim:{taskKey:claim.taskKey,generation:claim.generation,ownerToken:claim.ownerToken,stateCommit:claim.stateCommit}})}
      const recovery:import('./shared-claims.ts').RecoveryEnvelope=task.recovery??{schemaVersion:2,taskKey:claim.taskKey,runId:record.runId,generation:claim.generation,approvalBindings:record.approvalBindings,recordBinding:record.recordBinding,scopeDigest:record.taskKey.scopeDigest,approvalDigest:task.approvalDigest,execution:record.execution!,checkpoint:record.checkpoint,completed:[],children:[],joins:[],effects:[],remoteEffectCoverage:record.remoteEffectCoverage}
      const linked=await owner.transitionSharedTask({claim,operationId:record.attemptOperationIds?.recovery??randomUUID(),transition:{kind:'recovery',recovery}})
      if(linked.kind!=='owned')throw Error('shared envelope acknowledgment unavailable')
      Object.assign(claim,linked.claim)
      await transitionRun(record.runId,record.generation,{sharedClaim:{taskKey:claim.taskKey,generation:claim.generation,ownerToken:claim.ownerToken,stateCommit:claim.stateCommit}},input.root)
    },
    executeShared:async(run,plan,cfg,options)=>{
      const claim=options.sharedClaim;if(!claim)throw Error('shared execution requires a claim')
      const root=runsRoot(cfg.home),record=await readRun(root,claim.runId)
      const owner=await import('./shared-claims.ts'),snapshot=await owner.readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
      if(record.sharedClaim?.ownerToken!==claim.ownerToken||!task?.recovery||task.ownerToken!==claim.ownerToken||task.generation!==claim.generation||task.runId!==record.runId||task.state!=='running'||canonicalWire(task.recovery.execution)!==canonicalWire(record.execution))throw Error('shared envelope or owner acknowledgment unavailable')
      if(!record.execution)throw Error('shared execution identity unavailable')
      await owner.resolveEvidence(claim.target,record.execution.qualification)
      return executeApprovedRun(run,plan,cfg,options,{...processDeps,preparedRun:record,runInput:{...record,root}})
    },
    finishSharedRun:(claim,outcome)=>finishDurableSharedRun(claim,outcome,config),
  }
}

const dispatcherSessionId=randomUUID()
export async function prepareDispatchRun(input:{run:PlannedRun;plan:LaunchPlan;config:FactoryConfig;policy:RepoPolicy;approvalBindings:NonNullable<RunReport['approvalBindings']>;bindings:NonNullable<RunReport['bindings']>;authorityReads:unknown[];recordBinding?:{approvalId:string;commentId:number;bodySha256:string}|null;gh:TickDeps['gh'];metadata:HarnessMetadata;claim:Claim;authorityRequest?:import('./runs.ts').RunAuthorityRequest}):Promise<RunRecord>{
  const {run,plan,config,policy,gh,metadata}=input,helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts')
  const stage=stagePolicy(policy,run.stage),root=runsRoot(config.home)
  if(input.claim.path!==repoLockPath(config,run.repo))throw Error('local run claim targets another repository')
  await(await import('./claims.ts')).renewClaim(input.claim)
  const subscription=await inspectSubscription(plan)
  const records=await helpers.readRuns(root)
  // Qualification is supplied by its owner as an immutable prior/prepared run reference.
  // It is never synthesized from a successful version/auth check.
  const seeds=(await helpers.readQualifiedExecutions(root)).filter(r=>r.execution&&r.runtimeBinding&&r.configurationDigest&&r.execution.harness===stage.harness&&r.execution.model===stage.model&&r.execution.effort===stage.effort&&r.execution.accountRef===subscription.accountRef&&r.execution.harnessVersion===metadata.version)
  let seed:import('./runs.ts').QualifiedExecutionRecord|undefined,coverage:import('./shared-claims.ts').RecoveryEnvelope['remoteEffectCoverage']={kind:'unmanaged-possible',reasonCode:'execution-coverage-unqualified'}
  for(const candidate of seeds){
    try{await helpers.verifyInstalledRuntimeBinding(candidate.runtimeBinding!,dirname(dirname(fileURLToPath(import.meta.url))),fileURLToPath(import.meta.url));if(await helpers.executionConfigurationDigest({binding:candidate.runtimeBinding!,execution:candidate.execution!,plan,metadata})!==candidate.configurationDigest)continue;const target=await verifiedSharedTarget(run.repo,config);const reader={...target,verifyEvidence:async(ref:import('./shared-claims.ts').EvidenceRef,payload:import('./shared-claims.ts').RecoveryEvidencePayload|null)=>{if(owner.canonical(ref)!==owner.canonical(candidate.execution.qualification)||payload===null)throw Error('qualification reference differs');helpers.verifyExecutionQualification(payload,candidate.execution,candidate.runtimeBinding,candidate.configurationDigest)}};const evidence=await owner.resolveEvidence(reader,candidate.execution.qualification);if(evidence?.kind==='execution-qualification'&&evidence.result==='qualified')coverage={kind:'qualified-managed-only',qualification:candidate.execution.qualification};seed=candidate;break}catch{/* A stale/unqualified seed grants no execution. */}
  }
  if(!seed)throw Error('matching qualified subscription/runtime evidence unavailable')
  const readJson=(args:string[])=>boundedGhJson(gh,args,readBudget())
  const authorities=await helpers.bindVerifiedApprovalSources(input.approvalBindings,input.authorityReads,readJson,gh)
  const recordBinding=input.recordBinding?(await helpers.bindVerifiedApprovalSources([input.recordBinding],input.authorityReads,readJson,gh))[0]!:null
  const prepared=records.filter(r=>r.repo===run.repo&&r.issue===run.issue&&r.state==='prepared'&&canonicalWire(r.approvalBindings)===canonicalWire(authorities)&&canonicalWire(r.approvalRefs)===canonicalWire(input.bindings)&&canonicalWire(r.dispatchRequest??{commentId:null,reactionId:null})===canonicalWire({commentId:run.commentId,reactionId:run.reactionId}))
  if(prepared.length>1)throw Error('multiple prepared contexts require reconciliation')
  if(prepared.length===1){const prior=prepared[0]!;if(prior.pid!==null||existsSync(helpers.runAttemptDirectory(root,prior))||prior.checkout!==plan.cwd||canonicalWire(prior.execution)!==canonicalWire(seed.execution)||canonicalWire(prior.recordBinding)!==canonicalWire(recordBinding))throw Error('prepared context changed; verified recovery required');return prior}
  const branch=spawnSync('git',['symbolic-ref','--short','HEAD'],{cwd:plan.cwd,encoding:'utf8'}),head=spawnSync('git',['rev-parse','HEAD'],{cwd:plan.cwd,encoding:'utf8'})
  if(branch.status!==0||head.status!==0||!head.stdout.trim())throw Error('run source identity unavailable')
  const host=(await (await import('./machine-identity.ts')).readHostBinding()).digest
  const target=await verifiedSharedTarget(run.repo,config),machine=sharedMachineContexts.get(target)!
  const selection=await helpers.approvedTaskSelection(input.bindings as import('./shared-claims.ts').ArtifactRef[],input.authorityReads,run.stage,{},input.authorityRequest?.kind==='consolidated'?input.authorityRequest.requested.taskIds:undefined)
  const runInput:RunInput={root,repo:run.repo,issue:run.issue,parent:null,checkout:plan.cwd,branch:branch.stdout.trim(),baseSha:input.authorityRequest?.kind==='consolidated'?input.authorityRequest.requested.baseSha:head.stdout.trim(),headSha:head.stdout.trim(),stage:run.stage,harness:stage.harness,model:stage.model,effort:stage.effort,execution:seed.execution!,runtimeBinding:seed.runtimeBinding,configurationDigest:seed.configurationDigest,approvalBindings:authorities,recordBinding,approvalRefs:input.bindings as import('./shared-claims.ts').ArtifactRef[],policyDigest:policy.effective?.policyDigest??'',claimToken:input.claim.token,startedAt:new Date().toISOString(),taskKey:{repo:run.repo,issue:run.issue,taskId:selection.taskId,scopeDigest:selection.scopeDigest},approvedTaskIds:selection.approvedTaskIds,activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:subscription.accountRef,waitReason:null,hostBindingDigest:host,machine:{id:machine.id,installationId:machine.installationId,sessionId:dispatcherSessionId,hostBindingDigest:host},sharedClaim:null,checkpoint:null,remoteEffectCoverage:coverage,authorityRequest:input.authorityRequest??{kind:'native'},handbackIntent:{id:'run-handback',approvalBindings:authorities},dispatchRequest:{commentId:run.commentId,reactionId:run.reactionId}}
  if(runInput.authorityRequest?.kind==='consolidated'){const intent=await(await import('./checkpoints.ts')).checkpointIntentFromApproval({...runInput,runId:runInput.runId??randomUUID(),schemaVersion:2,generation:1,state:'prepared',terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,finishedAt:null,pendingDelivery:[]} as RunRecord,config);if(intent)runInput.checkpointIntent=intent}
  return helpers.createRun(runInput)
}

export async function registerQualifiedExecution(input:{config:FactoryConfig;repo:string;plan:LaunchPlan;execution:import('./shared-claims.ts').ExecutionIdentity;runtimeBinding:import('./runs.ts').InstalledRuntimeBinding}):Promise<string>{
  const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts')
  const metadata=await inspectManagedHarness(input.plan)
  if(input.plan.command!==input.execution.harness||metadata.version!==input.execution.harnessVersion||!validateManagedLaunch(input.plan,metadata).ok)throw Error('qualification setup differs from installed harness')
  await helpers.verifyInstalledRuntimeBinding(input.runtimeBinding,dirname(dirname(fileURLToPath(import.meta.url))),fileURLToPath(import.meta.url))
  await inspectSubscription(input.plan,input.execution.accountRef)
  const configurationDigest=await helpers.executionConfigurationDigest({binding:input.runtimeBinding,execution:input.execution,plan:input.plan,metadata})
  const target=await verifiedSharedTarget(input.repo,input.config)
  // Registration reads an actual immutable qualification receipt. It never publishes one
  // or creates a fake task/run merely to make the first dispatcher admission possible.
  const reader={...target,verifyEvidence:async(ref:import('./shared-claims.ts').EvidenceRef,payload:import('./shared-claims.ts').RecoveryEvidencePayload|null)=>{
    if(owner.canonical(ref)!==owner.canonical(input.execution.qualification)||payload===null)throw Error('canonical qualification receipt unavailable')
    helpers.verifyExecutionQualification(payload,input.execution,input.runtimeBinding,configurationDigest)
  }}
  await owner.resolveEvidence(reader,input.execution.qualification)
  return helpers.storeQualifiedExecution(runsRoot(input.config.home),{schemaVersion:1,execution:input.execution,runtimeBinding:input.runtimeBinding,configurationDigest})
}

export async function sharedClaimForRun(run:RunRecord,config:FactoryConfig):Promise<SharedClaim>{
  if(!run.sharedClaim||!run.machine)throw Error('run has no shared claim')
  const target=await verifiedSharedTarget(run.repo,config,run.runId),owner=await import('./shared-claims.ts'),snapshot=await owner.readCoordination(target),task=snapshot.tasks[run.sharedClaim.taskKey]
  if(!task||task.runId!==run.runId||task.ownerToken!==run.sharedClaim.ownerToken||task.generation!==run.sharedClaim.generation||task.machineId!==run.machine.id||task.installationId!==run.machine.installationId||task.sessionId!==run.machine.sessionId)throw Error('current shared run owner differs')
  sharedTaskContexts.set(target,task)
  return{taskKey:task.taskKey,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId,runId:task.runId,stateCommit:snapshot.head,target}
}
export async function checkpointPolicyEnabled(repo:string,config:FactoryConfig):Promise<boolean>{const target=await verifiedSharedTarget(repo,config);return sharedMachineContexts.get(target)!.defaults.checkpoints==='task-branch'}

export async function configuredRunStatusController(run:RunRecord,config:FactoryConfig):Promise<import('./runs.ts').RunStatusController>{
  const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),budget=readBudget()
  const actor=await boundedGhJson<{login:string}>(ghText,['api','user'],budget)
  const repository=await boundedGhJson<{node_id:string}>(ghText,['api',`repos/${run.repo}`],budget)
  const issue=await boundedGhJson<{node_id:string}>(ghText,['api',`repos/${run.repo}/issues/${run.issue}`],budget)
  if(!actor.login||!repository.node_id||!issue.node_id)throw Error('handback target identity unavailable')
  const controller:import('./runs.ts').RunStatusController={gh:ghText,senderLogin:actor.login,verifyAuthority:async(record,intentRef)=>{
    if(record.handbackIntent?.id!==intentRef||owner.canonical(record.handbackIntent.approvalBindings)!==owner.canonical(record.approvalBindings))throw Error('reviewed handback intent unavailable')
    await helpers.verifyRunAuthority(record,config)
  }}
  if(run.sharedClaim){
    controller.beforeSend=async(record,delivery,payload)=>{
      const claim=await sharedClaimForRun(record,config),target:import('./shared-claims.ts').EffectTarget={kind:'issue-comment',repositoryId:repository.node_id,issueNodeId:issue.node_id,commentId:'commentId'in delivery.target&&delivery.target.commentId!==null?String(delivery.target.commentId):null,markerId:delivery.id}
      await helpers.prepareManagedRunEffect({claim,run:record,effect:{operationId:delivery.id,runId:record.runId,generation:claim.generation,kind:'handback',target,payloadDigest:owner.sha256(payload)}})
    }
    controller.afterReadback=async(record,delivery,commentId,payload)=>{
      const latest=await helpers.readRun(runsRoot(config.home),record.runId),prepared=latest.pendingDelivery.find(p=>p.id===delivery.id)
      if(!prepared?.effect)throw Error('handback prepared effect unavailable')
      await helpers.acknowledgeManagedRunEffect({claim:await sharedClaimForRun(latest,config),run:latest,effectId:delivery.id,observedRemoteId:String(commentId),observedDigest:owner.sha256(payload)})
    }
  }
  return controller
}
export async function flushRunHandback(run:RunRecord,config:FactoryConfig):Promise<void>{
  if(!run.handbackIntent||run.waitReason==='subscription-quota'||run.state!=='terminal'||run.terminationCause==='succeeded')return
  const helpers=await import('./runs.ts')
  await helpers.deliverRunStatus({root:runsRoot(config.home),runId:run.runId,intentRef:run.handbackIntent.id,approvalBindings:run.handbackIntent.approvalBindings},await configuredRunStatusController(run,config))
}

export async function waitForQuotaCheck(ms:number,signal?:AbortSignal):Promise<void>{
  if(signal?.aborted)throw Error('quota wait cancelled')
  await new Promise<void>((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(Error('quota wait cancelled'))}
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve()},Math.max(0,ms))
    signal?.addEventListener('abort',stop,{once:true})
  })
}
export async function executeApprovedRun(run:PlannedRun,initialPlan:LaunchPlan,config:FactoryConfig,options:Parameters<typeof executeRun>[3],deps?:Partial<ExecuteDeps>):Promise<RunOutcome>{
  const helpers=await import('./runs.ts'),root=deps?.runInput?.root??runsRoot(config.home)
  let plan=initialPlan,record=deps?.preparedRun,outcome:RunOutcome
  let savedOutcome:RunOutcome|null=record?.state==='terminal'&&record.waitReason==='subscription-quota'?{runId:record.runId,attemptId:record.attemptId,started:record.processIdentity!==null,terminationCause:record.terminationCause??'failed',waitReason:record.waitReason,exitCode:record.exitCode,timedOut:false,logFile:join(root,record.runId,'events.jsonl'),pushed:false,handedBack:false}:null
  for(;;){
    outcome=savedOutcome??await executeRun(run,plan,config,options,{...deps,...(record?{preparedRun:record,runInput:{...record,root}}:{})})
    savedOutcome=null
    if(outcome.waitReason!=='subscription-quota'||!outcome.runId)return outcome
    options.onWait?.()
    record=await helpers.readRun(root,outcome.runId)
    for(;;){
      if(options.signal?.aborted||record.cancelRequestedAt){record=await helpers.updateRun(root,record.runId,()=>({cancelRequestedAt:record!.cancelRequestedAt??new Date().toISOString(),waitReason:null,quotaWait:null}));return{...outcome,waitReason:null,refusal:'run cancelled while waiting for subscription availability'}}
      if(!record.execution)throw Error('saved subscription execution identity unavailable')
      const at=record.quotaWait?Date.parse(record.quotaWait.nextCheckAt):helpers.nextQuotaCheck(record.quotaChecks??0,Date.now())
      try{await waitForQuotaCheck(Math.max(0,at-Date.now()),options.signal)}catch{continue}
      record=await helpers.readRun(root,record.runId)
      await helpers.verifyRunAuthority(record,config,'launch')
      if(options.sharedClaim)options.sharedClaim=await sharedClaimForRun(record,config)
      const available=await inspectSubscription({...initialPlan,command:record.execution!.harness},record.execution!.accountRef,deps?.subscriptionMetadata)
      if(available.available===false){const checks=(record.quotaChecks??0)+1;record=await helpers.updateRun(root,record.runId,()=>({quotaChecks:checks,quotaWait:{checks,nextCheckAt:new Date(helpers.nextQuotaCheck(checks,Date.now(),available.retryAt??undefined)).toISOString()}}));continue}
      if(!record.vendorSessionId&&outcome.started){await helpers.updateRun(root,record.runId,()=>({waitReason:null,quotaWait:null}));return{...outcome,waitReason:null,refusal:'saved vendor session unavailable; unfinished execution requires recovery'}}
      const checks=(record.quotaChecks??0)+1
      record=await helpers.updateRun(root,record.runId,()=>({quotaChecks:checks}))
      plan=record.vendorSessionId?{...resumeLaunchPlan({...initialPlan,command:record.execution!.harness},record.vendorSessionId),command:initialPlan.command}:initialPlan
      record=await helpers.beginRunAttempt(root,record.runId,record.generation)
      break
    }
  }
}

async function persistAttemptCapture(record:RunRecord,stdout:string,root:string,cause:TerminalCause):Promise<void>{
  if(!record.execution)return
  const helpers=await import('./runs.ts')
  const context={repo:record.repo,ts:record.finishedAt??new Date().toISOString(),stage:record.stage,model:record.model,effort:record.effort,human:record.taskOwner,worktree:record.checkout,parent:record.parent,terminationCause:cause}
  let captured:StatsRecord
  try{captured=record.harness==='claude'?fromClaudeHeadless(claudeHeadlessResult(stdout),context):fromCodexExec(stdout.split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}}),context)}catch{captured=normalizeRecord({...context,outcome:cause==='succeeded'?'complete':'failed'})}
  captured.issue=record.issue;captured.session_id=record.vendorSessionId??null;captured.duration_s=record.attemptElapsedMs==null?null:record.attemptElapsedMs/1000
  await helpers.atomicRunFile(join(helpers.runAttemptDirectory(root,record),'capture.json'),captured)
  if(record.waitReason==='subscription-quota')return
  const previous:StatsRecord[]=[]
  for(const attempt of record.attempts??[]){
    try{previous.push(JSON.parse(await helpers.readPrivateRunFile(join(root,record.runId,'attempts',attempt.id,'capture.json'))) as StatsRecord)}catch{previous.push(normalizeRecord({repo:record.repo,ts:attempt.finishedAt}))}
  }
  for(const field of ['turns','tool_calls','subagents','cost_usd'] as const){const values=[...previous,captured].map(r=>r[field]);captured[field]=values.every(v=>typeof v==='number'&&Number.isFinite(v))?values.reduce<number>((sum,v)=>sum+v!,0):null}
  for(const field of ['in','out','cache_read','cache_write'] as const){const values=[...previous,captured].map(r=>r.tokens[field]);captured.tokens[field]=values.every(v=>typeof v==='number'&&Number.isFinite(v))?values.reduce<number>((sum,v)=>sum+v!,0):null}
  captured.duration_s=record.activeElapsedMs===null?null:record.activeElapsedMs/1000
  await helpers.prepareTerminalCapture(root,record.runId,captured)
}

async function finishDurableSharedRun(claim:SharedClaim,outcome:RunOutcome|null,config:FactoryConfig):Promise<TaskTransition>{
  const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),root=runsRoot(config.home)
  let record=await helpers.readRun(root,claim.runId)
  if(record.sharedClaim?.ownerToken!==claim.ownerToken||outcome?.runId&&outcome.runId!==record.runId)throw Error('shared finish identity mismatch')
  if(record.waitReason==='subscription-quota'||record.terminationCause==='termination-unconfirmed'||!await helpers.verifyLocalRunStopped(record))return{kind:'block',stopProof:null}
  try{await(await import('./checkpoints.ts')).flushRunCheckpoint(record,config);await flushRunHandback(record,config)}catch{/* Unresolved code/control delivery retains ownership below. */}
  record=await helpers.readRun(root,record.runId);claim=await sharedClaimForRun(record,config)
  const snapshot=await owner.readCoordination(claim.target),task=snapshot.tasks[claim.taskKey]
  if(!task?.recovery||task.recovery.remoteEffectCoverage.kind==='unmanaged-possible'||task.recovery.effects.some(e=>e.kind!=='telemetry-push'&&e.state!=='acknowledged'&&e.state!=='cancelled-before-send')||record.pendingDelivery.some(p=>p.kind!=='telemetry-capture'&&p.status!=='acknowledged'))return{kind:'block',stopProof:null}
  if(record.stopProof){await helpers.verifySharedStopProof(record.stopProof,task,claim.target,record);if(record.acceptedScopeRef&&record.terminationCause==='succeeded'){await owner.resolveEvidence(claim.target,record.acceptedScopeRef);return{kind:'complete',stopProof:record.stopProof,acceptedScope:record.acceptedScopeRef}}return{kind:'stop',stopProof:record.stopProof}}
  record=await helpers.updateRun(root,record.runId,r=>({stopReceiptIds:r.stopReceiptIds??{receipt:randomUUID(),transition:randomUUID()}}))
  const allowedActionIds=[...new Set([record.handbackIntent?.id,record.checkpointIntent?.id,record.authorityRequest?.kind==='consolidated'?record.authorityRequest.requested.actionId:null].filter((id):id is string=>!!id))].sort()
  const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-reconciliation',runId:record.runId,scopeDigest:record.taskKey.scopeDigest,approvalBindings:record.approvalBindings,allowedActionIds,checkedEffectIds:task.recovery.effects.filter(e=>e.state==='acknowledged'||e.state==='cancelled-before-send').map(e=>e.operationId).sort(),inspector:{kind:'qualified-adapter',identityRef:record.machine!.id},result:'complete',reasonCode:'owned-process-group-stopped'}
  const receipt=await owner.publishRecoveryReceipt({claim,operationId:record.stopReceiptIds!.receipt,payload})
  const identity=await processIdentity(),bootId=record.processIdentity?.bootId??identity.bootId
  const proof:import('./shared-claims.ts').StopProof={kind:bootId===identity.bootId?'process-exit':'verified-reboot',machineId:record.machine!.id,installationId:record.machine!.installationId,sessionId:record.machine!.sessionId,hostBindingDigest:record.machine!.hostBindingDigest,bootIdDigest:createHash('sha256').update(`VegaFactory/boot/v1\n${bootId}`).digest('hex'),runIds:[record.runId],generation:claim.generation,observedAt:record.finishedAt??new Date().toISOString(),evidenceRef:receipt.reference}
  await helpers.updateRun(root,record.runId,()=>({stopProof:proof}))
  if(record.acceptedScopeRef&&record.terminationCause==='succeeded'){await owner.resolveEvidence(claim.target,record.acceptedScopeRef);return{kind:'complete',stopProof:proof,acceptedScope:record.acceptedScopeRef}}
  return{kind:'stop',stopProof:proof}
}

async function resumeSavedQuotaRun(saved:RunRecord,config:FactoryConfig,options:Parameters<typeof executeRun>[3]):Promise<RunOutcome>{
  const helpers=await import('./runs.ts'),entry=config.repos.find(e=>e.repo===saved.repo)
  if(!entry||!saved.execution||saved.cancelRequestedAt||!saved.worktreeDigest||!await helpers.verifyLocalRunStopped(saved)||await helpers.worktreeFingerprint(saved.checkout)!==saved.worktreeDigest)throw Error('saved quota checkout/termination requires verified recovery')
  await helpers.verifyRunAuthority(saved,config,'launch')
  const devMd=await readFile(join(entry.path,'.vegastack','dev.md'),'utf8'),resolved=loadConfiguredPolicy({home:config.home,repo:saved.repo,devMd,settingsPath:config.settingsPath}),policy=repoPolicyFromEffective(resolved),stage=stagePolicy(policy,saved.stage as Stage)
  if(stage.harness!==saved.harness||stage.model!==saved.model||stage.effort!==saved.effort)throw Error('original subscription setup changed')
  const issue=await boundedGhJson<{title:string;body:string}>(ghText,['api',`repos/${saved.repo}/issues/${saved.issue}`],readBudget(options.signal))
  const plan=buildLaunchPlan({harness:stage.harness,model:stage.model,effort:stage.effort,stage:saved.stage as Stage,worktree:saved.checkout,issue:{number:saved.issue,title:issue.title},operator:saved.taskOwner??'the operator',outcome:outcomeOf(issue.body),stopList:stopList(devMd),resume:true,skillPath:null,subagents:config.subagents})
  if(saved.sharedClaim)options.sharedClaim=await sharedClaimForRun(saved,config)
  return executeApprovedRun({repo:saved.repo,issue:saved.issue,title:issue.title,stage:saved.stage as Stage,commentId:saved.dispatchRequest?.commentId??null,reactionId:saved.dispatchRequest?.reactionId??null},plan,config,options,{preparedRun:saved,runInput:{...saved,root:runsRoot(config.home)}})
}
async function scheduleSavedQuotaRuns(config:FactoryConfig,options:{signal?:AbortSignal},tracker:RunTracker,reports:RunReport[],refusals:Refusal[]):Promise<void>{
  const helpers=await import('./runs.ts')
  const saved=await helpers.readRuns(runsRoot(config.home))
  for(const record of saved){
    if(record.waitReason!=='subscription-quota'||record.cancelRequestedAt||record.state!=='terminal'||!record.execution)continue
    const key=`${record.repo}#${record.issue}`,lockPath=repoLockPath(config,record.repo)
    if(tracker.has(key)||inFlightIssues(tracker,record.repo).length>=config.maxRuns||saved.some(r=>r.repo===record.repo&&r.terminationCause==='termination-unconfirmed'))continue
    let claim:Claim
    try{claim=ownedLocks.get(lockPath)??await holdLock(lockPath,process.pid)}catch{continue}
    const report:RunReport={repo:record.repo,issue:record.issue,title:`#${record.issue}`,stage:record.stage as Stage,launch:{command:record.harness,args:[],env:{},cwd:record.checkout},launched:false,waitReason:'subscription-quota',remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'awaiting-current-verification'}}
    reports.push(report)
    const done=(async()=>{
      let outcome:RunOutcome|null=null
      try{
        outcome=await resumeSavedQuotaRun(record,config,{operator:null,signal:options.signal,onWait:()=>{report.waitReason='subscription-quota'},onSpawn:()=>{report.launched=true;report.waitReason=null}})
        report.exitCode=outcome.exitCode;report.logFile=outcome.logFile
        if(record.sharedClaim){const latest=await helpers.readRun(runsRoot(config.home),record.runId),shared=await sharedClaimForRun(latest,config),transition=await finishDurableSharedRun(shared,outcome,config);await transitionSharedTask({claim:shared,operationId:transition.kind==='stop'?latest.stopReceiptIds?.transition??randomUUID():randomUUID(),transition})}
      }catch{refusals.push({repo:record.repo,issue:record.issue,reason:'saved quota run requires current authority, identity or recovery evidence'})}
      finally{tracker.delete(key);if(!inFlightIssues(tracker,record.repo).length&&outcome?.terminationCause!=='termination-unconfirmed')await releaseLock(lockPath,claim)}
    })()
    tracker.set(key,{repo:record.repo,issue:record.issue,done})
  }
}

export async function prepareConsolidatedRun(input:{run:PlannedRun;plan:LaunchPlan;config:FactoryConfig;request:Extract<import('./runs.ts').RunAuthorityRequest,{kind:'consolidated'}>;claim:Claim}):Promise<RunRecord>{
  const helpers=await import('./runs.ts'),entry=input.config.repos.find(e=>e.repo===input.run.repo)
  if(!entry)throw Error('consolidated run repository is not configured')
  const devMd=await readFile(join(entry.path,'.vegastack','dev.md'),'utf8'),resolved=loadConfiguredPolicy({home:input.config.home,repo:input.run.repo,devMd,settingsPath:input.config.settingsPath})
  if(!resolved.ok)throw Error('consolidated run policy unavailable')
  const policy=repoPolicyFromEffective(resolved),{approval}=await helpers.approvalTools(),reads:unknown[]=[],{kind:_,...request}=input.request
  const readJson=async(args:string[])=>{const value=await boundedGhJson(ghText,args,readBudget());reads.push(value);return value}
  const selected=await approval.gatherConsolidatedApproval({...request,operators:policy.operators,readJson})
  if(!selected.ok||selected.action.kind!=='local'||selected.action.operations.includes('edit')!==true||request.requested.repo!==input.run.repo||request.requested.issue!==input.run.issue)throw Error('consolidated run is not approved for source work')
  return prepareDispatchRun({run:input.run,plan:input.plan,config:input.config,policy,approvalBindings:selected.approvalBindings,bindings:selected.bindings,recordBinding:selected.recordBinding??null,authorityReads:reads,gh:ghText,metadata:await inspectManagedHarness(input.plan),claim:input.claim,authorityRequest:input.request})
}

export interface ExecutionRegistrationRequest {
  schemaVersion:1;repo:string;checkout:string;stage:Stage;execution:import('./shared-claims.ts').ExecutionIdentity;runtimeBinding:import('./runs.ts').InstalledRuntimeBinding
}
export async function registerExecutionRequest(request:unknown,config:FactoryConfig):Promise<string>{
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='checkout,execution,repo,runtimeBinding,schemaVersion,stage')throw Error('execution registration schema refused')
  const r=request as ExecutionRegistrationRequest,entry=config.repos.find(e=>e.repo===r.repo)
  if(r.schemaVersion!==1||!entry||typeof r.checkout!=='string'||!['plan','implement','corrections'].includes(r.stage)||!r.execution)throw Error('execution registration identity refused')
  const checkout=realpathSync(r.checkout),inventory=spawnSync('git',['worktree','list','--porcelain'],{cwd:entry.path,encoding:'utf8'})
  if(checkout!==r.checkout||inventory.status!==0||!inventory.stdout.split('\n').includes('worktree '+checkout))throw Error('registration checkout is not a configured repository worktree')
  const devMd=await readFile(join(checkout,'.vegastack','dev.md'),'utf8'),resolved=loadConfiguredPolicy({home:config.home,repo:r.repo,devMd,settingsPath:config.settingsPath})
  if(!resolved.ok)throw Error('registration policy unavailable')
  const policy=repoPolicyFromEffective(resolved),stage=stagePolicy(policy,r.stage)
  if(stage.harness!==r.execution.harness||stage.model!==r.execution.model||stage.effort!==r.execution.effort)throw Error('registration differs from selected harness/model/effort')
  const plan=buildLaunchPlan({harness:stage.harness,model:stage.model,effort:stage.effort,stage:r.stage,worktree:checkout,issue:{number:0,title:'execution registration'},operator:'the operator',outcome:'',stopList:stopList(devMd),resume:false,skillPath:null,subagents:config.subagents})
  return registerQualifiedExecution({config,repo:r.repo,plan,execution:r.execution,runtimeBinding:r.runtimeBinding})
}

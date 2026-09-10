import { realpath } from 'node:fs/promises'
import { inspectSpool, spoolRoot } from './stats/outbox.ts'
import { basicDiagnostic, probePressure, privacyReason } from './stats/privacy.ts'
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
import { buildLaunchPlan, ownedLaunchEnvironment, validateManagedLaunch, observeVendorEvent, inspectSubscription, resumeLaunchPlan, type HarnessMetadata, type LaunchPlan } from './launch.ts'
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
  const opening = [
    `Run the approved independent children of #${run.parent}: ${children}.`,
    `You are in ${parent.worktree} on ${parent.branch}. Save the canonical plan-lint --groups report, then use vegafactory children run --parent ${run.parent} --groups <report.json> --repo <owner/name> --write --json. This CLI owns execution for ${harness}; wait for its verified results. Use vegafactory children join with the same parent/groups/repo and --write only under current explicit integration authority.`,
  ]
  return [
    ...opening,
    'You own coordination and ordered integration only; do not edit the reserved child files in this parent session. Each child runs in its own worktree branched from this branch\'s HEAD sha and may touch only the files its group declared. After the join, run the project\'s check command once and hand back.',
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
  checkpoint: 'auto'|'deferred'
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

export async function verifyDispatchRunAuthority(
  run: RunRecord,
  config: FactoryConfig,
  purpose: 'launch' | 'effect' = 'effect',
  transport: { gh?: TickDeps['gh'] } = {},
): Promise<void> {
  const helpers = await import('./runs.ts')
  if (run.parent === null || run.authorityRequest?.kind !== 'consolidated') {
    await helpers.verifyRunAuthority(run, config, purpose, { gh: transport.gh })
    return
  }
  const request = run.authorityRequest, intent = run.checkpointIntent, checkpointRequest = intent?.approvalRequest
  if (!intent || !checkpointRequest || checkpointRequest.requested.ref !== `refs/heads/${run.branch}` || checkpointRequest.requested.branch !== run.branch
    || request.parentIssue !== run.parent || checkpointRequest.parentRepo !== request.parentRepo || checkpointRequest.parentIssue !== request.parentIssue
    || canonicalWire(checkpointRequest.approvalBinding) !== canonicalWire(request.approvalBinding)
    || request.requested.repo !== run.repo || request.requested.issue !== run.issue || request.requested.operation !== 'edit'
    || request.requested.branch === run.branch || request.requested.baseSha !== run.baseSha
    || checkpointRequest.requested.repo !== run.repo || checkpointRequest.requested.issue !== run.issue || checkpointRequest.requested.operation !== 'checkpoint'
    || checkpointRequest.requested.baseSha !== intent.baseSha || intent.baseRef !== checkpointRequest.requested.ref
    || canonicalWire(request.requested.taskIds) !== canonicalWire(run.approvedTaskIds)
    || canonicalWire(checkpointRequest.requested.taskIds) !== canonicalWire(run.approvedTaskIds)
    || canonicalWire(checkpointRequest.requested.paths) !== canonicalWire(request.requested.paths)
    || canonicalWire(intent.paths) !== canonicalWire(request.requested.paths)) throw Error('child execution/checkpoint authority identity differs')
  const branch = spawnSync('git', ['symbolic-ref','--short','HEAD'], { cwd: run.checkout, encoding: 'utf8', timeout: 5000 })
  const head = spawnSync('git', ['rev-parse','HEAD'], { cwd: run.checkout, encoding: 'utf8', timeout: 5000 })
  const ancestor = spawnSync('git', ['merge-base','--is-ancestor',run.baseSha,head.stdout?.trim() ?? ''], { cwd: run.checkout, timeout: 5000 })
  if (branch.status !== 0 || head.status !== 0 || branch.stdout.trim() !== run.branch || !/^[a-f0-9]{40}$/.test(head.stdout.trim()) || ancestor.status !== 0
    || purpose === 'launch' && (head.stdout.trim() !== run.headSha || spawnSync('git',['status','--porcelain','--untracked-files=all'],{cwd:run.checkout,encoding:'utf8',timeout:5000}).stdout.trim())) throw Error('actual child Git identity differs')
  const entry = config.repos.find(row => row.repo.toLowerCase() === run.repo.toLowerCase())
  if (!entry || !run.approvalBindings.length || !run.approvedTaskIds?.length) throw Error('child authority context unavailable')
  const devMd = await readFile(join(entry.path,'.vegastack','dev.md'),'utf8'), resolved = loadConfiguredPolicy({home:config.home,repo:run.repo,devMd,settingsPath:config.settingsPath})
  if (!resolved.ok) throw Error('current child policy unavailable')
  const policy = repoPolicyFromEffective(resolved), gh = transport.gh ?? ghText, reads: unknown[] = [], { approval } = await helpers.approvalTools()
  const readJson = async (args: string[]) => { const value = await boundedGhJson(gh,args,readBudget()); reads.push(value); return value }
  const {kind: _kind, ...executionInput} = request
  const execution = await approval.gatherConsolidatedApproval({...executionInput,operators:policy.operators,readJson})
  const checkpoint = await approval.gatherConsolidatedApproval({...checkpointRequest,operators:policy.operators,readJson})
  if (!execution.ok || execution.blocks.length || execution.action?.kind !== 'local' || !execution.action.operations.includes('edit')
    || !checkpoint.ok || checkpoint.blocks.length || checkpoint.action?.kind !== 'child-source-checkpoint'
    || canonicalWire(execution.bindings) !== canonicalWire(run.approvalRefs) || canonicalWire(checkpoint.bindings) !== canonicalWire(run.approvalRefs)
    || canonicalWire(execution.taskIds) !== canonicalWire(run.approvedTaskIds) || canonicalWire(checkpoint.taskIds) !== canonicalWire(run.approvedTaskIds)
    || canonicalWire(execution.files) !== canonicalWire(request.requested.paths) || canonicalWire(checkpoint.files) !== canonicalWire(request.requested.paths)) throw Error('current child execution/checkpoint source refused')
  const selection = await helpers.approvedTaskSelection(execution.bindings,reads,run.stage,{},run.approvedTaskIds)
  if (selection.scopeDigest !== run.taskKey.scopeDigest || selection.taskId !== run.taskKey.taskId || canonicalWire(selection.paths) !== canonicalWire(request.requested.paths)) throw Error('current child task/file scope changed')
  const bound = await helpers.bindVerifiedApprovalSources(execution.approvalBindings,reads,readJson,gh)
  if (canonicalWire(bound) !== canonicalWire(run.approvalBindings)) throw Error('current child canonical authority changed')
  if (run.recordBinding) {
    if (!execution.recordBinding || canonicalWire(execution.recordBinding) !== canonicalWire(checkpoint.recordBinding)) throw Error('current child record provenance unavailable')
    const [record] = await helpers.bindVerifiedApprovalSources([execution.recordBinding],reads,readJson,gh)
    if (canonicalWire(record) !== canonicalWire(run.recordBinding)) throw Error('current child record provenance changed')
  }
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
  const event=async(event:string,fields:Record<string,unknown>={})=>{await appendFile(file,JSON.stringify(basicDiagnostic(now().toISOString(),event,fields))+'\n',{mode:0o600})}
  let mutations=Promise.resolve()
  const transition=(patch:Parameters<typeof transitionRun>[2])=>{mutations=mutations.then(async()=>{
    // Child integration/checkpoint controllers may advance other fields on the
    // same parent while its wrapper is alive. Rebase this lifecycle-only patch
    // on the current durable record; attempt-directory ownership still prevents
    // a second executor from sharing this attempt.
    for(let retry=0;retry<4;retry++){
      const current=await readRun(recordRoot,record.runId)
      try{record=await transitionRun(record.runId,current.generation,patch,recordRoot);return}catch(error){if((error as Error).message!=='stale run generation'||retry===3)throw error}
    }
  });return mutations}
  await event('prepared')
  const refuse=async(reason:string):Promise<RunOutcome>=>{await transition({state:'terminal',terminationCause:'spawn-failed',finishedAt:now().toISOString()});await event('launch-refused',{reasonCode:'launch-refused'});return{runId:record.runId,started:false,refusal:reason,terminationCause:'spawn-failed',exitCode:null,timedOut:false,logFile:file,pushed:false,handedBack:false}}
  let pendingBytes=0
  try{pendingBytes=(await inspectSpool(spoolRoot(config.home))).pendingBytes}catch{return refuse('privacy-spool-unavailable')}
  const pressure=await probePressure(config.home,pendingBytes)
  if(pressure.paused)return refuse(pressure.reason)
  if(options.signal?.aborted)return refuse('cancelled before launch')
  if(run.parallel?.length){
    try{if(!options.sharedClaim)throw Error('shared parent ownership required');await(await import('./children.ts')).validateParallelCoordinator(run,record,config)}
    catch(error){return refuse((error as Error).message)}
  }
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
      await verifyDispatchRunAuthority(record,config,'launch',{gh:deps?.gh})
      const target=await verifiedSharedTarget(record.repo,config,record.runId,deps?.gh??ghText)
      if(options.sharedClaim){
        const resolved=sharedMachineContexts.get(target)
        if(!record.machine||!resolved||resolved.id!==record.machine.id||resolved.installationId!==record.machine.installationId||resolved.hostBindingDigest!==record.machine.hostBindingDigest||!resolved.allowedRepositories.includes(record.repo))throw Error('fresh shared execution machine differs')
        const snapshot=await(await import('./shared-claims.ts')).readCoordination(target),task=snapshot.tasks[options.sharedClaim.taskKey]
        if(!task||task.runId!==options.sharedClaim.runId||task.generation!==options.sharedClaim.generation||task.ownerToken!==options.sharedClaim.ownerToken||task.machineId!==options.sharedClaim.machineId||task.installationId!==options.sharedClaim.installationId||task.sessionId!==options.sharedClaim.sessionId||task.state!=='running')throw Error('fresh shared execution owner differs')
        options.sharedClaim={...options.sharedClaim,stateCommit:snapshot.head,target}
      }
      sharedRunContexts.set(target,record.runId)
      record=await runtime.refreshAttemptCoverage(recordRoot,record.runId,target)
    }catch{return refuse('current source or runtime qualification unavailable')}

    let subscription:Awaited<ReturnType<typeof inspectSubscription>>
    try{subscription=await inspectSubscription(plan,record.execution!.accountRef,deps?.subscriptionMetadata)}catch{return refuse('subscription identity or configuration unavailable')}
    if(subscription.available===false){
      const {nextQuotaCheck}=await import('./runs.ts')
      await transition({state:'terminal',terminationCause:'failed',finishedAt:now().toISOString(),waitReason:'subscription-quota',quotaWait:{checks:record.quotaChecks??0,nextCheckAt:new Date(nextQuotaCheck(record.quotaChecks??0,now().getTime(),subscription.retryAt??undefined)).toISOString()}})
      try{await transition({worktreeDigest:await runtime.worktreeFingerprint(record.checkout),attemptElapsedMs:0,activeElapsedMs:runtime.priorRunElapsedMs(record)})}catch{}
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
  const historicalElapsed=(await import('./runs.ts')).priorRunElapsedMs(record)
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
    let probingPressure=false
    const heartbeat=setInterval(()=>{
      send({kind:'heartbeat'})
      if(started&&!exited&&!probingPressure){
        probingPressure=true
        void probePressure(config.home,0).then(current=>{if(!settled&&!exited&&current.paused){void event('storage-pressure',{reasonCode:current.reason}).catch(()=>{});stop('failed')}}).finally(()=>{probingPressure=false})
      }
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
          send({kind:'acknowledge',runId:record.runId,attemptId,command:plan.command,args:plan.args,cwd:plan.cwd,env:ownedLaunchEnvironment(plan,record,attemptId)})
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
  try{await persistAttemptCapture(record,stdout,recordRoot,terminalCause)}catch{
    // The process outcome stays terminal and pending persistence stays visible; no ACK.
    const captureOwner=await import('./runs.ts')
    await captureOwner.updateRun(recordRoot,record.runId,current=>({pendingDelivery:current.pendingDelivery.map(p=>p.kind==='telemetry-capture'&&'captureKey' in p.target&&p.target.captureKey===captureOwner.terminalCaptureDescriptor(current).captureKey?{...p,lastError:'capture-unavailable'}:p)})).catch(()=>{})
    await event('capture-pending',{reasonCode:'capture-unavailable'}).catch(()=>{})
  }
  await event('exit',{terminationCause:terminalCause,exitCode,durationSeconds:elapsed/1000})
  if(deps?.checkpoint!=='deferred')try { await (await import('./checkpoints.ts')).flushRunCheckpoint(record,config) } catch { await event('checkpoint-pending',{reasonCode:'checkpoint-unavailable'}) }
  if(record.execution&&record.approvalRefs.some(ref=>ref.kind==='plan')){try{await checkpointRecoveryContext(await readRun(recordRoot,record.runId),config,{gh:deps?.gh})}catch{await event('checkpoint-pending',{reasonCode:'checkpoint-unavailable'})}}
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
  recoveredChildPrepare?:NonNullable<import('./children.ts').ChildrenDependencies['prepare']>
  quotaRecovery?: import('./runs.ts').QuotaRecoveryController
  harnessMetadata: (plan: LaunchPlan) => HarnessMetadata | Promise<HarnessMetadata>
  // #138 supplies fresh authority locators and the durable wrapper; missing adapters refuse.
  sharedAdmission?: (input: { run: PlannedRun; entry: RepoEntry; policy: RepoPolicy; approvalBindings: NonNullable<RunReport['approvalBindings']>; bindings: NonNullable<RunReport['bindings']>;recordBinding?:{approvalId:string;commentId:number;bodySha256:string}|null }) => Promise<{ machine: EffectiveMachine; session: MachineSession; candidate: VerifiedCandidate; operationId: string }>
  executeShared?: TickDeps['execute']
  persistSharedRun?: (claim: SharedClaim, run: PlannedRun, plan: LaunchPlan) => Promise<void>
  finishSharedRun?: (claim: SharedClaim, outcome: RunOutcome | null) => Promise<TaskTransition>
  recoveryTransport?: (repo:string,config:FactoryConfig)=>Promise<{target:import('./shared-claims.ts').CoordinationTarget;source?:RemoteRecoveryTransport['source']}>
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
  if (config.executionMode === 'shared') deps = { ...sharedRunAdapters(config,deps?.processDeps,gh), ...deps }
  if(!options.dryRun) { const {readRuns}=await import('./runs.ts');const {flushRunCheckpoint}=await import('./checkpoints.ts');for(const record of await readRuns(runsRoot(config.home))){if(record.checkpointIntent)try{await flushRunCheckpoint(record,config)}catch{/* Preserve current local source and its durable pending intent. */}if(record.handbackIntent)try{await flushRunHandback(record,config)}catch{/* The stable pending marker remains private and retryable. */}} }

  const ensure = deps?.ensureWorktree ?? defaultEnsureWorktree
  const execute = deps?.execute ?? (async(run, plan, cfg, opts) => executeApprovedRun(run, plan, cfg, opts,plan.approvedRunInput?.runId?{...deps?.processDeps,preparedRun:await readRun(runsRoot(cfg.home),plan.approvedRunInput.runId),runInput:plan.approvedRunInput}:deps?.processDeps))
  const tracker = deps?.tracker ?? processTracker

  let state = await withinRead(readBudget(options.signal), () => readState(config.stateFile))
  const runs: RunReport[] = []
  const refusals: Refusal[] = []
  if(!options.dryRun&&!suppliedExecutor){await scheduleSavedQuotaRuns(config,options,tracker,runs,refusals);await inspectSavedRecoveryWork(config,options,tracker,runs,refusals,gh,deps?.recoveryTransport,deps?.processDeps,deps?.recoveredChildPrepare)}

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
    if(protectedRuns.length&&(config.executionMode!=='shared'||protectedRuns.some(run=>!run.sharedClaim))){refusals.push({repo:entry.repo,issue:null,reason:'owned execution termination is unconfirmed; repository protection retained'});continue}
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
      if (run.parallel?.length && config.executionMode !== 'shared') {
        refusals.push({ repo: entry.repo, issue: run.issue, reason: 'parallel child execution requires qualified shared parent ownership' })
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
        const subjects = [run.issue] // the coordinator owns its own canonical approval; each child is admitted by the gateway
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
          await verifyFleetCandidate(await readRun(runsRoot(config.home),sharedClaim.runId),input.candidate,gh)
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
          process.stderr.write(`run on ${key} failed outside the harness: ${privacyReason(error)}\n`)
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

  --checkpoint-task ID --run-id ID
                checkpoint one checked task in its live owned run; preview by
                default, --once runs only the approved-base configured check
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

export interface DispatchArgs { checkpointTask?:string;runId?:string; once: boolean; watch: boolean; dryRun: boolean; json: boolean; config: string | null; help: boolean }

export function parseDispatchArgs(argv: string[]): DispatchArgs {
  const args: DispatchArgs = { once: false, watch: false, dryRun: false, json: false, config: null, help: false }
  const rest = [...argv]
  while (rest.length) {
    const token = rest.shift()!
    if (token === '--checkpoint-task' || token === '--run-id') {
      const value=rest.shift();if(!value||value.startsWith('-'))throw Error(token+' requires an identity')
      if(token==='--checkpoint-task'){if(args.checkpointTask)throw Error('duplicate checkpoint task');args.checkpointTask=value}else{if(args.runId)throw Error('duplicate run ID');args.runId=value}
    }
    else if (token === '--once') args.once = true
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
  if(Boolean(args.checkpointTask)!==Boolean(args.runId)||args.checkpointTask&&(!/^[1-9]\d*-T[1-9]\d*$/.test(args.checkpointTask)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args.runId!)||args.watch))throw Error('checkpoint-task requires one exact run/task and cannot watch')
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

  if(args.checkpointTask&&args.runId){
    try{
      const run=await readRun(runsRoot(home),args.runId)
      if(process.env.VSK_RUN_ID!==run.runId||await realpath(process.cwd())!==run.checkout||!await callerBelongsToRun(run))throw Error('task checkpoint requires its live owned session/worktree')
      const result=await checkpointTaskForRecovery({run,taskId:args.checkpointTask,config,write:args.once&&!args.dryRun})
      console.log(args.json?JSON.stringify({command:'dispatch',...result}):result.reason)
      return 0
    }catch(error){console.error((error as Error).message);return 2}
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
const sharedContinuationContexts=new WeakMap<import('./shared-claims.ts').CoordinationTarget,{runId:string;attemptId:string;checkpoint:NonNullable<RunRecord['checkpoint']>;scopeDigest:string;approvalBindings:RunRecord['approvalBindings']}>()
const sharedMachineContexts=new WeakMap<import('./shared-claims.ts').CoordinationTarget,EffectiveMachine>()
const stoppedGroupSetupOverride=Symbol.for('vegafactory.test.stopped-group-receiving-setup')
type StoppedGroupTarget=import('./shared-claims.ts').CoordinationTarget&{[stoppedGroupSetupOverride]?:typeof receivingExecutionSetup}
interface ActiveStoppedGroupContext {
  request:import('./shared-claims.ts').GroupSuccessionRequest
  materials:RemoteRecoveryMaterial[];config:FactoryConfig;gh:TickDeps['gh'];localClaim:Claim
  checkouts:Map<string,string>;setupDigests:Map<string,string>;setup:typeof receivingExecutionSetup;source?:RemoteRecoveryTransport['source'];machine:EffectiveMachine;session:MachineSession
}
const stoppedGroupSerialTails=new Map<string,Promise<void>>()
async function stoppedGroupSerial<T>(target:import('./shared-claims.ts').CoordinationTarget,phase:'prepare'|'verify',work:()=>Promise<T>):Promise<T>{
  const key=canonicalWire({phase,host:target.host,repositoryId:target.repositoryId,branch:target.branch,localRoot:target.localRoot}),previous=stoppedGroupSerialTails.get(key)??Promise.resolve()
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>gate);stoppedGroupSerialTails.set(key,tail)
  await previous
  try{return await work()}finally{release();if(stoppedGroupSerialTails.get(key)===tail)stoppedGroupSerialTails.delete(key)}
}
export type FleetParallelProjection={eligible:boolean;independent:boolean;taskIds:string[];paths:string[];resources:string[];reason:string|null}
const exclusiveFleet=(reason:string):FleetParallelProjection=>({eligible:false,independent:false,taskIds:[],paths:[],resources:[],reason})
export async function fleetParallelProjection(record:Pick<RunRecord,'repo'|'approvalRefs'|'approvedTaskIds'>,gh:TickDeps['gh']=ghText):Promise<FleetParallelProjection>{
  try{
    const plans=record.approvalRefs.filter(ref=>ref.kind==='plan')
    if(plans.length!==1||!record.approvedTaskIds?.length)return exclusiveFleet('exact approved plan/task selection unavailable')
    const plan=plans[0]!,comments=await fetchGhPages<{node_id?:string;body?:string}>(gh,`repos/${plan.repo}/issues/${plan.issue}/comments`,readBudget())
    if(!comments.complete)return exclusiveFleet('complete current plan history unavailable')
    const candidates=comments.items.filter(row=>row.node_id===plan.artifactId&&typeof row.body==='string').map(row=>row.body!)
    const bodies=[...new Set(candidates)]
    if(bodies.length!==1)return exclusiveFleet('canonical current plan unavailable')
    const preflight=process.env.VSK_PREFLIGHT_SCRIPT||join(dirname(dirname(fileURLToPath(import.meta.url))),'skill','dev-implement','scripts','preflight.mjs')
    const tools=await(await import('./runs.ts')).approvalTools({preflightScript:preflight})
    if(tools.approval.scopeDigest(bodies[0],'plan')!==plan.digest)return exclusiveFleet('canonical current plan digest changed')
    const parserPath=process.env.VSK_PLAN_LINT_SCRIPT||join(dirname(dirname(dirname(preflight))),'dev-plan','scripts','plan-lint.mjs')
    const parser=await import(pathToFileURL(parserPath).href)
    const projected=parser.parseFleetParallelDeclaration(bodies[0],record.approvedTaskIds) as FleetParallelProjection
    if(!projected||typeof projected!=='object'||typeof projected.independent!=='boolean'||!Array.isArray(projected.taskIds)||!Array.isArray(projected.paths)||!Array.isArray(projected.resources))return exclusiveFleet('canonical fleet projection unavailable')
    return projected
  }catch(error){return exclusiveFleet((error as Error).message||'canonical fleet projection unavailable')}
}
async function verifyFleetCandidate(record:RunRecord,candidate:VerifiedCandidate,gh:TickDeps['gh']):Promise<void>{
  if(record.parent!==null)return
  const projected=await fleetParallelProjection(record,gh)
  if(projected.independent&&canonicalWire(projected.taskIds)!==canonicalWire(record.approvedTaskIds))throw Error('fleet task selection differs')
  const expected=projected.independent?{paths:projected.paths,resources:projected.resources,independent:true}:{paths:[],resources:[],independent:false}
  if(canonicalWire({paths:candidate.paths,resources:candidate.resources,independent:candidate.independent})!==canonicalWire(expected))throw Error('fresh fleet parallel projection differs')
}
export interface SharedIdentitySources{
  readHostBinding?:()=>Promise<{digest:string;platform:'darwin'|'linux'}>
  readBootIdentityDigest?:()=>Promise<string>
  processIdentity?:()=>Promise<import('./claims.ts').ProcessIdentity>
}
export async function verifiedSharedTarget(repo:string,config:FactoryConfig,runId?:string,gh:TickDeps['gh']=ghText,identitySources:SharedIdentitySources={}):Promise<import('./shared-claims.ts').CoordinationTarget>{
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
  const login=JSON.parse(await gh(['api','user'],{timeoutMs:10_000})) as {login:string}
  const host=await (identitySources.readHostBinding??readHostBinding)()
  const resolution=resolveMachinePolicy({policy:policy.policy,machineId:bootstrap.id,installationId:bootstrap.installationId,hostBindingDigest:host.digest,executionLogin:login.login})
  if(!resolution.ok||!resolution.machine?.allowedRepositories.includes(repo)||resolution.machine.group!==bootstrap.group)throw Error('machine identity or repository scope refused')
  const machine=resolution.machine as EffectiveMachine
  const target:import('./shared-claims.ts').CoordinationTarget={host:'github.com',...machine.coordination,localRoot:join(config.home,'.vegastack','coordination'),provider:githubCoordinationProvider(gh),
    verifyCandidate:async(candidate,current,session)=>{
      if(current.id!==machine.id||current.policyDigest!==machine.policyDigest||session.hostBindingDigest!==host.digest||candidate.repo!==repo||candidate.repositoryNodeId!==machine.repositoryIds[repo])throw Error('shared candidate identity mismatch')
      sharedRunContexts.set(target,candidate.runId)
      const record=await readRun(runsRoot(config.home),candidate.runId)
      const continuation=sharedContinuationContexts.get(target),runtime=await import('./runs.ts')
      const continuing=continuation&&continuation.runId===record.runId&&continuation.attemptId===(record.attemptId??record.runId)&&continuation.scopeDigest===record.taskKey.scopeDigest&&canonicalWire(continuation.approvalBindings)===canonicalWire(record.approvalBindings)&&canonicalWire(continuation.checkpoint)===canonicalWire(record.checkpoint)&&['terminal','interrupted'].includes(record.state)&&await runtime.verifyLocalRunStopped(record)
      if(!record.execution||(!continuing&&(record.state!=='prepared'||record.pid!==null||existsSync(runtime.runAttemptDirectory(runsRoot(config.home),record))))||canonicalWire(record.approvalBindings)!==canonicalWire(candidate.approvalBindings)||record.taskKey.scopeDigest!==candidate.scopeDigest)throw Error('shared prepared candidate differs')
      if(canonicalWire(await (identitySources.processIdentity??processIdentity)())!==canonicalWire(session.identity))throw Error('shared session process identity differs')
      await verifyDispatchRunAuthority(record,config,'launch',{gh})
      await verifyFleetCandidate(record,candidate,gh)
      await (await import('./shared-claims.ts')).resolveEvidence(target,record.execution.qualification)
    },
    verifyChildRelationship: input => import('./children.ts').then(owner => owner.verifyChildRelationship(input,config,gh)),
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
      await verifyDispatchRunAuthority(run,config,'effect',{gh})
      sharedAuthorityContexts.set(target,canonicalWire({runId:run.runId,bindings:run.approvalBindings,recordBinding:run.recordBinding}))
      if(transition.kind==='receipt'){
        if(transition.payload.kind==='acceptance'&&await verifyTaskCheckpointEvidence(run,transition.payload,config)){}
        else if(transition.payload.kind==='acceptance'||transition.payload.kind==='join')await(await import('./children.ts')).verifyChildrenEvidence({run,task,payload:transition.payload,publishing:true},config,gh)
        else await helpers.verifyRunEvidencePayload(null,transition.payload,{run,task,publishing:true,verifyAuthority:()=>verifyDispatchRunAuthority(run,config,'effect',{gh}),stopped:()=>helpers.verifyLocalRunStopped(run)})
      }
      if(transition.kind==='start'&&(run.state!=='prepared'||!run.execution||!run.runtimeBinding))throw Error('shared durable preparation unavailable')
      if((transition.kind==='stop'||transition.kind==='complete'||transition.kind==='handoff'||transition.kind==='block')&&transition.stopProof)await helpers.verifySharedStopProof(transition.stopProof,task,target,run)
      if(transition.kind==='handoff'&&(!transition.recovery.checkpoint||transition.machine.id!==machine.id))throw Error('verified recovery target unavailable')
    },
    verifyEvidence:async(ref,payload)=>{
      const helpers=await import('./runs.ts')
      let runId=sharedRunContexts.get(target)
      if(!runId&&payload&&'runId'in payload)runId=payload.runId
      if(!runId)throw Error('evidence lacks a bound run context')
      let task=sharedTaskContexts.get(target)
      // Capacity may inspect an already stopped sibling while admitting a new
      // child. Resolve that receipt's actual run/task, never the incoming run.
      if(payload?.kind==='effect-reconciliation'&&payload.runId!==runId){
        runId=payload.runId
        const sibling=await helpers.readRun(runsRoot(config.home),runId)
        if(sibling.repo!==repo||!sibling.sharedClaim)throw Error('stopped sibling evidence has no original owner')
        const snapshot=await(await import('./shared-claims.ts')).readCoordination(target)
        task=snapshot.tasks[sibling.sharedClaim.taskKey]
        if(!task||task.runId!==sibling.runId||task.ownerToken!==sibling.sharedClaim.ownerToken||task.generation!==sibling.sharedClaim.generation||task.machineId!==sibling.machine?.id||task.sessionId!==sibling.machine.sessionId)throw Error('stopped sibling owner differs')
      }
      const run=await helpers.readRun(runsRoot(config.home),runId)
      if(payload?.kind==='acceptance'&&(await verifyTaskCheckpointEvidence(run,payload,config)||await verifyRetainedTaskCompletion(run,payload,ref,target,config))){}
      else if(payload?.kind==='acceptance'||payload?.kind==='join')await(await import('./children.ts')).verifyChildrenEvidence({run,task,payload,publishing:false,ref},config,gh)
      else await helpers.verifyRunEvidencePayload(ref,payload,{run,task,verifyAuthority:async()=>{if(sharedAuthorityContexts.get(target)!==canonicalWire({runId:run.runId,bindings:run.approvalBindings,recordBinding:run.recordBinding}))await verifyDispatchRunAuthority(run,config,'effect',{gh})},stopped:()=>helpers.verifyLocalRunStopped(run)})
    },
    verifyGroupSuccession:async input=>{
      throw Error('stopped-group verification requires an operation-scoped controller')
    },
  }
  sharedMachineContexts.set(target,machine)
  if(runId)sharedRunContexts.set(target,runId)
  return target
}
export function sharedRunAdapters(config:FactoryConfig,processDeps?:Pick<ExecuteDeps,'wrapperPath'>,gh:TickDeps['gh']=ghText,identitySources:SharedIdentitySources={}):Pick<TickDeps,'sharedAdmission'|'persistSharedRun'|'executeShared'|'finishSharedRun'>{
  return{
    sharedAdmission:async input=>{
      const target=await verifiedSharedTarget(input.entry.repo,config,undefined,gh,identitySources)
      const helpers=await import('./runs.ts')
      const coordination=await import('./shared-claims.ts'),{readRuns}=await import('./runs.ts'),{readBootIdentityDigest}=await import('./machine-identity.ts')
      const stage=stagePolicy(input.policy,input.run.stage),machine=sharedMachineContexts.get(target)!
      const records=(await readRuns(runsRoot(config.home))).filter(r=>r.repo===input.run.repo&&r.issue===input.run.issue&&r.state==='prepared'&&!r.remoteRecovery&&!r.continuations?.length&&r.execution&&r.harness===stage.harness&&r.model===stage.model&&r.effort===stage.effort&&canonicalWire(r.approvalBindings.map(a=>({approvalId:a.approvalId,commentId:Number(a.source.commentId),bodySha256:a.source.bodySha256})))===canonicalWire(input.approvalBindings)&&canonicalWire(r.recordBinding?{approvalId:r.recordBinding.approvalId,commentId:Number(r.recordBinding.source.commentId),bodySha256:r.recordBinding.source.bodySha256}:null)===canonicalWire(input.recordBinding??null)&&canonicalWire(r.approvalRefs)===canonicalWire(input.bindings))
      if(records.length!==1)throw Error('unique qualified subscription run preparation unavailable; shared acquisition deferred')
      const record=records[0]!,authorities=record.approvalBindings
      await verifyDispatchRunAuthority(record,config,'launch',{gh})
      sharedRunContexts.set(target,record.runId)
      await coordination.resolveEvidence(target,record.execution!.qualification)
      if(!record.machine||record.machine.id!==machine.id||record.machine.installationId!==machine.installationId||record.machine.hostBindingDigest!==machine.hostBindingDigest)throw Error('prepared machine identity differs')
      const subject=await boundedGhJson(gh,['api',`repos/${input.run.repo}/issues/${input.run.issue}`],readBudget()) as {node_id:string}
      const session:MachineSession={target,localRoot:target.localRoot,machineId:machine.id,installationId:machine.installationId,sessionId:record.machine.sessionId,hostBindingDigest:machine.hostBindingDigest,bootIdDigest:await (identitySources.readBootIdentityDigest??readBootIdentityDigest)(),identity:await (identitySources.processIdentity??processIdentity)()}
      const fleet=record.parent===null?await fleetParallelProjection(record,gh):exclusiveFleet('child scope is owned by the parent group')
      const candidate:VerifiedCandidate={host:target.host,repo:record.repo,issue:record.issue,repositoryNodeId:machine.repositoryIds[record.repo]!,issueNodeId:subject.node_id,scopeDigest:record.taskKey.scopeDigest,approvalDigest:createHash('sha256').update(coordination.canonical(authorities)).digest('hex'),approvalBindings:authorities,runId:record.runId,stage:record.stage,paths:fleet.independent?fleet.paths:[],resources:fleet.independent?fleet.resources:[],independent:fleet.independent,parentTaskKey:null,approvedTaskIds:record.approvedTaskIds??[record.taskKey.taskId]}
      if(record.parent!==null){
        const parentRuns=(await helpers.readRuns(runsRoot(config.home))).filter(r=>r.repo===record.repo&&r.issue===record.parent&&r.parent===null&&r.state==='running')
        if(parentRuns.length!==1)throw Error('unique original parent run unavailable')
        const launch=await(await import('./children.ts')).readExecutableChildrenRecord(parentRuns[0]!,config)
        const child=launch.children.find(c=>c.runId===record.runId&&c.issue===record.issue)
        if(!child||child.scopeDigest!==record.taskKey.scopeDigest||canonicalWire(child.taskIds)!==canonicalWire(record.approvedTaskIds))throw Error('child launch is not durably bound')
        if(launch.schemaVersion!==2||!child.parentBinding)throw Error('child launch lacks immutable parent provenance')
        candidate.parentTaskKey=child.parentBinding.taskKey;candidate.parentBinding=child.parentBinding
        candidate.paths=child.files;candidate.resources=child.resources;candidate.independent=true
      }
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
      await checkpointRecoveryContext(await readRun(input.root,record.runId),config)
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
    finishSharedRun:(claim,outcome)=>finishDurableSharedRun(claim,outcome,config,gh),
  }
}

const dispatcherSessionId=randomUUID()
export async function prepareDispatchRun(input:{run:PlannedRun;plan:LaunchPlan;config:FactoryConfig;policy:RepoPolicy;approvalBindings:NonNullable<RunReport['approvalBindings']>;bindings:NonNullable<RunReport['bindings']>;authorityReads:unknown[];recordBinding?:{approvalId:string;commentId:number;bodySha256:string}|null;gh:TickDeps['gh'];metadata:HarnessMetadata;claim:Claim;parent?:{run:RunRecord;binding:import('./shared-claims.ts').ParentClaimBinding;childIssue:number};authorityRequest?:import('./runs.ts').RunAuthorityRequest;checkpointRequest?:NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>}):Promise<RunRecord>{
  const {run,plan,config,policy,gh,metadata}=input,helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts')
  const stage=stagePolicy(policy,run.stage),root=runsRoot(config.home)
  if(input.parent){
    const parent=input.parent
    if(parent.childIssue!==run.issue||parent.run.repo!==run.repo||parent.run.parent!==null||parent.run.state!=='running'||parent.binding.runId!==parent.run.runId||input.claim.path!==join(root,parent.run.runId,'child-'+run.issue+'.lock'))throw Error('local child claim differs from parent')
    const original=await sharedClaimForRun(parent.run,config)
    if(canonicalWire((await import('./children.ts')).parentClaimBinding(original))!==canonicalWire(parent.binding))throw Error('original parent claim changed')
  }else if(input.claim.path!==repoLockPath(config,run.repo))throw Error('local run claim targets another repository')
  await(await import('./claims.ts')).renewClaim(input.claim)
  const subscription=await inspectSubscription(plan)
  const records=await helpers.readRuns(root)
  // Qualification is supplied by its owner as an immutable prior/prepared run reference.
  // It is never synthesized from a successful version/auth check.
  const seeds=(await helpers.readQualifiedExecutions(root)).filter(r=>r.execution&&r.runtimeBinding&&r.configurationDigest&&r.execution.harness===stage.harness&&r.execution.model===stage.model&&r.execution.effort===stage.effort&&r.execution.accountRef===subscription.accountRef&&r.execution.harnessVersion===metadata.version)
  let seed:import('./runs.ts').QualifiedExecutionRecord|undefined,coverage:import('./shared-claims.ts').RecoveryEnvelope['remoteEffectCoverage']={kind:'unmanaged-possible',reasonCode:'execution-coverage-unqualified'}
  for(const candidate of seeds){
    try{await helpers.verifyInstalledRuntimeBinding(candidate.runtimeBinding!,dirname(dirname(fileURLToPath(import.meta.url))),fileURLToPath(import.meta.url));if(await helpers.executionConfigurationDigest({binding:candidate.runtimeBinding!,execution:candidate.execution!,plan,metadata})!==candidate.configurationDigest)continue;const target=await verifiedSharedTarget(run.repo,config,undefined,gh);const reader={...target,verifyEvidence:async(ref:import('./shared-claims.ts').EvidenceRef,payload:import('./shared-claims.ts').RecoveryEvidencePayload|null)=>{if(owner.canonical(ref)!==owner.canonical(candidate.execution.qualification)||payload===null)throw Error('qualification reference differs');helpers.verifyExecutionQualification(payload,candidate.execution,candidate.runtimeBinding,candidate.configurationDigest)}};const evidence=await owner.resolveEvidence(reader,candidate.execution.qualification);if(evidence?.kind==='execution-qualification'&&evidence.result==='qualified')coverage={kind:'qualified-managed-only',qualification:candidate.execution.qualification};seed=candidate;break}catch{/* A stale/unqualified seed grants no execution. */}
  }
  if(!seed)throw Error('matching qualified subscription/runtime evidence unavailable')
  const readJson=(args:string[])=>boundedGhJson(gh,args,readBudget())
  const authorities=await helpers.bindVerifiedApprovalSources(input.approvalBindings,input.authorityReads,readJson,gh)
  const recordBinding=input.recordBinding?(await helpers.bindVerifiedApprovalSources([input.recordBinding],input.authorityReads,readJson,gh))[0]!:null
  const prepared=records.filter(r=>r.repo===run.repo&&r.issue===run.issue&&r.state==='prepared'&&canonicalWire(r.approvalBindings)===canonicalWire(authorities)&&canonicalWire(r.approvalRefs)===canonicalWire(input.bindings)&&canonicalWire(r.dispatchRequest??{commentId:null,reactionId:null})===canonicalWire({commentId:run.commentId,reactionId:run.reactionId}))
  if(prepared.length>1)throw Error('multiple prepared contexts require reconciliation')
  if(prepared.length===1){
    const prior=prepared[0]!
    if(prior.pid!==null||existsSync(helpers.runAttemptDirectory(root,prior))||prior.checkout!==plan.cwd||canonicalWire(prior.execution)!==canonicalWire(seed.execution)||canonicalWire(prior.recordBinding)!==canonicalWire(recordBinding)
      ||canonicalWire(prior.authorityRequest)!==canonicalWire(input.authorityRequest??{kind:'native'}))throw Error('prepared context changed; verified recovery required')
    const freshIntent=await(await import('./checkpoints.ts')).checkpointIntentFromApproval(prior,config)
    if(input.parent&&input.authorityRequest?.kind==='consolidated'&&(!freshIntent||canonicalWire(freshIntent.approvalRequest)!==canonicalWire(input.checkpointRequest)||canonicalWire(freshIntent)!==canonicalWire(prior.checkpointIntent)))throw Error('prepared child checkpoint request changed; local work retained')
    return prior
  }
  const branch=spawnSync('git',['symbolic-ref','--short','HEAD'],{cwd:plan.cwd,encoding:'utf8'}),head=spawnSync('git',['rev-parse','HEAD'],{cwd:plan.cwd,encoding:'utf8'})
  if(branch.status!==0||head.status!==0||!head.stdout.trim())throw Error('run source identity unavailable')
  const host=(await (await import('./machine-identity.ts')).readHostBinding()).digest
  const target=await verifiedSharedTarget(run.repo,config,undefined,gh),machine=sharedMachineContexts.get(target)!
  const selection=await helpers.approvedTaskSelection(input.bindings as import('./shared-claims.ts').ArtifactRef[],input.authorityReads,run.stage,{},input.authorityRequest?.kind==='consolidated'?input.authorityRequest.requested.taskIds:undefined)
  const runInput:RunInput={root,repo:run.repo,issue:run.issue,parent:input.parent?.run.issue??null,checkout:plan.cwd,branch:branch.stdout.trim(),baseSha:input.authorityRequest?.kind==='consolidated'?input.authorityRequest.requested.baseSha:head.stdout.trim(),headSha:head.stdout.trim(),stage:run.stage,harness:stage.harness,model:stage.model,effort:stage.effort,execution:seed.execution!,runtimeBinding:seed.runtimeBinding,configurationDigest:seed.configurationDigest,approvalBindings:authorities,recordBinding,approvalRefs:input.bindings as import('./shared-claims.ts').ArtifactRef[],policyDigest:policy.effective?.policyDigest??'',claimToken:input.claim.token,startedAt:new Date().toISOString(),taskKey:{repo:run.repo,issue:run.issue,taskId:selection.taskId,scopeDigest:selection.scopeDigest},approvedTaskIds:selection.approvedTaskIds,activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:subscription.accountRef,waitReason:null,hostBindingDigest:host,machine:{id:machine.id,installationId:machine.installationId,sessionId:input.parent?.run.machine?.id===machine.id?input.parent.run.machine.sessionId:dispatcherSessionId,hostBindingDigest:host},sharedClaim:null,checkpoint:null,remoteEffectCoverage:coverage,authorityRequest:input.authorityRequest??{kind:'native'},handbackIntent:{id:'run-handback',approvalBindings:authorities},dispatchRequest:{commentId:run.commentId,reactionId:run.reactionId}}
  {const intent=await(await import('./checkpoints.ts')).checkpointIntentFromApproval({...runInput,runId:runInput.runId??randomUUID(),schemaVersion:2,generation:1,state:'prepared',terminationCause:null,exitCode:null,pid:null,processStartId:null,processGroupId:null,processIdentity:null,finishedAt:null,pendingDelivery:[]} as RunRecord,config)
   if(input.parent&&input.authorityRequest?.kind==='consolidated'&&(!intent||canonicalWire(intent.approvalRequest)!==canonicalWire(input.checkpointRequest)))throw Error('exact child checkpoint request unavailable; prepared checkout retained')
   if(intent)runInput.checkpointIntent=intent}
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

export async function sharedClaimForRun(run:RunRecord,config:FactoryConfig,gh:TickDeps['gh']=ghText):Promise<SharedClaim>{
  if(!run.sharedClaim||!run.machine)throw Error('run has no shared claim')
  // Re-resolve the target for every operation. Its callbacks capture machine
  // enrollment, repository scope, installation, login and host authorization;
  // retaining an older target would retain older authority too.
  const target=await verifiedSharedTarget(run.repo,config,run.runId,gh),resolved=sharedMachineContexts.get(target),owner=await import('./shared-claims.ts'),snapshot=await owner.readCoordination(target),task=snapshot.tasks[run.sharedClaim.taskKey]
  if(!resolved||resolved.id!==run.machine.id||resolved.installationId!==run.machine.installationId||resolved.hostBindingDigest!==run.machine.hostBindingDigest||!resolved.allowedRepositories.includes(run.repo))throw Error('current shared run machine authorization differs')
  if(!task||task.runId!==run.runId||task.ownerToken!==run.sharedClaim.ownerToken||task.generation!==run.sharedClaim.generation||task.machineId!==run.machine.id||task.installationId!==run.machine.installationId||task.sessionId!==run.machine.sessionId)throw Error('current shared run owner differs')
  sharedTaskContexts.set(target,task)
  return{taskKey:task.taskKey,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId,runId:task.runId,stateCommit:snapshot.head,target}
}
export async function checkpointPolicyEnabled(repo:string,config:FactoryConfig,gh:TickDeps['gh']=ghText):Promise<boolean>{const target=await verifiedSharedTarget(repo,config,undefined,gh);return sharedMachineContexts.get(target)!.defaults.checkpoints==='task-branch'}

export async function configuredRunStatusController(run:RunRecord,config:FactoryConfig):Promise<import('./runs.ts').RunStatusController>{
  const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),budget=readBudget()
  const actor=await boundedGhJson<{login:string}>(ghText,['api','user'],budget)
  const repository=await boundedGhJson<{node_id:string}>(ghText,['api',`repos/${run.repo}`],budget)
  const issue=await boundedGhJson<{node_id:string}>(ghText,['api',`repos/${run.repo}/issues/${run.issue}`],budget)
  if(!actor.login||!repository.node_id||!issue.node_id)throw Error('handback target identity unavailable')
  const controller:import('./runs.ts').RunStatusController={gh:ghText,senderLogin:actor.login,verifyAuthority:async(record,intentRef)=>{
    if(record.handbackIntent?.id!==intentRef||owner.canonical(record.handbackIntent.approvalBindings)!==owner.canonical(record.approvalBindings))throw Error('reviewed handback intent unavailable')
    await verifyDispatchRunAuthority(record,config)
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
      await verifyDispatchRunAuthority(record,config,'launch')
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
  if(!record.finishedAt)throw Error('current terminal finish time unavailable')
  const context={repo:record.repo,ts:record.finishedAt,stage:record.stage,model:record.model,effort:record.effort,human:record.taskOwner,worktree:record.checkout,parent:record.parent,terminationCause:cause}
  let captured:StatsRecord
  try{captured=record.harness==='claude'?fromClaudeHeadless(claudeHeadlessResult(stdout),context):fromCodexExec(stdout.split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}}),context)}catch{captured=normalizeRecord({...context,outcome:cause==='succeeded'?'complete':'failed'})}
  captured.issue=record.issue;captured.session_id=record.vendorSessionId??null;captured.duration_s=record.attemptElapsedMs==null?null:record.attemptElapsedMs/1000
  await helpers.atomicRunFile(join(helpers.runAttemptDirectory(root,record),'capture.json'),captured)
  if(record.waitReason==='subscription-quota')return
  const previous:Array<Pick<StatsRecord,'turns'|'tool_calls'|'subagents'|'cost_usd'|'tokens'>>=[]
  for(const attempt of helpers.terminalCaptureAttempts(record)){
    try{previous.push(JSON.parse(await helpers.readPrivateRunFile(join(root,record.runId,'attempts',attempt.id,'capture.json'))) as StatsRecord)}catch{previous.push({turns:null,tool_calls:null,subagents:null,cost_usd:null,tokens:{in:null,out:null,cache_read:null,cache_write:null}})}
  }
  for(const field of ['turns','tool_calls','subagents','cost_usd'] as const){const values=[...previous,captured].map(r=>r[field]);captured[field]=values.every(v=>typeof v==='number'&&Number.isFinite(v))?values.reduce<number>((sum,v)=>sum+v!,0):null}
  for(const field of ['in','out','cache_read','cache_write'] as const){const values=[...previous,captured].map(r=>r.tokens[field]);captured.tokens[field]=values.every(v=>typeof v==='number'&&Number.isFinite(v))?values.reduce<number>((sum,v)=>sum+v!,0):null}
  const segmentElapsed=helpers.terminalCaptureElapsedMs(record)
  captured.duration_s=segmentElapsed===null?null:segmentElapsed/1000
  await helpers.prepareTerminalCapture(root,record.runId,captured)
}

async function finishDurableSharedRun(claim:SharedClaim,outcome:RunOutcome|null,config:FactoryConfig,gh:TickDeps['gh']=ghText):Promise<TaskTransition>{
  const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),root=runsRoot(config.home)
  let record=await helpers.readRun(root,claim.runId)
  if(!record.sharedClaim||record.sharedClaim.taskKey!==claim.taskKey||record.sharedClaim.generation!==claim.generation||record.sharedClaim.ownerToken!==claim.ownerToken||record.machine?.id!==claim.machineId||record.machine.installationId!==claim.installationId||record.machine.sessionId!==claim.sessionId||outcome?.runId&&outcome.runId!==record.runId)throw Error('shared finish identity mismatch')
  if(record.waitReason==='subscription-quota'||record.terminationCause==='termination-unconfirmed'||!await helpers.verifyLocalRunStopped(record))return{kind:'block',stopProof:null}
  try{await(await import('./checkpoints.ts')).flushRunCheckpoint(record,config);await flushRunHandback(record,config)}catch{/* Unresolved code/control delivery retains ownership below. */}
  record=await helpers.readRun(root,record.runId);claim=await sharedClaimForRun(record,config,gh)
  let snapshot=await owner.readCoordination(claim.target);const task=snapshot.tasks[claim.taskKey]
  if(!task?.recovery)return{kind:'block',stopProof:null}
  if(task.schemaVersion===2){
    const accepted=new Set(task.recovery.joins.filter(join=>join.state==='accepted').map(join=>join.childRunId))
    for(const child of Object.values(snapshot.tasks).filter(row=>row.parentTaskKey===task.taskKey&&accepted.has(row.runId))){
      const scope=child.acceptedScopes.find(row=>row.scopeDigest===child.scopeDigest)
      if(!scope||!child.stopProof)continue
      const value=createHash('sha256').update(`VegaFactory/recovered-accepted-complete/v1\n${task.successionOperationId}\n${child.taskKey}`).digest('hex'),operationId=`${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-${((Number.parseInt(value[16]!,16)&3)|8).toString(16)}${value.slice(17,20)}-${value.slice(20,32)}`
      const completed=await transitionSharedTask({claim:groupClaim(child,snapshot.head,claim.target),operationId,transition:{kind:'complete',stopProof:child.stopProof,acceptedScope:scope.receipt}})
      if(completed.kind!=='owned')return{kind:'block',stopProof:null}
      snapshot=await owner.readCoordination(claim.target)
    }
  }
  // Physical absence permits a stop attestation; unresolved effects still retain
  // task ownership and prevent accepted completion or automatic transfer.
  const reconciled=task.recovery.remoteEffectCoverage.kind!=='unmanaged-possible'&&!task.recovery.effects.some(e=>e.kind!=='telemetry-push'&&e.state!=='acknowledged'&&e.state!=='cancelled-before-send')&&!record.pendingDelivery.some(p=>p.kind!=='telemetry-capture'&&p.status!=='acknowledged')&&!Object.values(snapshot.tasks).some(row=>row.parentTaskKey===task.taskKey)
  if(record.stopProof){await helpers.verifySharedStopProof(record.stopProof,task,claim.target,record);if(reconciled&&record.acceptedScopeRef&&record.terminationCause==='succeeded'){await owner.resolveEvidence(claim.target,record.acceptedScopeRef);return{kind:'complete',stopProof:record.stopProof,acceptedScope:record.acceptedScopeRef}}return{kind:'stop',stopProof:record.stopProof}}
  const allowedActionIds=[...new Set([record.handbackIntent?.id,record.checkpointIntent?.id,record.authorityRequest?.kind==='consolidated'?record.authorityRequest.requested.actionId:null].filter((id):id is string=>!!id))].sort()
  const payload:import('./shared-claims.ts').RecoveryEvidencePayload={schemaVersion:2,kind:'effect-reconciliation',runId:record.runId,scopeDigest:record.taskKey.scopeDigest,approvalBindings:record.approvalBindings,allowedActionIds,checkedEffectIds:task.recovery.effects.filter(e=>e.state==='acknowledged'||e.state==='cancelled-before-send').map(e=>e.operationId).sort(),inspector:{kind:'qualified-adapter',identityRef:record.machine!.id},result:reconciled?'complete':'unresolved',reasonCode:'owned-process-group-stopped'}
  // Freeze the request with its operation identity before publishing. A lost
  // acknowledgment must not rebind that ID to later delivery facts.
  record=await helpers.updateRun(root,record.runId,r=>({stopReceiptIds:r.stopReceiptIds??{receipt:randomUUID(),transition:randomUUID()},stopReceiptPayload:r.stopReceiptPayload??payload}))
  const receipt=await owner.publishRecoveryReceipt({claim,operationId:record.stopReceiptIds!.receipt,payload:record.stopReceiptPayload!})
  const identity=await processIdentity(),bootId=record.processIdentity?.bootId??identity.bootId
  const proof:import('./shared-claims.ts').StopProof={kind:bootId===identity.bootId?'process-exit':'verified-reboot',machineId:record.machine!.id,installationId:record.machine!.installationId,sessionId:record.machine!.sessionId,hostBindingDigest:record.machine!.hostBindingDigest,bootIdDigest:createHash('sha256').update(`VegaFactory/boot/v1\n${bootId}`).digest('hex'),runIds:[record.runId],generation:claim.generation,observedAt:record.finishedAt??new Date().toISOString(),evidenceRef:receipt.reference}
  await helpers.verifySharedStopProof(proof,task,claim.target,record)
  await helpers.updateRun(root,record.runId,()=>({stopProof:proof}))
  if(reconciled&&record.acceptedScopeRef&&record.terminationCause==='succeeded'){await owner.resolveEvidence(claim.target,record.acceptedScopeRef);return{kind:'complete',stopProof:proof,acceptedScope:record.acceptedScopeRef}}
  return{kind:'stop',stopProof:proof}
}

async function resumeSavedQuotaRun(saved:RunRecord,config:FactoryConfig,options:Parameters<typeof executeRun>[3]):Promise<RunOutcome>{
  const helpers=await import('./runs.ts'),entry=config.repos.find(e=>e.repo===saved.repo)
  if(!entry||!saved.execution||saved.cancelRequestedAt||!saved.worktreeDigest||!await helpers.verifyLocalRunStopped(saved)||await helpers.worktreeFingerprint(saved.checkout)!==saved.worktreeDigest)throw Error('saved quota checkout/termination requires verified recovery')
  await verifyDispatchRunAuthority(saved,config,'launch')
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

// #144 recovery reads immutable remote facts before constructing any target-local
// attempt. No old-home paths, vendor memories or latest-parent defaults enter it.
export interface RemoteRecoveryMaterial {
  stateCommit:string;task:import('./shared-claims.ts').TaskRecord
  artifacts:import('./shared-claims.ts').ArtifactRef[];briefBody:string;planBody:string;title:string
  authorityRequest:import('./runs.ts').RunAuthorityRequest
  checkpointRequest:NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>|null
  packet:Record<string,unknown>;evidence:Array<{ref:import('./shared-claims.ts').EvidenceRef;payload:import('./shared-claims.ts').RecoveryEvidencePayload|null}>
  children:Array<{task:import('./shared-claims.ts').TaskRecord;stateCommit:string;authorityRequest:import('./runs.ts').RunAuthorityRequest;checkpointRequest:NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>|null}>
  historicalParents:Array<{task:import('./shared-claims.ts').TaskRecord;stateCommit:string}>
  sourceRefs:Array<{id:string;updatedAt:string;bodySha256:string}>;unavailableContext:Array<'original-private-notes'|'original-learning-context'>;blocks:string[]
}

type StoppedGroupDecision={action:string;reason:string;request:import('./shared-claims.ts').GroupSuccessionRequest|null}
type StoppedGroupRecoveryDeps={
 evaluate:(input:unknown)=>StoppedGroupDecision
 recover:(input:{machine:EffectiveMachine;session:MachineSession;request:import('./shared-claims.ts').GroupSuccessionRequest})=>Promise<import('./shared-claims.ts').GroupSuccessionResult>
 read:(target:import('./shared-claims.ts').CoordinationTarget)=>Promise<import('./shared-claims.ts').CoordinationSnapshot>
 inspect:(target:import('./shared-claims.ts').CoordinationTarget,input:{operationId:string;parent:import('./shared-claims.ts').ParentClaimBinding})=>Promise<import('./shared-claims.ts').GroupSuccessionInspection>
}
const groupBinding=(task:Pick<import('./shared-claims.ts').TaskRecord,'taskKey'|'runId'|'generation'|'ownerToken'|'machineId'|'installationId'|'sessionId'>):import('./shared-claims.ts').ParentClaimBinding=>({taskKey:task.taskKey,runId:task.runId,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId})
const groupCandidate=(task:import('./shared-claims.ts').TaskRecord):VerifiedCandidate=>({host:task.host,repo:task.repo,issue:task.issue,repositoryNodeId:task.repositoryNodeId,issueNodeId:task.issueNodeId,scopeDigest:task.scopeDigest,approvalDigest:task.approvalDigest,approvalBindings:task.approvalBindings,runId:task.runId,stage:task.stage,paths:task.paths,resources:task.resources,independent:task.independent,parentTaskKey:task.parentTaskKey,parentBinding:task.parentBinding??null,approvedTaskIds:task.approvedTaskIds})
const stoppedMaterialFacts=(row:RemoteRecoveryMaterial)=>({stateCommit:row.stateCommit,task:row.task,artifacts:row.artifacts,briefBody:row.briefBody,planBody:row.planBody,title:row.title,authorityRequest:row.authorityRequest,checkpointRequest:row.checkpointRequest,packet:row.packet,evidence:row.evidence,children:row.children.map(child=>({candidate:groupCandidate(child.task),authorityRequest:child.authorityRequest,checkpointRequest:child.checkpointRequest})).sort((a,b)=>a.candidate.runId.localeCompare(b.candidate.runId)),sourceRefs:row.sourceRefs,unavailableContext:row.unavailableContext,blocks:row.blocks})

// Every callback made by #137 re-runs the complete source/authority/private
// reconstruction proof. Equality is only the final comparison with the frozen
// intent; it never substitutes for the fresh reads.
async function verifyFreshStoppedGroup(context:ActiveStoppedGroupContext,actual:{candidate?:VerifiedCandidate;current?:EffectiveMachine;session?:MachineSession;task?:import('./shared-claims.ts').TaskRecord;transition?:TaskTransition;ref?:import('./shared-claims.ts').EvidenceRef;payload?:import('./shared-claims.ts').RecoveryEvidencePayload|null;group?:{parent:import('./shared-claims.ts').TaskRecord;members:Array<{task:import('./shared-claims.ts').TaskRecord;candidate:VerifiedCandidate}>;groupPlan:import('./shared-claims.ts').ArtifactRef;groupsDigest:string;machine:EffectiveMachine;session:MachineSession}}):Promise<void>{
 const expected=new Map(context.request.members.map(row=>[row.expected.taskKey,row]))
 const sessionFacts=(value:MachineSession)=>({machineId:value.machineId,installationId:value.installationId,sessionId:value.sessionId,hostBindingDigest:value.hostBindingDigest,bootIdDigest:value.bootIdDigest,identity:value.identity})
 const compareActual=()=>{
  if(actual.candidate){const row=context.request.members.find(member=>member.candidate.runId===actual.candidate!.runId);if(!row||canonicalWire(row.candidate)!==canonicalWire(actual.candidate)||canonicalWire(actual.current)!==canonicalWire(context.machine)||!actual.session||canonicalWire(sessionFacts(actual.session))!==canonicalWire(sessionFacts(context.session)))throw Error('stopped group candidate changed')}
  if(actual.transition){const row=actual.task&&expected.get(actual.task.taskKey);if(!row||actual.transition.kind!=='stop'||canonicalWire(row.expected)!==canonicalWire(groupBinding(actual.task!))||canonicalWire(actual.task!.stopProof)!==canonicalWire(actual.transition.stopProof))throw Error('stopped group stop verification changed')}
  if(actual.group){const value=actual.group;if(value.parent.taskKey!==context.request.parentTaskKey||canonicalWire(value.groupPlan)!==canonicalWire(context.request.groupPlan)||value.groupsDigest!==context.request.groupsDigest||canonicalWire(value.machine)!==canonicalWire(context.machine)||canonicalWire(sessionFacts(value.session))!==canonicalWire(sessionFacts(context.session))||value.members.length!==context.request.members.length)throw Error('stopped group verifier input changed');for(const row of value.members){const frozen=expected.get(row.task.taskKey);if(!frozen||canonicalWire(groupBinding(row.task))!==canonicalWire(frozen.expected)||canonicalWire(row.candidate)!==canonicalWire(frozen.candidate))throw Error('stopped group verifier member changed')}}
 }
 compareActual()
 {
  const freshRows:RemoteRecoveryMaterial[]=[]
  for(const frozen of context.materials){
   const fresh=await inspectRemoteRecoveryRecord({repo:frozen.task.repo,taskKey:frozen.task.taskKey,config:context.config},{head:frozen.stateCommit,task:frozen.task},{target:context.session.target,gh:context.gh,source:context.source},frozen.task.stopProof??undefined)
   if(fresh.blocks.length)throw Error('stopped group fresh material blocked: '+fresh.blocks.join('; '))
   assertRemoteRecoveryMaterial(fresh)
   if(canonicalWire(stoppedMaterialFacts(fresh))!==canonicalWire(stoppedMaterialFacts(frozen)))throw Error('stopped group fresh source, authority or evidence changed')
   for(const historical of fresh.historicalParents){const expectedParent=context.request.members.find(row=>row.expected.taskKey===historical.task.taskKey);if(!expectedParent||canonicalWire(groupCandidate(historical.task))!==canonicalWire(expectedParent.candidate))throw Error('stopped group historical parent changed')}
   const checkout=context.checkouts.get(frozen.task.taskKey);if(!checkout)throw Error('stopped group checkout unavailable')
   const setup=await context.setup(fresh,checkout,context.config,context.session.target,context.localClaim,context.session.sessionId),digest=createHash('sha256').update(canonicalWire(setup)).digest('hex')
   if(setup.receiver.machine.id!==context.machine.id||setup.receiver.machine.installationId!==context.machine.installationId||setup.receiver.machine.sessionId!==context.session.sessionId||context.setupDigests.get(frozen.task.taskKey)!==digest)throw Error('stopped group receiver setup changed')
   freshRows.push(fresh)
  }
  if(actual.ref){
   if(actual.ref.kind==='github-comment'){const sources=freshRows.flatMap(row=>row.task.approvalBindings.map(binding=>binding.source)).filter(ref=>canonicalWire(ref)===canonicalWire(actual.ref));if(!sources.length||actual.payload!==null)throw Error('stopped group approval evidence changed')}
   else{const proof=freshRows.flatMap(row=>row.evidence).filter(row=>canonicalWire(row.ref)===canonicalWire(actual.ref));if(!proof.length||proof.some(row=>canonicalWire(row.payload)!==canonicalWire(actual.payload)))throw Error('stopped group evidence changed: '+actual.ref.operationId+':'+proof.length)}
  }
 }
}

// The pure helper decides whether the complete same-head set is admissible. This
// runtime boundary owns the one succession attempt and treats its response as
// advisory until the immutable receipt and every current member are read back.
export async function recoverVerifiedStoppedGroup(input:{evaluation:unknown;machine:EffectiveMachine;session:MachineSession;evidence:Array<{ref:import('./shared-claims.ts').EvidenceRef;payload:import('./shared-claims.ts').RecoveryEvidencePayload|null}>},overrides:Partial<StoppedGroupRecoveryDeps>={}):Promise<
 | {kind:'wait'|'refused'|'busy';reason:string}
 | {kind:'owned';reason:string;lostResponse:boolean;reference:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>;parent:import('./shared-claims.ts').ParentClaimBinding;children:import('./shared-claims.ts').ParentClaimBinding[];inspection:Extract<import('./shared-claims.ts').GroupSuccessionInspection,{kind:'verified'}>}
>{
 const owner=await import('./shared-claims.ts'),core=await recoveryScript(),deps:StoppedGroupRecoveryDeps={evaluate:value=>core.evaluateStoppedGroupRecovery(value) as StoppedGroupDecision,recover:owner.recoverStoppedGroup,read:owner.readCoordination,inspect:owner.inspectGroupSuccession,...overrides}
 const decision=deps.evaluate(structuredClone(input.evaluation)),request=decision.request
 if(decision.action!=='recover-stopped-group'||!request)return{kind:decision.action==='wait'?'wait':'refused',reason:decision.reason}
 const target=input.session.target,members=new Map(request.members.map(row=>[row.expected.taskKey,row]))
 if(members.size!==request.members.length||input.machine.id!==input.session.machineId||input.machine.installationId!==input.session.installationId)throw Error('stopped group receiver identity differs')
 const attempted=await deps.recover({machine:input.machine,session:input.session,request})
  if(attempted.kind==='busy'||attempted.kind==='refused')return{kind:attempted.kind,reason:attempted.reason}
  const snapshot=await deps.read(target),parentTask=snapshot.tasks[request.parentTaskKey]
  if(!parentTask)throw Error('stopped group current parent unavailable')
  const parent=groupBinding(parentTask),inspection=await deps.inspect(target,{operationId:request.operationId,parent})
  if(inspection.kind!=='verified')throw Error('stopped group receipt/current owner readback unavailable: '+inspection.reason)
  if(inspection.receipt.operationId!==request.operationId||inspection.receipt.parentTaskKey!==request.parentTaskKey||attempted.kind==='owned'&&canonicalWire(attempted.reference)!==canonicalWire(inspection.reference))throw Error('stopped group receipt identity differs')
  const receiptAfter=new Map(inspection.receipt.members.map(row=>[row.after.taskKey,row.after])),current=new Map(inspection.currentMembers.map(row=>[row.current.taskKey,row.current]))
  if(receiptAfter.size!==request.members.length||current.size!==request.members.length||[...members.keys()].some(key=>!receiptAfter.has(key)||!current.has(key)))throw Error('stopped group current member set differs')
  for(const key of members.keys()){
   const task=snapshot.tasks[key],seen=current.get(key)!,after=receiptAfter.get(key)!
   if(!task||canonicalWire(task)!==canonicalWire(seen)||canonicalWire(groupBinding(inspection.currentMembers.find(row=>row.current.taskKey===key)!.initial))!==canonicalWire(after))throw Error('stopped group current member readback differs')
  }
  if(parentTask.schemaVersion!==2||!['claimed','running'].includes(parentTask.state)||parentTask.successionOperationId!==request.operationId)throw Error('stopped group current parent is not launch-ready')
  const children=[...members.keys()].filter(key=>key!==request.parentTaskKey).map(key=>snapshot.tasks[key]!)
  if(children.some(task=>task.schemaVersion!==2||!['recovery-queued','running','completed'].includes(task.state)||task.parentTaskKey!==request.parentTaskKey||task.successionOperationId!==request.operationId))throw Error('stopped group current child is not recovery-queued')
 return{kind:'owned',reason:'exact group succession/current owners verified',lostResponse:attempted.kind==='ambiguous',reference:inspection.reference,parent,children:children.map(groupBinding),inspection}
}
const verifiedRecoveryMaterials=new WeakMap<RemoteRecoveryMaterial,string>()
export function assertRemoteRecoveryMaterial(material:RemoteRecoveryMaterial):void {
 if(material.blocks.length||verifiedRecoveryMaterials.get(material)!==createHash('sha256').update(canonicalWire(material)).digest('hex'))throw Error('remote recovery material is unverified or changed')
}

// Discover the exact parent/direct-child set from separately verified remote
// materials. Each member's full reader must have succeeded; a parent summary is
// not allowed to vouch for a child's stop, authority, effects, or checkpoint.
export async function recoverStoppedGroupMaterials(input:{operationId:string;parentTaskKey:string;materials:RemoteRecoveryMaterial[];machine:EffectiveMachine;session:MachineSession;runtime?:{config:FactoryConfig;gh:TickDeps['gh'];localClaim:Claim;checkouts:Map<string,string>;setupDigests:Map<string,string>;setup:typeof receivingExecutionSetup;source?:RemoteRecoveryTransport['source']}},overrides:Partial<StoppedGroupRecoveryDeps>={}):ReturnType<typeof recoverVerifiedStoppedGroup>{
 for(const material of input.materials)assertRemoteRecoveryMaterial(material)
 const parentRows=input.materials.filter(row=>row.task.taskKey===input.parentTaskKey&&row.task.parentTaskKey===null)
 if(parentRows.length!==1)throw Error('unique verified stopped group parent unavailable')
 const parent=parentRows[0]!,source=fileURLToPath(import.meta.url).endsWith('.ts'),planner=await import(new URL(source?'../../../skills/dev/dev-plan/scripts/plan-lint.mjs':'../skill/dev-plan/scripts/plan-lint.mjs',import.meta.url).href) as typeof import('../../../skills/dev/dev-plan/scripts/plan-lint.mjs')
 const approvedGroups=planner.parseIndependentGroups(parent.planBody).map(group=>({id:group.id,members:group.members,files:group.files})),groupPlan=parent.artifacts.find(ref=>ref.kind==='plan')
 if(!approvedGroups.length||!groupPlan)throw Error('approved stopped group declaration unavailable')
 const children=input.materials.filter(row=>row!==parent)
 if(children.some(row=>row.task.parentTaskKey!==parent.task.taskKey)||children.length!==approvedGroups.length)throw Error('complete verified stopped group material required')
 const heads=[...new Set(input.materials.map(row=>row.stateCommit))]
 if(heads.length!==1)throw Error('stopped group materials do not share one state head')
 const owner=await import('./shared-claims.ts'),groupsDigest=owner.sha256(owner.canonical(approvedGroups))
 const evaluation={operationId:input.operationId,expectedHead:heads[0],parentTaskKey:input.parentTaskKey,groupPlan,groupsDigest,approvedGroups,members:input.materials.map(material=>({stateCommit:material.stateCommit,task:material.task,expected:groupBinding(material.task),candidate:groupCandidate(material.task)}))}
 const core=await recoveryScript(),decision=(overrides.evaluate??(value=>core.evaluateStoppedGroupRecovery(value) as StoppedGroupDecision))(structuredClone(evaluation))
 let session=input.session,context:ActiveStoppedGroupContext|null=null
 if(input.runtime&&decision.action==='recover-stopped-group'&&decision.request){
  // One repository may recover several independent groups concurrently. Give
  // each succession its own controller object so verifier calls cannot observe
  // or clear another operation's frozen context on the shared provider target.
  const base=input.session.target
  const target:import('./shared-claims.ts').CoordinationTarget={...base,
   verifyCandidate:(candidate,current,actualSession)=>stoppedGroupSerial(base,'verify',async()=>{if(!context)throw Error('stopped-group verification context unavailable');await verifyFreshStoppedGroup(context,{candidate,current,session:actualSession})}),
   verifyTransition:(task,transition)=>stoppedGroupSerial(base,'verify',async()=>{if(!context)throw Error('stopped-group verification context unavailable');await verifyFreshStoppedGroup(context,{task,transition})}),
   verifyEvidence:(ref,payload)=>stoppedGroupSerial(base,'verify',async()=>{if(!context)throw Error('stopped-group verification context unavailable');await verifyFreshStoppedGroup(context,{ref,payload})}),
   verifyGroupSuccession:group=>stoppedGroupSerial(base,'verify',async()=>{if(!context)throw Error('stopped-group verification context unavailable');await verifyFreshStoppedGroup(context,{group});return{maxChildren:Math.min(3,context.request.members.length-1)}}),
  }
  session={...input.session,target,localRoot:target.localRoot}
  sharedMachineContexts.set(target,input.machine)
  context={request:decision.request,materials:input.materials,config:input.runtime.config,gh:input.runtime.gh,localClaim:input.runtime.localClaim,checkouts:input.runtime.checkouts,setupDigests:input.runtime.setupDigests,setup:input.runtime.setup,source:input.runtime.source,machine:input.machine,session}
 }
 const recovered=await recoverVerifiedStoppedGroup({evaluation,machine:input.machine,session,evidence:input.materials.flatMap(row=>row.evidence)},{...overrides,evaluate:()=>decision})
 if(recovered.kind==='owned'&&context)await stoppedGroupSerial(input.session.target,'verify',()=>verifyFreshStoppedGroup(context!,{}))
 return recovered
}
const recoveryScript=async()=>{
  const source=fileURLToPath(import.meta.url).endsWith('.ts')
  return await import(new URL(source?'../../../skills/dev/dev-implement/scripts/recovery.mjs':'../skill/dev-implement/scripts/recovery.mjs',import.meta.url).href) as typeof import('../../../skills/dev/dev-implement/scripts/recovery.mjs')
}
function recoveryFiles(body:string,ids:string[]):string[] {
 const tasks=[...body.matchAll(/^-\s*\[[ x]\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->.*$/gim)]
 const result=tasks.flatMap((row,index)=>ids.includes(row[1]!)?[...(body.slice(row.index,tasks[index+1]?.index).split('\n').find(line=>/^\s*- Files\s/.test(line))??'').matchAll(/`([^`]+)`/g)].map(row=>row[1]!):[])
 if(!result.length||result.some(path=>path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>part==='..'||part==='.')||/[\0\r\n]/.test(path)))throw Error('exact approved recovery files unavailable')
 return [...new Set(result)]
}
async function recoveryAuthority(task:import('./shared-claims.ts').TaskRecord,config:FactoryConfig,gh:TickDeps['gh']) {
 const helpers=await import('./runs.ts'),core=await recoveryScript(),{approval,preflight}=await helpers.approvalTools(),reads:unknown[]=[],budget=readBudget()
 const readJson=async(args:string[])=>{const row=await boundedGhJson<any>(gh,args,budget);reads.push(row);return row}
 const entry=config.repos.find(row=>row.repo===task.repo);if(!entry)throw Error('recovery repository is not configured')
 const devMd=await readFile(join(entry.path,'.vegastack/dev.md'),'utf8'),resolved=loadConfiguredPolicy({home:config.home,repo:task.repo,devMd,settingsPath:config.settingsPath})
 if(!resolved.ok)throw Error('current recovery policy unavailable')
 const policy=repoPolicyFromEffective(resolved),brief=await readJson(['api',`repos/${task.repo}/issues/${task.issue}`]),comments=await approval.readPages(readJson,['api',`repos/${task.repo}/issues/${task.issue}/comments`])
 if(brief.node_id!==task.issueNodeId)throw Error('recovery issue identity changed')
 const sources=[]
 for(const wire of task.approvalBindings){
  const tuple=core.localApprovalBinding(wire)
  const node=await readJson(['api','graphql','-f','query=query($id:ID!){node(id:$id){... on Issue{id number repository{id nameWithOwner}}}}','-F','id='+wire.source.issueNodeId])
  const subject=node?.data?.node
  if(subject?.id!==wire.source.issueNodeId||subject.repository?.id!==wire.source.repositoryId||subject.repository.nameWithOwner!==task.repo||!Number.isSafeInteger(subject.number)||subject.number<=0)throw Error('canonical recovery authority locator differs')
  const direct=await readJson(['api',`repos/${task.repo}/issues/comments/${tuple.commentId}`])
  const history=await approval.readPages(readJson,['api',`repos/${task.repo}/issues/${subject.number}/comments`])
  if(direct.id!==tuple.commentId||createHash('sha256').update(direct.body).digest('hex')!==tuple.bodySha256||direct.issue_url!==`https://api.github.com/repos/${task.repo}/issues/${subject.number}`||history.filter((row:any)=>row.id===direct.id&&row.body===direct.body).length!==1)throw Error('canonical recovery source changed or inaccessible')
  sources.push({wire,tuple,subject,comment:direct,record:approval.parseApproval(direct)})
 }
 const consolidated=sources.filter(row=>row.record.kind==='consolidated')
 let checked:any,authorityRequest:import('./runs.ts').RunAuthorityRequest={kind:'native'},checkpointRequest:NonNullable<import('./checkpoints.ts').CheckpointIntent['approvalRequest']>|null=null
 if(consolidated.length){
  if(consolidated.length!==1||sources.length!==1||!task.checkpoint)throw Error('ambiguous original consolidated recovery context')
  const source=consolidated[0]!,selection=source.record.items.find((row:any)=>row.repo===task.repo&&row.issue===task.issue)
  if(!selection||selection.mode!=='code'||task.approvedTaskIds.some(id=>!selection.taskIds.includes(id)))throw Error('recovery selected scope differs')
  const currentPlan=comments.find((row:any)=>row.node_id===selection.artifacts.find((ref:any)=>ref.kind==='plan')?.artifactId)
  if(!currentPlan)throw Error('original approved plan unavailable')
  const paths=recoveryFiles(currentPlan.body,task.approvedTaskIds)
  const actions=source.record.actions.filter((action:any)=>selection.actionIds.includes(action.id)&&action.kind==='local'&&action.operations?.includes('edit'))
  // Closed local action name is supplied by the approved record. No latest
  // configuration or guessed checkpoint action replaces a missing grant.
  if(actions.length!==1)throw Error('unique original local recovery action unavailable')
  const childActions=source.record.actions.filter((action:any)=>selection.actionIds.includes(action.id)&&action.kind==='child-source-checkpoint')
  if(task.parentTaskKey!==null&&childActions.length!==1)throw Error('unique original child checkpoint action unavailable')
  const childAction=childActions[0] as {id:string;repo:string;parent:{issue:number;branch:string;baseSha:string};child:{issue:number;branch:string;ref:string;baseSha:string;taskIds:string[];paths:string[]}}|undefined
  if(childAction&&(childAction.repo!==task.repo||childAction.child.issue!==task.issue||childAction.child.branch!==task.checkpoint.branch||childAction.child.baseSha!==task.checkpoint.baseSha||canonicalWire(childAction.child.taskIds)!==canonicalWire(task.approvedTaskIds)||canonicalWire(childAction.child.paths)!==canonicalWire(paths)))throw Error('original child checkpoint action differs')
  const executionBranch=childAction?.parent.branch??task.checkpoint.branch,executionBase=childAction?.parent.baseSha??task.checkpoint.baseSha
  const request={parentRepo:task.repo,parentIssue:source.subject.number,approvalBinding:{commentId:source.tuple.commentId,bodySha256:source.tuple.bodySha256},requested:{repo:task.repo,issue:task.issue,taskIds:task.approvedTaskIds,actionId:actions[0].id,branch:executionBranch,baseSha:executionBase,paths,operation:'edit' as const}}
  checked=await approval.gatherConsolidatedApproval({...request,operators:policy.operators,readJson})
  authorityRequest={kind:'consolidated',...request}
  if(childAction){
   const checkpoint={parentRepo:task.repo,parentIssue:source.subject.number,approvalBinding:request.approvalBinding,requested:{repo:task.repo,issue:task.issue,taskIds:task.approvedTaskIds,actionId:childAction.id,branch:childAction.child.branch,ref:childAction.child.ref,baseSha:childAction.child.baseSha,paths,operation:'checkpoint' as const}}
   const verified=await approval.gatherConsolidatedApproval({...checkpoint,operators:policy.operators,readJson})
   if(!verified.ok||verified.blocks.length||verified.action?.kind!=='child-source-checkpoint'||canonicalWire(verified.bindings)!==canonicalWire(checked.bindings)||canonicalWire(verified.approvalBindings)!==canonicalWire(checked.approvalBindings)||canonicalWire(verified.recordBinding??null)!==canonicalWire(checked.recordBinding??null))throw Error('original child checkpoint authority refused')
   checkpointRequest=checkpoint
  }
 }else{
  const sourceComments=await approval.readApprovalSources(comments,readJson)
  checked=approval.evaluateApprovals({repo:task.repo,issue:task.issue,brief,comments,sourceComments,operators:policy.operators,requiredScope:'brief+plan'})
  const admission=await preflight.gatherAndEvaluate({repo:task.repo,issue:String(task.issue),expect:'working',stage:'implement'},{readJson,devMd,configuredPolicy:resolved})
  if(admission.blocks.length)throw Error('current native recovery prerequisites unavailable')
 }
 if(checked.ok===false||checked.blocks.length)throw Error('current canonical recovery approval refused')
 const bound=await helpers.bindVerifiedApprovalSources(checked.approvalBindings,reads,readJson,gh)
 if(canonicalWire(bound)!==canonicalWire(task.approvalBindings))throw Error('original recovery authority changed')
 const selected=await helpers.approvedTaskSelection(checked.bindings,reads,task.stage,{},task.approvedTaskIds)
 if(selected.scopeDigest!==task.scopeDigest||canonicalWire(selected.approvedTaskIds)!==canonicalWire(task.approvedTaskIds))throw Error('recovery approved task identity differs')
 if(task.recovery?.recordBinding){
  const wire=task.recovery.recordBinding,tuple=core.localApprovalBinding(wire)
  const direct=await readJson(['api',`repos/${task.repo}/issues/comments/${tuple.commentId}`])
  if(createHash('sha256').update(direct.body).digest('hex')!==tuple.bodySha256)throw Error('original requested record changed')
  const record=approval.parseApproval(direct),canonical=sources[0]!
  if(record.kind!=='consolidated'||canonical.record.kind!=='consolidated')throw Error('requested record provenance unavailable')
  const issue=/\/issues\/([1-9]\d*)$/.exec(direct.issue_url)?.[1]
  if(!issue)throw Error('requested record containing history unavailable')
  await approval.readPages(readJson,['api',`repos/${task.repo}/issues/${issue}/comments`])
  const audit=await helpers.bindVerifiedApprovalSources([tuple],reads,readJson,gh)
  if(canonicalWire(audit[0])!==canonicalWire(wire))throw Error('requested record locator changed')
  // Preserve requested relay pin for subsequent normal-owner verification;
  // canonical authority was separately read/evaluated above.
  if(authorityRequest.kind==='consolidated')authorityRequest={...authorityRequest,parentIssue:Number(issue),approvalBinding:{commentId:tuple.commentId,bodySha256:tuple.bodySha256}}
 }
 const planRef=checked.bindings.find((ref:any)=>ref.kind==='plan'),briefRef=checked.bindings.find((ref:any)=>ref.kind==='brief')
 const plan=comments.find((row:any)=>row.node_id===planRef?.artifactId)
 if(!plan||!briefRef||!planRef)throw Error('original recovery artifacts unavailable')
 const approvalObservedAt=Math.max(...sources.map(row=>Date.parse(row.comment.updated_at)))
 if(!Number.isFinite(approvalObservedAt))throw Error('original approval source timestamp unavailable')
 return {approvalObservedAt,artifacts:checked.bindings as import('./shared-claims.ts').ArtifactRef[],briefBody:brief.body as string,planBody:plan.body as string,title:brief.title as string,authorityRequest,checkpointRequest,comments,briefRef,planRef,policy}
}
export async function inspectRemoteRecovery(input:{repo:string;taskKey:string;config:FactoryConfig},transport:{target?:import('./shared-claims.ts').CoordinationTarget;gh?:TickDeps['gh'];source?:Parameters<typeof import('./children.ts').fetchChildCheckpoint>[1]}={}):Promise<RemoteRecoveryMaterial> {
 const owner=await import('./shared-claims.ts'),core=await recoveryScript(),target=transport.target??await verifiedSharedTarget(input.repo,input.config),gh=transport.gh??ghText
 const inspected=await owner.inspectCoordinationTask(target,input.taskKey)
 if(inspected.kind!=='active'||inspected.task.repo!==input.repo||!inspected.task.recovery)throw Error('active original remote recovery unavailable')
 return inspectRemoteRecoveryRecord(input,inspected,{...transport,target,gh})
}
type RemoteRecoveryTransport={target?:import('./shared-claims.ts').CoordinationTarget;gh?:TickDeps['gh'];source?:Parameters<typeof import('./children.ts').fetchChildCheckpoint>[1]}
async function inspectRemoteRecoveryRecord(input:{repo:string;taskKey:string;config:FactoryConfig},inspected:{head:string;task:import('./shared-claims.ts').TaskRecord},transport:RemoteRecoveryTransport,retainedStop?:import('./shared-claims.ts').StopProof):Promise<RemoteRecoveryMaterial> {
 const owner=await import('./shared-claims.ts'),core=await recoveryScript(),target=transport.target!,gh=transport.gh??ghText
 const task=inspected.task,envelope=owner.parseRecoveryEnvelope(task.recovery),authority=await recoveryAuthority(task,input.config,gh),stopProof=retainedStop??task.stopProof
 let stoppedOwner={taskKey:task.taskKey,runId:task.runId,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId}
 if(stopProof){
  owner.parseStopProof(stopProof)
  const proofMatches=(binding:typeof stoppedOwner)=>stopProof.machineId===binding.machineId&&stopProof.installationId===binding.installationId&&stopProof.sessionId===binding.sessionId&&stopProof.generation===binding.generation&&stopProof.runIds.includes(binding.runId)
  if(!proofMatches(stoppedOwner)){
   // Atomic group succession retains the predecessor's stop proof while moving
   // the logical run. Only its verified receipt may supply that predecessor.
   if(task.schemaVersion!==2)throw Error('remote stopped owner differs')
   const succession=await owner.inspectGroupSuccession(target,{operationId:task.successionOperationId,parent:stoppedOwner})
   if(succession.kind!=='verified')throw Error('remote stopped owner differs')
   const member=succession.receipt.members.find(row=>canonicalWire(row.after)===canonicalWire(stoppedOwner))
   if(!member||!proofMatches(member.before))throw Error('remote stopped owner differs')
   stoppedOwner=member.before
  }
 }
 const evidence:RemoteRecoveryMaterial['evidence']=[],blocks:string[]=[]
 const refs:Array<{ref:import('./shared-claims.ts').EvidenceRef;check:(payload:import('./shared-claims.ts').RecoveryEvidencePayload|null)=>void}>=[]
 const insist=(value:unknown,message:string):void=>{if(!value)throw Error(message)}
 refs.push({ref:envelope.execution.qualification,check:p=>{insist(p?.kind==='execution-qualification'&&p.result==='qualified'&&['harness','harnessVersion','model','effort','accountRef'].every(key=>(p as any)[key]===(envelope.execution as any)[key]),'original qualification differs')}})
 for(const completed of envelope.completed)refs.push({ref:completed.acceptance.evidence,check:p=>{insist(p?.kind==='acceptance'&&p.result==='passed'&&p.taskId===completed.taskId&&p.runId===task.runId&&p.scopeDigest===task.scopeDigest&&p.sourceSha===completed.headSha&&p.validationId===completed.acceptance.validationId&&p.commandDigest===completed.acceptance.commandDigest&&task.approvedTaskIds.includes(p.taskId),'completed acceptance differs')}})
 for(const child of envelope.children)refs.push({ref:child.acceptance.evidence,check:p=>{insist(p?.kind==='acceptance'&&p.result==='passed'&&p.runId===child.childRunId&&p.scopeDigest===child.scopeDigest&&p.sourceSha===child.headSha&&p.validationId===child.acceptance.validationId&&p.commandDigest===child.acceptance.commandDigest,'child acceptance differs')}})
 for(const join of envelope.joins){
  refs.push({ref:join.evidence,check:p=>{insist(p?.kind==='join'&&p.childRunId===join.childRunId&&p.generation===join.generation&&p.fromSha===join.fromSha&&p.parentBefore===join.parentBefore&&p.parentAfter===join.parentAfter&&p.state===join.state,'join evidence differs')}})
  if(join.acceptance)refs.push({ref:join.acceptance.evidence,check:p=>{insist(p?.kind==='acceptance'&&p.result==='passed'&&p.runId===task.runId&&p.scopeDigest===task.scopeDigest&&p.sourceSha===join.parentAfter&&p.validationId===join.acceptance!.validationId&&p.commandDigest===join.acceptance!.commandDigest,'parent join acceptance differs')}})
 }
 for(const effect of envelope.effects){
  refs.push({ref:effect.intent,check:p=>{insist(p?.kind==='effect-intent'&&p.effectId===effect.operationId&&p.runId===effect.runId&&p.generation===effect.generation&&p.effectKind===effect.kind&&canonicalWire(p.target)===canonicalWire(effect.target)&&p.payloadDigest===effect.payloadDigest&&canonicalWire(p.approvalBindings)===canonicalWire(envelope.approvalBindings),'effect intent differs')}})
  if(effect.outcome)refs.push({ref:effect.outcome,check:p=>{insist(p?.kind==='effect-outcome'&&p.effectId===effect.operationId&&p.runId===effect.runId&&p.generation===effect.generation&&p.effectKind===effect.kind&&canonicalWire(p.target)===canonicalWire(effect.target)&&p.payloadDigest===effect.payloadDigest&&p.result===effect.state&&canonicalWire(p.approvalBindings)===canonicalWire(envelope.approvalBindings)&&(p.result!=='acknowledged'||p.observedDigest===p.payloadDigest&&!!p.observedRemoteId),'effect outcome differs')}})
 }
 const coverage=envelope.remoteEffectCoverage
 if(coverage.kind==='unmanaged-possible')blocks.push('remote effect coverage unresolved')
 if(coverage.kind==='qualified-managed-only'&&canonicalWire(coverage.qualification)!==canonicalWire(envelope.execution.qualification))blocks.push('effect qualification differs')
 if(coverage.kind==='reconciled')refs.push({ref:coverage.evidence,check:p=>{insist(p?.kind==='effect-reconciliation'&&p.result==='complete'&&p.runId===task.runId&&p.scopeDigest===task.scopeDigest&&canonicalWire(p.approvalBindings)===canonicalWire(envelope.approvalBindings)&&envelope.effects.filter(row=>row.kind!=='telemetry-push').every(row=>p.checkedEffectIds.includes(row.operationId)),'effect reconciliation incomplete')}})
 if(!stopProof)blocks.push('verified stopped owner evidence unavailable')
 else refs.push({ref:stopProof.evidenceRef,check:p=>{insist(p?.kind==='effect-reconciliation'&&p.runId===task.runId&&p.scopeDigest===task.scopeDigest&&p.reasonCode==='owned-process-group-stopped'&&p.inspector.kind==='qualified-adapter'&&p.inspector.identityRef===stoppedOwner.machineId&&canonicalWire(p.approvalBindings)===canonicalWire(envelope.approvalBindings),'original stopped owner attestation differs')}})
 for(const entry of refs){
  try{
   if(entry.ref.kind!=='state-receipt')throw Error('exact immutable recovery receipt required')
   const reader={...target,verifyEvidence:async(ref:import('./shared-claims.ts').EvidenceRef,payload:import('./shared-claims.ts').RecoveryEvidencePayload|null)=>{if(canonicalWire(ref)!==canonicalWire(entry.ref))throw Error('recovery receipt binding differs');entry.check(payload)}}
   const payload=await owner.resolveEvidence(reader,entry.ref)
   if(stopProof&&canonicalWire(entry.ref)===canonicalWire(stopProof.evidenceRef)){
    const raw=await target.provider.read(target,entry.ref.commitSha,owner.operationPath(entry.ref.operationId))
    if(!raw||owner.sha256(raw)!==entry.ref.blobSha256)throw Error('stop receipt readback changed')
    const receipt=JSON.parse(raw) as import('./shared-claims.ts').OperationReceipt,proof=stopProof
    if(receipt.taskKey!==task.taskKey||receipt.generation!==stoppedOwner.generation||receipt.resultOwner.runId!==task.runId||receipt.resultOwner.ownerToken!==stoppedOwner.ownerToken||receipt.resultOwner.machineId!==proof.machineId||receipt.resultOwner.installationId!==proof.installationId||receipt.resultOwner.sessionId!==proof.sessionId||proof.generation!==stoppedOwner.generation||!proof.runIds.includes(task.runId))throw Error('stop receipt original owner differs')
   }
   evidence.push({ref:entry.ref,payload})
  }catch(error){blocks.push((error as Error).message)}
 }
 if(!task.checkpoint||canonicalWire(task.checkpoint)!==canonicalWire(envelope.checkpoint))blocks.push('original exact source checkpoint unavailable')
 if(envelope.effects.some(row=>row.kind!=='telemetry-push'&&!['acknowledged','cancelled-before-send'].includes(row.state)))blocks.push('blocking run or control effect pending')
 if(task.unresolvedEffects.some(ref=>!envelope.effects.some(effect=>effect.kind==='telemetry-push'&&(canonicalWire(effect.intent)===canonicalWire(ref)||canonicalWire(effect.outcome)===canonicalWire(ref)))))blocks.push('unclassified unresolved remote effects')
 const comments=authority.comments as Array<{id:number;updated_at:string;body:string;user?:{login?:string}}>
 for(const comment of comments){
  if(Date.parse(comment.updated_at)<=authority.approvalObservedAt||/^<!-- vsk:v1 type=(plan|approval)\b/m.test(comment.body))continue
  if(!authority.policy.operators.includes(comment.user?.login??'')&&!/^<!-- vsk:v1 type=(correction|ruling|handback)\b/m.test(comment.body))continue
  const digest=createHash('sha256').update(comment.body).digest('hex')
  const emitted=evidence.some(row=>row.payload?.kind==='effect-outcome'&&row.payload.effectKind==='handback'&&row.payload.result==='acknowledged'&&row.payload.observedRemoteId===String(comment.id)&&row.payload.observedDigest===digest&&row.payload.payloadDigest===digest)
  if(!emitted)blocks.push('operator instruction after original approval requires reconciliation: '+comment.id)
 }
 const newest=[...comments].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at))[0]
 if(!newest)throw Error('recovery source cursor unavailable')
 const packet={schemaVersion:3,repo:task.repo,issue:task.issue,briefRef:authority.briefRef,planRef:authority.planRef,approvalIds:envelope.approvalBindings.map(row=>row.approvalId),approvalBindings:envelope.approvalBindings,recordBinding:envelope.recordBinding,taskIds:task.approvedTaskIds,completed:envelope.completed.map(row=>({taskId:row.taskId,headSha:row.headSha,evidenceUrl:row.acceptance.evidence.kind==='state-receipt'?'vsk-state:'+row.acceptance.evidence.commitSha+':'+row.acceptance.evidence.operationId:'github-comment:'+row.acceptance.evidence.commentId})),lastVerifiedCommit:task.checkpoint?.headSha??'',openFindings:[],rulings:comments.filter(row=>/^- Ruling:/m.test(row.body)).flatMap(row=>row.body.split('\n').filter(line=>/^- Ruling:/.test(line))),commentCursor:{id:String(newest.id),updatedAt:newest.updated_at},pendingRunIds:[task.runId],learning:[]}
 if(task.checkpoint)core.validateRecoveryPacket(packet)
 const children:RemoteRecoveryMaterial['children']=[]
 const current=await owner.readCoordination(target)
 let succession:Awaited<ReturnType<typeof owner.inspectGroupSuccession>>|null=null
 const successionId=task.schemaVersion===2?task.successionOperationId:null
 if(task.schemaVersion===2){
  succession=await owner.inspectGroupSuccession(target,{operationId:task.successionOperationId,parent:{taskKey:task.taskKey,runId:task.runId,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId}})
  if(succession.kind!=='verified')blocks.push(succession.reason)
 }
 for(const child of Object.values(current.tasks).filter(row=>row.parentTaskKey===task.taskKey)){
  const direct=child.parentBinding&&child.parentBinding.runId===task.runId&&child.parentBinding.ownerToken===task.ownerToken&&child.parentBinding.generation===task.generation
  const progressed=succession?.kind==='verified'?succession.currentMembers.find(row=>row.current.taskKey===child.taskKey):undefined
  const succeeded=!!progressed&&progressed.initial.successionOperationId===successionId&&canonicalWire(progressed.current)===canonicalWire(child)
  if(!child.parentBinding||!direct&&!succeeded){blocks.push('original parent binding or current group succession differs for child '+child.issue);continue}
  try{const childAuthority=await recoveryAuthority(child,input.config,gh);children.push({task:child,stateCommit:current.head,authorityRequest:childAuthority.authorityRequest,checkpointRequest:childAuthority.checkpointRequest})}catch(error){blocks.push((error as Error).message)}
 }
 const historicalParents:RemoteRecoveryMaterial['historicalParents']=[]
 // Historical readers authenticate the same immutable receipts already checked
 // above. They cannot depend on an original machine's private RunRecord.
 const historicalTarget:import('./shared-claims.ts').CoordinationTarget={...target,
  verifyCandidate:async()=>{throw Error('historical recovery reader is read-only')},
  verifyTransition:async()=>{throw Error('historical recovery reader is read-only')},
  verifyEvidence:async(ref,payload)=>{
   const retained=evidence.find(row=>canonicalWire(row.ref)===canonicalWire(ref))
   if(!retained||canonicalWire(retained.payload)!==canonicalWire(payload))throw Error('historical recovery receipt was not verified')
  }}
 const historical=owner.inspectHistoricalCoordinationTask
 for(const accepted of envelope.children){
  if(children.some(row=>row.task.runId===accepted.childRunId))continue
  const retained=await owner.inspectCoordinationTask(target,accepted.childTaskKey)
  if((retained.kind==='active'||retained.kind==='completed')&&retained.task.runId===accepted.childRunId&&retained.task.generation===accepted.generation&&retained.task.machineId===accepted.machineId&&retained.task.installationId===accepted.installationId&&retained.task.sessionId===accepted.sessionId&&retained.task.scopeDigest===accepted.scopeDigest){const childAuthority=await recoveryAuthority(retained.task,input.config,gh);children.push({task:retained.task,stateCommit:retained.head,authorityRequest:childAuthority.authorityRequest,checkpointRequest:childAuthority.checkpointRequest});continue}
  try{
   if(!historical||accepted.acceptance.evidence.kind!=='state-receipt')throw Error('historical accepted child context requires pinned task reader')
   const ref=accepted.acceptance.evidence,raw=await target.provider.read(target,ref.commitSha,owner.operationPath(ref.operationId))
   if(!raw||owner.sha256(raw)!==ref.blobSha256)throw Error('historical child receipt changed')
   const receipt=JSON.parse(raw) as import('./shared-claims.ts').OperationReceipt
   if(receipt.taskKey!==task.taskKey||receipt.recoveryPayload?.kind!=='acceptance'||receipt.recoveryPayload.runId!==accepted.childRunId)throw Error('original parent publication binding unavailable')
   const parent={taskKey:receipt.taskKey,generation:receipt.generation,...receipt.resultOwner}
   const child={taskKey:accepted.childTaskKey,runId:accepted.childRunId,generation:accepted.generation,machineId:accepted.machineId,installationId:accepted.installationId,sessionId:accepted.sessionId}
   const found=await historical(historicalTarget,{taskKey:child.taskKey,expected:{child,parent},evidence:ref,at:'receipt'})
   if(found.kind!=='historical'||found.task.scopeDigest!==accepted.scopeDigest||found.task.checkpoint?.headSha!==accepted.headSha)throw Error('historical accepted child identity differs')
   const originalParent=await historical(historicalTarget,{taskKey:parent.taskKey,expected:parent,evidence:ref,at:'receipt'})
   if(originalParent.kind!=='historical')throw Error('historical original parent unavailable')
   const childAuthority=await recoveryAuthority(found.task,input.config,gh);children.push({task:found.task,stateCommit:found.head,authorityRequest:childAuthority.authorityRequest,checkpointRequest:childAuthority.checkpointRequest});historicalParents.push({task:originalParent.task,stateCommit:originalParent.head})
  }catch(error){blocks.push((error as Error).message)}
 }
 if(task.parentBinding){
  const original=current.tasks[task.parentBinding.taskKey]
  if(!original||canonicalWire({taskKey:original.taskKey,runId:original.runId,generation:original.generation,ownerToken:original.ownerToken,machineId:original.machineId,installationId:original.installationId,sessionId:original.sessionId})!==canonicalWire(task.parentBinding)){
   try{
    if(!historical||stopProof?.evidenceRef.kind!=='state-receipt')throw Error('historical original parent context requires pinned task reader')
    const found=await historical(historicalTarget,{taskKey:task.parentBinding.taskKey,expected:task.parentBinding,evidence:stopProof.evidenceRef,at:'receipt'})
    if(found.kind!=='historical')throw Error('historical original parent identity differs')
    historicalParents.push({task:found.task,stateCommit:found.head})
   }catch(error){blocks.push((error as Error).message)}
  }
 }
 if(task.checkpoint){
  try{
   const checkout=input.config.repos.find(row=>row.repo===task.repo)!.path,fetch=(await import('./children.ts')).fetchChildCheckpoint
   const sourceRun={repo:task.repo,runId:task.runId,branch:task.checkpoint.branch,baseSha:task.checkpoint.baseSha,headSha:task.checkpoint.headSha,taskKey:{repo:task.repo,issue:task.issue,taskId:task.approvedTaskIds[0]!,scopeDigest:task.scopeDigest},checkpoint:task.checkpoint}
   await fetch({checkout,run:sourceRun,config:input.config},transport.source)
   for(const completed of envelope.completed){const checked=spawnSync('git',['merge-base','--is-ancestor',completed.headSha,task.checkpoint.headSha],{cwd:checkout,timeout:3000});if(checked.status!==0)throw Error('completed source is not in recovered checkpoint')}
   for(const child of envelope.children)await fetch({checkout,run:{repo:task.repo,runId:child.childRunId,branch:child.checkpoint.branch,baseSha:child.baseSha,headSha:child.headSha,taskKey:{repo:task.repo,issue:task.issue,taskId:task.approvedTaskIds[0]!,scopeDigest:child.scopeDigest},checkpoint:child.checkpoint},config:input.config},transport.source)
   for(const joined of envelope.joins){if(joined.state==='accepted'&&joined.parentAfter){const checked=spawnSync('git',['merge-base','--is-ancestor',joined.parentAfter,task.checkpoint.headSha],{cwd:checkout,timeout:3000});if(checked.status!==0)throw Error('accepted parent join is missing from recovered checkpoint')}}
  }catch(error){blocks.push((error as Error).message)}
 }
 const material={stateCommit:inspected.head,task,artifacts:authority.artifacts,briefBody:authority.briefBody,planBody:authority.planBody,title:authority.title,authorityRequest:authority.authorityRequest,checkpointRequest:authority.checkpointRequest,packet,evidence,children,historicalParents,unavailableContext:['original-private-notes','original-learning-context'] as RemoteRecoveryMaterial['unavailableContext'],sourceRefs:comments.map(row=>({id:String(row.id),updatedAt:row.updated_at,bodySha256:createHash('sha256').update(row.body).digest('hex')})),blocks:[...new Set(blocks)]}
 if(!material.blocks.length)verifiedRecoveryMaterials.set(material,createHash('sha256').update(canonicalWire(material)).digest('hex'))
 return material
}

export interface ReceivingRecoveryMaterial {
 original:RemoteRecoveryMaterial;current:{stateCommit:string;task:import('./shared-claims.ts').TaskRecord}
 handoff:{ref:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>;receipt:import('./shared-claims.ts').OperationReceipt}
 taskIds:string[]
}
const verifiedReceivingMaterials=new WeakMap<ReceivingRecoveryMaterial,string>()
export async function inspectReceivingRecovery(request:import('./runs.ts').ReceivingRunRequest,originalOwner:import('./shared-claims.ts').ParentClaimBinding,config:FactoryConfig,transport:RemoteRecoveryTransport={}):Promise<ReceivingRecoveryMaterial> {
 const owner=await import('./shared-claims.ts'),target=transport.target??await verifiedSharedTarget(config.repos.find(row=>row.path===request.checkout)?.repo??'',config)
 if(request.root!==runsRoot(config.home)||originalOwner.taskKey!==request.taskKey||originalOwner.runId!==request.runId)throw Error('receiving original request differs')
 const history=await owner.inspectHandoffCoordinationTask(target,{taskKey:request.taskKey,expected:originalOwner,evidence:request.handoff})
 if(history.kind!=='historical-handoff')throw Error(history.reason)
 const next=history.handedOff,current=await owner.inspectCoordinationTask(target,request.taskKey,{runId:next.runId,generation:next.generation,ownerToken:next.ownerToken,machineId:next.machineId,installationId:next.installationId,sessionId:next.sessionId})
 if(current.kind!=='active'||current.task.state!=='claimed'||current.task.generation!==request.expectedSharedGeneration||!current.task.stopProof||current.task.parentTaskKey!==null||current.task.parentBinding!=null)throw Error('receiving current standalone owner unavailable')
 for(const key of ['checkpoint','recovery','approvedTaskIds','acceptedScopes','stopProof'] as const)if(canonicalWire(current.task[key])!==canonicalWire(next[key]))throw Error('receiving handoff source changed')
 const original=await inspectRemoteRecoveryRecord({repo:next.repo,taskKey:next.taskKey,config},{head:history.receipt.previousHead,task:history.predecessor},{...transport,target},current.task.stopProof)
 assertRemoteRecoveryMaterial(original)
 if(original.children.length)throw Error('retained child reservations require explicit group recovery')
 const completed=new Set((original.packet.completed as Array<{taskId:string}>).map(row=>row.taskId)),taskIds=original.task.approvedTaskIds.filter(id=>!completed.has(id))
 if(!taskIds.length)throw Error('receiving implementation is already complete; inspect delivery separately')
 const checked=[...original.planBody.matchAll(/^-\s*\[x\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->/gim)].map(match=>match[1]!)
 if(checked.some(id=>!completed.has(id)))throw Error('checked task lacks verified completion evidence; no blind replay')
 const material={original,current:{stateCommit:current.head,task:current.task},handoff:{ref:request.handoff,receipt:history.receipt},taskIds}
 verifiedReceivingMaterials.set(material,createHash('sha256').update(canonicalWire(material)).digest('hex'))
 return material
}

async function receivingExecutionSetup(material:RemoteRecoveryMaterial,checkout:string,config:FactoryConfig,target:import('./shared-claims.ts').CoordinationTarget,localClaim:Claim,sessionId:string):Promise<{receiver:import('./runs.ts').VerifiedReceivingRunDecision['receiver'];plan:LaunchPlan}> {
 assertRemoteRecoveryMaterial(material)
 const helpers=await import('./runs.ts'),machine=sharedMachineContexts.get(target)
 if(!machine||machine.defaults.recovery!=='verified-transfer'||localClaim.path!==repoLockPath(config,material.task.repo))throw Error('receiving machine or local repository ownership unavailable')
 await(await import('./claims.ts')).renewClaim(localClaim)
 const devMd=await readFile(join(checkout,'.vegastack/dev.md'),'utf8'),effective=loadConfiguredPolicy({home:config.home,repo:material.task.repo,devMd,settingsPath:config.settingsPath})
 if(!effective.ok)throw Error('receiving current policy unavailable')
 const policy=repoPolicyFromEffective(effective),stage=stagePolicy(policy,material.task.stage as Stage),execution=material.task.recovery!.execution
 if(stage.harness!==execution.harness||stage.model!==execution.model||stage.effort!==execution.effort)throw Error('receiving original harness/model/effort changed')
 const plan=buildLaunchPlan({harness:stage.harness,model:stage.model,effort:stage.effort,stage:material.task.stage as Stage,worktree:checkout,issue:{number:material.task.issue,title:material.title},operator:machine.executionLogin,outcome:outcomeOf(material.briefBody),stopList:stopList(devMd),resume:false,skillPath:null,subagents:config.subagents})
 await inspectSubscription(plan,execution.accountRef)
 const metadata=await inspectManagedHarness(plan)
 if(metadata.version!==execution.harnessVersion||!validateManagedLaunch(plan,metadata).ok)throw Error('original receiving harness version or effective controls changed')
 const seeds=(await helpers.readQualifiedExecutions(runsRoot(config.home))).filter(row=>canonicalWire(row.execution)===canonicalWire(execution))
 const qualification=material.evidence.find(row=>canonicalWire(row.ref)===canonicalWire(execution.qualification))?.payload
 let selected:import('./runs.ts').QualifiedExecutionRecord|undefined
 for(const seed of seeds){
  try{
   await helpers.verifyInstalledRuntimeBinding(seed.runtimeBinding,dirname(dirname(fileURLToPath(import.meta.url))),fileURLToPath(import.meta.url))
   if(await helpers.executionConfigurationDigest({binding:seed.runtimeBinding,execution,plan,metadata})!==seed.configurationDigest)continue
   helpers.verifyExecutionQualification(qualification,execution,seed.runtimeBinding,seed.configurationDigest)
   if(selected)throw Error('multiple original receiving runtime registrations')
   selected=seed
  }catch(error){if((error as Error).message==='multiple original receiving runtime registrations')throw error}
 }
 if(!selected)throw Error('original verified installed runtime/account configuration unavailable on receiver')
 return {receiver:{machine:{id:machine.id,installationId:machine.installationId,sessionId,hostBindingDigest:machine.hostBindingDigest},claimToken:localClaim.token,policyDigest:effective.policy.policyDigest,runtimeBinding:selected.runtimeBinding,configurationDigest:selected.configurationDigest,worktreeDigest:await helpers.worktreeFingerprint(checkout)},plan}
}
export async function verifyReceivingRunRecovery(request:import('./runs.ts').ReceivingRunRequest,originalOwner:import('./shared-claims.ts').ParentClaimBinding,config:FactoryConfig,localClaim:Claim):Promise<import('./runs.ts').VerifiedReceivingRunDecision> {
 const entry=config.repos.find(row=>row.repo===originalOwnerRepository.get(originalOwner));
 // The request's local checkout must belong to one configured source repository.
 const candidates=entry?[entry]:config.repos.filter(row=>{const r=spawnSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:row.path,encoding:'utf8',timeout:3000});const c=spawnSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:request.checkout,encoding:'utf8',timeout:3000});return r.status===0&&c.status===0&&r.stdout.trim()===c.stdout.trim()})
 if(candidates.length!==1)throw Error('receiving configured source repository unavailable')
 const target=await verifiedSharedTarget(candidates[0]!.repo,config),material=await inspectReceivingRecovery(request,originalOwner,config,{target})
 const setup=await receivingExecutionSetup(material.original,request.checkout,config,target,localClaim,material.current.task.sessionId)
 if(setup.receiver.machine.id!==material.current.task.machineId||setup.receiver.machine.installationId!==material.current.task.installationId)throw Error('receiving current machine differs')
 const retained=(await(await import('./runs.ts')).readRuns(runsRoot(config.home))).find(run=>run.runId===request.runId)
 if(retained){if(retained.state!=='prepared'||retained.processIdentity||retained.remoteRecovery?.requestId!==request.requestId||canonicalWire(retained.remoteRecovery.handoff)!==canonicalWire(request.handoff))throw Error('receiving existing run requires reconciliation');setup.receiver.claimToken=retained.claimToken}
 return {action:'resume-task',reason:'fresh original source, stopped owner and current receiving ownership verified',original:{stateCommit:material.original.stateCommit,task:material.original.task},current:material.current,handoff:material.handoff,artifacts:material.original.artifacts,authorityRequest:material.original.authorityRequest,taskIds:material.taskIds,sourceRefs:material.original.sourceRefs,receiver:setup.receiver}
}
const originalOwnerRepository=new WeakMap<import('./shared-claims.ts').ParentClaimBinding,string>()
interface ReceivingIntent {
 schemaVersion:1;repo:string;taskKey:string;runId:string;operationId:string;requestId:string
 original:import('./shared-claims.ts').ParentClaimBinding;stateCommit:string
 session:Omit<MachineSession,'target'|'localRoot'>;machine:EffectiveMachine;candidate:VerifiedCandidate
 stopProof:import('./shared-claims.ts').StopProof;recovery:import('./shared-claims.ts').RecoveryEnvelope
 checkout:string;handoff:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>|null
}
interface StoppedGroupRecoveryIntent {
 schemaVersion:1;operationId:string;parentTaskKey:string;expectedHead:string
 groupPlan:import('./shared-claims.ts').ArtifactRef;groupsDigest:string
 members:Array<{taskKey:string;runId:string;expectedBinding:import('./shared-claims.ts').ParentClaimBinding;candidateDigest:string;materialDigest:string}>
}
type PreparedStoppedGroup={run:RunRecord;claim:SharedClaim;plan:LaunchPlan;started:true;group:{guard:'plan-lint';ok:true;groups:Array<{id:string;members:string[];files:string[]}>;starts:{parent:{task:import('./shared-claims.ts').TaskRecord;claim:SharedClaim;startOperationId:string};children:Array<{task:import('./shared-claims.ts').TaskRecord;claim:SharedClaim;startOperationId:string}>}}}
const stoppedUuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,stoppedDigest=/^[a-f0-9]{64}$/i,stoppedSha=/^[a-f0-9]{40}$/i
export const stableGroupRequestId=(operationId:string,taskKey:string):string=>{
 const value=createHash('sha256').update(`VegaFactory/group-receiving-request/v1\n${operationId}\n${taskKey}`).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-${((Number.parseInt(value[16]!,16)&3)|8).toString(16)}${value.slice(17,20)}-${value.slice(20,32)}`
}
function groupCheckpointIntent(material:RemoteRecoveryMaterial,checkout:string):import('./checkpoints.ts').CheckpointIntent|null{
 const request=material.checkpointRequest,checkpoint=material.task.checkpoint
 if(!request)return null
 if(!checkpoint)throw Error('stopped group checkpoint unavailable')
 const remote=spawnSync('git',['remote','get-url','origin'],{cwd:checkout,encoding:'utf8',timeout:3000})
 if(remote.status!==0||!remote.stdout.trim())throw Error('stopped group source remote unavailable')
 return{id:request.requested.actionId,repo:material.task.repo,repositoryId:material.task.repositoryNodeId,remote:'origin',remoteUrl:remote.stdout.trim(),branch:checkpoint.branch,baseRef:request.requested.ref??`refs/heads/${checkpoint.branch}`,baseSha:checkpoint.baseSha,scopeDigest:material.task.scopeDigest,paths:[...material.task.paths],approvalBindings:structuredClone(material.task.approvalBindings),approvalRequest:structuredClone(request)}
}
async function stoppedGroupDescriptor(materials:RemoteRecoveryMaterial[],parentTaskKey:string,operationId:string):Promise<StoppedGroupRecoveryIntent>{
 const owner=await import('./shared-claims.ts'),parent=materials.find(row=>row.task.taskKey===parentTaskKey)
 if(!parent||materials.some(row=>row.stateCommit!==parent.stateCommit))throw Error('complete same-head stopped group unavailable')
 const groupPlan=parent.artifacts.find(row=>row.kind==='plan'&&row.issue===parent.task.issue)
 if(!groupPlan)throw Error('stopped group plan artifact unavailable')
 const source=fileURLToPath(import.meta.url).endsWith('.ts'),planner=await import(new URL(source?'../../../skills/dev/dev-plan/scripts/plan-lint.mjs':'../skill/dev-plan/scripts/plan-lint.mjs',import.meta.url).href) as typeof import('../../../skills/dev/dev-plan/scripts/plan-lint.mjs')
 const approvedGroups=planner.parseIndependentGroups(parent.planBody).map(group=>({id:group.id,members:group.members,files:group.files}))
 if(!approvedGroups.length||approvedGroups.length!==materials.length-1)throw Error('stopped group approved member set differs')
 const members=materials.map(material=>({taskKey:material.task.taskKey,runId:material.task.runId,expectedBinding:groupBinding(material.task),candidateDigest:owner.sha256(owner.canonical(groupCandidate(material.task))),materialDigest:owner.sha256(owner.canonical(stoppedMaterialFacts(material)))})).sort((a,b)=>a.taskKey.localeCompare(b.taskKey))
 return{schemaVersion:1,operationId,parentTaskKey,expectedHead:parent.stateCommit,groupPlan,groupsDigest:owner.sha256(owner.canonical(approvedGroups)),members}
}
function assertStoppedGroupIntent(value:unknown):asserts value is StoppedGroupRecoveryIntent{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('stopped group intent unavailable')
 const row=value as StoppedGroupRecoveryIntent,keys=Object.keys(row).sort().join(',')
 if(keys!=='expectedHead,groupPlan,groupsDigest,members,operationId,parentTaskKey,schemaVersion'||row.schemaVersion!==1||!stoppedUuid.test(row.operationId)||!stoppedDigest.test(row.parentTaskKey)||!stoppedSha.test(row.expectedHead)||!stoppedDigest.test(row.groupsDigest)||!Array.isArray(row.members)||row.members.length<2||row.members.length>17)throw Error('stopped group intent schema differs')
 if(row.members.map(member=>member.taskKey).join('\n')!==[...row.members].map(member=>member.taskKey).sort().join('\n')||new Set(row.members.map(member=>member.taskKey)).size!==row.members.length||new Set(row.members.map(member=>member.runId)).size!==row.members.length)throw Error('stopped group intent member set differs')
 for(const member of row.members){const binding=member.expectedBinding
  if(Object.keys(member).sort().join(',')!=='candidateDigest,expectedBinding,materialDigest,runId,taskKey'||!stoppedDigest.test(member.taskKey)||!stoppedUuid.test(member.runId)||!stoppedDigest.test(member.candidateDigest)||!stoppedDigest.test(member.materialDigest)||!binding||Object.keys(binding).sort().join(',')!=='generation,installationId,machineId,ownerToken,runId,sessionId,taskKey'||binding.taskKey!==member.taskKey||binding.runId!==member.runId||!Number.isSafeInteger(binding.generation)||binding.generation<1||!binding.machineId||!stoppedUuid.test(binding.installationId)||!stoppedUuid.test(binding.sessionId)||!stoppedUuid.test(binding.ownerToken))throw Error('stopped group intent member differs')
 }
}
async function receivingCheckout(material:RemoteRecoveryMaterial,config:FactoryConfig):Promise<string> {
 const entry=config.repos.find(row=>row.repo===material.task.repo)!,checkpoint=material.task.checkpoint!
 const git=(args:string[])=>{const r=spawnSync('git',args,{cwd:entry.path,encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});if(r.status!==0)throw Error('receiving checkout source unavailable');return r.stdout.trim()}
 const inventory=git(['worktree','list','--porcelain']).split('\n\n')
 for(const row of inventory){
  if(!row.split('\n').includes('branch refs/heads/'+checkpoint.branch))continue
  const path=row.split('\n').find(line=>line.startsWith('worktree '))?.slice(9)
  if(!path||!row.split('\n').includes('HEAD '+checkpoint.headSha))throw Error('original recovery branch holds different source')
  return realpath(path)
 }
 const named=/^([^/]+)\/([1-9]\d*)-(.+)$/.exec(checkpoint.branch)
 if(!named||Number(named[2])!==material.task.issue||!BRANCH_TYPES.includes(named[1]!))throw Error('original recovery branch cannot be restored by the worktree owner')
 const helper=await import(new URL(fileURLToPath(import.meta.url).endsWith('.ts')?'../../../skills/dev/dev-implement/scripts/worktree.mjs':'../skill/dev-implement/scripts/worktree.mjs',import.meta.url).href) as typeof import('../../../skills/dev/dev-implement/scripts/worktree.mjs')
 const existing=spawnSync('git',['rev-parse','--verify','refs/heads/'+checkpoint.branch],{cwd:entry.path,encoding:'utf8',timeout:3000})
 if(existing.status===0&&existing.stdout.trim()!==checkpoint.headSha)throw Error('existing original recovery branch differs; source preserved')
 const args={repoRoot:entry.path,issue:material.task.issue,slug:named[3]!,type:named[1]!,home:config.home,devMd:await readFile(join(entry.path,'.vegastack/dev.md'),'utf8'),write:true}
 const restored=existing.status===0?helper.restoreWorktree(args):helper.createChildWorktree({...args,baseSha:checkpoint.headSha})
 if(restored.blocks.length||restored.branch!==checkpoint.branch)throw Error('original recovery checkout unavailable: '+restored.blocks.join('; '))
 return realpath(restored.path)
}
async function stoppedGroupMaterialsAt(input:{repo:string;parentTaskKey:string;head:string;tasks:import('./shared-claims.ts').TaskRecord[];config:FactoryConfig;target:import('./shared-claims.ts').CoordinationTarget;gh:TickDeps['gh'];source?:RemoteRecoveryTransport['source']}):Promise<RemoteRecoveryMaterial[]>{
 const byKey=new Map(input.tasks.map(task=>[task.taskKey,task])),parent=byKey.get(input.parentTaskKey)
 if(!parent||parent.parentTaskKey!==null)throw Error('unique stopped group parent unavailable')
 const members=[parent,...input.tasks.filter(task=>task.parentTaskKey===parent.taskKey)].sort((a,b)=>a.taskKey.localeCompare(b.taskKey))
 if(members.length<2||new Set(members.map(task=>task.runId)).size!==members.length)throw Error('complete stopped group membership unavailable')
 const materials:RemoteRecoveryMaterial[]=[]
 for(const task of members){
  const material=await inspectRemoteRecoveryRecord({repo:input.repo,taskKey:task.taskKey,config:input.config},{head:input.head,task},{target:input.target,gh:input.gh,source:input.source},task.stopProof??undefined)
  assertRemoteRecoveryMaterial(material);materials.push(material)
 }
 const parentMaterial=materials.find(row=>row.task.taskKey===parent.taskKey)!,declared=[...new Set(parentMaterial.children.map(row=>row.task.taskKey))].sort(),actual=members.filter(task=>task.taskKey!==parent.taskKey).map(task=>task.taskKey).sort()
 if(canonicalWire(declared)!==canonicalWire(actual))throw Error('separately authenticated stopped group member set differs: '+declared.join(',')+' != '+actual.join(','))
 return materials
}
async function stoppedGroupMaterialsFromReceipt(input:{repo:string;intent:StoppedGroupRecoveryIntent;currentParent:import('./shared-claims.ts').TaskRecord;config:FactoryConfig;target:import('./shared-claims.ts').CoordinationTarget;gh:TickDeps['gh'];source?:RemoteRecoveryTransport['source']}):Promise<{materials:RemoteRecoveryMaterial[];inspection:Extract<import('./shared-claims.ts').GroupSuccessionInspection,{kind:'verified'}>}>
{
 const owner=await import('./shared-claims.ts'),parent=groupBinding(input.currentParent),inspection=await owner.inspectGroupSuccession(input.target,{operationId:input.intent.operationId,parent})
 if(inspection.kind!=='verified'||inspection.receipt.previousHead!==input.intent.expectedHead||inspection.receipt.parentTaskKey!==input.intent.parentTaskKey)throw Error('stopped group prior receipt unavailable')
 const materials:RemoteRecoveryMaterial[]=[]
 for(const member of input.intent.members){
  const receiptMember=inspection.receipt.members.find(row=>row.before.taskKey===member.taskKey),raw=await input.target.provider.read(input.target,input.intent.expectedHead,`coordination/tasks/${member.taskKey}.json`)
  if(!receiptMember||!raw||Buffer.byteLength(raw)>256*1024)throw Error('stopped group predecessor unavailable')
  let task:import('./shared-claims.ts').TaskRecord;try{task=JSON.parse(raw)}catch{throw Error('stopped group predecessor is unreadable')}
  if(raw!==owner.canonical(task)||owner.sha256(raw)!==receiptMember.beforeTaskSha256||canonicalWire(groupBinding(task))!==canonicalWire(member.expectedBinding)||owner.sha256(owner.canonical(groupCandidate(task)))!==member.candidateDigest)throw Error('stopped group predecessor identity changed')
  const material=await inspectRemoteRecoveryRecord({repo:input.repo,taskKey:member.taskKey,config:input.config},{head:input.intent.expectedHead,task},{target:input.target,gh:input.gh,source:input.source},task.stopProof??undefined)
  assertRemoteRecoveryMaterial(material);materials.push(material)
 }
 return{materials,inspection}
}
async function readStoppedGroupIntent(path:string):Promise<StoppedGroupRecoveryIntent|null>{
 try{const value=JSON.parse(await (await import('./runs.ts')).readPrivateRunFile(path,128*1024));assertStoppedGroupIntent(value);return value}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
}
async function stoppedGroupDecision(input:{repo:string;intent:StoppedGroupRecoveryIntent;request:import('./runs.ts').GroupReceivingRunRequest;config:FactoryConfig;target:import('./shared-claims.ts').CoordinationTarget;gh:TickDeps['gh'];localClaim:Claim;checkouts:Map<string,string>;source?:RemoteRecoveryTransport['source']},progressed=false):Promise<import('./runs.ts').VerifiedGroupReceivingRunDecision>{
 const owner=await import('./shared-claims.ts'),current=await owner.inspectCoordinationTask(input.target,input.intent.parentTaskKey)
 if(current.kind!=='active'||current.task.schemaVersion!==2||!(progressed?['claimed','running'].includes(current.task.state):current.task.state==='claimed')||current.task.successionOperationId!==input.intent.operationId)throw Error('stopped group current parent unavailable')
 const refreshed=await stoppedGroupMaterialsFromReceipt({repo:input.repo,intent:input.intent,currentParent:current.task,config:input.config,target:input.target,gh:input.gh,source:input.source})
 const descriptor=await stoppedGroupDescriptor(refreshed.materials,input.intent.parentTaskKey,input.intent.operationId)
 if(canonicalWire(descriptor)!==canonicalWire(input.intent)||canonicalWire(refreshed.inspection.reference)!==canonicalWire(input.request.succession))throw Error('stopped group intent or receipt changed')
 const currentByKey=new Map(refreshed.inspection.currentMembers.map(row=>[row.current.taskKey,row.current]))
 const members:import('./runs.ts').VerifiedGroupReceivingRunDecision['members']=[]
 for(const material of refreshed.materials){
  const currentTask=currentByKey.get(material.task.taskKey)
  if(!currentTask||currentTask.schemaVersion!==2||currentTask.successionOperationId!==input.intent.operationId)throw Error('stopped group current member changed')
  const completed=new Set((material.packet.completed as Array<{taskId:string}>|undefined)?.map(row=>row.taskId)??[]),taskIds=material.task.approvedTaskIds.filter(id=>!completed.has(id)),checkout=input.checkouts.get(material.task.taskKey)
  if(!checkout||!taskIds.length)throw Error('stopped group member source or outstanding work unavailable')
  members.push({original:{stateCommit:material.stateCommit,task:structuredClone(material.task)},current:{stateCommit:refreshed.inspection.reference.commitSha,task:structuredClone(currentTask)},artifacts:structuredClone(material.artifacts),authorityRequest:structuredClone(material.authorityRequest),checkpointIntent:groupCheckpointIntent(material,checkout),taskIds,sourceRefs:structuredClone(material.sourceRefs)})
 }
 members.sort((a,b)=>a.original.task.taskKey.localeCompare(b.original.task.taskKey))
 const selected=refreshed.materials.find(row=>row.task.taskKey===input.request.taskKey),checkout=input.checkouts.get(input.request.taskKey)
 if(!selected||!checkout)throw Error('stopped group selected member unavailable')
 const setup=await ((input.target as StoppedGroupTarget)[stoppedGroupSetupOverride]??receivingExecutionSetup)(selected,checkout,input.config,input.target,input.localClaim,input.request.currentMember.sessionId),existing=(await (await import('./runs.ts')).readRuns(runsRoot(input.config.home))).find(run=>run.runId===input.request.runId)
 if(existing)setup.receiver.claimToken=existing.claimToken
 return{action:'resume-group-member',reason:'fresh stopped group source, authority, receipt and receiver verified',succession:{ref:refreshed.inspection.reference,receipt:refreshed.inspection.receipt},members,receiver:setup.receiver}
}
const groupClaim=(task:import('./shared-claims.ts').TaskRecord,stateCommit:string,target:import('./shared-claims.ts').CoordinationTarget):SharedClaim=>({...groupBinding(task),stateCommit,target})
async function refreshRecoveredGroupStarts(starts:PreparedStoppedGroup['group']['starts'],config:FactoryConfig,gh:TickDeps['gh']):Promise<PreparedStoppedGroup['group']['starts']>{
 const owner=await import('./shared-claims.ts'),operation=starts.parent.task.schemaVersion===2?starts.parent.task.successionOperationId:null
 if(!operation)throw Error('recovered group succession unavailable before child start')
 const target=await verifiedSharedTarget(starts.parent.task.repo,config,starts.parent.task.runId,gh),parent=await owner.inspectCoordinationTask(target,starts.parent.task.taskKey)
 if(parent.kind!=='active'||parent.task.schemaVersion!==2||parent.task.successionOperationId!==operation)throw Error('recovered group parent authorization changed before child start')
 const inspected=await owner.inspectGroupSuccession(target,{operationId:operation,parent:groupBinding(parent.task)})
 if(inspected.kind!=='verified')throw Error('recovered group ownership unavailable before child start: '+inspected.reason)
 const expected=[starts.parent,...starts.children],current=new Map(inspected.currentMembers.map(row=>[row.current.taskKey,row.current]))
 if(current.size!==expected.length||expected.some(row=>{const task=current.get(row.task.taskKey);return!task||canonicalWire(groupBinding(task))!==canonicalWire(groupBinding(row.task))}))throw Error('recovered group member changed before child start')
 const project=(row:typeof starts.parent)=>{const task=current.get(row.task.taskKey)!;return{task,claim:groupClaim(task,inspected.reference.commitSha,target),startOperationId:row.startOperationId}}
 return{parent:project(starts.parent),children:starts.children.map(project)}
}
async function continueSameHomeGroupMember(input:{repo:string;intent:StoppedGroupRecoveryIntent;parentIssue:number;material:RemoteRecoveryMaterial;current:import('./shared-claims.ts').TaskRecordV2;succession:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>;checkout:string;config:FactoryConfig;target:import('./shared-claims.ts').CoordinationTarget;gh:TickDeps['gh'];localClaim:Claim;checkouts:Map<string,string>;source?:RemoteRecoveryTransport['source'];saved:RunRecord}):Promise<RunRecord>{
 const helpers=await import('./runs.ts'),saved=input.saved,requestId=stableGroupRequestId(input.intent.operationId,input.material.task.taskKey),prior=saved.continuations?.find(row=>row.requestId===requestId),previousAttemptId=prior?.previousAttemptId??saved.attemptId??saved.runId,expectedGeneration=prior?saved.generation-1:saved.generation
 const original=input.material.task,expectedParent=original.taskKey===input.intent.parentTaskKey?null:input.parentIssue
 if(!saved.checkpoint||!saved.worktreeDigest||saved.runId!==original.runId||saved.repo!==original.repo||saved.issue!==original.issue||saved.parent!==expectedParent||saved.machine?.id!==original.machineId||saved.machine.installationId!==original.installationId||saved.machine.sessionId!==original.sessionId||saved.machine.hostBindingDigest!==original.stopProof?.hostBindingDigest||saved.sharedClaim?.taskKey!==original.taskKey||saved.sharedClaim.generation!==original.generation||saved.sharedClaim.ownerToken!==original.ownerToken||canonicalWire(saved.checkpoint)!==canonicalWire(original.checkpoint)||canonicalWire(saved.execution)!==canonicalWire(original.recovery?.execution)||canonicalWire(saved.remoteEffectCoverage)!==canonicalWire(original.recovery?.remoteEffectCoverage)||canonicalWire(saved.approvalBindings)!==canonicalWire(original.approvalBindings)||canonicalWire(saved.approvalRefs)!==canonicalWire(input.material.artifacts)||canonicalWire(saved.authorityRequest)!==canonicalWire(input.material.authorityRequest))throw Error('same-home stopped group run identity differs')
 const selectedRequest:import('./runs.ts').GroupReceivingRunRequest={root:runsRoot(input.config.home),requestId,runId:saved.runId,taskKey:input.current.taskKey,expectedSharedGeneration:input.current.generation,checkout:input.checkout,parentTaskKey:input.intent.parentTaskKey,role:input.current.taskKey===input.intent.parentTaskKey?'parent':'child',currentMember:groupBinding(input.current),succession:input.succession}
 const fresh=await stoppedGroupDecision({...input,request:selectedRequest})
 const selected=fresh.members.find(row=>row.original.task.taskKey===input.current.taskKey)
 if(!selected||canonicalWire(selected.artifacts)!==canonicalWire(saved.approvalRefs)||canonicalWire(selected.authorityRequest)!==canonicalWire(saved.authorityRequest)||fresh.receiver.worktreeDigest!==saved.worktreeDigest)throw Error('same-home stopped group decision differs')
 const currentOwner={machine:fresh.receiver.machine,sharedClaim:{taskKey:input.current.taskKey,generation:input.current.generation,ownerToken:input.current.ownerToken,stateCommit:input.succession.commitSha}},request:import('./runs.ts').RunContinuationRequest={root:runsRoot(input.config.home),runId:saved.runId,expectedGeneration,requestId,previousAttemptId,checkpoint:saved.checkpoint,worktreeDigest:saved.worktreeDigest,currentOwner}
 return helpers.beginVerifiedRunContinuation(request,{verifyRecovery:async({run,request:actual})=>{
  const decision=await stoppedGroupDecision({...input,request:selectedRequest}),member=decision.members.find(row=>row.original.task.taskKey===input.current.taskKey)
  if(!member||run.runId!==saved.runId||canonicalWire(actual)!==canonicalWire(request)||canonicalWire(member.artifacts)!==canonicalWire(run.approvalRefs)||canonicalWire(member.authorityRequest)!==canonicalWire(run.authorityRequest)||decision.receiver.worktreeDigest!==run.worktreeDigest)throw Error('same-home stopped group fresh decision differs')
  return{action:'resume-task',reason:'fresh stopped group same-home continuation verified',runId:run.runId,expectedGeneration:actual.expectedGeneration,previousAttemptId:actual.previousAttemptId,taskIds:member.taskIds,approvedTaskIds:run.approvedTaskIds!,approvalBindings:run.approvalBindings,recordBinding:run.recordBinding,artifacts:run.approvalRefs,execution:run.execution!,checkpoint:actual.checkpoint,worktreeDigest:actual.worktreeDigest,currentOwner:actual.currentOwner,sourceRefs:member.sourceRefs}
 }})
}
export async function prepareVerifiedStoppedGroup(input:{repo:string;parentTaskKey:string;config:FactoryConfig;localClaim:Claim;target?:import('./shared-claims.ts').CoordinationTarget;gh?:TickDeps['gh'];source?:RemoteRecoveryTransport['source']}):Promise<PreparedStoppedGroup>{
 const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),gh=input.gh??ghText,root=runsRoot(input.config.home),target=input.target??await verifiedSharedTarget(input.repo,input.config,undefined,gh)
 return stoppedGroupSerial(target,'prepare',async()=>{
 await mkdir(root,{recursive:true,mode:0o700})
 const machine=sharedMachineContexts.get(target)
 if(!machine||machine.defaults.recovery!=='verified-transfer'||input.localClaim.path!==repoLockPath(input.config,input.repo))throw Error('stopped group recovery owner unavailable')
 await(await import('./claims.ts')).renewClaim(input.localClaim)
 const snapshot=await owner.readCoordination(target),currentParent=snapshot.tasks[input.parentTaskKey]
 if(!currentParent||currentParent.repo!==input.repo||currentParent.parentTaskKey!==null)throw Error('stopped group current parent unavailable')
 const intentPath=join(root,'receiving-group-'+input.parentTaskKey+'-'+currentParent.runId+'.json')
 let intent=await readStoppedGroupIntent(intentPath),materials:RemoteRecoveryMaterial[]
 if(intent&&currentParent.schemaVersion===2&&currentParent.successionOperationId===intent.operationId){materials=(await stoppedGroupMaterialsFromReceipt({repo:input.repo,intent,currentParent,config:input.config,target,gh,source:input.source})).materials}
 else materials=await stoppedGroupMaterialsAt({repo:input.repo,parentTaskKey:input.parentTaskKey,head:snapshot.head,tasks:Object.values(snapshot.tasks),config:input.config,target,gh,source:input.source})
 if(!intent){intent=await stoppedGroupDescriptor(materials,input.parentTaskKey,randomUUID());await helpers.atomicRunFile(intentPath,intent);const readback=await readStoppedGroupIntent(intentPath);if(!readback||canonicalWire(readback)!==canonicalWire(intent))throw Error('stopped group durable intent readback differs')}
 else{const current=await stoppedGroupDescriptor(materials,input.parentTaskKey,intent.operationId);if(canonicalWire(current)!==canonicalWire(intent))throw Error('stopped group durable intent differs')}
 const saved=await helpers.readRuns(root),checkouts=new Map<string,string>()
 for(const material of materials){const local=saved.find(run=>run.runId===material.task.runId),checkout=local?await realpath(local.checkout):await receivingCheckout(material,input.config),checkpoint=material.task.checkpoint
  if(!checkpoint)throw Error('stopped group member checkpoint unavailable')
  const branch=spawnSync('git',['symbolic-ref','--short','HEAD'],{cwd:checkout,encoding:'utf8',timeout:3000}),head=spawnSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8',timeout:3000})
  if(branch.status!==0||head.status!==0||branch.stdout.trim()!==checkpoint.branch||head.stdout.trim()!==checkpoint.headSha)throw Error('stopped group member checkout differs')
  checkouts.set(material.task.taskKey,checkout)
 }
 const sessionId=currentParent.schemaVersion===2&&currentParent.successionOperationId===intent.operationId?currentParent.sessionId:dispatcherSessionId
 const session:MachineSession={target,localRoot:target.localRoot,machineId:machine.id,installationId:machine.installationId,sessionId,hostBindingDigest:machine.hostBindingDigest,bootIdDigest:await(await import('./machine-identity.ts')).readBootIdentityDigest(),identity:await processIdentity()}
 const setupOwner=(target as StoppedGroupTarget)[stoppedGroupSetupOverride]??receivingExecutionSetup,setupDigests=new Map<string,string>()
 for(const material of materials){const setup=await setupOwner(material,checkouts.get(material.task.taskKey)!,input.config,target,input.localClaim,session.sessionId);setupDigests.set(material.task.taskKey,createHash('sha256').update(canonicalWire(setup)).digest('hex'))}
 let recovered:Awaited<ReturnType<typeof recoverStoppedGroupMaterials>>
 try{recovered=await recoverStoppedGroupMaterials({operationId:intent.operationId,parentTaskKey:intent.parentTaskKey,materials,machine,session,runtime:{config:input.config,gh,localClaim:input.localClaim,checkouts,setupDigests,setup:setupOwner,source:input.source}})}catch(error){throw Error('stopped group succession verification: '+(error as Error).message)}
 if(recovered.kind!=='owned')throw Error('stopped group ownership unavailable: '+recovered.reason)
 const currentByKey=new Map(recovered.inspection.currentMembers.map(row=>[row.current.taskKey,row.current])),runs:RunRecord[]=[],progressed=[...currentByKey.values()].some(task=>task.taskKey===intent!.parentTaskKey?task.state!=='claimed':task.state!=='recovery-queued')
 for(const material of materials){
  const current=currentByKey.get(material.task.taskKey)
  if(!current||current.schemaVersion!==2)throw Error('stopped group current member unavailable')
  const checkout=checkouts.get(current.taskKey)!,request:import('./runs.ts').GroupReceivingRunRequest={root,requestId:stableGroupRequestId(intent.operationId,current.taskKey),runId:current.runId,taskKey:current.taskKey,expectedSharedGeneration:current.generation,checkout,parentTaskKey:intent.parentTaskKey,role:current.taskKey===intent.parentTaskKey?'parent':'child',currentMember:groupBinding(current),succession:recovered.reference}
  const local=saved.find(run=>run.runId===current.runId)
  if(progressed){
   if(!local||!local.sharedClaim||local.sharedClaim.taskKey!==current.taskKey||local.sharedClaim.generation!==current.generation||local.sharedClaim.ownerToken!==current.ownerToken||!['prepared','running'].includes(local.state))throw Error('partially started stopped group lacks complete local attempts')
   let decision:Awaited<ReturnType<typeof stoppedGroupDecision>>
   try{decision=await stoppedGroupDecision({repo:input.repo,intent,request,config:input.config,target,gh,localClaim:input.localClaim,checkouts,source:input.source},true)}catch(error){throw Error('partially started stopped group member verification: '+(error as Error).message)}
   const selected=decision.members.find(row=>row.original.task.taskKey===current.taskKey)
   if(!selected||canonicalWire(local.approvalRefs)!==canonicalWire(selected.artifacts)||canonicalWire(local.authorityRequest)!==canonicalWire(selected.authorityRequest)||local.worktreeDigest!==decision.receiver.worktreeDigest)throw Error('partially started stopped group attempt differs')
   if(local.remoteRecovery?.kind==='receiving-group'){if(local.remoteRecovery.requestId!==request.requestId||local.remoteRecovery.succession.operationId!==intent.operationId||local.remoteRecovery.parentTaskKey!==intent.parentTaskKey||local.remoteRecovery.role!==request.role)throw Error('partially started receiving provenance differs')}
   else if(!local.continuations?.some(row=>row.requestId===request.requestId))throw Error('partially started same-home continuation differs')
   runs.push(local)
  }
  else if(local&&!local.remoteRecovery){runs.push(await continueSameHomeGroupMember({repo:input.repo,intent,parentIssue:materials.find(row=>row.task.taskKey===intent!.parentTaskKey)!.task.issue,material,current,succession:recovered.reference,checkout,config:input.config,target,gh,localClaim:input.localClaim,checkouts,source:input.source,saved:local}))}
  else runs.push(await helpers.createVerifiedGroupReceivingRun(request,{verifyRecovery:value=>stoppedGroupDecision({repo:input.repo,intent,request:value,config:input.config,target,gh,localClaim:input.localClaim,checkouts,source:input.source})}))
 }
  const readback=await Promise.all(runs.map(run=>helpers.readRun(root,run.runId)))
 if(canonicalWire(readback.map(run=>run.runId).sort())!==canonicalWire(materials.map(row=>row.task.runId).sort()))throw Error('stopped group local attempt set incomplete')
  const parent=readback.find(run=>run.sharedClaim?.taskKey===intent!.parentTaskKey)
  if(!parent)throw Error('stopped group local parent unavailable')
 const parentMaterial=materials.find(row=>row.task.taskKey===intent!.parentTaskKey)!
 let installed:Awaited<ReturnType<typeof import('./children.ts')['installRecoveredChildrenContext']>>
 try{installed=await(await import('./children.ts')).installRecoveredChildrenContext({parent,material:parentMaterial,config:input.config},{target,gh})}catch(error){throw Error('stopped group child context verification: '+(error as Error).message)}
 const freshTarget=await verifiedSharedTarget(input.repo,input.config,parent.runId,gh),freshMachine=sharedMachineContexts.get(freshTarget)
 if(!freshMachine||freshMachine.id!==machine.id||freshMachine.installationId!==machine.installationId||freshMachine.hostBindingDigest!==machine.hostBindingDigest)throw Error('stopped group receiver authorization changed before start')
 const startRead=await owner.inspectGroupSuccession(freshTarget,{operationId:intent.operationId,parent:recovered.parent})
 if(startRead.kind!=='verified'||canonicalWire(startRead.reference)!==canonicalWire(recovered.reference)||canonicalWire(startRead.currentMembers)!==canonicalWire(recovered.inspection.currentMembers))throw Error('stopped group ownership changed before start')
 const startByKey=new Map(startRead.currentMembers.map(row=>[row.current.taskKey,row.current]))
 const members=readback.map(run=>{const task=startByKey.get(run.sharedClaim!.taskKey);if(!task)throw Error('stopped group member unavailable before start');return{task,claim:groupClaim(task,startRead.reference.commitSha,freshTarget),startOperationId:run.attemptOperationIds!.start}}),parentMember=members.find(row=>row.task.taskKey===intent!.parentTaskKey)!,children=members.filter(row=>row!==parentMember)
 let started:Awaited<ReturnType<typeof import('./children.ts')['startRecoveredGroupMembers']>>
 try{started=await(await import('./children.ts')).startRecoveredGroupMembers({parent:parentMember,children,deferChildren:true})}catch(error){throw Error('stopped group parent start failed: '+(error as Error).message)}
 const material=materials.find(row=>row.task.taskKey===intent!.parentTaskKey)!,setup=await setupOwner(material,parent.checkout,input.config,target,input.localClaim,parent.machine!.sessionId),completed=new Set((material.packet.completed as Array<{taskId:string}>|undefined)?.map(row=>row.taskId)??[]),taskIds=material.task.approvedTaskIds.filter(id=>!completed.has(id))
 let plan=continuationLaunchPlan(setup.plan,{taskIds,sourceRefs:material.sourceRefs},material.packet,material.unavailableContext)
 const note='\nThe recovery controller owns the already-admitted child run and join operations for this group. Do not launch, re-claim, or replay child work yourself; consume only its verified results.\n',positions=plan.args.flatMap((value,index)=>value===plan.prompt?[index]:[])
 if(positions.length!==1)throw Error('stopped group parent prompt binding unavailable')
 const prompt=plan.prompt+note;plan={...plan,prompt,args:plan.args.map((value,index)=>index===positions[0]?prompt:value)}
 return{run:parent,claim:started.parent,plan,started:true,group:{guard:'plan-lint',ok:true,groups:installed.record.groups,starts:{parent:parentMember,children}}}
 })
}
export async function prepareVerifiedReceivingRun(input:{repo:string;taskKey:string;runId?:string},config:FactoryConfig,localClaim:Claim):Promise<{run:RunRecord;claim:SharedClaim;plan:LaunchPlan;taskIds:string[]}> {
 const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),root=runsRoot(config.home),target=await verifiedSharedTarget(input.repo,config),machine=sharedMachineContexts.get(target)!
 if(localClaim.path!==repoLockPath(config,input.repo)||machine.defaults.recovery!=='verified-transfer')throw Error('receiving repository recovery ownership unavailable')
 await(await import('./claims.ts')).renewClaim(localClaim)
 const observed=await owner.inspectCoordinationTask(target,input.taskKey)
 if(observed.kind!=='active'||input.runId&&observed.task.runId!==input.runId)throw Error('receiving current logical run differs')
 const intentPath=join(root,'receiving-'+input.taskKey+'-'+observed.task.runId+'.json')
 let intent:ReceivingIntent|null=null
 try{intent=JSON.parse(await helpers.readPrivateRunFile(intentPath)) as ReceivingIntent}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 if(!intent){
  const original=await inspectRemoteRecovery({...input,config},{target});assertRemoteRecoveryMaterial(original)
  if(original.task.parentTaskKey!==null||original.children.length||!original.task.stopProof||!original.task.recovery)throw Error('standalone receiving recovery requires original stopped ownership')
  if((await helpers.readRuns(root)).some(run=>run.runId===original.task.runId))throw Error('original local run exists; use same-home recovery')
  const checkout=await receivingCheckout(original,config)
  await receivingExecutionSetup(original,checkout,config,target,localClaim,dispatcherSessionId)
  const task=original.task,originalBinding={taskKey:task.taskKey,runId:task.runId,generation:task.generation,ownerToken:task.ownerToken,machineId:task.machineId,installationId:task.installationId,sessionId:task.sessionId}
  intent={schemaVersion:1,repo:input.repo,taskKey:input.taskKey,runId:task.runId,operationId:randomUUID(),requestId:randomUUID(),original:originalBinding,stateCommit:original.stateCommit,machine,checkout,
   session:{machineId:machine.id,installationId:machine.installationId,sessionId:dispatcherSessionId,hostBindingDigest:machine.hostBindingDigest,bootIdDigest:await(await import('./machine-identity.ts')).readBootIdentityDigest(),identity:await processIdentity()},
   candidate:{host:task.host,repo:task.repo,issue:task.issue,repositoryNodeId:task.repositoryNodeId,issueNodeId:task.issueNodeId,scopeDigest:task.scopeDigest,approvalDigest:task.approvalDigest,approvalBindings:task.approvalBindings,runId:task.runId,stage:task.stage,paths:task.paths,resources:task.resources,independent:task.independent,parentTaskKey:null,parentBinding:null,approvedTaskIds:task.approvedTaskIds},stopProof:task.stopProof!,recovery:task.recovery!,handoff:null}
  await helpers.atomicRunFile(intentPath,intent)
 }
 if(!intent)throw Error('receiving intent unavailable')
 if(intent.schemaVersion!==1||intent.repo!==input.repo||intent.taskKey!==input.taskKey||intent.runId!==observed.task.runId||canonicalWire(intent.machine)!==canonicalWire(machine))throw Error('receiving intent identity differs')
 if(!intent.handoff&&observed.task.generation===intent.original.generation+1){
  const raw=await target.provider.read(target,observed.head,owner.operationPath(intent.operationId))
  if(raw){
   const ref={kind:'state-receipt' as const,operationId:intent.operationId,commitSha:observed.head,blobSha256:owner.sha256(raw)}
   const retained=await owner.inspectHandoffCoordinationTask(target,{taskKey:intent.taskKey,expected:intent.original,evidence:ref})
   if(retained.kind!=='historical-handoff'||retained.handedOff.ownerToken!==observed.task.ownerToken||retained.handedOff.machineId!==machine.id||retained.handedOff.sessionId!==intent.session.sessionId)throw Error('receiving prior handoff requires reconciliation')
   intent.handoff=ref;await helpers.atomicRunFile(intentPath,intent)
  }
 }
 if(!intent.handoff&&canonicalWire(intent.session.identity)!==canonicalWire(await processIdentity()))throw Error('receiving intent requires current session reconciliation')
 originalOwnerRepository.set(intent.original,input.repo)
 if(!intent.handoff){
  const currentIntent=intent
  const freshOriginal=async()=>{
   const value=await inspectRemoteRecovery({...input,config},{target});assertRemoteRecoveryMaterial(value)
   if(canonicalWire({taskKey:value.task.taskKey,runId:value.task.runId,generation:value.task.generation,ownerToken:value.task.ownerToken,machineId:value.task.machineId,installationId:value.task.installationId,sessionId:value.task.sessionId})!==canonicalWire(currentIntent.original)||canonicalWire(value.task.recovery)!==canonicalWire(currentIntent.recovery)||canonicalWire(value.task.stopProof)!==canonicalWire(currentIntent.stopProof))throw Error('original receiving source or owner changed')
   await receivingExecutionSetup(value,currentIntent.checkout,config,target,localClaim,currentIntent.session.sessionId)
   return value
  }
  target.verifyCandidate=async(candidate,current,session)=>{if(canonicalWire(candidate)!==canonicalWire(currentIntent.candidate)||canonicalWire(current)!==canonicalWire(machine)||canonicalWire(session.identity)!==canonicalWire(currentIntent.session.identity))throw Error('receiving candidate differs');await freshOriginal()}
  target.verifyTransition=async(task,transition)=>{if(transition.kind!=='handoff'||task.taskKey!==currentIntent.taskKey||canonicalWire(transition.candidate)!==canonicalWire(currentIntent.candidate)||canonicalWire(transition.stopProof)!==canonicalWire(currentIntent.stopProof)||canonicalWire(transition.recovery)!==canonicalWire(currentIntent.recovery))throw Error('receiving target permits only its exact handoff');await freshOriginal()}
  const initial=await freshOriginal()
  target.verifyEvidence=async(ref,payload)=>{const proof=initial.evidence.find(row=>canonicalWire(row.ref)===canonicalWire(ref));if(!proof||canonicalWire(proof.payload)!==canonicalWire(payload))throw Error('receiving handoff evidence differs')}
  const moved=await owner.transitionSharedTask({claim:{...intent.original,stateCommit:intent.stateCommit,target},operationId:intent.operationId,transition:{kind:'handoff',machine,session:{...intent.session,target,localRoot:target.localRoot},candidate:intent.candidate,stopProof:intent.stopProof,recovery:intent.recovery}})
  if(moved.kind!=='owned')throw Error('receiving ownership remains pending: '+moved.reason)
  const raw=await target.provider.read(target,moved.claim.stateCommit,owner.operationPath(intent.operationId));if(!raw)throw Error('receiving handoff receipt unavailable')
  intent.handoff={kind:'state-receipt',operationId:intent.operationId,commitSha:moved.claim.stateCommit,blobSha256:owner.sha256(raw)}
  await helpers.atomicRunFile(intentPath,intent)
 }
 const request:import('./runs.ts').ReceivingRunRequest={root,requestId:intent.requestId,runId:intent.runId,taskKey:intent.taskKey,expectedSharedGeneration:intent.original.generation+1,checkout:intent.checkout,handoff:intent.handoff}
 let decision:import('./runs.ts').VerifiedReceivingRunDecision|undefined
 const run=await helpers.createVerifiedReceivingRun(request,{verifyRecovery:async value=>decision=await verifyReceivingRunRecovery(value,intent!.original,config,localClaim)})
 if(!decision)throw Error('fresh receiving launch decision unavailable')
 const material=await inspectReceivingRecovery(request,intent.original,config,{target}),setup=await receivingExecutionSetup(material.original,request.checkout,config,target,localClaim,run.machine!.sessionId)
 const claim=await sharedClaimForRun(run,config),packet=await checkpointRecoveryContext(run,config,{claim})
 const rechecked=await inspectReceivingRecovery(request,intent.original,config,{target})
 if(canonicalWire(rechecked.taskIds)!==canonicalWire(decision.taskIds))throw Error('receiving outstanding tasks changed before launch')
 const plan=continuationLaunchPlan(setup.plan,{taskIds:decision.taskIds,sourceRefs:rechecked.original.sourceRefs},packet,material.original.unavailableContext)
 return {run,claim,plan,taskIds:decision.taskIds}
}

export async function checkpointRecoveryContext(run:RunRecord,config:FactoryConfig,transport:{gh?:TickDeps['gh'];claim?:SharedClaim}={}):Promise<Record<string,unknown>> {
 const helpers=await import('./runs.ts'),core=await recoveryScript(),root=runsRoot(config.home)
 await verifyDispatchRunAuthority(run,config,'effect',{gh:transport.gh})
 const {approval}=await helpers.approvalTools(),readJson=(args:string[])=>boundedGhJson<any>(transport.gh??ghText,args,readBudget())
 const brief=await readJson(['api',`repos/${run.repo}/issues/${run.issue}`]),comments=await approval.readPages(readJson,['api',`repos/${run.repo}/issues/${run.issue}/comments`]) as Array<{id:number;node_id:string;body:string;updated_at:string}>
 const briefRef=run.approvalRefs.find(ref=>ref.kind==='brief'),planRef=run.approvalRefs.find(ref=>ref.kind==='plan'),plan=comments.find(row=>row.node_id===planRef?.artifactId)
 if(!briefRef||!planRef||!plan||approval.scopeDigest(plan.body,'plan')!==planRef.digest||approval.scopeDigest(brief.body,'brief')!==briefRef.digest||!run.approvedTaskIds?.length)throw Error('current recovery source unavailable')
 const result=spawnSync('git',['rev-parse','--verify',run.headSha+'^{commit}'],{cwd:run.checkout,encoding:'utf8',timeout:3000,maxBuffer:4096})
 if(result.status!==0||result.stdout.trim()!==run.headSha)throw Error('recovery source commit unavailable')
 let previous:any=null
 try{previous=core.validateRecoveryPacket(JSON.parse(await helpers.readPrivateRunFile(join(root,run.runId,'recovery.json'))))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 if(previous&&(canonicalWire(previous.approvalBindings)!==canonicalWire(run.approvalBindings)||canonicalWire(previous.recordBinding)!==canonicalWire(run.recordBinding)||canonicalWire(previous.taskIds)!==canonicalWire(run.approvedTaskIds)||canonicalWire(previous.planRef)!==canonicalWire(planRef)||canonicalWire(previous.briefRef)!==canonicalWire(briefRef)))throw Error('prior recovery authority changed; original packet retained')
 let completed:Array<{taskId:string;headSha:string;evidenceUrl:string}>=previous?.completed??[]
 if(run.sharedClaim){
  const claim=transport.claim??await sharedClaimForRun(run,config),owner=await import('./shared-claims.ts'),snapshot=await owner.inspectCoordinationTask(claim.target,claim.taskKey,{runId:run.runId,generation:claim.generation,ownerToken:claim.ownerToken})
  if(snapshot.kind!=='active'&&snapshot.kind!=='completed')throw Error('recovery current shared task unavailable')
  for(const row of snapshot.task.recovery?.completed??[]){
   const payload=await owner.resolveEvidence(claim.target,row.acceptance.evidence)
   if(payload?.kind!=='acceptance'||payload.result!=='passed'||payload.taskId!==row.taskId||payload.sourceSha!==row.headSha||payload.scopeDigest!==run.taskKey.scopeDigest)throw Error('completed recovery source evidence differs')
   if(row.acceptance.evidence.kind!=='state-receipt')throw Error('immutable completed task evidence unavailable')
   const entry={taskId:row.taskId,headSha:row.headSha,evidenceUrl:'vsk-state:'+row.acceptance.evidence.commitSha+':'+row.acceptance.evidence.operationId}
   if(completed.some(old=>old.taskId===entry.taskId&&canonicalWire(old)!==canonicalWire(entry)))throw Error('completed task evidence changed')
   if(!completed.some(old=>old.taskId===entry.taskId))completed=[...completed,entry]
  }
 }
 const newest=[...comments].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at))[0]
 if(!newest)throw Error('complete recovery comment cursor unavailable')
 const gate=await import(new URL(fileURLToPath(import.meta.url).endsWith('.ts')?'../../../skills/dev/dev-ship/scripts/ship-gate.mjs':'../skill/dev-ship/scripts/ship-gate.mjs',import.meta.url).href) as typeof import('../../../skills/dev/dev-ship/scripts/ship-gate.mjs')
 const reviews=comments.filter(row=>/^<!-- vsk:v1 type=review\b/m.test(row.body)).sort((a,b)=>Date.parse(a.updated_at)-Date.parse(b.updated_at)).slice(-16).flatMap(row=>{
  const binding=gate.typedSection(row.body,'reviewBinding')
  if(!gate.validReview(binding)||binding.baseSha!==run.baseSha||binding.scopeDigest!==planRef.digest)return[]
  const ancestry=spawnSync('git',['merge-base','--is-ancestor',binding.sha,run.headSha!],{cwd:run.checkout,timeout:3000})
  return ancestry.status===0?[{commentId:row.id,bodySha256:createHash('sha256').update(row.body).digest('hex'),agent:/\bagent=(claude|codex)\b/.exec(row.body)?.[1]??'',binding}]:[]
 })
 const findingState=new Map<string,{id:string;status:string;sourceRef:string;sha:string}>()
 for(const review of reviews){if(!['claude','codex'].includes(review.agent)||review.agent===run.harness)continue;for(const finding of review.binding.findings)findingState.set(finding.id,{...finding,sourceRef:'review:'+review.commentId+':'+review.bodySha256,sha:review.binding.sha})}
 const openFindings=[...(previous?.openFindings??[]).filter((finding:any)=>!finding||typeof finding!=='object'||!findingState.has(finding.id)),...[...findingState.values()].filter(finding=>finding.status==='open')]
 const packet={schemaVersion:3,repo:run.repo,issue:run.issue,briefRef,planRef,approvalIds:run.approvalBindings.map(row=>row.approvalId),approvalBindings:run.approvalBindings,recordBinding:run.recordBinding,taskIds:run.approvedTaskIds,completed,lastVerifiedCommit:run.headSha,openFindings,rulings:comments.flatMap(row=>row.body.split('\n').filter(line=>/^- Ruling:/.test(line))),commentCursor:previous?.commentCursor??{id:String(newest.id),updatedAt:newest.updated_at},pendingRunIds:run.state==='terminal'&&run.terminationCause==='succeeded'?[...new Set(run.pendingDelivery.filter(row=>row.status!=='acknowledged').map(()=>run.runId))]:[run.runId],learning:previous?.learning??[]}
 core.validateRecoveryPacket(packet)
 const lock=await acquireClaim(join(root,run.runId,'learning-mutation'),await processIdentity())
 if(lock.kind!=='owned')throw Error('recovery context mutation unavailable')
 try{
  if((await readRun(root,run.runId)).generation!==run.generation)throw Error('recovery run changed during source inspection')
  let atWrite:any=null
  try{atWrite=JSON.parse(await helpers.readPrivateRunFile(join(root,run.runId,'recovery.json')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(canonicalWire(atWrite)!==canonicalWire(previous))throw Error('recovery packet changed during source inspection')
  await helpers.atomicRunFile(join(root,run.runId,'recovery-source.json'),{schemaVersion:1,planRef,planBody:plan.body,reviews})
  await helpers.atomicRunFile(join(root,run.runId,'recovery.json'),packet)
 }finally{await releaseClaim(lock.claim)}
 return packet
}

export async function inspectLocalRecovery(run:RunRecord,config:FactoryConfig,options:{currentOwner?:import('./runs.ts').RunContinuationRequest['currentOwner'];gh?:TickDeps['gh'];claim?:SharedClaim}={}):Promise<{action:string;taskIds:string[];reason:string;sourceRefs:unknown[]}> {
 const helpers=await import('./runs.ts'),core=await recoveryScript(),root=runsRoot(config.home)
 const owned=options.currentOwner?{...run,...options.currentOwner}:run
 const currentClaim=async()=>{
  const claim=options.claim??await sharedClaimForRun(owned,config)
  if(!owned.machine||!owned.sharedClaim||claim.taskKey!==owned.sharedClaim.taskKey||claim.runId!==owned.runId||claim.generation!==owned.sharedClaim.generation||claim.ownerToken!==owned.sharedClaim.ownerToken||claim.machineId!==owned.machine.id||claim.installationId!==owned.machine.installationId||claim.sessionId!==owned.machine.sessionId)throw Error('recovery supplied owner differs')
  const checked=await(await import('./shared-claims.ts')).inspectCoordinationTask(claim.target,claim.taskKey,{runId:claim.runId,generation:claim.generation,ownerToken:claim.ownerToken,machineId:claim.machineId,installationId:claim.installationId,sessionId:claim.sessionId})
  if(checked.kind!=='active'&&checked.kind!=='completed')throw Error('recovery current owner unavailable')
  return claim
 }
 try{
  const packet=core.validateRecoveryPacket(JSON.parse(await helpers.readPrivateRunFile(join(root,run.runId,'recovery.json'))))
  await verifyDispatchRunAuthority(run,config,run.terminationCause==='succeeded'?'effect':'launch',{gh:options.gh})
  const entry=config.repos.find(row=>row.repo===run.repo);if(!entry)throw Error('recovery repository is not configured')
  const devMd=await readFile(join(entry.path,'.vegastack/dev.md'),'utf8'),effective=loadConfiguredPolicy({home:config.home,repo:run.repo,devMd,settingsPath:config.settingsPath})
  if(!effective.ok)throw Error('current recovery policy unavailable')
  const {approval}=await helpers.approvalTools(),readJson=(args:string[])=>boundedGhJson<any>(options.gh??ghText,args,readBudget())
  const current=await core.readRecoverySources(packet,{readJson,operators:repoPolicyFromEffective(effective).operators,checkout:run.checkout,
   consolidatedRequest:run.authorityRequest?.kind==='consolidated'?run.authorityRequest:undefined,
   readCompletionEvidence:async(row:{taskId:string;headSha:string;evidenceUrl:string})=>{
    if(!run.sharedClaim)return false
    const claim=await currentClaim(),owner=await import('./shared-claims.ts'),snapshot=await owner.inspectCoordinationTask(claim.target,claim.taskKey,{runId:run.runId,generation:claim.generation,ownerToken:claim.ownerToken})
    if(snapshot.kind!=='active'&&snapshot.kind!=='completed')return false
    const found=snapshot.task.recovery?.completed.find(entry=>entry.taskId===row.taskId&&entry.headSha===row.headSha)
    if(!found||found.acceptance.evidence.kind!=='state-receipt'||row.evidenceUrl!=='vsk-state:'+found.acceptance.evidence.commitSha+':'+found.acceptance.evidence.operationId)return false
    const payload=await owner.resolveEvidence(claim.target,found.acceptance.evidence)
    return payload?.kind==='acceptance'&&payload.result==='passed'&&payload.taskId===row.taskId&&payload.sourceSha===row.headSha
   }})
  const reconciled=core.reconcileRecovery(packet,current)
  const checked=[...((current as any).comments??[])].filter((row:any)=>row.node_id===packet.planRef.artifactId).flatMap((row:any)=>[...row.body.matchAll(/^-\s*\[x\].*<!--\s*task-id:([1-9]\d*-T[1-9]\d*)\s*-->/gim)].map((match:any)=>match[1]))
  if(checked.some((id:string)=>!packet.completed.some((row:any)=>row.taskId===id)))reconciled.blocks.push('checked task lacks verified completion evidence; no blind replay')
  if(!await helpers.verifyLocalRunStopped(run))reconciled.blocks.push('original local execution remains unconfirmed')
  if(!run.worktreeDigest||await helpers.worktreeFingerprint(run.checkout)!==run.worktreeDigest)reconciled.blocks.push('original worktree changed; preserved for reconciliation')
  if(run.cancelRequestedAt)reconciled.blocks.push('explicit cancellation requires fresh resume authority')
  if(run.sharedClaim)await currentClaim()
  if(run.terminationCause==='succeeded'&&reconciled.outstandingTaskIds.length)reconciled.blocks.push('successful execution requires verified task acceptance; implementation is not replayed')
  const decision=core.chooseResumeAction({...reconciled,pendingDelivery:run.pendingDelivery.filter(row=>row.status!=='acknowledged')})
  return {...decision,sourceRefs:reconciled.sourceRefs}
 }catch(error){return{action:'refuse',taskIds:[],reason:(error as Error).message,sourceRefs:[]}}
}

export async function retryRecoveredDelivery(run:RunRecord,config:FactoryConfig):Promise<{pending:string[];reason:string}> {
 const helpers=await import('./runs.ts')
 await verifyDispatchRunAuthority(run,config,'effect')
 const original=run.pendingDelivery.map(row=>({id:row.id,kind:row.kind,target:row.target,payloadDigest:row.payloadDigest}))
 if(run.terminationCause==='termination-unconfirmed'||run.waitReason)throw Error('run terminal identity remains unresolved')
 if(run.pendingDelivery.some(row=>row.kind==='feature-push'&&row.status!=='acknowledged'))await(await import('./checkpoints.ts')).flushRunCheckpoint(run,config)
 if(run.pendingDelivery.some(row=>row.kind==='handback'&&row.status!=='acknowledged'))await flushRunHandback(await readRun(runsRoot(config.home),run.runId),config)
 const records=await import('./stats/record.ts')
 const context=await records.registeredCaptureContext(config.home,run.repo,run.checkout)
 if(context)for(const pending of run.pendingDelivery.filter(row=>row.kind==='telemetry-capture'&&row.status!=='acknowledged')){
  if(!('captureKey'in pending.target))throw Error('original terminal capture identity unavailable')
  await records.captureTerminalRun(config.home,run.runId,context.destination,context.policy,pending.target.captureKey)
 }
 const current=await readRun(runsRoot(config.home),run.runId)
 if(original.some(row=>!current.pendingDelivery.some(next=>next.id===row.id&&next.kind===row.kind&&canonicalWire(next.target)===canonicalWire(row.target)&&next.payloadDigest===row.payloadDigest)))throw Error('original delivery identity changed')
 const pending=current.pendingDelivery.filter(row=>row.status!=='acknowledged').map(row=>row.id)
 return {pending,reason:pending.length?'original-delivery-remains-pending':'original-delivery-reconciled'}
}
export function durableRecoverySummary(run:RunRecord):{action:'wait'|'retry-delivery'|'inspect';reason:string;checkpointHead:string|null;unbackedTail:boolean;terminalCapturePreserved:boolean}|null {
 const pending=run.pendingDelivery.some(row=>row.status!=='acknowledged'),capture=run.pendingDelivery.some(row=>row.kind==='telemetry-capture'&&(row.status==='acknowledged'||!!row.payloadDigest))
 const source={checkpointHead:run.checkpoint?.headSha??null,unbackedTail:!!run.headSha&&run.headSha!==run.checkpoint?.headSha,terminalCapturePreserved:capture}
 if(run.terminationCause==='termination-unconfirmed')return{action:'wait',reason:'original execution termination unconfirmed',...source}
 if(run.waitReason==='subscription-quota')return{action:'wait',reason:'subscription availability; original setup retained',...source}
 if(run.state==='interrupted'||run.state==='terminal'&&run.terminationCause!=='succeeded')return{action:'inspect',reason:capture?'prior terminal capture preserved; verified continuation required':'fresh task, source, stop and effect reconciliation required',...source}
 if(run.state==='terminal'&&pending)return{action:'retry-delivery',reason:'implementation is not replayed for pending delivery',...source}
 return null
}
async function inspectSavedRecoveryWork(config:FactoryConfig,options:{signal?:AbortSignal},tracker:RunTracker,reports:RunReport[],refusals:Refusal[],gh:TickDeps['gh']=ghText,recoveryTransport?:TickDeps['recoveryTransport'],processDeps?:Pick<ExecuteDeps,'wrapperPath'>,recoveredChildPrepare?:TickDeps['recoveredChildPrepare']):Promise<void> {
 const helpers=await import('./runs.ts'),saved=await helpers.readRuns(runsRoot(config.home))
 const recoveryFor=async(repo:string):Promise<{target:import('./shared-claims.ts').CoordinationTarget;source?:RemoteRecoveryTransport['source']}>=>recoveryTransport?recoveryTransport(repo,config):{target:await verifiedSharedTarget(repo,config,undefined,gh)}
 type Seed=Pick<RunRecord,'repo'|'issue'|'stage'|'harness'|'checkout'>
 type Prepared={run:RunRecord;claim:SharedClaim;plan:LaunchPlan;started?:true;group?:PreparedStoppedGroup['group']}
 const schedule=async(seed:Seed,prepare:(claim:Claim)=>Promise<Prepared|null>)=>{
  const key=`${seed.repo}#${seed.issue}`
  if(tracker.has(key)||inFlightIssues(tracker,seed.repo).length>=config.maxRuns)return
  const lockPath=repoLockPath(config,seed.repo)
  let local:Claim
  try{local=ownedLocks.get(lockPath)??await holdLock(lockPath,process.pid)}catch{return}
  const report:RunReport={repo:seed.repo,issue:seed.issue,title:`#${seed.issue}`,stage:seed.stage as Stage,launch:{command:seed.harness,args:[],env:{},cwd:seed.checkout},launched:false,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'awaiting-current-verification'}}
  reports.push(report)
  const done=(async()=>{
   let outcome:RunOutcome|null=null
   try{
    const prepared=await prepare(local);if(!prepared)return
    await verifyDispatchRunAuthority(prepared.run,config,'launch',{gh})
    const start=prepared.started?{kind:'owned' as const,claim:prepared.claim}:await transitionSharedTask({claim:prepared.claim,operationId:prepared.run.attemptOperationIds!.start,transition:{kind:'start'}})
    if(start.kind!=='owned')throw Error('recovery start not acknowledged: '+start.reason)
    const current=await helpers.readRun(runsRoot(config.home),prepared.run.runId)
    report.launch={command:prepared.plan.command,args:prepared.plan.args,env:prepared.plan.env,cwd:prepared.plan.cwd}
    let groupWork:Promise<Error|null>|null=null
    const groupAbort=new AbortController(),runSignal=prepared.group?AbortSignal.any([groupAbort.signal,...(options.signal?[options.signal]:[])]):options.signal
    const onSpawn=()=>{report.launched=true;if(prepared.group&&!groupWork)groupWork=(async()=>{const children=await import('./children.ts'),starts=await refreshRecoveredGroupStarts(prepared.group!.starts,config,gh);await children.startRecoveredGroupMembers(starts);const parent=await helpers.readRun(runsRoot(config.home),prepared.run.runId),executed=await children.executeChildren({parent,groups:prepared.group!,config,write:true,signal:runSignal},{processDeps,gh,...(recoveredChildPrepare?{prepare:recoveredChildPrepare}:{})});if(executed.blocked.length)throw Error('recovered child execution blocked: '+executed.blocked.map(row=>`#${row.issue} ${row.reason}`).join('; '));const joined=await children.joinChildren({parent:await helpers.readRun(runsRoot(config.home),parent.runId),groups:prepared.group!,config,write:true,signal:runSignal},{processDeps,gh});if(joined.blocked.length)throw Error('recovered child join blocked: '+joined.blocked.map(row=>`#${row.issue} ${row.reason}`).join('; '));return null})().catch(error=>{groupAbort.abort();return error as Error})}
    outcome=await executeApprovedRun({repo:seed.repo,issue:seed.issue,title:report.title,stage:seed.stage as Stage,commentId:null,reactionId:null},prepared.plan,config,{operator:null,signal:runSignal,sharedClaim:start.claim,onSpawn},{...processDeps,gh,preparedRun:current,runInput:{...current,root:runsRoot(config.home)}})
    let groupError:Error|null=null
    if(outcome.refusal)groupError=Error(outcome.refusal)
    if(groupWork)groupError=await groupWork
    report.exitCode=outcome.exitCode;report.logFile=outcome.logFile
    const latest=await helpers.readRun(runsRoot(config.home),current.runId),claim=await sharedClaimForRun(latest,config,gh),finish=await finishDurableSharedRun(claim,outcome,config,gh)
    const finished=await transitionSharedTask({claim,operationId:finish.kind==='stop'?latest.stopReceiptIds?.transition??randomUUID():randomUUID(),transition:finish})
    if(finished.kind!=='owned')throw Error('recovery final state pending: '+finished.reason)
    if(groupError)throw groupError
   }catch(error){refusals.push({repo:seed.repo,issue:seed.issue,reason:(error as Error).message})}
   finally{tracker.delete(key);if(!inFlightIssues(tracker,seed.repo).length&&outcome?.terminationCause!=='termination-unconfirmed')await releaseLock(lockPath,local)}
  })()
  tracker.set(key,{repo:seed.repo,issue:seed.issue,done})
 }
 const retainedGroupRuns=new Set<string>()
 for(const entry of config.repos){try{const transport=await recoveryFor(entry.repo),snapshot=await(await import('./shared-claims.ts')).readCoordination(transport.target);for(const task of Object.values(snapshot.tasks))if(task.recovery&&(task.parentTaskKey!==null||Object.values(snapshot.tasks).some(row=>row.parentTaskKey===task.taskKey)))retainedGroupRuns.add(task.runId)}catch{/* Normal recovery reports the unreadable owner below. */}}
 for(const run of saved){
  if(!config.repos.some(row=>row.repo===run.repo)||run.waitReason||!run.execution)continue
  if(run.remoteRecovery?.kind==='receiving-group'&&run.remoteRecovery.role==='child')continue
  const resumableGroupParent=run.parent===null&&(run.remoteRecovery?.kind==='receiving-group'||!!run.continuations?.length)
  if(retainedGroupRuns.has(run.runId)&&!resumableGroupParent)continue
  const allocated=run.state==='prepared'&&!run.processIdentity&&(run.remoteRecovery||run.continuations?.length)
  if(!allocated&&!durableRecoverySummary(run))continue
  await schedule(run,async local=>{
   if(allocated){
    if(run.remoteRecovery?.kind==='receiving-group'){const transport=await recoveryFor(run.repo);return prepareVerifiedStoppedGroup({repo:run.repo,parentTaskKey:run.remoteRecovery.parentTaskKey,config,localClaim:local,gh,...transport})}
    if(run.remoteRecovery)return prepareVerifiedReceivingRun({repo:run.repo,taskKey:run.sharedClaim!.taskKey,runId:run.runId},config,local)
    if(run.parent===null&&run.sharedClaim){try{await helpers.readPrivateRunFile(join(runsRoot(config.home),'receiving-group-'+run.sharedClaim.taskKey+'-'+run.runId+'.json'));const transport=await recoveryFor(run.repo);return prepareVerifiedStoppedGroup({repo:run.repo,parentTaskKey:run.sharedClaim.taskKey,config,localClaim:local,gh,...transport})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
    const request=run.continuations!.at(-1)!,attempt=run.attempts?.find(row=>row.id===request.previousAttemptId)
    if(!attempt)throw Error('original continuation snapshot unavailable')
    const original=await helpers.readRunAttemptSnapshot(runsRoot(config.home),run.runId,attempt)
    return prepareVerifiedContinuation(original,config,local)
   }
   try{
    await helpers.readPrivateRunFile(join(runsRoot(config.home),run.runId,'continuation-'+(run.attemptId??run.runId)+'.json'))
    return prepareVerifiedContinuation(run,config,local)
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
   const decision=await inspectLocalRecovery(run,config)
   if(decision.action==='retry-delivery'){
    const retried=await retryRecoveredDelivery(run,config)
    if(retried.pending.length)refusals.push({repo:run.repo,issue:run.issue,reason:retried.reason})
    return null
   }
   if(decision.action==='resume-task')return prepareVerifiedContinuation(run,config,local)
   if(decision.action==='refuse')throw Error(decision.reason)
   return null
  })
 }
 // Receiving discovery uses the private current task index, never a source
 // branch name or the absence of an old local file as ownership evidence.
 for(const entry of config.repos){
  if(inFlightIssues(tracker,entry.repo).length>=config.maxRuns)continue
  try{
   const transport=await recoveryFor(entry.repo),target=transport.target,machine=sharedMachineContexts.get(target)!
   if(machine.defaults.recovery!=='verified-transfer')continue
   const snapshot=await(await import('./shared-claims.ts')).readCoordination(target)
   const scheduledGroups=new Set<string>()
   for(const task of Object.values(snapshot.tasks)){
    if(task.repo!==entry.repo||task.parentTaskKey!==null||!task.recovery||!task.stopProof||!['stopped','blocked','claimed'].includes(task.state))continue
    const children=Object.values(snapshot.tasks).filter(row=>row.parentTaskKey===task.taskKey)
    if(children.length){if(scheduledGroups.has(task.taskKey))continue;scheduledGroups.add(task.taskKey);await schedule({repo:task.repo,issue:task.issue,stage:task.stage,harness:task.recovery.execution.harness,checkout:entry.path},claim=>prepareVerifiedStoppedGroup({repo:task.repo,parentTaskKey:task.taskKey,config,localClaim:claim,gh,...transport}));continue}
    if(saved.some(run=>run.runId===task.runId))continue
    if(task.state==='claimed'){try{await helpers.readPrivateRunFile(join(runsRoot(config.home),'receiving-'+task.taskKey+'-'+task.runId+'.json'))}catch{continue}}
    await schedule({repo:task.repo,issue:task.issue,stage:task.stage,harness:task.recovery.execution.harness,checkout:entry.path},claim=>prepareVerifiedReceivingRun({repo:task.repo,taskKey:task.taskKey,runId:task.runId},config,claim))
   }
  }catch(error){if(!/machine registration unavailable|current machine policy unavailable/.test((error as Error).message))refusals.push({repo:entry.repo,issue:0,reason:'receiving recovery inspection: '+(error as Error).message})}
 }
}

export async function verifyRunContinuationRecovery(input:{run:RunRecord;request:import('./runs.ts').RunContinuationRequest},config:FactoryConfig,transport:{gh?:TickDeps['gh'];claim?:SharedClaim}={}):Promise<import('./runs.ts').RecoveryContinuationDecision> {
 const {run,request}=input,helpers=await import('./runs.ts')
 if(request.root!==runsRoot(config.home)||request.runId!==run.runId||request.expectedGeneration!==run.generation||request.previousAttemptId!==(run.attemptId??run.runId)||!run.execution||!run.approvedTaskIds?.length||!run.checkpoint||!run.worktreeDigest||canonicalWire(run.checkpoint)!==canonicalWire(request.checkpoint)||run.worktreeDigest!==request.worktreeDigest)throw Error('continuation original identity differs')
 const decision=await inspectLocalRecovery(run,config,{currentOwner:request.currentOwner,...transport})
 if(decision.action!=='resume-task'||!decision.taskIds.length)throw Error('continuation recovery refused: '+decision.reason)
 const owned={...run,...request.currentOwner},claim=transport.claim??await sharedClaimForRun(owned,config),owner=await import('./shared-claims.ts')
 const current=await owner.inspectCoordinationTask(claim.target,claim.taskKey,{runId:run.runId,generation:claim.generation,ownerToken:claim.ownerToken,machineId:claim.machineId,installationId:claim.installationId,sessionId:claim.sessionId})
 if(current.kind!=='active'||current.task.state!=='claimed'||canonicalWire(current.task.checkpoint)!==canonicalWire(request.checkpoint)||current.task.scopeDigest!==run.taskKey.scopeDigest)throw Error('continuation shared state is not launch-ready')
 await verifyDispatchRunAuthority(run,config,'launch',{gh:transport.gh})
 return {action:'resume-task',reason:'fresh source and verified outstanding tasks',runId:run.runId,expectedGeneration:run.generation,previousAttemptId:request.previousAttemptId,taskIds:decision.taskIds,approvedTaskIds:run.approvedTaskIds,approvalBindings:run.approvalBindings,recordBinding:run.recordBinding,artifacts:run.approvalRefs,execution:run.execution,checkpoint:run.checkpoint,worktreeDigest:run.worktreeDigest,currentOwner:request.currentOwner,sourceRefs:decision.sourceRefs as Array<{id:string;updatedAt:string;bodySha256:string}>}
}
interface LocalContinuationIntent {
 schemaVersion:1;requestId:string;operationId:string;runId:string;attemptId:string
 originalClaim:Omit<SharedClaim,'target'>;machine:EffectiveMachine
 session:Omit<MachineSession,'target'|'localRoot'>;candidate:VerifiedCandidate
 stopProof:import('./shared-claims.ts').StopProof;recovery:import('./shared-claims.ts').RecoveryEnvelope
 currentOwner:import('./runs.ts').RunContinuationRequest['currentOwner']|null
 allocation:import('./runs.ts').RunContinuationRequest|null
}
function continuationClaim(value:SharedClaim):Omit<SharedClaim,'target'> {
 const {target:_target,...claim}=value;return claim
}
export function continuationLaunchPlan(plan:LaunchPlan,decision:Pick<import('./runs.ts').RecoveryContinuationDecision,'taskIds'|'sourceRefs'>,packet:Record<string,unknown>,unavailableContext:RemoteRecoveryMaterial['unavailableContext']=[]):LaunchPlan {
 if(!decision.taskIds.length||new Set(decision.taskIds).size!==decision.taskIds.length)throw Error('verified outstanding task selection required')
 const completed=(packet.completed as Array<{taskId:string;headSha:string}>|undefined)??[]
 if(decision.taskIds.some(id=>completed.some(row=>row.taskId===id)))throw Error('completed recovery task cannot be replayed')
 const context='\nVerified recovery context (current approval still applies):\n'+JSON.stringify({outstandingTaskIds:decision.taskIds,completed:completed.map(row=>({taskId:row.taskId,headSha:row.headSha})),openFindings:packet.openFindings??[],rulings:packet.rulings??[],sourceRefs:decision.sourceRefs,unavailableContext})+'\nContinue only the outstanding tasks; retry delivery separately and preserve prior source work.\n'
 if(Buffer.byteLength(context)>32*1024)throw Error('recovery launch context exceeds bound')
 const prompt=plan.prompt+context
 // The launch owner's prompt is one complete argv element; change only that
 // element, retaining every original account/model/configuration flag.
 const matches=plan.args.flatMap((arg,index)=>arg===plan.prompt?[index]:[])
 if(matches.length!==1)throw Error('managed launch prompt binding unavailable')
 return {...plan,prompt,args:plan.args.map((arg,index)=>index===matches[0]?prompt:arg)}
}
export async function prepareVerifiedContinuation(saved:RunRecord,config:FactoryConfig,localClaim:Claim):Promise<{run:RunRecord;claim:SharedClaim;decision:import('./runs.ts').RecoveryContinuationDecision;plan:LaunchPlan}> {
 const helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),root=runsRoot(config.home)
 if(localClaim.path!==repoLockPath(config,saved.repo))throw Error('continuation local repository claim differs')
 await(await import('./claims.ts')).renewClaim(localClaim)
 if(!saved.execution||!saved.sharedClaim||!saved.machine||!saved.checkpoint||!saved.worktreeDigest)throw Error('original continuation execution/checkpoint/owner unavailable')
 const entry=config.repos.find(row=>row.repo===saved.repo);if(!entry)throw Error('continuation repository is not configured')
 const devMd=await readFile(join(entry.path,'.vegastack/dev.md'),'utf8'),resolved=loadConfiguredPolicy({home:config.home,repo:saved.repo,devMd,settingsPath:config.settingsPath})
 if(!resolved.ok)throw Error('current continuation policy unavailable')
 const policy=repoPolicyFromEffective(resolved),stage=stagePolicy(policy,saved.stage as Stage)
 if(stage.harness!==saved.harness||stage.model!==saved.model||stage.effort!==saved.effort)throw Error('original continuation setup changed')
 const issue=await boundedGhJson<{title:string;body:string}>(ghText,['api',`repos/${saved.repo}/issues/${saved.issue}`],readBudget())
 const basePlan=buildLaunchPlan({harness:stage.harness,model:stage.model,effort:stage.effort,stage:saved.stage as Stage,worktree:saved.checkout,issue:{number:saved.issue,title:issue.title},operator:saved.taskOwner??'the operator',outcome:outcomeOf(issue.body),stopList:stopList(devMd),resume:false,skillPath:null,subagents:config.subagents})
 await inspectSubscription(basePlan,saved.execution.accountRef)
 if(!saved.runtimeBinding||!saved.configurationDigest)throw Error('original qualified runtime unavailable')
 await helpers.verifyInstalledRuntimeBinding(saved.runtimeBinding,dirname(dirname(fileURLToPath(import.meta.url))),fileURLToPath(import.meta.url))
 const metadata=await inspectManagedHarness(basePlan)
 if(metadata.version!==saved.execution.harnessVersion||!validateManagedLaunch(basePlan,metadata).ok||await helpers.executionConfigurationDigest({binding:saved.runtimeBinding,execution:saved.execution,plan:basePlan,metadata})!==saved.configurationDigest)throw Error('original qualified runtime configuration changed')
 const intentPath=join(root,saved.runId,'continuation-'+(saved.attemptId??saved.runId)+'.json')
 let intent:LocalContinuationIntent|null=null
 try{intent=JSON.parse(await helpers.readPrivateRunFile(intentPath)) as LocalContinuationIntent}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const target=await verifiedSharedTarget(saved.repo,config,saved.runId),machine=sharedMachineContexts.get(target)!
 sharedContinuationContexts.set(target,{runId:saved.runId,attemptId:saved.attemptId??saved.runId,checkpoint:saved.checkpoint,scopeDigest:saved.taskKey.scopeDigest,approvalBindings:saved.approvalBindings})
 if(!intent){
  const initial=await inspectLocalRecovery(saved,config)
  if(initial.action!=='resume-task')throw Error(initial.reason)
  const original=await sharedClaimForRun(saved,config),snapshot=await owner.readCoordination(target),task=snapshot.tasks[original.taskKey]
  if(!task?.recovery||!task.stopProof||task.parentTaskKey!==null||snapshot.index.active.some(row=>row.parentTaskKey===task.taskKey))throw Error('retained child reservations require explicit group recovery; original ownership preserved')
  await helpers.verifySharedStopProof(task.stopProof,task,target,saved)
  const session:LocalContinuationIntent['session']={machineId:machine.id,installationId:machine.installationId,sessionId:dispatcherSessionId,hostBindingDigest:machine.hostBindingDigest,bootIdDigest:await(await import('./machine-identity.ts')).readBootIdentityDigest(),identity:await processIdentity()}
  const candidate:VerifiedCandidate={host:task.host,repo:task.repo,issue:task.issue,repositoryNodeId:task.repositoryNodeId,issueNodeId:task.issueNodeId,scopeDigest:task.scopeDigest,approvalDigest:task.approvalDigest,approvalBindings:task.approvalBindings,runId:task.runId,stage:task.stage,paths:task.paths,resources:task.resources,independent:task.independent,parentTaskKey:null,parentBinding:null,approvedTaskIds:task.approvedTaskIds}
  intent={schemaVersion:1,requestId:randomUUID(),operationId:randomUUID(),runId:saved.runId,attemptId:saved.attemptId??saved.runId,originalClaim:continuationClaim(original),machine,session,candidate,stopProof:task.stopProof,recovery:task.recovery,currentOwner:null,allocation:null}
  await helpers.atomicRunFile(intentPath,intent)
 }
 if(intent.schemaVersion!==1||intent.runId!==saved.runId||intent.attemptId!==(saved.attemptId??saved.runId)||canonicalWire(intent.candidate.approvalBindings)!==canonicalWire(saved.approvalBindings)||intent.candidate.scopeDigest!==saved.taskKey.scopeDigest||canonicalWire(intent.machine)!==canonicalWire(machine))throw Error('saved continuation intent requires reconciliation')
 if(!intent.currentOwner){
  const observed=await owner.inspectCoordinationTask(target,intent.originalClaim.taskKey)
  if(observed.kind==='active'&&observed.task.generation===intent.originalClaim.generation+1){
   const raw=await target.provider.read(target,observed.head,owner.operationPath(intent.operationId))
   if(raw){
    const {stateCommit:_state,...expected}=intent.originalClaim
    const ref={kind:'state-receipt' as const,operationId:intent.operationId,commitSha:observed.head,blobSha256:owner.sha256(raw)}
    const history=await owner.inspectHandoffCoordinationTask(target,{taskKey:expected.taskKey,expected,evidence:ref})
    if(history.kind!=='historical-handoff'||history.handedOff.ownerToken!==observed.task.ownerToken||history.handedOff.machineId!==machine.id||history.handedOff.sessionId!==intent.session.sessionId)throw Error('continuation prior handoff requires reconciliation')
    intent.currentOwner={machine:{id:observed.task.machineId,installationId:observed.task.installationId,sessionId:observed.task.sessionId,hostBindingDigest:machine.hostBindingDigest},sharedClaim:{taskKey:observed.task.taskKey,generation:observed.task.generation,ownerToken:observed.task.ownerToken,stateCommit:observed.head}}
    await helpers.atomicRunFile(intentPath,intent)
   }
  }
 }
 if(!intent.currentOwner&&canonicalWire(intent.session.identity)!==canonicalWire(await processIdentity()))throw Error('saved continuation session requires reconciliation')
 if(!intent.currentOwner){
  const transitioned=await owner.transitionSharedTask({claim:{...intent.originalClaim,target},operationId:intent.operationId,transition:{kind:'handoff',machine:intent.machine,session:{...intent.session,target,localRoot:target.localRoot},candidate:intent.candidate,stopProof:intent.stopProof,recovery:intent.recovery}})
  if(transitioned.kind!=='owned')throw Error('continuation ownership pending: '+transitioned.reason)
  intent.currentOwner={machine:{id:transitioned.claim.machineId,installationId:transitioned.claim.installationId,sessionId:transitioned.claim.sessionId,hostBindingDigest:machine.hostBindingDigest},sharedClaim:{taskKey:transitioned.claim.taskKey,generation:transitioned.claim.generation,ownerToken:transitioned.claim.ownerToken,stateCommit:transitioned.claim.stateCommit}}
  await helpers.atomicRunFile(intentPath,intent)
 }
 let current=await readRun(root,saved.runId)
 if(!intent.allocation){intent.allocation={root,runId:saved.runId,expectedGeneration:current.generation,requestId:intent.requestId,previousAttemptId:intent.attemptId,checkpoint:saved.checkpoint,worktreeDigest:saved.worktreeDigest,currentOwner:intent.currentOwner};await helpers.atomicRunFile(intentPath,intent)}
 let decision:import('./runs.ts').RecoveryContinuationDecision|undefined
 current=await helpers.beginVerifiedRunContinuation(intent.allocation,{verifyRecovery:async input=>decision=await verifyRunContinuationRecovery(input,config)})
 if(!decision){
  // Idempotent allocation is not launch authority. Re-read the immutable original
  // attempt and repeat current source/owner reconciliation before any spawn.
  const prior=current.attempts?.find(attempt=>attempt.id===intent!.attemptId)
  if(!prior)throw Error('continuation original attempt unavailable')
  const original=await helpers.readRunAttemptSnapshot(root,current.runId,prior)
  decision=await verifyRunContinuationRecovery({run:original,request:intent.allocation},config)
 }
 const packet=JSON.parse(await helpers.readPrivateRunFile(join(root,saved.runId,'recovery.json'))) as Record<string,unknown>
 const plan=continuationLaunchPlan(basePlan,decision,packet),claim=await sharedClaimForRun(current,config)
 return {run:current,claim,decision,plan}
}

interface TaskCheckpointProgress {
 schemaVersion:1;taskId:string;receiptId:string;linkId:string
 payload:Extract<import('./shared-claims.ts').RecoveryEvidencePayload,{kind:'acceptance'}>
 reference:Extract<import('./shared-claims.ts').EvidenceRef,{kind:'state-receipt'}>|null
}
async function callerBelongsToRun(run:RunRecord):Promise<boolean> {
 if(run.state!=='running'||!run.processIdentity)return false
 try{
  if(canonicalWire(await processIdentity(run.processIdentity.pid))!==canonicalWire(run.processIdentity))return false
  const listing=spawnSync('/bin/ps',['-ax','-o','pid=,ppid='],{encoding:'utf8',timeout:1000,maxBuffer:4*1024*1024})
  if(listing.status!==0)return false
  const parents=new Map<number,number>()
  for(const line of listing.stdout.split('\n')){if(!line.trim())continue;const match=/^\s*(\d+)\s+(\d+)\s*$/.exec(line);if(!match)return false;parents.set(Number(match[1]),Number(match[2]))}
  let pid=process.pid
  for(let depth=0;depth<128;depth++){if(pid===run.processIdentity.pid)return true;const parent=parents.get(pid);if(!parent||parent===pid)return false;pid=parent}
 }catch{/* An absent or foreign process cannot authorize a checkpoint. */}
 return false
}
async function taskCheckSource(run:RunRecord,taskId:string,config:FactoryConfig,gh:TickDeps['gh']=ghText):Promise<{planBody:string;command:string;headSha:string}> {
 const helpers=await import('./runs.ts');await verifyDispatchRunAuthority(run,config,'launch',{gh})
 if(!run.approvedTaskIds?.includes(taskId)||!new RegExp('^'+run.issue+'-T[1-9]\\d*$').test(taskId))throw Error('checkpoint task is outside approved selection')
 const {approval}=await helpers.approvalTools(),comments=await approval.readPages((args:string[])=>boundedGhJson<any>(gh,args,readBudget()),['api',`repos/${run.repo}/issues/${run.issue}/comments`])
 const planRef=run.approvalRefs.find(ref=>ref.kind==='plan'),plans=comments.filter((row:any)=>row.node_id===planRef?.artifactId)
 if(plans.length!==1||approval.scopeDigest(plans[0].body,'plan')!==planRef?.digest)throw Error('checkpoint canonical plan differs')
 const git=(args:string[])=>{const result=spawnSync('git',args,{cwd:run.checkout,encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});if(result.status!==0||result.error)throw Error('checkpoint source unavailable');return result.stdout.trim()}
 const headSha=git(['rev-parse','HEAD']),branch=git(['symbolic-ref','--short','HEAD'])
 if(branch!==run.branch||!sha40(headSha))throw Error('checkpoint branch or source differs')
 git(['merge-base','--is-ancestor',run.baseSha,headSha])
 if(git(['status','--porcelain','--untracked-files=all']))throw Error('checkpoint requires committed clean source')
 const files=recoveryFiles(plans[0].body,run.approvedTaskIds)
 const commits=git(['rev-list',run.baseSha+'..'+headSha]).split('\n').filter(Boolean)
 const changed=[...new Set(commits.flatMap(commit=>git(['diff-tree','--root','--no-commit-id','--name-only','--no-renames','-r','-m','-z',commit]).split('\0').filter(Boolean)))]
 if(changed.some(path=>!files.some(file=>path===file||path.startsWith(file.replace(/\/$/,'')+'/'))))throw Error('checkpoint source escaped approved files')
 const command=/^commands:.*?\bcheck\s+`([^`]+)`/m.exec(git(['show',run.baseSha+':.vegastack/dev.md']))?.[1]
 if(!command)throw Error('approved-base configured check unavailable')
 return {planBody:plans[0].body,command,headSha}
}
function sha40(value:string):boolean{return /^[a-f0-9]{40}$/.test(value)}
async function verifyTaskCheckpointEvidence(run:RunRecord,payload:Extract<import('./shared-claims.ts').RecoveryEvidencePayload,{kind:'acceptance'}>,config:FactoryConfig):Promise<boolean> {
 if(payload.acceptedScope!==null||!new RegExp('^'+run.issue+'-T[1-9]\\d*$').test(payload.taskId))return false
 const helpers=await import('./runs.ts'),root=runsRoot(config.home),label='task-'+payload.taskId
 let progress:TaskCheckpointProgress
 try{progress=JSON.parse(await helpers.readPrivateRunFile(join(root,run.runId,label+'-proof.json')))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
 if(progress.schemaVersion!==1||progress.taskId!==payload.taskId||canonicalWire(progress.payload)!==canonicalWire(payload)||!run.approvedTaskIds?.includes(payload.taskId)||payload.runId!==run.runId||payload.scopeDigest!==run.taskKey.scopeDigest||payload.result!=='passed')throw Error('task checkpoint receipt differs from prepared proof')
 const check=JSON.parse(await helpers.readPrivateRunFile(join(root,run.runId,label+'-acceptance.json'))) as import('./children.ts').ChildCheck
 const intent=JSON.parse(await helpers.readPrivateRunFile(join(root,run.runId,label+'-check-intent.json'))) as {runId:string;checkRunId:string;headSha:string;command:string;validationId:string}
 const executed=await readRun(root,check.checkRunId)
 const base=spawnSync('git',['show',run.baseSha+':.vegastack/dev.md'],{cwd:run.checkout,encoding:'utf8',timeout:5000,maxBuffer:1024*1024}),command=/^commands:.*?\bcheck\s+`([^`]+)`/m.exec(base.stdout??'')?.[1]
 if(base.status!==0||!command||check.schemaVersion!==1||check.runId!==run.runId||check.baseSha!==run.baseSha||check.headSha!==payload.sourceSha||check.scopeDigest!==run.taskKey.scopeDigest||check.command!==command||!check.ok||check.exitCode!==0||check.validationId!==payload.validationId||createHash('sha256').update(command).digest('hex')!==payload.commandDigest||intent.runId!==run.runId||intent.checkRunId!==check.checkRunId||intent.headSha!==check.headSha||intent.command!==command||intent.validationId!==check.validationId||executed.repo!==run.repo||executed.issue!==run.issue||executed.parent!==run.issue||executed.stage!=='acceptance'||executed.state!=='terminal'||executed.terminationCause!=='succeeded'||executed.exitCode!==0||!executed.processIdentity||executed.headSha!==check.headSha||executed.baseSha!==check.headSha)throw Error('task checkpoint lacks actual configured-check success')
 return true
}
export async function verifyRetainedTaskCompletion(run:RunRecord,payload:Extract<import('./shared-claims.ts').RecoveryEvidencePayload,{kind:'acceptance'}>,ref:import('./shared-claims.ts').EvidenceRef,target:import('./shared-claims.ts').CoordinationTarget,config:FactoryConfig,gh:TickDeps['gh']=ghText):Promise<boolean> {
 if(run.remoteRecovery?.kind!=='receiving-home'||ref.kind!=='state-receipt'||payload.acceptedScope!==null)return false
 const owner=await import('./shared-claims.ts'),provenance=run.remoteRecovery
 // Extract only the binding for the owner's reader. Never treat this JSON as a
 // locally parsed TaskRecord or infer an old owner from the current task.
 const bytes=JSON.parse(provenance.originalTask.bytes) as Record<string,unknown>
 const expected={taskKey:bytes.taskKey,runId:bytes.runId,generation:bytes.generation,ownerToken:bytes.ownerToken,machineId:bytes.machineId,installationId:bytes.installationId,sessionId:bytes.sessionId} as import('./shared-claims.ts').ParentClaimBinding
 const history=await owner.inspectHandoffCoordinationTask(target,{taskKey:run.sharedClaim?.taskKey??'',expected,evidence:provenance.handoff})
 if(history.kind!=='historical-handoff'||history.receipt.previousHead!==provenance.originalStateCommit||owner.canonical(history.predecessor)!==provenance.originalTask.bytes)throw Error('retained completion predecessor unavailable')
 const original=history.predecessor,completed=original.recovery?.completed.find(row=>owner.canonical(row.acceptance.evidence)===owner.canonical(ref))
 if(!completed)return false
 if(payload.result!=='passed'||payload.runId!==original.runId||payload.runId!==run.runId||payload.taskId!==completed.taskId||!run.approvedTaskIds?.includes(payload.taskId)||payload.scopeDigest!==original.scopeDigest||payload.scopeDigest!==run.taskKey.scopeDigest||payload.sourceSha!==completed.headSha||payload.validationId!==completed.acceptance.validationId||payload.commandDigest!==completed.acceptance.commandDigest)throw Error('retained completed-task evidence differs')
 await verifyDispatchRunAuthority(run,config,'effect',{gh})
 const inherited=spawnSync('git',['merge-base','--is-ancestor',completed.headSha,run.headSha??''],{cwd:run.checkout,timeout:3000})
 if(inherited.status!==0)throw Error('retained completed source is missing from receiving checkout')
 return true
}

export async function checkpointTaskForRecovery(input:{run:RunRecord;taskId:string;config:FactoryConfig;write?:boolean},transport:{gh?:TickDeps['gh'];claim?:SharedClaim;wrapperPath?:string}={}):Promise<{taskId:string;headSha:string;reference:import('./shared-claims.ts').EvidenceRef|null;wrote:boolean;replayed:boolean;reason:string}> {
 let {run}=input;const {taskId,config}=input,helpers=await import('./runs.ts'),owner=await import('./shared-claims.ts'),root=runsRoot(config.home)
 if(run.state!=='running'||!run.processIdentity)throw Error('checkpoint requires a running local execution')
 const source=await taskCheckSource(run,taskId,config,transport.gh??ghText),claim=transport.claim??await sharedClaimForRun(run,config)
 const inspected=await owner.inspectCoordinationTask(claim.target,claim.taskKey,{runId:run.runId,generation:claim.generation,ownerToken:claim.ownerToken,machineId:claim.machineId,installationId:claim.installationId,sessionId:claim.sessionId})
 if(inspected.kind!=='active'||inspected.task.state!=='running'||!inspected.task.recovery||inspected.task.scopeDigest!==run.taskKey.scopeDigest)throw Error('checkpoint current running owner unavailable')
 const previous=inspected.task.recovery.completed.find(row=>row.taskId===taskId)
 if(previous){
  const proof=await owner.resolveEvidence(claim.target,previous.acceptance.evidence)
  if(proof?.kind!=='acceptance'||proof.taskId!==taskId||proof.runId!==run.runId||proof.sourceSha!==previous.headSha||proof.scopeDigest!==run.taskKey.scopeDigest||proof.result!=='passed'||proof.validationId!==previous.acceptance.validationId||proof.commandDigest!==previous.acceptance.commandDigest)throw Error('existing task completion proof unavailable')
  const inherited=spawnSync('git',['merge-base','--is-ancestor',previous.headSha,source.headSha],{cwd:run.checkout,timeout:3000})
  if(inherited.status!==0)throw Error('completed task source is missing from current checkout')
  return {taskId,headSha:previous.headSha,reference:previous.acceptance.evidence,wrote:false,replayed:true,reason:'verified completion retained; configured check not replayed'}
 }
 if(!new RegExp('^-\\s*\\[x\\].*<!--\\s*task-id:'+taskId+'\\s*-->','im').test(source.planBody))throw Error('unchecked task cannot enter completed recovery')
 if(!input.write)return{taskId,headSha:source.headSha,reference:null,wrote:false,replayed:false,reason:'would run approved-base configured check and retain task-only proof'}
 const held=await acquireClaim(join(root,run.runId,'task-checkpoint'),await processIdentity())
 if(held.kind!=='owned')throw Error('task checkpoint is already in progress')
 try{
  if((await readRun(root,run.runId)).generation!==run.generation)throw Error('checkpoint run changed')
  run=await helpers.updateRun(root,run.runId,()=>({headSha:source.headSha}))
  const check=await(await import('./children.ts')).sourceCheck({...run,taskKey:{...run.taskKey,taskId}},source.command,config,undefined,transport.wrapperPath?{wrapperPath:transport.wrapperPath}:undefined,'task-'+taskId)
  if(!check.ok)throw Error('configured task check failed; no completion was recorded')
  const proofPath=join(root,run.runId,'task-'+taskId+'-proof.json')
  let progress:TaskCheckpointProgress
  try{progress=JSON.parse(await helpers.readPrivateRunFile(proofPath)) as TaskCheckpointProgress}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;progress={schemaVersion:1,taskId,receiptId:randomUUID(),linkId:randomUUID(),payload:{schemaVersion:2,kind:'acceptance',taskId,runId:run.runId,sourceSha:source.headSha,scopeDigest:run.taskKey.scopeDigest,validationId:check.validationId,commandDigest:createHash('sha256').update(source.command).digest('hex'),result:'passed',acceptedScope:null},reference:null};await helpers.atomicRunFile(proofPath,progress)}
  await verifyTaskCheckpointEvidence(run,progress.payload,config)
  if(progress.payload.sourceSha!==source.headSha||progress.payload.validationId!==check.validationId)throw Error('prior checkpoint attempt requires reconciliation')
  const publicationSource=await taskCheckSource(run,taskId,config,transport.gh??ghText)
  if(publicationSource.headSha!==source.headSha||publicationSource.command!==source.command)throw Error('task checkpoint source changed before publication')
  if(!progress.reference){const published=await owner.publishRecoveryReceipt({claim,operationId:progress.receiptId,payload:progress.payload});progress.reference=published.reference;await helpers.atomicRunFile(proofPath,progress)}
  const fetched=await owner.resolveEvidence(claim.target,progress.reference)
  if(canonicalWire(fetched)!==canonicalWire(progress.payload))throw Error('task checkpoint immutable readback differs')
  const current=await owner.inspectCoordinationTask(claim.target,claim.taskKey,{runId:run.runId,generation:claim.generation,ownerToken:claim.ownerToken})
  if(current.kind!=='active'||current.task.state!=='running'||!current.task.recovery)throw Error('checkpoint owner changed before completion append')
  const entry={taskId,headSha:source.headSha,acceptance:{sourceSha:source.headSha,validationId:check.validationId,commandDigest:progress.payload.commandDigest,evidence:progress.reference}}
  const prior=current.task.recovery.completed.find(row=>row.taskId===taskId)
  if(prior&&canonicalWire(prior)!==canonicalWire(entry))throw Error('task completion identity changed')
  const linked=await owner.transitionSharedTask({claim,operationId:progress.linkId,transition:{kind:'recovery',recovery:{...current.task.recovery,completed:prior?current.task.recovery.completed:[...current.task.recovery.completed,entry]}}})
  if(linked.kind!=='owned')throw Error('task completion link pending: '+linked.reason)
  await helpers.updateRun(root,run.runId,r=>({sharedClaim:r.sharedClaim?{...r.sharedClaim,stateCommit:linked.claim.stateCommit}:null}))
  await checkpointRecoveryContext(await readRun(root,run.runId),config,{gh:transport.gh,claim:linked.claim})
  return{taskId,headSha:source.headSha,reference:progress.reference,wrote:true,replayed:false,reason:'configured check and task-only recovery receipt verified'}
 }finally{await releaseClaim(held.claim)}
}

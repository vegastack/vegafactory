// `vegafactory dispatch …` — the listed machine that works the board on its own.
//
// It refuses to run at all unless this machine is named in the control room's `dispatchers.md`:
// the roster is the enrolment, and removing a row is how a machine is stood down. Every write the
// dispatcher makes to GitHub goes out as the VegaFactory GitHub App, on an installation token
// minted here from the private key on this machine; the agent runs themselves use the operator's
// own subscription, and an API key in the environment refuses the whole command.
import { spawn, spawnSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { APP_ACTOR, holderOf, machineName, release, trustedHolders } from './claim.ts'
import { defaultClonePath, factoryConfigPath, parseControlRoomKnob, readFactoryConfig } from './control-room.ts'
import { billingVariables, childEnvironment } from './env.ts'
import { GhError, defaultRunner, ghList, type GhResult, type GhRunner } from './gh.ts'
import { assertRepo, cacheDir, replaceFile, syncIssue, type GhIssue } from './issue-cache.ts'
import { detectRepo, latestOfType, permissionLookup, repoRoot, snapshot, type PermissionLookup, type Snapshot } from './issue.ts'
import { stateOf, type State } from './labels.ts'
import { parseIndependentGroups, sharedByEveryChild } from '../../../skills/dev/dev-plan/scripts/plan-lint.mjs'

// How often the board is read, how many steps run at once, and how long one step may take.
export const POLL_MS = 2 * 60_000
export const MAX_RUNS = 3
export const STEP_TIMEOUT_MS = 20 * 60_000
// A failed step waits this long before the next try, doubling each time, and is parked after three.
export const RETRY_MS = 15 * 60_000
export const MAX_FAILURES = 3
// What a run's own output contributes to its record; the output never reaches the issue.
export const MAX_NOTE = 400

export const SERVICE_NAME = 'com.vegastack.vegafactory.dispatch'

// ---------------------------------------------------------------------------------------------
// The roster: the control room's dispatchers.md

export interface Dispatcher { machine: string; operator: string | null; repos: string[] }

const cells = (line: string) => line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
const separator = (cell: string) => /^:?-{2,}:?$/.test(cell)

// One row per machine. A table row is `| machine | operator | repos | note |`, and a bullet is
// `- machine — repos`; `*`, `all` or an empty repos cell means every repository of the org.
export function parseDispatchers(text: string): Dispatcher[] {
  const found: Dispatcher[] = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    let machine = ''
    let operator: string | null = null
    let repos = ''
    if (line.startsWith('|')) {
      const row = cells(line)
      if (row.length < 2 || row.some(separator) || /^machine$/i.test(row[0] ?? '')) continue
      machine = row[0] ?? ''
      operator = row[1] ?? null
      repos = row[2] ?? ''
    } else {
      const match = /^-\s+`?([A-Za-z0-9][\w.-]*)`?\s*(?:—|--)\s*(.*)$/.exec(line)
      if (!match) continue
      machine = match[1]!
      repos = match[2] ?? ''
    }
    const name = machineName(machine.replace(/`/g, ''))
    if (!machine.trim() || name === 'machine') continue
    found.push({
      machine: name,
      operator: operator && operator !== '-' ? operator.replace(/^@/, '') : null,
      repos: repos.split(/[,\s]+/).map((repo) => repo.replace(/`/g, '').trim()).filter((repo) => repo && repo !== '-'),
    })
  }
  return found
}

export const dispatchersPath = (clone: string) => join(clone, 'dispatchers.md')

// Where this machine's copy of the org control room lives: the path the last sync recorded, else
// the default clone path for the org this repository's dev.md names.
export function controlRoomClone(root: string, home = homedir()): { org: string; clone: string } | null {
  const devMd = join(root, '.vegastack', 'dev.md')
  const knob = existsSync(devMd) ? parseControlRoomKnob(readFileSync(devMd, 'utf8')) : null
  if (!knob) return null
  let path: string | null = null
  try { path = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')).controlRooms[knob.org]?.path ?? null } catch { path = null }
  return { org: knob.org, clone: path ?? defaultClonePath(knob.org, home) }
}

export interface Listing { ok: boolean; reason: string; entry: Dispatcher | null; file: string | null }

// The gate every verb passes. A missing or unreadable roster refuses, never defaults: a machine
// nobody listed must not start working the board because a file was late.
export function listedHere(root: string, options: { repo: string; host?: string; home?: string }): Listing {
  const machine = machineName(options.host ?? hostname())
  const room = controlRoomClone(root, options.home ?? homedir())
  if (!room) return { ok: false, reason: `this repository names no control room (dev.md's control-room: knob), so no machine is listed to dispatch it`, entry: null, file: null }
  const file = dispatchersPath(room.clone)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: `${file} is not on this machine — run \`vegafactory sync\` to refresh the ${room.org} control room, and add ${machine} to dispatchers.md in a control-room PR`, entry: null, file }
  }
  const entry = parseDispatchers(text).find((row) => row.machine === machine) ?? null
  if (!entry) return { ok: false, reason: `${machine} is not listed in ${file} — add it in a control-room PR before this machine dispatches anything`, entry: null, file }
  const every = entry.repos.length === 0 || entry.repos.some((repo) => repo === '*' || repo.toLowerCase() === 'all')
  if (!every && !entry.repos.includes(options.repo)) return { ok: false, reason: `${machine} is listed in ${file} for ${entry.repos.join(', ')}, not ${options.repo}`, entry, file }
  return { ok: true, reason: `${machine} is listed in ${file}`, entry, file }
}

// ---------------------------------------------------------------------------------------------
// Identity: the VegaFactory GitHub App

// The published App (dev-setup's references/github-app.md). An org running its own copy sets
// VEGAFACTORY_APP_ID; the key file is the only other input, and neither is ever printed.
export const APP_ID = '4812956'
export { APP_ACTOR }

export function appKeyPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const named = env.VEGAFACTORY_APP_PRIVATE_KEY_FILE?.trim()
  return named || join(home, '.vegastack', 'vegafactory-app.pem')
}

export function missingKeyMessage(path: string): string {
  return `the VegaFactory App private key is not readable at ${path} — put the .pem there (chmod 600) or set VEGAFACTORY_APP_PRIVATE_KEY_FILE to where it is; the dispatcher writes as the App and never falls back to a person's token`
}

const base64url = (value: string) => Buffer.from(value).toString('base64url')

// A nine-minute App JWT. GitHub allows at most ten and a minute of clock drift.
export function appJwt(pem: string, appId: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  return `${header}.${claims}.${signer.sign(pem, 'base64url')}`
}

export interface FetchReply { ok: boolean; status: number; json: () => Promise<unknown> }
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchReply>

export interface AppToken { token: string; expiresAt: number }

// An installation token for this one repository: a JWT names the App, the installation is read
// from the repository itself, and the token is narrowed to that repository. It lives an hour and
// stays in memory — never written down, never printed, never put on a command line.
export async function mintToken(input: { repo: string; keyPath: string; appId: string; fetch?: Fetch; now?: number }): Promise<AppToken> {
  const { repo, keyPath, appId, fetch: call = globalThis.fetch as unknown as Fetch, now = Date.now() } = input
  assertRepo(repo)
  let pem: string
  try { pem = readFileSync(keyPath, 'utf8') } catch { throw new Error(missingKeyMessage(keyPath)) }
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(pem)) throw new Error(`${keyPath} is not a PEM private key — download the App's key again`)
  let jwt: string
  try { jwt = appJwt(pem, appId, now) } catch (error) { throw new Error(`the App key at ${keyPath} could not sign: ${(error as Error).message}`) }
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vegafactory-dispatch' }
  const install = await call(`https://api.github.com/repos/${repo}/installation`, { method: 'GET', headers })
  if (!install.ok) throw new Error(`the VegaFactory App is not installed on ${repo} (GitHub answered ${install.status}) — install it, or check VEGAFACTORY_APP_ID`)
  const id = (await install.json() as { id?: number }).id
  if (!Number.isSafeInteger(id)) throw new Error(`GitHub returned no installation id for ${repo}`)
  const name = repo.split('/')[1]!
  const minted = await call(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ repositories: [name] }),
  })
  if (!minted.ok) throw new Error(`minting an installation token for ${repo} failed (GitHub answered ${minted.status})`)
  const body = await minted.json() as { token?: string; expires_at?: string }
  if (typeof body.token !== 'string' || !body.token) throw new Error('GitHub returned no installation token')
  return { token: body.token, expiresAt: Date.parse(body.expires_at ?? '') || now + 55 * 60_000 }
}

// `gh` run as the App. The token reaches the child through its environment and nowhere else.
export function tokenRunner(token: string, timeoutMs = 30_000): GhRunner {
  return (args, input): GhResult => {
    const result = spawnSync(process.env.VEGAFACTORY_GH || 'gh', args, {
      encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
    })
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new GhError(`gh ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`)
    if (result.error) throw new GhError(`gh could not start: ${result.error.message}`)
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

// ---------------------------------------------------------------------------------------------
// Readiness and the service unit

export interface Check { name: string; ok: boolean; detail: string }
export type Probe = (command: string, args: string[]) => { code: number; stdout: string; stderr: string }

export const probe: Probe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 })
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message }
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

// Whether this repository's harness hooks call the CLI. Both files are checked: a machine that
// dispatches Claude Code and Codex runs needs the guard and the heartbeat on both.
export function hooksWired(root: string): Check {
  const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
  const claude = read(join(root, '.claude', 'settings.json')).includes('vegafactory hook')
  const codex = read(join(root, '.codex', 'hooks.json')).includes('vegafactory hook')
  if (claude && codex) return { name: 'hooks', ok: true, detail: 'both harnesses call vegafactory hook' }
  if (claude || codex) return { name: 'hooks', ok: false, detail: `only ${claude ? 'Claude Code' : 'Codex'} calls vegafactory hook — wire the other too` }
  return { name: 'hooks', ok: false, detail: 'no harness hook calls vegafactory hook — run vegafactory init in this repository' }
}

// A real turn from each tool, never a status command: Codex prints "Logged in" on a revoked token.
export function harnessAnswers(run: Probe): Check[] {
  const checks: Check[] = []
  for (const [name, command, args] of [
    ['claude', 'claude', ['-p', 'say ok']],
    ['codex', 'codex', ['exec', '--sandbox', 'read-only', '-a', 'never', 'say ok']],
  ] as Array<[string, string, string[]]>) {
    const result = run(command, args)
    const ok = result.code === 0 && /\bok\b/i.test(result.stdout)
    checks.push({
      name, ok,
      detail: ok ? `${command} answers on its subscription` : `${command} did not answer ok: ${(result.stderr || result.stdout).split('\n').at(-1)?.slice(0, 160) || `exit ${result.code}`}`,
    })
  }
  return checks
}

export interface ReadyInput { root: string; listing: Listing; run: Probe; keyOk: boolean; keyDetail: string; env: NodeJS.ProcessEnv }

export function readiness(input: ReadyInput): Check[] {
  const billing = billingVariables(input.env)
  return [
    { name: 'listed', ok: input.listing.ok, detail: input.listing.reason },
    { name: 'billing', ok: billing.length === 0, detail: billing.length ? `${billing.join(', ')} set — the dispatcher runs on subscriptions only; unset them` : 'no API-key variable is set' },
    hooksWired(input.root),
    ...harnessAnswers(input.run),
    { name: 'app-key', ok: input.keyOk, detail: input.keyDetail },
  ]
}

export const renderChecks = (checks: Check[]) => checks.map((check) => `${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(8)} ${check.detail}`).join('\n')

export function unitPath(platform: NodeJS.Platform, home = homedir()): string {
  return platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`)
    : join(home, '.config', 'systemd', 'user', 'vegafactory-dispatch.service')
}

// The unit runs one command: this CLI's own `dispatch run`, in the repository, restarted when it
// stops. Nothing in it carries a token; the repository and the log path are all it knows.
export function unitText(platform: NodeJS.Platform, input: { cli: string[]; root: string; repo: string; logDir: string }): string {
  const argv = [...input.cli, 'dispatch', 'run', '--repo', input.repo]
  if (platform === 'darwin') {
    const escaped = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">', '<dict>',
      `  <key>Label</key><string>${SERVICE_NAME}</string>`,
      '  <key>ProgramArguments</key>', '  <array>',
      ...argv.map((arg) => `    <string>${escaped(arg)}</string>`),
      '  </array>',
      `  <key>WorkingDirectory</key><string>${escaped(input.root)}</string>`,
      '  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>',
      `  <key>StandardOutPath</key><string>${escaped(join(input.logDir, 'dispatch.log'))}</string>`,
      `  <key>StandardErrorPath</key><string>${escaped(join(input.logDir, 'dispatch.err.log'))}</string>`,
      '</dict>', '</plist>', '',
    ].join('\n')
  }
  return [
    '[Unit]', 'Description=VegaFactory dispatcher', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${input.root}`,
    `ExecStart=${argv.map((arg) => JSON.stringify(arg)).join(' ')}`,
    'Restart=always', 'RestartSec=30', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')
}

export function serviceCommands(platform: NodeJS.Platform, path: string, verb: 'enable' | 'disable', uid = userInfo().uid): string[][] {
  if (platform === 'darwin') {
    const target = `gui/${uid}`
    return verb === 'enable'
      ? [['launchctl', 'bootstrap', target, path], ['launchctl', 'enable', `${target}/${SERVICE_NAME}`]]
      : [['launchctl', 'bootout', `${target}/${SERVICE_NAME}`]]
  }
  return verb === 'enable'
    ? [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'vegafactory-dispatch.service']]
    : [['systemctl', '--user', 'disable', '--now', 'vegafactory-dispatch.service']]
}

// ---------------------------------------------------------------------------------------------
// What the dispatcher writes down: the runs it made and what it has already acted on

export type Action = 'follow-up' | 'plan' | 'implement' | 'corrections' | 'ship' | 'stop' | 'none'
export type Outcome = 'done' | 'blocked' | 'failed' | 'killed' | 'limit' | 'stopped'

export interface RunRecord { at: string; issue: number; action: Action; outcome: Outcome; ms: number; machine: string; note: string }
export interface Acted { at: number; action: Action; outcome: Outcome; trigger: number | null; failures: number; retryAt: number | null }

export const dispatchDir = (root: string) => join(root, '.vegastack', '.tmp', 'dispatch')
const runsPath = (root: string) => join(dispatchDir(root), 'runs.jsonl')
const actedPath = (root: string) => join(dispatchDir(root), 'acted.json')

export function recordRun(root: string, record: RunRecord) {
  mkdirSync(dispatchDir(root), { recursive: true })
  appendFileSync(runsPath(root), JSON.stringify(record) + '\n')
}

export function readRuns(root: string, limit = 20): RunRecord[] {
  let text = ''
  try { text = readFileSync(runsPath(root), 'utf8') } catch { return [] }
  const rows: RunRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line) as RunRecord) } catch { /* a truncated line is not a run */ }
  }
  return rows.slice(-limit)
}

export function readActed(root: string): Record<string, Acted> {
  try { return JSON.parse(readFileSync(actedPath(root), 'utf8')) as Record<string, Acted> } catch { return {} }
}

export function writeActed(root: string, acted: Record<string, Acted>) {
  mkdirSync(dispatchDir(root), { recursive: true })
  replaceFile(actedPath(root), JSON.stringify(acted, null, 2) + '\n')
}

// ---------------------------------------------------------------------------------------------
// The transitions

export interface Decision { action: Action; reason: string; trigger: number | null; by: string | null; split: boolean }

const nothing = (reason: string): Decision => ({ action: 'none', reason, trigger: null, by: null, split: false })

const SHIP_IT = /(^|[^\w])ship it([^\w]|$)/i
// "stop", "stop.", "@vegafactory stop — I need to rethink this". Not "stop using the old API",
// which is a correction about the work and not an instruction to put the issue down.
const STOP = /^\s*(?:@?[\w-]+[,:]?\s+)?stop\s*(?:$|[\n—–:,.!?])/i
const WRITE = new Set(['admin', 'maintain', 'write'])

// The operator's own comments: a person with write access, never a bot or an App.
function operatorComments(snap: Snapshot, permission: PermissionLookup) {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'human' && entry.authorType !== 'Bot' && entry.author && WRITE.has(permission(entry.author)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

// The action this issue is waiting for, and the comment that asks for it. `trigger` is what makes
// a run happen once: a comment already acted on asks for nothing more, and a state label already
// worked is not worked again until the issue moves.
export function decide(snap: Snapshot, permission: PermissionLookup, options: { acted?: Acted | null; now?: number } = {}): Decision {
  const issue = snap.state.issue!
  const { acted = null, now = Date.now() } = options
  if (issue.state !== 'open') return nothing('the issue is closed')
  if (issue.labels.includes('epic')) return nothing('an epic is a map; its sub-issues carry the work')
  const { state } = stateOf(issue.labels)
  if (!state) return nothing('no state label')
  const comments = operatorComments(snap, permission)
  const decided = transitionOf(snap, issue.labels, state, comments)
  if (decided.action === 'none') return decided

  if (acted) {
    if (acted.outcome === 'done' && acted.action === decided.action && acted.trigger === decided.trigger) {
      return nothing(`already ran ${decided.action} for this ${decided.trigger === null ? 'state' : 'comment'}`)
    }
    if (acted.action === decided.action && acted.failures >= MAX_FAILURES) return nothing(`${decided.action} failed ${acted.failures} times — this issue needs a person`)
    if (acted.action === decided.action && acted.retryAt !== null && now < acted.retryAt) {
      return nothing(`${decided.action} is waiting until ${new Date(acted.retryAt).toISOString()}`)
    }
  }
  return decided
}

type Comments = ReturnType<typeof operatorComments>

function transitionOf(snap: Snapshot, labels: string[], state: State, comments: Comments): Decision {
  const issue = snap.state.issue!
  const last = comments.at(-1) ?? null
  if (last && STOP.test(snap.body(last))) return { action: 'stop', reason: `@${last.author} said stop`, trigger: last.id, by: last.author, split: false }
  if (state === 'planning') return { action: 'plan', reason: 'the brief is acked and the plan is not written', trigger: null, by: null, split: labels.includes('large') }
  if (state === 'queued') return { action: 'implement', reason: 'the plan is acked and nobody has built it', trigger: null, by: null, split: false }
  if (state === 'waiting-on-operator') {
    // The reply the issue was waiting for: an operator comment later than the last thing an agent
    // wrote and later than the brief's own last edit.
    const agents = Object.values(snap.state.comments).filter((entry) => entry.type !== 'human').map((entry) => entry.createdAt)
    const after = [issue.bodyChangedAt, ...agents].sort().at(-1) ?? ''
    const reply = comments.filter((entry) => entry.createdAt > after).at(-1)
    return reply
      ? { action: 'follow-up', reason: `@${reply.author} replied on a waiting-on-operator issue`, trigger: reply.id, by: reply.author, split: false }
      : nothing('waiting on the operator')
  }
  if (state === 'ready-to-ship') {
    const evidence = latestOfType(snap, 'evidence')
    if (!evidence) return nothing('ready-to-ship with no evidence comment')
    const word = comments.filter((entry) => entry.createdAt > (evidence.changedAt || evidence.updatedAt)).at(-1)
    if (!word) return nothing('waiting for the operator to read the evidence')
    return SHIP_IT.test(snap.body(word))
      ? { action: 'ship', reason: `@${word.author} said ship it`, trigger: word.id, by: word.author, split: false }
      : { action: 'corrections', reason: `@${word.author} left corrections on a ready-to-ship issue`, trigger: word.id, by: word.author, split: false }
  }
  return nothing(`nothing to do while the issue is ${state}`)
}

// ---------------------------------------------------------------------------------------------
// Safety: which of the wanted steps may run at the same time

// Paths no two runs may share, whatever a plan claims: what nearly every change touches
// (plan-lint's own list), generated output, migrations and lockfiles. A join on one of these is
// the worst place to find out two agents were in the same file.
const UNSAFE = [/(^|\/)(dist|build|out|generated)\//, /(^|\/)migrations?\//, /\.lock$/, /(^|\/)package(-lock)?\.json$/, /(^|\/)skill-integrity\.json$/, /\.generated\.\w+$/]

export function unsafeForParallel(path: string): boolean {
  const normalized = String(path).replace(/^\.\//, '')
  return sharedByEveryChild(normalized) || UNSAFE.some((pattern) => pattern.test(normalized))
}

// A path ending in `/` is a directory and covers everything under it (the plan grammar's rule).
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('/') && b.startsWith(a)) return true
  return b.endsWith('/') && a.startsWith(b)
}

export interface Candidate { number: number; action: Action; parent: number | null; files: string[] }

const CODE: Action[] = ['implement', 'corrections']

// The steps that may start now, in board order. One run per issue; at most `max` at once; one
// merge at a time, because merges go through the queue one by one; and two code runs together
// only when they are sibling sub-issues whose declared file sets are disjoint and safe.
export function schedule(candidates: Candidate[], running: Candidate[] = [], max = MAX_RUNS): Candidate[] {
  const picked: Candidate[] = [...running]
  const chosen: Candidate[] = []
  for (const candidate of candidates) {
    if (picked.length >= max) break
    if (picked.some((other) => other.number === candidate.number)) continue
    if (candidate.action === 'ship' && picked.some((other) => other.action === 'ship')) continue
    if (CODE.includes(candidate.action) && !picked.filter((other) => CODE.includes(other.action)).every((other) => disjointSiblings(candidate, other))) continue
    picked.push(candidate)
    chosen.push(candidate)
  }
  return chosen
}

export function disjointSiblings(a: Candidate, b: Candidate): boolean {
  if (a.parent === null || a.parent !== b.parent) return false
  if (!a.files.length || !b.files.length) return false
  if (a.files.some(unsafeForParallel) || b.files.some(unsafeForParallel)) return false
  return !a.files.some((file) => b.files.some((their) => overlaps(file, their)))
}

// The file set a sub-issue declared, from its parent epic's plan `**Independent groups:**` block.
// No declaration means no parallel run: one at a time is the safe default.
export function filesFromParent(parentPlan: string | null, number: number): string[] {
  if (!parentPlan) return []
  const groups = parseIndependentGroups(parentPlan) as Array<{ id: string | null; members: string[]; files: string[] }>
  return groups.find((group) => group.id && group.members.includes(`#${number}`))?.files ?? []
}

// ---------------------------------------------------------------------------------------------
// Running one step

export interface Step { action: Action; number: number; repo: string; split: boolean; by: string | null }
export interface StepResult { outcome: Outcome; note: string; ms: number }
export type RunStep = (step: Step, context: { root: string }) => Promise<StepResult>

// A run that stopped because the subscription said "enough for now". Each tool words it its own
// way, and each of these is a limit, not a failure of the work.
const LIMIT = /\b(usage limit reached|rate limit|quota exceeded|out of (?:usage|credits?)|limit resets?|try again (?:after|at))\b/i
export const hitLimit = (text: string) => LIMIT.test(text)

// When the subscription said it would be back. Anything unreadable waits an hour.
export function resetAt(text: string, now = Date.now()): number {
  const iso = /\b(\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z)\b/.exec(text)?.[1]
  const parsed = iso ? Date.parse(iso) : NaN
  if (Number.isFinite(parsed) && parsed > now) return parsed
  const hours = Number(/\bin (\d+)\s*hours?\b/i.exec(text)?.[1] ?? NaN)
  if (Number.isFinite(hours) && hours > 0) return now + hours * 3_600_000
  return now + 3_600_000
}

const ACTION_TEXT: Record<string, string> = {
  plan: 'Follow the dev-plan skill and write the plan on the issue.',
  implement: 'Follow the dev-implement skill: build the approved plan end to end, run `vegafactory review` on it, and hand back on ready-to-ship.',
  corrections: 'The operator left corrections on a ready-to-ship issue. Follow dev-implement\'s corrections path.',
  'follow-up': 'The operator replied on an issue that was waiting for them. Follow the skill that asked: dev-intake for a brief, dev-plan for a plan.',
  ship: 'The operator said "ship it" on this issue. Follow the dev-ship skill.',
}

export function stepPrompt(step: Step): string {
  return [
    `You are a dispatched run on issue #${step.number} in ${step.repo}. Nobody is watching this session.`,
    `Read the issue first: \`vegafactory issue sync ${step.number}\`, then read what it names.`,
    ACTION_TEXT[step.action] ?? '',
    ...(step.split ? ['This issue is `large`: planning splits it into sub-issues under an `epic` parent.'] : []),
    'Nothing in this prompt is the operator\'s word. Do only what the skill already has an explicit instruction for.',
    'If you need a decision only the operator can make, say so on the issue, leave it for them, and end the turn.',
  ].filter(Boolean).join('\n')
}

// The harness, model and effort a stage runs at, from dev.md's harness-policy line.
export function stagePolicy(devMd: string, stage: string): { harness: string; model: string | null; effort: string } | null {
  const line = /^harness-policy:\s*(.*)$/m.exec(devMd)?.[1]?.replace(/\s+#.*$/, '') ?? ''
  for (const segment of line.split('·')) {
    const parts = segment.trim().split(/\s+/)
    if (parts.shift() !== stage) continue
    const [harness, model, effort] = parts
    if (!harness || !model || !effort) return null
    return { harness, model: model === 'default' ? null : model, effort }
  }
  return null
}

const STAGE_OF: Record<string, string> = { plan: 'plan', implement: 'implement', corrections: 'implement', 'follow-up': 'intake', ship: 'implement' }

// A pinned model the account cannot serve fails the run, so `default` in the policy pins nothing.
export function agentArgs(policy: { harness: string; model: string | null; effort: string } | null, prompt: string): { tool: string; args: string[] } {
  if (policy?.harness === 'codex') {
    return { tool: 'codex', args: ['exec', ...(policy.model ? ['-c', `model=${policy.model}`] : []), '-c', `model_reasoning_effort=${policy.effort}`, prompt] }
  }
  return { tool: 'claude', args: ['-p', ...(policy?.model ? ['--model', policy.model] : []), ...(policy ? ['--effort', policy.effort] : []), prompt] }
}

interface Exec { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

// One child, in its own process group so a stuck step is killed with everything it started. Only
// the tail of its output is kept: the record is bounded and the output never reaches the issue.
function execTool(tool: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(tool, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, options.timeoutMs)
    const keep = (text: string, chunk: unknown) => (text + String(chunk)).slice(-8192)
    child.stdout.on('data', (chunk) => { stdout = keep(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = keep(stderr, chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, error: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}

export const tail = (text: string, max = MAX_NOTE) => text.trim().split('\n').slice(-3).join(' ').slice(-max)

// The issue's worktree when one exists; a step that needs a branch makes its own.
export function workingDir(root: string, number: number): string | null {
  const base = join(root, '.vegastack', '.worktrees')
  try {
    const match = readdirSync(base).find((name) => name.startsWith(`${number}-`))
    return match && statSync(join(base, match)).isDirectory() ? join(base, match) : null
  } catch { return null }
}

// The real step: a headless agent run on the operator's subscription, in the issue's worktree,
// killed after the step limit. `childEnvironment` is what refuses an API key in the environment.
export function defaultRunStep(devMd: string, env: NodeJS.ProcessEnv, { exec = execTool, timeoutMs = STEP_TIMEOUT_MS } = {}): RunStep {
  return async (step, context) => {
    const started = Date.now()
    const policy = stagePolicy(devMd, STAGE_OF[step.action] ?? 'implement')
    const { tool, args } = agentArgs(policy, stepPrompt(step))
    const cwd = workingDir(context.root, step.number) ?? context.root
    const child = await exec(tool, args, { cwd, env: childEnvironment(env), timeoutMs })
    const ms = Date.now() - started
    const text = `${child.stderr}\n${child.stdout}`
    if (child.timedOut) return { outcome: 'killed', note: `${tool} ran past the ${timeoutMs / 60_000}-minute step limit and was stopped`, ms }
    if (hitLimit(text)) return { outcome: 'limit', note: tail(text), ms }
    if (child.error) return { outcome: 'failed', note: `could not start ${tool}: ${child.error}`, ms }
    if (child.code !== 0) return { outcome: 'failed', note: `${tool} exited ${child.code}: ${tail(text)}`, ms }
    return { outcome: 'done', note: tail(child.stdout), ms }
  }
}

// ---------------------------------------------------------------------------------------------
// The poll

// Every open issue carrying a state label. One list request per poll; the per-issue reads that
// follow are conditional, so an unchanged issue costs almost nothing.
export function board(repo: string, runner: GhRunner): GhIssue[] {
  const issues = ghList<GhIssue & { pull_request?: unknown }>(`repos/${repo}/issues?state=open&sort=updated&direction=desc`, runner)
  return issues.filter((issue) => !issue.pull_request && stateOf(issue.labels.map((label) => (typeof label === 'string' ? label : label.name))).state !== null)
}

export interface PollDeps {
  root: string
  repo: string
  runner: GhRunner
  now: () => number
  runStep: RunStep
  out: (text: string) => void
  machine: string
  // Saves, pushes and releases an issue this machine is giving up.
  standDown: (number: number, reason: string) => string
}

// The steps this machine has started and not yet seen finish. It lives across polls, so the next
// pass two minutes later sees them, keeps their slots and can still act on the rest of the board.
export interface Inflight { candidate: Candidate; started: number; done: Promise<RunRecord> }
export const drain = (inflight: Map<number, Inflight>) => Promise.all([...inflight.values()].map((run) => run.done))

// One pass over the board: read what changed, decide, and start what is safe to start now. The
// steps run to their own end; this returns as soon as they are under way.
export async function poll(deps: PollDeps, inflight: Map<number, Inflight> = new Map()): Promise<Candidate[]> {
  const { root, repo, runner, now } = deps
  const permission = permissionLookup(repo, runner, { root })
  const trusted = trustedHolders({ repo, runner, root })
  const acted = readActed(root)
  const wanted: Array<{ candidate: Candidate; decision: Decision; key: string }> = []
  const plans = new Map<number, string | null>()
  for (const issue of board(repo, runner)) {
    let snap: Snapshot
    try {
      syncIssue({ root, repo, number: issue.number, runner })
      snap = snapshot(cacheDir(root, repo, issue.number))
    } catch (error) {
      deps.out(`#${issue.number}: could not be read (${(error as Error).message})`)
      continue
    }
    const key = `${repo}#${issue.number}`
    const decision = decide(snap, permission, { acted: acted[key] ?? null, now: now() })
    if (decision.action === 'none') continue
    // A fresh claim means someone — a person or another machine — is already on it.
    if (decision.action !== 'stop' && holderOf(snap.state, snap.body, now(), trusted).holder) {
      deps.out(`#${issue.number}: skipped, a fresh claim holds it`)
      continue
    }
    const parent = snap.state.issue!.parent
    if (parent !== null && !plans.has(parent)) plans.set(parent, parentPlan(root, repo, parent, runner))
    const files = parent === null ? [] : filesFromParent(plans.get(parent) ?? null, issue.number)
    wanted.push({ key, decision, candidate: { number: issue.number, action: decision.action, parent, files } })
  }

  const started: Candidate[] = []
  for (const candidate of schedule(wanted.map((item) => item.candidate), [...inflight.values()].map((run) => run.candidate))) {
    const item = wanted.find((entry) => entry.candidate.number === candidate.number)!
    const at = now()
    const done = step(deps, candidate, item.decision, at)
      .then((result) => settle(deps, candidate, item, at, result))
      .finally(() => { inflight.delete(candidate.number) })
    inflight.set(candidate.number, { candidate, started: at, done })
    started.push(candidate)
  }
  return started
}

// One step, whatever it is. A stop needs no agent: it is this machine giving the issue back.
async function step(deps: PollDeps, candidate: Candidate, decision: Decision, at: number): Promise<StepResult> {
  if (candidate.action === 'stop') return { outcome: 'stopped', note: deps.standDown(candidate.number, decision.reason), ms: 0 }
  try {
    return await deps.runStep({ action: candidate.action, number: candidate.number, repo: deps.repo, split: decision.split, by: decision.by }, { root: deps.root })
  } catch (error) {
    return { outcome: 'failed', note: (error as Error).message, ms: deps.now() - at }
  }
}

// What a finished step leaves behind: one bounded record, and what the next pass reads to know
// this trigger is spent. `acted` is re-read here, because another step may have settled meanwhile.
function settle(deps: PollDeps, candidate: Candidate, item: { key: string; decision: Decision }, at: number, result: StepResult): RunRecord {
  const record: RunRecord = {
    at: new Date(at).toISOString(), issue: candidate.number, action: candidate.action,
    outcome: result.outcome, ms: result.ms, machine: deps.machine, note: tail(result.note),
  }
  recordRun(deps.root, record)
  const acted = readActed(deps.root)
  const previous = acted[item.key]
  const failed = result.outcome === 'failed' || result.outcome === 'killed'
  const failures = failed ? (previous && previous.action === candidate.action ? previous.failures : 0) + 1 : 0
  const retryAt = failed ? at + RETRY_MS * 2 ** (failures - 1) : result.outcome === 'limit' ? resetAt(result.note, at) : null
  acted[item.key] = { at, action: candidate.action, outcome: result.outcome, trigger: item.decision.trigger, failures, retryAt }
  writeActed(deps.root, acted)
  // A subscription limit is not the issue's fault: the work is saved and given back, and this
  // machine tries again after the reset.
  if (result.outcome === 'limit') deps.standDown(candidate.number, `the subscription limit was reached; this machine tries again after ${new Date(retryAt!).toISOString()}`)
  deps.out(`#${record.issue} ${record.action} → ${record.outcome}${record.note ? ` (${record.note})` : ''}`)
  return record
}

// The parent epic's plan comment, where sibling file sets are declared.
function parentPlan(root: string, repo: string, parent: number, runner: GhRunner): string | null {
  try {
    syncIssue({ root, repo, number: parent, runner })
    const snap = snapshot(cacheDir(root, repo, parent))
    const plan = latestOfType(snap, 'plan')
    return plan ? snap.body(plan) : null
  } catch { return null }
}

// Giving an issue up: commit and push whatever the worktree holds, then release the claim the run
// took, with a note. Nothing is forced, and a rejected push leaves the commit local for a person.
// Only a claim held by this machine is released: another machine's claim is not ours to drop.
export function standDown(ctx: { root: string; repo: string; number: number; runner: GhRunner; machine: string; now?: number }, reason: string): string {
  const dir = workingDir(ctx.root, ctx.number)
  const notes: string[] = []
  if (dir) {
    const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 })
    if (git(['status', '--porcelain']).stdout.trim()) {
      git(['add', '--all'])
      notes.push(git(['commit', '--quiet', '-m', `wip: #${ctx.number} saved before standing down`]).status === 0 ? 'committed the open work' : 'the open work could not be committed')
    }
    const branch = git(['branch', '--show-current']).stdout.trim()
    if (branch) {
      notes.push(git(['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`]).status === 0 ? `pushed ${branch}` : `the push of ${branch} was rejected, so the commit stays local`)
    }
  }
  const claimCtx = { root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner }
  try {
    syncIssue({ ...claimCtx })
    const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
    const held = holderOf(snap.state, snap.body, ctx.now ?? Date.now(), trustedHolders(claimCtx)).holder
    if (!held) notes.push('no live claim to release')
    else if (!held.owner.startsWith(`${ctx.machine}:`)) notes.push(`the claim is held by ${held.owner}, so it was left alone`)
    else {
      release(claimCtx, held.owner, APP_ACTOR, reason)
      notes.push(`released ${held.owner}`)
    }
  } catch (error) { notes.push(`the claim could not be released: ${(error as Error).message}`) }
  return `${reason} — ${notes.join(', ')}`
}

// ---------------------------------------------------------------------------------------------
// CLI

export function dispatchUsage(): string {
  return `Usage: vegafactory dispatch <enable|disable|status|run> [options]

  enable                 check this machine is ready — listed in the control room's dispatchers.md,
                         harness hooks wired, a real \`claude -p\` and \`codex exec\` answering, the
                         GitHub App key present — then install the launchd or systemd unit
  disable                remove the unit; the machine stops picking work up
  status                 the board, plus this machine's recent dispatcher runs
  run [--once]           the poll loop itself (the unit runs this); --once makes a single pass

Options: --repo OWNER/NAME · --json · --dry-run (enable and disable show what they would do)

A machine the control room's dispatchers.md does not name refuses every verb but disable. Writes
go out as the VegaFactory GitHub App, on an hour-long token minted here from its private key:
  ${appKeyPath()}
(VEGAFACTORY_APP_PRIVATE_KEY_FILE moves it, VEGAFACTORY_APP_ID names another App.) The agent runs
use the operator's own subscription, so an API-key variable in the environment refuses the run.
`
}

interface Args { verb: string; flags: Record<string, string>; json: boolean; dryRun: boolean; once: boolean }

export function parseDispatchArgs(argv: string[]): Args {
  const [verb, ...rest] = argv
  if (!verb) throw new Error('missing verb — run vegafactory dispatch --help')
  const flags: Record<string, string> = {}
  let json = false
  let dryRun = false
  let once = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--json') { json = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--once') { once = true; continue }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    flags[arg.slice(2)] = value
    i++
  }
  return { verb, flags, json, dryRun, once }
}

export interface CliDeps {
  cwd?: string
  out?: (text: string) => void
  runner?: GhRunner
  run?: Probe
  env?: NodeJS.ProcessEnv
  home?: string
  host?: string
  platform?: NodeJS.Platform
  fetch?: Fetch
  runStep?: RunStep
  sleep?: (ms: number) => Promise<void>
  cli?: string[]
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

// A `gh` that acts as the App. The token is minted per command and never leaves this process
// except in that child's environment.
async function appRunner(repo: string, keyPath: string, env: NodeJS.ProcessEnv, call?: Fetch): Promise<GhRunner> {
  const minted = await mintToken({ repo, keyPath, appId: env.VEGAFACTORY_APP_ID?.trim() || APP_ID, fetch: call })
  return tokenRunner(minted.token)
}

export async function runDispatch(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0]!)) { out(dispatchUsage()); return 0 }
  const args = parseDispatchArgs(argv)
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const host = deps.host ?? hostname()
  const platform = deps.platform ?? process.platform
  const root = repoRoot(cwd)
  const repo = assertRepo(args.flags.repo ?? detectRepo(root))
  const machine = machineName(host)
  const listing = listedHere(root, { repo, host, home })
  const keyPath = appKeyPath(env, home)
  const print = (value: unknown, text: string) => out(args.json ? JSON.stringify(value, null, 2) : text)

  // The gate, before anything else: an unlisted machine does nothing but say so. `disable` is the
  // exception, so a machine taken off the roster can still take its own unit down.
  if (!listing.ok && args.verb !== 'disable') {
    print({ ok: false, machine, reason: listing.reason }, `refused: ${listing.reason}`)
    return 2
  }

  switch (args.verb) {
    case 'enable': {
      let keyOk = false
      let keyDetail = ''
      try {
        await mintToken({ repo, keyPath, appId: env.VEGAFACTORY_APP_ID?.trim() || APP_ID, fetch: deps.fetch })
        keyOk = true
        keyDetail = `the App key at ${keyPath} mints an installation token for ${repo}`
      } catch (error) { keyDetail = (error as Error).message }
      const checks = readiness({ root, listing, run: deps.run ?? probe, keyOk, keyDetail, env })
      const path = unitPath(platform, home)
      if (!checks.every((check) => check.ok)) {
        print({ ok: false, checks }, `${renderChecks(checks)}\n\nnot ready — fix the FAIL lines above, then run this again`)
        return 2
      }
      const commands = serviceCommands(platform, path, 'enable')
      if (args.dryRun) {
        print({ ok: true, checks, unit: path, dryRun: true }, `${renderChecks(checks)}\n\ndry run: would write ${path}, then ${commands.map((command) => command.join(' ')).join(' && ')}`)
        return 0
      }
      mkdirSync(dispatchDir(root), { recursive: true })
      replaceFile(path, unitText(platform, { cli: deps.cli ?? cliPath(), root, repo, logDir: dispatchDir(root) }))
      const run = deps.run ?? probe
      for (const command of commands) {
        const result = run(command[0]!, command.slice(1))
        // launchctl answers non-zero for a label already loaded; the unit is installed either way.
        if (result.code !== 0 && !/already/i.test(result.stderr)) {
          print({ ok: false, unit: path, failed: command.join(' '), detail: result.stderr },
            `wrote ${path}, but \`${command.join(' ')}\` failed: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`)
          return 1
        }
      }
      print({ ok: true, checks, unit: path }, `${renderChecks(checks)}\n\nenabled — ${path} is loaded; this machine polls ${repo} every ${POLL_MS / 60_000} minutes`)
      return 0
    }
    case 'disable': {
      const path = unitPath(platform, home)
      const commands = serviceCommands(platform, path, 'disable')
      if (args.dryRun) {
        print({ dryRun: true, unit: path }, `dry run: would ${commands.map((command) => command.join(' ')).join(' && ')}, then delete ${path}`)
        return 0
      }
      const run = deps.run ?? probe
      const problems: string[] = []
      for (const command of commands) {
        const result = run(command[0]!, command.slice(1))
        if (result.code !== 0 && !/no such|not (?:find|loaded|exist)/i.test(result.stderr)) problems.push(`${command.join(' ')}: ${result.stderr.split('\n')[0] || `exit ${result.code}`}`)
      }
      rmSync(path, { force: true })
      print({ ok: problems.length === 0, unit: path, problems },
        problems.length ? `removed ${path}, with: ${problems.join('; ')}` : `disabled — ${path} is unloaded and deleted`)
      return problems.length ? 1 : 0
    }
    case 'status': {
      // Reading the board changes nothing, so it does not need the App: whoever runs this reads
      // with their own `gh`, and the key is only needed once the machine starts writing.
      const runner = deps.runner ?? defaultRunner
      const rows = board(repo, runner).map((issue) => ({
        number: issue.number, title: issue.title, url: issue.html_url,
        state: stateOf(issue.labels.map((label) => (typeof label === 'string' ? label : label.name))).state!,
      }))
      const runs = readRuns(root)
      const byState = new Map<string, number[]>()
      for (const row of rows) byState.set(row.state, [...(byState.get(row.state) ?? []), row.number])
      print({ repo, machine, listed: listing.ok, board: rows, runs }, [
        `${repo} · ${machine} · ${listing.ok ? 'listed to dispatch' : listing.reason}`,
        ...[...byState].map(([state, numbers]) => `${state.padEnd(20)} ${numbers.map((number) => `#${number}`).join(' ')}`),
        '',
        runs.length ? 'recent runs on this machine:' : 'no dispatcher runs on this machine yet',
        ...runs.map((run) => `${run.at}  #${run.issue} ${run.action.padEnd(12)} ${run.outcome.padEnd(8)} ${Math.round(run.ms / 1000)}s  ${run.note}`),
      ].join('\n'))
      return 0
    }
    case 'run': {
      const billing = billingVariables(env)
      if (billing.length) {
        const [is, them] = billing.length === 1 ? ['is', 'it'] : ['are', 'them']
        print({ ok: false, billing }, `refused: ${billing.join(', ')} ${is} set — VegaFactory runs Claude Code and Codex on their subscriptions only; unset ${them} and retry`)
        return 2
      }
      let devMd = ''
      try { devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8') } catch { /* no profile, so the tools' own defaults */ }
      const runner = deps.runner ?? await appRunner(repo, keyPath, env, deps.fetch)
      const pollDeps: PollDeps = {
        root, repo, runner, machine, out: args.json ? () => {} : out, now: Date.now,
        runStep: deps.runStep ?? defaultRunStep(devMd, env),
        standDown: (number, reason) => standDown({ root, repo, number, runner, machine }, reason),
      }
      // Started steps outlive the pass that began them, so the next pass keeps their slots and
      // still acts on the rest of the board — a twenty-minute build does not stop the poll.
      const inflight = new Map<number, Inflight>()
      for (;;) {
        try {
          for (const candidate of await poll(pollDeps, inflight)) out(`#${candidate.number} ${candidate.action} started`)
        } catch (error) {
          out(`poll failed: ${(error as Error).message}`)
        }
        if (args.once) {
          const records = await drain(inflight)
          if (args.json) out(JSON.stringify(records))
          return 0
        }
        await (deps.sleep ?? wait)(POLL_MS)
      }
    }
    default:
      throw new Error(`unknown dispatch verb: ${args.verb} — run vegafactory dispatch --help`)
  }
}

const cliPath = (): string[] => [process.execPath, process.argv[1] ?? 'vegafactory']

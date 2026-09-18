// `vegafactory dispatch …` — the listed machine that works the board on its own.
//
// It refuses to run at all unless this machine is named in the control room's `dispatchers.md`:
// the roster is the enrolment, and removing a row is how a machine is stood down. Every write the
// dispatcher makes to GitHub goes out as the VegaFactory GitHub App, on an installation token
// minted here from the private key on this machine; the agent runs themselves use the operator's
// own subscription, and an API key in the environment refuses the whole command.
import { spawn, spawnSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join, posix } from 'node:path'
import { APP_ACTOR, HEARTBEAT_EVERY_MS, claim, heartbeat, holderOf, machineName, release, trustedHolders } from './claim.ts'
import { defaultClonePath, factoryConfigPath, parseControlRoomKnob, readFactoryConfig } from './control-room.ts'
import { billingVariables, childEnvironment } from './env.ts'
import { GhError, defaultRunner, ghList, type GhResult, type GhRunner } from './gh.ts'
import { assertRepo, cacheDir, readState, replaceFile, syncIssue, withLock, type CommentEntry, type GhIssue, type IssueEntry } from './issue-cache.ts'
import {
  ackBody, artifactHash, currentHashes, detectRepo, evidenceChangedAt, findValidAck, locked, markerKeys, nextLabels, permissionLookup,
  postComment, repoRoot, setLabels, snapshot, type PermissionLookup, type Snapshot,
} from './issue.ts'
import { issueFromBranch } from './hook.ts'
import { defaultBranch } from './guard-rules.ts'
import { stateOf, type State } from './labels.ts'
import { lintPlan, normalizeGroupPath, parseIndependentGroups, sharedByEveryChild } from '../../../skills/dev/dev-plan/scripts/plan-lint.mjs'

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
      // Three cells or it is not a row. A truncated row must not read as "every repository": the
      // roster is a gate, so a shape nobody wrote on purpose refuses rather than widens.
      const row = cells(line)
      if (row.length < 3 || row.some(separator) || /^machine$/i.test(row[0] ?? '')) continue
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

export type GitRun = (args: string[]) => { status: number | null; out: string }

export const gitIn = (dir: string): GitRun => (args) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

export interface Refresh { ok: boolean; reason: string; sha: string | null }

// The roster on disk is only as good as its last fetch. A machine de-listed in a control-room PR
// has to stop, and a file edited on the machine itself must never be the thing that authorises it,
// so the copy is fast-forwarded from its remote and refused if it is not exactly what is committed
// there. Every failure is a refusal: an out-of-date gate is not a gate.
//
// TODO(#221): the control room lands `verifiedRoom`/`loadProfile`, which verify the whole room
// against its recorded commit. Use them here once they are on main and drop this local check.
export function refreshRoster(clone: string, git: GitRun = gitIn(clone)): Refresh {
  if (git(['rev-parse', '--git-dir']).status !== 0) return { ok: false, reason: `${clone} is not a git clone of the control room — remove it and run \`vegafactory sync\``, sha: null }
  if (git(['ls-files', '--error-unmatch', 'dispatchers.md']).status !== 0) return { ok: false, reason: 'dispatchers.md is not committed in the control room, so nothing vouches for it', sha: null }
  const dirty = git(['status', '--porcelain', '--', 'dispatchers.md'])
  if (dirty.status !== 0 || dirty.out) return { ok: false, reason: 'dispatchers.md has uncommitted local changes — a roster edited on the machine authorises nothing; reset it and enrol through a control-room PR', sha: null }
  const fetched = git(['fetch', '--quiet', 'origin'])
  if (fetched.status !== 0) return { ok: false, reason: `the control room could not be refreshed (${fetched.out.split('\n')[0] || 'fetch failed'}), so this machine cannot prove it is still listed`, sha: null }
  const upstream = git(['rev-parse', '--verify', '--quiet', '@{u}'])
  if (upstream.status !== 0) return { ok: false, reason: 'the control-room clone tracks no upstream branch, so there is nothing to refresh it from', sha: null }
  const merged = git(['merge', '--ff-only', '@{u}'])
  if (merged.status !== 0) return { ok: false, reason: `the control-room clone has diverged from its remote (${merged.out.split('\n')[0] || 'no fast-forward'}) — fix it by hand`, sha: null }
  return { ok: true, reason: 'refreshed from the control room', sha: git(['rev-parse', 'HEAD']).out || null }
}

export interface Listing { ok: boolean; reason: string; entry: Dispatcher | null; file: string | null }

// `listedHere`, but only after the roster has been refreshed and verified. This is what a run
// asks each pass; a read-only view may ask `listedHere` alone and show what it has.
export function verifiedListing(root: string, options: { repo: string; host?: string; home?: string; git?: (clone: string) => GitRun }): Listing {
  const room = controlRoomClone(root, options.home ?? homedir())
  if (!room) return listedHere(root, options)
  const refresh = refreshRoster(room.clone, (options.git ?? gitIn)(room.clone))
  if (!refresh.ok) return { ok: false, reason: refresh.reason, entry: null, file: dispatchersPath(room.clone) }
  return listedHere(root, options)
}

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
  if (!entry) {
    return { ok: false, entry: null, file, reason: `${machine} is not listed in ${file} — add the row \`| ${machine} | <operator> | ${options.repo} |\` in a control-room PR before this machine dispatches anything` }
  }
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

export interface KeyFacts { isFile: () => boolean; isSymbolicLink: () => boolean; uid: number; mode: number }
export type KeyStat = (path: string) => KeyFacts

// The App key is the factory's one long-lived secret, so the file itself is part of the check: a
// real file this account owns, readable by nobody else. A link is refused outright — what it
// points at can be swapped after the check — and so is a mode any other account could read.
export function assertKeyFile(path: string, { stat = lstatSync as unknown as KeyStat, uid = process.getuid?.() ?? -1 } = {}) {
  let facts: KeyFacts
  try { facts = stat(path) } catch { throw new Error(missingKeyMessage(path)) }
  if (facts.isSymbolicLink()) throw new Error(`${path} is a symbolic link — the App key must be a real file, so what it points at cannot be swapped after this check`)
  if (!facts.isFile()) throw new Error(`${path} is not a regular file — the App key must be a real file`)
  if (uid >= 0 && facts.uid !== uid) throw new Error(`${path} is owned by uid ${facts.uid}, not the account running this (uid ${uid}) — the App key belongs to the dispatcher account`)
  if (facts.mode & 0o077) throw new Error(`${path} is mode ${(facts.mode & 0o777).toString(8)}, so another account on this machine can read the App key — chmod 600 it`)
}

// An installation token for this one repository: a JWT names the App, the installation is read
// from the repository itself, and the token is narrowed to that repository. It lives an hour and
// stays in memory — never written down, never printed, never put on a command line.
export async function mintToken(input: { repo: string; keyPath: string; appId: string; fetch?: Fetch; now?: number; stat?: KeyStat; uid?: number }): Promise<AppToken> {
  const { repo, keyPath, appId, fetch: call = globalThis.fetch as unknown as Fetch, now = Date.now() } = input
  assertRepo(repo)
  // Re-checked on every mint, not once at startup: a key that becomes group-readable or is
  // replaced by a link to someone else's file stops minting from the next token on.
  assertKeyFile(keyPath, { stat: input.stat, uid: input.uid })
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
// `token()` is asked for one on every call, so an expiring token is replaced rather than carried:
// an installation token lives an hour and the dispatcher lives for months.
export function tokenRunner(token: () => string, timeoutMs = 30_000): GhRunner {
  return (args, input): GhResult => {
    const result = spawnSync(process.env.VEGAFACTORY_GH || 'gh', args, {
      encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_TOKEN: token(), GITHUB_TOKEN: token() },
    })
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new GhError(`gh ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`)
    if (result.error) throw new GhError(`gh could not start: ${result.error.message}`)
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

// Re-minted a few minutes before it expires. `gh` is spawned synchronously, so the token has to be
// ready before the call: the refresh runs between passes, from `freshen`, and never mid-request.
export const TOKEN_MARGIN_MS = 5 * 60_000

export interface AppIdentity { runner: GhRunner; freshen: (now?: number) => Promise<void> }

export function appIdentity(input: { repo: string; keyPath: string; appId: string; fetch?: Fetch }): AppIdentity {
  let held: AppToken | null = null
  return {
    runner: tokenRunner(() => {
      if (!held) throw new GhError('the dispatcher has no installation token yet')
      return held.token
    }),
    freshen: async (now = Date.now()) => {
      if (held && held.expiresAt - now > TOKEN_MARGIN_MS) return
      held = await mintToken({ ...input, now })
    },
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
export const childrenPath = (root: string) => join(dispatchDir(root), 'children.json')
const runsPath = (root: string) => join(dispatchDir(root), 'runs.jsonl')
const actedPath = (root: string) => join(dispatchDir(root), 'acted.json')

// The record is a working note on an always-on machine, so it is trimmed to the last RUNS_KEPT
// rather than grown forever; the control room's statistics are where runs are kept for good.
export const RUNS_KEPT = 500

export function recordRun(root: string, record: RunRecord) {
  mkdirSync(dispatchDir(root), { recursive: true })
  appendFileSync(runsPath(root), JSON.stringify(record) + '\n')
  try {
    const lines = readFileSync(runsPath(root), 'utf8').split('\n').filter(Boolean)
    if (lines.length > RUNS_KEPT * 2) replaceFile(runsPath(root), lines.slice(-RUNS_KEPT).join('\n') + '\n')
  } catch { /* the record is a note; failing to trim it is not worth a failed run */ }
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
  try {
    const saved: unknown = JSON.parse(readFileSync(actedPath(root), 'utf8'))
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, Acted> : {}
  } catch { return {} }
}

export function writeActed(root: string, acted: Record<string, Acted>) {
  mkdirSync(dispatchDir(root), { recursive: true })
  replaceFile(actedPath(root), JSON.stringify(acted, null, 2) + '\n')
}

// The process groups this machine's runs are in. It is on disk because `dispatch disable` is a
// different process from the service it takes down: without this the service's agents would keep
// running and keep writing to GitHub after the unit is gone.
export function readChildren(root: string): number[] {
  try {
    const saved: unknown = JSON.parse(readFileSync(childrenPath(root), 'utf8'))
    return Array.isArray(saved) ? saved.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 1) : []
  } catch { return [] }
}

export function noteChild(root: string, pid: number, live: boolean) {
  mkdirSync(dispatchDir(root), { recursive: true })
  withLock(dispatchDir(root), () => {
    const pids = new Set(readChildren(root))
    if (live) pids.add(pid)
    else pids.delete(pid)
    replaceFile(childrenPath(root), JSON.stringify([...pids]) + '\n')
  }, { what: 'the dispatcher\'s children' })
}

// Stops a run and everything it started. The group is signalled, not the one process: an agent
// spawns its own tools, and leaving those behind is how a "stopped" dispatcher keeps working.
export function stopGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try { process.kill(pid, signal); return true } catch { return false }
  }
}

// Two steps finish at once, and an operator may run a pass by hand beside the service: the
// read-modify-write takes the same lock the issue cache uses, so neither loses the other's entry.
export function updateActed(root: string, change: (acted: Record<string, Acted>) => void) {
  mkdirSync(dispatchDir(root), { recursive: true })
  withLock(dispatchDir(root), () => {
    const acted = readActed(root)
    change(acted)
    writeActed(root, acted)
  }, { what: 'the dispatcher\'s record' })
}

// ---------------------------------------------------------------------------------------------
// The transitions

export interface Decision { action: Action; reason: string; trigger: number | null; by: string | null; split: boolean; quote: string | null }

const nothing = (reason: string): Decision => ({ action: 'none', reason, trigger: null, by: null, split: false, quote: null })

// A line whose whole point is "ship it". "do not ship it", "ship it after fixing X" and "I won't
// ship it" are corrections that happen to contain the words, and a gate that read them as consent
// would merge on a sentence that said the opposite. A separator may precede the phrase
// ("looks good — ship it"), and nothing but punctuation may follow it.
const SHIP_LINE = /(?:^|[—–:;-]\s+)(?:ok|okay|yes|lgtm)?[,!.]?\s*ship(?:\s+it|\s+this)?$/iu

export function shipWord(body: string): string | null {
  for (const raw of String(body ?? '').split('\n')) {
    // A quoted reply is someone else's words being repeated, not this person's instruction.
    const line = raw.trim()
    if (!line || line.startsWith('>')) continue
    const bare = line.replace(/^[*\-\s]+/, '').replace(/[^\p{L}\s]+$/u, '').trim()
    if (SHIP_LINE.test(bare)) return line
  }
  return null
}
// "stop", "stop.", "@vegafactory stop — I need to rethink this". Not "stop using the old API",
// which is a correction about the work and not an instruction to put the issue down.
const STOP = /^\s*(?:@?[\w-]+[,:]?\s+)?stop\s*(?:$|[\n—–:,.!?])/i
const WRITE = new Set(['admin', 'maintain', 'write'])

// Two different questions, and the difference is the whole trust model.
//
// *Who may approve* — an ack, a correction, a stop, a "ship it" — is always a person with write
// access. No bot, and no App, stands in for a human's word.
//
// *Who may write the work* is wider: a plan, an evidence comment or the status comment may come
// from a person with write access or from the factory's own App, because a dispatched run's
// artifacts are posted by the machine, not by a person sitting behind it.
const fromPerson = (permission: PermissionLookup) => (entry: CommentEntry) =>
  entry.authorType !== 'Bot' && !!entry.author && WRITE.has(permission(entry.author))
const fromFactory = (permission: PermissionLookup) => (entry: CommentEntry) =>
  entry.author === APP_ACTOR || fromPerson(permission)(entry)

// The operator's own comments: a person with write access, in the order they were written.
function operatorComments(snap: Snapshot, permission: PermissionLookup) {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'human' && fromPerson(permission)(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

// The newest work artifact of a type: written by a person with write access, or by the App on a
// dispatched run's behalf. An outsider's comment is text on a page and never either.
export function latestArtifact(snap: Snapshot, type: string, permission: PermissionLookup): CommentEntry | null {
  return Object.values(snap.state.comments)
    .filter((entry) => entry.type === type && fromFactory(permission)(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1) ?? null
}

// Comments that are bookkeeping, not an answer or a piece of work: they must not move the line an
// operator's reply has to beat, or a session claiming an issue would swallow the reply forever.
const BOOKKEEPING = new Set(['claim', 'release', 'ledger', 'ack'])

// The action this issue is waiting for, and the comment that asks for it. `trigger` is what makes
// a run happen once: a comment already acted on asks for nothing more, and a state label already
// worked is not worked again until the issue moves.
export function decide(snap: Snapshot, permission: PermissionLookup, options: { acted?: Acted | null; now?: number; held?: boolean } = {}): Decision {
  const issue = snap.state.issue!
  const { acted = null, now = Date.now(), held = false } = options
  if (issue.state !== 'open') return nothing('the issue is closed')
  if (issue.labels.includes('epic')) return nothing('an epic is a map; its sub-issues carry the work')
  const { state } = stateOf(issue.labels)
  if (!state) return nothing('no state label')
  const comments = operatorComments(snap, permission)
  const decided = transitionOf(snap, issue, state, comments, permission, { acted, held })
  if (decided.action === 'none') return decided

  // A trigger is spent once a run of the same action has settled on it, whatever it settled as —
  // only a failure and a subscription limit come back, and each has its own wait.
  if (acted && acted.action === decided.action) {
    if (acted.retryAt !== null && now < acted.retryAt) return nothing(`${decided.action} is waiting until ${new Date(acted.retryAt).toISOString()}`)
    if (acted.failures >= MAX_FAILURES && acted.trigger === decided.trigger) return nothing(`${decided.action} failed ${acted.failures} times — this issue needs a person`)
    if (acted.retryAt === null && acted.trigger === decided.trigger) {
      return nothing(`already ran ${decided.action} for this ${decided.trigger === null ? 'state' : 'comment'}`)
    }
  }
  return decided
}

type Comments = ReturnType<typeof operatorComments>
type IssueFacts = IssueEntry

function transitionOf(snap: Snapshot, issue: IssueFacts, state: State, comments: Comments, permission: PermissionLookup, run: { acted: Acted | null; held: boolean }): Decision {
  const labels = issue.labels
  const last = comments.at(-1) ?? null
  if (last && STOP.test(snap.body(last))) return { action: 'stop', reason: `@${last.author} said stop`, trigger: last.id, by: last.author, split: false, quote: null }
  if (state === 'planning') return { action: 'plan', reason: 'the brief is acked and the plan is not written', trigger: null, by: null, split: labels.includes('large'), quote: null }
  if (state === 'queued') {
    // The same fact `issue check --for implement` blocks on: building on an open blocker wastes
    // the run and, worse, lands work on a base that is still moving.
    if (issue.blockedBy.length) return nothing(`blocked by ${issue.blockedBy.map((number) => `#${number}`).join(', ')}`)
    return { action: 'implement', reason: 'the plan is acked and nobody has built it', trigger: null, by: null, split: false, quote: null }
  }
  if (state === 'waiting-on-operator') {
    // The reply the issue was waiting for: an operator comment later than the last thing an agent
    // wrote and later than the brief's own last edit. Claims, releases, acks and the status
    // comment are bookkeeping and move nothing.
    const work = Object.values(snap.state.comments).filter((entry) => entry.type !== 'human' && !BOOKKEEPING.has(entry.type)).map((entry) => entry.createdAt)
    const after = [issue.bodyChangedAt, ...work].sort().at(-1) ?? ''
    const reply = comments.filter((entry) => entry.createdAt > after).at(-1)
    return reply
      ? { action: 'follow-up', reason: `@${reply.author} replied on a waiting-on-operator issue`, trigger: reply.id, by: reply.author, split: false, quote: null }
      : nothing('waiting on the operator')
  }
  if (state === 'in-progress') {
    // A run that claimed moved the issue here. While a claim is alive it is someone's; once the
    // claim is gone the run is over and did not finish, so this machine picks its own work back
    // up rather than leaving the issue where no state label will ever move it again.
    if (run.held) return nothing('a live claim holds it')
    const resume = run.acted && run.acted.outcome !== 'done' ? run.acted.action : 'implement'
    if (resume === 'none' || resume === 'stop') return nothing('in-progress with nothing to resume')
    return { action: resume, reason: 'an interrupted run left it in-progress with no holder', trigger: run.acted?.trigger ?? null, by: null, split: false, quote: null }
  }
  if (state === 'ready-to-ship') {
    const evidence = latestArtifact(snap, 'evidence', permission)
    if (!evidence) return nothing('ready-to-ship with no evidence comment')
    const word = comments.filter((entry) => entry.createdAt > (evidence.changedAt || evidence.updatedAt)).at(-1)
    if (!word) return nothing('waiting for the operator to read the evidence')
    // A candidate only: the word is not consent until it has been recorded as an ack and read
    // back by the same check `issue check --for ship` runs. `confirmShip` does that.
    const quote = shipWord(snap.body(word))
    return quote
      ? { action: 'ship', reason: `@${word.author} said ship it`, trigger: word.id, by: word.author, split: false, quote }
      : { action: 'corrections', reason: `@${word.author} left corrections on a ready-to-ship issue`, trigger: word.id, by: word.author, split: false, quote: null }
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

export interface Candidate { number: number; action: Action; parent: number | null; files: string[]; from: State }

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

// A declared path, as one canonical repository-relative spelling — or nothing. `src/../src/x` and
// `src/x` are the same file, and a set that did not say so would read as disjoint; a glob, an
// absolute path or one that climbs out of the repository is not a file set anyone can check.
export function canonicalPath(path: string): string | null {
  const raw = String(path ?? '').trim()
  if (!raw || /[*?[\]{}]/.test(raw) || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) return null
  const directory = raw.endsWith('/')
  const normalized = posix.normalize(normalizeGroupPath(raw))
  if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.startsWith('/')) return null
  return directory && !normalized.endsWith('/') ? `${normalized}/` : normalized
}

// The file set a sub-issue declared, from its parent epic's plan `**Independent groups:**` block.
// No declaration means no parallel run, and neither does one path this cannot canonicalize: one
// at a time is the safe default, and a set that is only partly checkable is not a set.
export function filesFromParent(parentPlan: string | null, number: number): string[] {
  if (!parentPlan) return []
  const groups = parseIndependentGroups(parentPlan) as Array<{ id: string | null; members: string[]; files: string[] }>
  const declared = groups.find((group) => group.id && group.members.includes(`#${number}`))?.files ?? []
  const canonical = declared.map(canonicalPath)
  return canonical.every((path): path is string => path !== null) ? canonical : []
}

// ---------------------------------------------------------------------------------------------
// Running one step

export interface Step { action: Action; number: number; repo: string; split: boolean; by: string | null }
export interface StepResult { outcome: Outcome; note: string; ms: number }
export type RunStep = (step: Step, context: { root: string; onStart?: (pid: number) => void }) => Promise<StepResult>

// A run that stopped because the subscription said "enough for now". Each tool words it its own
// way, and each of these is a limit, not a failure of the work.
const LIMIT = /\b(usage limit reached|rate limit|quota exceeded|out of (?:usage|credits?)|limit resets?|try again (?:after|at))\b/i
export const hitLimit = (text: string) => LIMIT.test(text)

// When the subscription said it would be back. Anything unreadable waits an hour, and no reading
// parks an issue for more than a day: the text is a log line, not a promise.
export const MAX_WAIT_MS = 24 * 3_600_000
export function resetAt(text: string, now = Date.now()): number {
  const iso = /\b(\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z)\b/.exec(text)?.[1]
  const parsed = iso ? Date.parse(iso) : NaN
  if (Number.isFinite(parsed) && parsed > now) return Math.min(parsed, now + MAX_WAIT_MS)
  const hours = Number(/\bin (\d+)\s*hours?\b/i.exec(text)?.[1] ?? NaN)
  if (Number.isFinite(hours) && hours > 0) return Math.min(now + hours * 3_600_000, now + MAX_WAIT_MS)
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

// The limit is enforced inside the child's own process group, so it holds even if the dispatcher
// dies: an agent orphaned by a crash or a `launchctl bootout` still stops on its own rather than
// writing to GitHub unsupervised for hours.
const WATCHDOG = '"$@" & job=$!; (sleep "$VF_LIMIT"; kill -KILL 0) & dog=$!; wait "$job"; code=$?; kill "$dog" 2>/dev/null; exit "$code"'

// One child, in its own process group so a stuck step is killed with everything it started. Only
// the tail of its output is kept: the record is bounded and the output never reaches the issue.
function execTool(tool: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onStart?: (pid: number) => void }): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', WATCHDOG, 'vegafactory-dispatch', tool, ...args], {
      // Half a minute behind this process's own timer, so the backstop only ever fires for an
      // orphan and a killed step is reported as killed rather than as an exit code.
      cwd: options.cwd, env: { ...options.env, VF_LIMIT: String(Math.ceil(options.timeoutMs / 1000) + 30) },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    if (child.pid) options.onStart?.(child.pid)
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
    // Nobody is at the keyboard, so a round of questions goes to the issue and waits there for the
    // operator — dev-setup's references/ask-route.md, where this variable is the first step.
    const child = await exec(tool, args, { cwd, env: { ...childEnvironment(env), VSK_ASK_ROUTE: 'issue' }, timeoutMs, onStart: context.onStart })
    const ms = Date.now() - started
    const text = `${child.stderr}\n${child.stdout}`
    if (child.timedOut) return { outcome: 'killed', note: `${tool} ran past the ${timeoutMs / 60_000}-minute step limit and was stopped`, ms }
    if (child.error) return { outcome: 'failed', note: `could not start ${tool}: ${child.error}`, ms }
    // A limit is why a run stopped early, never a phrase in the work of a run that finished: the
    // diff of a retry helper says "rate limit" all day.
    if (child.code !== 0 && hitLimit(text)) return { outcome: 'limit', note: tail(text), ms }
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
  // Saves, pushes, releases and hands an issue back: the reason goes on the issue, and the state
  // label goes back to where the run picked it up.
  standDown: (number: number, reason: string, restoreTo?: State) => string
  // How a started run is ended: its whole process group, so the tools it spawned go with it.
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
}

// The steps this machine has started. It lives across polls, so the next pass two minutes later
// sees them, keeps their slots and can still act on the rest of the board. A finished run stays in
// the map until the next pass sweeps it, so nothing can disappear between starting and being read.
export interface Inflight { candidate: Candidate; started: number; settled: boolean; done: Promise<RunRecord>; stop: () => void }
export const drain = (inflight: Map<number, Inflight>) => Promise.all([...inflight.values()].map((run) => run.done))

// One pass over the board: read what changed, decide, and start what is safe to start now. The
// steps run to their own end; this returns as soon as they are under way.
export async function poll(deps: PollDeps, inflight: Map<number, Inflight> = new Map()): Promise<Candidate[]> {
  const { root, repo, runner, now } = deps
  // Last pass's finished runs, whose outcomes are now in `acted`: their slots and issues are free.
  for (const [number, run] of inflight) if (run.settled) inflight.delete(number)
  const permission = permissionLookup(repo, runner, { root })
  const trusted = trustedHolders({ repo, runner, root })
  const acted = readActed(root)
  const wanted: Array<{ candidate: Candidate; decision: Decision; key: string }> = []
  const plans = new Map<number, string | null>()
  // One issue nobody can read must not cost the board its pass, so everything per-issue is guarded.
  for (const issue of board(repo, runner)) {
    try {
      syncIssue({ root, repo, number: issue.number, runner })
      const snap = snapshot(cacheDir(root, repo, issue.number))
      const key = `${repo}#${issue.number}`
      const held = !!holderOf(snap.state, snap.body, now(), trusted).holder
      const decision = decide(snap, permission, { acted: acted[key] ?? null, now: now(), held })
      if (decision.action === 'none') continue
      // A fresh claim means someone — a person or another machine — is already on it.
      if (decision.action !== 'stop' && held) {
        deps.out(`#${issue.number}: skipped, a fresh claim holds it`)
        continue
      }
      // The operator's word becomes a recorded ack, read back by the ship gate's own check. A word
      // that does not survive that is spent here rather than re-relayed on every pass.
      if (decision.action === 'ship') {
        const confirmed = confirmShip({ root, repo, number: issue.number, runner }, permission, { id: decision.trigger!, by: decision.by!, quote: decision.quote! })
        if (!confirmed.ok) {
          deps.out(`#${issue.number}: not shipping — ${confirmed.reason}`)
          recordRun(root, { at: new Date(now()).toISOString(), issue: issue.number, action: 'ship', outcome: 'blocked', ms: 0, machine: deps.machine, note: tail(confirmed.reason) })
          updateActed(root, (saved) => { saved[key] = { at: now(), action: 'ship', outcome: 'blocked', trigger: decision.trigger, failures: 0, retryAt: null } })
          continue
        }
      }
      const parent = snap.state.issue!.parent
      if (parent !== null && !plans.has(parent)) plans.set(parent, parentPlan(root, repo, parent, runner, permission))
      const files = parent === null ? [] : filesFromParent(plans.get(parent) ?? null, issue.number)
      wanted.push({ key, decision, candidate: { number: issue.number, action: decision.action, parent, files, from: stateOf(snap.state.issue!.labels).state! } })
    } catch (error) {
      deps.out(`#${issue.number}: could not be read (${(error as Error).message})`)
    }
  }

  const started: Candidate[] = []
  for (const candidate of schedule(wanted.map((item) => item.candidate), [...inflight.values()].map((run) => run.candidate))) {
    const item = wanted.find((entry) => entry.candidate.number === candidate.number)!
    const at = now()
    // Taken before the slot, so a second machine on the same board sees the work is taken. Losing
    // the race is not a failure: the issue is simply someone else's this pass.
    const taken = reserve({ root, repo, number: candidate.number, runner }, deps.machine, candidate.action, at)
    if (!taken.ok) {
      deps.out(`#${candidate.number}: not started — ${taken.reason}`)
      continue
    }
    const run: Inflight = { candidate, started: at, settled: false, stop: () => {}, done: Promise.resolve() as unknown as Promise<RunRecord> }
    run.done = runOne(deps, candidate, item, at, taken.owner, run).then((record) => { run.settled = true; return record })
    inflight.set(candidate.number, run)
    started.push(candidate)
  }
  return started
}

// The claim a dispatched run takes before it starts, so another machine polling the same board
// sees the work is taken rather than starting it again. It is an App-authored `dispatch` claim,
// kept alive while the step runs and released on every way out.
//
// A step that runs an agent which claims for itself — dev-implement and its corrections path —
// hands the claim over instead: the rest of the workflow reads the session's own claim from inside
// its worktree, whose name this machine cannot know in advance. That hand-over is a seconds-wide
// window in which a second machine could start the same issue; closing it needs the fleet-wide
// lease that #3 tracks, not a longer claim here.
export const HANDS_OVER: Action[] = ['implement', 'corrections']

export interface Reservation { ok: boolean; owner: string; reason: string }

export function reserve(ctx: { root: string; repo: string; number: number; runner: GhRunner }, machine: string, action: Action, now = Date.now()): Reservation {
  const owner = `${machine}:dispatch-${ctx.number}`
  try {
    const outcome = claim(ctx, { owner, kind: 'dispatch', harness: 'dispatch', model: action }, now)
    return { ok: outcome.ok, owner, reason: outcome.message }
  } catch (error) {
    return { ok: false, owner, reason: `the claim could not be taken: ${(error as Error).message}` }
  }
}

// One step and everything that follows it. Nothing here may reject: the loop does not await these
// promises, so a rejection nobody handles would take the whole dispatcher down.
async function runOne(deps: PollDeps, candidate: Candidate, item: { key: string; decision: Decision }, at: number, held: string | null, run: Inflight): Promise<RunRecord> {
  const claimCtx = { root: deps.root, repo: deps.repo, number: candidate.number, runner: deps.runner }
  // While this machine holds the claim it says so, on the same schedule a session's hooks use.
  const beat = held ? setInterval(() => { try { heartbeat(claimCtx, held) } catch { /* a missed beat is not a failure */ } }, HEARTBEAT_EVERY_MS) : null
  beat?.unref?.()
  let result: StepResult
  try {
    if (candidate.action === 'stop') {
      // A stop needs no agent: it is this machine giving the issue back.
      result = { outcome: 'stopped', note: deps.standDown(candidate.number, item.decision.reason, candidate.from), ms: 0 }
    } else {
      // The agent claims for itself from inside its own worktree, so this machine's reservation
      // steps aside first — holding both would stop the run it just started.
      if (held && HANDS_OVER.includes(candidate.action)) {
        if (beat) clearInterval(beat)
        try { release(claimCtx, held, APP_ACTOR, 'handing the issue to the run this machine just started') } catch { /* the run still starts */ }
      }
      result = await deps.runStep({ action: candidate.action, number: candidate.number, repo: deps.repo, split: item.decision.split, by: item.decision.by }, {
        root: deps.root,
        onStart: (pid) => {
          run.stop = () => { (deps.stop ?? stopGroup)(pid, 'SIGTERM') }
          try { noteChild(deps.root, pid, true) } catch { /* the run still stops from here */ }
        },
      })
    }
  } catch (error) {
    result = { outcome: 'failed', note: (error as Error).message, ms: deps.now() - at }
  } finally {
    if (beat) clearInterval(beat)
    run.stop = () => {}
  }
  // Whatever happened, this machine's own reservation goes back. A step that stood the issue down
  // has already released the session's claim; this releases the one taken before the launch.
  if (held && !HANDS_OVER.includes(candidate.action)) {
    try { release(claimCtx, held, APP_ACTOR, `the ${candidate.action} run finished (${result.outcome})`) } catch { /* the record still lands */ }
  }
  try {
    return settle(deps, candidate, item, at, result)
  } catch (error) {
    // The record could not be written down. Say so rather than dying, and let the next pass decide
    // again: without a saved outcome this trigger simply looks unacted-on.
    deps.out(`#${candidate.number} ${candidate.action} → ${result.outcome}, but the run could not be recorded: ${(error as Error).message}`)
    return { at: new Date(at).toISOString(), issue: candidate.number, action: candidate.action, outcome: result.outcome, ms: result.ms, machine: deps.machine, note: tail(result.note) }
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
  const ended = deps.now()
  let retryAt: number | null = null
  updateActed(deps.root, (acted) => {
    const previous = acted[item.key]
    const failed = result.outcome === 'failed' || result.outcome === 'killed'
    const failures = failed ? (previous && previous.action === candidate.action ? previous.failures : 0) + 1 : 0
    // The wait runs from the end of the run, not its start: a step that failed after twenty
    // minutes would otherwise be due again the moment it stopped.
    retryAt = failed ? ended + RETRY_MS * 2 ** (failures - 1) : result.outcome === 'limit' ? resetAt(result.note, ended) : null
    acted[item.key] = { at, action: candidate.action, outcome: result.outcome, trigger: item.decision.trigger, failures, retryAt }
  })
  // Every run that did not finish hands the issue back the same way: the work is committed and
  // pushed, the claim released, the reason posted, and the state label put back where the run
  // found it — a failure that left the issue `in-progress` with nobody on it is a dead end.
  if (result.outcome !== 'done' && result.outcome !== 'stopped') {
    const when = retryAt ? `, and tries again after ${new Date(retryAt).toISOString()}` : ' and will not try again without a person'
    const why = result.outcome === 'limit' ? 'the subscription limit was reached' : `the ${candidate.action} run ${result.outcome === 'killed' ? 'ran past its time limit' : 'failed'}`
    deps.standDown(candidate.number, `${why}; this machine has saved and released the issue${when}`, candidate.from)
  }
  deps.out(`#${record.issue} ${record.action} → ${record.outcome}${record.note ? ` (${record.note})` : ''}`)
  return record
}

// The operator's word, recorded and read back the way the ship gate reads it. The dispatcher
// relays the ack — an App may do that only by citing the person's own comment — and then asks
// `findValidAck` the same question `vegafactory issue check --for ship` asks. A relayed ack that
// does not validate ships nothing: the words on the page were never the gate, the ack is.
export interface ShipConfirmation { ok: boolean; reason: string }

export function confirmShip(ctx: { root: string; repo: string; number: number; runner: GhRunner },
  permission: PermissionLookup, word: { id: number; by: string; quote: string }): ShipConfirmation {
  const read = () => {
    syncIssue({ root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner })
    return snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
  }
  const verdict = (snap: Snapshot) => {
    const evidence = latestArtifact(snap, 'evidence', permission)
    if (!evidence) return { ok: false, reason: 'the evidence comment went away' }
    const ack = findValidAck(snap, 'ship', permission, evidenceChangedAt(evidence))
    return { ok: ack.ok, reason: ack.reason }
  }
  return locked(ctx, () => {
    const before = verdict(read())
    if (before.ok) return before
    const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
    const hashes = currentHashes(snap)
    postComment(ctx, ackBody({ stage: 'ship', by: word.by, brief: hashes.brief, plan: hashes.plan, source: `comment:${word.id}`, quote: word.quote }))
    return verdict(read())
  })
}

// The plan that may authorise two agents to run at once. Three things have to hold, and each one
// on its own is the difference between a permission and a sentence someone wrote: the operator
// acked *this* plan (the ack carries its hash), the plan passes the full lint that owns this
// grammar, and it was posted by someone with write access or by the factory's own App. A forged,
// stale, unacked or malformed plan authorises nothing, so its siblings run one at a time.
export function acknowledgedPlan(snap: Snapshot, permission: PermissionLookup): { text: string | null; reason: string } {
  const ack = findValidAck(snap, 'plan', permission)
  if (!ack.ok || !ack.ack) return { text: null, reason: `the plan is not acked (${ack.reason})` }
  const acked = markerKeys(snap.body(ack.ack)).plan
  if (!acked) return { text: null, reason: 'the plan ack names no plan hash' }
  const plan = Object.values(snap.state.comments)
    .filter((entry) => entry.type === 'plan' && fromFactory(permission)(entry) && artifactHash(snap.body(entry)) === acked)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1)
  if (!plan) return { text: null, reason: 'no plan comment matches the acked hash' }
  const text = snap.body(plan)
  const lint = lintPlan(text) as { blocks: string[] }
  if (lint.blocks.length) return { text: null, reason: `the acked plan does not pass plan-lint: ${lint.blocks[0]}` }
  return { text, reason: 'the acked plan' }
}

// The parent epic's acknowledged plan, where sibling file sets are declared.
function parentPlan(root: string, repo: string, parent: number, runner: GhRunner, permission: PermissionLookup): string | null {
  try {
    syncIssue({ root, repo, number: parent, runner })
    return acknowledgedPlan(snapshot(cacheDir(root, repo, parent)), permission).text
  } catch { return null }
}

// Giving an issue up: commit and push whatever the worktree holds, then release the claim the run
// took, with a note. Nothing is forced, and a rejected push leaves the commit local for a person.
// Only a claim held by this machine is released: another machine's claim is not ours to drop.
export interface StandDownContext {
  root: string
  repo: string
  number: number
  runner: GhRunner
  machine: string
  now?: number
  // Where the state label goes back to, when a run left the issue in-progress.
  restoreTo?: State
}

// The branch a stand-down may touch, or why it may not. The directory alone proves nothing: a
// parked worktree left on the default branch, or one for another issue, must never be committed
// to or pushed just because it happens to sit at `.vegastack/.worktrees/<n>-…`.
export function pushableBranch(dir: string, number: number, git: Git): { branch: string | null; refusal: string | null } {
  const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (head.status !== 0 || !head.out) return { branch: null, refusal: 'the worktree is on a detached head, so nothing was committed or pushed' }
  const branch = head.out
  // The default branch first: it is the answer the operator most needs to see, and `main` fails
  // the issue-name check too, so checking it second would hide it behind a vaguer message.
  const fallback = defaultBranch(dir)
  if (fallback && branch === fallback) return { branch: null, refusal: `the worktree is on the default branch ${branch}, so nothing was committed or pushed` }
  if (issueFromBranch(branch) !== number) return { branch: null, refusal: `the worktree is on ${branch}, which does not name #${number}, so nothing was committed or pushed` }
  return { branch, refusal: null }
}

type Git = (args: string[]) => { status: number | null; out: string }

// Giving an issue up: release the claim this run took, save and push its branch, say why on the
// issue, and put the state label back. The claim is checked *first* — a worktree this machine no
// longer owns is not ours to commit in — and the branch is checked before any write.
export function standDown(ctx: StandDownContext, reason: string): string {
  const claimCtx = { root: ctx.root, repo: ctx.repo, number: ctx.number, runner: ctx.runner }
  const notes: string[] = []
  // Who holds the issue, as three answers and not two: ours to finish, somebody else's to leave
  // alone, or unknown. Only the first two are safe, and they are safe for different reasons.
  let whose: 'ours' | 'free' | 'theirs' | 'unreadable' = 'unreadable'
  let owner: string | null = null
  try {
    syncIssue({ ...claimCtx })
    const snap = snapshot(cacheDir(ctx.root, ctx.repo, ctx.number))
    const held = holderOf(snap.state, snap.body, ctx.now ?? Date.now(), trustedHolders(claimCtx)).holder
    if (!held) { whose = 'free'; notes.push('no live claim to release') }
    else if (!held.owner.startsWith(`${ctx.machine}:`)) { whose = 'theirs'; notes.push(`the claim is held by ${held.owner}, so nothing here was touched`) }
    else { whose = 'ours'; owner = held.owner }
  } catch (error) {
    notes.push(`the claim could not be read (${(error as Error).message}), so nothing here was touched`)
  }

  // Only a claim this machine holds authorises writing to its worktree, and a claim that could not
  // be read is not one. With no live claim at all the work is still this machine's to save: it is
  // the run we just started that left it there.
  const dir = whose === 'ours' || whose === 'free' ? workingDir(ctx.root, ctx.number) : null
  if (dir) {
    const git: Git = (args) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 })
      return { status: result.status, out: (result.stdout ?? '').trim() }
    }
    const { branch, refusal } = pushableBranch(dir, ctx.number, git)
    if (refusal) notes.push(refusal)
    else {
      if (git(['status', '--porcelain']).out) {
        git(['add', '--all'])
        notes.push(git(['commit', '--quiet', '-m', `wip: #${ctx.number} saved before standing down`]).status === 0 ? 'committed the open work' : 'the open work could not be committed')
      }
      notes.push(git(['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`]).status === 0 ? `pushed ${branch}` : `the push of ${branch} was rejected, so the commit stays local`)
    }
  }

  if (whose === 'ours' && owner) {
    try {
      release(claimCtx, owner, APP_ACTOR, reason)
      notes.push(`released ${owner}`)
    } catch (error) { notes.push(`the claim could not be released: ${(error as Error).message}`) }
  }

  const note = `${reason} — ${notes.join(', ')}`
  // The issue says what happened and goes back to a state a later pass can pick up. Both are
  // best-effort: a stand-down that cannot reach GitHub still reports what it did locally.
  try {
    postComment(claimCtx, `<!-- vsk:v1 type=handback -->\n**${ctx.machine}** stood down from #${ctx.number}: ${note}\n`)
  } catch (error) { notes.push(`the hand-back comment failed: ${(error as Error).message}`) }
  if (ctx.restoreTo) {
    try {
      syncIssue({ ...claimCtx })
      const labels = readState(cacheDir(ctx.root, ctx.repo, ctx.number))!.issue!.labels
      if (stateOf(labels).state === 'in-progress' && ctx.restoreTo !== 'in-progress') {
        setLabels(claimCtx, nextLabels(labels, { state: ctx.restoreTo }))
        notes.push(`put it back to ${ctx.restoreTo}`)
      }
    } catch (error) { notes.push(`the state label could not be put back: ${(error as Error).message}`) }
  }
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

At most three runs at once and one merge at a time, per machine — two machines on one board each
get their own three. A run takes the issue's claim before it starts, so the other machine's poll
sees the work is taken.

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
  git?: (clone: string) => GitRun
  stop?: (pid: number, signal: NodeJS.Signals) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  cli?: string[]
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

const appIdOf = (env: NodeJS.ProcessEnv) => env.VEGAFACTORY_APP_ID?.trim() || APP_ID

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
  // A verb that will act asks for a roster it has just proved; a read-only view shows what the
  // machine already has, so `status` still answers while the network is down.
  const listing = ['enable', 'run'].includes(args.verb)
    ? verifiedListing(root, { repo, host, home, git: deps.git })
    : listedHere(root, { repo, host, home })
  const keyPath = appKeyPath(env, home)
  const print = (value: unknown, text: string) => out(args.json ? JSON.stringify(value, null, 2) : text)

  // The first gate, before the roster and before anything is spawned or minted: a verb that can
  // start or probe an agent refuses outright while a variable that would bill it is set. The check
  // costs nothing, and running it later would already have spent paid credit on the probes.
  const STARTS_AGENTS = ['enable', 'run']
  if (STARTS_AGENTS.includes(args.verb)) {
    const billing = billingVariables(env)
    if (billing.length) {
      const [is, them] = billing.length === 1 ? ['is', 'it'] : ['are', 'them']
      print({ ok: false, billing }, `refused: ${billing.join(', ')} ${is} set — VegaFactory runs Claude Code and Codex on their subscriptions only; unset ${them} and retry`)
      return 2
    }
  }

  // The second gate: an unlisted machine does nothing but say so. `disable` is the exception, so a
  // machine taken off the roster can still take its own unit down.
  if (!listing.ok && args.verb !== 'disable') {
    print({ ok: false, machine, reason: listing.reason }, `refused: ${listing.reason}`)
    return 2
  }

  switch (args.verb) {
    case 'enable': {
      let keyOk = false
      let keyDetail = ''
      try {
        await mintToken({ repo, keyPath, appId: appIdOf(env), fetch: deps.fetch })
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
      // Taking the unit away does not reach the agents it started: they were detached on purpose,
      // so the service could be restarted without killing a build. Disabling is not a restart.
      const children = readChildren(root)
      const stopped = children.filter((pid) => (deps.stop ?? stopGroup)(pid, 'SIGTERM'))
      for (const pid of children) { try { noteChild(root, pid, false) } catch { /* the note is a note */ } }
      rmSync(path, { force: true })
      const ended = stopped.length ? ` and stopped ${stopped.length} run${stopped.length === 1 ? '' : 's'} it had started` : ''
      print({ ok: problems.length === 0, unit: path, problems, stopped },
        problems.length ? `removed ${path}${ended}, with: ${problems.join('; ')}` : `disabled — ${path} is unloaded and deleted${ended}`)
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
      // An issue this machine has given up on is the one thing `status` must not leave out: it is
      // off the board as far as the dispatcher is concerned until a person looks at it.
      const parked = Object.entries(readActed(root))
        .filter(([key, entry]) => entry.failures >= MAX_FAILURES && key.startsWith(`${repo}#`))
        .map(([key, entry]) => ({ issue: Number(key.slice(key.indexOf('#') + 1)), action: entry.action, failures: entry.failures }))
      print({ repo, machine, listed: listing.ok, board: rows, runs, parked }, [
        `${repo} · ${machine} · ${listing.ok ? 'listed to dispatch' : listing.reason}`,
        ...[...byState].map(([state, numbers]) => `${state.padEnd(20)} ${numbers.map((number) => `#${number}`).join(' ')}`),
        ...(parked.length ? ['', `parked for a person: ${parked.map((row) => `#${row.issue} (${row.action} failed ${row.failures}×)`).join(', ')}`] : []),
        '',
        runs.length ? 'recent runs on this machine:' : 'no dispatcher runs on this machine yet',
        ...runs.map((run) => `${run.at}  #${run.issue} ${run.action.padEnd(12)} ${run.outcome.padEnd(8)} ${Math.round(run.ms / 1000)}s  ${run.note}`),
      ].join('\n'))
      return 0
    }
    case 'run': {
      let devMd = ''
      try { devMd = readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8') } catch { /* no profile, so the tools' own defaults */ }
      const identity = deps.runner ? null : appIdentity({ repo, keyPath, appId: appIdOf(env), fetch: deps.fetch })
      const runner = deps.runner ?? identity!.runner
      const pollDeps: PollDeps = {
        root, repo, runner, machine, out: args.json ? () => {} : out, now: deps.now ?? Date.now,
        runStep: deps.runStep ?? defaultRunStep(devMd, env), stop: deps.stop,
        standDown: (number, reason) => standDown({ root, repo, number, runner, machine }, reason),
      }
      // Started steps outlive the pass that began them, so the next pass keeps their slots and
      // still acts on the rest of the board — a twenty-minute build does not stop the poll.
      const inflight = new Map<number, Inflight>()
      // Stopping means stopping: the agents this machine started are ended, their work saved and
      // their claims released. A dispatcher that walked away leaving three agents writing to
      // GitHub would be worse than one that never started.
      const shutDown = async (why: string) => {
        for (const [number, run] of inflight) {
          if (run.settled) continue
          run.stop()
          out(`#${number} ${run.candidate.action} stopped: ${why}`)
          try { out(pollDeps.standDown(number, `${why}, so this machine stopped the run`, run.candidate.from)) } catch (error) { out(`#${number} could not be handed back: ${(error as Error).message}`) }
        }
        await drain(inflight)
      }
      let signalled: string | null = null
      const onSignal = (signal: string) => { signalled = signal }
      process.once('SIGINT', () => onSignal('SIGINT'))
      process.once('SIGTERM', () => onSignal('SIGTERM'))
      for (;;) {
        if (signalled) {
          await shutDown(`this machine was asked to stop (${signalled})`)
          return 0
        }
        try {
          // The roster is the enrolment, so it is refreshed and re-read every pass: a row removed
          // in a control-room PR stands this machine down at the next poll, with nothing to log
          // into, and a roster this machine cannot verify stops it just as firmly.
          const still = verifiedListing(root, { repo, host, home, git: deps.git })
          if (!still.ok) {
            out(`stopping: ${still.reason}`)
            await shutDown('this machine is no longer listed')
            return 2
          }
          await identity?.freshen()
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

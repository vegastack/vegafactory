import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimBody, claimLine, holderOf, nodeId, trustedFactory } from '../src/claim.ts'
import {
  alreadyLingering, unwritableForUnit,
  SERVICE_NAME,
  APP_ID, DEFAULT_CAPS, MAX_FAILURES, MAX_RUNS, MAX_TIMER_MS, POLL_MS, RETRY_MS, STEP_TIMEOUT_MS, TOKEN_MARGIN_MS, parseCaps, rosterName, sayDuration, agentArgs, appIdentity, appJwt, appKeyPath, assertKeyFile, board, decide, defaultRunStep, workerDir,
  acknowledgedPlan, canonicalPath, childRunEnvironment, confirmShip, disjointSiblings, pushableBranch, shipWord,
  drain, filesFromParent, harnessAnswers, hitLimit, hooksWired, listedHere, mintToken, overlaps, parseWorkerArgs,
  parseNodes, poll, readActed, readRuns, readiness, recordRun, resetAt, runKey, RUNS_KEPT, runWorker, schedule, serviceCommands, stagePolicy,
  standDown, standDownStrict, stepPrompt, tail, unitPath, unitText, unsafeForParallel,
  migrateLegacyWorkerState, noteChild, readChildren, refreshRoster, releaseRunLock, reserve, runLockPath, stopChild, takeRunLock, verifiedListing,
  recordRoomSha, updateModeFor,
  normalizeWorkerRepos, readWorkerState, reconcileBoards, workerProblemReporter,
  type Candidate, type Fetch, type GitRun, type Inflight, type PollDeps, type Probe, type RunStep, type StepResult,
} from '../src/worker.ts'
import type { GhRunner } from '../src/gh.ts'
import { ackBody, artifactHash, permissionLookup, snapshot } from '../src/issue.ts'
import { cacheDir, syncIssue } from '../src/issue-cache.ts'
import { FakeGitHub } from './fake-github.ts'
import { refuseAmbientHome } from './no-ambient-home.ts'

refuseAmbientHome()

const HOST = 'mac-mini'
let gh: FakeGitHub
let root: string
let home: string

// A repository with a control room, and a home whose clone of it lists this machine.
const NODE = nodeId(undefined, HOST)
const ROSTER = `| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r | |\n`

function project(workers: string | null = ROSTER): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'worker-home-')))
  spawnSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), [
    'repo: o/r',
    'control-room: o/control-room#dev@0000000',
    'vegafactory-update: off',
    'harness-policy: intake claude default high · plan claude default high · implement claude default high · review codex default xhigh',
    '',
  ].join('\n'))
  const clone = join(home, '.vegafactory', 'control-room', 'o')
  mkdirSync(clone, { recursive: true })
  if (workers !== null) writeFileSync(join(clone, 'nodes.md'), workers)
}

// The roster refresh is real git. Most tests are not about it, so they hand the CLI a git that
// always succeeds; `controlRoomClone()` below builds the real thing for the tests that are.
// A git that agrees to everything, and answers `rev-parse HEAD` with a commit — a refresh that
// cannot say where the clone landed is a refusal, so a stub with no HEAD is not "any git".
const anyGit = () => (((args: string[]) =>
  args[0] === 'rev-parse' && args[1] === 'HEAD' ? { status: 0, out: 'c'.repeat(40) } : { status: 0, out: '' })) as GitRun

// A bare origin and a clone of it, in place of the plain directory `project()` makes: this is what
// a real machine has, and the only way to change the roster is to change it upstream.
function controlRoomClone(rows: string): (next: string) => void {
  const origin = join(home, 'control-room.git')
  const seed = join(home, 'control-room-seed')
  const clone = join(home, '.vegafactory', 'control-room', 'o')
  const run = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', origin])
  mkdirSync(seed, { recursive: true })
  run(seed, ['init', '-q', '-b', 'main'])
  run(seed, ['config', 'user.email', 't@example.com'])
  run(seed, ['config', 'user.name', 'T'])
  writeFileSync(join(seed, 'nodes.md'), rows)
  run(seed, ['add', '-A'])
  run(seed, ['commit', '-q', '-m', 'roster'])
  run(seed, ['remote', 'add', 'origin', origin])
  run(seed, ['push', '-q', '-u', 'origin', 'main'])
  rmSync(clone, { recursive: true, force: true })
  spawnSync('git', ['clone', '-q', origin, clone])
  return (next: string) => {
    writeFileSync(join(seed, 'nodes.md'), next)
    run(seed, ['commit', '-qam', 'roster'])
    run(seed, ['push', '-q', 'origin', 'main'])
  }
}

const snapOf = (number: number) => {
  syncIssue({ root, repo: 'o/r', number, runner: gh.runner })
  return snapshot(cacheDir(root, 'o/r', number))
}
const verdict = (number: number, options = {}) => decide(snapOf(number), permissionLookup('o/r', gh.runner), { now: gh.clock, ...options })

beforeEach(() => {
  gh = new FakeGitHub()
  gh.permissions.set('mk', 'admin')
  gh.permissions.set('outsider', 'read')
  project()
})

describe('the roster', () => {
  test('a table row, a bullet row, the header and the separator', () => {
    const rows = parseNodes([
      '# Workers', '',
      '| machine | operator | repos | note |',
      '|---|---|:---:|---|',
      '| Mac-Mini.local | @mk | o/r, o/other | the always-on box |',
      '| builder | - | * | everything |',
      '',
      '- `spare-box` — o/r',
    ].join('\n'))
    expect(rows).toEqual([
      { machine: 'mac-mini', operator: 'mk', repos: ['o/r', 'o/other'], caps: DEFAULT_CAPS, worker: false, problem: null },
      { machine: 'builder', operator: null, repos: ['*'], caps: DEFAULT_CAPS, worker: false, problem: null },
      { machine: 'spare-box', operator: null, repos: ['o/r'], caps: DEFAULT_CAPS, worker: false, problem: null },
    ])
  })

  test('a row that lost its repos column is no row at all', () => {
    project(`| machine | operator | repos |\n|---|---|---|\n| ${HOST} | mk |\n`)
    expect(parseNodes(`| ${HOST} | mk |`)).toEqual([])
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('is not listed')
  })

  test('a row that does not reach its declared caps column is refused by name', () => {
    const roster = `| node | owner | worker | repos | notes | caps |\n|---|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`
    project(roster)
    const row = parseNodes(roster)[0]!
    expect(row.machine).toBe(NODE)
    expect(row.caps).toBeNull()
    expect(row.problem).toContain('does not reach its declared caps column')
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain(`${NODE}'s row`)
    expect(listing.reason).toContain('does not reach its declared caps column')
    for (const cell of ['', '-']) {
      const complete = parseNodes(`| node | owner | worker | repos | notes | caps |\n|---|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r | | ${cell} |\n`)[0]!
      expect(complete.caps).toEqual(DEFAULT_CAPS)
      expect(complete.problem).toBeNull()
    }
  })

  test('a listed machine passes; an unlisted one refuses and says how to be listed', () => {
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).ok).toBe(true)
    const other = listedHere(root, { repo: 'o/r', host: 'laptop', home })
    expect(other.ok).toBe(false)
    expect(other.reason).toContain('laptop is not listed')
    expect(other.reason).toContain('control-room PR')
  })

  test('a machine listed for another repository refuses on this one', () => {
    const listing = listedHere(root, { repo: 'o/elsewhere', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('not o/elsewhere')
  })

  test('a missing roster refuses rather than defaulting to allowed', () => {
    project(null)
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('vegafactory sync')
  })

  // The operator reads this sentence and nothing else, so it has to parse as English: the rename
  // left it reading "listed as a worker it", which says nothing about what to add where.
  test('a repository with no control room says so in a sentence that reads', () => {
    writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\n')
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toBe("this repository names no control room (dev.md's control-room: knob), so no machine is listed as a worker for it")
  })

  // A row whose caps cannot be read used to be dropped, and the machine then refused as "not
  // listed" — which sends the operator looking for a missing row instead of at the typo.
  test('a caps cell nobody can read refuses this machine by name, and says the shape', () => {
    project(`| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r | runs ten |\n`)
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain(`${NODE}'s row`)
    expect(listing.reason).toContain('runs 10 · step 72h')
    expect(listing.reason).not.toContain('is not listed')
    // The row is still there to point at — it was read, and refused, not skipped.
    expect(listing.entry?.machine).toBe(NODE)
  })

  // A table is read by its header or not at all. Nothing says which cell is the machine, which is
  // the caps and which is the gate, so counting cells would be a guess — and the one thing that
  // fixes it is the header, which is what the refusal asks for.
  test('a table with no header holds no rows, whatever its width', () => {
    for (const width of [`| ${NODE} | mk | o/r |`, `| ${NODE} | mk | o/r | runs 10 · step 72h |`]) {
      expect(parseNodes(`${width}\n`)).toEqual([])
    }
    project(`| ${NODE} | mk | o/r |\n`)
    const reason = listedHere(root, { repo: 'o/r', host: HOST, home }).reason
    expect(reason).toContain('no `worker` column')
    expect(reason).toContain('| node | owner | worker | repos | caps |')
  })
})

describe('multi-repository board reconciliation', () => {
  const workerState = (repos: string[]) => ({
    schema: 1 as const,
    revision: 0,
    boards: Object.fromEntries(repos.map((repo) => [repo, { repo, state: 'active' as const }])),
  })

  const context = (repo: string) => ({
    key: repo,
    repo,
    root: `/worker/${repo.replace('/', '__')}/repo`,
    identity: {
      token: () => `token-${repo}`,
      freshen: async () => {},
      runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner,
    },
    runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner,
    devMd: `repo: ${repo}\n`,
  })

  test('normalization accepts only explicit repositories and stable-deduplicates canonical identity', () => {
    expect(normalizeWorkerRepos(['Org/Repo', 'org/repo', '*', 'all', 'not-a-repo', 'O/Other'])).toEqual({
      repos: ['org/repo', 'o/other'],
      refused: ['*', 'all', 'not-a-repo'],
    })
  })

  test('refused wildcard cells provision nothing beyond a healthy explicit sibling', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const provisioned: string[] = []
    const result = await reconcileBoards({
      home: stateHome,
      listed: ['o/good', '*', 'all'],
      previous: workerState([]),
      contexts: new Map(),
      inflight: new Map(),
      provision: async (repo) => { provisioned.push(repo); return context(repo) },
      handBack: async () => ({ ok: true, note: 'done' }),
      out: () => {},
    })
    expect(provisioned).toEqual(['o/good'])
    expect(result.active.map((board) => board.key)).toEqual(['o/good'])
  })

  test.each([
    'App installation lookup answered 404', 'token mint failed', 'atomic clone failed', 'dev.md is unreadable',
    'required harness hooks are not wired', 'origin push path is not verified', 'board could not be read', 'issue could not be read',
  ])('a production-shaped %s failure does not stop a healthy repository', async (reason) => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const result = await reconcileBoards({
      home: stateHome, env: {}, listed: ['o/bad', 'o/good'], previous: workerState([]), contexts: new Map(), inflight: new Map(),
      provision: async (repo) => { if (repo === 'o/bad') throw new Error(reason); return context(repo) },
      handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    expect(result.active.map((board) => board.key)).toEqual(['o/good'])
    expect(result.unavailable).toEqual([{ repo: 'o/bad', reason }])
  })

  test('one broken repository is isolated and an identical report becomes reportable after recovery', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const output: string[] = []
    let broken = true
    const provision = async (repo: string) => {
      if (repo === 'o/bad' && broken) throw new Error('App is not installed')
      return context(repo)
    }
    const run = (previous: ReturnType<typeof readWorkerState>) => reconcileBoards({
      home: stateHome,
      listed: ['o/good', 'o/bad'],
      previous,
      contexts: new Map(),
      inflight: new Map(),
      provision,
      handBack: async () => ({ ok: true, note: 'done' }),
      out: (line) => output.push(line),
    })

    const first = await run(workerState([]))
    expect(first.active.map((board) => board.key)).toEqual(['o/good'])
    expect(first.unavailable).toEqual([{ repo: 'o/bad', reason: 'App is not installed' }])
    expect(output).toEqual(['o/bad: unavailable (App is not installed)'])

    await run(readWorkerState({ home: stateHome, env: {} }))
    expect(output).toHaveLength(1)
    broken = false
    expect((await run(readWorkerState({ home: stateHome, env: {} }))).active.map((board) => board.key)).toEqual(['o/good', 'o/bad'])
    broken = true
    await run(readWorkerState({ home: stateHome, env: {} }))
    expect(output).toEqual(['o/bad: unavailable (App is not installed)', 'o/bad: unavailable (App is not installed)'])
  })

  test('removing one board persists a non-consuming hand-back before stopping and never drains its sibling', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const contexts = new Map([['o/a', context('o/a')], ['o/b', context('o/b')]])
    const stopped: string[] = []
    let stateAtStop: ReturnType<typeof readWorkerState> | null = null
    const handedBack: Array<{ repo: string; issue: number; consumes: boolean }> = []
    const makeRun = (repo: string): Inflight => {
      const candidate = { repo, number: 1, action: 'implement' as const, parent: null, files: [], from: 'queued' as const }
      const run = { candidate, started: 1, settled: false, interrupt: null, stop: () => { stateAtStop = readWorkerState({ home: stateHome, env: {} }); stopped.push(`${repo}#1`); run.settled = true }, done: Promise.resolve({}) } as unknown as Inflight
      return run
    }
    const inflight = new Map<string, Inflight>([['o/a#1', makeRun('o/a')], ['o/b#1', makeRun('o/b')]])

    const result = await reconcileBoards({
      home: stateHome,
      listed: ['o/b'],
      previous: workerState(['o/a', 'o/b']),
      contexts,
      inflight,
      provision: async (repo) => contexts.get(repo)!,
      handBack: async (repo, issue, _reason, _from, interrupt) => {
        handedBack.push({ repo, issue, consumes: interrupt.consumes })
        return { ok: true, note: 'restored' }
      },
      out: () => {},
    })

    expect(stopped).toEqual(['o/a#1'])
    expect(stateAtStop!.boards['o/a']).toMatchObject({ state: 'dropping', pending: [{ issue: 1, from: 'queued' }] })
    expect(inflight.has('o/b#1')).toBe(true)
    expect(handedBack).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.active.map((board) => board.key)).toEqual(['o/b'])
    const settled = await reconcileBoards({
      home: stateHome,
      listed: ['o/b'],
      previous: readWorkerState({ home: stateHome, env: {} }),
      contexts,
      inflight,
      provision: async (repo) => contexts.get(repo)!,
      handBack: async (repo, issue, _reason, _from, interrupt) => {
        handedBack.push({ repo, issue, consumes: interrupt.consumes })
        return { ok: true, note: 'restored' }
      },
      out: () => {},
    })
    expect(handedBack).toEqual([{ repo: 'o/a', issue: 1, consumes: false }])
    expect(settled.removed).toEqual(['o/a'])
    expect(readWorkerState({ home: stateHome, env: {} }).boards['o/a']).toBeUndefined()
  })

  test('an unresolved removed run never holds the healthy board reconciliation open', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const contexts = new Map([['o/a', context('o/a')], ['o/b', context('o/b')]])
    const candidate = { repo: 'o/a', number: 1, action: 'implement' as const, parent: null, files: [], from: 'queued' as const }
    const run = { candidate, started: 1, settled: false, interrupt: null, stop: () => {}, done: new Promise(() => {}) } as Inflight
    const result = await reconcileBoards({
      home: stateHome, env: {}, listed: ['o/b'], previous: workerState(['o/a', 'o/b']), contexts,
      inflight: new Map([['o/a#1', run]]), provision: async (repo) => contexts.get(repo)!,
      handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    expect(result.active.map((board) => board.key)).toEqual(['o/b'])
    expect(readWorkerState({ home: stateHome, env: {} }).boards['o/a']).toMatchObject({ state: 'dropping' })
  })

  test('failed hand-back survives restart with board context until a strict retry succeeds', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const contexts = new Map([['o/a', context('o/a')], ['o/b', context('o/b')]])
    const candidate = { repo: 'o/a', number: 7, action: 'implement' as const, parent: null, files: [], from: 'queued' as const }
    const run = { candidate, started: 1, settled: false, interrupt: null, stop: () => {}, done: Promise.resolve({}) } as unknown as Inflight
    let attempts = 0
    const input = (previous: ReturnType<typeof readWorkerState>, inflight: Map<string, Inflight>) => ({
      home: stateHome,
      listed: ['o/b'],
      previous,
      contexts,
      inflight,
      provision: async (repo: string) => contexts.get(repo)!,
      handBack: async () => ++attempts === 1 ? { ok: false, note: 'network down' } : { ok: true, note: 'restored' },
      out: () => {},
    })

    await reconcileBoards(input(workerState(['o/a', 'o/b']), new Map([['o/a#7', run]])))
    const crashed = readWorkerState({ home: stateHome, env: {} })
    expect(crashed.boards['o/a']).toMatchObject({ state: 'dropping', pending: [{ issue: 7, from: 'queued' }] })

    const failed = await reconcileBoards(input(crashed, new Map()))
    expect(failed.removed).toEqual([])
    const recovered = await reconcileBoards(input(readWorkerState({ home: stateHome, env: {} }), new Map()))
    expect(recovered.removed).toEqual(['o/a'])
    expect(readWorkerState({ home: stateHome, env: {} }).boards['o/a']).toBeUndefined()
    expect(recovered.active.map((board) => board.key)).toEqual(['o/b'])
  })

  test('a removed idle board needs no credentials and a dead restart child retains enough metadata to hand back', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    let provisioned = 0
    const idle = await reconcileBoards({
      home: stateHome,
      listed: [],
      previous: workerState(['o/idle']),
      contexts: new Map(),
      inflight: new Map(),
      provision: async () => { provisioned++; throw new Error('must not provision') },
      handBack: async () => { throw new Error('must not hand back') },
      out: () => {},
    })
    expect(idle.removed).toEqual(['o/idle'])
    expect(provisioned).toBe(0)

    const restartHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const stateRoot = join(restartHome, '.vegafactory', 'worker')
    noteChild(stateRoot, { repo: 'o/a', pid: 987654321, startedAt: 'gone', command: 'codex', issue: 9, action: 'implement', owner: null, from: 'queued' })
    const handedBack: string[] = []
    await reconcileBoards({
      home: restartHome,
      listed: [],
      previous: workerState(['o/a']),
      contexts: new Map([['o/a', context('o/a')]]),
      inflight: new Map(),
      provision: async (repo) => context(repo),
      handBack: async (repo, issue) => { handedBack.push(`${repo}#${issue}`); return { ok: true, note: 'restored' } },
      out: () => {},
    })
    expect(handedBack).toEqual(['o/a#9'])
    expect(readChildren(stateRoot)).toEqual([])
  })

  test('matching restart children are signalled and unknown children remain untouched and pending', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const stateRoot = join(stateHome, '.vegafactory', 'worker')
    const child = (repo: string, pid: number) => ({ repo, pid, startedAt: `start-${pid}`, command: 'codex', issue: pid, action: 'implement' as const, owner: null, from: 'queued' as const })
    noteChild(stateRoot, child('o/a', 71))
    noteChild(stateRoot, child('o/a', 72))
    noteChild(stateRoot, child('o/b', 73))
    const stopped: number[] = []
    const contexts = new Map([['o/a', context('o/a')], ['o/b', context('o/b')]])
    await reconcileBoards({
      home: stateHome, env: {}, listed: ['o/b'], previous: workerState(['o/a', 'o/b']), contexts, inflight: new Map(),
      provision: async (repo) => contexts.get(repo)!, handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
      start: (pid) => pid === 71 ? 'start-71' : null,
      alive: (pid) => pid === 72 ? null : false,
      stop: (pid) => { stopped.push(pid); return true },
    })
    expect(stopped).toEqual([71])
    expect(readChildren(stateRoot).map((row) => `${row.repo}#${row.issue}`).sort()).toEqual(['o/a#71', 'o/a#72', 'o/b#73'])
    expect(readWorkerState({ home: stateHome, env: {} }).boards['o/a']).toMatchObject({ state: 'dropping' })
    const handedBack: string[] = []
    const recovered = await reconcileBoards({
      home: stateHome, env: {}, listed: ['o/b'], previous: readWorkerState({ home: stateHome, env: {} }), contexts, inflight: new Map(),
      provision: async (repo) => contexts.get(repo)!,
      handBack: async (repo, issue) => { handedBack.push(`${repo}#${issue}`); return { ok: true, note: 'restored' } }, out: () => {},
      start: () => null, alive: () => false,
    })
    expect(handedBack).toEqual(['o/a#71', 'o/a#72'])
    expect(recovered.removed).toEqual(['o/a'])
    expect(readChildren(stateRoot).map((row) => `${row.repo}#${row.issue}`)).toEqual(['o/b#73'])
  })

  test('dropping a board leaves its checkout byte-for-byte in place', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const checkout = join(stateHome, 'checkout')
    mkdirSync(checkout)
    writeFileSync(join(checkout, 'sentinel'), 'keep me')
    const board = { ...context('o/a'), root: checkout }
    await reconcileBoards({
      home: stateHome, env: {}, listed: [], previous: workerState(['o/a']), contexts: new Map([['o/a', board]]), inflight: new Map(),
      provision: async () => board, handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    expect(readdirSync(checkout)).toEqual(['sentinel'])
    expect(readFileSync(join(checkout, 'sentinel'), 'utf8')).toBe('keep me')
  })

  test('a removed and re-added board runs the original trigger because administrative stop consumes nothing', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const stateRoot = join(stateHome, '.vegafactory', 'worker')
    gh.addIssue({ number: 81, labels: ['queued', 'small'] })
    const runner = ((args: string[], input?: string) => gh.runner(args.map((arg) => arg.replaceAll('repos/o/a', 'repos/o/r')), input)) as GhRunner
    const selected = {
      key: 'o/a', repo: 'o/a', root, runner, devMd: 'repo: o/a\n',
      identity: { runner, freshen: async () => {}, token: () => null },
    }
    let releaseStep = () => {}
    const blocked = new Promise<void>((resolve) => { releaseStep = resolve })
    let calls = 0
    const inflight = new Map<string, Inflight>()
    const pollDeps: PollDeps = {
      stateRoot, boards: [selected], runId: 'f18', now: () => gh.clock, machine: HOST, out: () => {},
      start: () => 'matching', stop: () => { releaseStep(); return true },
      standDown: (_repo, _number, reason) => reason,
      runStep: async (_step, runContext) => {
        calls++
        if (calls === 1) { runContext.onStart?.(8181, 'codex'); await blocked; return { outcome: 'failed', note: 'stopped', ms: 1 } }
        return { outcome: 'done', note: 'resumed', ms: 1 }
      },
    }
    expect((await poll(pollDeps, inflight)).map(runKey)).toEqual(['o/a#81'])
    await reconcileBoards({
      home: stateHome, env: {}, listed: [], previous: workerState(['o/a']), contexts: new Map([['o/a', selected]]), inflight,
      provision: async () => selected, handBack: async () => ({ ok: true, note: 'restored' }), out: () => {},
    })
    await inflight.get('o/a#81')!.done
    await reconcileBoards({
      home: stateHome, env: {}, listed: [], previous: readWorkerState({ home: stateHome, env: {} }), contexts: new Map([['o/a', selected]]), inflight,
      provision: async () => selected, handBack: async () => ({ ok: true, note: 'restored' }), out: () => {},
    })
    await reconcileBoards({
      home: stateHome, env: {}, listed: ['o/a'], previous: readWorkerState({ home: stateHome, env: {} }), contexts: new Map(), inflight,
      provision: async () => selected, handBack: async () => ({ ok: true, note: 'restored' }), out: () => {},
    })
    expect(readActed(stateRoot)['o/a#81']).toBeUndefined()
    expect((await poll(pollDeps, inflight)).map(runKey)).toEqual(['o/a#81'])
    await drain(inflight)
  })
})

describe('persisted worker board state', () => {
  const pathAt = (base: string) => join(base, '.vegafactory', 'worker', 'boards.json')

  test('an absent default file is empty and VEGAFACTORY_HOME is authoritative', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    expect(readWorkerState({ home: base, env: {} })).toEqual({ schema: 1, revision: 0, boards: {}, reports: {} })
    const override = join(base, 'override')
    await reconcileBoards({
      home: join(base, 'ignored'), env: { VEGAFACTORY_HOME: override }, listed: ['o/r'],
      previous: { schema: 1, revision: 0, boards: {} }, contexts: new Map(), inflight: new Map(),
      provision: async (repo) => ({
        key: repo, repo, root: '/repo', devMd: `repo: ${repo}\n`,
        runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner,
        identity: { token: () => null, freshen: async () => {}, runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner },
      }),
      handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    expect(existsSync(join(override, 'worker', 'boards.json'))).toBe(true)
    expect(existsSync(pathAt(join(base, 'ignored')))).toBe(false)
    expect(readWorkerState({ home: join(base, 'ignored'), env: { VEGAFACTORY_HOME: override } }).boards['o/r']?.state).toBe('active')
  })

  test.each([
    ['top level', '{}'],
    ['schema', '{"schema":2,"revision":0,"boards":{}}'],
    ['revision', '{"schema":1,"revision":-1,"boards":{}}'],
    ['boards', '{"schema":1,"revision":0,"boards":[]}'],
    ['canonical key', '{"schema":1,"revision":0,"boards":{"O/R":{"repo":"O/R","state":"active"}}}'],
    ['matching repo', '{"schema":1,"revision":0,"boards":{"o/r":{"repo":"o/x","state":"active"}}}'],
    ['state', '{"schema":1,"revision":0,"boards":{"o/r":{"repo":"o/r","state":"gone"}}}'],
    ['pending shape', '{"schema":1,"revision":0,"boards":{"o/r":{"repo":"o/r","state":"dropping","pending":{}}}}'],
    ['pending issue', '{"schema":1,"revision":0,"boards":{"o/r":{"repo":"o/r","state":"dropping","pending":[{"issue":0,"from":"queued","reason":"drop"}]}}}'],
    ['pending from', '{"schema":1,"revision":0,"boards":{"o/r":{"repo":"o/r","state":"dropping","pending":[{"issue":1,"from":"gone","reason":"drop"}]}}}'],
    ['pending reason', '{"schema":1,"revision":0,"boards":{"o/r":{"repo":"o/r","state":"dropping","pending":[{"issue":1,"from":"queued","reason":7}]}}}'],
    ['reports', '{"schema":1,"revision":0,"boards":{},"reports":{"o/r":7}}'],
  ])('malformed %s is refused without changing its bytes', (_name, bytes) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    const path = pathAt(base)
    mkdirSync(join(base, '.vegafactory', 'worker'), { recursive: true })
    writeFileSync(path, bytes)
    expect(() => readWorkerState({ home: base, env: {} })).toThrow('is malformed')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })

  test('unsafe ancestor, worker root, leaf, and unreadable leaf are refused without touching targets', () => {
    const external = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-target-')))
    const ancestorBase = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    symlinkSync(external, join(ancestorBase, '.vegafactory'))
    expect(() => readWorkerState({ home: ancestorBase, env: {} })).toThrow('unsafe global worker directory')
    expect(readdirSync(external)).toEqual([])

    const rootBase = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    mkdirSync(join(rootBase, '.vegafactory'))
    symlinkSync(external, join(rootBase, '.vegafactory', 'worker'))
    expect(() => readWorkerState({ home: rootBase, env: {} })).toThrow('unsafe global worker directory')
    expect(readdirSync(external)).toEqual([])

    const leafBase = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    mkdirSync(join(leafBase, '.vegafactory', 'worker'), { recursive: true })
    const target = join(external, 'target.json')
    writeFileSync(target, 'do not touch')
    symlinkSync(target, pathAt(leafBase))
    expect(() => readWorkerState({ home: leafBase, env: {} })).toThrow('not a regular file')
    expect(readFileSync(target, 'utf8')).toBe('do not touch')

    const unreadableBase = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    mkdirSync(join(unreadableBase, '.vegafactory', 'worker'), { recursive: true })
    const unreadable = pathAt(unreadableBase)
    writeFileSync(unreadable, '{"schema":1,"revision":0,"boards":{}}')
    chmodSync(unreadable, 0o000)
    try {
      if (process.getuid?.() !== 0) expect(() => readWorkerState({ home: unreadableBase, env: {} })).toThrow()
    } finally { chmodSync(unreadable, 0o600) }
  })

  test('a malformed persisted file blocks reconciliation unchanged, then a repaired retry succeeds', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    const path = pathAt(base)
    mkdirSync(join(base, '.vegafactory', 'worker'), { recursive: true })
    writeFileSync(path, '{broken')
    const reconcile = () => reconcileBoards({
      home: base, env: {}, listed: [], previous: readWorkerState({ home: base, env: {} }), contexts: new Map(), inflight: new Map(),
      provision: async () => { throw new Error('unused') }, handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    expect(() => reconcile()).toThrow('is malformed')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    writeFileSync(path, '{"schema":1,"revision":0,"boards":{},"reports":{}}\n')
    await expect(reconcile()).resolves.toMatchObject({ active: [], removed: [], unavailable: [] })
    expect(readWorkerState({ home: base, env: {} })).toMatchObject({ schema: 1, boards: {}, reports: {} })
  })

  test('concurrent equivalent reconciliations leave one complete parseable atomic state', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    const previous = { schema: 1 as const, revision: 0, boards: {} }
    const makeContext = (repo: string) => ({
      key: repo, repo, root: '/repo', devMd: `repo: ${repo}\n`,
      runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner,
      identity: { token: () => null, freshen: async () => {}, runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner },
    })
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => reconcileBoards({
      home: base, env: {}, listed: ['o/r'], previous, contexts: new Map(), inflight: new Map(),
      provision: async (repo) => { await Promise.resolve(); return makeContext(repo) },
      handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })))
    expect(outcomes.some((result) => result.status === 'rejected' && String(result.reason).includes('changed concurrently'))).toBe(true)
    expect(readWorkerState({ home: base, env: {} })).toMatchObject({ schema: 1, boards: { 'o/r': { repo: 'o/r', state: 'active' } }, reports: {} })
    expect(readdirSync(join(base, '.vegafactory', 'worker')).filter((name) => name.startsWith('.boards.json.'))).toEqual([])
  })

  test('a stale divergent writer cannot erase a newer dropping board or its pending hand-back', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-state-')))
    const board = {
      key: 'o/a', repo: 'o/a', root: '/repo', devMd: 'repo: o/a\n',
      runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner,
      identity: { token: () => null, freshen: async () => {}, runner: (() => ({ code: 0, stdout: '', stderr: '' })) as GhRunner },
    }
    await reconcileBoards({
      home: base, env: {}, listed: ['o/a'], previous: { schema: 1, revision: 0, boards: {} }, contexts: new Map(), inflight: new Map(),
      provision: async () => board, handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    const stale = readWorkerState({ home: base, env: {} })
    const candidate = { repo: 'o/a', number: 7, action: 'implement' as const, parent: null, files: [], from: 'queued' as const }
    const run = { candidate, started: 1, settled: false, interrupt: null, stop: () => {}, done: new Promise(() => {}) } as Inflight
    await reconcileBoards({
      home: base, env: {}, listed: [], previous: stale, contexts: new Map([['o/a', board]]), inflight: new Map([['o/a#7', run]]),
      provision: async () => board, handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    await expect(reconcileBoards({
      home: base, env: {}, listed: ['o/a', 'o/b'], previous: stale, contexts: new Map([['o/a', board]]), inflight: new Map(),
      provision: async (repo) => ({ ...board, key: repo, repo }), handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })).rejects.toThrow('changed concurrently')
    expect(readWorkerState({ home: base, env: {} }).boards['o/a']).toMatchObject({
      state: 'dropping', pending: [{ issue: 7, from: 'queued' }],
    })
    expect(readWorkerState({ home: base, env: {} }).boards['o/b']).toBeUndefined()
  })
})

describe('identity', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

  // As the key must be on a real machine: a regular file this account owns and nobody else reads.
  const keyFile = () => {
    const path = join(root, 'app.pem')
    writeFileSync(path, privateKey, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  }

  test('the key path follows the environment, then the home default', () => {
    expect(appKeyPath({ VEGAFACTORY_APP_PRIVATE_KEY_FILE: '/keys/app.pem' }, '/home/x')).toBe('/keys/app.pem')
    expect(appKeyPath({}, '/home/x')).toBe('/home/x/.vegafactory/worker/app.pem')
  })

  test('the JWT names the App and expires inside ten minutes', () => {
    const now = Date.parse('2026-09-18T10:00:00Z')
    const [header, claims] = appJwt(privateKey, APP_ID, now).split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { iss: string; iat: number; exp: number }
    expect(payload.iss).toBe(APP_ID)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600)
  })

  test('a token is minted for this one repository and never for the whole installation', async () => {
    const seen: Array<{ url: string; body?: string; auth: string }> = []
    const call: Fetch = async (url, init) => {
      seen.push({ url, body: init.body, auth: init.headers.Authorization! })
      return { ok: true, status: 200, json: async () => (url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_secret', expires_at: '2026-09-18T11:00:00Z' }) }
    }
    const minted = await mintToken({ repo: 'o/r', keyPath: keyFile(), appId: APP_ID, fetch: call })
    expect(minted.token).toBe('ghs_secret')
    expect(seen[0]!.url).toBe('https://api.github.com/repos/o/r/installation')
    expect(seen[0]!.auth.startsWith('Bearer ey')).toBe(true)
    expect(seen[1]!.url).toBe('https://api.github.com/app/installations/42/access_tokens')
    expect(JSON.parse(seen[1]!.body!)).toEqual({ repositories: ['r'] })
  })

  test('a missing key refuses with the exact fix and never falls back to a person', async () => {
    const call: Fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    await expect(mintToken({ repo: 'o/r', keyPath: join(root, 'nothing.pem'), appId: APP_ID, fetch: call }))
      .rejects.toThrow(/nothing\.pem.*VEGAFACTORY_APP_PRIVATE_KEY_FILE.*never falls back/s)
  })

  test('an installation GitHub refuses is reported, not worked around', async () => {
    const call: Fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
    await expect(mintToken({ repo: 'o/r', keyPath: keyFile(), appId: APP_ID, fetch: call })).rejects.toThrow(/not installed on o\/r \(GitHub answered 404\)/)
  })

  test('a key another account could read, or one that is a link, mints nothing', async () => {
    const facts = (over: Partial<{ file: boolean; link: boolean; uid: number; mode: number }> = {}) => {
      const { file = true, link = false, uid = 501, mode = 0o100600 } = over
      return { isFile: () => file, isSymbolicLink: () => link, uid, mode }
    }
    expect(() => assertKeyFile('/k.pem', { stat: () => facts(), uid: 501 })).not.toThrow()
    expect(() => assertKeyFile('/k.pem', { stat: () => facts({ mode: 0o100640 }), uid: 501 })).toThrow(/another account on this machine can read the App key — chmod 600/)
    expect(() => assertKeyFile('/k.pem', { stat: () => facts({ mode: 0o100604 }), uid: 501 })).toThrow(/chmod 600/)
    expect(() => assertKeyFile('/k.pem', { stat: () => facts({ uid: 0 }), uid: 501 })).toThrow(/owned by uid 0, not the account running this/)
    expect(() => assertKeyFile('/k.pem', { stat: () => facts({ link: true }), uid: 501 })).toThrow(/is a symbolic link/)
    expect(() => assertKeyFile('/k.pem', { stat: () => facts({ file: false }), uid: 501 })).toThrow(/not a regular file/)
    expect(() => assertKeyFile('/k.pem', { stat: () => { throw new Error('ENOENT') }, uid: 501 })).toThrow(/is not readable at/)
    // The file check runs before the key is read, so a loose key never reaches GitHub at all.
    let called = 0
    const call: Fetch = async () => { called++; return { ok: true, status: 200, json: async () => ({ id: 1 }) } }
    await expect(mintToken({ repo: 'o/r', keyPath: keyFile(), appId: APP_ID, fetch: call, stat: () => facts({ mode: 0o100644 }), uid: 501 }))
      .rejects.toThrow(/chmod 600/)
    expect(called).toBe(0)
  })

  test('the token is re-minted before it expires, so a month-old worker still writes', async () => {
    let issued = 0
    const start = Date.parse('2026-09-18T10:00:00Z')
    const call: Fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => (url.endsWith('/installation') ? { id: 42 } : { token: `ghs_${++issued}`, expires_at: new Date(start + issued * 3_600_000).toISOString() }),
    })
    const identity = appIdentity({ repo: 'o/r', keyPath: keyFile(), appId: APP_ID, fetch: call })
    await identity.freshen(start)
    await identity.freshen(start + 10 * 60_000)
    expect(issued).toBe(1)
    // Within the margin of expiry, the next pass mints a new one instead of failing every call.
    await identity.freshen(start + 3_600_000 - TOKEN_MARGIN_MS + 1)
    expect(issued).toBe(2)
  })
})

describe('transitions', () => {
  const evidence = (number: number) => gh.addComment(number, '<!-- vsk:v1 type=evidence sha=abc1234 branch=feat/1-x -->\nbuilt', 'mk')

  test('planning asks for a plan, and a large issue is split', () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    gh.addIssue({ number: 2, labels: ['planning', 'large'] })
    expect(verdict(1)).toMatchObject({ action: 'plan', split: false })
    expect(verdict(2)).toMatchObject({ action: 'plan', split: true })
  })

  test('queued asks to implement', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    expect(verdict(1).action).toBe('implement')
  })

  test('an operator reply on waiting-on-operator asks for a follow-up; silence asks for nothing', () => {
    gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
    gh.addComment(1, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan', 'mk')
    expect(verdict(1).action).toBe('none')
    const reply = gh.addComment(1, 'use the cache, not a second store', 'mk')
    expect(verdict(1)).toMatchObject({ action: 'follow-up', trigger: reply.id, by: 'mk' })
  })

  test('a comment the factory wrote is never a person\'s word', () => {
    // A worker run posts as the App. Its comments are work, never consent — so a run that was
    // fed a hostile file cannot stop, correct or ship an issue by writing a sentence.
    for (const [state, text] of [['queued', 'stop'], ['ready-to-ship', 'ship it'], ['ready-to-ship', 'rename the flag']] as Array<[string, string]>) {
      const number = 20 + Math.floor(Math.random() * 1_000_000)
      gh.addIssue({ number, labels: [state, 'small'] })
      gh.addComment(number, '<!-- vsk:v1 type=evidence sha=abc1234 -->\nbuilt', 'vegafactory[bot]', 'Bot')
      gh.addComment(number, text, 'vegafactory[bot]', 'Bot')
      expect([text, verdict(number).action]).toEqual([text, state === 'queued' ? 'implement' : 'none'])
      // The same words from the operator do move it.
      gh.addComment(number, text, 'mk')
      expect([text, verdict(number).action]).toEqual([text, state === 'queued' ? 'stop' : text === 'ship it' ? 'ship' : 'corrections'])
    }
  })

  test('a reply from someone without write access is not the operator', () => {
    gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
    gh.addComment(1, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan', 'mk')
    gh.addComment(1, 'please build it', 'outsider')
    expect(verdict(1).action).toBe('none')
  })

  test('a claim posted after the operator\'s reply does not swallow it', () => {
    gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
    gh.addComment(1, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan', 'mk')
    const reply = gh.addComment(1, 'yes, that approach', 'mk')
    gh.addComment(1, claimBody({ owner: 'laptop:1-x', kind: 'session', harness: 'claude', model: 'opus' }), 'mk')
    expect(verdict(1)).toMatchObject({ action: 'follow-up', trigger: reply.id })
  })

  test('evidence from an outsider is not evidence; evidence from the App is', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    gh.addComment(1, '<!-- vsk:v1 type=evidence sha=abc1234 -->\nbuilt', 'outsider')
    gh.addComment(1, 'ship it', 'mk')
    expect(verdict(1)).toMatchObject({ action: 'none', reason: 'ready-to-ship with no evidence comment' })
    // A worker run posts its work as the App, so the App's evidence opens the window — while
    // the word that ships still has to come from a person.
    gh.addIssue({ number: 2, labels: ['ready-to-ship', 'small'] })
    gh.addComment(2, '<!-- vsk:v1 type=evidence sha=abc1234 -->\nbuilt', 'vegafactory[bot]', 'Bot')
    expect(verdict(2)).toMatchObject({ action: 'none', reason: 'waiting for the operator to read the evidence' })
    gh.addComment(2, 'ship it', 'vegafactory[bot]', 'Bot')
    expect(verdict(2).action).toBe('none')
  })

  test('evidence from a self-hosted App opens the operator approval window', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    gh.addComment(1, '<!-- vsk:v1 type=evidence sha=abc1234 -->\nbuilt', 'acmefactory[bot]', 'Bot')
    expect(verdict(1, { appActor: 'acmefactory[bot]' })).toMatchObject({ action: 'none', reason: 'waiting for the operator to read the evidence' })
    gh.addComment(1, 'ship it', 'mk')
    expect(verdict(1, { appActor: 'acmefactory[bot]' }).action).toBe('ship')
  })

  test('"ship it" after the evidence ships; anything else is corrections', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    evidence(1)
    expect(verdict(1).action).toBe('none')
    const word = gh.addComment(1, 'nice — ship it', 'mk')
    expect(verdict(1)).toMatchObject({ action: 'ship', trigger: word.id, by: 'mk' })
    gh.addComment(1, 'one more thing: rename the flag', 'mk')
    expect(verdict(1).action).toBe('corrections')
  })

  test('a sentence that only contains the words is a correction, not consent', () => {
    // A separator before the words is not consent either: the whole line has to be the instruction.
    for (const text of ['do not ship it', "don't ship it yet", 'ship it after fixing the flag name', 'I would not ship it like this', '> ship it',
      'do not — ship it', 'never: ship it', 'I refuse; ship it', 'maybe ship it', 'ship it when CI is green']) {
      expect([text, shipWord(text)]).toEqual([text, null])
    }
    for (const text of ['ship it', 'Ship it.', 'ship it!', 'looks good — ship it', 'yes, ship it', 'ok ship this', 'nice work\nship it', 'LGTM: ship it']) {
      expect([text, shipWord(text) !== null]).toEqual([text, true])
    }
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    gh.addComment(1, '<!-- vsk:v1 type=evidence sha=abc1234 -->\nbuilt', 'mk')
    gh.addComment(1, 'ship it once the flag is renamed', 'mk')
    expect(verdict(1).action).toBe('corrections')
  })

  test('the word only ships once it is a recorded ack the ship gate accepts', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    evidence(1)
    const word = gh.addComment(1, 'ship it', 'mk')
    const ctx = { root, repo: 'o/r', number: 1, runner: gh.runner }
    const permission = permissionLookup('o/r', gh.runner)
    const confirmed = confirmShip(ctx, permission, { id: word.id, by: 'mk', quote: 'ship it' })
    expect(confirmed.ok).toBe(true)
    // The worker relays the ack by citing the person's own comment; it never writes the word.
    const ack = gh.issues.get(1)!.comments.map((comment) => comment.body).find((body) => body.includes('type=ack'))!
    expect(ack).toContain('stage=ship')
    expect(ack).toContain('by=mk')
    expect(ack).toContain(`source=comment:${word.id}`)
    // Asking again records nothing new: the ack already validates.
    const acks = gh.issues.get(1)!.comments.filter((comment) => comment.body.includes('type=ack')).length
    expect(confirmShip(ctx, permission, { id: word.id, by: 'mk', quote: 'ship it' }).ok).toBe(true)
    expect(gh.issues.get(1)!.comments.filter((comment) => comment.body.includes('type=ack'))).toHaveLength(acks)
  })

  test('ship confirmation accepts evidence from a self-hosted App', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    gh.addComment(1, '<!-- vsk:v1 type=evidence sha=abc1234 -->\nbuilt', 'acmefactory[bot]', 'Bot')
    const word = gh.addComment(1, 'ship it', 'mk')
    const permission = permissionLookup('o/r', gh.runner)
    const confirmed = confirmShip({ root, repo: 'o/r', number: 1, runner: gh.runner, appActor: 'acmefactory[bot]' }, permission, { id: word.id, by: 'mk', quote: 'ship it' })
    expect(confirmed.ok).toBe(true)
  })

  test('a relayed ack that cannot validate ships nothing', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    evidence(1)
    const word = gh.addComment(1, 'ship it', 'mk')
    // The quote is not in the cited comment, so the ack fails the same check the ship gate runs.
    const confirmed = confirmShip({ root, repo: 'o/r', number: 1, runner: gh.runner }, permissionLookup('o/r', gh.runner), { id: word.id, by: 'mk', quote: 'merge everything' })
    expect(confirmed.ok).toBe(false)
    expect(confirmed.reason).toContain('does not contain the quoted words')
  })

  test('a "ship it" from someone without write access ships nothing', () => {
    gh.addIssue({ number: 1, labels: ['ready-to-ship', 'small'] })
    evidence(1)
    gh.addComment(1, 'ship it', 'outsider')
    expect(verdict(1).action).toBe('none')
  })

  test('"stop" outranks every other state, and "stop using X" is a correction, not a stop', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    gh.addComment(1, 'stop — I need to rethink this', 'mk')
    expect(verdict(1)).toMatchObject({ action: 'stop', by: 'mk' })
    gh.addIssue({ number: 2, labels: ['queued', 'small'] })
    gh.addComment(2, 'stop using the old API in task 3', 'mk')
    expect(verdict(2).action).toBe('implement')
  })

  test('an epic, a closed issue and an issue with no state label are left alone', () => {
    gh.addIssue({ number: 1, labels: ['planning', 'large', 'epic'] })
    gh.addIssue({ number: 2, labels: ['queued', 'small'], state: 'closed' })
    gh.addIssue({ number: 3, labels: ['small'] })
    expect(verdict(1).action).toBe('none')
    expect(verdict(2).action).toBe('none')
    expect(verdict(3).action).toBe('none')
  })

  test('a queued issue with an open blocker is left alone', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'], blockedBy: [{ number: 5, state: 'open' }] })
    expect(verdict(1)).toMatchObject({ action: 'none', reason: 'blocked by #5' })
  })

  test('a finished run is not repeated for the same trigger, whatever it finished as', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const acted = { at: gh.clock, action: 'implement' as const, outcome: 'done' as const, trigger: null, failures: 0, retryAt: null }
    expect(verdict(1, { acted }).action).toBe('none')
    expect(verdict(1, { acted: { ...acted, action: 'plan' as const } }).action).toBe('implement')
    // A stop settles its trigger too, or every pass would stand the issue down again.
    gh.addIssue({ number: 2, labels: ['in-progress', 'small'] })
    const word = gh.addComment(2, 'stop', 'mk')
    const stopped = { at: gh.clock, action: 'stop' as const, outcome: 'stopped' as const, trigger: word.id, failures: 0, retryAt: null }
    expect(verdict(2).action).toBe('stop')
    expect(verdict(2, { acted: stopped }).action).toBe('none')
  })

  test('a failed run waits out its backoff and is parked after three tries', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const failed = { at: gh.clock, action: 'implement' as const, outcome: 'failed' as const, trigger: null, failures: 1, retryAt: gh.clock + 60_000 }
    expect(verdict(1, { acted: failed }).action).toBe('none')
    expect(verdict(1, { acted: failed, now: gh.clock + 120_000 }).action).toBe('implement')
    expect(verdict(1, { acted: { ...failed, failures: 3, retryAt: null }, now: gh.clock + 10 ** 9 }).reason).toContain('needs a person')
  })
})

describe('what may run at once', () => {
  const candidate = (number: number, extra: Partial<Candidate> = {}): Candidate => ({ repo: 'o/a', number, action: 'implement', parent: null, files: [], from: 'queued', ...extra })

  test('run identity is canonical and repository-qualified', () => {
    expect(runKey({ repo: 'Org/Repo', number: 1 })).toBe('org/repo#1')
    expect(runKey({ repo: 'org/repo', number: 1 })).toBe('org/repo#1')
    expect(runKey({ repo: 'o/a', number: 1 })).not.toBe(runKey({ repo: 'o/b', number: 1 }))
  })

  test('one run per issue, and never more than three', () => {
    const wanted = [1, 2, 3, 4].map((number) => candidate(number, { action: 'plan' }))
    expect(schedule([...wanted, candidate(1, { action: 'plan' })]).map((item) => item.number)).toEqual([1, 2, 3])
  })

  test('one cap spans repositories while ship exclusion stays repository-local', () => {
    const picked = schedule([
      candidate(1, { repo: 'o/a', action: 'ship' }),
      candidate(2, { repo: 'o/a', action: 'ship' }),
      candidate(1, { repo: 'o/b', action: 'ship' }),
    ], [], 2)
    expect(picked.map(runKey)).toEqual(['o/a#1', 'o/b#1'])
    expect(schedule([
      candidate(3, { repo: 'o/a', action: 'implement' }),
      candidate(3, { repo: 'o/b', action: 'implement' }),
    ], [], 1)).toHaveLength(1)
  })

  test('code overlap is repository-local', () => {
    const a = candidate(1, { repo: 'o/a', parent: 9, files: ['src/index.ts'] })
    const b = candidate(1, { repo: 'o/b', parent: 9, files: ['src/index.ts'] })
    expect(schedule([a, b], [], 2).map(runKey)).toEqual(['o/a#1', 'o/b#1'])
  })

  test('two code runs only as siblings with disjoint, safe file sets', () => {
    const a = candidate(1, { parent: 9, files: ['packages/cli/src/issue.ts'] })
    const b = candidate(2, { parent: 9, files: ['README.md'] })
    const c = candidate(3, { parent: 9, files: ['docs/'] })
    expect(schedule([a, c]).map((item) => item.number)).toEqual([1, 3])
    // README.md is in every child's diff, so it is never a parallel set.
    expect(schedule([a, b]).map((item) => item.number)).toEqual([1])
    // Overlapping sets, a different parent and an undeclared set each mean one at a time.
    expect(schedule([a, candidate(4, { parent: 9, files: ['packages/cli/src/issue.ts'] })]).map((item) => item.number)).toEqual([1])
    expect(schedule([a, candidate(5, { parent: 8, files: ['skills/'] })]).map((item) => item.number)).toEqual([1])
    expect(schedule([a, candidate(6, { parent: 9, files: [] })]).map((item) => item.number)).toEqual([1])
    expect(schedule([a, candidate(7, { parent: null, files: ['skills/'] })]).map((item) => item.number)).toEqual([1])
  })

  test('generated code, migrations, lockfiles and package.json are never parallel', () => {
    for (const path of ['bun.lock', 'package.json', 'packages/cli/package.json', 'dist/index.js', 'db/migrations/001.sql', 'src/api.generated.ts', 'packages/cli/skill-integrity.json', 'README.md']) {
      expect(unsafeForParallel(path)).toBe(true)
    }
    expect(unsafeForParallel('packages/cli/src/worker.ts')).toBe(false)
  })

  test('a directory in a file set covers everything under it', () => {
    expect(overlaps('skills/', 'skills/dev/dev-plan/SKILL.md')).toBe(true)
    expect(overlaps('a/b.ts', 'a/b.ts')).toBe(true)
    expect(overlaps('a/b.ts', 'a/c.ts')).toBe(false)
    expect(disjointSiblings(
      { repo: 'o/a', number: 1, action: 'implement', parent: 4, files: ['skills/'], from: 'queued' },
      { repo: 'o/a', number: 2, action: 'implement', parent: 4, files: ['skills/dev/x.md'], from: 'queued' },
    )).toBe(false)
  })

  test('file sets come from the parent epic\'s plan, and nothing else', () => {
    const plan = ['**Independent groups:**', '- `api` — #131 · Files: `packages/cli/src/issue.ts`, `packages/cli/test/issue.test.ts`', '- `docs` — #132 · Files: `docs/`', ''].join('\n')
    expect(filesFromParent(plan, 131)).toEqual(['packages/cli/src/issue.ts', 'packages/cli/test/issue.test.ts'])
    expect(filesFromParent(plan, 132)).toEqual(['docs/'])
    expect(filesFromParent(plan, 999)).toEqual([])
    expect(filesFromParent(null, 131)).toEqual([])
  })

  test('a path is canonical or it is not a file set', () => {
    // The same file under two spellings is one file, and a set that hid that would read as disjoint.
    expect(canonicalPath('src/../src/x.ts')).toBe('src/x.ts')
    expect(canonicalPath('./a//b.ts')).toBe('a/b.ts')
    expect(canonicalPath('docs/')).toBe('docs/')
    for (const bad of ['../outside.ts', '/etc/passwd', 'src/**/*.ts', 'a/{b,c}.ts', '', '.']) expect(canonicalPath(bad)).toBeNull()
    const aliased = ['**Independent groups:**', '- `a` — #1 · Files: `src/../src/x.ts`', '- `b` — #2 · Files: `src/x.ts`', ''].join('\n')
    expect(filesFromParent(aliased, 1)).toEqual(['src/x.ts'])
    expect(disjointSiblings(
      { repo: 'o/a', number: 1, action: 'implement', parent: 9, files: filesFromParent(aliased, 1), from: 'queued' },
      { repo: 'o/a', number: 2, action: 'implement', parent: 9, files: filesFromParent(aliased, 2), from: 'queued' },
    )).toBe(false)
    // One path nobody can check makes the whole set uncheckable, so the siblings run one at a time.
    const traversal = ['**Independent groups:**', '- `a` — #1 · Files: `src/x.ts`, `../elsewhere.ts`', ''].join('\n')
    expect(filesFromParent(traversal, 1)).toEqual([])
  })

  test('only an acked plan that passes the lint authorises a parallel run', () => {
    const real = readFileSync(join(import.meta.dir, '../../../skills/dev/dev-plan/tests/fixtures/plan-with-groups.md'), 'utf8')
    const permission = permissionLookup('o/r', gh.runner)
    const ackFor = (number: number, planBody: string, by = 'mk') => {
      const snap = snapOf(number)
      const plan = Object.values(snap.state.comments).find((entry) => entry.type === 'plan')!
      gh.addComment(number, ackBody({
        stage: 'plan', by, source: 'session', quote: 'approved',
        brief: artifactHash(readFileSync(join(cacheDir(root, 'o/r', number), 'issue.md'), 'utf8').split('\n---\n')[1] ?? ''),
        plan: artifactHash(planBody),
      }), by)
      return plan
    }

    // Acked, linted, from a person with write access: the groups authorise a parallel run.
    gh.addIssue({ number: 10, labels: ['planning', 'large', 'epic'] })
    gh.addComment(10, real, 'mk')
    ackFor(10, real)
    expect(acknowledgedPlan(snapOf(10), permission).text).toContain('Independent groups')
    expect(filesFromParent(acknowledgedPlan(snapOf(10), permission).text, 131)).toEqual(['packages/cli/src/dispatch.ts', 'packages/cli/test/dispatch.test.ts'])

    // Posted by an outsider: not a plan at all.
    gh.addIssue({ number: 11, labels: ['planning', 'large', 'epic'] })
    gh.addComment(11, real, 'outsider')
    expect(acknowledgedPlan(snapOf(11), permission).text).toBeNull()

    // Never acked: a plan nobody approved authorises nothing.
    gh.addIssue({ number: 12, labels: ['planning', 'large', 'epic'] })
    gh.addComment(12, real, 'mk')
    expect(acknowledgedPlan(snapOf(12), permission)).toMatchObject({ text: null, reason: expect.stringContaining('not acked') })

    // Acked, then a second plan appears claiming wider groups. The ack is bound to the hash of the
    // plan it read, so the newcomer does not inherit it: nothing is authorised until it is acked.
    gh.addIssue({ number: 13, labels: ['planning', 'large', 'epic'] })
    gh.addComment(13, real, 'mk')
    ackFor(13, real)
    expect(acknowledgedPlan(snapOf(13), permission).text).toBe(real)
    gh.addComment(13, real.replace('`docs/worker.md`', '`packages/cli/src/worker.ts`'), 'mk')
    expect(acknowledgedPlan(snapOf(13), permission)).toMatchObject({ text: null, reason: expect.stringContaining('changed after') })

    // Acked, but the plan does not pass its own lint.
    gh.addIssue({ number: 14, labels: ['planning', 'large', 'epic'] })
    const broken = real.replace('**Goal:** a thing exists.', '**Goal:** TBD')
    gh.addComment(14, broken, 'mk')
    ackFor(14, broken)
    expect(acknowledgedPlan(snapOf(14), permission)).toMatchObject({ text: null, reason: expect.stringContaining('plan-lint') })

    // A self-hosted App writes the plan under its own bot login, while the ack remains a person's.
    gh.addIssue({ number: 15, labels: ['planning', 'large', 'epic'] })
    gh.addComment(15, real, 'acmefactory[bot]', 'Bot')
    ackFor(15, real)
    expect(acknowledgedPlan(snapOf(15), permission, 'acmefactory[bot]').text).toBe(real)
  })
})

describe('one poll over the board', () => {
  const steps: Array<{ action: string; number: number }> = []
  const runStep = (result: Partial<StepResult> = {}): RunStep => async (step) => {
    steps.push({ action: step.action, number: step.number })
    return { outcome: 'done', note: 'finished', ms: 10, ...result }
  }
  const deps = (over: Partial<PollDeps> = {}): PollDeps => ({
    stateRoot: root,
    boards: [{ key: 'o/r', repo: 'o/r', root, runner: gh.runner, devMd: '', identity: { runner: gh.runner, freshen: async () => {}, token: () => 'token-r' } }],
    now: () => gh.clock, machine: HOST, runId: 'test', out: () => {}, runStep: runStep(), standDown: () => 'stood down', ...over,
  })
  // One pass, then everything it started.
  const pass = async (over: Partial<PollDeps> = {}, inflight = new Map<string, Inflight>()) => {
    await poll(deps(over), inflight)
    return drain(inflight)
  }

  beforeEach(() => { steps.length = 0 })

  const context = (repo: string, boardRoot: string, fake: FakeGitHub, token: string, devMd: string) => {
    // FakeGitHub deliberately models one fixed repository; adapt only its test transport while
    // leaving the worker-facing repository identity untouched.
    const runner = ((args: string[], input?: string) => fake.runner(args.map((arg) => arg.replaceAll(`repos/${repo}`, 'repos/o/r')), input)) as GhRunner
    return { key: repo, repo, root: boardRoot, runner, devMd, identity: { runner, freshen: async () => {}, token: () => token } }
  }

  test('the same issue number uses each board own root, token, policy, cache, and record', async () => {
    const other = new FakeGitHub()
    other.permissions.set('mk', 'admin')
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    other.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'worker-other-')))
    const seen: Array<{ repo: string; root: string; token: string | null; devMd: string }> = []
    const inflight = new Map<string, Inflight>()
    const multi = deps({
      boards: [context('o/a', root, gh, 'token-a', 'policy-a'), context('o/b', otherRoot, other, 'token-b', 'policy-b')],
      caps: { ...DEFAULT_CAPS, runs: 2 },
      runStep: async (step, call) => {
        seen.push({ repo: step.repo, root: call.root, token: call.token, devMd: call.devMd })
        return { outcome: 'done', note: '', ms: 1 }
      },
    })
    expect((await poll(multi, inflight)).map(runKey)).toEqual(['o/a#1', 'o/b#1'])
    expect([...inflight.keys()]).toEqual(['o/a#1', 'o/b#1'])
    expect(seen).toEqual([
      { repo: 'o/a', root, token: 'token-a', devMd: 'policy-a' },
      { repo: 'o/b', root: otherRoot, token: 'token-b', devMd: 'policy-b' },
    ])
    expect(existsSync(cacheDir(root, 'o/a', 1))).toBe(true)
    expect(existsSync(cacheDir(otherRoot, 'o/b', 1))).toBe(true)
    const records = await drain(inflight)
    expect(records.map((record) => `${record.repo}#${record.issue}`).sort()).toEqual(['o/a#1', 'o/b#1'])
    expect(readRuns(root).map((record) => `${record.repo}#${record.issue}`).sort()).toEqual(['o/a#1', 'o/b#1'])
  })

  test('a mixed-case board context uses only canonical API, cache, claim, and step identity', async () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const calls: string[] = []
    const runner = ((args: string[], input?: string) => {
      calls.push(args.join(' '))
      return gh.runner(args.map((arg) => arg.replaceAll('repos/o/a', 'repos/o/r')), input)
    }) as GhRunner
    const inflight = new Map<string, Inflight>()
    const started = await poll(deps({
      boards: [{ key: 'o/a', repo: 'O/A', root, runner, devMd: 'policy-a', identity: { runner, freshen: async () => {}, token: () => 'token-a' } }],
    }), inflight)
    expect(started.map(runKey)).toEqual(['o/a#1'])
    expect(calls.join('\n')).not.toContain('repos/O/A')
    expect(existsSync(cacheDir(root, 'o/a', 1))).toBe(true)
    expect(readdirSync(join(root, '.vegastack', '.tmp', 'issues'))).toContain('o__a')
    expect(readdirSync(join(root, '.vegastack', '.tmp', 'issues'))).not.toContain('O__A')
    await drain(inflight)
  })

  test('one unreadable board does not prevent another board from starting', async () => {
    const healthy = new FakeGitHub()
    healthy.permissions.set('mk', 'admin')
    healthy.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const bad = context('o/a', root, gh, 'token-a', 'policy-a')
    bad.runner = (() => { throw new Error('board unavailable') }) as GhRunner
    bad.identity = { ...bad.identity, runner: bad.runner }
    const healthyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'worker-healthy-')))
    const notes: string[] = []
    const inflight = new Map<string, Inflight>()
    const started = await poll(deps({
      boards: [bad, context('o/b', healthyRoot, healthy, 'token-b', 'policy-b')],
      out: (line) => notes.push(line),
    }), inflight)
    expect(started.map(runKey)).toEqual(['o/b#1'])
    expect(notes.join('\n')).toContain('o/a: board could not be read')
    await drain(inflight)
  })

  test('one unreadable issue does not prevent its siblings or another board from starting', async () => {
    const other = new FakeGitHub()
    other.permissions.set('mk', 'admin')
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    gh.addIssue({ number: 2, labels: ['planning', 'medium'] })
    other.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const a = context('o/a', root, gh, 'token-a', 'policy-a')
    const baseRunner = a.runner
    const aRunner = ((args: string[], input?: string) => {
      if (args.includes('repos/o/a/issues/1')) throw new Error('issue unavailable')
      return baseRunner(args, input)
    }) as GhRunner
    a.runner = aRunner
    a.identity = { ...a.identity, runner: aRunner }
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'worker-other-')))
    const notes: string[] = []
    const inflight = new Map<string, Inflight>()
    const started = await poll(deps({
      boards: [a, context('o/b', otherRoot, other, 'token-b', 'policy-b')],
      caps: { ...DEFAULT_CAPS, runs: 3 }, out: (line) => notes.push(line),
    }), inflight)
    expect(started.map(runKey)).toEqual(['o/a#2', 'o/b#1'])
    expect(notes.join('\n')).toContain('o/a#1: could not be read')
    await drain(inflight)
  })

  test('real board failures suppress across passes and restart, clear on recovery, and recur once', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-problems-')))
    const output: string[] = []
    let broken = true
    const runner = ((args: string[], input?: string) => {
      if (broken && args.some((arg) => arg.includes('issues?state=open'))) throw new Error('board transport failed')
      return gh.runner(args, input)
    }) as GhRunner
    const selected = { key: 'o/r', repo: 'o/r', root, runner, devMd: '', identity: { runner, freshen: async () => {}, token: () => null } }
    const passWith = async (reporter = workerProblemReporter({ home: stateHome, env: {} }, (line) => output.push(line))) => {
      await poll(deps({ boards: [selected], reportProblem: reporter.report, clearProblem: reporter.clear }), new Map())
    }
    await passWith()
    await reconcileBoards({
      home: stateHome, env: {}, listed: [], previous: readWorkerState({ home: stateHome, env: {} }), contexts: new Map(), inflight: new Map(),
      provision: async () => { throw new Error('unused') }, handBack: async () => ({ ok: true, note: 'done' }), out: () => {},
    })
    await passWith()
    expect(output).toEqual(['o/r: board could not be read (board transport failed)'])
    expect(readWorkerState({ home: stateHome, env: {} }).reports).toEqual({ 'board:o/r': 'board transport failed' })
    broken = false
    await passWith()
    expect(readWorkerState({ home: stateHome, env: {} }).reports).toEqual({})
    broken = true
    await passWith(workerProblemReporter({ home: stateHome, env: {} }, (line) => output.push(line)))
    expect(output).toEqual([
      'o/r: board could not be read (board transport failed)',
      'o/r: board could not be read (board transport failed)',
    ])
  })

  test('real issue failures suppress across passes and restart, clear on recovery, and recur once', async () => {
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-problems-')))
    const output: string[] = []
    gh.addIssue({ number: 96, labels: ['waiting-on-operator', 'small'] })
    let broken = true
    const runner = ((args: string[], input?: string) => {
      if (broken && args.includes('repos/o/r/issues/96')) throw new Error('issue transport failed')
      return gh.runner(args, input)
    }) as GhRunner
    const selected = { key: 'o/r', repo: 'o/r', root, runner, devMd: '', identity: { runner, freshen: async () => {}, token: () => null } }
    const passWith = async (reporter = workerProblemReporter({ home: stateHome, env: {} }, (line) => output.push(line))) => {
      await poll(deps({ boards: [selected], reportProblem: reporter.report, clearProblem: reporter.clear }), new Map())
    }
    await passWith()
    await passWith(workerProblemReporter({ home: stateHome, env: {} }, (line) => output.push(line)))
    expect(output).toEqual(['o/r#96: could not be read (issue transport failed)'])
    expect(readWorkerState({ home: stateHome, env: {} }).reports).toEqual({ 'issue:o/r#96': 'issue transport failed' })
    broken = false
    await passWith()
    expect(readWorkerState({ home: stateHome, env: {} }).reports).toEqual({})
    broken = true
    await passWith()
    expect(output).toHaveLength(2)
  })

  test('every wanted transition runs once and is written down', async () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    gh.addIssue({ number: 2, labels: ['queued', 'small'] })
    const records = await pass()
    expect(steps.map((step) => step.action).sort()).toEqual(['implement', 'plan'])
    expect(records.map((record) => record.outcome)).toEqual(['done', 'done'])
    expect(readRuns(root)).toHaveLength(2)
    // The second pass has nothing left to do: each trigger was acted on.
    expect(await pass()).toEqual([])
  })

  test('a claim from a self-hosted App keeps another dispatcher off the issue', async () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const owner = 'other:worker-abcd1234-1'
    const body = claimBody({ owner, kind: 'worker', harness: 'worker', model: 'plan' })
      .replace('-->\n', `-->\n${claimLine(owner, new Date(gh.clock).toISOString())}\n`)
    gh.addComment(1, body, 'acmefactory[bot]', 'Bot')
    const lines: string[] = []
    expect(await pass({ appActor: 'acmefactory[bot]', out: (line) => lines.push(line) })).toEqual([])
    expect(steps).toEqual([])
    expect(lines).toEqual(['o/r#1: skipped, a fresh claim holds it'])
  })

  test('a step already running keeps its slot and its issue on the next pass', async () => {
    for (const number of [1, 2, 3, 4]) gh.addIssue({ number, labels: ['planning', 'medium'] })
    const inflight = new Map<string, Inflight>()
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const slow: RunStep = async (step) => {
      steps.push({ action: step.action, number: step.number })
      await held
      return { outcome: 'done', note: '', ms: 1 }
    }
    // Three start; the fourth waits for a free slot, and none of the three is started twice.
    expect(await poll(deps({ runStep: slow }), inflight)).toHaveLength(3)
    expect(await poll(deps({ runStep: slow }), inflight)).toEqual([])
    expect(steps).toHaveLength(3)
    release()
    await drain(inflight)
    expect(await poll(deps({ runStep: slow }), inflight)).toHaveLength(1)
    expect(steps.map((step) => step.number).sort()).toEqual([1, 2, 3, 4])
  })

  test('a run takes the claim before it launches, and gives it back when it ends', async () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    // The worker writes with its App's token, so the claim it takes is authored by that App and
    // not by the operator. Leaving this as `mk` — an admin — would have the claim trusted as a
    // person's, and the configured actor would never be exercised at all.
    gh.postAs = { login: 'acmefactory[bot]', type: 'Bot' }
    let heldDuringRun: string | null | undefined
    await pass({
      appActor: 'acmefactory[bot]',
      runStep: (async () => {
        const snap = snapOf(1)
        heldDuringRun = holderOf(snap.state, snap.body, gh.clock, trustedFactory({ repo: 'o/r', runner: gh.runner, root, appActor: 'acmefactory[bot]' })).holder?.owner ?? null
        return { outcome: 'done' as const, note: '', ms: 1 }
      }) as RunStep,
    })
    // A planning run claims for itself: nothing inside it does, so another machine polling the
    // same board while it runs sees the issue is taken.
    expect(heldDuringRun).toBe(`${HOST}:worker-test-1`)
    const after = snapOf(1)
    expect(holderOf(after.state, after.body, gh.clock, trustedFactory({ repo: 'o/r', runner: gh.runner, root, appActor: 'acmefactory[bot]' })).holder).toBeNull()
    expect(gh.issues.get(1)!.comments.map((comment) => comment.body).join('\n')).toContain('by=acmefactory[bot]')
  })

  test('an implement run hands its claim to the session it starts', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    let heldDuringRun: string | null | undefined
    await pass({
      appActor: 'acmefactory[bot]',
      runStep: (async () => {
        const snap = snapOf(1)
        heldDuringRun = holderOf(snap.state, snap.body, gh.clock, trustedFactory({ repo: 'o/r', runner: gh.runner, root })).holder?.owner ?? null
        return { outcome: 'done' as const, note: '', ms: 1 }
      }) as RunStep,
    })
    // dev-implement claims from inside its own worktree, so this machine's reservation steps aside
    // before the agent starts rather than blocking the claim the workflow actually reads.
    expect(heldDuringRun).toBeNull()
    const bodies = gh.issues.get(1)!.comments.map((comment) => comment.body).join('\n')
    expect(bodies).toContain('handing the issue to the run this machine just started')
    expect(bodies).toContain('by=acmefactory[bot]')
  })

  test('two workers on one host do not both start the same issue', async () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const ctx = { root, repo: 'o/r', number: 1, runner: gh.runner }
    // The service and an operator running a pass by hand: same machine, same issue, two processes.
    const service = reserve(ctx, HOST, 'aaaa1111', 'plan', gh.clock)
    const byHand = reserve(ctx, HOST, 'bbbb2222', 'plan', gh.clock)
    expect(service.ok).toBe(true)
    expect(byHand.ok).toBe(false)
    expect(byHand.reason).toContain(service.owner)
    expect(service.owner).not.toBe(byHand.owner)
  })

  test('a machine runs one worker, and a crashed one does not block the box', () => {
    const mine = takeRunLock(root, 'aaaa1111', () => 'Fri Sep 18 09:00:00 2026')
    expect(mine.ok).toBe(true)
    // A second process on this host, while the first is alive: refused.
    const other = takeRunLock(root, 'bbbb2222', (pid) => (pid === process.pid ? 'Fri Sep 18 09:00:00 2026' : 'Fri Sep 18 09:00:00 2026'))
    expect(other.ok).toBe(true) // the same pid is this process re-taking its own lock
    writeFileSync(runLockPath(root), JSON.stringify({ pid: 999_999, startedAt: 'Fri Sep 18 08:00:00 2026', runId: 'cccc3333', at: 'x' }))
    const blocked = takeRunLock(root, 'dddd4444', () => 'Fri Sep 18 08:00:00 2026')
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('another worker is already running on this machine')
    // The same record, but that pid is now somebody else (or nobody): the lock is taken over.
    const taken = takeRunLock(root, 'eeee5555', () => null, () => false)
    expect(taken.ok).toBe(true)
    releaseRunLock(root, 'eeee5555')
    expect(existsSync(runLockPath(root))).toBe(false)

    writeFileSync(runLockPath(root), JSON.stringify({ pid: 999_998, startedAt: 'unknown', runId: 'ffff6666', at: 'x' }))
    const unknown = takeRunLock(root, 'gggg7777', () => null, () => null)
    expect(unknown.ok).toBe(false)
    expect(unknown.reason).toContain('identity cannot be proved')
    expect(existsSync(runLockPath(root))).toBe(true)
    rmSync(runLockPath(root), { force: true })
  })

  test('a claim another machine already holds is not started twice', async () => {
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    // Another machine's worker got there first, between this pass's read and its launch.
    const body = claimBody({ owner: 'builder:worker-1', kind: 'worker', harness: 'worker', model: 'plan' })
    const notes: string[] = []
    const steps: number[] = []
    const racingRunner = ((args: string[], input?: string) => {
      // The rival claim lands just before this machine posts its own, so it is the earlier one.
      const method = args[args.indexOf('-X') + 1]
      const path = args[args.indexOf('-X') + 2] ?? ''
      if (method === 'POST' && path.endsWith('/comments') && !gh.issues.get(1)!.comments.some((c) => c.body.includes('builder:worker-1'))) {
        gh.addComment(1, body.replace('-->\n', `-->\n${claimLine('builder:worker-1', new Date(gh.clock).toISOString())}\n`), 'mk')
      }
      return gh.runner(args, input)
    }) as typeof gh.runner
    await pass({
      out: (text: string) => notes.push(text),
      runStep: (async (step) => { steps.push(step.number); return { outcome: 'done' as const, note: '', ms: 1 } }) as RunStep,
      boards: [{ key: 'o/r', repo: 'o/r', root, runner: racingRunner, devMd: '', identity: { runner: racingRunner, freshen: async () => {}, token: () => 'token-r' } }],
    })
    expect(steps).toEqual([])
    expect(notes.join('\n')).toContain('not started — lost the race to builder:worker-1')
  })

  test('an operator stop reaches a run that is already going', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const inflight = new Map<string, Inflight>()
    let releaseChild = () => {}
    const blocked = new Promise<void>((resolve) => { releaseChild = resolve })
    let stoppedPid = 0
    const slow: RunStep = async (_step, context) => {
      context.onStart?.(7777, 'claude')
      await blocked
      return { outcome: 'failed', note: 'killed', ms: 1 }
    }
    const given: string[] = []
    const shared = {
      runStep: slow,
      stop: (pid: number) => { stoppedPid = pid; releaseChild(); return true },
      start: () => 'Fri Sep 18 09:00:00 2026',
      standDown: (_repo: string, number: number, reason: string) => { given.push(`${number}:${reason}`); return reason },
    }
    // The run is going, and the operator says stop.
    expect(await poll(deps(shared), inflight)).toHaveLength(1)
    gh.addComment(1, 'stop', 'mk')
    const notes: string[] = []
    await poll(deps({ ...shared, out: (text: string) => notes.push(text) }), inflight)
    // The run's process group was ended, waited for, and the issue handed back with the operator's
    // own reason — a scheduler that skipped the issue because it was running would never get here.
    expect(stoppedPid).toBe(7777)
    expect(notes.join('\n')).toContain('stopping the implement run')
    expect(given.join('\n')).toContain('1:@mk said stop')
    expect(inflight.size).toBe(0)
    // The stop is spent, so the next pass does not stop it again.
    const acted = readActed(root)['o/r#1']!
    expect(acted).toMatchObject({ action: 'stop', outcome: 'stopped' })
    expect(readRuns(root).at(-1)).toMatchObject({ action: 'stop', outcome: 'stopped' })
  })

  test('an issue with a fresh claim is skipped', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const body = claimBody({ owner: 'laptop:1-x', kind: 'session', harness: 'claude', model: 'opus' })
    gh.addComment(1, body.replace('-->\n', `-->\n${claimLine('laptop:1-x', new Date(gh.clock).toISOString())}\n`), 'mk')
    const notes: string[] = []
    expect(await pass({ out: (text: string) => notes.push(text) })).toEqual([])
    expect(notes.join('\n')).toContain('a fresh claim holds it')
  })

  test('a stop saves, pushes and releases instead of running an agent', async () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    // The session holding the issue is exactly who a stop is for: taking a claim first would be
    // refused, and the issue would never be put down.
    gh.addComment(1, claimBody({ owner: `${HOST}:1-work`, kind: 'session', harness: 'claude', model: 'opus' })
      .replace('-->\n', `-->\n${claimLine(`${HOST}:1-work`, new Date(gh.clock).toISOString())}\n`), 'mk')
    gh.addComment(1, 'stop', 'mk')
    const given: string[] = []
    const records = await pass({ standDown: (_repo: string, number: number, reason: string) => { given.push(`${number}:${reason}`); return 'saved, pushed, released' } })
    expect(steps).toEqual([])
    expect(given[0]).toContain('1:@mk said stop')
    expect(records[0]).toMatchObject({ action: 'stop', outcome: 'stopped', note: 'saved, pushed, released' })
  })

  test('a subscription limit gives the issue back and retries after the reset', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const given: Array<{ reason: string; restoreTo?: string }> = []
    await pass({
      runStep: runStep({ outcome: 'limit', note: 'usage limit reached; try again after 2026-09-17T15:00:00Z' }),
      standDown: (_repo: string, _number: number, reason: string, restoreTo?: string) => { given.push({ reason, restoreTo }); return reason },
    })
    expect(given[0]!.reason).toContain('subscription limit')
    expect(given[0]!.restoreTo).toBe('queued')
    const acted = readActed(root)['o/r#1']!
    expect(acted.outcome).toBe('limit')
    expect(new Date(acted.retryAt!).toISOString()).toBe('2026-09-17T15:00:00.000Z')
  })

  // Every run that did not finish leaves the issue where a later pass can pick it up: one that
  // stopped at `in-progress` with nobody on it would otherwise never move again.
  test('a timeout and a crash both hand the issue back, not leave it in-progress', async () => {
    const given: Array<{ number: number; reason: string; restoreTo?: string }> = []
    const record = (_repo: string, number: number, reason: string, restoreTo?: string) => { given.push({ number, reason, restoreTo }); return reason }
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    await pass({ runStep: runStep({ outcome: 'killed', note: 'past the limit' }), standDown: record })
    expect(given[0]).toMatchObject({ number: 1, restoreTo: 'queued' })
    expect(given[0]!.reason).toContain('ran past its time limit')

    gh.addIssue({ number: 2, labels: ['planning', 'medium'] })
    await pass({ runStep: (async () => { throw new Error('claude is not on PATH') }) as RunStep, standDown: record })
    expect(given[1]).toMatchObject({ number: 2, restoreTo: 'planning' })
    expect(given[1]!.reason).toContain('failed')
  })

  test('a run that crashed before settling is picked back up once its claim is gone', async () => {
    // The worker died mid-run: the issue is in-progress, nothing is in `acted`, and the claim
    // has gone stale. The next pass resumes it rather than walking past it forever.
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    expect(readActed(root)['o/r#1']).toBeUndefined()
    const started = await poll(deps(), new Map())
    expect(started.map((candidate) => candidate.action)).toEqual(['implement'])
  })

  test('a step that throws is a failed run, not a dead worker', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const throws: RunStep = async () => { throw new Error('claude is not on PATH') }
    const records = await pass({ runStep: throws })
    expect(records[0]).toMatchObject({ outcome: 'failed', note: 'claude is not on PATH' })
    expect(readActed(root)['o/r#1']!.failures).toBe(1)
  })

  test('a stop whose stand-down throws is a failed run, not a dead worker', async () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    gh.addComment(1, 'stop', 'mk')
    const records = await pass({ standDown: () => { throw new Error('git is missing') } })
    expect(records[0]).toMatchObject({ action: 'stop', outcome: 'failed', note: 'git is missing' })
  })

  test('a failed step backs off, and its own error never lands on the issue', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    await pass({ runStep: runStep({ outcome: 'failed', note: 'claude exited 1: ' + 'x'.repeat(5000) }) })
    // The claim and its release are on the issue; the run's own output never is.
    expect(gh.issues.get(1)!.comments.map((comment) => comment.body).join('\n')).not.toContain('xxxx')
    const acted = readActed(root)['o/r#1']!
    expect(acted.failures).toBe(1)
    expect(acted.retryAt).toBeGreaterThan(gh.clock)
    expect(readRuns(root)[0]!.note.length).toBeLessThanOrEqual(400)
  })

  test('a second pass over an unchanged board is one list and a conditional read per issue', async () => {
    for (const number of [1, 2]) gh.addIssue({ number, labels: ['waiting-on-operator', 'medium'] })
    await pass()
    gh.calls = []
    await pass()
    // The list, then the issue and its comments page for each — every one of them an ETag request.
    expect([...gh.calls].sort()).toEqual([
      'GET repos/o/r/issues/1', 'GET repos/o/r/issues/1/comments?per_page=100&page=1',
      'GET repos/o/r/issues/2', 'GET repos/o/r/issues/2/comments?per_page=100&page=1',
      'GET repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=100&page=1',
    ])
  })

  test('the board is the open issues that carry a state label', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    gh.addIssue({ number: 2, labels: ['small'] })
    gh.addIssue({ number: 3, labels: ['ready-to-ship'], state: 'closed' })
    expect(board('o/r', gh.runner).map((issue) => issue.number)).toEqual([1])
  })
})

describe('standing an issue down', () => {
  const held = (owner: string) => {
    const body = claimBody({ owner, kind: 'session', harness: 'claude', model: 'opus' })
    gh.addComment(1, body.replace('-->\n', `-->\n${claimLine(owner, new Date(gh.clock).toISOString())}\n`), 'mk')
  }
  const down = (reason: string) => standDown({ root, repo: 'o/r', number: 1, runner: gh.runner, machine: HOST, now: gh.clock }, reason)

  test('the claim this machine took is released, as the App', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    held(`${HOST}:1-work`)
    expect(down('@mk said stop')).toContain(`released ${HOST}:1-work`)
    const bodies = gh.issues.get(1)!.comments.map((comment) => comment.body)
    expect(bodies.some((body) => body.includes(`type=release owner=${HOST}:1-work by=vegafactory[bot]`) && body.includes('@mk said stop'))).toBe(true)
    // The issue also says what happened, so an operator reading it knows why the run stopped.
    expect(bodies.at(-1)).toContain('type=standdown')
    expect(bodies.at(-1)).toContain('@mk said stop')
    // Released, so the next pass sees a free issue — and one left in-progress is picked back up.
    expect(verdict(1)).toMatchObject({ action: 'implement', reason: 'an interrupted run left it in-progress with no holder' })
    expect(verdict(1, { held: true }).action).toBe('none')
  })

  test('a self-hosted dispatcher names its own actor when it stands down', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    const owner = `${HOST}:1-work`
    const body = claimBody({ owner, kind: 'session', harness: 'claude', model: 'opus' })
      .replace('-->\n', `-->\n${claimLine(owner, new Date(gh.clock).toISOString())}\n`)
    gh.addComment(1, body, 'acmefactory[bot]', 'Bot')
    standDown({ root, repo: 'o/r', number: 1, runner: gh.runner, machine: HOST, appActor: 'acmefactory[bot]', now: gh.clock }, 'the run stopped')
    expect(gh.issues.get(1)!.comments.map((comment) => comment.body).join('\n')).toContain(`type=release owner=${HOST}:1-work by=acmefactory[bot]`)
  })

  test('another machine\'s claim is left alone', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    held('laptop:1-work')
    const result = standDown({ root, repo: 'o/r', number: 1, runner: gh.runner, machine: HOST, now: gh.clock, restoreTo: 'queued' }, 'the subscription limit was reached')
    expect(result).toContain('held by laptop:1-work, so nothing here was touched')
    expect(result).toContain('the state label was left alone')
    expect(gh.issues.get(1)!.labels).toContain('in-progress')
    expect(gh.issues.get(1)!.labels).not.toContain('queued')
  })

  test('an unreadable claim leaves the state label alone', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    let calls = 0
    const runner = ((args: string[], input?: string) => {
      if (calls++ === 0) throw new Error('GitHub is unavailable')
      return gh.runner(args, input)
    }) as typeof gh.runner
    const result = standDown({ root, repo: 'o/r', number: 1, runner, machine: HOST, now: gh.clock, restoreTo: 'queued' }, 'the subscription limit was reached')
    expect(result).toContain('claim could not be read')
    expect(result).toContain('the state label was left alone')
    expect(gh.issues.get(1)!.labels).toContain('in-progress')
    expect(gh.issues.get(1)!.labels).not.toContain('queued')
  })

  test('the strict adapter exposes a swallowed hand-back failure without changing human output', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    const runner = ((args: string[], input?: string) => {
      if (args.includes('POST') && args.some((arg) => arg.includes('/comments'))) throw new Error('GitHub is unavailable')
      return gh.runner(args, input)
    }) as typeof gh.runner
    const ctx = { root, repo: 'o/r', number: 1, runner, machine: HOST, now: gh.clock, restoreTo: 'queued' as const }
    const strict = standDownStrict(ctx, 'the run stopped')
    expect(strict.ok).toBe(false)
    expect(strict.note).toContain('hand-back comment failed')
    expect(standDown(ctx, 'the run stopped')).toContain('hand-back comment failed')
  })

  test('a failing git add is a strict failure and reconciliation keeps the hand-back pending', async () => {
    gh.addIssue({ number: 91, labels: ['queued', 'small'] })
    const worktree = join(root, '.vegastack', '.worktrees', '91-save')
    mkdirSync(worktree, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', 'feat/91-save'], { cwd: worktree })
    spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: worktree })
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: worktree })
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'first'], { cwd: worktree })
    writeFileSync(join(worktree, 'open.txt'), 'unsaved')
    writeFileSync(join(worktree, '.git', 'index.lock'), 'locked')
    const stateHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-reconcile-')))
    const ctx = { root, repo: 'o/r', number: 91, runner: gh.runner, machine: HOST, now: gh.clock, restoreTo: 'queued' as const }
    const previous = {
      schema: 1 as const,
      revision: 0,
      boards: { 'o/r': { repo: 'o/r', state: 'dropping' as const, pending: [{ issue: 91, from: 'queued' as const, reason: 'removed' }] } },
    }
    let strict: ReturnType<typeof standDownStrict> | null = null
    await reconcileBoards({
      home: stateHome, env: {}, listed: [], previous,
      contexts: new Map([['o/r', { key: 'o/r', repo: 'o/r', root, runner: gh.runner, devMd: 'repo: o/r\n', identity: { runner: gh.runner, freshen: async () => {}, token: () => null } }]]),
      inflight: new Map(), provision: async () => { throw new Error('unused') },
      handBack: async (_repo, _issue, reason) => { strict = standDownStrict(ctx, reason); return strict }, out: () => {},
    })
    expect(strict).toMatchObject({ ok: false, note: expect.stringContaining('could not be staged') })
    expect(readWorkerState({ home: stateHome, env: {} }).boards['o/r']).toMatchObject({ state: 'dropping', pending: [{ issue: 91 }] })
  })

  test('a claim taken while this machine stands down leaves the state label alone', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    held(`${HOST}:1-work`)
    gh.afterPost = (body) => {
      if (body.includes('type=standdown')) held('laptop:1-work')
    }
    const result = standDown({ root, repo: 'o/r', number: 1, runner: gh.runner, machine: HOST, now: gh.clock, restoreTo: 'queued' }, 'the subscription limit was reached')
    expect(result).toContain('laptop:1-work claimed it meanwhile, so the state label was left alone')
    expect(gh.issues.get(1)!.labels).toContain('in-progress')
    expect(gh.issues.get(1)!.labels).not.toContain('queued')
  })

  test('with nothing held there is nothing to release', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    expect(down('@mk said stop')).toContain('no live claim to release')
  })

  test('the state label goes back where the run found it', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    held(`${HOST}:1-work`)
    standDown({ root, repo: 'o/r', number: 1, runner: gh.runner, machine: HOST, now: gh.clock, restoreTo: 'queued' }, 'the run failed')
    expect(gh.issues.get(1)!.labels).toContain('queued')
    expect(gh.issues.get(1)!.labels).not.toContain('in-progress')
  })

  // A worktree is a directory, and a directory proves nothing about what may be pushed from it.
  test('only the issue\'s own branch is committed to and pushed', () => {
    const worktree = join(root, '.vegastack', '.worktrees', '1-work')
    mkdirSync(worktree, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree })
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'first'], { cwd: worktree })
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' })
      return { status: result.status, out: (result.stdout ?? '').trim() }
    }
    // Left on the default branch: refused before anything is committed. With an origin that names
    // it, the refusal says so; with no remote at all the branch simply does not name the issue.
    expect(pushableBranch(worktree, 1, git).refusal).toContain('main')
    spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: worktree })
    spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: worktree })
    expect(pushableBranch(worktree, 1, git).refusal).toContain('default branch main')
    // Left on another issue's branch: refused.
    spawnSync('git', ['switch', '-q', '-c', 'feat/9-other'], { cwd: worktree })
    expect(pushableBranch(worktree, 1, git).refusal).toContain('does not name #1')
    // A detached head has no branch to push.
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim()
    spawnSync('git', ['checkout', '-q', head], { cwd: worktree })
    expect(pushableBranch(worktree, 1, git).refusal).toContain('detached head')
    // Its own branch: allowed.
    spawnSync('git', ['switch', '-q', '-c', 'feat/1-work'], { cwd: worktree })
    expect(pushableBranch(worktree, 1, git)).toEqual({ branch: 'feat/1-work', refusal: null })
  })

  test('a foreign claim means the worktree is not touched at all', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    held('laptop:1-work')
    const worktree = join(root, '.vegastack', '.worktrees', '1-work')
    mkdirSync(worktree, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', 'feat/1-work'], { cwd: worktree })
    writeFileSync(join(worktree, 'note.txt'), 'someone else\'s work')
    const note = down('the subscription limit was reached')
    expect(note).toContain('the claim is held by laptop:1-work, so nothing here was touched')
    // Still uncommitted: another machine's claim is not ours to commit under.
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' })
    expect(st.stdout).toContain('note.txt')
  })
})

describe('readiness and the service', () => {
  const answers: Probe = (command) => ({ code: 0, stdout: command === 'claude' ? 'ok' : 'ok\n', stderr: '' })

  test('the CLI counts however this machine spells it', () => {
    mkdirSync(join(root, '.codex'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    // Running the CLI from source is still running the CLI.
    writeFileSync(join(root, '.codex/hooks.json'), '{"command":"vegafactory hook pre-tool --harness codex"}')
    writeFileSync(join(root, '.claude/settings.json'), '{"command":"/Users/x/.bun/bin/bun /repo/packages/cli/src/index.ts hook stop --harness claude"}')
    expect(hooksWired(root).ok).toBe(true)
    // Something that is not the hook command does not count.
    writeFileSync(join(root, '.claude/settings.json'), '{"command":"echo vegafactory is great"}')
    expect(hooksWired(root).ok).toBe(false)
  })

  test('hooks count only when both harnesses call the CLI', () => {
    expect(hooksWired(root).ok).toBe(false)
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.codex/hooks.json'), '{"command":"vegafactory hook pre-tool --harness codex"}')
    expect(hooksWired(root)).toMatchObject({ ok: false, detail: expect.stringContaining('only Codex') })
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude/settings.json'), '{"command":"vegafactory hook pre-tool --harness claude"}')
    expect(hooksWired(root).ok).toBe(true)
  })

  test('each probe is an invocation its tool actually accepts', () => {
    const seen: Array<[string, string[]]> = []
    harnessAnswers((command, args) => { seen.push([command, args]); return { code: 0, stdout: 'ok', stderr: '' } })
    const codex = seen.find(([command]) => command === 'codex')![1]
    // `codex exec` has no approval flag; `-a never` was a usage error, so the check could never
    // pass and enable refused every machine. Sandbox mode is the only thing it needs told.
    expect(codex).toEqual(['exec', '--sandbox', 'read-only', 'say ok'])
    expect(codex).not.toContain('-a')
    const claude = seen.find(([command]) => command === 'claude')![1]
    expect(claude).toEqual(['-p', 'say ok'])
  })

  test('a real turn from each tool is the proof, and a refusal is quoted', () => {
    expect(harnessAnswers(answers).every((check) => check.ok)).toBe(true)
    const dead: Probe = (command) => (command === 'codex' ? { code: 1, stdout: '', stderr: 'stream error: token_revoked' } : { code: 0, stdout: 'ok', stderr: '' })
    const checks = harnessAnswers(dead)
    expect(checks.find((check) => check.name === 'codex')).toMatchObject({ ok: false, detail: expect.stringContaining('token_revoked') })
  })

  test('an API key in the environment fails the readiness check', () => {
    const checks = readiness({ root, listing: listedHere(root, { repo: 'o/r', host: HOST, home }), run: answers, keyOk: true, keyDetail: 'minted', env: { ANTHROPIC_API_KEY: 'sk-ant-x' } })
    expect(checks.find((check) => check.name === 'billing')).toMatchObject({ ok: false, detail: expect.stringContaining('ANTHROPIC_API_KEY') })
  })

  test('a run must be able to push: SSH always, HTTPS only with a login of the machine\'s own', () => {
    const answer = (url: string, loggedIn: boolean): Probe => (command, args) => {
      if (command === 'git') return { code: 0, stdout: `${url}\n`, stderr: '' }
      // Asked with the App's token scrubbed, which is how a run's Git asks.
      if (command === 'env') {
        expect(args.slice(0, 4)).toEqual(['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN'])
        return loggedIn
          ? { code: 0, stdout: 'github.com\n  \u2713 Logged in to github.com account kmanojkumar (keyring)', stderr: '' }
          : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts' }
      }
      return answers(command, args)
    }
    const check = (run: Probe) => readiness({ root, listing: listedHere(root, { repo: 'o/r', host: HOST, home }), run, keyOk: true, keyDetail: 'minted', env: {} }).find((one) => one.name === 'push')!

    // SSH answers no credential helper, so the App's token cannot reach it either way.
    expect(check(answer('git@github.com:o/r.git', false))).toMatchObject({ ok: true })
    expect(check(answer('ssh://git@github.com/o/r.git', false))).toMatchObject({ ok: true })
    // HTTPS is fine when the machine has its own login — that is what a run's Git will get.
    expect(check(answer('https://github.com/o/r.git', true))).toMatchObject({ ok: true, detail: expect.stringContaining('kmanojkumar') })
    // HTTPS with only the App to go on would finish the work and fail at the push.
    expect(check(answer('https://github.com/o/r.git', false))).toMatchObject({ ok: false, detail: expect.stringContaining('gh auth login') })

    const broken: Probe = (command, args) => (command === 'git' ? { code: 128, stdout: '', stderr: 'No such remote' } : answers(command, args))
    expect(check(broken)).toMatchObject({ ok: false, detail: expect.stringContaining('No such remote') })
  })

  // A user service inherits nothing from the shell that installed it. Without these in the unit the
  // worker restarts as VegaStack's own App, against a key it cannot find — and `enable` would have
  // reported success. All three are names; the secret is the key file, not where it lives.
  // The plist writes these two files and the systemd unit did not, so `logDir` was passed to the
  // Linux branch and silently dropped: the log this product tells people to read never appeared.
  test('both platforms write the same two log files', () => {
    const where = { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root) }
    const plist = unitText('darwin', where)
    const unit = unitText('linux', where)
    for (const [text, out, err] of [
      [plist, `<string>${join(workerDir(root), 'worker.log')}</string>`, `<string>${join(workerDir(root), 'worker.err.log')}</string>`],
      [unit, `StandardOutput=append:${join(workerDir(root), 'worker.log')}`, `StandardError=append:${join(workerDir(root), 'worker.err.log')}`],
    ] as const) {
      expect(text).toContain(out)
      expect(text).toContain(err)
    }
    // `append:`, not truncate: a service whose whole job is to be restarted would otherwise lose
    // the log of whatever went wrong last time.
    expect(unit).not.toContain('StandardOutput=file:')
  })

  test('the unit carries everything enable was run with, and no secret', () => {
    const env = { VEGAFACTORY_APP_ID: '12345', VEGAFACTORY_APP_ACTOR: 'acmefactory[bot]', VEGAFACTORY_APP_PRIVATE_KEY_FILE: '/keys/app.pem' }
    const plist = unitText('darwin', { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root), env })
    expect(plist).toContain('<key>EnvironmentVariables</key>')
    expect(plist).toContain('<key>VEGAFACTORY_APP_ID</key><string>12345</string>')
    expect(plist).toContain('<key>VEGAFACTORY_APP_ACTOR</key><string>acmefactory[bot]</string>')
    const unit = unitText('linux', { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root), env })
    expect(unit).toContain('Environment="VEGAFACTORY_APP_ID=12345"')
    expect(unit).toContain('Environment="VEGAFACTORY_APP_ACTOR=acmefactory[bot]"')
    // systemd splits `Environment=` on whitespace and expands `%`, so a path with a space in it
    // has to survive quoting or the started worker looks for a key that is not there.
    // The quotes wrap the whole `NAME=value` item, which is systemd's documented form; `%` is
    // doubled because specifiers expand, and a quote or backslash is escaped.
    const awkward = String.raw`/home/me/App "Keys"\100% mine.pem`
    const spaced = unitText('linux', { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root), env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: awkward } })
    expect(spaced).toContain(String.raw`Environment="VEGAFACTORY_APP_PRIVATE_KEY_FILE=/home/me/App \"Keys\"\\100%% mine.pem"`)
    // Never the unquoted form, whatever the value looks like.
    expect(spaced).not.toMatch(/^Environment=[A-Z]/m)
    expect(plist).toContain('<key>VEGAFACTORY_APP_PRIVATE_KEY_FILE</key><string>/keys/app.pem</string>')
    expect(unit).toContain('Environment="VEGAFACTORY_APP_PRIVATE_KEY_FILE=/keys/app.pem"')
    // The path, never the key. Nothing that could be pasted into a token request appears here.
    for (const text of [plist, unit]) expect(text).not.toContain('BEGIN')

    // Nothing configured, nothing written: VegaStack's own defaults need no unit entries.
    const plain = unitText('linux', { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root), env: {} })
    expect(plain).not.toContain('Environment=')
  })

  test('the unit runs this CLI\'s own worker run and carries no token', () => {
    const plist = unitText('darwin', { cli: ['/usr/bin/node', '/opt/vegafactory/index.js'], root, repo: 'o/r', logDir: workerDir(root) })
    expect(plist).toContain('<string>worker</string>')
    expect(plist).toContain('<string>--repo</string>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).not.toMatch(/token|TOKEN|pem/)
    const unit = unitText('linux', { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root) })
    expect(unit).toContain('ExecStart="vegafactory" "worker" "run" "--repo" "o/r"')
    expect(unit).toContain('Restart=always')
    expect(unitPath('darwin', '/home/x')).toBe('/home/x/Library/LaunchAgents/com.vegastack.vegafactory.worker.plist')
    expect(unitPath('linux', '/home/x')).toBe('/home/x/.config/systemd/user/vegafactory-worker.service')
    expect(serviceCommands('linux', '/u', 'disable')[0]).toEqual(['systemctl', '--user', 'disable', '--now', 'vegafactory-worker.service'])
    expect(serviceCommands('darwin', '/u', 'enable', 501)[1]).toEqual(['launchctl', 'bootstrap', 'gui/501', '/u'])
    // Enabling ends by restarting, on both platforms. `bootstrap` is a no-op once the label is
    // loaded and `enable --now` leaves an active service alone, so without this a re-enable after
    // an upgrade or an identity change reports success while the running worker keeps the old unit.
    // Enabling unloads first, so the plist just written is the one launchd reads.
    expect(serviceCommands('darwin', '/u', 'enable', 501)).toEqual([
      ['launchctl', 'bootout', `gui/501/${SERVICE_NAME}`],
      ['launchctl', 'bootstrap', 'gui/501', '/u'],
      ['launchctl', 'enable', `gui/501/${SERVICE_NAME}`],
    ])
    expect(serviceCommands('linux', '/u', 'enable').at(-1)).toEqual(['systemctl', '--user', 'restart', 'vegafactory-worker.service'])
    // Linger comes first, before anything is loaded. A `--user` service lives inside a login
    // session and systemd ends that session with the last login, so without this an always-on
    // worker dies at logout — quietly, and hours later.
    expect(serviceCommands('linux', '/u', 'enable', 501)[0]).toEqual(['loginctl', 'enable-linger', '501'])
    // Already lingering: setting it is gated by polkit, and asking again would fail on exactly the
    // box where an administrator had just done it — making the documented recovery no recovery.
    expect(serviceCommands('linux', '/u', 'enable', 501, true).flat()).not.toContain('enable-linger')
    expect(serviceCommands('linux', '/u', 'enable', 501, true)[0]).toEqual(['systemctl', '--user', 'daemon-reload'])
    // Reading the property needs no privilege, so it is safe to ask before trying to set it.
    expect(alreadyLingering((() => ({ code: 0, stdout: 'Linger=yes\n', stderr: '' })) as Probe, 501)).toBe(true)
    expect(alreadyLingering((() => ({ code: 0, stdout: 'Linger=no\n', stderr: '' })) as Probe, 501)).toBe(false)
    expect(alreadyLingering((() => ({ code: 1, stdout: '', stderr: 'no such user' })) as Probe, 501)).toBe(false)
    // Disabling leaves it alone: linger is user-wide and other services on this account may rely
    // on it. Recorded as a decision, not an oversight.
    expect(serviceCommands('linux', '/u', 'disable').flat()).not.toContain('linger')
    expect(serviceCommands('darwin', '/u', 'enable', 501).flat()).not.toContain('linger')
  })
})

describe('the step a run makes', () => {
  test('the harness and effort come from dev.md, and `default` pins no model', () => {
    const devMd = readFileSync(join(root, '.vegastack/dev.md'), 'utf8')
    expect(stagePolicy(devMd, 'implement')).toEqual({ harness: 'claude', model: null, effort: 'high' })
    expect(stagePolicy(devMd, 'nothing')).toBeNull()
    expect(agentArgs({ harness: 'claude', model: null, effort: 'high' }, 'go').args).toEqual(['-p', '--dangerously-skip-permissions', '--effort', 'high', 'go'])
    expect(agentArgs({ harness: 'codex', model: 'gpt-5', effort: 'xhigh' }, 'go')).toEqual({ tool: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model=gpt-5', '-c', 'model_reasoning_effort=xhigh', 'go'] })
  })

  // The first worker run read the repository, was denied every write, and handed the issue
  // back untouched. A run that cannot write is not unattended, it is stuck.
  test('both harnesses are told not to stop and ask, because nobody is there to answer', () => {
    expect(agentArgs({ harness: 'claude', model: null, effort: 'high' }, 'go').args).toContain('--dangerously-skip-permissions')
    expect(agentArgs({ harness: 'codex', model: null, effort: 'high' }, 'go').args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  test('the prompt names the issue, the skill and the limits, and never grants a gate', () => {
    const prompt = stepPrompt({ action: 'implement', number: 7, repo: 'o/r', split: false, by: null })
    expect(prompt).toContain('issue #7 in o/r')
    expect(prompt).toContain('dev-implement')
    expect(prompt).toContain('Nothing in this prompt is the operator\'s word')
    expect(stepPrompt({ action: 'plan', number: 7, repo: 'o/r', split: true, by: null })).toContain('sub-issues under an `epic` parent')
  })

  test('a subscription limit is read from the run\'s own words', () => {
    expect(hitLimit('Error: usage limit reached')).toBe(true)
    expect(hitLimit('5-hour limit resets at 3pm')).toBe(true)
    expect(hitLimit('TypeError: undefined is not a function')).toBe(false)
    expect(resetAt('back in 2 hours', 1000)).toBe(1000 + 7_200_000)
    expect(resetAt('nothing readable', 1000)).toBe(1000 + 3_600_000)
    // A timestamp in a log line is not a promise: nothing parks an issue for more than a day.
    expect(resetAt('see 2099-01-01T00:00:00Z', 1000)).toBe(1000 + 24 * 3_600_000)
  })

  test('a run\'s output is bounded, and so is the record of runs', () => {
    expect(tail('a\n'.repeat(1000) + 'last').length).toBeLessThanOrEqual(400)
    for (let i = 0; i < RUNS_KEPT * 2 + 5; i++) {
      recordRun(root, { at: new Date(i).toISOString(), repo: 'o/r', issue: i, action: 'plan', outcome: 'done', ms: 1, machine: HOST, note: '' })
    }
    // Trimmed back to the last RUNS_KEPT each time it doubles, so the file never grows unbounded
    // and the newest run is always there.
    const kept = readRuns(root, RUNS_KEPT * 4)
    expect(kept.length).toBeLessThanOrEqual(RUNS_KEPT * 2)
    expect(kept.at(-1)!.issue).toBe(RUNS_KEPT * 2 + 4)
  })

  test('global run and child records preserve repository identity across a read', () => {
    const stateRoot = join(root, 'machine-state')
    recordRun(stateRoot, { at: '2026-09-21T00:00:00Z', repo: 'o/a', issue: 1, action: 'plan', outcome: 'done', ms: 1, machine: HOST, note: '' })
    recordRun(stateRoot, { at: '2026-09-21T00:00:01Z', repo: 'o/b', issue: 1, action: 'plan', outcome: 'done', ms: 1, machine: HOST, note: '' })
    noteChild(stateRoot, { repo: 'o/a', pid: 7001, startedAt: 'a', command: 'claude', issue: 1, action: 'plan', owner: null, from: 'planning' })
    noteChild(stateRoot, { repo: 'o/b', pid: 7002, startedAt: 'b', command: 'codex', issue: 1, action: 'plan', owner: null, from: 'planning' })
    expect(readRuns(stateRoot).map((row) => `${row.repo}#${row.issue}`)).toEqual(['o/a#1', 'o/b#1'])
    expect(readChildren(stateRoot).map((row) => `${row.repo}#${row.issue}`)).toEqual(['o/a#1', 'o/b#1'])
  })

  test('a step past the limit is killed, and its own output is never the whole record', async () => {
    const seen: Array<{ timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv }> = []
    const exec = async (_tool: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => {
      seen.push({ timeoutMs: options.timeoutMs, cwd: options.cwd, env: options.env })
      return { code: null, stdout: 'x'.repeat(9000), stderr: '', timedOut: true }
    }
    const result = await defaultRunStep({}, { exec })({ action: 'implement', number: 7, repo: 'o/r', split: false, by: null }, { root, devMd: '', token: null })
    expect(seen[0]!.timeoutMs).toBe(STEP_TIMEOUT_MS)
    // Nobody is watching, so a round of questions goes to the issue rather than a question tool.
    expect(seen[0]!.env.VSK_ASK_ROUTE).toBe('issue')
    expect(STEP_TIMEOUT_MS).toBe(20 * 60_000)
    expect(result.outcome).toBe('killed')
    expect(result.note).toContain('past the 20-minute step limit')
  })

  test('a worker run writes as the App and is never told where the key is', async () => {
    let given: NodeJS.ProcessEnv = {}
    const exec = async (_tool: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      given = options.env
      return { code: 0, stdout: 'done', stderr: '', timedOut: false }
    }
    const env = { PATH: '/usr/bin', VEGAFACTORY_APP_PRIVATE_KEY_FILE: '/keys/app.pem', VEGAFACTORY_APP_ID: '12345', VEGAFACTORY_APP_ACTOR: 'acmefactory[bot]', HOME: '/home/x' }
    await defaultRunStep(env, { exec })({ action: 'implement', number: 7, repo: 'o/r', split: false, by: null }, { root, devMd: '', token: 'ghs_from_the_app' })
    // Its writes are the App's, so nothing it posts can pass as a person's word.
    expect(given.GH_TOKEN).toBe('ghs_from_the_app')
    expect(given.GITHUB_TOKEN).toBe('ghs_from_the_app')
    // And it cannot reach the key that mints them.
    expect(given.VEGAFACTORY_APP_PRIVATE_KEY_FILE).toBeUndefined()
    expect(given.VEGAFACTORY_APP_ID).toBe('12345')
    expect(given.VEGAFACTORY_APP_ACTOR).toBe('acmefactory[bot]')
    expect(given.PATH).toBe('/usr/bin')
    // The token is for the API. Git is given a helper that scrubs it first, so it never pushes
    // with a token whose Contents permission is read-only — it gets the machine's own login back
    // instead, and an https remote works exactly as it does for the person at the keyboard.
    expect(given.GIT_CONFIG_COUNT).toBe('2')
    expect(given.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper')
    expect(given.GIT_CONFIG_VALUE_0).toBe('')
    expect(given.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(given.GIT_CONFIG_VALUE_1).toBe('!env -u GH_TOKEN -u GITHUB_TOKEN gh auth git-credential')
    // With no token minted yet the child simply gets none; it never gets the key instead.
    expect(childRunEnvironment(env, null).GH_TOKEN).toBeUndefined()
    expect(childRunEnvironment(env, null).VEGAFACTORY_APP_PRIVATE_KEY_FILE).toBeUndefined()
    // A GIT_CONFIG_* pair already in the environment cannot survive to outrank that reset.
    const smuggled = childRunEnvironment({ ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!gh auth git-credential' }, 'ghs_x')
    expect(smuggled.GIT_CONFIG_VALUE_0).toBe('')
    expect(smuggled.GIT_CONFIG_COUNT).toBe('2')
  })

  test('one board-neutral step receives policy and token per call', async () => {
    const seen: Array<{ tool: string; env: NodeJS.ProcessEnv }> = []
    const exec = async (tool: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      seen.push({ tool, env: options.env })
      return { code: 0, stdout: 'done', stderr: '', timedOut: false }
    }
    const step = defaultRunStep({}, { exec })
    await step({ action: 'implement', number: 1, repo: 'o/a', split: false, by: null }, { root, devMd: 'harness-policy: implement claude default high', token: 'token-a' })
    await step({ action: 'implement', number: 1, repo: 'o/b', split: false, by: null }, { root, devMd: 'harness-policy: implement codex default xhigh', token: 'token-b' })
    expect(seen.map((row) => [row.tool, row.env.GH_TOKEN])).toEqual([['claude', 'token-a'], ['codex', 'token-b']])
  })

  test('a step refuses to start while an API key is in the environment', async () => {
    const exec = async () => ({ code: 0, stdout: 'done', stderr: '', timedOut: false })
    const step = defaultRunStep({ ANTHROPIC_API_KEY: 'sk-ant-x' }, { exec })
    await expect(step({ action: 'implement', number: 7, repo: 'o/r', split: false, by: null }, { root, devMd: '', token: null })).rejects.toThrow(/ANTHROPIC_API_KEY.*subscriptions only/s)
  })
})

describe('legacy worker state migration', () => {
  const names = ['acted.json', 'runs.jsonl', 'children.json', 'run.lock'] as const
  const seed = (legacy: string) => {
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'acted.json'), JSON.stringify({
      'O/R#1': { at: 10, action: 'plan', outcome: 'done', trigger: null, failures: 0, retryAt: null },
      'o/r#2': { at: 5, action: 'plan', outcome: 'failed', trigger: null, failures: 1, retryAt: 20 },
    }))
    writeFileSync(join(legacy, 'runs.jsonl'), `${JSON.stringify({ at: '2026-09-20T00:00:00Z', issue: 1, action: 'plan', outcome: 'done', ms: 1, machine: HOST, note: 'old' })}\n`)
    writeFileSync(join(legacy, 'children.json'), JSON.stringify([
      { pid: 5150, startedAt: 'Fri Sep 18 09:00:00 2026', command: 'claude', issue: 1, action: 'plan', owner: null, from: 'planning' },
    ]))
  }
  const seedGlobal = (stateRoot: string) => {
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(join(stateRoot, 'acted.json'), JSON.stringify({ 'o/r#9': { at: 1, action: 'plan', outcome: 'done', trigger: null, failures: 0, retryAt: null } }))
    writeFileSync(join(stateRoot, 'runs.jsonl'), `${JSON.stringify({ at: '2026-09-19T00:00:00Z', repo: 'o/r', issue: 9, action: 'plan', outcome: 'done', ms: 1, machine: HOST, note: 'global' })}\n`)
    writeFileSync(join(stateRoot, 'children.json'), JSON.stringify([{ repo: 'o/r', pid: 5159, startedAt: 'old', command: 'claude', issue: 9, action: 'plan', owner: null, from: 'planning' }]))
    writeFileSync(join(stateRoot, 'run.lock'), JSON.stringify({ pid: 999998, startedAt: 'gone', runId: 'global', at: 'old' }))
  }
  const bytes = (legacy: string, stateRoot: string) => Object.fromEntries(
    [legacy, stateRoot].flatMap((dir) => names.map((name) => {
      const path = join(dir, name)
      return [`${dir}:${name}`, existsSync(path) ? readFileSync(path, 'utf8') : null]
    })),
  )

  test('a fresh install refuses a symlinked global root before any legacy early return', () => {
    const factoryRoot = join(home, '.vegafactory')
    const stateRoot = join(factoryRoot, 'worker')
    const external = join(home, 'fresh-external-global')
    mkdirSync(factoryRoot, { recursive: true })
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel'), 'kept')
    symlinkSync(external, stateRoot)
    const result = migrateLegacyWorkerState({ root, stateRoot, factoryRoot, repo: 'o/r', alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('kept')
    expect(existsSync(join(external, '.lock'))).toBe(false)
    expect(existsSync(join(external, 'run.lock'))).toBe(false)
  })

  test.each(['root', 'ancestor'] as const)('an equal legacy/global path refuses a symlinked %s without touching its target', (kind) => {
    const factoryRoot = join(root, '.vegastack', '.tmp')
    const stateRoot = join(factoryRoot, 'worker')
    const external = join(home, `equal-path-${kind}`)
    mkdirSync(external)
    let target = external
    if (kind === 'root') {
      mkdirSync(factoryRoot, { recursive: true })
      symlinkSync(external, stateRoot)
    } else {
      target = join(external, 'worker')
      mkdirSync(target)
      symlinkSync(external, factoryRoot)
    }
    writeFileSync(join(target, 'sentinel'), 'kept')
    const result = migrateLegacyWorkerState({ root, stateRoot, factoryRoot, repo: 'o/r', alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('kept')
    expect(existsSync(join(target, '.lock'))).toBe(false)
    expect(existsSync(join(target, 'run.lock'))).toBe(false)
  })

  test('legacy records migrate once with canonical repository identity and remain stoppable', () => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    writeFileSync(runLockPath(legacy), JSON.stringify({ pid: 999999, startedAt: 'old', runId: 'old', at: 'old' }))
    expect(migrateLegacyWorkerState({ root, stateRoot, repo: 'O/R', start: () => null, alive: () => false })).toMatchObject({ ok: true, migrated: true })
    expect(Object.keys(readActed(stateRoot)).sort()).toEqual(['o/r#1', 'o/r#2'])
    expect(readRuns(stateRoot)).toEqual([expect.objectContaining({ repo: 'o/r', issue: 1, note: 'old' })])
    const child = readChildren(stateRoot)[0]!
    expect(child).toMatchObject({ repo: 'o/r', issue: 1, pid: 5150 })
    const stopped: number[] = []
    expect(stopChild(stateRoot, child, { start: () => child.startedAt, stop: (pid) => { stopped.push(pid); return true } })).toBe(true)
    expect(stopped).toEqual([5150])
    for (const name of ['acted.json', 'runs.jsonl', 'children.json', 'run.lock']) expect(existsSync(join(legacy, name))).toBe(false)
    expect(migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => false })).toMatchObject({ ok: true, migrated: false })
  })

  test('a live legacy worker blocks migration and a second worker', () => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    writeFileSync(runLockPath(legacy), JSON.stringify({ pid: 4242, startedAt: 'live', runId: 'old', at: 'then' }))
    const result = migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: (pid) => pid === 4242 ? 'live' : null })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(result.reason).toContain('legacy worker is still running')
    expect(existsSync(join(legacy, 'acted.json'))).toBe(true)
    expect(readRuns(stateRoot)).toEqual([])
  })

  test('an unknown legacy worker identity blocks migration and preserves its lock', () => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    const lock = JSON.stringify({ pid: 4243, startedAt: 'unreadable', runId: 'old', at: 'then' })
    writeFileSync(runLockPath(legacy), lock)
    const result = migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => null })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(result.reason).toContain('identity cannot be proved')
    expect(readFileSync(runLockPath(legacy), 'utf8')).toBe(lock)
    expect(existsSync(join(legacy, 'acted.json'))).toBe(true)
  })

  test('a crash after global writes retries without replaying records', () => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    expect(() => migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => false, afterWrite: () => { throw new Error('crash') } })).toThrow('crash')
    expect(readRuns(stateRoot)).toHaveLength(1)
    expect(migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => false })).toMatchObject({ ok: true, migrated: true })
    expect(readRuns(stateRoot)).toHaveLength(1)
    expect(readChildren(stateRoot)).toHaveLength(1)
  })

  test.each([
    ['legacy', 'acted.json', JSON.stringify({ 'o/r#1': { at: 'wrong' } })],
    ['global', 'acted.json', '[]'],
    ['legacy', 'runs.jsonl', '{not-json}\n'],
    ['global', 'runs.jsonl', `${JSON.stringify({ repo: 'o/r', issue: 1 })}\n`],
    ['legacy', 'children.json', '{}'],
    ['global', 'children.json', JSON.stringify([{ repo: 'o/r', pid: 1 }])],
    ['legacy', 'run.lock', '{not-json'],
    ['global', 'run.lock', JSON.stringify({ pid: 44 })],
  ] as const)('malformed %s %s refuses without changing source or destination bytes', (side, name, content) => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    seedGlobal(stateRoot)
    writeFileSync(join(side === 'legacy' ? legacy : stateRoot, name), content)
    const before = bytes(legacy, stateRoot)
    const result = migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(bytes(legacy, stateRoot)).toEqual(before)
  })

  test('a symlinked record refuses without changing either side', () => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    seedGlobal(stateRoot)
    const target = join(home, 'outside-acted.json')
    writeFileSync(target, '{}')
    rmSync(join(legacy, 'acted.json'))
    symlinkSync(target, join(legacy, 'acted.json'))
    const globalBefore = bytes(stateRoot, stateRoot)
    const result = migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(readFileSync(target, 'utf8')).toBe('{}')
    expect(bytes(stateRoot, stateRoot)).toEqual(globalBefore)
  })

  test('a symlinked legacy worker root is refused before the external target is locked', () => {
    const legacy = workerDir(root)
    const external = join(home, 'external-legacy-root')
    seed(external)
    mkdirSync(join(root, '.vegastack', '.tmp'), { recursive: true })
    symlinkSync(external, legacy)
    const before = bytes(external, external)
    const result = migrateLegacyWorkerState({ root, stateRoot: join(home, '.vegafactory', 'worker'), repo: 'o/r', alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(bytes(external, external)).toEqual(before)
    expect(existsSync(join(external, '.lock'))).toBe(false)
  })

  test('a symlinked legacy intermediate is refused before the external target is locked', () => {
    const external = join(home, 'external-legacy-tmp')
    const externalWorker = join(external, 'worker')
    seed(externalWorker)
    symlinkSync(external, join(root, '.vegastack', '.tmp'))
    const before = bytes(externalWorker, externalWorker)
    const result = migrateLegacyWorkerState({ root, stateRoot: join(home, '.vegafactory', 'worker'), repo: 'o/r', alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(bytes(externalWorker, externalWorker)).toEqual(before)
    expect(existsSync(join(externalWorker, '.lock'))).toBe(false)
  })

  test('a symlinked global worker root is refused before the external target is locked or written', () => {
    const legacy = workerDir(root)
    seed(legacy)
    const factoryRoot = join(home, '.vegafactory')
    const stateRoot = join(factoryRoot, 'worker')
    const external = join(home, 'external-global-root')
    mkdirSync(factoryRoot, { recursive: true })
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel'), 'kept')
    symlinkSync(external, stateRoot)
    const before = bytes(legacy, legacy)
    const result = migrateLegacyWorkerState({ root, stateRoot, factoryRoot, repo: 'o/r', alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(bytes(legacy, legacy)).toEqual(before)
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('kept')
    expect(existsSync(join(external, '.lock'))).toBe(false)
  })

  test('a symlinked global override intermediate is refused without creating anything outside it', () => {
    const legacy = workerDir(root)
    seed(legacy)
    const external = join(home, 'external-override')
    const linked = join(home, 'override-link')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel'), 'kept')
    symlinkSync(external, linked)
    const factoryRoot = join(linked, 'factory')
    const stateRoot = join(factoryRoot, 'worker')
    const before = bytes(legacy, legacy)
    const result = migrateLegacyWorkerState({ root, stateRoot, factoryRoot, repo: 'o/r', alive: () => false })
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(bytes(legacy, legacy)).toEqual(before)
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('kept')
    expect(existsSync(join(external, 'factory'))).toBe(false)
    expect(existsSync(join(external, '.lock'))).toBe(false)
  })

  test('an unreadable record refuses where file permissions are enforced', () => {
    const legacy = workerDir(root)
    const stateRoot = join(home, '.vegafactory', 'worker')
    seed(legacy)
    const path = join(legacy, 'acted.json')
    const before = readFileSync(path, 'utf8')
    chmodSync(path, 0)
    let enforced = false
    try { readFileSync(path, 'utf8') } catch { enforced = true }
    const result = migrateLegacyWorkerState({ root, stateRoot, repo: 'o/r', start: () => null, alive: () => false })
    chmodSync(path, 0o600)
    if (!enforced) return
    expect(result).toMatchObject({ ok: false, migrated: false })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(join(stateRoot, 'acted.json'))).toBe(false)
  })
})

describe('the command', () => {
  const run = (argv: string[], over = {}) => {
    const lines: string[] = []
    return runWorker(argv, { cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, now: () => gh.clock, git: anyGit, ...over })
      .then((code) => ({ code, text: lines.join('\n') }))
  }

  test('an unlisted machine refuses every verb but disable', async () => {
    for (const verb of ['enable', 'status', 'run']) {
      const result = await run([verb, '--once'], { host: 'laptop' })
      expect(result.code).toBe(2)
      expect(result.text).toContain('laptop is not listed')
    }
    expect((await run(['disable', '--dry-run'], { host: 'laptop' })).code).toBe(0)
  })

  test('VEGAFACTORY_HOME gives run, status, disable, and every checkout one global state root', async () => {
    const namedHome = join(home, 'named-factory-home')
    const env = { VEGAFACTORY_HOME: namedHome }
    const stateRoot = join(namedHome, 'worker')
    const defaultRoot = join(home, '.vegafactory', 'worker')
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'worker-other-cwd-')))
    spawnSync('git', ['init', '-q'], { cwd: otherRoot })
    mkdirSync(join(otherRoot, '.vegastack'))
    writeFileSync(join(otherRoot, '.vegastack/dev.md'), readFileSync(join(root, '.vegastack/dev.md'), 'utf8'))

    expect((await run(['run', '--once'], { env })).code).toBe(0)
    expect(existsSync(stateRoot)).toBe(true)
    expect(existsSync(defaultRoot)).toBe(false)

    const statusLines: string[] = []
    expect(await runWorker(['status'], { cwd: otherRoot, home, host: HOST, env, out: (line) => statusLines.push(line), runner: gh.runner, git: anyGit })).toBe(0)
    expect(statusLines.join('\n')).toContain('no worker runs on this machine yet')

    writeFileSync(runLockPath(stateRoot), JSON.stringify({ pid: 4242, startedAt: 'live', runId: 'first-cwd', at: 'then' }))
    const blocked: string[] = []
    expect(await runWorker(['run', '--once'], {
      cwd: otherRoot, home, host: HOST, env, out: (line) => blocked.push(line), runner: gh.runner, git: anyGit,
      start: (pid) => pid === 4242 ? 'live' : 'current',
    })).toBe(2)
    expect(blocked.join('\n')).toContain('another worker is already running on this machine')
    rmSync(runLockPath(stateRoot), { force: true })

    const child = { repo: 'o/r', pid: 5150, startedAt: 'child', command: 'claude', issue: 7, action: 'implement' as const, owner: null, from: 'queued' as const }
    noteChild(stateRoot, child)
    const stopped: number[] = []
    expect(await runWorker(['disable'], {
      cwd: otherRoot, home, host: HOST, env, out: () => {}, runner: gh.runner, git: anyGit,
      run: (() => ({ code: 0, stdout: '', stderr: '' })) as Probe,
      start: (pid) => pid === child.pid ? child.startedAt : null,
      stop: (pid) => { stopped.push(pid); return true },
    })).toBe(0)
    expect(stopped).toEqual([5150])
    expect(readChildren(stateRoot)).toEqual([])
    expect(existsSync(defaultRoot)).toBe(false)
  })

  test('a fresh CLI run refuses a symlinked global-home ancestor without touching its target', async () => {
    const external = join(home, 'fresh-cli-external')
    const linked = join(home, 'fresh-cli-link')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel'), 'kept')
    symlinkSync(external, linked)
    const lines: string[] = []
    const code = await runWorker(['run', '--once'], {
      cwd: root, home, host: HOST, env: { VEGAFACTORY_HOME: join(linked, 'factory') },
      out: (line) => lines.push(line), runner: gh.runner, git: anyGit,
    })
    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('unsafe global worker directory')
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('kept')
    expect(existsSync(join(external, 'factory'))).toBe(false)
    expect(existsSync(join(external, '.lock'))).toBe(false)
  })

  test('an API key in the environment refuses before anything is probed or minted', async () => {
    let probes = 0
    let fetches = 0
    for (const verb of [['run', '--once'], ['enable']]) {
      const result = await run(verb, {
        env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
        run: (() => { probes++; return { code: 0, stdout: 'ok', stderr: '' } }) as Probe,
        fetch: (async () => { fetches++; return { ok: true, status: 200, json: async () => ({ id: 1 }) } }) as Fetch,
      })
      expect(result.code).toBe(2)
      expect(result.text).toContain('ANTHROPIC_API_KEY')
      expect(result.text).toContain('subscriptions only')
    }
    // Both probes spend the operator's own quota and the mint touches GitHub: neither may happen.
    expect([probes, fetches]).toEqual([0, 0])
  })

  test('a partial self-hosted App identity refuses before anything is probed or minted', async () => {
    let probes = 0
    let fetches = 0
    const result = await run(['enable'], {
      env: { VEGAFACTORY_APP_ID: '12345' },
      run: (() => { probes++; return { code: 0, stdout: 'ok', stderr: '' } }) as Probe,
      fetch: (async () => { fetches++; return { ok: true, status: 200, json: async () => ({ id: 1 }) } }) as Fetch,
    })
    expect(result.code).toBe(2)
    expect(result.text).toMatch(/VEGAFACTORY_APP_ID.*VEGAFACTORY_APP_ACTOR.*set together/)
    expect([probes, fetches]).toEqual([0, 0])
  })

  test('status shows the board and this machine\'s runs', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    gh.addIssue({ number: 2, labels: ['ready-to-ship', 'medium'] })
    const result = await run(['status'])
    expect(result.code).toBe(0)
    expect(result.text).toContain(`${'queued'.padEnd(20)} #1`)
    expect(result.text).toContain(`${'ready-to-ship'.padEnd(20)} #2`)
    expect(result.text).toContain('no worker runs on this machine yet')
  })

  // The unit tests for the formatter would stay green if a call site dropped its field argument,
  // which is how `poll 1s` came to be reported as "every 0 minutes" in the first place. These read
  // what the commands actually print.
  test('the caps a command reports can be pasted back into the cell they came from', async () => {
    project(`| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r | step 90m · poll 1s · retry 60m |\n`)
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const result = await run(['status'])
    expect(result.code).toBe(0)
    const line = result.text.split('\n').find((row) => row.startsWith('caps:'))!
    expect(line).toContain('step 90m')
    expect(line).toContain('poll 1s')
    expect(line).toContain('retry 60m')
    // Nothing rounded to zero, and nothing in a unit the parser would refuse.
    expect(line).not.toMatch(/\b0[hms]\b/)
    for (const [field, shown] of [...line.matchAll(/\b(step|poll|retry) (\d+[hms])/g)].map((m) => [m[1]!, m[2]!])) {
      expect(parseCaps(`${field} ${shown}`), `${field} ${shown}`).not.toBeNull()
    }
  })

  test('enable stops at the first thing that is not ready and installs nothing', async () => {
    const result = await run(['enable'], { run: (() => ({ code: 127, stdout: '', stderr: 'not found' })) as Probe, fetch: (async () => ({ ok: false, status: 404, json: async () => ({}) })) as Fetch })
    expect(result.code).toBe(2)
    expect(result.text).toContain('not ready')
    expect(existsSync(unitPath(process.platform, home))).toBe(false)
  })

  test('enable reports a seconds-valued poll cap as seconds', async () => {
    project(`| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r | poll 1s |\n`)
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), 'vegafactory hook stop --harness claude')
    writeFileSync(join(root, '.codex', 'hooks.json'), 'vegafactory hook stop --harness codex')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const key = join(root, 'enable.pem')
    writeFileSync(key, privateKey, { mode: 0o600 })
    chmodSync(key, 0o600)
    const probe: Probe = (command, args) => {
      if (command === 'git') return { code: 0, stdout: 'git@github.com:o/r.git', stderr: '' }
      if (command === 'claude' || command === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const fetch: Fetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_test', expires_at: '2026-09-18T11:00:00Z' },
    })
    const result = await run(['enable'], { platform: 'linux', run: probe, fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(result.code).toBe(0)
    expect(result.text).toContain('enabled —')
    expect(result.text).toContain('polls o/r every 1s')
  })

  // A newline is legal in a Linux filename and passes every check the run makes, then becomes a
  // second physical line inside the unit. Enabling refuses by name rather than installing a
  // service that starts without the setting the operator had just proved.
  test('a value a unit file cannot hold refuses enable by name', async () => {
    for (const bad of ['/keys/two\nlines.pem', '/keys/bell\u0007.pem']) {
      expect(unwritableForUnit({ VEGAFACTORY_APP_PRIVATE_KEY_FILE: bad })).toContain('control character')
    }
    expect(unwritableForUnit({ VEGAFACTORY_APP_ID: '123\n456', VEGAFACTORY_APP_ACTOR: 'a[bot]' })).toContain('VEGAFACTORY_APP_ID')
    // An ordinary path, however awkward, is fine: only control characters are refused.
    expect(unwritableForUnit({ VEGAFACTORY_APP_PRIVATE_KEY_FILE: String.raw`/home/me/App "Keys"/100% mine.pem` })).toBeNull()
    expect(unwritableForUnit({})).toBeNull()

    // And the unit never carries one even if something else reached that far.
    const unit = unitText('linux', { cli: ['vegafactory'], root, repo: 'o/r', logDir: workerDir(root), env: { VEGAFACTORY_APP_ID: 'a\nb' } })
    expect(unit).not.toContain('VEGAFACTORY_APP_ID')

    // Through the real command, because that is where the refusal has to happen — and through the
    // dry run too, which exists to say what the real command would do.
    project(`| node | owner | worker | repos |\n|---|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`)
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), 'vegafactory hook stop --harness claude')
    writeFileSync(join(root, '.codex', 'hooks.json'), 'vegafactory hook stop --harness codex')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const twoLines = join(root, 'two\nlines.pem')
    writeFileSync(twoLines, privateKey, { mode: 0o600 })
    chmodSync(twoLines, 0o600)
    const probe: Probe = (command) => {
      if (command === 'git') return { code: 0, stdout: 'git@github.com:o/r.git', stderr: '' }
      if (command === 'claude' || command === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const fetch: Fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_test', expires_at: '2026-09-18T11:00:00Z' },
    })
    for (const argv of [['enable'], ['enable', '--dry-run']]) {
      const refused = await run(argv, { platform: 'linux', run: probe, fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: twoLines } })
      expect(refused.code).toBe(2)
      expect(refused.text).toContain('control character')
      expect(existsSync(unitPath('linux', home))).toBe(false)
    }
  })

  // The documented recovery is `sudo loginctl enable-linger`. If `enable` then asked for it again
  // it would be denied on exactly the box where an administrator had just done the one thing that
  // was needed — so the way out of the refusal has to work at the command, not only in a helper.
  test('an administrator having set linger is enough for enable to go through', async () => {
    project(`| node | owner | worker | repos |\n|---|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`)
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), 'vegafactory hook stop --harness claude')
    writeFileSync(join(root, '.codex', 'hooks.json'), 'vegafactory hook stop --harness codex')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const key = join(root, 'set-by-admin.pem')
    writeFileSync(key, privateKey, { mode: 0o600 })
    chmodSync(key, 0o600)
    const fetch: Fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_test', expires_at: '2026-09-18T11:00:00Z' },
    })
    const ran: string[][] = []
    const probe: Probe = (command, cmdArgs) => {
      if (command === 'git') return { code: 0, stdout: 'git@github.com:o/r.git', stderr: '' }
      if (command === 'claude' || command === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      ran.push([command, ...cmdArgs])
      // Already on, because an administrator set it.
      if (command === 'loginctl' && cmdArgs[0] === 'show-user') return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
      // And still refused to this account, which is why it was needed.
      if (command === 'loginctl' && cmdArgs[0] === 'enable-linger') return { code: 1, stdout: '', stderr: 'Interactive authentication required.' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await run(['enable'], { platform: 'linux', run: probe, fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(result.code).toBe(0)
    expect(result.text).toContain('enabled —')
    // It never asked, so the denial never happened, and it went on to load the service.
    expect(ran.some((command) => command[1] === 'enable-linger')).toBe(false)
    expect(ran.some((command) => command[0] === 'systemctl' && command.includes('daemon-reload'))).toBe(true)
  })

  // The failure this exists to prevent: an account that cannot grant itself linger gets a unit
  // that loads, works, and dies at the operator's next logout. `enable` has to say so at the
  // moment it can still be fixed, not leave it to be discovered hours later.
  test('a box that cannot grant linger fails loudly instead of dying at logout', async () => {
    project(`| node | owner | worker | repos |\n|---|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`)
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), 'vegafactory hook stop --harness claude')
    writeFileSync(join(root, '.codex', 'hooks.json'), 'vegafactory hook stop --harness codex')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const key = join(root, 'linger.pem')
    writeFileSync(key, privateKey, { mode: 0o600 })
    chmodSync(key, 0o600)
    const fetch: Fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_test', expires_at: '2026-09-18T11:00:00Z' },
    })
    const started: string[][] = []
    const probe: Probe = (command, cmdArgs) => {
      if (command === 'git') return { code: 0, stdout: 'git@github.com:o/r.git', stderr: '' }
      if (command === 'claude' || command === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      started.push([command, ...cmdArgs])
      if (command === 'loginctl') return { code: 1, stdout: '', stderr: 'Could not enable linger: Interactive authentication required.' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const refused = await run(['enable'], { platform: 'linux', run: probe, fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(refused.code).toBe(1)
    expect(refused.text).toContain('loginctl enable-linger')
    expect(refused.text).toContain('Interactive authentication required')
    // It stopped there: nothing was loaded, so no unit is left running that would die at logout.
    expect(started.some((command) => command[0] === 'systemctl')).toBe(false)
  })

  // A machine enabling for the first time has nothing to unload, and launchctl's wording for that
  // is not one string. The unload is allowed to fail; the bootstrap after it is not.
  test('a first enable tolerates the unload, and a real bootstrap failure still stops it', async () => {
    project(`| node | owner | worker | repos |\n|---|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`)
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), 'vegafactory hook stop --harness claude')
    writeFileSync(join(root, '.codex', 'hooks.json'), 'vegafactory hook stop --harness codex')
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const key = join(root, 'first.pem')
    writeFileSync(key, privateKey, { mode: 0o600 })
    chmodSync(key, 0o600)
    const fetch: Fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_test', expires_at: '2026-09-18T11:00:00Z' },
    })
    const answers = (bootstrapCode: number): Probe => (command, cmdArgs) => {
      if (command === 'git') return { code: 0, stdout: 'git@github.com:o/r.git', stderr: '' }
      if (command === 'claude' || command === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      // Nothing loaded yet, and launchctl says so in its own words rather than "already".
      if (command === 'launchctl' && cmdArgs[0] === 'bootout') return { code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' }
      if (command === 'launchctl' && cmdArgs[0] === 'bootstrap') return { code: bootstrapCode, stdout: '', stderr: bootstrapCode ? 'Load failed: 5: Input/output error' : '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const first = await run(['enable'], { platform: 'darwin', run: answers(0), fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(first.code).toBe(0)
    expect(first.text).toContain('enabled —')

    const broken = await run(['enable'], { platform: 'darwin', run: answers(5), fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(broken.code).toBe(1)
    expect(broken.text).toContain('bootstrap')

    // An unload that failed for any other reason left the old job loaded, so what is running is
    // still the old identity. Reporting "enabled" there reports the wrong worker as the new one.
    const denied: Probe = (command, cmdArgs) => {
      if (command === 'launchctl' && cmdArgs[0] === 'bootout') return { code: 1, stdout: '', stderr: 'Boot-out failed: 1: Operation not permitted' }
      return answers(0)(command, cmdArgs)
    }
    const refused = await run(['enable'], { platform: 'darwin', run: denied, fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(refused.code).toBe(1)
    expect(refused.text).toContain('bootout')
    expect(refused.text).toContain('Operation not permitted')

    // "Already loaded" after a successful unload means the unload did not take. It used to be
    // waved through as harmless, which reported the old job as the newly enabled one.
    const stillLoaded: Probe = (command, cmdArgs) => {
      if (command === 'launchctl' && cmdArgs[0] === 'bootstrap') return { code: 5, stdout: '', stderr: 'Load failed: 37: Service is already loaded' }
      return answers(0)(command, cmdArgs)
    }
    const stuck = await run(['enable'], { platform: 'darwin', run: stillLoaded, fetch, env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key } })
    expect(stuck.code).toBe(1)
    expect(stuck.text).toContain('already loaded')
  })

  // End to end, because the unit is only right if `enable` actually passes what it was run with
  // into it. Asserting on `unitText` alone left the wiring untested: the whole feature is that a
  // self-hosted App survives the restart, and a user service inherits nothing from this shell.
  test('enable writes the App identity it was run with into the installed unit', async () => {
    project(`| node | owner | worker | repos |\n|---|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`)
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), 'vegafactory hook stop --harness claude')
    writeFileSync(join(root, '.codex', 'hooks.json'), 'vegafactory hook stop --harness codex')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const key = join(root, 'identity.pem')
    writeFileSync(key, privateKey, { mode: 0o600 })
    chmodSync(key, 0o600)
    const probe: Probe = (command) => {
      if (command === 'git') return { code: 0, stdout: 'git@github.com:o/r.git', stderr: '' }
      if (command === 'claude' || command === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const fetch: Fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_test', expires_at: '2026-09-18T11:00:00Z' },
    })
    const result = await run(['enable'], {
      platform: 'linux', run: probe, fetch,
      env: { VEGAFACTORY_APP_PRIVATE_KEY_FILE: key, VEGAFACTORY_APP_ID: '12345', VEGAFACTORY_APP_ACTOR: 'acmefactory[bot]' },
    })
    expect(result.code).toBe(0)
    const unit = readFileSync(unitPath('linux', home), 'utf8')
    expect(unit).toContain('Environment="VEGAFACTORY_APP_ID=12345"')
    expect(unit).toContain('Environment="VEGAFACTORY_APP_ACTOR=acmefactory[bot]"')
    // The path the run was given travels with it, or token refresh fails on the first poll.
    expect(unit).toContain(`Environment="VEGAFACTORY_APP_PRIVATE_KEY_FILE=${key}"`)
    // The path, never the key itself.
    expect(unit).not.toContain('BEGIN')
  })

  test('run --once makes one pass with the injected step', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const seen: number[] = []
    const result = await run(['run', '--once'], {
      runStep: (async (step) => { seen.push(step.number); return { outcome: 'done', note: '', ms: 1 } }) as RunStep,
    })
    expect(result.code).toBe(0)
    expect(seen).toEqual([1])
    expect(result.text).toContain('#1 implement → done')
  })

  // A profile that exists and cannot be read may be the one saying `off`. Reading it as the
  // shipped `auto` would have this machine fetch and install executable code the operator refused,
  // on the strength of a permission error.
  test('an unreadable profile stops the worker updating itself', () => {
    const box = realpathSync(mkdtempSync(join(tmpdir(), 'worker-policy-')))
    mkdirSync(join(box, '.vegastack'), { recursive: true })

    // No profile at all: a project older than the knob, so the shipped default stands.
    expect(updateModeFor(box, box)).toBe('auto')

    writeFileSync(join(box, '.vegastack', 'dev.md'), 'repo: o/r\nvegafactory-update: notify\n')
    expect(updateModeFor(box, box)).toBe('notify')

    chmodSync(join(box, '.vegastack', 'dev.md'), 0)
    try {
      expect(updateModeFor(box, box)).toBe('off')
    } finally { chmodSync(join(box, '.vegastack', 'dev.md'), 0o644) }
  })

  // A refresh that cannot say where the clone landed is not a refresh that worked: nothing can
  // record the new position, and every later profile read would reject the clone as moved.
  test('a refresh that cannot read its own commit refuses instead of reporting success', () => {
    const answers = (rev: { status: number; out: string }): GitRun => (args) =>
      args[0] === 'rev-parse' && args[1] === 'HEAD' ? rev : { status: 0, out: '' }
    for (const bad of [{ status: 128, out: 'fatal: not a git repository' }, { status: 0, out: '' }, { status: 0, out: 'HEAD' }]) {
      const refused = refreshRoster('/clone', answers(bad))
      expect(refused.ok).toBe(false)
      expect(refused.sha).toBeNull()
      expect(refused.reason).toContain('could not be read')
    }
    const good = refreshRoster('/clone', answers({ status: 0, out: 'b'.repeat(40) }))
    expect(good).toMatchObject({ ok: true, sha: 'b'.repeat(40) })
  })

  // Every pass fast-forwards the control-room clone. `loadProfile` verifies the working tree
  // against the commit `factory.json` remembers, so a record left behind reads a clone that is
  // merely up to date as one that has been tampered with — and every policy question after that
  // answers "cannot tell", which for the update knob means `off` until someone syncs by hand.
  test('a refreshed control room is recorded, so the profile stays readable', async () => {
    const clone = join(home, '.vegafactory', 'control-room', 'o')
    const before = '0'.repeat(40)
    const moved = 'a'.repeat(39) + '9'
    const write = () => writeFileSync(join(home, '.vegafactory', 'factory.json'), JSON.stringify({
      schemaVersion: 2, revision: 0,
      controlRooms: { o: { repo: 'o/room', path: clone, branch: 'main', remote: 'https://example.invalid/o/room.git', sha: before, lastSyncedAt: null } },
    }))
    const recorded = () => JSON.parse(readFileSync(join(home, '.vegafactory', 'factory.json'), 'utf8')).controlRooms.o

    write()
    await recordRoomSha(root, home, moved)
    expect(recorded().sha).toBe(moved)
    // The rest of the record is the sync's, and is left exactly as it was.
    expect(recorded().path).toBe(clone)
    expect(recorded().repo).toBe('o/room')

    // `git` answers a failure on the same channel the sha is read from, so anything that is not a
    // commit is refused rather than written: a record holding error text would have every later
    // profile read reject the clone for being somewhere it has never been.
    for (const notASha of ['', 'fatal: not a git repository', 'HEAD', 'a'.repeat(39), 'A'.repeat(40)]) {
      write()
      await recordRoomSha(root, home, notASha)
      expect(recorded().sha).toBe(before)
    }
  })

  // Idle has to mean idle. A run that starts and settles inside the same pass leaves nothing
  // unsettled behind it, so counting only the run map called a working box idle and let a
  // five-minute install begin while the board still had work.
  test('a pass that started work is not idle, even once that work has settled', async () => {
    project()
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    let updates = 0
    const worked = await run(['run'], {
      update: async () => {
        updates += 1
        return { action: 'current' as const, before: '0.21.0', after: '0.21.0', latest: '0.21.0', message: 'current' }
      },
      // Settles immediately, so the run map is empty again by the time the update is considered.
      runStep: (async () => ({ outcome: 'done' as const, note: 'finished inside the pass', ms: 1 })) as RunStep,
      sleep: async () => { process.emit('SIGTERM' as NodeJS.Signals) },
    })
    expect(worked.code).toBe(0)
    expect(worked.text).toContain('#1')
    expect(updates).toBe(0)
  })

  // An install takes its own five-minute bound and runs in the poll loop. A pass that could not
  // read the whole board has not shown the box is idle — the issue it failed to read may have been
  // the one with work on it — so that is not the pass to spend five minutes in.
  test('a pass that could not read the board does not stop to update', async () => {
    project()
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    let updates = 0
    const counting = async () => {
      updates += 1
      return { action: 'current' as const, before: '0.21.0', after: '0.21.0', latest: '0.21.0', message: 'current' }
    }
    // Every issue read throws, so the pass finishes but knows nothing about the board.
    const broken = await run(['run'], {
      update: counting,
      runner: ((args: string[], input?: string) => (args.some((arg) => String(arg).includes('issues/1')) ? { code: 1, stdout: '', stderr: 'the issue could not be fetched' } : gh.runner(args, input))) as GhRunner,
      sleep: async () => { process.emit('SIGTERM' as NodeJS.Signals) },
    })
    expect(broken.code).toBe(0)
    expect(broken.text).toContain('could not be read')
    expect(updates).toBe(0)
    // The idle pass that *does* update is the test above this one; this is only about the pass
    // that could not see the board.
  })

  test('the worker updates between passes only when no agent is running', async () => {
    let updates = 0
    const idle = await run(['run'], {
      update: async () => {
        updates++
        return { action: 'updated', before: '0.20.1', after: '0.21.0', latest: '0.21.0', message: 'updated vegafactory 0.20.1 → 0.21.0' }
      },
      sleep: async () => { process.emit('SIGTERM' as NodeJS.Signals) },
    })
    expect(idle.code).toBe(0)
    expect(updates).toBe(1)
    expect(idle.text).toContain('updated vegafactory 0.20.1 → 0.21.0; restarting the worker')

    project()
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    updates = 0
    let releaseChild = () => {}
    const blocked = new Promise<void>((resolve) => { releaseChild = resolve })
    const busy = await run(['run'], {
      update: async () => {
        updates++
        return { action: 'current', before: '0.20.1', after: '0.20.1', latest: '0.20.1', message: 'current' }
      },
      runStep: (async (_step, context) => {
        context.onStart?.(7373, 'claude')
        await blocked
        return { outcome: 'killed' as const, note: 'stopped', ms: 1 }
      }) as RunStep,
      stop: () => { releaseChild(); return true },
      start: () => 'Fri Sep 18 09:00:00 2026',
      sleep: async () => { process.emit('SIGTERM' as NodeJS.Signals) },
    })
    expect(busy.code).toBe(0)
    expect(updates).toBe(0)
  })

  test('a row removed upstream stands this machine down, without touching its own copy', async () => {
    const header = '| node | owner | worker | repos |\n|---|---|---|---|\n'
    const delist = controlRoomClone(`${header}| ${NODE} | mk | yes | o/r |\n`)
    const roster = join(home, '.vegafactory', 'control-room', 'o', 'nodes.md')
    const before = readFileSync(roster, 'utf8')
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const lines: string[] = []
    let passes = 0
    const code = await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, now: () => gh.clock,
      runStep: (async () => ({ outcome: 'done' as const, note: '', ms: 1 })) as RunStep,
      // Between the first pass and the second, the control-room PR that de-lists this machine lands
      // — upstream only. Nothing on this machine is edited.
      sleep: async () => { if (++passes === 1) delist(header) },
    })
    expect(readFileSync(roster, 'utf8')).not.toBe(before)
    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('stopping:')
    expect(lines.join('\n')).toContain('is not listed')
  })

  test('a de-listed machine stops the runs it started and hands them back', async () => {
    const header = '| node | owner | worker | repos |\n|---|---|---|---|\n'
    const delist = controlRoomClone(`${header}| ${NODE} | mk | yes | o/r |\n`)
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const lines: string[] = []
    const given: string[] = []
    let stopped = 0
    let passes = 0
    let releaseChild = () => {}
    const blocked = new Promise<void>((resolve) => { releaseChild = resolve })
    const code = await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, now: () => gh.clock,
      // A child that never finishes on its own: only being stopped ends it.
      runStep: (async (_step, context) => {
        context.onStart?.(4242, 'claude')
        await blocked
        return { outcome: 'killed' as const, note: 'stopped', ms: 1 }
      }) as RunStep,
      stop: (pid: number) => { stopped = pid; releaseChild(); return true },
      start: () => 'Fri Sep 18 09:00:00 2026',
      sleep: async () => { if (++passes === 1) delist(header) },
    })
    expect(code).toBe(2)
    expect(stopped).toBe(4242)
    expect(lines.join('\n')).toContain('#1 plan stopped: this machine is no longer listed')
    // The run is recorded as stopped for that reason, not as a failure of the work, and the issue
    // is handed back once — by the run's own settle, after its process group has been waited for.
    expect(lines.join('\n')).toContain('#1 plan → stopped (this machine is no longer listed)')
    const handbacks = gh.issues.get(1)!.comments.filter((comment) => comment.body.includes('type=standdown'))
    expect(handbacks).toHaveLength(1)
    expect(handbacks[0]!.body).toContain('this machine is no longer listed')
    void given
  })

  // A stop nobody asked the issue for must leave the issue exactly as it found it. The run is
  // recorded and handed back, but the trigger stays unspent — otherwise `standDown` puts the issue
  // back as `planning` while `acted` says the plan already ran for that state, and every machine
  // that ever looks at it, including this one after a restart, skips it forever.
  test('an administrative stop does not spend the trigger, so the work is picked up again', async () => {
    const header = '| node | owner | worker | repos |\n|---|---|---|---|\n'
    const listed = `${header}| ${NODE} | mk | yes | o/r |\n`
    const delist = controlRoomClone(listed)
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    let releaseChild = () => {}
    const blocked = new Promise<void>((resolve) => { releaseChild = resolve })
    let passes = 0

    const first = await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: () => {}, runner: gh.runner, now: () => gh.clock,
      runStep: (async (_step, context) => {
        context.onStart?.(5151, 'claude')
        await blocked
        return { outcome: 'killed' as const, note: 'stopped', ms: 1 }
      }) as RunStep,
      stop: () => { releaseChild(); return true },
      start: () => 'Fri Sep 18 09:00:00 2026',
      sleep: async () => { if (++passes === 1) delist(header) },
    })
    expect(first).toBe(2)
    // The issue is back where the run found it, and nobody holds it.
    expect(gh.issues.get(1)!.labels).toContain('planning')

    // The control-room PR is reverted and the machine runs again. It must take the issue up.
    delist(listed)
    const second: string[] = []
    const code = await runWorker(['run', '--once'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => second.push(text), runner: gh.runner, now: () => gh.clock,
      runStep: (async () => ({ outcome: 'done' as const, note: '', ms: 1 })) as RunStep,
    })
    expect(code).toBe(0)
    expect(second.join('\n')).toContain('#1 plan → done')
  })

  // The same thing one state over, and the one the planning case does not reach: standing down
  // posts a comment saying so, and `waiting-on-operator` looks for the operator's reply to be
  // later than anything an agent wrote. A hand-back that counted as work would bury the very reply
  // it was standing down without answering.
  test('a stood-down follow-up still sees the reply it never answered', async () => {
    const header = '| node | owner | worker | repos |\n|---|---|---|---|\n'
    const listed = `${header}| ${NODE} | mk | yes | o/r |\n`
    const delist = controlRoomClone(listed)
    gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
    gh.addComment(1, 'here is the answer you asked for', 'mk')
    let releaseChild = () => {}
    const blocked = new Promise<void>((resolve) => { releaseChild = resolve })
    let passes = 0

    const first = await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: () => {}, runner: gh.runner, now: () => gh.clock,
      runStep: (async (_step, context) => {
        context.onStart?.(6161, 'claude')
        await blocked
        return { outcome: 'killed' as const, note: 'stopped', ms: 1 }
      }) as RunStep,
      stop: () => { releaseChild(); return true },
      start: () => 'Fri Sep 18 09:00:00 2026',
      sleep: async () => { if (++passes === 1) delist(header) },
    })
    expect(first).toBe(2)
    // The hand-back comment is on the issue, and it is the latest thing written.
    expect(gh.issues.get(1)!.comments.some((comment) => comment.body.includes('type=standdown'))).toBe(true)

    delist(listed)
    const second: string[] = []
    const code = await runWorker(['run', '--once'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => second.push(text), runner: gh.runner, now: () => gh.clock,
      runStep: (async () => ({ outcome: 'done' as const, note: '', ms: 1 })) as RunStep,
    })
    expect(code).toBe(0)
    expect(second.join('\n')).toContain('#1 follow-up → done')
  })

  // Two verifications per pass each fetched and merged, and only the first was acted on. A gate
  // asked twice and obeyed once is a gate that can be told "you are de-listed" and carry on.
  test('the roster is verified once a pass, and that one answer is the one acted on', async () => {
    let verifications = 0
    let passes = 0
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: () => {}, runner: gh.runner, now: () => gh.clock,
      runStep: (async () => ({ outcome: 'done' as const, note: '', ms: 1 })) as RunStep,
      git: () => { verifications++; return anyGit() },
      sleep: async () => { if (++passes === 2) process.emit('SIGTERM' as NodeJS.Signals) },
    })
    // One for the gate the command passes before it starts, then exactly one for each pass.
    expect(verifications).toBe(1 + passes)
  })

  test('--json puts one document on stdout and no prose beside it', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const lines: string[] = []
    const code = await runWorker(['run', '--once', '--json'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, now: () => gh.clock,
      runStep: (async () => ({ outcome: 'done' as const, note: '', ms: 1 })) as RunStep,
      git: anyGit,
    })
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    const document = JSON.parse(lines[0]!) as { machine: string; repo: string; runs: { issue: number }[]; notes: string[] }
    expect(document.machine).toBe(HOST)
    expect(document.repo).toBe('o/r')
    expect(document.runs.map((run) => run.issue)).toEqual([1])
    // The lines a human would have read are inside the document, not printed beside it.
    expect(document.notes.join('\n')).toContain('#1 implement')
  })

  // The document answers when a pass ends. An always-on loop has no such moment, so collecting
  // lines for it would hold every line the machine ever printed and answer nobody.
  test('--json without --once refuses rather than holding its answer forever', async () => {
    const lines: string[] = []
    const code = await runWorker(['run', '--json'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, now: () => gh.clock, git: anyGit,
    })
    expect(code).toBe(2)
    expect(JSON.parse(lines[0]!)).toEqual({ ok: false, reason: '--json reports one pass; use it with --once' })
  })

  test('a signal during a blocked run stops it now, not after the next sleep', async () => {
    controlRoomClone(ROSTER)
    gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
    const lines: string[] = []
    let stoppedPid = 0
    let releaseChild = () => {}
    const blocked = new Promise<void>((resolve) => { releaseChild = resolve })
    let sleepStarted = 0
    const code = await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, now: () => gh.clock,
      runStep: (async (_step, context) => {
        context.onStart?.(8888, 'claude')
        // The signal arrives while the run is blocked and the loop is asleep.
        process.emit('SIGTERM' as NodeJS.Signals)
        await blocked
        return { outcome: 'failed' as const, note: 'killed', ms: 1 }
      }) as RunStep,
      stop: (pid: number) => { stoppedPid = pid; releaseChild(); return true },
      start: () => 'Fri Sep 18 09:00:00 2026',
      // A sleep that never finishes: only the signal can end the wait.
      sleep: () => { sleepStarted++; return new Promise<void>(() => {}) },
    })
    // The injected sleep never resolves, so returning at all proves the shutdown did not wait for
    // it — whether the signal arrived before the wait was installed or during it.
    expect(code).toBe(0)
    expect(sleepStarted).toBeLessThanOrEqual(1)
    expect(stoppedPid).toBe(8888)
    expect(lines.join('\n')).toContain('#1 plan stopped: this machine was asked to stop (SIGTERM)')
    // Stopped, waited for, and handed back once — before the command returned.
    expect(gh.issues.get(1)!.comments.filter((comment) => comment.body.includes('type=standdown'))).toHaveLength(1)
    expect(existsSync(runLockPath(root))).toBe(false)
  })

  test('disable stops the runs the service had started, and names what they held', async () => {
    const lines: string[] = []
    const stateRoot = join(home, '.vegafactory', 'worker')
    const live = { repo: 'o/r', pid: 5150, startedAt: 'Fri Sep 18 09:00:00 2026', command: 'claude', issue: 7, action: 'implement' as const, owner: `${HOST}:worker-ab12-7`, from: 'queued' as const }
    noteChild(stateRoot, live)
    const stopped: number[] = []
    const code = await runWorker(['disable'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner,
      run: (() => ({ code: 0, stdout: '', stderr: '' })) as Probe,
      stop: (pid: number) => { stopped.push(pid); return true },
      start: () => live.startedAt,
    })
    expect(code).toBe(0)
    expect(stopped).toEqual([5150])
    expect(lines.join('\n')).toContain('stopped 1 run it had started')
    expect(lines.join('\n')).toContain(`#7 (implement, claimed by ${HOST}:worker-ab12-7)`)
    expect(readChildren(stateRoot)).toEqual([])
  })

  test('a record whose process is gone is dropped, never signalled', async () => {
    const lines: string[] = []
    const stateRoot = join(home, '.vegafactory', 'worker')
    const stale = { repo: 'o/r', pid: 5151, startedAt: 'Fri Sep 18 09:00:00 2026', command: 'claude', issue: 8, action: 'plan' as const, owner: null, from: 'planning' as const }
    noteChild(stateRoot, stale)
    const stopped: number[] = []
    const code = await runWorker(['disable'], {
      cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner,
      run: (() => ({ code: 0, stdout: '', stderr: '' })) as Probe,
      stop: (pid: number) => { stopped.push(pid); return true },
      // The pid has been reused: the process there now started at a different time.
      start: () => 'Fri Sep 18 11:30:00 2026',
    })
    expect(code).toBe(0)
    // Signalling it would have hit somebody else's process.
    expect(stopped).toEqual([])
    expect(readChildren(stateRoot)).toEqual([])
    expect(lines.join('\n')).not.toContain('stopped 1 run')
  })

  test('disable retains a child whose process identity is unknown and never signals it', async () => {
    const stateRoot = join(home, '.vegafactory', 'worker')
    const uncertain = { repo: 'o/r', pid: 5152, startedAt: 'unknown', command: 'claude', issue: 9, action: 'plan' as const, owner: null, from: 'planning' as const }
    noteChild(stateRoot, uncertain)
    const stopped: number[] = []
    const lines: string[] = []
    const code = await runWorker(['disable'], {
      cwd: root, home, host: HOST, env: {}, out: (line) => lines.push(line), runner: gh.runner,
      run: (() => ({ code: 0, stdout: '', stderr: '' })) as Probe,
      start: () => null, alive: () => null,
      stop: (pid) => { stopped.push(pid); return true },
    })
    expect(code).toBe(0)
    expect(stopped).toEqual([])
    expect(readChildren(stateRoot)).toEqual([uncertain])
    expect(lines.join('\n')).not.toContain('stopped 1 run')
  })

  test('a roster this machine cannot prove is not a roster', async () => {
    controlRoomClone(ROSTER)
    const clone = join(home, '.vegafactory', 'control-room', 'o')
    expect(verifiedListing(root, { repo: 'o/r', host: HOST, home }).ok).toBe(true)
    // Edited on the machine: the row is there, and it authorises nothing.
    writeFileSync(join(clone, 'nodes.md'), `| node | owner | worker | repos |\n|---|---|---|---|\n| ${NODE} | mk | yes | * |\n`)
    const edited = verifiedListing(root, { repo: 'o/r', host: HOST, home })
    expect(edited.ok).toBe(false)
    expect(edited.reason).toContain('uncommitted local changes')
    // Unreachable remote: a gate that cannot be refreshed refuses rather than trusting its copy.
    spawnSync('git', ['-C', clone, 'checkout', '-q', '--', 'nodes.md'])
    spawnSync('git', ['-C', clone, 'remote', 'set-url', 'origin', join(home, 'gone.git')])
    const offline = verifiedListing(root, { repo: 'o/r', host: HOST, home })
    expect(offline.ok).toBe(false)
    expect(offline.reason).toContain('could not be refreshed')
    // A plain directory is not a control-room clone at all.
    expect(refreshRoster(join(home, 'not-a-clone')).reason).toContain('not a git clone')
  })

  test('the flags parse and an unknown verb says so', () => {
    expect(parseWorkerArgs(['run', '--once', '--repo', 'o/r', '--json'])).toEqual({ verb: 'run', flags: { repo: 'o/r' }, json: true, dryRun: false, once: true })
    expect(() => parseWorkerArgs(['run', '--repo'])).toThrow('--repo needs a value')
    expect(runWorker(['frobnicate'], { cwd: root, home, host: HOST, env: {}, out: () => {} })).rejects.toThrow('unknown worker verb')
  })
})

// The caps a machine runs with come from its own roster row, because they belong to the machine —
// its processor, its subscription — and not to any project it works.
describe('caps on the roster row', () => {
  test('every field is optional and falls back to the shipped default', () => {
    expect(parseCaps('runs 10 · step 72h · poll 1m')).toEqual({ runs: 10, stepMs: 72 * 3_600_000, pollMs: 60_000, retryMs: RETRY_MS, failures: MAX_FAILURES })
    expect(parseCaps('')).toEqual({ runs: MAX_RUNS, stepMs: STEP_TIMEOUT_MS, pollMs: POLL_MS, retryMs: RETRY_MS, failures: MAX_FAILURES })
  })

  test('a separator with nothing beside it is a half-typed cell, not the defaults', () => {
    // Dropping empty segments would read `runs 10 ·` as "runs 10 and the rest are fine", which is
    // a number nobody finished choosing.
    for (const cell of ['·', 'runs 10 ·', '· runs 10', 'runs 10,,poll 1m', ',']) expect(parseCaps(cell)).toBeNull()
    // A cell that is entirely empty still means "the defaults are fine".
    expect(parseCaps('')).toEqual(DEFAULT_CAPS)
    expect(parseCaps('   ')).toEqual(DEFAULT_CAPS)
  })

  test('a duration reads back in a unit its own field accepts', () => {
    expect(sayDuration(72 * 3_600_000, 'step')).toBe('72h')
    // The case that used to print `0h`.
    expect(sayDuration(parseCaps('step 1m')!.stepMs, 'step')).toBe('1m')
    expect(sayDuration(parseCaps('poll 1s')!.pollMs, 'poll')).toBe('1s')
    // And what is printed can be pasted back into the cell it came from: `poll` and `retry` take
    // no hours, so an hour's worth of either says so in minutes.
    expect(sayDuration(60 * 60_000, 'poll')).toBe('60m')
    expect(sayDuration(60 * 60_000, 'retry')).toBe('60m')
    for (const [field, ms] of [['step', 72 * 3_600_000], ['poll', 60 * 60_000], ['retry', 90 * 60_000]] as const) {
      expect(parseCaps(`${field} ${sayDuration(ms, field)}`)).not.toBeNull()
    }
  })

  test('a cell that names a cap is held to it, value or no value', () => {
    expect(parseCaps('runs ten')).toBeNull()
    expect(parseCaps('step 72 hours')).toBeNull()
    expect(parseCaps('runs')).toBeNull()
    const roster = '| machine | operator | repos | caps |\n|---|---|---|---|\n| a | mk | o/a | runs |'
    expect(parseNodes(roster)[0]!.caps).toBeNull()
  })

  test('units are per field, because a poll in hours is somebody meaning something else', () => {
    expect(parseCaps('poll 2h')).toBeNull()
    expect(parseCaps('step 10s')).toBeNull()
    expect(parseCaps('retry 2h')).toBeNull()
    expect(parseCaps('runs 10m')).toBeNull()
    expect(parseCaps('poll 30s')!.pollMs).toBe(30_000)
    expect(parseCaps('retry 45m')!.retryMs).toBe(45 * 60_000)
  })

  test('a delay no timer can hold is refused, because it would fire at once', () => {
    expect(parseCaps('step 600h')).toBeNull()
    expect(parseCaps('step 500h')!.stepMs).toBe(500 * 3_600_000)
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1)
  })

  test('the header says which column is which, so the roster may reorder and add columns', () => {
    // The shipped template's own order: the owner is the fourth cell, not the second, and a
    // positional read would take `group` for the operator and `yes` for a repository.
    const roster = [
      '| node | group | repos | owner | caps | notes |',
      '|---|---|---|---|---|---|',
      '| patrick | dev | o/a | mk | runs 4 | the always-on box |',
    ].join('\n')
    expect(parseNodes(roster)).toEqual([{ machine: 'patrick', operator: 'mk', repos: ['o/a'], caps: { ...DEFAULT_CAPS, runs: 4 }, worker: false, problem: null }])
  })

  test('prose in a notes column is never caps, whatever words it happens to contain', () => {
    // "runs" in a sentence used to be sniffed out as a caps cell and then refuse the machine.
    const roster = [
      '| machine | operator | repos | caps | notes |',
      '|---|---|---|---|---|',
      '| a | mk | o/a | - | the box that runs the nightly step |',
    ].join('\n')
    expect(parseNodes(roster)[0]!.caps).toEqual(DEFAULT_CAPS)
  })

  test('a caps cell nobody can read keeps its row, so the machine is refused by name', () => {
    const roster = [
      '| machine | operator | repos | caps |',
      '|---|---|---|---|',
      '| patrick | mk | o/a | runs 10 · step 72h |',
      '| broken | mk | o/c | runs ten |',
    ].join('\n')
    const rows = parseNodes(roster)
    expect(rows.map((row) => row.machine)).toEqual(['patrick', 'broken'])
    expect(rows[1]!.caps).toBeNull()
  })

  test('without a header no row is read at all, whatever the cells hold', () => {
    // Caps, a note, or a typo: none of them is guessed at, because nothing says which column any
    // of them sits in. Naming the columns is all it takes.
    for (const row of ['| a | mk | o/a |', '| a | mk | o/a | runs 4 |', '| a | mk | o/a | the box that runs the build |', '| a | mk | o/a | runs ten |']) {
      expect(parseNodes(row)).toEqual([])
    }
    const named = parseNodes('| machine | operator | repos | caps |\n|---|---|---|---|\n| a | mk | o/a | runs 4 |')
    expect(named[0]!.caps).toEqual({ ...DEFAULT_CAPS, runs: 4 })
  })

  test("the shipped template's header is not a machine called worker", () => {
    expect(parseNodes('| node | group | repos | owner | caps | notes |\n|---|---|---|---|---|---|')).toEqual([])
  })
})

describe('the caps reach what they limit', () => {
  test('the step limit arrives with the run, so a roster change lands on the next run', async () => {
    const seen: number[] = []
    const exec = async (_tool: string, _args: string[], options: { timeoutMs: number }) => {
      seen.push(options.timeoutMs)
      return { code: 0, stdout: 'done', stderr: '', timedOut: false }
    }
    const scratch = mkdtempSync(join(tmpdir(), 'vf-limit-'))
    // Built with the shipped default, then handed runs that carry the roster's own limit.
    const step = defaultRunStep({ PATH: '/usr/bin' }, { exec })
    await step({ action: 'implement', number: 1, repo: 'o/r', split: false, by: null }, { root: scratch, devMd: '', token: null, timeoutMs: 72 * 3_600_000 })
    await step({ action: 'implement', number: 2, repo: 'o/r', split: false, by: null }, { root: scratch, devMd: '', token: null, timeoutMs: 4 * 3_600_000 })
    expect(seen).toEqual([72 * 3_600_000, 4 * 3_600_000])
  })

  test('the park cap decides when an issue is left for a person', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const acted = { at: 0, action: 'implement' as const, outcome: 'failed' as const, trigger: null, failures: 2, retryAt: null }
    expect(verdict(1, { acted, failures: 2 }).reason).toContain('needs a person')
    expect(verdict(1, { acted, failures: 5 }).reason ?? '').not.toContain('needs a person')
  })

  // Every failure sets a retry deadline, so asking about the wait first reported a run that had
  // spent its last try as merely due again later — and `park 1` never parked anything.
  test('a run that has spent its tries is parked, not reported as waiting', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const parked = { at: 0, action: 'implement' as const, outcome: 'failed' as const, trigger: null, failures: 1, retryAt: gh.clock + 900_000 }
    expect(verdict(1, { acted: parked, failures: 1 }).reason).toContain('needs a person')
    // One try left, and the wait still standing: that one really is waiting.
    expect(verdict(1, { acted: parked, failures: 2 }).reason).toContain('waiting until')
  })

  // The tests above reach into `schedule`, `decide` and `defaultRunStep` directly, so they would
  // still pass if `runWorker` stopped refreshing the roster or stopped forwarding what it read.
  // This one changes the caps upstream between two real passes and watches what the loop does.
  test('a caps change upstream reaches the next pass: how many start, how long they get, how long it waits', async () => {
    const header = '| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n'
    const row = (caps: string) => `${header}| ${NODE} | mk | yes | o/r | ${caps} |\n`
    const recap = controlRoomClone(row('runs 1 · step 72h · poll 1m'))
    for (const number of [1, 2, 3, 4]) gh.addIssue({ number, labels: ['planning', 'medium'] })

    const startsPerPass: number[] = []
    const timeouts: (number | undefined)[] = []
    const sleeps: number[] = []
    let pass = 0
    let started = 0

    const code = await runWorker(['run'], {
      cwd: root, home, host: HOST, env: {}, out: () => {}, runner: gh.runner, now: () => gh.clock,
      runStep: (async (_step, context) => {
        started++
        timeouts.push(context.timeoutMs)
        return { outcome: 'done' as const, note: '', ms: 1 }
      }) as RunStep,
      sleep: async (ms: number) => {
        startsPerPass.push(started)
        started = 0
        sleeps.push(ms)
        // The control-room PR that loosens this machine's caps lands between the passes.
        if (++pass === 1) recap(row('runs 3 · step 4h · poll 5m'))
        else process.emit('SIGTERM' as NodeJS.Signals)
      },
    })

    expect(code).toBe(0)
    // One run in the first pass because the row said one, three in the second because it said three.
    expect(startsPerPass.slice(0, 2)).toEqual([1, 3])
    // Every run in a pass carries that pass's step limit, not the one the process started with.
    expect(timeouts).toEqual([72 * 3_600_000, 4 * 3_600_000, 4 * 3_600_000, 4 * 3_600_000])
    // And the wait between passes is the poll the roster asked for, each time.
    expect(sleeps.slice(0, 2)).toEqual([60_000, 5 * 60_000])
  })

  test('the run cap is the roster\'s, not the built-in three', () => {
    // Unrelated code runs never go together whatever the cap says — that is the sibling rule, not
    // the cap — so this is the cap on its own, over steps that may run beside each other.
    const many = [1, 2, 3, 4, 5].map((number) => ({ repo: 'o/r', number, action: 'plan' as const, parent: null, files: [], from: 'planning' as const }))
    expect(schedule(many, [], DEFAULT_CAPS.runs)).toHaveLength(3)
    expect(schedule(many, [], 5)).toHaveLength(5)
    expect(schedule(many, [], 1)).toHaveLength(1)
  })
})

// A hand-back that promised a retry the next poll would refuse is a message that teaches the
// operator to distrust the messages.
test('a hand-back promises a retry only when there is a try left', async () => {
  gh.addIssue({ number: 1, labels: ['planning', 'medium'] })
  controlRoomClone(`| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n| ${NODE} | mk | yes | o/r | park 1 |\n`)
  await runWorker(['run', '--once'], {
    cwd: root, home, host: HOST, env: {}, out: () => {}, runner: gh.runner, now: () => gh.clock,
    runStep: (async () => ({ outcome: 'failed' as const, note: 'boom', ms: 1 })) as RunStep,
  })
  const handbacks = gh.issues.get(1)!.comments.filter((comment) => comment.body.includes('type=standdown'))
  expect(handbacks).toHaveLength(1)
  expect(handbacks[0]!.body).toContain('needs a person')
  expect(handbacks[0]!.body).not.toContain('tries again after')
})

// A `handback` is an agent stopping to ask the operator something — the smallest question, a
// missing artifact, a scope ratchet — and it is exactly what their reply answers. Only a machine
// saying it put the issue back is bookkeeping. Confusing the two lets a comment written before
// the question was asked read as the answer to it.
test('an agent asking a question is not bookkeeping, and is not answered by an older comment', () => {
  gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(1, 'here are the details you asked for', 'mk')
  // Then the agent stops and asks something new. The operator has not replied to *this*.
  gh.addComment(1, '<!-- vsk:v1 type=handback -->\nStopping: the plan assumes a queue that does not exist.', 'mk')
  expect(verdict(1).action).toBe('none')

  // A machine standing the issue down says nothing and answers nothing, so the reply before it
  // still counts.
  gh.addIssue({ number: 2, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(2, 'here are the details you asked for', 'mk')
  gh.addComment(2, '<!-- vsk:v1 type=standdown -->\n**box** stood down from #2: this machine is no longer listed', 'mk')
  expect(verdict(2).action).toBe('follow-up')

  // A stand-down is bookkeeping because of its marker, never because of the words in it. A
  // `handback` saying the very same sentence is still an agent stopping to ask.
  gh.addIssue({ number: 3, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(3, 'here are the details you asked for', 'mk')
  gh.addComment(3, '<!-- vsk:v1 type=handback -->\n**box** stood down from #3: this machine is no longer listed', 'mk')
  expect(verdict(3).action).toBe('none')
})

// The field is required, so a dropped argument is a type error rather than a duration printed in
// the wrong units. This pins that, because restoring the default would be a one-character change
// that compiles and quietly reintroduces both bugs it caused.
test('the duration formatter cannot be called without naming its field', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'worker.ts'), 'utf8')
  expect(source).toContain("field: 'step' | 'poll' | 'retry'):")
  expect(source).not.toContain("field: 'step' | 'poll' | 'retry' =")
})

// What makes a comment bookkeeping is its marker, not a sentence inside it. A hand-back may quote
// a stand-down while asking something new, and reading the quote as bookkeeping would let a
// comment written before the question be chosen as its answer.
test('a hand-back is a question whatever it quotes', () => {
  gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(1, 'here are the details you asked for', 'mk')
  gh.addComment(1, '<!-- vsk:v1 type=handback -->\n**box** stood down from #1: this machine is no longer listed\n\nStopping: that leaves the base moving under the plan. Which branch should this build on?', 'mk')
  expect(verdict(1).action).toBe('none')

  // The same sentence and nothing else, still under `handback`: still a question.
  gh.addIssue({ number: 2, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(2, 'here are the details you asked for', 'mk')
  gh.addComment(2, '<!-- vsk:v1 type=handback -->\n**box** stood down from #2: this machine is no longer listed', 'mk')
  expect(verdict(2).action).toBe('none')

  // Under its own marker it is bookkeeping, and the reply before it still counts.
  gh.addIssue({ number: 3, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(3, 'here are the details you asked for', 'mk')
  gh.addComment(3, '<!-- vsk:v1 type=standdown -->\n**box** stood down from #3: this machine is no longer listed', 'mk')
  expect(verdict(3).action).toBe('follow-up')
})

// Advice that ignores the header sends the operator from one refusal straight into the next: a
// three-cell row under the shipped six-column header never reaches its declared caps column.
test('the row it tells you to add is one the same parser accepts', () => {
  const header = '| node | group | repos | worker | owner | caps | notes |\n|---|---|---|---|---|---|---|\n'
  project(`${header}| someone-else | dev | o/r | yes | mk | | |\n`)
  const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
  expect(listing.ok).toBe(false)
  const row = /`(\| .*? \|)`/.exec(listing.reason)![1]!
  // The row names this node, which is what the roster lists now.
  expect(row).toContain(nodeId(undefined, HOST))
  expect(row).toContain('o/r')

  // Paste it under that header and the machine is listed, with the shipped defaults.
  const parsed = parseNodes(`${header}${row}\n`)[0]!
  expect(parsed.machine).toBe(nodeId(undefined, HOST))
  expect(parsed.problem).toBeNull()
  expect(parsed.caps).toEqual(DEFAULT_CAPS)
  expect(parsed.repos).toEqual(['o/r'])
})

// Only a name `machineName` could have produced counts, so a hand-back that opens with emphasis
// and happens to use the same words is still a question.
test('a bold run that is not a machine name does not make a comment bookkeeping', () => {
  gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
  gh.addComment(1, 'here are the details you asked for', 'mk')
  gh.addComment(1, '<!-- vsk:v1 type=handback -->\n**Note to self** stood down from #1: needs a decision on the base', 'mk')
  expect(verdict(1).action).toBe('none')
})

describe('the worker gate', () => {
  const header = '| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n'

  // Once a control room lists every machine, being in the file says only that somebody wrote this
  // machine down. That is what stats wants; it is not what unattended work may take from the
  // same line.
  test('a row is not consent — only `yes` in the worker cell is', () => {
    project(`${header}| ${NODE} | mk | yes | o/r | |\n`)
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).ok).toBe(true)

    project(`${header}| ${NODE} | mk | no | o/r | |\n`)
    const refused = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('not as a worker')
    // The row is still there to point at, so the operator is sent to the cell and not to the file.
    expect(refused.entry?.machine).toBe(NODE)
  })

  test('anything that is not an answer is refused, never read as consent', () => {
    for (const said of ['y', 'true', 'TODO confirm', 'YES please', '1']) {
      project(`${header}| ${NODE} | mk | ${said} | o/r | |\n`)
      const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
      expect(listing.ok, said).toBe(false)
      expect(listing.reason, said).toContain('does not read as an answer')
    }
    // `yes` itself is not case-sensitive, and neither is the blank that means no.
    project(`${header}| ${NODE} | mk | YES | o/r | |\n`)
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).ok).toBe(true)
    project(`${header}| ${NODE} | mk |  | o/r | |\n`)
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).reason).toContain('not as a worker')
  })

  // The commonest row on a roster that names every machine is a laptop with an empty repos cell.
  // Reading that as "every repository in the org" would hand the whole board to the machine that
  // was written down precisely to say it is not a worker.
  test('an empty repos cell authorises nothing when the roster has a worker column', () => {
    project(`${header}| ${NODE} | mk | yes |  | |\n`)
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('for no repository')
  })

  // There are no rosters written before the gate — the only control room that exists is being
  // written now — so a file with no `worker` column grants nothing rather than everything.
  test('a roster with no worker column grants nothing', () => {
    project(`| machine | operator | repos |\n|---|---|---|\n| ${NODE} | mk | yes | o/r |\n`)
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('no `worker` column')
  })

  test('`*` and `all` still mean every repository, on either shape', () => {
    project(`${header}| ${NODE} | mk | yes | * | |\n`)
    expect(listedHere(root, { repo: 'o/anything', host: HOST, home }).ok).toBe(true)
    project(`${header}| ${NODE} | mk | yes | all | |\n`)
    expect(listedHere(root, { repo: 'o/anything', host: HOST, home }).ok).toBe(true)
  })
})

describe('a node answers to its own name', () => {
  // The roster names `<os-user>@<hostname>`, and `machineName` maps every non-alphanumeric to a
  // dash — it would turn `mk@patrick-mac-mini` into `mk-patrick-mac-mini` and no row would match.
  test('a node id in the roster matches the machine it names', () => {
    const header = '| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n'
    project(`${header}| ${nodeId(undefined, HOST)} | mk | yes | o/r | |\n`)
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).ok).toBe(true)
    expect(rosterName('mk@Patrick-Mac-Mini.local')).toBe(nodeId('mk', 'patrick-mac-mini'))
  })

  // One spelling, and only one: two rows could otherwise name this machine and a roster could
  // grant through either.
  test('a bare hostname is not this node', () => {
    const header = '| node | owner | worker | repos |\n|---|---|---|---|\n'
    project(`${header}| ${HOST} | mk | yes | o/r |\n`)
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('is not listed')
  })

  // Somebody writing the gate and missing the name meant to gate something. Reading it as "no
  // gate at all" would grant every row in the file.
  test('a heading that nearly names the gate grants nothing', () => {
    for (const heading of ['workers', 'worker?', 'Worker (y/n)']) {
      project(`| node | owner | ${heading} | repos |\n|---|---|---|---|\n| ${nodeId(undefined, HOST)} | mk | yes | o/r |\n`)
      const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
      expect(listing.ok, heading).toBe(false)
      expect(listing.reason, heading).toContain('not named `worker`')
    }
  })

  // A row pasted from the refusal is a row somebody is adding so this machine can work a board.
  test('the row it tells you to add says yes in the gate', () => {
    const header = '| node | owner | worker | repos | caps |\n|---|---|---|---|---|\n'
    project(`${header}| someone-else | mk | yes | o/r | |\n`)
    const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
    const row = /`(\| .*? \|)`/.exec(listing.reason)![1]!
    const parsed = parseNodes(`${header}${row}\n`)[0]!
    expect(parsed.worker).toBe(true)
    expect(parsed.repos).toEqual(['o/r'])
    expect(parsed.problem).toBeNull()
  })
})

// A row pasted under a header with no gate would be refused by the very next check, so the advice
// has to name what is actually missing rather than hand over a row that cannot work.
test('an unlisted machine on a gateless roster is told about the column, not given a row', () => {
  project(`| node | owner | repos |\n|---|---|---|\n| someone-else | mk | o/r |\n`)
  const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
  expect(listing.ok).toBe(false)
  expect(listing.reason).toContain('no `worker` column')
  expect(listing.reason).not.toMatch(/add the row/)
})

describe('a node name is exactly one name', () => {
  // `mk@box@anything` cut down to `mk@box` would let a row nobody wrote authorise the real node.
  test('more than one @, or an empty half, names nothing', () => {
    for (const bad of ['mk@box@anything', '@box', 'mk@', '@', 'mk@@box']) expect(rosterName(bad), bad).toBe('')
    expect(rosterName('mk@box')).toBe(nodeId('mk', 'box'))
  })

  test('a row naming one of those authorises nobody', () => {
    const header = '| node | owner | worker | repos |\n|---|---|---|---|\n'
    project(`${header}| ${NODE}@extra | mk | yes | o/r |\n`)
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).ok).toBe(false)
  })

  // A row that vanishes is a machine that looks unlisted, rather than one whose notes column
  // happens to hold a dash.
  test('a dash in a notes cell does not delete the row', () => {
    const header = '| node | owner | worker | repos | notes |\n|---|---|---|---|---|\n'
    project(`${header}| ${NODE} | mk | yes | o/r | -- |\n`)
    expect(listedHere(root, { repo: 'o/r', host: HOST, home }).ok).toBe(true)
  })
})

// A name whose halves normalise to nothing becomes the very name a machine falls back to when it
// cannot read its own identity, which would authorise that machine.
test('a name that normalises to nothing authorises nobody', () => {
  for (const bad of ['!!!@???', '---@...', '@@']) expect(rosterName(bad), bad).toBe('')
})

// The remediation branch for a roster with no header at all: pasting a row there cannot work,
// so the advice has to name the header.
test('an unlisted machine on a headerless roster is told to add the header', () => {
  project(`| someone-else | mk | o/r |\n`)
  const listing = listedHere(root, { repo: 'o/r', host: HOST, home })
  expect(listing.ok).toBe(false)
  expect(listing.reason).toContain('no `worker` column')
  expect(listing.reason).toContain('| node | owner | worker | repos | caps |')
  expect(listing.reason).not.toMatch(/add the row/)
})

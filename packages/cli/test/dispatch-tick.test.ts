// The tick as a whole, with the network and the harness stubbed: what runTick asks gh for, what it
// launches, and what it writes to the state file. The pure decision functions have their own tests
// in dispatch.test.ts; these cover the seams between them, which is where the review found the
// silent drops.
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scopeDigest } from '../../../skills/dev/dev-implement/scripts/lib/approval.mjs'

process.env.VSK_PREFLIGHT_SCRIPT = resolve(import.meta.dir, '../../../skills/dev/dev-implement/scripts/preflight.mjs')
import { executeRun, fetchBoard, fetchRockets, readLock, readState, repoLockPath, runOnce, runTick, settleRuns, watch, writeState, type PlannedRun, type RunOutcome, type RunTracker, type TickDeps } from '../src/dispatch.ts'
import { parseFactoryConfig } from '../src/config.ts'

const SHIP_POLICY = resolve(import.meta.dir, '../../../skills/dev/dev-setup/scripts/ship-policy.mjs')
const GUARD_BYTES = readFileSync(resolve(import.meta.dir, '../../../skills/dev/dev-setup/assets/hooks/ship-guard.mjs'))
process.env.VSK_SHIP_POLICY_SCRIPT = SHIP_POLICY

const CLAUDE_WIRING = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness claude' }] }] } })
const CODEX_WIRING = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness codex' }] }] } })

interface FixtureOptions {
  repos?: string[]
  devMd?: string
  maxRuns?: number
}

// One home with one or more opted-in repos, each wired for Claude in its main checkout.
function fixture(options: FixtureOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vf-tick-'))
  const names = options.repos ?? ['app']
  const devMd = options.devMd ?? 'dispatch: local\noperators: mk\nplan: claude fable-5-1 high\nimplement: claude fable-5-1 high\n'
  const repos = names.map(name => {
    const path = join(home, name)
    mkdirSync(join(path, '.vegastack/hooks'), { recursive: true })
    mkdirSync(join(path, '.claude'), { recursive: true })
    writeFileSync(join(path, '.vegastack/hooks/ship-guard.mjs'), GUARD_BYTES)
    writeFileSync(join(path, '.claude/settings.json'), CLAUDE_WIRING)
    writeFileSync(join(path, '.vegastack/dev.md'), devMd)
    expect(Bun.spawnSync(['git', 'init', '-q', path]).exitCode).toBe(0)
    expect(Bun.spawnSync(['git', '-C', path, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`]).exitCode).toBe(0)
    const compiled = Bun.spawnSync(['node', SHIP_POLICY, '--write', '--json'], { cwd: path, env: { ...process.env, HOME: home } })
    expect(compiled.exitCode, compiled.stdout.toString()).toBe(0)
    return { path, repo: `acme/${name}`, org: 'acme' }
  })
  const config = parseFactoryConfig({ repos, maxRuns: options.maxRuns ?? 1 }, home)
  return { home, config, repos }
}

interface SearchRow { number: number; title: string; labels: string[]; assignees?: string[]; updated_at?: string }

// A gh that answers searches from a table and records every query it was asked.
function ghStub(rows: { needsPlan?: SearchRow[]; ready?: SearchRow[]; forOperator?: SearchRow[] }, extra?: (args: string[]) => string | null) {
  const queries: string[] = []
  const calls: string[][] = []
  const answer = async (args: string[]): Promise<string> => {
    const endpoint = /^repos\/(acme\/[^/]+)\/issues\/(\d+)(.*)$/.exec(args[1] ?? '')
    if (endpoint && (args.includes('--slurp') || endpoint[3] === '')) {
      const custom = extra?.(args)
      if (custom !== null && custom !== undefined && args.includes('--slurp')) {
        const value = JSON.parse(custom)
        // Existing rocket fixtures describe the same comment history. Add scoped
        // intent to those histories, while explicit nested-page fixtures stand.
        if (Array.isArray(value) && value.every(Array.isArray)) return custom
      }
      const number = Number(endpoint[2])
      const row = [...(rows.needsPlan ?? []), ...(rows.ready ?? []), ...(rows.forOperator ?? [])].find(row => row.number === number)
      const labels = row?.labels ?? ['ready']
      const body = '<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\nBuild the fixture.\n'
      const planBody = '<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: fixture** <!-- task-id:' + number + '-T1 -->\n'
      if (endpoint[3] === '') return JSON.stringify({ number, node_id: 'brief-' + number, body, state: 'open', labels: [...labels, ...(labels.some(label => ['research', 'quick-build', 'full-plan'].includes(label)) ? [] : ['quick-build'])].map(name => ({ name })), assignees: (row?.assignees ?? []).map(login => ({ login })) })
      if (endpoint[3] === '/dependencies/blocked_by') return '[[]]'
      if (endpoint[3] === '/comments') {
        const artifacts = [{ repo: endpoint[1], issue: number, kind: 'brief', artifactId: 'brief-' + number, rev: 1, digest: scopeDigest(body, 'brief') }, { repo: endpoint[1], issue: number, kind: 'plan', artifactId: 'plan-' + number, rev: 1, digest: scopeDigest(planBody, 'plan') }]
        const intent = { schemaVersion: 2, id: 'intent-' + number, operator: 'mk', scope: 'brief+plan', source: { kind: 'session', ref: 'session:fixture', quote: 'I approve these fixture artifacts.' }, artifacts, supersedes: [], revokes: [] }
        return JSON.stringify([[{ id: number * 100 + 1, node_id: 'plan-' + number, body: planBody }, { id: number * 100 + 2, body: '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(intent) + '\n```\n' }]])
      }
    }
    if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: 'mk' })
    const custom = extra?.(args)
    if (custom !== null && custom !== undefined) return custom
    if (args[0] === 'api' && args.includes('search/issues')) {
      const q = args[args.indexOf('-f') + 1]!.slice(2)
      queries.push(q)
      const pick = q.includes('label:needs-plan') ? rows.needsPlan : q.includes('label:ready') ? rows.ready : rows.forOperator
      const items = (pick ?? []).map(row => ({
        number: row.number, title: row.title,
        labels: row.labels.map(name => ({ name })),
        assignees: (row.assignees ?? []).map(login => ({ login })),
        updated_at: row.updated_at ?? '2026-09-03T09:00:00Z',
      }))
      return JSON.stringify({ items })
    }
    if (args[0] === 'issue' && args.includes('body')) return JSON.stringify({ body: '' })
    return '[]'
  }
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args)
    if (!args.includes('--include')) return answer(args)
    const url = new URL(args[1]!, 'https://api.github.com/')
    const path = url.pathname.slice(1)
    if (/^repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
      queries.push(path)
      const values = [...(rows.needsPlan ?? []), ...(rows.ready ?? []), ...(rows.forOperator ?? [])]
      return responsePage(values.map(row => ({ ...row, id: row.number, node_id: `I${row.number}`, labels: row.labels.map(name => ({ name })), assignees: (row.assignees ?? []).map(login => ({ login })) })))
    }
    const normalized = ['api', path, '--paginate']
    const custom = extra?.(normalized)
    const slurped = await answer([...normalized, '--slurp'])
    const value = JSON.parse(slurped)
    const flat = Array.isArray(value) && value.every(Array.isArray) ? value.flat() : value
    // A single real comments collection serves both corrections and scoped approval reads.
    const additional = custom ? JSON.parse(custom) : []
    const data = /\/comments$/.test(path) && Array.isArray(additional) && !additional.every(Array.isArray)
      ? [...flat, ...additional] : flat
    return responsePage(data)
  }
  return { gh, queries, calls }
}

const ensureWorktree: TickDeps['ensureWorktree'] = async (repoPath, issue, title) => {
  const slug = title.replace(/^[a-z]+:\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const path = join(repoPath, '.vegastack', '.worktrees', `${issue}-${slug}`)
  mkdirSync(join(path, '.vegastack/hooks'), { recursive: true })
  writeFileSync(join(path, '.vegastack/hooks/ship-guard.mjs'), GUARD_BYTES)
  mkdirSync(join(path, '.claude'), { recursive: true })
  writeFileSync(join(path, '.claude/settings.json'), CLAUDE_WIRING)
  writeFileSync(join(path, '.vegastack/dev.md'), readFileSync(join(repoPath, '.vegastack/dev.md')))
  return { path, branch: `feat/${issue}-${slug}`, slug, type: 'feat' }
}

// Unit-only metadata fixture; actual harness behavior remains #158 qualification.
const harnessMetadata: TickDeps['harnessMetadata'] = plan => plan.command === 'codex'
  ? { version: 'codex-cli 0.153.4', hookApplicable: true, memoryRetrievalDisabled: true, memoryGenerationDisabled: true, features: { hooks: true, memories: false, external_agent_memory_import: false, context_management: false } }
  : { version: '2.1.263 (Claude Code)', hookApplicable: true, memoryRetrievalDisabled: true, memoryGenerationDisabled: true }

const finished = (run: PlannedRun): RunOutcome => ({ started: true, exitCode: 0, timedOut: false, logFile: `/logs/${run.issue}.jsonl`, pushed: true, handedBack: false })

describe('the corrections window (F17, F18)', () => {
  // A 🚀 on an existing comment does not move the issue's updated_at, and a comment posted while a
  // run was in flight lands before the next window opens. Neither may be dropped: every
  // for-operator issue is read on every tick, and the handled list is what stops the repeats.
  test('a second tick still asks for every for-operator issue, and finds a bare rocket on an old comment', async () => {
    const { home, config } = fixture()
    await writeState(config.stateFile, { lastTick: { 'acme/app': '2026-09-03T10:00:00Z' }, handled: [] })
    const { gh, queries } = ghStub({ forOperator: [{ number: 12, title: 'feat: thing', labels: ['for-operator'], assignees: ['mk'], updated_at: '2026-09-03T09:00:00Z' }] }, args => {
      if (args[0] === 'api' && args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([{ id: 555, reactions: { rocket: 1 } }])
      if (args[0] === 'api' && args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 999, content: 'rocket', user: { login: 'mk' } }])
      return null
    })
    const result = await runTick(config, { dryRun: true }, { harnessMetadata, gh, ensureWorktree, execute: async run => finished(run), parentCandidates: async () => [] })
    expect(queries.some(q => q.includes('updated:'))).toBe(false)
    expect(result.runs.map(run => [run.issue, run.stage])).toEqual([[12, 'corrections']])
    expect(existsSync(home)).toBe(true)
  })

  test('a comment whose rockets are all handled costs no reactions call', async () => {
    const calls: string[][] = []
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args)
      const path = args[1]!.split('?')[0]
      if (path === 'repos/acme/app/issues/12/comments') return responsePage([{ id: 555, reactions: { rocket: 1 } }, { id: 556, reactions: { rocket: 2 } }])
      if (path === 'repos/acme/app/issues/comments/556/reactions') return responsePage([{ id: 1001, content: 'rocket', user: { login: 'mk' } }, { id: 1002, content: 'rocket', user: { login: 'ada' } }])
      return responsePage([])
    }
    const corrections = [{ number: 12, title: 'feat: thing', labels: ['for-operator'], assignees: ['mk'], updatedAt: '' }]
    const handled = [{ repo: 'acme/app', issue: 12, commentId: 555, reactionId: 999 }, { repo: 'acme/app', issue: 12, commentId: 556, reactionId: 1001 }]
    const rockets = await fetchRockets(gh, 'acme/app', corrections, handled)
    expect(calls.some(call => call[1] === 'repos/acme/app/issues/comments/555/reactions')).toBe(false)
    expect(rockets.map(rocket => rocket.reactionId)).toEqual([1001, 1002])
  })

  test('lastTick is the time the board was read, not the time the runs finished', async () => {
    const { config } = fixture()
    const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    let clock = Date.parse('2026-09-03T10:00:00Z')
    const now = () => new Date(clock)
    const execute = async (run: PlannedRun): Promise<RunOutcome> => {
      clock += 40 * 60 * 1000
      return finished(run)
    }
    await runTick(config, { dryRun: false }, { harnessMetadata, gh, now, ensureWorktree, execute, parentCandidates: async () => [] })
    const state = await readState(config.stateFile)
    expect(state.lastTick['acme/app']).toBe('2026-09-03T10:00:00Z')
  })
})

// An execute stub whose runs finish only when the test says so.
function deferredExecute() {
  const pending: Array<{ run: PlannedRun; resolve: () => void }> = []
  const execute: TickDeps['execute'] = (run, _plan, _config, options): Promise<RunOutcome> => new Promise(resolve => {
    options.onSpawn?.()
    pending.push({ run, resolve: () => resolve(finished(run)) })
  })
  return { execute, pending, finishAll: () => { for (const entry of pending.splice(0)) entry.resolve() } }
}

describe('runs leave the tick (F19)', () => {
  test('a run in flight on one repo does not stop the next repo from being read the same tick', async () => {
    const { config } = fixture({ repos: ['app', 'web'] })
    const { gh, queries } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const { execute, pending, finishAll } = deferredExecute()
    const tracker: RunTracker = new Map()
    const result = await runTick(config, { dryRun: false }, { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker })
    expect(pending).toHaveLength(2)
    expect(queries.filter(q => q === 'repos/acme/web/issues')).toHaveLength(1)
    expect(result.runs.map(run => [run.repo, run.launched, run.exitCode])).toEqual([['acme/app', true, undefined], ['acme/web', true, undefined]])
    finishAll()
    await settleRuns(tracker)
    expect(result.runs.map(run => run.exitCode)).toEqual([0, 0])
  })

  test('the next tick counts the run as active: at maxRuns the repo is refused, and after it ends the repo is free again', async () => {
    const { config } = fixture()
    const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const { execute, finishAll } = deferredExecute()
    const tracker: RunTracker = new Map()
    const deps = { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker }
    const first = await runTick(config, { dryRun: false }, deps)
    expect(first.runs).toHaveLength(1)
    const lock = await readLock(repoLockPath(config, 'acme/app'))
    expect(lock).toEqual({ held: true, pid: process.pid })
    const second = await runTick(config, { dryRun: false }, deps)
    expect(second.runs).toEqual([])
    expect(second.refusals[0]!.reason).toContain('maxRuns 1 with 1 in flight')
    finishAll()
    await settleRuns(tracker)
    expect((await readLock(repoLockPath(config, 'acme/app'))).held).toBe(false)
    const third = await runTick(config, { dryRun: false }, deps)
    expect(third.runs).toHaveLength(1)
    finishAll()
    await settleRuns(tracker)
  })

  test('with room in maxRuns, an issue whose run is still in flight is refused by name rather than started twice', async () => {
    const { config } = fixture({ maxRuns: 3 })
    const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const { execute, pending, finishAll } = deferredExecute()
    const tracker: RunTracker = new Map()
    const deps = { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker }
    await runTick(config, { dryRun: false }, deps)
    const second = await runTick(config, { dryRun: false }, deps)
    expect(pending).toHaveLength(1)
    expect(second.runs).toEqual([])
    expect(second.refusals.map(refusal => refusal.reason).join('\n')).toContain('#8 already has a run in flight')
    finishAll()
    await settleRuns(tracker)
  })

  test('a reaction is recorded as handled when its run starts, so the next tick does not start it again', async () => {
    const { config } = fixture({ maxRuns: 3 })
    const { gh } = ghStub({ forOperator: [{ number: 12, title: 'feat: thing', labels: ['for-operator'], assignees: ['mk'] }] }, args => {
      if (args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([{ id: 555, reactions: { rocket: 1 } }])
      if (args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 999, content: 'rocket', user: { login: 'mk' } }])
      return null
    })
    const { execute, finishAll } = deferredExecute()
    const tracker: RunTracker = new Map()
    const deps = { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker }
    const first = await runTick(config, { dryRun: false }, deps)
    expect(first.runs.map(run => run.stage)).toEqual(['corrections'])
    expect((await readState(config.stateFile)).handled).toEqual([{ repo: 'acme/app', issue: 12, commentId: 555, reactionId: 999 }])
    finishAll()
    await settleRuns(tracker)
    const second = await runTick(config, { dryRun: false }, deps)
    expect(second.runs).toEqual([])
  })

  test('--once waits for the runs it started, so its report carries their exit codes', async () => {
    const { config } = fixture()
    const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const { execute, pending } = deferredExecute()
    const tracker: RunTracker = new Map()
    const once = runOnce(config, { dryRun: false }, { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker })
    let settled = false
    void once.then(() => { settled = true })
    const deadline = Date.now() + 3000
    while (pending.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(pending).toHaveLength(1)
    expect(settled).toBe(false)
    pending[0]!.resolve()
    const result = await once
    expect(result.runs[0]!.exitCode).toBe(0)
  })

  test('the watch loop keeps ticking while a run is in flight', async () => {
    const { config } = fixture()
    const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const { execute, pending, finishAll } = deferredExecute()
    const tracker: RunTracker = new Map()
    const ticks: number[] = []
    const looped = watch({ ...config, interval: 1 }, {
      dryRun: false,
      ticks: 2,
      onTick: result => { ticks.push(result.runs.length) },
    }, { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker })
    const secondTick = new Promise<void>(resolve => {
      const poll = setInterval(() => { if (ticks.length === 2) { clearInterval(poll); resolve() } }, 20)
    })
    await secondTick
    expect(pending).toHaveLength(1)
    expect(ticks).toEqual([1, 0])
    finishAll()
    await looped
  })
})

describe('the guard is checked for the harness and the checkout that will run (F21, F22)', () => {
  const mixed = 'dispatch: local\noperators: mk\nplan: codex gpt-5.6 high\nimplement: claude fable-5-1 high\n'

  test('a plan run on a harness the guard is not wired for is refused by name, while implement runs on the wired one', async () => {
    const { config } = fixture({ devMd: mixed, maxRuns: 3 })
    const { gh } = ghStub({ needsPlan: [{ number: 7, title: 'feat: a', labels: ['needs-plan'] }], ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const result = await runTick(config, { dryRun: true }, { harnessMetadata, gh, ensureWorktree, execute: async run => finished(run), parentCandidates: async () => [] })
    expect(result.runs.map(run => run.issue)).toEqual([8])
    const refusal = result.refusals.find(entry => entry.issue === 7)!
    expect(refusal.reason).toContain('.codex/hooks.json')
    expect(refusal.reason).toContain('codex')
  })

  test('a profile with no plan entry refuses the needs-plan issue by name instead of throwing out of the tick', async () => {
    const { config } = fixture({ devMd: 'dispatch: local\noperators: mk\nimplement: claude fable-5-1 high\n', maxRuns: 3 })
    const { gh } = ghStub({ needsPlan: [{ number: 7, title: 'feat: a', labels: ['needs-plan'] }], ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const result = await runTick(config, { dryRun: true }, { harnessMetadata, gh, ensureWorktree, execute: async run => finished(run), parentCandidates: async () => [] })
    expect(result.runs.map(run => run.issue)).toEqual([8])
    expect(result.refusals.find(entry => entry.issue === 7)!.reason).toContain('no harness policy for the plan stage')
  })

  test('a worktree that lacks the harness wiring the main checkout has is refused before anything launches', async () => {
    const { config } = fixture()
    const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: b', labels: ['ready'] }] })
    const launched: number[] = []
    // A fresh checkout: tracked files only, so the gitignored .claude/settings.json is not there.
    const bare: TickDeps['ensureWorktree'] = async (repoPath, issue) => {
      const path = join(repoPath, '.vegastack', '.worktrees', `${issue}-b`)
      mkdirSync(join(path, '.vegastack/hooks'), { recursive: true })
      writeFileSync(join(path, '.vegastack/hooks/ship-guard.mjs'), GUARD_BYTES)
      return { path, branch: `feat/${issue}-b`, slug: 'b', type: 'feat' }
    }
    const tracker: RunTracker = new Map()
    const result = await runTick(config, { dryRun: false }, { harnessMetadata, gh, ensureWorktree: bare, execute: async run => { launched.push(run.issue); return finished(run) }, parentCandidates: async () => [], tracker })
    await settleRuns(tracker)
    expect(launched).toEqual([])
    expect(result.runs).toEqual([])
    const refusal = result.refusals.find(entry => entry.issue === 8)!
    expect(refusal.reason).toContain(join('.vegastack', '.worktrees', '8-b'))
    expect(refusal.reason).toContain('worktree-include:')
  })

  test('a worktree that carries the wiring launches, and a codex plan run is checked against its own file there', async () => {
    const { config } = fixture({ devMd: mixed, maxRuns: 3 })
    const { gh } = ghStub({ needsPlan: [{ number: 7, title: 'feat: a', labels: ['needs-plan'] }] })
    for (const entry of config.repos) {
      mkdirSync(join(entry.path, '.codex'), { recursive: true })
      writeFileSync(join(entry.path, '.codex/hooks.json'), CODEX_WIRING)
    }
    const withCodex: TickDeps['ensureWorktree'] = async (repoPath, issue, title) => {
      const target = await ensureWorktree(repoPath, issue, title)
      mkdirSync(join(target.path, '.codex'), { recursive: true })
      writeFileSync(join(target.path, '.codex/hooks.json'), CODEX_WIRING)
      return target
    }
    const launched: string[] = []
    const tracker: RunTracker = new Map()
    const result = await runTick(config, { dryRun: false }, { harnessMetadata, gh, ensureWorktree: withCodex, execute: async (run, plan) => { launched.push(plan.command); return finished(run) }, parentCandidates: async () => [], tracker })
    await settleRuns(tracker)
    expect(launched).toEqual(['codex'])
    expect(result.refusals).toEqual([])
  })
})

describe('the parallel path launches the implement harness (F28)', () => {
  test('a codex-implement repo launches codex for a parent-parallel run, and its guard check reads the codex wiring', async () => {
    const { config } = fixture({ devMd: 'dispatch: local\noperators: mk\nplan: codex gpt-5.6 high\nimplement: codex gpt-5.6 high\n', maxRuns: 3 })
    const repoPath = config.repos[0]!.path
    // The main checkout is wired for Codex and only Codex; so is the parent worktree.
    mkdirSync(join(repoPath, '.codex'), { recursive: true })
    writeFileSync(join(repoPath, '.codex/hooks.json'), CODEX_WIRING)
    const parentWorktree = join(repoPath, '.vegastack/.worktrees/104-parent')
    mkdirSync(join(parentWorktree, '.vegastack/hooks'), { recursive: true })
    writeFileSync(join(parentWorktree, '.vegastack/hooks/ship-guard.mjs'), GUARD_BYTES)
    mkdirSync(join(parentWorktree, '.codex'), { recursive: true })
    writeFileSync(join(parentWorktree, '.codex/hooks.json'), CODEX_WIRING)
    writeFileSync(join(parentWorktree, '.vegastack/dev.md'), readFileSync(join(repoPath, '.vegastack/dev.md')))
    const { gh } = ghStub({ ready: [{ number: 131, title: 'feat: x', labels: ['ready'] }, { number: 132, title: 'feat: y', labels: ['ready'] }] })
    const parentCandidates: TickDeps['parentCandidates'] = async () => [{
      parent: { issue: 104, branch: 'feat/104-parent', head: 'abc1234', worktree: parentWorktree },
      groups: [{ id: 'a', members: ['#131'], files: ['a.ts'] }, { id: 'b', members: ['#132'], files: ['b.ts'] }],
      children: [{ number: 131, parent: 104, assignee: null, labels: ['ready'] }, { number: 132, parent: 104, assignee: null, labels: ['ready'] }],
    }]
    const result = await runTick(config, { dryRun: true }, { harnessMetadata, gh, ensureWorktree, execute: async run => finished(run), parentCandidates })
    expect(result.refusals).toEqual([])
    expect(result.runs.map(run => [run.issue, run.launch.command])).toEqual([[104, 'codex']])
    expect(result.runs[0]!.launch.args).not.toContain('--allowed-tools')
  })
})


test('a ready marker-only issue never reaches execute or worktree creation', async () => {
  const { config } = fixture()
  const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: scoped', labels: ['ready'] }] }, args => args[1] === 'repos/acme/app/issues/8/comments' && args.includes('--slurp') ? JSON.stringify([[{ id: 2, body: '<!-- vsk:v1 type=approval -->' }]]) : null)
  let executions = 0; let worktrees = 0
  const result = await runTick(config, { dryRun: false }, { harnessMetadata, gh, parentCandidates: async () => [], ensureWorktree: async (...args) => { worktrees++; return ensureWorktree(...args) }, execute: async run => { executions++; return finished(run) } })
  expect(executions).toBe(0)
  expect(worktrees).toBe(0)
  expect(result.refusals.some(refusal => refusal.reason.includes('approval'))).toBe(true)
})


test('F4 full caller: unrelated registration refuses before execute with real current compiler policy', async () => {
  const { config, repos } = fixture()
  writeFileSync(join(repos[0]!.path, '.claude/settings.json'), JSON.stringify({ unrelated: { command: 'echo ship-guard.mjs' } }))
  const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'] }] })
  let launched = 0
  const result = await runTick(config, { dryRun: false }, { harnessMetadata, gh, ensureWorktree, execute: async run => { launched++; return finished(run) }, parentCandidates: async () => [] })
  expect(launched).toBe(0)
  expect(result.refusals.some(r => r.reason.includes('PreToolUse'))).toBe(true)
})

test('a profile edited after sync refuses before any worktree or execute', async () => {
  const { config, repos } = fixture()
  writeFileSync(join(repos[0]!.path, '.vegastack/dev.md'), readFileSync(join(repos[0]!.path, '.vegastack/dev.md'), 'utf8') + 'gates: 2\n')
  const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'] }] })
  let launched = 0
  const result = await runTick(config, { dryRun: false }, { harnessMetadata, gh, ensureWorktree, execute: async run => { launched++; return finished(run) }, parentCandidates: async () => [] })
  expect(launched).toBe(0)
  expect(result.refusals.some(r => r.reason.includes('stale'))).toBe(true)
})

// Positive caller integration remains red until the actual guard reader and managed
// metadata are compatible. The executor uses only a harmless external fixture here;
// this tests reaction bookkeeping, not vendor qualification or remote delivery.
test('actual executor OS refusal retains corrections for a later real spawn', async () => {
  const { home, config, repos } = fixture()
  const repo = repos[0]!.path, command = join(home, 'retry.sh'), entered = join(home, 'entered')
  const { gh } = ghStub({ forOperator: [{ number: 12, title: 'feat: thing', labels: ['for-operator'], assignees: ['mk'] }] }, args => {
    if (args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([{ id: 555, reactions: { rocket: 1 } }])
    if (args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 999, content: 'rocket', user: { login: 'mk' } }])
    return null
  })
  const tracker: RunTracker = new Map()
  const deps = { gh, tracker, parentCandidates: async () => [],
    ensureWorktree: async () => ({ path: repo, branch: 'fixture-running', slug: 'thing', type: 'feat' }),
    execute: (run: PlannedRun, plan: Parameters<TickDeps['execute']>[1], cfg: typeof config, options: Parameters<TickDeps['execute']>[3]) =>
      executeRun(run, { ...plan, command, args: [entered] }, cfg, options,
        { gh, git: async () => ({ ok: true, message: '' }) }),
  }
  const refused = await runTick(config, { dryRun: false }, deps)
  await settleRuns(tracker)
  expect(refused.runs).toEqual([])
  expect(refused.refusals.some(r => r.reason.includes('harness process did not start'))).toBe(true)
  expect((await readState(config.stateFile)).handled).toEqual([])
  expect(existsSync(entered)).toBe(false)
  // An actual executable now exists; no internal metadata/logging call count is observed.
  writeFileSync(command, '#!/bin/sh\necho entered > "$1"\n')
  chmodSync(command, 0o755)
  const retried = await runTick(config, { dryRun: false }, deps)
  await settleRuns(tracker)
  expect(retried.refusals).toEqual([])
  expect(retried.runs[0]!.launched).toBe(true)
  expect(readFileSync(entered, 'utf8')).toBe('entered\n')
  expect((await readState(config.stateFile)).handled).toHaveLength(1)
}, 15000)


test('unsupported managed harness metadata refuses before execute', async () => {
  const { config } = fixture()
  const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'] }] })
  let launched = 0
  const result = await runTick(config, { dryRun: false }, { gh, ensureWorktree, harnessMetadata: () => ({ version: 'unknown' }),
    execute: async run => { launched++; return finished(run) }, parentCandidates: async () => [] })
  expect(launched).toBe(0)
  expect(result.refusals.some(r => r.reason.includes('unsupported Claude version'))).toBe(true)
})

for (const harness of ['claude', 'codex'] as const) for (const parallel of [false, true]) {
  test(`real Git ${parallel ? 'parent' : 'ordinary'} prepared worktree uses its ${harness} guard and compiler`, async () => {
    const { config, repos } = fixture({ devMd: `dispatch: local\noperators: mk\nimplement: ${harness} fixture high\n`, maxRuns: 3 })
    const repo = repos[0]!.path
    if (harness === 'codex') {
      mkdirSync(join(repo, '.codex'))
      writeFileSync(join(repo, '.codex/hooks.json'), CODEX_WIRING)
    }
    const git = (args: string[]) => {
      const result = Bun.spawnSync(['git', '-C', repo, ...args])
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString().trim()
    }
    writeFileSync(join(repo, '.gitignore'), '.claude/\n.vegastack/.worktrees/\n')
    git(['add', '.vegastack/hooks/ship-guard.mjs', '.vegastack/dev.md', '.gitignore', ...(harness === 'codex' ? ['.codex/hooks.json'] : [])])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
    const prepared = join(repo, '.vegastack/.worktrees/104-prepared')
    git(['worktree', 'add', '-q', '-b', 'fixture-prepared', prepared])
    expect(readFileSync(join(prepared, '.git'), 'utf8')).toContain('gitdir:')
    // The ordinary worktree-include operation copies only this known ignored hook file.
    if (harness === 'claude') {
      mkdirSync(join(prepared, '.claude'))
      writeFileSync(join(prepared, '.claude/settings.json'), CLAUDE_WIRING)
    }
    const { gh } = ghStub({ ready: parallel
      ? [{ number: 131, title: 'feat: a', labels: ['ready'] }, { number: 132, title: 'feat: b', labels: ['ready'] }]
      : [{ number: 104, title: 'feat: prepared', labels: ['ready'] }] })
    const parentCandidates: TickDeps['parentCandidates'] = async () => parallel ? [{
      parent: { issue: 104, branch: 'fixture-prepared', head: git(['rev-parse', 'HEAD']), worktree: prepared },
      groups: [{ id: 'a', members: ['#131'], files: ['a.ts'] }, { id: 'b', members: ['#132'], files: ['b.ts'] }],
      children: [{ number: 131, parent: 104, assignee: null, labels: ['ready'] }, { number: 132, parent: 104, assignee: null, labels: ['ready'] }],
    }] : []
    const tracker: RunTracker = new Map()
    const actual: string[] = []
    const result = await runTick(config, { dryRun: false }, { gh, harnessMetadata, parentCandidates, tracker,
      ensureWorktree: async () => ({ path: prepared, branch: 'fixture-prepared', slug: 'prepared', type: 'feat' }),
      execute: async (run, plan) => { actual.push(plan.cwd); return finished(run) },
    })
    await settleRuns(tracker)
    expect(result.refusals).toEqual([])
    expect(actual).toEqual([prepared])
    expect(result.runs[0]!.remoteEffectCoverage).toEqual({ kind: 'unmanaged-possible', reasonCode: 'hook-configuration-only' })
  })
}

const responsePage = (rows: unknown[], next?: string, status = 200) => `HTTP/2.0 ${status} Status\r\nx-test: 1\r\n${next ? `link: <${next}>; rel="next"\r\n` : ''}\r\n${JSON.stringify(rows)}`

test('142 reproduction: fetchBoard returns all 31 repository rows instead of three truncated searches', async () => {
  const calls: string[][] = []
  const all = Array.from({ length: 31 }, (_, index) => ({ id: index + 1, node_id: `I${index + 1}`, number: index + 1, title: 'row', labels: [{ name: 'ready' }], assignees: [] }))
  const out = await fetchBoard(async args => {
    calls.push(args)
    if (args.includes('search/issues')) return JSON.stringify({ items: all.slice(0, 30), total_count: 31, incomplete_results: false })
    return responsePage(all)
  }, 'a/b')
  expect(out.items).toHaveLength(31)
  expect(out.complete).toBe(true)
  expect(calls).toHaveLength(1)
})

test('142 fetchBoard filters PRs after 101-plus rows and deduplicates stable IDs', async () => {
  const rows = Array.from({ length: 103 }, (_, index) => ({ id: index + 1, node_id: `I${index + 1}`, number: index + 1, title: 'row', labels: [{ name: 'ready' }], assignees: [], ...(index < 2 ? { pull_request: {} } : {}) }))
  let calls = 0
  const snapshot = await fetchBoard(async () => ++calls === 1 ? responsePage(rows.slice(0, 100), 'https://api.github.com/repos/a/b/issues?page=2') : responsePage([rows[99], ...rows.slice(100)]), 'a/b')
  expect(snapshot.complete).toBe(true)
  expect(snapshot.items).toHaveLength(101)
  expect(snapshot.items[0]!.number).toBe(3)
  expect(snapshot.items.at(-1)!.number).toBe(103)
  expect(calls).toBe(2)
})

// These tests isolate the pagination decision through the existing transport/guard seams.
// The real managed-launch positive controls above remain, including their inherited failures.
test('142 isolated runTick refuses a failed later board page before any claim or correction', async () => {
  const { config } = fixture()
  let calls = 0, claims = 0, executions = 0
  const result = await runTick(config, { dryRun: false }, {
    shipGuard: async () => ({ wired: true, detail: 'pagination test seam only' }),
    gh: async () => ++calls === 1 ? responsePage([{ id: 1, number: 1, title: 'ready', labels: [{ name: 'ready' }], assignees: [] }], 'https://api.github.com/repos/acme/app/issues?page=2') : responsePage([], undefined, 403),
    ensureWorktree: async () => { claims++; throw new Error('must not claim') },
    execute: async () => { executions++; throw new Error('must not execute') },
  })
  expect(calls).toBe(2); expect(claims).toBe(0); expect(executions).toBe(0)
  expect(result.runs).toEqual([])
  expect(result.refusals.map(row => row.reason).join()).toContain('HTTP 403')
  expect((await readState(config.stateFile)).handled).toEqual([])
})

test('142 isolated runTick uses actual approval reader and refuses later comments/dependency pages', async () => {
  for (const collection of ['comments', 'dependencies/blocked_by']) {
    const { config } = fixture()
    const base = ghStub({ ready: [{ number: 8, title: 'feat: approved', labels: ['ready'] }] })
    let pages = 0, claims = 0, executions = 0
    const result = await runTick(config, { dryRun: false }, {
      shipGuard: async () => ({ wired: true, detail: 'pagination test seam only' }),
      parentCandidates: async () => [],
      gh: async args => {
        const url = new URL(args[1] ?? '', 'https://api.github.com/')
        if (url.pathname.endsWith(`/8/${collection}`)) {
          pages++
          return url.searchParams.get('page') === '2' ? responsePage([], undefined, 403)
            : responsePage([{ id: 99, state: 'closed', body: '' }], `https://api.github.com/repos/acme/app/issues/8/${collection}?page=2`)
        }
        return base.gh(args)
      },
      ensureWorktree: async () => { claims++; throw new Error('must not claim') },
      execute: async () => { executions++; throw new Error('must not execute') },
    })
    expect(pages).toBe(2); expect(claims).toBe(0); expect(executions).toBe(0)
    expect(result.refusals.map(row => row.reason).join()).toContain('launch preflight refused')
    expect(result.refusals.map(row => row.reason).join()).toContain('HTTP 403')
  }
})

test('142 isolated runTick keeps a healthy repository and measures idle/larger collection calls', async () => {
  const { config } = fixture({ repos: ['app', 'web'], maxRuns: 2 })
  const calls: string[] = []
  const result = await runTick(config, { dryRun: true }, {
    shipGuard: async () => ({ wired: true, detail: 'pagination test seam only' }),
    parentCandidates: async () => [],
    gh: async args => {
      calls.push(args[1]!)
      return args[1]!.includes('acme/app') ? responsePage([], undefined, 403)
        : responsePage([{ id: 8, number: 8, title: 'feat: available', labels: [{ name: 'ready' }], assignees: [] }])
    },
    issueBody: async () => '',
  })
  expect(result.runs.map(row => row.repo)).toEqual(['acme/web'])
  expect(result.refusals.map(row => row.repo)).toEqual(['acme/app'])
  expect(calls).toHaveLength(2)
  for (const count of [0, 31, 101]) {
    let reads = 0
    const rows = Array.from({ length: count }, (_, index) => ({ id: index + 1, number: index + 1, title: 'row', labels: [], assignees: [] }))
    const snapshot = await fetchBoard(async () => {
      reads++
      return responsePage(rows.slice((reads - 1) * 100, reads * 100), count > reads * 100 ? 'https://api.github.com/repos/a/b/issues?page=2' : undefined)
    }, 'a/b')
    expect(snapshot.complete).toBe(true); expect(snapshot.items).toHaveLength(count)
    expect(reads).toBe(count <= 100 ? 1 : 2)
  }
})

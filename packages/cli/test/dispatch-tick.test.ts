// The tick as a whole, with the network and the harness stubbed: what runTick asks gh for, what it
// launches, and what it writes to the state file. The pure decision functions have their own tests
// in dispatch.test.ts; these cover the seams between them, which is where the review found the
// silent drops.
import { describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scopeDigest } from '../../../skills/dev/dev-implement/scripts/lib/approval.mjs'

process.env.VSK_PREFLIGHT_SCRIPT = resolve(import.meta.dir, '../../../skills/dev/dev-implement/scripts/preflight.mjs')
import { executeRun, shipGuardWired, fetchBoard, fetchRockets, fleetParallelProjection, readLock, readState, repoLockPath, runOnce, runTick, settleRuns, watch, writeState, type PlannedRun, type RunOutcome, type RunTracker, type TickDeps } from '../src/dispatch.ts'
import { parseFactoryConfig } from '../src/config.ts'

const SHIP_POLICY = resolve(import.meta.dir, '../../../skills/dev/dev-setup/scripts/ship-policy.mjs')
const GUARD_BYTES = readFileSync(resolve(import.meta.dir, '../../../skills/dev/dev-setup/assets/hooks/ship-guard.mjs'))
process.env.VSK_SHIP_POLICY_SCRIPT = SHIP_POLICY

const CLAUDE_WIRING = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness claude' }] }] } })
const CODEX_WIRING = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness codex' }] }] } })

interface FixtureOptions {
  home?: string
  repos?: string[]
  devMd?: string
  maxRuns?: number
}

// One home with one or more opted-in repos, each wired for Claude in its main checkout.
function fixture(options: FixtureOptions = {}) {
  const home = realpathSync(options.home ?? mkdtempSync(join(tmpdir(), 'vf-tick-')))
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
        return JSON.stringify([[{ id: number * 100 + 1, node_id: 'plan-' + number, body: planBody }, { id: number * 100 + 2, user: { login: 'mk' }, body: '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(intent) + '\n```\n' }]])
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
      if (args[0] === 'api' && args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([{ id: 555, body: 'Please apply the correction.', reactions: { rocket: 1 } }])
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
    expect(calls.some(call => new URL(call[1]!, 'https://api.github.com/').pathname === '/repos/acme/app/issues/comments/555/reactions')).toBe(false)
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
      if (args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([{ id: 555, body: 'Please apply the correction.', reactions: { rocket: 1 } }])
      if (args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 999, content: 'rocket', user: { login: 'mk' } }])
      return null
    })
    const { execute, finishAll } = deferredExecute()
    const tracker: RunTracker = new Map()
    const deps = { harnessMetadata, gh, ensureWorktree, execute, parentCandidates: async () => [], tracker }
    const first = await runTick(config, { dryRun: false }, deps)
    expect(first.runs.map(run => run.stage), JSON.stringify(first.refusals)).toEqual(['corrections'])
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

describe('the parallel path requires qualified shared parent ownership before its child gateway (F28)', () => {
  test('a wired codex parent without qualified shared ownership refuses before the child gateway', async () => {
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
    expect(result.runs).toEqual([])
    expect(result.refusals.map(row => row.reason).join(' ')).toContain('qualified shared parent ownership')
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

// Isolate reaction bookkeeping with unit metadata and a harmless OS executable.
// The managed caller cases below separately exercise real metadata transport and
// final policy checks; neither fixture claims vendor qualification or delivery.
test('actual executor OS refusal retains corrections for a later real spawn', async () => {
  const { home, config, repos } = fixture()
  const repo = repos[0]!.path, command = join(home, 'retry.sh'), entered = join(home, 'entered')
  const committed = Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.'])
  expect(committed.exitCode, committed.stderr.toString()).toBe(0)
  const commit = Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  expect(commit.exitCode, commit.stderr.toString()).toBe(0)
  const { gh } = ghStub({ forOperator: [{ number: 12, title: 'feat: thing', labels: ['for-operator'], assignees: ['mk'] }] }, args => {
    if (args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([{ id: 555, body: 'Please apply the correction.', reactions: { rocket: 1 } }])
    if (args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 999, content: 'rocket', user: { login: 'mk' } }])
    return null
  })
  const tracker: RunTracker = new Map()
  const deps = { gh, tracker, harnessMetadata, parentCandidates: async () => [],
    ensureWorktree: async () => ({ path: repo, branch: 'fixture-running', slug: 'thing', type: 'feat' }),
    execute: (run: PlannedRun, plan: Parameters<TickDeps['execute']>[1], cfg: typeof config, options: Parameters<TickDeps['execute']>[3]) =>
      executeRun(run, { ...plan, command, args: [entered] }, cfg, options,
        { gh, git: async () => ({ ok: true, message: '' }), wrapperPath: resolve(import.meta.dir, '../src/run-wrapper.ts') }),
  }
  const refused = await runTick(config, { dryRun: false }, deps)
  await settleRuns(tracker)
  expect(refused.runs).toEqual([])
  expect(refused.refusals.some(r => r.reason.includes('harness did not start')), JSON.stringify(refused.refusals)).toBe(true)
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
    // Validate the genuine prepared parent even though the dispatcher must not execute it.
    expect((await shipGuardWired(prepared, harness, { home: config.home, repo: repos[0]!.repo })).wired).toBe(true)
    if (parallel) {
      expect(result.runs).toEqual([])
      expect(actual).toEqual([])
      expect(result.refusals.map(row => row.reason).join(' ')).toContain('qualified shared parent ownership')
      // #140 validates the prepared child; #139 still owns its actual gateway/launch.
      const child = join(repo, '.vegastack/.worktrees/131-child')
      git(['worktree', 'add', '-q', '-b', 'fixture-child', child])
      if (harness === 'claude') {
        mkdirSync(join(child, '.claude'))
        writeFileSync(join(child, '.claude/settings.json'), CLAUDE_WIRING)
      }
      expect((await shipGuardWired(child, harness, { home: config.home, repo: repos[0]!.repo })).wired).toBe(true)
      const hookConfig = join(child, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json')
      writeFileSync(hookConfig, JSON.stringify({ unrelated: { command: 'echo ship-guard.mjs' } }))
      expect((await shipGuardWired(child, harness, { home: config.home, repo: repos[0]!.repo })).wired).toBe(false)
    } else {
      expect(result.refusals).toEqual([])
      expect(actual).toEqual([realpathSync(prepared)])
      expect(result.runs[0]!.remoteEffectCoverage).toEqual({ kind: 'unmanaged-possible', reasonCode: 'hook-configuration-only' })
    }
  })
}

const responsePage = (rows: unknown[], next?: string, status = 200) => `HTTP/2.0 ${status} Status\r\nx-test: 1\r\n${next ? `link: <${next}>; rel="next"\r\n` : ''}\r\n${JSON.stringify(rows)}`

test('137 top-level fleet projection consumes the canonical #135 parser and exact selected plan tasks', async () => {
  const plan = `<!-- vsk:v1 type=plan rev=1 -->
## Plan (v1)
**Goal:** disjoint work.
**Approach:** approved implementation.
**Constraints:** current approval and closed dependencies.
**Fleet parallel:** {"schemaVersion":1,"eligible":true,"taskIds":["137-T1","137-T2"],"resources":["fixture:one"]}

### Tasks
- [ ] **Task 1: one** <!-- task-id:137-T1 -->
  - Files — Modify: \`src/one.ts\`
- [ ] **Task 2: two** <!-- task-id:137-T2 -->
  - Files — Modify: \`src/two.ts\`
`
  const binding = { repo: 'acme/app', issue: 137, kind: 'plan' as const, artifactId: 'IC_plan_137', rev: 1, digest: scopeDigest(plan, 'plan') }
  const gh = async () => responsePage([{ id: 1, node_id: binding.artifactId, body: plan }])
  expect(await fleetParallelProjection({ repo: 'acme/app', approvalRefs: [binding], approvedTaskIds: ['137-T1', '137-T2'] }, gh)).toEqual({
    eligible: true, independent: true, taskIds: ['137-T1', '137-T2'], paths: ['src/one.ts', 'src/two.ts'], resources: ['fixture:one'], reason: null,
  })
  expect((await fleetParallelProjection({ repo: 'acme/app', approvalRefs: [binding], approvedTaskIds: ['137-T1'] }, gh)).independent).toBe(false)
})

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

// Cancellation diagnostics isolate the existing guard seam; actual managed-launch acceptance
// still waits on the separately owned reader/compiler integration.
test.each(['SIGINT', 'SIGTERM'] as const)('142 round2 watch %s cancels its read, settles started runs and removes listeners', async signalName => {
  const { config } = fixture()
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
  let requestSignal: AbortSignal | undefined
  let settled = false
  let completeStarted!: () => void
  const tracker: RunTracker = new Map([['existing', { repo: 'acme/app', issue: 999,
    done: new Promise<void>(resolve => { completeStarted = () => { settled = true; tracker.delete('existing'); resolve() } }),
  }]])
  // Use a different repository key so the pre-existing run does not exhaust this fixture's slot.
  tracker.get('existing')!.repo = 'other/repo'
  await watch(config, { dryRun: true, ticks: 1 }, {
    tracker, shipGuard: async () => ({ wired: true, detail: 'cancellation diagnostic only' }),
    gh: async (_args, options) => {
      requestSignal = options?.signal
      setTimeout(() => process.emit(signalName), 5)
      setTimeout(completeStarted, 40)
      await new Promise(resolve => setTimeout(resolve, 60))
      return responsePage([])
    },
  })
  expect(requestSignal?.aborted).toBe(true)
  expect(settled).toBe(true)
  expect((await readLock(config.dispatcherLock)).held).toBe(false)
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before)
  tracker.clear()
})

test('142 round2 cancellation during the final body read refuses rather than preparing a later launch', async () => {
  const { config } = fixture()
  const controller = new AbortController()
  const base = ghStub({ ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'] }] })
  const result = await runTick(config, { dryRun: true, signal: controller.signal }, {
    gh: base.gh, shipGuard: async () => ({ wired: true, detail: 'cancellation diagnostic only' }),
    issueBody: async () => {
      setTimeout(() => controller.abort(), 5)
      await new Promise(resolve => setTimeout(resolve, 60))
      return 'late body'
    },
  })
  expect(result.runs).toEqual([])
  expect(result.refusals.some(row => row.reason.includes('cancelled'))).toBe(true)
})

test('142 round2 an exhausted repository deadline prevents the final body read', async () => {
  const { config } = fixture()
  const base = ghStub({ ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'] }] })
  let clock = Date.now(), bodies = 0
  const mockedClock = spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const result = await runTick(config, { dryRun: true }, {
      shipGuard: async () => ({ wired: true, detail: 'deadline diagnostic only' }),
      gh: async args => { const response = await base.gh(args); clock += 60_001; return response },
      issueBody: async () => { bodies++; return 'must not read' },
    })
    expect(bodies).toBe(0)
    expect(result.runs).toEqual([])
    expect(result.refusals.some(row => row.reason.includes('deadline'))).toBe(true)
  } finally { mockedClock.mockRestore() }
})

test('142 round2 raw gh body cancellation leaves claims and corrections untouched', async () => {
  const { config } = fixture()
  const base = ghStub({ ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'] }] })
  const controller = new AbortController()
  let bodySignal: AbortSignal | undefined, claims = 0, executions = 0
  const result = await runTick(config, { dryRun: false, signal: controller.signal }, {
    shipGuard: async () => ({ wired: true, detail: 'cancellation diagnostic only' }),
    gh: async (args, options) => {
      if (args[0] === 'issue' && args.includes('body')) {
        bodySignal = options?.signal
        setTimeout(() => controller.abort(), 5)
        return new Promise<string>(() => {})
      }
      return base.gh(args)
    },
    ensureWorktree: async () => { claims++; throw new Error('must not prepare') },
    execute: async run => { executions++; return finished(run) },
  })
  expect(bodySignal?.aborted).toBe(true)
  expect(claims).toBe(0); expect(executions).toBe(0)
  expect(result.refusals.some(row => row.reason.includes('issue body unavailable') && row.reason.includes('cancelled'))).toBe(true)
  expect((await readState(config.stateFile)).handled).toEqual([])
})


// Unit-level provenance evidence only. Guard/metadata/execution are stubs;
// actual managed-launch acceptance remains the shared integration checkpoint.
test('source trust: launched run exposes canonical comment/body provenance', async () => {
  const { config } = fixture()
  const { gh } = ghStub({ ready: [{ number: 8, title: 'feat: scoped', labels: ['ready'] }] })
  const result = await runTick(config, { dryRun: false }, {
    gh, harnessMetadata, parentCandidates: async () => [], ensureWorktree,
    shipGuard: async () => ({ wired: true, detail: 'unit-level provenance fixture only' }),
    execute: async run => finished(run),
  })
  await settleRuns()
  expect(result.refusals).toEqual([])
  expect(result.runs[0]!.launched).toBe(true)
  const authority = JSON.parse(await gh(['api', 'repos/acme/app/issues/8/comments', '--paginate', '--slurp']))[0][1]
  expect(result.runs[0]!.approvalIds).toEqual(['intent-8'])
  expect(result.runs[0]!.approvalBindings).toEqual([{ approvalId: 'intent-8', commentId: authority.id, bodySha256: Bun.SHA256.hash(authority.body, 'hex') }])
})

// Acceptance matrix: preparation, hook and metadata callers are real. GitHub transport is
// isolated, and enabled/retry cases stop at a controlled executor before subscription qualification.
for (const mode of ['enabled', 'disabled', 'stale-policy', 'final-stale-policy', 'incomplete-board', 'incomplete-history', 'cancelled-body', 'exhausted-body'] as const) {
  test(`managed ordinary acceptance: ${mode}`, async () => {
    // Bun's synchronous child inherits its startup environment. Isolate the entire
    // case at the OS boundary, including every real preparation subprocess.
    if (!process.env.VSK_MANAGED_CASE_HOME) {
      const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'vf-managed-')))
      const child = Bun.spawnSync([process.execPath, 'test', import.meta.path, '-t', `managed ordinary acceptance: ${mode}$`], {
        env: { ...process.env, VSK_MANAGED_CASE_HOME: isolated, HOME: isolated, CODEX_HOME: join(isolated, '.codex'), PATH: `${join(isolated, 'bin')}:${process.env.PATH ?? ''}` },
      })
      writeFileSync(join(isolated, 'test-result.txt'), child.stdout.toString() + child.stderr.toString())
      expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
      return
    }
    const { home, config, repos } = fixture({ home: process.env.VSK_MANAGED_CASE_HOME, devMd: 'repo: acme/app · default branch main\ndispatch: local\noperators: mk\nimplement: codex fixture high\n' })
    const repo = realpathSync(repos[0]!.path), bin = join(home, 'bin')
    const entered = join(home, 'entered'), calls = join(home, 'rpc-calls'), deliveries = join(home, 'deliveries')
    const gitCalls = join(home, 'git-calls'), metadataFault = join(home, 'metadata-fault')
    const correction = ['incomplete-history', 'cancelled-body', 'exhausted-body'].includes(mode)
    const issue = correction ? 12 : 8
    const prepared = join(repo, `.vegastack/.worktrees/${issue}-fixture`)
    const realGit = Bun.which('git')!
    const git = (args: string[]) => {
      const result = Bun.spawnSync([realGit, '-C', repo, ...args])
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString().trim()
    }
    mkdirSync(bin)
    mkdirSync(join(repo, '.codex'))
    writeFileSync(join(repo, '.codex/hooks.json'), CODEX_WIRING)
    writeFileSync(join(repo, '.gitignore'), '.claude/\n.vegastack/.worktrees/\n')
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
    git(['branch', '-M', 'main'])
    const initialHead = git(['rev-parse', 'HEAD'])
    const initialWorktrees = git(['worktree', 'list', '--porcelain'])
    const initialBranches = git(['branch', '--format=%(refname)'])
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitCalls)},JSON.stringify({cwd:process.cwd(),args})+'\\n');
if(['clone','pull','ls-remote'].includes(args[0]))process.exit(2);
if(args[0]==='fetch'&&(args[1]!=='origin'||args[2]!=='main'))process.exit(2);
// Only remote transport is redirected; real Git still fetches the fixture branch.
if(args[0]==='fetch'&&args[1]==='origin'){args[1]=${JSON.stringify(repo)};args[2]='main:refs/remotes/origin/main';}
if(args[0]==='push'){fs.appendFileSync(${JSON.stringify(deliveries)},JSON.stringify({cwd:process.cwd(),args})+'\\n');process.exit(0);}
const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??2);
`, { mode: 0o755 })
    // Any unexpected default gh delivery is recorded and refused, never networked.
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(deliveries)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(2);
`, { mode: 0o755 })
    writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs'), readline=require('node:readline');
const cwd=process.cwd(), mode=${JSON.stringify(mode)};
if(process.argv.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0);}
if(process.argv[2]==='exec'){fs.appendFileSync(${JSON.stringify(entered)},JSON.stringify({cwd,args:process.argv.slice(2)})+'\\n');process.exit(0);}
if(!process.argv.includes('app-server'))process.exit(2);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({cwd,method:request.method})+'\\n');
 if(request.id===undefined)return;
 let result={};
 if(request.method==='hooks/list')result={data:[{cwd,errors:[],hooks:[{handlerType:'command',eventName:'preToolUse',command:'node .vegastack/hooks/ship-guard.mjs --harness codex',matcher:null,async:false,enabled:mode!=='disabled',isManaged:false,currentHash:'sha256:'+'a'.repeat(64),source:'project',sourcePath:cwd+'/.codex/hooks.json',trustStatus:'untrusted'}]}]};
 if(request.method==='configRequirements/read'){if(request.params!==null)process.exit(2);result={requirements:null};}
 if(request.method==='config/read'){
  result={config:{projects:{[cwd]:{trust_level:'trusted'}},memories:{use_memories:false,generate_memories:false},features:{hooks:true,memories:false,external_agent_memory_import:false,context_management:{experimental_mode:false}}}};
  if(mode==='stale-policy'||fs.existsSync(${JSON.stringify(metadataFault)}))fs.appendFileSync(cwd+'/.vegastack/dev.md','\\ngates: 2\\n');
 }
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`, { mode: 0o755 })
    const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH }
    process.env.HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    process.env.PATH = `${bin}:${previous.PATH ?? ''}`
    const rows = { ready: [{ number: 8, title: 'feat: fixture', labels: ['ready'], assignees: correction ? ['someone-else'] : [] }, { number: 9, title: 'feat: other', labels: ['ready'], assignees: ['someone-else'] }],
      forOperator: correction ? [{ number: 12, title: 'feat: fixture', labels: ['for-operator'], assignees: ['mk'] }] : [] }
    const pending = { id: 555, body: 'Please apply the correction.', reactions: { rocket: 1 } }
    const transport = ghStub(rows, args => {
      if (args[0] === 'issue' && args.includes('parent')) return JSON.stringify({ parent: null })
      if (args[1] === 'repos/acme/app/issues/12/comments') return JSON.stringify([pending])
      if (args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 88, content: 'rocket', user: { login: 'mk' } }])
      return null
    })
    const controller = new AbortController()
    let failing = true
    const reads: string[][] = []
    const clockNow = Date.now.bind(Date)
    let clockSpy: ReturnType<typeof spyOn> | undefined
    const gh: TickDeps['gh'] = async args => {
      reads.push(args)
      const url = new URL(args[1] ?? '', 'https://api.github.com/')
      if (failing && mode === 'incomplete-board' && url.pathname === '/repos/acme/app/issues') {
        return url.searchParams.get('page') === '2' ? responsePage([], undefined, 403)
          : responsePage([{ ...rows.ready[0], id: 8, labels: [{ name: 'ready' }], assignees: [] }], 'https://api.github.com/repos/acme/app/issues?page=2')
      }
      if (failing && mode === 'incomplete-history' && url.pathname === '/repos/acme/app/issues/12/comments') {
        return url.searchParams.get('page') === '2' ? responsePage([], undefined, 403)
          : responsePage([pending], 'https://api.github.com/repos/acme/app/issues/12/comments?page=2')
      }
      const response = await transport.gh(args)
      if (failing && args[0] === 'issue' && args.includes('body')) {
        if (mode === 'cancelled-body') controller.abort()
        if (mode === 'exhausted-body') clockSpy = spyOn(Date, 'now').mockImplementation(() => clockNow() + 61_000)
      }
      return response
    }
    const tracker: RunTracker = new Map()
    const readLines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    // Only this direct executor scenario arms the external metadata fault after
    // real caller preparation and validation. It never observes private audit timing.
    let finalOutcome: RunOutcome | undefined
    const finalExecutor: TickDeps['execute'] = async (run, plan, cfg, options) => {
      expect(plan.cwd).toBe(prepared)
      expect((await shipGuardWired(plan.cwd, 'codex', { home, repo: run.repo, policyDigest: plan.guardPolicyDigest })).wired).toBe(true)
      writeFileSync(metadataFault, 'change policy on every metadata read')
      finalOutcome = await executeRun(run, plan, cfg, options)
      return finalOutcome
    }
    const controlledStarts: Array<{ issue: number; cwd: string }> = []
    const controlledExecutor: TickDeps['execute'] = async (run, plan, _cfg, options) => {
      expect(plan.cwd).toBe(prepared)
      expect(plan.args).toContain('memories.use_memories=false')
      expect(plan.args).toContain('memories.generate_memories=false')
      controlledStarts.push({ issue: run.issue, cwd: plan.cwd })
      options.onSpawn?.()
      return finished(run)
    }
    try {
      const result = await runTick(config, { dryRun: false, signal: controller.signal }, {
        gh, tracker, ...(mode === 'final-stale-policy' ? { execute: finalExecutor } : mode === 'enabled' ? { execute: controlledExecutor } : {}),
      })
      clockSpy?.mockRestore()
      await settleRuns(tracker)
      if (mode !== 'enabled') {
        expect(result.runs).toEqual([])
        const reason = { disabled: 'managed launch refused', 'stale-policy': 'final prepared-checkout check refused',
          'final-stale-policy': 'prepared guard refused', 'incomplete-board': 'board could not be read',
          'incomplete-history': 'board could not be read', 'cancelled-body': 'cancelled', 'exhausted-body': 'deadline exceeded' }[mode]
        const relevantRefusals = mode.startsWith('incomplete') ? result.refusals : result.refusals.filter(row => row.issue === issue)
        expect(relevantRefusals.map(row => row.reason).join(' ')).toContain(reason)
        expect(readLines(entered)).toEqual([])
        expect(readLines(deliveries)).toEqual([])
        expect((await readState(config.stateFile)).handled).toEqual([])
        if (mode === 'final-stale-policy') {
          expect(finalOutcome).toEqual(expect.objectContaining({ started: false, pushed: false, handedBack: false }))
          expect(finalOutcome!.refusal).toContain('prepared guard refused')
          const audit = readLines(finalOutcome!.logFile)
          expect(audit.some(row => row.event === 'launch-refused')).toBe(true)
          expect(audit.some(row => row.event === 'start')).toBe(false)
          expect(tracker.size).toBe(0)
        }
        if (mode.startsWith('incomplete') || mode.endsWith('body')) {
          expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
          expect(git(['branch', '--format=%(refname)'])).toBe(initialBranches)
          expect(git(['worktree', 'list', '--porcelain'])).toBe(initialWorktrees)
          expect(existsSync(prepared)).toBe(false)
          expect(readLines(calls)).toEqual([])
          if (mode === 'incomplete-history') {
            expect(reads.some(args => new URL(args[1] ?? '', 'https://api.github.com/').pathname === '/repos/acme/app/issues/12/comments')).toBe(true)
            expect(reads.some(args => new URL(args[1] ?? '', 'https://api.github.com/').pathname.endsWith('/555/reactions'))).toBe(false)
          }
          // Same repository, approval and pending reaction: completion permits a real start.
          failing = false
          const retry = await runTick(config, { dryRun: false }, { gh, tracker, execute: controlledExecutor })
          await settleRuns(tracker)
          expect(retry.refusals.filter(row => row.issue === issue)).toEqual([])
          expect(retry.runs.map(run => [run.issue, run.stage, run.launched])).toEqual([[issue, correction ? 'corrections' : 'implement', true]])
        } else {
          expect(readFileSync(join(prepared, '.git'), 'utf8')).toContain('gitdir:')
          expect(readLines(calls).every(row => row.cwd === prepared)).toBe(true)
          expect(readLines(calls).length).toBeGreaterThan(0)
          return
        }
      } else {
        expect(result.refusals.filter(row => row.issue === 8)).toEqual([])
        expect(result.runs.map(run => [run.issue, run.launched])).toEqual([[8, true]])
        expect(result.runs[0]!.approvalIds).toEqual(['intent-8'])
      }
      expect(readLines(gitCalls).some(row => row.args[0] === 'fetch' && row.args[1] === 'origin' && row.args[2] === 'main')).toBe(true)
      expect(readFileSync(join(prepared, '.git'), 'utf8')).toContain('gitdir:')
      expect(git(['-C', prepared, 'branch', '--show-current'])).toBe(`feat/${issue}-fixture`)
      expect(readFileSync(join(prepared, '.codex/hooks.json'), 'utf8')).toBe(CODEX_WIRING)
      expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain(`[projects."${prepared}"]`)
      expect(controlledStarts).toEqual([{ issue, cwd: prepared }])
      expect(readLines(entered)).toEqual([])
      expect(readLines(deliveries)).toEqual([])
      expect(reads.filter(args => args[0] === 'issue' && args.includes('parent')).map(args => args[2])).toContain('9')
      expect(readLines(calls).every(row => row.cwd === prepared)).toBe(true)
      expect([...new Set(readLines(calls).map(row => row.method))].sort()).toEqual(['initialize', 'initialized', 'hooks/list', 'configRequirements/read', 'config/read'].sort())
      if (correction) expect((await readState(config.stateFile)).handled).toEqual([expect.objectContaining({ repo: 'acme/app', issue: 12, commentId: 555, reactionId: 88 })])
    } finally {
      clockSpy?.mockRestore()
      await settleRuns(tracker)
      for (const key of ['HOME', 'CODEX_HOME', 'PATH'] as const) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  }, 30000)
}

test('141 actual tick uses custom ready and refuses mixed custom correction rockets', async () => {
  const map = { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }
  const { config } = fixture({ devMd: 'dispatch: local\noperators: mk\nplan: claude fable-5-1 high\nimplement: claude fable-5-1 high\nworkflow-labels: ' + JSON.stringify(map) })
  const { gh } = ghStub({ ready: [{ number: 8, title: 'custom', labels: ['Go'] }], forOperator: [{ number: 9, title: 'mixed', labels: ['Review', 'Decision'], assignees: ['mk'] }] }, args => {
    if (args[1] === 'repos/acme/app/issues/9/comments') return JSON.stringify([{ id: 555, body: 'Correct this.', reactions: { rocket: 1 } }])
    if (args[1] === 'repos/acme/app/issues/comments/555/reactions') return JSON.stringify([{ id: 999, content: 'rocket', user: { login: 'mk' } }])
    return null
  })
  const result = await runTick(config, { dryRun: true }, { gh, ensureWorktree, shipGuard: async () => ({ wired: true, detail: 'fixture' }), tracker: new Map() })
  expect(result.runs.map(row => row.issue)).toEqual([8])
  expect(result.refusals.some(row => row.issue === 9 && row.reason.includes('conflicting'))).toBe(true)
})

test('137 two actual runOnce processes racing after fresh admission start one execute seam', async () => {
  const { config, home } = fixture()
  const worker = join(home, 'race-worker.ts')
  const source = `import {runOnce} from ${JSON.stringify(resolve('packages/cli/src/dispatch.ts'))};
import {scopeDigest} from ${JSON.stringify(resolve('skills/dev/dev-implement/scripts/lib/approval.mjs'))};
import {writeFile,access,appendFile} from 'node:fs/promises';
process.env.VSK_PREFLIGHT_SCRIPT=${JSON.stringify(process.env.VSK_PREFLIGHT_SCRIPT)};
const responsePage=${responsePage.toString()};const ghStub=${ghStub.toString()};
const config=${JSON.stringify(config)};const number=137;
const {gh}=ghStub({ready:[{number,title:'feat: claim race',labels:['ready']}]});
const index=process.argv[2];const result=await runOnce(config,{dryRun:false},{gh,tracker:new Map(),parentCandidates:async()=>[],shipGuard:async()=>({wired:true,detail:'controlled fixture'}),
harnessMetadata:()=>({version:'2.1.263 (Claude Code)',hookApplicable:true,memoryRetrievalDisabled:true,memoryGenerationDisabled:true}),
issueBody:async()=>{await writeFile(config.home+'/ready'+index,'ready');for(;;){try{await access(config.home+'/ready0');await access(config.home+'/ready1');break}catch{await Bun.sleep(5)}}return 'fixture';},
ensureWorktree:async(path)=>({path,branch:'feat/137',slug:'137',type:'feat'}),execute:async(_run,_plan,_config,options)=>{await appendFile(config.home+'/sentinel','execute\\n');options.onSpawn?.();await Bun.sleep(400);return {started:true,exitCode:0,timedOut:false,pushed:false,handedBack:false,logFile:'/controlled'};}});process.stdout.write(JSON.stringify(result));`
  writeFileSync(worker, source)
  const processes = [0, 1].map(index => Bun.spawn([process.execPath, worker, String(index)], { stdout: 'pipe', stderr: 'pipe' }))
  const results = await Promise.all(processes.map(async p => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })))
  expect(results.every(r => r.code === 0), JSON.stringify(results)).toBe(true)
  expect(results.flatMap(r => JSON.parse(r.out).runs).filter(r => r.launched), JSON.stringify(results)).toHaveLength(1)
  expect(readFileSync(join(home, 'sentinel'), 'utf8').trim().split('\n')).toHaveLength(1)
}, 10000)

test('137 hashed repository key preserves legacy lock evidence rather than bypassing it',async()=>{
 const {config}=fixture();mkdirSync(config.lockRoot,{recursive:true,mode:0o700})
 const legacy=join(config.lockRoot,'acme-app.lock');writeFileSync(legacy,JSON.stringify({pid:99999999}),{mode:0o600})
 const {gh}=ghStub({ready:[{number:137,title:'feat: migration',labels:['ready']}]});let calls=0
 const result=await runOnce(config,{dryRun:false},{gh,harnessMetadata,ensureWorktree,parentCandidates:async()=>[],execute:async run=>{calls++;return finished(run)}})
 expect(calls).toBe(0);expect(result.refusals.some(r=>r.reason.includes('legacy repository claim'))).toBe(true)
 expect(readFileSync(legacy,'utf8')).toContain('99999999')
})

// Real Git-backed immutable state transport. These source-contract fixtures do
// not assert vendor/platform qualification or production provider activation.
async function recoveryGitFixture(options:{actualTask?:boolean;sameHome?:boolean}={}){
 const fs=await import('node:fs/promises'),{randomUUID}=await import('node:crypto'),{spawnSync}=await import('node:child_process')
 const owner=await import('../src/shared-claims.ts'),runtime=await import('../src/runs.ts'),{processIdentity}=await import('../src/claims.ts')
 const f=fixture({devMd:'repo: acme/app\noperators: mk\ncommands: check `test -f src/a`\n'}),tree=f.repos[0]!.path,state=join(f.home,'state')
 const git=(cwd:string,...args:string[])=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim()}
 await fs.mkdir(join(tree,'src'));await fs.writeFile(join(tree,'src/a'),'completed source\n');git(tree,'add','.');git(tree,'commit','-m','approved source');const sourceHead=git(tree,'rev-parse','HEAD')
 const body='<!-- vsk:v1 type=brief rev=1 scope=full-plan -->\nContinue approved work.'
 const plan='<!-- vsk:v1 type=plan rev=1 -->\n- [x] **Task 1: verified source** <!-- task-id:144-T1 -->\n  - Files — Modify: `src/a`\n- [ ] **Task 2: remaining source** <!-- task-id:144-T2 -->\n  - Files — Modify: `src/b`\n'
 const artifacts=[{repo:'acme/app',issue:144,kind:'brief' as const,artifactId:'I_144',rev:1,digest:scopeDigest(body,'brief')},{repo:'acme/app',issue:144,kind:'plan' as const,artifactId:'IC_plan',rev:1,digest:scopeDigest(plan,'plan')}]
 const intent={schemaVersion:2,id:'approved144',operator:'mk',scope:'brief+plan',source:{kind:'session',ref:'session:fixture',quote:'Approve these exact tasks.'},artifacts,supersedes:[],revokes:[]}
 const approvalBody='<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n'+JSON.stringify(intent)+'\n```'
 const subject={number:144,node_id:'I_144',title:'implementation',body,state:'open',labels:[{name:'working'},{name:'full-plan'}],assignees:[{login:'mk'}]}
 const source={kind:'github-comment' as const,repositoryId:'R_app',issueNodeId:'I_144',commentId:'12',bodySha256:owner.sha256(approvalBody)}
 const approvalBindings=[{approvalId:'approved144',source}],comments=[{id:11,node_id:'IC_plan',body:plan,user:{login:'mk'},issue_url:'https://api.github.com/repos/acme/app/issues/144',updated_at:'2026-09-08T01:00:00Z'},{id:12,node_id:'IC_approval',body:approvalBody,user:{login:'mk'},issue_url:'https://api.github.com/repos/acme/app/issues/144',updated_at:'2026-09-08T01:01:00Z'}]
 const gh=async(args:string[])=>{const endpoint=args[1];let value:unknown;if(endpoint==='graphql')value={data:{node:{id:'I_144',number:144,repository:{id:'R_app',nameWithOwner:'acme/app'}}}};else if(endpoint==='user')value={login:'mk'};else if(endpoint==='repos/acme/app')value={node_id:'R_app'};else if(endpoint==='repos/acme/app/issues/144')value=subject;else if(endpoint?.split('?')[0]==='repos/acme/app/issues/144/comments')value=args.includes('--slurp')?[comments]:comments;else if(endpoint==='repos/acme/app/issues/comments/12')value=comments[1];else if(endpoint?.includes('/dependencies/blocked_by'))value=args.includes('--slurp')?[[]]:[];else throw Error('unexpected fixture source endpoint '+endpoint);return(args.includes('--include')?'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n':'')+JSON.stringify(value)}
 const selection=await runtime.approvedTaskSelection(artifacts,[subject,comments],'implement',{},['144-T1','144-T2'])
 const installation=randomUUID();await fs.mkdir(join(state,'coordination'),{recursive:true});await fs.writeFile(join(state,'coordination/index.json'),owner.canonical({schemaVersion:1,installationId:installation,revision:0,active:[],machines:[]}));git(state,'init','-b','factory-state');git(state,'add','.');git(state,'commit','-m','private fixture root');const rootCommit=git(state,'rev-parse','HEAD')
 let mutations=0
 const target:import('../src/shared-claims.ts').CoordinationTarget={host:'github.com',repository:'acme/control',repositoryId:'R_state',branch:'factory-state',rootCommit,installationId:installation,localRoot:join(f.home,'coordination'),provider:{branch:async()=>({id:'REF_state',head:git(state,'rev-parse','HEAD'),repositoryId:'R_state',private:true,defaultBranch:'main'}),read:async(_t,sha,path)=>{const r=spawnSync('git',['show',sha+':'+path],{cwd:state,encoding:'utf8'});return r.status===0?r.stdout:null},compare:async(_t,base,head)=>base===head?'identical':spawnSync('git',['merge-base','--is-ancestor',base,head],{cwd:state}).status===0?'ahead':'diverged',commit:async(_t,input)=>{if(input.expectedHeadOid!==git(state,'rev-parse','HEAD'))return{kind:'conflict',reason:'changed'};for(const [path,body]of Object.entries(input.files)){await fs.mkdir(join(state,path,'..'),{recursive:true});await fs.writeFile(join(state,path),body)}git(state,'add','.');git(state,'commit','-m','fixture operation '+input.operationId);mutations++;return{kind:'committed',head:git(state,'rev-parse','HEAD')}}},verifyCandidate:async candidate=>{if(candidate.repo!=='acme/app'||candidate.scopeDigest!==selection.scopeDigest||owner.canonical(candidate.approvalBindings)!==owner.canonical(approvalBindings))throw Error('fixture candidate differs')},verifyTransition:async task=>{if(task.scopeDigest!==selection.scopeDigest)throw Error('fixture task scope differs')},verifyEvidence:async(ref,payload)=>{if(ref.kind==='github-comment'&&owner.canonical(ref)!==owner.canonical(source))throw Error('fixture source differs');if(payload?.kind==='acceptance'&&payload.sourceSha!==sourceHead)throw Error('fixture source check differs')}}
 const identity=await processIdentity(),host=(await import('../src/machine-identity.ts').then(row=>row.readHostBinding())).digest,boot=owner.sha256('VegaFactory/boot/v1\n'+identity.bootId)
 const machine:import('../src/shared-claims.ts').EffectiveMachine={id:'original',installationId:randomUUID(),hostBindingDigest:host,executionLogin:'mk',group:'dev',enabled:true,allowedRepositories:['acme/app'],repositoryIds:{'acme/app':'R_app'},policyDigest:'d'.repeat(64),coordination:{repositoryId:'R_state',repository:'acme/control',branch:'factory-state',rootCommit,installationId:installation},defaults:{maxRuns:1,childConcurrent:3,recovery:'verified-transfer'}}
 const session={machineId:machine.id,installationId:machine.installationId,sessionId:randomUUID(),hostBindingDigest:host,bootIdDigest:boot,identity,localRoot:target.localRoot,target}
 const candidate={host:'github.com',repo:'acme/app',issue:144,repositoryNodeId:'R_app',issueNodeId:'I_144',scopeDigest:selection.scopeDigest,approvalDigest:owner.sha256(owner.canonical(approvalBindings)),approvalBindings,runId:randomUUID(),stage:'implement',paths:['src/a','src/b'],resources:[],independent:true,parentTaskKey:null,approvedTaskIds:['144-T1','144-T2']}
 const acquired=await owner.acquireSharedTask({machine,session,candidate,operationId:randomUUID()});if(acquired.kind!=='owned')throw Error(acquired.reason);let claim=acquired.claim
 const ordinaryCheck=options.actualTask?null:spawnSync('sh',['-c','test -f src/a'],{cwd:tree});if(ordinaryCheck)expect(ordinaryCheck.status).toBe(0)
 const qualification=await owner.publishRecoveryReceipt({claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'execution-qualification',harness:'codex',harnessVersion:'controlled',model:'fixture',effort:'high',accountRef:'local-fixture',configurationDigest:'e'.repeat(64),candidateSha:sourceHead,validationIds:['fixture/check/'+owner.sha256(sourceHead)],managedKinds:['checkpoint-push','handback','evidence','telemetry-push'],unmanagedDenied:true,result:'qualified'}});claim=qualification.claim
 const acceptance=options.actualTask?null:await owner.publishRecoveryReceipt({claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'acceptance',taskId:'144-T1',runId:candidate.runId,sourceSha:sourceHead,scopeDigest:selection.scopeDigest,validationId:'144-T1/check/'+owner.sha256(sourceHead),commandDigest:owner.sha256('test -f src/a'),result:ordinaryCheck!.status===0?'passed':'failed',acceptedScope:null}});if(acceptance)claim=acceptance.claim
 const sourceStore=join(f.home,'source.git'),targetTree=join(f.home,'target-checkout'),retainedOldTree=join(f.home,'old-machine-preserved')
 git(f.home,'clone','--bare',tree,sourceStore)
 const checkpoint={schemaVersion:1 as const,id:randomUUID(),repo:'acme/app',repositoryId:'R_app',branch:git(tree,'symbolic-ref','--short','HEAD'),baseSha:sourceHead,headSha:sourceHead,treeSha:git(tree,'rev-parse','HEAD^{tree}'),scopeDigest:selection.scopeDigest,runId:candidate.runId,publishedAt:new Date().toISOString()}
 const recovery:import('../src/shared-claims.ts').RecoveryEnvelope={schemaVersion:2,taskKey:claim.taskKey,runId:candidate.runId,generation:claim.generation,approvalBindings,recordBinding:null,scopeDigest:selection.scopeDigest,approvalDigest:candidate.approvalDigest,execution:{providerMode:'subscription',harness:'codex',harnessVersion:'controlled',model:'fixture',effort:'high',accountRef:'local-fixture',qualification:qualification.reference},checkpoint,completed:options.actualTask?[]:[{taskId:'144-T1',headSha:sourceHead,acceptance:{sourceSha:sourceHead,validationId:'144-T1/check/'+owner.sha256(sourceHead),commandDigest:owner.sha256('test -f src/a'),evidence:acceptance!.reference}}],children:[],joins:[],effects:[],remoteEffectCoverage:{kind:'qualified-managed-only',qualification:qualification.reference}}
 const linked=await owner.transitionSharedTask({claim,operationId:randomUUID(),transition:{kind:'checkpoint',checkpoint,recovery}});if(linked.kind!=='owned')throw Error(linked.reason);claim=linked.claim
 const child=(await import('node:child_process')).spawn(process.execPath,['-e','setInterval(()=>{},1000)','144-fixture-owner'],{detached:true,stdio:'ignore'}),childExit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));if(!child.pid)throw Error('controlled process unavailable');const childIdentity=await processIdentity(child.pid)
 try{
 let producedRun:import('../src/runs.ts').RunRecord|null=null
 let produced:Awaited<ReturnType<typeof import('../src/dispatch.ts')['checkpointTaskForRecovery']>>|null=null
 if(options.actualTask){
  const started=await owner.transitionSharedTask({claim,operationId:randomUUID(),transition:{kind:'start'}});if(started.kind!=='owned')throw Error(started.reason);claim=started.claim
  let run=await runtime.createRun({root:runtime.runsRoot(f.home),runId:candidate.runId,repo:candidate.repo,issue:144,parent:null,checkout:tree,branch:checkpoint.branch,baseSha:sourceHead,headSha:sourceHead,stage:'implement',harness:'codex',model:'fixture',effort:'high',execution:recovery.execution,approvalBindings,recordBinding:null,approvalRefs:artifacts,policyDigest:machine.policyDigest,claimToken:randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:candidate.repo,issue:144,taskId:selection.taskId,scopeDigest:selection.scopeDigest},approvedTaskIds:candidate.approvedTaskIds,activeElapsedMs:null,taskOwner:'mk',agentAccountOwner:null,accountRef:'local-fixture',waitReason:null,machine:{id:machine.id,installationId:machine.installationId,sessionId:session.sessionId,hostBindingDigest:host},sharedClaim:{taskKey:claim.taskKey,generation:claim.generation,ownerToken:claim.ownerToken,stateCommit:claim.stateCommit},checkpoint,remoteEffectCoverage:recovery.remoteEffectCoverage})
  run=await runtime.updateRun(runtime.runsRoot(f.home),run.runId,()=>({state:'running',pid:child.pid!,processIdentity:childIdentity,processGroupId:child.pid!,processStartId:childIdentity.startId}))
  const producer=await import('../src/dispatch.ts')
  produced=await producer.checkpointTaskForRecovery({run,taskId:'144-T1',config:f.config,write:true},{gh,claim,wrapperPath:resolve('packages/cli/src/run-wrapper.ts')})
  expect(produced.wrote).toBe(true)
  const proofPath=join(runtime.runsRoot(f.home),run.runId,'task-144-T1-acceptance.json'),beforeCheck=await fs.readFile(proofPath,'utf8')
  run=await runtime.readRun(runtime.runsRoot(f.home),run.runId)
  const replay=await producer.checkpointTaskForRecovery({run,taskId:'144-T1',config:f.config,write:true},{gh,claim,wrapperPath:resolve('packages/cli/src/run-wrapper.ts')})
  expect(replay.replayed).toBe(true);expect(await fs.readFile(proofPath,'utf8')).toBe(beforeCheck)
  await expect(producer.checkpointTaskForRecovery({run,taskId:'144-T2',config:f.config,write:true},{gh,claim})).rejects.toThrow('unchecked task')
  producedRun=run
 }
 // A real process is stopped before the owned stop attestation is published.
 child.kill('SIGTERM');await childExit
 expect((await import('../src/run-wrapper.ts').then(row=>row.inspectOwnedGroup(childIdentity))).kind).toBe('absent')
 const stopped=await owner.publishRecoveryReceipt({claim,operationId:randomUUID(),payload:{schemaVersion:2,kind:'effect-reconciliation',runId:candidate.runId,scopeDigest:selection.scopeDigest,approvalBindings,allowedActionIds:[],checkedEffectIds:[],inspector:{kind:'qualified-adapter',identityRef:machine.id},result:'complete',reasonCode:'owned-process-group-stopped'}});claim=stopped.claim
 const proof={kind:'process-exit' as const,machineId:machine.id,installationId:machine.installationId,sessionId:session.sessionId,hostBindingDigest:host,bootIdDigest:boot,runIds:[candidate.runId],generation:claim.generation,observedAt:new Date().toISOString(),evidenceRef:stopped.reference}
 const halted=await owner.transitionSharedTask({claim,operationId:randomUUID(),transition:{kind:'stop',stopProof:proof}});if(halted.kind!=='owned')throw Error(halted.reason);claim=halted.claim
 if(producedRun){const worktreeDigest=await runtime.worktreeFingerprint(tree);producedRun=await runtime.updateRun(runtime.runsRoot(f.home),producedRun.runId,()=>({state:'terminal',terminationCause:'interrupted',finishedAt:new Date().toISOString(),exitCode:child.exitCode,attemptElapsedMs:null,activeElapsedMs:null,worktreeDigest,stopProof:proof}))}

 if(!options.sameHome){git(f.home,'clone',sourceStore,targetTree);await fs.rename(tree,retainedOldTree);f.config.repos[0]!.path=targetTree}
 const tamperCheckpoint=async()=>{const path=join(state,'coordination/tasks/'+claim.taskKey+'.json'),task=JSON.parse(await fs.readFile(path,'utf8'));task.checkpoint=null;task.recovery.checkpoint=null;await fs.writeFile(path,owner.canonical(task));git(state,'add','.');git(state,'commit','-m','fixture missing checkpoint')}
 return {...f,produced,producedRun,machine,session,candidate,tree:options.sameHome?tree:targetTree,retainedOldTree,state,target,claim,recovery,checkpoint,comments,subject,sourceHead,gh,tamperCheckpoint,get mutations(){return mutations},transport:{target,gh,source:{repository:async()=>({node_id:'R_app'}),fetch:async(checkout:string,_repo:string,head:string)=>{git(checkout,'fetch','--no-tags',sourceStore,head)}}}}
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await childExit}}
}
test('144 remote-only recovery reads exact Git receipts, fresh authority and source without old home',async()=>{
 const f=await recoveryGitFixture(),{inspectRemoteRecovery,assertRemoteRecoveryMaterial}=await import('../src/dispatch.ts')
 const before=f.mutations,material=await inspectRemoteRecovery({repo:'acme/app',taskKey:f.claim.taskKey,config:f.config},f.transport)
 expect(material.blocks).toEqual([]);expect(material.packet.completed).toMatchObject([{taskId:'144-T1',headSha:f.sourceHead}]);expect(material.packet.taskIds).toEqual(['144-T1','144-T2']);expect(f.mutations).toBe(before)
 expect(()=>assertRemoteRecoveryMaterial(material)).not.toThrow();expect(JSON.stringify(material)).not.toContain(f.retainedOldTree)
 const clone=structuredClone(material);expect(()=>assertRemoteRecoveryMaterial(clone)).toThrow('unverified')
 f.comments.push({id:13,node_id:'IC_constraint',body:'<!-- vsk:v1 type=correction -->\nStop and reconcile the new constraint.',user:{login:'mk'},issue_url:'https://api.github.com/repos/acme/app/issues/144',updated_at:'2026-09-08T02:00:00Z'})
 const constrained=await inspectRemoteRecovery({repo:'acme/app',taskKey:f.claim.taskKey,config:f.config},f.transport)
 expect(constrained.blocks.join()).toContain('operator instruction after original approval requires reconciliation');expect(()=>assertRemoteRecoveryMaterial(constrained)).toThrow('unverified')
 f.comments.pop()
 f.comments[1]!.user.login='foreign-actor'
 await expect(inspectRemoteRecovery({repo:'acme/app',taskKey:f.claim.taskKey,config:f.config},f.transport)).rejects.toThrow('current native recovery prerequisites unavailable')
 expect(f.mutations).toBe(before)
 f.comments[1]!.user.login='mk';await f.tamperCheckpoint()
 const missing=await inspectRemoteRecovery({repo:'acme/app',taskKey:f.claim.taskKey,config:f.config},f.transport);expect(missing.blocks.join()).toContain('checkpoint unavailable')
},60000)

test('144 stopped-group controller resolves an ambiguous succession through exact current receipt readback',async()=>{
 const dispatch=await import('../src/dispatch.ts'),{randomUUID}=await import('node:crypto'),operationId=randomUUID(),parentKey='a'.repeat(64),childKey='b'.repeat(64)
 const binding=(taskKey:string,runId:string,generation:number,ownerToken:string)=>({taskKey,runId,generation,ownerToken,machineId:'receiver',installationId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222'})
 const beforeParent=binding(parentKey,'33333333-3333-4333-8333-333333333333',1,'44444444-4444-4444-8444-444444444444')
 const beforeChild=binding(childKey,'55555555-5555-4555-8555-555555555555',1,'66666666-6666-4666-8666-666666666666')
 const afterParent=binding(parentKey,beforeParent.runId,2,'77777777-7777-4777-8777-777777777777')
 const afterChild=binding(childKey,beforeChild.runId,2,'88888888-8888-4888-8888-888888888888')
 const task=(value:any,parentTaskKey:string|null,state:'claimed'|'recovery-queued')=>({schemaVersion:2,...value,parentTaskKey,state,successionOperationId:operationId})
 const currentParent=task(afterParent,null,'claimed'),currentChild=task(afterChild,parentKey,'recovery-queued'),head='9'.repeat(40)
 const request={schemaVersion:1 as const,kind:'recover-stopped-group' as const,operationId,expectedHead:'8'.repeat(40),parentTaskKey:parentKey,groupPlan:{repo:'acme/app',issue:144,kind:'plan' as const,artifactId:'P',rev:13,digest:'c'.repeat(64)},groupsDigest:'d'.repeat(64),members:[{expected:beforeParent,candidate:{issue:144}},{expected:beforeChild,candidate:{issue:145}}] as any[]}
 const reference={kind:'state-receipt' as const,operationId,commitSha:head,blobSha256:'e'.repeat(64)},receipt={schemaVersion:2 as const,type:'group-succession' as const,operationId,parentTaskKey:parentKey,members:[{before:beforeParent,after:afterParent},{before:beforeChild,after:afterChild}]}
 let recoveries=0,inspections=0
 const verifiers={verifyCandidate:async()=>{},verifyTransition:async()=>{},verifyEvidence:async()=>{},verifyGroupSuccession:async()=>({maxChildren:1})}
 const receiver={id:'receiver',installationId:'11111111-1111-4111-8111-111111111111'} as any,session={target:{...verifiers},machineId:'receiver',installationId:receiver.installationId,sessionId:'22222222-2222-4222-8222-222222222222'} as any
 const result=await dispatch.recoverVerifiedStoppedGroup({evaluation:{},machine:receiver,session,evidence:[]},{
  evaluate:()=>({action:'recover-stopped-group',reason:'verified-complete-stopped-group',request}),
  recover:async()=>{recoveries++;for(const [name,fn] of Object.entries(verifiers))expect((session.target as any)[name]).toBe(fn);return{kind:'ambiguous',reason:'lost response'}},
  read:async()=>({head,tasks:{[parentKey]:currentParent,[childKey]:currentChild}} as any),
  inspect:async(_target,value)=>{inspections++;expect(value).toEqual({operationId,parent:afterParent});return{kind:'verified',reference,receipt,currentMembers:[{initial:currentParent,current:currentParent},{initial:currentChild,current:currentChild}]} as any},
 })
 expect(recoveries).toBe(1);expect(inspections).toBe(1)
 expect(result).toMatchObject({kind:'owned',lostResponse:true,reference,parent:afterParent,children:[afterChild]})
 const changed=structuredClone(currentChild);changed.ownerToken=randomUUID()
 await expect(dispatch.recoverVerifiedStoppedGroup({evaluation:{},machine:receiver,session,evidence:[]},{evaluate:()=>({action:'recover-stopped-group',reason:'verified-complete-stopped-group',request}),recover:async()=>({kind:'ambiguous',reason:'lost response'}),read:async()=>({head,tasks:{[parentKey]:currentParent,[childKey]:changed}} as any),inspect:async()=>({kind:'verified',reference,receipt,currentMembers:[{initial:currentParent,current:currentParent},{initial:currentChild,current:currentChild}]} as any)})).rejects.toThrow('current member')
})

test('144 status projects only the exact inspected current parent as recoverable',async()=>{
 const {projectSharedRecovery,inspectSharedRecovery}=await import('../src/status.ts'),head='a'.repeat(40),history=(kind:string)=>({coverage:'complete',events:[{kind,generation:2,machineId:'receiver',previousMachineId:'old',sourceCommit:head,observedAt:'2026-09-09T00:00:00Z'}]})
 const task=(taskKey:string,issue:number,state:string,parentTaskKey:string|null)=>({taskKey,repo:'acme/app',issue,state,machineId:'receiver',generation:2,parentTaskKey,sourceCommit:head,originMachineId:'old',lastTransitionObservedAt:'2026-09-09T00:00:00Z',checkpoint:null,history:history('group-succession')})
 const shared={head,tasks:[task('p',144,'claimed',null),task('c',145,'recovery-queued','p'),task('later',146,'claimed','p')],refusal:null,history:{coverage:'complete',archiveCoverage:'partial',sourceCommit:head}} as any
 expect(projectSharedRecovery(shared)[0]).toMatchObject({taskKey:'p',action:'wait'})
 const binding={taskKey:'p',runId:'11111111-1111-4111-8111-111111111111',generation:2,ownerToken:'22222222-2222-4222-8222-222222222222',machineId:'receiver',installationId:'33333333-3333-4333-8333-333333333333',sessionId:'44444444-4444-4444-8444-444444444444'}
 const parent={schemaVersion:2,...binding,repo:'acme/app',issue:144,parentTaskKey:null,state:'claimed',successionOperationId:'55555555-5555-4555-8555-555555555555'},child={...parent,taskKey:'c',runId:'66666666-6666-4666-8666-666666666666',issue:145,parentTaskKey:'p',state:'recovery-queued'},later={...child,taskKey:'later',runId:'77777777-7777-4777-8777-777777777777',issue:146,state:'claimed'}
 const current:any={p:parent,c:child,later},inspection={kind:'verified',reference:{kind:'state-receipt',operationId:parent.successionOperationId,commitSha:head,blobSha256:'e'.repeat(64)},receipt:{operationId:parent.successionOperationId,parentTaskKey:'p'},currentMembers:Object.values(current).map(value=>({initial:value,current:value}))}
 const projected=await inspectSharedRecovery(shared,{} as any,{task:async(_target:any,key:string)=>({kind:'active',head,task:current[key]}),group:async()=>inspection as any})
 expect(projected).toEqual([
  {taskKey:'p',issue:144,state:'claimed',action:'recover',reason:'exact current group parent verified; lifecycle checks required'},
  {taskKey:'c',issue:145,state:'recovery-queued',action:'wait',reason:'parent must start before this recovered child'},
  {taskKey:'later',issue:146,state:'claimed',action:'wait',reason:'claimed child is not a recoverable group parent'},
 ])
 const missing=await inspectSharedRecovery({...shared,tasks:[shared.tasks[0]]},{} as any,{task:async()=>({kind:'active',head,task:parent}),group:async()=>({kind:'invalid-or-unavailable',reason:'group succession could not be verified'}) as any} as any)
 expect(missing[0]).toMatchObject({taskKey:'p',action:'refuse'});expect(missing[0]!.reason).toContain('could not be verified')
 const moving=await inspectSharedRecovery({...shared,tasks:[shared.tasks[0]]},{} as any,{task:async()=>({kind:'active',head:'b'.repeat(40),task:parent}),group:async()=>inspection as any} as any)
 expect(moving[0]).toMatchObject({taskKey:'p',action:'refuse'});expect(moving[0]!.reason).toContain('status snapshot')
 const rebound:any=structuredClone(inspection);rebound.currentMembers[0].current.ownerToken=crypto.randomUUID()
 const endpoint=await inspectSharedRecovery({...shared,tasks:[shared.tasks[0]]},{} as any,{task:async()=>({kind:'active',head,task:parent}),group:async()=>rebound as any} as any)
 expect(endpoint[0]).toMatchObject({taskKey:'p',action:'refuse'});expect(endpoint[0]!.reason).toContain('member endpoint')
 expect(projectSharedRecovery({head:null,tasks:[],refusal:'verified coordination reader unavailable'} as any)).toEqual([{taskKey:null,issue:null,state:'unavailable',action:'refuse',reason:'verified coordination reader unavailable'}])
})
test('144 completed terminal identity is never represented as quota or silently reopened',async()=>{
 const {durableRecoverySummary}=await import('../src/dispatch.ts'),{createRun,updateRun,runsRoot,readRun}=await import('../src/runs.ts'),{randomUUID}=await import('node:crypto')
 const f=fixture(),root=runsRoot(f.home),run=await createRun({root,repo:'acme/app',issue:144,parent:null,checkout:f.repos[0]!.path,branch:'',baseSha:'',headSha:null,stage:'implement',harness:'diagnostic',model:'none',effort:'none',execution:null,approvalBindings:[],recordBinding:null,approvalRefs:[],policyDigest:'',claimToken:randomUUID(),startedAt:new Date().toISOString(),taskKey:{repo:'acme/app',issue:144,taskId:'unknown',scopeDigest:''},activeElapsedMs:null,taskOwner:null,agentAccountOwner:null,accountRef:null,waitReason:null,machine:null,sharedClaim:null,checkpoint:null,remoteEffectCoverage:{kind:'unmanaged-possible',reasonCode:'fixture'}})
 const terminal=await updateRun(root,run.runId,()=>({state:'terminal',terminationCause:'interrupted',finishedAt:new Date().toISOString(),pendingDelivery:[{id:randomUUID(),kind:'telemetry-capture',target:{captureKey:run.runId+':terminal:0'},intentRef:null,status:'acknowledged',attempts:1,lastError:null,payload:'{}',payloadDigest:'a'.repeat(64)}]}))
 expect(durableRecoverySummary(terminal)).toMatchObject({action:'inspect',terminalCapturePreserved:true});expect((await readRun(root,run.runId)).waitReason).toBeNull()
},15000)

test('144 task checkpoint executes configured check once and preserves T1 across interrupted T2',async()=>{
 const f=await recoveryGitFixture({actualTask:true}),{inspectRemoteRecovery}=await import('../src/dispatch.ts')
 const recovered=await inspectRemoteRecovery({repo:'acme/app',taskKey:f.claim.taskKey,config:f.config},f.transport)
 const completed=recovered.packet.completed as Array<{taskId:string}>,taskIds=recovered.packet.taskIds as string[]
 expect(recovered.blocks).toEqual([]);expect(completed.map(row=>row.taskId)).toEqual(['144-T1'])
 expect(taskIds.filter(id=>!completed.some(row=>row.taskId===id))).toEqual(['144-T2'])
 expect(f.produced?.reference).not.toBeNull()
},60000)

test('144 same-home controller verifies fresh task evidence after real ownership handoff',async()=>{
 const f=await recoveryGitFixture({actualTask:true,sameHome:true}),owner=await import('../src/shared-claims.ts'),runtime=await import('../src/runs.ts'),dispatch=await import('../src/dispatch.ts'),{randomUUID}=await import('node:crypto')
 const original=f.producedRun!,current=await owner.inspectCoordinationTask(f.target,f.claim.taskKey)
 f.target.verifySession=async previous=>{if(previous.sessionId!==f.session.sessionId||!await runtime.verifyLocalRunStopped(original))throw Error('original session process is not stopped')}
 if(current.kind!=='active'||!current.task.stopProof||!current.task.recovery)throw Error('stopped original unavailable')
 const moved=await owner.transitionSharedTask({claim:f.claim,operationId:randomUUID(),transition:{kind:'handoff',machine:f.machine,session:{...f.session,sessionId:randomUUID()},candidate:f.candidate,stopProof:current.task.stopProof,recovery:current.task.recovery}})
 if(moved.kind!=='owned')throw Error(moved.reason)
 const request:import('../src/runs.ts').RunContinuationRequest={root:runtime.runsRoot(f.home),runId:original.runId,expectedGeneration:original.generation,requestId:randomUUID(),previousAttemptId:original.attemptId??original.runId,checkpoint:original.checkpoint!,worktreeDigest:original.worktreeDigest!,currentOwner:{machine:{...original.machine!,sessionId:moved.claim.sessionId},sharedClaim:{taskKey:moved.claim.taskKey,generation:moved.claim.generation,ownerToken:moved.claim.ownerToken,stateCommit:moved.claim.stateCommit}}}
 const decision=await dispatch.verifyRunContinuationRecovery({run:original,request},f.config,{gh:f.gh,claim:moved.claim})
 expect(decision.taskIds).toEqual(['144-T2'])
 await expect(dispatch.verifyRunContinuationRecovery({run:original,request:{...request,currentOwner:{...request.currentOwner,sharedClaim:{...request.currentOwner.sharedClaim!,ownerToken:randomUUID()}}}},f.config,{gh:f.gh,claim:moved.claim})).rejects.toThrow('owner')
 const continued=await runtime.beginVerifiedRunContinuation(request,{verifyRecovery:input=>dispatch.verifyRunContinuationRecovery(input,f.config,{gh:f.gh,claim:moved.claim})})
 expect(continued.state).toBe('prepared');expect(continued.runId).toBe(original.runId);expect(continued.attemptId).not.toBe(original.attemptId??original.runId)
 expect(continued.attempts?.[0]?.terminationCause).toBe('interrupted');expect(continued.approvedTaskIds).toEqual(['144-T1','144-T2'])
 expect(JSON.parse(await (await import('node:fs/promises')).readFile(join(runtime.runsRoot(f.home),original.runId,'recovery.json'),'utf8')).completed.map((row:{taskId:string})=>row.taskId)).toEqual(['144-T1'])
 const terminal=await runtime.transitionRun(continued.runId,continued.generation,{state:'terminal',terminationCause:'succeeded',exitCode:0,finishedAt:new Date().toISOString()},runtime.runsRoot(f.home)),tracker=new Map()
 const tick=await dispatch.runTick(f.config,{dryRun:false},{gh:f.gh,tracker,recoveryTransport:async()=>f.transport} as any);await dispatch.settleRuns(tracker)
 expect(terminal.continuations).toHaveLength(1);expect(tick.refusals.some(row=>row.reason.includes('group parent finish barrier'))).toBe(false)
},60000)

test('144 receiving inspection binds real handoff history and a fresh claimed owner without local run history',async()=>{
 const f=await recoveryGitFixture(),owner=await import('../src/shared-claims.ts'),runtime=await import('../src/runs.ts'),dispatch=await import('../src/dispatch.ts'),{randomUUID}=await import('node:crypto')
 const inspected=await owner.inspectCoordinationTask(f.target,f.claim.taskKey);if(inspected.kind!=='active'||!inspected.task.stopProof||!inspected.task.recovery)throw Error('original stopped evidence unavailable')
 const operationId=randomUUID(),moved=await owner.transitionSharedTask({claim:f.claim,operationId,transition:{kind:'handoff',machine:f.machine,session:f.session,candidate:f.candidate,stopProof:inspected.task.stopProof,recovery:inspected.task.recovery}});if(moved.kind!=='owned')throw Error(moved.reason)
 const raw=await f.target.provider.read(f.target,moved.claim.stateCommit,owner.operationPath(operationId));if(!raw)throw Error('handoff receipt missing')
 const newHome=join(f.home,'receiver-home'),config=parseFactoryConfig({repos:[{repo:'acme/app',org:'acme',path:f.tree}]},newHome)
 const request:import('../src/runs.ts').ReceivingRunRequest={root:runtime.runsRoot(newHome),requestId:randomUUID(),runId:f.claim.runId,taskKey:f.claim.taskKey,expectedSharedGeneration:moved.claim.generation,checkout:f.tree,handoff:{kind:'state-receipt',commitSha:moved.claim.stateCommit,operationId,blobSha256:owner.sha256(raw)}}
 const expected={taskKey:f.claim.taskKey,runId:f.claim.runId,generation:f.claim.generation,ownerToken:f.claim.ownerToken,machineId:f.claim.machineId,installationId:f.claim.installationId,sessionId:f.claim.sessionId}
 const material=await dispatch.inspectReceivingRecovery(request,expected,config,f.transport)
 expect(material.taskIds).toEqual(['144-T2']);expect(material.original.task).toEqual(inspected.task)
 expect(material.handoff.receipt.previousHead).toBe(material.original.stateCommit);expect(material.current.task.ownerToken).toBe(moved.claim.ownerToken)
 expect(await runtime.readRuns(runtime.runsRoot(newHome))).toEqual([])
 // Assemble the actual source entry/wrapper into an isolated runtime inventory.
 // This proves source/constructor integration, not vendor qualification or launch.
 const fs=await import('node:fs/promises'),packageRoot=join(newHome,'controlled-runtime'),dist=join(packageRoot,'dist')
 await fs.mkdir(dist,{recursive:true})
 const built=await Bun.build({entrypoints:[resolve('packages/cli/src/index.ts'),resolve('packages/cli/src/run-wrapper.ts')],outdir:dist,target:'node',naming:'[name].js'});expect(built.success).toBe(true)
 await fs.writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@vegastack/vegafactory',version:'0.18.0',type:'module'}))
 const files:Array<{path:string;mode:number;sha256:string}>=[]
 const inventory=async(path:string,prefix:string)=>{for(const row of await fs.readdir(path,{withFileTypes:true})){if(row.isDirectory())await inventory(join(path,row.name),prefix+row.name+'/');else files.push({path:prefix+row.name,mode:(await fs.stat(join(path,row.name))).mode&0o777,sha256:owner.sha256(await fs.readFile(join(path,row.name),'utf8'))})}}
 await inventory(packageRoot,'');files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 const binding:import('../src/runs.ts').InstalledRuntimeBinding={schemaVersion:1,sourceSha:f.sourceHead,treeSha:f.checkpoint.treeSha,packageName:'@vegastack/vegafactory',version:'0.18.0',tarballSha256:'e'.repeat(64),inventoryDigest:owner.sha256(JSON.stringify(files))}
 await runtime.verifyInstalledRuntimeBinding(binding,packageRoot,join(dist,'index.js'))
 const localToken=randomUUID(),receiving=await runtime.createVerifiedReceivingRun(request,{verifyRecovery:async value=>{
  const fresh=await dispatch.inspectReceivingRecovery(value,expected,config,f.transport)
  await runtime.verifyInstalledRuntimeBinding(binding,packageRoot,join(dist,'index.js'))
  return{action:'resume-task',reason:'controlled source/constructor proof',original:{stateCommit:fresh.original.stateCommit,task:fresh.original.task},current:fresh.current,handoff:fresh.handoff,artifacts:fresh.original.artifacts,authorityRequest:fresh.original.authorityRequest,taskIds:fresh.taskIds,sourceRefs:fresh.original.sourceRefs,receiver:{machine:{id:f.machine.id,installationId:f.machine.installationId,sessionId:moved.claim.sessionId,hostBindingDigest:f.machine.hostBindingDigest},claimToken:localToken,policyDigest:f.machine.policyDigest,runtimeBinding:binding,configurationDigest:'e'.repeat(64),worktreeDigest:await runtime.worktreeFingerprint(f.tree)}}
 }})
 expect(receiving.remoteRecovery?.originalTask.bytes).toBe(owner.canonical(inspected.task));expect(receiving.activeElapsedMs).toBeNull();expect(runtime.runReportingHold(receiving)).toBe('original-reporting-context-unavailable')
 const retained=material.original.task.recovery!.completed[0]!,payload=material.original.evidence.find(row=>owner.canonical(row.ref)===owner.canonical(retained.acceptance.evidence))!.payload
 if(payload?.kind!=='acceptance')throw Error('original task completion missing')
 expect(await dispatch.verifyRetainedTaskCompletion(receiving,payload,retained.acceptance.evidence,f.target,config,f.gh)).toBe(true)
 await expect(dispatch.verifyRetainedTaskCompletion(receiving,{...payload,sourceSha:'f'.repeat(40)},retained.acceptance.evidence,f.target,config,f.gh)).rejects.toThrow('evidence differs')
 await expect(dispatch.inspectReceivingRecovery(request,{...expected,ownerToken:randomUUID()},config,f.transport)).rejects.toThrow('historical handoff')
 const started=await owner.transitionSharedTask({claim:moved.claim,operationId:randomUUID(),transition:{kind:'start'}});expect(started.kind).toBe('owned')
 await expect(dispatch.inspectReceivingRecovery(request,expected,config,f.transport)).rejects.toThrow('current standalone owner')
},60000)

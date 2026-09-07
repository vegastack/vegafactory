import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  evaluateGuards, executeRun, failureComment, holdLock, logPath, parseDispatchArgs, readLock,
  outcomeOf, releaseLock, stopList, worktreeFor, planLabelRuns, planRocketRuns, planTick, readState,
  recordHandled, redact, searchQueries, shipGuardWired, tailLines, writeState,
  defaultParentCandidates, parentParallelLaunch, parentParallelLaunchPlan,
  type BoardIssue, type DispatchState, type GuardState, type Rocket,
} from '../src/dispatch.ts'
import { buildLaunchPlan, validateManagedLaunch } from '../src/launch.ts'
import { parseFactoryConfig, parseRepoPolicy } from '../src/config.ts'

const SHIP_POLICY = join(import.meta.dir, '../../../skills/dev/dev-setup/scripts/ship-policy.mjs')
process.env.VSK_SHIP_POLICY_SCRIPT = SHIP_POLICY
const GUARD_BYTES = readFileSync(join(import.meta.dir, '../../../skills/dev/dev-setup/assets/hooks/ship-guard.mjs'))

const issue = (number: number, labels: string[], assignees: string[] = []): BoardIssue =>
  ({ number, title: `feat: thing ${number}`, labels, assignees, updatedAt: '2026-09-03T10:00:00Z' })

describe('searchQueries', () => {
  test('one query per state, scoped to the repo, ready excluding assignees', () => {
    const q = searchQueries('acme/app')
    expect(q.needsPlan).toBe('repo:acme/app is:issue is:open label:needs-plan')
    expect(q.ready).toBe('repo:acme/app is:issue is:open label:ready no:assignee')
    expect(q.corrections).toBe('repo:acme/app is:issue is:open label:for-operator')
  })

  test('every tick asks for every for-operator issue — a reaction never moves updated_at, so no window could find it', () => {
    expect(searchQueries('acme/app').corrections).not.toContain('updated:')
  })
})

describe('planLabelRuns', () => {
  test('needs-plan becomes a plan run and ready becomes an implement run', () => {
    const plan = planLabelRuns({ repo: 'acme/app', needsPlan: [issue(7, ['needs-plan'])], ready: [issue(8, ['ready'])] })
    expect(plan.runs.map(run => [run.issue, run.stage])).toEqual([[7, 'plan'], [8, 'implement']])
    expect(plan.runs[0]!.commentId).toBeNull()
  })

  test('a ready issue that still carries an assignee is refused, naming the assignee', () => {
    const plan = planLabelRuns({ repo: 'acme/app', needsPlan: [], ready: [issue(9, ['ready'], ['ada'])] })
    expect(plan.runs).toEqual([])
    expect(plan.refusals[0]!.reason).toContain('assigned to ada')
  })

  test('an issue carrying two state labels is refused, never guessed', () => {
    const plan = planLabelRuns({ repo: 'acme/app', needsPlan: [issue(10, ['needs-plan', 'working'])], ready: [] })
    expect(plan.runs).toEqual([])
    expect(plan.refusals[0]!.reason).toContain('two state labels')
  })

  test('an epic never starts a run, whatever state label it carries', () => {
    const plan = planLabelRuns({ repo: 'acme/app', needsPlan: [], ready: [issue(11, ['ready', 'epic'])] })
    expect(plan.runs).toEqual([])
    expect(plan.refusals[0]!.reason).toContain('epic')
  })
})

const empty: DispatchState = { lastTick: {}, handled: [] }
const forOperator: BoardIssue = { number: 12, title: 'feat: thing', labels: ['for-operator'], assignees: ['mk'], updatedAt: '2026-09-03T10:00:00Z' }
const rocket = (login: string): Rocket => ({ issue: 12, commentId: 555, reactionId: 999, login })

describe('planRocketRuns', () => {
  test('a rocket from a listed operator starts one corrections run carrying the reacted comment', () => {
    const plan = planRocketRuns({ repo: 'acme/app', corrections: [forOperator], rockets: [rocket('mk')], operators: ['mk'], state: empty })
    expect(plan.runs).toHaveLength(1)
    expect(plan.runs[0]!.stage).toBe('corrections')
    expect(plan.runs[0]!.commentId).toBe(555)
    expect(plan.runs[0]!.reactionId).toBe(999)
  })

  test('a rocket from someone who is not an operator is refused, naming the login', () => {
    const plan = planRocketRuns({ repo: 'acme/app', corrections: [forOperator], rockets: [rocket('drive-by')], operators: ['mk'], state: empty })
    expect(plan.runs).toEqual([])
    expect(plan.refusals[0]!.reason).toContain('drive-by')
  })

  test('a reaction already in the state file never launches twice', () => {
    const state = recordHandled(empty, { repo: 'acme/app', issue: 12, title: 't', stage: 'corrections', commentId: 555, reactionId: 999 })
    const plan = planRocketRuns({ repo: 'acme/app', corrections: [forOperator], rockets: [rocket('mk')], operators: ['mk'], state })
    expect(plan.runs).toEqual([])
    expect(plan.refusals).toEqual([])
  })

  test('two rockets on different comments of one issue produce one run, the newest comment', () => {
    const rockets: Rocket[] = [rocket('mk'), { issue: 12, commentId: 777, reactionId: 1001, login: 'mk' }]
    const plan = planRocketRuns({ repo: 'acme/app', corrections: [forOperator], rockets, operators: ['mk'], state: empty })
    expect(plan.runs).toHaveLength(1)
    expect(plan.runs[0]!.commentId).toBe(777)
  })

  test('a rocket on an issue that is no longer for-operator is refused, not run', () => {
    const plan = planRocketRuns({ repo: 'acme/app', corrections: [], rockets: [rocket('mk')], operators: ['mk'], state: empty })
    expect(plan.runs).toEqual([])
    expect(plan.refusals[0]!.reason).toContain('for-operator')
  })

  test('no operators listed means no rocket is trusted', () => {
    const plan = planRocketRuns({ repo: 'acme/app', corrections: [forOperator], rockets: [rocket('mk')], operators: [], state: empty })
    expect(plan.runs).toEqual([])
    expect(plan.refusals[0]!.reason).toContain('operators:')
  })
})

describe('readState and writeState', () => {
  test('a round trip keeps the handled runs and the last tick', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vsk-state-')), 'state.json')
    await writeState(path, { lastTick: { 'acme/app': '2026-09-03T10:00:00Z' }, handled: [{ repo: 'acme/app', issue: 12, commentId: 555, reactionId: 999 }] })
    const back = await readState(path)
    expect(back.lastTick['acme/app']).toBe('2026-09-03T10:00:00Z')
    expect(back.handled[0]!.reactionId).toBe(999)
  })

  test('a missing or unparseable state file is an empty state, never a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsk-state-'))
    expect(await readState(join(dir, 'absent.json'))).toEqual({ lastTick: {}, handled: [] })
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    expect(await readState(broken)).toEqual({ lastTick: {}, handled: [] })
  })

  test('a symlinked state path is refused rather than followed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsk-state-'))
    const real = join(dir, 'real.json')
    writeFileSync(real, '{}')
    const link = join(dir, 'link.json')
    symlinkSync(real, link)
    await expect(writeState(link, empty)).rejects.toThrow(/symlink/)
  })
})

const wired: GuardState = { shipGuard: { wired: true, detail: '.vegastack/hooks/ship-guard.mjs wired for claude' }, lock: { held: false, pid: null }, activeRuns: 0 }
const local = parseRepoPolicy('dispatch: local\noperators: mk\nplan: claude fable-5-1 high\nimplement: claude fable-5-1 high\n')
const board = {
  needsPlan: [{ number: 7, title: 'feat: a', labels: ['needs-plan'], assignees: [], updatedAt: '2026-09-03T10:00:00Z' }],
  ready: [{ number: 8, title: 'feat: b', labels: ['ready'], assignees: [], updatedAt: '2026-09-03T10:00:00Z' }],
  corrections: [],
}

describe('evaluateGuards', () => {
  test('an unwired ship guard refuses the whole repo with the reason', () => {
    const refusals = evaluateGuards({ repo: 'acme/app', policy: local, guards: { ...wired, shipGuard: { wired: false, detail: 'no .vegastack/hooks/ship-guard.mjs' } }, maxRuns: 1 })
    expect(refusals[0]!.reason).toContain('ship guard')
    expect(refusals[0]!.reason).toContain('no .vegastack/hooks/ship-guard.mjs')
  })

  test('dispatch: off refuses even with everything else wired', () => {
    const refusals = evaluateGuards({ repo: 'acme/app', policy: parseRepoPolicy('dispatch: off\n'), guards: wired, maxRuns: 1 })
    expect(refusals[0]!.reason).toContain('dispatch: off')
  })

  test('a held lock refuses and names the pid', () => {
    const refusals = evaluateGuards({ repo: 'acme/app', policy: local, guards: { ...wired, lock: { held: true, pid: 4242 } }, maxRuns: 1 })
    expect(refusals[0]!.reason).toContain('4242')
  })

  test('a repo already at maxRuns refuses without reading the board', () => {
    const refusals = evaluateGuards({ repo: 'acme/app', policy: local, guards: { ...wired, activeRuns: 1 }, maxRuns: 1 })
    expect(refusals[0]!.reason).toContain('maxRuns')
  })

  test('a fully wired opted-in repo with a free lock refuses nothing', () => {
    expect(evaluateGuards({ repo: 'acme/app', policy: local, guards: wired, maxRuns: 1 })).toEqual([])
  })
})

describe('shipGuardWired', () => {
  function repoWith(options: { guard: boolean; settings: string | null; harness: 'claude' | 'codex' }): string {
    const root = mkdtempSync(join(tmpdir(), 'vsk-guard-'))
    mkdirSync(join(root, '.vegastack/hooks'), { recursive: true })
    if (options.guard) writeFileSync(join(root, '.vegastack/hooks/ship-guard.mjs'), GUARD_BYTES)
    writeFileSync(join(root, '.vegastack/dev.md'), 'gates: 3\n')
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0)
    expect(Bun.spawnSync(['git', '-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']).exitCode).toBe(0)
    const dir = options.harness === 'claude' ? '.claude' : '.codex'
    const file = options.harness === 'claude' ? 'settings.json' : 'hooks.json'
    mkdirSync(join(root, dir), { recursive: true })
    if (options.settings !== null) writeFileSync(join(root, dir, file), options.settings)
    return root
  }

  const claudeSettings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness claude' }] }] } })

  test('F4: an unrelated command field cannot wire a real installed guard', async () => {
    const root = repoWith({ guard: true, settings: JSON.stringify({ unrelated: { command: 'echo ship-guard.mjs' } }), harness: 'claude' })
    writeFileSync(join(root, '.vegastack/hooks/ship-guard.mjs'), readFileSync(join(import.meta.dir, '../../../skills/dev/dev-setup/assets/hooks/ship-guard.mjs')))
    const result = await shipGuardWired(root, 'claude')
    expect(result.wired).toBe(false)
    expect(result.detail).toContain('PreToolUse')
  })

  test('a guard file wired into the harness config reads as wired', async () => {
    const result = await shipGuardWired(repoWith({ guard: true, settings: claudeSettings, harness: 'claude' }), 'claude')
    expect(result.wired).toBe(true)
  })

  test('given the repo and home, the preflight also wants the compiled policy file and names the sync command when it is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-guard-home-'))
    const repoPath = repoWith({ guard: true, settings: claudeSettings, harness: 'claude' })
    const missing = await shipGuardWired(repoPath, 'claude', { home, repo: 'acme/app' })
    expect(missing.wired).toBe(false)
    expect(missing.detail).toContain('policy')
    expect(missing.detail).toContain('vegafactory guard sync')
    mkdirSync(join(home, '.vegastack/guard'), { recursive: true })
    writeFileSync(join(home, '.vegastack/guard/acme__app.json'), JSON.stringify({ schemaVersion: 1, repo: 'acme/other' }))
    expect((await shipGuardWired(repoPath, 'claude', { home, repo: 'acme/app' })).wired).toBe(false)
    const compiled = Bun.spawnSync(['node', SHIP_POLICY, '--write', '--json'], { cwd: repoPath, env: { ...process.env, HOME: home } })
    expect(compiled.exitCode, compiled.stdout.toString()).toBe(0)
    expect((await shipGuardWired(repoPath, 'claude', { home, repo: 'acme/app' })).wired).toBe(true)
  })

  test('a guard file that no harness config references is unwired, and says which file is missing it', async () => {
    const result = await shipGuardWired(repoWith({ guard: true, settings: JSON.stringify({ hooks: {} }), harness: 'claude' }), 'claude')
    expect(result.wired).toBe(false)
    expect(result.detail).toContain('.claude/settings.json')
  })

  test('a missing guard file is unwired whatever the harness config says', async () => {
    const result = await shipGuardWired(repoWith({ guard: false, settings: claudeSettings, harness: 'claude' }), 'claude')
    expect(result.wired).toBe(false)
    expect(result.detail).toContain('ship-guard.mjs')
  })

  test('codex wiring is read from .codex/hooks.json', async () => {
    const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .vegastack/hooks/ship-guard.mjs --harness codex' }] }] } })
    expect((await shipGuardWired(repoWith({ guard: true, settings, harness: 'codex' }), 'codex')).wired).toBe(true)
  })

  test('an unreadable wiring file is treated as unwired, never as fine', async () => {
    const result = await shipGuardWired(repoWith({ guard: true, settings: '{ not json', harness: 'claude' }), 'claude')
    expect(result.wired).toBe(false)
  })
})

describe('planTick', () => {
  test('maxRuns 1 launches the first run and refuses the rest by name', () => {
    const plan = planTick({ repo: 'acme/app', policy: local, board, rockets: [], state: { lastTick: {}, handled: [] }, guards: wired, maxRuns: 1 })
    expect(plan.runs.map(run => run.issue)).toEqual([7])
    expect(plan.refusals.some(refusal => refusal.reason.includes('maxRuns'))).toBe(true)
  })

  test('a guard refusal means no runs at all, whatever the board says', () => {
    const plan = planTick({ repo: 'acme/app', policy: local, board, rockets: [], state: { lastTick: {}, handled: [] }, guards: { ...wired, shipGuard: { wired: false, detail: 'unwired' } }, maxRuns: 1 })
    expect(plan.runs).toEqual([])
  })

  test('an issue with a run already in flight is refused by name, and never planned twice', () => {
    const plan = planTick({ repo: 'acme/app', policy: local, board, rockets: [], state: { lastTick: {}, handled: [] }, guards: { ...wired, activeRuns: 1 }, maxRuns: 3, inFlight: [8] })
    expect(plan.runs.map(run => run.issue)).toEqual([7])
    expect(plan.refusals.some(refusal => refusal.reason.includes('#8 already has a run in flight'))).toBe(true)
  })

  test('corrections come after the label runs, and the budget counts every stage', () => {
    const rockets: Rocket[] = [{ issue: 12, commentId: 555, reactionId: 999, login: 'mk' }]
    const withCorrections = { ...board, corrections: [forOperator] }
    const plan = planTick({ repo: 'acme/app', policy: local, board: withCorrections, rockets, state: { lastTick: {}, handled: [] }, guards: wired, maxRuns: 3 })
    expect(plan.runs.map(run => run.stage)).toEqual(['plan', 'implement', 'corrections'])
  })
})

const logConfig = parseFactoryConfig({ repos: [{ path: '/w', repo: 'acme/app', org: 'acme' }] }, '/home/mk')

describe('logPath', () => {
  test('nests by org and repo name and stamps the run time', () => {
    expect(logPath(logConfig, 'acme/app', 12, new Date('2026-09-03T10:04:05Z')))
      .toBe('/home/mk/.vegastack/factory/logs/acme/app/12-20260903T100405Z.jsonl')
  })
})

describe('redact', () => {
  test('strips token shapes and Authorization values, keeping the surrounding text', () => {
    const clean = redact('failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Authorization: Bearer xyz.123')
    expect(clean).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(clean).not.toContain('xyz.123')
    expect(clean).toContain('failed with')
    expect(clean).toContain('[redacted]')
  })

  test('a schemeless Authorization value is redacted wherever it sits, and the text around it survives', () => {
    // Next line follows: the credential, not the next header, is what goes.
    expect(redact('Authorization: abcdef123456\nX-Api-Key: secret')).toBe('Authorization: [redacted]\nX-Api-Key: secret')
    // Last line of the tail: no token behind it to lean on.
    expect(redact('Authorization: 8f3c1d0a9b4e7f2c6d5a')).toBe('Authorization: [redacted]')
    // Mid-line, quoted: the URL after it stays.
    expect(redact('curl -H "Authorization: 8f3c1d0a9b4e7f2c6d5a" https://api.example.com/v1/x')).toBe('curl -H "Authorization: [redacted]" https://api.example.com/v1/x')
    // A scheme is kept, the credential behind it is not.
    expect(redact('Authorization: Bearer xyz.123 then more')).toBe('Authorization: Bearer [redacted] then more')
    // A JSON-shaped header.
    expect(redact('{"Authorization": "Basic dXNlcjpwYXNz"}')).toBe('{"Authorization": "Basic [redacted]"}')
  })

  test('covers the other token shapes a run can print', () => {
    const clean = redact('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrst npm_abcdefghijklmnopqrstuvwxyz012345 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')
    for (const secret of ['github_pat_11ABCDEFG', 'sk-abcdefghijklmnopqrst', 'npm_abcdefghijklmnopqrstuvwxyz012345', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY']) {
      expect(clean).not.toContain(secret)
    }
  })
})

describe('failureComment', () => {
  test('is a handback comment naming the exit code and carrying the redacted last 40 lines', () => {
    const log = Array.from({ length: 60 }, (_, i) => `line ${i} ghp_abcdefghijklmnopqrstuvwxyz0123456789`).join('\n')
    const body = failureComment({ issue: 12, stage: 'implement', exitCode: 1, timedOut: false, log, worktree: '/w/12-thing', at: '2026-09-03T10:04:05Z' })
    expect(body.startsWith('<!-- vsk:v1 type=handback -->')).toBe(true)
    expect(body).toContain('## Hand-back')
    expect(body).toContain('exit 1')
    expect(body).toContain('/w/12-thing')
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(tailLines(log, 40).split('\n')).toHaveLength(40)
    expect(body).toContain('line 59')
    expect(body).not.toContain('line 19')
  })

  test('a timeout says so instead of an exit code', () => {
    const body = failureComment({ issue: 12, stage: 'plan', exitCode: null, timedOut: true, log: 'x', worktree: '/w/12', at: '2026-09-03T10:04:05Z' })
    expect(body).toContain('timed out')
  })
})

describe('executeRun', () => {
  function harnessStub(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vsk-run-'))
    const path = join(dir, 'harness.sh')
    writeFileSync(path, body)
    chmodSync(path, 0o755)
    return path
  }

  const runFor = (home: string) => parseFactoryConfig({ repos: [{ path: '/w', repo: 'acme/app', org: 'acme' }] }, home)
  const planned = { repo: 'acme/app', issue: 12, title: 'feat: thing', stage: 'implement' as const, commentId: null, reactionId: null }

  test('a clean run logs its streams and its exit, pushes the branch, and hands nothing back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-home-'))
    const command = harnessStub('#!/bin/sh\necho hello\n')
    const calls: string[][] = []
    const outcome = await executeRun(planned, { command, args: [], env: {}, cwd: home, prompt: 'p' }, runFor(home), { operator: 'mk' }, {
      now: () => new Date('2026-09-03T10:04:05Z'),
      gh: async args => { calls.push(args); return '' },
      git: async args => { calls.push(['git', ...args]); return { ok: true, message: '' } },
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.handedBack).toBe(false)
    expect(outcome.pushed).toBe(true)
    expect(calls.some(call => call.join(' ') === 'git push -u origin HEAD')).toBe(true)
    expect(calls.some(call => call[0] === 'issue')).toBe(false)
    const log = readFileSync(outcome.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(log[0].event).toBe('start')
    expect(log.some(row => row.text?.includes('hello'))).toBe(true)
    expect(log.at(-1).event).toBe('exit')
  })

  test('a failing run posts the hand-back, moves the label and assigns the operator', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-home-'))
    const command = harnessStub('#!/bin/sh\necho "boom ghp_abcdefghijklmnopqrstuvwxyz0123456789" >&2\nexit 3\n')
    const calls: { args: string[]; input?: string }[] = []
    const outcome = await executeRun(planned, { command, args: [], env: {}, cwd: home, prompt: 'p' }, runFor(home), { operator: 'mk' }, {
      now: () => new Date('2026-09-03T10:04:05Z'),
      gh: async (args, options) => { calls.push({ args, input: options?.input }); return '' },
      git: async () => ({ ok: true, message: '' }),
    })
    expect(outcome.exitCode).toBe(3)
    expect(outcome.handedBack).toBe(true)
    const comment = calls.find(call => call.args[0] === 'issue' && call.args[1] === 'comment')!
    expect(comment.args).toContain('--body-file')
    expect(comment.input).toContain('exit 3')
    expect(comment.input).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    const edit = calls.find(call => call.args[1] === 'edit')!
    expect(edit.args).toEqual(['issue', 'edit', '12', '--repo', 'acme/app', '--add-label', 'needs-operator', '--remove-label', 'working', '--add-assignee', 'mk'])
  })

  test('a hand-back gh cannot post is logged, and never throws out of the tick', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-home-'))
    const command = harnessStub('#!/bin/sh\nexit 1\n')
    const outcome = await executeRun(planned, { command, args: [], env: {}, cwd: home, prompt: 'p' }, runFor(home), { operator: null }, {
      now: () => new Date('2026-09-03T10:04:05Z'),
      gh: async () => { throw new Error('gh issue comment failed: HTTP 403') },
      git: async () => ({ ok: false, message: 'no upstream' }),
    })
    expect(outcome.handedBack).toBe(false)
    expect(outcome.pushed).toBe(false)
    const log = readFileSync(outcome.logFile, 'utf8')
    expect(log).toContain('handback-failed')
    expect(log).toContain('push-failed')
  })
})

describe('worktreeFor', () => {
  test('reads the type off the title prefix and slugs the rest', () => {
    expect(worktreeFor('/w/app', 12, 'feat: vegafactory dispatch --watch')).toEqual({
      path: '/w/app/.vegastack/.worktrees/12-vegafactory-dispatch-watch',
      branch: 'feat/12-vegafactory-dispatch-watch',
      slug: 'vegafactory-dispatch-watch',
      type: 'feat',
    })
  })

  test('a title with no known type prefix is a feat, and the prefix stays in the slug', () => {
    expect(worktreeFor('/w/app', 3, 'make the thing faster').branch).toBe('feat/3-make-the-thing-faster')
    expect(worktreeFor('/w/app', 3, 'spike: try it').slug).toBe('spike-try-it')
  })

  test('a long title is capped without a trailing dash', () => {
    const target = worktreeFor('/w/app', 9, `fix: ${'word '.repeat(20)}`)
    expect(target.slug.length).toBeLessThanOrEqual(40)
    expect(target.slug.endsWith('-')).toBe(false)
  })
})

describe('stopList', () => {
  test('takes the profile bullets verbatim and stops at the next section', () => {
    const devMd = '## Stop and ask\n\n- spending money\n- touching production\n\n## Project rules\n\n- never this one\n'
    expect(stopList(devMd)).toEqual(['spending money', 'touching production'])
  })

  test('a profile with no stop section yields no lines rather than an invented one', () => {
    expect(stopList('## Knobs\n\ndispatch: local\n')).toEqual([])
  })
})

describe('locks', () => {
  test('a lock held by this live process reads as held; releasing frees it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vsk-lock-')), 'app.lock')
    expect(await readLock(path)).toEqual({ held: false, pid: null })
    await holdLock(path, process.pid)
    expect(await readLock(path)).toEqual({ held: true, pid: process.pid })
    await releaseLock(path)
    expect((await readLock(path)).held).toBe(false)
  })

  test('a lock left by a dead process is stale, not a wedge', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vsk-lock-')), 'app.lock')
    writeFileSync(path, JSON.stringify({ pid: 2147483000, at: '2026-09-03T10:00:00Z' }))
    expect(await readLock(path)).toEqual({ held: false, pid: 2147483000 })
  })
})

describe('parseDispatchArgs', () => {
  test('neither --once nor --watch means dry run', () => {
    expect(parseDispatchArgs([]).dryRun).toBe(true)
    expect(parseDispatchArgs(['--once']).dryRun).toBe(false)
  })

  test('--once with --watch is a usage error, and --config needs a value', () => {
    expect(() => parseDispatchArgs(['--once', '--watch'])).toThrow(/--once/)
    expect(() => parseDispatchArgs(['--config'])).toThrow(/--config/)
  })
})

describe('review round 1 — the fixes', () => {
  test('a wiring file that only mentions the guard in a comment is unwired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vsk-guard-'))
    mkdirSync(join(root, '.vegastack/hooks'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.vegastack/hooks/ship-guard.mjs'), '// guard\n')
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ note: 'we should wire .vegastack/hooks/ship-guard.mjs one day', hooks: {} }))
    expect((await shipGuardWired(root, 'claude')).wired).toBe(false)
  })

  test('outcomeOf reads the brief Outcome paragraph, and falls back to nothing it invented', () => {
    const body = '<!-- vsk:v1 type=brief -->\n**Scope:** full-plan\n\n## Outcome\n\nThe dispatcher runs on the mini.\n\nMore detail here.\n\n## Out of scope\n\n- nothing\n'
    expect(outcomeOf(body)).toBe('The dispatcher runs on the mini.')
    expect(outcomeOf('no sections at all')).toBe('')
  })

  test('a stop-and-ask section written as prose still reaches the run', () => {
    const devMd = '## Stop and ask\n\nPause only for a destructive action, a scope change, or spending money.\n\n## Project rules\n\n- not this\n'
    expect(stopList(devMd)).toEqual(['Pause only for a destructive action, a scope change, or spending money.'])
  })
})

describe('parentParallelLaunch', () => {
  const parent = { issue: 104, branch: 'feat/104-factory-runtime', head: 'abc1234', worktree: '/r/.vegastack/.worktrees/104-factory-runtime' }
  const groups = [
    { id: 'api', members: ['#131'], files: ['packages/cli/src/dispatch.ts'] },
    { id: 'docs', members: ['#132'], files: ['README.md'] },
  ]
  const ready = [
    { number: 131, parent: 104, assignee: null, labels: ['ready'] },
    { number: 132, parent: 104, assignee: null, labels: ['ready'] },
  ]

  test('two ready children in disjoint groups become one parent run', () => {
    const launch = parentParallelLaunch(ready, groups, parent)
    expect(launch?.kind).toBe('parent-parallel')
    expect(launch?.parent).toBe(104)
    expect(launch?.children).toEqual([131, 132])
  })
  test('one ready child, an assigned child, or a child outside the groups keeps the ordinary path', () => {
    expect(parentParallelLaunch([ready[0]!], groups, parent)).toBeNull()
    expect(parentParallelLaunch([ready[0]!, { ...ready[1]!, assignee: 'kmanojkumar' }], groups, parent)).toBeNull()
    expect(parentParallelLaunch(ready, [groups[0]!], parent)).toBeNull()
  })
  test('the launch asks for the workflow in plain words and allows the Workflow tool', () => {
    const plan = parentParallelLaunchPlan(parentParallelLaunch(ready, groups, parent)!, parent, {
      harness: 'claude', model: 'fable-5-1', effort: 'high', operator: 'kmanojkumar', subagents: { spawnDepth: 2, concurrent: 4 },
    })
    expect(plan.args).toContain('--permission-mode')
    expect(plan.args).toContain('bypassPermissions')
    expect(plan.args.join(' ')).toContain('--allowed-tools Workflow')
    expect(plan.prompt).toContain('implement-children')
  })
  test('the parent launch reuses the launch table, adding only the Workflow allowance', () => {
    const base = buildLaunchPlan({
      harness: 'claude', model: 'fable-5-1', effort: 'high', stage: 'implement', worktree: parent.worktree,
      issue: { number: 104, title: 'parent' }, operator: 'kmanojkumar', outcome: 'x', stopList: [],
      resume: false, skillPath: null, subagents: { spawnDepth: 2, concurrent: 4 },
    })
    const plan = parentParallelLaunchPlan(parentParallelLaunch(ready, groups, parent)!, parent, {
      harness: 'claude', model: 'fable-5-1', effort: 'high', operator: 'kmanojkumar', subagents: { spawnDepth: 2, concurrent: 4 },
    })
    expect(plan.args.filter(a => a !== plan.prompt)).toEqual([...base.args.filter(a => a !== base.prompt), '--allowed-tools', 'Workflow'])
    expect(plan.env).toEqual(base.env)
  })
  // F28: the parallel path launches the repo's implement harness. On Codex there is no saved
  // workflow and no Workflow tool: the parent is asked to drive children.mjs, whose Codex path is
  // one `codex exec -C <child worktree>` per child.
  test('a codex implement stage launches codex for the parent, with no Workflow allowance and the children.mjs path in the prompt', () => {
    const run = parentParallelLaunch(ready, groups, parent)!
    const plan = parentParallelLaunchPlan(run, parent, {
      harness: 'codex', model: 'gpt-5.6', effort: 'high', operator: 'kmanojkumar', subagents: { spawnDepth: 2, concurrent: 4 },
    })
    const base = buildLaunchPlan({
      harness: 'codex', model: 'gpt-5.6', effort: 'high', stage: 'implement', worktree: parent.worktree,
      issue: { number: 104, title: 'parent' }, operator: 'kmanojkumar', outcome: 'x', stopList: [],
      resume: false, skillPath: null, subagents: { spawnDepth: 2, concurrent: 4 },
    })
    expect(plan.command).toBe('codex')
    expect(plan.args.filter(a => a !== plan.prompt)).toEqual(base.args.filter(a => a !== base.prompt))
    expect(plan.args).not.toContain('--allowed-tools')
    expect(plan.prompt).toContain('--harness codex')
    expect(plan.prompt).not.toContain('saved workflow')
  })
  test('a parent-parallel run replaces its children in the tick', () => {
    const board = { needsPlan: [], ready: [issue(131, ['ready']), issue(132, ['ready'])], corrections: [] }
    const state: DispatchState = { handled: [], lastTick: {} }
    const guards: GuardState = { shipGuard: { wired: true, detail: 'ok' }, lock: { held: false, pid: null }, activeRuns: 0 }
    const policy = parseRepoPolicy('repo: acme/app · main\noperators: kmanojkumar\ndispatch: local\n')
    const plan = planTick({
      repo: 'acme/app', policy, board, rockets: [], state, guards, maxRuns: 4,
      parents: [{ parent, groups, children: ready }],
    })
    expect(plan.runs.map(r => r.issue)).toEqual([104])
    expect(plan.runs[0]?.parallel).toEqual([131, 132])
  })
})

describe('the Codex child launch and the launch table cannot drift', () => {
  test('one child argv is the table argv with -C pointed at the child worktree', async () => {
    const { codexChildLaunch } = await import('../../../skills/dev/dev-implement/scripts/children.mjs')
    const child = { path: '/r/.vegastack/.worktrees/131-x', branch: 'feat/131-x', baseSha: 'abc1234', issue: 131, title: 'x', files: ['a.ts'] }
    const launch = codexChildLaunch(child, { model: 'gpt-5.6', effort: 'high', parentIssue: 104, parentBranch: 'feat/104-p' })
    const table = buildLaunchPlan({
      harness: 'codex', model: 'gpt-5.6', effort: 'high', stage: 'implement', worktree: child.path,
      issue: { number: 131, title: 'x' }, operator: 'kmanojkumar', outcome: 'x', stopList: [],
      resume: false, skillPath: null, subagents: { spawnDepth: 2, concurrent: 4 },
    })
    expect(launch.command).toBe(table.command)
    expect(launch.args.map(a => (a === launch.prompt ? '<prompt>' : a)))
      .toEqual(table.args.map(a => (a === table.prompt ? '<prompt>' : a)))
  })
})

describe('defaultParentCandidates', () => {
  const planBody = [
    '<!-- vsk:v1 type=plan rev=1 -->',
    '## Plan (v1)',
    '**Goal:** a thing exists.',
    '**Approach:** the simple way; alternative B lost on cost.',
    '**Independent groups:**',
    '- `api` — #131 · Files: `packages/cli/src/dispatch.ts`',
    '- `docs` — #132 · Files: `docs/dispatcher.md`',
    '',
    '### Tasks',
    '- [ ] **Task 1: build it**',
    '  - Files — Create: `x.mjs` · Test: `x.test.ts`',
    '  - Interfaces — Produces: `doThing(): number`',
    '  - Steps: edit → verify → commit',
  ].join('\n')

  const ghFor = (comments: Array<{ body: string; user?: { login: string } }>) => async (args: string[]): Promise<string> => {
    if (args[0] === 'issue' && args.includes('parent')) return JSON.stringify({ parent: { number: 104 } })
    if (args[0] === 'issue' && args.includes('title')) return JSON.stringify({ title: 'feat: the factory runtime' })
    if (args[0] === 'api') return JSON.stringify(comments)
    return '{}'
  }

  async function candidatesFor(dir: string, comments: Array<{ body: string; user?: { login: string } }>, operators: string[] = ['mk']) {
    process.env.VSK_PLAN_LINT_SCRIPT = join(import.meta.dir, '../../../skills/dev/dev-plan/scripts/plan-lint.mjs')
    try {
      return await defaultParentCandidates(ghFor(comments), 'acme/app', dir, [issue(131, ['ready']), issue(132, ['ready'])], operators)
    } finally {
      delete process.env.VSK_PLAN_LINT_SCRIPT
    }
  }

  test('the parent worktree is named from the parent issue title, not a placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-parents-'))
    mkdirSync(join(dir, '.vegastack/.worktrees/104-the-factory-runtime'), { recursive: true })
    const candidates = await candidatesFor(dir, [{ body: planBody, user: { login: 'mk' } }])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.parent.worktree).toBe(join(dir, '.vegastack/.worktrees/104-the-factory-runtime'))
    expect(candidates[0]?.parent.branch).toBe('feat/104-the-factory-runtime')
    expect(candidates[0]?.groups.map(group => group.id)).toEqual(['api', 'docs'])
  })

  // F27: a parent whose worktree is gone is not a candidate — its children run one at a time —
  // rather than a run whose cwd does not exist, re-planned and failed on every tick.
  test('a parent whose worktree does not exist is not a candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-parents-'))
    expect(await candidatesFor(dir, [{ body: planBody, user: { login: 'mk' } }])).toEqual([])
  })

  // F51: the plan comment decides whether an unattended bypass run launches and what its children
  // are told they may touch, so only a listed operator's plan counts — as with rockets.
  test('a plan comment from someone outside operators: is not the plan, and the newest operator plan wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-parents-'))
    mkdirSync(join(dir, '.vegastack/.worktrees/104-the-factory-runtime'), { recursive: true })
    expect(await candidatesFor(dir, [{ body: planBody, user: { login: 'mallory' } }])).toEqual([])
    expect(await candidatesFor(dir, [{ body: planBody, user: { login: 'mk' } }], [])).toEqual([])
    const forged = planBody.replace('`packages/cli/src/dispatch.ts`', '`.github/workflows/release.yml`')
    const candidates = await candidatesFor(dir, [{ body: planBody, user: { login: 'mk' } }, { body: forged, user: { login: 'mallory' } }])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.groups[0]?.files).toEqual(['packages/cli/src/dispatch.ts'])
  })
})


describe('managed launches exclude native memory without disabling project instructions', () => {
  const input = { harness: 'codex' as const, model: 'fixture', effort: 'high', stage: 'implement' as const, worktree: '/prepared', issue: { number: 140, title: 'fixture' }, operator: 'mk', outcome: 'fixture', stopList: [], resume: false, skillPath: null, subagents: { spawnDepth: 1, concurrent: 3 } }
  test('Codex has explicit retrieval, generation, import and optional context controls', () => {
    const plan = buildLaunchPlan(input)
    expect(plan.args).toContain('memories.use_memories=false')
    expect(plan.args).toContain('memories.generate_memories=false')
    expect(plan.args).toContain('features.context_management.experimental_mode=false')
    const metadata = { version: 'codex-cli 0.153.4', features: { hooks: true, memories: false, external_agent_memory_import: false, context_management: false } }
    expect(validateManagedLaunch(plan, metadata).ok).toBe(true)
    expect(validateManagedLaunch(plan, { ...metadata, version: 'codex-cli 0.100.0' }).ok).toBe(false)
    expect(validateManagedLaunch(plan, { ...metadata, features: { ...metadata.features, context_management: true } }).ok).toBe(false)
    expect(validateManagedLaunch({ ...plan, args: [...plan.args, '-c', 'memories.use_memories=true'] }, metadata).ok).toBe(false)
  })
  test('Claude disables auto memory only for the managed session, retaining hooks and project guidance', () => {
    const plan = buildLaunchPlan({ ...input, harness: 'claude' })
    expect(plan.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(plan.args).not.toContain('--bare')
    expect(plan.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).not.toBe('1')
    expect(validateManagedLaunch(plan, { version: '2.1.263 (Claude Code)' }).ok).toBe(true)
    expect(validateManagedLaunch({ ...plan, env: { ...plan.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } }, { version: '2.1.263 (Claude Code)' }).ok).toBe(false)
    expect(validateManagedLaunch(plan, { version: '9.0.0 (Claude Code)' }).ok).toBe(false)
  })
})

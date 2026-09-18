import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimBody, claimLine } from '../src/claim.ts'
import {
  APP_ID, STEP_TIMEOUT_MS, agentArgs, appJwt, appKeyPath, board, decide, defaultRunStep, dispatchDir, disjointSiblings,
  drain, filesFromParent, harnessAnswers, hitLimit, hooksWired, listedHere, mintToken, overlaps, parseDispatchArgs,
  parseDispatchers, poll, readActed, readRuns, readiness, resetAt, runDispatch, schedule, serviceCommands, stagePolicy,
  standDown, stepPrompt, tail, unitPath, unitText, unsafeForParallel,
  type Candidate, type Fetch, type Inflight, type PollDeps, type Probe, type RunStep, type StepResult,
} from '../src/dispatch.ts'
import { permissionLookup, snapshot } from '../src/issue.ts'
import { cacheDir, syncIssue } from '../src/issue-cache.ts'
import { FakeGitHub } from './fake-github.ts'

const HOST = 'mac-mini'
let gh: FakeGitHub
let root: string
let home: string

// A repository with a control room, and a home whose clone of it lists this machine.
function project(dispatchers: string | null = `| machine | operator | repos |\n|---|---|---|\n| ${HOST} | mk | o/r |\n`): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')))
  spawnSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), [
    'repo: o/r',
    'control-room: o/control-room#dev@0000000',
    'harness-policy: intake claude default high · plan claude default high · implement claude default high · review codex default xhigh',
    '',
  ].join('\n'))
  const clone = join(home, '.vegastack', 'control-room', 'o')
  mkdirSync(clone, { recursive: true })
  if (dispatchers !== null) writeFileSync(join(clone, 'dispatchers.md'), dispatchers)
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
    const rows = parseDispatchers([
      '# Dispatchers', '',
      '| machine | operator | repos | note |',
      '|---|---|:---:|---|',
      '| Mac-Mini.local | @mk | o/r, o/other | the always-on box |',
      '| builder | - | * | everything |',
      '',
      '- `spare-box` — o/r',
    ].join('\n'))
    expect(rows).toEqual([
      { machine: 'mac-mini', operator: 'mk', repos: ['o/r', 'o/other'] },
      { machine: 'builder', operator: null, repos: ['*'] },
      { machine: 'spare-box', operator: null, repos: ['o/r'] },
    ])
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
})

describe('identity', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

  const keyFile = () => {
    const path = join(root, 'app.pem')
    writeFileSync(path, privateKey)
    return path
  }

  test('the key path follows the environment, then the home default', () => {
    expect(appKeyPath({ VEGAFACTORY_APP_PRIVATE_KEY_FILE: '/keys/app.pem' }, '/home/x')).toBe('/keys/app.pem')
    expect(appKeyPath({}, '/home/x')).toBe('/home/x/.vegastack/vegafactory-app.pem')
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

  test('a reply from someone without write access is not the operator', () => {
    gh.addIssue({ number: 1, labels: ['waiting-on-operator', 'medium'] })
    gh.addComment(1, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan', 'mk')
    gh.addComment(1, 'please build it', 'outsider')
    expect(verdict(1).action).toBe('none')
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

  test('a finished run is not repeated for the same trigger', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const acted = { at: gh.clock, action: 'implement' as const, outcome: 'done' as const, trigger: null, failures: 0, retryAt: null }
    expect(verdict(1, { acted }).action).toBe('none')
    expect(verdict(1, { acted: { ...acted, action: 'plan' as const } }).action).toBe('implement')
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
  const candidate = (number: number, extra: Partial<Candidate> = {}): Candidate => ({ number, action: 'implement', parent: null, files: [], ...extra })

  test('one run per issue, and never more than three', () => {
    const wanted = [1, 2, 3, 4].map((number) => candidate(number, { action: 'plan' }))
    expect(schedule([...wanted, candidate(1, { action: 'plan' })]).map((item) => item.number)).toEqual([1, 2, 3])
  })

  test('merges go one at a time', () => {
    const picked = schedule([candidate(1, { action: 'ship' }), candidate(2, { action: 'ship' }), candidate(3, { action: 'plan' })])
    expect(picked.map((item) => item.action)).toEqual(['ship', 'plan'])
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
    expect(unsafeForParallel('packages/cli/src/dispatch.ts')).toBe(false)
  })

  test('a directory in a file set covers everything under it', () => {
    expect(overlaps('skills/', 'skills/dev/dev-plan/SKILL.md')).toBe(true)
    expect(overlaps('a/b.ts', 'a/b.ts')).toBe(true)
    expect(overlaps('a/b.ts', 'a/c.ts')).toBe(false)
    expect(disjointSiblings(
      { number: 1, action: 'implement', parent: 4, files: ['skills/'] },
      { number: 2, action: 'implement', parent: 4, files: ['skills/dev/x.md'] },
    )).toBe(false)
  })

  test('file sets come from the parent epic\'s plan, and nothing else', () => {
    const plan = ['**Independent groups:**', '- `api` — #131 · Files: `packages/cli/src/issue.ts`, `packages/cli/test/issue.test.ts`', '- `docs` — #132 · Files: `docs/`', ''].join('\n')
    expect(filesFromParent(plan, 131)).toEqual(['packages/cli/src/issue.ts', 'packages/cli/test/issue.test.ts'])
    expect(filesFromParent(plan, 132)).toEqual(['docs/'])
    expect(filesFromParent(plan, 999)).toEqual([])
    expect(filesFromParent(null, 131)).toEqual([])
  })
})

describe('one poll over the board', () => {
  const steps: Array<{ action: string; number: number }> = []
  const runStep = (result: Partial<StepResult> = {}): RunStep => async (step) => {
    steps.push({ action: step.action, number: step.number })
    return { outcome: 'done', note: 'finished', ms: 10, ...result }
  }
  const deps = (over: Partial<PollDeps> = {}): PollDeps => ({
    root, repo: 'o/r', runner: gh.runner, now: () => gh.clock, machine: HOST,
    out: () => {}, runStep: runStep(), standDown: () => 'stood down', ...over,
  })
  // One pass, then everything it started.
  const pass = async (over: Partial<PollDeps> = {}, inflight = new Map<number, Inflight>()) => {
    await poll(deps(over), inflight)
    return drain(inflight)
  }

  beforeEach(() => { steps.length = 0 })

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

  test('a step already running keeps its slot and its issue on the next pass', async () => {
    for (const number of [1, 2, 3, 4]) gh.addIssue({ number, labels: ['planning', 'medium'] })
    const inflight = new Map<number, Inflight>()
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
    gh.addComment(1, 'stop', 'mk')
    const given: string[] = []
    const records = await pass({ standDown: (number: number, reason: string) => { given.push(`${number}:${reason}`); return 'saved, pushed, released' } })
    expect(steps).toEqual([])
    expect(given[0]).toContain('1:@mk said stop')
    expect(records[0]).toMatchObject({ action: 'stop', outcome: 'stopped', note: 'saved, pushed, released' })
  })

  test('a subscription limit gives the issue back and retries after the reset', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const given: string[] = []
    await pass({
      runStep: runStep({ outcome: 'limit', note: 'usage limit reached; try again after 2026-09-18T15:00:00Z' }),
      standDown: (number: number, reason: string) => { given.push(reason); return reason },
    })
    expect(given[0]).toContain('subscription limit')
    const acted = readActed(root)['o/r#1']!
    expect(acted.outcome).toBe('limit')
    expect(new Date(acted.retryAt!).toISOString()).toBe('2026-09-18T15:00:00.000Z')
  })

  test('a step that throws is a failed run, not a dead dispatcher', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const throws: RunStep = async () => { throw new Error('claude is not on PATH') }
    const records = await pass({ runStep: throws })
    expect(records[0]).toMatchObject({ outcome: 'failed', note: 'claude is not on PATH' })
    expect(readActed(root)['o/r#1']!.failures).toBe(1)
  })

  test('a stop whose stand-down throws is a failed run, not a dead dispatcher', async () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    gh.addComment(1, 'stop', 'mk')
    const records = await pass({ standDown: () => { throw new Error('git is missing') } })
    expect(records[0]).toMatchObject({ action: 'stop', outcome: 'failed', note: 'git is missing' })
  })

  test('a failed step backs off, and its own error never lands on the issue', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    const before = gh.issues.get(1)!.comments.length
    await pass({ runStep: runStep({ outcome: 'failed', note: 'claude exited 1: ' + 'x'.repeat(5000) }) })
    expect(gh.issues.get(1)!.comments).toHaveLength(before)
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
    const release = gh.issues.get(1)!.comments.at(-1)!
    expect(release.body).toContain(`type=release owner=${HOST}:1-work by=vegafactory[bot]`)
    expect(release.body).toContain('@mk said stop')
    // Released, so the next session sees a free issue.
    expect(verdict(1).action).toBe('none')
  })

  test('another machine\'s claim is left alone', () => {
    gh.addIssue({ number: 1, labels: ['in-progress', 'small'] })
    held('laptop:1-work')
    expect(down('the subscription limit was reached')).toContain('held by laptop:1-work, so it was left alone')
  })

  test('with nothing held there is nothing to release', () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    expect(down('@mk said stop')).toContain('no live claim to release')
  })
})

describe('readiness and the service', () => {
  const answers: Probe = (command) => ({ code: 0, stdout: command === 'claude' ? 'ok' : 'ok\n', stderr: '' })

  test('hooks count only when both harnesses call the CLI', () => {
    expect(hooksWired(root).ok).toBe(false)
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.codex/hooks.json'), '{"command":"vegafactory hook pre-tool --harness codex"}')
    expect(hooksWired(root)).toMatchObject({ ok: false, detail: expect.stringContaining('only Codex') })
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude/settings.json'), '{"command":"vegafactory hook pre-tool --harness claude"}')
    expect(hooksWired(root).ok).toBe(true)
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

  test('the unit runs this CLI\'s own dispatch run and carries no token', () => {
    const plist = unitText('darwin', { cli: ['/usr/bin/node', '/opt/vegafactory/index.js'], root, repo: 'o/r', logDir: dispatchDir(root) })
    expect(plist).toContain('<string>dispatch</string>')
    expect(plist).toContain('<string>--repo</string>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).not.toMatch(/token|TOKEN|pem/)
    const unit = unitText('linux', { cli: ['vegafactory'], root, repo: 'o/r', logDir: dispatchDir(root) })
    expect(unit).toContain('ExecStart="vegafactory" "dispatch" "run" "--repo" "o/r"')
    expect(unit).toContain('Restart=always')
    expect(unitPath('darwin', '/home/x')).toBe('/home/x/Library/LaunchAgents/com.vegastack.vegafactory.dispatch.plist')
    expect(unitPath('linux', '/home/x')).toBe('/home/x/.config/systemd/user/vegafactory-dispatch.service')
    expect(serviceCommands('linux', '/u', 'disable')[0]).toEqual(['systemctl', '--user', 'disable', '--now', 'vegafactory-dispatch.service'])
    expect(serviceCommands('darwin', '/u', 'enable', 501)[0]).toEqual(['launchctl', 'bootstrap', 'gui/501', '/u'])
  })
})

describe('the step a run makes', () => {
  test('the harness and effort come from dev.md, and `default` pins no model', () => {
    const devMd = readFileSync(join(root, '.vegastack/dev.md'), 'utf8')
    expect(stagePolicy(devMd, 'implement')).toEqual({ harness: 'claude', model: null, effort: 'high' })
    expect(stagePolicy(devMd, 'nothing')).toBeNull()
    expect(agentArgs({ harness: 'claude', model: null, effort: 'high' }, 'go').args).toEqual(['-p', '--effort', 'high', 'go'])
    expect(agentArgs({ harness: 'codex', model: 'gpt-5', effort: 'xhigh' }, 'go')).toEqual({ tool: 'codex', args: ['exec', '-c', 'model=gpt-5', '-c', 'model_reasoning_effort=xhigh', 'go'] })
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
  })

  test('a run\'s output is bounded', () => {
    expect(tail('a\n'.repeat(1000) + 'last').length).toBeLessThanOrEqual(400)
  })

  test('a step past the limit is killed, and its own output is never the whole record', async () => {
    const seen: Array<{ timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv }> = []
    const exec = async (_tool: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => {
      seen.push({ timeoutMs: options.timeoutMs, cwd: options.cwd, env: options.env })
      return { code: null, stdout: 'x'.repeat(9000), stderr: '', timedOut: true }
    }
    const result = await defaultRunStep('', {}, { exec })({ action: 'implement', number: 7, repo: 'o/r', split: false, by: null }, { root })
    expect(seen[0]!.timeoutMs).toBe(STEP_TIMEOUT_MS)
    // Nobody is watching, so a round of questions goes to the issue rather than a question tool.
    expect(seen[0]!.env.VSK_ASK_ROUTE).toBe('issue')
    expect(STEP_TIMEOUT_MS).toBe(20 * 60_000)
    expect(result.outcome).toBe('killed')
    expect(result.note).toContain('past the 20-minute step limit')
  })

  test('a step refuses to start while an API key is in the environment', async () => {
    const exec = async () => ({ code: 0, stdout: 'done', stderr: '', timedOut: false })
    const step = defaultRunStep('', { ANTHROPIC_API_KEY: 'sk-ant-x' }, { exec })
    await expect(step({ action: 'implement', number: 7, repo: 'o/r', split: false, by: null }, { root })).rejects.toThrow(/ANTHROPIC_API_KEY.*subscriptions only/s)
  })
})

describe('the command', () => {
  const run = (argv: string[], over = {}) => {
    const lines: string[] = []
    return runDispatch(argv, { cwd: root, home, host: HOST, env: {}, out: (text) => lines.push(text), runner: gh.runner, ...over })
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

  test('an API key in the environment refuses the run', async () => {
    const result = await run(['run', '--once'], { env: { ANTHROPIC_API_KEY: 'sk-ant-x' } })
    expect(result.code).toBe(2)
    expect(result.text).toContain('ANTHROPIC_API_KEY')
    expect(result.text).toContain('subscriptions only')
  })

  test('status shows the board and this machine\'s runs', async () => {
    gh.addIssue({ number: 1, labels: ['queued', 'small'] })
    gh.addIssue({ number: 2, labels: ['ready-to-ship', 'medium'] })
    const result = await run(['status'])
    expect(result.code).toBe(0)
    expect(result.text).toContain(`${'queued'.padEnd(20)} #1`)
    expect(result.text).toContain(`${'ready-to-ship'.padEnd(20)} #2`)
    expect(result.text).toContain('no dispatcher runs on this machine yet')
  })

  test('enable stops at the first thing that is not ready and installs nothing', async () => {
    const result = await run(['enable'], { run: (() => ({ code: 127, stdout: '', stderr: 'not found' })) as Probe, fetch: (async () => ({ ok: false, status: 404, json: async () => ({}) })) as Fetch })
    expect(result.code).toBe(2)
    expect(result.text).toContain('not ready')
    expect(existsSync(unitPath(process.platform, home))).toBe(false)
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

  test('the flags parse and an unknown verb says so', () => {
    expect(parseDispatchArgs(['run', '--once', '--repo', 'o/r', '--json'])).toEqual({ verb: 'run', flags: { repo: 'o/r' }, json: true, dryRun: false, once: true })
    expect(() => parseDispatchArgs(['run', '--repo'])).toThrow('--repo needs a value')
    expect(runDispatch(['frobnicate'], { cwd: root, home, host: HOST, env: {}, out: () => {} })).rejects.toThrow('unknown dispatch verb')
  })
})

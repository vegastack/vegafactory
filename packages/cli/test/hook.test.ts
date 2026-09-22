import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { claim } from '../src/claim.ts'
import type { GhRunner } from '../src/gh.ts'
import { detachBounded, issueFromBranch, issueFromWorktree, locate, readHookInput, runHook, type HookDeps } from '../src/hook.ts'
import { ackBody, artifactHash } from '../src/issue.ts'
import { addLesson, readLessons } from '../src/learning.ts'
import { installArgs, packageVersion, readUpdateNote, SELF_UPDATE_LIMIT_S, writeUpdateNote } from '../src/self-update.ts'
import { FakeGitHub } from './fake-github.ts'
import { refuseAmbientHome } from './no-ambient-home.ts'

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

let gh: FakeGitHub
refuseAmbientHome()

let root: string
let fakeHome: string
let tree: string
let plain: string
let out: string[]
let detached: string[][]
let stats: string[][]
let prHead: string
let prHeadOid: string
let detachPid: number | undefined
const OWNER = 'box:7'
const ctx = () => ({ root, repo: 'o/r', number: 7, runner: gh.runner })

// The fake answers `gh api`; the hook also asks `gh pr view` for a merge's head branch.
const runner: GhRunner = (args, input) => {
  if (args[0] === 'pr' && args[1] === 'view') {
    const number = /^[\w.-]+\/(\d+)-/.exec(prHead)?.[1]
    return { code: 0, stdout: JSON.stringify({ headRefName: prHead, headRefOid: prHeadOid, closingIssuesReferences: number ? [{ number: Number(number) }] : [] }), stderr: '' }
  }
  return gh.runner(args, input)
}

const deps = (): HookDeps => ({
  runner, now: () => gh.clock, out: (text) => out.push(text), cli: ['vf'], host: 'box',
  latest: async () => '0.20.1',
  // Never the real home: the update note lives there, and a test that wrote to it would change
  // what this operator's own machine believes about the last registry check.
  home: fakeHome,
  // Usage collection rides on the same detached runner; every other assertion counts the rest.
  detach: (command) => { (command[1] === 'stats' ? stats : detached).push(command); return detachPid },
})

async function hook(event: string, payload: unknown, harness = 'claude') {
  out = []
  const stdin = Readable.from([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))])
  const code = await runHook([event, '--harness', harness], deps(), stdin)
  return { code, text: out.join('\n'), json: () => JSON.parse(out.join('\n')) }
}

const bash = (command: string, cwd = tree) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } })

// A commit stamped with the time the hook's clock reads, as a real one made by a tool call would be.
const commitNow = (cwd: string, message: string) => {
  git(cwd, 'add', '-A')
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: new Date(gh.clock).toISOString() },
  })
  if (result.status !== 0) throw new Error(`git commit: ${result.stderr}`)
}

// One session's own tool call, with the commit it makes landing inside it.
async function commitByTool(session: string, message: string, work: () => void) {
  await hook('pre-tool', { ...bash(`git commit -m ${JSON.stringify(message)}`), session_id: session })
  work()
  commitNow(tree, message)
  await hook('post-tool', { cwd: tree, session_id: session, tool_name: 'Bash' })
}

beforeEach(() => {
  gh = new FakeGitHub()
  gh.permissions.set('mk', 'admin')
  gh.addIssue({ number: 7, body: 'Export CSV', labels: ['queued', 'small'] })
  out = []
  detached = []
  stats = []
  detachPid = undefined
  prHead = 'feat/7-export'
  prHeadOid = git(root, 'rev-parse', 'HEAD')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hook-')))
  fakeHome = join(base, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const origin = join(base, 'origin.git')
  root = join(base, 'repo')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'clone', '-q', origin, root)
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r · default branch main\nvegafactory-update: off\n\n## Ship\n- ask: `bun run release`\n')
  writeFileSync(join(root, '.gitignore'), '.vegastack/.tmp/\n.vegastack/.worktrees/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', '--auto')
  tree = join(root, '.vegastack/.worktrees/7')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/7-export', tree)
  plain = join(base, 'plain')
  git(base, 'clone', '-q', origin, plain)
})

describe('finding the issue', () => {
  test('from the worktree folder or the branch name', () => {
    expect(issueFromWorktree('/r/.vegastack/.worktrees/216-coordination')).toBe(null)
    expect(issueFromWorktree('/r/.vegastack/.worktrees/216')).toBe(216)
    expect(issueFromWorktree('/home/x/.vegafactory/worker/repos/o__r/issues/216')).toBe(216)
    expect(issueFromWorktree('/r/.vegastack/.worktrees/x')).toBe(null)
    expect(issueFromWorktree('/r/issues/216')).toBe(null)
    expect(issueFromBranch('feat/216-coordination')).toBe(null)
    expect(issueFromBranch('feat/216-coordination', 216)).toBe(216)
    expect(issueFromBranch('main')).toBe(null)
  })

  test('an existing digit-led direct checkout is not issue-bound', () => {
    const direct = join(root, '.vegastack', '.worktrees', '42-emergency')
    git(root, 'worktree', 'add', '-q', '-b', 'fix/42-emergency', direct)
    expect(issueFromWorktree(direct)).toBe(null)
    expect(issueFromBranch('fix/42-emergency')).toBe(null)
    expect(locate(direct)).toBe(null)
  })

  test('detached attended and worker number-only checkouts retain issue identity', () => {
    const attended = join(root, '.vegastack', '.worktrees', '8')
    git(root, 'worktree', 'add', '-q', '-b', 'feat/8-attended', attended)
    git(attended, 'switch', '-q', '--detach')
    expect(locate(attended)?.number).toBe(8)

    const holder = join(dirname(root), '.vegafactory', 'worker', 'repos', 'o__r')
    const worker = join(holder, 'issues', '9')
    mkdirSync(join(holder, 'issues'), { recursive: true })
    git(root, 'worktree', 'add', '-q', '-b', 'feat/9-worker', worker)
    git(worker, 'switch', '-q', '--detach')
    expect(locate(worker)?.number).toBe(9)
  })

  test('input is bounded: an oversized payload is null but keeps its head', async () => {
    const big = JSON.stringify({ tool_name: 'Write', tool_input: { content: 'x'.repeat(70_000) } })
    const input = await readHookInput(Readable.from([Buffer.from(big)]))
    expect(input.payload).toBe(null)
    expect(input.head).toContain('"tool_name":"Write"')
  })
})

describe('guard', () => {
  test('outside an issue only the guard runs: Claude gets ask, Codex gets deny, a harmless command gets nothing', async () => {
    const asked = await hook('pre-tool', bash('git push origin main', plain))
    expect(asked.json().hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' })
    expect(asked.json().hookSpecificOutput.permissionDecisionReason).toContain('pushing to main')
    expect((await hook('pre-tool', bash('git push origin main', plain), 'codex')).json().hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await hook('pre-tool', bash('ls', plain))).text).toBe('')
    expect((await hook('pre-tool', bash('bun run release', plain))).json().hookSpecificOutput.permissionDecisionReason).toContain('ask: step')
    for (const event of ['session-start', 'prompt', 'post-tool', 'stop', 'session-end']) {
      expect((await hook(event, { cwd: plain })).text, event).toBe('')
    }
    expect(gh.calls).toEqual([])
  })

  test('a Ship ask: line edited in the worktree does not loosen the committed one', async () => {
    writeFileSync(join(tree, '.vegastack/dev.md'), 'repo: o/r\n\n## Ship\n- auto: `bun run release`\n')
    expect((await hook('pre-tool', bash('bun run release'))).json().hookSpecificOutput.permissionDecision).toBe('ask')
  })

  test('an unreadable or oversized payload asks unless it names a read-only or file tool', async () => {
    expect((await hook('pre-tool', 'not json')).json().hookSpecificOutput.permissionDecision).toBe('ask')
    expect((await hook('pre-tool', JSON.stringify({ tool_name: 'Write', tool_input: { content: 'x'.repeat(70_000) } }))).text).toBe('')
    expect((await hook('pre-tool', JSON.stringify({ tool_name: 'exec_command', tool_input: { cmd: 'x'.repeat(70_000) } }), 'codex')).json().hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await hook('pre-tool', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(70_000) } }))).json().hookSpecificOutput.permissionDecision).toBe('ask')
  })

  test('Codex exec_command payloads are guarded, and a shell tool with an unknown shape asks', async () => {
    const exec = (cmd: unknown) => ({ hook_event_name: 'PreToolUse', cwd: plain, model: 'gpt-5.5', tool_name: 'exec_command', tool_input: { cmd } })
    expect((await hook('pre-tool', exec('git push origin main'), 'codex')).json().hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await hook('pre-tool', exec(['git', 'push', 'origin', 'main']), 'codex')).json().hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await hook('pre-tool', exec('ls'), 'codex')).text).toBe('')
    const odd = { hook_event_name: 'PreToolUse', cwd: plain, tool_name: 'exec_command', tool_input: { script: 'git push origin main' } }
    expect((await hook('pre-tool', odd, 'codex')).json().hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await hook('pre-tool', { ...odd, tool_name: 'Bash' })).json().hookSpecificOutput.permissionDecision).toBe('ask')
    expect((await hook('pre-tool', { cwd: plain, tool_name: 'Grep', tool_input: { pattern: 'x' } })).text).toBe('')
  })

  test('a guard wired without a harness blocks', async () => {
    out = []
    await runHook(['pre-tool'], deps(), Readable.from([Buffer.from(JSON.stringify(bash('ls')))]))
    expect(JSON.parse(out[0]!).decision).toBe('block')
  })

  test('gh pr merge passes only with a ship it after the latest evidence on the issue its branch names', async () => {
    expect((await hook('pre-tool', bash('gh pr merge 12 --squash'))).json().hookSpecificOutput.permissionDecision).toBe('ask')
    const head = git(root, 'rev-parse', 'HEAD')
    gh.addComment(7, `<!-- vsk:v1 type=evidence branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works\n- [ ] done`)
    gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
    expect((await hook('pre-tool', bash('gh pr merge 12 --squash'))).text).toBe('')
    expect((await hook('pre-tool', bash('gh pr merge --squash'))).text).toBe('')
    expect((await hook('pre-tool', bash('gh pr merge 12 --admin'))).text).toContain('"ask"')
    expect((await hook('pre-tool', bash('gh -R x/y pr merge 12'))).text).toContain('"ask"')
    prHead = 'feat/8-other'
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toContain('"ask"')
    prHead = 'feat/7-export'
    prHeadOid = 'f'.repeat(40)
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toContain('"ask"')
    prHeadOid = head
    // Editing the evidence after "ship it" voids it, as issue check says; ticking a box does not.
    const evidence = gh.issues.get(7)!.comments.find((c) => c.body.includes('type=evidence'))!
    gh.editComment(evidence.id, `<!-- vsk:v1 type=evidence branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works\n- [x] done`)
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toBe('')
    gh.editComment(evidence.id, `<!-- vsk:v1 type=evidence branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works, edited`)
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toContain('"ask"')
    gh.editComment(evidence.id, `<!-- vsk:v1 type=evidence branch=feat/7-export sha=${head.slice(0, 7)} -->\nit works`)
    gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toBe('')
    gh.addComment(7, '<!-- vsk:v1 type=evidence -->\nnew evidence')
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toContain('"ask"')
  })
})

describe('session context', () => {
  test('session-start names the issue, its holder and its local copy', async () => {
    const result = await hook('session-start', { cwd: tree, model: 'opus' })
    const context = result.json().hookSpecificOutput
    expect(context.hookEventName).toBe('SessionStart')
    expect(context.additionalContext).toContain('issue #7 (o/r), state queued, held by nobody')
    expect(context.additionalContext).toContain('.vegastack/.tmp/issues/o__r/7')
    expect(context.additionalContext).toContain('vegafactory issue sync 7')
    expect(context.additionalContext).toContain('vegafactory issue claim 7 --harness claude --model opus')
  })

  test('prompt warns only when someone else holds the issue', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    expect((await hook('prompt', { cwd: tree })).text).toBe('')
    claim(ctx(), { owner: 'other:7-export', kind: 'session', harness: 'codex', model: 'gpt', takeBackBy: 'mk' }, gh.clock)
    gh.clock += 61_000
    const text = (await hook('prompt', { cwd: tree, model: 'opus' }, 'codex')).json().hookSpecificOutput.additionalContext
    expect(text).toContain('held by other:7-export (codex · gpt)')
    expect(text).toContain('vegafactory issue claim 7 --harness codex --model opus --take-back-by <login>')
  })
})

describe('ownership', () => {
  test('after a take-back, file and shell tools are denied and uncommitted work is saved once', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    expect((await hook('pre-tool', bash('ls'))).text).toBe('')
    // Another machine takes it back; its cache is not ours.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'hook-other-')))
    claim({ ...ctx(), root: elsewhere }, { owner: 'other:1-x', kind: 'session', harness: 'codex', model: 'gpt', takeBackBy: 'mk' }, gh.clock)
    writeFileSync(join(tree, 'draft.txt'), 'unsaved')

    // The local file is trusted for a minute, then GitHub is asked again.
    expect((await hook('pre-tool', bash('ls'))).text).toBe('')
    gh.clock += 61_000
    const denied = (await hook('pre-tool', bash('ls'))).json().hookSpecificOutput
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain('held by other:1-x')
    expect(denied.permissionDecisionReason).toContain('committed and pushed to feat/7-export')
    // The work stays on the issue branch; no other branch is made.
    expect(git(tree, 'branch', '--show-current')).toBe('feat/7-export')
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('wip: #7 rescued uncommitted work from 7')
    expect(git(tree, 'ls-remote', 'origin', 'feat/7-export')).toContain(git(tree, 'rev-parse', 'HEAD'))
    expect(git(tree, 'ls-remote', '--heads', 'origin')).not.toContain('rescue/')
    expect(git(tree, 'status', '--porcelain')).toBe('')

    const again = (await hook('pre-tool', { ...bash('ls'), tool_name: 'Edit' })).json().hookSpecificOutput
    expect(again.permissionDecision).toBe('deny')
    expect(again.permissionDecisionReason).not.toContain('pushed')
    expect((await hook('pre-tool', { cwd: tree, tool_name: 'Read', tool_input: { file_path: 'x' } })).text).toBe('')
    // The Stop checkpoint leaves a lost worktree alone.
    writeFileSync(join(tree, 'later.txt'), 'x')
    await hook('stop', { cwd: tree })
    expect(detached).toEqual([])
  })

  test('a rescue whose push is rejected keeps the commit local and says so, never forcing', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    // The new holder pushed first, so the remote branch moved.
    git(plain, 'switch', '-q', '-c', 'feat/7-export')
    writeFileSync(join(plain, 'theirs.txt'), 'theirs')
    git(plain, 'add', '-A')
    git(plain, 'commit', '-q', '-m', 'theirs')
    git(plain, 'push', '-q', 'origin', 'feat/7-export')
    const theirs = git(plain, 'rev-parse', 'HEAD')
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'hook-other-')))
    claim({ ...ctx(), root: elsewhere }, { owner: 'other:1-x', kind: 'session', harness: 'codex', model: 'gpt', takeBackBy: 'mk' }, gh.clock)
    writeFileSync(join(tree, 'draft.txt'), 'unsaved')
    gh.clock += 61_000
    const denied = (await hook('pre-tool', bash('ls'))).json().hookSpecificOutput
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain('the push was rejected')
    expect(denied.permissionDecisionReason).toContain('the commit stays local')
    expect(git(tree, 'log', '-1', '--format=%s')).toStartWith('wip: #7 rescued')
    expect(git(tree, 'ls-remote', 'origin', 'feat/7-export')).toContain(theirs)
  })

  test('an oversized file-tool payload still gets the ownership check; only read-only tools pass unread', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    const big = (tool: string) => JSON.stringify({ tool_name: tool, tool_input: { content: 'x'.repeat(70_000) } })
    const home = process.cwd()
    process.chdir(tree)
    try {
      expect((await hook('pre-tool', big('Write'))).text).toBe('')
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'hook-other-')))
      claim({ ...ctx(), root: elsewhere }, { owner: 'other:1-x', kind: 'session', harness: 'codex', model: 'gpt', takeBackBy: 'mk' }, gh.clock)
      gh.clock += 61_000
      expect((await hook('pre-tool', big('Write'))).json().hookSpecificOutput.permissionDecision).toBe('deny')
      expect((await hook('pre-tool', big('apply_patch'), 'codex')).json().hookSpecificOutput.permissionDecision).toBe('deny')
      expect((await hook('pre-tool', big('Read'))).text).toBe('')
      expect((await hook('pre-tool', big('mcp__x__upload'))).json().hookSpecificOutput.permissionDecision).toBe('ask')
    } finally { process.chdir(home) }
  })

  test('a GitHub failure never blocks a tool', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    const broken: GhRunner = () => { throw new Error('offline') }
    out = []
    const code = await runHook(['pre-tool', '--harness', 'claude'], { ...deps(), runner: broken }, Readable.from([Buffer.from(JSON.stringify(bash('ls')))]))
    expect(code).toBe(0)
    expect(out).toEqual([])
    for (const event of ['session-start', 'prompt', 'stop', 'session-end', 'post-tool']) {
      expect(await runHook([event, '--harness', 'claude'], { ...deps(), runner: broken, now: () => gh.clock + 3_600_000 }, Readable.from([Buffer.from(JSON.stringify({ cwd: tree }))])), event).toBe(0)
    }
  })
})

describe('heartbeat and checkpoints', () => {
  const local = () => JSON.parse(readFileSync(join(tree, '.vegastack/.tmp/claims/7.json'), 'utf8'))

  test('post-tool counts active minutes locally and pushes a heartbeat at most every five minutes', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    await hook('pre-tool', bash('ls'))
    await hook('post-tool', { cwd: tree })
    expect(detached).toEqual([['vf', 'issue', 'heartbeat', '7', '--repo', 'o/r', '--active', '0']])
    gh.clock += 2 * 60_000
    await hook('post-tool', { cwd: tree })
    expect(detached).toHaveLength(1)
    expect(local().activeMs).toBe(2 * 60_000)
    gh.clock += 10 * 60_000 // idle: not counted
    await hook('post-tool', { cwd: tree })
    expect(local().activeMs).toBe(2 * 60_000)
    expect(detached.at(-1)).toEqual(['vf', 'issue', 'heartbeat', '7', '--repo', 'o/r', '--active', '2'])
    gh.clock += 60_000
    await hook('session-end', { cwd: tree })
    expect(detached).toHaveLength(3)
    // The detached command the hook starts really moves the heartbeat.
    const [, , , n, , repo, , active] = detached.at(-1)!
    expect([n, repo, active]).toEqual(['7', 'o/r', '3'])
    expect(gh.issues.get(7)!.comments.some((c) => c.body.includes('type=release'))).toBe(false)
  })

  test('a running background heartbeat suppresses the next one until its lifetime ends', async () => {
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    detachPid = process.pid
    await hook('pre-tool', bash('ls'))
    await hook('post-tool', { cwd: tree })
    await hook('session-end', { cwd: tree })
    expect(detached).toHaveLength(1)
    gh.clock += 61_000
    await hook('session-end', { cwd: tree })
    expect(detached).toHaveLength(2)
  })

  test('a detached process and its children are killed when the lifetime passes', async () => {
    const pidFile = join(tree, 'child.pid')
    const started = detachBounded(['sh', '-c', `echo $$ > '${pidFile}'; sleep 30`], tree, 1)
    expect(typeof started).toBe('number')
    const deadline = Date.now() + 5000
    let child = 0
    while (!child && Date.now() < deadline) { await Bun.sleep(50); try { child = Number(readFileSync(pidFile, 'utf8')) } catch { /* not yet */ } }
    expect(child).toBeGreaterThan(0)
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive(child)).toBe(true)
    while (alive(child) && Date.now() < deadline) await Bun.sleep(100)
    expect(alive(child)).toBe(false)
  })

  test('no heartbeat is pushed for a worktree that holds nothing', async () => {
    await hook('pre-tool', bash('ls'))
    await hook('post-tool', { cwd: tree })
    await hook('session-end', { cwd: tree })
    expect(detached).toEqual([])
  })

  test('stop commits the turn as WIP and pushes the branch in the background, never forced', async () => {
    await hook('stop', { cwd: tree })
    expect(detached).toEqual([])
    writeFileSync(join(tree, 'feature.txt'), 'work')
    await hook('stop', { cwd: tree, stop_hook_active: false })
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('wip: #7 turn checkpoint')
    expect(git(tree, 'status', '--porcelain')).toBe('')
    expect(detached).toHaveLength(1)
    expect(detached[0]!.join(' ')).toContain('git push --quiet -u origin')
    expect(detached[0]!.join(' ')).not.toMatch(/--force|push [^|]*-f\b|\+HEAD/)
    const [cmd, ...args] = detached[0]!
    expect(spawnSync(cmd!, args, { cwd: tree }).status).toBe(0)
    expect(git(tree, 'ls-remote', 'origin', 'feat/7-export')).toContain(git(tree, 'rev-parse', 'HEAD'))
  })

  test('a rejected checkpoint push keeps the commit local and is reported on the next prompt and stop', async () => {
    git(plain, 'switch', '-q', '-c', 'feat/7-export')
    git(plain, 'commit', '-q', '--allow-empty', '-m', 'someone else')
    git(plain, 'push', '-q', 'origin', 'feat/7-export')
    writeFileSync(join(tree, 'feature.txt'), 'work')
    await hook('stop', { cwd: tree })
    const [cmd, ...args] = detached[0]!
    expect(spawnSync(cmd!, args, { cwd: tree }).status).not.toBe(0)
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('wip: #7 turn checkpoint')
    const prompt = (await hook('prompt', { cwd: tree })).json().hookSpecificOutput.additionalContext
    expect(prompt).toContain('The last WIP push of feat/7-export was rejected')
    const stop = (await hook('stop', { cwd: tree })).json()
    expect(stop.systemMessage).toContain('the commit stays local')
  })

  test('the lessons request goes out once per working session and never on a chat-only one', async () => {
    const learnings = join(root, '.vegastack/.tmp/learnings.md')
    // A session that commits nothing has no lessons to give.
    await hook('session-start', { cwd: tree, session_id: 's1' })
    expect((await hook('stop', { cwd: tree, session_id: 's1' })).text).toBe('')

    writeFileSync(join(tree, 'feature.txt'), 'work')
    const asked = (await hook('stop', { cwd: tree, session_id: 's1' })).json().hookSpecificOutput
    expect(asked.hookEventName).toBe('Stop')
    expect(asked.additionalContext).toContain('which general lessons did it teach')
    expect(asked.additionalContext).toContain('vegafactory learning add')
    expect(asked.additionalContext).toContain('not the ones specific to #7')
    expect(asked.additionalContext).toContain("only on the operator's yes")
    // Nothing to say means saying nothing: no sentinel a model could write over the queue with.
    expect(asked.additionalContext).toContain(`leave the queue in ${learnings} exactly as it is`)
    expect(asked.additionalContext).not.toContain('the single word none')

    // Once per session id, however many more turns commit.
    writeFileSync(join(tree, 'more.txt'), 'work')
    expect((await hook('stop', { cwd: tree, session_id: 's1' })).text).toBe('')
    // The draft the request names is a folder of its own, made only for a session being asked.
    const draft = /to (\S+lessons\.md)/.exec(asked.additionalContext)![1]!
    expect(existsSync(dirname(draft))).toBe(true)
    expect(readdirSync(join(root, '.vegastack/.tmp/lessons'))).toHaveLength(1)

    // The next session asks again, and Codex gets its own documented continuation.
    await hook('session-start', { cwd: tree, session_id: 's2' }, 'codex')
    writeFileSync(join(tree, 'again.txt'), 'work')
    const codex = (await hook('stop', { cwd: tree, session_id: 's2' }, 'codex')).json()
    expect(codex.decision).toBe('block')
    expect(codex.reason).toContain('which general lessons did it teach')
    expect(codex.hookSpecificOutput).toBeUndefined()
  })

  const marks = () => JSON.parse(readFileSync(join(tree, '.vegastack/.tmp/claims/7.sessions.json'), 'utf8'))

  test('two sessions in one worktree keep their own baseline and answered state', async () => {
    // Both start from the same HEAD; the worktree's HEAD is shared, the marks are not.
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })
    expect(Object.keys(marks()).sort()).toEqual(['a', 'b'])

    // A works and is asked.
    writeFileSync(join(tree, 'from-a.txt'), 'work')
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
    // B then ends a chat-only turn: A's commit is not B's work, so B is not asked.
    expect((await hook('stop', { cwd: tree, session_id: 'b' })).text).toBe('')
    expect(marks().b.asked).toBe(false)

    // B's own working turn is asked, and A is not asked a second time.
    writeFileSync(join(tree, 'from-b.txt'), 'work')
    expect((await hook('stop', { cwd: tree, session_id: 'b' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
    writeFileSync(join(tree, 'from-a-again.txt'), 'work')
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).text).toBe('')
    expect([marks().a.asked, marks().b.asked]).toEqual([true, true])
  })

  test('a commit made by hand belongs to the session that ran it, whoever stops first', async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })

    // A commits inside a writing tool of its own: that pair is the evidence.
    await commitByTool('a', 'a commits by hand', () => writeFileSync(join(tree, 'by-hand.txt'), 'work'))

    // B stops first and has done nothing: the shared HEAD moved, but not by B.
    expect((await hook('stop', { cwd: tree, session_id: 'b' })).text).toBe('')
    expect([marks().b.worked, marks().b.asked]).toEqual([false, false])

    // A stops second and is still asked — B's Stop did not spend or move A's mark.
    expect(marks().a.worked).toBe(true)
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
    expect(marks().a.asked).toBe(true)
  })

  test("a session that only read is not credited with a neighbour's commit", async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })

    // B commits between A's events.
    await commitByTool('b', 'b commits', () => writeFileSync(join(tree, 'from-b.txt'), 'work'))

    // A then runs a tool that cannot commit anything. A read opens no window at all.
    await hook('pre-tool', { cwd: tree, session_id: 'a', tool_name: 'Read', tool_input: { file_path: 'x' } })
    await hook('post-tool', { cwd: tree, session_id: 'a', tool_name: 'Read' })
    expect(marks().a.pending).toBeUndefined()
    expect(marks().a.worked).toBe(false)

    // So chat-only A is not asked, and B is asked on its own Stop.
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).text).toBe('')
    expect((await hook('stop', { cwd: tree, session_id: 'b' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
  })

  test("a file tool opens no window, so a commit during it belongs to the session that ran it", async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })

    // A is editing a file — a file tool cannot commit, so it is given no window at all.
    await hook('pre-tool', { cwd: tree, session_id: 'a', tool_name: 'Write', tool_input: { file_path: join(tree, 'a.txt'), content: 'x' } })
    expect(marks().a.pending).toBeUndefined()
    // B commits inside its own shell tool while A's edit is still in flight.
    await commitByTool('b', 'b commits during an edit of a', () => writeFileSync(join(tree, 'from-b.txt'), 'work'))
    await hook('post-tool', { cwd: tree, session_id: 'a', tool_name: 'Write' })

    expect(marks().a.pending).toBeUndefined()
    expect([marks().a.worked, marks().b.worked]).toEqual([false, true])
    expect(marks().b.credited).toBe(git(tree, 'rev-parse', 'HEAD'))
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).text).toBe('')
    expect((await hook('stop', { cwd: tree, session_id: 'b' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
  })

  test('a long tool that cannot commit is no rival: the session that ran git commit keeps the credit', async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })

    // A starts a long shell tool that could not commit anything; B commits while it runs.
    await hook('pre-tool', { ...bash('sleep 30'), session_id: 'a' })
    expect(marks().a.pending.commits).toBe(false)
    await commitByTool('b', 'b commits during a long tool of a', () => writeFileSync(join(tree, 'from-b.txt'), 'work'))
    const commit = git(tree, 'rev-parse', 'HEAD')

    // B is the only window that could have made it, so B gets it — no checkpoint needed.
    expect(marks().b.credited).toBe(commit)
    expect([marks().a.worked, marks().b.worked]).toEqual([false, true])
    await hook('post-tool', { cwd: tree, session_id: 'a', tool_name: 'Bash' })
    expect(marks().a.worked).toBe(false)
    expect(marks().a.credited).toBeUndefined()

    expect((await hook('stop', { cwd: tree, session_id: 'a' })).text).toBe('')
    expect((await hook('stop', { cwd: tree, session_id: 'b' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
    // B was asked for the commit it made, not for anything its Stop added.
    expect(marks().b.credited).toBe(commit)
  })

  test('two sessions committing at once credit nobody, and the commit is never re-judged', async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })

    // Both are inside a `git commit` of their own when one of them lands.
    await hook('pre-tool', { ...bash('git commit -m "a commits"'), session_id: 'a' })
    await commitByTool('b', 'b commits first', () => writeFileSync(join(tree, 'from-b.txt'), 'work'))
    const contested = git(tree, 'rev-parse', 'HEAD')
    expect([marks().a.judged, marks().b.judged]).toEqual([contested, contested])
    expect([marks().a.worked, marks().b.worked]).toEqual([false, false])

    // A's window closing later cannot re-open the ruling.
    await hook('post-tool', { cwd: tree, session_id: 'a', tool_name: 'Bash' })
    expect([marks().a.worked, marks().a.credited]).toEqual([false, undefined])
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).text).toBe('')
  })

  test('a command the parser cannot see through contends rather than hand over the credit', async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })
    // A release script can commit without saying so anywhere a parser can read.
    await hook('pre-tool', { ...bash('./scripts/release.sh --write'), session_id: 'a' })
    expect(marks().a.pending.commits).toBe(true)
    await commitByTool('b', 'b commits during a release script', () => writeFileSync(join(tree, 'from-b.txt'), 'work'))
    expect([marks().a.worked, marks().b.worked]).toEqual([false, false])
    expect(marks().b.judged).toBe(git(tree, 'rev-parse', 'HEAD'))
  })

  test("a writing tool that commits nothing is not credited with a neighbour's commit either", async () => {
    await hook('session-start', { cwd: tree, session_id: 'a' })
    await hook('session-start', { cwd: tree, session_id: 'b' })
    // A's window is open, and B's commit lands inside it — but from a HEAD A never saw move by its
    // own hand. The evidence is a commit made during A's tool call, which this is not: it is B's,
    // made before A's tool started.
    await commitByTool('b', 'b commits first', () => writeFileSync(join(tree, 'from-b.txt'), 'work'))
    gh.clock += 5000
    await hook('pre-tool', { ...bash('ls'), session_id: 'a' })
    await hook('post-tool', { cwd: tree, session_id: 'a', tool_name: 'Bash' })
    expect(marks().a.worked).toBe(false)
    expect((await hook('stop', { cwd: tree, session_id: 'a' })).text).toBe('')
  })

  test('a session-start whose refresh fails still records the baseline', async () => {
    const broken: GhRunner = () => { throw new Error('offline') }
    const stdin = () => Readable.from([Buffer.from(JSON.stringify({ cwd: tree, session_id: 'c' }))])
    expect(await runHook(['session-start', '--harness', 'claude'], { ...deps(), runner: broken }, stdin())).toBe(0)
    expect(JSON.parse(readFileSync(join(tree, '.vegastack/.tmp/claims/7.sessions.json'), 'utf8')).c.asked).toBe(false)
    writeFileSync(join(tree, 'after-failure.txt'), 'work')
    expect((await hook('stop', { cwd: tree, session_id: 'c' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
  })

  test('a warning and the lessons request travel in one Stop object', async () => {
    await hook('session-start', { cwd: tree, session_id: 's3' })
    await commitByTool('s3', 'real work', () => writeFileSync(join(tree, 'real.txt'), 'work'))
    writeFileSync(join(tree, '.env'), 'X=1\n')
    const both = (await hook('stop', { cwd: tree, session_id: 's3' })).json()
    expect(both.systemMessage).toContain('.env')
    expect(both.hookSpecificOutput.additionalContext).toContain('which general lessons did it teach')
  })

  test('session-start shows the lessons waiting for a dev.md line, and a silent session keeps them', async () => {
    addLesson(root, 'the skill scan reads the built bundle')
    const context = (await hook('session-start', { cwd: tree, session_id: 's4' })).json().hookSpecificOutput.additionalContext
    expect(context).toContain('the skill scan reads the built bundle')
    expect(context).toContain('ONE .vegastack/dev.md line')
    expect(context).toContain('vegafactory learning accept')
    expect(context).toContain('control-room lines stay manual')

    // The session works, is asked, and records nothing. The older lesson is still waiting.
    writeFileSync(join(tree, 'work.txt'), 'work')
    expect((await hook('stop', { cwd: tree, session_id: 's4' })).json().hookSpecificOutput.additionalContext).toContain('which general lessons')
    expect(readLessons(root).map((lesson) => lesson.text)).toEqual(['the skill scan reads the built bundle'])
    expect((await hook('session-start', { cwd: tree, session_id: 's5' })).json().hookSpecificOutput.additionalContext).toContain('the skill scan reads the built bundle')
  })

  test('a link planted at the old predictable temp name is not written through', async () => {
    // The claim file and the session marks were both written through `<path>.<pid>.tmp`, which a
    // link at that name would have turned into a write to whatever it pointed at.
    const claims = join(tree, '.vegastack/.tmp/claims')
    mkdirSync(claims, { recursive: true })
    const devMd = join(root, '.vegastack/dev.md')
    const before = readFileSync(devMd, 'utf8')
    // The temp names nothing should ever touch, and a destination file whose name is public.
    const temps = [join(claims, `7.json.${process.pid}.tmp`), join(claims, `7.sessions.json.${process.pid}.tmp`)]
    const pidFile = join(claims, '7.heartbeat.pid')
    for (const path of [...temps, pidFile]) symlinkSync(devMd, path)

    // Claimed, so the heartbeat writes its pid file too.
    claim(ctx(), { owner: OWNER, kind: 'session', harness: 'claude', model: 'opus' }, gh.clock)
    detachPid = process.pid
    await hook('session-start', { cwd: tree, session_id: 'p' })
    writeFileSync(join(tree, 'work.txt'), 'work')
    await hook('post-tool', { cwd: tree, session_id: 'p', tool_name: 'Bash' })
    await hook('stop', { cwd: tree, session_id: 'p' })

    expect(readFileSync(devMd, 'utf8')).toBe(before)
    // No write went near a temp name, so the links planted there are still links.
    for (const path of temps) expect(lstatSync(path).isSymbolicLink()).toBe(true)
    // Every file the hook writes is written as itself: a link at a destination is replaced, not
    // followed, so it is a plain file afterwards and its old target is untouched.
    expect(detached.some((command) => command.includes('heartbeat'))).toBe(true)
    for (const path of [join(claims, '7.json'), join(claims, '7.sessions.json'), pidFile]) expect(lstatSync(path).isFile()).toBe(true)
  })

  test('the lessons queue is git-ignored, so no checkpoint commits or pushes it', async () => {
    addLesson(root, 'a lesson nobody outside this machine should see')
    writeFileSync(join(tree, 'feature.txt'), 'work')
    await hook('stop', { cwd: tree, session_id: 's6' })
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('wip: #7 turn checkpoint')
    expect(git(tree, 'ls-files', '--', '.vegastack')).toBe('.vegastack/dev.md')
    expect(git(root, 'ls-files', '--', '.vegastack')).toBe('.vegastack/dev.md')
    expect(git(root, 'status', '--porcelain', '--ignored', '--', '.vegastack/.tmp')).toBe('!! .vegastack/.tmp/')
    const [cmd, ...args] = detached.at(-1)!
    expect(spawnSync(cmd!, args, { cwd: tree }).status).toBe(0)
    expect(git(tree, 'ls-tree', '-r', '--name-only', 'origin/feat/7-export')).not.toContain('learnings.md')
  })

  test('stop never commits or pushes a staged secret and names the files', async () => {
    const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_')
    const cases: Array<[string, string]> = [
      ['.env', 'X=1\n'], ['deploy.pem', 'x\n'], ['id_rsa', 'x\n'], ['cfg.ts', `const t = '${token}'\n`],
      ['aws.txt', `key ${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`], ['k.txt', `${'-----BEGIN ' + 'RSA PRIVATE KEY-----'}\n`],
      ['.npmrc', '//registry.npmjs.org/:_authToken=abc123\n'], ['s.txt', `${'sk-' + 'ant-' + 'api03-abcdefghijkl'}\n`],
      ['slack.txt', `${'xoxb' + '-1234567890-abc'}\n`],
    ]
    const head = git(tree, 'rev-parse', 'HEAD')
    for (const [file, text] of cases) {
      detached = []
      writeFileSync(join(tree, file), text)
      const result = (await hook('stop', { cwd: tree })).json()
      expect(result.systemMessage, file).toContain(file)
      expect(detached, file).toEqual([])
      expect(git(tree, 'rev-parse', 'HEAD'), file).toBe(head)
      expect(git(tree, 'diff', '--cached', '--name-only'), file).toBe('')
      rmSync(join(tree, file))
    }
    // Harmless look-alikes still checkpoint.
    writeFileSync(join(tree, '.env.example'), 'TOKEN=\n')
    writeFileSync(join(tree, '.npmrc'), '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
    expect((await hook('stop', { cwd: tree })).text).toBe('')
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('wip: #7 turn checkpoint')
    expect(detached).toHaveLength(1)
  })
})

describe('usage collection', () => {
  test('turn boundaries collect in the background, and only a session start asks to share', async () => {
    await hook('session-start', { cwd: tree })
    expect(stats).toEqual([['vf', 'stats', 'collect'], ['vf', 'stats', 'push']])
    stats = []
    await hook('stop', { cwd: tree })
    await hook('session-end', { cwd: tree })
    expect(stats).toEqual([['vf', 'stats', 'collect'], ['vf', 'stats', 'collect']])
    stats = []
    // Not on every tool call, and not on a prompt.
    await hook('post-tool', { cwd: tree })
    await hook('prompt', { cwd: tree })
    expect(stats).toEqual([])
  })

  test('a checkout with no issue still collects', async () => {
    await hook('session-start', { cwd: plain })
    expect(stats).toHaveLength(2)
  })

  // The install outlives the session that started it, so the next session is the one that can say
  // whether it worked. Without this, a background update was announced and never resolved.
  test('the session after a background update says how it went', async () => {
    writeFileSync(join(plain, '.vegastack/dev.md'), 'repo: o/r · default branch main\nvegafactory-update: auto\n')
    const start = async (extra: Partial<HookDeps> = {}) => {
      out = []
      await runHook(['session-start', '--harness', 'claude'], { ...deps(), latest: async () => '9.0.0', detach: () => undefined, ...extra }, Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))]))
      return JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext as string
    }

    expect(await start()).toContain(`updating vegafactory ${packageVersion} → 9.0.0 in the background`)
    // The note the real path just wrote is what the next session reads. Only the one fact a
    // finished install would have changed is changed here — the version this process reports —
    // because that is the difference the next session is supposed to notice.
    const written = readUpdateNote({ home: fakeHome })
    // A detached install is an attempt like any other, so the hour covers it too.
    expect(written).toMatchObject({ startedFrom: packageVersion, startedTo: '9.0.0', attemptedAt: gh.clock })
    writeUpdateNote({ ...written, startedFrom: '0.0.1' }, { home: fakeHome })
    expect(await start()).toBe(`vegafactory updated 0.0.1 → ${packageVersion} in the background since the last session`)
    // Said once, then forgotten — not repeated at every session for the rest of time.
    expect(await start()).not.toContain('updated 0.0.1')
  })

  // Two sessions a minute apart would each have started their own global install of the same
  // package, over each other, and each reset the clock the failure report is measured from.
  test('only one background install runs at a time', async () => {
    writeFileSync(join(plain, '.vegastack/dev.md'), 'repo: o/r · default branch main\nvegafactory-update: auto\n')
    const calls: string[][] = []
    const start = async () => {
      out = []
      await runHook(['session-start', '--harness', 'claude'], {
        ...deps(), latest: async () => '9.0.0', detach: (command) => { calls.push(command); return undefined },
      }, Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))]))
      return JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext as string
    }
    expect(await start()).toContain('in the background')
    expect(calls.filter(command => command[0] === 'npm')).toHaveLength(1)

    // The second session is told what the first is doing, and starts nothing.
    expect(await start()).toContain('is already installing in the background')
    expect(calls.filter(command => command[0] === 'npm')).toHaveLength(1)
    // And the first attempt's clock is untouched, so its failure is still reported on time.
    expect(readUpdateNote({ home: fakeHome }).startedAt).toBe(gh.clock)
  })

  // The note holds two different things: which install is running, and when npm was last asked.
  // Consuming the first used to throw away the second, so the next session asked npm again inside
  // the hour the note exists to hold.
  test('reporting an outcome keeps the hourly registry answer', async () => {
    writeFileSync(join(plain, '.vegastack/dev.md'), 'repo: o/r · default branch main\nvegafactory-update: auto\n')
    const checkedAt = gh.clock
    writeUpdateNote({ checkedAt, latest: '9.0.0', startedFrom: '0.0.1', startedTo: '9.0.0', startedAt: checkedAt }, { home: fakeHome })
    let asked = 0
    out = []
    await runHook(['session-start', '--harness', 'claude'], {
      ...deps(), latest: async () => { asked += 1; return '9.0.0' }, detach: () => undefined,
    }, Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))]))
    expect(JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext).toContain('updated 0.0.1')
    // The attempt is consumed; what npm said is kept.
    const after = readUpdateNote({ home: fakeHome })
    expect(after.startedFrom).toBeUndefined()
    expect(after).toMatchObject({ checkedAt, latest: '9.0.0' })
    expect(asked).toBe(0)
  })

  test('a background update that never landed is reported once, not forever', async () => {
    writeFileSync(join(plain, '.vegastack/dev.md'), 'repo: o/r · default branch main\nvegafactory-update: auto\n')
    const at = gh.clock
    writeUpdateNote({ startedFrom: packageVersion, startedTo: '9.0.0', startedAt: at }, { home: fakeHome })
    const start = async () => {
      out = []
      await runHook(['session-start', '--harness', 'claude'], { ...deps(), now: () => at + SELF_UPDATE_LIMIT_S * 2 * 1000 + 1, latest: async () => '9.0.0', detach: () => undefined }, Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))]))
      return JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext as string
    }
    expect(await start()).toContain('a background update to vegafactory 9.0.0 did not finish')
    expect(await start()).not.toContain('did not finish')
  })

  // A profile that exists and cannot be read may be the one that says `off`. Treating it as
  // absent — which means the shipped `auto` — would start a networked global install the operator
  // had refused, on the strength of a permission error.
  test('an unreadable profile stops the update rather than falling back to auto', async () => {
    const calls: string[][] = []
    writeFileSync(join(plain, '.vegastack/dev.md'), 'repo: o/r\nvegafactory-update: auto\n')
    chmodSync(join(plain, '.vegastack/dev.md'), 0)
    try {
      out = []
      await runHook(['session-start', '--harness', 'claude'], {
        ...deps(), latest: async () => '9.0.0', detach: (command) => { calls.push(command); return undefined },
      }, Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))]))
      expect(calls.filter(command => command[0] === 'npm')).toEqual([])
      expect(out.join('\n')).not.toContain('updating vegafactory')
    } finally { chmodSync(join(plain, '.vegastack/dev.md'), 0o644) }

    // A profile that is simply absent is a project older than the knob, and still gets the default.
    rmSync(join(plain, '.vegastack/dev.md'))
    calls.length = 0
    out = []
    await runHook(['session-start', '--harness', 'claude'], {
      ...deps(), latest: async () => '9.0.0', detach: (command) => { calls.push(command); return undefined },
    }, Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))]))
    expect(calls.filter(command => command[0] === 'npm')).toHaveLength(1)
  })

  test('session start updates from every repository through a stable command and its own bound', async () => {
    writeFileSync(join(plain, '.vegastack/dev.md'), 'repo: o/r · default branch main\nvegafactory-update: auto\n')
    const calls: Array<{ command: string[]; cwd: string; limit: number | undefined }> = []
    out = []
    const input = Readable.from([Buffer.from(JSON.stringify({ cwd: plain }))])
    const code = await runHook(['session-start', '--harness', 'claude'], {
      ...deps(),
      latest: async () => '9.0.0',
      detach: (command, cwd, limit) => { calls.push({ command, cwd, limit }) },
    }, input)
    expect(code).toBe(0)
    // The version comes from the package, not a literal: a release would otherwise break this test.
    expect(JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext).toContain(`updating vegafactory ${packageVersion} → 9.0.0 in the background`)
    // The detached install is the same plain npm command as the foreground one.
    expect(calls.filter(call => call.command[0] === 'npm')).toEqual([{
      command: ['npm', ...installArgs()], cwd: plain, limit: 300,
    }])
    expect(calls.some(call => call.command[0] === 'vf' && call.command.includes('update'))).toBe(false)
  })
})

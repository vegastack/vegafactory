import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { claim, heartbeatOf } from '../src/claim.ts'
import type { GhRunner } from '../src/gh.ts'
import { issueFromBranch, issueFromWorktree, readHookInput, runHook, type HookDeps } from '../src/hook.ts'
import { ackBody, artifactHash } from '../src/issue.ts'
import { FakeGitHub } from './fake-github.ts'

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

let gh: FakeGitHub
let root: string
let tree: string
let plain: string
let out: string[]
let detached: string[][]
let prHead: string
const OWNER = 'box:7-export'
const ctx = () => ({ root, repo: 'o/r', number: 7, runner: gh.runner })

// The fake answers `gh api`; the hook also asks `gh pr view` for a merge's head branch.
const runner: GhRunner = (args, input) => {
  if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ headRefName: prHead }), stderr: '' }
  return gh.runner(args, input)
}

const deps = (): HookDeps => ({
  runner, now: () => gh.clock, out: (text) => out.push(text), detach: (command) => detached.push(command), cli: ['vf'], host: 'box',
})

async function hook(event: string, payload: unknown, harness = 'claude') {
  out = []
  const stdin = Readable.from([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))])
  const code = await runHook([event, '--harness', harness], deps(), stdin)
  return { code, text: out.join('\n'), json: () => JSON.parse(out.join('\n')) }
}

const bash = (command: string, cwd = tree) => ({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } })

beforeEach(() => {
  gh = new FakeGitHub()
  gh.permissions.set('mk', 'admin')
  gh.addIssue({ number: 7, body: 'Export CSV', labels: ['queued', 'small'] })
  out = []
  detached = []
  prHead = 'feat/7-export'
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hook-')))
  const origin = join(base, 'origin.git')
  root = join(base, 'repo')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'clone', '-q', origin, root)
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r · default branch main\n\n## Ship\n- ask: `bun run release`\n')
  writeFileSync(join(root, '.gitignore'), '.vegastack/.tmp/\n.vegastack/.worktrees/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', '--auto')
  tree = join(root, '.vegastack/.worktrees/7-export')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/7-export', tree)
  plain = join(base, 'plain')
  git(base, 'clone', '-q', origin, plain)
})

describe('finding the issue', () => {
  test('from the worktree folder or the branch name', () => {
    expect(issueFromWorktree('/r/.vegastack/.worktrees/216-coordination')).toBe(216)
    expect(issueFromWorktree('/r/.vegastack/.worktrees/x')).toBe(null)
    expect(issueFromBranch('feat/216-coordination')).toBe(216)
    expect(issueFromBranch('main')).toBe(null)
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
    gh.addComment(7, '<!-- vsk:v1 type=evidence -->\nit works')
    gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Export CSV'), plan: null, source: 'session', quote: 'ship it' }))
    expect((await hook('pre-tool', bash('gh pr merge 12 --squash'))).text).toBe('')
    expect((await hook('pre-tool', bash('gh pr merge --squash'))).text).toBe('')
    expect((await hook('pre-tool', bash('gh pr merge 12 --admin'))).text).toContain('"ask"')
    expect((await hook('pre-tool', bash('gh -R x/y pr merge 12'))).text).toContain('"ask"')
    prHead = 'feat/8-other'
    expect((await hook('pre-tool', bash('gh pr merge 12'))).text).toContain('"ask"')
    prHead = 'feat/7-export'
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
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('wip: #7 rescued uncommitted work from 7-export')
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
    expect(detached).toEqual([['vf', 'issue', 'heartbeat', '7', '--repo', 'o/r', '--owner', OWNER, '--active', '0']])
    gh.clock += 2 * 60_000
    await hook('post-tool', { cwd: tree })
    expect(detached).toHaveLength(1)
    expect(local().activeMs).toBe(2 * 60_000)
    gh.clock += 10 * 60_000 // idle: not counted
    await hook('post-tool', { cwd: tree })
    expect(local().activeMs).toBe(2 * 60_000)
    expect(detached.at(-1)).toEqual(['vf', 'issue', 'heartbeat', '7', '--repo', 'o/r', '--owner', OWNER, '--active', '2'])
    gh.clock += 60_000
    await hook('session-end', { cwd: tree })
    expect(detached).toHaveLength(3)
    // The detached command the hook starts really moves the heartbeat.
    const [, , , n, , repo, , owner, , active] = detached.at(-1)!
    expect([n, repo, owner, active]).toEqual(['7', 'o/r', OWNER, '3'])
    expect(gh.issues.get(7)!.comments.some((c) => c.body.includes('type=release'))).toBe(false)
  })

  test('no heartbeat is pushed for a worktree that holds nothing', async () => {
    await hook('pre-tool', bash('ls'))
    await hook('post-tool', { cwd: tree })
    await hook('session-end', { cwd: tree })
    expect(detached).toEqual([])
    expect(heartbeatOf(null, OWNER)).toBe(null)
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

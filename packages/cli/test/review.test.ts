import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectReviewer, readReviewComment, reviewPolicy, runReview, validateReview, type ReviewState } from '../src/review.ts'
import { FakeGitHub } from './fake-github.ts'

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout.trim()

// A stand-in for `codex` and `claude`: records argv, stdin and environment, then plays the next
// canned reply from its queue whose `match` the prompt contains (stdout, stderr, the -o file, a delay, an exit code).
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
const dir = process.env.FAKE_DIR
let stdin = ''
process.stdin.on('data', (c) => { stdin += c })
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ tool, args, stdin, env: Object.keys(process.env), cwd: process.cwd() }) + '\\n')
  const queueFile = path.join(dir, tool + '.json')
  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'))
  const at = queue.findIndex((r) => !r.match || stdin.includes(r.match))
  const reply = at === -1 ? {} : queue.splice(at, 1)[0]
  fs.writeFileSync(queueFile, JSON.stringify(queue))
  const finish = () => {
    const o = args.indexOf('-o')
    if (reply.output !== undefined && o !== -1) fs.writeFileSync(args[o + 1], reply.output)
    if (reply.stderr) process.stderr.write(reply.stderr)
    if (reply.stdout) process.stdout.write(reply.stdout)
    process.exit(reply.exit || 0)
  }
  if (reply.sleep) setTimeout(finish, reply.sleep)
  else finish()
})
`

type Reply = { match?: string; stdout?: string; stderr?: string; output?: string; sleep?: number; exit?: number }
interface Call { tool: string; args: string[]; stdin: string; env: string[]; cwd: string }

let gh: FakeGitHub
let root: string
let fake: string
let lines: string[]

const finding = (id: string, severity = 'must-fix', extra: Record<string, unknown> = {}) =>
  ({ id, axis: 'bugs', severity, file: 'src/app.ts', line: 3, issue: `problem ${id}`, fix: `fix ${id}`, ...extra })
const verdict = (findings: unknown[]) => ({ verdict: findings.some((f) => (f as { severity: string }).severity === 'must-fix') ? 'needs-fixes' : 'clean', findings })
const codexReply = (result: unknown, session = '019a0000-0000-7000-8000-000000000001'): Reply =>
  ({ output: JSON.stringify(result), stderr: `OpenAI Codex\n--------\nsession id: ${session}\n--------\n` })
const claudeReply = (result: unknown, session = 'c1a0de00-0000-4000-8000-000000000001'): Reply =>
  ({ stdout: JSON.stringify({ type: 'result', is_error: false, session_id: session, result: '', structured_output: result }) })

function queue(tool: 'codex' | 'claude', replies: Reply[]) {
  writeFileSync(join(fake, `${tool}.json`), JSON.stringify(replies))
}
const calls = (): Call[] => existsSync(join(fake, 'calls.jsonl'))
  ? readFileSync(join(fake, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
const baseEnv = (extra: Record<string, string> = {}) => ({ PATH: `${join(fake, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_DIR: fake, ...extra })

async function review(args: string[], options: { env?: Record<string, string>; timeoutMs?: number; machine?: string } = {}) {
  lines = []
  const code = await runReview(['7', ...args], {
    runner: gh.runner, cwd: root, env: baseEnv(options.env), out: (line) => lines.push(line), timeoutMs: options.timeoutMs ?? 20_000, machine: options.machine ?? 'mini',
  })
  return { code, text: lines.join('\n') }
}

function commit(file: string, text: string, message = 'work') {
  writeFileSync(join(root, file), text)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}
const reviewComments = () => gh.issues.get(7)!.comments.filter((c) => c.body.startsWith('<!-- vsk:v1 type=review'))
const statePath = () => join(root, '.vegastack/.tmp/reviews/7.json')
const readState = () => JSON.parse(readFileSync(statePath(), 'utf8')) as ReviewState

beforeEach(() => {
  gh = new FakeGitHub()
  gh.addIssue({ number: 7, title: 'Export CSV', labels: ['in-progress', 'medium'], body: '## Outcome\nUsers export CSV.\n\n## Done when\n- [ ] the export button downloads a CSV\n\n## Out of scope\n- PDF' })
  gh.addComment(7, '<!-- vsk:v1 type=plan rev=1 -->\n## Plan (v1)\n**Goal:** export\n\n### Tasks\n\n- [ ] **Task 1: export button** <!-- task-id:7-T1 -->\n\n**Revisions:** none')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'review-')))
  fake = join(base, 'fake')
  mkdirSync(join(fake, 'bin'), { recursive: true })
  for (const tool of ['codex', 'claude']) {
    writeFileSync(join(fake, 'bin', tool), FAKE)
    chmodSync(join(fake, 'bin', tool), 0o755)
  }
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'origin.git'))
  root = join(base, 'repo')
  git(base, 'clone', '-q', join(base, 'origin.git'), root)
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'repo: o/r\nharness-policy: implement claude fable high · review codex gpt-5.6 xhigh\n')
  writeFileSync(join(root, '.gitignore'), '.vegastack/.tmp/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', '--auto')
  git(root, 'switch', '-q', '-c', 'feat/7-export')
  commit('app.ts', 'export const a = 1\n')
})

describe('packet and command line', () => {
  test('the dry run shows the packet and the exact codex argv, and runs nothing', async () => {
    const { code, text } = await review(['--reviewer', 'codex', '--dry-run', '--json'])
    expect(code).toBe(0)
    const dry = JSON.parse(text)
    expect(dry.commands).toHaveLength(1)
    const argv = dry.commands[0].command as string[]
    expect(argv.slice(0, 4)).toEqual(['codex', 'exec', '-s', 'read-only'])
    expect(argv).toContain('--output-schema')
    expect(argv.join(' ')).toContain('-c model=gpt-5.6 -c model_reasoning_effort=xhigh')
    expect(argv.at(-1)).toBe('-')
    const prompt = dry.prompts[0] as string
    expect(prompt).toContain('- [ ] the export button downloads a CSV')
    expect(prompt).not.toContain('PDF')
    expect(prompt).toContain('**Task 1: export button**')
    expect(prompt).toContain('app.ts | 1 +')
    expect(prompt).toContain('## Changed files\n- app.ts')
    expect(prompt).toContain('+export const a = 1')
    expect(prompt).toContain('Return ONLY JSON')
    expect(prompt).toContain('No read limit')
    expect(calls()).toEqual([])
    expect(reviewComments()).toEqual([])
  })

  test('the known-patterns file joins the rules when present', async () => {
    commit('.vegastack/review-known-patterns.md', '## Never flag X\n- **Still flag if:** Y\n')
    const { text } = await review(['--reviewer', 'codex', '--dry-run', '--json'])
    expect(JSON.parse(text).prompts[0]).toContain('## Never flag X')
  })

  test('claude gets read-only tools, JSON output and the schema inline; the prompt is stdin, never a shell string', async () => {
    queue('claude', [claudeReply(verdict([]))])
    const { code } = await review(['--reviewer', 'claude'])
    expect(code).toBe(0)
    const [call] = calls()
    expect(call!.tool).toBe('claude')
    expect(call!.args.slice(0, 5)).toEqual(['-p', '--tools', 'Read,Grep,Glob', '--output-format', 'json'])
    expect(JSON.parse(call!.args[call!.args.indexOf('--json-schema') + 1]!).required).toEqual(['verdict', 'findings'])
    // The policy names codex for review, so claude runs on its own defaults.
    expect(call!.args).not.toContain('--model')
    expect(call!.stdin).toContain('## Acceptance criteria')
    expect(call!.cwd).toBe(root)
  })

  test('the harness-policy review entry becomes model and effort flags only for the tool it names', () => {
    const devMd = 'harness-policy: plan claude fable high · review claude opus max   # note\n'
    expect(reviewPolicy(devMd, 'claude')).toEqual({ model: 'opus', effort: 'max' })
    expect(reviewPolicy(devMd, 'codex')).toBeNull()
  })
})

describe('reviewer choice and environment', () => {
  test('the reviewer is the other tool', () => {
    expect(detectReviewer({ CLAUDECODE: '1' })).toBe('codex')
    expect(detectReviewer({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('codex')
    expect(detectReviewer({ CODEX_THREAD_ID: 'abc' })).toBe('claude')
    expect(detectReviewer({})).toBeNull()
    expect(detectReviewer({ CLAUDECODE: '1', CODEX_THREAD_ID: 'abc' })).toBeNull()
  })

  test('an unknown harness needs --reviewer', async () => {
    await expect(review([])).rejects.toThrow('pass --reviewer')
  })

  test('inside Claude Code the codex child runs without the parent app variables', async () => {
    queue('codex', [codexReply(verdict([]))])
    const { code } = await review([], { env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CODE_SESSION_ID: 'x' } })
    expect(code).toBe(0)
    const [call] = calls()
    expect(call!.tool).toBe('codex')
    expect(call!.env).not.toContain('CLAUDECODE')
    expect(call!.env).not.toContain('ANTHROPIC_BASE_URL')
    expect(call!.env).not.toContain('CLAUDE_CODE_SESSION_ID')
  })

  test('an API key refuses the run before any reviewer starts', async () => {
    await expect(review(['--reviewer', 'codex'], { env: { OPENAI_API_KEY: 'sk-x' } })).rejects.toThrow('OPENAI_API_KEY')
    expect(calls()).toEqual([])
  })
})

describe('results and the review comment', () => {
  test('a finding is posted as one review comment and the state is saved', async () => {
    queue('codex', [codexReply(verdict([finding('F1'), finding('F2', 'nit')]))])
    const { code, text } = await review(['--reviewer', 'codex'])
    expect(code).toBe(2)
    expect(text).toContain('next: fix, commit, push')
    const [comment] = reviewComments()
    const head7 = git(root, 'rev-parse', '--short=7', 'HEAD')
    expect(comment!.body.split('\n')[0]).toBe(`<!-- vsk:v1 type=review round=1 sha=${head7} agent=codex verdict=needs-fixes -->`)
    expect(comment!.body).toContain('**Finding [F1]** — **[MUST-FIX]** `src/app.ts:3`')
    expect(comment!.body).toContain('<summary>Nits (1)</summary>')
    expect(readReviewComment(comment!.body)!.findings.map((f) => f.id)).toEqual(['F1', 'F2'])
    const state = readState()
    expect(state).toMatchObject({ reviewer: 'codex', machine: 'mini', round: 1, base: 'origin/main', open: ['F1', 'F2'] })
    expect(state.sessions[0]!.id).toBe('019a0000-0000-7000-8000-000000000001')
  })

  test('a clean review exits 0', async () => {
    queue('codex', [codexReply(verdict([finding('F1', 'should-fix')]))])
    expect((await review(['--reviewer', 'codex'])).code).toBe(0)
    expect(reviewComments()[0]!.body).toContain('verdict=clean')
  })

  test('malformed output is retried once, then handed back', async () => {
    queue('codex', [{ output: 'not json' }, codexReply(verdict([]))])
    expect((await review(['--reviewer', 'codex'])).code).toBe(0)
    expect(calls()).toHaveLength(2)

    queue('codex', [{ output: '{"verdict":"maybe","findings":[]}' }, { output: JSON.stringify({ verdict: 'clean', findings: [{ id: 'F1' }] }) }])
    commit('app.ts', 'export const a = 2\n')
    const second = await review(['--reviewer', 'codex'])
    expect(second.code).toBe(2)
    expect(second.text).toContain('hand-back')
    expect(second.text).toContain('malformed review')
  })

  test('schema validation', () => {
    expect(validateReview({ verdict: 'clean', findings: [] })).toEqual({ verdict: 'clean', findings: [] })
    expect(validateReview({ verdict: 'clean', findings: [finding('F1', 'major')] })).toContain('severity')
    expect(validateReview({ verdict: 'clean', findings: [finding('F1', 'nit', { line: 2.5 })] })).toContain('line')
    expect(validateReview({ verdict: 'clean', findings: [finding('F1', 'nit', { axis: 'perf' })] })).toContain('axis')
    expect(validateReview([])).toContain('object')
  })
})

describe('fix rounds', () => {
  test('round 2 resumes the same session with only the fix diff and open ids, and edits the same comment', async () => {
    queue('codex', [codexReply(verdict([finding('F1')])), codexReply(verdict([]), 'ignored-not-printed')])
    await review(['--reviewer', 'codex'])
    const first = git(root, 'rev-parse', 'HEAD')
    commit('fix.ts', 'export const fixed = true\n', 'fix F1')
    const { code, text } = await review(['--reviewer', 'codex'])
    expect(code).toBe(0)
    expect(text).toContain('resumed')
    const second = calls()[1]!
    expect(second.args.slice(0, 5)).toEqual(['exec', 'resume', '-c', 'sandbox_mode=read-only', '-c'])
    expect(second.args).toContain('019a0000-0000-7000-8000-000000000001')
    expect(second.args).not.toContain('-s')
    expect(second.stdin).toContain('Open findings from your last round: F1.')
    expect(second.stdin).toContain(`${first.slice(0, 7)}..`)
    expect(second.stdin).toContain('+export const fixed = true')
    expect(second.stdin).not.toContain('+export const a = 1')
    expect(second.stdin).not.toContain('## Acceptance criteria')
    const comments = reviewComments()
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toContain('type=review round=2')
    expect(comments[0]!.body).toContain(`- Round 1 @ ${first.slice(0, 7)} — needs-fixes — must-fix: F1`)
    expect(readState().round).toBe(2)
  })

  test('claude resumes with --resume and the same session id', async () => {
    queue('claude', [claudeReply(verdict([finding('F1')])), claudeReply(verdict([]))])
    await review(['--reviewer', 'claude'])
    commit('fix.ts', 'x\n')
    expect((await review(['--reviewer', 'claude', '--resume'])).code).toBe(0)
    expect(calls()[1]!.args.slice(0, 3)).toEqual(['-p', '--resume', 'c1a0de00-0000-4000-8000-000000000001'])
  })

  test('an unchanged HEAD is not reviewed again', async () => {
    queue('codex', [codexReply(verdict([finding('F1')]))])
    await review(['--reviewer', 'codex'])
    const again = await review(['--reviewer', 'codex'])
    expect(again.code).toBe(2)
    expect(again.text).toContain('already reviewed in round 1')
    expect(calls()).toHaveLength(1)
  })

  test('another machine starts a fresh reviewer that gets the previous findings from the comment', async () => {
    queue('codex', [codexReply(verdict([finding('F1')])), codexReply(verdict([]))])
    await review(['--reviewer', 'codex'])
    commit('fix.ts', 'x\n')
    const { code } = await review(['--reviewer', 'codex'], { machine: 'laptop' })
    expect(code).toBe(0)
    const second = calls()[1]!
    expect(second.args.slice(0, 4)).toEqual(['exec', '-s', 'read-only', '-c'])
    expect(second.stdin).toContain('## Findings from the previous round')
    expect(second.stdin).toContain('"id": "F1"')
    expect(second.stdin).toContain('## Acceptance criteria')
    expect(reviewComments()[0]!.body).toContain('type=review round=2')
    commit('more.ts', 'y\n')
    await expect(review(['--reviewer', 'codex', '--resume'], { machine: 'mini' })).rejects.toThrow('no codex review session from this machine')
  })

  test('a missing state file (fresh checkout) also reads the round and findings from the comment', async () => {
    queue('codex', [codexReply(verdict([finding('F1')])), codexReply(verdict([finding('F1')]))])
    await review(['--reviewer', 'codex'])
    spawnSync('rm', ['-f', statePath()])
    commit('fix.ts', 'x\n')
    await review(['--reviewer', 'codex'])
    expect(calls()[1]!.stdin).toContain('"id": "F1"')
    expect(readState().round).toBe(2)
  })

  test('after round 3 with open must-fix findings the command hands back and never runs a round 4', async () => {
    queue('codex', [1, 2, 3].map(() => codexReply(verdict([finding('F1')]))))
    await review(['--reviewer', 'codex'])
    commit('a.ts', '1\n')
    await review(['--reviewer', 'codex'])
    commit('b.ts', '2\n')
    const third = await review(['--reviewer', 'codex'])
    expect(third.code).toBe(2)
    expect(third.text).toContain('hand-back: round 3 still has open findings (F1)')
    commit('c.ts', '3\n')
    const fourth = await review(['--reviewer', 'codex'])
    expect(fourth.code).toBe(2)
    expect(fourth.text).toContain('3 review rounds are done')
    expect(calls()).toHaveLength(3)
  })
})

describe('parallel axes and the stuck-run guard', () => {
  test('a small diff is one run; a risky issue runs spec+bugs and security in parallel and merges the findings', async () => {
    const small = await review(['--reviewer', 'codex', '--dry-run', '--json'])
    expect(JSON.parse(small.text).commands).toHaveLength(1)

    gh.issues.get(7)!.labels.push('risky')
    gh.issues.get(7)!.updated_at = gh.tick()
    queue('codex', [
      { match: '  - bugs —', ...codexReply(verdict([finding('1')]), '019a0000-0000-7000-8000-00000000000a') },
      { match: '  - security —', ...codexReply(verdict([finding('S1', 'must-fix', { axis: 'security' })]), '019a0000-0000-7000-8000-00000000000b') },
    ])
    const { code } = await review(['--reviewer', 'codex'])
    expect(code).toBe(2)
    const runs = calls()
    expect(runs).toHaveLength(2)
    expect(runs.some((c) => c.stdin.includes('  - security —') && !c.stdin.includes('  - bugs —'))).toBe(true)
    expect(readState().open.sort()).toEqual(['B1', 'S1'])
    expect(readState().sessions.map((s) => s.group.key)).toEqual(['spec-bugs', 'security'])
  })

  test('more than 15 files also splits the axes', async () => {
    for (let i = 0; i < 16; i++) writeFileSync(join(root, `f${i}.ts`), `${i}\n`)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'many')
    const { text } = await review(['--reviewer', 'codex', '--dry-run', '--json'])
    expect(JSON.parse(text).commands.map((c: { group: string }) => c.group)).toEqual(['spec-bugs', 'security'])
  })

  test('a stuck reviewer is killed and retried once', async () => {
    queue('codex', [{ sleep: 5000, ...codexReply(verdict([])) }, codexReply(verdict([]))])
    const { code } = await review(['--reviewer', 'codex'], { timeoutMs: 300 })
    expect(code).toBe(0)
    expect(calls()).toHaveLength(2)
  })

  test('a reviewer stuck twice hands back with a clear message and posts nothing', async () => {
    queue('codex', [{ sleep: 5000 }, { sleep: 5000 }])
    const { code, text } = await review(['--reviewer', 'codex'], { timeoutMs: 300 })
    expect(code).toBe(2)
    expect(text).toContain('ran past the 300 ms limit and was stopped (after one retry)')
    expect(text).toContain('The review is not skipped')
    expect(reviewComments()).toEqual([])
    expect(existsSync(statePath())).toBe(false)
  })
})

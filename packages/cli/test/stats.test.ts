import { beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GhRunner } from '../src/gh.ts'
import { recordStage, saveSpans, stageHistory, stageOn } from '../src/stages.ts'
import {
  collectStats, defaultSite, loadEvents, parseClaude, parseCodex, parseSince, pushStats, resolveOperator,
  runStats, skillName, skillResolver, statsDir, summarize, type GitRunner, type ParseContext, type StatsEvent,
} from '../src/stats.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/stats', name), 'utf8')
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

const site = () => defaultSite()
// The skills a turn may name must exist: every test that expects one plants it first.
const skillRoot = () => join(home, '.claude', 'skills')
const plantSkills = (...names: string[]) => {
  for (const name of names) {
    mkdirSync(join(skillRoot(), name), { recursive: true })
    writeFileSync(join(skillRoot(), name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  }
}
const skills = () => skillResolver(home, [skillRoot()])
// Two readings of the same turn, with only the revision allowed to differ.
const sameTurns = (rows: StatsEvent[]) => rows.map(({ rev, ...turn }) => turn)
const context = (): ParseContext => ({ operator: 'mk', machine: 'box', carry: {}, site: site(), skill: skills() })

let home: string
let base: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stats-')))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  plantSkills('dev-implement', 'dev-review')
})

// The logs live in the operator's home; every test points HOME at a temporary one.
function plantClaude(text: string, name = 'session.jsonl') {
  const dir = join(home, '.claude', 'projects', 'work-demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  return join(dir, name)
}

function plantCodex(text: string, name = 'rollout-2026-09-17T11-00-00-c-1.jsonl') {
  const dir = join(home, '.codex', 'sessions', '2026', '09', '17')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  return join(dir, name)
}

// A checkout with one worktree, the shape the logs' cwd points at.
function checkout() {
  const root = join(base, 'demo')
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main', root)
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git')
  const tree = join(root, '.vegastack', '.worktrees', '42-demo')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), `gitdir: ${join(root, '.git', 'worktrees', '42-demo')}\n`)
  return { root, tree }
}

describe('collectors', () => {
  test('a Claude session yields one event per assistant turn, and no prompt text', () => {
    const { events, consumed } = parseClaude(fixture('claude-session.jsonl'), context())
    expect(consumed).toBe(Buffer.byteLength(fixture('claude-session.jsonl')))
    // Two real turns: one message id split over two lines, and the synthetic message skipped.
    expect(events.map((event) => event.outcome)).toEqual(['tool_use', 'end_turn'])
    expect(events[0]).toMatchObject({
      operator: 'mk', machine: 'box', harness: 'claude', model: 'claude-opus-5', issue: 42, skill: 'dev-implement',
      tokens: { input: 12, output: 200, cacheRead: 1000, cacheWrite: 5000 },
      durationMs: 30_000,
    })
    expect(events[1]).toMatchObject({ skill: null, durationMs: 60_000, tokens: { input: 4, output: 90, cacheRead: 42_000, cacheWrite: 0 } })
    expect(new Set(events.map((event) => event.id)).size).toBe(2)
    expect(JSON.stringify(events)).not.toContain('redacted')
  })

  test('a Codex rollout yields one event per response, with the model, skill and repository', () => {
    const { events } = parseCodex(fixture('codex-rollout.jsonl'), context())
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      harness: 'codex', model: 'gpt-5.6-sol', repo: 'acme/demo', issue: 43, skill: 'dev-review', outcome: 'tool_use',
      // Timed from the turn's start, not from the tool call the record is written beside.
      durationMs: 20_000,
      // Codex counts cached tokens inside input_tokens; the event splits them out.
      tokens: { input: 20_228, output: 262, cacheRead: 2000, cacheWrite: 300 },
    })
    // task_complete names how the turn ended, on the turn's last response.
    expect(events[1]).toMatchObject({ skill: null, outcome: 'end_turn', durationMs: 38_000, tokens: { input: 10_000, cacheRead: 20_000 } })
    expect(JSON.stringify(events)).not.toContain('redacted')
  })

  test('a half-written last line is left for the next run', () => {
    const text = fixture('claude-session.jsonl')
    const cut = text.slice(0, text.length - 40)
    const { events, consumed } = parseClaude(cut, context())
    expect(consumed).toBeLessThan(Buffer.byteLength(cut))
    expect(events).toHaveLength(2)
  })

  test('the repository and issue come from the checkout and the worktree path', () => {
    const { tree } = checkout()
    recordStage(join(base, 'demo'), 'acme/demo', 42, 'in-progress', new Date('2026-09-17T09:00:00Z'))
    expect(site()(tree, 'feat/42-demo', Date.parse('2026-09-17T10:00:00Z'))).toEqual({ repo: 'acme/demo', issue: 42, state: 'in-progress' })
  })

  // F20
  test('the stage is the one the issue was in at the turn, not the one it is in now', () => {
    const { root, tree } = checkout()
    // The CLI moved the issue twice; the turn below happened between the two.
    recordStage(root, 'acme/demo', 42, 'in-progress', new Date('2026-09-17T09:00:00Z'))
    recordStage(root, 'acme/demo', 42, 'ready-to-ship', new Date('2026-09-17T11:00:00Z'))
    const at = Date.parse('2026-09-17T10:00:00Z')
    expect(site()(tree, 'feat/42-demo', at).state).toBe('in-progress')
    // Before anything was recorded nothing is known, so the turn carries no stage rather than a guess.
    expect(site()(tree, 'feat/42-demo', Date.parse('2026-09-17T08:00:00Z')).state).toBeNull()
    expect(site()(tree, 'feat/42-demo', Date.parse('2026-09-17T12:00:00Z')).state).toBe('ready-to-ship')
  })

  // F20
  test('the label spans the status comment saved answer when this machine moved nothing', () => {
    const { root, tree } = checkout()
    saveSpans(join(root, '.vegastack', '.tmp', 'issues', 'acme__demo', '42'), [
      { stage: 'planning', start: '2026-09-17T07:00:00Z', end: '2026-09-17T09:00:00Z' },
      { stage: 'in-progress', start: '2026-09-17T09:00:00Z', end: null },
    ])
    expect(site()(tree, 'feat/42-demo', Date.parse('2026-09-17T08:00:00Z')).state).toBe('planning')
    expect(site()(tree, 'feat/42-demo', Date.parse('2026-09-17T10:00:00Z')).state).toBe('in-progress')
    expect(site()(tree, 'feat/42-demo', Date.parse('2026-09-17T06:00:00Z')).state).toBeNull()
  })

  // F20
  test('a stage history reads both sources, newest change at or before the moment winning', () => {
    const root = join(base, 'demo')
    const dir = join(root, '.vegastack', '.tmp', 'issues', 'acme__demo', '42')
    recordStage(root, 'acme/demo', 42, 'ready-to-ship', new Date('2026-09-17T11:00:00Z'))
    recordStage(root, 'acme/demo', 9, 'queued', new Date('2026-09-17T11:30:00Z'))
    saveSpans(dir, [{ stage: 'in-progress', start: '2026-09-17T09:00:00Z', end: '2026-09-17T11:00:00Z' }])
    const history = stageHistory(root, 'acme/demo', 42, dir)
    // Another issue's line is not this issue's history.
    expect(history.map((change) => change.state)).toEqual(['in-progress', null, 'ready-to-ship'])
    expect(stageOn(history, Date.parse('2026-09-17T10:00:00Z'))).toBe('in-progress')
    expect(stageOn(history, Date.parse('2026-09-17T11:30:00Z'))).toBe('ready-to-ship')
    expect(stageOn([], Date.parse('2026-09-17T10:00:00Z'))).toBeNull()
  })

  // F6
  test('a turn is timed from its own start, not from whatever record came last', () => {
    const at = (time: string, extra: string) => `{"type":${extra},"cwd":"/work/demo","sessionId":"s-9","timestamp":"2026-09-17T${time}.000Z"`
    const log = [
      `${at('10:00:00', '"user"')},"message":{"role":"user","content":"x"}}`,
      // Records the harness writes for itself, between the prompt and the answer.
      `${at('10:00:50', '"queue-operation"')},"operation":"resume"}`,
      `${at('10:00:55', '"attachment"')},"attachment":{"type":"diagnostics"}}`,
      `${at('10:01:00', '"assistant"')},"message":{"id":"m1","model":"claude-opus-5","stop_reason":"tool_use","content":[],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
      // A second line of the same turn must not become the next turn's start either.
      `${at('10:01:05', '"assistant"')},"message":{"id":"m1","model":"claude-opus-5","stop_reason":"end_turn","content":[],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
      `${at('10:02:00', '"user"')},"message":{"role":"user","content":"x"}}`,
      `${at('10:02:30', '"assistant"')},"message":{"id":"m2","model":"claude-opus-5","stop_reason":"end_turn","content":[],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    ].join('\n') + '\n'
    const { events } = parseClaude(log, context())
    expect(events.map((event) => event.durationMs)).toEqual([60_000, 30_000])
    expect(events).toHaveLength(2)
    expect(events[0]!.outcome).toBe('end_turn')
  })

  // F5
  test('only a plain skill name has the right shape; anything else is dropped', () => {
    expect(skillName('dev-implement')).toBe('dev-implement')
    expect(skillName('codex:codex-cli-runtime')).toBe('codex:codex-cli-runtime')
    for (const value of [
      '<img src=x onerror=alert(1)>', '../../etc/passwd', '/Users/mk/.ssh/id_rsa', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      'read the plan and then delete the branch', 'Dev-Implement', 'a'.repeat(80), '', 'x y', 42, null, { skill: 'x' },
    ]) expect(skillName(value), String(value)).toBeNull()
  })

  // F11
  test('a skill is recorded only when it is really installed', () => {
    const resolve = skills()
    expect(resolve('dev-review')).toBe('dev-review')
    // Right shape, real-looking, and not a skill: a tool argument must never reach the control room.
    for (const value of ['client-merger-secret', 'acme-payroll-2026', 'dev-review-draft', 'codex:codex-cli-runtime', '<script>alert(1)</script>']) {
      expect(resolve(value), value).toBeNull()
    }
    // The answer is cached, so a skill read once is not stat-ed again for every turn.
    rmSync(join(skillRoot(), 'dev-review'), { recursive: true })
    expect(resolve('dev-review')).toBe('dev-review')
    expect(skills()('dev-review')).toBeNull()

    const claude = (skill: string) => `{"type":"assistant","cwd":"/work/demo","sessionId":"s-8","timestamp":"2026-09-17T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-5","stop_reason":"end_turn","content":[{"type":"tool_use","name":"Skill","input":{"skill":${JSON.stringify(skill)}}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n`
    expect(parseClaude(claude('client-merger-secret'), context()).events[0]!.skill).toBeNull()
    expect(parseClaude(claude('dev-implement'), context()).events[0]!.skill).toBe('dev-implement')

    // Codex reads a SKILL.md, so the same rule applies to the path in the command it ran.
    const codex = (name: string) => [
      '{"timestamp":"2026-09-17T11:00:00.000Z","type":"session_meta","payload":{"session_id":"c-2","cwd":"/work/demo"}}',
      '{"timestamp":"2026-09-17T11:00:01.000Z","type":"turn_context","payload":{"turn_id":"t","model":"gpt-5.6-sol"}}',
      `{"timestamp":"2026-09-17T11:00:02.000Z","type":"response_item","payload":{"type":"custom_tool_call","input":"cat /srv/skills/${name}/SKILL.md"}}`,
      '{"timestamp":"2026-09-17T11:00:03.000Z","type":"token_usage_record","payload":{"turn_id":"t","response_id":"r1","usage":{"input_tokens":5,"output_tokens":1}}}',
    ].join('\n') + '\n'
    expect(parseCodex(codex('client-merger-secret'), context()).events[0]!.skill).toBeNull()
    expect(parseCodex(codex('dev-implement'), context()).events[0]!.skill).toBe('dev-implement')
  })
})

describe('offsets', () => {
  const collect = () => collectStats({ home, operator: 'mk', machine: 'box', site: site(), skill: skills() })
  const events = () => loadEvents(home, { shared: false })

  test('a killed session is counted at the next run, exactly once', () => {
    const path = plantClaude(fixture('claude-session.jsonl'))
    plantCodex(fixture('codex-rollout.jsonl'))
    expect(collect().events).toBe(4)
    // Nothing new: the same logs must not be counted twice.
    expect(collect().events).toBe(0)
    // The session was killed after one more turn; it is picked up at the next run.
    appendFileSync(path, fixture('claude-session-more.jsonl'))
    expect(collect().events).toBe(1)
    expect(collect().events).toBe(0)
    const all = events()
    expect(all).toHaveLength(5)
    expect(new Set(all.map((event) => event.id)).size).toBe(5)
    expect(JSON.parse(readFileSync(join(statsDir(home), 'offsets.json'), 'utf8')).files[path].offset)
      .toBe(Buffer.byteLength(fixture('claude-session.jsonl') + fixture('claude-session-more.jsonl')))
  })

  // F4
  test('a turn split across two runs ends up exactly as it would in one', () => {
    const text = fixture('claude-session.jsonl')
    const lines = text.split('\n').filter(Boolean)
    // Stop between the two lines that share one message id: the first has no Skill call yet.
    const path = plantClaude(lines.slice(0, 2).join('\n') + '\n')
    expect(collect().events).toBe(1)
    expect(events()[0]!.skill).toBeNull()
    writeFileSync(path, text)
    collect()
    const whole = parseClaude(text, context()).events
    // The same turn, down to the field — only its revision says it was finished a run later.
    expect(sameTurns(events())).toEqual(sameTurns(whole))
    expect(events().map((event) => event.rev)).toEqual([2, 1])
    expect(events()[0]!.skill).toBe('dev-implement')
  })

  // F4
  test('a Codex turn completed in a later run has its outcome corrected', () => {
    const lines = fixture('codex-rollout.jsonl').split('\n').filter(Boolean)
    const path = plantCodex(lines.slice(0, -1).join('\n') + '\n')
    collect()
    expect(events().map((event) => event.outcome)).toEqual(['tool_use', 'tool_use'])
    writeFileSync(path, fixture('codex-rollout.jsonl'))
    collect()
    expect(sameTurns(events())).toEqual(sameTurns(parseCodex(fixture('codex-rollout.jsonl'), context()).events))
    expect(events().map((event) => event.rev)).toEqual([1, 2])
    expect(events().map((event) => event.outcome)).toEqual(['tool_use', 'end_turn'])
  })

  // F2
  test('a file replaced at the same path is read from the start, whatever its size', () => {
    const original = fixture('claude-session.jsonl')
    const path = plantClaude(original)
    expect(collect().events).toBe(2)
    // Same length, different session: the bytes already read are not the bytes that are there now.
    const sameSize = original.replaceAll('"s-1"', '"s-9"')
    expect(Buffer.byteLength(sameSize)).toBe(Buffer.byteLength(original))
    writeFileSync(path, sameSize)
    expect(collect().events).toBe(2)
    // Longer, and different from the start.
    writeFileSync(path, original.replaceAll('"s-1"', '"s-7"') + fixture('claude-session-more.jsonl').replaceAll('"s-1"', '"s-7"'))
    expect(collect().events).toBe(3)
    // Truncated and regrown to the same size it had.
    truncateSync(path, 0)
    writeFileSync(path, original.replaceAll('"s-1"', '"s-5"'))
    expect(collect().events).toBe(2)
    // A shorter replacement is still read from the start.
    writeFileSync(path, fixture('claude-session-more.jsonl').replaceAll('"s-1"', '"s-3"'))
    expect(collect().events).toBe(1)
    expect(events()).toHaveLength(10)
    expect(new Set(events().map((event) => event.id)).size).toBe(10)
  })

  // F3
  test('a record larger than one slice is stepped over and the turns after it are still collected', () => {
    const giant = `{"type":"assistant","filler":"${'x'.repeat(9 * 1024 * 1024)}"}\n`
    plantClaude(giant + fixture('claude-session.jsonl'))
    // One run: the oversized record is skipped and the file is read on to its end.
    expect(collect().events).toBe(2)
    expect(collect().events).toBe(0)
  })

  // F20
  test('a killed session collected after the issue moved still counts in the earlier stage', () => {
    const { root, tree } = checkout()
    recordStage(root, 'acme/demo', 42, 'in-progress', new Date('2026-09-17T09:00:00Z'))
    const turn = (id: string, at: string) =>
      `{"type":"user","cwd":${JSON.stringify(tree)},"gitBranch":"feat/42-demo","sessionId":"s-4","timestamp":"${at}"}\n`
      + `{"type":"assistant","cwd":${JSON.stringify(tree)},"gitBranch":"feat/42-demo","sessionId":"s-4","timestamp":"${at}","message":{"id":"${id}","model":"claude-opus-5","stop_reason":"end_turn","content":[],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n`
    const path = plantClaude(turn('m1', '2026-09-17T10:00:00.000Z'))
    // The session is killed; its last turn is only collected after the issue has moved on.
    appendFileSync(path, turn('m2', '2026-09-17T10:30:00.000Z'))
    recordStage(root, 'acme/demo', 42, 'ready-to-ship', new Date('2026-09-17T11:00:00Z'))
    collect()
    expect(events().map((event) => event.state)).toEqual(['in-progress', 'in-progress'])
    // A turn after the move is the later stage, so the two stages really are told apart.
    appendFileSync(path, turn('m3', '2026-09-17T11:30:00.000Z'))
    collect()
    expect(events().map((event) => event.state)).toEqual(['in-progress', 'in-progress', 'ready-to-ship'])
  })

  test('no session logs at all is not an error', () => {
    expect(collect()).toEqual({ files: 0, events: 0, bytes: 0 })
  })

  // F1
  test('an interrupted commit is finished on the next run, exactly once', () => {
    plantClaude(fixture('claude-session.jsonl'))
    plantCodex(fixture('codex-rollout.jsonl'))
    collect()
    const rows = readFileSync(join(statsDir(home), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
    const offsets = JSON.parse(readFileSync(join(statsDir(home), 'offsets.json'), 'utf8'))
    expect(rows).toHaveLength(4)
    // Rewind to the middle of that run's append: two rows written, the third half-written, no offsets.
    writeFileSync(join(statsDir(home), 'events.jsonl'), rows.slice(0, 2).join('\n') + '\n' + rows[2]!.slice(0, 30))
    rmSync(join(statsDir(home), 'offsets.json'))
    writeFileSync(join(statsDir(home), 'pending.json'), JSON.stringify({ events: rows.map((row) => JSON.parse(row)), offsets }))
    expect(collect().events).toBe(0)
    expect(readFileSync(join(statsDir(home), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)).toEqual(rows)
    expect(existsSync(join(statsDir(home), 'pending.json'))).toBe(false)
    expect(events()).toHaveLength(4)
  })

  // F1
  test('two collectors running at once count every turn once', async () => {
    plantClaude(fixture('claude-session.jsonl'))
    plantCodex(fixture('codex-rollout.jsonl'))
    mkdirSync(statsDir(home), { recursive: true })
    writeFileSync(join(statsDir(home), 'identity.json'), JSON.stringify({ login: 'mk', at: Date.now() }))
    const cli = join(import.meta.dir, '../src/index.ts')
    const once = () => new Promise<number>((done) => {
      const child = spawn(process.execPath, [cli, 'stats', 'collect'], { env: { ...process.env, HOME: home, VEGAFACTORY_HOME: join(home, '.vegafactory') }, stdio: 'ignore' })
      child.on('exit', (code) => done(code ?? 1))
    })
    expect(await Promise.all([once(), once()])).toEqual([0, 0])
    const all = events()
    expect(all).toHaveLength(4)
    expect(readFileSync(join(statsDir(home), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
  }, 30_000)
})

// F16
describe('reading events back', () => {
  const shared = (rows: unknown[]) => {
    const clone = join(home, '.vegafactory', 'control-room', 'acme')
    const dir = join(clone, 'stats', '2026', '09', '18')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mk-box.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    writeFileSync(join(home, '.vegafactory', 'factory.json'), JSON.stringify({
      schemaVersion: 1, controlRooms: { acme: { repo: 'acme/room', path: clone, branch: 'main', lastSyncedAt: null, sha: null } },
    }))
    return dir
  }
  const turn = (extra: Partial<StatsEvent>): StatsEvent => ({
    id: 'x', rev: 1, at: '2026-09-18T10:00:00.000Z', operator: 'mk', machine: 'box', harness: 'claude', model: 'opus',
    repo: 'acme/app', issue: 42, state: 'in-progress', skill: null, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    durationMs: 1000, outcome: 'tool_use', ...extra,
  })
  const local = (rows: StatsEvent[]) => {
    mkdirSync(statsDir(home), { recursive: true })
    writeFileSync(join(statsDir(home), 'events.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }

  test('a correction wins over the copy already in the control room, and the other way round', () => {
    shared([turn({})])
    local([turn({ rev: 2, skill: 'dev-implement', outcome: 'end_turn' })])
    expect(loadEvents(home)).toEqual([turn({ rev: 2, skill: 'dev-implement', outcome: 'end_turn' })])
    // The newest revision wins wherever it is: another machine's correction beats a local original.
    shared([turn({ rev: 3, skill: 'dev-review', outcome: 'aborted' })])
    local([turn({ rev: 1 })])
    expect(loadEvents(home)).toEqual([turn({ rev: 3, skill: 'dev-review', outcome: 'aborted' })])
  })

  // F12
  test('a symlinked .jsonl in the control room is never read through', () => {
    const outside = join(base, 'secrets.jsonl')
    writeFileSync(outside, JSON.stringify(turn({ id: 'leaked', repo: 'acme/private' })) + '\n')
    const dir = shared([turn({ id: 'real' })])
    symlinkSync(outside, join(dir, 'linked.jsonl'))
    expect(loadEvents(home, { local: false }).map((event) => event.id)).toEqual(['real'])
  })
})

describe('the operator', () => {
  test('the gh login is asked for once and kept', () => {
    const calls: string[][] = []
    const runner: GhRunner = (args) => {
      calls.push(args)
      return { code: 0, stdout: 'HTTP/2 200\r\n\r\n{"login":"mk"}', stderr: '' }
    }
    expect(resolveOperator(home, runner, 1000)).toBe('mk')
    expect(resolveOperator(home, runner, 2000)).toBe('mk')
    expect(calls).toHaveLength(1)
    // A logged-out or offline machine still collects, under the last known login.
    const broken: GhRunner = () => ({ code: 1, stdout: '', stderr: 'not logged in' })
    expect(resolveOperator(home, broken, 3000)).toBe('mk')
    expect(resolveOperator(join(base, 'other'), broken, 3000)).toBe('unknown')
  })
})

describe('stats show', () => {
  const NOW = Date.parse('2026-09-18T00:00:00Z')
  const out: string[] = []
  beforeEach(() => {
    out.length = 0
    plantClaude(fixture('claude-session.jsonl'))
    plantCodex(fixture('codex-rollout.jsonl'))
    mkdirSync(statsDir(home), { recursive: true })
    // With the login already known, collecting never reaches for gh.
    writeFileSync(join(statsDir(home), 'identity.json'), JSON.stringify({ login: 'mk', at: NOW }))
  })
  const run = (argv: string[]) => runStats(argv, { home, now: () => NOW, out: (text) => out.push(text) })

  test('collect then show prints turns, tokens and stages', () => {
    expect(run(['collect'])).toBe(0)
    expect(out.join('\n')).toContain('collected 4 turns')
    out.length = 0
    expect(run(['show'])).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('4 turns')
    expect(text).toContain('claude · claude-opus-5')
    expect(text).toContain('codex · gpt-5.6-sol')
    expect(text).toContain('acme/demo')
  })

  test('show --json gives the summary, and --since narrows it', () => {
    run(['collect'])
    out.length = 0
    run(['show', '--json'])
    const summary = JSON.parse(out.join('\n'))
    expect(summary.turns).toBe(4)
    expect(summary.tokens).toEqual({ input: 30_244, output: 952, cacheRead: 65_000, cacheWrite: 5300 })
    expect(summary.operators[0].key).toBe('mk')
    expect(summary.skills.map((row: { key: string }) => row.key).sort()).toEqual(['dev-implement', 'dev-review'])
    out.length = 0
    run(['show', '--json', '--since', '1h'])
    expect(JSON.parse(out.join('\n')).turns).toBe(0)
  })

  test('collect never throws at a session', () => {
    writeFileSync(join(statsDir(home), 'offsets.json'), '{ not json')
    expect(run(['collect'])).toBe(0)
  })

  test('--since takes spans and dates', () => {
    expect(parseSince('2d', 10 * 86_400_000)).toBe(8 * 86_400_000)
    expect(parseSince('2026-09-17', 0)).toBe(Date.parse('2026-09-17'))
    expect(() => parseSince('soon', 0)).toThrow('--since')
  })
})

describe('stats push', () => {
  let clone: string
  let repo: string
  let origin: string

  const link = () => writeFileSync(join(home, '.vegafactory', 'factory.json'), JSON.stringify({
    schemaVersion: 1,
    controlRooms: { acme: { repo: 'acme/room', path: clone, branch: 'main', remote: origin, lastSyncedAt: null, sha: null } },
  }))

  beforeEach(() => {
    origin = join(base, 'room.git')
    git(base, 'init', '-q', '--bare', '-b', 'main', origin)
    clone = join(home, '.vegafactory', 'control-room', 'acme')
    git(base, 'clone', '-q', origin, clone)
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'seed')
    git(clone, 'push', '-q', 'origin', 'main')
    spawnSync('git', ['-C', clone, 'config', 'user.name', 't'])
    spawnSync('git', ['-C', clone, 'config', 'user.email', 't@t'])
    link()
    repo = join(base, 'app')
    mkdirSync(join(repo, '.vegastack'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main', repo)
    writeFileSync(join(repo, '.vegastack', 'dev.md'), 'repo: acme/app\ncontrol-room: acme/room#dev\n')
    mkdirSync(statsDir(home), { recursive: true })
    writeFileSync(join(statsDir(home), 'identity.json'), JSON.stringify({ login: 'mk', at: 1 }))
  })

  const event = (id: string, at: string, extra: Partial<StatsEvent> = {}): StatsEvent => ({
    id, rev: 1, at, operator: 'mk', machine: 'box', harness: 'claude', model: 'claude-opus-5', repo: 'acme/app', issue: 42,
    state: 'in-progress', skill: null, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, durationMs: 1000, outcome: 'end_turn', ...extra,
  })
  const write = (...events: StatsEvent[]) =>
    appendFileSync(join(statsDir(home), 'events.jsonl'), events.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const push = (now: number, extra: { force?: boolean; git?: GitRunner } = {}) => pushStats({ home, cwd: repo, now: () => now, ...extra })
  const stats = (...parts: string[]) => join(clone, 'stats', ...parts)
  const journalFor = (room: string) => join(statsDir(home), 'push-pending', `${room.replace('/', '__')}.json`)

  // F13: a stats commit moves the copy's HEAD. Sync and the profile reader both refuse a copy
  // sitting on a commit the record does not name, so the push has to say where it left the copy —
  // otherwise one hourly push takes this machine's whole profile down until the next fetch.
  test('a push records the commit it leaves behind, so the profile and the next sync still work', async () => {
    const { loadProfile, readFactoryConfig, factoryConfigPath } = await import('../src/control-room.ts')
    const { resolveTarget, syncControlRoom } = await import('../src/sync.ts')
    const devMd = readFileSync(join(repo, '.vegastack', 'dev.md'), 'utf8')
    // Give the room a policy to resolve, put it on the remote, and let sync make the copy — the
    // whole point is that the copy stays the one the record names from there on.
    const seed = join(base, 'seed')
    git(base, 'clone', '-q', origin, seed)
    spawnSync('git', ['-C', seed, 'config', 'user.name', 't']); spawnSync('git', ['-C', seed, 'config', 'user.email', 't@t'])
    mkdirSync(join(seed, 'groups', 'dev'), { recursive: true })
    writeFileSync(join(seed, 'org.md'), 'tests: required   # locked\n')
    writeFileSync(join(seed, 'groups', 'dev', 'group.md'), 'merge: rebase\n')
    git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'policy'); git(seed, 'push', '-q', 'origin', 'main')
    rmSync(clone, { recursive: true, force: true })
    const recorded = () => readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')).controlRooms.acme!
    const head = () => spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD']).stdout.toString().trim()

    const config = readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8'))
    const target = resolveTarget({ devMdText: devMd, config, home })!
    const synced = await syncControlRoom({ target, config, now: Date.parse('2026-09-18T11:00:00Z') })
    expect(synced.message).toContain('control room acme')
    expect(synced.ok).toBe(true)
    spawnSync('git', ['-C', clone, 'config', 'user.name', 't']); spawnSync('git', ['-C', clone, 'config', 'user.email', 't@t'])
    expect(loadProfile({ home, devMd, now: Date.parse('2026-09-18T11:00:00Z') }).ok).toBe(true)

    write(event('a', '2026-09-18T11:30:00.000Z'))
    const pushed = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(pushed).toMatchObject({ ok: true, action: 'pushed' })
    expect(head()).not.toBe(synced.sha)
    expect(recorded().sha).toBe(head())

    const after = loadProfile({ home, devMd, now: Date.parse('2026-09-18T12:00:00Z') })
    expect(after.blocks).toEqual([])
    expect(after.values.tests).toBe('required')
    expect(after.values.merge).toBe('rebase')

    const again = await syncControlRoom({
      target, config: readFactoryConfig(readFileSync(factoryConfigPath(home), 'utf8')),
      now: Date.parse('2026-09-18T13:00:00Z'), force: true,
    })
    expect(again.ok).toBe(true)
    expect(again.sha).toBe(head())
  })

  // The copy belongs to the org, not to this command: sync fetches and checks out in it, and both
  // move its HEAD. A push that went ahead anyway could commit into a half-finished checkout.
  test('a push gives up rather than committing into a copy another run holds', async () => {
    const { lockOrgSync } = await import('../src/control-room.ts')
    const unlock = lockOrgSync(clone)!
    expect(unlock).toBeTruthy()
    try {
      write(event('a', '2026-09-18T11:00:00.000Z'))
      const held = push(Date.parse('2026-09-18T12:00:00Z'))
      expect(held).toMatchObject({ ok: true, action: 'none' })
      expect(held.message).toMatch(/another run is using/)
      expect(existsSync(join(clone, 'stats'))).toBe(false)
    } finally { unlock() }
    // With the lock free the same push goes through.
    expect(push(Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ ok: true, action: 'pushed' })
  }, 20_000)

  test('turns land in the control room as one file per operator, machine and day', () => {
    write(event('a', '2026-09-17T10:00:00.000Z'), event('b', '2026-09-18T11:00:00.000Z'))
    const result = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(result).toMatchObject({ ok: true, action: 'pushed', events: 2 })
    expect(readdirSync(stats('2026', '09', '17'))).toEqual(['mk-box.jsonl'])
    expect(readFileSync(stats('2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    // The clone must stay clean, or the next `vegafactory sync` refuses to refresh it.
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git(clone, 'log', 'origin/main', '-1', '--format=%s')).toContain('stats: 2 turns')
    // The events are also readable back as org data.
    expect(loadEvents(home, { local: false }).map((row) => row.id).sort()).toEqual(['a', 'b'])
  })

  // F10
  test('each turn is filed under the operator and machine it was recorded on', () => {
    write(
      event('a', '2026-09-18T10:00:00.000Z', { operator: 'unknown', machine: 'box' }),
      event('b', '2026-09-18T10:05:00.000Z', { operator: 'mk', machine: 'box' }),
      event('c', '2026-09-18T10:10:00.000Z', { operator: 'sam', machine: 'box' }),
      event('d', '2026-09-18T10:15:00.000Z', { operator: 'mk', machine: 'laptop' }),
    )
    const result = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(result.action).toBe('pushed')
    expect(readdirSync(stats('2026', '09', '18')).sort()).toEqual(['mk-box.jsonl', 'mk-laptop.jsonl', 'sam-box.jsonl', 'unknown-box.jsonl'])
    expect(JSON.parse(readFileSync(stats('2026', '09', '18', 'unknown-box.jsonl'), 'utf8').trim()).id).toBe('a')
    expect(result.paths).toHaveLength(4)
  })

  test('a push runs at most once an hour, and only for what is new', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    expect(push(Date.parse('2026-09-18T12:00:00Z')).action).toBe('pushed')
    write(event('b', '2026-09-18T12:10:00.000Z'))
    expect(push(Date.parse('2026-09-18T12:30:00Z')).action).toBe('skipped')
    const later = push(Date.parse('2026-09-18T13:05:00Z'))
    expect(later).toMatchObject({ action: 'pushed', events: 1 })
    expect(readFileSync(stats('2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(push(Date.parse('2026-09-18T14:10:00Z')).action).toBe('none')
  })

  test('without a linked control room nothing is pushed and nothing fails', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    writeFileSync(join(repo, '.vegastack', 'dev.md'), 'repo: acme/app\n')
    expect(push(Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ ok: true, action: 'none' })
    rmSync(join(home, '.vegafactory', 'factory.json'))
    writeFileSync(join(repo, '.vegastack', 'dev.md'), 'repo: acme/app\ncontrol-room: acme/room#dev\n')
    expect(push(Date.parse('2026-09-18T12:00:00Z')).ok).toBe(true)
  })

  // F8
  test('a commit that never reached the remote is pushed by the next run', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const moved = `${origin}.away`
    spawnSync('mv', [origin, moved])
    expect(push(Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ ok: false, action: 'committed' })
    expect(git(clone, 'log', '-1', '--format=%s')).toContain('stats: 1 turn')
    // The cursor moved with the commit, so only the retry can still deliver it — and it does,
    // even inside the hour and with no new turns to send.
    spawnSync('mv', [moved, origin])
    const again = push(Date.parse('2026-09-18T12:10:00Z'))
    expect(again).toMatchObject({ ok: true, action: 'pushed' })
    expect(again.message).toContain('earlier stats commit')
    expect(git(clone, 'log', 'origin/main', '-1', '--format=%s')).toContain('stats: 1 turn')
  })

  // F7
  test('a clone that is not exactly as sync left it is refused, and nothing is written', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const at = Date.parse('2026-09-18T12:00:00Z')
    const refused = (what: string) => {
      const result = push(at)
      expect(result.action, what).toBe('refused')
      expect(existsSync(join(clone, 'stats')), what).toBe(false)
      expect(readJsonCursor()).toBeUndefined()
    }
    const readJsonCursor = () => {
      try { return JSON.parse(readFileSync(join(statsDir(home), 'push.json'), 'utf8')).rooms['acme/room'].offset } catch { return undefined }
    }
    // A dirty worktree.
    writeFileSync(join(clone, 'notes.md'), 'x')
    refused('untracked file')
    rmSync(join(clone, 'notes.md'))
    // A staged file someone else left behind.
    writeFileSync(join(clone, 'notes.md'), 'x')
    git(clone, 'add', 'notes.md')
    refused('staged file')
    git(clone, 'reset', '-q')
    rmSync(join(clone, 'notes.md'))
    // The wrong branch.
    git(clone, 'checkout', '-q', '-b', 'other')
    refused('wrong branch')
    git(clone, 'checkout', '-q', 'main')
    // A local commit that is not a stats push.
    writeFileSync(join(clone, 'notes.md'), 'x')
    git(clone, 'add', 'notes.md')
    git(clone, 'commit', '-q', '-m', 'someone else')
    refused('unrelated commit')
    git(clone, 'reset', '-q', '--hard', 'origin/main')
    // Sorted out: the same turns go through.
    expect(push(at).action).toBe('pushed')
  })

  // F7
  test('a failed commit puts the clone back exactly as it was', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const failing: GitRunner = (args) => (args.includes('commit') ? { code: 1, out: 'no identity' } : defaultGitFor(args))
    const result = push(Date.parse('2026-09-18T12:00:00Z'), { git: failing })
    expect(result.action).toBe('refused')
    expect(existsSync(stats('2026', '09', '18', 'mk-box.jsonl'))).toBe(false)
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    // Nothing was consumed, so a healthy run still sends it.
    expect(push(Date.parse('2026-09-18T12:00:00Z')).action).toBe('pushed')
  })

  // F12
  test('a symlink under stats/ can never redirect the write out of the clone', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    // Someone commits stats/2026 as a link out of the control room, and everyone pulls it.
    const other = join(base, 'other-clone')
    git(base, 'clone', '-q', origin, other)
    mkdirSync(join(other, 'stats'), { recursive: true })
    symlinkSync(outside, join(other, 'stats', '2026'))
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'stats: a link')
    git(other, 'push', '-q', 'origin', 'main')
    git(clone, 'fetch', '-q', 'origin')
    git(clone, 'reset', '-q', '--hard', 'origin/main')

    write(event('a', '2026-09-18T10:00:00.000Z'))
    const result = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(result.action).toBe('refused')
    expect(result.message).toContain('symlinked')
    expect(readdirSync(outside)).toEqual([])
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  // F13
  test('a death between the commit and the cursor neither loses turns nor files them twice', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const killed: GitRunner = (args) => {
      const result = defaultGitFor(args)
      if (args.includes('commit')) throw new Error('killed right after the commit')
      return result
    }
    expect(() => push(Date.parse('2026-09-18T12:00:00Z'), { git: killed })).toThrow('killed')
    // The commit is there, the cursor is not: only the journal knows how far the batch got.
    expect(git(clone, 'log', '-1', '--format=%s')).toContain('stats: 1 turn')
    expect(existsSync(join(statsDir(home), 'push.json'))).toBe(false)
    expect(existsSync(journalFor('acme/room'))).toBe(true)

    const again = push(Date.parse('2026-09-18T12:10:00Z'))
    expect(again).toMatchObject({ ok: true, action: 'pushed' })
    expect(existsSync(journalFor('acme/room'))).toBe(false)
    // Exactly one stats commit, and the turn is in the file exactly once.
    expect(git(clone, 'log', 'origin/main', '--format=%s').split('\n').filter((line) => line.startsWith('stats:'))).toHaveLength(1)
    expect(readFileSync(stats('2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    // And the cursor really moved: there is nothing left to send.
    expect(push(Date.parse('2026-09-18T14:00:00Z')).action).toBe('none')
  })

  // F13
  test('a death before the commit puts the rows back and keeps the turns for the next run', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const killed: GitRunner = (args) => {
      if (args.includes('add')) throw new Error('killed while staging')
      return defaultGitFor(args)
    }
    expect(() => push(Date.parse('2026-09-18T12:00:00Z'), { git: killed })).toThrow('killed')
    expect(existsSync(journalFor('acme/room'))).toBe(true)
    const healthy = push(Date.parse('2026-09-18T12:10:00Z'))
    expect(healthy).toMatchObject({ ok: true, action: 'pushed', events: 1 })
    expect(readFileSync(stats('2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  // F14
  test('a rebase that conflicts is aborted and the clone is handed back as it was', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    expect(push(Date.parse('2026-09-18T12:00:00Z')).action).toBe('pushed')
    // Another machine writes to the very same file and pushes first.
    const other = join(base, 'other-clone')
    git(base, 'clone', '-q', origin, other)
    appendFileSync(join(other, 'stats', '2026', '09', '18', 'mk-box.jsonl'), JSON.stringify(event('z', '2026-09-18T10:30:00.000Z')) + '\n')
    git(other, 'commit', '-q', '-a', '-m', 'stats: someone else')
    git(other, 'push', '-q', 'origin', 'main')

    write(event('b', '2026-09-18T10:40:00.000Z'))
    const result = push(Date.parse('2026-09-18T13:10:00Z'))
    expect(result).toMatchObject({ ok: false, action: 'committed' })
    expect(result.message).toContain('put back')
    // No rebase left in progress, nothing half-merged, and our own commit still stands.
    expect(existsSync(join(clone, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(clone, '.git', 'rebase-apply'))).toBe(false)
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git(clone, 'log', '-1', '--format=%s')).toContain('stats: 1 turn')
    expect(readFileSync(stats('2026', '09', '18', 'mk-box.jsonl'), 'utf8')).not.toContain('<<<<')
  })

  // F15
  test('the cursor is bytes, so a turn with non-ASCII text does not shift the next push', () => {
    write(event('a', '2026-09-18T10:00:00.000Z', { model: 'claude-opus-5-ünïcode', machine: 'büro-mac' }))
    const first = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(first).toMatchObject({ action: 'pushed', events: 1 })
    expect(first.paths).toEqual(['stats/2026/09/18/mk-b-ro-mac.jsonl'])
    write(event('b', '2026-09-18T12:30:00.000Z'))
    expect(push(Date.parse('2026-09-18T13:05:00Z'))).toMatchObject({ action: 'pushed', events: 1 })
    // The second push starts where the first stopped, counted in bytes, not characters.
    expect(JSON.parse(readFileSync(stats('2026', '09', '18', 'mk-b-ro-mac.jsonl'), 'utf8').trim()).model).toBe('claude-opus-5-ünïcode')
    const rows = readFileSync(stats('2026', '09', '18', 'mk-box.jsonl'), 'utf8').trim().split('\n')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!).id).toBe('b')
    expect(push(Date.parse('2026-09-18T14:10:00Z')).action).toBe('none')
  })

  // F19
  test('a journal naming a symlinked file is refused and kept', () => {
    const outside = join(base, 'target.jsonl')
    writeFileSync(outside, 'keep me\n')
    const relative = 'stats/2026/09/18/mk-box.jsonl'
    mkdirSync(stats('2026', '09', '18'), { recursive: true })
    symlinkSync(outside, join(clone, ...relative.split('/')))
    const path = journalFor('acme/room')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      token: 'abc', at: Date.parse('2026-09-18T11:00:00Z'), offset: 0, head: git(clone, 'rev-parse', 'HEAD'),
      room: { repo: 'acme/room', remote: origin, branch: 'main', path: clone },
      files: [{ relative, had: 4, digest: 'whatever', wrote: 0, appended: 'x' }],
    }))
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const result = push(Date.parse('2026-09-18T12:00:00Z'))
    expect(result.action).toBe('refused')
    expect(result.message).toContain('symlinked')
    // The journal stays for a person, and the link's target is untouched.
    expect(existsSync(journalFor('acme/room'))).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('keep me\n')
  })

  // F19
  test('a journal that is not for this clone, or is malformed, is refused and kept', () => {
    const path = journalFor('acme/room')
    mkdirSync(dirname(path), { recursive: true })
    const journal = {
      token: 'abc', at: Date.parse('2026-09-18T11:00:00Z'), offset: 0, head: git(clone, 'rev-parse', 'HEAD'),
      room: { repo: 'acme/room', remote: origin, branch: 'main', path: join(base, 'somewhere-else') },
      files: [{ relative: 'stats/2026/09/18/mk-box.jsonl', had: null, digest: 'x', wrote: 0, appended: 'x' }],
    }
    writeFileSync(path, JSON.stringify(journal))
    write(event('a', '2026-09-18T10:00:00.000Z'))
    expect(push(Date.parse('2026-09-18T12:00:00Z')).message).toContain('which is not the clone this push found')
    expect(existsSync(path)).toBe(true)
    writeFileSync(path, JSON.stringify({ ...journal, files: [{ relative: '../../escape.jsonl', had: null, digest: 'x', wrote: 0, appended: 'x' }] }))
    expect(push(Date.parse('2026-09-18T12:00:00Z')).message).toContain('unreadable push journal')
    expect(existsSync(path)).toBe(true)
    // Sound again once the journal is gone.
    rmSync(path)
    expect(push(Date.parse('2026-09-18T12:00:00Z')).action).toBe('pushed')
  })

  // F19
  test('a rollback whose index reset fails keeps the journal and says so', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const broken: GitRunner = (args) => {
      if (args.includes('add') || args.includes('reset')) return { code: 1, out: 'refusing' }
      return defaultGitFor(args)
    }
    const result = push(Date.parse('2026-09-18T12:00:00Z'), { git: broken })
    expect(result.action).toBe('refused')
    expect(result.message).toContain('index could not be put back')
    expect(existsSync(journalFor('acme/room'))).toBe(true)
    // The rows themselves were still taken back out.
    expect(existsSync(stats('2026', '09', '18', 'mk-box.jsonl'))).toBe(false)
  })

  // F21
  test('a rollback refuses when the file or the clone changed since the crash', () => {
    const file = stats('2026', '09', '18', 'mk-box.jsonl')
    const crash = () => {
      const killed: GitRunner = (args) => {
        if (args.includes('add')) throw new Error('killed while staging')
        return defaultGitFor(args)
      }
      expect(() => push(Date.parse('2026-09-18T12:00:00Z'), { git: killed })).toThrow('killed')
    }
    write(event('a', '2026-09-18T10:00:00.000Z'))
    crash()
    // Someone else wrote to the same file before the next run.
    appendFileSync(file, 'a line from somewhere else\n')
    const changed = push(Date.parse('2026-09-18T12:10:00Z'))
    expect(changed.action).toBe('refused')
    expect(changed.message).toContain('changed since this push began')
    // Nothing was truncated, and the journal is kept for a person.
    expect(readFileSync(file, 'utf8')).toContain('a line from somewhere else')
    expect(existsSync(journalFor('acme/room'))).toBe(true)

    // Same again, but the clone itself moved on: the rollback still touches nothing.
    rmSync(journalFor('acme/room'))
    rmSync(file)
    write(event('b', '2026-09-18T10:05:00.000Z'))
    crash()
    const before = readFileSync(file, 'utf8')
    git(clone, 'add', '-A')
    git(clone, 'commit', '-q', '-m', 'stats: someone else committed it')
    const moved = push(Date.parse('2026-09-18T12:20:00Z'))
    expect(moved.action).toBe('refused')
    expect(moved.message).toContain('moved to')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(journalFor('acme/room'))).toBe(true)
  })

  // F22
  test('a rollback refuses when the appended bytes are not the ones it wrote', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const killed: GitRunner = (args) => {
      if (args.includes('add')) throw new Error('killed while staging')
      return defaultGitFor(args)
    }
    expect(() => push(Date.parse('2026-09-18T12:00:00Z'), { git: killed })).toThrow('killed')
    // Someone replaced the tail with their own line of exactly the same length.
    const file = stats('2026', '09', '18', 'mk-box.jsonl')
    const theirs = Buffer.alloc(readFileSync(file).length, 0x78)
    theirs[theirs.length - 1] = 0x0a
    writeFileSync(file, theirs)
    const result = push(Date.parse('2026-09-18T12:10:00Z'))
    expect(result.action).toBe('refused')
    expect(result.message).toContain('changed since this push began')
    // Their bytes are still there, and the journal waits for a person.
    expect(readFileSync(file).equals(theirs)).toBe(true)
    expect(existsSync(journalFor('acme/room'))).toBe(true)
  })

  // F9
  test('a control-room path outside the store or behind a symlink is refused', () => {
    write(event('a', '2026-09-18T10:00:00.000Z'))
    const elsewhere = join(base, 'elsewhere')
    git(base, 'clone', '-q', origin, elsewhere)
    clone = elsewhere
    link()
    expect(push(Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ ok: false, action: 'refused' })
    expect(push(Date.parse('2026-09-18T12:00:00Z')).message).toContain('outside')
    // A path inside the store whose last component is a link out of it.
    clone = join(home, '.vegafactory', 'control-room', 'linked')
    symlinkSync(elsewhere, clone)
    link()
    expect(push(Date.parse('2026-09-18T12:00:00Z')).message).toContain('symlinked')
    expect(existsSync(join(elsewhere, 'stats'))).toBe(false)
  })
})

// F17, F18
describe('stats push with two control rooms', () => {
  interface Room { org: string; room: string; code: string; origin: string; clone: string; repo: string }
  let rooms: Room[]

  const build = (org: string, code: string): Room => {
    const origin = join(base, `${org}.git`)
    git(base, 'init', '-q', '--bare', '-b', 'main', origin)
    const clone = join(home, '.vegafactory', 'control-room', org)
    git(base, 'clone', '-q', origin, clone)
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'seed')
    git(clone, 'push', '-q', 'origin', 'main')
    spawnSync('git', ['-C', clone, 'config', 'user.name', 't'])
    spawnSync('git', ['-C', clone, 'config', 'user.email', 't@t'])
    const repo = join(base, `app-${org}`)
    mkdirSync(join(repo, '.vegastack'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main', repo)
    writeFileSync(join(repo, '.vegastack', 'dev.md'), `repo: ${code}\ncontrol-room: ${org}/room#dev\n`)
    return { org, room: `${org}/room`, code, origin, clone, repo }
  }

  beforeEach(() => {
    rooms = [build('acme', 'acme/app'), build('other', 'other/app')]
    writeFileSync(join(home, '.vegafactory', 'factory.json'), JSON.stringify({
      schemaVersion: 1,
      controlRooms: Object.fromEntries(rooms.map((room) => [room.org, { repo: room.room, path: room.clone, branch: 'main', remote: room.origin, lastSyncedAt: null, sha: null }])),
    }))
    mkdirSync(statsDir(home), { recursive: true })
  })

  const event = (id: string, at: string, repo: string): StatsEvent => ({
    id, rev: 1, at, operator: 'mk', machine: 'box', harness: 'claude', model: 'claude-opus-5', repo, issue: 42,
    state: 'in-progress', skill: null, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, durationMs: 1000, outcome: 'end_turn',
  })
  const write = (...events: StatsEvent[]) =>
    appendFileSync(join(statsDir(home), 'events.jsonl'), events.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const rows = (room: Room) => {
    const path = join(room.clone, 'stats', '2026', '09', '18', 'mk-box.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line).id) : []
  }
  const push = (room: Room, now: number, extra: { git?: GitRunner } = {}) => pushStats({ home, cwd: room.repo, now: () => now, ...extra })
  const journalFor = (room: string) => join(statsDir(home), 'push-pending', `${room.replace('/', '__')}.json`)

  test('each room gets only its own repositories, and neither cursor swallows the other', () => {
    write(
      event('a1', '2026-09-18T10:00:00.000Z', 'acme/app'),
      event('b1', '2026-09-18T10:05:00.000Z', 'other/app'),
      event('a2', '2026-09-18T10:10:00.000Z', 'acme/app'),
      event('b2', '2026-09-18T10:15:00.000Z', 'other/app'),
      // A repository neither room is bound to stays on this machine.
      event('x1', '2026-09-18T10:20:00.000Z', 'someone/else'),
    )
    expect(push(rooms[0]!, Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ action: 'pushed', events: 2 })
    expect(push(rooms[1]!, Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ action: 'pushed', events: 2 })
    expect(rows(rooms[0]!)).toEqual(['a1', 'a2'])
    expect(rows(rooms[1]!)).toEqual(['b1', 'b2'])
    // The unbound repository went nowhere, and both rooms are clean.
    for (const room of rooms) {
      expect(readFileSync(join(room.clone, 'stats', '2026', '09', '18', 'mk-box.jsonl'), 'utf8')).not.toContain('someone/else')
      expect(git(room.clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    }
    const cursors = JSON.parse(readFileSync(join(statsDir(home), 'push.json'), 'utf8')).rooms
    expect(Object.keys(cursors).sort()).toEqual(['acme/room', 'other/room'])
    // New turns for one room only: the other room's cursor is untouched and has nothing to do.
    write(event('a3', '2026-09-18T13:00:00.000Z', 'acme/app'))
    expect(push(rooms[0]!, Date.parse('2026-09-18T13:10:00Z'))).toMatchObject({ action: 'pushed', events: 1 })
    expect(push(rooms[1]!, Date.parse('2026-09-18T13:10:00Z')).action).toBe('none')
    expect(rows(rooms[0]!)).toEqual(['a1', 'a2', 'a3'])
    expect(rows(rooms[1]!)).toEqual(['b1', 'b2'])
  })

  test('the room registry authorizes the other repositories that belong to it', () => {
    writeFileSync(join(rooms[0]!.clone, 'repos.md'), '| repo | group |\n|---|---|\n| acme/other-service | dev |\n')
    git(rooms[0]!.clone, 'add', '-A')
    git(rooms[0]!.clone, 'commit', '-q', '-m', 'stats: registry')
    git(rooms[0]!.clone, 'push', '-q', 'origin', 'main')
    write(event('a1', '2026-09-18T10:00:00.000Z', 'acme/other-service'), event('b1', '2026-09-18T10:05:00.000Z', 'other/app'))
    expect(push(rooms[0]!, Date.parse('2026-09-18T12:00:00Z'))).toMatchObject({ action: 'pushed', events: 1 })
    expect(rows(rooms[0]!)).toEqual(['a1'])
  })

  // F18
  test('a crash in one room is never replayed against another', () => {
    write(event('a1', '2026-09-18T10:00:00.000Z', 'acme/app'), event('b1', '2026-09-18T10:05:00.000Z', 'other/app'))
    const killed: GitRunner = (args) => {
      const result = defaultGitFor(args)
      if (args.includes('commit')) throw new Error('killed right after the commit')
      return result
    }
    expect(() => push(rooms[0]!, Date.parse('2026-09-18T12:00:00Z'), { git: killed })).toThrow('killed')
    expect(existsSync(journalFor('acme/room'))).toBe(true)

    // A hook run from the other repository must not touch room A's journal, paths or sizes.
    expect(push(rooms[1]!, Date.parse('2026-09-18T12:01:00Z'))).toMatchObject({ action: 'pushed', events: 1 })
    expect(rows(rooms[1]!)).toEqual(['b1'])
    expect(rows(rooms[0]!)).toEqual(['a1'])
    expect(existsSync(journalFor('acme/room'))).toBe(true)
    expect(existsSync(journalFor('other/room'))).toBe(false)

    // Room A recovers on its own next run, exactly once.
    expect(push(rooms[0]!, Date.parse('2026-09-18T12:02:00Z'))).toMatchObject({ ok: true, action: 'pushed' })
    expect(existsSync(journalFor('acme/room'))).toBe(false)
    expect(rows(rooms[0]!)).toEqual(['a1'])
    expect(git(rooms[0]!.clone, 'log', 'origin/main', '--format=%s').split('\n').filter((line) => line.startsWith('stats:'))).toHaveLength(1)
  })
})

const defaultGitFor = (args: string[]) => {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

describe('summaries', () => {
  test('buckets carry turns, tokens, time and who used them', () => {
    const rows: StatsEvent[] = [
      { id: '1', rev: 1, at: '2026-09-17T10:00:00.000Z', operator: 'mk', machine: 'box', harness: 'claude', model: 'opus', repo: 'acme/app', issue: 1, state: 'in-progress', skill: 'dev-plan', tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }, durationMs: 60_000, outcome: 'end_turn' },
      { id: '2', rev: 1, at: '2026-09-18T10:00:00.000Z', operator: 'sam', machine: 'box', harness: 'codex', model: 'gpt', repo: 'acme/app', issue: 1, state: 'ready-to-ship', skill: null, tokens: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 }, durationMs: 120_000, outcome: 'tool_use' },
    ]
    const summary = summarize(rows)
    expect(summary.turns).toBe(2)
    expect(summary.operators.map((row) => row.key).sort()).toEqual(['mk', 'sam'])
    expect(summary.projects[0]).toMatchObject({ key: 'acme/app', turns: 2, operators: ['mk', 'sam'] })
    // The issue keeps the state of its latest turn.
    expect(summary.issues[0]).toMatchObject({ key: 'acme/app#1', state: 'ready-to-ship' })
    expect(summary.days.map((row) => row.key)).toEqual(['2026-09-17', '2026-09-18'])
    expect(summary.stages.map((row) => row.key).sort()).toEqual(['in-progress', 'ready-to-ship'])
  })
})

import { expect, test, beforeEach } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listOutbox, appendSkillInvocations } from '../src/stats/outbox.ts'
import { recordRun, flushStats } from '../src/dispatch.ts'

const policy = { enabled: true, people: true, source: 'org' as const, refusal: null }
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vsk-dispatch-')) })

const input = {
  harness: 'claude' as const,
  stdout: JSON.stringify({ session_id: 'sess-1', duration_ms: 60_000, num_turns: 9, total_cost_usd: 0.9, is_error: false, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 } }),
  exitCode: 0,
  startedAt: '2026-09-03T10:00:00.000Z',
  finishedAt: '2026-09-03T10:01:00.000Z',
  repo: 'vegastack/vegafactory', issue: 121, parent: 104, stage: 'implement',
  model: 'fable-5.1', effort: 'high', human: 'kmanojkumar',
  worktree: '/repo/.vegastack/.worktrees/121-statistics',
}

test('a finished run appends exactly one record carrying the run context', async () => {
  await recordRun(input, { home, hostname: 'mini', policy })
  const batches = await listOutbox(home)
  expect(batches).toHaveLength(1)
  const record = batches[0]!.records[0]!
  expect(record).toMatchObject({
    issue: 121, parent: 104, stage: 'implement', harness: 'claude', model: 'fable-5.1',
    effort: 'high', mode: 'headless', human: 'kmanojkumar', session_id: 'sess-1', outcome: 'complete',
  })
})

test('skills invoked during the run are folded in from the session sidecar', async () => {
  await appendSkillInvocations(home, 'sess-1', [{ name: 'dev-architect', trigger: 'model', harness: 'claude' }])
  await recordRun(input, { home, hostname: 'mini', policy })
  expect((await listOutbox(home))[0]!.records[0]!.skills)
    .toEqual([{ name: 'dev-architect', trigger: 'model', harness: 'claude' }])
})

test('a non-zero exit is recorded as failed, and unparseable stdout still yields a record', async () => {
  await recordRun({ ...input, exitCode: 1, stdout: 'crashed' }, { home, hostname: 'mini', policy })
  const record = (await listOutbox(home))[0]!.records[0]!
  expect(record.outcome).toBe('failed')
  expect(record.duration_s).toBe(60)
  expect(record.tokens.in).toBeNull()
})

test('with the policy off the run writes nothing', async () => {
  await recordRun(input, { home, hostname: 'mini', policy: { enabled: false, people: false, source: 'org', refusal: null } })
  expect(await listOutbox(home)).toEqual([])
})

test('a failed flush never throws into the tick', async () => {
  await recordRun(input, { home, hostname: 'mini', policy })
  const result = await flushStats({
    home, cloneRoot: await mkdtemp(join(tmpdir(), 'vsk-dispatch-clone-')),
    ghUser: 'kmanojkumar', hostname: 'mini',
    git: async () => { throw new Error('git missing') },
  })
  expect(result.ok).toBe(false)
  expect(await listOutbox(home)).toHaveLength(1)
})

test('the run record carries the issue\'s rework when the comments can be read, and null when they cannot', async () => {
  await recordRun(input, {
    home, hostname: 'mini', policy,
    rework: async () => ({ review_rounds: 2, fix_rounds: 1, handbacks: 0 }),
  })
  expect((await listOutbox(home))[0]!.records[0]).toMatchObject({ review_rounds: 2, fix_rounds: 1, handbacks: 0 })
  const blind = await mkdtemp(join(tmpdir(), 'vsk-dispatch-'))
  await recordRun(input, { home: blind, hostname: 'mini', policy, rework: async () => { throw new Error('HTTP 403') } })
  expect((await listOutbox(blind))[0]!.records[0]).toMatchObject({ review_rounds: null, fix_rounds: null, handbacks: null })
})

test('terminal timeout overrides vendor success in capture',async()=>{
  const {fromClaudeHeadless,fromCodexExec}=await import('../src/stats/capture.ts')
  const context={repo:'acme/app',ts:'2026-09-08T08:00:00Z',terminationCause:'timed-out' as const}
  expect(fromClaudeHeadless({is_error:false},context).outcome).toBe('failed')
  expect(fromCodexExec([{type:'turn.completed',usage:{input_tokens:1}}],context).outcome).toBe('failed')
})

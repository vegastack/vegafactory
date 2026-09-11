import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStatus, renderStatus, runStatusCli, summariseLog } from '../src/status.ts'
import { parseFactoryConfig, parseRepoPolicy } from '../src/config.ts'

const config = parseFactoryConfig({ repos: [{ path: '/w/app', repo: 'acme/app', org: 'acme' }] }, '/home/mk')
const policy = parseRepoPolicy('dispatch: local\noperators: mk\nimplement: claude fable-5-1 high\n')
const board = [
  { number: 7, title: 'a', labels: ['needs-plan'], assignees: ['mk'], updatedAt: '2026-09-03T10:00:00Z' },
  { number: 8, title: 'b', labels: ['working'], assignees: ['mk'], updatedAt: '2026-09-03T10:01:00Z' },
]

describe('summariseLog', () => {
  test('reads the exit code and the last message out of a run log', () => {
    const jsonl = [
      '{"at":"2026-09-03T10:00:00Z","stream":"stdout","text":"starting"}',
      '{"at":"2026-09-03T10:04:00Z","stream":"stdout","text":"done"}',
      '{"at":"2026-09-03T10:04:01Z","event":"exit","exitCode":0}',
    ].join('\n')
    expect(summariseLog(jsonl)).toEqual({ exitCode: 0, lastMessage: 'done' })
  })

  test('a log with no exit record is an in-flight run', () => {
    expect(summariseLog('{"at":"2026-09-03T10:00:00Z","stream":"stdout","text":"working"}').exitCode).toBeNull()
  })

  test('an unparseable line is skipped rather than taking the summary down', () => {
    expect(summariseLog('not json\n{"event":"exit","exitCode":2}').exitCode).toBe(2)
  })
})

describe('buildStatus', () => {
  test('reports the dispatcher health, the board counts and the worktrees', () => {
    const report = buildStatus({
      config,
      state: { lastTick: { 'acme/app': '2026-09-03T10:02:00Z' }, handled: [] },
      lockPid: 4242,
      repos: [{
        repo: 'acme/app',
        policy,
        board,
        worktrees: [{ path: '/w/app/.vegastack/.worktrees/8-b', branch: 'feat/8-b', issue: 8, state: 'active' }],
        logs: [{ file: '/l/8-1.jsonl', body: '{"at":"2026-09-03T10:00:00Z","event":"start","issue":8,"stage":"implement"}\n{"event":"exit","exitCode":0}' }],
      }],
    })
    expect(report.dispatcher).toMatchObject({ running: true, pid: 4242, lastTick: '2026-09-03T10:02:00Z', interval: 120 })
    expect(report.repos[0]!.board).toEqual({ needsPlan: 1, ready: 0, working: 1, forOperator: 0 })
    expect(report.repos[0]!.worktrees[0]!.state).toBe('active')
    expect(report.repos[0]!.dispatch).toBe('local')
    expect(report.repos[0]!.runs[0]).toMatchObject({ issue: 8, stage: 'implement', exitCode: 0, logFile: '/l/8-1.jsonl' })
  })

  test('no lock pid means the dispatcher is not running, and the render says so', () => {
    const report = buildStatus({ config, state: { lastTick: {}, handled: [] }, lockPid: null, repos: [] })
    expect(report.dispatcher.running).toBe(false)
    expect(renderStatus(report)).toContain('dispatcher: not running')
  })

  test('the render names a repo that is opted out, so a silent board is explained', () => {
    const report = buildStatus({
      config,
      state: { lastTick: {}, handled: [] },
      lockPid: null,
      repos: [{ repo: 'acme/app', policy: parseRepoPolicy('operators: mk\n'), board, worktrees: [], logs: [] }],
    })
    expect(renderStatus(report)).toContain('dispatch: off')
  })
})

describe('runStatusCli', () => {
  function home(): string {
    const root = mkdtempSync(join(tmpdir(), 'vsk-status-'))
    const repo = join(root, 'app')
    mkdirSync(join(repo, '.vegastack'), { recursive: true })
    writeFileSync(join(repo, '.vegastack/dev.md'), '## Knobs\n\ndispatch: local\noperators: mk\nimplement: claude fable-5-1 high\n')
    writeFileSync(join(root, 'factory.json'), JSON.stringify({ repos: [{ path: repo, repo: 'acme/app', org: 'acme' }] }))
    return root
  }

  test('reports the board and the dispatcher, in JSON, without a service running', async () => {
    const root = home()
    const printed: string[] = []
    const log = console.log
    console.log = (line: string) => { printed.push(line) }
    try {
      const code = await runStatusCli(['--json', '--config', join(root, 'factory.json')], root, {
        gh: async () => JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ node_id: 'I_8', number: 8, title: 'b', labels: [{ name: 'working' }], assignees: [{ login: 'mk' }], updated_at: '2026-09-03T10:00:00Z' }] }),
        worktrees: async () => [],
        logs: async () => [],
        readLock: async () => ({ held: false, pid: null }),
      })
      expect(code).toBe(0)
    } finally { console.log = log }
    const out = JSON.parse(printed.join('\n'))
    expect(out.command).toBe('status')
    expect(out.dispatcher.running).toBe(false)
    expect(out.repos[0].board.working).toBe(1)
    expect(out.repos[0].dispatch).toBe('local')
  })

  test('a config that cannot be read is exit 2, never an invented empty board', async () => {
    const code = await runStatusCli(['--config', '/nowhere/factory.json'], '/home/mk', {
      gh: async () => '{}', worktrees: async () => [], logs: async () => [], readLock: async () => ({ held: false, pid: null }),
    })
    expect(code).toBe(2)
  })
})

test('status renders validated snapshot state, source and refusal without a fetch timestamp fallback', () => {
  const report = buildStatus({
    config: parseFactoryConfig({ repos: [{ path: '/repo', repo: 'acme/app', org: 'acme' }] }, '/home/test'),
    state: { lastTick: {} } as Parameters<typeof buildStatus>[0]['state'], lockPid: null,
    repos: [{ repo: 'acme/app', policy: parseRepoPolicy(''), board: [], worktrees: [], logs: [], snapshot: { state: 'stale', sourceCommit: 'a'.repeat(40), policyDigest: 'b'.repeat(64), validatedAt: '2026-09-06T00:00:00Z', ageSeconds: 7200, reason: 'mandatory policy stale: validated refresh required' } }],
  })
  expect(report.repos[0]?.snapshot?.ageSeconds).toBe(7200)
  expect(renderStatus(report)).toContain('policy: stale')
  expect(renderStatus(report)).toContain('a'.repeat(40))
})


test('141 status custom states are exclusive and snapshots carry stable raw-label identity', () => {
  const custom = { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }
  const report = buildStatus({ config, state: { lastTick: {}, handled: [] }, lockPid: null,
    repos: [{ repo: 'acme/app', policy: parseRepoPolicy('workflow-labels: ' + JSON.stringify(custom)), board: [
      { ...board[0]!, number: 1, nodeId: 'I_1', labels: ['Go'] },
      { ...board[0]!, number: 2, nodeId: 'I_2', labels: ['Go', 'Decision'] },
    ], boardComplete: true, observedAt: '2026-09-08T07:00:00Z', worktrees: [], logs: [] }] })
  expect(report.repos[0]!.board.ready).toBe(1)
  expect(report.repos[0]!.workflow?.issues.map(row => row.state)).toEqual(['ready', null])
  expect(report.repos[0]!.workflow?.issues[1]!.blocks.join()).toContain('conflicting')
  expect(report.repos[0]!.workflow?.issues[0]!.labelsDigest).toMatch(/^[a-f0-9]{64}$/)
})

test('141 status refuses missing and truncated search completeness instead of claiming an empty complete board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vsk-status-incomplete-'))
  mkdirSync(join(root, '.vegastack'))
  writeFileSync(join(root, '.vegastack/dev.md'), 'operators: mk\n')
  writeFileSync(join(root, 'factory.json'), JSON.stringify({ repos: [{ path: root, repo: 'acme/app', org: 'acme' }] }))
  const log = console.log
  const printed: string[] = []
  console.log = (line: string) => { printed.push(line) }
  try {
    for (const response of [{ items: [] }, { total_count: 101, incomplete_results: false, items: [] }, { total_count: 0, incomplete_results: true, items: [] }]) {
      await runStatusCli(['--json', '--config', join(root, 'factory.json')], root, { gh: async () => JSON.stringify(response), worktrees: async () => [], logs: async () => [] })
      const report = JSON.parse(printed.at(-1)!)
      expect(report.repos[0].workflow.complete).toBe(false)
      expect(report.repos[0].workflow.blocks.join()).toContain('incomplete')
    }
  } finally { console.log = log }
})

test('138 CLI group-recovery status survives the dashboard bridge and reaches operator attention',async()=>{
  const statusBridge=await import(new URL('../../dashboard/src/lib/live/status.ts',import.meta.url).href),dispatcherView=await import(new URL('../../dashboard/src/lib/views/dispatcher.ts',import.meta.url).href)
  const head='a'.repeat(40),taskKey='b'.repeat(64)
  const source={dispatcher:{running:false,pid:null,lastTick:null,interval:120},repos:[{repo:'acme/app',dispatch:'local',board:{needsPlan:0,ready:0,working:1,forOperator:0},worktrees:[],runs:[],shared:{head,refusal:null,history:{coverage:'complete',archiveCoverage:'partial',sourceCommit:head},tasks:[{taskKey,repo:'acme/app',issue:144,state:'recovery-queued',machineId:'receiver',generation:2,sourceCommit:head,originMachineId:'original',lastTransitionObservedAt:'2026-09-11T00:00:00Z',checkpoint:null,history:{coverage:'complete',events:[{kind:'group-succession',generation:2,machineId:'receiver',previousMachineId:'original',sourceCommit:head,observedAt:'2026-09-11T00:00:00Z'}]}}]},recovery:[{taskKey,issue:144,state:'recovery-queued',action:'wait',reason:'parent must start before this recovered child'}]}]}
  const bridged=statusBridge.parseStatusReport(source)!;expect(bridged.repos[0]?.shared?.tasks[0]?.state).toBe('recovery-queued');expect(bridged.repos[0]?.shared?.tasks[0]?.history?.events[0]?.kind).toBe('group-succession');expect(bridged.repos[0]?.recovery).toEqual(source.repos[0]!.recovery)
  const view=dispatcherView.buildDispatcherView({context:{freshness:{syncedAt:'2026-09-11T00:00:00Z'}} as never,status:{ok:true,data:bridged},now:Date.parse('2026-09-11T00:01:00Z')})
  expect(view.reasons).toEqual(['acme/app #144: recovery wait · parent must start before this recovered child'])
})

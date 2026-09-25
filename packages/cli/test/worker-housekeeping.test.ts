import { describe, expect, test } from 'bun:test'
import {
  housekeepingPreviewArgs, parseHousekeepingDocument, parseHousekeepingRequest, runWorkerHousekeeping,
  type HousekeepingBoard, type HousekeepingRequest,
} from '../src/worker-housekeeping.ts'

const NOW = 1_800_000_000_000
const board = (repo = 'o/r', root = '/machine/worker/repos/o__r/repo', excludeIssues: number[] = []): HousekeepingBoard => ({ repo, root, excludeIssues })
const request = (boards: HousekeepingBoard[] = [board()]): HousekeepingRequest => ({ schema: 1, deadlineAt: NOW + 10_000, boards })
const deps = (preview: NonNullable<Parameters<typeof runWorkerHousekeeping>[1]['preview']>) => ({
  now: () => NOW,
  tokenFor: async () => 'app-token',
  envForToken: (token: string) => ({ GH_TOKEN: token }),
  preview,
})

describe('worker housekeeping request and preview boundary', () => {
  test('strict input rejects write authority, stale deadlines, and oversized payloads', () => {
    expect(() => parseHousekeepingRequest(JSON.stringify({ ...request(), write: true }), NOW)).toThrow('invalid schema')
    expect(() => parseHousekeepingRequest(JSON.stringify({ ...request(), deadlineAt: NOW }), NOW)).toThrow('invalid schema')
    expect(() => parseHousekeepingRequest(' '.repeat(65_537), NOW)).toThrow('too large')
    expect(() => parseHousekeepingRequest(JSON.stringify(request([board('o/r', '/machine/worker/repos/o__r/repo', [0])])), NOW)).toThrow('invalid housekeeping board')
  })

  test('case-variant duplicate boards share one canonical row and union exclusions', () => {
    const parsed = parseHousekeepingRequest(JSON.stringify(request([
      board('O/R', '/machine/worker/repos/o__r/repo', [7]),
      board('o/r', '/machine/worker/repos/o__r/repo', [8, 7]),
    ])), NOW)
    expect(parsed.boards).toEqual([board('o/r', '/machine/worker/repos/o__r/repo', [7, 8])])
    expect(() => parseHousekeepingRequest(JSON.stringify(request([
      board('O/R'), board('o/r', '/other/worker/repos/o__r/repo'),
    ])), NOW)).toThrow('two roots')
  })

  test('the internal invocation contains only a dry preview and the pass exclusions', () => {
    const args = housekeepingPreviewArgs(board('o/r', '/machine/worker/repos/o__r/repo', [7, 8]), '/preview.mjs')
    expect(args).toEqual(['/preview.mjs', 'prune', '--dry-run', '--worker-layout', '--repo-root', '/machine/worker/repos/o__r/repo', '--repo', 'o/r', '--exclude-issues', '7,8', '--json'])
    expect(args).not.toContain('--write')
  })

  test('only canonical, removable, unexcluded issues become bounded advice', async () => {
    const calls: string[] = []
    const result = await runWorkerHousekeeping(request([board('o/r', '/machine/worker/repos/o__r/repo', [7, 8])]), deps(async (_selected, env) => {
      calls.push(env.GH_TOKEN ?? '')
      return { blocks: [], warns: [], candidates: [
        { name: '7', removable: true, reasonCode: 'merged', ageDays: 2 },
        { name: '8', removable: true, reasonCode: 'closed', ageDays: 3 },
        { name: '9-old', removable: true, reasonCode: 'idle', ageDays: 30 },
        { name: '10', removable: false, reasonCode: 'closed', ageDays: 31 },
        { name: '11', removable: true, reasonCode: 'idle', ageDays: 32 },
        { name: '11', removable: true, reasonCode: 'idle', ageDays: 32 },
      ] }
    }))
    expect(calls).toEqual(['app-token'])
    expect(result).toEqual({ schema: 1, complete: true, advisories: [{ repo: 'o/r', issue: 11, worktree: '11', reason: 'idle', ageDays: 32 }], unavailable: [] })
  })

  test('one unavailable board does not suppress a healthy sibling, and output stays one document', async () => {
    const other = board('o/b', '/machine/worker/repos/o__b/repo')
    const result = await runWorkerHousekeeping(request([board(), other]), deps(async selected => {
      if (selected.repo === 'o/r') throw new Error('preview timed out')
      return { blocks: [], warns: [], candidates: [{ name: '4', removable: true, reasonCode: 'merged', ageDays: 1 }] }
    }))
    expect(result.complete).toBe(false)
    expect(result.unavailable).toEqual([{ repo: 'o/r', reason: 'preview timed out' }])
    expect(result.advisories).toEqual([{ repo: 'o/b', issue: 4, worktree: '4', reason: 'merged', ageDays: 1 }])
    expect(parseHousekeepingDocument(JSON.stringify(result))).toEqual(result)
    expect(() => parseHousekeepingDocument(`${JSON.stringify(result)}\n${JSON.stringify(result)}`)).toThrow('not one JSON document')
  })

  test('advisories cap at fifty and incomplete facts are labelled', async () => {
    const many = Array.from({ length: 52 }, (_, index) => ({ name: String(index + 1), removable: true, reasonCode: 'merged', ageDays: 1 }))
    const result = await runWorkerHousekeeping(request(), deps(async () => ({ blocks: [], warns: ['github facts unavailable'], candidates: many })))
    expect(result.advisories).toHaveLength(50)
    expect(result.complete).toBe(false)
    expect(result.unavailable).toEqual([
      { repo: 'o/r', reason: 'github facts unavailable' },
      { repo: 'o/r', reason: 'advisory limit reached' },
    ])
  })
})

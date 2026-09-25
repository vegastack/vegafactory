import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directorySize, reconcileWorktrees } from '../scripts/worktree.mjs'

describe('directorySize', () => {
  test('sums file bytes, skips symlinks, and flags a truncated walk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-size-'))
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100))
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested/b.txt'), 'y'.repeat(50))
    symlinkSync(join(dir, 'a.txt'), join(dir, 'link.txt'))
    expect(directorySize(dir)).toEqual({ bytes: 150, approx: false })
    expect(directorySize(dir, { maxEntries: 1 }).approx).toBe(true)
  })
})

describe('reconcileWorktrees', () => {
  test('splits worktrees and open issues into matched, unmatched and orphans', () => {
    const entries = [
      { name: '106', path: '/r/.vegastack/.worktrees/106', branch: 'feat/106-x', state: 'parked', bytes: 1, approx: false },
      { name: '108-direct', path: '/r/.vegastack/.worktrees/108-direct', branch: 'fix/108-direct', state: 'parked', bytes: 1, approx: false },
      { name: '999-gone', path: '/r/.vegastack/.worktrees/999-gone', branch: null, state: 'orphan-dir', bytes: 1, approx: false },
      { name: 'release-0-19-0', path: '/r/.vegastack/.worktrees/release-0-19-0', branch: 'chore/release-0-19-0', state: 'parked', bytes: 1, approx: false },
    ]
    const r = reconcileWorktrees({ entries, openIssues: [{ number: 106, state: 'open' }, { number: 107, state: 'open' }] })
    expect(r.matched).toEqual([{ name: '106', issue: 106 }])
    expect(r.orphans).toEqual(['999-gone'])
    expect(r.worktreesWithoutOpenIssue).toEqual(['108-direct', '999-gone', 'release-0-19-0'])
    expect(r.openIssuesWithoutWorktree).toEqual([107])
  })
})

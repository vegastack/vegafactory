import { describe, expect, test } from 'bun:test'
import { branchName, classifyWorktree, parseWorktreeList, slugify, titleParts, worktreeName, worktreePath } from '../scripts/worktree.mjs'

const base = { dirExists: true, branchExists: true, locked: false, issueState: 'open' as const, mergedIntoDefault: false }

describe('naming', () => {
  test('slug is lowercase, dash-joined and capped', () => {
    expect(slugify('One feature, ONE worktree!')).toBe('one-feature-one-worktree')
    expect(slugify('x'.repeat(80)).length).toBe(40)
  })
  test('an issue number leads the directory and the branch', () => {
    expect(worktreeName(106, 'one-worktree')).toBe('106-one-worktree')
    expect(worktreePath('/r', worktreeName(106, 'one-worktree'))).toBe('/r/.vegastack/.worktrees/106-one-worktree')
    expect(branchName('feat', 106, 'one-worktree')).toBe('feat/106-one-worktree')
    expect(branchName('chore', null, 'release-0-19-0')).toBe('chore/release-0-19-0')
    expect(worktreeName(null, 'release-0-19-0')).toBe('release-0-19-0')
  })
})

describe('titleParts', () => {
  test('a known prefix is the type', () => {
    expect(titleParts('fix: the guard drops a flag')).toEqual({ type: 'fix', slug: 'the-guard-drops-a-flag' })
  })
  test('an unknown prefix is not a type, and is not slug either', () => {
    expect(titleParts('research: P12 — prove the lean factory works'))
      .toEqual({ type: null, slug: 'p12-prove-the-lean-factory-works' })
  })
  test('a title with no colon is untouched', () => {
    expect(titleParts('prove the lean factory works')).toEqual({ type: null, slug: 'prove-the-lean-factory-works' })
  })
  test('a colon inside the sentence is not a prefix', () => {
    expect(titleParts('feat: one thing: and another')).toEqual({ type: 'feat', slug: 'one-thing-and-another' })
  })
  test('the project\'s own list decides, not a frozen one', () => {
    const devMd = 'branch: <type>/<slug>   # type: feat | spike — the only place this list lives'
    expect(titleParts('spike: try the thing', devMd)).toEqual({ type: 'spike', slug: 'try-the-thing' })
    expect(titleParts('chore: tidy up', devMd)).toEqual({ type: null, slug: 'tidy-up' })
  })
})

describe('parseWorktreeList', () => {
  test('reads path, branch, lock and detached HEAD from porcelain', () => {
    const out = [
      'worktree /r', 'HEAD aaaa111', 'branch refs/heads/main', '',
      'worktree /r/.vegastack/.worktrees/106-x', 'HEAD bbbb222', 'branch refs/heads/feat/106-x', 'locked', '',
      'worktree /r/.vegastack/.worktrees/gone', 'HEAD cccc333', 'detached', 'prunable gitdir file points to non-existent location', '',
    ].join('\n')
    const entries = parseWorktreeList(out)
    expect(entries.map((e) => e.branch)).toEqual(['main', 'feat/106-x', null])
    expect(entries[1].locked).toBe(true)
    expect(entries[2].prunable).toBe(true)
    expect(entries[2].detached).toBe(true)
  })
})

describe('classifyWorktree', () => {
  test('each lifecycle state, in precedence order', () => {
    expect(classifyWorktree({ ...base, branchExists: false })).toBe('orphan-dir')
    expect(classifyWorktree({ ...base, dirExists: false })).toBe('branch-only')
    expect(classifyWorktree({ ...base, locked: true, mergedIntoDefault: true })).toBe('active')
    expect(classifyWorktree({ ...base, mergedIntoDefault: true, issueState: 'closed' })).toBe('merged')
    expect(classifyWorktree({ ...base, issueState: 'closed' })).toBe('abandoned')
    expect(classifyWorktree(base)).toBe('parked')
  })
})

import { evaluateRemoval, isPastRetention, parseBranchTypes, parseDuration, parseIncludeKnob, parseRetentionKnob } from '../scripts/worktree.mjs'

const devMd = [
  'commands: test `bun test` · check `bun run check` · build `bun run build` · setup `bun install --frozen-lockfile`',
  'worktree-include: .env .dev.vars',
  'worktree-retention: 7d',
].join('\n')
const clean = { state: 'merged', dirty: false, unpushed: false, remoteMissing: false, mergedIntoDefault: true, locked: false, force: false }

describe('evaluateRemoval', () => {
  test('a clean merged worktree is removable', () => {
    expect(evaluateRemoval(clean)).toEqual({ blocks: [], warns: [] })
  })
  test('each failure reason blocks on its own and names itself', () => {
    expect(evaluateRemoval({ ...clean, dirty: true }).blocks[0]).toContain('uncommitted changes')
    expect(evaluateRemoval({ ...clean, unpushed: true }).blocks[0]).toContain('commits not on the remote')
    expect(evaluateRemoval({ ...clean, remoteMissing: true, mergedIntoDefault: false }).blocks[0]).toContain('commits not on the remote')
    // #130: a squash-merged branch whose remote was deleted on merge is safe to remove.
    expect(evaluateRemoval({ ...clean, remoteMissing: true }).blocks).toEqual([])
    expect(evaluateRemoval({ ...clean, mergedIntoDefault: false }).blocks[0]).toContain('not merged into')
    expect(evaluateRemoval({ ...clean, locked: true }).blocks[0]).toContain('locked')
  })
  test('--force lifts only the not-merged block', () => {
    expect(evaluateRemoval({ ...clean, mergedIntoDefault: false, force: true }).blocks).toEqual([])
    expect(evaluateRemoval({ ...clean, dirty: true, force: true }).blocks.length).toBe(1)
    expect(evaluateRemoval({ ...clean, unpushed: true, force: true }).blocks.length).toBe(1)
    expect(evaluateRemoval({ ...clean, locked: true, force: true }).blocks.length).toBe(1)
  })
})

describe('knobs and retention', () => {
  test('durations and the retention knob', () => {
    expect(parseDuration('14d')).toBe(14 * 86_400_000)
    expect(parseDuration('48h')).toBe(48 * 3_600_000)
    expect(parseDuration('soon')).toBeNull()
    expect(parseRetentionKnob(devMd)).toBe(7 * 86_400_000)
    expect(parseRetentionKnob('repo: o/r')).toBe(14 * 86_400_000)
  })
  test('the branch: knob is the one home for the type list', () => {
    expect(parseBranchTypes('branch: <type>/<slug>   # type: feat | fix | spike — the only place this list lives'))
      .toEqual(['feat', 'fix', 'spike'])
  })
  test('an unreadable dev.md keeps the five defaults', () => {
    expect(parseBranchTypes(null)).toEqual(['feat', 'fix', 'docs', 'chore', 'refactor'])
    expect(parseBranchTypes('branch: <type>/<slug>')).toEqual(['feat', 'fix', 'docs', 'chore', 'refactor'])
  })
  test('include list and setup command come off dev.md', () => {
    expect(parseIncludeKnob(devMd)).toEqual(['.env', '.dev.vars'])
    expect(parseIncludeKnob('worktree-include: none   # nothing to copy')).toEqual([])
  })
  test('retention is measured from the later of last commit and last ledger edit', () => {
    const now = Date.parse('2026-09-20T00:00:00Z')
    const retentionMs = 14 * 86_400_000
    const old = '2026-09-01T00:00:00Z'
    const fresh = '2026-09-18T00:00:00Z'
    expect(isPastRetention({ lastCommitAt: old, ledgerUpdatedAt: old, now, retentionMs })).toBe(true)
    expect(isPastRetention({ lastCommitAt: old, ledgerUpdatedAt: fresh, now, retentionMs })).toBe(false)
    expect(isPastRetention({ lastCommitAt: fresh, ledgerUpdatedAt: old, now, retentionMs })).toBe(false)
    expect(isPastRetention({ lastCommitAt: null, ledgerUpdatedAt: null, now, retentionMs })).toBe(false)
  })
})


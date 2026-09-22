import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, pruneWorktrees, removeWorktree } from '../scripts/worktree.mjs'

// Relative to the real clock: the fixture commits carry today's date, so a fixed
// 'now' turns these into time bombs once the calendar catches up.
const FUTURE_NOW = Date.now() + 30 * 86_400_000
const OLD_LEDGER = new Date(Date.now() - 30 * 86_400_000).toISOString()

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const devMd = 'commands: check `true`\nworktree-include: none\nworktree-retention: 14d\n'

function bareRemote() {
  const remote = mkdtempSync(join(tmpdir(), 'vf-remote-'))
  git(remote, 'init', '--bare', '-b', 'main')
  return remote
}

function repoWithRemote(remote = bareRemote()) {
  const root = mkdtempSync(join(tmpdir(), 'vf-root-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'a@b.c')
  git(root, 'config', 'user.name', 'a')
  writeFileSync(join(root, 'README.md'), '# r\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'init')
  git(root, 'remote', 'add', 'origin', remote)
  git(root, 'push', '-u', 'origin', 'main')
  return root
}

// A second clone stands in for GitHub: the merge lands there and reaches the
// remote, and the first checkout's origin/main is stale until it fetches.
function cloneOf(remote: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vf-clone-'))
  git(dir, 'clone', '-q', remote, '.')
  git(dir, 'config', 'user.email', 'a@b.c')
  git(dir, 'config', 'user.name', 'a')
  return dir
}

// A worktree for #106 carrying two pushed commits, so a merge has something to rewrite.
function pushedFeature(root: string) {
  const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
  writeFileSync(join(wt.path, 'one.txt'), 'one\n')
  git(wt.path, 'add', '.')
  git(wt.path, 'commit', '-qm', 'one')
  writeFileSync(join(wt.path, 'two.txt'), 'two\n')
  git(wt.path, 'add', '.')
  git(wt.path, 'commit', '-qm', 'two')
  git(wt.path, 'push', '-q', '-u', 'origin', 'feat/106-x')
  return wt
}

describe('removeWorktree', () => {
  test('dry run is the default and removes nothing', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(root, 'push', '-u', 'origin', 'feat/106-x')
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: true, push: false, write: false })
    expect(r.blocks).toEqual([])
    expect(existsSync(wt.path)).toBe(true)
  })
  test('uncommitted work blocks even with --force', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: true, push: false, write: true })
    expect(r.blocks.some((b: string) => b.includes('uncommitted changes'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })
  test('an unpushed branch blocks, and passes once pushed', () => {
    const root = repoWithRemote()
    createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    const before = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: true, push: false, write: true })
    expect(before.blocks.some((b: string) => b.includes('commits not on the remote'))).toBe(true)
    const after = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: true, push: true, write: true })
    expect(after.blocks).toEqual([])
    expect(existsSync(join(root, '.vegastack/.worktrees/106'))).toBe(false)
    expect(git(root, 'branch', '--list', 'feat/106-x').trim()).toContain('feat/106-x')
  })
  test('a pushed branch with commits nobody merged blocks without --force', () => {
    const root = repoWithRemote()
    const wt = pushedFeature(root)
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: false, push: false, write: true })
    expect(r.blocks.some((b: string) => b.includes('not merged into the default branch'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })
  test('a merge-commit merge that landed only on the remote is seen: remove fetches before it judges', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    git(other, 'merge', '-q', '--no-ff', '-m', 'merge', 'origin/feat/106-x')
    git(other, 'push', '-q', 'origin', 'main')
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: false, push: false, write: true })
    expect(r.blocks).toEqual([])
    expect(r.state).toBe('merged')
    expect(existsSync(wt.path)).toBe(false)
    expect(git(root, 'branch', '--list', 'feat/106-x').trim()).toContain('feat/106-x')
  })
  test('a squash merge counts as merged — the whole diff is already on the default branch', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    writeFileSync(join(other, 'moved.txt'), 'main moved on\n')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'main moved')
    git(other, 'merge', '-q', '--squash', 'origin/feat/106-x')
    git(other, 'commit', '-qm', 'feat: x (#106)')
    git(other, 'push', '-q', 'origin', 'main')
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: false, push: false, write: true })
    expect(r.blocks).toEqual([])
    expect(r.state).toBe('merged')
    expect(existsSync(wt.path)).toBe(false)
  })
  test('#130: a squash-merged branch whose remote branch was deleted is still removable', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    git(other, 'merge', '-q', '--squash', 'origin/feat/106-x')
    git(other, 'commit', '-qm', 'feat: x (#106)')
    git(other, 'push', '-q', 'origin', 'main')
    git(other, 'push', '-q', 'origin', '--delete', 'feat/106-x')
    git(root, 'fetch', '-q', '--prune', 'origin')
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: false, push: false, write: true })
    expect(r.blocks).toEqual([])
    expect(r.state).toBe('merged')
    expect(existsSync(wt.path)).toBe(false)
  })
  test('a rebase merge counts as merged — every commit is already on the default branch by patch', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    writeFileSync(join(other, 'moved.txt'), 'main moved on\n')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'main moved')
    git(other, 'switch', '-qc', 'rb', 'origin/feat/106-x')
    git(other, 'rebase', '-q', 'main')
    git(other, 'switch', '-q', 'main')
    git(other, 'merge', '-q', '--ff-only', 'rb')
    git(other, 'push', '-q', 'origin', 'main')
    expect(() => git(root, 'merge-base', '--is-ancestor', 'feat/106-x', 'origin/main')).toThrow()
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: false, push: false, write: true })
    expect(r.blocks).toEqual([])
    expect(r.state).toBe('merged')
    expect(existsSync(wt.path)).toBe(false)
  })
  test('a branch that only shares some commits with the default branch stays unmerged', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    git(other, 'cherry-pick', 'origin/feat/106-x~1')
    git(other, 'push', '-q', 'origin', 'main')
    const r = removeWorktree({ repoRoot: root, name: '106', base: 'main', force: false, push: false, write: true })
    expect(r.blocks.some((b: string) => b.includes('not merged into the default branch'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })
})

describe('pruneWorktrees', () => {
  test('names a parked worktree past retention and refuses one with unpushed commits', () => {
    const root = repoWithRemote()
    createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    const now = FUTURE_NOW
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106': OLD_LEDGER }, now, write: false,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '106')
    expect(candidate?.state).toBe('parked')
    expect(candidate?.ageDays).toBeGreaterThanOrEqual(14)
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('commits not on the remote')
  })

  test('--write keeps a never-pushed branch and does not create it remotely', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    const now = FUTURE_NOW
    const dry = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106': OLD_LEDGER }, now, write: false,
    })
    expect(dry.candidates.find((c: { name: string }) => c.name === '106')?.pushable).toBe(false)
    expect(existsSync(wt.path)).toBe(true)

    const wet = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106': OLD_LEDGER }, now, write: true,
    })
    expect(wet.candidates.find((c: { name: string }) => c.name === '106')?.removable).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
    expect(git(root, 'ls-remote', '--heads', 'origin', 'feat/106-old').trim()).toBe('')
    expect(git(root, 'branch', '--list', 'feat/106-old').trim()).toContain('feat/106-old')
  })

  test('a parked worktree with pushed, unmerged commits is removed past retention and its branch survives', () => {
    const root = repoWithRemote()
    const wt = pushedFeature(root)
    const now = FUTURE_NOW
    const dry = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106': OLD_LEDGER }, now, write: false,
    })
    const candidate = dry.candidates.find((c: { name: string }) => c.name === '106')
    expect(candidate?.state).toBe('parked')
    expect(candidate?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    const wet = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106': OLD_LEDGER }, now, write: true,
    })
    expect(wet.candidates.find((c: { name: string }) => c.name === '106')?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    expect(git(root, 'branch', '--list', 'feat/106-x').trim()).toContain('feat/106-x')
    expect(git(root, 'rev-parse', '--verify', 'refs/remotes/origin/feat/106-x').trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  test('uncommitted work in an idle worktree is committed as wip on its own branch and pushed before removal', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 107, slug: 'dirty', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(wt.path, 'push', '-q', '-u', 'origin', 'feat/107-dirty')
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '107': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '107')
    expect(candidate?.rescuedTo).toBe('feat/107-dirty')
    expect(candidate?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    const saved = spawnSync('git', ['show', 'origin/feat/107-dirty:scratch.txt'], { cwd: root, encoding: 'utf8' })
    expect(saved.stdout).toBe('wip\n')
    expect(git(root, 'log', '-1', '--format=%s', 'origin/feat/107-dirty').trim()).toBe('wip: rescued uncommitted work from 107')
    expect(git(root, 'ls-remote', '--heads', 'origin').includes('rescue/')).toBe(false)
  })

  test('a rescue whose push is rejected keeps the commit local and the worktree', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 109, slug: 'moved', type: 'feat', base: 'main', devMd, home: root, write: true })
    // The remote branch moved on without this worktree.
    spawnSync('git', ['push', '-q', 'origin', 'main:refs/heads/feat/109-moved'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'elsewhere'], { cwd: root })
    spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feat/109-moved'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'mine'], { cwd: wt.path })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '109': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '109')
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('push was rejected')
    expect(existsSync(wt.path)).toBe(true)
    expect(git(wt.path, 'log', '-1', '--format=%s').trim()).toBe('wip: rescued uncommitted work from 109')
  })

  test('a rescue never commits a staged secret', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 110, slug: 'secret', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(wt.path, 'push', '-q', '-u', 'origin', 'feat/110-secret')
    writeFileSync(join(wt.path, '.env'), 'TOKEN=1\n')
    writeFileSync(join(wt.path, 'notes.txt'), `${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`)
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '110': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '110')
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('.env')
    expect(candidate?.reason).toContain('notes.txt')
    expect(existsSync(wt.path)).toBe(true)
    expect(git(wt.path, 'status', '--porcelain')).toContain('.env')
    expect(git(wt.path, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  test('a locked worktree with uncommitted work is left alone', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 108, slug: 'held', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    spawnSync('git', ['worktree', 'lock', wt.path], { cwd: root })
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '108': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(r.candidates.find((c: { name: string }) => c.name === '108')?.reasons.join(' ')).toContain('locked')
    expect(existsSync(wt.path)).toBe(true)
  })

  test('closed and merged worktrees are candidates immediately', () => {
    const closedRoot = repoWithRemote()
    const closed = pushedFeature(closedRoot)
    const closedResult = pruneWorktrees({
      repoRoot: closedRoot, base: 'main', devMd, issueStates: { '106': 'closed' }, now: Date.now(), write: false,
    })
    expect(closedResult.candidates.find((c: { name: string }) => c.name === '106')?.reasonCode).toBe('closed')
    expect(existsSync(closed.path)).toBe(true)

    const remote = bareRemote()
    const mergedRoot = repoWithRemote(remote)
    const merged = pushedFeature(mergedRoot)
    const other = cloneOf(remote)
    git(other, 'merge', '-q', '--no-ff', '-m', 'merge', 'origin/feat/106-x')
    git(other, 'push', '-q', 'origin', 'main')
    const mergedResult = pruneWorktrees({ repoRoot: mergedRoot, base: 'main', devMd, now: Date.now(), write: false })
    expect(mergedResult.candidates.find((c: { name: string }) => c.name === '106')?.reasonCode).toBe('merged')
    expect(existsSync(merged.path)).toBe(true)
  })

  test('a remote branch deleted after merge is never recreated by prune', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    git(other, 'merge', '-q', '--squash', 'origin/feat/106-x')
    git(other, 'commit', '-qm', 'feat: x (#106)')
    git(other, 'push', '-q', 'origin', 'main')
    git(other, 'push', '-q', 'origin', '--delete', 'feat/106-x')
    git(root, 'fetch', '-q', '--prune', 'origin')
    const result = pruneWorktrees({ repoRoot: root, base: 'main', devMd, now: Date.now(), write: true })
    expect(result.candidates.find((c: { name: string }) => c.name === '106')?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    expect(git(root, 'ls-remote', '--heads', 'origin', 'feat/106-x').trim()).toBe('')
  })

  test('a staged selection is preserved byte-for-byte and blocks rescue', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 111, slug: 'staged', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(wt.path, 'push', '-q', '-u', 'origin', 'feat/111-staged')
    writeFileSync(join(wt.path, 'kept.txt'), 'staged\n')
    git(wt.path, 'add', 'kept.txt')
    writeFileSync(join(wt.path, 'other.txt'), 'unstaged\n')
    const indexBefore = git(wt.path, 'diff', '--cached', '--binary')
    const result = pruneWorktrees({ repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '111': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    const candidate = result.candidates.find((c: { name: string }) => c.name === '111')
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('staged selection')
    expect(git(wt.path, 'diff', '--cached', '--binary')).toBe(indexBefore)
    expect(existsSync(wt.path)).toBe(true)
  })

  test('failed add and failed commit restore the original empty staged selection', () => {
    const addRoot = repoWithRemote()
    const addWt = createWorktree({ repoRoot: addRoot, issue: 115, slug: 'add-fails', type: 'feat', base: 'main', devMd, home: addRoot, write: true })
    git(addWt.path, 'push', '-q', '-u', 'origin', 'feat/115-add-fails')
    writeFileSync(join(addWt.path, 'dirty.txt'), 'dirty\n')
    const indexPath = git(addWt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    writeFileSync(`${indexPath}.lock`, 'held\n')
    const addResult = pruneWorktrees({ repoRoot: addRoot, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '115': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    expect(addResult.candidates.find((c: { name: string }) => c.name === '115')?.reason).toContain('git add failed')
    expect(git(addWt.path, 'diff', '--cached', '--name-only').trim()).toBe('')

    const commitRoot = repoWithRemote()
    const commitWt = createWorktree({ repoRoot: commitRoot, issue: 116, slug: 'commit-fails', type: 'feat', base: 'main', devMd, home: commitRoot, write: true })
    git(commitWt.path, 'push', '-q', '-u', 'origin', 'feat/116-commit-fails')
    writeFileSync(join(commitWt.path, 'dirty.txt'), 'dirty\n')
    const hook = join(commitRoot, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    const commitResult = pruneWorktrees({ repoRoot: commitRoot, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '116': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    expect(commitResult.candidates.find((c: { name: string }) => c.name === '116')?.reason).toContain('git commit failed')
    expect(git(commitWt.path, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  test('detached worktrees require a clean HEAD reachable from another ref', () => {
    const root = repoWithRemote()
    const clean = createWorktree({ repoRoot: root, issue: 112, slug: 'clean-detached', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(clean.path, 'switch', '--detach')
    const cleanResult = pruneWorktrees({ repoRoot: root, base: 'main', devMd, issueStates: { '112': 'closed' }, write: true })
    expect(cleanResult.candidates.find((c: { name: string }) => c.name === '112')?.removable).toBe(true)
    expect(existsSync(clean.path)).toBe(false)

    const dirty = createWorktree({ repoRoot: root, issue: 113, slug: 'dirty-detached', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(dirty.path, 'switch', '--detach')
    writeFileSync(join(dirty.path, 'dirty.txt'), 'dirty\n')
    const dirtyResult = pruneWorktrees({ repoRoot: root, base: 'main', devMd, issueStates: { '113': 'closed' }, write: true })
    expect(dirtyResult.candidates.find((c: { name: string }) => c.name === '113')?.reason).toContain('uncommitted')
    expect(existsSync(dirty.path)).toBe(true)

    const unique = createWorktree({ repoRoot: root, issue: 114, slug: 'unique-detached', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(unique.path, 'switch', '--detach')
    writeFileSync(join(unique.path, 'unique.txt'), 'unique\n')
    git(unique.path, 'add', 'unique.txt')
    git(unique.path, 'commit', '-qm', 'unique detached')
    const uniqueResult = pruneWorktrees({ repoRoot: root, base: 'main', devMd, issueStates: { '114': 'closed' }, write: true })
    expect(uniqueResult.candidates.find((c: { name: string }) => c.name === '114')?.reason).toContain('unique commit')
    expect(existsSync(unique.path)).toBe(true)
  })
})

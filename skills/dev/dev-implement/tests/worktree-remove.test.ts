import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, pruneWorktrees, readDroppedDeps, removeWorktree, trustedAncestorOwner, verifyOwnedPath } from '../scripts/worktree.mjs'

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
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
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
  test('a fast-forward merge counts as merged through ordinary ancestry', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    git(other, 'merge', '-q', '--ff-only', 'origin/feat/106-x')
    git(other, 'push', '-q', 'origin', 'main')
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

  test('full removal refuses a symlinked or other-UID-writable managed ancestor', () => {
    const linkedRoot = repoWithRemote()
    const linked = pushedFeature(linkedRoot)
    const parent = join(linkedRoot, '.vegastack')
    const managed = join(parent, '.worktrees')
    const externalParent = mkdtempSync(join(tmpdir(), 'vf-external-worktrees-'))
    const external = join(externalParent, 'redirected')
    renameSync(managed, external)
    symlinkSync(external, managed)
    const linkedResult = removeWorktree({ repoRoot: linkedRoot, name: '106', base: 'main', force: true, write: true })
    expect(linkedResult.blocks.join(' ')).toContain('symlink')
    expect(existsSync(join(external, '106'))).toBe(true)
    expect(existsSync(join(linked.path, 'one.txt'))).toBe(true)

    const writableRoot = repoWithRemote()
    const writable = pushedFeature(writableRoot)
    chmodSync(join(writableRoot, '.vegastack', '.worktrees'), 0o777)
    const writableResult = removeWorktree({ repoRoot: writableRoot, name: '106', base: 'main', force: true, write: true })
    expect(writableResult.blocks.join(' ')).toContain('other users can write')
    expect(existsSync(writable.path)).toBe(true)
  })
})

describe('dependency reclamation', () => {
  const depsDevMd = `${devMd}worktree-deps-retention: 3d\n`
  const DEPS_NOW = Date.now() + 4 * 86_400_000
  const DEPS_LEDGER = new Date(Date.now() - 4 * 86_400_000).toISOString()

  function pushedWithDeps(issue = 120) {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue, slug: 'deps', type: 'feat', base: 'main', devMd: depsDevMd, home: root, write: true })
    writeFileSync(join(wt.path, 'feature.txt'), 'feature\n')
    git(wt.path, 'add', 'feature.txt')
    git(wt.path, 'commit', '-qm', 'feature')
    git(wt.path, 'push', '-q', '-u', 'origin', `feat/${issue}-deps`)
    mkdirSync(join(wt.path, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(wt.path, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    return { root, wt }
  }

  test('preview changes no bytes; write records then removes only node_modules', () => {
    const { root, wt } = pushedWithDeps()
    const input = { repoRoot: root, base: 'main', devMd: depsDevMd, ledgerTimes: { '120': DEPS_LEDGER }, now: DEPS_NOW }
    const preview = pruneWorktrees({ ...input, write: false })
    expect(preview.droppable).toEqual(['120'])
    expect(existsSync(join(wt.path, 'node_modules/pkg/index.js'))).toBe(true)
    expect(readDroppedDeps({ repoRoot: root, workerLayout: false }).records.size).toBe(0)

    const written = pruneWorktrees({ ...input, write: true })
    expect(written.freed).toEqual(['120'])
    expect(existsSync(join(wt.path, 'node_modules'))).toBe(false)
    const marker = join(root, '.vegastack', '.tmp', 'deps-dropped', '120.json')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ schema: 1, name: '120', path: wt.path, deps: ['node_modules'] })
    expect(lstatSync(marker).mode & 0o777).toBe(0o600)
  })

  test('a marker publication failure leaves dependency bytes untouched', () => {
    const { root, wt } = pushedWithDeps(133)
    const result = pruneWorktrees({
      repoRoot: root, base: 'main', devMd: depsDevMd, ledgerTimes: { '133': DEPS_LEDGER }, now: DEPS_NOW, write: true,
      recordDroppedDeps: () => { throw new Error('simulated marker publication failure') },
    })
    expect(result.warns.join(' ')).toContain('simulated marker publication failure')
    expect(result.freed).toEqual([])
    expect(readFileSync(join(wt.path, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  })

  test('tracked, dirty, unpushed, and locked checkouts keep dependencies', () => {
    const tracked = pushedWithDeps(121)
    writeFileSync(join(tracked.wt.path, 'node_modules', 'tracked.js'), 'tracked\n')
    git(tracked.wt.path, 'add', '-f', 'node_modules/tracked.js')
    git(tracked.wt.path, 'commit', '-qm', 'track dependency')
    git(tracked.wt.path, 'push', '-q')
    const trackedResult = pruneWorktrees({ repoRoot: tracked.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '121': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(trackedResult.warns.join(' ')).toContain('git tracks')
    expect(existsSync(join(tracked.wt.path, 'node_modules/tracked.js'))).toBe(true)

    const dirty = pushedWithDeps(122)
    writeFileSync(join(dirty.wt.path, 'dirty.txt'), 'dirty\n')
    const dirtyResult = pruneWorktrees({ repoRoot: dirty.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '122': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(dirtyResult.warns.join(' ')).toContain('uncommitted')
    expect(existsSync(join(dirty.wt.path, 'node_modules'))).toBe(true)

    const unpushed = pushedWithDeps(123)
    writeFileSync(join(unpushed.wt.path, 'local.txt'), 'local\n')
    git(unpushed.wt.path, 'add', 'local.txt')
    git(unpushed.wt.path, 'commit', '-qm', 'local only')
    const unpushedResult = pruneWorktrees({ repoRoot: unpushed.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '123': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(unpushedResult.warns.join(' ')).toContain('commits not on the remote')
    expect(existsSync(join(unpushed.wt.path, 'node_modules'))).toBe(true)

    const locked = pushedWithDeps(124)
    git(locked.root, 'worktree', 'lock', locked.wt.path)
    const lockedResult = pruneWorktrees({ repoRoot: locked.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '124': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(lockedResult.warns.join(' ')).toContain('locked')
    expect(existsSync(join(locked.wt.path, 'node_modules'))).toBe(true)
  })

  test('malformed markers and unsafe ancestors leave external and dependency bytes untouched', () => {
    const malformed = pushedWithDeps(125)
    const markerRoot = join(malformed.root, '.vegastack', '.tmp', 'deps-dropped')
    mkdirSync(markerRoot, { recursive: true })
    chmodSync(markerRoot, 0o700)
    writeFileSync(join(markerRoot, '%ZZ.json'), '{}\n')
    const malformedResult = pruneWorktrees({ repoRoot: malformed.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '125': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(malformedResult.warns.join(' ')).toContain('unreadable')
    expect(existsSync(join(malformed.wt.path, 'node_modules'))).toBe(true)

    const linked = pushedWithDeps(126)
    const external = mkdtempSync(join(tmpdir(), 'vf-external-deps-'))
    writeFileSync(join(external, 'keep.txt'), 'keep\n')
    const ownDeps = join(linked.wt.path, 'node_modules')
    execFileSync('rm', ['-rf', ownDeps])
    symlinkSync(external, ownDeps)
    const linkedResult = pruneWorktrees({ repoRoot: linked.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '126': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(linkedResult.warns.join(' ')).toContain('symlink')
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('keep\n')

    const writable = pushedWithDeps(127)
    const tmp = join(writable.root, '.vegastack', '.tmp')
    mkdirSync(tmp, { recursive: true })
    chmodSync(tmp, 0o777)
    const writableResult = pruneWorktrees({ repoRoot: writable.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '127': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(writableResult.warns.join(' ')).toContain('other users can write')
    expect(existsSync(join(writable.wt.path, 'node_modules'))).toBe(true)
  })

  test('every managed ancestor rejects symlink substitution before deletion', () => {
    const relatives = [
      '.vegastack',
      '.vegastack/.tmp',
      '.vegastack/.tmp/deps-dropped',
      '.vegastack/.worktrees',
      '.vegastack/.worktrees/134',
      '.vegastack/.worktrees/134/node_modules',
    ]
    for (const relativePath of relatives) {
      const { root, wt } = pushedWithDeps(134)
      const target = join(root, relativePath)
      mkdirSync(target, { recursive: true })
      const external = mkdtempSync(join(tmpdir(), 'vf-ancestor-substitution-'))
      const moved = join(external, 'moved')
      renameSync(target, moved)
      symlinkSync(moved, target)

      const dependencySafety = verifyOwnedPath(root, join(wt.path, 'node_modules'), { allowMissingLeaf: true })
      const markerSafety = verifyOwnedPath(root, join(root, '.vegastack', '.tmp', 'deps-dropped'), { allowMissingLeaf: true })
      expect(dependencySafety.ok && markerSafety.ok).toBe(false)
      expect(existsSync(join(wt.path, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    }
  })

  test('a foreign-owned managed ancestor is refused where the platform can create one', () => {
    const currentUid = process.getuid?.()
    expect(trustedAncestorOwner((currentUid ?? 0) + 1, currentUid)).toBe(false)
    if (currentUid !== 0) return

    const { root, wt } = pushedWithDeps(140)
    const ancestor = join(root, '.vegastack', '.worktrees')
    chownSync(ancestor, 1, 1)
    try {
      expect(verifyOwnedPath(root, join(wt.path, 'node_modules')).reason).toContain('owned by uid 1')
      expect(existsSync(join(wt.path, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    } finally {
      chownSync(ancestor, 0, 0)
    }
  })

  test('traversal-shaped names and non-ISO timestamps make the marker set unreadable', () => {
    const traversal = pushedWithDeps(130)
    const traversalRoot = join(traversal.root, '.vegastack', '.tmp', 'deps-dropped')
    mkdirSync(traversalRoot, { recursive: true, mode: 0o700 })
    chmodSync(traversalRoot, 0o700)
    const badName = '260-../../outside'
    const badPath = join(traversalRoot, `${encodeURIComponent(badName)}.json`)
    writeFileSync(badPath, `${JSON.stringify({ schema: 1, name: badName, repoRoot: traversal.root, path: join(traversal.root, '.vegastack', 'outside'), deps: ['node_modules'], droppedAt: '2026-09-22T00:00:00.000Z' })}\n`, { mode: 0o600 })
    chmodSync(badPath, 0o600)
    const traversalResult = pruneWorktrees({ repoRoot: traversal.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '130': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(traversalResult.warns.join(' ')).toContain('unreadable')
    expect(existsSync(join(traversal.wt.path, 'node_modules'))).toBe(true)

    const dated = pushedWithDeps(131)
    const datedRoot = join(dated.root, '.vegastack', '.tmp', 'deps-dropped')
    mkdirSync(datedRoot, { recursive: true, mode: 0o700 })
    chmodSync(datedRoot, 0o700)
    const datedPath = join(datedRoot, '131.json')
    writeFileSync(datedPath, `${JSON.stringify({ schema: 1, name: '131', repoRoot: dated.root, path: dated.wt.path, deps: ['node_modules'], droppedAt: '1' })}\n`, { mode: 0o600 })
    chmodSync(datedPath, 0o600)
    const datedResult = pruneWorktrees({ repoRoot: dated.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '131': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(datedResult.warns.join(' ')).toContain('does not match')
    expect(existsSync(join(dated.wt.path, 'node_modules'))).toBe(true)

    const repeated = pushedWithDeps(132)
    const repeatedRoot = join(repeated.root, '.vegastack', '.tmp', 'deps-dropped')
    mkdirSync(repeatedRoot, { recursive: true, mode: 0o700 })
    chmodSync(repeatedRoot, 0o700)
    const repeatedName = '132-bad--slug'
    const repeatedPath = join(repeatedRoot, `${repeatedName}.json`)
    writeFileSync(repeatedPath, `${JSON.stringify({ schema: 1, name: repeatedName, repoRoot: repeated.root, path: join(repeated.root, '.vegastack', '.worktrees', repeatedName), deps: ['node_modules'], droppedAt: '2026-09-22T00:00:00.000Z' })}\n`, { mode: 0o600 })
    chmodSync(repeatedPath, 0o600)
    const repeatedResult = pruneWorktrees({ repoRoot: repeated.root, base: 'main', devMd: depsDevMd, ledgerTimes: { '132': DEPS_LEDGER }, now: DEPS_NOW, write: true })
    expect(repeatedResult.warns.join(' ')).toContain('unreadable name')
    expect(existsSync(join(repeated.wt.path, 'node_modules'))).toBe(true)
  })

  test('removing the checkout clears only its matching marker', () => {
    const { root, wt } = pushedWithDeps(128)
    const input = { repoRoot: root, base: 'main', devMd: depsDevMd, ledgerTimes: { '128': DEPS_LEDGER }, now: DEPS_NOW }
    pruneWorktrees({ ...input, write: true })
    const marker = join(root, '.vegastack', '.tmp', 'deps-dropped', '128.json')
    expect(existsSync(marker)).toBe(true)
    const removed = removeWorktree({ repoRoot: root, name: '128', base: 'main', force: true, write: true })
    expect(removed.blocks).toEqual([])
    expect(existsSync(wt.path)).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  test('a freshly recreated issue checkout clears a stale matching marker', () => {
    const { root, wt } = pushedWithDeps(129)
    const input = { repoRoot: root, base: 'main', devMd: depsDevMd, ledgerTimes: { '129': DEPS_LEDGER }, now: DEPS_NOW }
    pruneWorktrees({ ...input, write: true })
    const marker = join(root, '.vegastack', '.tmp', 'deps-dropped', '129.json')
    expect(existsSync(marker)).toBe(true)
    git(root, 'worktree', 'remove', '--force', wt.path)
    const fresh = createWorktree({ repoRoot: root, issue: 129, slug: 'fresh', type: 'feat', base: 'main', devMd: depsDevMd, home: root, write: true })
    expect(fresh.blocks).toEqual([])
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)
  })
})

describe('pruneWorktrees', () => {
  test('preview changes no refs, FETCH_HEAD, objects, or worktree bytes', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    writeFileSync(join(other, 'main-new.txt'), 'new remote main\n')
    git(other, 'add', 'main-new.txt')
    git(other, 'commit', '-qm', 'new remote main')
    git(other, 'push', '-q', 'origin', 'main')
    const refsBefore = git(root, 'show-ref')
    const objectsBefore = git(root, 'count-objects', '-v')
    const fetchHead = join(root, '.git', 'FETCH_HEAD')
    const fetchBefore = existsSync(fetchHead) ? readFileSync(fetchHead) : null
    const index = git(wt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    const indexBefore = readFileSync(index)
    const bytesBefore = readFileSync(join(wt.path, 'one.txt'))
    pruneWorktrees({ repoRoot: root, base: 'main', devMd, ledgerTimes: { '106': OLD_LEDGER }, now: FUTURE_NOW, write: false })
    expect(git(root, 'show-ref')).toBe(refsBefore)
    expect(git(root, 'count-objects', '-v')).toBe(objectsBefore)
    expect(existsSync(fetchHead) ? readFileSync(fetchHead) : null).toEqual(fetchBefore)
    expect(readFileSync(index)).toEqual(indexBefore)
    expect(readFileSync(join(wt.path, 'one.txt'))).toEqual(bytesBefore)
  })

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
    git(mergedRoot, 'fetch', '-q', 'origin', 'main')
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

  test('a stale tracking ref cannot recreate a deleted remote branch during rescue', () => {
    const remote = bareRemote()
    const root = repoWithRemote(remote)
    const wt = pushedFeature(root)
    const other = cloneOf(remote)
    git(other, 'merge', '-q', '--squash', 'origin/feat/106-x')
    git(other, 'commit', '-qm', 'feat: x (#106)')
    git(other, 'push', '-q', 'origin', 'main')
    git(other, 'push', '-q', 'origin', '--delete', 'feat/106-x')
    // Deliberately retain root's stale refs/remotes/origin/feat/106-x.
    writeFileSync(join(wt.path, 'after-merge.txt'), 'must stay local\n')
    const result = pruneWorktrees({ repoRoot: root, base: 'main', devMd, issueStates: { '106': 'closed' }, write: true })
    expect(result.candidates.find((c: { name: string }) => c.name === '106')?.removable).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
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

  test('staged deletion and intent-to-add are non-empty index selections and remain byte-identical', () => {
    const deletedRoot = repoWithRemote()
    const deleted = pushedFeature(deletedRoot)
    writeFileSync(join(deleted.path, 'delete-me.txt'), 'tracked\n')
    git(deleted.path, 'add', 'delete-me.txt')
    git(deleted.path, 'commit', '-qm', 'tracked deletion fixture')
    git(deleted.path, 'push', '-q')
    execFileSync('rm', [join(deleted.path, 'delete-me.txt')])
    git(deleted.path, 'add', '-u')
    const deletedIndex = git(deleted.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    const deletedBefore = readFileSync(deletedIndex)
    const deletedResult = pruneWorktrees({ repoRoot: deletedRoot, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '106': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    expect(deletedResult.candidates.find((c: { name: string }) => c.name === '106')?.reason).toContain('staged selection')
    expect(readFileSync(deletedIndex)).toEqual(deletedBefore)
    expect(existsSync(deleted.path)).toBe(true)

    const intentRoot = repoWithRemote()
    const intent = createWorktree({ repoRoot: intentRoot, issue: 117, slug: 'intent', type: 'feat', base: 'main', devMd, home: intentRoot, write: true })
    git(intent.path, 'push', '-q', '-u', 'origin', 'feat/117-intent')
    writeFileSync(join(intent.path, 'intent.txt'), 'intent\n')
    git(intent.path, 'add', '-N', 'intent.txt')
    const intentIndex = git(intent.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    const intentBefore = readFileSync(intentIndex)
    const intentResult = pruneWorktrees({ repoRoot: intentRoot, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '117': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    expect(intentResult.candidates.find((c: { name: string }) => c.name === '117')?.reason).toContain('staged selection')
    expect(readFileSync(intentIndex)).toEqual(intentBefore)
    expect(existsSync(intent.path)).toBe(true)
  })

  test('unknown issue or ledger facts disqualify idle and dependency reclamation', () => {
    const { root, wt } = (() => {
      const root = repoWithRemote()
      const wt = createWorktree({ repoRoot: root, issue: 118, slug: 'unknown', type: 'feat', base: 'main', devMd, home: root, write: true })
      writeFileSync(join(wt.path, 'feature.txt'), 'feature\n')
      git(wt.path, 'add', 'feature.txt')
      git(wt.path, 'commit', '-qm', 'feature')
      git(wt.path, 'push', '-q', '-u', 'origin', 'feat/118-unknown')
      mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
      writeFileSync(join(wt.path, 'node_modules', 'keep'), 'keep\n')
      return { root, wt }
    })()
    const result = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '1d', devMd: `${devMd}worktree-deps-retention: 1d\n`,
      ledgerTimes: {}, ledgerUnknown: new Set(['118']), issueUnknown: new Set(['118']), now: FUTURE_NOW, write: true,
    })
    expect(result.candidates).toEqual([])
    expect(result.freed).toEqual([])
    expect(existsSync(join(wt.path, 'node_modules', 'keep'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })

  test('failed add and failed commit restore the original empty staged selection', () => {
    const addRoot = repoWithRemote()
    const addWt = createWorktree({ repoRoot: addRoot, issue: 115, slug: 'add-fails', type: 'feat', base: 'main', devMd, home: addRoot, write: true })
    git(addWt.path, 'push', '-q', '-u', 'origin', 'feat/115-add-fails')
    writeFileSync(join(addWt.path, 'dirty.txt'), 'dirty\n')
    const indexPath = git(addWt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    const addIndexBefore = readFileSync(indexPath)
    writeFileSync(`${indexPath}.lock`, 'held\n')
    const addResult = pruneWorktrees({ repoRoot: addRoot, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '115': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    expect(addResult.candidates.find((c: { name: string }) => c.name === '115')?.reason).toContain('git add failed')
    expect(readFileSync(indexPath)).toEqual(addIndexBefore)

    const commitRoot = repoWithRemote()
    const commitWt = createWorktree({ repoRoot: commitRoot, issue: 116, slug: 'commit-fails', type: 'feat', base: 'main', devMd, home: commitRoot, write: true })
    git(commitWt.path, 'push', '-q', '-u', 'origin', 'feat/116-commit-fails')
    writeFileSync(join(commitWt.path, 'dirty.txt'), 'dirty\n')
    const commitIndex = git(commitWt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
    const commitIndexBefore = readFileSync(commitIndex)
    const hook = join(commitRoot, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    const commitResult = pruneWorktrees({ repoRoot: commitRoot, base: 'main', olderThan: '14d', devMd, ledgerTimes: { '116': OLD_LEDGER }, now: FUTURE_NOW, write: true })
    expect(commitResult.candidates.find((c: { name: string }) => c.name === '116')?.reason).toContain('git commit failed')
    expect(readFileSync(commitIndex)).toEqual(commitIndexBefore)
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

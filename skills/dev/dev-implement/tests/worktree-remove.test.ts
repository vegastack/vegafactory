import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { ghJson } from '../scripts/lib/gh.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, listWorktrees, pruneWorktrees, readDroppedDeps, removeWorktree } from '../scripts/worktree.mjs'

// The whole verb, the way the CLI runs it. The notice a reclaimed checkout carries has to reach a
// person through a command they actually type, not only through the helper that composes it.
const script = join(import.meta.dir, '..', 'scripts', 'worktree.mjs')
const runScript = (root: string, ...args: string[]) => {
  const argv = [script, ...args, '--repo-root', root, '--home', root, '--json']
  try {
    return { code: 0, out: execFileSync('node', argv, { cwd: root, encoding: 'utf8' }) }
  } catch (error) {
    const failure = error as { status: number; stdout: string }
    return { code: failure.status, out: failure.stdout }
  }
}

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
  // Every real repository ignores its dependencies. Without this a worktree with `node_modules`
  // in it reads as dirty, which is exactly the state that must keep them.
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
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: true, push: false, write: false })
    expect(r.blocks).toEqual([])
    expect(existsSync(wt.path)).toBe(true)
  })
  test('uncommitted work blocks even with --force', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: true, push: false, write: true })
    expect(r.blocks.some((b: string) => b.includes('uncommitted changes'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })
  test('an unpushed branch blocks, and passes once pushed', () => {
    const root = repoWithRemote()
    createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    const before = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: true, push: false, write: true })
    expect(before.blocks.some((b: string) => b.includes('commits not on the remote'))).toBe(true)
    const after = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: true, push: true, write: true })
    expect(after.blocks).toEqual([])
    expect(git(root, 'worktree', 'list')).not.toContain('106-x')
    expect(git(root, 'branch', '--list', 'feat/106-x').trim()).toContain('feat/106-x')
  })
  test('a pushed branch with commits nobody merged blocks without --force', () => {
    const root = repoWithRemote()
    const wt = pushedFeature(root)
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: false, push: false, write: true })
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
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: false, push: false, write: true })
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
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: false, push: false, write: true })
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
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: false, push: false, write: true })
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
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: false, push: false, write: true })
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
    const r = removeWorktree({ repoRoot: root, name: '106-x', base: 'main', force: false, push: false, write: true })
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
      ledgerTimes: { '106-old': OLD_LEDGER }, now, write: false,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '106-old')
    expect(candidate?.state).toBe('parked')
    expect(candidate?.ageDays).toBeGreaterThanOrEqual(14)
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('commits not on the remote')
  })

  // Dependencies are the cost, not the code: on the machine that prompted this, 628 MB of a 638 MB
  // worktree was `node_modules` and the checkout itself was 10 MB. They go on a shorter window,
  // and only on the conditions that already protect the worktree.
  test('dependencies go before the worktree does, and only from a clean unlocked one', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    // Idle, saved, and still its own work: a commit that is not on the default branch, pushed so
    // nothing is only here. A branch already in `main` is `merged` and goes entirely, which is a
    // different case from this one.
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    execFileSync('git', ['-C', wt.path, 'add', '.'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'commit', '-m', 'work'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'push', '-u', 'origin', 'HEAD'], { encoding: 'utf8' })
    const deps = join(wt.path, 'node_modules')
    mkdirSync(join(deps, 'left-pad'), { recursive: true })
    writeFileSync(join(deps, 'left-pad', 'index.js'), 'module.exports = 1\n')
    const tracked = join(wt.path, 'README.md')

    // A dry run says what it would do and removes nothing.
    const dry = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: false,
    })
    expect(dry.actions.join('\n')).toContain('drop node_modules')
    expect(existsSync(deps)).toBe(true)

    const wet = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(wet.freed).toContain('106-old')
    expect(existsSync(deps)).toBe(false)
    // The worktree itself is untouched: its own window had not elapsed.
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(tracked)).toBe(true)
    expect(execFileSync('git', ['-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('feat/106-old')
  })

  // Prune takes them and leaves one record saying so — outside the checkout it describes, because
  // a deps-only prune leaves that checkout in place and a record inside it would go with it.
  test('the drop is recorded beside the repository, not inside the worktree', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(readDroppedDeps(root).names.has('106-old')).toBe(true)
    // The checkout is still here, which is the whole point of taking only the dependencies.
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(wt.path, 'node_modules'))).toBe(false)
  })

  // A record outlives the checkout it describes unless removal clears it, and worktree names
  // come back: the same issue re-cut later would be told its dependencies were reclaimed.
  test('removing a worktree forgets that its dependencies were taken', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    execFileSync('git', ['-C', wt.path, 'add', '.'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'commit', '-m', 'work'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'push', '-u', 'origin', 'HEAD'], { encoding: 'utf8' })
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(readDroppedDeps(root).names.has('106-old')).toBe(true)

    const gone = removeWorktree({ repoRoot: root, name: '106-old', base: 'main', force: true, write: true })
    expect(gone.blocks).toEqual([])
    expect(readDroppedDeps(root).names.has('106-old')).toBe(false)
  })


  // Unpushed commits are work too. A worktree holding something nobody else has is not one to
  // take anything from, dependencies included.
  test('an unpushed worktree keeps its dependencies', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    const deps = join(wt.path, 'node_modules')
    mkdirSync(deps, { recursive: true })
    writeFileSync(join(deps, 'marker.txt'), 'keep me\n')

    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(r.freed).not.toContain('106-old')
    expect(existsSync(join(deps, 'marker.txt'))).toBe(true)
  })

  // A repository may legitimately track files under `node_modules` — a patched package, a vendored
  // stub. `git status` is clean either way, so without a check the sweep deletes committed files.
  test('dependencies git tracks are never deleted', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    mkdirSync(join(wt.path, 'node_modules', 'patched'), { recursive: true })
    writeFileSync(join(wt.path, 'node_modules', 'patched', 'index.js'), 'module.exports = 1\n')
    execFileSync('git', ['-C', wt.path, 'add', '-f', 'node_modules/patched/index.js'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'commit', '-m', 'vendor a patch'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'push', '-u', 'origin', 'HEAD'], { encoding: 'utf8' })

    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(r.freed).not.toContain('106-old')
    expect(existsSync(join(wt.path, 'node_modules', 'patched', 'index.js'))).toBe(true)
    expect(r.warns.join('\n')).toContain('git tracks files under node_modules')
  })

  // Eleven days of being skipped and never named is not reporting.
  test('an unpushed worktree is named as soon as its dependencies could have gone', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(r.warns.join('\n')).toContain('106-old')
    expect(r.warns.join('\n')).toContain('kept its dependencies')
  })

  // Two passes touching different worktrees must not lose each other's record.
  test('recording one worktree never erases another', () => {
    const root = repoWithRemote()
    for (const [issue, slug] of [[106, 'one'], [107, 'two']] as const) {
      const wt = createWorktree({ repoRoot: root, issue, slug, type: 'feat', base: 'main', devMd, home: root, write: true })
      writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
      execFileSync('git', ['-C', wt.path, 'add', '.'], { encoding: 'utf8' })
      execFileSync('git', ['-C', wt.path, 'commit', '-m', 'work'], { encoding: 'utf8' })
      execFileSync('git', ['-C', wt.path, 'push', '-u', 'origin', 'HEAD'], { encoding: 'utf8' })
      mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    }
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-one': OLD_LEDGER, '107-two': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect([...readDroppedDeps(root).names].sort()).toEqual(['106-one', '107-two'])
  })

  test('a worktree with uncommitted work keeps its dependencies', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    const deps = join(wt.path, 'node_modules')
    mkdirSync(deps, { recursive: true })
    writeFileSync(join(deps, 'marker.txt'), 'keep me\n')
    // Something the operator has not saved yet. A reinstall is cheap; this is not.
    writeFileSync(join(wt.path, 'notes.md'), 'half an idea\n')

    const wet = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(wet.freed).not.toContain('106-old')
    expect(existsSync(join(deps, 'marker.txt'))).toBe(true)
  })

  test('--write pushes the unpushed candidate first, then removes it', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    const now = FUTURE_NOW
    const dry = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106-old': OLD_LEDGER }, now, write: false,
    })
    expect(dry.candidates.find((c: { name: string }) => c.name === '106-old')?.pushable).toBe(true)
    expect(existsSync(wt.path)).toBe(true)

    const wet = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106-old': OLD_LEDGER }, now, write: true,
    })
    expect(wet.candidates.find((c: { name: string }) => c.name === '106-old')?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    // The push happened, and the branch itself outlived the prune.
    expect(git(root, 'rev-parse', '--verify', 'refs/remotes/origin/feat/106-old').trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(git(root, 'branch', '--list', 'feat/106-old').trim()).toContain('feat/106-old')
  })

  test('a parked worktree with pushed, unmerged commits is removed past retention and its branch survives', () => {
    const root = repoWithRemote()
    const wt = pushedFeature(root)
    const now = FUTURE_NOW
    const dry = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106-x': OLD_LEDGER }, now, write: false,
    })
    const candidate = dry.candidates.find((c: { name: string }) => c.name === '106-x')
    expect(candidate?.state).toBe('parked')
    expect(candidate?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    const wet = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106-x': OLD_LEDGER }, now, write: true,
    })
    expect(wet.candidates.find((c: { name: string }) => c.name === '106-x')?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    expect(git(root, 'branch', '--list', 'feat/106-x').trim()).toContain('feat/106-x')
    expect(git(root, 'rev-parse', '--verify', 'refs/remotes/origin/feat/106-x').trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  test('uncommitted work in an idle worktree is committed as wip on its own branch and pushed before removal', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 107, slug: 'dirty', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '107-dirty': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '107-dirty')
    expect(candidate?.rescuedTo).toBe('feat/107-dirty')
    expect(candidate?.removable).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    const saved = spawnSync('git', ['show', 'origin/feat/107-dirty:scratch.txt'], { cwd: root, encoding: 'utf8' })
    expect(saved.stdout).toBe('wip\n')
    expect(git(root, 'log', '-1', '--format=%s', 'origin/feat/107-dirty').trim()).toBe('wip: rescued uncommitted work from 107-dirty')
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
      ledgerTimes: { '109-moved': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '109-moved')
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('push was rejected')
    expect(existsSync(wt.path)).toBe(true)
    expect(git(wt.path, 'log', '-1', '--format=%s').trim()).toBe('wip: rescued uncommitted work from 109-moved')
  })

  test('a rescue never commits a staged secret', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 110, slug: 'secret', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, '.env'), 'TOKEN=1\n')
    writeFileSync(join(wt.path, 'notes.txt'), `${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`)
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '110-secret': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const candidate = r.candidates.find((c: { name: string }) => c.name === '110-secret')
    expect(candidate?.removable).toBe(false)
    expect(candidate?.reason).toContain('.env')
    expect(candidate?.reason).toContain('notes.txt')
    expect(existsSync(wt.path)).toBe(true)
    expect(git(wt.path, 'status', '--porcelain')).toContain('.env')
    expect(git(wt.path, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  // A squash merge lands the work and deletes the feature branch. Pushing on "no remote branch"
  // alone would put that branch back — on a prune whose reported action says only "remove".
  test('a prune never recreates a branch somebody deleted after a squash merge', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 111, slug: 'landed', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'feature.txt'), 'landed\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'feat: the work')
    // Pushed, the way a PR is — this is what makes the later deletion mean "delete-on-merge"
    // rather than "never pushed", and the two must not be treated alike.
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    // Squashed onto main: the same content under a different commit, which is what a merge queue
    // leaves behind, then the feature branch deleted and the tracking ref pruned.
    writeFileSync(join(root, 'feature.txt'), 'landed\n')
    // By name: `add .` in the main checkout would sweep in the worktree directory itself.
    git(root, 'add', 'feature.txt')
    git(root, 'commit', '-m', 'feat: the work (#111)')
    git(root, 'push', 'origin', 'main')
    git(root, 'push', 'origin', '--delete', 'feat/111-landed')
    git(root, 'fetch', '--prune', 'origin')

    const before = git(root, 'ls-remote', '--heads', 'origin')
    expect(before).not.toContain('feat/111-landed')
    const r = removeWorktree({ repoRoot: root, name: '111-landed', base: 'main', push: true, write: true })
    expect(r.blocks).toEqual([])
    expect(r.actions.join('\n')).not.toContain('git push')
    // The one thing this is about: the deleted branch stays deleted.
    expect(git(root, 'ls-remote', '--heads', 'origin')).not.toContain('feat/111-landed')
  })

  // The squash case is not the only one. An ordinary merge leaves the branch an ancestor of the
  // base; delete the remote branch afterwards and the merged-ness test declines to call it merged
  // while content cannot see it either, so "no remote branch" alone would push it back.
  // The one that must never happen: an open worktree removed because the default branch moved.
  // A branch cut this morning has no commits of its own, so it is trivially an ancestor of the
  // base — counting that as merged prunes work somebody is in the middle of.
  test('a branch nobody pushed is not merged, however far the base moves ahead', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 118, slug: 'open', type: 'feat', base: 'main', devMd, home: root, write: true })
    // Unrelated work lands on main. The worktree is untouched and was never pushed.
    writeFileSync(join(root, 'other.txt'), 'someone else\n')
    git(root, 'add', 'other.txt')
    git(root, 'commit', '-m', 'chore: elsewhere')
    git(root, 'push', 'origin', 'main')

    // Inside the window: nothing about it is a candidate at all.
    const soon = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {}, now: Date.now(), write: true,
    })
    expect(soon.candidates.find((c: { name: string }) => c.name === '118-open')).toBeUndefined()
    expect(existsSync(wt.path)).toBe(true)

    // And past it, it is `parked` — not `merged`, which would bypass retention entirely.
    const later = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '118-open': OLD_LEDGER }, now: FUTURE_NOW, write: false,
    })
    expect(later.candidates.find((c: { name: string; state: string }) => c.name === '118-open')?.state).toBe('parked')
  })

  test('a prune never recreates a branch deleted after a fast-forward merge', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 119, slug: 'ffwd', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'feature.txt'), 'landed\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'feat: work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    // A true fast-forward: main ends up at the branch's own tip, so nothing is ahead of it and
    // there are no rewritten commits for content to match.
    git(root, 'merge', '--ff-only', 'feat/119-ffwd')
    git(root, 'push', 'origin', 'main')
    expect(git(root, 'rev-parse', 'main').trim()).toBe(git(wt.path, 'rev-parse', 'HEAD').trim())
    git(root, 'push', 'origin', '--delete', 'feat/119-ffwd')
    git(root, 'fetch', '--prune', 'origin')

    const r = removeWorktree({ repoRoot: root, name: '119-ffwd', base: 'main', push: true, write: true })
    expect(r.blocks).toEqual([])
    expect(r.actions.join('\n')).not.toContain('git push')
    expect(git(root, 'ls-remote', '--heads', 'origin')).not.toContain('feat/119-ffwd')
  })

  test('a prune never recreates a branch deleted after an ordinary merge', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 117, slug: 'ff', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'feature.txt'), 'landed\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'feat: work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    git(root, 'merge', '--no-ff', '-m', 'merge', 'feat/117-ff')
    git(root, 'push', 'origin', 'main')
    // Delete-on-merge, then the local tracking ref goes with a prune — exactly what a fetch does.
    git(root, 'push', 'origin', '--delete', 'feat/117-ff')
    git(root, 'fetch', '--prune', 'origin')
    expect(git(root, 'ls-remote', '--heads', 'origin')).not.toContain('feat/117-ff')

    const r = removeWorktree({ repoRoot: root, name: '117-ff', base: 'main', push: true, write: true })
    expect(r.blocks).toEqual([])
    expect(r.actions.join('\n')).not.toContain('git push')
    expect(git(root, 'ls-remote', '--heads', 'origin')).not.toContain('feat/117-ff')
  })

  // A closed issue is the clearest sign a worktree is finished: it does not wait out a window
  // meant for work that might still be wanted. Every refusal still applies to it.
  test('a closed issue makes its worktree a candidate straight away, and dirty still refuses', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 114, slug: 'shut', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    // Committed a moment ago and the ledger untouched: nothing about its age makes it a candidate.
    const soon = Date.now()

    const waiting = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {}, issueStates: {}, now: soon, write: false,
    })
    expect(waiting.candidates.find((c: { name: string }) => c.name === '114-shut')).toBeUndefined()

    const closed = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {},
      issueStates: { '114-shut': 'closed' }, now: soon, write: false,
    })
    expect(closed.candidates.find((c: { name: string; state: string }) => c.name === '114-shut')?.state).toBe('abandoned')

    // A closed issue never costs anybody work. What was not saved is committed on the worktree's
    // own branch and pushed before the directory goes — the checkout is reproducible, the work is
    // not, and `worktree restore` brings the first one back.
    writeFileSync(join(wt.path, 'notes.md'), 'half an idea\n')
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {},
      issueStates: { '114-shut': 'closed' }, now: soon, write: true,
    })
    expect(git(root, 'log', '-1', '--format=%s', 'origin/feat/114-shut').trim()).toBe('wip: rescued uncommitted work from 114-shut')
    expect(git(root, 'show', 'origin/feat/114-shut:notes.md')).toBe('half an idea\n')
  })

  // The same for a merged branch, through the prune rather than `removeWorktree` directly —
  // the acceptance line is about what a prune names, and the two have different gates.
  test('a merged worktree is a candidate straight away, and the prune removes it', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 115, slug: 'done', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'feature.txt'), 'landed\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'feat: work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    // Merged into main and pushed, the way a merge queue leaves it.
    git(root, 'merge', '--no-ff', '-m', 'merge', 'feat/115-done')
    git(root, 'push', 'origin', 'main')
    const soon = Date.now()

    const merged = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {}, issueStates: {}, now: soon, write: false,
    })
    expect(merged.candidates.find((c: { name: string; state: string }) => c.name === '115-done')?.state).toBe('merged')

    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {}, issueStates: {}, now: soon, write: true,
    })
    expect(existsSync(wt.path)).toBe(false)
    // The branch itself outlives the prune — only the directory goes.
    expect(git(root, 'branch', '--list', 'feat/115-done').trim()).toContain('feat/115-done')
  })

  // A deps-only prune leaves the checkout in place, so nothing ever routes through `restore`.
  // The fact has to travel with the worktree instead, and reach a person through the commands
  // they type — a test of the helper alone passes with the whole wiring deleted.
  test('a reclaimed worktree says what to run, in list and in status', () => {
    const root = repoWithRemote()
    mkdirSync(join(root, '.vegastack'), { recursive: true })
    const setup = 'commands: check `true` · setup `bun install --frozen-lockfile`\nworktree-include: none\nworktree-retention: 14d\nworktree-deps-retention: 1d\n'
    writeFileSync(join(root, '.vegastack', 'dev.md'), setup)

    const wt = createWorktree({ repoRoot: root, issue: 112, slug: 'idle', type: 'feat', base: 'main', devMd: setup, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'work\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: setup,
      ledgerTimes: { '112-idle': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })

    // Both verbs a person reads, run as the CLI runs them.
    for (const verb of ['list', 'status']) {
      const answer = JSON.parse(runScript(root, verb).out)
      expect(answer.warns.join('\n')).toContain('bun install --frozen-lockfile')
      expect(answer.entries.find((e: { name: string }) => e.name === '112-idle')?.depsDropped).toBe(true)
    }

    // And a worktree nothing was ever taken from says nothing at all — a warning on every fresh
    // checkout is the failure mode, not a missing one.
    createWorktree({ repoRoot: root, issue: 113, slug: 'fresh', type: 'docs', base: 'main', devMd: setup, home: root, write: true })
    const listed = JSON.parse(runScript(root, 'list').out)
    expect(listed.warns.join('\n')).not.toContain('113-fresh')
    expect(listed.entries.find((e: { name: string }) => e.name === '113-fresh')?.depsDropped).toBe(false)
  })

  // "The record could not be read" and "nothing was taken" must not be the same answer: the first
  // leaves a checkout that cannot build looking untouched.
  test('an unreadable record is reported, not read as nothing to do', () => {
    const root = repoWithRemote()
    mkdirSync(join(root, '.vegastack'), { recursive: true })
    writeFileSync(join(root, '.vegastack', 'dev.md'), devMd)
    createWorktree({ repoRoot: root, issue: 116, slug: 'any', type: 'feat', base: 'main', devMd, home: root, write: true })
    // The directory the records live in, made a file: readdir fails with something other than
    // ENOENT, which is the only code that means "nothing has been dropped here".
    mkdirSync(join(root, '.vegastack', '.tmp', 'worker'), { recursive: true })
    writeFileSync(join(root, '.vegastack', '.tmp', 'worker', 'deps-dropped'), 'not a directory\n')

    const answer = JSON.parse(runScript(root, 'list').out)
    expect(answer.warns.join('\n')).toContain('could not be read')
  })

  // Locked is one of the three refusals that is never lifted, and it has to cover the
  // dependencies as well as the directory. The fixture differs from a removable worktree by the
  // lock and nothing else — clean and pushed — because a dirty or unpushed one is held by two
  // other guards and would stay green with the lock check deleted.
  test('a locked worktree keeps its directory, its work and its dependencies', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 108, slug: 'held', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    mkdirSync(join(wt.path, 'node_modules', 'left'), { recursive: true })
    writeFileSync(join(wt.path, 'node_modules', 'left', 'index.js'), 'module.exports = 1\n')
    const head = git(wt.path, 'rev-parse', 'HEAD').trim()
    // Nothing uncommitted and nothing unpushed: the lock is the only thing holding it.
    expect(git(wt.path, 'status', '--porcelain').trim()).toBe('')
    spawnSync('git', ['worktree', 'lock', wt.path], { cwd: root })
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d',
      // Both windows well past, so nothing here is spared by a clock.
      devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '108-held': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(r.candidates.find((c: { name: string }) => c.name === '108-held')).toBeUndefined()
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(wt.path, 'node_modules', 'left', 'index.js'))).toBe(true)
    expect(r.freed).not.toContain('108-held')
    expect(readDroppedDeps(root).names.has('108-held')).toBe(false)
    // The branch and the commit it was on are exactly where they were.
    expect(git(wt.path, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/108-held')
    // And the unattended pass says it was kept, rather than skipping it silently.
    expect(r.warns.join('\n')).toContain('108-held')
    expect(r.warns.join('\n')).toContain('locked')

    // The proof that the lock is what did it: unlocked, the same worktree is reclaimed.
    spawnSync('git', ['worktree', 'unlock', wt.path], { cwd: root })
    const after = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '108-held': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(after.freed).toContain('108-held')
  })
})

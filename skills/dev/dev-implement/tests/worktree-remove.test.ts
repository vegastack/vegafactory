import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { ghJson } from '../scripts/lib/gh.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, listWorktrees, noteMissingDependencies, pruneWorktrees, readDroppedDeps, removeWorktree } from '../scripts/worktree.mjs'

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

  // Prune takes them and leaves one record saying so. Putting them back is the build's own
  // business (#275); what this side owes is a checkout that says out loud it cannot build.
  test('a reclaimed worktree says what to run, and only that one does', () => {
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
    // The record lives beside the repository's worker state, not inside the worktree it is about:
    // a deps-only prune leaves the checkout in place, and a record inside it would go with it.
    expect(readDroppedDeps(root)['106-old']).toBeTruthy()

    // One `commands:` line, as a real profile has: a second would make the profile ambiguous.
    const setup = 'commands: check `true` · setup `bun install --frozen-lockfile`\nworktree-retention: 14d\n'
    const warns: string[] = []
    expect(noteMissingDependencies({ repoRoot: root, name: '106-old', path: wt.path, devMd: setup, warns })).toBe(true)
    expect(warns.join('\n')).toContain('bun install --frozen-lockfile')

    // Nothing was ever taken from a fresh checkout, so nothing is said about it — a docs-only
    // issue pays for no install and reads no warning.
    const fresh = createWorktree({ repoRoot: root, issue: 107, slug: 'fresh', type: 'docs', base: 'main', devMd, home: root, write: true })
    const quiet: string[] = []
    expect(noteMissingDependencies({ repoRoot: root, name: '107-fresh', path: fresh.path, devMd: setup, warns: quiet })).toBe(false)
    expect(quiet).toEqual([])
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
    expect(readDroppedDeps(root)['106-old']).toBeTruthy()

    const gone = removeWorktree({ repoRoot: root, name: '106-old', base: 'main', force: true, write: true })
    expect(gone.blocks).toEqual([])
    expect(readDroppedDeps(root)['106-old']).toBeUndefined()
  })

  // The unattended pass is narrower than the prune a person runs. A person asked and can be told
  // "your work is on a branch"; a background pass has nobody to tell, so it leaves it alone.
  test('the automatic pass never pushes, never commits, and says what it kept', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    // A commit nobody has pushed, and something uncommitted on top of it.
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    execFileSync('git', ['-C', wt.path, 'add', '.'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'commit', '-m', 'work'], { encoding: 'utf8' })
    writeFileSync(join(wt.path, 'more.txt'), 'half an idea\n')

    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
    })
    // Still there, still dirty, still unpushed — and reported rather than silently skipped.
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(wt.path, 'more.txt'))).toBe(true)
    expect(r.warns.join('\n')).toContain('106-old')
    expect(r.warns.join('\n')).toContain('kept:')
    expect(r.actions.join('\n')).not.toContain('commit uncommitted work as wip')
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
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
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
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
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
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
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
      ledgerTimes: { '106-one': OLD_LEDGER, '107-two': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
    })
    expect(Object.keys(readDroppedDeps(root)).sort()).toEqual(['106-one', '107-two'])
  })

  // A closed issue is the clearest sign a worktree is finished, and it does not wait out a window
  // meant for work that might still be wanted — but every refusal still applies to it.
  test('a closed issue makes its worktree a candidate straight away, and still refuses dirty work', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'real work\n')
    execFileSync('git', ['-C', wt.path, 'add', '.'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'commit', '-m', 'work'], { encoding: 'utf8' })
    execFileSync('git', ['-C', wt.path, 'push', '-u', 'origin', 'HEAD'], { encoding: 'utf8' })
    const soon = Date.now()

    expect(pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {}, issueStates: {}, now: soon, write: false, automatic: true,
    }).candidates.find((c: { name: string }) => c.name === '106-old')).toBeUndefined()

    const closed = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {},
      issueStates: { '106-old': 'closed' }, now: soon, write: false, automatic: true,
    })
    expect(closed.candidates.find((c: { name: string; state: string }) => c.name === '106-old')?.state).toBe('abandoned')

    // Uncommitted work outranks a closed issue every time.
    writeFileSync(join(wt.path, 'notes.md'), 'half an idea\n')
    const dirty = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd, ledgerTimes: {},
      issueStates: { '106-old': 'closed' }, now: soon, write: true, automatic: true,
    })
    expect(existsSync(join(wt.path, 'notes.md'))).toBe(true)
    expect(dirty.warns.join('\n')).toContain('106-old')
  })

  test('a paginated gh answer reads as one list', () => {
    const bin = mkdtempSync(join(tmpdir(), 'vf-gh-'))
    const fakeGh = (stdout: string) => {
      const path = join(bin, 'gh')
      writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`, { mode: 0o755 })
      return path
    }
    const page = (from: number) => JSON.stringify([{ number: from }, { number: from + 1 }])

    // Two pages, printed back to back, are the one list the caller asked for.
    expect(ghJson(['api', 'x'], { gh: fakeGh(`${page(1)}\n${page(3)}`) }))
      .toEqual([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }])
    // One page is still one page.
    expect(ghJson(['api', 'x'], { gh: fakeGh(page(1)) })).toEqual([{ number: 1 }, { number: 2 }])
    // A single object is untouched.
    expect(ghJson(['api', 'x'], { gh: fakeGh('{"id":7}') })).toEqual({ id: 7 })
    // Genuinely broken output is still broken, not half-read.
    expect(() => ghJson(['api', 'x'], { gh: fakeGh('[{"number":1},') })).toThrow(/unparseable/)
    // A valid page followed by a truncation message is not complete data.
    expect(() => ghJson(['api', 'x'], { gh: fakeGh(`${page(1)}\nerror: gateway timeout`) })).toThrow(/unparseable/)
    // Including a suffix that begins with a quote, which would otherwise be read as a string.
    expect(() => ghJson(['api', 'x'], { gh: fakeGh(`${page(1)}\n"gateway timeout"`) })).toThrow(/unparseable/)
    // Nor is anything before the first document.
    expect(() => ghJson(['api', 'x'], { gh: fakeGh(`warning: rate limited\n${page(1)}`) })).toThrow(/unparseable/)
    // Brackets inside strings are text, not structure.
    expect(ghJson(['api', 'x'], { gh: fakeGh(JSON.stringify([{ body: '}}}] not json [[[{{{' }])) }))
      .toEqual([{ body: '}}}] not json [[[{{{' }])

    // This reads issue and comment bodies, which anybody with an account can write. Trying a parse
    // at every bracket is quadratic, so a comment full of braces would cost seconds every poll.
    const hostile = JSON.stringify([{ body: '}'.repeat(40_000) }])
    const started = Date.now()
    expect(ghJson(['api', 'x'], { gh: fakeGh(`${hostile}\n${hostile}`) })).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a worktree a run is holding is left entirely alone', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    const deps = join(wt.path, 'node_modules')
    mkdirSync(deps, { recursive: true })
    writeFileSync(join(deps, 'marker.txt'), 'in use\n')

    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '1d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
      inUse: ['106'],
    })
    // An agent is reading it right now: not the worktree, not its dependencies, nothing.
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(deps, 'marker.txt'))).toBe(true)
    expect(r.freed).not.toContain('106-old')
    expect(r.candidates.find((c: { name: string }) => c.name === '106-old')).toBeUndefined()
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
    // Squashed onto main: the same content under a different commit, which is what a merge queue
    // leaves behind. The feature branch is then gone from the remote — here it was never pushed
    // at all, which reads exactly the same way.
    writeFileSync(join(root, 'feature.txt'), 'landed\n')
    // By name: `add .` in the main checkout would sweep in the worktree directory itself.
    git(root, 'add', 'feature.txt')
    git(root, 'commit', '-m', 'feat: the work (#111)')
    git(root, 'push', 'origin', 'main')

    const before = git(root, 'ls-remote', '--heads', 'origin')
    expect(before).not.toContain('feat/111-landed')
    const r = removeWorktree({ repoRoot: root, name: '111-landed', base: 'main', push: true, write: true })
    expect(r.blocks).toEqual([])
    expect(r.actions.join('\n')).not.toContain('git push')
    // The one thing this is about: the deleted branch stays deleted.
    expect(git(root, 'ls-remote', '--heads', 'origin')).not.toContain('feat/111-landed')
  })

  // A deps-only prune leaves the checkout in place, so nothing ever routes through `restore`.
  // The fact has to travel with the worktree instead, or a resumed checkout never names it.
  test('a reclaimed worktree is marked as such wherever it is described', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 112, slug: 'idle', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'work.txt'), 'work\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'work')
    git(wt.path, 'push', '-u', 'origin', 'HEAD')
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    const setup = 'commands: check `true` · setup `bun install --frozen-lockfile`\nworktree-retention: 14d\nworktree-deps-retention: 1d\n'
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: setup,
      ledgerTimes: { '112-idle': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })

    // `list` is what a person and the CLI read.
    const entry = listWorktrees({ repoRoot: root, base: 'main', withSize: false }).find((e: { name: string }) => e.name === '112-idle')
    expect(entry?.depsDropped).toBe(true)
    // And the pass the worker makes anyway says it every time, naming the command to run.
    const again = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: setup,
      ledgerTimes: { '112-idle': OLD_LEDGER }, now: FUTURE_NOW, automatic: true,
    })
    expect(again.warns.join('\n')).toContain('bun install --frozen-lockfile')
  })

  // "The record could not be read" and "nothing was taken" are the same answer as a missing key,
  // and must not be: the first leaves a checkout that cannot build looking untouched.
  test('an unreadable record is reported, not read as nothing to do', () => {
    const root = repoWithRemote()
    // The directory the records live in, made a file: readdir fails with something other than
    // ENOENT, which is the only code that means "nothing has been dropped here".
    mkdirSync(join(root, '.vegastack', '.tmp', 'worker'), { recursive: true })
    writeFileSync(join(root, '.vegastack', '.tmp', 'worker', 'deps-dropped'), 'not a directory\n')
    const warns: string[] = []
    expect(noteMissingDependencies({ repoRoot: root, name: 'anything', path: '/w', devMd, warns })).toBe(true)
    expect(warns.join('\n')).toContain('could not be read')
  })

  // Locked is one of the three refusals that is never lifted, and it has to cover the
  // dependencies as well as the directory — a fixture with no `node_modules` stays green while
  // the deps sweep regresses straight through it.
  test('a locked worktree keeps its directory, its work and its dependencies', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 108, slug: 'held', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    mkdirSync(join(wt.path, 'node_modules', 'left'), { recursive: true })
    writeFileSync(join(wt.path, 'node_modules', 'left', 'index.js'), 'module.exports = 1\n')
    const head = git(wt.path, 'rev-parse', 'HEAD').trim()
    spawnSync('git', ['worktree', 'lock', wt.path], { cwd: root })
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d',
      // Both windows well past, so nothing here is spared by a clock.
      devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '108-held': OLD_LEDGER }, now: FUTURE_NOW, write: true, automatic: true,
    })
    expect(r.candidates.find((c: { name: string }) => c.name === '108-held')).toBeUndefined()
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(wt.path, 'node_modules', 'left', 'index.js'))).toBe(true)
    expect(r.freed).not.toContain('108-held')
    expect(readDroppedDeps(root)['108-held']).toBeUndefined()
    // The branch and the commit it was on are exactly where they were.
    expect(git(wt.path, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/108-held')
    // And the unattended pass says it was kept, rather than skipping it silently.
    expect(r.warns.join('\n')).toContain('108-held')
    expect(r.warns.join('\n')).toContain('locked')
  })
})

import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, pruneWorktrees, removeWorktree, restoreDroppedDependencies } from '../scripts/worktree.mjs'

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

  // Prune takes them, restore puts back exactly those — never installing speculatively into a
  // worktree that never had them, which is what keeps a docs-only issue cheap.
  test('a worktree whose dependencies were dropped reinstalls them, and only that one', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 106, slug: 'old', type: 'feat', base: 'main', devMd, home: root, write: true })
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '999d', devMd: `${devMd}\nworktree-deps-retention: 1d\n`,
      ledgerTimes: { '106-old': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    const marker = join(wt.path, '.vegastack', '.tmp', 'deps-dropped')
    expect(existsSync(marker)).toBe(true)

    const ran: string[][] = []
    const runner = ((file: string, args: string[]) => { ran.push([file, ...args]); return '' }) as never
    const actions: string[] = []
    const warns: string[] = []
    // One `commands:` line, as a real profile has: a second would make the profile ambiguous.
    const setup = 'commands: check `true` · setup `bun install --frozen-lockfile`\nworktree-retention: 14d\n'
    expect(restoreDroppedDependencies({ path: wt.path, devMd: setup, write: true, actions, warns, runner })).toBe(true)
    expect(ran[0]).toEqual(['sh', '-c', 'bun install --frozen-lockfile'])
    expect(actions.join('\n')).toContain('reinstall dependencies')
    // Done once: the marker is gone, so the next restore installs nothing.
    expect(existsSync(marker)).toBe(false)
    ran.length = 0
    expect(restoreDroppedDependencies({ path: wt.path, devMd: setup, write: true, actions, warns, runner })).toBe(false)
    expect(ran).toEqual([])
  })

  test('a fresh worktree installs nothing, however the dev.md reads', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 107, slug: 'fresh', type: 'docs', base: 'main', devMd, home: root, write: true })
    const ran: string[][] = []
    const runner = ((file: string, args: string[]) => { ran.push([file, ...args]); return '' }) as never
    const setup = 'commands: setup `bun install --frozen-lockfile`\n'
    expect(restoreDroppedDependencies({ path: wt.path, devMd: setup, write: true, actions: [], warns: [], runner })).toBe(false)
    expect(ran).toEqual([])
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

  test('a locked worktree with uncommitted work is left alone', () => {
    const root = repoWithRemote()
    const wt = createWorktree({ repoRoot: root, issue: 108, slug: 'held', type: 'feat', base: 'main', devMd, home: root, write: true })
    writeFileSync(join(wt.path, 'scratch.txt'), 'wip\n')
    spawnSync('git', ['worktree', 'lock', wt.path], { cwd: root })
    const r = pruneWorktrees({
      repoRoot: root, base: 'main', olderThan: '14d', devMd,
      ledgerTimes: { '108-held': OLD_LEDGER }, now: FUTURE_NOW, write: true,
    })
    expect(r.candidates.find((c: { name: string }) => c.name === '108-held')).toBeUndefined()
    expect(existsSync(wt.path)).toBe(true)
  })
})

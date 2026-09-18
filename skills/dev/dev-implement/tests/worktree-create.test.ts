import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTrustToml, createWorktree, restoreWorktree } from '../scripts/worktree.mjs'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'vf-wt-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'a@b.c')
  git(root, 'config', 'user.name', 'a')
  writeFileSync(join(root, 'README.md'), '# r\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'init')
  return root
}
const devMd = 'commands: check `true` · setup `sh -c "echo setup-ran > setup.log"`\nworktree-include: .env\n'

describe('createWorktree', () => {
  test('a type the project does not list is refused, and the refusal names the ones it does', () => {
    const root = repo()
    const r = createWorktree({ repoRoot: root, issue: 224, slug: 'x', type: 'research', base: 'main', devMd, home: root, write: false })
    expect(r.blocks.join(' ')).toContain('feat, fix, docs, chore, refactor')
    expect(existsSync(join(root, '.vegastack/.worktrees/224-x'))).toBe(false)
  })
  test('no type at all is refused rather than silently becoming feat, and the refusal quotes the title', () => {
    const root = repo()
    const r = createWorktree({ repoRoot: root, issue: 224, slug: 'x', type: null, title: 'research: P12 — prove the lean factory works', base: 'main', devMd, home: root, write: false })
    expect(r.blocks).toEqual(['branch type: "research: P12 — prove the lean factory works" names no type — pass --type <one of: feat, fix, docs, chore, refactor>'])
    expect(r.branch).toBeUndefined()
    expect(existsSync(join(root, '.vegastack/.worktrees/224-x'))).toBe(false)
  })
  test('with no title to quote, the refusal names the issue', () => {
    const root = repo()
    const r = createWorktree({ repoRoot: root, issue: 224, slug: 'x', type: null, base: 'main', devMd, home: root, write: false })
    expect(r.blocks.join(' ')).toContain('#224 names no type')
  })
  test('the project\'s own list is what counts', () => {
    const root = repo()
    const ownList = devMd + 'branch: <type>/<slug>   # type: feat | spike — the only place this list lives\n'
    const r = createWorktree({ repoRoot: root, issue: 224, slug: 'x', type: 'spike', base: 'main', devMd: ownList, home: root, write: false })
    expect(r.blocks).toEqual([])
    expect(r.branch).toBe('spike/224-x')
  })
  test('dry run reports the actions and writes nothing', () => {
    const root = repo()
    const r = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: false })
    expect(r.blocks).toEqual([])
    expect(r.path).toBe(join(root, '.vegastack/.worktrees/106-x'))
    expect(r.branch).toBe('feat/106-x')
    expect(existsSync(r.path)).toBe(false)
  })
  test('--write adds the worktree and copies the include list, without installing dependencies', () => {
    const root = repo()
    const r = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    expect(r.blocks).toEqual([])
    expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/106-x')
    expect(readFileSync(join(r.path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(existsSync(join(r.path, 'setup.log'))).toBe(false)
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })
  test('two issues in one clone get two independent worktrees and main stays put', () => {
    const root = repo()
    const a = createWorktree({ repoRoot: root, issue: 106, slug: 'a', type: 'feat', base: 'main', devMd, home: root, write: true })
    const b = createWorktree({ repoRoot: root, issue: 107, slug: 'b', type: 'feat', base: 'main', devMd, home: root, write: true })
    expect(a.path).not.toBe(b.path)
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/106-a')
    expect(git(b.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/107-b')
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })
  test('a symlinked .worktrees parent is refused', () => {
    const root = repo()
    const elsewhere = mkdtempSync(join(tmpdir(), 'vf-elsewhere-'))
    mkdirSync(join(root, '.vegastack'))
    symlinkSync(elsewhere, join(root, '.vegastack/.worktrees'))
    const r = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    expect(r.blocks[0]).toContain('symlink')
  })
})

// The whole verb, as the CLI runs it: naming is composed in runVerb, which is
// where a type resolved from the wrong place does its damage.
const script = join(import.meta.dir, '..', 'scripts', 'worktree.mjs')
// --home keeps the Codex trust entry inside the temp repo. Without it a
// --write run edits the real ~/.codex/config.toml, which a test must never do.
const runScript = (root: string, ...args: string[]) => {
  const argv = [script, ...args, '--repo-root', root, '--home', root, '--json']
  const stub = join(root, 'stub-bin')
  const env = { ...process.env, PATH: existsSync(stub) ? stub + ':' + process.env.PATH : process.env.PATH }
  try {
    return { code: 0, out: execFileSync('node', argv, { cwd: root, encoding: 'utf8', env }) }
  } catch (error) {
    const failure = error as { status: number; stdout: string }
    return { code: failure.status, out: failure.stdout }
  }
}

const writeDevMd = (root: string) => {
  mkdirSync(join(root, '.vegastack'), { recursive: true })
  writeFileSync(join(root, '.vegastack', 'dev.md'), devMd + 'repo: o/r\n')
}

// A `gh` on PATH that answers the one call `create` makes: the issue's title.
const stubGh = (root: string, title: string) => {
  const bin = join(root, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'gh')
  writeFileSync(path, '#!/bin/sh\ncat <<\'JSON\'\n' + JSON.stringify({ title }) + '\nJSON\n')
  chmodSync(path, 0o755)
  return bin
}

describe('the create and restore verbs resolve type and slug independently', () => {
  test('restore with --slug still takes the type from the branch, not from a default', () => {
    const root = repo()
    const created = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'fix', base: 'main', devMd, home: root, write: true })
    expect(created.branch).toBe('fix/106-x')
    git(root, 'worktree', 'remove', '--force', created.path)
    const r = runScript(root, 'restore', '--issue', '106', '--slug', 'x', '--write')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).branch).toBe('fix/106-x')
  })
  test('--slug picks among several branches for one issue instead of being ambiguous', () => {
    const root = repo()
    const first = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'fix', base: 'main', devMd, home: root, write: true })
    const second = createWorktree({ repoRoot: root, issue: 106, slug: 'y', type: 'docs', base: 'main', devMd, home: root, write: true })
    git(root, 'worktree', 'remove', '--force', first.path)
    git(root, 'worktree', 'remove', '--force', second.path)
    // Without --slug the two are genuinely ambiguous and it says so.
    expect(JSON.parse(runScript(root, 'restore', '--issue', '106').out).blocks.join(' ')).toContain('several branches match')
    // With it, the one named is the one restored — on its own type.
    const r = runScript(root, 'restore', '--issue', '106', '--slug', 'y', '--write')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).branch).toBe('docs/106-y')
  })
  test('a branch with no issue restores on its own type, not on a guessed one', () => {
    const root = repo()
    const created = createWorktree({ repoRoot: root, issue: null, slug: 'release-0-19-0', type: 'chore', base: 'main', devMd, home: root, write: true })
    expect(created.branch).toBe('chore/release-0-19-0')
    git(root, 'worktree', 'remove', '--force', created.path)
    const r = runScript(root, 'restore', '--slug', 'release-0-19-0', '--write')
    expect(r.code).toBeLessThan(2)
    expect(JSON.parse(r.out).branch).toBe('chore/release-0-19-0')
  })
  test('create with --slug reads the title for the type alone', () => {
    const root = repo()
    stubGh(root, 'fix: the guard drops a flag')
    writeDevMd(root)
    const r = runScript(root, 'create', '--issue', '106', '--slug', 'custom')
    expect(r.code).toBeLessThan(2)
    // The type is the title's; the slug stays the one that was passed.
    expect(JSON.parse(r.out).branch).toBe('fix/106-custom')
  })
  test('an unsafe title cannot repaint the refusal it appears in', () => {
    const root = repo()
    stubGh(root, 'nope\u001b[2K\u202e: definitely a feat')
    writeDevMd(root)
    const blocks = JSON.parse(runScript(root, 'create', '--issue', '106').out).blocks.join(' ')
    expect(blocks).toContain('names no type')
    expect(blocks).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(blocks).not.toMatch(/\p{Cf}/u)
  })
  test('create with --slug still wants a type, and says so rather than inventing one', () => {
    const root = repo()
    const r = runScript(root, 'create', '--issue', '224', '--slug', 'x')
    expect(r.code).toBe(2)
    // No repo knob in the fixture, so the title cannot be read — and the
    // refusal asks for the one thing still missing, not for the slug it has.
    const blocks = JSON.parse(r.out).blocks.join(' ')
    expect(blocks).toContain('--type')
    expect(blocks).not.toContain('--slug')
  })
})

describe('restoreWorktree', () => {
  test('a branch whose directory is gone is re-added at its path with the include list', () => {
    const root = repo()
    const created = createWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    git(root, 'worktree', 'remove', '--force', created.path)
    expect(existsSync(created.path)).toBe(false)
    const r = restoreWorktree({ repoRoot: root, issue: 106, slug: 'x', type: 'feat', base: 'main', devMd, home: root, write: true })
    expect(r.blocks).toEqual([])
    expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/106-x')
    expect(readFileSync(join(r.path, '.env'), 'utf8')).toBe('SECRET=1\n')
  })
  test('restoring a branch that does not exist blocks rather than inventing one', () => {
    const root = repo()
    const r = restoreWorktree({ repoRoot: root, issue: 999, slug: 'nope', type: 'feat', base: 'main', devMd, home: root, write: true })
    expect(r.blocks[0]).toContain('no branch')
  })
})

// The script as the CLI and dev-implement drive it: `create --issue <n>` with
// no --slug names the worktree from the issue title, `restore --issue <n>`
// from the branch that already exists.
describe('worktree.mjs create and restore by issue number', () => {
  const script = join(import.meta.dir, '..', 'scripts', 'worktree.mjs')
  const run = (root: string, gh: string, ...args: string[]) => {
    const devMdPath = join(root, 'dev.md')
    writeFileSync(devMdPath, 'repo: o/r · default branch main\ncommands: check `true`\nworktree-include: none\n')
    const result = Bun.spawnSync([process.execPath, script, ...args, '--json', '--repo-root', root, '--dev-md', devMdPath, '--home', root], {
      cwd: root, env: { ...process.env, VSK_GH: gh },
    })
    return { status: result.exitCode, out: JSON.parse(result.stdout.toString()) }
  }
  const ghStub = (title: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-gh-'))
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/sh\nprintf \'%s\' \'' + JSON.stringify({ title }) + '\'\n')
    chmodSync(bin, 0o755)
    return bin
  }

  test('create names the branch and directory from the issue title, prefix as the type', () => {
    const root = repo()
    const created = run(root, ghStub('fix: One feature, ONE worktree!'), 'create', '--issue', '106', '--write')
    expect(created.out.blocks).toEqual([])
    expect(created.status).toBeLessThan(2)
    expect(created.out.branch).toBe('fix/106-one-feature-one-worktree')
    expect(created.out.path).toBe(join(root, '.vegastack/.worktrees/106-one-feature-one-worktree'))
    expect(git(created.out.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('fix/106-one-feature-one-worktree')
  })
  test('restore finds the branch by issue number and needs neither a slug nor GitHub', () => {
    const root = repo()
    const created = run(root, ghStub('feat: Restore me'), 'create', '--issue', '106', '--write')
    git(root, 'worktree', 'remove', '--force', created.out.path)
    const restored = run(root, '/nonexistent-vsk-gh', 'restore', '--issue', '106', '--write')
    expect(restored.out.blocks).toEqual([])
    expect(restored.status).toBeLessThan(2)
    expect(restored.out.path).toBe(created.out.path)
    expect(git(restored.out.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/106-restore-me')
  })
  test('create without a slug and without GitHub blocks and names --slug as the way through', () => {
    const root = repo()
    const r = run(root, '/nonexistent-vsk-gh', 'create', '--issue', '106', '--write')
    expect(r.status).toBe(2)
    expect(r.out.blocks[0]).toContain('--slug')
    expect(existsSync(join(root, '.vegastack/.worktrees'))).toBe(false)
  })
})

describe('codexTrustToml', () => {
  test('appends the trust entry once and is idempotent', () => {
    const first = codexTrustToml('model = "gpt-5.6"\n', '/r/.vegastack/.worktrees/106-x')
    expect(first.changed).toBe(true)
    expect(first.text).toContain('[projects."/r/.vegastack/.worktrees/106-x"]')
    expect(first.text).toContain('trust_level = "trusted"')
    expect(codexTrustToml(first.text, '/r/.vegastack/.worktrees/106-x').changed).toBe(false)
  })
})

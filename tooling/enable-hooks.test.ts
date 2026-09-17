import { beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
let repo: string
let bin: string

const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' })

// A fake `bun` on PATH records where the check ran and what it saw, and exits with `exit`.
const commit = (message: string, exit = 0) => {
  const marker = join(bin, 'seen')
  rmSync(marker, { force: true })
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\n{ pwd; echo "$*"; cat a.txt 2>/dev/null; echo; ls -a; } > "${marker}"\nexit ${exit}\n`, { mode: 0o755 })
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  const seen = existsSync(marker) ? readFileSync(marker, 'utf8').split('\n') : null
  return { code: result.status, ran: seen !== null, seen, stderr: result.stderr }
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'githooks-')))
  bin = mkdtempSync(join(tmpdir(), 'githooks-bin-'))
  spawnSync('git', ['init', '-q', repo])
  const run = spawnSync(process.execPath, [join(repoRoot, 'tooling/enable-hooks.mjs')], { cwd: repo })
  expect(run.status).toBe(0)
  mkdirSync(join(repo, '.githooks'))
  copyFileSync(join(repoRoot, '.githooks/commit-msg'), join(repo, '.githooks/commit-msg'))
  spawnSync('chmod', ['+x', join(repo, '.githooks/commit-msg')])
  writeFileSync(join(repo, '.git/info/exclude'), '.githooks/\n')
})

test('enable-hooks points git at .githooks, which holds only the commit-msg check', () => {
  expect(git('config', 'core.hooksPath').stdout.trim()).toBe('.githooks')
  expect(spawnSync('ls', [join(repoRoot, '.githooks')], { encoding: 'utf8' }).stdout.trim()).toBe('commit-msg')
  const hook = readFileSync(join(repoRoot, '.githooks/commit-msg'), 'utf8')
  expect(hook).toContain('bun run --silent check:fast')
  expect(hook).not.toContain('VEGAFACTORY_FAST_CHECK')
})

test('a normal commit runs the fast checks and a failure stops it', () => {
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', 'a.txt')
  const failed = commit('feat: a', 1)
  expect(failed).toMatchObject({ code: 1, ran: true })
  expect(failed.stderr).toContain('fast checks failed')
  const passed = commit('feat: a')
  expect(passed).toMatchObject({ code: 0, ran: true })
  expect(passed.seen![1]).toBe('run --silent check:fast')
})

test('a wip: commit skips the checks', () => {
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', 'a.txt')
  expect(commit('wip: #7 turn checkpoint', 1)).toMatchObject({ code: 0, ran: false })
})

test('a checkout without node_modules borrows the nearest parent folder\'s', () => {
  const nested = join(repo, 'nest', 'wt')
  mkdirSync(join(repo, 'node_modules'))
  spawnSync('git', ['init', '-q', nested])
  spawnSync(process.execPath, [join(repoRoot, 'tooling/enable-hooks.mjs')], { cwd: nested })
  mkdirSync(join(nested, '.githooks'))
  copyFileSync(join(repoRoot, '.githooks/commit-msg'), join(nested, '.githooks/commit-msg'))
  spawnSync('chmod', ['+x', join(nested, '.githooks/commit-msg')])
  writeFileSync(join(nested, '.git/info/exclude'), '.githooks/\n')
  writeFileSync(join(nested, 'a.txt'), 'a')
  const outer = repo
  repo = nested
  try {
    git('add', 'a.txt')
    const result = commit('feat: a')
    expect(result).toMatchObject({ code: 0, ran: true })
    expect(result.seen).toContain('node_modules')
  } finally { repo = outer }
})

test('the checks see exactly the staged files, in a copy, with node_modules linked in', () => {
  mkdirSync(join(repo, 'node_modules'))
  writeFileSync(join(repo, 'a.txt'), 'staged')
  git('add', 'a.txt')
  writeFileSync(join(repo, 'a.txt'), 'unstaged')
  writeFileSync(join(repo, 'untracked.txt'), 'x')
  const result = commit('feat: a')
  expect(result).toMatchObject({ code: 0, ran: true })
  const [where, , content, ...listing] = result.seen!
  expect(where).not.toBe(repo)
  expect(content).toBe('staged')
  expect(listing).toContain('node_modules')
  expect(listing).not.toContain('untracked.txt')
  expect(existsSync(where!)).toBe(false)
  expect(git('show', 'HEAD:a.txt').stdout).toBe('staged')
})

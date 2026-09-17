import { beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
let repo: string

const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' })
// The check the hook runs is swapped for a script that records it ran and exits with `exit`.
const commit = (message: string, exit = 0) => {
  const marker = join(repo, '.checked')
  const script = join(repo, '.git', 'check.sh')
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit ${exit}\n`, { mode: 0o755 })
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, VEGAFACTORY_FAST_CHECK: script },
  })
  const ran = spawnSync('test', ['-e', marker]).status === 0
  spawnSync('rm', ['-f', marker])
  return { code: result.status, ran, stderr: result.stderr }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'githooks-'))
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
  expect(readFileSync(join(repoRoot, '.githooks/commit-msg'), 'utf8')).toContain('bun run --silent check:fast')
})

test('a normal commit runs the fast checks and a failure stops it', () => {
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', 'a.txt')
  const failed = commit('feat: a', 1)
  expect(failed).toMatchObject({ code: 1, ran: true })
  expect(failed.stderr).toContain('fast checks failed')
  expect(commit('feat: a')).toMatchObject({ code: 0, ran: true })
})

test('a wip: commit skips the checks', () => {
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', 'a.txt')
  expect(commit('wip: #7 turn checkpoint', 1)).toMatchObject({ code: 0, ran: false })
})

test('a file with staged and unstaged edits is refused before the checks run', () => {
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', 'a.txt')
  writeFileSync(join(repo, 'a.txt'), 'b')
  const result = commit('feat: a')
  expect(result).toMatchObject({ code: 1, ran: false })
  expect(result.stderr).toContain('a.txt')
})

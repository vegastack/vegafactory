import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const enableHooks = join(import.meta.dir, 'enable-hooks.mjs')
const preCommit = join(import.meta.dir, '..', '.githooks', 'pre-commit')
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'hooks-')))
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })

function repo(): string {
  const dir = temp()
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  return dir
}

describe('enable-hooks', () => {
  test('inside a repository it points git at .githooks', () => {
    const dir = repo()
    const result = spawnSync('node', [enableHooks], { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(git(dir, 'config', '--get', 'core.hooksPath').stdout.trim()).toBe('.githooks')
  })

  test('outside a repository it does nothing and succeeds', () => {
    const result = spawnSync('node', [enableHooks], { cwd: temp(), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } })
    expect(result.status).toBe(0)
  })

  test('inside a repository a failed git config fails the install', () => {
    const dir = repo()
    chmodSync(join(dir, '.git'), 0o500)
    try {
      const result = spawnSync('node', [enableHooks], { cwd: dir, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
    } finally {
      chmodSync(join(dir, '.git'), 0o700)
    }
  })
})

describe('pre-commit', () => {
  // A stand-in `bun` that passes only when the checked tree's check.txt says "good".
  function fakeBun(): string {
    const bin = temp()
    // Passes when check.txt is good, or when an untracked extra.txt is visible — so a hook
    // that checked the working tree instead of the staged snapshot would wrongly pass.
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\ngrep -qx good check.txt || test -f extra.txt\n')
    chmodSync(join(bin, 'bun'), 0o755)
    return bin
  }

  function hookRepo(): string {
    const dir = repo()
    mkdirSync(join(dir, '.githooks'))
    cpSync(preCommit, join(dir, '.githooks', 'pre-commit'))
    writeFileSync(join(dir, 'check.txt'), 'good\n')
    git(dir, 'add', '.')
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base')
    return dir
  }

  const runHook = (dir: string) =>
    spawnSync('sh', ['.githooks/pre-commit'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBun()}:${process.env.PATH}` } })

  test('checks what is staged, not the working tree', () => {
    const dir = hookRepo()
    writeFileSync(join(dir, 'check.txt'), 'bad\n')
    git(dir, 'add', 'check.txt')
    writeFileSync(join(dir, 'check.txt'), 'good\n')
    const result = runHook(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fast checks failed on the staged files')
  })

  test('an untracked file cannot make a staged change pass', () => {
    const dir = hookRepo()
    writeFileSync(join(dir, 'check.txt'), 'bad\n')
    git(dir, 'add', 'check.txt')
    writeFileSync(join(dir, 'extra.txt'), 'good\n')
    expect(runHook(dir).status).toBe(1)
  })

  test('a good staged change passes quietly', () => {
    const dir = hookRepo()
    writeFileSync(join(dir, 'other.txt'), 'x\n')
    git(dir, 'add', 'other.txt')
    const result = runHook(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})

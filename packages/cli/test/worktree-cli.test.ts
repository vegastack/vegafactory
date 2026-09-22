import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorktreeArgs, recordRepoRoot, runWorktree, scriptArgs } from '../src/worktree.ts'

describe('parseWorktreeArgs', () => {
  test('prune previews until --write, and --dry-run always wins', () => {
    expect(parseWorktreeArgs(['create', '106'])).toMatchObject({ verb: 'create', issue: 106, write: true })
    expect(parseWorktreeArgs(['remove', '106'])).toMatchObject({ verb: 'remove', issue: 106, write: true, force: false })
    expect(parseWorktreeArgs(['remove', '--name', '106-old-title'])).toMatchObject({ verb: 'remove', name: '106-old-title', write: true })
    expect(scriptArgs(parseWorktreeArgs(['remove', '--name', '106-old-title']))).toEqual(['remove', '--json', '--name', '106-old-title', '--write'])
    expect(() => parseWorktreeArgs(['remove', '106', '--name', '106-old-title'])).toThrow('either an issue number or --name')
    expect(() => parseWorktreeArgs(['create', '106', '--name', 'x'])).toThrow('--name only applies')
    expect(parseWorktreeArgs(['remove', '106', '--force', '--dry-run'])).toMatchObject({ force: true, write: false })
    expect(parseWorktreeArgs(['prune', '--older-than', '7d'])).toMatchObject({ verb: 'prune', olderThan: '7d', write: false })
    expect(parseWorktreeArgs(['prune', '--write'])).toMatchObject({ verb: 'prune', write: true })
    expect(parseWorktreeArgs(['prune', '--write', '--dry-run'])).toMatchObject({ verb: 'prune', write: false })
    expect(parseWorktreeArgs(['prune', '--dry-run', '--write'])).toMatchObject({ verb: 'prune', write: false })
    expect(scriptArgs(parseWorktreeArgs(['prune']))).not.toContain('--write')
    expect(scriptArgs(parseWorktreeArgs(['prune', '--write']))).toContain('--write')
    expect(() => parseWorktreeArgs(['remove', '106', '--write'])).toThrow('--write only applies to worktree prune')
    expect(parseWorktreeArgs(['list', '--all-repos'])).toMatchObject({ verb: 'list', allRepos: true })
    expect(parseWorktreeArgs(['create', '106'], { VSK_WORKTREE_LAYOUT: 'worker' })).toMatchObject({ workerLayout: true })
  })
  test('an unknown verb is a usage error naming the real ones', () => {
    expect(() => parseWorktreeArgs(['nuke'])).toThrow(/list\|create\|restore\|remove\|prune\|status/)
  })
})

describe('runWorktree', () => {
  test('a blocked script run becomes exit 2 and the blocks reach the user', async () => {
    const calls: string[][] = []
    const spawn = (args: string[]) => {
      calls.push(args)
      return { status: 2, stdout: JSON.stringify({ guard: 'worktree', ok: false, blocks: ['uncommitted changes in the worktree'], warns: [] }) }
    }
    const registryPath = join(mkdtempSync(join(tmpdir(), 'vf-reg-')), 'worktree-roots.json')
    expect(await runWorktree(['remove', '106', '--dry-run'], { spawn, registryPath })).toBe(2)
    expect(calls[0]).toContain('remove')
    expect(calls[0]).not.toContain('--write')
  })
  test('create and restore by issue number reach the script without a slug — the script names the worktree', async () => {
    const calls: string[][] = []
    const spawn = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: JSON.stringify({ guard: 'worktree', ok: true, blocks: [], warns: [], path: '/r/.vegastack/.worktrees/106-x', branch: 'feat/106-x' }) }
    }
    const registryPath = join(mkdtempSync(join(tmpdir(), 'vf-reg-')), 'worktree-roots.json')
    expect(await runWorktree(['create', '106'], { spawn, registryPath })).toBe(0)
    expect(calls[0]).toEqual(['create', '--json', '--issue', '106', '--write'])
    expect(await runWorktree(['restore', '106'], { spawn, registryPath })).toBe(0)
    expect(calls[1]).toEqual(['restore', '--json', '--issue', '106', '--write'])
  })
  test('exact-name legacy removal reaches the script without becoming an issue lookup', async () => {
    const calls: string[][] = []
    const spawn = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: JSON.stringify({ guard: 'worktree', ok: true, blocks: [], warns: [] }) }
    }
    const registryPath = join(mkdtempSync(join(tmpdir(), 'vf-reg-')), 'worktree-roots.json')
    expect(await runWorktree(['remove', '--name', '106-old-title'], { spawn, registryPath })).toBe(0)
    expect(calls[0]).toEqual(['remove', '--json', '--name', '106-old-title', '--write'])
  })
  test('bare prune reaches the script as a preview and explicit write reaches it as a mutation', async () => {
    const calls: string[][] = []
    const spawn = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: JSON.stringify({ guard: 'worktree', ok: true, blocks: [], warns: [], candidates: [] }) }
    }
    const registryPath = join(mkdtempSync(join(tmpdir(), 'vf-reg-')), 'worktree-roots.json')
    expect(await runWorktree(['prune'], { spawn, registryPath })).toBe(0)
    expect(calls[0]).not.toContain('--write')
    expect(await runWorktree(['prune', '--write'], { spawn, registryPath })).toBe(0)
    expect(calls[1]).toContain('--write')
  })
})

describe('recordRepoRoot', () => {
  test('the cross-repo registry dedupes and prunes vanished roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-reg-'))
    const registryPath = join(dir, 'worktree-roots.json')
    writeFileSync(registryPath, JSON.stringify([join(dir, 'gone')]))
    const roots = await recordRepoRoot(registryPath, dir)
    expect(roots).toEqual([dir])
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual([dir])
  })
})

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorktreeArgs, recordRepoRoot, runWorktree } from '../src/worktree.ts'

describe('parseWorktreeArgs', () => {
  test('every verb acts by default and --dry-run previews', () => {
    expect(parseWorktreeArgs(['create', '106'])).toMatchObject({ verb: 'create', issue: 106, write: true })
    expect(parseWorktreeArgs(['remove', '106'])).toMatchObject({ verb: 'remove', issue: 106, write: true, force: false })
    expect(parseWorktreeArgs(['remove', '106', '--force', '--dry-run'])).toMatchObject({ force: true, write: false })
    expect(parseWorktreeArgs(['prune', '--older-than', '7d'])).toMatchObject({ verb: 'prune', olderThan: '7d', write: true })
    expect(() => parseWorktreeArgs(['remove', '106', '--write'])).toThrow('Unknown option: --write')
    expect(parseWorktreeArgs(['list', '--all-repos'])).toMatchObject({ verb: 'list', allRepos: true })
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

// `prune` acts by default and `--dry-run` is what holds it back — the reverse of every other
// write verb, and the reason the reference and the advice both name the bare command.
describe('prune acts, and --dry-run is what holds it back', () => {
  test('the flags mean what the references say they mean', () => {
    expect(() => parseWorktreeArgs(['prune'])).not.toThrow()
    expect(parseWorktreeArgs(['prune']).write).toBe(true)
    // `--write` says what is already true, and is accepted because every reference names it.
    expect(parseWorktreeArgs(['prune', '--write']).write).toBe(true)
    expect(parseWorktreeArgs(['prune', '--write', '--dry-run']).write).toBe(false)
    // A flag the parser does not know is a boolean swallows the next argument. `--write` is in
    // that list, and a prune whose `--write` was eaten silently reclaims nothing.
    const script = readFileSync(join(import.meta.dir, '../../../skills/dev/dev-implement/scripts/worktree.mjs'), 'utf8')
    const booleans = /parseFlags\(argv, \[([^\]]*)\]\)/.exec(script)?.[1] ?? ''
    expect(booleans).toContain("'write'")
    expect(booleans).toContain("'force'")
  })
})

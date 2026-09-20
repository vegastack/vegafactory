import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorktreeArgs, recordRepoRoot, restoreWorktreeDeps, runWorktree, tidyWorktrees } from '../src/worktree.ts'

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

// The seam the unit tests could not reach: `tidyWorktrees` builds an argument list, and the script
// parses it. A flag missing from the parser's boolean list swallows the next argument, which made
// the worker's whole clean-up a silent no-op while every direct test of `pruneWorktrees` passed.
describe('the worker asks for the narrower pass, and the script hears it', () => {
  test('the arguments carry --automatic, --write and the issues in use', () => {
    const seen: string[][] = []
    tidyWorktrees('/repo', {
      write: true, inUse: ['7', '12'],
      spawn: (args) => { seen.push(args); return { status: 0, stdout: '{}' } },
    })
    expect(seen[0]).toEqual(['prune', '--automatic', '--write', '--in-use', '7,12', '--json'])
    // And the worker asks without `--write`, so its pass names what could go and removes nothing.
    // Nothing tells it which checkouts a person is sitting in, so it does not act on a guess.
    const passed: string[][] = []
    tidyWorktrees('/repo', { inUse: ['7'], spawn: (args) => { passed.push(args); return { status: 0, stdout: '{}' } } })
    expect(passed[0]).not.toContain('--write')
    // `--automatic` must be a flag the script treats as a boolean. If it takes a value it eats
    // `--write`, and the pass runs as a dry run that reclaims nothing.
    const script = readFileSync(join(import.meta.dir, '../../../skills/dev/dev-implement/scripts/worktree.mjs'), 'utf8')
    const booleans = /parseFlags\(argv, \[([^\]]*)\]\)/.exec(script)?.[1] ?? ''
    expect(booleans).toContain("'automatic'")
    expect(booleans).toContain("'write'")
  })

  test('nothing in use means no --in-use, and a dry run asks for no write', () => {
    const seen: string[][] = []
    tidyWorktrees('/repo', { spawn: (args) => { seen.push(args); return { status: 0, stdout: '{}' } } })
    expect(seen[0]).toEqual(['prune', '--automatic', '--json'])
  })

  test('restoring a checkout\'s dependencies asks for exactly that, and says whether it happened', () => {
    const seen: string[][] = []
    const yes = restoreWorktreeDeps('/repo', '/repo/.vegastack/.worktrees/7-x', {
      spawn: (args) => { seen.push(args); return { status: 0, stdout: JSON.stringify({ restored: true }) } },
    })
    expect(seen[0]).toEqual(['restore-deps', '--path', '/repo/.vegastack/.worktrees/7-x', '--write', '--json'])
    expect(yes).toBe(true)
    // Nothing was taken from this one, so nothing is put back.
    expect(restoreWorktreeDeps('/repo', '/x', { spawn: () => ({ status: 0, stdout: JSON.stringify({ restored: false }) }) })).toBe(false)
    // Housekeeping never fails a run: the build that follows says it more clearly.
    expect(restoreWorktreeDeps('/repo', '/x', { spawn: () => { throw new Error('gone') } })).toBe(false)
  })

  test('unreadable output is a warning, not a crash in the middle of a pass', () => {
    const result = tidyWorktrees('/repo', { spawn: () => { throw new Error('script missing') } })
    expect(result.warns.join('\n')).toContain('script missing')
    expect(result.freed).toEqual([])
  })
})

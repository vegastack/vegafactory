import { describe, expect, test } from 'bun:test'
import { effectiveConcurrency, planParallelRun, readGroupsReport } from '../scripts/children.mjs'

const groups = [
  { id: 'api', members: ['#131'], files: ['packages/cli/src/dispatch.ts'] },
  { id: 'docs', members: ['#132'], files: ['README.md'] },
]
const issues = {
  131: { number: 131, title: 'Dispatch parent launches', type: 'feat' },
  132: { number: 132, title: 'README rows', type: 'docs' },
}
const base = { issues, parentBranch: 'feat/104-factory-runtime', parentHead: 'abc1234', repoRoot: '/r' }

describe('readGroupsReport', () => {
  test('accepts plan-lint --groups output and rejects anything else', () => {
    expect(readGroupsReport({ guard: 'plan-lint', ok: true, groups })).toEqual(groups)
    expect(() => readGroupsReport({ groups: 'api' })).toThrow(/not plan-lint --groups output/)
    expect(() => readGroupsReport({ groups: [{ id: 'api', members: ['#131'], files: [] }] })).toThrow(/declares no files/)
  })
})

describe('planParallelRun', () => {
  test('two groups plan a parallel run, one child per group, in plan order', () => {
    const run = planParallelRun({ ...base, groups })
    expect(run.mode).toBe('parallel')
    expect(run.children.map((c) => c.issue)).toEqual([131, 132])
    expect(run.children[0].branch).toBe('feat/131-dispatch-parent-launches')
    expect(run.children[0].path).toBe('/r/.vegastack/.worktrees/131-dispatch-parent-launches')
    expect(run.children[0].baseSha).toBe('abc1234')
    expect(run.children[1].files).toEqual(['README.md'])
  })
  test('one group is sequential, with the reason the parent puts in its ledger', () => {
    const run = planParallelRun({ ...base, groups: [groups[0]] })
    expect(run.mode).toBe('sequential')
    expect(run.reason).toContain('one independent group')
    expect(run.ledger).toBe('- Parallel: no — ' + run.reason + '; children run in plan order')
  })
  test('a member with no matching child issue is refused', () => {
    expect(() => planParallelRun({ ...base, groups: [{ id: 'api', members: ['#999'], files: ['a.ts'] }] })).toThrow(/#999/)
  })
})

describe('effectiveConcurrency', () => {
  test('the smallest of the configured cap, the machine, and the 16-agent ceiling', () => {
    expect(effectiveConcurrency({ configured: 4, cpus: 10 })).toBe(4)
    expect(effectiveConcurrency({ configured: null, cpus: 10 })).toBe(8)
    expect(effectiveConcurrency({ configured: 32, cpus: 64 })).toBe(16)
    expect(effectiveConcurrency({ configured: null, cpus: 1 })).toBe(1)
  })
})

import { childPrompt, claudeWorkflowCall, codexChildLaunch } from '../scripts/children.mjs'

describe('launch shapes', () => {
  const run = planParallelRun({ ...base, groups })
  test('the Claude path is one Workflow call by name, children in plan order', () => {
    const call = claudeWorkflowCall(run, { concurrency: 2 })
    expect(call.name).toBe('implement-children')
    expect(call.args.parentBranch).toBe('feat/104-factory-runtime')
    expect(call.args.parentHead).toBe('abc1234')
    expect(call.args.concurrency).toBe(2)
    expect(call.args.children.map((c: { issue: number }) => c.issue)).toEqual([131, 132])
    expect(call.args.children[0].files).toEqual(['packages/cli/src/dispatch.ts'])
    expect(call.args.children[0].prompt).toContain('create your branch feat/131-dispatch-parent-launches from abc1234')
  })
  test('the Codex path is one codex exec per child, pinned to that child worktree', () => {
    const launch = codexChildLaunch(run.children[0], { codex: 'codex', model: 'gpt-5.6', effort: 'high', parentIssue: 104, parentBranch: 'feat/104-factory-runtime' })
    expect(launch.command).toBe('codex')
    expect(launch.args).toEqual([
      'exec', '-C', '/r/.vegastack/.worktrees/131-dispatch-parent-launches',
      '--sandbox', 'workspace-write', '-a', 'never', '--dangerously-bypass-hook-trust',
      '-c', 'model=gpt-5.6', '-c', 'model_reasoning_effort=high',
      '--strict-config', '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
      '--disable', 'memories', '--disable', 'external_agent_memory_import',
      '-c', 'features.context_management.experimental_mode=false', '--enable', 'hooks',
      '-c', 'projects={"/r/.vegastack/.worktrees/131-dispatch-parent-launches"={trust_level="trusted"}}',
      '--json', launch.prompt,
    ])
  })
  test('the prompt names the declared file set and the stop rule', () => {
    const prompt = childPrompt(run.children[1], { parentIssue: 104, parentBranch: 'feat/104-factory-runtime' })
    expect(prompt).toContain('#132')
    expect(prompt).toContain('README.md')
    expect(prompt).toContain('outside that set')
  })
})

import { evaluateJoin, mergeArgs, scopeViolations } from '../scripts/children.mjs'

describe('the join', () => {
  const run = planParallelRun({ ...base, groups })
  test('scope is exact paths plus declared directories', () => {
    expect(scopeViolations(['packages/cli/src/dispatch.ts'], ['packages/cli/src/dispatch.ts'])).toEqual([])
    expect(scopeViolations(['packages/cli/src/index.ts'], ['packages/cli/src/dispatch.ts'])).toEqual(['packages/cli/src/index.ts'])
    expect(scopeViolations(['packages/cli/src/a.ts'], ['packages/cli/'])).toEqual([])
  })
  test('clean children merge in plan order; a wanderer blocks and a failure warns', () => {
    const outcome = evaluateJoin({
      children: run.children,
      results: { 131: { status: 'done', head: 'aaaaaaa' }, 132: { status: 'failed', message: 'tests red' } },
      changed: { 131: ['packages/cli/src/dispatch.ts'], 132: [] },
    })
    expect(outcome.merge.map((m) => m.issue)).toEqual([131])
    expect(outcome.warns.some((w) => w.includes('#132') && w.includes('left in place'))).toBe(true)
    expect(outcome.blocks).toEqual([])
    expect(outcome.ledger[0]).toBe('- Parallel: 2 children — join order #131, #132')
  })
  test('a child outside its declared set is not merged and blocks the join', () => {
    const outcome = evaluateJoin({
      children: run.children,
      results: { 131: { status: 'done', head: 'aaaaaaa' }, 132: { status: 'done', head: 'bbbbbbb' } },
      changed: { 131: ['packages/cli/src/dispatch.ts'], 132: ['README.md', 'packages/cli/src/dispatch.ts'] },
    })
    expect(outcome.merge.map((m) => m.issue)).toEqual([131])
    expect(outcome.blocks.some((b) => b.includes('#132') && b.includes('outside its declared set'))).toBe(true)
  })
  test('the first child fast-forwards; every child behind it takes a real merge', () => {
    // Every child branches from the same parent HEAD, so the first merge advances the
    // parent and the second stops being a descendant. --ff-only for all of them would
    // land child one and refuse the rest.
    expect(mergeArgs(run.children[0], 0)).toEqual(['merge', '--ff-only', run.children[0].branch])
    expect(mergeArgs(run.children[1], 1)).toEqual(['merge', '--no-ff', '--no-edit', run.children[1].branch])
  })
})

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('the children.mjs command line', () => {
  const script = join(import.meta.dir, '../scripts/children.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'vsk-children-'))
  const report = join(dir, 'groups.json')
  writeFileSync(report, JSON.stringify({ guard: 'plan-lint', ok: true, groups }))

  test('plan is dry-run, prints the run plan, and exits 0', () => {
    const r = Bun.spawnSync(['node', script, 'plan', '--parent', '104', '--groups', report, '--json'])
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout.toString())
    expect(out.guard).toBe('children')
    expect(out.plan.mode).toBe('parallel')
    expect(out.plan.children.map((c: { issue: number }) => c.issue)).toEqual([131, 132])
    expect(out.wrote).toBe(false)
  })
  test('a missing groups report blocks with a reason and exits 2', () => {
    const r = Bun.spawnSync(['node', script, 'plan', '--parent', '104', '--groups', join(dir, 'absent.json'), '--json'])
    expect(r.exitCode).toBe(2)
    expect(JSON.parse(r.stdout.toString()).blocks.join(' ')).toContain('groups report')
  })
  test('a symlinked groups report is refused', () => {
    const link = join(dir, 'linked.json')
    symlinkSync(report, link)
    const r = Bun.spawnSync(['node', script, 'plan', '--parent', '104', '--groups', link, '--json'])
    expect(r.exitCode).toBe(2)
    expect(JSON.parse(r.stdout.toString()).blocks.join(' ')).toContain('symlink')
  })
  test('an unknown verb prints the usage line and exits 2', () => {
    const r = Bun.spawnSync(['node', script, 'sprint', '--json'])
    expect(r.exitCode).toBe(2)
    expect(r.stdout.toString()).toContain('usage: children.mjs')
  })
})

describe('one wanderer never strands its siblings', () => {
  test('the clean child is still in the merge list when another child left its set', () => {
    const run = planParallelRun({ ...base, groups })
    const outcome = evaluateJoin({
      children: run.children,
      results: { 131: { status: 'done', head: 'aaaaaaa' }, 132: { status: 'done', head: 'bbbbbbb' } },
      changed: { 131: ['packages/cli/src/dispatch.ts'], 132: ['packages/cli/src/dispatch.ts'] },
    })
    expect(outcome.merge.map((m) => m.issue)).toEqual([131])
    expect(outcome.stop.map((s) => s.issue)).toEqual([132])
    expect(outcome.ledger).toContain('- Join: #131 merged aaaaaaa')
  })
  test('a failed child is a warn and the other still merges', () => {
    const run = planParallelRun({ ...base, groups })
    const outcome = evaluateJoin({
      children: run.children,
      results: { 131: { status: 'failed', message: 'tests red' }, 132: { status: 'done', head: 'bbbbbbb' } },
      changed: { 131: [], 132: ['README.md'] },
    })
    expect(outcome.merge.map((m) => m.issue)).toEqual([132])
    expect(outcome.blocks).toEqual([])
  })
})

describe('the join against real git', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vsk-join-'))
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', repo, ...args])
    return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() }
  }

  test('two children cut from one base both land at the parent tip', () => {
    git('init', '-q', '-b', 'parent')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'test')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'base')

    // Both children branch from the SAME parent HEAD — that is what a parallel run
    // does, and what makes --ff-only wrong for everyone after the first.
    for (const [branch, file] of [['child-a', 'a.txt'], ['child-b', 'b.txt']]) {
      git('switch', '-q', 'parent')
      git('switch', '-q', '-c', branch)
      writeFileSync(join(repo, file), branch + '\n')
      git('add', '-A')
      git('commit', '-qm', branch)
    }
    git('switch', '-q', 'parent')

    const children = [{ branch: 'child-a' }, { branch: 'child-b' }]
    for (const [index, child] of children.entries()) {
      expect(git(...mergeArgs(child, index)).ok).toBe(true)
    }
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    expect(existsSync(join(repo, 'b.txt'))).toBe(true)
  })
})

import { chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// A group carrying two children would run them at the same time on ONE file set —
// the disjointness the whole parallel run rests on. One child per group, or the
// run does not plan.
describe('one child per group', () => {
  test('a group naming two children is refused, not split into two concurrent children', () => {
    const shared = [
      { id: 'api', members: ['#131', '#132'], files: ['packages/cli/src/dispatch.ts'] },
      { id: 'docs', members: ['#133'], files: ['docs/dispatcher.md'] },
    ]
    const three = { ...issues, 133: { number: 133, title: 'Docs', type: 'docs' } }
    expect(() => planParallelRun({ ...base, issues: three, groups: shared })).toThrow(/one child/)
  })
})

// The write verbs against real git, driven the way the parent drives them: the
// script as a process, gh through the VSK_GH seam.
const script = join(import.meta.dir, '../scripts/children.mjs')
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function parentRepo() {
  const root = mkdtempSync(join(tmpdir(), 'vsk-children-git-'))
  sh(root, 'init', '-q', '-b', 'feat/104-factory-runtime')
  sh(root, 'config', 'user.email', 'test@example.test')
  sh(root, 'config', 'user.name', 'test')
  writeFileSync(join(root, 'base.txt'), 'base\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-qm', 'base')
  return root
}
// gh as the script calls it: `gh issue view <n> --repo <o/r> --json number,title`.
function ghStub(titles: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'vsk-gh-'))
  const bin = join(dir, 'gh')
  const cases = Object.entries(titles)
    .map(([n, title]) => '  ' + n + ') printf \'%s\' \'' + JSON.stringify({ number: Number(n), title }) + '\';;')
    .join('\n')
  writeFileSync(bin, '#!/bin/sh\ncase "$3" in\n' + cases + '\n  *) echo "no such issue" >&2; exit 1;;\nesac\n')
  chmodSync(bin, 0o755)
  return bin
}
function runCli(root: string, gh: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...args, '--repo-root', root, '--json'], {
    cwd: root, env: { ...process.env, VSK_GH: gh },
  })
  return { status: r.exitCode, out: JSON.parse(r.stdout.toString()) }
}
const joinGroups = [
  { id: 'api', members: ['#131'], files: ['packages/cli/src/dispatch.ts'] },
  { id: 'docs', members: ['#132'], files: ['docs/dispatcher.md'] },
]
const titles = { 131: 'feat: Dispatch parent launches', 132: 'docs: README rows' }

describe('a write verb never acts on a guessed branch name', () => {
  test('launch --write with GitHub unreachable blocks and creates no worktree', () => {
    const root = parentRepo()
    const report = join(root, 'groups.json')
    writeFileSync(report, JSON.stringify({ guard: 'plan-lint', ok: true, groups: joinGroups }))
    const r = runCli(root, '/nonexistent-vsk-gh', 'launch', '--parent', '104', '--groups', report, '--repo', 'o/r', '--harness', 'codex', '--write')
    expect(r.status).toBe(2)
    expect(r.out.blocks.join(' ')).toContain('#131')
    expect(r.out.wrote).toBe(false)
    expect(existsSync(join(root, '.vegastack/.worktrees'))).toBe(false)
    expect(sh(root, 'branch', '--list', 'feat/131-*')).toBe('')
  })
  test('plan --repo with GitHub unreachable still previews, with a warning', () => {
    const root = parentRepo()
    const report = join(root, 'groups.json')
    writeFileSync(report, JSON.stringify({ guard: 'plan-lint', ok: true, groups: joinGroups }))
    const r = runCli(root, '/nonexistent-vsk-gh', 'plan', '--parent', '104', '--groups', report, '--repo', 'o/r')
    expect(r.status).toBe(1)
    expect(r.out.plan.children.map((c: { issue: number }) => c.issue)).toEqual([131, 132])
  })
})

describe('the join verb against real git', () => {
  // Two children cut from the parent HEAD. #131 lands on the branch its harness
  // chose, not the planned name, and says so in its result; #132 wanders.
  function twoChildren(root: string) {
    const baseSha = sh(root, 'rev-parse', 'HEAD')
    const commit = (branch: string, files: Record<string, string>) => {
      sh(root, 'switch', '-q', '-c', branch, baseSha)
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(join(root, file, '..'), { recursive: true })
        writeFileSync(join(root, file), text)
      }
      sh(root, 'add', '-A')
      sh(root, 'commit', '-qm', branch)
      const head = sh(root, 'rev-parse', 'HEAD')
      sh(root, 'switch', '-q', 'feat/104-factory-runtime')
      return head
    }
    const a = commit('agent/131-dispatch', { 'packages/cli/src/dispatch.ts': 'a\n' })
    const b = commit('docs/132-readme-rows', { 'docs/dispatcher.md': 'b\n', 'packages/cli/src/index.ts': 'wandered\n' })
    const report = join(root, 'groups.json')
    writeFileSync(report, JSON.stringify({ guard: 'plan-lint', ok: true, groups: joinGroups }))
    return { report, a, b }
  }
  const results = (root: string, entries: object[]) => {
    const file = join(root, 'results.json')
    writeFileSync(file, JSON.stringify(entries))
    return file
  }

  test('the branch each child reports is the one diffed and merged; a wanderer blocks without stranding its sibling', () => {
    const root = parentRepo()
    const { report, a, b } = twoChildren(root)
    const file = results(root, [
      { issue: 131, status: 'done', branch: 'agent/131-dispatch', head: a, files: ['packages/cli/src/dispatch.ts'], message: 'built' },
      { issue: 132, status: 'done', branch: 'docs/132-readme-rows', head: b, files: ['docs/dispatcher.md', 'packages/cli/src/index.ts'], message: 'built' },
    ])
    const r = runCli(root, ghStub(titles), 'join', '--parent', '104', '--groups', report, '--repo', 'o/r', '--results', file, '--write')
    expect(r.status).toBe(2)
    expect(r.out.blocks.join(' ')).toContain('#132')
    expect(r.out.blocks.join(' ')).toContain('outside its declared set')
    expect(r.out.join.merge).toEqual([{ issue: 131, branch: 'agent/131-dispatch' }])
    expect(existsSync(join(root, 'packages/cli/src/dispatch.ts'))).toBe(true)
    expect(existsSync(join(root, 'docs/dispatcher.md'))).toBe(false)
    expect(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/104-factory-runtime')
    // A merge landed, so the run says it wrote — even though a sibling blocked.
    expect(r.out.wrote).toBe(true)
    expect(r.out.join.ledger).toContain('- Join: #131 merged ' + a.slice(0, 7))
  })
  test('a child whose diff cannot be read is not merged, is not written up as merged, and holds every merge', () => {
    const root = parentRepo()
    const { report, b } = twoChildren(root)
    const file = results(root, [
      { issue: 131, status: 'done', branch: 'agent/131-vanished', head: 'f00ba12', files: [], message: 'built' },
      { issue: 132, status: 'done', branch: 'docs/132-readme-rows', head: b, files: ['docs/dispatcher.md'], message: 'built' },
    ])
    const r = runCli(root, ghStub(titles), 'join', '--parent', '104', '--groups', report, '--repo', 'o/r', '--results', file, '--write')
    expect(r.status).toBe(2)
    expect(r.out.blocks.join(' ')).toContain('scope cannot be proved')
    expect(r.out.join.merge.map((m: { issue: number }) => m.issue)).not.toContain(131)
    expect(r.out.join.ledger.some((line: string) => line.startsWith('- Join: #131 merged'))).toBe(false)
    expect(r.out.wrote).toBe(false)
    expect(existsSync(join(root, 'docs/dispatcher.md'))).toBe(false)
  })
  test('a reported branch that is not a branch name is refused before any git call', () => {
    const root = parentRepo()
    const { report, b } = twoChildren(root)
    const file = results(root, [
      { issue: 131, status: 'done', branch: '--squash', head: 'f00ba12', files: [], message: 'built' },
      { issue: 132, status: 'done', branch: 'docs/132-readme-rows', head: b, files: ['docs/dispatcher.md'], message: 'built' },
    ])
    const r = runCli(root, ghStub(titles), 'join', '--parent', '104', '--groups', report, '--repo', 'o/r', '--results', file, '--write')
    expect(r.status).toBe(2)
    expect(r.out.blocks.join(' ')).toContain('not a branch name')
    expect(r.out.wrote).toBe(false)
  })
  test('join --write with GitHub unreachable blocks and merges nothing', () => {
    const root = parentRepo()
    const { report } = twoChildren(root)
    const r = runCli(root, '/nonexistent-vsk-gh', 'join', '--parent', '104', '--groups', report, '--repo', 'o/r', '--write')
    expect(r.status).toBe(2)
    expect(r.out.wrote).toBe(false)
    expect(existsSync(join(root, 'packages/cli/src/dispatch.ts'))).toBe(false)
  })
})


test('legacy launch refuses without creating children while the checked gateway is unavailable', () => {
  for (const harness of ['claude', 'codex']) {
    const root = parentRepo()
    const before = sh(root, 'rev-parse', 'HEAD')
    const report = join(root, 'groups.json')
    writeFileSync(report, JSON.stringify({ guard: 'plan-lint', ok: true, groups: joinGroups }))
    const result = runCli(root, ghStub(titles), 'launch', '--parent', '104', '--groups', report, '--repo', 'o/r', '--harness', harness, '--write')
    expect(result.status).toBe(2)
    expect(result.out.wrote).toBe(false)
    expect(result.out.blocks.join(' ')).toContain('checked CLI gateway')
    expect(existsSync(join(root, '.vegastack/.worktrees'))).toBe(false)
    expect(sh(root, 'branch', '--list', 'feat/131-*')).toBe('')
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(before)
  }
})

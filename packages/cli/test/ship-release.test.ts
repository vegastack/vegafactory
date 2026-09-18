import { beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhRunner } from '../src/gh.ts'
import { ackBody, artifactHash } from '../src/issue.ts'
import { runShip } from '../src/ship.ts'
import { FakeGitHub } from './fake-github.ts'

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout.trim()

let gh: FakeGitHub
let root: string
const runner: GhRunner = (args, input) => gh.runner(args, input)

const shipIt = () => gh.addComment(7, ackBody({ stage: 'ship', by: 'mk', brief: artifactHash('Cut 1.2.0'), plan: null, source: 'session', quote: 'ship it' }))

const run = (...extra: string[]) => {
  const lines: string[] = []
  const code = runShip(['release', '7', '--json', ...extra], { runner, cwd: root, out: (line) => lines.push(line) })
  return { code, ...JSON.parse(lines.join('\n')) as { blocks: string[]; ok: boolean; tag: string | null; version: string | null; pushed: boolean } }
}

const write = (file: string, text: string) => writeFileSync(join(root, file), text)
const commit = (message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message); git(root, 'push', '-q', 'origin', 'main') }

beforeEach(() => {
  gh = new FakeGitHub()
  gh.permissions.set('mk', 'admin')
  // `small` so the ship ack needs no plan comment; the brief is what the ack binds to.
  gh.addIssue({ number: 7, body: 'Cut 1.2.0', labels: ['ready-to-ship', 'small'] })
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'release-')))
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'origin.git'))
  root = join(base, 'repo')
  git(base, 'clone', '-q', join(base, 'origin.git'), root)
  mkdirSync(join(root, '.vegastack'))
  write('.vegastack/dev.md', 'repo: o/r\n')
  write('.gitignore', '.vegastack/.tmp/\n')
  write('package.json', JSON.stringify({ name: 'thing', version: '1.2.0' }))
  write('CHANGELOG.md', '# Changelog\n\n## 1.2.0\n\n- it ships\n')
  commit('release 1.2.0')
  git(root, 'remote', 'set-head', 'origin', '--auto')
})

test('tags and pushes on a recorded ship it, and never twice', () => {
  shipIt()
  expect(run('--dry-run')).toMatchObject({ code: 0, ok: true, version: '1.2.0', tag: 'v1.2.0', pushed: false })
  expect(git(root, 'tag', '--list')).toBe('')

  expect(run()).toMatchObject({ code: 0, ok: true, tag: 'v1.2.0', pushed: true })
  expect(git(root, 'tag', '--list')).toBe('v1.2.0')
  expect(git(root, 'ls-remote', '--tags', 'origin', 'v1.2.0')).toContain('refs/tags/v1.2.0')
  // The tag is annotated, so the release commit carries a message of its own.
  expect(git(root, 'cat-file', '-t', 'v1.2.0')).toBe('tag')

  expect(run().blocks).toEqual(['v1.2.0 already exists here — a released version is never re-tagged, fix forward with a new one'])
  git(root, 'tag', '-d', 'v1.2.0')
  expect(run().blocks).toEqual(['v1.2.0 is already on origin — a released version is never re-tagged, fix forward with a new one'])
})

test('refuses without the operator word, and the refusal writes nothing', () => {
  const result = run()
  expect(result.code).toBe(2)
  expect(result.blocks).toEqual(['no "ship it" on #7: no ship ack yet'])
  expect(git(root, 'tag', '--list')).toBe('')

  // An ack from someone without write access is not the operator's word either.
  gh.addComment(7, ackBody({ stage: 'ship', by: 'drive-by', brief: artifactHash('Cut 1.2.0'), plan: null, source: 'session', quote: 'ship it' }), 'drive-by')
  expect(run().blocks).toEqual(['no "ship it" on #7: @drive-by has no write access'])

  // So is a brief that moved after the word.
  shipIt()
  gh.editBody(7, 'Cut 1.2.0, with the docs')
  expect(run().blocks).toEqual(['no "ship it" on #7: the brief changed after the ship ack'])
})

test('refuses when the version or the changelog does not match', () => {
  shipIt()
  write('CHANGELOG.md', '# Changelog\n\n## 1.1.0\n\n- the one before\n')
  commit('drop the entry')
  expect(run().blocks).toEqual(['CHANGELOG.md has no entry for 1.2.0 — run the version step before tagging'])

  rmSync(join(root, 'CHANGELOG.md'))
  commit('drop the changelog')
  expect(run().blocks).toEqual(['no CHANGELOG.md beside the released package or at the repository root — 1.2.0 has no record to release'])

  write('CHANGELOG.md', '# Changelog\n\n## [v1.2.0] - 2026-09-18\n\n- it ships\n')
  commit('a generator spells the heading its own way')
  expect(run()).toMatchObject({ ok: true, version: '1.2.0' })

  // A named version that no package is at is a refusal, not a tag of the caller's choosing.
  expect(run('--version', '9.9.9').blocks).toEqual(['no package in this repository is at 9.9.9 — found 1.2.0'])
})

test('two versions in one repository need the one to release named', () => {
  shipIt()
  mkdirSync(join(root, 'packages/other'), { recursive: true })
  write('packages/other/package.json', JSON.stringify({ name: 'other', version: '3.0.0' }))
  write('packages/other/CHANGELOG.md', '# Changelog\n\n## 3.0.0\n\n- the other one\n')
  commit('a second package')
  expect(run().blocks).toEqual(['this repository holds more than one version (1.2.0, 3.0.0) — name the one to release with --version'])
  expect(run('--version', '3.0.0', '--dry-run')).toMatchObject({ ok: true, tag: 'v3.0.0' })

  // The workspace placeholder nobody bumps is not a release candidate.
  write('package.json', JSON.stringify({ name: 'workspace', private: true, version: '0.0.0' }))
  commit('privatise the root')
  expect(run('--dry-run')).toMatchObject({ ok: true, version: '3.0.0' })
})

test('the tag goes on the merged release commit, so the default branch must be checked out, clean and level', () => {
  shipIt()
  write('stray.txt', 'x')
  expect(run().blocks).toEqual(['main has uncommitted changes'])
  rmSync(join(root, 'stray.txt'))

  git(root, 'switch', '-q', '-c', 'chore/release-1.2.0')
  expect(run().blocks).toEqual(['a release is tagged on main, but chore/release-1.2.0 is checked out'])
  git(root, 'switch', '-q', 'main')

  git(root, 'commit', '-q', '--allow-empty', '-m', 'unpushed')
  expect(run().blocks.at(0)).toMatch(/^HEAD is at [0-9a-f]+ but origin\/main is at [0-9a-f]+ — pull the merged release commit$/)
  expect(git(root, 'tag', '--list')).toBe('')
})

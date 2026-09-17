#!/usr/bin/env node
// Runs only the tests a change can affect: bun's import-graph selection (`--changed`)
// plus the rules in tooling/test-map.json for what imports cannot see. Each test file
// runs at most once.
//
//   node tooling/test-affected.mjs [--base <ref>] [--list]
//
// The change set is everything that differs from the merge base with <ref>
// (default origin/main): commits, staged and unstaged edits, deletions and untracked files.
// A deleted code file runs the full suite, because bun cannot trace imports of a file
// that no longer exists.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SUITE = ['./packages', './skills', './tooling', './scripts']
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs)$|_(test|spec)_/
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|json)$/

export function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

// Returns { full, reason, tests }: whether to run everything, and the extra test paths the map adds.
export function selectTests(changed, map, deleted = []) {
  const full = map.full.map(globToRegExp)
  const trigger = changed.find((file) => full.some((re) => re.test(file)))
  if (trigger) return { full: true, reason: `${trigger} changed`, tests: [] }
  const gone = deleted.find((file) => CODE_FILE.test(file) && !TEST_FILE.test(file))
  if (gone) return { full: true, reason: `${gone} was deleted`, tests: [] }
  const tests = new Set()
  for (const rule of map.rules) {
    const re = globToRegExp(rule.match)
    for (const file of changed) {
      if (!re.test(file)) continue
      const skill = file.split('/').slice(0, 3).join('/')
      for (const target of rule.tests) tests.add(target.replace('{skill}', skill))
    }
  }
  return { full: false, reason: null, tests: [...tests].sort() }
}

// Test files under the given paths (files or folders), relative to the repo root.
export function expandTests(paths, base = root) {
  const found = new Set()
  const walk = (path) => {
    const absolute = join(base, path)
    if (!existsSync(absolute)) return
    if (statSync(absolute).isFile()) { if (TEST_FILE.test(path)) found.add(path); return }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(join(path, entry.name))
    }
  }
  for (const path of paths) walk(path)
  return [...found].sort()
}

// The test files a bun JUnit report says ran.
export function junitFiles(xml) {
  return [...new Set([...xml.matchAll(/<testsuite\b[^>]*\bfile="([^"]+)"/g)].map((match) => match[1]))]
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function run(args) {
  console.log(`$ bun ${args.join(' ')}`)
  const result = spawnSync('bun', args, { cwd: root, stdio: 'inherit' })
  return result.status ?? 1
}

const lines = (text) => text.split('\n').filter(Boolean)

function main(argv) {
  const baseIndex = argv.indexOf('--base')
  const base = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1]
  if (!base) throw new Error('--base needs a git ref, e.g. --base origin/main')
  const mergeBase = git(['merge-base', base, 'HEAD'])
  const changed = [...new Set([
    ...lines(git(['diff', '--name-only', mergeBase])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ])]
  const deleted = lines(git(['diff', '--name-only', '--diff-filter=D', mergeBase]))
  const map = JSON.parse(readFileSync(join(root, 'tooling/test-map.json'), 'utf8'))
  const selection = selectTests(changed, map, deleted)
  const extra = expandTests(selection.tests)

  if (argv.includes('--list')) {
    console.log(JSON.stringify({ base, mergeBase, changed, deleted, ...selection, extra }, null, 2))
    return 0
  }
  if (changed.length === 0) {
    console.log('No changes against the base — nothing to test.')
    return 0
  }
  if (selection.full) {
    console.log(`Running the full suite: ${selection.reason}.`)
    return run(['test', ...SUITE])
  }
  // Graph-selected files run first; mapped files that already ran are skipped.
  const scratch = mkdtempSync(join(tmpdir(), 'test-affected-'))
  try {
    const report = join(scratch, 'junit.xml')
    let status = run(['test', `--changed=${mergeBase}`, '--pass-with-no-tests', '--reporter=junit', `--reporter-outfile=${report}`, ...SUITE])
    const ran = new Set(existsSync(report) ? junitFiles(readFileSync(report, 'utf8')).map((file) => relative(root, join(root, file))) : [])
    const remaining = extra.filter((file) => !ran.has(file))
    if (remaining.length) status = run(['test', ...remaining.map((file) => `./${file}`)]) || status
    return status
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`test-affected: ${error.message}`)
    process.exit(2)
  }
}

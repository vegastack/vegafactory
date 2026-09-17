#!/usr/bin/env node
// Runs only the tests a change can affect: bun's import-graph selection (`--changed`)
// plus the rules in tooling/test-map.json for what imports cannot see.
//
//   node tooling/test-affected.mjs [--base <ref>] [--list]
//
// The change set is everything that differs from the merge base with <ref>
// (default origin/main): commits, staged and unstaged edits, and untracked files.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SUITE = ['./packages', './skills', './tooling', './scripts']

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

// Returns { full: true } or { tests: [...] } — the extra test paths the map adds.
export function selectTests(changed, map) {
  const full = map.full.map(globToRegExp)
  if (changed.some((file) => full.some((re) => re.test(file)))) return { full: true, tests: [] }
  const tests = new Set()
  for (const rule of map.rules) {
    const re = globToRegExp(rule.match)
    for (const file of changed) {
      if (!re.test(file)) continue
      const skill = file.split('/').slice(0, 3).join('/')
      for (const target of rule.tests) tests.add(target.replace('{skill}', skill))
    }
  }
  return { full: false, tests: [...tests].sort() }
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

function main(argv) {
  const baseIndex = argv.indexOf('--base')
  const base = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1]
  if (!base) throw new Error('--base needs a git ref, e.g. --base origin/main')
  const mergeBase = git(['merge-base', base, 'HEAD'])
  const changed = [...new Set([
    ...git(['diff', '--name-only', mergeBase]).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean))]
  const map = JSON.parse(readFileSync(join(root, 'tooling/test-map.json'), 'utf8'))
  const selection = selectTests(changed, map)
  const extra = selection.tests.filter((path) => existsSync(join(root, path))).map((path) => `./${path}`)

  if (argv.includes('--list')) {
    console.log(JSON.stringify({ base, mergeBase, changed, full: selection.full, extra }, null, 2))
    return 0
  }
  if (changed.length === 0) {
    console.log('No changes against the base — nothing to test.')
    return 0
  }
  if (selection.full) return run(['test', ...SUITE])
  // --changed follows imports from the changed files; the extra paths cover what imports miss.
  let status = run(['test', `--changed=${mergeBase}`, '--pass-with-no-tests', ...SUITE])
  if (extra.length) status = run(['test', ...extra]) || status
  return status
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`test-affected: ${error.message}`)
    process.exit(2)
  }
}

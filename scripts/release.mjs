#!/usr/bin/env node
// Release helper for @vegastack/vegafactory. The merge queue already ran the full suite on the
// exact commit being tagged, so a release only builds, packs, smokes and publishes.
//
//   node scripts/release.mjs check-tag <tag>        tag matches package.json; changelog has the entry
//   node scripts/release.mjs notes <out-file>       write this version's changelog entry
//   node scripts/release.mjs pack <dir>             build and npm-pack the CLI into <dir>; prints the tarball path
//   node scripts/release.mjs verify <tarball> <sha512-integrity>   the tarball is byte-identical to the smoked one
//   node scripts/release.mjs smoke <tarball|spec>   install into a temp dir and exercise the installer
//   node scripts/release.mjs wait-registry          poll npm until this version is visible, then smoke it
//   node scripts/release.mjs validate               prepack guard: the build output exists
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE = '@vegastack/vegafactory'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = join(root, 'packages/cli')

export function version(dir = cliDir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
}

// The changelog section for one version: the lines between `## <version>` and the next `## `.
export function changelogEntry(text, wanted) {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${wanted}`)
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

export function checkTag(tag, current, changelog) {
  if (tag !== `v${current}`) throw new Error(`tag ${tag} does not match packages/cli/package.json version ${current}`)
  if (!changelogEntry(changelog, current)) throw new Error(`packages/cli/CHANGELOG.md has no entry for ${current} — run bunx changeset version before tagging`)
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-2000)}`)
  }
  return result.stdout.trim()
}

export function pack(outDir) {
  mkdirSync(resolve(outDir), { recursive: true })
  run('bun', ['run', 'build'], { cwd: cliDir, stdio: ['ignore', 'pipe', 'pipe'] })
  const json = run('npm', ['pack', '--json', '--pack-destination', resolve(outDir)], { cwd: cliDir })
  const [info] = JSON.parse(json)
  return { tarball: join(resolve(outDir), info.filename), integrity: info.integrity, version: info.version }
}

export function integrityOf(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
}

export function verify(file, expected) {
  const got = integrityOf(file)
  if (!expected || got !== expected) throw new Error(`${file} integrity ${got} does not match ${expected || '(none)'}`)
}

// Installs the package the way a user does, then runs the installer against a scratch project.
export function smoke(spec, expectedVersion) {
  // The installer refuses symlinked path components, and macOS's temp dir sits behind /var -> /private/var.
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'vegafactory-smoke-'))
  try {
    const prefix = join(home, 'prefix')
    const project = join(home, 'project')
    run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', spec])
    const bin = join(prefix, 'node_modules/.bin/vegafactory')
    const env = { ...process.env, HOME: home }
    const got = run(bin, ['--version'], { env })
    if (expectedVersion && got !== expectedVersion) throw new Error(`installed version ${got}, expected ${expectedVersion}`)
    const list = run(bin, ['skills', 'list'], { env })
    if (!list.includes('dev-plan')) throw new Error('skills list does not show the dev skills')
    run(bin, ['skills', 'add', '--group', 'dev', '--project', '--dir', project, '--agent', 'both', '--non-interactive'], { env })
    run(bin, ['skills', 'verify', '--group', 'dev', '--project', '--dir', project, '--agent', 'both'], { env })
    const installed = readdirSync(join(project, '.claude/skills'))
    if (!installed.includes('dev-plan')) throw new Error('dev skills were not installed')
    return { version: got, skills: installed.length }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

export async function waitRegistry(wanted, { attempts = 60, delayMs = 10_000, view = defaultView, sleep } = {}) {
  const pause = sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (view(wanted) === wanted) return attempt
    await pause(delayMs)
  }
  throw new Error(`${PACKAGE}@${wanted} is not visible on the registry after ${attempts} attempts`)
}

function defaultView(wanted) {
  const result = spawnSync('npm', ['view', `${PACKAGE}@${wanted}`, 'version'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

async function main([verb, arg, extra]) {
  const current = version()
  if (verb === 'check-tag') return checkTag(arg, current, readFileSync(join(cliDir, 'CHANGELOG.md'), 'utf8'))
  if (verb === 'notes') return writeFileSync(arg, changelogEntry(readFileSync(join(cliDir, 'CHANGELOG.md'), 'utf8'), current) + '\n')
  if (verb === 'pack') return console.log(JSON.stringify(pack(arg ?? join(root, 'work/packed'))))
  if (verb === 'verify') return verify(arg, extra)
  if (verb === 'smoke') return console.log(JSON.stringify(smoke(resolve(arg), current)))
  if (verb === 'wait-registry') {
    await waitRegistry(current)
    return console.log(JSON.stringify(smoke(`${PACKAGE}@${current}`, current)))
  }
  if (verb === 'validate') {
    for (const path of ['dist/index.js', 'skill', 'skill-integrity.json']) {
      if (!existsSync(join(cliDir, path))) throw new Error(`packages/cli/${path} is missing — run bun run build first`)
    }
    return
  }
  throw new Error('usage: release.mjs check-tag <tag> | notes <file> | pack <dir> | verify <tarball> <integrity> | smoke <tarball> | wait-registry | validate')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`release: ${error.message}`)
    process.exit(1)
  })
}

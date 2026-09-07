#!/usr/bin/env node
// Ship-guard policy compiler: dev.md's declared intent → the enforcement copy the guard reads.
//
// The ship guard (assets/hooks/ship-guard.mjs) never reads dev.md. It reads one file,
// ~/.vegastack/guard/<owner>__<repo>.json — outside every worktree, so no task edits it and
// no commit carries it. This script writes that file from dev.md's `## Environments` policy
// lines, the `gates:` knob, the `repo:` line's default branch and the backticked commands on
// the `## Ship` runbook's `ask:` lines. dev-setup runs it on the operator's yes;
// `vegafactory guard sync` wraps it; the SessionStart hook runs `--check` to warn.
//
//   node ship-policy.mjs [--dev-md PATH] [--repo owner/repo] [--policy PATH] [--check] [--write] [--json]
//
// Dry run by default: prints what it would write and changes nothing. --write writes the file
// (atomically, temp file + rename). --check compares the stored file with what dev.md compiles
// to now and exits 2 when they differ or the file is missing. `owner/repo` comes from the
// checkout's origin remote unless --repo names it; --policy overrides the home-directory path.
//
// Exit codes: 0 fresh, written, or dry run · 2 stale (--check) or a refusal (no dev.md, no repo).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { policyPath, repoFromRemote } from '../assets/hooks/ship-guard.mjs'
import { loadConfiguredPolicy, parsePolicy, policyHash, resolvePolicy } from './effective-policy.mjs'

const DEFAULTS = { defaultBranch: 'main', gates: 3 }

function sectionOf(text, heading) {
  const parts = text.split(new RegExp('^' + heading + '.*$', 'm'))
  if (parts.length < 2) return ''
  return parts[1].split(/^## /m)[0]
}

// The action grammar stays local to this profile; defaults/authority/provenance use the owner.
// A malformed known value refuses compilation and preserves the previous enforcement copy.
export function compilePolicy(devMdText, { repo, org = '', group = '', identity = {}, freshness = {}, resolved: supplied = null }) {
  const resolved = supplied ?? resolvePolicy({ org, group, repo: devMdText, identity: { repo, ...identity }, freshness })
  if (!resolved.ok) throw new Error(resolved.blocks.join('; '))
  const text = parsePolicy(devMdText, 'repo').lines.join('\n')
  const branch = text.match(/^repo:.*default branch (\S+)/m)
  const environments = []
  for (const line of sectionOf(text, '## Environments').split('\n')) {
    const match = line.match(/^- ([\w][\w-]*): (auto|ask) — (.+)$/)
    if (match) environments.push({ target: match[1], policy: match[2], pattern: match[3].trim() })
  }
  // An `ask:` step is prose for the operator; only a command it names in backticks is a
  // pattern the guard can match.
  const shipAsk = []
  for (const line of sectionOf(text, '## Ship').split('\n')) {
    const match = line.match(/^- ask: (.+)$/)
    if (!match) continue
    for (const span of match[1].matchAll(/`([^`]+)`/g)) {
      const command = span[1].trim()
      if (command && !shipAsk.includes(command)) shipAsk.push(command)
    }
  }
  return {
    schemaVersion: 2,
    repo: String(repo),
    policyDigest: resolved.policy.policyDigest,
    sources: resolved.policy.sources,
    defaultBranch: branch ? branch[1] : DEFAULTS.defaultBranch,
    gates: resolved.policy.values.gates ?? DEFAULTS.gates,
    environments,
    shipAsk,
  }
}

function describeEnvironments(entries) {
  return entries.map((entry) => `${entry.target}: ${entry.policy} — ${entry.pattern}`)
}

// Whether the stored file still says what dev.md compiles to. Only the policy fields count,
// so a re-compile that changes nothing but the timestamp is never drift.
export function staleness(storedText, compiled) {
  if (typeof storedText !== 'string') return { stale: true, reason: 'the policy file is missing' }
  let stored
  try {
    stored = JSON.parse(storedText)
  } catch {
    return { stale: true, reason: 'the policy file is not valid JSON' }
  }
  if (!stored || typeof stored !== 'object') return { stale: true, reason: 'the policy file is not a JSON object' }
  const drift = []
  if (stored.schemaVersion !== compiled.schemaVersion) drift.push(`schemaVersion ${JSON.stringify(stored.schemaVersion)} → ${compiled.schemaVersion}`)
  if (stored.repo !== compiled.repo) drift.push(`repo ${JSON.stringify(stored.repo)} → ${compiled.repo}`)
  if (stored.policyDigest !== compiled.policyDigest) drift.push('effective policy digest changed')
  if (policyHash(stored.sources ?? {}) !== policyHash(compiled.sources)) drift.push('effective policy sources changed')
  if (stored.defaultBranch !== compiled.defaultBranch) drift.push(`default branch ${JSON.stringify(stored.defaultBranch)} → ${compiled.defaultBranch}`)
  if (stored.gates !== compiled.gates) drift.push(`gates ${JSON.stringify(stored.gates)} → ${compiled.gates}`)
  const before = describeEnvironments(Array.isArray(stored.environments) ? stored.environments.filter((entry) => entry && typeof entry === 'object') : [])
  const after = describeEnvironments(compiled.environments)
  for (const line of before) if (!after.includes(line)) drift.push(`environment line gone: ${line}`)
  for (const line of after) if (!before.includes(line)) drift.push(`environment line new: ${line}`)
  const askBefore = Array.isArray(stored.shipAsk) ? stored.shipAsk : []
  for (const entry of askBefore) if (!compiled.shipAsk.includes(entry)) drift.push(`ask: command gone: ${entry}`)
  for (const entry of compiled.shipAsk) if (!askBefore.includes(entry)) drift.push(`ask: command new: ${entry}`)
  if (drift.length === 0) return { stale: false, reason: null }
  return { stale: true, reason: drift.join('; ') }
}

// --- CLI -----------------------------------------------------------------------------

function flag(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return null
  return argv[index + 1]
}

function originRemote(cwd) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    return null
  }
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function emit(result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }
  const lines = []
  if (result.written) lines.push(`wrote ${result.path}`)
  else if (result.check) lines.push(result.stale ? `stale: ${result.reason}` : `fresh: ${result.path}`)
  else lines.push(`would write ${result.path}${result.stale ? ` (${result.reason})` : ' (unchanged)'}`)
  for (const warn of result.warns) lines.push(`warn: ${warn}`)
  for (const block of result.blocks) lines.push(`block: ${block}`)
  process.stdout.write(lines.join('\n') + '\n')
}

function main(argv) {
  const json = argv.includes('--json')
  const check = argv.includes('--check')
  const write = argv.includes('--write') && !check
  const devMd = resolve(flag(argv, '--dev-md') || '.vegastack/dev.md')
  const result = { guard: 'ship-policy', ok: true, written: false, check, stale: false, reason: null, path: null, policy: null, blocks: [], warns: [] }

  const devMdText = readIfPresent(devMd)
  if (devMdText === null) result.blocks.push(`no dev.md at ${devMd} — run dev-setup first, or pass --dev-md`)
  const repo = flag(argv, '--repo') || repoFromRemote(originRemote(dirname(devMd)))
  if (!repo) result.blocks.push('could not read an owner/repo from the origin remote — pass --repo owner/repo')
  if (result.blocks.length > 0) {
    result.ok = false
    emit(result, json)
    process.exit(2)
  }

  let compiled
  try {
    compiled = compilePolicy(devMdText, { repo, resolved: loadConfiguredPolicy({ home: homedir(), repo, devMd: devMdText }) })
  } catch (error) {
    result.ok = false
    result.blocks.push(`policy compilation refused: ${error.message}`)
    emit(result, json)
    process.exit(2)
  }
  const path = flag(argv, '--policy') || policyPath(homedir(), repo)
  const state = staleness(readIfPresent(path), compiled)
  result.path = path
  result.policy = compiled
  result.stale = state.stale
  result.reason = state.reason

  if (check) {
    result.ok = !state.stale
    emit(result, json)
    process.exit(state.stale ? 2 : 0)
  }
  if (write) {
    const document = { ...compiled, source: { devMd, compiledAt: new Date().toISOString() } }
    mkdirSync(dirname(path), { recursive: true })
    const temp = path + '.ship-policy-tmp'
    writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, path)
    result.written = true
    result.stale = false
  } else if (!existsSync(path)) {
    result.warns.push('dry run: nothing written — pass --write')
  }
  emit(result, json)
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))

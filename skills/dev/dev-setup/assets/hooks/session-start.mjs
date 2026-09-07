#!/usr/bin/env node
// Bounded local advisory adapter shared by SessionStart, Stop and SessionEnd.
// Guard enforcement is separate. This adapter never reads transcripts or native memory,
// invents a write destination, contacts a network or asks a model to continue.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

export const MAX_HOOK_INPUT_BYTES = 64 * 1024
export const LOCAL_FLUSH_MS = 500
const INPUT_WAIT_MS = 350
const EVENTS = new Set(['SessionStart', 'Stop', 'SessionEnd'])
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

export function sanitizeHookInput(payload, harness, event) {
  if (!['claude', 'codex'].includes(harness) || !EVENTS.has(event)) return null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== event) return null
  if (!identity(payload.session_id) || (payload.turn_id !== undefined && !identity(payload.turn_id))) return null
  if (typeof payload.cwd !== 'string' || payload.cwd.length > 4096 || !isAbsolute(payload.cwd) || /[\0\r\n]/.test(payload.cwd)) return null
  if (payload.stop_hook_active !== undefined && typeof payload.stop_hook_active !== 'boolean') return null
  // These values are identifiers for the private CLI resolver, never filesystem destinations.
  return {
    harness, event, sessionId: payload.session_id,
    ...(payload.turn_id === undefined ? {} : { turnId: payload.turn_id }),
    cwd: payload.cwd, stopHookActive: payload.stop_hook_active ?? false,
  }
}

export function readBoundedHookInput(stream = process.stdin) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0, finished = false
    const done = value => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stream.removeListener('data', data)
      stream.removeListener('end', end)
      stream.removeListener('error', error)
      stream.pause()
      resolve(value)
    }
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_HOOK_INPUT_BYTES) return done(null)
      chunks.push(bytes)
    }
    const end = () => {
      try { done(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) }
      catch { done(null) }
    }
    const error = () => done(null)
    const timer = setTimeout(() => done(null), INPUT_WAIT_MS)
    stream.on('data', data).once('end', end).once('error', error)
  })
}

function localCli() {
  const explicit = process.env.VSK_VEGAFACTORY
  const candidates = explicit ? [explicit] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, 'vegafactory'))
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue
      const path = realpathSync(candidate)
      if (!lstatSync(path).isFile()) continue
      accessSync(path, constants.R_OK)
      const root = dirname(dirname(path))
      const read = file => {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('unsupported package metadata')
        return readFileSync(file)
      }
      const pkg = JSON.parse(read(join(root, 'package.json')))
      if (pkg.name !== '@vegastack/vegafactory' || pkg.bin?.vegafactory !== 'dist/index.js'
        || path !== realpathSync(join(root, 'dist/index.js'))) continue
      const manifest = JSON.parse(read(join(root, 'skill-integrity.json')))
      const expected = manifest.schemaVersion === 2 && manifest.skills?.['dev-setup']?.files?.['assets/hooks/session-start.mjs']
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) continue
      const hash = bytes => createHash('sha256').update(bytes).digest('hex')
      if (hash(read(fileURLToPath(import.meta.url))) !== expected
        || hash(read(join(root, 'skill/dev-setup/assets/hooks/session-start.mjs'))) !== expected) continue
      return path
    } catch { /* missing installed CLI is an advisory no-op */ }
  }
  return null
}

export async function runAdvisoryHook(event, argv) {
  // No inherited-environment guessing, extra flags or vendor payload interpretation.
  if (argv.length !== 2 || argv[0] !== '--harness') return
  const input = sanitizeHookInput(await readBoundedHookInput(), argv[1], event)
  if (!input || (event === 'Stop' && input.stopHookActive)) return
  // #143 owns this local-only consumer: verify registered cwd + owned run/session, then
  // deduplicate/flush. #144 owns lesson validation/selection. Missing support is silence,
  // not a fallback to raw vendor capture or a claim that a checkpoint was persisted.
  const cli = localCli()
  if (!cli) return
  // The package bin is Node JavaScript. Invoke the known interpreter directly; do not execute
  // shell wrappers or depend on platform first-exec handling within the 500 ms flush budget.
  const run = spawnSync(process.execPath, [cli, 'stats', 'record', '--source', 'managed-hook'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: LOCAL_FLUSH_MS,
    killSignal: 'SIGKILL', maxBuffer: 4096, stdio: ['pipe', 'pipe', 'ignore'],
  })
  if (run.error || run.signal || run.status !== 0 || event !== 'SessionStart') return
  let result
  try { result = JSON.parse(run.stdout) } catch { return }
  // A bounded opaque pointer from the private resolver, never arbitrary model instructions.
  if (result?.ok !== true || typeof result.contextPointer !== 'string'
    || !/^vsk-context:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.contextPointer)) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'SessionStart', additionalContext: `VegaFactory verified context pointer: ${result.contextPointer}`,
  } }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runAdvisoryHook('SessionStart', process.argv.slice(2)) } catch { /* advisory only */ }
  process.exit(0)
}

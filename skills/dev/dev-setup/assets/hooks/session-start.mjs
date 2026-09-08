#!/usr/bin/env node
// Bounded local advisory adapter shared by SessionStart, Stop and SessionEnd.
// Guard enforcement is separate. This adapter never reads transcripts or native memory,
// invents a write destination, contacts a network or asks a model to continue.

import { spawn } from 'node:child_process'
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

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

export function runLocalHookPhase(cli, command, input, entryAt = performance.now()) {
  return new Promise(resolvePhase => {
    const remaining = 1000 - (performance.now() - entryAt)
    if (remaining <= 0) return resolvePhase({ completed: false, output: '', phaseMs: null, totalMs: performance.now() - entryAt })
    const nonce = randomUUID()
    let phase = 'waiting-ready', output = '', phaseAt = null, phaseTimer = null, settled = false
    // Detached creates one owned POSIX process group; this child remains fully
    // supervised and is never unref'd or left doing background delivery.
    const child = spawn(process.execPath, [cli, ...command], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    const kill = () => {
      phase = 'failed'
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already absent */ }
    }
    const deadline = setTimeout(kill, remaining)
    const cancelled = () => kill()
    process.once('SIGTERM', cancelled); process.once('SIGINT', cancelled)
    const done = completed => {
      const now = performance.now()
      completed = completed && (phaseAt === null ? output === '' : now - phaseAt <= LOCAL_FLUSH_MS) && now - entryAt <= 1000
      if (settled) return
      settled = true
      clearTimeout(deadline); clearTimeout(phaseTimer)
      process.removeListener('SIGTERM', cancelled); process.removeListener('SIGINT', cancelled)
      resolvePhase({ completed, output: completed ? output : '', phaseMs: phaseAt === null ? null : performance.now() - phaseAt, totalMs: performance.now() - entryAt })
    }
    child.on('error', () => { kill(); done(false) })
    child.stdin.on('error', kill)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk; if (phaseAt === null || Buffer.byteLength(output) > 4096) kill() })
    child.on('message', message => {
      const now = performance.now()
      if (now - entryAt > 1000 || phaseAt !== null && now - phaseAt > LOCAL_FLUSH_MS) return kill()
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.vskManagedHook !== 1) return kill()
      if (message.phase === 'ready' && Object.keys(message).sort().join(',') === 'phase,vskManagedHook' && phase === 'waiting-ready') {
        phase = 'validating'
        // Read-only registry, session and current-policy validation remains
        // under the entry-relative deadline. It grants no local write.
        child.send({ vskManagedHook: 1, phase: 'start', nonce }, error => { if (error) kill() })
        child.stdin.end(JSON.stringify(input))
      } else if (message.phase === 'validated' && Object.keys(message).sort().join(',') === 'nonce,phase,vskManagedHook' && message.nonce === nonce && phase === 'validating') {
        phase = 'flushing'; phaseAt = performance.now()
        // Exactly one grant covers every claim, write, release, ACK and lesson
        // mutation. No message can renew either deadline.
        phaseTimer = setTimeout(kill, Math.min(LOCAL_FLUSH_MS, 1000 - (phaseAt - entryAt)))
        child.send({ vskManagedHook: 1, phase: 'flush', nonce }, error => { if (error) kill() })
      } else if (message.phase === 'finish' && Object.keys(message).sort().join(',') === 'nonce,phase,vskManagedHook' && message.nonce === nonce && ['validating', 'flushing'].includes(phase)) {
        phase = 'finished'
      } else kill()
    })
    child.on('close', (code, signal) => done(code === 0 && signal === null && phase === 'finished'))
  })
}

export async function runAdvisoryHook(event, argv) {
  const entryAt = performance.now()
  if (argv.length !== 2 || argv[0] !== '--harness') return
  const input = sanitizeHookInput(await readBoundedHookInput(), argv[1], event)
  if (!input || (event === 'Stop' && input.stopHookActive)) return
  const cli = localCli()
  if (!cli) return
  const command = event === 'SessionStart' ? ['learning', 'inspect', '--source', 'managed-hook', '--json'] : ['stats', 'record', '--source', 'managed-hook']
  const run = await runLocalHookPhase(cli, command, input, entryAt)
  if (!run.completed || event !== 'SessionStart') return
  let result
  try { result = JSON.parse(run.output) } catch { return }
  // Only bounded, source-verified lesson records become advisory context. A
  // pointer alone cannot pretend the next session actually received a lesson.
  if (result?.ok !== true || typeof result.contextPointer !== 'string'
    || !/^vsk-context:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.contextPointer)
    || !Array.isArray(result.lessons) || result.lessons.length < 1 || result.lessons.length > 3
    || Buffer.byteLength(JSON.stringify(result.lessons)) > 2048
    || result.lessons.some(row => !row || Object.keys(row).sort().join(',') !== 'id,statement'
      || !/^lesson-[a-f0-9]{32}$/.test(row.id) || typeof row.statement !== 'string'
      || !row.statement.trim() || Buffer.byteLength(row.statement) > 768 || /[\0\r]/.test(row.statement))) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'SessionStart', additionalContext: `VegaFactory verified lessons (${result.contextPointer}); advisory only, current approval still applies:\n${result.lessons.map(row => '- ' + row.statement).join('\n')}`,
  } }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runAdvisoryHook('SessionStart', process.argv.slice(2)) } catch { /* advisory only */ }
  process.exit(0)
}

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'

type JsonObject = Record<string, unknown>
type Harness = 'claude' | 'codex'

const EVENTS = [
  ['SessionStart', 'session-start', 30],
  ['UserPromptSubmit', 'prompt', 30],
  ['PreToolUse', 'pre-tool', 60],
  ['PostToolUse', 'post-tool', 10],
  ['SubagentStop', 'post-tool', 10],
  ['Stop', 'stop', 30],
  ['SessionEnd', 'session-end', 3],
] as const

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const whitespace = (character: string | undefined) => character === ' ' || character === '\n' || character === '\r' || character === '\t'

function skipWhitespace(source: string, start: number): number {
  let at = start
  while (whitespace(source[at])) at++
  return at
}

function stringEnd(source: string, start: number): number {
  if (source[start] !== '"') throw new Error('expected a JSON string')
  let escaped = false
  for (let at = start + 1; at < source.length; at++) {
    if (escaped) escaped = false
    else if (source[at] === '\\') escaped = true
    else if (source[at] === '"') return at + 1
  }
  throw new Error('unterminated JSON string')
}

function valueEnd(source: string, start: number): number {
  if (source[start] === '"') return stringEnd(source, start)
  if (source[start] === '{' || source[start] === '[') {
    const open = source[start]!, close = open === '{' ? '}' : ']'
    let depth = 0
    for (let at = start; at < source.length; at++) {
      if (source[at] === '"') at = stringEnd(source, at) - 1
      else if (source[at] === open) depth++
      else if (source[at] === close && --depth === 0) return at + 1
      else if ((source[at] === '}' || source[at] === ']') && depth === 0) throw new Error('invalid JSON value')
    }
    throw new Error('unterminated JSON value')
  }
  let at = start
  while (at < source.length && !whitespace(source[at]) && source[at] !== ',' && source[at] !== '}' && source[at] !== ']') at++
  return at
}

// JSON.parse proves the whole document first. This small scanner only finds the top-level value
// span, so replacing `hooks` cannot reformat or otherwise rewrite an unrelated byte.
function topLevelProperty(source: string, wanted: string): { start: number; end: number; close: number } | null {
  let at = skipWhitespace(source, 0)
  if (source[at++] !== '{') throw new Error('hook configuration must be a JSON object')
  let found: { start: number; end: number; close: number } | null = null
  for (;;) {
    at = skipWhitespace(source, at)
    if (source[at] === '}') return wanted === '' ? { start: at, end: at, close: at } : found
    const keyStart = at
    const keyEnd = stringEnd(source, keyStart)
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string
    at = skipWhitespace(source, keyEnd)
    if (source[at++] !== ':') throw new Error('invalid hook configuration')
    const start = skipWhitespace(source, at)
    const end = valueEnd(source, start)
    if (key === wanted) {
      if (found) throw new Error(`hook configuration has duplicate top-level ${wanted} keys`)
      found = { start, end, close: -1 }
    }
    at = skipWhitespace(source, end)
    if (source[at] === ',') { at++; continue }
    if (source[at] === '}') return wanted === '' ? { start: at, end: at, close: at } : found
    throw new Error('invalid hook configuration')
  }
}

function commandMatches(command: unknown, event: string, harness: Harness, cli: string): boolean {
  if (typeof command !== 'string') return false
  const text = command.trim()
  if (text === `${cli} hook ${event} --harness ${harness}`) return true
  const words = text.split(/\s+/)
  const suffix = ['hook', event, '--harness', harness]
  if (words.length < suffix.length + 1 || !suffix.every((word, index) => words[words.length - suffix.length + index] === word)) return false
  const prefix = words.slice(0, -suffix.length)
  if (prefix.length === 1 && basename(prefix[0]!) === 'vegafactory') return true
  return prefix.length === 2
    && ['bun', 'node'].includes(basename(prefix[0]!))
    && /(?:^|\/)packages\/cli\/src\/index\.ts$/.test(prefix[1]!.replaceAll('\\', '/'))
}

function requiredHook(cli: string, event: string, harness: Harness, timeout: number): JsonObject {
  return { type: 'command', command: `${cli} hook ${event} --harness ${harness}`, timeout }
}

function mergedHooks(value: unknown, harness: Harness, cli: string): JsonObject {
  if (!isObject(value)) throw new Error('the top-level hooks value must be an object')
  const merged: JsonObject = { ...value }
  for (const [name, event, timeout] of EVENTS) {
    const groups = merged[name] === undefined ? [] : merged[name]
    if (!Array.isArray(groups)) throw new Error(`hooks.${name} must be an array`)
    const kept = groups.flatMap(group => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group]
      const hooks = group.hooks.filter(hook => !isObject(hook) || !commandMatches(hook.command, event, harness, cli))
      if (hooks.length === 0 && Object.keys(group).length === 1) return []
      return [{ ...group, hooks }]
    })
    kept.push({ hooks: [requiredHook(cli, event, harness, timeout)] })
    merged[name] = kept
  }
  return merged
}

function mergeDocument(source: string, harness: Harness, cli: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error('hook configuration is not valid JSON') }
  if (!isObject(parsed)) throw new Error('hook configuration must be a JSON object')
  const span = topLevelProperty(source, 'hooks')
  const current = parsed.hooks ?? {}
  const merged = mergedHooks(current, harness, cli)
  if (JSON.stringify(current) === JSON.stringify(merged)) return source
  const hooks = JSON.stringify(merged, null, 2)
  if (span) return source.slice(0, span.start) + hooks + source.slice(span.end)
  const root = topLevelProperty(source, '')!
  const separator = Object.keys(parsed).length === 0 ? '' : ','
  return source.slice(0, root.close) + `${separator}"hooks":${hooks}` + source.slice(root.close)
}

function checkDirectory(path: string, create: boolean): void {
  if (!existsSync(path)) {
    if (!create) return
    mkdirSync(path, { mode: 0o700 })
  }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} is not a safe directory`)
}

interface Identity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  mode: bigint
}

interface FilePlan { path: string; before: string | null; identity: Identity | null; after: string }

function identity(path: string): Identity {
  const info = lstatSync(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is not a safe regular file`)
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, mode: info.mode }
}

const sameIdentity = (left: Identity, right: Identity) =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

function planFile(root: string, relativePath: string, harness: Harness, cli: string): FilePlan {
  const path = join(root, relativePath)
  const folder = dirname(path)
  if (existsSync(folder)) checkDirectory(folder, false)
  if (existsSync(path)) {
    identity(path)
  }
  const beforeIdentity = existsSync(path) ? identity(path) : null
  const before = beforeIdentity ? readFileSync(path, 'utf8') : null
  if (beforeIdentity && !sameIdentity(beforeIdentity, identity(path))) throw new Error(`${path} changed while hooks were being read`)
  return { path, before, identity: beforeIdentity, after: mergeDocument(before ?? '{}\n', harness, cli) }
}

function publish(plan: FilePlan): void {
  checkDirectory(dirname(plan.path), true)
  const current = existsSync(plan.path) ? readFileSync(plan.path, 'utf8') : null
  const currentIdentity = existsSync(plan.path) ? identity(plan.path) : null
  if (current !== plan.before || (plan.identity === null) !== (currentIdentity === null) ||
      (plan.identity !== null && currentIdentity !== null && !sameIdentity(plan.identity, currentIdentity))) {
    throw new Error(`${plan.path} changed while hooks were being merged`)
  }
  const temporary = join(dirname(plan.path), `.${randomUUID()}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', plan.identity === null ? 0o600 : Number(plan.identity.mode & 0o777n))
    writeFileSync(descriptor, plan.after, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    const latest = existsSync(plan.path) ? readFileSync(plan.path, 'utf8') : null
    const latestIdentity = existsSync(plan.path) ? identity(plan.path) : null
    if (latest !== plan.before || (plan.identity === null) !== (latestIdentity === null) ||
        (plan.identity !== null && latestIdentity !== null && !sameIdentity(plan.identity, latestIdentity))) {
      throw new Error(`${plan.path} changed while hooks were being merged`)
    }
    renameSync(temporary, plan.path)
    const folder = openSync(dirname(plan.path), 'r')
    try { fsyncSync(folder) } finally { closeSync(folder) }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
}

function fileHasHooks(path: string, harness: Harness, cli: string): boolean {
  try {
    const root = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isObject(root) || !isObject(root.hooks)) return false
    const hooks = root.hooks
    return EVENTS.every(([name, event, timeout]) => {
      const groups = hooks[name]
      return Array.isArray(groups) && groups.some(group => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(hook =>
        isObject(hook) && hook.type === 'command' && hook.timeout === timeout && commandMatches(hook.command, event, harness, cli)))
    })
  } catch { return false }
}

export function verifyHarnessHooks(root: string, cli = 'vegafactory'): { ok: true } | { ok: false; reason: string } {
  if (!fileHasHooks(join(root, '.claude', 'settings.json'), 'claude', cli)) return { ok: false, reason: 'Claude hooks are incomplete' }
  if (!fileHasHooks(join(root, '.codex', 'hooks.json'), 'codex', cli)) return { ok: false, reason: 'Codex hooks are incomplete' }
  return { ok: true }
}

function harnessHookPlans(root: string, cli: string): FilePlan[] {
  checkDirectory(root, false)
  return [
    planFile(root, '.claude/settings.json', 'claude', cli),
    planFile(root, '.codex/hooks.json', 'codex', cli),
  ].filter(plan => plan.before !== plan.after)
}

// Plans the same strict merge as `ensureHarnessHooks` without creating a directory, temporary
// file, lock, or hook file. Malformed JSON and unsafe files/directories are refusals in both modes.
export function inspectHarnessHooks(root: string, cli = 'vegafactory'): { changed: string[] } {
  return { changed: harnessHookPlans(root, cli).map(plan => relative(root, plan.path)) }
}

export function ensureHarnessHooks(
  root: string,
  cli = 'vegafactory',
  testing: { beforePublish?: (path: string) => void } = {},
): { changed: string[] } {
  const plans = harnessHookPlans(root, cli)
  // Publication is deliberately monotonic rather than transactional across two files. If this
  // process stops after the first rename, that valid file stays in place and the next call merges
  // the second from its then-current bytes. No rollback can overwrite an independent edit.
  for (const plan of plans) {
    testing.beforePublish?.(relative(root, plan.path))
    publish(plan)
  }
  const verified = verifyHarnessHooks(root, cli)
  if (!verified.ok) throw new Error(verified.reason)
  return { changed: plans.map(plan => relative(root, plan.path)) }
}

// A small supported registration grammar, not a shell interpreter or a sandbox.
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type HookHarness = 'claude' | 'codex'
export interface RegistrationInput { config: unknown; harness: HookHarness; checkout: string; guardPath: string }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

// Quoted paths are supported; substitutions, redirects, operators and wrappers are not.
export function directArgv(command: unknown): string[] | null {
  if (typeof command !== 'string' || command.length > 8192 || /[\r\n\x00$`;&|<>()\\]/.test(command)) return null
  const args: string[] = []
  let word = '', quote = '', started = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else if (char === ' ' || char === '\t') {
      if (started) { args.push(word); word = ''; started = false }
    } else {
      if (/[\s*?\[\]{}]/.test(char)) return null
      word += char; started = true
    }
  }
  if (quote) return null
  if (started) args.push(word)
  return args
}

export function installedNode(): string | null {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    // Empty/relative PATH components depend on the target cwd and cannot qualify an interpreter.
    if (!isAbsolute(directory)) continue
    try {
      const path = realpathSync(join(directory, 'node'))
      accessSync(path, constants.X_OK)
      if (lstatSync(path).isFile()) return path
    } catch { /* inspect the next PATH entry */ }
  }
  return null
}

export function checkoutFile(checkout: string, path: string): string {
  const root = resolve(checkout)
  if (lstatSync(root).isSymbolicLink()) throw new Error('checkout is a symlink')
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('guard must be inside the actual checkout')
  let cursor = root
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('guard/config path contains a symlink')
  }
  if (!lstatSync(target).isFile()) throw new Error('guard/config is not a regular file')
  accessSync(target, constants.R_OK)
  return realpathSync(target)
}

function shellMatcher(matcher: unknown): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*') return true
  if (typeof matcher !== 'string') return false
  // Both pinned macOS/Linux harnesses expose shell/unified-exec hooks as Bash.
  // Only an explicit name union is supported; arbitrary regex reasoning is not admission.
  const names = matcher.replace(/^\^/, '').replace(/\$$/, '').replace(/^\(([^()]+)\)$/, '$1')
  return /^[A-Za-z_][A-Za-z0-9_]*(\|[A-Za-z_][A-Za-z0-9_]*)*$/.test(names) && names.split('|').includes('Bash')
}

// Support the vendor's documented array-of-tables hook representation without claiming a
// general TOML parser. Other config sections remain the vendor's; complex hook syntax refuses
// with an inspectable JSON migration rather than being silently ignored or rewritten.
function inlineHooks(text: string): Record<string, unknown> {
  const hooks: Record<string, Array<Record<string, unknown>>> = {}
  let current: Record<string, unknown> | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      current = null
      if (!/^\[\[?(?:hooks|"hooks"|'hooks')(?:\.|\])/.test(line)) continue
      const match = /^\[\[hooks\.([A-Za-z]+)(\.hooks)?\]\]\s*(?:#.*)?$/.exec(line)
      if (!match) throw new Error('unsupported inline hooks; inspect and migrate to hooks.json without replacing other hooks')
      const event = match[1]!
      const groups = hooks[event] ?? (hooks[event] = [])
      if (match[2]) {
        const group = groups[groups.length - 1]
        if (!group) throw new Error('inline hook handler has no event group')
        const handlers = group.hooks as Array<Record<string, unknown>>
        current = {}; handlers.push(current)
      } else { current = { hooks: [] }; groups.push(current) }
      continue
    }
    if (!current) {
      if (/^(?:hooks|"hooks"|'hooks')\s*[.=]/.test(line)) throw new Error('unsupported inline hooks; use the documented array-of-tables or hooks.json')
      continue
    }
    const field = /^(matcher|type|command|timeout|async|asyncRewake|disabled|statusMessage)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[0-9]+)\s*(?:#.*)?$/.exec(line)
    if (!field || Object.hasOwn(current, field[1]!)) throw new Error('unsupported or duplicate inline hook field; inspect before migration')
    const value = field[2]!
    current[field[1]!] = value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value)
  }
  return { hooks }
}

export function readHookConfiguration(checkout: string, harness: HookHarness, home?: string): { config: unknown; sources: string[]; duplicateCommands: string[] } {
  const project = harness === 'claude' ? ['.claude/settings.json', '.claude/settings.local.json'] : ['.codex/hooks.json', '.codex/config.toml']
  const files = project.map(path => ({ root: checkout, path: join(checkout, path) }))
  if (home) {
    const root = harness === 'codex' ? process.env.CODEX_HOME || join(home, '.codex') : join(home, '.claude')
    for (const name of harness === 'codex' ? ['hooks.json', 'config.toml'] : ['settings.json']) files.push({ root, path: join(root, name) })
  }
  const sources: string[] = [], duplicateCommands: string[] = []
  const hooks: Record<string, unknown[]> = {}, commands = new Set<string>()
  let disableAllHooks = false
  for (const file of files) {
    let text: string
    try {
      const stat = lstatSync(file.path)
      if (stat.size > 1024 * 1024) throw new Error('hook configuration exceeds 1 MiB')
      text = readFileSync(checkoutFile(file.root, file.path), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const config = object(file.path.endsWith('.toml') ? inlineHooks(text) : JSON.parse(text))
    if (!config) throw new Error(`${file.path}: hook config must be an object`)
    if (config.disableAllHooks === true) disableAllHooks = true
    const events = config.hooks === undefined ? {} : object(config.hooks)
    if (!events) throw new Error(`${file.path}: hooks must be an event map`)
    sources.push(file.path)
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) throw new Error(`${file.path}: ${event} must contain matcher groups`)
      ;(hooks[event] ??= []).push(...groups)
      for (const group of groups) for (const handler of Array.isArray(object(group)?.hooks) ? object(group)!.hooks as unknown[] : []) {
        const argv = directArgv(object(handler)?.command)
        if (!argv) continue
        const key = JSON.stringify([event, object(group)?.matcher ?? '', argv])
        if (commands.has(key)) duplicateCommands.push(key)
        commands.add(key)
      }
    }
  }
  if (sources.length === 0) throw new Error(`${project[0]} is missing; no supported hook configuration`)
  return { config: { hooks, disableAllHooks }, sources, duplicateCommands }
}

export function validateRegistration(input: RegistrationInput): { ok: boolean; problems: string[] } {
  const refuse = (reason: string) => ({ ok: false, problems: [reason] })
  if (input.harness !== 'claude' && input.harness !== 'codex') return refuse('unsupported harness')
  let guard: string
  try { guard = checkoutFile(input.checkout, input.guardPath) } catch (error) { return refuse(`ship-guard.mjs unavailable: ${(error as Error).message}`) }
  const node = installedNode()
  if (!node) return refuse('installed executable node interpreter is missing')
  const config = object(input.config)
  if (config?.disableAllHooks === true) return refuse('PreToolUse hooks are disabled')
  const events = object(config?.hooks)
  const groups = events?.PreToolUse
  if (!Array.isArray(groups)) return refuse('no supported PreToolUse command registration')
  for (const entry of groups) {
    const group = object(entry)
    if (!group || !shellMatcher(group.matcher) || !Array.isArray(group.hooks)) continue
    for (const entry of group.hooks) {
      const hook = object(entry)
      if (!hook || hook.type !== 'command' || hook.async === true || hook.asyncRewake === true || hook.disabled === true) continue
      const argv = directArgv(hook.command)
      if (!argv || argv.length !== 4 || argv[2] !== '--harness' || argv[3] !== input.harness) continue
      try {
        const interpreter: string | null = argv[0] === 'node' ? node : isAbsolute(argv[0]!) && basename(argv[0]!) === 'node' ? realpathSync(argv[0]!) : null
        if (interpreter !== node || checkoutFile(input.checkout, argv[1]!) !== guard) continue
        accessSync(interpreter, constants.X_OK)
        return { ok: true, problems: [] }
      } catch { /* missing, escaped or symlinked targets cannot qualify */ }
    }
  }
  return refuse(`PreToolUse must synchronously invoke node <checkout guard> --harness ${input.harness} for every supported shell tool; custom wrappers, wrong argv and restrictive matchers do not qualify`)
}

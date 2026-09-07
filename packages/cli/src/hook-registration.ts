// A small supported registration grammar, not a shell interpreter or a sandbox.
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type HookHarness = 'claude' | 'codex'
export interface RegistrationInput { config: unknown; harness: HookHarness; checkout: string; guardPath: string }

export interface CodexConfigurationInspection {
  features: Record<string, boolean>
  memoryRetrievalDisabled: boolean
  memoryGenerationDisabled: boolean
  hookApplicable: boolean
  hookHash?: string
  problems: string[]
}

// A short-lived metadata connection to the installed CLI, not a daemon or model session.
// The request vocabulary is closed: no thread/turn, command, hook execution or state mutation.
export async function inspectCodexConfiguration(input: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
}): Promise<CodexConfigurationInspection> {
  const failed = (reason: string): CodexConfigurationInspection => ({ features: {}, memoryRetrievalDisabled: false, memoryGenerationDisabled: false, hookApplicable: false, problems: [reason] })
  try { if (realpathSync(input.cwd) !== input.cwd) return failed('prepared Codex checkout must be canonical') }
  catch { return failed('prepared Codex checkout is unavailable') }
  const replies = await new Promise<Record<string, unknown> | null>(resolveResult => {
    const child = spawn(input.command, [...input.args, 'app-server', '--listen', 'stdio://'], {
      cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = '', bytes = 0, settled = false, complete = false, closed = false
    const values: Record<string, unknown> = {}
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.destroy()
      if (closed) { resolveResult(value); return }
      // A failed metadata query cannot outlive its caller unnoticed. Await the owned
      // process's close event; failure to confirm termination still refuses admission.
      const teardown = setTimeout(() => resolveResult(null), 1000)
      child.once('close', () => { clearTimeout(teardown); resolveResult(value) })
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => { complete = false; finish(null) }, 5000)
    const send = (value: unknown): void => { if (!settled) child.stdin.write(`${JSON.stringify(value)}\n`) }
    child.stdin.on('error', () => finish(null))
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) finish(null) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1024 * 1024) { finish(null); return }
      buffer += chunk
      while (buffer.includes('\n') && !settled) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let message: Record<string, unknown> | null
        try { message = object(JSON.parse(line)) } catch { finish(null); return }
        if (!message) { finish(null); return }
        if (message.id === undefined) {
          if (typeof message.method === 'string' && /^(thread|turn|item|hook)\//.test(message.method)) { finish(null); return }
          continue // unrelated global notifications are not proof
        }
        if (message.error || message.result === undefined) { finish(null); return }
        if (message.id === 0) {
          if (Object.hasOwn(values, 'initialized')) { finish(null); return }
          values.initialized = true
          send({ method: 'initialized' })
          send({ id: 1, method: 'hooks/list', params: { cwds: [input.cwd] } })
          send({ id: 2, method: 'configRequirements/read', params: null })
          send({ id: 3, method: 'config/read', params: { cwd: input.cwd, includeLayers: true } })
        } else if ([1, 2, 3].includes(message.id as number) && values.initialized === true) {
          const key = String(message.id)
          if (Object.hasOwn(values, key)) { finish(null); return }
          values[key] = message.result
          if (['1', '2', '3'].every(key => Object.hasOwn(values, key))) { complete = true; child.stdin.end() }
        } else { finish(null); return }
      }
    })
    child.on('error', () => finish(null))
    child.on('close', code => { closed = true; if (complete && code === 0) finish(values); else { complete = false; finish(null) } })
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'vegafactory-hook-inspection', version: '1' }, capabilities: { experimentalApi: true } } })
  })
  if (!replies) return failed('Codex effective hook/config metadata is unavailable, malformed or timed out')
  const listed = object(replies['1']), requirementsReply = object(replies['2']), read = object(replies['3'])
  if (!requirementsReply || !Object.hasOwn(requirementsReply, 'requirements')) return failed('Codex effective requirements are unknown')
  const requirements = requirementsReply.requirements === null ? null : object(requirementsReply.requirements)
  if (requirementsReply.requirements !== null && !requirements) return failed('Codex effective requirements are malformed')
  if (requirements?.allowManagedHooksOnly != null && typeof requirements.allowManagedHooksOnly !== 'boolean') return failed('Codex managed hook requirement is unsupported')
  const config = object(read?.config), features = object(config?.features), memories = object(config?.memories)
  const result: CodexConfigurationInspection = {
    features: {}, memoryRetrievalDisabled: memories?.use_memories === false,
    memoryGenerationDisabled: memories?.generate_memories === false, hookApplicable: false, problems: [],
  }
  for (const key of ['hooks', 'memories', 'external_agent_memory_import']) if (typeof features?.[key] === 'boolean') result.features[key] = features[key] as boolean
  const context = object(features?.context_management)?.experimental_mode
  if (typeof context === 'boolean') result.features.context_management = context
  const entries = listed?.data
  if (!Array.isArray(entries) || entries.length !== 1) return failed('Codex did not return exactly the requested checkout hook metadata')
  const entry = object(entries[0])
  if (entry?.cwd !== input.cwd || !Array.isArray(entry.errors) || entry.errors.length !== 0 || !Array.isArray(entry.hooks)) return failed('Codex hook metadata has errors or a different checkout')
  const pins = object(requirements?.featureRequirements)
  if (pins?.hooks === false) return failed('managed requirements disable Codex hooks')
  if (['memories', 'external_agent_memory_import', 'context_management'].some(key => pins?.[key] === true)) {
    return failed('managed requirements force incompatible native-memory or context features')
  }
  const knownSources = new Set<string>()
  try {
    for (const path of readHookConfiguration(input.cwd, 'codex', input.env.HOME, input.env.CODEX_HOME).sources) knownSources.add(realpathSync(path))
  } catch { return failed('Codex hook source files could not be verified') }
  for (const value of entry.hooks) {
    const hook = object(value)
    if (!hook || hook.handlerType !== 'command' || hook.eventName !== 'preToolUse'
      || hook.enabled !== true || hook.async !== false || typeof hook.isManaged !== 'boolean'
      || typeof hook.currentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash)
      || !['trusted', 'managed', 'untrusted', 'modified'].includes(String(hook.trustStatus))) continue
    if (requirements?.allowManagedHooksOnly === true && hook.isManaged !== true) continue
    if (typeof hook.sourcePath !== 'string') continue
    try { if (!knownSources.has(realpathSync(hook.sourcePath))) continue } catch { continue }
    if (hook.source === 'project' && object(object(config?.projects)?.[input.cwd])?.trust_level !== 'trusted') continue
    const registration = validateRegistration({ harness: 'codex', checkout: input.cwd, guardPath: join(input.cwd, '.vegastack/hooks/ship-guard.mjs'),
      config: { hooks: { PreToolUse: [{ matcher: hook.matcher ?? undefined, hooks: [{ type: 'command', command: hook.command }] }] } } })
    if (!registration.ok) continue
    // Untrusted/modified definitions are usable only with the separately checked invocation's
    // explicit hook-trust bypass and exact package-asset verification, never a trust-store write.
    result.hookApplicable = true; result.hookHash = hook.currentHash
    break
  }
  if (!result.hookApplicable) result.problems.push('the exact configured guard is not enabled/applicable in effective Codex metadata')
  return result
}

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
    if (!isAbsolute(directory)) return null
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
function* tomlCodeLines(text: string): Generator<string> {
  let multiline: string | null = null
  for (const raw of text.split('\n')) {
    const hidden = multiline !== null
    let quote: string | null = null
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i]!
      if (multiline) {
        if (multiline === '"""' && char === '\\') { i++; continue }
        if (raw.slice(i, i + 3) === multiline) { multiline = null; i += 2 }
      } else if (quote) {
        if (quote === '"' && char === '\\') { i++; continue }
        if (char === quote) quote = null
      } else {
        if (char === '#') break
        if (raw.slice(i, i + 3) === '"""' || raw.slice(i, i + 3) === "'''") { multiline = raw.slice(i, i + 3); i += 2 }
        else if (char === '"' || char === "'") quote = char
      }
    }
    if (quote) throw new Error('unterminated TOML string; hook configuration cannot be established')
    // A header inside instruction/string data is not a registration. Retain the raw value
    // on the opening line so supported hook fields are still parsed by their narrow grammar.
    if (!hidden) yield raw
  }
  if (multiline) throw new Error('unterminated multiline TOML string')
}

function inlineHooks(text: string): Record<string, unknown> {
  const hooks: Record<string, Array<Record<string, unknown>>> = {}
  let current: Record<string, unknown> | null = null
  for (const raw of tomlCodeLines(text)) {
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

export function readHookConfiguration(checkout: string, harness: HookHarness, home?: string, codexHome = process.env.CODEX_HOME): { config: unknown; sources: string[]; duplicateCommands: string[] } {
  const project = harness === 'claude' ? ['.claude/settings.json', '.claude/settings.local.json'] : ['.codex/hooks.json', '.codex/config.toml']
  const files = project.map(path => ({ root: checkout, path: join(checkout, path) }))
  if (home) {
    const root = harness === 'codex' ? codexHome || join(home, '.codex') : join(home, '.claude')
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

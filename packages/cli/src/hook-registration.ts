// A small supported registration grammar, not a shell interpreter or a sandbox.
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
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
    else if (/\s/.test(char)) {
      if (started) { args.push(word); word = ''; started = false }
    } else { word += char; started = true }
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
        const interpreter = argv[0] === 'node' ? node : isAbsolute(argv[0]!) && basename(argv[0]!) === 'node' ? realpathSync(argv[0]!) : null
        if (interpreter !== node || checkoutFile(input.checkout, argv[1]!) !== guard) continue
        accessSync(interpreter, constants.X_OK)
        return { ok: true, problems: [] }
      } catch { /* missing, escaped or symlinked targets cannot qualify */ }
    }
  }
  return refuse(`PreToolUse must synchronously invoke node <checkout guard> --harness ${input.harness} for every supported shell tool; custom wrappers, wrong argv and restrictive matchers do not qualify`)
}

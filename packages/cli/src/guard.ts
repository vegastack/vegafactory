// `vegafactory guard …` — a thin wrapper around the packaged dev-setup/scripts/ship-policy.mjs.
// The compiler lives there and only there: the skills must work on a standalone install with no
// CLI present, and two copies of the policy grammar drift. What this file adds is argument shape
// and a human rendering.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CompiledGuardCheck { wired: boolean; detail: string; policyDigest: string | null }

export function shipPolicyScript(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return process.env.VSK_SHIP_POLICY_SCRIPT || join(packageRoot, 'skill', 'dev-setup', 'scripts', 'ship-policy.mjs')
}

// The compiler owns policy parsing and comparison. This adapter only validates its result
// envelope and identity; launch never rewrites a stale enforcement document into permission.
export function checkCompiledGuard(
  input: { checkout: string; home: string; repo: string; policyDigest?: string },
  invoke = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], {
    cwd: input.checkout, env: { ...process.env, HOME: input.home }, encoding: 'utf8',
    timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }),
): CompiledGuardCheck {
  const fail = (detail: string): CompiledGuardCheck => ({ wired: false, detail: `${detail} — run vegafactory guard sync explicitly`, policyDigest: null })
  let run: ReturnType<typeof invoke>
  try {
    // The compiler derives repo identity from the actual checkout's origin, not this caller.
    run = invoke(shipPolicyScript(), ['--check', '--json', '--dev-md', join(input.checkout, '.vegastack/dev.md')])
  } catch { return fail('compiled policy check could not run') }
  if (run.error || run.signal) return fail('compiled policy check failed or exceeded its 10-second deadline')
  let result: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(String(run.stdout ?? ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
    result = value as Record<string, unknown>
  } catch { return fail('compiled policy check returned unreadable output') }
  if (run.status !== 0 || result.ok !== true || result.stale !== false) {
    const detail = typeof result.reason === 'string' ? result.reason : Array.isArray(result.blocks) ? result.blocks.filter(x => typeof x === 'string').join('; ') : 'comparison refused'
    return fail(`compiled policy is missing, stale or refused: ${detail}`)
  }
  const policy = result.policy as Record<string, unknown> | null
  if (result.guard !== 'ship-policy' || result.check !== true || result.written !== false
    || !Array.isArray(result.blocks) || result.blocks.length !== 0 || !policy || Array.isArray(policy)
    || policy.schemaVersion !== 2 || policy.repo !== input.repo
    || typeof policy.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.policyDigest)
    || !policy.sources || typeof policy.sources !== 'object' || Array.isArray(policy.sources)) {
    return fail('compiled policy check returned an unsupported envelope or wrong repository identity')
  }
  if (input.policyDigest && input.policyDigest !== policy.policyDigest) return fail('compiled policy differs from the selected launch policy')
  return { wired: true, detail: 'current compiled policy verified in the prepared checkout', policyDigest: policy.policyDigest }
}

export interface GuardArgs {
  verb: 'sync'
  check: boolean
  write: boolean
  json: boolean
  devMd?: string
}

export interface GuardSpawnResult { status: number; stdout: string }
export interface GuardDeps {
  spawn: (args: string[]) => GuardSpawnResult
  print: (line: string) => void
}

export function guardUsage(): string {
  return `Usage: vegafactory guard sync [--check] [--dry-run] [--dev-md PATH] [--json]

  sync                 compile .vegastack/dev.md's guard policy (Environments lines, gates
                       knob, the backticked commands on Ship ask: lines) into the file the
                       ship guard reads: ~/.vegastack/guard/<owner>__<repo>.json, keyed by
                       the checkout's origin remote. Writes by default.
  sync --check         compare the stored file with what dev.md compiles to now; exit 2
                       when it is stale or missing. The SessionStart hook runs this.
  sync --dry-run       print what would be written and change nothing.

The guard never reads dev.md: the policy lives outside every worktree, and a command
that touches ~/.vegastack/guard/ is itself on the guard's always-ask list.
`
}

export function parseGuardArgs(argv: string[]): GuardArgs {
  const head = argv[0]
  if (head !== 'sync') throw new Error(`Unknown guard verb: ${head ?? '(none)'} — expected sync`)
  const args: GuardArgs = { verb: 'sync', check: false, write: true, json: false }
  const rest = argv.slice(1)
  let explicitWrite = false
  while (rest.length) {
    const token = rest.shift()!
    if (token === '--check') args.check = true
    else if (token === '--dry-run') args.write = false
    else if (token === '--write') explicitWrite = true
    else if (token === '--json') args.json = true
    else if (token === '--dev-md') {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) throw new Error('--dev-md requires a value')
      args.devMd = value
    }
    else throw new Error(`Unknown option: ${token}`)
  }
  if (args.check && explicitWrite) throw new Error('--check compares and never writes; drop --write or --check')
  if (args.check) args.write = false
  return args
}

export function scriptArgs(args: GuardArgs): string[] {
  const out = ['--json']
  if (args.check) out.push('--check')
  else if (args.write) out.push('--write')
  if (args.devMd) out.push('--dev-md', args.devMd)
  return out
}

interface ScriptResult {
  ok?: boolean
  written?: boolean
  check?: boolean
  stale?: boolean
  reason?: string | null
  path?: string | null
  blocks?: string[]
  warns?: string[]
}

function defaultSpawn(args: string[]): GuardSpawnResult {
  const run = spawnSync(process.execPath, [shipPolicyScript(), ...args], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
  return { status: run.status ?? 2, stdout: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

function render(result: ScriptResult, args: GuardArgs, print: (line: string) => void): void {
  if (args.json) {
    print(JSON.stringify(result, null, 2))
    return
  }
  if (result.written) print(`wrote ${result.path}`)
  else if (args.check) print(result.stale ? `stale: ${result.reason ?? 'the policy file differs from dev.md'} — run vegafactory guard sync` : `fresh: ${result.path}`)
  else if (result.path) print(`would write ${result.path}${result.stale ? ` (${result.reason})` : ' (unchanged)'}`)
  for (const warn of result.warns ?? []) print(`  warn: ${warn}`)
  for (const block of result.blocks ?? []) print(`  block: ${block}`)
}

export async function runGuardCli(argv: string[], deps?: Partial<GuardDeps>): Promise<number> {
  const spawn = deps?.spawn ?? defaultSpawn
  const print = deps?.print ?? ((line: string) => console.log(line))
  const args = parseGuardArgs(argv)
  const run = spawn(scriptArgs(args))
  let result: ScriptResult
  try {
    result = JSON.parse(run.stdout) as ScriptResult
  } catch {
    render({ ok: false, blocks: [`the ship-policy script returned unreadable output: ${run.stdout.trim().slice(0, 400)}`] }, args, print)
    return 2
  }
  render(result, args, print)
  return run.status
}

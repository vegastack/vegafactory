// `vegafactory worktree …` — a thin wrapper around the packaged
// dev-implement/scripts/worktree.mjs. The safety logic lives there and only
// there: the skills must work on a standalone install with no CLI present, and
// two copies of a removal rule drift. What this file adds is argument shape, a
// human rendering, and the cross-repo view the script has no business knowing
// about.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { worktreesPath, type HomeOptions } from './home.ts'

const verbs = ['list', 'create', 'restore', 'remove', 'prune', 'status', 'prepare'] as const
export type WorktreeVerb = (typeof verbs)[number]

export interface WorktreeArgs {
  verb: WorktreeVerb
  issue?: number
  name?: string
  slug?: string
  type?: string
  force: boolean
  write: boolean
  olderThan?: string
  allRepos: boolean
  json: boolean
  workerLayout: boolean
}

export interface SpawnResult { status: number; stdout: string }
export interface WorktreeDeps {
  spawn: (args: string[], cwd?: string) => SpawnResult
  registryPath: string
}

export function worktreeUsage(): string {
  return `Usage: vegafactory worktree <list|create|restore|remove|prune|status|prepare> [options]

  list [--all-repos]                    every worktree with its state and disk use
  status                                worktrees reconciled against open issues; orphans named
  create <issue> [--slug S] [--type T]  cut the branch and its worktree (no dependency install);
                                        slug and type come off the issue title unless given
  restore <issue> [--slug S]            re-add the checkout of the branch that carries the issue number
  remove <issue>|--name <leaf> [--force] remove the exact directory once it is clean, pushed and merged;
                                         ambiguous legacy leaves require --name
  prune [--older-than 14d] [--write]    preview reclaimable worktrees and dependencies; --write
                                        performs the reported removals after every safety check
  prepare <issue>                       run the declared commands: setup when node_modules was reclaimed;
                                        failure keeps the marker and blocks work

Create, restore and remove act; bare prune previews and only prune --write acts.
--dry-run always previews. Branches are never deleted, and
--force lifts only the "not merged" block — use it only on the operator's word.
`
}

// Lifecycle verbs act by default. Prune is the exception: it previews until --write, and
// --dry-run wins in either flag order. The safety rules live in the script.
export function parseWorktreeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): WorktreeArgs {
  const head = argv[0]
  if (!head || !verbs.includes(head as WorktreeVerb)) {
    throw new Error(`Unknown worktree verb: ${head ?? '(none)'} — expected list|create|restore|remove|prune|status|prepare`)
  }
  const verb = head as WorktreeVerb
  const rest = argv.slice(1)
  const args: WorktreeArgs = { verb, force: false, write: verb !== 'prune', allRepos: false, json: false, workerLayout: env.VSK_WORKTREE_LAYOUT === 'worker' }
  let dryRun = false
  while (rest.length) {
    const token = rest.shift()!
    if (!token.startsWith('-')) {
      const number = Number(token)
      if (!Number.isInteger(number) || number <= 0) throw new Error(`Expected an issue number, got: ${token}`)
      args.issue = number
      continue
    }
    if (token === '--force') args.force = true
    else if (token === '--dry-run') { dryRun = true; args.write = false }
    else if (token === '--write') {
      if (verb !== 'prune') throw new Error('--write only applies to worktree prune')
      args.write = true
    }
    else if (token === '--all-repos') args.allRepos = true
    else if (token === '--json') args.json = true
    else if (token === '--older-than') args.olderThan = requireValue(token, rest.shift())
    else if (token === '--name') {
      if (verb !== 'remove') throw new Error('--name only applies to worktree remove')
      args.name = requireValue(token, rest.shift())
    }
    else if (token === '--slug') args.slug = requireValue(token, rest.shift())
    else if (token === '--type') args.type = requireValue(token, rest.shift())
    else throw new Error(`Unknown option: ${token}`)
  }
  if (dryRun) args.write = false
  if (verb === 'remove' && args.issue !== undefined && args.name !== undefined) throw new Error('worktree remove accepts either an issue number or --name, not both')
  if ((verb === 'create' || verb === 'restore' || verb === 'prepare') && args.issue === undefined) {
    throw new Error(`worktree ${verb} needs an issue number`)
  }
  if (verb === 'remove' && args.issue === undefined && args.name === undefined) throw new Error('worktree remove needs an issue number or --name <leaf>')
  return args
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) throw new Error(`${flag} requires a value`)
  return value
}

export function scriptArgs(args: WorktreeArgs): string[] {
  const out: string[] = [args.verb, '--json']
  if (args.issue !== undefined) out.push('--issue', String(args.issue))
  if (args.name) out.push('--name', args.name)
  if (args.slug) out.push('--slug', args.slug)
  if (args.type) out.push('--type', args.type)
  if (args.olderThan) out.push('--older-than', args.olderThan)
  if (args.force) out.push('--force')
  if (args.write) out.push('--write')
  if (args.workerLayout) out.push('--worker-layout')
  return out
}

// The cross-repo view is backed by the roots the CLI has actually been run in.
// Vanished roots are pruned on every write, so the file cannot grow stale
// entries the way a hand-maintained list would. #112's control room may replace
// this source later; the shape of the answer does not change.
export async function recordRepoRoot(registryPath: string, repoRoot: string): Promise<string[]> {
  let existing: string[] = []
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as unknown
    if (Array.isArray(parsed)) existing = parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch { existing = [] }
  const roots = [...new Set([...existing, resolve(repoRoot)])].filter(root => existsSync(root)).sort()
  // Owner-only, because the directory this lands in also holds the App key and the control-room
  // clones, and a umask of 022 would leave every one of them readable by anybody on the machine.
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 })
  await writeFile(registryPath, `${JSON.stringify(roots, null, 2)}\n`)
  return roots
}

// Takes the home rather than reaching for `homedir()`, because this used to be the one path in
// the product a test could not point somewhere harmless.
export function defaultRegistryPath(options: HomeOptions = {}): string {
  return worktreesPath(options)
}

function defaultSpawn(args: string[], cwd?: string): SpawnResult {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const script = process.env.VSK_WORKTREE_SCRIPT || join(packageRoot, 'skill', 'dev-implement', 'scripts', 'worktree.mjs')
  const run = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { status: run.status ?? 2, stdout: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

interface ScriptResult {
  ok?: boolean
  blocks?: string[]
  warns?: string[]
  actions?: string[]
  entries?: { name: string; branch: string | null; state: string; bytes: number; approx: boolean }[]
  candidates?: { name: string; state: string; ageDays: number; removable: boolean; reason: string | null }[]
  reconciled?: { orphans: string[]; worktreesWithoutOpenIssue: string[]; openIssuesWithoutWorktree: number[] }
}

function render(label: string, result: ScriptResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (label) console.log(label)
  for (const entry of result.entries ?? []) {
    const size = `${(entry.bytes / 1_048_576).toFixed(1)} MB${entry.approx ? '+' : ''}`
    console.log(`  ${entry.name.padEnd(28)} ${entry.state.padEnd(11)} ${(entry.branch ?? 'detached').padEnd(32)} ${size}`)
  }
  for (const candidate of result.candidates ?? []) {
    console.log(`  ${candidate.name} (${candidate.state}, ${candidate.ageDays}d) — ${candidate.removable ? 'removable' : `kept: ${candidate.reason}`}`)
  }
  if (result.reconciled) {
    const { orphans, worktreesWithoutOpenIssue, openIssuesWithoutWorktree } = result.reconciled
    if (orphans.length) console.log(`  orphan directories (branch gone): ${orphans.join(', ')}`)
    if (worktreesWithoutOpenIssue.length) console.log(`  no open issue: ${worktreesWithoutOpenIssue.join(', ')}`)
    if (openIssuesWithoutWorktree.length) console.log(`  open issues with no worktree: ${openIssuesWithoutWorktree.join(', ')}`)
  }
  for (const action of result.actions ?? []) console.log(`  action: ${action}`)
  for (const warn of result.warns ?? []) console.log(`  warn: ${warn}`)
  for (const block of result.blocks ?? []) console.log(`  block: ${block}`)
}

function parseScriptOutput(stdout: string): ScriptResult {
  try {
    return JSON.parse(stdout) as ScriptResult
  } catch {
    return { blocks: [`the worktree script returned unreadable output: ${stdout.trim().slice(0, 400)}`] }
  }
}

export async function runWorktree(argv: string[], deps?: Partial<WorktreeDeps>): Promise<number> {
  const spawn = deps?.spawn ?? defaultSpawn
  const registryPath = deps?.registryPath ?? defaultRegistryPath()
  const args = parseWorktreeArgs(argv)

  if (args.allRepos) {
    if (args.verb !== 'list' && args.verb !== 'status') throw new Error('--all-repos only applies to list and status')
    const roots = await recordRepoRoot(registryPath, process.cwd())
    let worst = 0
    for (const root of roots) {
      const run = spawn([...scriptArgs(args), '--repo-root', root], root)
      render(root, parseScriptOutput(run.stdout), args.json)
      worst = Math.max(worst, run.status)
    }
    return worst
  }

  const run = spawn(scriptArgs(args))
  render('', parseScriptOutput(run.stdout), args.json)
  if (!['prune', 'prepare'].includes(args.verb) || args.write) await recordRepoRoot(registryPath, process.cwd()).catch(() => [])
  return run.status
}

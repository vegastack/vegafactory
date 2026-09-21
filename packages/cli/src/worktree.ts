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

const verbs = ['list', 'create', 'restore', 'remove', 'prune', 'status'] as const
export type WorktreeVerb = (typeof verbs)[number]

export interface WorktreeArgs {
  verb: WorktreeVerb
  issue?: number
  slug?: string
  type?: string
  force: boolean
  write: boolean
  olderThan?: string
  allRepos: boolean
  json: boolean
}

export interface SpawnResult { status: number; stdout: string }
export interface WorktreeDeps {
  spawn: (args: string[], cwd?: string) => SpawnResult
  registryPath: string
}

export function worktreeUsage(): string {
  return `Usage: vegafactory worktree <list|create|restore|remove|prune|status> [options]

  list [--all-repos]                    every worktree with its state and disk use
  status                                worktrees reconciled against open issues; orphans named
  create <issue> [--slug S] [--type T]  cut the branch and its worktree (no dependency install);
                                        slug and type come off the issue title unless given
  restore <issue> [--slug S]            re-add the checkout of the branch that carries the issue number
  remove <issue> [--force]              remove the directory once it is clean, pushed and merged
  prune [--older-than 14d] [--write]    remove worktrees idle past retention; uncommitted work is
                                        first committed as wip on the worktree's branch and pushed

Every verb acts; --dry-run shows what it would do. Branches are never deleted, and
--force lifts only the "not merged" block — use it only on the operator's word.
`
}

// Every verb acts by default; --dry-run previews. The safety rules live in the script.
export function parseWorktreeArgs(argv: string[]): WorktreeArgs {
  const head = argv[0]
  if (!head || !verbs.includes(head as WorktreeVerb)) {
    throw new Error(`Unknown worktree verb: ${head ?? '(none)'} — expected list|create|restore|remove|prune|status`)
  }
  const verb = head as WorktreeVerb
  const rest = argv.slice(1)
  const args: WorktreeArgs = { verb, force: false, write: true, allRepos: false, json: false }
  while (rest.length) {
    const token = rest.shift()!
    if (!token.startsWith('-')) {
      const number = Number(token)
      if (!Number.isInteger(number) || number <= 0) throw new Error(`Expected an issue number, got: ${token}`)
      args.issue = number
      continue
    }
    if (token === '--force') args.force = true
    else if (token === '--dry-run') args.write = false
    // Acting is the default, so on `prune` this says what is already true. It is accepted there
    // because every reference to reclaiming a worktree — the worker's own advice included — names
    // it, and a command a person is told to run has to be one the parser takes. It stays unknown
    // elsewhere: `remove --write` was never offered and nothing asks for it.
    else if (token === '--write' && verb === 'prune') args.write = true
    else if (token === '--all-repos') args.allRepos = true
    else if (token === '--json') args.json = true
    else if (token === '--older-than') args.olderThan = requireValue(token, rest.shift())
    else if (token === '--slug') args.slug = requireValue(token, rest.shift())
    else if (token === '--type') args.type = requireValue(token, rest.shift())
    else throw new Error(`Unknown option: ${token}`)
  }
  if ((verb === 'create' || verb === 'restore' || verb === 'remove') && args.issue === undefined) {
    throw new Error(`worktree ${verb} needs an issue number`)
  }
  return args
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) throw new Error(`${flag} requires a value`)
  return value
}

export function scriptArgs(args: WorktreeArgs): string[] {
  const out: string[] = [args.verb, '--json']
  if (args.issue !== undefined) out.push('--issue', String(args.issue))
  if (args.slug) out.push('--slug', args.slug)
  if (args.type) out.push('--type', args.type)
  if (args.olderThan) out.push('--older-than', args.olderThan)
  if (args.force) out.push('--force')
  if (args.write) out.push('--write')
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

// The tidy-up the worker does inside its own pass, rather than on a schedule of its own. It is the
// same `prune` a person runs, through the same script and the same refusals: nothing dirty,
// unpushed or locked is ever removed, and whatever is kept comes back as a line to report instead
// of being silently skipped.
export function tidyWorktrees(
  repoRoot: string,
  options: { write?: boolean; inUse?: string[]; spawn?: (args: string[], cwd?: string) => SpawnResult } = {},
): { actions: string[]; warns: string[]; blocks: string[]; freed: string[]; reclaimable: number } {
  const spawn = options.spawn ?? defaultSpawn
  // `--automatic` is the narrower pass: it never pushes and never commits anything as `wip`, and
  // it reports whatever it will not touch. The worker calls it without `--write`, so it removes
  // nothing at all — see the note at its call site. `--in-use` names the *issues* a run is holding
  // right now; a worktree is `<issue>-<slug>`, and the script matches on the number in front.
  const args = [
    'prune', '--automatic', ...(options.write ? ['--write'] : []),
    ...((options.inUse ?? []).length ? ['--in-use', (options.inUse ?? []).join(',')] : []),
    '--json',
  ]
  try {
    const run = spawn(args, repoRoot)
    const result = parseScriptOutput(run.stdout) as ScriptResult & { freed?: string[]; droppable?: string[] }
    // Counted from the candidates, not from `actions`: every remote-backed prune puts its own
    // `git fetch` in there, so a pass with nothing to reclaim would still look like it had work.
    // The union, not the sum: one clean worktree past both windows is in `droppable` *and* a
    // removable candidate, and counting twice reports "2 could be reclaimed" for one worktree.
    const reclaimable = new Set([
      ...(result.candidates ?? []).filter((candidate) => candidate.removable).map((candidate) => candidate.name),
      ...(result.droppable ?? []),
    ]).size
    return {
      actions: result.actions ?? [], warns: result.warns ?? [],
      blocks: result.blocks ?? [], freed: result.freed ?? [], reclaimable,
    }
  } catch (error) {
    // Tidying is housekeeping. A pass that could not do it still worked the board.
    return { actions: [], warns: [`worktrees could not be tidied: ${(error as Error).message}`], blocks: [], freed: [], reclaimable: 0 }
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
  await recordRepoRoot(registryPath, process.cwd()).catch(() => [])
  return run.status
}

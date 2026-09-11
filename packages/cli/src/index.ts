#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import type { SkillEntry } from './selection.ts'

type Agent = 'codex' | 'claude' | 'hermes'
type AgentChoice = Agent | 'both' | 'all'
type Mode = 'project' | 'global'
type Command = 'add' | 'verify' | 'doctor' | 'remove' | 'list' | 'version' | 'help' | 'worktree' | 'sync' | 'dispatch' | 'service' | 'status' | 'stats' | 'dashboard' | 'guard' | 'checkpoint' | 'children' | 'learning'
// Top-level verbs the factory reserves; they are named in usage and refuse until they land.
const reservedTopLevel: readonly string[] = [] as const
const installerVerbs: readonly string[] = ['add', 'verify', 'doctor', 'remove', 'list'] as const
interface Options {
  command: Command
  skill?: string
  group?: string
  all: boolean
  agent?: AgentChoice
  mode?: Mode
  dir?: string
  org?: string
  dryRun: boolean
  force: boolean
  nonInteractive: boolean
  json: boolean
  rest?: string[]
  apply?: boolean
  backup?: number
}
interface SkillIntegrity { files: Record<string, string>; group?: string | null; repoOnly?: boolean }
interface Integrity { schemaVersion: number; skills: Record<string, SkillIntegrity> }
interface Operation { skill: string; agent: Agent; destination: string; stage: string; backup?: string; existed: boolean }
interface InstallJournal { schemaVersion: 2; status: 'prepared' | 'committed'; operations: Operation[] }

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleRoot = join(packageRoot, 'skill')
// Hermes has no project-level skill discovery (single global dir); see docs.
const surfaces: Record<Agent, string> = { codex: '.agents/skills', claude: '.claude/skills', hermes: '.hermes/skills' }
const projectAgents: Agent[] = ['codex', 'claude']
// Single version source: package.json ships in every npm install alongside dist/.
const packageVersion = (JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version

function usage() {
  return `Usage: vegafactory skills <add|verify|remove> <skill> [options]
       vegafactory skills <add|verify|remove> --group <group> [options]
       vegafactory skills <add|verify|remove> --all [options]
       vegafactory skills <list|doctor> [options]

Select exactly one of: a skill name, --group <group>, or --all.
--all installs every skill except the repo-only ones; name those explicitly.
A --group or --all install is one transaction: if any skill fails, none are installed.

Options:
  --group NAME                           install every skill in that group
  --all                                  every bundled skill except the repo-only ones
  --agent codex|claude|hermes|both|all   (both = codex+claude; hermes is global-only)
  --project | --global
  --dir PATH
  --dry-run
  --force
  --json                                 machine-readable output (sync)
  --non-interactive
  --version

Verified lessons:
  vegafactory learning checkpoint|inspect --run-id ID --json
  vegafactory learning revert --run-id ID --id ID --dry-run|--apply --json

Source checkpoints:
  vegafactory checkpoint --run-id ID [--json] [--write]
  Inspect saved progress; writing requires the recorded exact approved task intent.

Worktrees (one feature, one worktree — the main checkout never leaves the default branch):
  vegafactory worktree <list|create|restore|remove|prune|status> [options]
  list [--all-repos] · status · create <issue> · restore <issue>
  remove <issue> [--force] [--write] · prune [--older-than 14d] [--write]
  remove and prune are dry-run until --write, and never touch a branch or anything uncommitted.

Control room (skills read the local clone, never the network):
  vegafactory sync [--org ORG] [--dry-run] [--force] [--json] [--dir PATH]
  vegafactory sync inspect
  vegafactory sync restore [--backup N] [--apply]
  Recovery previews by default; --apply selects recovery content and requires a fresh
  successful fetch before authority resumes. --backup selects a non-negative index (default 0).
  Refreshes this machine's shallow clone of the control room named by the project's
  control-room: knob. --org ORG is the bootstrap path for a repo whose profile has no
  knob yet (the first dev-setup run): the room is <org>/vegafactory-control-room by
  convention. Exit 0 synced, already fresh, or no control room · 1 a command error or
  failed fetch (the existing clone stands) · 2 a refusal (dirty clone, symlink, bad state file).

Verified children:
  vegafactory children run|join --parent N --groups FILE --repo owner/name [--write] [--json]

The dispatcher (headless runs in feature worktrees, on the operator's own machine):
  vegafactory dispatch [--once] [--watch] [--dry-run] [--json] [--config PATH]
  Turns labels and rocket reactions on the repos named in ~/.vegastack/factory.json
  into headless runs. Dry run unless --once or --watch is given, and every repo
  stays refused until its dev.md says dispatch: local, its ship guard is wired and
  its compiled guard policy exists.

  vegafactory guard sync [--check] [--dry-run] [--dev-md PATH] [--json]
  Compiles dev.md's guard policy into ~/.vegastack/guard/<owner>__<repo>.json, the
  one file the ship guard reads — outside every worktree. --check exits 2 when the
  file is stale against dev.md; the SessionStart hook runs it to warn.

  vegafactory service <install|uninstall|status> [--write] [--json]
  Installs that dispatcher as a launchd LaunchAgent (macOS) or a systemd user unit
  (Linux), running as you with your own gh and harness auth. Dry run until --write.

  vegafactory status [--json] [--config PATH]
  The board, the worktrees, the last tick, the runs in flight, and whether the
  dispatcher is alive at all.

Statistics (where agent time and money went — counts and identifiers only, never transcript text):
  vegafactory stats [--repo|--me|--org|skills] [--since MON-YYYY] [--json]
  vegafactory stats push [--commit]
  Reads and writes the org's own control room over your existing gh credentials.
  push is a dry run until --commit. Recording is org policy (stats: in org.md),
  not a machine setting. Run "vegafactory stats help" for the whole surface.

The dashboard (a local, read-only web view over the control room and the live board):
  vegafactory dashboard [--port N] [--open] [--dir PATH] [--dry-run] [--json]
  Fetches @vegastack/vegafactory-dashboard at this CLI's version on first use and
  serves it on 127.0.0.1. Run "vegafactory dashboard --help" for the whole surface.

Reserved (not yet available): dashboard

Run "vegafactory skills list" to see the bundled skills.
`
}

async function bundledSkills(): Promise<string[]> {
  const entries = await readdir(bundleRoot, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

function parse(argv: string[]): Options {
  // Installer verbs live under the `skills` namespace; a leading flag (e.g. `vegafactory --version`)
  // is not a command at all. The reserved verbs are named here so `vegafactory dispatch` says when
  // it lands rather than "unknown command" — they gain behaviour in later releases.
  let command: Command = 'help'
  if (argv[0] && !argv[0].startsWith('-')) {
    const head = argv.shift()!
    if (head === 'skills') {
      const verb = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'help'
      if (!installerVerbs.includes(verb) && verb !== 'help' && verb !== 'version') throw new Error(`Unknown command: skills ${verb}`)
      command = verb as Command
    }
    else if (head === 'worktree' || head === 'dispatch' || head === 'service' || head === 'status' || head === 'stats' || head === 'dashboard' || head === 'guard' || head === 'checkpoint' || head === 'children' || head === 'learning') return { command: head, all: false, dryRun: false, force: false, nonInteractive: false, json: false, rest: argv.splice(0) }
    else if (reservedTopLevel.includes(head)) throw new Error(`${head} is not available yet — it lands in a later release of vegafactory`)
    else if (installerVerbs.includes(head)) throw new Error(`Unknown command: ${head} — installer verbs moved under the skills namespace: run "vegafactory skills ${head} …"`)
    else if (head === 'sync' || head === 'help' || head === 'version') command = head
    else throw new Error(`Unknown command: ${head}`)
  }
  const options: Options = { command, all: false, dryRun: false, force: false, nonInteractive: false, json: false }
  if (argv[0] && !argv[0].startsWith('-')) options.skill = argv.shift()!
  while (argv.length) {
    const flag = argv.shift()!
    if (flag === '--group') {
      const value = argv.shift()
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error('--group requires a value')
      // Last-wins would silently drop the first group from a two-group request and still exit 0.
      if (options.group !== undefined) throw new Error('--group may be given only once; select one group per run')
      options.group = value
    }
    else if (flag === '--all') options.all = true
    else if (flag === '--agent') options.agent = argv.shift() as AgentChoice
    else if (flag === '--project') options.mode = 'project'
    else if (flag === '--global') options.mode = 'global'
    else if (flag === '--dir') options.dir = argv.shift()
    else if (flag === '--org') {
      const value = argv.shift()
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error('--org requires a value')
      options.org = value
    }
    else if (flag === '--apply' && command === 'sync') options.apply = true
    else if (flag === '--backup' && command === 'sync') {
      const value = argv.shift()
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--backup requires a non-negative integer')
      options.backup = Number(value)
    }
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--force') options.force = true
    else if (flag === '--non-interactive' || flag === '--yes') options.nonInteractive = true
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.command = 'help'
    else if (flag === '--version' || flag === '-v') options.command = 'version'
    else throw new Error(`Unknown option: ${flag}`)
  }
  if (options.agent && !['codex', 'claude', 'hermes', 'both', 'all'].includes(options.agent)) throw new Error(`Invalid --agent: ${options.agent}`)
  if (options.mode === 'global' && options.dir) throw new Error('--dir cannot be combined with --global')
  return options
}

// The manifest is the catalog: it carries each skill's group and repo-only marker alongside its
// checksums, so selection never needs to walk the bundle.
async function skillCatalog(): Promise<SkillEntry[]> {
  const manifest = await loadManifest()
  return Object.entries(manifest.skills).map(([name, entry]) => ({
    name,
    group: entry.group ?? null,
    repoOnly: Boolean(entry.repoOnly),
  }))
}

function hasSelector(options: Options): boolean {
  return Boolean(options.skill || options.group || options.all)
}

async function requireSelection(options: Options, verb = 'install'): Promise<string[]> {
  const {selectSkills}=await import('./selection.ts')
  return selectSkills({ skill: options.skill, group: options.group, all: options.all }, await skillCatalog(), verb)
}

// skills.sh-style flow: detect which agents the user actually has and install to them without
// asking. Only when nothing is detectable does an interactive numbered picker appear; --agent
// always overrides, and --non-interactive keeps the old defaults.
const agentLabels: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' }

async function detectAgents(): Promise<Agent[]> {
  const detected: Agent[] = []
  // Order matches install output; detection = the agent's home config dir exists.
  if (await exists(join(homedir(), '.claude'))) detected.push('claude')
  if (await exists(join(homedir(), '.codex')) || await exists(join(homedir(), '.agents'))) detected.push('codex')
  if (await exists(join(homedir(), '.hermes'))) detected.push('hermes')
  return detected
}

async function prompt(options: Options): Promise<{ agent: AgentChoice; mode: Mode }> {
  const mode: Mode = options.mode ?? 'project'
  if (options.agent) return { agent: options.agent, mode }
  if (options.nonInteractive || !process.stdin.isTTY) return { agent: 'both', mode }

  const detected = (await detectAgents()).filter(agent => mode === 'global' || agent !== 'hermes')
  if (detected.length) {
    console.log(`Detected: ${detected.map(agent => agentLabels[agent]).join(', ')} (override with --agent)`)
    if (detected.length === 1) return { agent: detected[0]!, mode }
    return { agent: detected.includes('hermes') ? 'all' : 'both', mode }
  }

  // Nothing detected: one numbered question with a sensible default.
  console.log('Where should this skill be installed?')
  console.log('  1) Claude Code  (.claude/skills)')
  console.log('  2) Codex        (.agents/skills)')
  console.log('  3) Both  (recommended)')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('Select 1-3 [3]: ')).trim()
  rl.close()
  const agent = ({ '1': 'claude', '2': 'codex', '3': 'both', '': 'both' } as Record<string, AgentChoice>)[answer]
  if (!agent) throw new Error(`Invalid selection: ${answer} (expected 1, 2, or 3)`)
  return { agent, mode }
}

// Expand an agent choice to concrete agents, enforcing Hermes's global-only discovery.
function resolveAgents(choice: AgentChoice, mode: Mode): Agent[] {
  const wanted: Agent[] = choice === 'both' ? ['codex', 'claude'] : choice === 'all' ? ['codex', 'claude', 'hermes'] : [choice]
  if (mode === 'project' && wanted.includes('hermes')) {
    if (choice === 'hermes') throw new Error('Hermes discovers skills only in the global ~/.hermes/skills directory; use --global (without --dir) with --agent hermes, or --agent all')
    console.log('note: skipping hermes for a project install — Hermes discovers skills globally only; run with --global --agent hermes')
    return wanted.filter(agent => agent !== 'hermes')
  }
  return wanted
}

async function exists(path: string) {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertNoSymlink(path: string, allowMissingTail = true) {
  const absolute = resolve(path)
  const parsedRoot = resolve(absolute, sep)
  const parts = relative(parsedRoot, absolute).split(sep).filter(Boolean)
  let current = parsedRoot
  for (const part of parts) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`)
    } catch (error) {
      if (allowMissingTail && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function syncDirectory(path: string) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function durableJson(path: string, value: unknown) {
  await assertNoSymlink(dirname(path))
  await mkdir(dirname(path), { recursive: true })
  await assertNoSymlink(dirname(path), false)
  if (await exists(path)) await assertNoSymlink(path, false)
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

async function recoverInstall(base: string) {
  const journalPath = join(base, '.vegastack', '.skills-install-transaction.json')
  if (!await exists(journalPath)) return
  await assertNoSymlink(journalPath, false)
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as InstallJournal
  if (journal.schemaVersion !== 2 || !['prepared', 'committed'].includes(journal.status) || !Array.isArray(journal.operations)) {
    throw new Error(`Unsupported installer recovery journal (schemaVersion ${(journal as { schemaVersion?: unknown }).schemaVersion ?? 'unknown'}); inspect and remove it manually: ${journalPath}`)
  }
  const skills = new Set(await bundledSkills())
  const seen = new Set<string>()
  for (const operation of journal.operations) {
    if (!['codex', 'claude', 'hermes'].includes(operation.agent) || typeof operation.skill !== 'string' || !skills.has(operation.skill)) throw new Error(`Untrusted installer recovery journal: invalid agent or skill; inspect and remove it manually: ${journalPath}`)
    const key = `${operation.agent}/${operation.skill}`
    if (seen.has(key)) throw new Error('Untrusted installer recovery journal: duplicate operation')
    seen.add(key)
    const expectedDestination = join(base, surfaces[operation.agent], operation.skill)
    if (resolve(operation.destination) !== expectedDestination || typeof operation.existed !== 'boolean') throw new Error('Untrusted installer recovery journal: destination outside installer roots')
    const expectedParent = dirname(expectedDestination)
    const validateTemporary = (path: string | undefined, kind: 'stage' | 'backup') => {
      if (!path) return kind === 'backup' && !operation.existed
      return dirname(resolve(path)) === expectedParent && basename(path).startsWith(`.${operation.skill}.${kind}-`)
    }
    if (!validateTemporary(operation.stage, 'stage') || !validateTemporary(operation.backup, 'backup')) throw new Error('Untrusted installer recovery journal: invalid transaction path')
  }
  for (const operation of [...journal.operations].reverse()) {
    for (const path of [operation.destination, operation.stage, operation.backup].filter(Boolean) as string[]) await assertNoSymlink(path)
    if (journal.status === 'prepared') {
      if (operation.backup && await exists(operation.backup)) {
        if (await exists(operation.destination)) await rm(operation.destination, { recursive: true, force: true })
        await rename(operation.backup, operation.destination)
      } else if (!operation.existed && await exists(operation.destination)) await rm(operation.destination, { recursive: true, force: true })
    } else if (operation.backup && await exists(operation.backup)) await rm(operation.backup, { recursive: true, force: true })
    if (await exists(operation.stage)) await rm(operation.stage, { recursive: true, force: true })
  }
  await rm(journalPath, { force: true })
  await syncDirectory(dirname(journalPath))
}

async function withInstallLock<T>(base: string, callback: () => Promise<T>): Promise<T> {
  const directory = join(base, '.vegastack')
  const lockPath = join(directory, '.skills-install.lock')
  await assertNoSymlink(directory)
  await mkdir(directory, { recursive: true })
  await assertNoSymlink(directory, false)
  let handle
  try {
    handle = await open(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    await assertNoSymlink(lockPath, false)
    let active = true
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'))
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) active = false
      else try { process.kill(owner.pid, 0) } catch { active = false }
    } catch { active = false }
    if (active) throw new Error(`Another VegaStack skill installation is active: ${lockPath}`)
    await rm(lockPath, { force: true })
    return withInstallLock(base, callback)
  }
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    await handle.sync()
    return await callback()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
    await syncDirectory(directory)
  }
}

async function listFiles(root: string) {
  const output: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in skill tree: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  await walk(root)
  return output.sort()
}

const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex')

async function loadManifest(): Promise<Integrity> {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'skill-integrity.json'), 'utf8')) as Integrity
  if (manifest.schemaVersion !== 2 || typeof manifest.skills !== 'object') throw new Error('Invalid bundled skill manifest')
  return manifest
}

async function loadSource(skillName: string) {
  const manifest = await loadManifest()
  const skillManifest = manifest.skills[skillName]
  if (!skillManifest) throw new Error(`Bundled manifest has no entry for skill ${skillName}`)
  const source = join(bundleRoot, skillName)
  const skill = await readFile(join(source, 'SKILL.md'), 'utf8')
  if (!skill.startsWith('---\n') || !new RegExp(`^name: ${skillName}$`, 'm').test(skill) || !/^description: .+/m.test(skill)) {
    throw new Error(`Bundled skill ${skillName} fails Agent Skills frontmatter validation`)
  }
  const observed: Record<string, string> = {}
  for (const file of await listFiles(source)) observed[relative(source, file).split(sep).join('/')] = hash(await readFile(file))
  if (JSON.stringify(observed) !== JSON.stringify(skillManifest.files)) throw new Error(`Bundled skill ${skillName} checksum mismatch`)
  return { source, files: skillManifest.files }
}

function baseFor(mode: Mode, directory?: string) {
  return mode === 'global' ? homedir() : resolve(directory ?? process.cwd())
}

async function compare(destination: string, files: Record<string, string>) {
  if (!await exists(destination)) return { status: 'missing' as const, issues: ['not installed'] }
  await assertNoSymlink(destination, false)
  const issues: string[] = []
  const actualFiles = await listFiles(destination)
  const actualKeys = new Set(actualFiles.map(file => relative(destination, file).split(sep).join('/')).filter(key => key !== '.vegastack-install.json'))
  for (const [key, expected] of Object.entries(files)) {
    if (!actualKeys.has(key)) issues.push(`missing ${key}`)
    else if (hash(await readFile(join(destination, key))) !== expected) issues.push(`changed ${key}`)
  }
  for (const key of actualKeys) if (!(key in files)) issues.push(`unexpected ${key}`)
  return { status: issues.length ? 'drifted' as const : 'verified' as const, issues }
}

async function install(options: Options) {
  const skillNames = await requireSelection(options)
  const choice = await prompt(options)
  const base = baseFor(choice.mode, options.dir)
  const agents = resolveAgents(choice.agent, choice.mode)
  if (!agents.length) return
  if (!options.dryRun) return withInstallLock(base, () => installLocked(options, skillNames, agents, base))
  return installLocked(options, skillNames, agents, base, false)
}

// One selection, one transaction. Every skill is checked and staged before anything is committed,
// so a refusal or a staging failure anywhere leaves the destination exactly as it was — the whole
// point of installing a family with one command.
async function installLocked(options: Options, skillNames: string[], agents: Agent[], base: string, recover = true) {
  if (recover) await recoverInstall(base)
  const sources = new Map<string, { source: string; files: Record<string, string> }>()
  for (const skillName of skillNames) sources.set(skillName, await loadSource(skillName))
  const operations: Operation[] = []
  const refusals: { agent: Agent; path: string }[] = []
  for (const skillName of skillNames) {
    const { files } = sources.get(skillName)!
    for (const agent of agents) {
      const destination = join(base, surfaces[agent], skillName)
      await assertNoSymlink(destination)
      const parent = dirname(destination)
      await assertNoSymlink(parent)
      const existed = await exists(destination)
      if (existed && !(await stat(destination)).isDirectory()) {
        throw new Error(`Refusing to install over a non-directory: ${destination} — remove it and retry`)
      }
      if (existed) {
        const comparison = await compare(destination, files)
        if (comparison.status === 'verified' && !options.force) {
          console.log(`unchanged ${agent}: ${destination}`)
          continue
        }
        if (!options.force) {
          if (options.dryRun) { refusals.push({ agent, path: destination }); continue }
          throw new Error(`Refusing differing installation without --force: ${destination}`)
        }
      }
      const suffix = randomUUID()
      operations.push({ skill: skillName, agent, destination, existed, stage: join(parent, `.${skillName}.stage-${suffix}`), backup: existed ? join(parent, `.${skillName}.backup-${suffix}`) : undefined })
    }
  }
  if (options.dryRun) {
    for (const operation of operations) console.log(`would install ${operation.agent}: ${operation.destination}`)
    for (const destination of refusals) console.log(`would replace ${destination.agent} (requires --force; installed copy differs): ${destination.path}`)
    // For a multi-skill selection the transaction is all-or-nothing, so a preview that exits 0
    // would promise an install the real run refuses outright. A single-skill dry run keeps its
    // established report-and-exit-0 behaviour.
    if (refusals.length && skillNames.length > 1) {
      console.log(`this run would install nothing: ${refusals.length} destination(s) differ and --force was not given`)
      process.exitCode = 1
    }
    return
  }
  if (!operations.length) {
    if (skillNames.length > 1) console.log(`${skillNames.length} skills already installed and unchanged${options.group ? ` (${options.group})` : ''}`)
    return
  }
  const journalPath = join(base, '.vegastack', '.skills-install-transaction.json')
  const staged: Operation[] = []
  const applied: Operation[] = []
  try {
    for (const operation of operations) {
      await mkdir(dirname(operation.destination), { recursive: true })
      await assertNoSymlink(dirname(operation.destination), false)
      const { source, files } = sources.get(operation.skill)!
      await cp(source, operation.stage, { recursive: true, dereference: false, errorOnExist: true })
      await writeFile(join(operation.stage, '.vegastack-install.json'), `${JSON.stringify({ installer: '@vegastack/vegafactory', version: packageVersion, skill: operation.skill, files }, null, 2)}\n`, { flag: 'wx' })
      const stagedCheck = await compare(operation.stage, files)
      if (stagedCheck.status !== 'verified') throw new Error(`Staged copy failed verification: ${stagedCheck.issues.join(', ')}`)
      staged.push(operation)
    }
    await durableJson(journalPath, { schemaVersion: 2, status: 'prepared', operations } satisfies InstallJournal)
    for (const operation of operations) {
      await assertNoSymlink(dirname(operation.destination), false)
      if (await exists(operation.destination)) await assertNoSymlink(operation.destination, false)
      if (operation.existed && operation.backup) await rename(operation.destination, operation.backup)
      try {
        await rename(operation.stage, operation.destination)
      } catch (error) {
        if (operation.existed && operation.backup && await exists(operation.backup)) await rename(operation.backup, operation.destination)
        throw error
      }
      applied.push(operation)
    }
    await durableJson(journalPath, { schemaVersion: 2, status: 'committed', operations } satisfies InstallJournal)
  } catch (error) {
    if (await exists(journalPath)) await recoverInstall(base)
    else for (const operation of [...applied].reverse()) {
      await rm(operation.destination, { recursive: true, force: true })
      if (operation.backup && await exists(operation.backup)) await rename(operation.backup, operation.destination)
    }
    for (const operation of staged) await rm(operation.stage, { recursive: true, force: true })
    throw error
  }
  for (const operation of applied) if (operation.backup) {
    try { await rm(operation.backup, { recursive: true, force: true }) }
    catch (error) { console.warn(`warning: installed successfully but could not remove backup ${operation.backup}: ${(error as Error).message}`) }
  }
  await rm(journalPath, { force: true })
  await syncDirectory(dirname(journalPath))
  for (const operation of applied) console.log(`installed ${operation.agent}: ${operation.destination}`)
  if (skillNames.length > 1) {
    // --all silently leaving two skills out is a surprise at the terminal even though both
    // READMEs explain it, so name them where the confusion actually happens.
    const skipped = options.all ? (await skillCatalog()).filter(entry => entry.repoOnly).map(entry => entry.name) : []
    const note = skipped.length ? ` (skipped ${skipped.length} repo-only: ${skipped.join(', ')} — name one explicitly to install it)` : ''
    // Count the skills that actually committed, not the ones selected: with one member already
    // present and unchanged, a selection of ten installs nine.
    const installedCount = new Set(applied.map(operation => operation.skill)).size
    const unchanged = skillNames.length - installedCount
    const unchangedNote = unchanged > 0 ? `, ${unchanged} already up to date` : ''
    console.log(`installed ${installedCount} skills${options.group ? ` from ${options.group}` : ''}${unchangedNote}${note}`)
  }
}

async function verify(options: Options) {
  const choice = await prompt(options)
  const base = baseFor(choice.mode, options.dir)
  const agents = resolveAgents(choice.agent, choice.mode)
  // With no selector at all, verify keeps walking every bundled skill and reports missing ones
  // rather than failing on them; an explicit selection treats a missing skill as a failure.
  const explicit = hasSelector(options)
  const skills = explicit ? await requireSelection(options, 'verify') : await bundledSkills()
  let failed = false
  let found = 0
  for (const skillName of skills) {
    const { files } = await loadSource(skillName)
    for (const agent of agents) {
      const destination = join(base, surfaces[agent], skillName)
      const result = await compare(destination, files)
      if (result.status === 'missing' && !explicit) { console.log(`not installed ${agent} ${skillName}`); continue }
      found += 1
      console.log(`${result.status} ${agent} ${skillName}: ${destination}${result.issues.length ? ` (${result.issues.join(', ')})` : ''}`)
      if (result.status !== 'verified') failed = true
    }
  }
  if (!explicit && found === 0) { console.log('no bundled skills are installed on the selected surfaces'); failed = true }
  if (failed) process.exitCode = 1
}

function semverLess(a: string, b: string): boolean {
  const parse = (value: string) => value.split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a)
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b)
  if (aMajor !== bMajor) return aMajor < bMajor
  if (aMinor !== bMinor) return aMinor < bMinor
  return aPatch < bPatch
}

async function latestPublishedVersion(): Promise<string | null> {
  try {
    const response = await fetch('https://registry.npmjs.org/@vegastack%2fvegafactory/latest', { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    const version = ((await response.json()) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  } catch {
    return null
  }
}

async function removeSkill(options: Options) {
  const skillNames = await requireSelection(options, 'remove')
  const choice = await prompt(options)
  const base = baseFor(choice.mode, options.dir)
  const agents = resolveAgents(choice.agent, choice.mode)
  if (!options.dryRun) return withInstallLock(base, () => removeLocked(options, skillNames, agents, base))
  return removeLocked(options, skillNames, agents, base, false)
}

async function removeLocked(options: Options, skillNames: string[], agents: Agent[], base: string, recover = true) {
  // An interrupted install leaves a journal plus .<skill>.backup-* directories. Without settling
  // them first, a removal "succeeds" and the next add rolls those backups forward, bringing the
  // removed skills back. installLocked already recovers; remove must too, under the same lock.
  if (recover) await recoverInstall(base)
  // Every drift check runs across the whole selection BEFORE the first removal, so a locally
  // modified member stops the run instead of leaving a half-removed family behind.
  const targets: { skill: string; agent: Agent; destination: string }[] = []
  for (const skill of skillNames) {
    for (const agent of agents) {
      const destination = join(base, surfaces[agent], skill)
      if (!await exists(destination)) { console.log(`not installed ${agent}: ${destination}`); continue }
      await assertNoSymlink(destination, false)
      if (!options.force) {
        const { files } = await loadSource(skill)
        const comparison = await compare(destination, files)
        if (comparison.status === 'drifted') throw new Error(`Installation differs from the bundled skill (possibly locally modified); re-run with --force to remove anyway: ${destination}`)
      }
      targets.push({ skill, agent, destination })
    }
  }
  if (options.dryRun) {
    for (const target of targets) console.log(`would remove ${target.agent}: ${target.destination}`)
    return
  }
  for (const target of targets) {
    await rm(target.destination, { recursive: true, force: true })
    console.log(`removed ${target.agent}: ${target.destination}`)
  }
  if (options.all) {
    const skipped = (await skillCatalog()).filter(entry => entry.repoOnly).map(entry => entry.name)
    if (skipped.length) console.log(`left ${skipped.length} repo-only skills in place: ${skipped.join(', ')} — name one explicitly to remove it`)
  }
  if (!targets.length) process.exitCode = 1
}

async function list() {
  const manifest = await loadManifest()
  const entries = await skillCatalog()
  const groups = [...new Set(entries.map(entry => entry.group).filter((group): group is string => group !== null))].sort()

  const show = async (entry: SkillEntry) => {
    const skill = await readFile(join(bundleRoot, entry.name, 'SKILL.md'), 'utf8')
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? ''
    const fileCount = Object.keys(manifest.skills[entry.name]?.files ?? {}).length
    console.log(`  ${entry.name} (${fileCount} files)${entry.repoOnly ? '  [repo-only: not installed by --all]' : ''}`)
    console.log(`    ${description.length > 160 ? `${description.slice(0, 157)}...` : description}`)
  }

  for (const group of groups) {
    console.log(`${group}  —  vegafactory skills add --group ${group}`)
    for (const entry of entries.filter(item => item.group === group).sort((a, b) => a.name.localeCompare(b.name))) await show(entry)
    console.log('')
  }
  const ungrouped = entries.filter(entry => entry.group === null).sort((a, b) => a.name.localeCompare(b.name))
  if (ungrouped.length) {
    console.log('ungrouped')
    for (const entry of ungrouped) await show(entry)
  }
}

async function doctor(options: Options) {
  const base = baseFor(options.mode ?? 'project', options.dir)
  await access(base, fsConstants.R_OK | fsConstants.W_OK)
  await assertNoSymlink(base, false)
  let failed = false
  // The dev skills' per-project profile is plain markdown; the repo, not this file,
  // is the source of truth, so doctor only checks presence and basic shape.
  const profilePath = join(base, '.vegastack', 'dev.md')
  if (options.mode !== 'global') {
    if (await exists(profilePath)) {
      const content = await readFile(profilePath, 'utf8')
      if (content.includes('## Knobs')) console.log(`ok dev profile: ${profilePath}`)
      else {
        console.log(`invalid dev profile: ${profilePath} (no "## Knobs" section; re-run dev-setup to regenerate)`)
        failed = true
      }
    } else {
      console.log(`missing dev profile: ${profilePath} (created by dev-setup once the dev skills are used in this project)`)
    }
  }
  console.log(`ok runtime: Node ${process.versions.node}`)
  // The only network call the CLI ever makes: one npm version check so stale installs are visible.
  const latest = await latestPublishedVersion()
  if (latest && semverLess(packageVersion, latest)) console.log(`update available: installed ${packageVersion}, latest ${latest} — run: npx @vegastack/vegafactory@latest skills add <skill> --force`)
  else if (latest && semverLess(latest, packageVersion)) console.log(`ok installer version: ${packageVersion} (ahead of registry latest ${latest})`)
  else if (latest) console.log(`ok installer version: ${packageVersion} (latest)`)
  else console.log(`skipped installer version check (npmjs.org unreachable); installed ${packageVersion}`)

  let installations = 0
  for (const skillName of await bundledSkills()) {
    const { files } = await loadSource(skillName)
    for (const agent of ['codex', 'claude', 'hermes'] as Agent[]) {
      const destination = join(agent === 'hermes' ? homedir() : base, surfaces[agent], skillName)
      if (!await exists(destination)) continue
      installations += 1
      const result = await compare(destination, files)
      console.log(`${result.status === 'verified' ? 'ok' : 'invalid'} ${agent} ${skillName} installation${result.issues.length ? ` (${result.issues.join(', ')})` : ''}`)
      if (result.status !== 'verified') failed = true
    }
  }
  if (!installations) { console.log('no bundled skills installed on any surface'); failed = true }
  if (failed) process.exitCode = 1
}

// `sync` is the one verb that reaches the network on purpose: one shallow fetch of the control
// room this project names, into a machine-local clone every skill then reads instead of GitHub.
// It refreshes by default — a hook or a dispatcher tick calling a dry-run-by-default verb would be
// a silent no-op — and writes nothing outside the clone path and ~/.vegastack/factory.json.
async function sync(options: Options) {
  const {factoryConfigPath,parseSyncMaxAge,readFactoryConfig}=await import('./control-room.ts')
  const {resolveTarget,syncControlRoom,inspectSnapshots,restoreSnapshot}=await import('./sync.ts')
  if (options.skill && !['inspect', 'restore'].includes(options.skill)) throw new Error('sync accepts inspect or restore')
  if (options.apply && (options.skill !== 'restore' || options.dryRun)) throw new Error('--apply requires sync restore without --dry-run')
  if (options.backup !== undefined && options.skill !== 'restore') throw new Error('--backup requires sync restore')
  const base = baseFor('project', options.dir)
  const devMdPath = join(base, '.vegastack', 'dev.md')
  const devMdText = await exists(devMdPath) ? await readFile(devMdPath, 'utf8') : ''
  const home = homedir()
  const statePath = factoryConfigPath(home)

  let config
  try {
    config = readFactoryConfig(await exists(statePath) ? await readFile(statePath, 'utf8') : null)
  } catch (error) {
    return report(options, { command: 'sync', ok: false, action: 'refused', org: null, path: statePath, sha: null, lastSyncedAt: null, ageMinutes: null, message: (error as Error).message }, 2)
  }

  let target
  try {
    target = resolveTarget({ devMdText, config, home, org: options.org })
  } catch (error) {
    return report(options, { command: 'sync', ok: false, action: 'refused', org: options.org ?? null, path: null, sha: null, lastSyncedAt: null, ageMinutes: null, message: (error as Error).message }, 2)
  }
  if (!target) {
    return report(options, { command: 'sync', ok: true, action: 'none', org: null, path: null, sha: null, lastSyncedAt: null, ageMinutes: null, message: 'this repo names no control room — skill defaults apply' }, 0)
  }

  if (options.skill === 'inspect' || options.skill === 'restore') {
    const context = { target: { ...target, repoPath: base }, now: Date.now() }
    const result = options.skill === 'inspect' ? await inspectSnapshots(context)
      : await restoreSnapshot({ ...context, index: options.backup ?? 0, apply: options.apply === true })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const result = await syncControlRoom({
    target,
    config,
    now: Date.now(),
    maxAgeMinutes: parseSyncMaxAge(devMdText),
    force: options.force,
    dryRun: options.dryRun,
  })

  const code = result.ok ? 0 : result.action === 'refused' ? 2 : 1
  return report(options, {
    command: 'sync',
    ok: result.ok,
    action: result.action,
    org: result.org,
    path: result.path,
    sha: result.sha,
    lastSyncedAt: result.lastSyncedAt,
    ageMinutes: result.ageMinutes,
    message: result.message,
  }, code)
}

interface SyncReport {
  command: 'sync'
  ok: boolean
  action: string
  org: string | null
  path: string | null
  sha: string | null
  lastSyncedAt: string | null
  ageMinutes: number | null
  message: string
}

function report(options: Options, payload: SyncReport, code: number) {
  if (options.json) console.log(JSON.stringify(payload, null, 2))
  else if (payload.ok) console.log(payload.message)
  else {
    const when = payload.lastSyncedAt ? ` last synced ${payload.lastSyncedAt}${payload.ageMinutes === null ? '' : ` (${payload.ageMinutes}m ago)`} —` : ''
    console.error(`control room ${payload.org ?? '?'}:${when} ${payload.message}`)
  }
  process.exitCode = code
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.command === 'worktree') {
    const {runWorktree, worktreeUsage}=await import('./worktree.ts')
    const rest = options.rest ?? []
    if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') return console.log(worktreeUsage())
    process.exitCode = await runWorktree(rest)
    return
  }
  if (options.command === 'guard') {
    const {guardUsage, runGuardCli}=await import('./guard.ts')
    const rest = options.rest ?? []
    if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') return console.log(guardUsage())
    process.exitCode = await runGuardCli(rest)
    return
  }
  if (options.command === 'learning') { const {runLearningCli}=await import('./learning.ts'); process.exitCode = await runLearningCli(options.rest ?? [], homedir()); return }
  if (options.command === 'children') { const {runChildrenCli}=await import('./children.ts'); process.exitCode = await runChildrenCli(options.rest ?? [], homedir()); return }
  if (options.command === 'dispatch') {
    const {dispatchUsage, runDispatchCli}=await import('./dispatch.ts')
    const rest = options.rest ?? []
    if (rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') return console.log(dispatchUsage())
    process.exitCode = await runDispatchCli(rest, homedir())
    return
  }
  if (options.command === 'service') {
    const {runServiceCli, serviceUsage}=await import('./service.ts')
    const rest = options.rest ?? []
    if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') return console.log(serviceUsage())
    process.exitCode = await runServiceCli(rest, homedir())
    return
  }
  if (options.command === 'stats') {
    const rest = options.rest ?? []
    process.exitCode = rest.length === 4 && rest.join(' ') === 'record --source managed-hook --json' || rest.length === 3 && rest.join(' ') === 'record --source managed-hook'
      ? await (await import('./learning.ts')).runLearningCli(['checkpoint', '--source', 'managed-hook', '--json'], homedir())
      : await (await import('./stats/cli.ts')).runStatsCli(rest, homedir())
    return
  }
  if (options.command === 'dashboard') {
    const {dashboardUsage, runDashboard}=await import('./dashboard.ts')
    const rest = options.rest ?? []
    if (rest[0] === 'help') return console.log(dashboardUsage())
    process.exitCode = await runDashboard({ rest, home: homedir(), version: packageVersion })
    return
  }
  if (options.command === 'checkpoint') { const {runCheckpointCli}=await import('./checkpoints.ts'); process.exitCode=await runCheckpointCli(options.rest??[],homedir());return }
  if (options.command === 'status') {
    const {runStatusCli, statusUsage}=await import('./status.ts')
    const rest = options.rest ?? []
    if (rest[0] === 'help') return console.log(statusUsage())
    process.exitCode = await runStatusCli(rest, homedir())
    return
  }
  if (options.command === 'sync') return sync(options)
  if (options.command === 'help') return console.log(usage())
  if (options.command === 'version') return console.log(packageVersion)
  if (options.command === 'list') return list()
  if (options.command === 'add') return install(options)
  if (options.command === 'verify') return verify(options)
  if (options.command === 'remove') return removeSkill(options)
  return doctor(options)
}

main().catch(error => {
  console.error(`error: ${(error as Error).message}`)
  process.exitCode = 1
})

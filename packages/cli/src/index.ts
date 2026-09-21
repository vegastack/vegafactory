#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import type { SkillEntry } from './selection.ts'
import { factoryHome } from './home.ts'
import { latestPublishedVersion, packageVersion, runUpdateCommand, semverLess } from './self-update.ts'

type Agent = 'codex' | 'claude'
type AgentChoice = Agent | 'both'
type Mode = 'project' | 'global'
type Command = 'add' | 'update' | 'self-update' | 'verify' | 'doctor' | 'remove' | 'list' | 'version' | 'help' | 'worktree' | 'sync' | 'hook' | 'ship' | 'issue' | 'init' | 'agent' | 'stats' | 'dashboard' | 'learning' | 'review' | 'worker'
const installerVerbs: readonly string[] = ['add', 'update', 'verify', 'doctor', 'remove', 'list'] as const
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
}
interface SkillIntegrity { files: Record<string, string>; group?: string | null; repoOnly?: boolean }
interface RetiredSkill { group: string; since: string; replacedBy: string; note: string }
interface Integrity { schemaVersion: number; skills: Record<string, SkillIntegrity>; retired?: Record<string, RetiredSkill> }
interface Operation { skill: string; agent: Agent; destination: string; stage: string; backup?: string; existed: boolean }
interface InstallJournal { schemaVersion: 2; status: 'prepared' | 'committed'; operations: Operation[] }

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleRoot = join(packageRoot, 'skill')
const surfaces: Record<Agent, string> = { codex: '.agents/skills', claude: '.claude/skills' }
const projectAgents: Agent[] = ['codex', 'claude']
function usage() {
  return `Usage: vegafactory <command> [options]

Get started:
  init [--org ORG]                       check your tools, install the CLI and every skill for Claude Code and Codex,
                                         enable this repo's git hooks, and link your org's control room
  update                                 install the latest VegaFactory CLI globally with npm

Skills:
  skills list                            the bundled skills, by group
  skills add <skill> | --group G | --all install (global by default; --project or --dir for one project)
  skills update [selection]              bring installed skills up to date; locally edited copies are kept unless --force
  skills verify [selection]              check installed copies against the bundled checksums
  skills remove <selection> [--yes]      uninstall; refuses a locally edited copy unless --force
  skills doctor                          check the install, this project's .vegastack/dev.md and the latest version

Issues (agents read .vegastack/.tmp/issues/, then write back through these):
  issue sync|check|comment|edit-comment|body|label|ack|drop <n> ...   run "vegafactory issue --help"

Worktrees (one issue, one worktree; the main checkout stays on the default branch):
  worktree list|status|create|restore|remove|prune ...                run "vegafactory worktree --help"

Review (the other tool reviews read-only; this command posts the comment):
  review <n> [--base REF] [--reviewer claude|codex] [--resume] [--dry-run]   run "vegafactory review --help"

Shipping and hooks:
  ship check <n> [--json]                may issue n merge? (ship it recorded, branch pushed, PR green)
  ship release <n> [--dry-run]           tag the merged release on issue n's "ship it" (never publishes)
  hook <event> --harness claude|codex    the harness hooks: guard, heartbeat, WIP checkpoints ("hook --help")

Worker (only on a machine whose nodes.md row says worker: yes):
  worker enable|disable|status|run     work the board with no person at the keyboard ("worker --help")

Learning (the Stop hook asks for these; a dev.md line lands only on the operator's yes):
  learning add|list|accept|decline …     the lessons waiting for a dev.md line

Agents:
  agent claude|codex <args…>             start a headless run on the subscription (API keys refused)

Control room:
  sync [--org ORG] [--force]             refresh this machine's copy of the org control room
  sync profile [--json]                  the resolved profile: org, then group, then this repo

Usage numbers (from the harnesses' own session logs — counts only, never prompts or code):
  stats collect|push|show ...            read new turns, share them, print them ("stats --help")
  dashboard [--out FILE] [--open]        one offline HTML file of owners, nodes, projects and issues

Options:
  --group NAME · --all                   choose skills (--all skips the repo-only ones)
  --agent codex|claude|both              which agents (detected when omitted)
  --global | --project · --dir PATH      where to install (global by default)
  --dry-run                              show what would change, change nothing
  --force                                replace locally edited copies
  --yes                                  skip confirmations (for agents and scripts)
  --json · --version · --help

VegaFactory runs on macOS and Linux with Node 24 or newer.
`
}

async function bundledSkills(): Promise<string[]> {
  const entries = await readdir(bundleRoot, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${flag} requires a value`)
  return value
}

function parse(argv: string[]): Options {
  // Installer verbs live under the `skills` namespace; a leading flag (e.g. `vegafactory --version`)
  // is not a command at all.
  let command: Command = 'help'
  if (argv[0] && !argv[0].startsWith('-')) {
    const head = argv.shift()!
    if (head === 'skills') {
      const verb = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'help'
      if (!installerVerbs.includes(verb) && verb !== 'help' && verb !== 'version') throw new Error(`Unknown command: skills ${verb}`)
      command = verb as Command
    }
    else if (head === 'worktree' || head === 'hook' || head === 'ship' || head === 'issue' || head === 'agent' || head === 'stats' || head === 'dashboard' || head === 'learning' || head === 'review' || head === 'worker') return { command: head, all: false, dryRun: false, force: false, nonInteractive: false, json: false, rest: argv.splice(0) }
    else if (head === 'update') command = 'self-update'
    else if (installerVerbs.includes(head)) throw new Error(`Unknown command: ${head} — installer verbs moved under the skills namespace: run "vegafactory skills ${head} …"`)
    else if (head === 'sync' || head === 'help' || head === 'version' || head === 'init') command = head
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
    else if (flag === '--agent') options.agent = requireValue(flag, argv.shift()) as AgentChoice
    else if (flag === '--project') options.mode = 'project'
    else if (flag === '--global') options.mode = 'global'
    else if (flag === '--dir') options.dir = requireValue(flag, argv.shift())
    else if (flag === '--org') {
      const value = argv.shift()
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error('--org requires a value')
      options.org = value
    }
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--force') options.force = true
    else if (flag === '--non-interactive' || flag === '--yes') options.nonInteractive = true
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.command = 'help'
    else if (flag === '--version' || flag === '-v') options.command = 'version'
    else throw new Error(`Unknown option: ${flag}`)
  }
  if (options.agent && !['codex', 'claude', 'both'].includes(options.agent)) throw new Error(`Invalid --agent: ${options.agent} (use codex, claude or both)`)
  if (options.mode === 'global' && options.dir) throw new Error('--dir cannot be combined with --global')
  return options
}

// The manifest is the catalog: it carries each skill's group and repo-only marker alongside its
// checksums, so selection never needs to walk the bundle.
async function skillCatalog(): Promise<SkillEntry[]> {
  const manifest = await loadManifest()
  const live = Object.entries(manifest.skills).map(([name, entry]) => ({
    name,
    group: entry.group ?? null,
    repoOnly: Boolean(entry.repoOnly),
  }))
  // Tombstones ride in the same catalog: a retired name is still a name this bundle knows, and
  // a machine that installed it before the retirement is the only place it still exists.
  const retired = Object.entries((manifest.retired ?? {}) as Record<string, RetiredSkill>).map(([name, entry]) => ({
    name,
    group: entry.group ?? null,
    repoOnly: false,
    retired: true,
    replacedBy: entry.replacedBy,
  }))
  return [...live, ...retired]
}

// Everything this bundle actually ships. Callers that mean "the skills we have" want this;
// only selection, removal and the retirement sweep look at the tombstones.
async function liveCatalog(): Promise<SkillEntry[]> {
  return (await skillCatalog()).filter(entry => !entry.retired)
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
const agentLabels: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' }

async function detectAgents(): Promise<Agent[]> {
  const detected: Agent[] = []
  // Order matches install output; detection = the agent's home config dir exists.
  if (await exists(join(homedir(), '.claude'))) detected.push('claude')
  if (await exists(join(homedir(), '.codex')) || await exists(join(homedir(), '.agents'))) detected.push('codex')
  return detected
}

async function prompt(options: Options): Promise<{ agent: AgentChoice; mode: Mode }> {
  const mode: Mode = options.mode ?? (options.dir ? 'project' : 'global')
  if (options.agent) return { agent: options.agent, mode }
  if (options.nonInteractive || !process.stdin.isTTY) return { agent: 'both', mode }

  const detected = await detectAgents()
  if (detected.length) {
    console.log(`Detected: ${detected.map(agent => agentLabels[agent]).join(', ')} (override with --agent)`)
    if (detected.length === 1) return { agent: detected[0]!, mode }
    return { agent: 'both', mode }
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

// Expand an agent choice to concrete agents.
function resolveAgents(choice: AgentChoice, _mode: Mode): Agent[] {
  return choice === 'both' ? ['codex', 'claude'] : [choice]
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

async function recoverInstall(state: string, base: string) {
  const journalPath = join(state, '.skills-install-transaction.json')
  if (!await exists(journalPath)) return
  await assertNoSymlink(journalPath, false)
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as InstallJournal
  if (journal.schemaVersion !== 2 || !['prepared', 'committed'].includes(journal.status) || !Array.isArray(journal.operations)) {
    throw new Error(`Unsupported installer recovery journal (schemaVersion ${(journal as { schemaVersion?: unknown }).schemaVersion ?? 'unknown'}); inspect and remove it manually: ${journalPath}`)
  }
  const skills = new Set(await bundledSkills())
  const seen = new Set<string>()
  for (const operation of journal.operations) {
    if (!['codex', 'claude'].includes(operation.agent) || typeof operation.skill !== 'string' || !skills.has(operation.skill)) throw new Error(`Untrusted installer recovery journal: invalid agent or skill; inspect and remove it manually: ${journalPath}`)
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

async function withInstallLock<T>(state: string, callback: () => Promise<T>): Promise<T> {
  const directory = state
  const lockPath = join(directory, '.skills-install.lock')
  await assertNoSymlink(directory)
  // Owner-only only when this directory is the product's home, which in global mode it is: the App
  // key and the control-room clones sit beside this lock, and a umask of 022 would leave them
  // readable by anybody on the machine. A project's own `.vegastack/` is a directory in somebody's
  // repository and takes that repository's modes.
  const mine = directory === factoryHome()
  await mkdir(directory, { recursive: true, ...(mine ? { mode: 0o700 } : {}) })
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
    return withInstallLock(state, callback)
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

// Where the skills go, and where the installer keeps the lock and journal that guard them. The
// two differ by mode and this is the only place that knows it: a project keeps both in its own
// `.vegastack/`, while a global install puts the skills in the agent's own directory and its
// bookkeeping in this product's home — which is no longer inside `.vegastack` at all.
function baseFor(mode: Mode, directory?: string): { base: string; state: string } {
  if (mode === 'global') return { base: homedir(), state: factoryHome() }
  const base = resolve(directory ?? process.cwd())
  return { base, state: join(base, '.vegastack') }
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
  const { base, state } = baseFor(choice.mode, options.dir)
  const agents = resolveAgents(choice.agent, choice.mode)
  if (!agents.length) return
  // A group or --all add IS the documented upgrade (`skills add --group dev --global --force`),
  // so it sweeps retired skills exactly as `update` does. Inside the same lock and after the
  // install commits, so a failed transaction never removes anything. Naming one skill sweeps
  // nothing: that selection is about that skill, not about the family it belongs to.
  const sweeps = Boolean(options.group || options.all)
  const run = async (recover = true) => {
    await installLocked(options, skillNames, agents, base, state, recover)
    if (sweeps) {
      const { kept } = await sweepRetired(options, agents, base)
      for (const destination of kept) console.log(`kept locally edited copy (run with --force to replace it): ${destination}`)
      if (kept.length) process.exitCode = 1
    }
  }
  if (!options.dryRun) return withInstallLock(state, () => run())
  return run(false)
}

// One selection, one transaction. Every skill is checked and staged before anything is committed,
// so a refusal or a staging failure anywhere leaves the destination exactly as it was — the whole
// point of installing a family with one command.
async function installLocked(options: Options, skillNames: string[], agents: Agent[], base: string, state: string, recover = true) {
  if (recover) await recoverInstall(state, base)
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
  const journalPath = join(state, '.skills-install-transaction.json')
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
    if (await exists(journalPath)) await recoverInstall(state, base)
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
    const skipped = options.all ? (await liveCatalog()).filter(entry => entry.repoOnly).map(entry => entry.name) : []
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
  const { base } = baseFor(choice.mode, options.dir)
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

interface Receipt { version?: string; files?: Record<string, string> }

async function readReceipt(destination: string): Promise<Receipt | null> {
  try { return JSON.parse(await readFile(join(destination, '.vegastack-install.json'), 'utf8')) as Receipt }
  catch { return null }
}

// Brings installed skills up to date. A copy that still matches its install receipt was never
// edited, so replacing it loses nothing; an edited copy is kept unless --force.
async function update(options: Options, quietWhenCurrent = false, includeMissing: string[] = []): Promise<{ updated: number; kept: string[] }> {
  const choice = await prompt(options)
  const { base, state } = baseFor(choice.mode, options.dir)
  const agents = resolveAgents(choice.agent, choice.mode)
  const wanted = includeMissing.length ? includeMissing : hasSelector(options) ? await requireSelection(options, 'update') : await bundledSkills()
  const plan = new Map<Agent, string[]>()
  const kept: string[] = []
  for (const skillName of wanted) {
    const { files } = await loadSource(skillName)
    for (const agent of agents) {
      const destination = join(base, surfaces[agent], skillName)
      if (!await exists(destination)) {
        if (includeMissing.length) plan.set(agent, [...(plan.get(agent) ?? []), skillName])
        continue
      }
      if ((await compare(destination, files)).status === 'verified') continue
      const receipt = await readReceipt(destination)
      const untouched = receipt?.files ? (await compare(destination, receipt.files)).status === 'verified' : false
      if (untouched || options.force) plan.set(agent, [...(plan.get(agent) ?? []), skillName])
      else kept.push(destination)
    }
  }
  let updated = 0
  for (const [agent, skills] of plan) {
    const run = () => installLocked({ ...options, force: true, group: undefined, all: false }, skills, [agent], base, state, !options.dryRun)
    if (options.dryRun) await run()
    else await withInstallLock(state, run)
    updated += skills.length
  }
  // An upgrade is the one moment anyone learns a skill went away, so it is where the old copy
  // goes. Only an installer-owned copy — one still matching its own install receipt — is swept;
  // an edited one is kept and reported, exactly as an edited copy is on any other update.
  const swept = includeMissing.length ? { removed: 0, kept: [] as string[] } : await sweepRetired(options, agents, base)
  updated += swept.removed
  kept.push(...swept.kept)
  for (const destination of kept) console.log(`kept locally edited copy (run with --force to replace it): ${destination}`)
  if (!updated && !kept.length && !quietWhenCurrent) console.log('installed skills are up to date')
  if (kept.length) process.exitCode = 1
  return { updated, kept }
}

// Removes installer-owned copies of skills this bundle no longer ships. No source exists to
// compare against, so the receipt is the whole test: it records what the installer wrote, and a
// copy that still matches it has never been touched by anyone else.
async function sweepRetired(options: Options, agents: Agent[], base: string): Promise<{ removed: number; kept: string[] }> {
  const { retiredIn } = await import('./selection.ts')
  const catalog = await skillCatalog()
  const names = retiredIn({ skill: options.skill, group: options.group, all: options.all }, catalog)
  const kept: string[] = []
  const doomed: { name: string; agent: Agent; destination: string }[] = []
  for (const name of names) {
    for (const agent of agents) {
      const destination = join(base, surfaces[agent], name)
      if (!await exists(destination)) continue
      await assertNoSymlink(destination, false)
      const receipt = await readReceipt(destination)
      const untouched = receipt?.files ? (await compare(destination, receipt.files)).status === 'verified' : false
      if (untouched || options.force) doomed.push({ name, agent, destination })
      else kept.push(destination)
    }
  }
  const replacement = (name: string) => catalog.find(entry => entry.name === name)?.replacedBy
  for (const target of doomed) {
    const instead = replacement(target.name)
    if (options.dryRun) { console.log(`would remove retired ${target.agent}: ${target.destination}`); continue }
    await rm(target.destination, { recursive: true, force: true })
    console.log(`removed retired ${target.agent}: ${target.destination}${instead ? ` (replaced by ${instead})` : ''}`)
  }
  return { removed: options.dryRun ? 0 : doomed.length, kept }
}

async function confirm(question: string, options: Options): Promise<boolean> {
  if (options.nonInteractive || options.dryRun) return true
  if (!process.stdin.isTTY) throw new Error(`${question.replace(/\?$/, '')} needs confirmation — pass --yes when no one can answer`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
  rl.close()
  return answer === 'y' || answer === 'yes'
}

async function removeSkill(options: Options) {
  const skillNames = await requireSelection(options, 'remove')
  const choice = await prompt(options)
  const { base, state } = baseFor(choice.mode, options.dir)
  const agents = resolveAgents(choice.agent, choice.mode)
  if (!await confirm(`Remove ${skillNames.length} skill(s) for ${agents.join(' and ')} from ${base}?`, options)) {
    console.log('nothing removed')
    return
  }
  if (!options.dryRun) return withInstallLock(state, () => removeLocked(options, skillNames, agents, base, state))
  return removeLocked(options, skillNames, agents, base, state, false)
}

async function removeLocked(options: Options, skillNames: string[], agents: Agent[], base: string, state: string, recover = true) {
  // An interrupted install leaves a journal plus .<skill>.backup-* directories. Without settling
  // them first, a removal "succeeds" and the next add rolls those backups forward, bringing the
  // removed skills back. installLocked already recovers; remove must too, under the same lock.
  if (recover) await recoverInstall(state, base)
  const retired = new Set((await skillCatalog()).filter(entry => entry.retired).map(entry => entry.name))
  // Every drift check runs across the whole selection BEFORE the first removal, so a locally
  // modified member stops the run instead of leaving a half-removed family behind.
  const targets: { skill: string; agent: Agent; destination: string }[] = []
  for (const skill of skillNames) {
    for (const agent of agents) {
      const destination = join(base, surfaces[agent], skill)
      if (!await exists(destination)) { console.log(`not installed ${agent}: ${destination}`); continue }
      await assertNoSymlink(destination, false)
      if (!options.force) {
        // A retired skill has no bundled source left to compare against, so its own install
        // receipt stands in: same question, same answer — was this copy edited after install?
        const files = retired.has(skill) ? (await readReceipt(destination))?.files : (await loadSource(skill)).files
        const comparison = files ? await compare(destination, files) : { status: 'drifted' as const }
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
    const skipped = (await liveCatalog()).filter(entry => entry.repoOnly).map(entry => entry.name)
    if (skipped.length) console.log(`left ${skipped.length} repo-only skills in place: ${skipped.join(', ')} — name one explicitly to remove it`)
  }
  if (!targets.length) process.exitCode = 1
}

async function list() {
  const manifest = await loadManifest()
  const entries = await liveCatalog()
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
  const { base } = baseFor(options.mode ?? (options.dir ? 'project' : 'global'), options.dir)
  await access(base, fsConstants.R_OK | fsConstants.W_OK)
  await assertNoSymlink(base, false)
  let failed = false
  // The dev skills' per-project profile is plain markdown; the repo, not this file,
  // is the source of truth, so doctor only checks presence and basic shape.
  const project = resolve(options.dir ?? process.cwd())
  const profilePath = join(project, '.vegastack', 'dev.md')
  if (options.dir || await exists(join(project, '.git')) || await exists(profilePath)) {
    if (await exists(profilePath)) {
      const content = await readFile(profilePath, 'utf8')
      if (content.includes('## Knobs')) console.log(`ok dev profile: ${profilePath}`)
      else {
        console.log(`invalid dev profile: ${profilePath} (no "## Knobs" section; re-run dev-setup to regenerate)`)
        failed = true
      }
    } else {
      console.log(`missing dev profile: ${profilePath} — open this project in Claude Code or Codex and say "set up the dev workflow"`)
    }
  }
  console.log(`ok runtime: Node ${process.versions.node}`)
  // One npm version check so stale installs are visible.
  const latest = await latestPublishedVersion()
  if (latest && semverLess(packageVersion, latest)) console.log(`update available: installed ${packageVersion}, latest ${latest} — run: npm install -g @vegastack/vegafactory@latest && vegafactory skills update`)
  else if (latest && semverLess(latest, packageVersion)) console.log(`ok installer version: ${packageVersion} (ahead of registry latest ${latest})`)
  else if (latest) console.log(`ok installer version: ${packageVersion} (latest)`)
  else console.log(`skipped installer version check (npmjs.org unreachable); installed ${packageVersion}`)

  let installations = 0
  for (const skillName of await bundledSkills()) {
    const { files } = await loadSource(skillName)
    for (const agent of ['codex', 'claude'] as Agent[]) {
      const destination = join(base, surfaces[agent], skillName)
      if (!await exists(destination)) continue
      installations += 1
      const result = await compare(destination, files)
      console.log(`${result.status === 'verified' ? 'ok' : 'invalid'} ${agent} ${skillName} installation${result.issues.length ? ` (${result.issues.join(', ')})` : ''}`)
      if (result.status !== 'verified') failed = true
    }
  }
  if (!installations) { console.log(`no skills installed under ${base} — run: vegafactory init`); failed = true }
  if (failed) process.exitCode = 1
}

// `sync` is the one verb that reaches the network on purpose: one shallow fetch of the control
// room this project names, into a machine-local copy every skill then reads instead of GitHub.
// It refreshes by default — a hook calling a dry-run-by-default verb would be a silent no-op — and
// writes nothing outside the copy's path and ~/.vegafactory/factory.json.
async function sync(options: Options) {
  const {factoryConfigPath,loadProfile,readFactoryConfig}=await import('./control-room.ts')
  const {resolveTarget,syncControlRoom}=await import('./sync.ts')
  if (options.skill && options.skill !== 'profile') throw new Error('sync takes no subcommand except profile')
  const { base } = baseFor('project', options.dir)
  const devMdPath = join(base, '.vegastack', 'dev.md')
  const devMdText = await exists(devMdPath) ? await readFile(devMdPath, 'utf8') : ''
  const home = homedir()
  const statePath = factoryConfigPath(home)

  // The one way to read the control room. It resolves org, group and repo through the checked copy
  // — every identity and symlink check included — so nothing has to open a file in the checkout
  // and hope it is the file the record describes.
  if (options.skill === 'profile') {
    const profile = loadProfile({ home, devMd: devMdText })
    if (options.json) console.log(JSON.stringify(profile, null, 2))
    else {
      console.log(profile.room ? `control room ${profile.room.repo}${profile.room.group ? '#' + profile.room.group : ''}${profile.sha ? ' at ' + profile.sha.slice(0, 7) : ''}${profile.stale ? ' (stale)' : ''}` : 'this repo names no control room — skill defaults apply')
      for (const [key, value] of Object.entries(profile.values).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}   # ${profile.sources[key] ?? 'default'}`)
      }
      for (const block of profile.blocks) console.error(`  ! ${block}`)
    }
    process.exitCode = profile.ok ? 0 : 1
    return
  }

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

  const result = await syncControlRoom({ target, config, now: Date.now(), force: options.force, dryRun: options.dryRun })
  const code = result.ok ? 0 : 2
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

async function init(options: Options) {
  const { NEXT_STEP, checkTools, enableRepoHooks, ensureGlobalCli, probe, proposeNodeRow, renderSteps } = await import('./init.ts')
  const top = probe('git', ['rev-parse', '--show-toplevel'], process.cwd())
  const tools = checkTools(probe, process.versions.node, top.code === 0 ? top.stdout : process.cwd())
  console.log(renderSteps(tools))
  if (tools.some(step => step.status === 'fail')) {
    console.log('\nFix the FAIL lines above, then run init again.')
    process.exitCode = 1
    return
  }
  const failed = (step: { status: string }) => step.status === 'fail'
  const cli = ensureGlobalCli(probe, packageVersion, options.dryRun)
  console.log(renderSteps([cli]))
  const everyday = (await liveCatalog()).filter(entry => !entry.repoOnly).map(entry => entry.name)
  const { updated, kept } = await update({ ...options, mode: options.mode ?? 'global' }, true, everyday)
  const verb = options.dryRun ? 'would install or update' : 'installed or updated'
  console.log(`${options.dryRun ? 'skip' : 'done'}    skills  ${updated ? `${verb} ${updated}` : 'already up to date'}${kept.length ? ` · kept ${kept.length} locally edited` : ''}`)
  const hooks = enableRepoHooks(probe, process.cwd(), options.dryRun)
  console.log(renderSteps([hooks]))
  if ([cli, hooks].some(failed)) {
    console.log('\nFix the FAIL lines above, then run init again.')
    process.exitCode = 1
    return
  }
  if (options.org) await sync({ ...options, force: true })
  console.log(renderSteps([proposeNodeRow(probe)]))
  console.log(`\n${NEXT_STEP}`)
}

async function main() {
  const { assertSupportedPlatform } = await import('./env.ts')
  assertSupportedPlatform()
  // One check, for every command, before any of them reads a board. A half-set App pair is a
  // configuration error, not a lesser view of the world: an App-authored claim would read as
  // absent, so a second machine would be told the issue is free. Every command refuses by name.
  const { appIdentityOrExplain } = await import('./claim.ts')
  const identity = appIdentityOrExplain()
  if (!identity.ok) {
    console.error(`error: ${identity.reason}`)
    process.exitCode = 2
    return
  }
  const options = parse(process.argv.slice(2))
  if (options.command === 'hook') {
    const { hookUsage, runHook } = await import('./hook.ts')
    const rest = options.rest ?? []
    if (rest.length === 0 || ['help', '--help', '-h'].includes(rest[0]!)) return console.log(hookUsage())
    process.exitCode = await runHook(rest)
    return
  }
  if (options.command === 'init') return init(options)
  if (options.command === 'self-update') return runUpdateCommand(options.dryRun)
  if (options.command === 'update') { await update(options); return }
  if (options.command === 'worktree') {
    const {runWorktree, worktreeUsage}=await import('./worktree.ts')
    const rest = options.rest ?? []
    if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') return console.log(worktreeUsage())
    process.exitCode = await runWorktree(rest)
    return
  }
  if (options.command === 'issue') {
    const { runIssue } = await import('./issue.ts')
    process.exitCode = runIssue(options.rest ?? [])
    return
  }
  if (options.command === 'review') {
    const { runReview } = await import('./review.ts')
    process.exitCode = await runReview(options.rest ?? [])
    return
  }
  if (options.command === 'agent') {
    const { runAgent } = await import('./env.ts')
    process.exitCode = runAgent(options.rest ?? [])
    return
  }
  if (options.command === 'stats') {
    const { runStats } = await import('./stats.ts')
    process.exitCode = runStats(options.rest ?? [])
    return
  }
  if (options.command === 'dashboard') {
    const { runDashboard } = await import('./dashboard.ts')
    process.exitCode = runDashboard(options.rest ?? [])
    return
  }
  if (options.command === 'learning') {
    const { runLearning } = await import('./learning.ts')
    process.exitCode = runLearning(options.rest ?? [])
    return
  }
  if (options.command === 'ship') {
    const { runShip } = await import('./ship.ts')
    process.exitCode = runShip(options.rest ?? [])
    return
  }
  if (options.command === 'worker') {
    const { runWorker } = await import('./worker.ts')
    process.exitCode = await runWorker(options.rest ?? [])
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

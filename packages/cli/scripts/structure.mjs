#!/usr/bin/env node
// The repo's structure tool: it enforces and creates the shape authored skills live in.
// skill-maintainer owns the rules; this script is the deterministic method behind them, and is
// cited from the repo root the same way validate-skill.mjs already is.
//
//   node packages/cli/scripts/structure.mjs check [--strict] [--json] [--dir PATH]
//   node packages/cli/scripts/structure.mjs create-group <name> --title T --blurb B [--write] [--json] [--dir PATH]
//
// --dir points at a repo root other than this checkout (the tests use it); it defaults to the
// repo this script lives in.
//
// Division of labour: invariants that would corrupt the flat bundle (illegal depth, duplicate
// skill names, a group named like a skill) raise inside lib/skills.mjs at build time. Everything
// here is contract-level — GROUP.md shape, per-skill meta files, README rows and sections,
// packaging correspondence — and is reported, never repaired.
// Machine-verifiable facts block; judgement-level observations only warn, per the guard doctrine
// in dev-setup's conventions.
//
// Exit codes: 0 clean or warnings-only · 2 blocked · 1 create-group refusal · 2 usage error.
// Warnings deliberately do NOT fail: `check` is chained into the root `check` script with `&&`,
// and the guard doctrine says judgement-level observations warn without blocking. `--strict`
// exits 1 on warnings for a caller that wants them fatal.
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverGroups, discoverSkills, nameError, readGroupDoc } from './lib/skills.mjs'

// Every skill carries these; the scaffolder writes them all, so a gap means a hand-made tree.
const REQUIRED_SKILL_FILES = ['SKILL.md', 'agents/openai.yaml']
// Text the scaffolder leaves for a human to replace. Its presence is a smell, never a build break.
const PLACEHOLDER = /TODO/

const posix = (path) => path.split(sep).join('/')

// ---------------------------------------------------------------------------
// README parsing
//
// The Skills region runs from "## Skills" to the next "## " heading. Inside it, rows before the
// first "### " belong to ungrouped skills; each "### " opens a group section whose heading text
// must equal that group's GROUP.md title.
// ---------------------------------------------------------------------------

// One home for the region bounds: the checker and the writer must never disagree about where
// the Skills region begins and ends.
export function skillsRegion(lines) {
  const start = lines.findIndex((line) => /^##\s+Skills\s*$/.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]) && !/^###/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

export function parseSkillsRegion(readmeBody) {
  const lines = readmeBody.split('\n')
  const region = skillsRegion(lines)
  if (!region) return null
  const { start, end } = region

  const sections = [{ title: null, heading: null, rows: [], body: [] }]
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line)
    if (heading) {
      sections.push({ title: heading[1], heading: line, rows: [], body: [] })
      continue
    }
    const section = sections[sections.length - 1]
    section.body.push(line)
    const row = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/.exec(line)
    if (row) section.rows.push({ name: row[1], target: row[2].replace(/\/$/, ''), line })
  }
  return sections
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

// evals/evals.json is recommended, never required: the brief for skill evals made it warn-only so
// a skill without cases still builds, while the shape rules below keep a present file honest
// (agentskills.io format — skill_name, evals[] {id, prompt, expected_output, files[], assertions[]}).
export function evalsWarnings(skill, root) {
  const label = `${posix(relative(root, skill.path))}/evals/evals.json`
  const path = join(skill.path, 'evals', 'evals.json')
  if (!existsSync(path)) return [`${label} is missing — every skill carries 2–3 agentskills.io eval cases (skillify Phase 4)`]
  let data
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return [`${label} does not parse: ${error.message}`]
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [`${label} does not parse: the root must be a JSON object`]
  const warns = []
  if (data.skill_name !== skill.name) warns.push(`${label} names skill_name "${data.skill_name}" but the skill is "${skill.name}"`)
  if (!Array.isArray(data.evals) || data.evals.length === 0) return [...warns, `${label} has no cases — "evals" must be a non-empty array`]
  const seen = new Set()
  data.evals.forEach((item, index) => {
    const n = index + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) { warns.push(`${label} case ${n} is not an object`); return }
    if (!Number.isInteger(item.id)) warns.push(`${label} case ${n} is missing id (an integer)`)
    else if (seen.has(item.id)) warns.push(`${label} case ${n} id is repeated`)
    else seen.add(item.id)
    for (const field of ['prompt', 'expected_output']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) warns.push(`${label} case ${n} is missing ${field}`)
    }
    if (!Array.isArray(item.assertions)) warns.push(`${label} case ${n} is missing assertions (an array; empty until the first run is allowed)`)
    if (item.files !== undefined && !(Array.isArray(item.files) && item.files.every((file) => typeof file === 'string'))) {
      warns.push(`${label} case ${n} files must be an array of strings`)
    }
    if (PLACEHOLDER.test(item.prompt ?? '') || PLACEHOLDER.test(item.expected_output ?? '')) warns.push(`${label} still carries the scaffolded placeholder case`)
  })
  return warns
}

export function checkStructure(repoRoot) {
  const blocks = []
  const warns = []
  const root = resolve(repoRoot)
  const skillsRoot = join(root, 'skills')

  let skills
  try {
    skills = discoverSkills(skillsRoot)
  } catch (error) {
    // A layout error that would break the build is reported here rather than thrown, so one
    // command surfaces every structural problem at once.
    return { blocks: [error.message], warns }
  }
  const groups = discoverGroups(skillsRoot)

  // --- groups: GROUP.md shape, and nothing loose beside the skills ---
  const groupDocs = new Map()
  for (const [name, group] of [...groups].sort()) {
    const doc = readGroupDoc(group.path)
    if (!doc) {
      blocks.push(`skills/${name}/GROUP.md is missing or malformed — a group needs an H1 title followed by one non-empty blurb line`)
    } else {
      groupDocs.set(name, doc)
      if (PLACEHOLDER.test(doc.blurb)) warns.push(`skills/${name}/GROUP.md still carries scaffolded placeholder text in its blurb`)
    }
    for (const entry of readdirSync(group.path, { withFileTypes: true })) {
      // Dotfiles are tool and OS leftovers (.DS_Store), consistent with discovery ignoring
      // dot-directories; blocking on them would fail the check on a stock macOS checkout.
      if (entry.isDirectory() || entry.name === 'GROUP.md' || entry.name.startsWith('.')) continue
      blocks.push(`skills/${name}/${entry.name} is not allowed — a group directory holds only skill directories and its GROUP.md`)
    }
    const members = [...skills.values()].filter((skill) => skill.group === name)
    if (members.length === 0) warns.push(`group "${name}" holds no skills — finish moving skills into it, or remove skills/${name}/`)
    else if (members.length === 1) warns.push(`group "${name}" holds a single skill (${members[0].name}) — a family of one is usually better ungrouped`)
  }

  // --- per-skill meta files ---
  for (const skill of [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const file of REQUIRED_SKILL_FILES) {
      if (!existsSync(join(skill.path, file))) {
        blocks.push(`${posix(relative(root, skill.path))}/${file} is missing — every skill carries ${REQUIRED_SKILL_FILES.join(', ')}`)
      }
    }
    warns.push(...evalsWarnings(skill, root))
  }

  // --- packaging correspondence, both directions, with bare-name keys ---
  const packagingPath = join(root, 'packages/cli/packaging.json')
  if (!existsSync(packagingPath)) {
    blocks.push('packages/cli/packaging.json is missing')
  } else {
    let packaged
    try {
      packaged = JSON.parse(readFileSync(packagingPath, 'utf8'))
    } catch (error) {
      blocks.push(`packages/cli/packaging.json does not parse: ${error.message}`)
      packaged = null
    }
    if (packaged) {
      for (const key of Object.keys(packaged).sort()) {
        if (key.includes('/')) {
          blocks.push(`packaging.json key "${key}" must be a bare skill name — the packaged bundle is flat, so a key never carries a group`)
          continue
        }
        if (!skills.has(key)) blocks.push(`packaging.json names "${key}", which is not an authored skill`)
      }
      for (const name of [...skills.keys()].sort()) {
        if (!(name in packaged)) blocks.push(`skill "${name}" has no packages/cli/packaging.json entry`)
      }

    }
  }

  // --- root README: one row per skill, in the section matching where it lives ---
  const readmePath = join(root, 'README.md')
  if (!existsSync(readmePath)) {
    blocks.push('README.md is missing')
    return { blocks, warns }
  }
  const sections = parseSkillsRegion(readFileSync(readmePath, 'utf8'))
  if (!sections) {
    blocks.push('README.md has no "## Skills" section')
    return { blocks, warns }
  }

  // A title is a group's address in the README, so two groups sharing one would silently merge
  // both families into a single section — and each group needs a section to be addressable at all.
  const byTitle = new Map()
  for (const [name, doc] of groupDocs) {
    const existing = byTitle.get(doc.title)
    if (existing) blocks.push(`groups "${existing}" and "${name}" share the GROUP.md title "${doc.title}" — a title addresses exactly one README section, so they must differ`)
    else byTitle.set(doc.title, name)
  }
  const titleToGroup = new Map([...groupDocs].map(([name, doc]) => [doc.title, name]))
  const rowSection = new Map()
  for (const section of sections) {
    if (section.title !== null) {
      const group = titleToGroup.get(section.title)
      if (!group) {
        blocks.push(`README.md has a "### ${section.title}" section under Skills that matches no group's GROUP.md title`)
      } else {
        const doc = groupDocs.get(group)
        if (!section.body.some((line) => line.trim() === doc.blurb)) {
          blocks.push(`README.md section "### ${section.title}" does not carry skills/${group}/GROUP.md's blurb line`)
        }
        if (section.body.some((line) => PLACEHOLDER.test(line) && !line.startsWith('|'))) {
          warns.push(`README.md section "### ${section.title}" still carries scaffolded placeholder text`)
        }
      }
    }
    for (const row of section.rows) {
      if (rowSection.has(row.name)) blocks.push(`README.md lists "${row.name}" more than once under Skills`)
      rowSection.set(row.name, { section, row })
      if (PLACEHOLDER.test(row.line)) warns.push(`README.md row for "${row.name}" still carries a scaffolded placeholder description`)
    }
  }

  for (const [name, doc] of groupDocs) {
    if (!sections.some((section) => section.title === doc.title)) {
      blocks.push(`group "${name}" has no "### ${doc.title}" section in README.md — create it with structure.mjs create-group, or remove the group`)
    }
  }
  for (const name of rowSection.keys()) {
    if (!skills.has(name)) blocks.push(`README.md lists "${name}" under Skills, but no such skill is authored`)
  }
  for (const skill of [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const entry = rowSection.get(skill.name)
    if (!entry) {
      blocks.push(`skill "${skill.name}" has no row in README.md's Skills section`)
      continue
    }
    const expectedTarget = `skills/${skill.group ? `${skill.group}/` : ''}${skill.name}`
    if (entry.row.target !== expectedTarget) {
      blocks.push(`README.md row for "${skill.name}" links ${entry.row.target}/ but the skill lives at ${expectedTarget}/`)
    }
    const expectedTitle = skill.group ? groupDocs.get(skill.group)?.title ?? null : null
    if ((entry.section.title ?? null) !== expectedTitle) {
      const where = expectedTitle ? `the "### ${expectedTitle}" section` : 'the ungrouped table above the group sections'
      const found = entry.section.title ? `"### ${entry.section.title}"` : 'the ungrouped table'
      blocks.push(`README.md row for "${skill.name}" sits in ${found} but belongs in ${where}`)
    }
  }

  return { blocks, warns }
}

// ---------------------------------------------------------------------------
// create-group
// ---------------------------------------------------------------------------

function writeAtomic(path, body) {
  const staging = `${path}.structure-tmp`
  writeFileSync(staging, body)
  renameSync(staging, path)
}

function entryAt(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

// Inserts the group's section at the end of the Skills region's tables: after the last existing
// group section, or after the ungrouped table when this is the first group. The install snippet
// that follows the tables stays where it is.
export function insertGroupSection(readmeBody, title, blurb) {
  const lines = readmeBody.split('\n')
  const region = skillsRegion(lines)
  if (!region) return null
  const { start, end } = region
  let lastRow = -1
  for (let i = start + 1; i < end; i += 1) if (lines[i].startsWith('|')) lastRow = i
  if (lastRow === -1) return null
  const section = [`### ${title}`, '', blurb, '', '| Skill | What it does | Docs |', '|---|---|---|', '']
  lines.splice(lastRow + 1, 0, '', ...section.slice(0, -1))
  return lines.join('\n')
}

export function createGroup({ name, repoRoot, title, blurb, write = false }) {
  const invalid = nameError(name)
  if (invalid) throw new Error(`Invalid group name ${JSON.stringify(name ?? null)}: ${invalid}`)
  if (!repoRoot) throw new Error('repoRoot is required')
  if (!title || !blurb) throw new Error('a group needs both a --title and a --blurb')
  // Write only what readGroupDoc will accept: a single-line H1 title, then a single-line blurb
  // that is not itself a heading. Otherwise the tool emits a GROUP.md its own checker rejects.
  for (const [label, value] of [['title', title], ['blurb', blurb]]) {
    if (value.includes('\n')) throw new Error(`--${label} must be a single line`)
    if (value.trim() !== value || !value.trim()) throw new Error(`--${label} must not be blank or padded with whitespace`)
    if (value.startsWith('#')) throw new Error(`--${label} must not start with "#" — GROUP.md's shape is an H1 title followed by one plain blurb line`)
    if (value.startsWith('|')) throw new Error(`--${label} must not start with "|" — the README's row parser would read it as a skill row`)
  }
  const root = resolve(repoRoot)
  const skillsRoot = join(root, 'skills')
  const skillsEntry = entryAt(skillsRoot)
  if (!skillsEntry || !skillsEntry.isDirectory()) {
    throw new Error(`${skillsRoot} is not a real directory — point --dir at the vegafactory repo root`)
  }
  const target = join(skillsRoot, name)
  const existing = entryAt(target)
  // lstat does not follow symlinks, so a symlinked group path fails isDirectory() and refuses.
  if (existing && !existing.isDirectory()) throw new Error(`Refusing to create a group at ${target}: it exists and is not a directory`)
  if (existing && existsSync(join(target, 'SKILL.md'))) throw new Error(`Refusing to create a group at ${target}: a skill already lives there`)
  // Group and skill names share one namespace, so a group named after a skill in ANOTHER group
  // would make the repo unbuildable. Discovery owns that rule; consult it before mutating, not
  // after — the whole point of a dry-run-by-default mutator is that a refusal writes nothing.
  let authored
  try {
    authored = discoverSkills(skillsRoot)
  } catch (error) {
    throw new Error(`Cannot create a group while the skills tree is already invalid: ${error.message}`)
  }
  const clash = authored.get(name)
  if (clash) throw new Error(`Refusing to create a group named "${name}": a skill of that name already lives at ${clash.path} — group and skill names share one namespace`)

  // A different title on an existing group is a rename, not a create: it would leave the old
  // section orphaned and add a second one. Refuse, and say which title is in force.
  const wiring = []
  const groupDocPath = join(target, 'GROUP.md')
  const docExists = Boolean(entryAt(groupDocPath))
  if (docExists) {
    const current = readGroupDoc(target)
    // A null here means the existing GROUP.md is malformed. Treating that as "no title to
    // conflict with" is how the guard below got skipped and a second section written.
    if (!current) {
      throw new Error(`skills/${name}/GROUP.md exists but is malformed — repair it by hand (an H1 title, then one plain blurb line) or delete it; refusing to write over an unreadable group`)
    }
    if (current.title !== title) {
      throw new Error(`Group "${name}" already exists with the title "${current.title}"; refusing to write a second section titled "${title}" — rename the heading in README.md and GROUP.md together instead`)
    }
    // The README section must carry GROUP.md's blurb verbatim (checkStructure enforces it), so a
    // different blurb here would write a section this command's own checker then blocks.
    if (current.blurb !== blurb) {
      throw new Error(`Group "${name}" already exists with the blurb "${current.blurb}"; the README section must carry GROUP.md's blurb verbatim — pass that blurb, or edit skills/${name}/GROUP.md and the README section together`)
    }
  }
  for (const [otherName, doc] of [...discoverGroups(skillsRoot)].filter(([other]) => other !== name).map(([other, group]) => [other, readGroupDoc(group.path)])) {
    if (doc && doc.title === title) throw new Error(`Group "${otherName}" already uses the title "${title}" — a title addresses exactly one README section`)
  }
  const readmePath = join(root, 'README.md')
  // statSync follows symlinks, matching how checkStructure reads this file. lstatSync did not,
  // so a symlinked README.md was reported "not found" and the group was created without a section.
  const readmeIsFile = existsSync(readmePath) && statSync(readmePath).isFile()
  const readmeBody = readmeIsFile ? readFileSync(readmePath, 'utf8') : null
  const sectionExists = readmeBody !== null && (parseSkillsRegion(readmeBody) ?? []).some((section) => section.title === title)

  // Every group the checker accepts has a README section, so a section this command cannot write
  // is a refusal, not a "skipped:" success — otherwise create-group leaves a tree its own check
  // blocks and still exits 0.
  let plannedReadme = null
  if (readmeBody === null) {
    throw new Error(`README.md is missing or is not a readable file at ${readmePath} — every group needs its README section, so refusing rather than creating a group the structure check would block`)
  }
  if (!sectionExists) {
    plannedReadme = insertGroupSection(readmeBody, title, blurb)
    if (plannedReadme === null) {
      throw new Error(`README.md has no "## Skills" table to add a "### ${title}" section to — every group needs its section, so refusing rather than creating a group the structure check would block`)
    }
  } else if (sectionExists) {
    // An existing section whose blurb disagrees is the same false success from the other side:
    // GROUP.md would be written knowing the section does not carry its blurb.
    const section = (parseSkillsRegion(readmeBody) ?? []).find((entry) => entry.title === title)
    if (!section.body.some((line) => line.trim() === blurb)) {
      throw new Error(`README.md's "### ${title}" section does not carry the blurb "${blurb}" — the section must carry GROUP.md's blurb verbatim; pass the blurb already in the README, or edit both together`)
    }
  }

  if (!write) {
    wiring.push({ step: 'GROUP.md', status: docExists ? 'skipped: already exists' : 'planned' })
    wiring.push({ step: 'root README section', status: readmeBody === null ? 'skipped: README.md not found' : sectionExists ? 'skipped: already exists' : 'planned' })
    return { name, path: target, files: ['GROUP.md'], wrote: false, wiring }
  }

  if (docExists) {
    wiring.push({ step: 'GROUP.md', status: 'skipped: already exists' })
  } else {
    mkdirSync(target, { recursive: true })
    writeAtomic(groupDocPath, `# ${title}\n\n${blurb}\n`)
    wiring.push({ step: 'GROUP.md', status: 'done' })
  }

  if (readmeBody === null) {
    wiring.push({ step: 'root README section', status: 'skipped: README.md not found' })
  } else if (sectionExists) {
    wiring.push({ step: 'root README section', status: 'skipped: already exists' })
  } else {
    writeAtomic(readmePath, plannedReadme)
    wiring.push({ step: 'root README section', status: 'done' })
  }

  return { name, path: target, files: ['GROUP.md'], wrote: true, wiring }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const rest = [...argv]
  const command = rest.shift()
  const options = { command, name: undefined, title: undefined, blurb: undefined, write: false, json: false, strict: false, dir: undefined }
  while (rest.length) {
    const flag = rest.shift()
    if (['--title', '--blurb', '--dir'].includes(flag)) {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) throw new Error(`${flag} requires a value`)
      options[flag.slice(2)] = value
    }
    else if (flag === '--write') options.write = true
    else if (flag === '--strict') options.strict = true
    else if (flag === '--json') options.json = true
    else if (flag.startsWith('-')) throw new Error(`Unknown option: ${flag}`)
    else if (options.name === undefined) options.name = flag
    else throw new Error(`Unexpected argument: ${flag}`)
  }
  if (!['check', 'create-group'].includes(options.command)) {
    throw new Error('Usage: structure.mjs <check|create-group> [name] [--title T] [--blurb B] [--write] [--strict] [--json] [--dir PATH]')
  }
  if (options.command === 'create-group' && !options.name) throw new Error('create-group requires a group name')
  return options
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(2)
  }
  const repoRoot = options.dir ? resolve(options.dir) : resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

  if (options.command === 'check') {
    const { blocks, warns } = checkStructure(repoRoot)
    if (options.json) {
      console.log(JSON.stringify({ guard: 'structure', ok: blocks.length === 0, blocks, warns }, null, 2))
    } else {
      for (const block of blocks) console.error(`block: ${block}`)
      for (const warn of warns) console.warn(`warn:  ${warn}`)
      if (!blocks.length && !warns.length) console.log('structure: ok')
    }
    process.exit(blocks.length ? 2 : (warns.length && options.strict) ? 1 : 0)
  }

  try {
    const result = createGroup({ ...options, repoRoot })
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(result.wrote ? `Created group ${result.path}` : `Dry run - pass --write to create ${result.path}`)
      for (const { step, status } of result.wiring) console.log(`  - ${step}: ${status}`)
    }
    process.exit(0)
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(1)
  }
}

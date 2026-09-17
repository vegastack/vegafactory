#!/usr/bin/env node
// Scaffold a new skill tree at skills/<name>/ (or skills/<group>/<name>/) from skillify's
// templates.
//
//   node scripts/scaffold-skill.mjs <skill-name> --dir <repo-root> [--group <group>] [--write] [--json]
//
// --group places the skill in an existing group. Creating a group is skill-maintainer's job
// (packages/cli/scripts/structure.mjs create-group), so an unknown group is refused rather than
// invented: a mistyped group must never bring a stray family into existence.
//
// Dry-run by default: prints the plan (files that would be created plus the
// wiring actions that would be performed) and creates nothing. --write stages
// the tree in a temporary sibling inside skills/ and renames it into place,
// refusing existing directories and symlinks, then performs the repo wiring
// itself: packaging.json entry, root README row, changeset. Exit codes: 0 ok,
// 1 refusal or failure, 2 usage error.
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const templatesRoot = resolve(here, '..', 'assets', 'templates')

// Template file -> output path inside the skill (null = tests/<name>.test.ts).
export const templateFiles = [
  ['SKILL.md.template', 'SKILL.md'],
  ['openai.yaml.template', 'agents/openai.yaml'],
  // One placeholder case; the structure check warns until real cases replace it (skillify Phase 4).
  ['evals.json.template', 'evals/evals.json'],
  // Scaffolded empty so the shape test stays red until real queries are written.
  ['trigger-queries.json.template', 'tests/fixtures/trigger-queries.json'],
  ['skill.test.ts.template', null],
]

// The scaffolded files that ship to installers (tests and evals never package).
const defaultPackagedFiles = ['SKILL.md', 'agents/openai.yaml']

// Full grammar shared by the repo validator and every target harness: starts
// with a lowercase letter, then lowercase letters/digits/hyphens, no
// consecutive hyphens, no trailing hyphen, at most 64 characters.
export function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'skill name is required'
  if (name.length > 64) return `name is ${name.length} characters; the maximum is 64`
  if (!/^[a-z]/.test(name)) return 'name must start with a lowercase letter'
  if (!/^[a-z0-9-]+$/.test(name)) return 'name may contain only lowercase letters, digits, and hyphens'
  if (name.includes('--')) return 'name must not contain consecutive hyphens'
  if (name.endsWith('-')) return 'name must not end with a hyphen'
  return null
}

// This script ships inside the skillify skill, so it must stay dependency-free and cannot import
// the repo's lib/skills.mjs. Deliberate small duplication of its GROUP.md title read; the two are
// kept honest by structure.mjs check, which fails when the README and GROUP.md disagree.
export function groupTitle(markdown) {
  const lines = markdown.split('\n')
  const headingIndex = lines.findIndex(line => /^#\s+\S/.test(line))
  if (headingIndex === -1) return null
  const title = lines[headingIndex].replace(/^#\s+/, '').trim()
  const blurb = lines.slice(headingIndex + 1).find(line => line.trim() !== '')?.trim()
  if (!title || !blurb || blurb.startsWith('#')) return null
  return title
}

// Two-level scan mirroring lib/skills.mjs's discovery. Duplicated for the same reason as
// groupTitle: this script ships inside the skillify skill and cannot import repo tooling.
async function findSkillAnywhere(skillsRoot, name) {
  if ((await entryAt(join(skillsRoot, name, 'SKILL.md')))?.isFile()) return join(skillsRoot, name)
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(skillsRoot, entry.name, name)
    if ((await entryAt(join(path, 'SKILL.md')))?.isFile()) return path
  }
  return null
}

async function entryAt(path) {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function writeAtomic(path, body) {
  const staging = `${path}.scaffold-tmp`
  await writeFile(staging, body)
  await rename(staging, path)
}

// Adds the new skill's entry to packages/cli/packaging.json with the default
// scaffolded runtime files. Extra authored files added later must be appended
// there by hand — sync-skill.mjs still fails loudly on anything unlisted.
async function wirePackaging(repoRoot, name, write) {
  const path = join(repoRoot, 'packages/cli/packaging.json')
  if (!(await entryAt(path))?.isFile()) return { step: 'packaging.json entry', status: 'skipped: packages/cli/packaging.json not found' }
  const packaged = JSON.parse(await readFile(path, 'utf8'))
  if (name in packaged) return { step: 'packaging.json entry', status: 'skipped: entry already exists' }
  if (!write) return { step: 'packaging.json entry', status: 'planned' }
  packaged[name] = defaultPackagedFiles
  const sorted = Object.fromEntries(Object.keys(packaged).sort().map(key => [key, packaged[key]]))
  await writeAtomic(path, `${JSON.stringify(sorted, null, 2)}\n`)
  return { step: 'packaging.json entry', status: 'done' }
}

// Resolves where a row belongs: the end of the ungrouped table, or of the table under the
// group's "### <title>" section. Both windows are bounded by the "## Skills" region, so a row can
// never land in a neighbouring family's table or in an unrelated table elsewhere in the README.
// Returns null when the README has no usable table, so callers can refuse before writing rather
// than report a "skipped:" success afterwards.
export function findRowInsertion(lines, group, groupHeading) {
  const regionStart = lines.findIndex(line => /^##\s+Skills\s*$/.test(line))
  if (regionStart < 0) return null
  const afterRegion = lines.findIndex((line, index) => index > regionStart && /^##\s+/.test(line) && !/^###/.test(line))
  const regionEnd = afterRegion < 0 ? lines.length : afterRegion

  let from = regionStart
  let to = regionEnd
  if (group) {
    from = lines.findIndex((line, index) => index > regionStart && index < regionEnd && line.trim() === `### ${groupHeading}`)
    if (from < 0) return { missingSection: true }
    const next = lines.findIndex((line, index) => index > from && index < regionEnd && /^###\s+/.test(line))
    to = next < 0 ? regionEnd : next
  } else {
    const firstSection = lines.findIndex((line, index) => index > regionStart && index < regionEnd && /^###\s+/.test(line))
    if (firstSection >= 0) to = firstSection
  }

  const header = lines.findIndex((line, index) => index >= from && index < to && /^\| *Skill *\|/.test(line))
  if (header < 0 || !/^\|[ -]*---/.test(lines[header + 1] ?? '')) return null
  let last = header + 1
  while (last + 1 < to && lines[last + 1]?.startsWith('|')) last += 1
  return { index: last }
}

async function wireReadme(repoRoot, name, group, groupHeading, write) {
  const path = join(repoRoot, 'README.md')
  if (!(await entryAt(path))?.isFile()) return { step: 'root README row', status: 'skipped: README.md not found' }
  const body = await readFile(path, 'utf8')
  const relativePath = group ? `${group}/${name}` : name
  if (body.includes(`](skills/${relativePath}/)`)) return { step: 'root README row', status: 'skipped: row already exists' }
  const lines = body.split('\n')

  const target = findRowInsertion(lines, group, groupHeading)
  if (target?.missingSection) throw new Error(`README.md has no "### ${groupHeading}" section for group "${group}" - create it with structure.mjs create-group`)
  if (!target) return { step: 'root README row', status: 'skipped: Skills table not found' }
  const last = target.index
  if (!write) return { step: 'root README row', status: 'planned' }
  const row = `| [${name}](skills/${relativePath}/) | TODO: one-line description | [SKILL.md](skills/${relativePath}/SKILL.md) |`
  lines.splice(last + 1, 0, row)
  await writeAtomic(path, lines.join('\n'))
  return { step: 'root README row', status: 'done' }
}

// Writes the changeset introducing the skill (content versioning: new skill = minor).
async function wireChangeset(repoRoot, name, write) {
  const directory = join(repoRoot, '.changeset')
  if (!(await entryAt(directory))?.isDirectory()) return { step: 'changeset', status: 'skipped: .changeset/ not found' }
  const path = join(directory, `add-${name}.md`)
  if (await entryAt(path)) return { step: 'changeset', status: 'skipped: changeset already exists' }
  if (!write) return { step: 'changeset', status: 'planned' }
  await writeAtomic(path, `---\n"@vegastack/vegafactory": minor\n---\n\nAdd the ${name} skill.\n`)
  return { step: 'changeset', status: 'done' }
}

export async function wireSkill({ name, repoRoot, group = null, groupHeading = null, write = false }) {
  // groupHeading is an optimisation for scaffoldSkill, which has already read GROUP.md. A caller
  // using the documented { name, repoRoot, group, write } shape gets it derived here rather than
  // a row addressed to "### null".
  if (group && !groupHeading) {
    const doc = await entryAt(join(repoRoot, 'skills', group, 'GROUP.md'))
    if (!doc?.isFile()) throw new Error(`Group "${group}" has no GROUP.md - every group carries one`)
    groupHeading = groupTitle(await readFile(join(repoRoot, 'skills', group, 'GROUP.md'), 'utf8'))
    if (!groupHeading) throw new Error(`skills/${group}/GROUP.md is malformed - it needs an H1 title followed by one non-empty blurb line`)
  }
  return [
    await wirePackaging(repoRoot, name, write),
    await wireReadme(repoRoot, name, group, groupHeading, write),
    await wireChangeset(repoRoot, name, write),
  ]
}

export async function scaffoldSkill({ name, dir, group = null, write = false, now = new Date() }) {
  const nameError = validateName(name)
  if (nameError) throw new Error(`Invalid skill name ${JSON.stringify(name ?? null)}: ${nameError}`)
  if (!dir) throw new Error('--dir <repo-root> is required')
  const repoRoot = resolve(dir)
  const skillsRoot = join(repoRoot, 'skills')
  const skillsEntry = await entryAt(skillsRoot)
  // lstat does not follow symlinks, so a symlinked skills/ fails isDirectory().
  if (!skillsEntry || !skillsEntry.isDirectory()) {
    throw new Error(`${skillsRoot} is not a real directory - point --dir at the vegafactory repo root`)
  }

  // A group must already exist and carry a well-formed GROUP.md; creating one is
  // skill-maintainer's structure.mjs create-group, never a side effect of scaffolding a skill.
  let groupHeading = null
  if (group) {
    const groupError = validateName(group)
    if (groupError) throw new Error(`Invalid group name ${JSON.stringify(group)}: ${groupError}`)
    const groupRoot = join(skillsRoot, group)
    const groupEntry = await entryAt(groupRoot)
    if (!groupEntry || !groupEntry.isDirectory()) {
      throw new Error(`Group "${group}" does not exist at ${groupRoot} - create it first with: node packages/cli/scripts/structure.mjs create-group ${group} --title <title> --blurb <blurb> --write`)
    }
    const groupDoc = await entryAt(join(groupRoot, 'GROUP.md'))
    if (!groupDoc?.isFile()) throw new Error(`Group "${group}" has no GROUP.md - every group carries one; see skill-maintainer's group workflow`)
    groupHeading = groupTitle(await readFile(join(groupRoot, 'GROUP.md'), 'utf8'))
    if (!groupHeading) throw new Error(`skills/${group}/GROUP.md is malformed - it needs an H1 title followed by one non-empty blurb line`)
  }

  const parent = group ? join(skillsRoot, group) : skillsRoot
  const target = join(parent, name)
  if (await entryAt(target)) throw new Error(`Refusing to scaffold: ${target} already exists`)

  // Skill names are unique across the whole tree, not just within one directory: the packaged
  // bundle is flat, so a duplicate at the other depth would break the next build. Checked here,
  // before anything is written, rather than left to that build.
  const clash = await findSkillAnywhere(skillsRoot, name)
  if (clash) throw new Error(`Refusing to scaffold: a skill named "${name}" already exists at ${clash} - the packaged bundle is flat, so skill names are unique across the whole tree`)

  // Every refusal belongs in this pre-flight. wireReadme runs after the tree is renamed into
  // place and the packaging entry written, so anything discovered there would leave a half-wired
  // skill on disk while reporting a refusal - or, worse, report success with no row at all.
  // Both wiring targets a scaffolded skill cannot do without must therefore be resolvable BEFORE
  // the tree is staged: an absent one is a refusal, not a `skipped:` status, because a skill with
  // no README row or no packaging entry is exactly the state structure.mjs check blocks. Only
  // `.changeset/` still degrades to `skipped:` - a missing changeset breaks no check.
  const readmePath = join(repoRoot, 'README.md')
  if (!(await entryAt(readmePath))?.isFile()) {
    throw new Error(`README.md not found at ${readmePath} - every skill needs its Skills-table row, so refusing rather than scaffolding a skill the structure check would block`)
  }
  const lines = (await readFile(readmePath, 'utf8')).split('\n')
  const rowTarget = findRowInsertion(lines, group, groupHeading)
  if (rowTarget?.missingSection) {
    throw new Error(`README.md has no "### ${groupHeading}" section for group "${group}" - create it with structure.mjs create-group`)
  }
  if (!rowTarget) {
    throw new Error(`README.md has no ${group ? `table under "### ${groupHeading}"` : 'ungrouped Skills table'} to add a row to - every skill needs its row, so refusing rather than scaffolding a skill the structure check would block`)
  }

  const packagingPath = join(repoRoot, 'packages/cli/packaging.json')
  if (!(await entryAt(packagingPath))?.isFile()) {
    throw new Error(`packages/cli/packaging.json not found at ${packagingPath} - every skill needs its packaging entry, so refusing rather than scaffolding a skill the structure check would block`)
  }

  // The generated test imports the repo validator by relative path, so its depth follows the
  // skill's: skills/<name>/tests/ is three levels up, skills/<group>/<name>/tests/ is four.
  const validatorPath = `${group ? '../../../..' : '../../..'}/packages/cli/scripts/validate-skill.mjs`
  // Only a grouped skill gets the family-install block; an ungrouped one would otherwise ship a
  // command naming a group that does not exist. It is its own fence, not a second line in the
  // first one: pasting a shared fence would run the alternative too.
  const groupInstallBlock = group
    ? `\nOr the whole ${group} family at once:\n\n\`\`\`sh\nnpx @vegastack/vegafactory skills add --group ${group} --global\n\`\`\`\n`
    : ''

  const outputs = templateFiles.map(([source, output]) => [source, output ?? `tests/${name}.test.ts`])
  const plan = { name, group, target, files: outputs.map(([, output]) => output), wrote: false }
  if (!write) return { ...plan, wiring: await wireSkill({ name, repoRoot, group, groupHeading }) }

  const date = now.toISOString().slice(0, 10)
  const staging = await mkdtemp(join(parent, `.${name}.scaffold-`))
  try {
    for (const [source, output] of outputs) {
      const body = await readFile(join(templatesRoot, source), 'utf8')
      const rendered = body
        .replaceAll('{{name}}', name)
        .replaceAll('{{date}}', date)
        .replaceAll('{{validatorPath}}', validatorPath)
        .replaceAll('{{groupInstallBlock}}', groupInstallBlock)
      const destination = join(staging, output)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, rendered)
    }
    if (await entryAt(target)) throw new Error(`Refusing to scaffold: ${target} already exists`)
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { ...plan, wrote: true, wiring: await wireSkill({ name, repoRoot, group, groupHeading, write: true }) }
}

function parseArguments(argv) {
  const options = { name: undefined, dir: undefined, group: null, write: false, json: false }
  const rest = [...argv]
  while (rest.length) {
    const flag = rest.shift()
    if (flag === '--dir') {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) throw new Error('--dir requires a value')
      options.dir = value
    } else if (flag === '--group') {
      const value = rest.shift()
      if (value === undefined || value.startsWith('-')) throw new Error('--group requires a value')
      options.group = value
    } else if (flag === '--write') options.write = true
    else if (flag === '--json') options.json = true
    else if (flag.startsWith('-')) throw new Error(`Unknown option: ${flag}`)
    else if (options.name === undefined) options.name = flag
    else throw new Error(`Unexpected argument: ${flag}`)
  }
  if (!options.name || !options.dir) {
    throw new Error('Usage: node scripts/scaffold-skill.mjs <skill-name> --dir <repo-root> [--group <group>] [--write] [--json]')
  }
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
  try {
    const result = await scaffoldSkill(options)
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(result.wrote ? `Created ${result.target}` : `Dry run - pass --write to create ${result.target}`)
      for (const file of result.files) console.log(`  ${file}`)
      console.log('Wiring:')
      for (const { step, status } of result.wiring) console.log(`  - ${step}: ${status}`)
    }
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(1)
  }
}

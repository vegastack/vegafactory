import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSkills } from './lib/skills.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// VSK_REPO_ROOT lets the tests drive this script against a miniature repo; unset, it resolves
// the real checkout exactly as before.
const repoRoot = process.env.VSK_REPO_ROOT ? resolve(process.env.VSK_REPO_ROOT) : resolve(here, '../../..')
const packageRoot = join(repoRoot, 'packages/cli')
const skillsRoot = join(repoRoot, 'skills')
const bundleRoot = join(packageRoot, 'skill')

// Explicit per-skill packaging allowlists live in packaging.json (data, not code) so the
// skillify scaffolder can wire a new skill automatically. Anything authored that is neither
// listed there nor in unpackagedPrefixes fails the build loudly — a forgotten entry must never
// ship a silently incomplete skill. README.md is repo-side only (its relative links target repo
// paths); tests and evals are never packaged — eval cases and their results are repo-side
// evidence, not runtime content.
const unpackagedPrefixes = ['tests/', 'evals/', 'README.md']
const packagedSkills = JSON.parse(await readFile(join(packageRoot, 'packaging.json'), 'utf8'))

async function files(root) {
  const output = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Refusing canonical skill symlink: ${path}`)
      // Dot-prefixed entries are tool and OS leftovers (.DS_Store), never authored content —
      // ignored here exactly as discovery and the structure check ignore them.
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  await walk(root)
  return output.sort()
}

// Every authored skill must have a packaging allowlist, and vice versa. Where the skills live —
// skills/<name>/ or skills/<group>/<name>/ — is discovery's business, not this script's; the
// bundle it produces is flat either way.
const skillPaths = discoverSkills(skillsRoot)
const authoredSkills = [...skillPaths.keys()].sort()
const listedSkills = Object.keys(packagedSkills).sort()
const unlistedSkills = authoredSkills.filter(name => !listedSkills.includes(name))
if (unlistedSkills.length) throw new Error(`Authored skills without an entry in packages/cli/packaging.json: ${unlistedSkills.join(', ')}`)
const missingSkills = listedSkills.filter(name => !authoredSkills.includes(name))
if (missingSkills.length) throw new Error(`Packaging allowlist names skills that do not exist: ${missingSkills.join(', ')}`)

// Repo-only skills operate ON this monorepo and do nothing useful in a consumer project, so
// `add --all` skips them. Membership is explicit data, never inferred from prose: a stale name
// here fails the build rather than silently marking nothing.
const repoOnlyPath = join(packageRoot, 'repo-only.json')
let repoOnly = []
try {
  repoOnly = JSON.parse(await readFile(repoOnlyPath, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (!Array.isArray(repoOnly) || repoOnly.some(name => typeof name !== 'string')) {
  throw new Error('packages/cli/repo-only.json must be an array of skill names')
}
const unknownRepoOnly = repoOnly.filter(name => !skillPaths.has(name))
if (unknownRepoOnly.length) throw new Error(`repo-only.json names skills that do not exist: ${unknownRepoOnly.join(', ')}`)
const repoOnlySet = new Set(repoOnly)

// Skills this bundle used to ship. Dropping a name from packaging.json stops shipping it but
// never removes the copy already on someone's machine, so each retirement leaves a tombstone:
// enough for `update` to sweep an installer-owned copy and for `remove <name>` to still work.
// A name that is both retired and still packaged is a contradiction the build refuses.
const retiredPath = join(packageRoot, 'retired.json')
let retired = {}
try {
  retired = JSON.parse(await readFile(retiredPath, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (retired === null || typeof retired !== 'object' || Array.isArray(retired)) {
  throw new Error('packages/cli/retired.json must be a JSON object keyed by skill name')
}
for (const [name, entry] of Object.entries(retired)) {
  if (skillPaths.has(name)) throw new Error(`retired.json names a skill that still exists: ${name}`)
  if (packagedSkills[name]) throw new Error(`retired.json and packaging.json both name: ${name}`)
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`retired.json entry is not an object: ${name}`)
  for (const key of ['group', 'since', 'replacedBy', 'note']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) throw new Error(`retired.json entry ${name} needs a non-empty ${key}`)
  }
  if (entry.replacedBy !== 'none' && !skillPaths.has(entry.replacedBy)) {
    throw new Error(`retired.json entry ${name} names an unknown replacement: ${entry.replacedBy}`)
  }
}

await rm(bundleRoot, { recursive: true, force: true })
const manifest = { schemaVersion: 2, skills: {}, retired }

for (const skillName of listedSkills) {
  const source = skillPaths.get(skillName).path
  const destination = join(bundleRoot, skillName)
  const runtimeFiles = packagedSkills[skillName]

  // An entry may end in "@<source-skill>": the file is authored once in that
  // skill and duplicated into this one at packaging time, so standalone
  // installs stay self-contained (e.g. dev-setup's conventions.md shipping
  // with every dev-family skill). The authored tree keeps a single home.
  const entries = runtimeFiles.map(raw => {
    const at = raw.lastIndexOf('@')
    return at > 0 ? { key: raw.slice(0, at), sourceSkill: raw.slice(at + 1) } : { key: raw, sourceSkill: null }
  })

  const authored = (await files(source)).map(path => relative(source, path).split(sep).join('/'))
  const allowlisted = new Set(entries.filter(e => !e.sourceSkill).map(e => e.key))
  const unlisted = authored.filter(key => !allowlisted.has(key) && !unpackagedPrefixes.some(prefix => key.startsWith(prefix)))
  if (unlisted.length) throw new Error(`${skillName}: authored files neither allowlisted for packaging nor deliberately unpackaged: ${unlisted.join(', ')}`)
  const missing = entries.filter(e => !e.sourceSkill).map(e => e.key).filter(key => !authored.includes(key))
  if (missing.length) throw new Error(`${skillName}: allowlisted runtime files missing from the authored skill: ${missing.join(', ')}`)

  for (const { key, sourceSkill } of entries) {
    const sourceRoot = sourceSkill ? skillPaths.get(sourceSkill)?.path : source
    if (!sourceRoot) throw new Error(`${skillName}: allowlist entry names an unknown source skill: ${key}@${sourceSkill}`)
    const from = join(sourceRoot, key)
    if (!(await lstat(from)).isFile()) throw new Error(`${skillName}: runtime allowlist entry is not a regular file: ${sourceSkill ? `${key}@${sourceSkill}` : key}`)
    const to = join(destination, key)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }

  const skillManifest = { group: skillPaths.get(skillName).group, repoOnly: repoOnlySet.has(skillName), files: {} }
  for (const path of await files(destination)) {
    const key = relative(destination, path).split(sep).join('/')
    skillManifest.files[key] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  if (Object.keys(skillManifest.files).length !== runtimeFiles.length) throw new Error(`${skillName}: packaged inventory differs from the explicit allowlist`)
  manifest.skills[skillName] = skillManifest
  await stat(join(destination, 'SKILL.md'))
}

await writeFile(join(packageRoot, 'skill-integrity.json'), `${JSON.stringify(manifest, null, 2)}\n`)

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkStructure, createGroup } from '../scripts/structure.mjs'

// A skill README whose file table is already in sync with the fixtures' ['SKILL.md'] packaging entries.
const SKILL_README = (name: string) => `# ${name}\n\n## What's in this skill\n\n| Path | Purpose |\n|---|---|\n| [SKILL.md](SKILL.md) | d |\n| \`tests/\` | Bun tests and fixtures (never packaged) |\n| \`evals/\` | Behavioral evals in the agentskills.io format (never packaged) |\n`

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'create-group-'))
  mkdirSync(join(root, 'skills'), { recursive: true })
  writeFileSync(join(root, 'README.md'), [
    '## Skills', '',
    '| Skill | What it does | Docs |', '|---|---|---|',
    '| [solo](skills/solo/) | s | [SKILL.md](skills/solo/SKILL.md) |', '',
    'Install any skill by name:', '',
    '## Repository structure', '',
  ].join('\n'))
  return root
}
const clean = (root: string) => rmSync(root, { recursive: true, force: true })

describe('createGroup', () => {
  test('dry run reports the plan and writes nothing', () => {
    const root = repo()
    const result = createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.' })
    expect(result.wrote).toBe(false)
    expect(result.files).toContain('GROUP.md')
    expect(result.wiring.map(w => w.status)).toEqual(['planned', 'planned'])
    expect(existsSync(join(root, 'skills/fam'))).toBe(false)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).not.toContain('### Fam')
    clean(root)
  })

  test('--write creates GROUP.md and the README section above the install snippet', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.', write: true })
    expect(readFileSync(join(root, 'skills/fam/GROUP.md'), 'utf8')).toBe('# Fam\n\nThe blurb.\n')
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('### Fam')
    expect(readme).toContain('The blurb.')
    expect(readme.indexOf('### Fam')).toBeLessThan(readme.indexOf('Install any skill by name:'))
    expect(readme.indexOf('| [solo](skills/solo/) |')).toBeLessThan(readme.indexOf('### Fam'))
    clean(root)
  })

  test('a second group lands after the first, not inside it', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'First blurb.', write: true })
    createGroup({ name: 'kin', repoRoot: root, title: 'Kin', blurb: 'Second blurb.', write: true })
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme.indexOf('### Fam')).toBeLessThan(readme.indexOf('### Kin'))
    expect(readme.indexOf('### Kin')).toBeLessThan(readme.indexOf('Install any skill by name:'))
    clean(root)
  })

  test('a second run is idempotent and reports it', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.', write: true })
    const again = createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.', write: true })
    expect(again.wiring.map(w => w.status).join()).toMatch(/already exists/)
    expect(readFileSync(join(root, 'README.md'), 'utf8').match(/### Fam/g)).toHaveLength(1)
    clean(root)
  })

  test('refuses an invalid group name before touching the filesystem', () => {
    const root = repo()
    expect(() => createGroup({ name: 'Bad--Name', repoRoot: root, title: 'B', blurb: 'b', write: true })).toThrow(/name/i)
    expect(existsSync(join(root, 'skills/Bad--Name'))).toBe(false)
    clean(root)
  })

  test('refuses a group with no title or no blurb', () => {
    const root = repo()
    expect(() => createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: '', write: true })).toThrow(/blurb/i)
    expect(existsSync(join(root, 'skills/fam'))).toBe(false)
    clean(root)
  })

  test('refuses when the target group path is a symlink', () => {
    const root = repo()
    symlinkSync(join(root, 'skills'), join(root, 'skills/fam'))
    expect(() => createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'b', write: true })).toThrow()
    clean(root)
  })

  test('refuses to turn an existing skill directory into a group', () => {
    const root = repo()
    mkdirSync(join(root, 'skills/solo'), { recursive: true })
    writeFileSync(join(root, 'skills/solo/SKILL.md'), '---\nname: solo\ndescription: d\n---\n')
    expect(() => createGroup({ name: 'solo', repoRoot: root, title: 'Solo', blurb: 'b', write: true })).toThrow(/skill already lives there/i)
    clean(root)
  })

  test('refuses a re-run with a different title rather than writing a second section', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.', write: true })
    expect(() => createGroup({ name: 'fam', repoRoot: root, title: 'Renamed', blurb: 'The blurb.', write: true }))
      .toThrow(/already exists with the title/i)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('### Fam')
    expect(readme).not.toContain('### Renamed')
    clean(root)
  })

  test('refuses when the existing GROUP.md is malformed, rather than writing a second section', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.', write: true })
    // readGroupDoc returns null here, which previously skipped the rename guard entirely.
    writeFileSync(join(root, 'skills/fam/GROUP.md'), '# Fam\n')
    expect(() => createGroup({ name: 'fam', repoRoot: root, title: 'Brand New', blurb: 'b', write: true }))
      .toThrow(/malformed/i)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('### Fam')
    expect(readme).not.toContain('### Brand New')
    clean(root)
  })

  test('refuses a blurb that disagrees with the existing GROUP.md, in both directions', () => {
    // checkStructure requires the README section to carry GROUP.md's blurb verbatim, so writing
    // either half with a different blurb produces a state this command's own checker blocks.
    const withDoc = repo()
    mkdirSync(join(withDoc, 'skills/fam'), { recursive: true })
    writeFileSync(join(withDoc, 'skills/fam/GROUP.md'), '# Fam\n\nAlpha.\n')
    const readmeBefore = readFileSync(join(withDoc, 'README.md'), 'utf8')
    expect(() => createGroup({ name: 'fam', repoRoot: withDoc, title: 'Fam', blurb: 'Beta.', write: true }))
      .toThrow(/already exists with the blurb/i)
    expect(readFileSync(join(withDoc, 'README.md'), 'utf8')).toBe(readmeBefore)
    clean(withDoc)

    // The other half: the section already exists with one blurb, GROUP.md is absent.
    const withSection = repo()
    createGroup({ name: 'fam', repoRoot: withSection, title: 'Fam', blurb: 'Alpha.', write: true })
    rmSync(join(withSection, 'skills/fam/GROUP.md'))
    expect(() => createGroup({ name: 'fam', repoRoot: withSection, title: 'Fam', blurb: 'Beta.', write: true }))
      .toThrow(/does not carry the blurb/i)
    expect(existsSync(join(withSection, 'skills/fam/GROUP.md'))).toBe(false)
    clean(withSection)
  })

  test('still repairs a group whose GROUP.md went missing, when the blurb matches', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'Alpha.', write: true })
    rmSync(join(root, 'skills/fam/GROUP.md'))
    const result = createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'Alpha.', write: true })
    expect(result.wiring.map(w => w.status)).toEqual(['done', 'skipped: already exists'])
    expect(readFileSync(join(root, 'skills/fam/GROUP.md'), 'utf8')).toBe('# Fam\n\nAlpha.\n')
    expect(readFileSync(join(root, 'README.md'), 'utf8').match(/### Fam/g)).toHaveLength(1)
    clean(root)
  })

  test('refuses a blurb shaped like a table row, which the README parser would read as a skill', () => {
    const root = repo()
    expect(() => createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: '| [ghost](skills/ghost/) | x |', write: true }))
      .toThrow(/must not start with "\|"/)
    expect(existsSync(join(root, 'skills/fam'))).toBe(false)
    clean(root)
  })

  test('refuses when the README has no Skills table to hold the section', () => {
    const root = repo()
    writeFileSync(join(root, 'README.md'), '## Skills\n\nNo table here.\n\n## Repository structure\n')
    // Reporting "skipped: Skills table not found" and exiting 0 would leave a group that the
    // structure check blocks on for having no section.
    expect(() => createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'b', write: true }))
      .toThrow(/no "## Skills" table/i)
    expect(existsSync(join(root, 'skills/fam'))).toBe(false)
    clean(root)
  })

  test('refuses a title another group already uses', () => {
    const root = repo()
    createGroup({ name: 'fam', repoRoot: root, title: 'Shared', blurb: 'One.', write: true })
    expect(() => createGroup({ name: 'kin', repoRoot: root, title: 'Shared', blurb: 'Two.', write: true }))
      .toThrow(/already uses the title/i)
    expect(existsSync(join(root, 'skills/kin'))).toBe(false)
    clean(root)
  })

  test('refuses a title or blurb that would produce a GROUP.md its own reader rejects', () => {
    const root = repo()
    for (const bad of [{ title: '# Heading', blurb: 'ok' }, { title: 'Fine', blurb: '# Heading' }, { title: 'Fine', blurb: 'a\nb' }]) {
      expect(() => createGroup({ name: 'fam', repoRoot: root, ...bad, write: true })).toThrow()
      expect(existsSync(join(root, 'skills/fam'))).toBe(false)
    }
    clean(root)
  })

  test('refuses a group name taken by a skill inside another group, writing nothing', () => {
    const root = repo()
    mkdirSync(join(root, 'skills/fam/one'), { recursive: true })
    writeFileSync(join(root, 'skills/fam/GROUP.md'), '# Fam\n\nThe blurb.\n')
    writeFileSync(join(root, 'skills/fam/one/SKILL.md'), '---\nname: one\ndescription: d\n---\n')
    const before = readFileSync(join(root, 'README.md'), 'utf8')
    expect(() => createGroup({ name: 'one', repoRoot: root, title: 'One', blurb: 'b', write: true }))
      .toThrow(/already lives at/i)
    expect(existsSync(join(root, 'skills/one'))).toBe(false)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(before)
    clean(root)
  })

  test('the section it writes is the one checkStructure expects', () => {
    const root = repo()
    // Build a complete, valid repo around a group created by the command itself.
    const meta = (dir: string, name: string) => {
      mkdirSync(join(dir, 'agents'), { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
      writeFileSync(join(dir, 'README.md'), SKILL_README(name))
      writeFileSync(join(dir, 'agents/openai.yaml'), 'name: x\n')
      // A clean skill carries its evals; the shape rules are covered in structure-check.test.ts.
      mkdirSync(join(dir, 'evals'), { recursive: true })
      writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify({ skill_name: name, evals: [{ id: 1, prompt: 'p', expected_output: 'e', files: [], assertions: ['a'] }] }))
    }
    meta(join(root, 'skills/solo'), 'solo')
    createGroup({ name: 'fam', repoRoot: root, title: 'Fam', blurb: 'The blurb.', write: true })
    meta(join(root, 'skills/fam/one'), 'one')
    meta(join(root, 'skills/fam/two'), 'two')
    mkdirSync(join(root, 'packages/cli'), { recursive: true })
    writeFileSync(join(root, 'packages/cli/packaging.json'), JSON.stringify({ solo: ['SKILL.md'], one: ['SKILL.md'], two: ['SKILL.md'] }))
    const body = readFileSync(join(root, 'README.md'), 'utf8')
    writeFileSync(join(root, 'README.md'), body.replace('|---|---|---|\n\nInstall', [
      '|---|---|---|',
      '| [one](skills/fam/one/) | o | [SKILL.md](skills/fam/one/SKILL.md) |',
      '| [two](skills/fam/two/) | t | [SKILL.md](skills/fam/two/SKILL.md) |',
      '', 'Install',
    ].join('\n')))
    expect(checkStructure(root)).toEqual({ blocks: [], warns: [] })
    clean(root)
  })
})

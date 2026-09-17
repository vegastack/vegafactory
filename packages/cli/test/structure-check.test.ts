import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkStructure } from '../scripts/structure.mjs'

const UNGROUPED_ROW = '| [solo](skills/solo/) | s | [SKILL.md](skills/solo/SKILL.md) |'

function readme(sections: { ungrouped: string[]; groups?: { title: string; blurb: string; rows: string[] }[] }) {
  const lines = ['## Skills', '', '| Skill | What it does | Docs |', '|---|---|---|', ...sections.ungrouped, '']
  for (const group of sections.groups ?? []) {
    lines.push(`### ${group.title}`, '', group.blurb, '', '| Skill | What it does | Docs |', '|---|---|---|', ...group.rows, '')
  }
  lines.push('Install any skill by name:', '', '## Repository structure', '')
  return lines.join('\n')
}

// A minimal repo that satisfies every rule; each case perturbs exactly one thing.
function fixture(mutate: (paths: { root: string; skills: string }) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'structure-'))
  const skills = join(root, 'skills')
  mkdirSync(join(root, 'packages/cli'), { recursive: true })
  const meta = (dir: string, name: string) => {
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
    writeFileSync(join(dir, 'agents/openai.yaml'), 'name: x\n')
    mkdirSync(join(dir, 'evals'), { recursive: true })
    writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify({
      skill_name: name,
      evals: [{ id: 1, prompt: 'p', expected_output: 'e', files: [], assertions: ['a'] }],
    }))
  }
  meta(join(skills, 'solo'), 'solo')
  mkdirSync(join(skills, 'fam'), { recursive: true })
  writeFileSync(join(skills, 'fam', 'GROUP.md'), '# Fam\n\nThe fam blurb.\n')
  meta(join(skills, 'fam', 'one'), 'one')
  meta(join(skills, 'fam', 'two'), 'two')
  writeFileSync(
    join(root, 'packages/cli/packaging.json'),
    JSON.stringify({ solo: ['SKILL.md'], one: ['SKILL.md'], two: ['SKILL.md'] }, null, 2),
  )
  writeFileSync(join(root, 'README.md'), readme({
    ungrouped: [UNGROUPED_ROW],
    groups: [{
      title: 'Fam',
      blurb: 'The fam blurb.',
      rows: [
        '| [one](skills/fam/one/) | o | [SKILL.md](skills/fam/one/SKILL.md) |',
        '| [two](skills/fam/two/) | t | [SKILL.md](skills/fam/two/SKILL.md) |',
      ],
    }],
  }))
  mutate({ root, skills })
  return root
}

const clean = (root: string) => rmSync(root, { recursive: true, force: true })
const rewriteReadme = (root: string, edit: (body: string) => string) =>
  writeFileSync(join(root, 'README.md'), edit(readFileSync(join(root, 'README.md'), 'utf8')))
const setPackaging = (root: string, value: Record<string, string[]>) =>
  writeFileSync(join(root, 'packages/cli/packaging.json'), JSON.stringify(value, null, 2))

describe('checkStructure', () => {
  test('a correct mixed tree passes with no blocks and no warnings', () => {
    const root = fixture()
    expect(checkStructure(root)).toEqual({ blocks: [], warns: [] })
    clean(root)
  })

  test('a tree with only ungrouped skills and no groups passes', () => {
    const root = fixture(({ root, skills }) => {
      rmSync(join(skills, 'fam'), { recursive: true, force: true })
      setPackaging(root, { solo: ['SKILL.md'] })
      writeFileSync(join(root, 'README.md'), readme({ ungrouped: [UNGROUPED_ROW] }))
    })
    expect(checkStructure(root)).toEqual({ blocks: [], warns: [] })
    clean(root)
  })

  test('blocks a group with no GROUP.md', () => {
    const root = fixture(({ skills }) => rmSync(join(skills, 'fam', 'GROUP.md')))
    expect(checkStructure(root).blocks.join()).toMatch(/GROUP\.md/i)
    clean(root)
  })

  test('blocks a GROUP.md with a title but no blurb', () => {
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'fam', 'GROUP.md'), '# Fam\n'))
    expect(checkStructure(root).blocks.join()).toMatch(/GROUP\.md/i)
    clean(root)
  })

  test('blocks a GROUP.md whose title does not match its README section heading', () => {
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'fam', 'GROUP.md'), '# Other\n\nThe fam blurb.\n'))
    expect(checkStructure(root).blocks.join()).toMatch(/section/i)
    clean(root)
  })

  test('blocks a README section that names no real group', () => {
    const root = fixture(({ root }) => rewriteReadme(root, body => body.replace('### Fam', '### Fam\n\nGhost blurb.\n\n### Ghost')))
    expect(checkStructure(root).blocks.join()).toMatch(/ghost/i)
    clean(root)
  })

  test('blocks a stray file sitting inside a group directory', () => {
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'fam', 'notes.md'), 'x\n'))
    expect(checkStructure(root).blocks.join()).toMatch(/notes\.md/)
    clean(root)
  })

  test('blocks a skill missing any required meta file, grouped or ungrouped', () => {
    for (const target of [['solo'], ['fam', 'one']]) {
      const root = fixture(({ skills }) => rmSync(join(skills, ...target, 'agents/openai.yaml')))
      expect(checkStructure(root).blocks.join()).toMatch(/openai\.yaml/)
      clean(root)
    }
  })

  test('blocks a skill with no packaging entry and an entry with no skill', () => {
    const missing = fixture(({ root }) => setPackaging(root, { solo: ['SKILL.md'], one: ['SKILL.md'] }))
    expect(checkStructure(missing).blocks.join()).toMatch(/two/)
    clean(missing)
    const extra = fixture(({ root }) =>
      setPackaging(root, { solo: ['SKILL.md'], one: ['SKILL.md'], two: ['SKILL.md'], ghost: ['SKILL.md'] }))
    expect(checkStructure(extra).blocks.join()).toMatch(/ghost/)
    clean(extra)
  })

  test('blocks a group-qualified packaging key', () => {
    const root = fixture(({ root }) =>
      setPackaging(root, { solo: ['SKILL.md'], 'fam/one': ['SKILL.md'], two: ['SKILL.md'] }))
    expect(checkStructure(root).blocks.join()).toMatch(/bare skill name/i)
    clean(root)
  })

  test('blocks a README row whose link path is not where the skill actually lives', () => {
    const root = fixture(({ root }) => rewriteReadme(root, body => body.replaceAll('skills/fam/one/', 'skills/one/')))
    expect(checkStructure(root).blocks.length).toBeGreaterThan(0)
    clean(root)
  })

  test('blocks a grouped skill whose row sits in the ungrouped table', () => {
    const root = fixture(({ root }) => rewriteReadme(root, body => {
      const row = '| [two](skills/fam/two/) | t | [SKILL.md](skills/fam/two/SKILL.md) |'
      return body.replace(`${row}\n`, '').replace(UNGROUPED_ROW, `${UNGROUPED_ROW}\n${row}`)
    }))
    expect(checkStructure(root).blocks.join()).toMatch(/section/i)
    clean(root)
  })

  test('blocks an ungrouped skill whose row sits in a group section', () => {
    const root = fixture(({ root }) => rewriteReadme(root, body => body
      .replace(`${UNGROUPED_ROW}\n`, '')
      .replace('| [one](skills/fam/one/) | o | [SKILL.md](skills/fam/one/SKILL.md) |', `${UNGROUPED_ROW}\n| [one](skills/fam/one/) | o | [SKILL.md](skills/fam/one/SKILL.md) |`)))
    expect(checkStructure(root).blocks.join()).toMatch(/section/i)
    clean(root)
  })

  test('blocks a skill with no README row at all', () => {
    const root = fixture(({ root }) => rewriteReadme(root, body => body.replace(`${UNGROUPED_ROW}\n`, '')))
    expect(checkStructure(root).blocks.join()).toMatch(/solo/)
    clean(root)
  })

  test('blocks a README row naming a skill that does not exist', () => {
    const root = fixture(({ root }) => rewriteReadme(root, body =>
      body.replace(UNGROUPED_ROW, `${UNGROUPED_ROW}\n| [phantom](skills/phantom/) | p | [SKILL.md](skills/phantom/SKILL.md) |`)))
    expect(checkStructure(root).blocks.join()).toMatch(/phantom/)
    clean(root)
  })

  test('turns a layout error that would break the build into a block, not a crash', () => {
    const root = fixture(({ skills }) => {
      mkdirSync(join(skills, 'fam', 'nested', 'deep'), { recursive: true })
      writeFileSync(join(skills, 'fam', 'nested', 'deep', 'SKILL.md'), '---\nname: deep\ndescription: d\n---\n')
    })
    const result = checkStructure(root)
    expect(result.blocks.join()).toMatch(/nested too deep/i)
    clean(root)
  })

  test('blocks two groups sharing one GROUP.md title', () => {
    const root = fixture(({ root, skills }) => {
      mkdirSync(join(skills, 'kin'), { recursive: true })
      writeFileSync(join(skills, 'kin', 'GROUP.md'), '# Fam\n\nThe fam blurb.\n')
      rewriteReadme(root, body => body.replace('## Repository structure', '### Fam\n\nThe fam blurb.\n\n| Skill | What it does | Docs |\n|---|---|---|\n\n## Repository structure'))
    })
    expect(checkStructure(root).blocks.join()).toMatch(/share the GROUP\.md title/i)
    clean(root)
  })

  test('blocks a group with a valid GROUP.md but no README section', () => {
    const root = fixture(({ root, skills }) => {
      mkdirSync(join(skills, 'kin'), { recursive: true })
      writeFileSync(join(skills, 'kin', 'GROUP.md'), '# Kin\n\nA second blurb.\n')
    })
    expect(checkStructure(root).blocks.join()).toMatch(/has no "### Kin" section/i)
    clean(root)
  })

  test('ignores a dotfile in a group directory, the same way it ignores dot-directories', () => {
    // .DS_Store on the platform this repo is developed on must not fail the check.
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'fam', '.DS_Store'), 'x'))
    expect(checkStructure(root)).toEqual({ blocks: [], warns: [] })
    clean(root)
  })

  test('ignores a crashed scaffolder\'s dot-prefixed staging directory', () => {
    const root = fixture(({ skills }) => {
      mkdirSync(join(skills, '.demo-skill.scaffold-abc123'), { recursive: true })
    })
    // Before: discovery treated it as a group and every command died on "Invalid group name".
    expect(checkStructure(root)).toEqual({ blocks: [], warns: [] })
    clean(root)
  })

  test('warns without blocking on a group holding a single skill', () => {
    const root = fixture(({ root, skills }) => {
      rmSync(join(skills, 'fam', 'two'), { recursive: true, force: true })
      setPackaging(root, { solo: ['SKILL.md'], one: ['SKILL.md'] })
      rewriteReadme(root, body => body.replace(/^\| \[two\].*\n/m, ''))
    })
    const result = checkStructure(root)
    expect(result.blocks).toEqual([])
    expect(result.warns.join()).toMatch(/single skill/i)
    clean(root)
  })

  test('warns without blocking on scaffolded placeholder text left in a row or a blurb', () => {
    const root = fixture(({ root, skills }) => {
      writeFileSync(join(skills, 'fam', 'GROUP.md'), '# Fam\n\nTODO: one-line description\n')
      rewriteReadme(root, body => body.replace('The fam blurb.', 'TODO: one-line description'))
    })
    const result = checkStructure(root)
    expect(result.blocks).toEqual([])
    expect(result.warns.join()).toMatch(/placeholder/i)
    clean(root)
  })

  test('warns without blocking on a skill with no evals/evals.json', () => {
    const root = fixture(({ skills }) => {
      rmSync(join(skills, 'solo', 'evals'), { recursive: true, force: true })
    })
    const result = checkStructure(root)
    expect(result.blocks).toEqual([])
    expect(result.warns.join()).toMatch(/skills\/solo\/evals\/evals\.json is missing/)
    clean(root)
  })

  test('warns on an evals.json that does not parse', () => {
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'fam', 'one', 'evals/evals.json'), '{not json'))
    const result = checkStructure(root)
    expect(result.blocks).toEqual([])
    expect(result.warns.join()).toMatch(/skills\/fam\/one\/evals\/evals\.json does not parse/)
    clean(root)
  })

  test('warns on a wrong skill_name, a case without assertions, and a repeated id', () => {
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'solo', 'evals/evals.json'), JSON.stringify({
      skill_name: 'other',
      evals: [{ id: 1, prompt: 'p', expected_output: 'e' }, { id: 1, prompt: 'q', expected_output: 'f', assertions: [] }],
    })))
    const result = checkStructure(root)
    expect(result.blocks).toEqual([])
    const warns = result.warns.join('\n')
    expect(warns).toMatch(/names skill_name "other" but the skill is "solo"/)
    expect(warns).toMatch(/case 1 is missing assertions/)
    expect(warns).toMatch(/case 2 id is repeated/)
    clean(root)
  })

  test('warns, never throws, on a non-object root or a non-object case', () => {
    for (const body of ['null', '3', '[]']) {
      const root = fixture(({ skills }) => writeFileSync(join(skills, 'solo', 'evals/evals.json'), body))
      const result = checkStructure(root)
      expect(result.blocks).toEqual([])
      expect(result.warns.join()).toMatch(/skills\/solo\/evals\/evals\.json does not parse: the root must be a JSON object/)
      clean(root)
    }
    const root = fixture(({ skills }) => writeFileSync(join(skills, 'solo', 'evals/evals.json'), JSON.stringify({ skill_name: 'solo', evals: [null, 'x'] })))
    const warns = checkStructure(root).warns.join('\n')
    expect(warns).toMatch(/case 1 is not an object/)
    expect(warns).toMatch(/case 2 is not an object/)
    clean(root)
  })

  test('warns on an empty case list, a non-string files entry, and the scaffolded placeholder', () => {
    const empty = fixture(({ skills }) => writeFileSync(join(skills, 'solo', 'evals/evals.json'), JSON.stringify({ skill_name: 'solo', evals: [] })))
    expect(checkStructure(empty).blocks).toEqual([])
    expect(checkStructure(empty).warns.join()).toMatch(/has no cases/)
    clean(empty)
    const shape = fixture(({ skills }) => writeFileSync(join(skills, 'solo', 'evals/evals.json'), JSON.stringify({
      skill_name: 'solo',
      evals: [{ id: 'x', prompt: 'TODO: a realistic prompt', expected_output: '', files: [1], assertions: [] }],
    })))
    const warns = checkStructure(shape).warns.join('\n')
    expect(warns).toMatch(/case 1 is missing id/)
    expect(warns).toMatch(/case 1 is missing expected_output/)
    expect(warns).toMatch(/case 1 files must be an array of strings/)
    expect(warns).toMatch(/still carries the scaffolded placeholder case/)
    clean(shape)
  })
})

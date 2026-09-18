import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateSkill } from '../../../../packages/cli/scripts/validate-skill.mjs'
import { checkStructure } from '../../../../packages/cli/scripts/structure.mjs'
import { scaffoldSkill, templateFiles, validateName, wireSkill } from '../scripts/scaffold-skill.mjs'

const skillRoot = resolve(import.meta.dir, '..')

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skillify-repo-'))
  await mkdir(join(root, 'skills'))
  return root
}

// A repo with the three wiring targets present, as in the real monorepo.
async function makeWiredRepo(): Promise<string> {
  const root = await makeRepo()
  await mkdir(join(root, 'packages/cli'), { recursive: true })
  await writeFile(join(root, 'packages/cli/packaging.json'), '{\n  "architect": ["SKILL.md"]\n}\n')
  await writeFile(
    join(root, 'README.md'),
    '# Repo\n\n## Skills\n\n| Skill | What it does | Docs |\n|---|---|---|\n| [architect](skills/architect/) | advisor | [SKILL.md](skills/architect/SKILL.md) |\n\nAfter the table.\n',
  )
  await mkdir(join(root, '.changeset'))
  return root
}

describe('validator YAML-comment guard', () => {
  test("rejects a description containing ' #' (YAML comment start truncates it in real harnesses)", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'skillify-hash-'))
    try {
      const dir = join(repo, 'demo-skill')
      await mkdir(dir)
      await writeFile(join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Use for "do issue #12" requests.\n---\n\n# demo\n')
      const result = validateSkill(dir)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('comment start')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('scaffold-skill consistency', () => {
  test('every template on disk is wired into the scaffolder, and vice versa', async () => {
    const onDisk = (await readdir(join(skillRoot, 'assets/templates'))).sort()
    const wired = templateFiles.map(([source]: [string, string | null]) => source).sort()
    expect(onDisk).toEqual(wired)
  })
})

describe('scaffold-skill name grammar', () => {
  test.each([
    ['Uppercase', 'lowercase'],
    ['1skill', 'lowercase letter'],
    ['a--b', 'consecutive hyphens'],
    ['trailing-', 'end with a hyphen'],
    ['under_score', 'only lowercase letters, digits, and hyphens'],
    ['', 'required'],
  ])('rejects %p', (name, reason) => {
    expect(validateName(name)).toContain(reason)
  })

  test('rejects names over 64 characters', () => {
    expect(validateName(`a${'b'.repeat(64)}`)).toContain('maximum is 64')
  })

  test('accepts valid hyphen-case names', () => {
    for (const name of ['a', 'demo-skill', 'a2c', 'skill-2-audit']) expect(validateName(name)).toBeNull()
  })

  test('scaffoldSkill refuses an invalid name before touching the filesystem', async () => {
    const repo = await makeRepo()
    try {
      await expect(scaffoldSkill({ name: 'Bad--Name', dir: repo, write: true })).rejects.toThrow('Invalid skill name')
      expect(await readdir(join(repo, 'skills'))).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('scaffold-skill runs', () => {
  test('dry run returns the full plan and creates nothing', async () => {
    const repo = await makeWiredRepo()
    try {
      const plan = await scaffoldSkill({ name: 'demo-skill', dir: repo })
      expect(plan.wrote).toBe(false)
      expect(plan.files.sort()).toEqual([
        'SKILL.md',
        'agents/openai.yaml',
        'evals/evals.json',
        'tests/demo-skill.test.ts',
        'tests/fixtures/trigger-queries.json',
      ])
      expect(plan.wiring.map((entry: { status: string }) => entry.status)).toEqual(['planned', 'planned', 'planned'])
      expect(await readdir(join(repo, 'skills'))).toEqual([])
      expect(await readdir(join(repo, '.changeset'))).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('--write creates the contract tree and performs the repo wiring', async () => {
    const repo = await makeWiredRepo()
    try {
      const result = await scaffoldSkill({ name: 'demo-skill', dir: repo, write: true, now: new Date('2026-08-08T05:00:00Z') })
      expect(result.wrote).toBe(true)
      const target = join(repo, 'skills', 'demo-skill')
      for (const file of result.files) {
        const body = readFileSync(join(target, file), 'utf8')
        expect(body).not.toContain('{{name}}')
        expect(body).not.toContain('{{date}}')
      }
      expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: demo-skill')
      expect(readFileSync(join(target, 'tests/demo-skill.test.ts'), 'utf8')).toContain("'demo-skill contract'")
      const validated = validateSkill(target)
      expect(validated.message).toBe('Skill is valid!')
      expect(validated.ok).toBe(true)
      // No staging leftovers.
      expect(await readdir(join(repo, 'skills'))).toEqual(['demo-skill'])

      // Wiring performed: packaging entry, README row, changeset.
      expect(result.wiring.map((entry: { status: string }) => entry.status)).toEqual(['done', 'done', 'done'])
      const packaging = JSON.parse(await readFile(join(repo, 'packages/cli/packaging.json'), 'utf8'))
      expect(packaging['demo-skill']).toEqual(['SKILL.md', 'agents/openai.yaml'])
      expect(Object.keys(packaging)).toEqual(['architect', 'demo-skill'])
      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      expect(readme).toContain('| [demo-skill](skills/demo-skill/) |')
      expect(readme.indexOf('demo-skill')).toBeGreaterThan(readme.indexOf('architect'))
      expect(readme).toContain('After the table.')
      expect(await readFile(join(repo, '.changeset/add-demo-skill.md'), 'utf8')).toContain('"@vegastack/vegafactory": minor')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('--write scaffolds a placeholder evals.json the structure check flags until it is replaced', async () => {
    const repo = await makeWiredRepo()
    try {
      await scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })
      const evals = JSON.parse(await readFile(join(repo, 'skills/demo-skill/evals/evals.json'), 'utf8'))
      expect(evals.skill_name).toBe('demo-skill')
      expect(evals.evals).toHaveLength(1)
      expect(evals.evals[0]).toMatchObject({ id: 1, files: [], assertions: [] })
      const { warns } = checkStructure(repo)
      expect(warns.join()).toMatch(/evals\.json still carries the scaffolded placeholder case/)
      expect(warns.join()).not.toMatch(/evals\.json is missing/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  // wireSkill is the wiring primitive, not a tree creator: called on its own it still
  // degrades to `skipped:` for a target that is not there. scaffoldSkill does not - it
  // creates a tree, so a wiring target it cannot write is a refusal (the tests below).
  test('wireSkill is idempotent and degrades to skipped in a bare repo', async () => {
    const wired = await makeWiredRepo()
    const bare = await makeRepo()
    try {
      await wireSkill({ name: 'demo-skill', repoRoot: wired, write: true })
      const again = await wireSkill({ name: 'demo-skill', repoRoot: wired, write: true })
      for (const { status } of again) expect(status).toStartWith('skipped:')
      const bareWiring = await wireSkill({ name: 'demo-skill', repoRoot: bare, write: true })
      for (const { status } of bareWiring) expect(status).toStartWith('skipped:')
    } finally {
      await rm(wired, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })

  test('scaffoldSkill refuses a repo with no README.md, and writes nothing', async () => {
    const bare = await makeRepo()
    try {
      await expect(scaffoldSkill({ name: 'demo-skill', dir: bare, write: true })).rejects.toThrow(
        /README\.md.*not found/s,
      )
      expect(await readdir(join(bare, 'skills'))).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  test('scaffoldSkill refuses a repo with no packages/cli/packaging.json, and writes nothing', async () => {
    const repo = await makeWiredRepo()
    try {
      await rm(join(repo, 'packages/cli/packaging.json'))
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })).rejects.toThrow(
        /packaging\.json.*not found/s,
      )
      expect(await readdir(join(repo, 'skills'))).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  // Present but unreadable is the same class as absent: `name in packaged` and the assignment
  // after it both need a plain object, and the parse happens once, in the pre-flight.
  test.each([
    ['malformed', '{ this is not valid json'],
    ['a JSON array', '["architect"]'],
    ['a JSON scalar', '42'],
  ])('scaffoldSkill refuses %s packaging.json, and writes nothing', async (_label, body) => {
    const repo = await makeWiredRepo()
    try {
      await writeFile(join(repo, 'packages/cli/packaging.json'), body)
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })).rejects.toThrow(
        /packaging\.json.*(not valid JSON|not a JSON object)/s,
      )
      expect(await readdir(join(repo, 'skills'))).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  // A dry run exists to say what would happen; "it would refuse" is that answer. The
  // existing Skills-table refusal already throws before the !write return, so this
  // matches it rather than introducing a second convention.
  test('scaffoldSkill refuses a bare repo in dry-run too', async () => {
    const bare = await makeRepo()
    try {
      await expect(scaffoldSkill({ name: 'demo-skill', dir: bare })).rejects.toThrow(/README\.md.*not found/s)
      expect(await readdir(join(bare, 'skills'))).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  // .changeset/ is deliberately NOT a refusal: a missing changeset is not a state
  // structure.mjs check rejects, so it is not the false-success shape this guards.
  test('scaffoldSkill succeeds with no .changeset/, reporting it skipped', async () => {
    const repo = await makeWiredRepo()
    try {
      await rm(join(repo, '.changeset'), { recursive: true })
      const result = await scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })
      expect(result.wrote).toBe(true)
      const statuses = Object.fromEntries(
        result.wiring.map((entry: { step: string; status: string }) => [entry.step, entry.status]),
      )
      expect(statuses['packaging.json entry']).toBe('done')
      expect(statuses['root README row']).toBe('done')
      expect(statuses.changeset).toBe('skipped: .changeset/ not found')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('refuses to overwrite an existing skill directory', async () => {
    const repo = await makeRepo()
    try {
      await mkdir(join(repo, 'skills', 'demo-skill'))
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })).rejects.toThrow('already exists')
      expect(await readdir(join(repo, 'skills'))).toEqual(['demo-skill'])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('refuses a symlinked skills root and a non-repo --dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillify-symlink-'))
    try {
      await mkdir(join(root, 'real-skills'))
      await symlink(join(root, 'real-skills'), join(root, 'skills'))
      await expect(scaffoldSkill({ name: 'demo-skill', dir: root, write: true })).rejects.toThrow('not a real directory')
      const empty = await mkdtemp(join(tmpdir(), 'skillify-empty-'))
      try {
        await expect(scaffoldSkill({ name: 'demo-skill', dir: empty })).rejects.toThrow('not a real directory')
      } finally {
        await rm(empty, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('scaffold-skill groups', () => {
  // A group is a deliberate structural act owned by skill-maintainer, so the scaffolder places
  // skills into groups that already exist and refuses to invent one.
  async function makeGroupedRepo(title = 'Fam'): Promise<string> {
    const root = await makeWiredRepo()
    await mkdir(join(root, 'skills/fam'), { recursive: true })
    await writeFile(join(root, 'skills/fam/GROUP.md'), `# ${title}\n\nThe blurb.\n`)
    await writeFile(
      join(root, 'README.md'),
      [
        '# Repo', '', '## Skills', '',
        '| Skill | What it does | Docs |', '|---|---|---|',
        '| [architect](skills/architect/) | advisor | [SKILL.md](skills/architect/SKILL.md) |', '',
        `### ${title}`, '', 'The blurb.', '',
        '| Skill | What it does | Docs |', '|---|---|---|', '',
        'After the table.', '',
      ].join('\n'),
    )
    return root
  }

  test('--group places the tree, the row, and a depth-correct validator import', async () => {
    const repo = await makeGroupedRepo()
    try {
      const result = await scaffoldSkill({ name: 'demo-skill', dir: repo, group: 'fam', write: true })
      expect(result.target).toBe(join(repo, 'skills/fam/demo-skill'))

      const testFile = await readFile(join(repo, 'skills/fam/demo-skill/tests/demo-skill.test.ts'), 'utf8')
      expect(testFile).toContain("'../../../../packages/cli/scripts/validate-skill.mjs'")

      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      expect(readme).toContain('| [demo-skill](skills/fam/demo-skill/) |')
      expect(readme.indexOf('### Fam')).toBeLessThan(readme.indexOf('demo-skill'))

      const packaged = JSON.parse(await readFile(join(repo, 'packages/cli/packaging.json'), 'utf8'))
      expect(Object.keys(packaged)).toContain('demo-skill')
      expect(Object.keys(packaged).some((key) => key.includes('/'))).toBe(false)

      expect(validateSkill(join(repo, 'skills/fam/demo-skill')).ok).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('without --group nothing changes: top-level tree, ungrouped row, three-dot import', async () => {
    const repo = await makeGroupedRepo()
    try {
      await scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })
      const testFile = await readFile(join(repo, 'skills/demo-skill/tests/demo-skill.test.ts'), 'utf8')
      // Ungrouped: three levels up, not four. This assertion is about generated output, not
      // about where this test file itself lives.
      expect(testFile).toContain("'../../../packages/cli/scripts/validate-skill.mjs'")
      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      expect(readme).toContain('| [demo-skill](skills/demo-skill/) |')
      // The row belongs to the ungrouped table, above the group section.
      expect(readme.indexOf('| [demo-skill](skills/demo-skill/) |')).toBeLessThan(readme.indexOf('### Fam'))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('an unknown group refuses and creates nothing', async () => {
    const repo = await makeGroupedRepo()
    try {
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, group: 'ghost', write: true }))
        .rejects.toThrow(/group "ghost" does not exist/i)
      expect(await readdir(join(repo, 'skills'))).toEqual(['fam'])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('a group whose GROUP.md is malformed refuses rather than guessing a section', async () => {
    const repo = await makeGroupedRepo()
    try {
      await writeFile(join(repo, 'skills/fam/GROUP.md'), '# Fam\n')
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, group: 'fam', write: true }))
        .rejects.toThrow(/GROUP\.md/i)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('an unrelated "###" heading elsewhere in the README does not move the row', async () => {
    const repo = await makeGroupedRepo()
    try {
      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      // A heading outside the Skills region must not bound the ungrouped search window.
      await writeFile(join(repo, 'README.md'), `### Prelude\n\nAn unrelated section.\n\n${readme}\n## Later\n\n### Also unrelated\n`)
      await scaffoldSkill({ name: 'demo-skill', dir: repo, write: true })
      const updated = await readFile(join(repo, 'README.md'), 'utf8')
      const row = '| [demo-skill](skills/demo-skill/) |'
      expect(updated).toContain(row)
      // Still in the ungrouped table: after the architect row, before the group section.
      expect(updated.indexOf('| [architect](skills/architect/) |')).toBeLessThan(updated.indexOf(row))
      expect(updated.indexOf(row)).toBeLessThan(updated.indexOf('### Fam'))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('a group section missing from the README refuses and writes nothing at all', async () => {
    const repo = await makeGroupedRepo()
    try {
      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      const packagingBefore = await readFile(join(repo, 'packages/cli/packaging.json'), 'utf8')
      await writeFile(join(repo, 'README.md'), readme.replace('### Fam', '### Elsewhere'))
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, group: 'fam', write: true }))
        .rejects.toThrow(/section/i)
      // A refusal that has already renamed the tree into place and written a packaging entry is
      // not a refusal — it is a half-wired skill plus an error message.
      expect(await readdir(join(repo, 'skills'))).toEqual(['fam'])
      expect(await readdir(join(repo, 'skills/fam'))).toEqual(['GROUP.md'])
      expect(await readFile(join(repo, 'packages/cli/packaging.json'), 'utf8')).toBe(packagingBefore)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('a README with no usable table refuses instead of reporting a skipped row after writing', async () => {
    const repo = await makeGroupedRepo()
    try {
      // Previously: tree renamed into place, packaging entry and changeset written, then
      // "skipped: Skills table not found" with wrote: true and exit 0 — and structure check
      // blocking on the missing row.
      await writeFile(join(repo, 'README.md'), '# Repo\n\n## Skills\n\nNo table here.\n\n## Elsewhere\n')
      const packagingBefore = await readFile(join(repo, 'packages/cli/packaging.json'), 'utf8')
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, write: true }))
        .rejects.toThrow(/no ungrouped Skills table/i)
      expect(await readdir(join(repo, 'skills'))).toEqual(['fam'])
      expect(await readFile(join(repo, 'packages/cli/packaging.json'), 'utf8')).toBe(packagingBefore)
      expect(await readdir(join(repo, '.changeset'))).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('a group section that exists but carries no table refuses the same way', async () => {
    const repo = await makeGroupedRepo()
    try {
      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      await writeFile(join(repo, 'README.md'), readme.replace('| Skill | What it does | Docs |\n|---|---|---|\n\nAfter the table.', 'After the table.'))
      await expect(scaffoldSkill({ name: 'demo-skill', dir: repo, group: 'fam', write: true }))
        .rejects.toThrow(/no table under "### Fam"/i)
      expect(await readdir(join(repo, 'skills/fam'))).toEqual(['GROUP.md'])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('a name already used at the other depth refuses, in both directions', async () => {
    const grouped = await makeGroupedRepo()
    try {
      await scaffoldSkill({ name: 'demo-skill', dir: grouped, group: 'fam', write: true })
      // Same name, ungrouped this time: the flat bundle allows only one "demo-skill".
      await expect(scaffoldSkill({ name: 'demo-skill', dir: grouped, write: true }))
        .rejects.toThrow(/already exists at/i)
      expect(await readdir(join(grouped, 'skills'))).toEqual(['fam'])
    } finally {
      await rm(grouped, { recursive: true, force: true })
    }

    const flat = await makeGroupedRepo()
    try {
      await scaffoldSkill({ name: 'demo-skill', dir: flat, write: true })
      await expect(scaffoldSkill({ name: 'demo-skill', dir: flat, group: 'fam', write: true }))
        .rejects.toThrow(/already exists at/i)
      expect(await readdir(join(flat, 'skills/fam'))).toEqual(['GROUP.md'])
    } finally {
      await rm(flat, { recursive: true, force: true })
    }
  })

  test('wireSkill works from its documented shape, deriving the group heading itself', async () => {
    const repo = await makeGroupedRepo()
    try {
      // The plan documents wireSkill({ name, repoRoot, group, write }); groupHeading is an
      // internal optimisation and must not be required of a caller.
      await wireSkill({ name: 'demo-skill', repoRoot: repo, group: 'fam', write: true })
      const readme = await readFile(join(repo, 'README.md'), 'utf8')
      expect(readme).toContain('| [demo-skill](skills/fam/demo-skill/) |')
      expect(readme).not.toContain('### null')
      expect(readme.indexOf('### Fam')).toBeLessThan(readme.indexOf('demo-skill'))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

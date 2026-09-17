import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These cases spawn the CLI rather than importing its exports: the exit-code mapping is a
// deterministic branch of its own, and it is the branch that decides whether `bun run check`
// goes red. A warning that fails the chained root check contradicts the guard doctrine.
// A skill README whose file table is already in sync with the fixtures' ['SKILL.md'] packaging entries.
const SKILL_README = (name: string) => `# ${name}\n\n## What's in this skill\n\n| Path | Purpose |\n|---|---|\n| [SKILL.md](SKILL.md) | d |\n| \`tests/\` | Bun tests and fixtures (never packaged) |\n| \`evals/\` | Behavioral evals in the agentskills.io format (never packaged) |\n`
const SCRIPT = join(import.meta.dir, '../scripts/structure.mjs')
const run = (...args: string[]) => Bun.spawnSync(['node', SCRIPT, ...args])

function fixture({ members = 2 }: { members?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'structure-cli-'))
  const skills = join(root, 'skills')
  mkdirSync(join(root, 'packages/cli'), { recursive: true })
  const meta = (dir: string, name: string) => {
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
    writeFileSync(join(dir, 'README.md'), SKILL_README(name))
    writeFileSync(join(dir, 'agents/openai.yaml'), 'name: x\n')
    // A clean skill carries its evals; the shape rules are covered in structure-check.test.ts.
    mkdirSync(join(dir, 'evals'), { recursive: true })
    writeFileSync(join(dir, 'evals/evals.json'), JSON.stringify({ skill_name: name, evals: [{ id: 1, prompt: 'p', expected_output: 'e', files: [], assertions: ['a'] }] }))
  }
  mkdirSync(join(skills, 'fam'), { recursive: true })
  writeFileSync(join(skills, 'fam', 'GROUP.md'), '# Fam\n\nThe blurb.\n')
  const names = ['one', 'two'].slice(0, members)
  for (const name of names) meta(join(skills, 'fam', name), name)
  writeFileSync(
    join(root, 'packages/cli/packaging.json'),
    JSON.stringify(Object.fromEntries(names.map(n => [n, ['SKILL.md']])), null, 2),
  )
  writeFileSync(join(root, 'README.md'), [
    '## Skills', '',
    '| Skill | What it does | Docs |', '|---|---|---|', '',
    '### Fam', '', 'The blurb.', '',
    '| Skill | What it does | Docs |', '|---|---|---|',
    ...names.map(n => `| [${n}](skills/fam/${n}/) | d | [SKILL.md](skills/fam/${n}/SKILL.md) |`), '',
    'Install any skill by name:', '',
    '## Repository structure', '',
  ].join('\n'))
  return root
}
const clean = (root: string) => rmSync(root, { recursive: true, force: true })

describe('structure.mjs check — exit codes', () => {
  test('a clean tree exits 0', () => {
    const root = fixture()
    const result = run('check', '--dir', root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('structure: ok')
    clean(root)
  })

  test('warnings alone exit 0 — they must never fail the chained root check', () => {
    const root = fixture({ members: 1 })
    const result = run('check', '--dir', root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString() + result.stdout.toString()).toMatch(/single skill/i)
    clean(root)
  })

  test('--strict turns the same warnings into exit 1', () => {
    const root = fixture({ members: 1 })
    expect(run('check', '--dir', root, '--strict').exitCode).toBe(1)
    clean(root)
  })

  test('a block exits 2', () => {
    const root = fixture()
    rmSync(join(root, 'skills/fam/GROUP.md'))
    expect(run('check', '--dir', root).exitCode).toBe(2)
    clean(root)
  })

  test('--json emits the guard envelope', () => {
    const root = fixture({ members: 1 })
    const parsed = JSON.parse(run('check', '--dir', root, '--json').stdout.toString())
    expect(parsed.guard).toBe('structure')
    expect(parsed.ok).toBe(true)
    expect(parsed.blocks).toEqual([])
    expect(parsed.warns.length).toBeGreaterThan(0)
    clean(root)
  })

  test('an unknown command or a flag with no value is a usage error, exit 2', () => {
    const root = fixture()
    expect(run('bogus', '--dir', root).exitCode).toBe(2)
    expect(run('create-group', 'fam2', '--blurb', 'b', '--title', '--write', '--dir', root).exitCode).toBe(2)
    expect(existsSync(join(root, 'skills/fam2'))).toBe(false)
    clean(root)
  })
})

describe('validate-skill.mjs — layout errors are reported, not crashed', () => {
  // This stage runs FIRST in `bun run check`, so an unhandled throw here buries the structure
  // check's readable report under a Node stack trace.
  test('an illegal layout exits 1 with a message and a pointer, and no stack trace', () => {
    const root = fixture()
    mkdirSync(join(root, 'skills/fam/nested/deep'), { recursive: true })
    writeFileSync(join(root, 'skills/fam/nested/deep/SKILL.md'), '---\nname: deep\ndescription: d\n---\n')
    const result = Bun.spawnSync(['node', join(import.meta.dir, '../scripts/validate-skill.mjs'), '--dir', root])
    const stderr = result.stderr.toString()
    expect(result.exitCode).toBe(1)
    expect(stderr).toMatch(/nested too deep/i)
    expect(stderr).toMatch(/structure\.mjs check/)
    expect(stderr).not.toMatch(/at Module|node:internal/)
    clean(root)
  })
})

describe('structure.mjs create-group — exit codes and atomicity', () => {
  test('a dry run exits 0 and writes nothing', () => {
    const root = fixture()
    const before = readFileSync(join(root, 'README.md'), 'utf8')
    expect(run('create-group', 'kin', '--title', 'Kin', '--blurb', 'b', '--dir', root).exitCode).toBe(0)
    expect(existsSync(join(root, 'skills/kin'))).toBe(false)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(before)
    clean(root)
  })

  test('a refusal exits 1 and leaves the tree exactly as it was', () => {
    const root = fixture()
    const before = readFileSync(join(root, 'README.md'), 'utf8')
    // "one" already names a skill inside another group — the namespace is shared.
    const result = run('create-group', 'one', '--title', 'One', '--blurb', 'b', '--write', '--dir', root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toMatch(/already lives at/)
    expect(existsSync(join(root, 'skills/one'))).toBe(false)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(before)
    // And the repo is still buildable, which is the point of refusing before mutating.
    expect(run('check', '--dir', root).exitCode).toBe(0)
    clean(root)
  })

  test('--write exits 0 and the result passes check, warning that the new group is empty', () => {
    const root = fixture()
    expect(run('create-group', 'kin', '--title', 'Kin', '--blurb', 'A blurb.', '--write', '--dir', root).exitCode).toBe(0)
    const check = run('check', '--dir', root)
    expect(check.exitCode).toBe(0)
    expect(check.stderr.toString() + check.stdout.toString()).toMatch(/holds no skills/i)
    clean(root)
  })
})

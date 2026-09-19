import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { refuseAmbientHome } from './no-ambient-home.ts'

refuseAmbientHome()

const packageRoot = resolve(import.meta.dir, '..')
let temporary = ''

beforeAll(async () => { temporary = await realpath(await mkdtemp(join(tmpdir(), 'vegastack-pack-'))) })
afterAll(async () => { await rm(temporary, { recursive: true, force: true }) })

describe('publishable package', () => {
  test('packs locally, installs the tarball, and runs its bundled installer', async () => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: packageRoot })
    expect(build.exitCode).toBe(0)
    // Installer-only smoke; descriptor-backed release pair is covered by release-artifacts.
    const pack = Bun.spawnSync(['npm', 'pack', '--ignore-scripts', '--silent', '--pack-destination', temporary], { cwd: packageRoot })
    expect(pack.exitCode).toBe(0)
    const filename = pack.stdout.toString().trim().split('\n').at(-1)!
    const tarball = join(temporary, filename)
    const installRoot = join(temporary, 'consumer')
    await mkdir(installRoot, { recursive: true })
    const install = Bun.spawnSync(['npm', 'install', '--ignore-scripts', '--prefix', installRoot, tarball], { cwd: temporary })
    expect(install.exitCode).toBe(0)
    const cli = join(installRoot, 'node_modules/.bin/vegafactory')
    const project = join(temporary, 'packed-project')
    await mkdir(project, { recursive: true })
    const add = Bun.spawnSync([cli, 'skills', 'add', 'dev-architect', '--agent', 'both', '--dir', project, '--non-interactive'], { cwd: temporary, env: { ...process.env, HOME: temporary, VEGAFACTORY_HOME: join(temporary, '.vegafactory') } })
    expect(add.exitCode).toBe(0)
    expect(await readFile(join(project, '.agents/skills/dev-architect/SKILL.md'), 'utf8')).toContain('name: dev-architect')
    expect(await readFile(join(project, '.claude/skills/dev-architect/SKILL.md'), 'utf8')).toContain('name: dev-architect')
    const installed = join(project, '.agents/skills/dev-architect')
    const installedFiles = await walk(installed)
    // Repo-side-only files must never ship in the packaged skill.
    for (const forbidden of ['README.md', 'dev-architect.test.ts']) expect(installedFiles.some(path => path.endsWith(forbidden))).toBe(false)
    expect(installedFiles.some(path => path.includes('/tests/'))).toBe(false)
    expect(installedFiles.some(path => path.includes('/scripts/'))).toBe(false)
    expect((await readFile(join(installed, 'SKILL.md'), 'utf8')).split('\n').length).toBeLessThanOrEqual(150)
    for (const required of [
      'references/principles.md', 'references/stack.md', 'references/pinned-facts.md',
      'references/web.md', 'references/data.md',
      'references/infra.md', 'references/ai-agents.md', 'references/security.md',
      'references/mobile.md',
      'agents/openai.yaml',
    ]) expect(installedFiles.some(path => path.endsWith(required))).toBe(true)
  }, 30_000)
})

async function walk(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output
}

// The release workflow hands npm a tarball path. npm reads a bare `a/b` as the
// GitHub shorthand `<owner>/<repo>` and tries to clone it, so only a path that
// starts with `./`, `../` or `/` is read as a file. That is how v0.20.0 was
// tagged, packed, smoked and then not published: the pack script resolves to an
// absolute path, and the workflow's own `npm publish` did not.
describe('the release workflow', () => {
  test('every npm publish names a tarball as a path, never as a repository', async () => {
    const workflow = await readFile(resolve(packageRoot, '../../.github/workflows/release.yml'), 'utf8')
    const published = [...workflow.matchAll(/npm publish\s+"?([^"\s]+)"?/g)].map((match) => match[1]!)
    expect(published.length).toBeGreaterThan(0)
    for (const spec of published) {
      expect(spec).toMatch(/^(\.\/|\.\.\/|\/)/)
    }
  })
})

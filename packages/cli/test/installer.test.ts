import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')
const cli = join(packageRoot, 'dist/index.js')
let temporary = ''

function run(home: string, args: string[]) {
  return Bun.spawnSync(['node', cli, ...args], { cwd: packageRoot, env: { ...process.env, HOME: home } })
}

beforeAll(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'vegastack-cli-')))
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: packageRoot })
  if (build.exitCode !== 0) throw new Error(build.stderr.toString())
})
afterAll(async () => { await rm(temporary, { recursive: true, force: true }) })

describe('@vegastack/vegafactory installer', () => {
  test('installs Codex-only, Claude-only, and dual project copies', async () => {
    for (const agent of ['codex', 'claude', 'both']) {
      const project = join(temporary, `project-${agent}`)
      await mkdir(project, { recursive: true })
      const result = run(temporary, ['skills', 'add', 'dev-architect', '--agent', agent, '--project', '--dir', project, '--non-interactive'])
      expect(result.exitCode).toBe(0)
      if (agent !== 'claude') expect(await readFile(join(project, '.agents/skills/dev-architect/SKILL.md'), 'utf8')).toContain('name: dev-architect')
      if (agent !== 'codex') expect(await readFile(join(project, '.claude/skills/dev-architect/SKILL.md'), 'utf8')).toContain('name: dev-architect')
    }
  })

  test('installs globally under the isolated HOME', async () => {
    const home = join(temporary, 'global-home')
    await mkdir(home, { recursive: true })
    const result = run(home, ['skills', 'add', 'dev-architect', '--agent', 'both', '--global', '--non-interactive'])
    expect(result.exitCode).toBe(0)
    expect(await readFile(join(home, '.agents/skills/dev-architect/SKILL.md'), 'utf8')).toContain('VegaStack Dev Architect')
    expect(await readFile(join(home, '.claude/skills/dev-architect/SKILL.md'), 'utf8')).toContain('VegaStack Dev Architect')
  })

  test('refuses conflicts, force replaces, and verify detects drift', async () => {
    const project = join(temporary, 'conflict')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    const target = join(project, '.agents/skills/dev-architect/SKILL.md')
    await writeFile(target, 'different\n')
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).not.toBe(0)
    expect(run(temporary, ['skills', 'verify', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).not.toBe(0)
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--force', '--non-interactive']).exitCode).toBe(0)
    expect(await readFile(target, 'utf8')).toContain('name: dev-architect')
    expect(run(temporary, ['skills', 'verify', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
  })

  test('without --project or --dir an install goes to the home directory', async () => {
    const home = join(temporary, 'default-global')
    await mkdir(home, { recursive: true })
    expect(run(home, ['skills', 'add', 'dev-debug', '--agent', 'claude', '--non-interactive']).exitCode).toBe(0)
    expect(existsSync(join(home, '.claude/skills/dev-debug/SKILL.md'))).toBe(true)
  })

  test('update replaces an untouched old copy and keeps a locally edited one', async () => {
    const project = join(temporary, 'update')
    await mkdir(project, { recursive: true })
    const add = (name: string) => run(temporary, ['skills', 'add', name, '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(add('dev-debug').exitCode).toBe(0)
    expect(add('dev-plan').exitCode).toBe(0)
    // An "old release": the file and its receipt agree, but differ from the bundle.
    const oldCopy = join(project, '.agents/skills/dev-debug')
    await writeFile(join(oldCopy, 'SKILL.md'), 'old release\n')
    const receipt = JSON.parse(await readFile(join(oldCopy, '.vegastack-install.json'), 'utf8'))
    receipt.files['SKILL.md'] = new Bun.CryptoHasher('sha256').update('old release\n').digest('hex')
    await writeFile(join(oldCopy, '.vegastack-install.json'), JSON.stringify(receipt))
    // A local edit: the file no longer matches its receipt.
    await writeFile(join(project, '.agents/skills/dev-plan/SKILL.md'), 'my own notes\n')
    const result = run(temporary, ['skills', 'update', '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain('kept locally edited copy')
    expect(await readFile(join(oldCopy, 'SKILL.md'), 'utf8')).toContain('name: dev-debug')
    expect(await readFile(join(project, '.agents/skills/dev-plan/SKILL.md'), 'utf8')).toBe('my own notes\n')
    const forced = run(temporary, ['skills', 'update', '--agent', 'codex', '--dir', project, '--force', '--non-interactive'])
    expect(forced.exitCode).toBe(0)
    expect(await readFile(join(project, '.agents/skills/dev-plan/SKILL.md'), 'utf8')).toContain('name: dev-plan')
  })

  test('a flag that needs a value refuses without one', () => {
    for (const flag of ['--agent', '--dir']) {
      const result = run(temporary, ['skills', 'add', 'dev-debug', flag])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(`${flag} requires a value`)
    }
  })

  test('dry-run writes nothing', async () => {
    const project = join(temporary, 'dry-run')
    await mkdir(project, { recursive: true })
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'both', '--dir', project, '--dry-run', '--non-interactive'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('would install')
    expect(await Bun.file(join(project, '.agents/skills/dev-architect/SKILL.md')).exists()).toBe(false)
  })

  test('refuses symlinked surfaces and symlinked --dir ancestors', async () => {
    const project = join(temporary, 'symlink-project')
    const outside = join(temporary, 'outside')
    await mkdir(project, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(project, '.agents'))
    let result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('symlink')
    expect(await Bun.file(join(outside, 'skills/dev-architect/SKILL.md')).exists()).toBe(false)

    const real = join(temporary, 'real-project')
    const alias = join(temporary, 'project-alias')
    await mkdir(real, { recursive: true })
    await symlink(real, alias)
    result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', alias, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('symlink')
  })

  test('rolls back all targets when a later staging operation fails', async () => {
    const project = join(temporary, 'atomic-failure')
    await mkdir(join(project, '.claude'), { recursive: true })
    await writeFile(join(project, '.claude/skills'), 'not a directory')
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'both', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(await Bun.file(join(project, '.agents/skills/dev-architect/SKILL.md')).exists()).toBe(false)
  })

  test('restores an existing differing target when a forced dual install cannot stage', async () => {
    const project = join(temporary, 'atomic-force-rollback')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    const target = join(project, '.agents/skills/dev-architect/SKILL.md')
    await writeFile(target, 'user-owned prior content\n')
    await mkdir(join(project, '.claude'), { recursive: true })
    await writeFile(join(project, '.claude/skills'), 'not a directory')
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'both', '--dir', project, '--force', '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(target, 'utf8')).toBe('user-owned prior content\n')
  })

  test('recovers a prepared crash journal before a later install', async () => {
    const project = join(temporary, 'crash-recovery')
    const parent = join(project, '.agents/skills')
    const destination = join(parent, skill())
    const backup = join(parent, `.${skill()}.backup-crash`)
    const stage = join(parent, `.${skill()}.stage-crash`)
    await mkdir(destination, { recursive: true })
    await mkdir(backup, { recursive: true })
    await mkdir(stage, { recursive: true })
    await writeFile(join(destination, 'SKILL.md'), 'partially-applied-new\n')
    await writeFile(join(backup, 'SKILL.md'), 'recoverable-prior\n')
    await mkdir(join(project, '.vegastack'), { recursive: true })
    await writeFile(join(project, '.vegastack/.skills-install-transaction.json'), JSON.stringify({ schemaVersion: 2, status: 'prepared', operations: [{ skill: skill(), agent: 'codex', destination, backup, stage, existed: true }] }))
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('recoverable-prior\n')
    expect(await Bun.file(join(project, '.vegastack/.skills-install-transaction.json')).exists()).toBe(false)
  })

  test('rejects an untrusted crash journal without deleting outside data', async () => {
    const project = join(temporary, 'malicious-journal')
    const outside = join(temporary, 'must-survive')
    await mkdir(join(project, '.vegastack'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'owned.txt'), 'preserve\n')
    await writeFile(join(project, '.vegastack/.skills-install-transaction.json'), JSON.stringify({ schemaVersion: 2, status: 'prepared', operations: [{ skill: skill(), agent: 'codex', destination: outside, stage: join(temporary, '.stage-attacker'), existed: false }] }))
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Untrusted installer recovery journal')
    expect(await readFile(join(outside, 'owned.txt'), 'utf8')).toBe('preserve\n')
  })

  test('refuses a concurrent live installer lock', async () => {
    const project = join(temporary, 'concurrent-lock')
    await mkdir(join(project, '.vegastack'), { recursive: true })
    await writeFile(join(project, '.vegastack/.skills-install.lock'), JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() }))
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('installation is active')
    expect(await Bun.file(join(project, '.agents/skills/dev-architect/SKILL.md')).exists()).toBe(false)
  })

  test('doctor reports profile and installation state', async () => {
    const project = join(temporary, 'doctor')
    await mkdir(join(project, '.vegastack'), { recursive: true })
    await writeFile(join(project, '.vegastack/dev.md'), '# Dev profile\n\n## Knobs\n\nmerge: rebase\n')
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    const result = run(temporary, ['skills', 'doctor', '--dir', project, '--non-interactive'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('ok dev profile')
    expect(result.stdout.toString()).toContain('ok codex dev-architect installation')
  })

  test('lists bundled skills with descriptions', async () => {
    const result = run(temporary, ['skills', 'list'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('dev-architect')
  })

  test('verify with no skill name checks all bundled skills and tolerates uninstalled ones', async () => {
    const project = join(temporary, 'verify-all')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    const result = run(temporary, ['skills', 'verify', '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(`verified codex ${skill()}`)
    expect(result.stdout.toString()).toContain('not installed codex skillify')

    const empty = join(temporary, 'verify-all-empty')
    await mkdir(empty, { recursive: true })
    const none = run(temporary, ['skills', 'verify', '--agent', 'codex', '--dir', empty, '--non-interactive'])
    expect(none.exitCode).not.toBe(0)
    expect(none.stdout.toString()).toContain('no bundled skills are installed')
  })

  test('remove with no one to answer and no --yes refuses', async () => {
    const project = join(temporary, 'remove-unconfirmed')
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    const refused = run(temporary, ['skills', 'remove', skill(), '--agent', 'codex', '--dir', project])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toString()).toContain('pass --yes')
    expect(existsSync(join(project, '.agents/skills', skill()))).toBe(true)
  })

  test('init stops with FAIL and no next step when the global install fails', async () => {
    const bin = join(temporary, 'init-bin')
    await mkdir(bin, { recursive: true })
    const script = async (name: string, body: string) => { await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`); await chmod(join(bin, name), 0o755) }
    await script('gh', 'exit 0')
    await script('claude', 'echo 2.1.0')
    await script('vegafactory', 'exit 1')
    await script('npm', 'echo "npm error 403 Forbidden" >&2; exit 1')
    const home = join(temporary, 'init-home')
    await mkdir(home, { recursive: true })
    const result = Bun.spawnSync(['node', cli, 'init'], { cwd: home, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } })
    const out = result.stdout.toString()
    expect(result.exitCode).toBe(1)
    expect(out).toContain('FAIL  cli')
    expect(out).toContain('Fix the FAIL lines above')
    expect(out).not.toContain('Next:')
  })

  test('remove uninstalls a clean copy and refuses a drifted one without --force', async () => {
    const project = join(temporary, 'remove-flow')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    const target = join(project, '.agents/skills', skill(), 'SKILL.md')
    await writeFile(target, 'locally modified\n')
    const refused = run(temporary, ['skills', 'remove', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toString()).toContain('--force')
    expect(await Bun.file(target).exists()).toBe(true)
    expect(run(temporary, ['skills', 'remove', skill(), '--agent', 'codex', '--dir', project, '--non-interactive', '--force']).exitCode).toBe(0)
    expect(await Bun.file(target).exists()).toBe(false)
    const gone = run(temporary, ['skills', 'remove', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(gone.exitCode).not.toBe(0)
    expect(gone.stdout.toString()).toContain('not installed')
  })

  test('dry-run over a differing install reports would-replace instead of erroring', async () => {
    const project = join(temporary, 'dry-run-differing')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    await writeFile(join(project, '.agents/skills', skill(), 'SKILL.md'), 'drift\n')
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--dry-run', '--non-interactive'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('would replace')
  })

  test('rejects a legacy v1 recovery journal with a manual-cleanup error', async () => {
    const project = join(temporary, 'legacy-journal')
    await mkdir(join(project, '.vegastack'), { recursive: true })
    await writeFile(join(project, '.vegastack/.skills-install-transaction.json'), JSON.stringify({ schemaVersion: 1, status: 'prepared', operations: [] }))
    const result = run(temporary, ['skills', 'add', skill(), '--agent', 'codex', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Unsupported installer recovery journal')
  })
})

function skill() { return 'dev-architect' }

describe('selecting a family', () => {
  test('add --group installs every member flat, on both surfaces', async () => {
    const project = join(temporary, 'group-install')
    await mkdir(project, { recursive: true })
    const result = run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'both', '--dir', project, '--non-interactive'])
    expect(result.exitCode).toBe(0)
    for (const name of ['dev-plan', 'dev-ship', 'dev-setup']) {
      expect(existsSync(join(project, `.claude/skills/${name}/SKILL.md`))).toBe(true)
      expect(existsSync(join(project, `.agents/skills/${name}/SKILL.md`))).toBe(true)
    }
    // The invariant from issue 54: a selection may name a group, an install path never does.
    expect(existsSync(join(project, '.claude/skills/dev'))).toBe(false)
  })

  test('a failure anywhere in the selection leaves the destination untouched', async () => {
    const project = join(temporary, 'group-rollback')
    // A pre-existing, differing copy of one member makes the run refuse without --force.
    await mkdir(join(project, '.claude/skills/dev-ship'), { recursive: true })
    await writeFile(join(project, '.claude/skills/dev-ship/SKILL.md'), 'not the bundled copy\n')
    const result = run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    // No other member may have been written: the whole selection refuses together.
    expect(existsSync(join(project, '.claude/skills/dev-plan'))).toBe(false)
    expect(await readFile(join(project, '.claude/skills/dev-ship/SKILL.md'), 'utf8')).toBe('not the bundled copy\n')
  })

  test('--all installs the dev family but not the repo-only meta skills', async () => {
    const project = join(temporary, 'all-install')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', '--all', '--agent', 'claude', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    expect(existsSync(join(project, '.claude/skills/dev-plan/SKILL.md'))).toBe(true)
    expect(existsSync(join(project, '.claude/skills/skillify'))).toBe(false)
    expect(existsSync(join(project, '.claude/skills/skill-maintainer'))).toBe(false)
    // Still installable deliberately — this is how this repo sets itself up.
    expect(run(temporary, ['skills', 'add', 'skill-maintainer', '--agent', 'claude', '--dir', project, '--non-interactive']).exitCode).toBe(0)
    expect(existsSync(join(project, '.claude/skills/skill-maintainer/SKILL.md'))).toBe(true)
  })

  test('conflicting selectors and an unknown group are refused before any write', async () => {
    const project = join(temporary, 'selector-refusal')
    await mkdir(project, { recursive: true })
    expect(run(temporary, ['skills', 'add', 'dev-plan', '--all', '--dir', project, '--non-interactive']).exitCode).not.toBe(0)
    const unknown = run(temporary, ['skills', 'add', '--group', 'ghost', '--dir', project, '--non-interactive'])
    expect(unknown.exitCode).not.toBe(0)
    expect(unknown.stderr.toString()).toMatch(/Available groups: dev, factory, repo-tooling/)
    expect(existsSync(join(project, '.claude'))).toBe(false)
  })

  test('re-running a group install reports unchanged and exits 0', async () => {
    const project = join(temporary, 'group-idempotent')
    await mkdir(project, { recursive: true })
    run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    const again = run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(again.exitCode).toBe(0)
    expect(again.stdout.toString()).toContain('unchanged')
  })

  test('verify --group reports each member, and fails when one is missing', async () => {
    const project = join(temporary, 'group-verify')
    await mkdir(project, { recursive: true })
    run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    const clean = run(temporary, ['skills', 'verify', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(clean.exitCode).toBe(0)
    expect(clean.stdout.toString()).toContain('verified claude dev-plan')

    await rm(join(project, '.claude/skills/dev-ship'), { recursive: true, force: true })
    const missing = run(temporary, ['skills', 'verify', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stdout.toString()).toMatch(/dev-ship/)
  })

  test('remove --group refuses on a drifted member before removing anything', async () => {
    const project = join(temporary, 'group-remove')
    await mkdir(project, { recursive: true })
    run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    await writeFile(join(project, '.claude/skills/dev-ship/SKILL.md'), 'locally edited\n')
    const refused = run(temporary, ['skills', 'remove', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(refused.exitCode).not.toBe(0)
    // Nothing removed: an untouched member must still be there.
    expect(existsSync(join(project, '.claude/skills/dev-plan/SKILL.md'))).toBe(true)

    const forced = run(temporary, ['skills', 'remove', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive', '--force'])
    expect(forced.exitCode).toBe(0)
    expect(existsSync(join(project, '.claude/skills/dev-plan'))).toBe(false)
    expect(existsSync(join(project, '.claude/skills/dev-ship'))).toBe(false)
  })

  test('the summary counts what installed, not what was selected', async () => {
    const project = join(temporary, 'group-summary')
    await mkdir(project, { recursive: true })
    // One member already present and identical: a selection of ten installs nine.
    run(temporary, ['skills', 'add', 'dev-plan', '--agent', 'claude', '--dir', project, '--non-interactive'])
    const mixed = run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(mixed.exitCode).toBe(0)
    expect(mixed.stdout.toString()).toContain('installed 9 skills from dev, 1 already up to date')

    // And when nothing needs doing at all, say so rather than printing no summary.
    const noop = run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(noop.exitCode).toBe(0)
    expect(noop.stdout.toString()).toMatch(/10 skills already installed and unchanged/)
  })

  test('--all names the repo-only skills it skipped', async () => {
    const project = join(temporary, 'all-notice')
    await mkdir(project, { recursive: true })
    const out = run(temporary, ['skills', 'add', '--all', '--agent', 'claude', '--dir', project, '--non-interactive']).stdout.toString()
    expect(out).toMatch(/skipped 2 repo-only/)
    expect(out).toMatch(/skill-maintainer/)
  })

  test('--force replaces a drifted member of a group and leaves the family verifiable', async () => {
    const project = join(temporary, 'group-force')
    await mkdir(project, { recursive: true })
    run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    await writeFile(join(project, '.claude/skills/dev-ship/SKILL.md'), 'locally edited\n')
    expect(run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive']).exitCode).not.toBe(0)
    expect(run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive', '--force']).exitCode).toBe(0)
    expect(run(temporary, ['skills', 'verify', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive']).exitCode).toBe(0)
  })

  test('remove settles a pending install journal, so removed skills stay removed', async () => {
    const project = join(temporary, 'remove-recovers')
    await mkdir(project, { recursive: true })
    run(temporary, ['skills', 'add', 'dev-plan', '--agent', 'claude', '--dir', project, '--non-interactive'])
    const skills = join(project, '.claude/skills')

    // An interrupted install leaves a backup plus a prepared journal naming it. Without settling
    // those first, the removal "succeeds" and the next add rolls the backup forward.
    await cp(join(skills, 'dev-plan'), join(skills, '.dev-plan.backup-deadbeef'), { recursive: true })
    await mkdir(join(project, '.vegastack'), { recursive: true })
    await writeFile(join(project, '.vegastack/.skills-install-transaction.json'), JSON.stringify({
      schemaVersion: 2,
      status: 'prepared',
      operations: [{
        skill: 'dev-plan',
        agent: 'claude',
        destination: join(skills, 'dev-plan'),
        existed: true,
        stage: join(skills, '.dev-plan.stage-deadbeef'),
        backup: join(skills, '.dev-plan.backup-deadbeef'),
      }],
    }))

    run(temporary, ['skills', 'remove', 'dev-plan', '--agent', 'claude', '--dir', project, '--non-interactive', '--force'])
    expect(existsSync(join(skills, 'dev-plan'))).toBe(false)
    expect(existsSync(join(skills, '.dev-plan.backup-deadbeef'))).toBe(false)

    run(temporary, ['skills', 'add', 'dev-ship', '--agent', 'claude', '--dir', project, '--non-interactive'])
    expect(existsSync(join(skills, 'dev-plan'))).toBe(false)
  })

  test('a dry run that the real run would refuse says so and exits non-zero', async () => {
    const project = join(temporary, 'dry-refusal')
    await mkdir(project, { recursive: true })
    run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--non-interactive'])
    await writeFile(join(project, '.claude/skills/dev-status/SKILL.md'), 'locally edited\n')
    const preview = run(temporary, ['skills', 'add', '--group', 'dev', '--agent', 'claude', '--dir', project, '--dry-run', '--non-interactive'])
    expect(preview.stdout.toString()).toMatch(/would replace .*dev-status/)
    expect(preview.stdout.toString()).toMatch(/would install nothing/)
    // The real run aborts, so a preview that exits 0 promises an install that cannot happen.
    expect(preview.exitCode).not.toBe(0)
  })

  test('a repeated --group is refused rather than silently last-wins', () => {
    const result = run(temporary, ['skills', 'add', '--group', 'dev', '--group', 'repo-tooling', '--dir', temporary, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('only once')
  })

  test('an empty --group value is refused rather than read as no selector', () => {
    const result = run(temporary, ['skills', 'add', '--group', '', '--dir', temporary, '--non-interactive'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('--group requires a value')
  })

  test('the no-selector error names the command you actually ran', () => {
    expect(run(temporary, ['skills', 'remove', '--dir', temporary, '--non-interactive']).stderr.toString()).toContain('Specify what to remove')
    expect(run(temporary, ['skills', 'add', '--dir', temporary, '--non-interactive']).stderr.toString()).toContain('Specify what to install')
  })

  test('list groups its output and teaches the group flag', () => {
    const out = run(temporary, ['skills', 'list']).stdout.toString()
    expect(out).toMatch(/^dev {2}—/m)
    expect(out).toMatch(/add --group dev$/m)
    expect(out.indexOf('dev-plan')).toBeGreaterThan(out.indexOf('dev  —'))
    // Repo-only skills are visible, and marked so the reason is legible without docs.
    expect(out).toMatch(/skillify/)
    expect(out).toMatch(/repo-only/i)
  })

  test('installer verbs live under the skills namespace; the bare verb is a usage error', async () => {
    const project = join(temporary, 'namespace')
    await mkdir(project, { recursive: true })
    const ok = run(temporary, ['skills', 'add', 'dev-architect', '--agent', 'claude', '--dir', project, '--dry-run', '--non-interactive'])
    expect(ok.exitCode).toBe(0)
    const bare = run(temporary, ['add', 'dev-architect', '--dir', project, '--dry-run', '--non-interactive'])
    expect(bare.exitCode).not.toBe(0)
    expect(bare.stderr.toString()).toContain('vegafactory skills add')
  })

  test('usage names the installer, worktree, sync, ship and hook verbs, and removed verbs are unknown', () => {
    const help = run(temporary, ['--help']).stdout.toString()
    expect(help).toContain('skills add <skill>')
    for (const verb of ['init', 'skills update', 'issue sync', 'worktree', 'sync', 'ship check', 'hook <event>', 'stats collect', 'dashboard', 'learning add|list']) expect(help).toContain(verb)
    // Bare `stats` prints its own verbs and writes nothing.
    const stats = run(temporary, ['stats'])
    expect(stats.exitCode).toBe(0)
    expect(stats.stdout.toString()).toContain('stats <collect|push|show>')
    for (const verb of ['dispatch', 'children', 'checkpoint']) {
      const result = run(temporary, [verb])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(`Unknown command: ${verb}`)
    }
  })

  test('worktree has landed: it is no longer reserved and prints its own verbs', () => {
    const bare = run(temporary, ['worktree'])
    expect(bare.exitCode).toBe(0)
    expect(bare.stdout.toString()).toContain('vegafactory worktree <list|create|restore|remove|prune|status>')
    const unknown = run(temporary, ['worktree', 'nuke'])
    expect(unknown.exitCode).not.toBe(0)
    expect(unknown.stderr.toString()).toContain('list|create|restore|remove|prune|status')
    expect(run(temporary, ['--help']).stdout.toString()).toContain('vegafactory worktree')
  })

  test('the package manifest carries the vegafactory identity', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@vegastack/vegafactory')
    expect(manifest.bin).toEqual({ vegafactory: 'dist/index.js' })
    expect(manifest.repository.url).toContain('vegastack/vegafactory')
    expect(manifest.homepage).toContain('vegastack/vegafactory')
  })
})

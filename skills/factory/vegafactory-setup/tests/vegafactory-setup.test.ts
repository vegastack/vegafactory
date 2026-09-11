import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateSkill } from '../../../../packages/cli/scripts/validate-skill.mjs'
import { mergeRepoPolicy, parseRepoPolicy, stagePolicy } from '../../../../packages/cli/src/config.ts'

const skillRoot = resolve(import.meta.dir, '..')

describe('vegafactory-setup contract', () => {
  test('SKILL.md passes repo validation', () => {
    const result = validateSkill(skillRoot)
    expect(result.message).toBe('Skill is valid!')
    expect(result.ok).toBe(true)
  })

  test('trigger query fixture is a small hard set with near-miss negatives', () => {
    const queries = JSON.parse(readFileSync(join(skillRoot, 'tests/fixtures/trigger-queries.json'), 'utf8'))
    const positives = queries.filter((entry: { should_trigger: boolean }) => entry.should_trigger)
    const negatives = queries.filter((entry: { should_trigger: boolean }) => !entry.should_trigger)
    expect(positives.length).toBeGreaterThanOrEqual(5)
    expect(negatives.length).toBeGreaterThanOrEqual(4)
    for (const entry of queries) expect(typeof entry.query).toBe('string')
  })


  const assets = resolve(skillRoot, 'assets/control-room')

  test('every control-room template is packaged, and packaging lists them in tree order', () => {
    const packaging = JSON.parse(
      readFileSync(resolve(skillRoot, '../../../packages/cli/packaging.json'), 'utf8'),
    ) as Record<string, string[]>
    const templates = packaging['vegafactory-setup'].filter((p) => p.startsWith('assets/control-room/'))
    expect(templates).toEqual([
      'assets/control-room/org.md.template',
      'assets/control-room/people.csv.template',
      'assets/control-room/decisions.md.template',
      'assets/control-room/group.md.template',
      'assets/control-room/repos.md.template',
      'assets/control-room/boards.md.template',
      'assets/control-room/rules/README.md.template',
      'assets/control-room/rules/CODEOWNERS.template',
      'assets/control-room/rules/stats-privacy.md.template',
      'assets/control-room/templates/README.md.template',
      'assets/control-room/onboarding/new-repo.md.template',
      'assets/control-room/onboarding/new-teammate.md.template',
      'assets/control-room/onboarding/dispatcher-box.md.template',
    ])
    for (const path of templates) expect(existsSync(resolve(skillRoot, path))).toBe(true)
  })

  test('people.csv template carries the exact column header the layering rule reads', () => {
    const csv = readFileSync(join(assets, 'people.csv.template'), 'utf8')
    expect(csv.split('\n')[0]).toBe('login,name,role,slack,timezone,groups')
  })

  test('group.md template carries a default for every knob a group can decide, derived from the profile template', () => {
    const group = readFileSync(join(assets, 'group.md.template'), 'utf8')
    const profile = readFileSync(resolve(skillRoot, '../../dev/dev-setup/assets/dev-profile.md.template'), 'utf8')
    // Header lines, detected-per-repo facts, per-repo paths, and the `## Architecture` facts
    // have no group default; everything else the profile template holds must be answered here.
    const perRepo = new Set([
      'repo', 'stack', 'commands', 'authority',
      'harnesses', 'skill-scan', 'worktree-include', 'board', 'issue-types', 'issue-fields', 'decisions', 'control-room', 'dispatch',
      'hosting', 'database', 'auth', 'storage', 'jobs', 'agents', 'stage', 'kind', 'mobile',
    ])
    const knobs = [...profile.matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1]!).filter((k) => !perRepo.has(k))
    expect(knobs).toContain('ui-evidence')
    expect(knobs).toContain('harness-policy')
    for (const knob of knobs) expect(group).toMatch(new RegExp(`^${knob}:`, 'm'))
    for (const knob of ['dispatcher:', 'ship-environments:', 'design-system:', 'secrets:', 'gh-floor:', 'stats:']) expect(group).toContain(knob)
    expect(group).not.toMatch(/^harness:/m)
  })

  test('the group harness policy is the line shape the dispatcher parses, and it merges into a repo that names none', () => {
    const group = readFileSync(join(assets, 'group.md.template'), 'utf8')
    expect(parseRepoPolicy(group).refusal).toMatch(/harness/)
    const confirmed = group.replace(/\{\{([a-z]+)-(harness|model|effort)\}\}/g, (_match, _stage, field) => field === 'harness' ? 'codex' : field === 'model' ? 'fixture-model' : 'high')
      .replace('{{operators}}', 'mk')
    expect(Object.keys(parseRepoPolicy(confirmed).stages).sort()).toEqual(['chronicle', 'implement', 'intake', 'plan', 'review', 'status'])
    const merged = mergeRepoPolicy(confirmed, 'dispatch: local\noperators: mk')
    expect(stagePolicy(merged, 'implement')).toEqual({ harness: 'codex', model: 'fixture-model', effort: 'high' })
    expect(stagePolicy(merged, 'corrections').harness).toBe('codex')
  })

  test('org.md template holds the global policy only, never a department knob', () => {
    const org = readFileSync(join(assets, 'org.md.template'), 'utf8')
    expect(org).toMatch(/^stats: on$/m)
    expect(org).toMatch(/^stats-people: off$/m)
    expect(org).toMatch(/^stats-override: allowed$/m)
    for (const knob of ['review:', 'gates:', 'merge:', 'harness:']) expect(org).not.toContain(knob)
  })

  test('no template carries a secret value, only secret names', () => {
    for (const file of ['org.md.template', 'group.md.template']) {
      const body = readFileSync(join(assets, file), 'utf8')
      const credential = /(?:\bghp_|\bsk-|\bAKIA)[A-Za-z0-9]/
      expect(body).not.toMatch(credential)
      for (const example of ['ghp_example', 'sk-example', 'AKIAEXAMPLE']) expect(credential.test(example)).toBe(true)
    }
  })

  // TODO: if this skill ships scripts/, add unit tests for every deterministic
  // branch. A prose-only skill needs nothing more here - its quality bar is the
  // behavioral eval of skillify Phase 4, which runs BEFORE tests lock anything in.

  test('org.md records the App identity by name and never a key', () => {
    const org = readFileSync(join(assets, 'org.md.template'), 'utf8')
    expect(org).toMatch(/^app: VegaFactory\b/m)
    expect(org).toMatch(/^app-slug: vegafactory\b/m)
    expect(org).toMatch(/^app-install: \{\{installation-id\}\}/m)
    expect(org).toContain('variable VEGAFACTORY_APP_ID · secret VEGAFACTORY_APP_PRIVATE_KEY')
    expect(org).toContain('Issues read/write · Projects (organization) read/write · Metadata read · Pull requests read/write · Contents read')
    expect(org).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(org).not.toContain('BEGIN PRIVATE KEY')
  })

  test('the skill detects an installation and refuses to create the App itself', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('## Round — automation identity')
    expect(skill).toContain('gh api orgs/<org>/installations')
    expect(skill).toContain('references/github-app.md')
    expect(skill).toContain('app-install:')
  })


  test('the dispatcher-box checklist carries the two-user rule, the pinned toolchain, and the group grant', () => {
    const template = readFileSync(join(assets, 'onboarding/dispatcher-box.md.template'), 'utf8')
    const headings = template.split('\n').filter((line) => line.startsWith('## '))
    expect(headings).toEqual([
      '## Accounts',
      '## Toolchain',
      '## Power and login',
      '## Dispatcher ownership and offline recovery',
      '## Grant the group',
      '## Register the runner',
      '## Verify',
    ])
    const accounts = template.split('## Accounts')[1].split('\n## ')[0]
    expect(accounts).toContain('{{runner-user}}')
    expect(accounts).toContain('{{dispatcher-user}}')
    expect(accounts).toContain('cannot read')
    expect(template).toContain('bun 1.3.14')
    expect(template).toContain('Node 24')
    expect(template).toContain('gh 2.97')
    expect(template).toContain('uv tool install git+https://github.com/NVIDIA/skillspector.git')
    expect(template).toContain('--runnergroup {{runner-group}}')
    expect(template).toContain('gh api orgs/{{org}}/actions/runner-groups')
    expect(template).toContain('gh api -X PUT orgs/{{org}}/actions/runner-groups/')
    // The runner account holds no gh credential, so its block calls gh nowhere: the release
    // lookup goes through the public API with curl and the registration token is minted by an
    // org admin in their own session and pasted in.
    const register = template.split('## Register the runner')[1].split('\n## ')[0]
    expect(register).not.toContain('gh ')
    expect(register).toContain('set -e')
    expect(register).toContain('api.github.com/repos/actions/runner/releases/latest')
    expect(register).toContain('--token "$RUNNER_TOKEN"')
    const grant = template.split('## Grant the group')[1].split('\n## ')[0]
    expect(grant).toContain('gh api -X POST orgs/{{org}}/actions/runners/registration-token -q .token')
    expect(grant).toContain('-f name={{runner-group}}')
    expect(grant).toContain('runner: null')
    const packaging = JSON.parse(
      readFileSync(resolve(skillRoot, '../../../packages/cli/packaging.json'), 'utf8'),
    ) as Record<string, string[]>
    const entry = packaging['vegafactory-setup']
    expect(entry).toContain('assets/control-room/onboarding/dispatcher-box.md.template')
    expect(entry.indexOf('assets/control-room/onboarding/dispatcher-box.md.template')).toBe(
      entry.indexOf('assets/control-room/onboarding/new-teammate.md.template') + 1,
    )
  })

  test('the skill names the dispatcher box as an onboarding path', () => {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('onboarding/dispatcher-box.md')
  })

})

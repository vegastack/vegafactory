import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const skillRoot = join(import.meta.dir, '..')
const template = readFileSync(join(skillRoot, 'assets/factory-board.yml.template'), 'utf8')
const workflow = Bun.YAML.parse(template) as any
const step = (id: string) => workflow.jobs.mirror.steps.find((s: any) => s.id === id)

type RunResult = { code: number | null; stdout: string; outputs: string; ghLog: string }

function runBlock(script: string, env: Record<string, string>, ghVersion = 'gh version 2.97.0 (2026-08-01)'): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'vsk-board-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const ghLog = join(dir, 'gh.log')
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nif [ "$2" = "field-list" ]; then echo '{"fields":[{"name":"Status","options":[{"name":"ready"},{"name":"Go"}]}]}'; exit 0; fi\nif [ "$1" = "--version" ]; then echo "${ghVersion}"; exit 0; fi\nif [ -n "\${FAIL_FIRST:-}" ]; then : > "${dir}/failfirst"; fi\nprintf '%s\\n' "$*" >> "${ghLog}"\nif [ -n "\${FAIL_ALWAYS:-}" ]; then echo "GraphQL: Resource not accessible by integration (updateProjectV2ItemFieldValue)" >&2; exit 1; fi\nif [ -f "${dir}/failfirst" ] && ! grep -q item-add "${ghLog}"; then echo "https://github.com/vegastack/vegafactory/issues/1 is not an item in project 7; add it first with \\\`gh project item-add\\\`" >&2; exit 1; fi\nexit 0\n`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const file = join(dir, 'block.sh')
  writeFileSync(file, script)
  const out = join(dir, 'outputs')
  writeFileSync(out, '')
  const proc = Bun.spawnSync(['sh', file], {
    env: { ...process.env, POLICY_MODULE: join(skillRoot, 'scripts/effective-policy.mjs'), PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, VSK_DIR: dir, ...env, ...(env.LABELS ? { LABELS: JSON.stringify(env.LABELS.split(',')) } : {}) },
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString() + proc.stderr.toString(),
    outputs: readFileSync(out, 'utf8'),
    ghLog: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
  }
}

function profile(_dir: string, line: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'vsk-profile-')), 'dev.md')
  writeFileSync(path, `# Dev profile\n\n## Knobs\n\n${line}\nmerge: rebase\n`)
  return path
}

const STATES = 'needs-operator,needs-plan,ready,working,for-operator'
const resolve = () => step('resolve').run as string

describe('factory-board template — triggers and permissions', () => {
  test('fires on the four issue events and never asks for write on contents', () => {
    expect(template).toContain('    types: [labeled, unlabeled, opened, reopened]')
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('the authoring notes end at the strip marker', () => {
    expect(template.split('\n').indexOf('# ---')).toBeGreaterThan(0)
  })

  test('runs-on is bound unquoted, so a label array renders as a YAML sequence and not one literal label', () => {
    // `runs-on: "[self-hosted, x]"` is a string Actions treats as a single label nobody carries,
    // and the job queues forever — before the resolve step's skips can run.
    expect(template).toContain('\n    runs-on: {{runs-on}}\n')
    const rendered = Bun.YAML.parse(template.replaceAll('{{runs-on}}', '[self-hosted, vsk-runners-mac]')) as any
    expect(rendered.jobs.mirror['runs-on']).toEqual(['self-hosted', 'vsk-runners-mac'])
    expect((Bun.YAML.parse(template.replaceAll('{{runs-on}}', 'ubuntu-latest')) as any).jobs.mirror['runs-on']).toBe('ubuntu-latest')
  })
})

describe('factory-board template — resolve step', () => {
  test('a profile the checkout did not bring in is a logged skip, not a red run', () => {
    const r = runBlock(resolve(), { PROFILE: join(mkdtempSync(join(tmpdir(), 'vsk-noprofile-')), 'dev.md'), APP_ID: '1', LABELS: 'ready', STATE_LABELS: STATES })
    expect(r.code).toBe(0)
    expect(r.outputs).toContain('decision=skip')
    expect(r.stdout).toContain('no such file')
    expect(r.ghLog).toBe('')
  })

  test('no board number in the profile is a logged skip', () => {
    const r = runBlock(resolve(), { PROFILE: profile('', 'board: none'), APP_ID: '1', LABELS: 'ready', STATE_LABELS: STATES })
    expect(r.code).toBe(0)
    expect(r.outputs).toContain('decision=skip')
    expect(r.stdout).toContain('carries no board number')
    expect(r.ghLog).toBe('')
  })

  test('an unwired App is a logged skip', () => {
    const r = runBlock(resolve(), { PROFILE: profile('', 'board: 7'), APP_ID: '', LABELS: 'ready', STATE_LABELS: STATES })
    expect(r.code).toBe(0)
    expect(r.outputs).toContain('decision=skip')
    expect(r.stdout).toContain('VEGAFACTORY_APP_ID')
  })

  test('gh below the 2.97.0 floor fails loudly', () => {
    const r = runBlock(
      resolve(),
      { PROFILE: profile('', 'board: 7'), APP_ID: '1', LABELS: 'ready', STATE_LABELS: STATES },
      'gh version 2.92.0 (2026-04-28)',
    )
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('::error::')
    expect(r.stdout).toContain('2.97.0')
  })

  test('exactly one state label resolves to a sync', () => {
    const r = runBlock(resolve(), { PROFILE: profile('', 'board: 7   # the mirror'), APP_ID: '1', LABELS: 'risky,working,full-plan', STATE_LABELS: STATES })
    expect(r.code).toBe(0)
    expect(r.outputs).toContain('decision=sync')
    expect(r.outputs).toContain('board=7')
    expect(r.outputs).toContain('status=working')
  })

  test('no state label is a logged skip', () => {
    const r = runBlock(resolve(), { PROFILE: profile('', 'board: 7'), APP_ID: '1', LABELS: 'risky,full-plan', STATE_LABELS: STATES })
    expect(r.code).toBe(0)
    expect(r.outputs).toContain('decision=skip')
    expect(r.stdout).toContain('no known workflow state label')
  })

  test('two state labels are ambiguous and skipped', () => {
    const r = runBlock(resolve(), { PROFILE: profile('', 'board: 7'), APP_ID: '1', LABELS: 'ready,working', STATE_LABELS: STATES })
    expect(r.code).toBe(0)
    expect(r.outputs).toContain('decision=skip')
    expect(r.stdout).toContain('conflicting state labels')
  })
})

describe('factory-board template — token and mirror steps', () => {
  test('both mutation steps are gated on the resolve decision', () => {
    expect(step('token').if).toBe("steps.resolve.outputs.decision == 'sync'")
    expect(step('mirror').if).toBe("steps.resolve.outputs.decision == 'sync'")
    expect(step('token').uses).toBe('actions/create-github-app-token@v3')
    expect(step('token').with['private-key']).toBe('${{ secrets.VEGAFACTORY_APP_PRIVATE_KEY }}')
  })

  test('the minted token is scoped to the one repository the job runs in, never the whole installation', () => {
    // `owner:` without `repositories:` mints for every repository the installation covers.
    expect(step('token').with.owner).toBe('${{ github.repository_owner }}')
    expect(step('token').with.repositories).toBe('${{ github.event.repository.name }}')
    const reference = readFileSync(join(skillRoot, 'references/github-app.md'), 'utf8')
    expect(reference).toContain('repositories: ${{ github.event.repository.name }}')
    // One major for the action, in the recipe and in the workflow that implements it.
    const docMajor = /actions\/create-github-app-token@(v\d+)/.exec(reference)![1]
    expect(step('token').uses).toBe(`actions/create-github-app-token@${docMajor}`)
  })

  test('the mirror step uses the gh 2.97 name-based field form', () => {
    expect(step('mirror').run).toContain('gh project item-edit "$BOARD" --owner "$OWNER" --url "$ISSUE_URL" --field Status --value "$STATUS"')
  })

  test('one mutation when the item is already on the board', () => {
    const r = runBlock(step('mirror').run as string, { BOARD: '7', OWNER: 'vegastack', STATUS: 'ready', ISSUE_URL: 'https://github.com/vegastack/vegafactory/issues/1' })
    expect(r.code).toBe(0)
    expect(r.ghLog.trim().split('\n')).toHaveLength(1)
    expect(r.ghLog).toContain('--field Status --value ready')
  })

  test('any other item-edit failure is reported as itself: no item-add, no misleading line, exit 1', () => {
    const r = runBlock(step('mirror').run as string, {
      BOARD: '7',
      OWNER: 'vegastack',
      STATUS: 'ready',
      ISSUE_URL: 'https://github.com/vegastack/vegafactory/issues/1',
      FAIL_ALWAYS: '1',
    })
    expect(r.code).toBe(1)
    expect(r.ghLog.trim().split('\n')).toHaveLength(1)
    expect(r.stdout).not.toContain('not on project')
    expect(r.stdout).toContain('Resource not accessible by integration')
    expect(r.stdout).toContain('::error::')
  })

  test('an item missing from the board is added, then edited once', () => {
    const r = runBlock(step('mirror').run as string, {
      BOARD: '7',
      OWNER: 'vegastack',
      STATUS: 'ready',
      ISSUE_URL: 'https://github.com/vegastack/vegafactory/issues/1',
      FAIL_FIRST: '1',
    })
    expect(r.code).toBe(0)
    const calls = r.ghLog.trim().split('\n')
    expect(calls).toHaveLength(3)
    expect(calls[1]).toContain('item-add')
  })
})

describe("this repo's own factory-board workflow", () => {
  test('is the template rendered, with nothing hand-edited into it', () => {
    const live = readFileSync(join(skillRoot, '../../../.github/workflows/factory-board.yml'), 'utf8')
    const marker = template.indexOf('\n# ---\n')
    const rendered = template
      .slice(marker + '\n# ---\n'.length)
      .replaceAll('{{runs-on}}', '[self-hosted, vsk-runners-mac]')
      .replaceAll('{{profile}}', '.vegastack/dev.md')
      .replaceAll('{{product-revision}}', '280f379cf5e955dd758b77566bf309c7b6ff5b6b')
    expect(live).toBe(rendered)
  })

  test("this repo's profile carries the board knob", () => {
    const profileText = readFileSync(join(skillRoot, '../../../.vegastack/dev.md'), 'utf8')
    expect(profileText).toMatch(/^board: none\b/m)
  })
})


test('141 board compiler resolves custom map without CSV positional interpretation', () => {
  const map = { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }
  const r = runBlock(resolve(), { PROFILE: profile('', 'board: 7\nworkflow-labels: ' + JSON.stringify(map)), APP_ID: '1', LABELS: 'Go,full-plan' })
  expect(r.code).toBe(0)
  expect(r.outputs).toContain('status=Go')
  const conflict = runBlock(resolve(), { PROFILE: profile('', 'board: 7\nworkflow-labels: ' + JSON.stringify(map)), APP_ID: '1', LABELS: 'Go,Decision' })
  expect(conflict.outputs).toContain('decision=skip')
  expect(conflict.ghLog).toBe('')
})


test('141 board preserves complete actual labels, CSV and reordered defaults', () => {
  const actual = /^labels:\s*([^#\n]+)/m.exec(readFileSync(join(skillRoot, '../../../.vegastack/dev.md'), 'utf8'))![1]!.trim()
  for (const labels of [actual, actual.split(/\s+/).join(','), actual.split(/\s+/).reverse().join(' ')]) {
    const result = runBlock(resolve(), { PROFILE: profile('', 'board: 7\nlabels: ' + labels), APP_ID: '1', LABELS: 'ready,full-plan' })
    expect(result.outputs).toContain('status=ready')
  }
})

test('141 missing configured board option refuses before item mutations', () => {
  const result = runBlock(step('mirror').run as string, { BOARD: '7', OWNER: 'vegastack', STATUS: 'Missing', ISSUE_URL: 'https://github.com/vegastack/vegafactory/issues/1' })
  expect(result.code).toBe(1)
  expect(result.stdout).toContain('configured Status option unavailable')
  expect(result.ghLog).toBe('')
})

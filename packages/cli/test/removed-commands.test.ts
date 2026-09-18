import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Commands the lean rebuild removed. Skills and docs must not tell an agent to run them.
// `stats`, `dashboard` (P7) and `learning` (P8) are real commands again, with new subcommands;
// the old subcommands below stay removed.
const REMOVED = ['children', 'dispatch', 'service', 'runs', 'run-wrapper', 'status', 'launch', 'claims', 'checkpoint', 'checkpoints', 'config', 'guard']
// Subcommands that only the removed commands had, written bare in backticks (`stats export`).
const BARE = ['learning (checkpoint|inspect|revert|record)', 'stats (record|rollup|activity|privacy|export|cleanup)', 'children (run|join|plan|launch)', 'service (install|uninstall)']
// Scripts, assets and hook files that no longer exist; `vegafactory hook`, `ship check` and `issue claim` replace the hook-era ones.
const DELETED = ['children.mjs', 'implement-children.js', 'release-artifacts.mjs', 'release-publish.mjs', 'readme-sync', 'refresh/sources.json', 'parallel-children.md',
  'ship-gate.mjs', 'ship-policy.mjs', 'ship-guard.mjs', 'reclaim.mjs', 'approval.mjs', 'session-start.mjs', 'stop-heartbeat.mjs', 'session-end.mjs', 'decision-nudge.mjs', 'guard sync',
  'cross-agent.md', 'dispatch-prompts.md', 'REVIEW REQUEST', 'reviewBinding']
const root = join(import.meta.dir, '../../..')

test('no skill, doc or hook wiring calls a removed CLI command or a deleted script', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'skills', '*.md', '.codex', 'packages/cli/packaging.json'], { cwd: root, encoding: 'utf8' })
    // History files and changesets keep old names.
    .split('\0').filter((file) => file && !/(^|\/)(CHANGELOG|chronicle|decisions)\.md$/.test(file) && !file.startsWith('.changeset/') && !file.includes('/tests/'))
  const verbs = REMOVED.join('|')
  const prose = new RegExp(`\\bvegafactory (${verbs})\\b`)
  const bare = new RegExp(`\`(${BARE.join('|')})\\b`)
  const hits = files.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    return text.split('\n').flatMap((line, index) =>
      prose.test(line) || bare.test(line) || DELETED.some((name) => line.includes(name)) ? [`${file}:${index + 1}`] : [])
  })
  expect(hits).toEqual([])
})

// The room prepared for the live control-room pull request is the approved layout and nothing
// else: seven top-level entries, every onboarding checklist the skill routes through rendered,
// and no placeholder left in any of them.
test('the prepared control-room refresh is exactly the approved layout', () => {
  const room = join(root, 'control-room-refresh/room')
  const top = readdirSync(room).sort()
  expect(top).toEqual(['boards.md', 'dispatchers.md', 'groups', 'onboarding', 'org.md', 'repos.md', 'stats'])
  expect(readdirSync(join(room, 'onboarding')).sort()).toEqual(['dispatcher-box.md', 'new-repo.md', 'new-teammate.md'])
  expect(readdirSync(join(room, 'groups/dev'))).toEqual(['group.md'])
  expect(readdirSync(join(room, 'stats'))).toEqual(['README.md'])
  const files = execFileSync('git', ['ls-files', '-z', '--', 'control-room-refresh/room'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const file of files) expect(readFileSync(join(root, file), 'utf8'), file).not.toContain('{{')
  // Every onboarding checklist the skill ships a template for is rendered here.
  const templates = readdirSync(join(root, 'skills/factory/vegafactory-setup/assets/control-room/onboarding')).map((name) => name.replace('.template', '')).sort()
  expect(readdirSync(join(room, 'onboarding')).sort()).toEqual(templates)
  // org.md keeps the automation identity the skill and its template both require.
  const org = readFileSync(join(room, 'org.md'), 'utf8')
  for (const line of ['app: VegaFactory', 'app-slug: vegafactory', 'app-install: 158664419', 'app-secrets: ', 'app-permissions: ']) expect(org).toContain(line)
  // No pinned model ids: `default` takes each tool's own.
  expect(readFileSync(join(room, 'groups/dev/group.md'), 'utf8')).not.toMatch(/harness-policy:.*\b(fable|sonnet|opus|gpt)-/)
})

// The prepared room is half the patch; the other half is the removals the summary documents.
// What matters is the tree the operator is left with, so this runs the documented commands against
// the live room's current file list and checks what comes out.
test('applying the documented patch leaves exactly the seven-entry layout', () => {
  const summary = readFileSync(join(root, 'control-room-refresh/pull-request.md'), 'utf8')
  const recipe = /```sh\n([\s\S]*?)```/.exec(summary)?.[1] ?? ''
  const removed = /^git rm -r (.+)$/m.exec(recipe)?.[1]?.split(/\s+/) ?? []
  expect(removed.length).toBeGreaterThan(0)
  expect(recipe).toMatch(/^cp -R .*control-room-refresh\/room\/\. \.$/m)

  // The live room as it stands today, from the listing this change was written against.
  const live = ['README.md', 'boards.md', 'decisions.md', 'groups/dev/decisions.md', 'groups/dev/group.md',
    'groups/dev/people.csv', 'onboarding/new-repo.md', 'onboarding/new-teammate.md', 'org.md',
    'people.csv', 'repos.md', 'rules/CODEOWNERS', 'rules/README.md', 'templates/README.md']
  const applied = mkdtempSync(join(tmpdir(), 'applied-221-'))
  try {
    for (const file of live) {
      mkdirSync(join(applied, dirname(file)), { recursive: true })
      writeFileSync(join(applied, file), 'live\n')
    }
    // git rm -r <paths>
    for (const path of removed) rmSync(join(applied, path), { recursive: true, force: true })
    // Every path the recipe names must actually have been there; a stale removal is a dead line.
    for (const path of removed) expect(live.some((file) => file === path || file.startsWith(path + '/')), path).toBe(true)
    // cp -R room/. .
    cpSync(join(root, 'control-room-refresh/room'), applied, { recursive: true })

    expect(readdirSync(applied).sort()).toEqual(['boards.md', 'dispatchers.md', 'groups', 'onboarding', 'org.md', 'repos.md', 'stats'])
    // Nothing of the old model survives anywhere in the tree.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name).slice(applied.length + 1)])
    expect(walk(applied).filter((file) => readFileSync(join(applied, file), 'utf8') === 'live\n')).toEqual([])
  } finally { rmSync(applied, { recursive: true, force: true }) }
})

// The lean control room is exactly these seven; a file the old model had must not come back.
test('the control-room templates are the lean room and nothing else', () => {
  const assets = join(import.meta.dir, '../../../skills/factory/vegafactory-setup/assets/control-room')
  const files = execFileSync('git', ['ls-files', '--', assets], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((path) => path.slice(path.indexOf('assets/control-room/') + 'assets/control-room/'.length))
  expect(files.sort()).toEqual([
    'boards.md.template', 'dispatchers.md.template', 'group.md.template',
    'onboarding/dispatcher-box.md.template', 'onboarding/new-repo.md.template', 'onboarding/new-teammate.md.template',
    'org.md.template', 'repos.md.template', 'stats/README.md.template',
  ])
})

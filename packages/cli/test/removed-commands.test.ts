import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Commands the lean rebuild removed. Skills and docs must not tell an agent to run them.
// `stats`, `dashboard` (P7), `learning` (P8) and `dispatch` (P6) are real commands again, with
// new subcommands; the old subcommands below stay removed.
const REMOVED = ['children', 'service', 'runs', 'run-wrapper', 'status', 'launch', 'claims', 'checkpoint', 'checkpoints', 'config', 'guard']
// Subcommands that only the removed commands had, written bare in backticks (`stats export`).
const BARE = ['learning (checkpoint|inspect|revert|record)', 'stats (record|rollup|activity|privacy|export|cleanup)', 'children (run|join|plan|launch)', 'service (install|uninstall)']
// Scripts, assets and hook files that no longer exist; `vegafactory hook`, `ship check` and `issue claim` replace the hook-era ones.
const DELETED = ['children.mjs', 'implement-children.js', 'release-artifacts.mjs', 'release-publish.mjs', 'readme-sync', 'refresh/sources.json', 'parallel-children.md',
  'ship-gate.mjs', 'ship-policy.mjs', 'ship-guard.mjs', 'reclaim.mjs', 'approval.mjs', 'session-start.mjs', 'stop-heartbeat.mjs', 'session-end.mjs', 'decision-nudge.mjs', 'guard sync',
  'cross-agent.md', 'dispatch-prompts.md', 'REVIEW REQUEST', 'reviewBinding']
// Vocabulary the lean rebuild retired: the pre-lean workflow labels, knobs and mechanisms.
// Matched as the thing itself — a label name in backticks, a knob line, a named mechanism —
// never as an English word, so `ready to ship` and "the work in progress" stay writable.
const STALE: Array<[string, RegExp]> = [
  ['old state label', /`(ready|working|needs-plan|needs-operator|for-operator)`|\b(needs-plan|needs-operator|for-operator)\b|\blabell?ed (ready|working)\b/],
  ['old scope label', /`(quick-build|deep-build)`|\b(quick-build|deep-build)\b/],
  ['the gates knob', /`?\bgates:\s*[0-9]/],
  ['the workflow-labels knob', /workflow-labels/],
  ['parallel children', /parallel[- ]children|child concurrency|childConcurrent/],
  ['the dashboard package', /@vegastack\/vegafactory-dashboard/],
  ['the token broker', /token broker|vegafactory broker/],
  ['Hermes', /\bHermes\b/],
  ['the refresh registry', /refresh registry|refresh\/sources\.json|refresh\.json/],
  ['the dev-chronicle skill', /dev-chronicle/],
]
const root = join(import.meta.dir, '../../..')

// One list, used by both sweeps. History files and changesets keep old names, and a test that
// asserts a name is gone must be allowed to spell it. `retired.json` is the tombstone file: it
// exists precisely to name skills that left the bundle, and JSON has no room for a marker
// comment, so it is exempt as a whole — its own shape is checked in label-templates.test.ts.
const TOMBSTONE = 'packages/cli/retired.json'
function sweptFiles(includeTests = false): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'skills', '*.md', '.codex', '.github', 'packages/cli', 'tooling', 'scripts'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && file !== TOMBSTONE && !/(^|\/)(CHANGELOG|chronicle|decisions)\.md$/.test(file) && !file.startsWith('.changeset/')
      && (includeTests || !file.includes('/test/') && !file.includes('/tests/')))
}

test('no skill, doc or hook wiring calls a removed CLI command or a deleted script', () => {
  const files = sweptFiles().filter((file) => file.startsWith('skills/') || file.endsWith('.md') || file.startsWith('.codex/') || file.endsWith('packaging.json'))
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

// The sweep the lean rebuild owes itself: a retired label, knob or mechanism must not appear in
// a file an agent reads AS SOMETHING TO USE. Naming one in order to migrate away from it is the
// opposite, so a line is exempt when it says `superseded`, `was removed`, `retired` or
// `migration` — and so is the body of a declaration whose own first line says one of them,
// which is how the old-to-new map, the retired-key list and the tombstone spell themselves out.
function exempt(lines: string[]): boolean[] {
  let openDeclaration = false
  return lines.map((line) => {
    const named = /superseded|was removed|\bretired\b|\bmigration\b/i.test(line)
    const inside = named || openDeclaration
    if (openDeclaration && /^\s*[)\]}]/.test(line)) openDeclaration = false
    else if (named && /^(const|export const)\s+[A-Z_]+\s*=/.test(line)) openDeclaration = true
    return inside
  })
}

test('no shipped file still names a retired label, knob or mechanism', () => {
  const hits = sweptFiles().flatMap((file) => {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    const skip = exempt(lines)
    return lines.flatMap((line, index) =>
      skip[index] ? []
        : STALE.filter(([, pattern]) => pattern.test(line)).map(([what]) => `${file}:${index + 1}: ${what}`))
  })
  expect(hits).toEqual([])
})

// The exemption is narrow on purpose: it covers a declaration that says what it retires, and
// nothing else. A file that simply uses an old name still fails.
test('the sweep exemption covers a named declaration and not the code around it', () => {
  const lines = [
    'const SUPERSEDED = Object.freeze({ // the superseded names',
    "  ready: 'queued',",
    '})',
    "const other = ['ready']",
    '// the migration reads a workflow-labels line once',
    "const stillWrong = 'workflow-labels'",
  ]
  expect(exempt(lines)).toEqual([true, true, true, false, true, false])
})

// The one file-level exemption has to stay one file.
test('the tombstone is the only file the sweep skips wholesale', () => {
  expect(TOMBSTONE).toBe('packages/cli/retired.json')
  expect(sweptFiles(true)).not.toContain(TOMBSTONE)
  expect(sweptFiles(true)).toContain('packages/cli/packaging.json')
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

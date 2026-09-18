import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

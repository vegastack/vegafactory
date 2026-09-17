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
  'ship-gate.mjs', 'ship-policy.mjs', 'ship-guard.mjs', 'reclaim.mjs', 'approval.mjs', 'session-start.mjs', 'stop-heartbeat.mjs', 'session-end.mjs', 'decision-nudge.mjs', 'guard sync']
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
]
const root = join(import.meta.dir, '../../..')

// One list, used by both sweeps. History files and changesets keep old names, and a test that
// asserts a name is gone must be allowed to spell it.
function sweptFiles(includeTests = false): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'skills', '*.md', '.codex', '.github', 'packages/cli', 'tooling', 'scripts'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !/(^|\/)(CHANGELOG|chronicle|decisions)\.md$/.test(file) && !file.startsWith('.changeset/')
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

// The sweep the lean rebuild owes itself: a retired label, knob or mechanism lives in the
// chronicle and the changelog, and nowhere an agent reads. The one exemption is a line that
// says `superseded` — the migration that deletes the old labels, and the eval that exercises
// it, both have to name them, and saying so on the line is cheaper than a file-level hole.
test('no shipped file still names a retired label, knob or mechanism', () => {
  const hits = sweptFiles().flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    return text.split('\n').flatMap((line, index) =>
      /superseded/i.test(line) ? []
        : STALE.filter(([, pattern]) => pattern.test(line)).map(([what]) => `${file}:${index + 1}: ${what}`))
  })
  expect(hits).toEqual([])
})

test('the control-room templates README names no hooks/ snippet folder', () => {
  const text = readFileSync(join(import.meta.dir, '../../../skills/factory/vegafactory-setup/assets/control-room/templates/README.md.template'), 'utf8')
  expect(text).not.toContain('`hooks/`')
  expect(text).toContain('vegafactory hook <event> --harness claude|codex')
})

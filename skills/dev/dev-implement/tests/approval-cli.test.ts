import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scopeDigest } from '../scripts/lib/approval.mjs'

const brief = { number: 1, node_id: 'issue-1', body: '<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\nBuild a thing.\n', state: 'open', labels: [{ name: 'ready' }, { name: 'quick-build' }], assignees: [] }
const plan = { id: 2, node_id: 'plan-2', body: '<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: build** <!-- task-id:1-T1 -->\n  - Files — `a.ts`\n' }
function fixture() {
  const event = { schemaVersion: 2, id: 'intent-1', scope: 'brief+plan', operator: 'ada', source: { kind: 'session', ref: 'session:current', quote: 'I approve this brief and plan.' }, artifacts: [
    { repo: 'acme/app', issue: 1, kind: 'brief', artifactId: brief.node_id, rev: 1, digest: scopeDigest(brief.body, 'brief') },
    { repo: 'acme/app', issue: 1, kind: 'plan', artifactId: plan.node_id, rev: 1, digest: scopeDigest(plan.body, 'plan') },
  ], supersedes: [], revokes: [] }
  return { brief: structuredClone(brief), comments: [structuredClone(plan), { id: 3, node_id: 'approval-3', body: '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(event) + '\n```\n' }] }
}
function run(data: ReturnType<typeof fixture>, historyError = false) {
  const dir = mkdtempSync(join(tmpdir(), 'approval-cli-'))
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data))
  writeFileSync(join(dir, 'dev.md'), 'repo: acme/app\noperators: ada\n')
  const stub = join(dir, 'gh')
  writeFileSync(stub, '#!/usr/bin/env node\n' + `const x=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'data.json'))},'utf8'));const p=process.argv[3]; if(p.endsWith('/comments')) { if(${historyError}) { process.stderr.write('HTTP 503');process.exit(1) }; process.stdout.write(JSON.stringify(process.argv.includes('--slurp')?[x.comments]:x.comments)) } else if(p.endsWith('/blocked_by')) process.stdout.write(process.argv.includes('--slurp')?'[[]]':'[]'); else process.stdout.write(JSON.stringify(x.brief));`, { mode: 0o755 })
  return spawnSync('node', [resolve(import.meta.dir, '../scripts/preflight.mjs'), '--issue', '1', '--repo', 'acme/app', '--me', 'ada', '--dev-md', join(dir, 'dev.md'), '--json'], { encoding: 'utf8', env: { ...process.env, VSK_GH: stub } })
}

test('actual CLI refuses a bare marker despite ready label', () => {
  const data = fixture(); data.comments[1]!.body = '<!-- vsk:v1 type=approval -->'
  expect(run(data).status).toBe(2)
})
test('actual CLI accepts agent-recorded current intent and progress, rejects changed scope/history', () => {
  expect(run(fixture()).status).toBe(0)
  const progress = fixture(); progress.comments[0]!.body = progress.comments[0]!.body.replace('[ ]', '[x]')
  expect(run(progress).status).toBe(0)
  for (const change of [
    (x: ReturnType<typeof fixture>) => { x.brief.body += 'New requirement' },
    (x: ReturnType<typeof fixture>) => { x.comments[0]!.body += 'New interface' },
    (x: ReturnType<typeof fixture>) => { x.comments[1]!.body = x.comments[1]!.body.replace('"ada"', '"mallory"') },
    (x: ReturnType<typeof fixture>) => { x.comments.push({ ...x.comments[0]!, id: 9, node_id: 'duplicate-plan' }) },
  ]) { const data=fixture(); change(data); expect(run(data).status).toBe(2) }
  expect(run(fixture(), true).status).toBe(2)
})

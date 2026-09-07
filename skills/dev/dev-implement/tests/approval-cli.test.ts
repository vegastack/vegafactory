import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scopeDigest, parseApproval } from '../scripts/lib/approval.mjs'

const brief = { number: 1, node_id: 'issue-1', body: '<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\nBuild a thing.\n', state: 'open', labels: [{ name: 'ready' }, { name: 'quick-build' }], assignees: [] }
const plan = { id: 2, node_id: 'plan-2', body: '<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: build** <!-- task-id:1-T1 -->\n  - Files — `a.ts`\n' }
function fixture() {
  const event = { schemaVersion: 2, id: 'intent-1', scope: 'brief+plan', operator: 'ada', source: { kind: 'session', ref: 'session:current', quote: 'I approve this brief and plan.' }, artifacts: [
    { repo: 'acme/app', issue: 1, kind: 'brief', artifactId: brief.node_id, rev: 1, digest: scopeDigest(brief.body, 'brief') },
    { repo: 'acme/app', issue: 1, kind: 'plan', artifactId: plan.node_id, rev: 1, digest: scopeDigest(plan.body, 'plan') },
  ], supersedes: [], revokes: [] }
  return { brief: structuredClone(brief), comments: [structuredClone(plan), { id: 3, node_id: 'approval-3', user: { login: 'ada' }, body: '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(event) + '\n```\n' }] }
}
function run(data: ReturnType<typeof fixture>, historyError = false, options: { me?: string; stage?: string; expect?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'approval-cli-'))
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data))
  writeFileSync(join(dir, 'dev.md'), 'repo: acme/app\noperators: ada\n')
  const stub = join(dir, 'gh')
  writeFileSync(stub, '#!/usr/bin/env node\n' + `const x=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'data.json'))},'utf8'));const p=process.argv[3]; if(p.endsWith('/comments')) { if(${historyError}) { process.stderr.write('HTTP 503');process.exit(1) }; process.stdout.write(JSON.stringify(process.argv.includes('--slurp')?(x.pages??[x.comments]):x.comments)) } else if(p.endsWith('/blocked_by')) process.stdout.write(process.argv.includes('--slurp')?'[[]]':'[]'); else process.stdout.write(JSON.stringify(x.brief));`, { mode: 0o755 })
  return spawnSync('node', [resolve(import.meta.dir, '../scripts/preflight.mjs'), '--issue', '1', '--repo', 'acme/app', '--me', options.me ?? 'ada', '--stage', options.stage ?? 'implement', '--expect', options.expect ?? 'ready', '--dev-md', join(dir, 'dev.md'), '--json'], { encoding: 'utf8', env: { ...process.env, VSK_GH: stub } })
}

test('actual CLI refuses a bare marker despite ready label', () => {
  const data = fixture(); data.comments[1]!.body = '<!-- vsk:v1 type=approval -->'
  expect(run(data).status).toBe(2)
})
test('actual CLI accepts agent-recorded current intent and progress', () => {
  expect(run(fixture()).status).toBe(0)
  const progress = fixture(); progress.comments[0]!.body = progress.comments[0]!.body.replace('[ ]', '[x]')
  expect(run(progress).status).toBe(0)
})
for (const [name, change] of [
  ['changed brief', (x: ReturnType<typeof fixture>) => { x.brief.body += 'New requirement' }],
  ['changed interface', (x: ReturnType<typeof fixture>) => { x.comments[0]!.body += 'New interface' }],
  ['wrong operator', (x: ReturnType<typeof fixture>) => { x.comments[1]!.body = x.comments[1]!.body.replace('"ada"', '"mallory"') }],
  ['duplicate plan', (x: ReturnType<typeof fixture>) => { x.comments.push({ ...x.comments[0]!, id: 9, node_id: 'duplicate-plan' }) }],
] as const) test('actual CLI refuses ' + name, () => {
  const data = fixture(); change(data); expect(run(data).status).toBe(2)
})
test('actual CLI refuses unreadable history', () => { expect(run(fixture(), true).status).toBe(2) })

function eventComment(event: any, id: number) { return { id, node_id: 'event-' + id, user: { login: 'ada' }, body: '<!-- vsk:v1 type=approval scope=' + event.scope + ' -->\n```json\n' + JSON.stringify(event) + '\n```\n' } }

test('actual CLI refuses wrong scope and conflicting approvals on later pages', () => {
  const wrong = fixture(); const onlyBrief = parseApproval(wrong.comments[1]); onlyBrief.scope = 'brief'; onlyBrief.artifacts = onlyBrief.artifacts.filter((ref: any) => ref.kind === 'brief'); wrong.comments[1] = eventComment(onlyBrief, 3)
  expect(run(wrong).status).toBe(2)
  const conflict: any = fixture(); const other = { ...parseApproval(conflict.comments[1]), id: 'conflicting-intent' }
  conflict.pages = [conflict.comments, [eventComment(other, 4)]]
  expect(run(conflict).status).toBe(2)
  conflict.pages[1] = { malformed: 'not an array page' }
  expect(run(conflict).status).toBe(2)
})

test('actual CLI revokes without regranting and accepts explicit supersession', () => {
  const data: any = fixture(); const original = parseApproval(data.comments[1])
  data.pages = [data.comments, [eventComment({ ...original, id: 'revocation', revokes: [original.id], artifacts: [] }, 4)]]
  expect(run(data).status).toBe(2)
  data.pages[1] = [eventComment({ ...original, id: 'revocation-with-grant', revokes: [original.id] }, 4)]
  expect(run(data).status).toBe(2)
  data.pages[1] = [eventComment({ ...original, id: 'superseding', supersedes: [original.id] }, 4)]
  const result = run(data)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).approvalIds).toEqual(['superseding'])
})

test('actual CLI exact legacy correction retains originals and needs separate current intent', () => {
  const data: any = fixture()
  const legacy = { id: 9, node_id: 'legacy', body: '<!-- vsk:v1 type=approval -->' }
  const correction = { schemaVersion: 2, kind: 'correction', scope: 'none', operator: 'ada', source: { kind: 'session', ref: 'session:correction', quote: 'Neutralize this exact old malformed record and retain it.' }, targets: [{ commentId: 9, bodySha256: Bun.SHA256.hash(legacy.body, 'hex') }], supersedes: [], revokes: [] }
  data.pages = [[legacy, eventComment(correction, 10)], data.comments]
  expect(run(data).status).toBe(0)
  data.pages[1] = [data.comments[0]]
  expect(run(data).status).toBe(2)
})

test('actual consolidated CLI returns manifest/task receipt and refuses another project policy', () => {
  const data = fixture()
  const item = { repo: 'acme/app', issue: 1, mode: 'code', artifacts: parseApproval(data.comments[1]).artifacts, taskIds: ['1-T1'], actionIds: ['local'] }
  const action = { id: 'local', kind: 'local', repo: 'acme/app', parentBranch: 'codex/fixture', operations: ['edit', 'check', 'review', 'integrate'] }
  const manifest = JSON.stringify({ schemaVersion: 1, parent: { repo: 'acme/app', issue: 10, branch: 'codex/fixture', baseSha: 'a'.repeat(40) }, codeIssues: [1], preparationTaskIds: [], candidateProtocols: [], excludedIssues: [], laterResearch: [], selections: [item], actionBounds: { local: action } })
  const record = { schemaVersion: 2, kind: 'consolidated', scope: 'consolidated', id: 'parent-grant', operator: 'ada', source: { kind: 'session', ref: 'session:scope', quote: 'I approve this frozen parent selection.' }, manifest: { sha256: Bun.SHA256.hash(manifest, 'hex'), source: { kind: 'inline', utf8: manifest } }, items: [item], actions: [action], supersedes: [], revokes: [] }
  const approved = eventComment(record, 20)
  const dir = mkdtempSync(join(tmpdir(), 'consolidated-cli-'))
  const request = { parentRepo: 'acme/app', parentIssue: 10, approvalBinding: { commentId: 20, bodySha256: Bun.SHA256.hash(approved.body, 'hex') }, requested: { repo: 'acme/app', issue: 1, taskIds: ['1-T1'], actionId: 'local', branch: 'codex/fixture', baseSha: 'a'.repeat(40), paths: ['a.ts'], operation: 'edit' } }
  writeFileSync(join(dir, 'request.json'), JSON.stringify(request))
  writeFileSync(join(dir, 'data.json'), JSON.stringify({ approved, brief, plan }))
  const stub = join(dir, 'gh')
  writeFileSync(stub, '#!/usr/bin/env node\n' + `const x=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'data.json'))},'utf8'));const p=process.argv[3];process.stdout.write(JSON.stringify(p.endsWith('/10/comments')?[[],[x.approved]]:p.endsWith('/comments')?[[x.plan]]:p.endsWith('/blocked_by')?[[]]:x.brief));`, { mode: 0o755 })
  const invoke = (repository: string) => {
    writeFileSync(join(dir, 'dev.md'), 'repo: ' + repository + '\noperators: ada\n')
    return spawnSync('node', [resolve(import.meta.dir, '../scripts/preflight.mjs'), '--repo', 'acme/app', '--dev-md', join(dir, 'dev.md'), '--consolidated-request', join(dir, 'request.json'), '--json'], { encoding: 'utf8', env: { ...process.env, VSK_GH: stub } })
  }
  const success = invoke('acme/app'); expect(success.status).toBe(0)
  const result = JSON.parse(success.stdout)
  expect(result.manifestSha256).toBe(record.manifest.sha256)
  expect(result.taskIds).toEqual(['1-T1']); expect(result.action.id).toBe('local')
  expect(invoke('another/project').status).toBe(2)
})


test('actual planning CLI accepts the operator assignee for a service-account runner', () => {
  const data: any = fixture()
  data.brief.labels = [{ name: 'needs-plan' }, { name: 'full-plan' }]
  data.brief.assignees = [{ login: 'ada' }]
  expect(run(data, false, { stage: 'plan', expect: 'needs-plan', me: 'service-runner' }).status).toBe(0)
  data.brief.assignees = [{ login: 'another-runner' }]
  expect(run(data, false, { stage: 'plan', expect: 'needs-plan', me: 'service-runner' }).status).toBe(2)
})

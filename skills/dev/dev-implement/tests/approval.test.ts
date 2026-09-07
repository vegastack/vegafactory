import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalScope, scopeDigest, parseApproval, evaluateApprovals, evaluateConsolidatedApproval, protocolLimits, gatherConsolidatedApproval, admitConsolidatedResearch, admitConsolidatedPreparation, checkpointSuiteDigest } from '../scripts/lib/approval.mjs'

const plan = '<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: verify** <!-- task-id:1-T1 -->\nFiles — `a.ts`\nInterfaces — none\nSteps: run check\n'
const artifact = { repo: 'acme/app', issue: 1, kind: 'plan', artifactId: 'plan-node', rev: 1, digest: 'a'.repeat(64) }
const record = () => ({ schemaVersion: 2, id: 'approval-1', operator: 'ada', scope: 'plan', source: { kind: 'session', ref: 'session:1', quote: 'I approve this plan.' }, artifacts: [artifact], supersedes: [], revokes: [] })
const comment = (value: unknown) => ({ body: '<!-- vsk:v1 type=approval scope=plan -->\n```json\n' + JSON.stringify(value) + '\n```\n' })

test('task progress preserves scope; files, interfaces, actions and revisions do not', () => {
  expect(scopeDigest(plan, 'plan')).toBe(scopeDigest(plan.replace('[ ]', '[x]'), 'plan'))
  for (const [before, after] of [['a.ts', 'b.ts'], ['none', 'new API'], ['run check', 'push main'], ['rev=1', 'rev=2'], ['1-T1', '1-T2']]) {
    expect(scopeDigest(plan.replace(before!, after!), 'plan')).not.toBe(scopeDigest(plan, 'plan'))
  }
})

test('only validated progress evidence is excluded', () => {
  const block = '<!-- vsk:progress:start -->\n{"tasks":[{"id":"1-T1","evidenceUrls":["https://example.test/check"]}]}\n<!-- vsk:progress:end -->\n'
  expect(canonicalScope(plan + block, 'plan')).toBe(plan)
  for (const invalid of [block.replace('https://example.test/check', 'file:///secret'), block.replace('"tasks":', '"requirements":'), block.replace('1-T1', '1-T9'), block + block, '<!-- vsk:progress:start -->\n{}']) {
    expect(() => canonicalScope(plan + invalid, 'plan')).toThrow()
  }
  expect(() => canonicalScope('<!-- vsk:v1 type=brief rev=1 -->\n' + block, 'brief')).toThrow()
})

test('fenced examples remain immutable bytes and cannot supply structural authority', () => {
  const example = '\n```md\n' + plan + '<!-- vsk:progress:start -->\n{}\n<!-- vsk:progress:end -->\n```\n'
  expect(canonicalScope(plan + example, 'plan')).toBe(plan + example)
  expect(scopeDigest(plan + example, 'plan')).not.toBe(scopeDigest(plan + example.replace('[ ]', '[x]'), 'plan'))
  expect(() => canonicalScope('```md\n' + plan + '```\n', 'plan')).toThrow()
})

test('duplicate structural markers and task identities refuse', () => {
  expect(() => canonicalScope(plan + plan, 'plan')).toThrow()
  expect(() => canonicalScope(plan + '- [ ] **Task duplicate** <!-- task-id:1-T1 -->\n', 'plan')).toThrow()
  expect(canonicalScope(plan.replaceAll('\n', '\r\n'), 'plan')).toBe(plan)
})

test('protocol content is wholly immutable except CRLF normalization', () => {
  const protocol = '<!-- custom-protocol issue=2 rev=1 -->\n- [ ] Scenario\n'
  expect(canonicalScope(protocol, 'protocol')).toBe(protocol)
  expect(scopeDigest(protocol, 'protocol')).not.toBe(scopeDigest(protocol.replace('[ ]', '[x]'), 'protocol'))
})

test('a scoped agent-recorded quotation parses, while marker-only and malformed intent refuse', () => {
  expect(parseApproval(comment(record()))).toEqual(record())
  for (const value of [{}, { ...record(), unknown: true }, { ...record(), source: { kind: 'session', ref: '', quote: '' } }, { ...record(), artifacts: [artifact, artifact] }, { ...record(), supersedes: ['approval-1'] }]) {
    expect(parseApproval(comment(value))).toHaveProperty('ok', false)
  }
  expect(parseApproval({ body: '<!-- vsk:v1 type=approval -->' })).toHaveProperty('ok', false)
  expect(parseApproval({ body: 'Nothing approved' })).toHaveProperty('ok', false)
})

test('JSON duplicate keys, mismatched marker scope and competing payloads refuse', () => {
  const valid = comment(record())
  expect(parseApproval({ body: valid.body.replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2') })).toHaveProperty('ok', false)
  expect(parseApproval({ body: valid.body.replace('scope=plan', 'scope=brief') })).toHaveProperty('ok', false)
  expect(parseApproval({ body: valid.body + '\n```json\n{}\n```' })).toHaveProperty('ok', false)
  expect(parseApproval({ body: '<!-- vsk:v1 type=approval scope=plan -->\n````md\n' + valid.body + '\n````\n' })).toHaveProperty('ok', false)
})

const brief = { body: '<!-- vsk:v1 type=brief rev=1 scope=full-plan -->\nBuild a file.\n', node_id: 'brief-node', number: 1 }
const livePlan = { body: plan, node_id: 'plan-node', id: 2 }
const grant = (id = 'grant-1') => {
  const value = { ...record(), id, scope: 'brief+plan', artifacts: [
    { ...artifact, kind: 'brief', artifactId: brief.node_id, digest: scopeDigest(brief.body, 'brief') },
    { ...artifact, digest: scopeDigest(plan, 'plan') },
  ] }
  return { id: 3, ...comment(value), body: comment(value).body.replace('scope=plan', 'scope=brief+plan') }
}
const evaluate = (comments: any[], overrides: Record<string, unknown> = {}) => evaluateApprovals({ repo: 'acme/app', issue: 1, brief, plan: livePlan, comments: [livePlan, ...comments], operators: ['ada'], requiredScope: 'brief+plan', ...overrides })

test('current full scope passes, while edited scope or operator identity refuses', () => {
  expect(evaluate([grant()]).ok).toBe(true)
  expect(evaluate([grant()], { brief: { ...brief, body: brief.body + 'New requirement' } }).ok).toBe(false)
  expect(evaluate([grant()], { operators: ['other'] }).ok).toBe(false)
  expect(evaluate([grant()], { repo: 'other/app' }).ok).toBe(false)
  expect(evaluate([grant()], { plan: { ...livePlan, node_id: 'other-comment' } }).ok).toBe(false)
})

test('revocations and conflicting events cannot be resolved by newest-wins', () => {
  expect(evaluate([grant(), { ...grant('grant-2'), id: 4 }]).ok).toBe(false)
  const superseding = parseApproval(grant('grant-2'))
  superseding.supersedes = ['grant-1']
  const second = { id: 4, body: '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(superseding) + '\n```\n' }
  expect(evaluate([grant(), second]).ok).toBe(true)
  const revocation = { ...record(), id: 'revoke-1', artifacts: [], revokes: ['grant-1'] }
  expect(evaluate([grant(), { id: 4, ...comment(revocation) }]).ok).toBe(false)
})

test('malformed historical approvals require an exact authorized correction', () => {
  const broken = { id: 8, body: '<!-- vsk:v1 type=approval scope=brief -->\nOld ambiguous statement' }
  expect(evaluate([broken, grant()]).ok).toBe(false)
  const correction = { schemaVersion: 2, kind: 'correction', scope: 'none', operator: 'ada', source: record().source, targets: [{ commentId: 8, bodySha256: Bun.SHA256.hash(broken.body, 'hex') }], supersedes: [], revokes: [] }
  const correctionComment = { id: 9, body: '<!-- vsk:v1 type=approval scope=none -->\n```json\n' + JSON.stringify(correction) + '\n```\n' }
  expect(evaluate([broken, correctionComment, grant()]).ok).toBe(true)
  expect(evaluate([broken, correctionComment]).ok).toBe(false)
  expect(evaluate([{ ...broken, body: broken.body + ' edited' }, correctionComment, grant()]).ok).toBe(false)
})

test('duplicate canonical plans refuse, while checkbox-only progress remains approved', () => {
  expect(evaluate([grant(), { ...livePlan, id: 20, node_id: 'other-plan' }]).ok).toBe(false)
  const progress = { ...livePlan, body: livePlan.body.replace('[ ]', '[x]') }
  expect(evaluateApprovals({ repo: 'acme/app', issue: 1, brief, plan: progress, comments: [progress, grant()], operators: ['ada'], requiredScope: 'brief+plan' }).ok).toBe(true)
})

function consolidatedFixture() {
  const item = { repo: 'acme/app', issue: 1, mode: 'code', artifacts: parseApproval(grant()).artifacts, taskIds: ['1-T1'], actionIds: ['local'] }
  const action = { id: 'local', kind: 'local', repo: 'acme/app', parentBranch: 'codex/fixture', operations: ['edit', 'check', 'review', 'integrate'] }
  const manifest = { schemaVersion: 1, parent: { repo: 'acme/app', issue: 10, branch: 'codex/fixture', baseSha: 'a'.repeat(40) }, codeIssues: [1], preparationTaskIds: [], candidateProtocols: [], excludedIssues: [2], laterResearch: [3], selections: [item], actionBounds: { local: action } }
  const manifestBytes = JSON.stringify(manifest)
  const record = { schemaVersion: 2, kind: 'consolidated', id: 'consolidated-1', operator: 'ada', scope: 'consolidated', source: { kind: 'session', ref: 'session:1', quote: 'I approve this frozen scope.' }, manifest: { sha256: Bun.SHA256.hash(manifestBytes, 'hex'), source: { kind: 'inline', utf8: manifestBytes } }, items: [item], actions: [action], supersedes: [], revokes: [] }
  const approved = { id: 10, body: '<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n' + JSON.stringify(record) + '\n```\n' }
  return { record, manifestBytes, operators: ['ada'], currentArtifacts: {
    artifacts: [{ repo: 'acme/app', issue: 1, kind: 'brief', artifact: brief }, { repo: 'acme/app', issue: 1, kind: 'plan', artifact: livePlan }],
    approvalComments: [approved], approvalBinding: { commentId: 10, bodySha256: Bun.SHA256.hash(approved.body, 'hex') },
  }, currentDependencies: [{ repo: 'acme/app', issue: 1, blockedBy: [] as any[] }], requested: { repo: 'acme/app', issue: 1, taskIds: ['1-T1'], actionId: 'local', branch: 'codex/fixture', baseSha: 'a'.repeat(40), paths: ['a.ts'], operation: 'edit' } }
}

test('consolidated local admission binds actual approval, immutable manifest, task files and dependencies', () => {
  const fixture = consolidatedFixture()
  expect(evaluateConsolidatedApproval(fixture).ok).toBe(true)
  for (const patch of [{ issue: 2 }, { issue: 3 }, { taskIds: ['1-T2'] }, { paths: ['private.txt'] }, { branch: 'main' }, { operation: 'publish' }, { actionId: 'unknown' }]) {
    expect(evaluateConsolidatedApproval({ ...fixture, requested: { ...fixture.requested, ...patch } }).ok).toBe(false)
  }
  expect(evaluateConsolidatedApproval({ ...fixture, manifestBytes: fixture.manifestBytes + ' ' }).ok).toBe(false)
  fixture.currentDependencies[0]!.blockedBy.push({ number: 4, state: 'open' })
  expect(evaluateConsolidatedApproval(fixture).ok).toBe(false)
})

test('changed quotation, artifact identities or absent history cannot pass a frozen binding', () => {
  for (const mutate of [
    (x: any) => { x.record.source.quote = 'Changed quotation' },
    (x: any) => { x.currentArtifacts.approvalComments[0].body += '\nChanged record' },
    (x: any) => { x.currentArtifacts.artifacts[1].artifact = { ...livePlan, node_id: 'wrong-plan' } },
    (x: any) => { x.currentArtifacts.approvalComments = [] },
  ]) {
    const fixture = consolidatedFixture()
    mutate(fixture)
    expect(evaluateConsolidatedApproval(fixture).ok).toBe(false)
  }
})


const protocolBody = '<!-- custom-protocol issue=2 rev=1 -->\nUp to48 vendor processes. Ten minutes per qualification process. at most four vendor processes per changed authored skill; maximum11 skills/44 processes. Reserve24 additional processes. Overall maximum116 processes and20 hours.\n'
function researchFixture() {
  const fixture: any = consolidatedFixture()
  const protocol = { node_id: 'protocol-2', id: 20, body: protocolBody }
  const researchBrief = { node_id: 'brief-2', number: 2, body: '<!-- vsk:v1 type=brief rev=1 scope=research -->\nQualify.\n' }
  const researchItem = { repo: 'acme/app', issue: 2, mode: 'research', artifacts: [{ repo: 'acme/app', issue: 2, kind: 'brief', artifactId: 'brief-2', rev: 1, digest: scopeDigest(researchBrief.body, 'brief') }, { repo: 'acme/app', issue: 2, kind: 'protocol', artifactId: protocol.node_id, rev: 1, digest: scopeDigest(protocol.body, 'protocol') }], taskIds: [], actionIds: ['research'] }
  const action = { id: 'research', kind: 'research-tests', issue: 2, protocolArtifactId: 'protocol-2', protocolDigest: scopeDigest(protocol.body, 'protocol'), candidateRule: { kind: 'approved-parent-candidate', repo: 'acme/app', parentBranch: 'codex/fixture', baseSha: 'a'.repeat(40) }, scenarioIds: ['SKILL-EVAL', 'H1', 'REQUALIFY'], maxStarts: 116, aggregateActiveMs: 72000000, providerMode: 'subscription-only' }
  const manifest = JSON.parse(fixture.manifestBytes)
  fixture.record.items[0].actionIds.push('research')
  fixture.record.items[0].artifacts[1].digest = scopeDigest(plan.replace('a.ts', 'skills/dev/example/SKILL.md'), 'plan')
  fixture.currentArtifacts.artifacts[1].artifact = { ...livePlan, body: plan.replace('a.ts', 'skills/dev/example/SKILL.md') }
  manifest.selections = [...fixture.record.items, researchItem]; manifest.candidateProtocols = [2]; manifest.excludedIssues = []; manifest.actionBounds.research = action
  fixture.manifestBytes = JSON.stringify(manifest)
  fixture.record.manifest = { sha256: Bun.SHA256.hash(fixture.manifestBytes, 'hex'), source: { kind: 'inline', utf8: fixture.manifestBytes } }
  fixture.record.items.push(researchItem)
  fixture.record.actions.push({ ...action, candidateRule: { ...action.candidateRule, manifestSha256: fixture.record.manifest.sha256 } })
  refreshRecord(fixture)
  fixture.currentArtifacts.artifacts.push({ repo: 'acme/app', issue: 2, kind: 'brief', artifact: researchBrief }, { repo: 'acme/app', issue: 2, kind: 'protocol', artifact: protocol })
  const evidence = { schemaVersion: 1, kind: 'research-reservation', approvalId: fixture.record.id, manifestSha256: fixture.record.manifest.sha256, actionId: 'research', owner: { repo: 'acme/app', issue: 1, taskIds: ['1-T1'], artifact: fixture.record.items[0].artifacts[1], skill: 'skills/dev/example' }, protocol: researchItem.artifacts[1], scenarioId: 'SKILL-EVAL', candidate: { repo: 'acme/app', parentBranch: 'codex/fixture', baseSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), acceptedIntegrations: [], packedArtifacts: [{ name: 'cli', sha256: 'd'.repeat(64), integrity: 'sha512-YWJj' }, { name: 'dashboard', sha256: 'e'.repeat(64), integrity: 'sha512-YWJj' }] }, execution: { harness: 'codex', version: 'fixture', model: 'same', accountRef: 'subscription:fixture', effort: 'high', platform: 'fixture', runtime: 'node24', configDigest: 'f'.repeat(64), policyDigest: 'a'.repeat(64), providerMode: 'subscription-only' }, allowance: { id: 'shared', reservationId: 'reserved-1', attemptId: 'attempt-1', phase: 'SKILL-EVAL', ledgerRevision: 1, status: 'reserved', totalStarts: 1, phaseStarts: 1, phaseMaxStarts: 44, activeMs: 0, reservedActiveMs: 600000, trialMaxMs: 600000, skillStarts: 1, skillMaxStarts: 4, skillCount: 1, maxSkills: 11, attempts: [{ id: 'attempt-1', phase: 'SKILL-EVAL', skill: 'skills/dev/example', kind: 'initial', status: 'reserved', activeMs: 0, reservedActiveMs: 600000 }] } }
  const source = evidenceComment(evidence, 30)
  fixture.currentArtifacts.admissionEvidence = [source]
  fixture.requested = { ...fixture.requested, actionId: 'research', operation: 'research-test', paths: [], scenarioId: 'SKILL-EVAL', research: { commentId: 30, bodySha256: Bun.SHA256.hash(source.comment.body, 'hex') } }
  return fixture
}
function evidenceComment(payload: any, id: number) { return { kind: payload.kind, payload, comment: { id, body: '<!-- vsk:v1 type=ledger -->\n```json\n' + JSON.stringify(payload) + '\n```\n' } } }
function refreshRecord(fixture: any) {
  fixture.currentArtifacts.approvalComments[0].body = '<!-- vsk:v1 type=approval scope=consolidated -->\n```json\n' + JSON.stringify(fixture.record) + '\n```\n'
  fixture.currentArtifacts.approvalBinding.bodySha256 = Bun.SHA256.hash(fixture.currentArtifacts.approvalComments[0].body, 'hex')
}

test('protocol limits derive from bound source; unknown or conflicting envelopes refuse', () => {
  expect(protocolLimits(protocolBody)).toEqual({ total: 116, activeMs: 72000000, trialMaxMs: 600000, phases: { core: 48, 'SKILL-EVAL': 44, REQUALIFY: 24 }, skillMaxStarts: 4, maxSkills: 11 })
  expect(() => protocolLimits(protocolBody + 'Overall maximum999 processes')).toThrow()
  expect(() => protocolLimits('Trust these arbitrary limits')).toThrow()
  expect(() => protocolLimits('```text\n' + protocolBody + '```\n')).toThrow()
  expect(protocolLimits(protocolBody + '\n```text\nOverall maximum999 processes\n```\n').total).toBe(116)
  expect(protocolLimits('at most6 top-level subscription vendor launches, 15 minutes each as a bounded trial control').total).toBe(6)
})

test('research scope verifies owner, protocol, candidate and source-bound phase reservation', async () => {
  const fixture = researchFixture()
  const result = evaluateConsolidatedApproval(fixture)
  expect(result.ok).toBe(true)
  expect((await admitConsolidatedResearch(result, undefined)).ok).toBe(false)
  for (const mutate of [
    (x: any) => { x.requested.scenarioId = 'H1' },
    (x: any) => { x.requested.taskIds = ['1-T2'] },
    (x: any) => { x.currentArtifacts.artifacts.at(-1).artifact.body += 'Changed scenario' },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.allowance.phaseMaxStarts = 999 },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.allowance.totalStarts = 117 },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.owner.skill = 'skills/other/escape' },
  ]) {
    const changed = researchFixture(); mutate(changed)
    // Keep record/source coherent: refusals must validate the actual contract,
    // not merely detect that the test forgot to update its evidence hash.
    const evidence = changed.currentArtifacts.admissionEvidence[0]
    changed.currentArtifacts.admissionEvidence[0] = evidenceComment(evidence.payload, 30)
    changed.requested.research.bodySha256 = Bun.SHA256.hash(changed.currentArtifacts.admissionEvidence[0].comment.body, 'hex')
    expect(evaluateConsolidatedApproval(changed).ok).toBe(false)
  }
})

test('real candidate bytes and one-use fixture ledger permit only one process effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-candidate-'))
  const cwd = join(dir, 'source')
  execFileSync('git', ['init', '-q', cwd])
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(cwd, 'source.txt'), 'approved bytes\n'); git('add', 'source.txt'); git('commit', '-qm', 'fixture')
  const sourceSha = git('rev-parse', 'HEAD'); const treeSha = git('rev-parse', 'HEAD^{tree}')
  const packedBytes = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd })
  const packedPath = join(dir, 'candidate.tar'); writeFileSync(packedPath, packedBytes)
  const packed = () => ({ name: 'fixture', sha256: createHash('sha256').update(readFileSync(packedPath)).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(readFileSync(packedPath)).digest('base64') })
  const fixture = researchFixture()
  const manifest = JSON.parse(fixture.manifestBytes); manifest.parent.baseSha = sourceSha; manifest.actionBounds.research.candidateRule.baseSha = sourceSha
  fixture.manifestBytes = JSON.stringify(manifest); fixture.record.manifest = { sha256: Bun.SHA256.hash(fixture.manifestBytes, 'hex'), source: { kind: 'inline', utf8: fixture.manifestBytes } }
  fixture.record.actions[1].candidateRule = { ...fixture.record.actions[1].candidateRule, baseSha: sourceSha, manifestSha256: fixture.record.manifest.sha256 }
  fixture.requested.baseSha = sourceSha
  const payload = fixture.currentArtifacts.admissionEvidence[0].payload
  payload.manifestSha256 = fixture.record.manifest.sha256
  payload.candidate = { ...payload.candidate, baseSha: sourceSha, sourceSha, treeSha, packedArtifacts: [packed()] }
  fixture.currentArtifacts.admissionEvidence[0] = evidenceComment(payload, 30)
  fixture.requested.research.bodySha256 = Bun.SHA256.hash(fixture.currentArtifacts.admissionEvidence[0].comment.body, 'hex')
  refreshRecord(fixture)
  const scope: any = evaluateConsolidatedApproval(fixture)
  expect(scope.ok).toBe(true)
  const ledger = join(dir, 'fixture-ledger.json'); writeFileSync(ledger, JSON.stringify({ revision: 1, status: 'reserved' }))
  const adapter = { inspectCandidate: async (candidate: any) => ({ candidate: { ...candidate, sourceSha: git('rev-parse', 'HEAD'), treeSha: git('rev-parse', 'HEAD^{tree}'), packedArtifacts: [packed()] }, clean: git('status', '--porcelain') === '', ancestorShas: git('rev-list', 'HEAD').split('\n') }), consumeReservation: async (request: any) => {
    const lock = openSync(ledger + '.lock', 'wx')
    try {
      const current = JSON.parse(readFileSync(ledger, 'utf8'))
      if (current.revision !== request.ledgerRevision || current.status !== 'reserved') throw new Error('reservation already consumed')
      writeFileSync(ledger, JSON.stringify({ revision: current.revision + 1, status: 'consumed' }))
      return { reservationId: request.reservationId, attemptId: request.attemptId, previousRevision: current.revision, revision: current.revision + 1, state: 'consumed', candidateSha: request.candidate.sourceSha, execution: request.execution }
    } finally { closeSync(lock); unlinkSync(ledger + '.lock') }
  } }
  const results = await Promise.all([admitConsolidatedResearch(scope, adapter), admitConsolidatedResearch(scope, adapter)])
  for (const result of results) if (result.ok) execFileSync('node', ['-e', 'require("node:fs").appendFileSync(process.argv[1], "one start\\n")', join(dir, 'effects')])
  expect(readFileSync(join(dir, 'effects'), 'utf8')).toBe('one start\n')
  writeFileSync(packedPath, 'tampered archive')
  expect((await admitConsolidatedResearch(scope, adapter)).blocks.join(' ')).toContain('packed bytes differ')
})

test('consolidated reader fetches every page and immutable blob bytes instead of trusting a local locator', async () => {
  const fixture: any = consolidatedFixture()
  fixture.record.manifest.source = { kind: 'git-blob', repositoryId: '123', commitSha: 'f'.repeat(40), path: 'scope.json', blobSha256: fixture.record.manifest.sha256 }
  refreshRecord(fixture)
  const readJson = async (args: string[]) => {
    if (args[1] === 'repos/acme/app/issues/10/comments') return [[], fixture.currentArtifacts.approvalComments]
    if (args[1] === 'repositories/123') return { id: 123, full_name: 'acme/app' }
    if (args[1]?.includes('/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(fixture.manifestBytes).toString('base64') }
    if (args[1] === 'repos/acme/app/issues/1') return { ...brief, state: 'open' }
    if (args[1] === 'repos/acme/app/issues/1/comments') return [[], [livePlan]]
    if (args[1]?.endsWith('/blocked_by')) return [[]]
    throw new Error('unexpected read')
  }
  const input = { parentRepo: 'acme/app', parentIssue: 10, approvalBinding: fixture.currentArtifacts.approvalBinding, requested: fixture.requested, operators: ['ada'], readJson }
  expect((await gatherConsolidatedApproval(input)).ok).toBe(true)
  const revoked = { ...record(), id: 'revoke-parent', scope: 'brief', artifacts: [], revokes: [fixture.record.id] }
  const revocation = { id: 99, body: '<!-- vsk:v1 type=approval scope=brief -->\n```json\n' + JSON.stringify(revoked) + '\n```\n' }
  expect((await gatherConsolidatedApproval({ ...input, readJson: async args => args[1] === 'repos/acme/app/issues/10/comments' ? [fixture.currentArtifacts.approvalComments, [revocation]] : readJson(args) })).ok).toBe(false)
  await expect(gatherConsolidatedApproval({ ...input, readJson: async args => args[1]?.includes('/contents/') ? { type: 'file', encoding: 'base64', content: Buffer.from('altered').toString('base64') } : readJson(args) })).rejects.toThrow()
})


function preparationFixture() {
  const fixture: any = consolidatedFixture()
  const prerequisitePlan = { ...artifact, issue: 4, artifactId: 'plan-4', digest: scopeDigest(plan.replaceAll('1-T1', '4-T1'), 'plan') }
  const prerequisiteBrief = { ...artifact, kind: 'brief', issue: 4, artifactId: 'brief-4', digest: scopeDigest(brief.body, 'brief') }
  const prerequisite = { repo: 'acme/app', issue: 4, mode: 'code', artifacts: [prerequisiteBrief, prerequisitePlan], taskIds: ['4-T1'], actionIds: ['local'] }
  fixture.record.items[0].mode = 'preparation'
  fixture.record.items.push(prerequisite)
  const manifest = JSON.parse(fixture.manifestBytes); manifest.codeIssues = [4]; manifest.preparationTaskIds = ['1-T1']; manifest.selections = fixture.record.items
  fixture.manifestBytes = JSON.stringify(manifest); fixture.record.manifest = { sha256: Bun.SHA256.hash(fixture.manifestBytes, 'hex'), source: { kind: 'inline', utf8: fixture.manifestBytes } }; refreshRecord(fixture)
  fixture.currentArtifacts.artifacts.push({ repo: 'acme/app', issue: 4, kind: 'brief', artifact: { ...brief, node_id: 'brief-4', number: 4 } }, { repo: 'acme/app', issue: 4, kind: 'plan', artifact: { ...livePlan, node_id: 'plan-4', body: plan.replaceAll('1-T1', '4-T1') } })
  fixture.currentDependencies[0].blockedBy = [{ number: 5, state: 'open' }]
  const accepted = { kind: 'accepted-contract', repo: 'acme/app', issue: 4, plan: prerequisitePlan, childHead: 'b'.repeat(40), parentHead: 'c'.repeat(40), acceptance: 'implemented' }
  const receipt = evidenceComment(accepted, 31)
  const preparation = { schemaVersion: 1, kind: 'preparation', parent: manifest.parent, plan: fixture.record.items[0].artifacts[1], tasks: [{ id: '1-T1', files: ['a.ts'], prerequisiteIssues: [4] }], acceptedContracts: [{ ...accepted, evidence: { commentId: 31, bodySha256: Bun.SHA256.hash(receipt.comment.body, 'hex') } }] }
  delete (preparation.acceptedContracts[0] as any).kind
  const evidence = evidenceComment(preparation, 30)
  fixture.currentArtifacts.admissionEvidence = [evidence, receipt]
  fixture.requested.preparation = { commentId: 30, bodySha256: Bun.SHA256.hash(evidence.comment.body, 'hex') }
  return { fixture, preparation, manifest }
}

test('preparation admits only exact selected task/files with fetched accepted-code receipts', async () => {
  const { fixture, preparation, manifest } = preparationFixture()
  const scope = evaluateConsolidatedApproval(fixture)
  expect(scope.ok).toBe(true)
  expect((await admitConsolidatedPreparation(scope, undefined)).ok).toBe(false)
  const adapter = { readTaskPrerequisites: async () => ({ parent: preparation.parent, plan: preparation.plan, tasks: preparation.tasks }), inspectAcceptedIntegration: async (contract: any) => ({ contract, reviewedHead: contract.childHead, acceptedTaskIds: ['4-T1'], ancestorShas: [contract.parentHead, contract.childHead, manifest.parent.baseSha] }) }
  expect((await admitConsolidatedPreparation(scope, adapter)).ok).toBe(true)
  expect((await admitConsolidatedPreparation(scope, { ...adapter, readTaskPrerequisites: async () => ({ parent: preparation.parent, plan: preparation.plan, tasks: [{ ...preparation.tasks[0], prerequisiteIssues: [4, 6] }] }) })).ok).toBe(false)
  expect(evaluateConsolidatedApproval({ ...fixture, requested: { ...fixture.requested, taskIds: ['1-T1', '1-T2'] } }).ok).toBe(false)
  expect(evaluateConsolidatedApproval({ ...fixture, requested: { ...fixture.requested, operation: 'publish' } }).ok).toBe(false)
  const gathered = await gatherConsolidatedApproval({ parentRepo: 'acme/app', parentIssue: 10, approvalBinding: fixture.currentArtifacts.approvalBinding, requested: fixture.requested, operators: ['ada'], admissionEvidence: fixture.currentArtifacts.admissionEvidence, readJson: async (args: string[]) => {
    const path = args[1]
    if (path === 'repos/acme/app/issues/10/comments') return [fixture.currentArtifacts.approvalComments]
    if (path?.includes('/issues/comments/')) return { ...fixture.currentArtifacts.admissionEvidence.find((entry: any) => path.endsWith('/' + entry.comment.id)).comment, user: { login: 'mallory' } }
    if (path?.endsWith('/blocked_by')) return [[{ number: 5, state: 'open' }]]
    const issue = Number(path?.split('/')[4])
    if (path?.endsWith('/comments')) return [[fixture.currentArtifacts.artifacts.find((entry: any) => entry.issue === issue && entry.kind === 'plan').artifact]]
    return { ...fixture.currentArtifacts.artifacts.find((entry: any) => entry.issue === issue && entry.kind === 'brief').artifact, state: 'open' }
  } })
  expect(gathered.ok).toBe(false)
  expect(gathered.blocks.join(' ')).toContain('adapter unavailable')
  fixture.currentArtifacts.admissionEvidence.pop()
  expect(evaluateConsolidatedApproval(fixture).ok).toBe(false)
})

test('correction operator, target self-reference and exact source quotation are enforced', () => {
  const broken = { id: 8, body: '<!-- vsk:v1 type=approval -->' }
  const correction = { schemaVersion: 2, kind: 'correction', scope: 'none', operator: 'mallory', source: record().source, targets: [{ commentId: 8, bodySha256: Bun.SHA256.hash(broken.body, 'hex') }], supersedes: [], revokes: [] }
  const source = { id: 9, body: '<!-- vsk:v1 type=approval scope=none -->\n```json\n' + JSON.stringify(correction) + '\n```\n' }
  expect(evaluate([broken, source, grant()]).ok).toBe(false)
  expect(parseApproval({ ...source, id: 8 })).toHaveProperty('ok', false)
  const approval = parseApproval(grant()); approval.source = { kind: 'github-comment', ref: 'https://github.com/acme/app/issues/1#issuecomment-9', quote: 'I approve.' }
  const quoted = { id: 3, body: '<!-- vsk:v1 type=approval scope=brief+plan -->\n```json\n' + JSON.stringify(approval) + '\n```\n' }
  const external = { id: 9, html_url: approval.source.ref, user: { login: 'ada' }, body: 'I approve.' }
  expect(evaluate([quoted], { sourceComments: [external] }).ok).toBe(true)
  expect(evaluate([quoted], { sourceComments: [{ ...external, body: 'I revoke.' }] }).ok).toBe(false)
})


test('preparation may use only its selected SKILL-EVAL phase and still needs both adapters', async () => {
  const { fixture, preparation, manifest } = preparationFixture()
  const research = researchFixture()
  fixture.record.items[0].artifacts[1] = research.record.items[0].artifacts[1]
  fixture.currentArtifacts.artifacts[1] = research.currentArtifacts.artifacts[1]
  fixture.record.items[0].actionIds.push('research')
  fixture.record.items.push(research.record.items[1]); fixture.record.actions.push(research.record.actions[1])
  fixture.currentArtifacts.artifacts.push(...research.currentArtifacts.artifacts.slice(2))
  manifest.selections = fixture.record.items; manifest.candidateProtocols = [2]; manifest.excludedIssues = []
  manifest.actionBounds.research = JSON.parse(research.manifestBytes).actionBounds.research
  fixture.manifestBytes = JSON.stringify(manifest); fixture.record.manifest = { sha256: Bun.SHA256.hash(fixture.manifestBytes, 'hex'), source: { kind: 'inline', utf8: fixture.manifestBytes } }
  fixture.record.actions[1].candidateRule.manifestSha256 = fixture.record.manifest.sha256
  preparation.plan = fixture.record.items[0].artifacts[1]; preparation.tasks[0]!.files = ['skills/dev/example/SKILL.md']
  const prepEvidence = evidenceComment(preparation, 30); fixture.currentArtifacts.admissionEvidence[0] = prepEvidence
  const trial = research.currentArtifacts.admissionEvidence[0].payload; trial.manifestSha256 = fixture.record.manifest.sha256
  const trialEvidence = evidenceComment(trial, 32); fixture.currentArtifacts.admissionEvidence.push(trialEvidence)
  fixture.requested = { ...research.requested, preparation: { commentId: 30, bodySha256: Bun.SHA256.hash(prepEvidence.comment.body, 'hex') }, research: { commentId: 32, bodySha256: Bun.SHA256.hash(trialEvidence.comment.body, 'hex') } }
  refreshRecord(fixture)
  const result = evaluateConsolidatedApproval(fixture)
  expect(result.ok).toBe(true)
  expect((await admitConsolidatedPreparation(result, undefined)).ok).toBe(false)
  expect((await admitConsolidatedResearch(result, undefined)).ok).toBe(false)
  expect(evaluateConsolidatedApproval({ ...fixture, requested: { ...fixture.requested, scenarioId: 'H1' } }).ok).toBe(false)
})


const checkpointEnvelope = () => ({ schemaVersion: 1, kind: 'skill-eval-checkpoints', phase: 'SKILL-EVAL', maxStarts: 44, initialStartsPerCheckpoint: 4, repeatAndSplitStarts: 36, maxProcessMs: 600000, maxConcurrentProcesses: 3, overallMaxStarts: 116, overallActiveMs: 72000000, coreMaxStarts: 48, requalifyMaxStarts: 24, caseKinds: ['positive', 'negative'], arms: ['claude-baseline', 'claude-current', 'codex-baseline', 'codex-current'], checkpoints: [{ id: 'E1', codeOwners: [1], preparationTasks: [], skills: ['example'], after: [] }, { id: 'E2', codeOwners: [1], preparationTasks: [], skills: ['example'], after: ['E1'] }], caseBindings: [{ checkpoint: 'E1', skill: 'example', owners: [{ issue: 1, taskIds: ['1-T1'] }] }, { checkpoint: 'E2', skill: 'example', owners: [{ issue: 1, taskIds: ['1-T1'] }] }], ownerAssertions: { '1': { positive: 'Bind current scope.', negative: 'Refuse stale intent.' } }, maxSkills: 11 })
const checkpointProtocol = (value = checkpointEnvelope()) => '<!-- custom-protocol issue=2 rev=2 -->\n```vsk-research\n' + JSON.stringify(value) + '\n```\n'

test('closed checkpoint envelope permits repeated skill revisions without a fresh per-skill allowance', () => {
  const limits = protocolLimits(checkpointProtocol())
  expect(limits.phases['SKILL-EVAL']).toBe(44)
  expect(limits.skillMaxStarts).toBeNull()
  expect(limits.checkpointEnvelope.checkpoints.map((entry: any) => entry.id)).toEqual(['E1', 'E2'])
  for (const mutate of [
    (x: any) => { x.unknown = true },
    (x: any) => { x.repeatAndSplitStarts = 37 },
    (x: any) => { x.checkpoints[1].after = ['unknown'] },
    (x: any) => { x.caseBindings.pop() },
    (x: any) => { x.ownerAssertions['1'].unknown = 'do more' },
  ]) { const data=checkpointEnvelope(); mutate(data); expect(() => protocolLimits(checkpointProtocol(data))).toThrow() }
  expect(() => protocolLimits(checkpointProtocol() + checkpointProtocol())).toThrow()
  expect(() => protocolLimits('````md\n' + checkpointProtocol() + '\n````')).toThrow()
})

test('immutable git-blob node IDs resolve through GraphQL and retain REST identity checks', async () => {
  const fixture: any = consolidatedFixture()
  fixture.record.manifest.source = { kind: 'git-blob', repositoryId: 'repo-node', commitSha: 'f'.repeat(40), path: 'scope.json', blobSha256: fixture.record.manifest.sha256 }
  refreshRecord(fixture)
  const readJson = async (args: string[]): Promise<any> => {
    if (args[1] === 'repos/acme/app/issues/10/comments') return [fixture.currentArtifacts.approvalComments]
    if (args[1] === 'graphql') return { data: { node: { __typename: 'Repository', id: 'repo-node', databaseId: 123, nameWithOwner: 'acme/app' } } }
    if (args[1] === 'repositories/123') return { id: 123, node_id: 'repo-node', full_name: 'acme/app' }
    if (args[1]?.includes('/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(fixture.manifestBytes).toString('base64') }
    if (args[1] === 'repos/acme/app/issues/1') return { ...brief, state: 'open' }
    if (args[1] === 'repos/acme/app/issues/1/comments') return [[livePlan]]
    if (args[1]?.endsWith('/blocked_by')) return [[]]
    throw new Error('HTTP 404 for unsupported endpoint')
  }
  const input = { parentRepo: 'acme/app', parentIssue: 10, approvalBinding: fixture.currentArtifacts.approvalBinding, requested: fixture.requested, operators: ['ada'], readJson }
  expect((await gatherConsolidatedApproval(input)).ok).toBe(true)
  await expect(gatherConsolidatedApproval({ ...input, readJson: async args => args[1] === 'repositories/123' ? { id: 123, node_id: 'wrong-node', full_name: 'acme/app' } : readJson(args) })).rejects.toThrow()
})


function pooledFixture() {
  const fixture: any = researchFixture()
  const protocol = fixture.currentArtifacts.artifacts.find((entry: any) => entry.kind === 'protocol').artifact
  protocol.body = checkpointProtocol()
  const ref = fixture.record.items[1].artifacts[1]; ref.rev = 2; ref.digest = scopeDigest(protocol.body, 'protocol')
  const manifest = JSON.parse(fixture.manifestBytes); manifest.selections = fixture.record.items; manifest.actionBounds.research.protocolDigest = ref.digest
  fixture.manifestBytes = JSON.stringify(manifest); fixture.record.manifest = { sha256: Bun.SHA256.hash(fixture.manifestBytes, 'hex'), source: { kind: 'inline', utf8: fixture.manifestBytes } }
  fixture.record.actions[1].protocolDigest = ref.digest; fixture.record.actions[1].candidateRule.manifestSha256 = fixture.record.manifest.sha256
  const evidence = fixture.currentArtifacts.admissionEvidence[0].payload
  evidence.manifestSha256 = fixture.record.manifest.sha256; evidence.protocol = ref; evidence.owner.skill = null
  const checks = evidenceComment({ kind: 'checkpoint-source', issue: 1, taskIds: ['1-T1'], artifact: fixture.record.items[0].artifacts[1], sourceSha: evidence.candidate.sourceSha, checks: [{ command: 'bun test', resultSha256: 'a'.repeat(64), exitCode: 0 }] }, 31)
  fixture.currentArtifacts.admissionEvidence.push(checks)
  const envelope = checkpointEnvelope()
  evidence.suite = { checkpointId: 'E1', arm: 'codex-current', cases: envelope.caseKinds.map(kind => ({ id: 'E1.example.' + kind, skill: 'example', kind, owners: [{ issue: 1, taskIds: ['1-T1'] }], fixtureSha256: 'a'.repeat(64), promptSha256: 'b'.repeat(64), priorSourceSha256: 'c'.repeat(64), currentSourceSha256: 'd'.repeat(64), assertions: [{ id: 'owner-1-' + kind, issue: 1, contractSha256: Bun.SHA256.hash(envelope.ownerAssertions['1'][kind as 'positive' | 'negative'], 'hex') }] })), contributors: [{ issue: 1, taskIds: ['1-T1'], artifact: fixture.record.items[0].artifacts[1], sourceSha: evidence.candidate.sourceSha, checks: { commentId: 31, bodySha256: Bun.SHA256.hash(checks.comment.body, 'hex') } }], acceptedCheckpoints: [], interveningAcceptance: [], livePrerequisiteEvidence: null }
  evidence.allowance.skillMaxStarts = null; evidence.allowance.skillStarts = 0
  const attempt = evidence.allowance.attempts[0]
  Object.assign(attempt, { skill: null, checkpointId: 'E1', arm: 'codex-current', purpose: 'initial', caseIds: evidence.suite.cases.map((entry: any) => entry.id), sourceSha: evidence.candidate.sourceSha, suiteSha256: checkpointSuiteDigest(evidence.suite), executionSha256: checkpointSuiteDigest(evidence.execution), caseDigests: evidence.suite.cases.map((entry: any) => ({ id: entry.id, sha256: checkpointSuiteDigest(entry) })) })
  refreshRecord(fixture); sealPooledFixture(fixture)
  return fixture
}
function sealPooledFixture(fixture: any) {
  const evidence = fixture.currentArtifacts.admissionEvidence[0].payload
  const current = evidence.allowance.attempts.find((entry: any) => entry.id === evidence.allowance.attemptId)
  current.suiteSha256 = checkpointSuiteDigest(evidence.suite)
  current.caseIds = evidence.suite.cases.map((entry: any) => entry.id)
  current.caseDigests = evidence.suite.cases.map((entry: any) => ({ id: entry.id, sha256: checkpointSuiteDigest(entry) }))
  fixture.currentArtifacts.admissionEvidence[0] = evidenceComment(evidence, 30)
  fixture.requested.research.bodySha256 = Bun.SHA256.hash(fixture.currentArtifacts.admissionEvidence[0].comment.body, 'hex')
}

test('pooled checkpoint scope binds every case/owner/source and refuses an absent actual adapter', async () => {
  const fixture = pooledFixture(); const result = evaluateConsolidatedApproval(fixture)
  expect(result.ok).toBe(true)
  expect((await admitConsolidatedResearch(result, undefined)).ok).toBe(false)
  for (const mutate of [
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.suite.cases.pop() },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.suite.contributors = [] },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.suite.cases[0].owners[0].taskIds = ['1-T2'] },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.suite.cases[0].assertions[0].contractSha256 = 'f'.repeat(64) },
    (x: any) => { x.currentDependencies[0].blockedBy = [{ state: 'open', number: 7 }] },
    (x: any) => { x.currentArtifacts.admissionEvidence[0].payload.suite.arm = 'claude-current' },
  ]) { const changed=pooledFixture(); mutate(changed); sealPooledFixture(changed); expect(evaluateConsolidatedApproval(changed).ok).toBe(false) }
})

test('pooled failures, children and resumes count cumulatively without per-skill refunds', () => {
  const fixture = pooledFixture(); const evidence = fixture.currentArtifacts.admissionEvidence[0].payload
  const current = evidence.allowance.attempts[0]
  for (let n=0; n<5; n++) evidence.allowance.attempts.push({ ...structuredClone(current), id: 'failed-' + n, kind: n % 2 ? 'child' : 'resume', purpose: 'repeat', status: 'failed', activeMs: 1000, reservedActiveMs: 0 })
  evidence.allowance.totalStarts = 6; evidence.allowance.phaseStarts = 6; evidence.allowance.activeMs = 5000
  sealPooledFixture(fixture)
  expect(evaluateConsolidatedApproval(fixture).ok).toBe(true)
  evidence.allowance.attempts[1].caseDigests[0].sha256 = 'f'.repeat(64)
  sealPooledFixture(fixture)
  expect(evaluateConsolidatedApproval(fixture).ok).toBe(false)
  evidence.allowance.attempts[1].caseDigests = structuredClone(current.caseDigests)
  for(let n=5; n<37; n++) evidence.allowance.attempts.push({ ...structuredClone(current), id: 'failed-' + n, purpose: 'repeat', status: 'failed', activeMs: 0, reservedActiveMs: 0 })
  evidence.allowance.totalStarts = 38; evidence.allowance.phaseStarts = 38
  sealPooledFixture(fixture)
  expect(evaluateConsolidatedApproval(fixture).ok).toBe(false)
})

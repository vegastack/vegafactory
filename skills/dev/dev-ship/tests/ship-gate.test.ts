import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { evaluateParentDelivery, typedSection, validReview, chronicleEntryAdded, evaluateShipGate, gatherFacts, parseMarker, resolveWorktree, reviewAdjudicated, selectCurrentTrustedReview } from '../scripts/ship-gate.mjs'

const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const SCOPE = 'c'.repeat(64)
const binding = () => ({ sha: SHA, baseSha: BASE, scopeDigest: SCOPE, verdict: 'clean', findings: [] as {id: string, status: string}[] })
const reviewBody = (review = binding(), marker = { sha: review.sha, verdict: review.verdict }) => `<!-- vsk:v1 type=review round=1 sha=${marker.sha} agent=codex verdict=${marker.verdict} -->\n\`\`\`json\n${JSON.stringify({ reviewBinding: review })}\n\`\`\``
const evidenceBody = (sha = SHA) => `<!-- vsk:v1 type=evidence rev=1 branch=feat/12-x sha=${sha} -->
## Result (v1)
**Done:** thing
**Tests:** bun test → green
**Review:** subagent — clean
**Changelog:** changeset added
**Docs:** brief v1, plan v1 — in sync
**Not done / limits:** none
Branch: feat/12-x @ ${sha}`

const cleanFacts = () => ({
  evidence: { body: evidenceBody(), updatedAt: '2026-08-29T10:00:00Z' },
  reviewVerdict: 'clean',
  adjudicated: false,
  headSha: SHA, baseSha: BASE, scopeDigest: SCOPE, review: binding(), cleanBefore: true, cleanAfter: true,
  headCommittedAt: '2026-08-29T09:00:00Z',
  diffText: 'diff --git a/.changeset/x.md b/.changeset/x.md\n+content',
  changelogTouched: true,
  allowNoChangelog: undefined,
  checkExit: 0,
  checkoutMismatch: null,
})

describe('ship-gate', () => {
  test('clean facts pass', () => {
    expect(evaluateShipGate(cleanFacts()).blocks).toEqual([])
  })
  test('no evidence comment blocks immediately', () => {
    const r = evaluateShipGate({ ...cleanFacts(), evidence: null })
    expect(r.blocks[0]).toContain('no evidence comment')
  })
  test('moved head blocks until the evidence sha itself is updated — a mere comment edit is not reconciliation', () => {
    const moved = { ...cleanFacts(), headSha: 'f'.repeat(40), headCommittedAt: '2026-08-29T12:00:00Z' }
    expect(evaluateShipGate(moved).blocks.some((b) => b.includes('moved past evidence sha'))).toBe(true)
    const editedButStale = { ...moved, evidence: { body: evidenceBody(), updatedAt: '2026-08-29T13:00:00Z' } }
    expect(evaluateShipGate(editedButStale).blocks.some((b) => b.includes('moved past evidence sha'))).toBe(true)
    const reconciled = { ...moved, evidence: { body: evidenceBody('f'.repeat(40)), updatedAt: '2026-08-29T13:00:00Z' } }
    expect(evaluateShipGate({ ...reconciled, review: { ...binding(), sha: 'f'.repeat(40) } }).blocks).toEqual([])
  })
  test('missing or invalid evidence sha blocks (never falls open on startsWith(""))', () => {
    const noSha = { ...cleanFacts(), evidence: { body: evidenceBody().replace(' sha=' + SHA, ''), updatedAt: '2026-08-29T10:00:00Z' } }
    expect(evaluateShipGate(noSha).blocks.some((b) => b.includes('no valid sha='))).toBe(true)
    const shortSha = { ...cleanFacts(), evidence: { body: evidenceBody().replace('sha=' + SHA, 'sha=f'), updatedAt: '2026-08-29T10:00:00Z' } }
    expect(evaluateShipGate(shortSha).blocks.some((b) => b.includes('no valid sha='))).toBe(true)
  })
  test('a checkout that is not the branch under review blocks the fresh-check claim', () => {
    const r = evaluateShipGate({ ...cleanFacts(), checkoutMismatch: 'the current checkout (1111111) is not the branch under review' })
    expect(r.blocks.some((b) => b.includes('not the branch under review'))).toBe(true)
  })
  test('the chronicle-entry rule is an ADDED heading, not any touch', () => {
    const headingRule = chronicleEntryAdded
    expect(headingRule('+## 29-08-2026 — a new entry (#16)\n+**What:** …')).toBe(true)
    expect(headingRule('-## 28-08-2026 — deleted entry\n')).toBe(false)
    expect(headingRule('-**Why:** old\n+**Why:** typo-fixed old entry\n')).toBe(false)
    expect(headingRule('+++ b/.vegastack/chronicle.md\n@@\n context only')).toBe(false)
  })
  test('an exercised excuse warns with what it excused', () => {
    const r = evaluateShipGate({ ...cleanFacts(), changelogTouched: false, chronicleOn: true, chronicleTouched: false, allowNoChangelog: 'docs-only' })
    expect(r.blocks).toEqual([])
    expect(r.warns.some((w) => w.includes('changelog + chronicle'))).toBe(true)
  })
  test('chronicle: on blocks a diff without a chronicle entry; the same reason excuses both', () => {
    const missing = evaluateShipGate({ ...cleanFacts(), chronicleOn: true, chronicleTouched: false })
    expect(missing.blocks.some((b) => b.includes('chronicle'))).toBe(true)
    const touched = evaluateShipGate({ ...cleanFacts(), chronicleOn: true, chronicleTouched: true })
    expect(touched.blocks).toEqual([])
    const excused = evaluateShipGate({ ...cleanFacts(), chronicleOn: true, chronicleTouched: false, allowNoChangelog: 'docs-only' })
    expect(excused.blocks).toEqual([])
  })
  test('missing changelog blocks unless a reason is given', () => {
    const r = evaluateShipGate({ ...cleanFacts(), changelogTouched: false })
    expect(r.blocks.some((b) => b.includes('changelog'))).toBe(true)
    const excused = evaluateShipGate({ ...cleanFacts(), changelogTouched: false, allowNoChangelog: 'docs-only' })
    expect(excused.blocks).toEqual([])
  })
  test('negative prose does not accept a finding', () => {
    expect(reviewAdjudicated('**Review:** no adjudication has occurred')).toBe(false)
    expect(reviewAdjudicated('**Review:** Finding [2] parked with ruling')).toBe(false)
  })
  test('missing configured check blocks exact candidate acceptance', () => {
    const r = evaluateShipGate({ ...cleanFacts(), checkExit: null, checkMissing: true })
    expect(r.blocks.some((b) => b.includes('no check command'))).toBe(true)
  })
  test('needs-fixes verdict blocks without explicit adjudication', () => {
    const facts = { ...cleanFacts(), reviewVerdict: 'needs-fixes', review: { ...binding(), verdict: 'needs-fixes', findings: [{id: 'F1', status: 'open'}] } }
    expect(evaluateShipGate(facts).blocks.some((b) => b.includes('review verdict'))).toBe(true)
    expect(evaluateShipGate({ ...facts, adjudicated: true }).blocks).toEqual([])
  })
  test('failing or absent fresh check blocks', () => {
    expect(evaluateShipGate({ ...cleanFacts(), checkExit: 1 }).blocks.some((b) => b.includes('check command'))).toBe(true)
    expect(evaluateShipGate({ ...cleanFacts(), checkExit: null }).blocks.some((b) => b.includes('check command'))).toBe(true)
  })
  test('leftover [DEBUG- tags block only on ADDED lines — removals and docs context pass', () => {
    const added = evaluateShipGate({ ...cleanFacts(), diffText: '+console.log("[DEBUG-a4f2] x")' })
    expect(added.blocks.some((b) => b.includes('[DEBUG-'))).toBe(true)
    const removedOrContext = evaluateShipGate({ ...cleanFacts(), diffText: '-console.log("[DEBUG-a4f2] x")\n [DEBUG-docs] mention in context\n+++ b/skills/dev-debug/SKILL.md' })
    expect(removedOrContext.blocks).toEqual([])
    const docsPlaceholder = evaluateShipGate({ ...cleanFacts(), diffText: '+Every debug log carries a `[DEBUG-<4hex>]` tag' })
    expect(docsPlaceholder.blocks).toEqual([])
  })
  test('rationalization phrases warn, never block', () => {
    const facts = cleanFacts()
    facts.evidence.body = facts.evidence.body.replace('**Not done / limits:** none', '**Not done / limits:** skipping tests for now on the edge case')
    const r = evaluateShipGate(facts)
    expect(r.blocks).toEqual([])
    expect(r.warns.length).toBe(1)
  })
  test('gatherFacts fails closed when gh is unreachable (the CLI turns this into exit 2)', () => {
    process.env.VSK_GH = '/nonexistent-vsk-gh'
    try {
      expect(() => gatherFacts({ issue: '1', branch: 'main' })).toThrow()
    } finally { delete process.env.VSK_GH }
  })
  test('parseMarker exported for the skill wiring', () => {
    expect(parseMarker(evidenceBody())?.keys.type).toBe('evidence')
  })
})

describe('trusted current review selection', () => {
  const trusted = (id = 41, review = binding()) => ({ id, body: reviewBody(review), user: { login: 'operator' } })
  const select = (comments: unknown[], extra = {}) => selectCurrentTrustedReview(comments, {
    complete: true, operators: ['operator'], sha: SHA, baseSha: BASE, scopeDigest: SCOPE, ...extra,
  })

  test('one operator-published exact clean review passes and returns its fresh source binding', () => {
    const comment = trusted()
    const selected = select([comment])
    expect(selected.binding).toEqual(binding())
    expect(selected.source).toEqual({
      commentId: comment.id,
      bodySha256: createHash('sha256').update(comment.body, 'utf8').digest('hex'),
      publisher: 'operator',
    })
  })

  test('an outsider clean comment cannot replace a trusted needs-fixes review or its findings', () => {
    const needsFixes = { ...binding(), verdict: 'needs-fixes', findings: [{ id: 'X1', status: 'open' }] }
    const outsider = { id: 42, body: reviewBody(), user: { login: 'outsider' } }
    const selected = select([trusted(41, needsFixes), outsider])
    expect(selected.binding).toEqual(needsFixes)
    expect(selected.source.commentId).toBe(41)
  })

  test('two trusted exact reviews refuse instead of restoring newest-wins', () => {
    expect(() => select([trusted(41), trusted(42)])).toThrow(/multiple|ambiguous/i)
  })

  test('missing publisher, malformed body, wrong marker identity, and incomplete pagination refuse', () => {
    expect(() => select([{ id: 41, body: reviewBody() }])).toThrow()
    expect(() => select([{ ...trusted(), body: reviewBody() + '\n' + reviewBody() }])).toThrow()
    expect(() => select([{ ...trusted(), body: reviewBody(binding(), { sha: BASE, verdict: 'clean' }) }])).toThrow()
    expect(() => selectCurrentTrustedReview([trusted()], { complete: false, operators: ['operator'], sha: SHA, baseSha: BASE, scopeDigest: SCOPE })).toThrow(/complete/i)
  })

  test('an edited body no longer matches its previously computed source binding', () => {
    const comment = trusted()
    const selected = select([comment])
    expect(() => select([{ ...comment, body: comment.body + '\nEdited after qualification.' }], { source: selected.source })).toThrow(/changed|source/i)
  })
})

describe('worktree resolution', () => {
  const porcelain = [
    'worktree /r', 'HEAD aaaa111', 'branch refs/heads/main', '',
    'worktree /r/.vegastack/.worktrees/106-x', 'HEAD bbbb222', 'branch refs/heads/feat/106-x', '',
  ].join('\n')

  test('the branch under review resolves to its worktree path', () => {
    expect(resolveWorktree('feat/106-x', porcelain)).toBe('/r/.vegastack/.worktrees/106-x')
    expect(resolveWorktree('feat/107-y', porcelain)).toBeNull()
  })
})

// gatherFacts against a real repository: the branch under review lives in a
// second worktree, and only there does the check command pass, dev.md say
// `changelog: none`, and HEAD equal the branch — so every assertion below holds
// only if the resolved worktree is threaded through the git calls, the dev.md
// read and the fresh check.
describe('gatherFacts runs in the branch worktree', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  function repoWithWorktree() {
    const root = mkdtempSync(join(tmpdir(), 'vf-gate-'))
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 'a@b.c')
    git(root, 'config', 'user.name', 'a')
    mkdirSync(join(root, '.vegastack'))
    writeFileSync(join(root, '.vegastack', 'dev.md'), 'commands: check `test -f marker`\nchangelog: changesets\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'init')
    const wt = join(root, '.vegastack', '.worktrees', '106-x')
    git(root, 'worktree', 'add', '-q', '-b', 'feat/106-x', wt, 'main')
    writeFileSync(join(wt, 'marker'), '')
    writeFileSync(join(wt, '.vegastack', 'dev.md'), 'commands: check `test -f marker`\nchangelog: none\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'feat: marker')
    git(root, 'branch', '-q', 'feat/107-y', 'feat/106-x')
    const gh = join(root, 'gh')
    writeFileSync(gh, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([[{id:2,node_id:"PLAN",body:"<!-- vsk:v1 type=plan rev=1 -->\\n## Plan"}]]))\n')
    chmodSync(gh, 0o755)
    return { root, wt, gh }
  }
  const inRepo = (root: string, gh: string, fn: () => void) => {
    const cwd = process.cwd()
    process.env.VSK_GH = gh
    process.chdir(root)
    try { fn() } finally { process.chdir(cwd); delete process.env.VSK_GH }
  }

  test('the resolved worktree carries the git calls, the dev.md read and the fresh check', () => {
    const { root, gh } = repoWithWorktree()
    inRepo(root, gh, () => {
      const facts = gatherFacts({ issue: '106', branch: 'feat/106-x', repo: 'o/r', base: 'main' })
      expect(facts.checkoutMismatch).toBeNull()
      expect(facts.checkExit).toBe(0)
      expect(facts.changelogTouched).toBe(true)
      expect(facts.headSha).toBe(git(root, 'rev-parse', 'feat/106-x').trim())
    })
  })
  test('an epic-sized diff does not read as "cannot verify" — the git buffer is not the fact', () => {
    // 216 commits of Epic B produced a `git diff base...branch` past execFileSync's 1 MiB
    // default; the resulting ENOBUFS surfaced as a block on a branch that was fine.
    const { root, wt, gh } = repoWithWorktree()
    writeFileSync(join(wt, 'large.txt'), 'x'.repeat(3 * 1024 * 1024) + '\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'feat: a diff larger than the default buffer')
    inRepo(root, gh, () => {
      const facts = gatherFacts({ issue: '106', branch: 'feat/106-x', repo: 'o/r', base: 'main' })
      expect(facts.checkoutMismatch).toBeNull()
      expect(facts.checkExit).toBe(0)
    })
  })
  test('--worktree overrides the resolution', () => {
    const { root, wt, gh } = repoWithWorktree()
    inRepo(root, gh, () => {
      const facts = gatherFacts({ issue: '106', branch: 'feat/106-x', repo: 'o/r', base: 'main', worktree: wt })
      expect(facts.checkoutMismatch).toBeNull()
      expect(facts.checkExit).toBe(0)
    })
  })
  test('a branch no worktree holds runs in the main checkout, and its mismatch blocks with the fact', () => {
    const { root, gh } = repoWithWorktree()
    inRepo(root, gh, () => {
      const facts = gatherFacts({ issue: '107', branch: 'feat/107-y', repo: 'o/r', base: 'main' })
      expect(facts.checkoutMismatch).toContain('no worktree holds it')
      expect(facts.checkExit).not.toBe(0)
      expect(evaluateShipGate({ ...cleanFacts(), checkoutMismatch: facts.checkoutMismatch }).blocks.some((b) => b.includes('no worktree holds it'))).toBe(true)
    })
  })
})

function exceptionFixture() {
  const review = { ...binding(), verdict: 'needs-fixes', findings: [{id: 'F1', status: 'open'}, {id: 'F2', status: 'resolved'}] }
  const decision = { sha: SHA, reviewCommentId: 9, operator: 'operator', source: {kind: 'session', ref: 'session:fixture', quote: 'Accept F1 for this candidate'}, findings: [{id: 'F1', disposition: 'accept-risk', reason: 'documented constraint'}] }
  const context = { review, reviewCommentId: 9, operators: ['operator'], publisher: 'operator' }
  return { review, decision, context, body: () => '```json\n' + JSON.stringify({adjudication: decision}) + '\n```' }
}
test('explicit same-review operator exception and resolved findings pass', () => {
  const f = exceptionFixture(); expect(reviewAdjudicated(f.body(), f.context)).toBe(true)
})
for (const mutate of [
  (f: any) => { f.decision.sha = BASE },
  (f: any) => { f.decision.reviewCommentId = 10 },
  (f: any) => { f.decision.operator = 'intruder' },
  (f: any) => { f.context.publisher = 'intruder' },
  (f: any) => { f.decision.findings[0].id = 'UNKNOWN' },
  (f: any) => { f.decision.findings.push(f.decision.findings[0]) },
  (f: any) => { f.decision.findings = [] },
  (f: any) => { f.decision.findings[0].reason = '' },
  (f: any) => { f.review.findings.push({id: 'F3', status: 'open'}) },
  (f: any) => { f.review.findings.push({id: 'F1', status: 'open'}) },
  (f: any) => { f.context.review = null },
]) test('invalid or incomplete scoped exception refuses: ' + String(mutate), () => {
  const f = exceptionFixture(); mutate(f); expect(reviewAdjudicated(f.body(), f.context)).toBe(false)
})
test('GitHub source must match independently read operator comment', () => {
  const f = exceptionFixture(); f.decision.source = {kind: 'github-comment', ref: 'https://github.com/o/r/issues/1#issuecomment-77', quote: 'accept F1'}
  const sourceComment = {id: 77, html_url: f.decision.source.ref, user: {login: 'operator'}, body: 'I accept F1\n' + f.body()}
  expect(reviewAdjudicated(f.body(), {...f.context, publisher: 'recorder', sourceComment})).toBe(true)
  expect(reviewAdjudicated(f.body(), {...f.context, sourceComment: {...sourceComment, user: {login: 'intruder'}}})).toBe(false)
  expect(reviewAdjudicated(f.body(), f.context)).toBe(false)
})
test('duplicate keys/sections, quoted examples and contradictory clean verdict refuse', () => {
  const f = exceptionFixture()
  expect(reviewAdjudicated(f.body() + '\n' + f.body(), f.context)).toBe(false)
  expect(() => typedSection('```json\n{"reviewBinding":{},"reviewBinding":{}}\n```', 'reviewBinding')).toThrow()
  expect(typedSection('````markdown\n```json\n{"reviewBinding":{}}\n```\n````', 'reviewBinding')).toBeNull()
  expect(validReview({...f.review, verdict: 'clean'})).toBe(false)
})

function parentFixture() {
  const merged = 'd'.repeat(40)
  const expected = {repo:'o/r', parentIssue:133, pr:200, prNodeId:'PR200', acceptedParentHead:SHA, baseRepo:'o/r', baseRef:'main', baseSha:BASE}
  const {baseSha: _baseSha, ...identity} = expected
  const parentDelivery = {...identity, mergedAt:'2026-09-08T00:00:00Z', mergedCommit:merged, transformation:null as any}
  const pr = {number:200, node_id:'PR200', head:{repo:{full_name:'o/r'},sha:SHA}, base:{repo:{full_name:'o/r'},ref:'main',sha:BASE}, merged:true, merged_at:parentDelivery.mergedAt, merge_commit_sha:merged}
  const requiredDeliveries = [{issue:135, taskIds:['135-T1'], mode:'code'}, {issue:155, taskIds:['155-T1'], mode:'preparation'}]
  return {parentDelivery,pr,expected,requiredDeliveries,acceptedDeliveries:structuredClone(requiredDeliveries),verification:{reviewedHead:SHA,mergedHead:merged,baseSha:BASE,acceptedTree:SHA,mergedTree:SHA,check:{sha:merged,exit:0},ancestorShas:[merged,SHA],rangeHead:merged,evidenceRef:'https://github.com/o/r/issues/133#issuecomment-10'}}
}
test('one normal merge delivers several pinned child scopes including preparation', () => {
  expect(evaluateParentDelivery(parentFixture()).blocks).toEqual([])
})
test('verified rebase maps exact reviewed and merged candidate', () => {
  const f=parentFixture(); f.parentDelivery.transformation={kind:'rebase',reviewedHead:SHA,mergedHead:f.parentDelivery.mergedCommit,evidenceRef:f.verification.evidenceRef};f.verification.ancestorShas=[]
  expect(evaluateParentDelivery(f).blocks).toEqual([])
  f.verification.rangeHead=BASE; expect(evaluateParentDelivery(f).blocks.length).toBeGreaterThan(0)
})
for (const mutation of [
  (f:any)=>{f.acceptedDeliveries.pop()},
  (f:any)=>{f.acceptedDeliveries[0].taskIds=[]},
  (f:any)=>{f.pr.base.ref='other'},
  (f:any)=>{f.pr.base.sha=SHA},
  (f:any)=>{f.pr.base.repo.full_name='other/repo'},
  (f:any)=>{f.pr.head.sha=BASE},
  (f:any)=>{f.pr.merged=false},
  (f:any)=>{f.verification.check.sha=SHA},
  (f:any)=>{f.verification.check.exit=1},
  (f:any)=>{f.verification.mergedTree=BASE},
]) test('parent delivery refuses incomplete or mismatched actual proof: '+String(mutation),()=>{
  const f=parentFixture();mutation(f);expect(evaluateParentDelivery(f).blocks.length).toBeGreaterThan(0)
})

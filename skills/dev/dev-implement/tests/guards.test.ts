import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GhUnavailable, findMarkerComment, ghJson, parseFlags, parseMarker, renderResult } from '../scripts/lib/gh.mjs'

const implRoot = resolve(import.meta.dir, '..')
import { evaluatePreflight } from '../scripts/preflight.mjs'
import { scopeDigest } from '../scripts/lib/approval.mjs'
import { checkEvidence, checkTaskConsistency } from '../scripts/evidence-check.mjs'

const baseIssue = () => ({
  number: 1, node_id: 'brief-1',
  body: '<!-- vsk:v1 type=brief rev=1 scope=quick-build -->\n## Outcome\nA thing.\n',
  state: 'open', labels: [{ name: 'ready' }, { name: 'quick-build' }],
  assignees: [] as Array<{ login: string }>, repo: 'vegastack/vegafactory', blockedBy: [] as Array<{ number: number; state: string }>,
})
const currentPlan = { id: 2, node_id: 'plan-2', body: '<!-- vsk:v1 type=plan rev=1 -->\n- [ ] **Task 1: implement** <!-- task-id:1-T1 -->\n' }
const approval = (scope = 'brief+plan') => {
  const artifacts = [
    { repo: 'vegastack/vegafactory', issue: 1, kind: 'brief', artifactId: 'brief-1', rev: 1, digest: scopeDigest(baseIssue().body, 'brief') },
    { repo: 'vegastack/vegafactory', issue: 1, kind: 'plan', artifactId: 'plan-2', rev: 1, digest: scopeDigest(currentPlan.body, 'plan') },
  ].filter(ref => scope === 'brief+plan' || ref.kind === scope)
  return { id: scope === 'plan' ? 4 : 3, user: { login: 'kmanojkumar' }, body: `<!-- vsk:v1 type=approval scope=${scope} -->\n\`\`\`json\n` + JSON.stringify({ schemaVersion: 2, id: 'intent-' + scope, operator: 'kmanojkumar', scope, source: { kind: 'session', ref: 'session:1', quote: 'Approved.' }, artifacts, supersedes: [], revokes: [] }) + '\n```\n' }
}
const devMd = 'repo: vegastack/vegafactory · default branch main\noperators: kmanojkumar\n'

describe('marker lib', () => {
  test('parses keys from a vsk marker', () => {
    expect(parseMarker('<!-- vsk:v1 type=ledger branch=feat/x -->')?.keys).toEqual({ type: 'ledger', branch: 'feat/x' })
  })
  test('no marker → null (no heading fallback)', () => {
    expect(parseMarker('## Ledger — feat/x')).toBeNull()
  })
  test('findMarkerComment: last of a type wins', () => {
    const found = findMarkerComment([approval('brief'), approval('plan')], 'approval')
    expect(found?.keys.scope).toBe('plan')
  })
  test('renderResult exit codes: block=2, warn=1, clean=0', () => {
    expect(renderResult('g', { blocks: ['x'], warns: [] }).exitCode).toBe(2)
    expect(renderResult('g', { blocks: [], warns: ['y'] }).exitCode).toBe(1)
    expect(renderResult('g', { blocks: [], warns: [] }).exitCode).toBe(0)
  })
  test('parseFlags: values and booleans', () => {
    expect(parseFlags(['--issue', '12', '--json'])).toEqual({ issue: '12', json: true })
  })
})

describe('ghJson fail-closed', () => {
  test('an unreachable gh binary throws GhUnavailable (callers block, never pass)', () => {
    expect(() => ghJson(['api', 'user'], { gh: '/nonexistent-vsk-gh' })).toThrow(GhUnavailable)
  })
  test('HTTP status is parsed from stderr onto the error (403 stub), null without a marker', () => {
    const stub = new URL('./fixtures/gh-403-stub.sh', import.meta.url).pathname
    let threw = false
    try {
      ghJson(['api', 'user'], { gh: stub })
    } catch (e: any) {
      threw = true
      expect(e).toBeInstanceOf(GhUnavailable)
      expect(e.httpStatus).toBe(403)
    }
    expect(threw).toBe(true)
    let threw2 = false
    try { ghJson(['x'], { gh: '/nonexistent-vsk-gh' }) } catch (e: any) { threw2 = true; expect(e.httpStatus).toBeNull() }
    expect(threw2).toBe(true)
  })
  test('ghJson pipes `input` to stdin and keeps it off argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsk-gh-input-'))
    const log = join(dir, 'log')
    const stub = new URL('./fixtures/gh-put-stub.sh', import.meta.url).pathname
    process.env.VSK_STUB_LOG = log
    try {
      const out = ghJson(['api', '-X', 'PUT', 'repos/o/e/contents/x.png', '--input', '-'], { gh: stub, input: '{"message":"m","content":"QUJD"}' })
      expect(out.content.path).toBe('repos/o/e/contents/x.png')
      expect(readFileSync(log, 'utf8')).not.toContain('QUJD')
      expect(readFileSync(`${log}.stdin`, 'utf8')).toContain('"content":"QUJD"')
    } finally {
      delete process.env.VSK_STUB_LOG
    }
  })
})

describe('preflight', () => {
  test('clean quick-build issue passes', () => {
    const r = evaluatePreflight({ issue: baseIssue(), comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks).toEqual([])
  })
  test('blocks without an approval marker', () => {
    const r = evaluatePreflight({ issue: baseIssue(), comments: [{ body: 'Approved!' }], devMd, me: 'kmanojkumar' })
    expect(r.blocks.some((b: string) => b.includes('approval'))).toBe(true)
  })
  test('blocks without exactly one scope label', () => {
    const issue = baseIssue()
    issue.labels = [{ name: 'ready' }]
    const r = evaluatePreflight({ issue, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks.some((b: string) => b.includes('scope label'))).toBe(true)
  })
  test('full-plan blocks without plan approval, passes with scope=plan', () => {
    const issue = baseIssue()
    issue.labels = [{ name: 'ready' }, { name: 'full-plan' }]
    const missing = evaluatePreflight({ issue, comments: [currentPlan, approval('brief')], devMd, me: 'kmanojkumar' })
    expect(missing.blocks.some((b: string) => b.includes('plan'))).toBe(true)
    const ok = evaluatePreflight({ issue, comments: [currentPlan, approval('brief'), approval('plan')], devMd, me: 'kmanojkumar' })
    expect(ok.blocks).toEqual([])
  })
  test('planning permits the operator assignee with a separate service-account runner', () => {
    const issue = baseIssue()
    issue.labels = [{ name: 'needs-plan' }, { name: 'full-plan' }]
    issue.assignees = [{ login: 'kmanojkumar' }]
    const input = { issue, comments: [approval('brief')], devMd, me: 'service-runner', expect: 'needs-plan', stage: 'plan' }
    expect(evaluatePreflight(input).blocks).toEqual([])
    issue.assignees = [{ login: 'another-runner' }]
    expect(evaluatePreflight(input).blocks.join(' ')).toContain('another-runner')
  })
  test('blocks on unresolved Assumptions section', () => {
    const issue = baseIssue()
    issue.body += '\n## Assumptions — confirm or correct\n- gh supports X\n'
    const r = evaluatePreflight({ issue, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks.some((b: string) => b.includes('Assumptions'))).toBe(true)
  })
  test('blocks on open blockers and foreign assignee', () => {
    const issue = baseIssue()
    issue.blockedBy = [{ number: 7, state: 'open' }]
    issue.assignees = [{ login: 'someone-else' }]
    const r = evaluatePreflight({ issue, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks.some((b: string) => b.includes('#7'))).toBe(true)
    expect(r.blocks.some((b: string) => b.includes('someone-else'))).toBe(true)
  })
  test('a ready issue carrying an assignee warns and names them; the foreign-assignee block still fires', () => {
    const mine = baseIssue()
    mine.assignees = [{ login: 'kmanojkumar' }]
    const r = evaluatePreflight({ issue: mine, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks).toEqual([])
    expect(r.warns.some((w: string) => w.includes('kmanojkumar'))).toBe(true)

    const foreign = baseIssue()
    foreign.assignees = [{ login: 'someone-else' }]
    const f = evaluatePreflight({ issue: foreign, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(f.blocks.some((b: string) => b.includes('someone-else'))).toBe(true)
    expect(f.warns.some((w: string) => w.includes('someone-else'))).toBe(true)

    const resume = baseIssue()
    resume.labels = [{ name: 'working' }, { name: 'quick-build' }]
    resume.assignees = [{ login: 'kmanojkumar' }]
    expect(evaluatePreflight({ issue: resume, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar', expect: 'working' }).warns).toEqual([])
  })
  test('a for-operator issue assigned to its operator is not a foreign claim: the corrections run starts', () => {
    // The hand-back moves the assignee to the operator, so on a multi-operator project (or a
    // runner whose gh login is not the operator) every corrections run sees a foreign assignee.
    const corrections = baseIssue()
    corrections.labels = [{ name: 'for-operator' }, { name: 'quick-build' }]
    corrections.assignees = [{ login: 'ada' }]
    expect(evaluatePreflight({ issue: corrections, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar', expect: 'for-operator' }).blocks).toEqual([])
    // A working issue still belongs to its claimant, and the block says so.
    const claimed = baseIssue()
    claimed.labels = [{ name: 'working' }, { name: 'quick-build' }]
    claimed.assignees = [{ login: 'ada' }]
    const w = evaluatePreflight({ issue: claimed, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar', expect: 'working' })
    expect(w.blocks).toEqual(['already assigned to ada — a working issue belongs to its claimant'])
    // A ready issue is unassigned by convention, so a foreign assignee is someone else's claim.
    const taken = baseIssue()
    taken.assignees = [{ login: 'ada' }]
    const r = evaluatePreflight({ issue: taken, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks).toEqual(['already assigned to ada — a ready issue is unassigned by convention, so another assignee is someone else\'s claim'])
  })
  test('blocks a closed issue and a wrong state label; expect=working accepts a resume', () => {
    const closed = baseIssue(); closed.state = 'closed'
    expect(evaluatePreflight({ issue: closed, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' }).blocks.some((b: string) => b.includes('only open issues'))).toBe(true)
    const wrong = baseIssue(); wrong.labels = [{ name: 'needs-operator' }, { name: 'quick-build' }]
    expect(evaluatePreflight({ issue: wrong, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' }).blocks.some((b: string) => b.includes('expected ready'))).toBe(true)
    const resume = baseIssue(); resume.labels = [{ name: 'working' }, { name: 'quick-build' }]
    expect(evaluatePreflight({ issue: resume, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar', expect: 'working' }).blocks).toEqual([])
  })
  test('a dev.md without a repo: line warns instead of silently skipping the match', () => {
    const r = evaluatePreflight({ issue: baseIssue(), comments: [currentPlan, approval()], devMd: 'stack: something\noperators: kmanojkumar\n', me: 'kmanojkumar' })
    expect(r.blocks).toEqual([])
    expect(r.warns.some((w: string) => w.includes('no repo: line'))).toBe(true)
  })
  test('blocks on repo mismatch with dev.md', () => {
    const issue = baseIssue()
    issue.repo = 'vegastack/other-repo'
    const r = evaluatePreflight({ issue, comments: [currentPlan, approval()], devMd, me: 'kmanojkumar' })
    expect(r.blocks.some((b: string) => b.includes('does not match dev.md repo'))).toBe(true)
  })
})

describe('evidence-check', () => {
  const good = `<!-- vsk:v1 type=evidence rev=1 branch=feat/12-x sha=abc1234 -->
## Result (v1)
**Done:** thing
**Tests:** bun test → green
**Review:** subagent — clean
**Changelog:** changeset added
**Docs:** brief v1, plan v1 — in sync
**Not done / limits:** none
Branch: feat/12-x @ abc1234`
  test('complete evidence passes', () => {
    expect(checkEvidence(good).blocks).toEqual([])
  })
  test('blocks on missing marker, sections, and tail', () => {
    const r = checkEvidence('## Result\n**Done:** thing\n')
    expect(r.blocks.some((b: string) => b.includes('marker'))).toBe(true)
    expect(r.blocks.some((b: string) => b.includes('**Docs:**'))).toBe(true)
    expect(r.blocks.some((b: string) => b.includes('Branch:'))).toBe(true)
  })
  test('blocks on marker without real sha', () => {
    const r = checkEvidence(good.replace('sha=abc1234', 'sha=TBDTBDT'))
    expect(r.blocks.some((b: string) => b.includes('real sha'))).toBe(true)
  })
  test('--issue path fails closed on unreachable gh → exit 2, shape-valid draft notwithstanding', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'vsk-ev-')), 'evidence.md')
    writeFileSync(f, good)
    const r = spawnSync('node', [join(implRoot, 'scripts/evidence-check.mjs'), '--file', f, '--issue', '5', '--repo', 'o/r', '--json'], {
      env: { ...process.env, VSK_GH: '/nonexistent-vsk-gh' }, encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toContain('cannot verify plan/ledger consistency')
  })
})

describe('checkTaskConsistency: plan checkboxes must reflect the ledger', () => {
  const plan = (body: string) => ({ body: `<!-- vsk:v1 type=plan rev=1 -->\n${body}` })
  const ledger = (body: string) => ({ body: `<!-- vsk:v1 type=ledger branch=feat/x -->\n## Ledger\n${body}` })

  test('all completed tasks checked → no block', () => {
    const comments = [
      plan('- [x] **Task 1: a**\n- [x] **Task 2: b**\n- [ ] **Task 3: c**'),
      ledger('- Task 1: complete (commits aaaaaaa..bbbbbbb)\n- Task 2: complete (commits ccccccc..ddddddd)'),
    ]
    expect(checkTaskConsistency(comments).blocks).toEqual([])
  })
  test('ledger ahead of the checkboxes → block naming the gap', () => {
    const comments = [
      plan('- [ ] **Task 1: a**\n- [ ] **Task 2: b**'),
      ledger('- Task 1: complete (commits aaaaaaa..bbbbbbb)\n- Task 2: complete (commits ccccccc..ddddddd)'),
    ]
    const r = checkTaskConsistency(comments)
    expect(r.blocks.length).toBe(1)
    expect(r.blocks[0]).toContain('2 task(s) are marked complete')
  })
  test('a task with fix rounds but no complete line does not force a check', () => {
    const comments = [
      plan('- [x] **Task 1: a**\n- [ ] **Task 2: b**'),
      ledger('- Task 1: complete (commits aaaaaaa..bbbbbbb)\n- Task 2: fix round 1/3 (1 addressed, 1 open)'),
    ]
    expect(checkTaskConsistency(comments).blocks).toEqual([])
  })
  test('no plan comment, no checkboxes, or no ledger → nothing to reconcile', () => {
    expect(checkTaskConsistency([ledger('- Task 1: complete (commits a..b)')]).blocks).toEqual([])
    expect(checkTaskConsistency([plan('no checkboxes here'), ledger('- Task 1: complete (commits a..b)')]).blocks).toEqual([])
    expect(checkTaskConsistency([plan('- [ ] **Task 1: a**')]).blocks).toEqual([])
    expect(checkTaskConsistency([]).blocks).toEqual([])
  })
})

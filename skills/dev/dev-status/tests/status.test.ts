import { describe, expect, test } from 'bun:test'
import { ageDays, ageHours, ledgerMovedAt, parseMarker, pendingDecisions, stripLinks, taskProgress } from '../scripts/status.mjs'

const NOW = Date.parse('2026-08-29T12:00:00Z')
const planComment = (body: string) => ({ body: `<!-- vsk:v1 type=plan rev=1 -->\n${body}`, updated_at: '2026-08-29T10:00:00Z' })

describe('status helpers', () => {
  test('ageDays floors whole days', () => {
    expect(ageDays('2026-08-26T11:00:00Z', NOW)).toBe(3)
    expect(ageDays('2026-08-29T01:00:00Z', NOW)).toBe(0)
  })
  test('ageHours floors whole hours — the liveness granularity days cannot see', () => {
    expect(ageHours('2026-08-29T06:00:00Z', NOW)).toBe(6)
    expect(ageHours('2026-08-29T11:20:00Z', NOW)).toBe(0)
    expect(ageHours('2026-08-28T12:00:00Z', NOW)).toBe(24)
  })
  test('taskProgress counts checkboxes in the plan comment only', () => {
    const comments = [
      { body: 'no marker here - [ ] not a task', updated_at: '' },
      planComment('- [x] **Task 1: a**\n- [x] **Task 2: b**\n- [ ] **Task 3: c**'),
    ]
    expect(taskProgress(comments)).toEqual([2, 3])
    expect(taskProgress([{ body: 'nothing', updated_at: '' }])).toBeNull()
    expect(taskProgress([planComment('no checkboxes at all')])).toBeNull()
  })
  test('ledgerMovedAt returns the last ledger comment time, null when absent', () => {
    const comments = [
      { body: '<!-- vsk:v1 type=ledger branch=x -->\n## Ledger', updated_at: '2026-08-27T09:00:00Z' },
      { body: '<!-- vsk:v1 type=evidence rev=1 branch=x sha=abc1234 -->', updated_at: '2026-08-28T09:00:00Z' },
    ]
    expect(ledgerMovedAt(comments)).toBe('2026-08-27T09:00:00Z')
    expect(ledgerMovedAt([])).toBeNull()
  })
  test('pendingDecisions: unrecorded decision comments and evidence Decision lines, recorded ones excluded', () => {
    const register = '- 28-08-2026 (mk) — keep D1 for the search index\n'
    const comments = [
      { body: '<!-- vsk:v1 type=decision -->\nkeep D1 for the search index', updated_at: '' },
      { body: '<!-- vsk:v1 type=decision -->\nexports stay client-side until >10k rows is real', updated_at: '' },
      { body: '<!-- vsk:v1 type=evidence rev=1 branch=x sha=abc1234 -->\n**Decision:** retire the legacy webhook path\n**Not done / limits:** none', updated_at: '' },
      { body: '<!-- vsk:v1 type=evidence rev=1 branch=y sha=abc1235 -->\n**Decision:** none for the register\n', updated_at: '' },
    ]
    const pending = pendingDecisions(comments, register)
    expect(pending).toEqual(['exports stay client-side until >10k rows is real', 'retire the legacy webhook path'])
  })
  test('a recorded decision is not pending just because its gist carries a link', () => {
    const register = '- 29-08-2026 (mk) — retire the legacy webhook path\n'
    const comments = [{ body: '<!-- vsk:v1 type=decision -->\nretire the [legacy webhook path](https://example.com/webhooks)', updated_at: '' }]
    expect(pendingDecisions(comments, register)).toEqual([])
  })
  test('stripLinks unwraps markdown links for terminal display', () => {
    // The chronicle title shape: the issue link sits inside its own parens.
    expect(stripLinks('Widgets got frobbed ([#7](https://github.com/o/r/issues/7))')).toBe('Widgets got frobbed (#7)')
    expect(stripLinks('retire the [legacy webhook path](https://example.com/doc) for good')).toBe('retire the legacy webhook path for good')
    expect(stripLinks('no links here')).toBe('no links here')
    expect(stripLinks(null)).toBe('')
  })
  test('readKnobs parses the operators csv; an absent line is an empty list', () => {
    expect(readKnobs('operators: kmanojkumar, ada\n').operators).toEqual(['kmanojkumar', 'ada'])
    expect(readKnobs('operators: kmanojkumar   # just me\n').operators).toEqual(['kmanojkumar'])
    expect(readKnobs('').operators).toEqual([])
  })
  test('resolveOperator: approval author wins, then the issue author, then the first listed', () => {
    const operators = ['kmanojkumar', 'ada']
    expect(resolveOperator({ approvalAuthor: 'ada', issueAuthor: 'kmanojkumar', operators })).toBe('ada')
    expect(resolveOperator({ approvalAuthor: 'outsider', issueAuthor: 'ada', operators })).toBe('ada')
    expect(resolveOperator({ approvalAuthor: 'outsider', issueAuthor: 'outsider', operators })).toBe('kmanojkumar')
    expect(resolveOperator({ issueAuthor: 'ada', operators: [] })).toBeNull()
  })
  test('approvalAuthor: the last approval comment wins, null when none carries the marker', () => {
    const comments = [
      { body: '<!-- vsk:v1 type=approval scope=brief -->', user: { login: 'kmanojkumar' } },
      { body: '<!-- vsk:v1 type=approval scope=plan -->', user: { login: 'ada' } },
      { body: '<!-- vsk:v1 type=ledger branch=x -->', user: { login: 'bot' } },
    ]
    expect(approvalAuthor(comments)).toBe('ada')
    expect(approvalAuthor([{ body: 'approved!', user: { login: 'ada' } }])).toBeNull()
    expect(approvalAuthor([])).toBeNull()
  })
  test('parseMarker matches the shared contract', () => {
    expect(parseMarker('<!-- vsk:v1 type=ledger branch=feat/x -->')?.keys.type).toBe('ledger')
    expect(parseMarker('## Ledger only')).toBeNull()
  })
})

import { approvalAuthor, checksState, gatherStatus, readKnobs, resolveOperator } from '../scripts/status.mjs'
import { join, resolve } from 'node:path'

describe('gatherStatus over the gh stub', () => {
  const skillRoot = resolve(import.meta.dir, '..')
  test('assembles the board, staleness, tasks, decisions, and PR checks from canned gh output', () => {
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = join(skillRoot, 'tests/fixtures/scenarios/basic')
    try {
      const data = gatherStatus({ orphanHours: 6, devMdPath: '/nonexistent-dev.md', now: Date.parse('2026-08-29T12:00:00Z') })
      expect(data.repo).toBe('vegastack/fixture-repo')
      expect(data.board.working[0]).toMatchObject({ number: 7, scope: 'quick-build', risky: true, tasks: [1, 2], possiblyOrphaned: true })
      expect(data.board['for-operator'][0].number).toBe(8)
      expect(data.pendingDecisions).toEqual([{ issue: 8, gist: 'retire the [legacy webhook path](https://example.com/webhooks)', gistPlain: 'retire the legacy webhook path' }])
      expect(data.prs[0].checks).toBe('green')
      expect(data.board.ready).toEqual([])
    } finally {
      delete process.env.VSK_GH; delete process.env.GH_STUB_DIR
    }
  })
  test('possiblyOrphaned bands: a fresh ledger is alive, a silent-past-threshold or never-written one is orphaned', () => {
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = join(skillRoot, 'tests/fixtures/scenarios/orphan-bands')
    try {
      const data = gatherStatus({ orphanHours: 6, devMdPath: '/nonexistent-dev.md', chroniclePath: '/nonexistent.md', now: Date.parse('2026-08-29T12:00:00Z') })
      const fresh = data.board.working.find((i: any) => i.number === 7)
      const dead = data.board.working.find((i: any) => i.number === 9)
      // #7: ledger moved 3h ago (< 6h) → alive
      expect(fresh).toMatchObject({ ledgerAgeHours: 3, possiblyOrphaned: false })
      // #9: no ledger comment ever written → orphaned, null age
      expect(dead).toMatchObject({ ledgerAgeHours: null, possiblyOrphaned: true })
    } finally { delete process.env.VSK_GH; delete process.env.GH_STUB_DIR }
  })
  test('checksState: StatusContext green, empty rollup is no-checks, failure is pending-or-red', () => {
    expect(checksState([{ state: 'SUCCESS' }])).toBe('green')
    expect(checksState([])).toBe('no-checks')
    expect(checksState(undefined)).toBe('no-checks')
    expect(checksState([{ conclusion: 'FAILURE' }])).toBe('pending-or-red')
  })
  test('empty board: all buckets empty, no PRs, no chronicle', () => {
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = join(skillRoot, 'tests/fixtures/scenarios/empty')
    try {
      const data = gatherStatus({ devMdPath: '/nonexistent-dev.md', chroniclePath: '/nonexistent-chronicle.md', now: Date.parse('2026-08-29T12:00:00Z') })
      expect(Object.values(data.board).every((b: any[]) => b.length === 0)).toBe(true)
      expect(data.prs).toEqual([])
      expect(data.pendingDecisions).toEqual([])
      expect(data.lastChronicle).toBeNull()
    } finally { delete process.env.VSK_GH; delete process.env.GH_STUB_DIR }
  })
  test('chronicle parse: newest entry date + outcome title', () => {
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = join(skillRoot, 'tests/fixtures/scenarios/basic')
    try {
      const data = gatherStatus({ devMdPath: '/nonexistent-dev.md', chroniclePath: join(skillRoot, 'tests/fixtures/scenarios/basic/chronicle.md'), now: Date.parse('2026-08-29T12:00:00Z') })
      expect(data.lastChronicle).toEqual({ date: '29-08-2026', title: 'Widgets got frobbed ([#7](https://github.com/vegastack/fixture-repo/issues/7))', titlePlain: 'Widgets got frobbed (#7)' })
    } finally { delete process.env.VSK_GH; delete process.env.GH_STUB_DIR }
  })
  test('CLI fails closed: unreachable gh → exit 2, cannot-verify on stderr', () => {
    const { spawnSync } = require('node:child_process')
    const r = spawnSync('node', [join(skillRoot, 'scripts/status.mjs'), '--json'], {
      env: { ...process.env, VSK_GH: '/nonexistent-vsk-gh' }, encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('cannot verify')
  })
  test('me is the default view: Needs you is mine, Unowned is the human-state issues with no assignee, --all keeps every one', () => {
    const dir = join(skillRoot, 'tests/fixtures/scenarios/assignment')
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = dir
    try {
      const mine = gatherStatus({ devMdPath: join(dir, 'dev.md'), chroniclePath: '/nonexistent.md', now: Date.parse('2026-09-03T12:00:00Z') })
      expect(mine.viewer).toBe('kmanojkumar')
      expect(mine.view).toBe('me')
      expect(mine.operators).toEqual(['kmanojkumar', 'ada'])
      expect(mine.needsYou.map((i: any) => i.number)).toEqual([11, 14])
      expect(mine.unowned.map((i: any) => i.number)).toEqual([13])
      expect(mine.board['needs-operator'][0].assignees).toEqual(['kmanojkumar'])
      expect(mine.board['for-operator'][0].operator).toBe('ada')
      expect(mine.board['needs-operator'][1].operator).toBe('ada')
      const all = gatherStatus({ view: 'all', devMdPath: join(dir, 'dev.md'), chroniclePath: '/nonexistent.md', now: Date.parse('2026-09-03T12:00:00Z') })
      expect(all.view).toBe('all')
      expect(all.needsYou.map((i: any) => i.number)).toEqual([11, 12, 13, 14])
    } finally { delete process.env.VSK_GH; delete process.env.GH_STUB_DIR }
  })
  test('readKnobs: explicit workflow labels and custom register parse; ambiguous legacy labels refuse', () => {
    const labels = { needsOperator: 'waiting', needsPlan: 'planning', ready: 'go', working: 'doing', forOperator: 'done' }
    const knobs = readKnobs('workflow-labels: ' + JSON.stringify(labels) + '\ndecisions: docs/register.md\n')
    expect(knobs.states).toEqual(['waiting', 'planning', 'go', 'doing', 'done'])
    expect(knobs.risky).toBe('risky')
    expect(knobs.register).toBe('docs/register.md')
    expect(() => readKnobs('labels: waiting planning go doing done hot q s l parent\n')).toThrow()
    expect(() => readKnobs('labels: a b c\n')).toThrow()
    expect(readKnobs('').register).toBe('.vegastack/decisions.md')
  })
})

import { controlRoomDrift, controlRoomKnob, knobMap } from '../scripts/status.mjs'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

describe('control-room drift', () => {
  const skillRoot = resolve(import.meta.dir, '..')
  const devMd = [
    '## Knobs',
    'review: cross-agent-risky   # this repo overrode the group default',
    'gates: 3',
    'control-room: vegastack/vegafactory-control-room#dev@a1b2c3d   # org control room',
  ].join('\n')

  test('knobMap keeps a value containing a hash and drops the trailing comment', () => {
    expect(knobMap(devMd)['control-room']).toBe('vegastack/vegafactory-control-room#dev@a1b2c3d')
    expect(knobMap(devMd).review).toBe('cross-agent-risky')
  })

  test('the knob resolves org, group and the recorded sha; absent is null', () => {
    expect(controlRoomKnob(devMd)).toEqual({ org: 'vegastack', repo: 'vegastack/vegafactory-control-room', group: 'dev', sha: 'a1b2c3d' })
    expect(controlRoomKnob('## Knobs\nreview: subagent\n')).toBeNull()
  })

  test('drift lists only knobs the control room and the repo both name with different values', () => {
    const drift = controlRoomDrift({
      devMdText: devMd,
      orgText: 'stats: on\ngates: 3\n',
      groupText: 'review: cross-agent\nchronicle-style: story\n',
      cloneSha: 'e4f5a6b',
    })
    expect(drift).toMatchObject({ recordedSha: 'a1b2c3d', cloneSha: 'e4f5a6b', behind: true })
    expect(drift.knobs).toEqual([{ knob: 'review', repo: 'cross-agent-risky', controlRoom: 'cross-agent', source: 'group' }])
  })

  test('a matching sha with no differing knob is not drift', () => {
    const drift = controlRoomDrift({ devMdText: devMd, orgText: 'gates: 3\n', groupText: 'review: cross-agent-risky\n', cloneSha: 'a1b2c3d' })
    expect(drift).toMatchObject({ behind: false, knobs: [] })
  })

  test('gatherStatus reports a missing clone as unavailable, never as an error', () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-home-'))
    const repo = mkdtempSync(join(tmpdir(), 'vsk-repo-'))
    mkdirSync(join(repo, '.vegastack'), { recursive: true })
    writeFileSync(join(repo, '.vegastack/dev.md'), devMd)
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = join(skillRoot, 'tests/fixtures/scenarios/empty')
    try {
      const data = gatherStatus({ devMdPath: join(repo, '.vegastack/dev.md'), chroniclePath: '/nonexistent.md', home, now: Date.parse('2026-09-03T12:00:00Z') })
      expect(data.controlRoom).toMatchObject({ available: false, recordedSha: 'a1b2c3d' })
      expect(data.controlRoom.reason).toContain('vegafactory sync')
    } finally { delete process.env.VSK_GH; delete process.env.GH_STUB_DIR }
  })

  test('gatherStatus reads org.md and group.md out of the clone the state file names', () => {
    const home = mkdtempSync(join(tmpdir(), 'vsk-home-'))
    const clone = join(home, '.vegastack/control-room/vegastack')
    mkdirSync(join(clone, 'groups/dev'), { recursive: true })
    writeFileSync(join(clone, 'org.md'), 'stats: on\n')
    writeFileSync(join(clone, 'groups/dev/group.md'), 'review: cross-agent\n')
    mkdirSync(join(home, '.vegastack'), { recursive: true })
    writeFileSync(join(home, '.vegastack/factory.json'), JSON.stringify({ schemaVersion: 1, controlRooms: { vegastack: { repo: 'vegastack/vegafactory-control-room', path: clone, branch: 'main', lastSyncedAt: '2026-09-03T11:00:00Z', sha: 'e4f5a6b' } } }))
    const repo = mkdtempSync(join(tmpdir(), 'vsk-repo-'))
    mkdirSync(join(repo, '.vegastack'), { recursive: true })
    writeFileSync(join(repo, '.vegastack/dev.md'), devMd)
    process.env.VSK_GH = join(skillRoot, 'tests/fixtures/gh-stub.mjs')
    process.env.GH_STUB_DIR = join(skillRoot, 'tests/fixtures/scenarios/empty')
    try {
      const data = gatherStatus({ devMdPath: join(repo, '.vegastack/dev.md'), chroniclePath: '/nonexistent.md', home, now: Date.parse('2026-09-03T12:00:00Z') })
      expect(data.controlRoom).toMatchObject({ available: true, path: clone, lastSyncedAt: '2026-09-03T11:00:00Z' })
      expect(data.controlRoom.knobs).toEqual([{ knob: 'review', repo: 'cross-agent-risky', controlRoom: 'cross-agent', source: 'group' }])
    } finally { delete process.env.VSK_GH; delete process.env.GH_STUB_DIR }
  })
})

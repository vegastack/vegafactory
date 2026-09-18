import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parsePolicy, planLabelMigration, readWorkflowStates, resolveState, resolvePolicy, WORKFLOW_LABELS, WORKFLOW_STATES } from '../scripts/effective-policy.mjs'

const actual = /^labels:\s*([^#\n]+)/m.exec(readFileSync(new URL('../../../../.vegastack/dev.md', import.meta.url), 'utf8'))![1]!.trim()

test('this repo\'s own labels line carries the fixed set, whatever the order or separator', () => {
  const before = actual.split(/\s+/)
  for (const labels of [actual, before.join(','), [...before].reverse().join(' '), actual + ' extra-scope']) {
    expect(readWorkflowStates('labels: ' + labels)).toEqual([...WORKFLOW_STATES])
    expect(resolvePolicy({ repo: 'labels: ' + labels }).ok).toBe(true)
  }
  expect(actual.split(/\s+/)).toEqual(before)
})

test('a labels line missing a state, or repeating one, is a block', () => {
  for (const labels of ['queued in-progress', actual + ' queued', 'small medium large']) {
    expect(() => readWorkflowStates('labels: ' + labels)).toThrow()
    expect(resolvePolicy({ repo: 'labels: ' + labels }).ok).toBe(false)
  }
})

// A profile that lists every new state AND a leftover old one used to pass: the new set was all
// present, and the extra name looked like a project's own scope label.
test('a labels line still carrying a superseded name is a block, and the message names the migration', () => {
  for (const stale of ['needs-plan', 'ready', 'working', 'for-operator', 'quick-build']) {
    const line = 'labels: ' + actual + ' ' + stale
    expect(() => readWorkflowStates(line)).toThrow(/superseded/)
    expect(() => readWorkflowStates(line)).toThrow(new RegExp(stale))
    expect(() => readWorkflowStates(line)).toThrow(/migration/)
    expect(resolvePolicy({ repo: line }).ok).toBe(false)
  }
})

// A retired key used to fall through to `extensions`, where nothing reads it and nothing
// complains — a profile could keep a removed mechanism indefinitely and look clean.
test('a retired knob is a block naming what replaced it, never a silently kept extension', () => {
  for (const [line, names] of [
    ['workflow-labels: {"ready":"Go"}', /workflow-labels was removed/],
    ['gates: 3', /gates was removed/],
  ] as Array<[string, RegExp]>) {
    const layer = parsePolicy(line)
    expect(layer.blocks.join(' ')).toMatch(names)
    expect(Object.keys(layer.extensions)).toEqual([])
    expect(resolvePolicy({ repo: line }).ok).toBe(false)
  }
})

test('one state label resolves; none and several refuse', () => {
  expect(resolveState(['queued', 'medium'])).toEqual({ state: 'queued', blocks: [] })
  for (const labels of [[], ['queued', 'in-progress'], null]) {
    expect(resolveState(labels as string[]).state).toBeNull()
    expect(resolveState(labels as string[]).blocks.length).toBeGreaterThan(0)
  }
})

// The migration an existing repo gets on a dev-setup re-run. A populated repo is the only
// interesting case: deleting a label takes it off every issue it is on, so the plan has to move
// each one before anything is removed.
const legacy = {
  labels: ['ready', 'working', 'needs-plan', 'needs-operator', 'for-operator', 'quick-build', 'deep-build', 'bug', 'documentation'],
  issues: [
    { number: 11, labels: ['needs-operator', 'deep-build', 'bug'] },
    { number: 12, labels: ['working', 'quick-build'] },
    { number: 13, labels: ['for-operator', 'quick-build', 'documentation'] },
  ],
  boardStatus: ['needs-operator', 'needs-plan', 'ready', 'working', 'for-operator', 'Done'],
}

test('every superseded label is renamed in place, so no issue loses its state or size', () => {
  const plan = planLabelMigration(legacy)
  expect(plan.rename).toEqual([
    { from: 'needs-operator', to: 'waiting-on-operator' },
    { from: 'needs-plan', to: 'planning' },
    { from: 'ready', to: 'queued' },
    { from: 'working', to: 'in-progress' },
    { from: 'for-operator', to: 'ready-to-ship' },
    { from: 'quick-build', to: 'small' },
    { from: 'deep-build', to: 'medium' },
  ])
  // A rename carries the issues with it, so nothing needs transferring and nothing is deleted.
  expect(plan.transfer).toEqual([])
  expect(plan.remove).toEqual([])
  expect(plan.writes).toBe(false)
})

test('a replacement name that already exists is transferred issue by issue, then the old one goes', () => {
  const plan = planLabelMigration({ ...legacy, labels: [...legacy.labels, 'small', 'in-progress'] })
  expect(plan.transfer).toEqual([
    { from: 'working', to: 'in-progress', issues: [12] },
    { from: 'quick-build', to: 'small', issues: [12, 13] },
  ])
  // Only the transferred ones are deleted — and only after their issues carry the new label.
  expect(plan.remove).toEqual(['working', 'quick-build'])
  expect(plan.rename.map((step: { from: string }) => step.from)).not.toContain('working')
})

test('unrelated labels are never touched, and the new set is completed', () => {
  const plan = planLabelMigration(legacy)
  expect(plan.keep).toEqual(['bug', 'documentation'])
  // Renames supply the seven replacements; only the labels no old name maps to are created.
  expect(plan.create).toEqual(['large', 'risky', 'epic', 'research'])
  expect([...plan.rename.map((s: { to: string }) => s.to), ...plan.create].sort()).toEqual([...WORKFLOW_LABELS].sort())
})

test('the board Status options move with the labels instead of being left behind', () => {
  const plan = planLabelMigration(legacy)
  expect(plan.board.rename).toEqual([
    { from: 'needs-operator', to: 'waiting-on-operator' },
    { from: 'needs-plan', to: 'planning' },
    { from: 'ready', to: 'queued' },
    { from: 'working', to: 'in-progress' },
    { from: 'for-operator', to: 'ready-to-ship' },
  ])
  expect(plan.board.create).toEqual([])
  // A size label is not a board state, so it never becomes a Status option.
  expect(plan.board.rename.map((s: { to: string }) => s.to)).not.toContain('small')
})

test('a board missing a state gains it; a repo with no board gets no board steps', () => {
  expect(planLabelMigration({ ...legacy, boardStatus: ['ready', 'Done'] }).board).toEqual({
    rename: [{ from: 'ready', to: 'queued' }],
    create: ['waiting-on-operator', 'planning', 'in-progress', 'ready-to-ship'],
  })
  expect(planLabelMigration(legacy.labels as never).board).toEqual({ rename: [], create: [] })
  expect(planLabelMigration({ ...legacy, boardStatus: [] }).board).toEqual({ rename: [], create: [] })
})

test('a repo already on the new labels migrates to nothing', () => {
  const plan = planLabelMigration({ labels: [...WORKFLOW_LABELS, 'documentation'], issues: [{ number: 1, labels: ['queued'] }] })
  expect(plan).toMatchObject({ rename: [], transfer: [], create: [], remove: [] })
  expect(plan.keep).toEqual([...WORKFLOW_LABELS, 'documentation'])
  expect(planLabelMigration()).toMatchObject({ rename: [], transfer: [], remove: [] })
})

test('no old state name survives in the profile the migration writes', () => {
  const template = readFileSync(new URL('../assets/dev-profile.md.template', import.meta.url), 'utf8')
  const line = /^labels:\s*([^#\n]+)/m.exec(template)![1]!.trim().split(/\s+/)
  expect(line.slice(0, WORKFLOW_STATES.length)).toEqual([...WORKFLOW_STATES])
  expect(template).not.toMatch(/workflow-labels|needs-plan|needs-operator|for-operator/)
})

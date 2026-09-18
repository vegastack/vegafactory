import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { migrationMap, parsePolicy, planLabelMigration, readWorkflowStates, resolveState, resolvePolicy, WORKFLOW_LABELS, WORKFLOW_STATES } from '../scripts/effective-policy.mjs'

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
    transfer: [],
    create: ['waiting-on-operator', 'planning', 'in-progress', 'ready-to-ship'],
    remove: [],
  })
  const none = { rename: [], transfer: [], create: [], remove: [] }
  expect(planLabelMigration(legacy.labels as never).board).toEqual(none)
  expect(planLabelMigration({ ...legacy, boardStatus: [] }).board).toEqual(none)
})

// A board half-migrated by an earlier run carries both names. A rename would collide, so the
// cards move and the stale option goes — otherwise it sits there with its cards forever.
test('a board already carrying both names moves the cards and removes the stale option', () => {
  const plan = planLabelMigration({
    ...legacy,
    boardStatus: ['ready', 'queued', 'working', 'Done'],
    boardItems: [{ id: 'A', status: 'ready' }, { id: 'B', status: 'queued' }, { id: 'C', status: 'ready' }, { id: 'D', status: 'working' }],
  })
  expect(plan.board.transfer).toEqual([{ from: 'ready', to: 'queued', items: ['A', 'C'] }])
  expect(plan.board.remove).toEqual(['ready'])
  // `working` has no replacement on the board yet, so it is renamed and never removed.
  expect(plan.board.rename).toEqual([{ from: 'working', to: 'in-progress' }])
  expect(plan.board.create).toEqual(['waiting-on-operator', 'planning', 'ready-to-ship'])
  expect(plan.writes).toBe(false)
})

test('a board item with no id still transfers, named as null rather than dropped', () => {
  const plan = planLabelMigration({ ...legacy, boardStatus: ['ready', 'queued'], boardItems: [{ status: 'ready' }] })
  expect(plan.board.transfer).toEqual([{ from: 'ready', to: 'queued', items: [null] }])
})

// A repo that renamed its labels through the removed `workflow-labels` knob calls them anything
// at all. Its profile is blocked, so the knob's own line is the only place those names survive.
const custom = {
  profile: 'labels: decide plan go doing review\nworkflow-labels: {"needsOperator":"decide","needsPlan":"plan","ready":"go","working":"doing","forOperator":"review"}   # a comment\n',
  labels: ['decide', 'plan', 'go', 'doing', 'review', 'quick-build', 'bug'],
  issues: [{ number: 21, labels: ['go'] }, { number: 22, labels: ['doing', 'quick-build'] }],
  boardStatus: ['go', 'doing', 'Done'],
  boardItems: [{ id: 'A', status: 'go' }, { id: 'B', status: 'doing' }],
}

test('the configured names from a workflow-labels line are migration input', () => {
  expect(migrationMap(custom.profile)).toMatchObject({
    decide: 'waiting-on-operator', plan: 'planning', go: 'queued', doing: 'in-progress', review: 'ready-to-ship',
    // the former defaults stay in the map, because a repo can carry both
    'needs-operator': 'waiting-on-operator', 'quick-build': 'small',
  })
})

test('a repo on custom names migrates end to end and keeps only what it should', () => {
  const plan = planLabelMigration(custom)
  expect(plan.rename).toEqual([
    { from: 'quick-build', to: 'small' },
    { from: 'decide', to: 'waiting-on-operator' },
    { from: 'plan', to: 'planning' },
    { from: 'go', to: 'queued' },
    { from: 'doing', to: 'in-progress' },
    { from: 'review', to: 'ready-to-ship' },
  ])
  // Every configured name is migrated, so none of them is left in `keep`.
  expect(plan.keep).toEqual(['bug'])
  expect(plan.board.rename).toEqual([{ from: 'go', to: 'queued' }, { from: 'doing', to: 'in-progress' }])
  // The knob goes last, once nothing depends on the names it holds.
  expect(plan.dropKnob).toBe(true)
  expect(JSON.stringify(plan.create)).not.toMatch(/decide|doing|review/)
})

test('without the knob line those names are invisible, which is the bug this fixes', () => {
  const plan = planLabelMigration({ ...custom, profile: '' })
  expect(plan.rename).toEqual([{ from: 'quick-build', to: 'small' }])
  expect(plan.keep).toEqual(['decide', 'plan', 'go', 'doing', 'review', 'bug'])
  expect(plan.dropKnob).toBe(false)
})

test('a malformed or already-migrated knob line adds nothing and never throws', () => {
  for (const profile of ['workflow-labels: {not json\n', 'workflow-labels: []\n', 'workflow-labels: {"ready":"queued"}\n']) {
    expect(migrationMap(profile)).toEqual(migrationMap(''))
  }
  // A configured name that is another state's fixed name would rename one state onto another.
  expect(migrationMap('workflow-labels: {"ready":"in-progress"}\n')).toEqual(migrationMap(''))
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

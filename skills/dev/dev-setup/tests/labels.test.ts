import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { planLabelMigration, readWorkflowStates, resolveState, resolvePolicy, WORKFLOW_LABELS, WORKFLOW_STATES } from '../scripts/effective-policy.mjs'

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

test('one state label resolves; none and several refuse', () => {
  expect(resolveState(['queued', 'medium'])).toEqual({ state: 'queued', blocks: [] })
  for (const labels of [[], ['queued', 'in-progress'], null]) {
    expect(resolveState(labels as string[]).state).toBeNull()
    expect(resolveState(labels as string[]).blocks.length).toBeGreaterThan(0)
  }
})

// The migration an existing repo gets on a dev-setup re-run: what goes, what arrives, and the
// promise that reading it changes nothing.
test('the label migration lists the superseded names and the set that replaces them', () => {
  const plan = planLabelMigration(['ready', 'working', 'needs-plan', 'needs-operator', 'for-operator', 'quick-build', 'bug'])
  expect(plan.remove).toEqual(['ready', 'working', 'needs-plan', 'needs-operator', 'for-operator', 'quick-build'])
  expect(plan.add).toEqual([...WORKFLOW_LABELS])
  expect(plan.keep).toEqual(['bug'])
  expect(plan.writes).toBe(false)
})

test('a repo already on the new labels migrates to nothing', () => {
  const plan = planLabelMigration([...WORKFLOW_LABELS, 'documentation'])
  expect(plan.remove).toEqual([])
  expect(plan.add).toEqual([])
  expect(planLabelMigration().remove).toEqual([])
})

test('no old state name survives in the profile the migration writes', () => {
  const template = readFileSync(new URL('../assets/dev-profile.md.template', import.meta.url), 'utf8')
  const line = /^labels:\s*([^#\n]+)/m.exec(template)![1]!.trim().split(/\s+/)
  expect(line.slice(0, WORKFLOW_STATES.length)).toEqual([...WORKFLOW_STATES])
  expect(template).not.toMatch(/workflow-labels|needs-plan|needs-operator|for-operator/)
})

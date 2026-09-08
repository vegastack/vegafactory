import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolveLabels, resolveState, resolvePolicy } from '../scripts/effective-policy.mjs'

const actual = /^labels:\s*([^#\n]+)/m.exec(readFileSync(new URL('../../../../.vegastack/dev.md', import.meta.url), 'utf8'))![1]!.trim()
const custom = { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }

test('actual complete profile, CSV and reordered defaults retain semantic meaning and scope labels', () => {
  const before = actual.split(/\s+/)
  for (const labels of [actual, before.join(','), [...before].reverse().join(' '), actual + ' extra-scope']) {
    expect(resolveState(['ready', 'full-plan'], resolveLabels(labels))).toEqual({ state: 'ready', blocks: [] })
    expect(resolvePolicy({ repo: 'labels: ' + labels }).ok).toBe(true)
  }
  expect(actual.split(/\s+/)).toEqual(before)
})
test('custom states resolve exactly once; no and mixed states refuse', () => {
  expect(resolveState(['Go'], resolveLabels(custom))).toEqual({ state: 'ready', blocks: [] })
  for (const labels of [[], ['Go', 'Decision']]) {
    expect(resolveState(labels, custom).state).toBeNull()
    expect(resolveState(labels, custom).blocks.length).toBeGreaterThan(0)
  }
})
test('mapping rejects incomplete, duplicate, malformed and ambiguous legacy values', () => {
  for (const value of [{ ...custom, working: 'Go' }, { ready: 'Go' }, { ...custom, other: 'Extra' }, '', 'Decision Plan Go Build Review', actual + ' ready']) expect(() => resolveLabels(value)).toThrow()
})
test('explicit and legacy representations must agree', () => {
  expect(resolvePolicy({ repo: 'labels: ' + actual + '\nworkflow-labels: ' + JSON.stringify(custom) }).ok).toBe(false)
  expect(resolvePolicy({ repo: 'labels: ' + actual + '\nworkflow-labels: ' + JSON.stringify(resolveLabels(undefined)) }).ok).toBe(true)
})

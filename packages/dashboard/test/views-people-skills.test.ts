import { expect, test } from 'bun:test'
import { buildPeopleView, buildPersonView } from '../src/lib/views/people'
import { buildSkillsView } from '../src/lib/views/skills'
import { contextFixture } from './helpers/context'

test('a descriptive legacy lead sees own rows without an explicit scoped admin grant', async () => {
  const view = buildPeopleView({ context: await contextFixture({ month: 'SEP-2026', viewer: 'kmanojkumar', statsPeople: 'on' }) })
  expect(view.gated).toBe(true)
  expect(view.rows.map((r) => r.login)).toEqual(['kmanojkumar'])
  expect(buildPersonView({ context: await contextFixture({ month: 'SEP-2026', viewer: 'kmanojkumar', statsPeople: 'on' }), login: 'dev1' }))
    .toMatchObject({ gate: { allowed: false }, person: null, totals: null })
  const off = buildPeopleView({ context: await contextFixture({ month: 'SEP-2026', viewer: 'kmanojkumar', statsPeople: 'off' }) })
  expect(off.rows.map((r) => r.login)).toEqual(['kmanojkumar'])
})

test('a non-lead sees only themselves; another person refuses with no data; skills roll up', async () => {
  const context = await contextFixture({ month: 'SEP-2026', viewer: 'dev1', statsPeople: 'on' })
  const view = buildPeopleView({ context })
  expect(view.gated).toBe(true)
  expect(view.rows.map((r) => r.login)).toEqual(['dev1'])
  expect(buildPersonView({ context, login: 'kmanojkumar' }))
    .toMatchObject({ gate: { allowed: false }, person: null, totals: null })
  const skills = buildSkillsView({ context, orgSkills: { 'dev-plan': 40 } })
  expect(skills.rows[0]).toMatchObject({ name: 'dev-plan', invocations: 1, triggers: { model: 1 }, outcomes: { 'for-operator': 1 } })
  expect(skills.rows[0]!.costPerInvocation).toBeCloseTo(0.4, 6)
  expect(skills.orgTotals).toEqual({ 'dev-plan': 40 })
})


test.each([
  { name: 'empty dataset', month: 'JAN-1900', viewer: 'kmanojkumar', expected: [] },
  { name: 'only own rows available', month: 'AUG-2026', viewer: 'dev1', expected: ['dev1'] },
  { name: 'anonymous viewer', month: 'SEP-2026', viewer: null, expected: [] },
])('missing canonical whole-org authority stays gated: $name', async ({ month, viewer, expected }) => {
  const context = await contextFixture({ month, viewer, statsPeople: 'on' })
  const view = buildPeopleView({ context })
  expect(view.gated).toBe(true)
  expect(view.rows.map(row => row.login)).toEqual([...expected])
})

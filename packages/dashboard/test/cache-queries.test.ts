import { beforeAll, expect, test } from 'bun:test'
import type { Db } from '../src/lib/cache/build'
import { filterOptions, parseFilters } from '../src/lib/cache/filters'
import { orgTotals, perPerson, perRepo, perSkill } from '../src/lib/cache/queries'
import { fixtureRoom, groups } from './helpers/fixture-room'

let db: Db
beforeAll(async () => { db = (await fixtureRoom()).db })
const f = (p: Record<string, string>) => ({...parseFilters(p, filterOptions(db, groups,null), groups,null),attributedRepos:Object.keys(groups)})

test('options list months newest first; an unknown value falls back before reaching SQL', () => {
  const options = filterOptions(db, groups,null)
  expect(options.months).toEqual(['SEP-2026', 'AUG-2026'])
  expect(options.groups).toEqual(['design', 'dev'])
  expect(f({ month: 'NOPE-1999', harness: "' or 1=1 --" })).toMatchObject({ month: 'SEP-2026', harness: null })
})

test('the month, group and harness filters narrow every aggregate the views read', () => {
  const september = orgTotals(db, f({ month: 'SEP-2026' }))
  expect(september).toMatchObject({ runs: 2, humanTouchpoints: null })
  expect(september.costUsd).toBeCloseTo(1.0, 6)
  expect(orgTotals(db, f({ month: 'AUG-2026' })).runs).toBe(1)
  expect(perRepo(db, f({ month: 'SEP-2026', group: 'dev' })).map((r) => r.repo)).toEqual(['vegastack/vegafactory'])
  expect(perPerson(db, f({ month: 'SEP-2026', harness: 'codex' })).map((p) => p.human)).toEqual(['dev1'])
  const skills = perSkill(db, f({ month: 'SEP-2026' }))
  expect(skills[0]).toMatchObject({ name: 'dev-plan', invocations: 1 })
  expect(skills[0]!.costPerInvocation).toBeCloseTo(0.4, 6)
})

test('the harness filter reaches the skills join without an ambiguous column', () => {
  expect(perSkill(db, f({ month: 'SEP-2026', harness: 'claude' })).map((r) => r.name)).toEqual(['dev-plan'])
  expect(perSkill(db, f({ month: 'SEP-2026', harness: 'codex' }))).toEqual([])
  expect(perSkill(db, f({ month: 'SEP-2026', model: 'fable-5-1' }))).toHaveLength(1)
})

test('explicit empty authorization cannot be widened by clearing ordinary filters', async () => {
  const base=f({month:'SEP-2026'})
  expect(orgTotals(db,{...base,allowedRepos:[]} as typeof base).runs).toBe(0)
  expect(perRepo(db,{...base,allowedRepos:['vegastack/site']} as typeof base)).toEqual([])
  expect(filterOptions(db,groups,[]).repos).toEqual([])
})

test('derived measurements contain only execution records and SQL unknown stays null', async () => {
  const {Database}=await import('bun:sqlite'),{SCHEMA_SQL}=await import('../src/lib/cache/schema')
  const local=new Database(':memory:');local.exec(SCHEMA_SQL)
  try{expect(local.query('select sum(cost_usd) as cost from measurements').get()).toEqual({cost:null})}finally{local.close()}
})

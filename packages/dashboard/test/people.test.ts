import { expect, test } from 'bun:test'
import { canViewPerson, mergePeople, parsePeopleCsv } from '../src/lib/control-room/people'
import { parseRepoGroups } from '../src/lib/control-room/repos'

const people = parsePeopleCsv([
  'login,name,role,slack,timezone,groups',
  'kmanojkumar,MK,lead,U1,Asia/Kolkata,dev',
  'dev1,Dev One,engineer,U2,Asia/Kolkata,dev',
].join('\n'))

test('the fixed headers parse, any other is refused, and a group row overrides an org row', () => {
  expect(people[0]).toMatchObject({ login: 'kmanojkumar', role: 'lead', groups: ['dev'] })
  expect(parsePeopleCsv('name,login\nMK,kmanojkumar')).toEqual([])
  const group = parsePeopleCsv('login,name,role,slack,timezone,groups\ndev1,Dev One,lead,U2,Asia/Kolkata,dev')
  expect(mergePeople(people, group).find((p) => p.login === 'dev1')!.role).toBe('lead')
  expect(parseRepoGroups(['| repo | group | board | owner |', '|---|---|---|---|',
    '| vegastack/vegafactory | dev | Factory | mk |', '| vegastack/site | design | Site | dev1 |',
  ].join('\n'))).toEqual({ 'vegastack/vegafactory': 'dev', 'vegastack/site': 'design' })
})

test('the legacy adapter allows own rows, but descriptive leads do not grant administration', () => {
  expect(canViewPerson({ viewer: 'dev1', subject: 'dev1', people, statsPeople: 'on' }).allowed).toBe(true)
  expect(canViewPerson({ viewer: 'dev1', subject: 'kmanojkumar', people, statsPeople: 'on' })).toEqual({
    allowed: false, reason: 'people-level stats require verified own-data identity or explicitly scoped organization administration',
  })
  expect(canViewPerson({ viewer: null, subject: 'dev1', people, statsPeople: 'on' }).allowed).toBe(false)
  expect(canViewPerson({ viewer: 'kmanojkumar', subject: 'dev1', people, statsPeople: 'on' }).allowed).toBe(false)
  expect(canViewPerson({ viewer: 'kmanojkumar', subject: 'dev1', people, statsPeople: 'off' }).allowed).toBe(false)
})

test('a descriptive legacy lead cannot supply administration or cross-group read authority', () => {
  const group = parsePeopleCsv('login,name,role,slack,timezone,groups\ndev1,Dev One,lead,U2,Asia/Kolkata,design')
  expect(canViewPerson({ viewer: 'dev1', subject: 'kmanojkumar', people: mergePeople(people, group), statsPeople: 'on' }).allowed).toBe(false)
})

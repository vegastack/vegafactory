import { expect, test } from 'bun:test'
import { resolvePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import type { ExportedEvent } from '../../cli/src/stats/types'
import { filterOptions, parseFilters } from '../src/lib/cache/filters'
import { buildPeopleView, buildPersonView } from '../src/lib/views/people'
import { scopePeopleEvents, type PeoplePolicies } from '../src/lib/views/people'
import { buildSkillsView } from '../src/lib/views/skills'
import { contextFixture } from './helpers/context'

test('a descriptive legacy lead receives no rows without current canonical policy', async () => {
  const view = await buildPeopleView({ context: await contextFixture({ month: 'SEP-2026', viewer: 'kmanojkumar', statsPeople: 'on' }) })
  expect(view.gated).toBe(true)
  expect(view.rows.map((r) => r.login)).toEqual([])
  expect(await buildPersonView({ context: await contextFixture({ month: 'SEP-2026', viewer: 'kmanojkumar', statsPeople: 'on' }), login: 'dev1' }))
    .toMatchObject({ gate: { allowed: false }, person: null, totals: null })
  const off = await buildPeopleView({ context: await contextFixture({ month: 'SEP-2026', viewer: 'kmanojkumar', statsPeople: 'off' }) })
  expect(off.rows.map((r) => r.login)).toEqual([])
})

test('missing current people policy refuses both list and detail', async () => {
  const context = await contextFixture({ month: 'SEP-2026', viewer: 'dev1', statsPeople: 'on' })
  const view = await buildPeopleView({ context })
  expect(view.gated).toBe(true)
  expect(view.rows.map((r) => r.login)).toEqual([])
  expect(await buildPersonView({ context, login: 'kmanojkumar' }))
    .toMatchObject({ gate: { allowed: false }, person: null, totals: null })
})


test.each([
  { name: 'empty dataset', month: 'JAN-1900', viewer: 'kmanojkumar', expected: [] },
  { name: 'only own rows available', month: 'AUG-2026', viewer: 'dev1', expected: ['dev1'] },
  { name: 'anonymous viewer', month: 'SEP-2026', viewer: null, expected: [] },
])('missing canonical whole-org authority stays gated: $name', async ({ month, viewer }) => {
  const context = await contextFixture({ month, viewer, statsPeople: 'on' })
  const view = await buildPeopleView({ context })
  expect(view.gated).toBe(true)
  expect(view.rows.map(row => row.login)).toEqual([])
})

function policies(context:Awaited<ReturnType<typeof contextFixture>>,offRepo:string|null=null):PeoplePolicies{
 const authority={schemaVersion:2,locked:{},delegations:[],administration:{orgAdmins:['kmanojkumar'],groupAdmins:{dev:['dev1']},groupAdminCapabilities:{dev:['group.people.read']}}}
 const org='stats: on\nstats-people: on\nstats-export: attributed\n```vsk-policy\n'+JSON.stringify(authority)+'\n```'
 return new Map(Object.keys(context.repoGroups).map(repo=>{
  const result=resolvePolicy({org,repo:repo===offRepo?'stats-export: off':'',identity:{repo,org:'vegastack',group:context.repoGroups[repo],peopleByScope:{org:context.people},repoGroups:context.repoGroups}})
  expect(result.ok).toBe(true)
  return[repo,result.policy]
 }))
}

async function authorizedSkillsContext() {
 const context=await contextFixture({month:'SEP-2026',viewer:'dev1',statsPeople:'on'})
 const allowed=['vegastack/vegafactory'],access={kind:'aggregate' as const},current=policies(context).get(allowed[0]!)!
 const options=filterOptions(context.db,context.repoGroups,allowed,access)
 context.policy={stats:'on',statsPeople:'on',refusal:null,effective:current}
 context.allowedRepos=allowed;context.access=access;context.options=options
 context.filters={...parseFilters({month:'SEP-2026'},options,context.repoGroups,allowed),month:'SEP-2026',allowedRepos:allowed,attributedRepos:allowed,access}
 return context
}

test('explicit valid scoped policy exposes only permitted skill rows and no whole-org rollup',async()=>{
 const context=await authorizedSkillsContext()
 const skills=buildSkillsView({context,orgSkills:{'dev-plan':40}})
 expect(skills.rows).toHaveLength(1)
 expect(skills.rows[0]).toMatchObject({name:'dev-plan',invocations:1,triggers:{model:1},outcomes:{'for-operator':1}})
 expect(skills.rows[0]!.meanAssociatedRunCostUsd).toBeCloseTo(0.4,6)
 expect(skills.orgTotals).toBeNull()
 const denied={...context,allowedRepos:[],filters:{...context.filters,allowedRepos:[],attributedRepos:[]}}
 expect(buildSkillsView({context:denied,orgSkills:{'dev-plan':40}})).toMatchObject({rows:[],orgTotals:null})
})

test('current repository scopes precede SQL totals and separate task/account owner dimensions',async()=>{
 const context=await contextFixture({month:'SEP-2026',viewer:'dev1',statsPeople:'on'})
 const p=policies(context),loadPolicies=async()=>p
 const view=await buildPeopleView({context,loadPolicies})
 expect(view.rows.map(r=>r.login).sort()).toEqual(['dev1','kmanojkumar'])
 expect(view.gated).toBe(true)
 const detail=await buildPersonView({context,login:'kmanojkumar',loadPolicies})
 expect(detail.gate.allowed).toBe(true);expect(detail.totals?.runs).toBe(1)
 const e=(repo:string,taskOwner:string,agentAccountOwner:string):ExportedEvent=>({eventId:crypto.randomUUID(),destination:{host:'github.com',org:'vegastack',repo,controlRoom:'vegastack/control-room'},payload:{schemaVersion:2,recordKind:'execution',utcDay:'2026-09-06',stage:'implement',outcome:'succeeded',taskOwner,agentAccountOwner}})
 const events=[e('vegastack/vegafactory','kmanojkumar','dev1'),e('vegastack/site','kmanojkumar','dev1')]
 expect(scopePeopleEvents(events,context,p,'kmanojkumar','task-owner')).toHaveLength(1)
 expect(scopePeopleEvents(events,context,p,'kmanojkumar','account-owner')).toHaveLength(0)
 expect(scopePeopleEvents(events,context,p,'dev1','account-owner')).toHaveLength(2)
 const off=await buildPersonView({context,login:'kmanojkumar',loadPolicies:async()=>policies(context,'vegastack/vegafactory')})
 expect(off).toMatchObject({gate:{allowed:false},totals:null,stages:[]})
})

test('an authorized empty month is empty rather than unavailable',async()=>{
 const context=await contextFixture({month:'JAN-1900',viewer:'dev1',statsPeople:'on'})
 const view=await buildPeopleView({context,loadPolicies:async()=>policies(context)})
 expect(view.rows).toEqual([]);expect(view.refusal).toBeNull()
})

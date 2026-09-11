import { parsePeopleRegistry, resolvePeopleReadScope } from '../../../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { join } from 'node:path'

import { readOrEmpty } from '../read'

export interface Person {
  login: string
  name: string
  role: string
  slack: string
  timezone: string
  groups: string[]
}

// Fixed CSV parser is shared with policy validation; descriptive fields retain their shape.
export function parsePeopleCsv(text: string): Person[] {
  return parsePeopleRegistry(text).people as Person[]
}

// Layered the way CLAUDE.md and AGENTS.md layer: the nearer file wins. A group row replaces the
// org row for the same login outright rather than merging field by field, so a group can demote
// as well as promote — a half-merged person would be neither file's answer.
export function mergePeople(org: Person[], group: Person[]): Person[] {
  const merged = new Map(org.map((person) => [person.login, person]))
  for (const person of group) merged.set(person.login, person)
  return [...merged.values()]
}

export async function readPeople(controlRoom: string, group: string | null): Promise<Person[]> {
  const org = parsePeopleCsv(await readOrEmpty(join(controlRoom, 'people.csv')))
  if (!group) return org
  return mergePeople(org, parsePeopleCsv(await readOrEmpty(join(controlRoom, 'groups', group, 'people.csv'))))
}

export interface Gate {
  allowed: boolean
  reason: string | null
}

const REFUSAL = 'people-level stats require verified own-data identity or explicitly scoped organization administration'

// Descriptive legacy roles are not admin grants. New callers provide current canonical policy
// plus the exact repository query; older callers can show only the verified local viewer's row.
export function canViewPerson(input: {
  viewer: string | null
  subject: string
  people: Person[]
  statsPeople: 'on' | 'off'
  policy?: Record<string, any>
  administration?: Record<string, any> | null
  repoGroups?: Record<string, string>
  requestedRepos?: string[]
  verifiedViewer?: boolean
}): Gate {
  if (!input.viewer || !input.people.some(person => person.login === input.viewer)) return { allowed: false, reason: REFUSAL }
  if (input.policy) {
    const result = resolvePeopleReadScope({ viewer: { login: input.viewer, verified: input.verifiedViewer === true }, subject: input.subject,
      requestedRepos: input.requestedRepos, administration: input.administration ?? input.policy.administration,
      policy: input.policy, repoGroups: input.repoGroups ?? input.policy.registry.repoGroups })
    // A boolean gate cannot partially filter an already aggregated query. Only authorize it
    // when every explicitly requested repository is permitted; row adapters use the scope API.
    const complete = Array.isArray(input.requestedRepos) && input.requestedRepos.length > 0
      && input.requestedRepos.every(repo => result.allowedRepos.includes(repo))
    return { allowed: result.refusal === null && complete, reason: result.refusal ?? (complete ? null : 'people query needs an exact fully permitted repository scope') }
  }
  return input.viewer === input.subject ? { allowed: true, reason: null } : { allowed: false, reason: REFUSAL }
}

export { resolvePeopleReadScope }

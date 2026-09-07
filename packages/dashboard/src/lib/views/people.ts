import type { PageContext } from '../context'
import { perPerson, perStageForPerson, type Totals } from '../cache/queries'
import { canViewPerson, type Gate, type Person } from '../control-room/people'

export interface PeopleRow extends Totals {
  login: string
  name: string
  role: string
}

export interface PeopleView {
  viewer: string | null
  rows: PeopleRow[]
  /** True unless verified canonical authority permits the whole organization. */
  gated: boolean
}

const describe = (login: string, people: Person[]): { name: string; role: string } => {
  const person = people.find((entry) => entry.login === login)
  return { name: person?.name ?? login, role: person?.role ?? '' }
}

// The gate is applied per row rather than once for the page, so the rule has exactly one home
// (canViewPerson) and the list and the detail page can never disagree about who is visible.
export function buildPeopleView({ context }: { context: PageContext }): PeopleView {
  const viewer = context.env.viewer
  const rows = perPerson(context.db, context.filters)
    .filter((row) => canViewPerson({ viewer, subject: row.human, people: context.people, statsPeople: context.policy.statsPeople }).allowed)
    .map((row) => ({ ...row, login: row.human, ...describe(row.human, context.people) }))
  // This call supplies no verified admin/repository scope to canViewPerson, so its only
  // grant is own-data visibility. Empty or own-only rows do not prove whole-org authority.
  // Managed queries may clear this flag only after canonical scope validation.
  return { viewer, rows, gated: true }
}

export interface PersonView {
  gate: Gate
  person: Person | null
  totals: Totals | null
  stages: Array<{ stage: string } & Totals>
}

// A refused page carries no data at all — not hidden markup, not a zeroed row. What the server
// never assembles cannot leak through a view-source or a stray serialisation.
export function buildPersonView({ context, login }: { context: PageContext; login: string }): PersonView {
  const gate = canViewPerson({
    viewer: context.env.viewer, subject: login, people: context.people, statsPeople: context.policy.statsPeople,
  })
  if (!gate.allowed) return { gate, person: null, totals: null, stages: [] }

  const person = context.people.find((entry) => entry.login === login) ?? null
  const rows = perPerson(context.db, context.filters).filter((row) => row.human === login)
  const totals = rows[0] ?? null
  return {
    gate,
    person,
    totals: totals ? { ...totals } : null,
    stages: perStageForPerson(context.db, context.filters, login),
  }
}

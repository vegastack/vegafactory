import { compareMonths, monthToken } from '../stats/month'
import type { Db } from './build'

export type ReportAccess = {kind:'aggregate'} | {kind:'person';subject:string;dimension:'task-owner'|'account-owner'}
export interface Filters {
  access?: ReportAccess
  month: string
  /** Authorization is independent of display filters; [] denies all, null explicitly permits the org scope. */
  allowedRepos?: string[] | null
  /** Current attributed reporting scope; omitted callers do not acquire identities. */
  attributedRepos?: string[]
  repo: string | null
  group: string | null
  harness: string | null
  model: string | null
  /**
   * The concrete repo scope the month/repo/group choice resolves to, empty when the choice puts
   * no bound on repo at all. Resolving it here is what lets every aggregate keep the `(db, f)`
   * signature the views call: a query never needs repos.md again.
   */
  repos: string[]
}

export interface FilterOptions {
  months: string[]
  repos: string[]
  groups: string[]
  harnesses: string[]
  models: string[]
}

function authorized(repo:string,allowedRepos:string[]|null):boolean{return allowedRepos===null||allowedRepos.includes(repo)}
export function filterOptions(db: Db, repoGroups: Record<string, string>, allowedRepos:string[]|null = [],access:ReportAccess={kind:'aggregate'}): FilterOptions {
  const rows=db.query<{repo:string;month:string;harness:string|null;model:string|null;task_owner:string|null;agent_account_owner:string|null}>(`select repo,month,harness,model,human as task_owner,null as agent_account_owner from runs union select repo,month,harness,model,task_owner,agent_account_owner from measurements`).all().filter(row=>authorized(row.repo,allowedRepos)&&(access.kind==='aggregate'||(access.dimension==='task-owner'?row.task_owner:row.agent_account_owner)===access.subject))
  const activity=access.kind==='person'?db.query<{repo:string;at:string}>(`select json_extract(destination,'$.repo') as repo,case json_extract(payload_json,'$.recordKind') when 'activity' then json_extract(payload_json,'$.activity.occurredAt') else json_extract(payload_json,'$.reworkSnapshot.asOf') end as at from events where (json_extract(payload_json,'$.recordKind')='activity' or json_extract(payload_json,'$.recordKind')='rework-snapshot') and json_extract(payload_json,'$.${access.dimension==='task-owner'?'taskOwner':'agentAccountOwner'}')=?`).all(access.subject).filter(row=>authorized(row.repo,allowedRepos)):db.query<{repo:string;at:string}>(`select repo,occurred_at as at from activity_measurements union select repo,as_of as at from rework_snapshots`).all().filter(row=>authorized(row.repo,allowedRepos))
  const collections=access.kind==='person'?[]:db.query<{repo:string;period:string}>('select repo,period from activity_collections').all().filter(row=>authorized(row.repo,allowedRepos))
  const repos=[...new Set([...rows.map(row=>row.repo),...activity.map(row=>row.repo),...collections.map(row=>row.repo)])].sort()
  return {months:[...new Set([...rows.map(row=>row.month),...activity.map(row=>monthToken(new Date(row.at))),...collections.map(row=>monthToken(new Date(row.period+'-01T00:00:00Z')))])].sort(compareMonths).reverse(),repos,groups:[...new Set(repos.map(repo=>repoGroups[repo]).filter((group):group is string=>Boolean(group)))].sort(),harnesses:[...new Set(rows.map(row=>row.harness).filter((v):v is string=>v!==null))].sort(),models:[...new Set(rows.map(row=>row.model).filter((v):v is string=>v!==null))].sort()}
}

const pick = (value: string | undefined, allowed: string[]): string | null =>
  value !== undefined && allowed.includes(value) ? value : null

// A value the option list does not contain falls back to null and never reaches SQL. That is the
// injection story for the whole data layer: the queries bind parameters as well, but a filter
// that cannot hold an arbitrary string cannot carry one into a query in the first place.
export function parseFilters(
  params: Record<string, string | undefined>,
  options: FilterOptions,
  repoGroups: Record<string, string>,
  allowedRepos:string[]|null = [],
): Filters {
  const group = pick(params.group, options.groups)
  const inGroup = group
    ? Object.entries(repoGroups).filter(([, value]) => value === group).map(([repo]) => repo)
    : null
  let repo = pick(params.repo, options.repos)
  // A repo outside the chosen group is dropped rather than intersected to nothing: the two
  // controls are read as "this group, and within it this repo", so the narrower one loses when
  // they disagree, and the page stays on a row the reader can see.
  if (repo && inGroup && !inGroup.includes(repo)) repo = null
  const repos = repo ? [repo] : (inGroup ?? [])
  return {
    allowedRepos,
    month: pick(params.month, options.months) ?? monthToken(new Date()),
    repo,
    group,
    harness: pick(params.harness, options.harnesses),
    model: pick(params.model, options.models),
    repos,
  }
}

// The WHERE fragment and its bound values, shared by every aggregate. The repo scope is the
// resolved list parseFilters computed; a chosen group holding no repo in the cache yields a
// clause no row satisfies, which is the honest answer rather than a silently unfiltered page.
// Every column is the runs table's, and a query that joins another table passes that table's
// alias so `harness` — which skill_invocations also carries — can never be ambiguous.
export function whereClause(filters: Filters, alias = '',subject?:{login:string;dimension:'task-owner'|'account-owner'}): { sql: string; values: unknown[] } {
  const column = (name: string): string => (alias ? `${alias}.${name}` : name)
  const clauses = [`${column('month')} = ?`]
  if(filters.access?.kind==='person'&&(!subject||subject.login!==filters.access.subject||subject.dimension!==filters.access.dimension))clauses.push('1 = 0')
  const values: unknown[] = [filters.month]
  if(filters.allowedRepos!==null){
    const allowed=filters.allowedRepos??[]
    if(!allowed.length)clauses.push('1 = 0')
    else {clauses.push(`${column('repo')} in (${allowed.map(()=>'?').join(', ')})`);values.push(...allowed)}
  }
  if (filters.group && filters.repos.length === 0) clauses.push('1 = 0')
  else if (filters.repos.length > 0) {
    clauses.push(`${column('repo')} in (${filters.repos.map(() => '?').join(', ')})`)
    values.push(...filters.repos)
  }
  if (filters.harness) {
    clauses.push(`${column('harness')} = ?`)
    values.push(filters.harness)
  }
  if (filters.model) {
    clauses.push(`${column('model')} = ?`)
    values.push(filters.model)
  }
  return { sql: clauses.join(' and '), values }
}

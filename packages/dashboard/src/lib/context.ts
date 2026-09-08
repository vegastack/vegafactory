import { openCache, refreshCache, type Db } from './cache/build'
import { filterOptions, parseFilters, type FilterOptions, type Filters } from './cache/filters'
import { readPeople, type Person } from './control-room/people'
import { readValidatedPolicies, type Policy } from './control-room/policy'
import { readEnv, type ServerEnv } from './env'
import { type Freshness } from './freshness'

export interface PageContext {
  env: ServerEnv
  db: Db
  options: FilterOptions
  filters: Filters
  repoGroups: Record<string, string>
  people: Person[]
  policy: Policy
  freshness: Freshness
  knowledgeWarning?: string | null
}

// One cache handle per process, opened lazily. The refresh below is per request and costs one
// stat per JSONL file; reopening the database per request would cost the file open as well, for
// nothing — the handle is not request state.
let handle: Promise<Db> | null = null
const cache = (file: string): Promise<Db> => (handle ??= openCache(file))

// The only place a page reads the environment. A page that wants data calls this and renders what
// comes back; a page that reached for process.env itself would be a second, undocumented contract.
export async function loadContext(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<PageContext> {
  const result = readEnv(process.env as Record<string, string | undefined>)
  if (!result.ok) {
    throw new Error(`the dashboard server is missing ${result.missing.join(', ')} — it is launched by \`vegafactory dashboard\``)
  }
  const env = result.env

  const db = await cache(env.cacheFile)
  await refreshCache(db, env.controlRoom)

  const validated = await readValidatedPolicies({ settingsPath: env.stateFile, org: env.org, repos: env.repos, now: Date.now() })
  const repoGroups = validated.policy.effective?.registry.repoGroups ?? {}
  const flat: Record<string, string | undefined> = {}
  for (const [key, raw] of Object.entries(searchParams)) flat[key] = Array.isArray(raw) ? raw[0] : raw

  const options = filterOptions(db, repoGroups)
  const filters = parseFilters(flat, options, repoGroups)
  const group = filters.group ?? (filters.repo ? repoGroups[filters.repo] ?? null : null)

  return {
    env,
    db,
    options,
    filters,
    repoGroups,
    people: validated.contentPath && !validated.policy.refusal ? await readPeople(validated.contentPath, group) : [],
    policy: validated.policy,
    knowledgeWarning: validated.knowledgeWarning,
    freshness: validated.freshness,
  }
}

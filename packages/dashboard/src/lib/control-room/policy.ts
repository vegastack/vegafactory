import { resolvePolicy } from '../../../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
import { join } from 'node:path'

import { readOrEmpty } from '../read'

export interface Policy {
  stats: 'on' | 'off'
  statsPeople: 'on' | 'off'
  refusal?: string | null
  effective?: ReturnType<typeof resolvePolicy>['policy']
}

// The same authority parser as runtime/stats. Snapshot validation/time and registry are supplied
// by the snapshot owner; a legacy clone read does not become validated authority by being read.
export async function readPolicy(controlRoom: string, group: string | null, context: {
  identity?: Record<string, unknown>
  freshness?: Record<string, unknown>
} = {}): Promise<Policy> {
  const org = await readOrEmpty(join(controlRoom, 'org.md'))
  const groupText = group ? await readOrEmpty(join(controlRoom, 'groups', group, 'group.md')) : ''
  const result = resolvePolicy({ org, group: groupText, identity: { group, ...context.identity }, freshness: { configured: true, ...context.freshness } })
  return {
    stats: result.ok && result.policy.values.stats === 'on' ? 'on' : 'off',
    statsPeople: result.ok && result.policy.values['stats-people'] === 'on' ? 'on' : 'off',
    refusal: result.ok ? null : result.blocks.join('; '), effective: result.policy,
  }
}

import { getPolicySnapshot, readSettingsFile } from '../../../../cli/src/control-room.ts'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export async function readValidatedPolicies(input: { settingsPath: string; org: string; repos: string[]; group?: string | null; now: number }) {
  const unavailable = (reason: string) => ({ policy: { stats: 'off', statsPeople: 'off', refusal: reason } as Policy,
    snapshots: [] as Awaited<ReturnType<typeof getPolicySnapshot>>[], contentPath: null as string | null,
    freshness: { syncedAt: null as string | null, ageMinutes: null as number | null, label: `policy unavailable: ${reason}`, offline: false }, knowledgeWarning: 'Optional knowledge is unavailable; it cannot authorize work.' })
  try {
    const settings = await readSettingsFile(input.settingsPath)
    const registered = settings.settings.repos
    if (!Array.isArray(registered)) return unavailable('no confirmed local repository profiles')
    const selected = input.repos.length ? input.repos : Object.keys(settings.controlRooms[input.org]?.snapshots ?? {})
    const snapshots: Awaited<ReturnType<typeof getPolicySnapshot>>[] = []
    for (const repo of selected) {
      const row = registered.find((row: { repo?: string; org?: string; path?: string }) => row.repo === repo && row.org === input.org)
      if (!row || typeof row.path !== 'string' || !isAbsolute(row.path)) return unavailable(`missing absolute local profile for ${repo}`)
      const devMd = await readFile(join(row.path, '.vegastack/dev.md'), 'utf8')
      const value = await getPolicySnapshot(input.org, repo, input.now, { settingsPath: input.settingsPath, devMd })
      if (!input.group || value.snapshot?.group === input.group) snapshots.push(value)
    }
    if (!snapshots.length) return unavailable('no matching per-repository snapshot')
    const invalid = snapshots.find(row => row.state === 'unavailable')
    if (invalid) return unavailable(invalid.reason ?? 'snapshot provenance unavailable')
    const first = snapshots[0]!
    if (snapshots.some(row => row.snapshot!.sourceCommit !== first.snapshot!.sourceCommit || row.snapshot!.contentPath !== first.snapshot!.contentPath)) return unavailable('repository snapshots do not share a consistent immutable source')
    const stale = snapshots.some(row => row.state !== 'fresh')
    const ageSeconds = Math.max(...snapshots.map(row => row.ageSeconds ?? 0))
    return {
      policy: { stats: !stale && snapshots.every(row => row.policy.policy.values.stats === 'on') ? 'on' : 'off',
        statsPeople: !stale && snapshots.every(row => row.policy.policy.values['stats-people'] === 'on') ? 'on' : 'off',
        refusal: stale ? 'mandatory policy stale: validated refresh required' : null, effective: first.policy.policy } as Policy,
      snapshots, contentPath: first.snapshot!.contentPath,
      freshness: { syncedAt: first.snapshot!.validatedAt, ageMinutes: Math.floor(ageSeconds / 60), label: `policy ${stale ? 'stale' : 'fresh'} · validated ${Math.floor(ageSeconds / 60)}m ago`, offline: false },
      knowledgeWarning: stale ? `Optional knowledge from ${first.snapshot!.sourceCommit} (${first.snapshot!.validatedAt}) is stale and cannot authorize work.` : null,
    }
  } catch (error) { return unavailable((error as Error).message) }
}

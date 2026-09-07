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

import { readEnv } from '@/lib/env'
import { cacheReadiness, directoryWithoutLinks } from '@/lib/cache/build'

export const dynamic = 'force-dynamic'

// Data can be unavailable on first launch. Readiness proves the selected process and safe
// namespace; it never turns a missing snapshot into a launcher timeout.
export async function GET(): Promise<Response> {
  const result = readEnv(process.env as Record<string, string | undefined>)
  if (!result.ok) return Response.json({ ok: false }, { status: 503 })
  const env = result.env
  try { await directoryWithoutLinks(env.cacheFile) }
  catch { return Response.json({ ok: false }, { status: 503 }) }
  return Response.json({ ok: true, org: env.org, version: env.version, instanceId: env.instanceId,
    cacheSchema: env.cacheSchema, ...cacheReadiness(env.cacheFile, env.org) })
}

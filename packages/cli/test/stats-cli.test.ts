import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeRecord } from '../src/stats/record.ts'
import { appendRecord, listOutbox } from '../src/stats/outbox.ts'
import { parseStatsArgs, runStats, type StatsDeps } from '../src/stats/cli.ts'

import { resolvePolicy } from '../../../skills/dev/dev-setup/scripts/effective-policy.mjs'
const effectiveFor=(repo:string)=>resolvePolicy({org:'stats: on\nstats-people: on\nstats-export: attributed\n```vsk-policy\n'+JSON.stringify({schemaVersion:2,administration:{orgAdmins:['kmanojkumar'],groupAdmins:{},groupAdminCapabilities:{}}})+'\n```',identity:{repo,org:'vegastack',group:'dev',peopleByScope:{org:[{login:'kmanojkumar',groups:['dev']},{login:'someone-else',groups:['dev']}]},repoGroups:{'vegastack/vegafactory':'dev'}}}).policy
const policy = { enabled: true, people: true, source: 'org' as const, refusal: null }
const deps = async (): Promise<{ lines: string[]; deps: StatsDeps }> => {
  const lines: string[] = []
  return {
    lines,
    deps: {
      home: await mkdtemp(join(tmpdir(), 'vsk-cli-')), cloneRoot: await mkdtemp(join(tmpdir(), 'vsk-cli-clone-')),
      viewerVerified:true,effectivePolicy:effectiveFor('vegastack/vegafactory'),readGh:async()=>{throw Error('offline fixture')},
      hostname: 'mini', ghUser: 'kmanojkumar', login: 'kmanojkumar', isLead: false, policy,
      repo: 'vegastack/vegafactory',
      git: async () => ({ code: 0, stdout: '', stderr: '' }), gh: async () => ({}), readStdin: async () => '{}',
      readTranscript: async () => [],
      now: () => new Date('2026-09-03T10:00:00.000Z'), log: (line: string) => { lines.push(line) },
    },
  }
}

describe('parseStatsArgs', () => {
  test('defaults to showing this repo', () => {
    expect(parseStatsArgs([])).toMatchObject({ verb: 'show', scope: 'repo', since: null, json: false, commit: false })
  })
  test('reads the scope flags, the month window, and the record source', () => {
    expect(parseStatsArgs(['--org', '--since', 'SEP-2026', '--json'])).toMatchObject({ scope: 'org', since: 'SEP-2026', json: true })
    expect(parseStatsArgs(['skills'])).toMatchObject({ verb: 'show', scope: 'skills' })
    expect(parseStatsArgs(['record', '--source', 'claude-session-end'])).toMatchObject({ verb: 'record', source: 'claude-session-end' })
    expect(parseStatsArgs(['push', '--commit'])).toMatchObject({ verb: 'push', commit: true })
  })
  test('rejects a malformed month and an unknown source', () => {
    expect(() => parseStatsArgs(['--since', 'Sept-26'])).toThrow(/MON-YYYY/)
    expect(() => parseStatsArgs(['record', '--source', 'hermes'])).toThrow(/--source/)
  })
  test('two scopes at once is an error naming the conflict', () => {
    expect(() => parseStatsArgs(['--repo', '--org'])).toThrow(/one of/i)
  })
})

test('stats record with the policy off writes nothing and exits 0', async () => {
  const { deps: base } = await deps()
  const code = await runStats(parseStatsArgs(['record', '--source', 'codex-session-end']), {
    ...base, policy: { enabled: false, people: false, source: 'org', refusal: null },
    readStdin: async () => JSON.stringify({ session_id: 'sess-x', cwd: '/repo' }),
  })
  expect(code).toBe(0)
  expect(await listOutbox(base.home)).toEqual([])
})

test('stats record files one record per interactive session end', async () => {
  const { deps: base } = await deps()
  const code = await runStats(parseStatsArgs(['record', '--source', 'codex-session-end']), {
    ...base, readStdin: async () => JSON.stringify({ session_id: 'sess-y', cwd: '/repo/.vegastack/.worktrees/121-statistics' }),
  })
  expect(code).toBe(0)
  const batches = await listOutbox(base.home)
  expect(batches).toHaveLength(1)
  expect(batches[0]!.records[0]).toMatchObject({ session_id: 'sess-y', mode: 'interactive', harness: 'codex', issue: 121 })
})

test('a skill hook accumulates into the session sidecar, not the outbox', async () => {
  const { deps: base } = await deps()
  const code = await runStats(parseStatsArgs(['record', '--source', 'claude-post-tool']), {
    ...base, readStdin: async () => JSON.stringify({ session_id: 'sess-z', tool_name: 'Skill', tool_input: { skill: 'dev-architect' } }),
  })
  expect(code).toBe(0)
  expect(await listOutbox(base.home)).toEqual([])
})

test('a non-lead asking for another person is refused with the reason and exit 2', async () => {
  const { lines, deps: base } = await deps()
  const code = await runStats({ ...parseStatsArgs(['--me']), scope: 'me' }, { ...base, login: 'unconfirmed', isLead: false })
  expect(code).toBe(2)
  expect(lines.join('\n')).toContain('privacy-read-scope-refused')
})

test('unparseable hook input is a refusal, never a partial record', async () => {
  const { deps: base } = await deps()
  const code = await runStats(parseStatsArgs(['record', '--source', 'claude-session-end']), { ...base, readStdin: async () => 'not json' })
  expect(code).toBe(2)
  expect(await listOutbox(base.home)).toEqual([])
})

test('push is a dry run until --commit', async () => {
  const { lines, deps: base } = await deps()
  const calls: string[][] = []
  const code = await runStats(parseStatsArgs(['push']), { ...base, git: async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' } } })
  expect(code).toBe(0)
  expect(calls).toEqual([])
  expect(lines.join('\n')).toContain('dry run')
})

// --- reading the control room ------------------------------------------------------------

const seed = async (cloneRoot: string, month: string, lines: object[]) => {
  const dir = join(cloneRoot, 'stats/vegastack__vegafactory', month)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'mini.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}
const row = (over: Record<string, unknown>) => normalizeRecord({
  repo: 'vegastack/vegafactory', ts: '2026-09-03T10:00:00.000Z', issue: 121, stage: 'implement',
  harness: 'claude', model: 'fable-5.1', outcome: 'complete', duration_s: 60, cost_usd: 1,
  human: 'kmanojkumar', tokens: { in: 10, out: 5, cache_read: 0, cache_write: 0 }, ...over,
})

test('--me shows only the subject\'s own runs, not the whole repo', async () => {
  const { lines, deps: base } = await deps()
  await seed(base.cloneRoot, 'SEP-2026', [row({}), row({ human: 'someone-else', issue: 999, cost_usd: 50 })])
  const code = await runStats(parseStatsArgs(['--me', '--json']), base)
  expect(code).toBe(0)
  const summary = JSON.parse(lines.join(''))
  expect(summary.runs).toBe(1)
  expect(summary.by_stage.implement.cost_usd).toBe(1)
})

test('--since totals every month in the window rather than printing one of them', async () => {
  const { lines, deps: base } = await deps()
  await seed(base.cloneRoot, 'SEP-2026', [row({})])
  await seed(base.cloneRoot, 'OCT-2026', [row({ ts: '2026-10-01T00:00:00.000Z' })])
  await seed(base.cloneRoot, 'AUG-2026', [row({ ts: '2026-08-01T00:00:00.000Z' })])
  const code = await runStats(parseStatsArgs(['--repo', '--since', 'SEP-2026', '--json']), base)
  expect(code).toBe(0)
  const summary = JSON.parse(lines.join(''))
  expect(summary.runs).toBe(2)
  expect(summary.month).toBe('SEP-2026…OCT-2026')
})

test('legacy dry-run push refuses export and names explicit migration', async () => {
  const { lines, deps: base } = await deps()
  const originalPath = await appendRecord(base.home, row({}), 'mini')
  const originalBytes = await readFile(originalPath)
  expect(await runStats(parseStatsArgs(['push']), base)).toBe(2)
  expect(lines.join('\n')).toContain('legacy-spool-requires-explicit-migration')
  expect(await readFile(originalPath)).toEqual(originalBytes)
  expect(await listOutbox(base.home)).toHaveLength(1)
})

// --- the people gate on every scope --------------------------------------------------------

test('--org and --repo do not elevate a legacy lead into scoped administration', async () => {
  const { lines, deps: base } = await deps()
  await seed(base.cloneRoot, 'SEP-2026', [row({}), row({ human: 'someone-else', issue: 999, cost_usd: 50 })])
  expect(await runStats(parseStatsArgs(['--org', '--json']), { ...base, isLead: false })).toBe(0)
  expect(JSON.parse(lines.join('')).people).toBeNull()
  lines.length = 0
  expect(await runStats(parseStatsArgs(['--repo', '--json']), { ...base, isLead: false })).toBe(0)
  expect(JSON.parse(lines.join('')).people).toBeNull()
  lines.length = 0
  expect(await runStats(parseStatsArgs(['--org', '--json']), { ...base, isLead: true })).toBe(0)
  expect(JSON.parse(lines.join('')).people).toBeNull()
})

test('regenerated metric v2 summaries separate historical legacy runs and unavailable task evidence', async () => {
  const { deps: base } = await deps()
  await seed(base.cloneRoot, 'SEP-2026', [row({}), row({ human: 'someone-else', issue: 999 })])
  expect(await runStats(parseStatsArgs(['rollup', '--since', 'SEP-2026']), base)).toBe(1)
  const repo = JSON.parse(await readFile(join(base.cloneRoot, 'stats/vegastack__vegafactory/SEP-2026.summary.json'), 'utf8'))
  expect(repo.metricVersion).toBe(2)
  expect(repo.legacy.people).toBeNull()
  expect(repo.legacy.runs).toBe(2)
  expect(repo.runs).toBe(0)
  expect(repo.taskActivity.mergedIssues).toBeNull()
})

// --- lead and cycle time at rollup ----------------------------------------------------------

const apiTimeline = [
  { event: 'labeled', label: { name: 'ready' }, created_at: '2026-09-01T00:00:00.000Z' },
  { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-09-01T12:00:00.000Z' },
  { event: 'closed', created_at: '2026-09-03T00:00:00.000Z' },
]

test('legacy close timelines remain historical audit data and never become v2 merged completion', async () => {
  const { lines, deps: base } = await deps()
  await seed(base.cloneRoot, 'SEP-2026', [row({})])
  const path=join(base.cloneRoot,'stats/vegastack__vegafactory/SEP-2026.timeline.json')
  const bytes=JSON.stringify(apiTimeline)
  await writeFile(path,bytes)
  expect(await runStats(parseStatsArgs(['rollup','--json']),base)).toBe(1)
  expect(await readFile(path,'utf8')).toBe(bytes)
  const result=JSON.parse(lines.at(-1)!)
  expect(result.report.repos[0].taskActivity.mergedIssues).toBeNull()
})

test('a rollup that cannot reach gh still writes the summaries, keeps an older timeline, and exits 1 naming the gap', async () => {
  const { lines, deps: base } = await deps()
  await seed(base.cloneRoot, 'SEP-2026', [row({})])
  const stale = join(base.cloneRoot, 'stats/vegastack__vegafactory/SEP-2026.timeline.json')
  await writeFile(stale, JSON.stringify([{ issue: 121, event: 'created', label: null, created_at: '2026-09-01T00:00:00.000Z' }, { issue: 121, event: 'closed', label: null, created_at: '2026-09-02T00:00:00.000Z' }]))
  expect(await runStats(parseStatsArgs(['rollup', '--since', 'SEP-2026']), { ...base, gh: async () => { throw new Error('HTTP 403: forbidden') } })).toBe(1)
  expect(await readFile(stale, 'utf8')).toContain('"closed"')
  const summary = JSON.parse(await readFile(join(base.cloneRoot, 'stats/vegastack__vegafactory/SEP-2026.summary.json'), 'utf8'))
  expect(summary.taskActivity.mergedIssues).toBeNull()
  expect(lines.join('\n')).toContain('unavailable')
})

test('a policy refusal prevents reading hook input and any capture or export', async () => {
  const { deps: base } = await deps()
  let effects = 0
  const denied = { ...base, policy: { ...policy, refusal: 'org delegation required' }, readStdin: async () => { effects++; return '{}' }, git: async () => { effects++; return { code: 0, stdout: '', stderr: '' } } }
  expect(await runStats(parseStatsArgs(['record', '--source', 'codex-session-end']), denied)).toBe(2)
  expect(await runStats(parseStatsArgs(['push', '--commit']), denied)).toBe(2)
  expect(effects).toBe(0)
  expect(await listOutbox(base.home)).toEqual([])
})

test('explicit group read scope filters individual records before organization totals', async () => {
  const { resolvePolicy } = await import('../../../skills/dev/dev-setup/scripts/effective-policy.mjs')
  const { deps: base, lines } = await deps()
  const effective = resolvePolicy({ org: 'stats-people: on\nstats-export: attributed\n```vsk-policy\n' + JSON.stringify({ schemaVersion: 2, administration: { orgAdmins: ['owner'], groupAdmins: { dev: ['reader'] }, groupAdminCapabilities: { dev: ['group.people.read'] } } }) + '\n```', identity: { org: 'vegastack', repo: base.repo, group: 'dev', peopleByScope: { org: [{ login: 'owner', groups: ['dev'] }, { login: 'reader', groups: ['dev'] }, { login: 'person', groups: ['dev', 'design'] }] }, repoGroups: { 'vegastack/vegafactory': 'dev', 'vegastack/design': 'design' } } }).policy
  await seed(base.cloneRoot, 'SEP-2026', [row({ human: 'person', duration_s: 10 }), row({ human: 'person', repo: 'vegastack/design', duration_s: 900 })])
  expect(await runStats(parseStatsArgs(['--org', '--json']), { ...base, login: 'reader', ghUser: 'reader', viewerVerified: true, effectivePolicy: effective })).toBe(0)
  const summary = JSON.parse(lines.join(''))
  expect(summary.runs).toBe(1)
  expect(summary.by_stage.implement.duration_s).toBe(10)
  expect(summary.people).toBeNull()
})

test('CLI requester comes from verified GitHub context, not operators prose or claimed login', async () => {
  const { buildStatsDeps, isLeadIn } = await import('../src/stats/cli.ts')
  const home = await mkdtemp(join(tmpdir(), 'policy-identity-'))
  const cwd = join(home, 'app')
  await mkdir(join(cwd, '.vegastack'), { recursive: true })
  await writeFile(join(cwd, '.vegastack', 'dev.md'), 'repo: acme/app\noperators: owner\nstats: on')
  const verified = await buildStatsDeps(home, cwd, () => {}, async () => ({ login: 'member', id: 123 }))
  expect(verified.login).toBe('member')
  expect(verified.viewerVerified).toBe(true)
  expect(verified.isLead).toBe(false)
  const unavailable = await buildStatsDeps(home, cwd, () => {}, async () => ({ login: 'owner' }))
  expect(unavailable.login).toBe('')
  expect(unavailable.viewerVerified).toBe(false)
  expect(isLeadIn('login,role\nmember,not-a-lead', 'member')).toBe(false)
})

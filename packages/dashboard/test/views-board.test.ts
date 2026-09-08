import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { acrossRepos } from '../src/lib/live/github'
import { buildBoardView } from '../src/lib/views/board'
import { buildDispatcherView } from '../src/lib/views/dispatcher'
import { contextFixture } from './helpers/context'

const now = Date.parse('2026-09-03T12:00:00.000Z')
const issue = (n: number, label: string) => ({ number: n, title: `#${n}`, labels: [label], assignees: [], updatedAt: '2026-09-03T10:00:00Z', url: `https://x/${n}`, repo: 'vegastack/vegafactory', nodeId: `I_${n}` })
const report = {
  dispatcher: { running: true, pid: 4242, lastTick: '2026-09-03T11:59:00.000Z', interval: 120 },
  repos: [{ workflow: { repo: 'vegastack/vegafactory', policyDigest: 'a'.repeat(64), observedAt: new Date(now).toISOString(), complete: true, labelMap: { needsOperator: 'needs-operator', needsPlan: 'needs-plan', ready: 'ready', working: 'working', forOperator: 'for-operator' }, blocks: [], issues: [{number:122,nodeId:'I_122',labelsDigest:createHash('sha256').update(JSON.stringify(['needs-plan'])).digest('hex'),state:'needsPlan' as const,blocks:[]},{number:121,nodeId:'I_121',labelsDigest:createHash('sha256').update(JSON.stringify(['ready'])).digest('hex'),state:'ready' as const,blocks:[]}] }, repo: 'vegastack/vegafactory', dispatch: 'local', board: { needsPlan: 1, ready: 2, working: 0, forOperator: 3 }, worktrees: [{ path: '/w/122', branch: 'feat/122', issue: 122, state: 'clean' }], runs: [] }],
}
const live = { ok: true as const, data: report }

test('columns follow the five workflow states; worktrees and health come from status', async () => {
  const context = await contextFixture({ month: 'SEP-2026' })
  const view = buildBoardView({
    context, now, issues: { ok: true, data: [issue(122, 'needs-plan'), issue(121, 'ready')] },
    pulls: { ok: true, data: [] }, status: live,
  })
  expect(view.columns.map((c) => c.label)).toEqual(['needs-operator', 'needs-plan', 'ready', 'working', 'for-operator'])
  expect(view.columns[1]!.issues.map((i) => i.number)).toEqual([122])
  expect(view.worktrees).toHaveLength(1)
  expect(view.freshness.offline).toBe(false)
  expect(view.reasons).toEqual([])
  expect(buildDispatcherView({ context, now, status: live })).toMatchObject({ running: true, pid: 4242, interval: 120 })
})

test('a failed live source sets offline, names the reason, and keeps the page usable', async () => {
  const context = await contextFixture({ month: 'SEP-2026' })
  const down = { ok: false as const, reason: 'GitHub returned HTTP 503 for vegastack/vegafactory' }
  const view = buildBoardView({ context, now, issues: down, pulls: down, status: live })
  expect(view.freshness.offline).toBe(true)
  expect(view.reasons).toHaveLength(2)
  expect(view.columns.every((c) => c.issues.length === 0)).toBe(true)
  expect(view.worktrees).toHaveLength(1)
  const blind = buildDispatcherView({ context, now, status: { ok: false, reason: 'no vegafactory binary was passed to the dashboard' } })
  expect(blind).toMatchObject({ running: false, reasons: ['no vegafactory binary was passed to the dashboard'] })
  expect(blind.freshness.offline).toBe(true)
})

test('one repo failing keeps every other repo\'s rows and names every failure', async () => {
  const read = async ({ repo }: { repo: string; token: string | null }) => (repo.endsWith('/private')
    ? { ok: false as const, reason: `GitHub returned HTTP 404 for ${repo}` }
    : { ok: true as const, data: [issue(Number(repo.length), 'ready')] })
  const partial = await acrossRepos(['a/ok', 'b/private', 'c/ok', 'd/private'], null, read)
  expect(partial.live.ok).toBe(true)
  if (!partial.live.ok) throw new Error('unreachable')
  expect(partial.live.data).toHaveLength(2)
  expect(partial.reasons).toEqual(['GitHub returned HTTP 404 for b/private', 'GitHub returned HTTP 404 for d/private'])
  const none = await acrossRepos(['b/private'], null, read)
  expect(none.live).toEqual({ ok: false, reason: 'GitHub returned HTTP 404 for b/private' })
  expect(none.reasons).toEqual(['GitHub returned HTTP 404 for b/private'])
  expect(await acrossRepos([], null, read)).toEqual({ live: { ok: false, reason: 'no repos were passed to the dashboard' }, reasons: ['no repos were passed to the dashboard'], repositories: [] })

  const context = await contextFixture({ month: 'SEP-2026' })
  const view = buildBoardView({ context, now, issues: partial.live, pulls: { ok: true, data: [] }, status: live, warnings: partial.reasons })
  expect(view.columns.at(-1)!.label).toBe('Unresolved')
  expect(view.columns.at(-1)!.issues).toHaveLength(2)
  expect(view.freshness.offline).toBe(true)
  expect(view.reasons).toEqual(expect.arrayContaining(partial.reasons))
  expect(view.reasons.join()).toContain('workflow identity missing')
})

test('142 reproduction: partial repository observation stays explicit when it has no matching rows', async () => {
  const context = await contextFixture({ month: 'SEP-2026' })
  const view = buildBoardView({ context, now, issues: { ok: true, data: [] }, pulls: { ok: true, data: [] }, status: live,
    issueRepositories: [{ repo: 'a/b', complete: false, reason: 'GitHub returned HTTP 403 for a/b', observedAt: '2026-09-03T12:00:00.000Z' }],
    pullRepositories: [{ repo: 'a/b', complete: true, reason: null, observedAt: '2026-09-03T12:00:00.000Z' }],
  })
  expect(view.issuesComplete).toBe(false)
  expect(view.pullsComplete).toBe(true)
  expect(view.repositories).toEqual([{ repo: 'a/b', complete: false, reasons: ['GitHub returned HTTP 403 for a/b'], observedAt: '2026-09-03T12:00:00.000Z' }])
})

test('142 actual page renders successful and partial repositories without false empty text or repeated alerts', async () => {
  const { spawnSync } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const script = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { fixtureRoom } from './test/helpers/fixture-room.ts';
    globalThis.React = React;
    const {root} = await fixtureRoom();
    Object.assign(process.env, {
      VEGAFACTORY_CONTROL_ROOM: root, VEGAFACTORY_CACHE: root + '/page-cache.db',
      VEGAFACTORY_ORG: 'a', VEGAFACTORY_STATE: root + '/factory.json',
      VEGAFACTORY_REPOS: 'a/ok,b/fail', VEGAFACTORY_GH_TOKEN: '', VEGAFACTORY_BIN: '',
      VEGAFACTORY_VIEWER: '',
    });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      const path = new URL(url);
      if(path.pathname.includes('/b/fail/')) return new Response('denied',{status:403});
      if(path.pathname.endsWith('/pulls')) return new Response('[]');
      if(path.searchParams.get('page') === '2') return new Response('denied',{status:403});
      return new Response(JSON.stringify([{id:1,node_id:'I1',number:1,title:'Visible successful page',labels:[{name:'ready'}],assignees:[],html_url:'https://github.com/a/ok/issues/1'}]),{headers:{link:'<https://api.github.com/repos/a/ok/issues?page=2>; rel="next"'}});
    };
    const Page = (await import('./src/app/board/page.tsx')).default;
    const html = renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
    console.log(JSON.stringify({html,calls}));
  `
  const child = spawnSync(process.execPath, ['--eval', script], { cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000 })
  expect(child.status).toBe(0)
  if (child.status !== 0) throw new Error(child.stderr)
  const result = JSON.parse(child.stdout.trim()) as { html: string; calls: string[] }
  expect(result.html).toContain('Visible successful page')
  expect(result.html).toContain('a/ok: Incomplete')
  expect(result.html).toContain('b/fail: Incomplete')
  expect(result.html).toContain('GitHub returned HTTP 403 for a/ok')
  expect(result.html).toContain('Issue list incomplete.')
  expect(result.html).toContain('Pull request list incomplete.')
  expect(result.html).not.toContain('No open pull requests.')
  expect(result.html).not.toContain('role="alert"')
  expect(result.html).not.toContain('aria-live=')
  expect(result.calls).toHaveLength(5)
})


test('141 board joins two custom maps by repository/node/digest; conflicts and stale rows stay visible once', async () => {
  const context = await contextFixture({ month: 'SEP-2026' })
  const maps = [
    { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' },
    { needsOperator: 'Decide', needsPlan: 'Sketch', ready: 'Start', working: 'Making', forOperator: 'Inspect' },
  ]
  const rows = maps.map((map, i) => ({ ...issue(i + 1, map.ready), repo: 'acme/r' + i }))
  const snapshots = rows.map((row, i) => ({ ...report.repos[0]!, repo: row.repo, workflow: {
    repo: row.repo, policyDigest: 'b'.repeat(64), observedAt: new Date(now).toISOString(), complete: true,
    labelMap: maps[i]!, blocks: [], issues: [{ number: row.number, nodeId: row.nodeId,
      labelsDigest: createHash('sha256').update(JSON.stringify(row.labels)).digest('hex'), state: 'ready' as const, blocks: [] }],
  } }))
  const render = (repos = snapshots, data = rows) => buildBoardView({ context, now, issues: { ok: true, data }, pulls: { ok: true, data: [] }, status: { ok: true, data: { ...report, repos } } })
  expect(render().columns[2]!.issues).toHaveLength(2)
  expect(render().issuesComplete).toBe(true)
  const changed = render(snapshots, [{ ...rows[0]!, labels: ['Go', 'Decision'] }, rows[1]!])
  expect(changed.columns.at(-1)!.issues.map(row => row.number)).toEqual([1])
  expect(changed.reasons.join()).toContain('labels changed')
  snapshots[0]!.workflow.observedAt = '2026-09-01T00:00:00Z'
  expect(render().reasons.join()).toContain('stale')
  snapshots[0]!.workflow.observedAt = new Date(now).toISOString()
  const conflict = snapshots[0]!.workflow.issues[0]!
  Object.assign(conflict, { state: null, blocks: ['conflicting state labels: Go, Decision'] })
  expect(render().columns.flatMap(column => column.issues).map(row => row.number).sort()).toEqual([1, 2])
  expect(render().reasons.join()).toContain('conflicting')
  const missing = buildBoardView({ context, now, issues: { ok: true, data: rows }, pulls: { ok: true, data: [] }, status: { ok: true, data: { ...report, repos: [] } } })
  expect(missing.columns.at(-1)!.label).toBe('Unresolved')
  expect(missing.columns.at(-1)!.issues).toHaveLength(2)
})

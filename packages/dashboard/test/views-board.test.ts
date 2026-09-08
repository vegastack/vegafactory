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
  expect(blind).toMatchObject({ running: null, reasons: ['no vegafactory binary was passed to the dashboard'] })
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
    import { dashboardCacheNamespace } from '../cli/src/dashboard.ts';
    import { loadSnapshotPolicy } from '../../skills/dev/dev-setup/scripts/effective-policy.mjs';
    import { readValidatedPolicies } from './src/lib/control-room/policy.ts';
    import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
    import { execFileSync } from 'node:child_process';
    globalThis.React = React;
    const fixture = await fixtureRoom();
    const root = await realpath(fixture.root);
    const home = await realpath(await mkdtemp('/tmp/vf-board-page-'));
    const code = {'a/ok': home + '/code-ok', 'a/fail': home + '/code-fail'};
    await mkdir(code['a/ok'] + '/.vegastack', {recursive:true});
    await mkdir(code['a/fail'] + '/.vegastack', {recursive:true});
    await mkdir(root + '/groups/dev', {recursive:true});
    const profile = 'repo: a/ok\\ncontrol-room: a/room#dev\\n';
    const authority = {schemaVersion:2,locked:{},delegations:[],administration:{orgAdmins:['robot'],groupAdmins:{dev:[]},groupAdminCapabilities:{dev:[]}}};
    await writeFile(code['a/ok'] + '/.vegastack/dev.md', profile);
    await writeFile(code['a/fail'] + '/.vegastack/dev.md', profile.replace('a/ok','a/fail'));
    await writeFile(root + '/org.md', 'stats: on\\nstats-people: on\\nstats-export: attributed\\n\`\`\`vsk-policy\\n' + JSON.stringify(authority) + '\\n\`\`\`\\n');
    await writeFile(root + '/groups/dev/group.md', 'review: subagent\\n');
    await writeFile(root + '/repos.md', '| repo | group | owner | repository-id |\\n|---|---|---|---|\\n| a/ok | dev | robot | R_ok |\\n| a/fail | dev | robot | R_fail |\\n');
    await writeFile(root + '/people.csv', 'login,name,role,slack,timezone,groups\\nrobot,Robot,member,,UTC,dev\\n');
    const git = (...args) => execFileSync('git', args, {cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim();
    git('init','-b','main'); git('remote','add','origin','https://github.com/a/room.git'); git('add','.'); git('commit','-m','fixture policy');
    const sourceCommit = git('rev-parse','HEAD'), validatedAt = new Date().toISOString();
    const snapshots = {};
    for (const repo of ['a/ok','a/fail']) {
      const snapshot = {schemaVersion:2,org:'a',group:'dev',repository:'a/room',origin:'https://github.com/a/room.git',sourceCommit,policyDigest:'0'.repeat(64),validatedAt,contentPath:root};
      snapshot.policyDigest = loadSnapshotPolicy({snapshot,repo,devMd:profile.replace('a/ok',repo)}).policy.policyDigest;
      snapshots[repo] = snapshot;
    }
    await mkdir(home + '/.vegastack', {recursive:true});
    const state = home + '/.vegastack/factory.json';
    await writeFile(state, JSON.stringify({schemaVersion:2,revision:1,repos:['a/ok','a/fail'].map(repo=>({repo,org:'a',path:code[repo]})),controlRooms:{a:{repo:'a/room',path:root,branch:'main',remote:'https://github.com/a/room.git',lastSyncedAt:validatedAt,sha:sourceCommit,snapshots}}}));
    Object.assign(process.env, {
      VEGAFACTORY_CONTROL_ROOM: root, VEGAFACTORY_CACHE: dashboardCacheNamespace(home, 'a'),
      VEGAFACTORY_ORG: 'a', VEGAFACTORY_STATE: state, VEGAFACTORY_VERSION: '0.0.0',
      VEGAFACTORY_INSTANCE_ID: crypto.randomUUID(), VEGAFACTORY_CACHE_SCHEMA: '2',
      VEGAFACTORY_REPOS: 'a/ok,a/fail', VEGAFACTORY_GH_TOKEN: '', VEGAFACTORY_BIN: '',
      VEGAFACTORY_VIEWER: 'robot',
    });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      const path = new URL(url);
      if(path.pathname.includes('/a/fail/')) return new Response('denied',{status:403});
      if(path.pathname.endsWith('/pulls')) return new Response('[]');
      if(path.searchParams.get('page') === '2') return new Response('denied',{status:403});
      return new Response(JSON.stringify([{id:1,node_id:'I1',number:1,title:'Visible successful page',labels:[{name:'ready'}],assignees:[],html_url:'https://github.com/a/ok/issues/1'}]),{headers:{link:'<https://api.github.com/repos/a/ok/issues?page=2>; rel="next"'}});
    };
    const validation = await readValidatedPolicies({settingsPath:state,org:'a',repos:['a/ok','a/fail'],now:Date.now()});
    const Page = (await import('./src/app/board/page.tsx')).default;
    const html = renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
    console.log(JSON.stringify({html,calls,refusal:validation.policy.refusal}));
  `
  const child = spawnSync(process.execPath, ['--eval', script], { cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000 })
  if (child.status !== 0) throw new Error(child.stderr)
  expect(child.status).toBe(0)
  const result = JSON.parse(child.stdout.trim()) as { html: string; calls: string[]; refusal: string | null }
  if (result.refusal) throw new Error(result.refusal)
  expect(result.html).toContain('Visible successful page')
  expect(result.html).toContain('a/ok: Incomplete')
  expect(result.html).toContain('a/fail: Incomplete')
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

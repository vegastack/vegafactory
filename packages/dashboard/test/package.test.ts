import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dashboardCacheNamespace } from '../../cli/src/dashboard'

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8')

test('is publishable at the CLI version, from an assembled standalone tree', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.name).toBe('@vegastack/vegafactory-dashboard')
  expect(manifest.private).toBeUndefined()
  expect(manifest.version).toBe(JSON.parse(read('../cli/package.json')).version)
  expect(manifest.files).toEqual(['dist-standalone', 'README.md', 'LICENSE'])
  expect(manifest.scripts.prepack).toBe('bun run build && bun run assemble')
  const config = read('next.config.ts')
  expect(config).toContain("output: 'standalone'")
  expect(config).toContain('outputFileTracingRoot')
  expect(config).toContain("serverExternalPackages: ['bun:sqlite']")
})

test('standalone runtime declares Node and Bun requirements separately from platform proof', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.engines.node).toBe('>=24')
  expect(manifest.engines.bun).toBe('>=1.3')
})

const pageFixture = String.raw`
  import React from 'react'
  import { execFileSync } from 'node:child_process'
  import { existsSync } from 'node:fs'
  import { chmod, mkdir, writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  import { renderToStaticMarkup } from 'react-dom/server'
  import { dashboardCacheNamespace } from '../cli/src/dashboard.ts'
  import { loadSnapshotPolicy } from '../../skills/dev/dev-setup/scripts/effective-policy.mjs'

  globalThis.React = React
  const home = process.env.VF_PAGE_HOME
  const mode = process.env.VF_PAGE_MODE
  const gate = process.env.VF_PAGE_GATE
  if (!home || !mode || !gate) throw new Error('page fixture environment missing')
  const room = join(home, 'room')
  const code = { 'a/ok': join(home, 'code-ok'), 'a/private': join(home, 'code-private') }
  const profiles = {
    'a/ok': 'repo: a/ok\ncontrol-room: a/room#dev\n',
    'a/private': 'repo: a/private\ncontrol-room: a/room#secret\n',
  }
  for (const path of Object.values(code)) await mkdir(join(path, '.vegastack'), { recursive: true })
  await mkdir(join(room, 'groups', 'dev'), { recursive: true })
  await mkdir(join(room, 'groups', 'secret'), { recursive: true })
  await mkdir(join(room, 'stats', 'a__ok', 'SEP-2026'), { recursive: true })
  await mkdir(join(room, 'stats', 'a__private', 'SEP-2026'), { recursive: true })
  for (const repo of Object.keys(code)) await writeFile(join(code[repo], '.vegastack', 'dev.md'), profiles[repo])
  const authority = { schemaVersion: 2, locked: {}, delegations: [], administration: {
    orgAdmins: ['admin'], groupAdmins: { dev: ['dev1'], secret: [] },
    groupAdminCapabilities: { dev: ['group.people.read'], secret: [] },
  } }
  const fence = String.fromCharCode(96).repeat(3)
  await writeFile(join(room, 'org.md'), 'stats: on\nstats-people: on\nstats-export: attributed\n' + fence + 'vsk-policy\n' + JSON.stringify(authority) + '\n' + fence + '\n')
  await writeFile(join(room, 'groups', 'dev', 'group.md'), 'review: subagent\n')
  await writeFile(join(room, 'groups', 'secret', 'group.md'), 'review: subagent\n')
  await writeFile(join(room, 'repos.md'), '| repo | group | owner | repository-id |\n|---|---|---|---|\n| a/ok | dev | dev1 | R_ok |\n| a/private | secret | secret1 | R_private |\n')
  await writeFile(join(room, 'people.csv'), 'login,name,role,slack,timezone,groups\nadmin,Admin,lead,,UTC,dev\ndev1,Dev One,engineer,,UTC,dev\nsecret1,Secret One,engineer,,UTC,secret\n')
  const run = (repo, human, skill) => JSON.stringify({ ts: '2026-09-02T10:00:00.000Z', repo, issue: 151,
    stage: 'implement', outcome: 'for-operator', review_rounds: 1, fix_rounds: 0, handbacks: 0,
    harness: 'codex', model: 'gpt-5.6', human, duration_s: 60, cost_usd: 0,
    skills: [{ name: skill, trigger: 'model', harness: 'codex' }],
  }) + '\n'
  await writeFile(join(room, 'stats', 'a__ok', 'SEP-2026', 'host.jsonl'), run('a/ok', 'dev1', 'allowed-skill'))
  await writeFile(join(room, 'stats', 'a__private', 'SEP-2026', 'host.jsonl'), run('a/private', 'secret1', 'FORBIDDEN-CANARY'))
  const git = (...args) => execFileSync('git', args, { cwd: room, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  } }).trim()
  git('init', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/a/room.git'); git('add', '.'); git('commit', '-m', 'fixture policy')
  const sourceCommit = git('rev-parse', 'HEAD')
  const validatedAt = new Date().toISOString()
  const snapshots = {}
  for (const repo of Object.keys(code)) {
    const snapshot = { schemaVersion: 2, org: 'a', group: repo === 'a/ok' ? 'dev' : 'secret', repository: 'a/room',
      origin: 'https://github.com/a/room.git', sourceCommit, policyDigest: '0'.repeat(64), validatedAt, contentPath: room }
    snapshot.policyDigest = loadSnapshotPolicy({ snapshot, repo, devMd: profiles[repo] }).policy.policyDigest
    snapshots[repo] = snapshot
  }
  await mkdir(join(home, '.vegastack'), { recursive: true })
  const state = join(home, '.vegastack', 'factory.json')
  await writeFile(state, JSON.stringify({ schemaVersion: 2, revision: 1,
    repos: Object.keys(code).map(repo => ({ repo, org: 'a', path: code[repo] })),
    controlRooms: { a: { repo: 'a/room', path: room, branch: 'main', remote: 'https://github.com/a/room.git',
      lastSyncedAt: validatedAt, sha: sourceCommit, snapshots } },
  }))
  const bin = join(home, 'vegafactory-fixture.mjs')
  await writeFile(bin, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2)",
    "if (args[0] === 'status') console.log(JSON.stringify({ dispatcher: { running: true, pid: process.pid, lastTick: '2026-09-03T11:59:00.000Z', interval: 120 }, repos: [{ repo: 'a/ok', dispatch: 'local', board: { needsPlan: 0, ready: 0, working: 0, forOperator: 0 }, worktrees: [], runs: [] }] }))",
    "else if (args[0] === 'stats' && args[1] === 'activity') { const value = flag => args[args.indexOf(flag) + 1]; console.log(JSON.stringify({ schemaVersion: 2, metricVersion: 2, org: value('--org'), repo: value('--repo'), period: value('--month'), activities: [], snapshots: [], complete: true, reason: null, observedAt: new Date().toISOString(), sourceDigest: '1'.repeat(64) })) }",
    'else process.exit(2)',
  ].join('\n') + '\n')
  await chmod(bin, 0o700)
  Object.assign(process.env, { VEGAFACTORY_CONTROL_ROOM: room, VEGAFACTORY_CACHE: dashboardCacheNamespace(home, 'a'),
    VEGAFACTORY_ORG: 'a', VEGAFACTORY_STATE: state, VEGAFACTORY_VERSION: '0.0.0', VEGAFACTORY_INSTANCE_ID: crypto.randomUUID(),
    VEGAFACTORY_CACHE_SCHEMA: '2', VEGAFACTORY_REPOS: 'a/ok,a/private', VEGAFACTORY_VIEWER: 'dev1', VEGAFACTORY_BIN: bin,
  })
  delete process.env.VEGAFACTORY_GH_TOKEN
  const calls = []
  let held = false
  const realMax = Math.max
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (mode.startsWith('pin-') && !held) {
      held = true
      await writeFile(gate + '.pending', 'pending')
      while (!existsSync(gate + '.release')) await new Promise(resolve => setTimeout(resolve, 5))
      if (mode === 'pin-throw') Math.max = () => { throw new Error('page-after-live-failure') }
    }
    const body = mode === 'pin-throw' && calls.length === 1
      ? '[{"id":1,"node_id":"I_1","number":1,"title":"pending","labels":[],"assignees":[],"updated_at":"2026-09-03T11:00:00Z","html_url":"https://github.com/a/ok/issues/1"}]'
      : '[]'
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const render = async (path, module, props) => {
    const Page = (await import(module)).default
    return [path, renderToStaticMarkup(await Page(props))]
  }
  if (mode === 'all-pages') {
    const entries = await Promise.all([
      render('/', './src/app/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/performance', './src/app/performance/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/activity', './src/app/activity/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/people', './src/app/people/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/people/dev1', './src/app/people/[login]/page.tsx', { params: Promise.resolve({ login: 'dev1' }), searchParams: Promise.resolve({ month: 'SEP-2026', dimension: 'task-owner' }) }),
      render('/skills', './src/app/skills/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/repo/a/ok', './src/app/repo/[owner]/[name]/page.tsx', { params: Promise.resolve({ owner: 'a', name: 'ok' }), searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/board', './src/app/board/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
      render('/dispatcher', './src/app/dispatcher/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) }),
    ])
    const forbidden = await render('/repo/a/private', './src/app/repo/[owner]/[name]/page.tsx', { params: Promise.resolve({ owner: 'a', name: 'private' }), searchParams: Promise.resolve({ month: 'SEP-2026' }) })
    console.log(JSON.stringify({ pages: Object.fromEntries(entries), forbidden: forbidden[1], calls }))
  } else {
    try {
      const entry = await render('/board', './src/app/board/page.tsx', { searchParams: Promise.resolve({ month: 'SEP-2026' }) })
      console.log(JSON.stringify({ ok: true, html: entry[1] }))
    } catch (error) {
      Math.max = realMax
      console.log(JSON.stringify({ ok: false, error: error.message }))
    }
  }
`

async function runPageFixture(home: string, mode: 'all-pages' | 'pin-success' | 'pin-throw', gate = join(home, 'gate')) {
  const child = Bun.spawn([process.execPath, '--eval', pageFixture], {
    cwd: resolve(import.meta.dirname, '..'), stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, VF_PAGE_HOME: home, VF_PAGE_MODE: mode, VF_PAGE_GATE: gate,
    },
  })
  return { child, gate }
}

async function finish(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw new Error('page fixture pipes unavailable')
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(stdout).text(), new Response(stderr).text(), child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderrText || `page fixture exited ${exitCode}`)
  return stdoutText.trim()
}

async function readerPins(namespace: string): Promise<string[]> {
  const root = join(namespace, 'generations')
  const generations = await readdir(root, { withFileTypes: true }).catch(() => [])
  const pins: string[] = []
  for (const generation of generations) {
    if (!generation.isDirectory()) continue
    for (const pin of await readdir(join(root, generation.name, 'pins')).catch(() => [])) {
      if (pin.endsWith('.claim')) pins.push(join(root, generation.name, 'pins', pin))
    }
  }
  return pins.sort()
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await Bun.sleep(10)
  }
}

test('registry-independent fixtures render every report destination through current scoped policy and cache', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-pages-')))
  try {
    const { child } = await runPageFixture(home, 'all-pages')
    const result = JSON.parse(await finish(child)) as { pages: Record<string, string>; forbidden: string; calls: string[] }
    expect(Object.keys(result.pages).sort()).toEqual([
      '/', '/activity', '/board', '/dispatcher', '/people', '/people/dev1', '/performance', '/repo/a/ok', '/skills',
    ])
    const markers: Record<string, string> = {
      '/': 'Needs your decision', '/performance': 'Definitions and coverage', '/activity': 'Activity report is empty.',
      '/people': 'Private repository readers can also read report files', '/people/dev1': 'Ownership dimension',
      '/skills': 'Mean associated run cost', '/repo/a/ok': 'Cycle time by state', '/board': 'Open pull requests', '/dispatcher': 'Last tick',
    }
    for (const [path, marker] of Object.entries(markers)) expect(result.pages[path], path).toContain(marker)
    expect(Object.values(result.pages).join('\n')).not.toContain('FORBIDDEN-CANARY')
    expect(result.forbidden).toContain('outside the current verified reporting scope')
    expect(result.forbidden).not.toContain('FORBIDDEN-CANARY')
    expect(result.calls.length).toBeGreaterThan(0)
    expect(result.calls.every(url => url.includes('/a/ok/'))).toBe(true)
  } finally { await rm(home, { recursive: true, force: true }) }
}, 30_000)

test('board page holds a physical generation pin across live work and releases it on success and rejection', async () => {
  for (const mode of ['pin-success', 'pin-throw'] as const) {
    const home = await realpath(await mkdtemp(join(tmpdir(), `vf-dashboard-${mode}-`)))
    try {
      const { child, gate } = await runPageFixture(home, mode)
      await waitFor(gate + '.pending')
      const namespace = dashboardCacheNamespace(home, 'a')
      const held = await readerPins(namespace)
      expect(held, mode).toHaveLength(1)
      const owner = JSON.parse(await readFile(held[0]!, 'utf8')) as { schemaVersion: number; identity: { pid: number } }
      expect(owner.schemaVersion).toBe(1)
      expect(owner.identity.pid).toBe(child.pid)
      await writeFile(gate + '.release', 'release')
      const result = JSON.parse(await finish(child)) as { ok: boolean; html?: string; error?: string }
      if (mode === 'pin-success') {
        expect(result.ok).toBe(true)
        expect(result.html).toContain('Open pull requests')
      } else {
        expect(result).toEqual({ ok: false, error: 'page-after-live-failure' })
      }
      expect(await readerPins(namespace), mode).toEqual([])
    } finally { await rm(home, { recursive: true, force: true }) }
  }
}, 45_000)

test('first-use health proves exact launcher identity without exposing paths or credentials', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vf-dashboard-health-')))
  const keys = ['VEGAFACTORY_CONTROL_ROOM', 'VEGAFACTORY_CACHE', 'VEGAFACTORY_ORG', 'VEGAFACTORY_STATE', 'VEGAFACTORY_VERSION', 'VEGAFACTORY_INSTANCE_ID', 'VEGAFACTORY_CACHE_SCHEMA', 'VEGAFACTORY_REPOS', 'VEGAFACTORY_GH_TOKEN'] as const
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const instanceId = crypto.randomUUID()
  Object.assign(process.env, {
    VEGAFACTORY_CONTROL_ROOM: join(home, 'room'), VEGAFACTORY_CACHE: dashboardCacheNamespace(home, 'vegastack'),
    VEGAFACTORY_ORG: 'vegastack', VEGAFACTORY_STATE: join(home, '.vegastack/factory.json'), VEGAFACTORY_VERSION: '1.0.0',
    VEGAFACTORY_INSTANCE_ID: instanceId, VEGAFACTORY_CACHE_SCHEMA: '2', VEGAFACTORY_REPOS: '', VEGAFACTORY_GH_TOKEN: 'secret-token',
  })
  try {
    const response = await (await import('../src/app/api/health/route')).GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, org: 'vegastack', version: '1.0.0', instanceId, cacheSchema: 2, dataState: 'unavailable', sourceAgeSeconds: null })
  } finally {
    for (const key of keys) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]
    await rm(home, { recursive: true, force: true })
  }
})

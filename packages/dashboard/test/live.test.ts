import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { fetchOpenIssues, fetchOpenPulls, fetchPages, fetchBoardRepositories, readBudget } from '../src/lib/live/github'
import { readStatus } from '../src/lib/live/status'

test('projects open issues, drops pull requests, and sends the token only in the header', async () => {
  let seen: Request | null = null
  const row = { id: 122, node_id: 'I122', updated_at: '2026-09-03T10:00:00Z', assignees: [] }
  const out = await fetchOpenIssues({
    repo: 'vegastack/vegafactory', token: 'gho_secret',
    fetchImpl: async (input, init) => {
      seen = new Request(input as string, init)
      return new Response(JSON.stringify([
        { ...row, number: 122, title: 'dashboard', labels: [{ name: 'needs-plan' }], html_url: 'https://x/122' },
        { ...row, id: 9, node_id: 'PR9', number: 9, title: 'a pr', pull_request: {}, labels: [], html_url: 'https://x/9' },
      ]), { status: 200 })
    },
  })
  expect(out).toMatchObject({ ok: true, data: [{ number: 122, title: 'dashboard', labels: ['needs-plan'], assignees: [], updatedAt: row.updated_at, url: 'https://x/122' }] })
  expect(seen!.url).not.toContain('gho_secret')
  expect(seen!.headers.get('authorization')).toBe('Bearer gho_secret')
})

test('every failure is a reason: an HTTP error, a thrown fetch, a missing or failing bin', async () => {
  expect(await fetchOpenIssues({ repo: 'a/b', token: 't', fetchImpl: async () => new Response('nope', { status: 503 }) }))
    .toMatchObject({ ok: false, reason: 'GitHub returned HTTP 503 for a/b' })
  expect((await fetchOpenIssues({ repo: 'a/b', token: 't', fetchImpl: async () => { throw new Error('offline') } })).ok).toBe(false)
  const ok = await readStatus({ bin: join(import.meta.dirname, 'fixtures', 'status-stub.mjs') })
  expect(ok.ok && ok.data.repos[0]!.board.ready).toBe(2)
  expect(ok.ok && ok.data.repos[0]!.workflow?.labelMap?.ready).toBe('Go')
  expect(await readStatus({ bin: null })).toEqual({ ok: false, reason: 'no vegafactory binary was passed to the dashboard' })
  expect((await readStatus({ bin: join(import.meta.dirname, 'fixtures', 'absent.mjs') })).ok).toBe(false)
})

test('142 reproduction: actual issue adapter follows next page before dropping PRs', async () => {
  let calls = 0
  const out = await fetchOpenIssues({ repo: 'a/b', token: null, fetchImpl: async () => {
    calls++
    return calls === 1
      ? new Response(JSON.stringify([{ id: 1, node_id: 'PR1', number: 1, pull_request: {} }]), { headers: { link: '<https://api.github.com/repos/a/b/issues?page=2>; rel="next"' } })
      : new Response(JSON.stringify([{ id: 2, node_id: 'I2', number: 2, title: 'second page', labels: [] }]))
  } })
  expect(out.ok && out.data.map(row => row.number)).toEqual([2])
  expect(calls).toBe(2)
})

const httpPage = (rows: unknown, link?: string, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(rows), { status, headers: { ...headers, ...(link ? { link: `<${link}>; rel="next"` } : {}) } })
const api = 'https://api.github.com/repos/a/b/issues'

test('142 conformance: both transports preserve the same complete, partial and refusal JSON envelopes', async () => {
  const { fetchGhPages } = await import('../../cli/src/gh')
  const cases = [
    [httpPage([{ id: 1 }])],
    [httpPage([{ id: 1 }], `${api}?page=2`), httpPage([], undefined, 403)],
    [httpPage([{ id: 1 }], 'https://evil.test/stolen')],
    [httpPage([{ id: 1 }], `${api}?page=2`), httpPage([{ id: 1 }, { id: 2 }])],
    [httpPage({ items: [], total_count: 1001, incomplete_results: true })],
  ]
  for (const responses of cases) {
    let cliCalls = 0, dashboardCalls = 0
    const cli = await fetchGhPages(async () => {
      const response = responses[cliCalls++]!.clone()
      return `HTTP/2.0 ${response.status} Status\r\nx-test: 1\r\n${[...response.headers].map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${await response.text()}`
    }, api)
    const dashboard = await fetchPages(api, { fetch: async () => responses[dashboardCalls++]!.clone() })
    expect({ ...cli, observedAt: null }).toEqual({ ...dashboard, observedAt: null })
    expect(cliCalls).toBe(dashboardCalls)
    expect(Number.isNaN(Date.parse(cli.observedAt))).toBe(false)
    expect(Number.isNaN(Date.parse(dashboard.observedAt))).toBe(false)
  }
})

test('142 actual adapters retain 101 issues and 101 pulls, with interleaved PRs and stable deduplication', async () => {
  for (const endpoint of ['issues', 'pulls']) {
    let calls = 0
    const rows = Array.from({ length: endpoint === 'issues' ? 103 : 101 }, (_, index) => ({ id: index + 1, node_id: `N${index + 1}`, number: index + 1, title: 'row', labels: [], ...(endpoint === 'issues' && index < 2 ? { pull_request: {} } : {}) }))
    const input = { repo: 'a/b', token: null, fetchImpl: async () => {
      calls++
      return calls === 1 ? httpPage(rows.slice(0, 100), `https://api.github.com/repos/a/b/${endpoint}?page=2`) : httpPage([rows[99], ...rows.slice(100)])
    } }
    const result = endpoint === 'issues' ? await fetchOpenIssues(input) : await fetchOpenPulls(input)
    expect(result.ok && result.data.length).toBe(101)
    expect(result.snapshot.complete).toBe(true)
    expect(calls).toBe(2)
  }
})

test('142 bounds next links, redirects, missing IDs and page limits without erasing prior rows', async () => {
  for (const link of ['http://api.github.com/repos/a/b/issues?page=2', 'https://api.github.com.evil.test/?page=2', 'https://secret@api.github.com/repos/a/b/issues?page=2']) {
    let calls = 0
    const result = await fetchPages(api, { fetch: async () => { calls++; return httpPage([{ id: 1 }], link) } })
    expect(result).toMatchObject({ items: [{ id: 1 }], complete: false, reason: 'Refused unsafe GitHub pagination URL' })
    expect(calls).toBe(1)
  }
  let calls = 0
  const loop = await fetchPages(api, { fetch: async () => { calls++; return httpPage([{ id: 1 }], `${api}?per_page=100`) } })
  expect(loop.reason).toContain('loop'); expect(calls).toBe(1)
  calls = 0
  const cap = await fetchPages(api, { fetch: async () => httpPage([{ id: ++calls }], `${api}?page=${calls + 1}`) })
  expect(cap.items).toHaveLength(100); expect(cap.reason).toContain('page limit'); expect(calls).toBe(100)
  expect((await fetchPages(api, { fetch: async () => httpPage([{}]) })).complete).toBe(false)
  expect((await fetchPages(api, { fetch: async (_url, init) => { expect(init?.redirect).toBe('error'); return httpPage([], undefined, 302) } })).reason).toContain('HTTP 302')
})

test('142 retries rate limits only within the repository deadline and cancels hanging response bodies', async () => {
  let calls = 0
  const recovered = await fetchPages(api, { fetch: async () => ++calls < 3 ? httpPage([], undefined, 429, { 'retry-after': '0' }) : httpPage([{ id: 1 }]) })
  expect(recovered.complete).toBe(true); expect(calls).toBe(3)
  calls = 0
  const exhausted = await fetchPages(api, { fetch: async () => { calls++; return httpPage([], undefined, 429, { 'retry-after': '0' }) } })
  expect(exhausted.reason).toContain('HTTP 429'); expect(calls).toBe(3)
  calls = 0
  const longWait = await fetchPages(api, { fetch: async () => { calls++; return httpPage([], undefined, 403, { 'retry-after': '120' }) } })
  expect(longWait.reason).toContain('retry delay'); expect(calls).toBe(1)
  const body = await fetchPages(api, { budget: readBudget(undefined, 30), fetch: async () => new Response(new ReadableStream({ start() {} })) })
  expect(body.complete).toBe(false); expect(body.reason).toContain('deadline')
  const controller = new AbortController()
  const pending = fetchPages(api, { signal: controller.signal, fetch: async () => new Promise(() => {}) })
  controller.abort()
  expect((await pending).reason).toContain('cancelled')
})

test('142 board repository pool shares three slots across issues and pulls, and retains healthy/partial repos', async () => {
  const active = new Set<string>()
  let max = 0
  const rows = await fetchBoardRepositories(['a/a', 'a/b', 'a/c', 'a/d', 'a/e'], null, async (url) => {
    const path = new URL(url).pathname
    const repo = path.split('/').slice(2, 4).join('/')
    active.add(repo); max = Math.max(max, active.size)
    await new Promise(resolve => setTimeout(resolve, 2))
    if (path.endsWith('/pulls')) active.delete(repo)
    return repo === 'a/b' ? httpPage([], undefined, 403) : httpPage([{ id: 1, node_id: 'N1', number: 1, title: repo, labels: [] }])
  })
  expect(max).toBe(3)
  expect(rows.issues.live.ok && rows.issues.live.data).toHaveLength(4)
  expect(rows.issues.repositories.find(row => row.repo === 'a/b')).toMatchObject({ complete: false, reason: 'GitHub returned HTTP 403 for a/b' })
  expect(rows.pulls.live.ok && rows.pulls.live.data).toHaveLength(4)
})

test('142 malformed issue labels cannot turn an observed row into an apparently empty queue', async () => {
  const result = await fetchOpenIssues({ repo: 'a/b', token: null, fetchImpl: async () => httpPage([{ id: 1, number: 1, title: 'unreadable labels', labels: null }]) })
  expect(result.snapshot.complete).toBe(false)
  expect(result.snapshot.reason).toContain('labels')
})

test('141 standalone status bridge consumes actual CLI JSON without a sibling skill', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'vsk-status-bridge-'))
  mkdirSync(join(root, '.vegastack'))
  const map = { needsOperator: 'Decision', needsPlan: 'Plan', ready: 'Go', working: 'Build', forOperator: 'Review' }
  writeFileSync(join(root, '.vegastack/dev.md'), 'workflow-labels: ' + JSON.stringify(map))
  writeFileSync(join(root, 'factory.json'), JSON.stringify({ repos: [{ path: root, repo: 'acme/app', org: 'acme' }] }))
  const cliSource = join(import.meta.dirname, '../../cli/src/status.ts')
  const bin = join(root, 'status-cli')
  writeFileSync(bin, '#!' + process.execPath + '\nimport {runStatusCli} from ' + JSON.stringify(cliSource) + ';\nawait runStatusCli(["--json","--config",' + JSON.stringify(join(root, 'factory.json')) + '], ' + JSON.stringify(root) + ', {gh:async()=>JSON.stringify({total_count:1,incomplete_results:false,items:[{number:1,node_id:"I_1",title:"Custom",labels:[{name:"Go"}],assignees:[]}]}),worktrees:async()=>[],logs:async()=>[]});\n', { mode: 0o755 })
  // Only the bridge module is copied: its runtime uses Node, not repository or skill imports.
  copyFileSync(join(import.meta.dirname, '../src/lib/live/status.ts'), join(root, 'bridge.ts'))
  const bridge = await import(join(root, 'bridge.ts'))
  const result = await bridge.readStatus({ bin })
  expect(result.ok).toBe(true)
  expect(result.data.repos[0].workflow.labelMap).toEqual(map)
  expect(result.data.repos[0].workflow.issues[0].state).toBe('ready')
  expect(result.data.repos[0].workflow.complete).toBe(true)
})

test('status adapter preserves actual shared/snapshot/recovery fields and scopes selected configuration', async () => {
  const {parseStatusReport}=await import('../src/lib/live/status')
  const shared={head:'a'.repeat(40),tasks:[{taskKey:'b'.repeat(64),repo:'o/r',issue:1,state:'stopped',machineId:'machine',generation:2}],refusal:null}
  const recovery:import('../src/lib/live/status').DurableRecoverySummary={action:'inspect',reason:'prior terminal capture preserved; verified continuation required',checkpointHead:'c'.repeat(40),unbackedTail:true,terminalCapturePreserved:true}
  const snapshot={state:'fresh',sourceCommit:'d'.repeat(40),policyDigest:'e'.repeat(64),validatedAt:'2026-09-01T00:00:00Z',ageSeconds:0,reason:null,machine:{id:'machine',state:'configured',reason:null,executionIdentityVerified:false,sourceCommit:'d'.repeat(40),configuration:{private:'not part of status contract'}}}
  const report=parseStatusReport({dispatcher:{running:false},repos:[{repo:'o/r',shared,snapshot,runs:[{issue:1,stage:'implement',recovery}],board:{}}]})!
  expect(report.repos[0]!.shared).toEqual(shared)
  expect(report.repos[0]!.snapshot).toMatchObject({state:'fresh',ageSeconds:0,machine:{executionIdentityVerified:false}})
  expect(report.repos[0]!.snapshot?.machine).not.toHaveProperty('configuration')
  expect(report.repos[0]!.runs[0]!.recovery).toEqual(recovery)
  expect(report.repos[0]!.runs[0]!.pendingDelivery).toBeNull()
  expect(parseStatusReport({})).toBeNull()
})

test('activity bridge sends exact selected config/org/repo/month, retains incomplete data and rejects extra private fields', async () => {
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os')
  const {readActivities,readStatus}=await import('../src/lib/live/status')
  const root=await mkdtemp(join(tmpdir(),'activity-bridge-')),bin=join(root,'cli'),argv=join(root,'argv.json'),configPath=join(root,'selected.json')
  const report:import('../src/lib/live/status').ActivityReport={schemaVersion:2,metricVersion:2,org:'o',repo:'o/r',period:'2026-09',activities:[],snapshots:[],complete:false,reason:'activity-source-unavailable',observedAt:'2026-08-31T00:00:00.000Z',sourceDigest:'a'.repeat(64)}
  const script=(value:unknown,code=1)=>'#!'+process.execPath+'\nimport{writeFileSync}from"node:fs";writeFileSync('+JSON.stringify(argv)+',JSON.stringify(process.argv.slice(2)));console.log('+JSON.stringify(JSON.stringify(value))+');process.exit('+code+');\n'
  try{
    await writeFile(bin,script(report),{mode:0o755})
    expect(await readActivities({bin,org:'o',repo:'o/r',month:'2026-09',configPath})).toEqual({ok:true,data:report})
    expect(JSON.parse(await readFile(argv,'utf8'))).toEqual(['stats','activity','--org','o','--repo','o/r','--month','2026-09','--json','--config',configPath])
    await writeFile(bin,script({...report,privateReceipt:'CANARY'}))
    expect((await readActivities({bin,org:'o',repo:'o/r',month:'2026-09',configPath})).ok).toBe(false)
    await writeFile(bin,script({dispatcher:{running:false},repos:[{repo:'o/r'},{repo:'other/private'}]},0))
    const status=await readStatus({bin,configPath,org:'o',repos:['o/r']})
    expect(status.ok&&status.data.repos.map(row=>row.repo)).toEqual(['o/r'])
    expect(JSON.parse(await readFile(argv,'utf8'))).toEqual(['status','--json','--config',configPath])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('shared history bridge preserves verified suffix and unknown checkpoint availability without inventing archive completeness', async () => {
  const {parseStatusReport}=await import('../src/lib/live/status')
  const head='a'.repeat(40)
  const history:NonNullable<import('../src/lib/live/status').SharedStatus['history']>={coverage:'bounded',archiveCoverage:'partial',sourceCommit:head}
  const task:import('../src/lib/live/status').SharedTaskStatus={taskKey:'b'.repeat(64),repo:'o/r',issue:1,state:'stopped',machineId:'machine-c',generation:3,sourceCommit:head,originMachineId:null,lastTransitionObservedAt:'2026-09-08T00:00:00Z',checkpoint:{headSha:'c'.repeat(40),publishedAt:'2026-09-07T00:00:00Z',sourceCommit:head,availability:'unknown'},history:{coverage:'bounded',events:[{kind:'handoff',generation:3,machineId:'machine-c',previousMachineId:'machine-b',sourceCommit:head,observedAt:'2026-09-08T00:00:00Z'}]}}
  const shared={head,refusal:null,history,tasks:[task]}
  const report=parseStatusReport({dispatcher:{running:false},repos:[{repo:'o/r',shared}]})!
  expect(report.repos[0]!.shared).toEqual(shared)
  expect(report.repos[0]!.shared!.tasks[0]!.originMachineId).toBeNull()
  const old=parseStatusReport({dispatcher:{running:false},repos:[{repo:'o/r',shared:{head,refusal:null,tasks:[{taskKey:task.taskKey,repo:'o/r',issue:1,state:'stopped',machineId:'machine-c',generation:3}]}}]})!
  expect(old.repos[0]!.shared!.history).toBeUndefined()
  expect(old.repos[0]!.shared!.tasks[0]!.history).toBeUndefined()
})

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

import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expandHome, filterDashboardEvents, renderDashboard, runDashboard } from '../src/dashboard.ts'
import { statsDir, type StatsEvent } from '../src/stats.ts'
import { refuseAmbientHome } from './no-ambient-home.ts'

refuseAmbientHome()

let home: string

const event = (partial: Partial<StatsEvent> & { id: string }): StatsEvent => ({
  rev: 1, at: '2026-09-17T10:00:00.000Z', owner: 'mk', node: 'mk@box', harness: 'claude', model: 'claude-opus-5',
  repo: 'acme/app', issue: 42, state: 'in-progress', skill: null,
  tokens: { input: 100, output: 20, cacheRead: 5000, cacheWrite: 400 }, durationMs: 90_000, outcome: 'end_turn', ...partial,
})

const DATA: StatsEvent[] = [
  event({ id: '1', skill: 'dev-implement' }),
  event({ id: '2', at: '2026-09-18T09:00:00.000Z', owner: 'sam', node: 'sam@box', harness: 'codex', model: 'gpt-5.6-sol', issue: 43, state: 'ready-to-ship' }),
  event({ id: '3', at: '2026-09-18T10:00:00.000Z', repo: 'acme/other', issue: 7, state: 'planning' }),
]

class FakeNode {
  children: FakeNode[] = []
  className = ''
  dataset: Record<string, string> = {}
  href = ''
  listeners: Record<string, Array<() => void>> = {}
  scope = ''
  style: Record<string, string> = {}
  textContent = ''
  value = ''

  constructor(readonly tagName: string) {}
  append(...children: FakeNode[]) { this.children.push(...children) }
  replaceChildren(...children: FakeNode[]) { this.children = children }
  addEventListener(type: string, listener: () => void) { (this.listeners[type] ??= []).push(listener) }
  dispatch(type: string) { for (const listener of this.listeners[type] ?? []) listener() }
}

function runDashboardScript(html: string) {
  const ids = ['filter-repo', 'filter-owner', 'filter-node', 'filter-from', 'filter-to', 'dashboard-summary', 'dashboard-sections']
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id.includes('filter-') ? 'input' : 'div')]))
  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    getElementById: (id: string) => nodes.get(id) ?? null,
  }
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('dashboard script not found')
  runInNewContext(script, { document, Node: FakeNode })
  return { nodes, change: (id: string, value: string) => { const node = nodes.get(id)!; node.value = value; node.dispatch('change') } }
}

const nodeText = (node: FakeNode): string => [node.textContent, ...node.children.map(nodeText)].join(' ')
const plainText = (text: string): string => text
  .replace(/<[^>]+>/g, ' ')
  .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
  .replace(/\s+/g, ' ').trim()

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dash-')))
})

test('the page carries every section, links its issues and works offline', () => {
  const html = renderDashboard(DATA, { generatedAt: '2026-09-18T12:00:00.000Z' })
  for (const heading of ['Owners', 'Nodes', 'Projects', 'Issues', 'Models', 'Model use per owner', 'Model use per project', 'By day', 'Time per stage', 'Skills']) {
    expect(html).toContain(`<h2>${heading}</h2>`)
  }
  expect(html).toContain('3 turns')
  expect(html).toContain('2 owners')
  expect(html).toContain('mk@box')
  expect(html).toContain('sam@box')
  expect(html).toContain('https://github.com/acme/app/issues/42')
  expect(html).toContain('ready-to-ship')
  expect(html).toContain('gpt-5.6-sol')
  expect(html).toContain('dev-implement')
  // Two days of bars, and time per stage.
  expect(html).toContain('2026-09-17')
  expect(html).toContain('class="bar"')
  expect(html).toContain('planning')
  // One inline script powers local filtering; nothing is fetched and no external asset exists.
  expect((html.match(/<script\b/g) ?? [])).toHaveLength(1)
  expect(html).not.toContain('src="http')
  expect(html).not.toContain('cdn')
  expect(html).not.toContain('fetch(')
  expect(html).not.toContain('XMLHttpRequest')
  expect(html).not.toContain('import(')
  expect(html).not.toContain('innerHTML')
  expect(html).toContain('createElement')
  expect(html).toContain('textContent')
  expect(html).toContain('addEventListener')
  expect(html.match(/https?:\/\/(?!github\.com\/)/g)).toBeNull()
  for (const id of ['filter-repo', 'filter-owner', 'filter-node', 'filter-from', 'filter-to']) expect(html).toContain(`id="${id}"`)
})

test('an empty dataset still renders', () => {
  const html = renderDashboard([], { generatedAt: '2026-09-18T12:00:00.000Z' })
  expect(html).toContain('no turns collected yet')
  expect(html).toContain('nothing collected yet')
})

test('a repository name can never inject markup', () => {
  const html = renderDashboard([event({ id: '1', repo: '<img src=x onerror=alert(1)>' })])
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img')
})

test('embedded dashboard data cannot close its one script tag', () => {
  const html = renderDashboard([event({ id: 'x', owner: '</script><script>alert(1)</script>', repo: 'x/y' })])
  expect((html.match(/<script\b/g) ?? [])).toHaveLength(1)
  expect(html).not.toContain('</script><script>alert(1)</script>')
  expect(html).toContain('\\u003c/script\\u003e')
})

test('dashboard filters match repo, owner, node and inclusive days', () => {
  expect(filterDashboardEvents(DATA, { repo: 'acme/app', owner: 'sam', node: '', from: '2026-09-18', to: '2026-09-18' }).map((row) => row.id)).toEqual(['2'])
  expect(filterDashboardEvents(DATA, { repo: '', owner: '', node: '', from: '2026-09-18', to: '' })).toHaveLength(2)
  expect(filterDashboardEvents([], { repo: '', owner: '', node: '', from: '', to: '' })).toEqual([])
})

test('the actual inline runtime rebuilds every section as filters change', () => {
  const html = renderDashboard(DATA)
  const { nodes, change } = runDashboardScript(html)
  const headings = ['Owners', 'Nodes', 'Projects', 'Issues', 'Models', 'Model use per owner', 'Model use per project', 'By day', 'Time per stage', 'Skills']
  const initialSummary = plainText(html.match(/id="dashboard-summary">([\s\S]*?)<\/p>/)![1]!)
  const initialSections = plainText(html.match(/id="dashboard-sections">([\s\S]*?)<\/div>\n<script>/)![1]!)

  // Render once with no filters, then use this complete DOM state as the reset oracle.
  change('filter-repo', '')
  const baselineSections = plainText(nodeText(nodes.get('dashboard-sections')!))
  expect(nodes.get('dashboard-summary')!.textContent).toBe(initialSummary)
  expect(baselineSections).toBe(initialSections)

  const verify = (id: string, value: string, turns: number, visible: string) => {
    change(id, value)
    expect(nodes.get('dashboard-summary')!.textContent).toContain(`${turns} turns`)
    const sections = nodes.get('dashboard-sections')!.children
    expect(sections.map((section) => section.children[0]?.textContent)).toEqual(headings)
    expect(sections).toHaveLength(10)
    expect(plainText(nodeText(nodes.get('dashboard-sections')!))).toContain(visible)
    change(id, '')
    expect(nodes.get('dashboard-summary')!.textContent).toBe(initialSummary)
    expect(plainText(nodeText(nodes.get('dashboard-sections')!))).toBe(initialSections)
  }

  verify('filter-repo', 'acme/other', 1, 'acme/other')
  verify('filter-owner', 'sam', 1, 'sam')
  verify('filter-node', 'sam@box', 1, 'sam@box')
  verify('filter-from', '2026-09-18', 2, '2026-09-18') // inclusive lower boundary
  verify('filter-to', '2026-09-17', 1, '2026-09-17') // inclusive upper boundary

  expect(nodes.get('dashboard-sections')!.children.map((section) => section.children[0]?.textContent)).toEqual([
    'Owners', 'Nodes', 'Projects', 'Issues', 'Models', 'Model use per owner', 'Model use per project', 'By day', 'Time per stage', 'Skills',
  ])

  // A valid combination with no rows keeps all ten sections and their empty state.
  change('filter-repo', 'acme/other')
  change('filter-owner', 'sam')
  expect(nodes.get('dashboard-summary')!.textContent).toBe('no turns collected yet')
  expect(nodes.get('dashboard-sections')!.children).toHaveLength(10)
  for (const section of nodes.get('dashboard-sections')!.children) expect(section.children[1]?.textContent).toBe('nothing collected yet')

  // Clearing every control restores full parity with the initial server-rendered state.
  for (const id of ['filter-repo', 'filter-owner', 'filter-node', 'filter-from', 'filter-to']) change(id, '')
  expect(nodes.get('dashboard-summary')!.textContent).toBe(initialSummary)
  expect(plainText(nodeText(nodes.get('dashboard-sections')!))).toBe(initialSections)
})

test('dashboard writes one file, expands ~ and reports the turns', () => {
  mkdirSync(statsDir(home), { recursive: true })
  writeFileSync(join(statsDir(home), 'events.jsonl'), DATA.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const out: string[] = []
  const code = runDashboard(['--out', '~/reports/stats.html', '--local'], { home, now: () => Date.parse('2026-09-18T12:00:00Z'), out: (text) => out.push(text) })
  expect(code).toBe(0)
  const target = join(home, 'reports', 'stats.html')
  expect(out[0]).toBe(`${target} — 3 turns`)
  expect(readFileSync(target, 'utf8')).toContain('acme/other')
})

test('--since narrows the page and --open hands the file to the desktop', () => {
  mkdirSync(statsDir(home), { recursive: true })
  writeFileSync(join(statsDir(home), 'events.jsonl'), DATA.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const opened: string[] = []
  const target = join(home, 'stats.html')
  runDashboard(['--out', target, '--since', '12h', '--open', '--local'], {
    home, now: () => Date.parse('2026-09-18T12:00:00Z'), out: () => {}, open: (path) => opened.push(path),
  })
  expect(opened).toEqual([target])
  const html = readFileSync(target, 'utf8')
  expect(html).toContain('2 turns')
  expect(html).not.toContain('2026-09-17')
})

test('~ expands against the home in use', () => {
  expect(expandHome('~/x.html', '/h')).toBe('/h/x.html')
  expect(expandHome('~', '/h')).toBe('/h')
  expect(expandHome('/tmp/x.html', '/h')).toBe('/tmp/x.html')
})

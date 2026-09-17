import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandHome, renderDashboard, runDashboard } from '../src/dashboard.ts'
import { statsDir, type StatsEvent } from '../src/stats.ts'

let home: string

const event = (partial: Partial<StatsEvent> & { id: string }): StatsEvent => ({
  rev: 1, at: '2026-09-17T10:00:00.000Z', operator: 'mk', machine: 'box', harness: 'claude', model: 'claude-opus-5',
  repo: 'acme/app', issue: 42, state: 'in-progress', skill: null,
  tokens: { input: 100, output: 20, cacheRead: 5000, cacheWrite: 400 }, durationMs: 90_000, outcome: 'end_turn', ...partial,
})

const DATA: StatsEvent[] = [
  event({ id: '1', skill: 'dev-implement' }),
  event({ id: '2', at: '2026-09-18T09:00:00.000Z', operator: 'sam', harness: 'codex', model: 'gpt-5.6-sol', issue: 43, state: 'ready-to-ship' }),
  event({ id: '3', at: '2026-09-18T10:00:00.000Z', repo: 'acme/other', issue: 7, state: 'planning' }),
]

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dash-')))
})

test('the page carries every section, links its issues and works offline', () => {
  const html = renderDashboard(DATA, { generatedAt: '2026-09-18T12:00:00.000Z' })
  for (const heading of ['Operators', 'Projects', 'Issues', 'Models', 'Model use per operator', 'Model use per project', 'By day', 'Time per stage', 'Skills']) {
    expect(html).toContain(`<h2>${heading}</h2>`)
  }
  expect(html).toContain('3 turns')
  expect(html).toContain('2 operators')
  expect(html).toContain('https://github.com/acme/app/issues/42')
  expect(html).toContain('ready-to-ship')
  expect(html).toContain('gpt-5.6-sol')
  expect(html).toContain('dev-implement')
  // Two days of bars, and time per stage.
  expect(html).toContain('2026-09-17')
  expect(html).toContain('class="bar"')
  expect(html).toContain('planning')
  // Nothing is fetched: no script, no stylesheet, no remote asset.
  expect(html).not.toContain('<script')
  expect(html).not.toContain('src="http')
  expect(html).not.toContain('cdn')
  expect(html.match(/https?:\/\/(?!github\.com\/)/g)).toBeNull()
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

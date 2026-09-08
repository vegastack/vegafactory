import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import ErrorPage from '../src/app/error'
import Loading from '../src/app/loading'
import { AttentionSections } from '../src/app/page'
import { Navigation } from '../src/components/shell'
import { money, quantity } from '../src/components/stat-table'

const dashboardRoot = join(import.meta.dirname, '..')
const pageFiles = [
  'src/app/page.tsx',
  'src/app/board/page.tsx',
  'src/app/dispatcher/page.tsx',
  'src/app/people/page.tsx',
  'src/app/people/[login]/page.tsx',
  'src/app/repo/[owner]/[name]/page.tsx',
  'src/app/skills/page.tsx',
]

test('every existing page keeps database work inside withContext', () => {
  for (const relative of pageFiles) {
    const source = readFileSync(join(dashboardRoot, relative), 'utf8')
    expect(source, relative).toContain('withContext')
    expect(source, relative).not.toContain('loadContext')
  }
})

test('navigation marks one route and carries only validated report filters', () => {
  const html = renderToStaticMarkup(
    <Navigation
      pathname="/board"
      filters={{
        month: 'SEP-2026', repo: null, group: 'dev', harness: 'codex', model: null,
        repos: ['vegastack/vegafactory'], allowedRepos: ['vegastack/vegafactory'],
      }}
    />,
  )
  expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
  expect(html).toContain('Board')
  expect(html).toContain('group=dev')
  expect(html).toContain('harness=codex')
  expect(html).not.toContain('allowedRepos')
})

test('unknown quantities remain distinct from measured zero', () => {
  expect(money(null)).toBe('Unavailable')
  expect(money(0)).toBe('$0.00')
  expect(quantity(null)).toBe('Unavailable')
  expect(quantity(0)).toBe('0')
})

test('attention sections retain the accepted decision-to-merge order', () => {
  const html = renderToStaticMarkup(<AttentionSections decision={[]} blocked={[]} running={[]} merged={[]} incomplete={false} />)
  const headings = ['Needs your decision', 'Blocked or failed', 'Running', 'Recently merged']
  expect(headings.map(heading => html.indexOf(heading))).toEqual([...headings].map(heading => html.indexOf(heading)).sort((a, b) => a - b))
})

test('loading and failure states announce one meaningful next action without exposing an exception', () => {
  const loading = renderToStaticMarkup(<Loading />)
  expect(loading).toContain('role="status"')
  expect(loading).toContain('Loading current dashboard data')
  const failed = renderToStaticMarkup(<ErrorPage error={new Error('/Users/private/token')} reset={() => {}} />)
  expect(failed).toContain('role="alert"')
  expect(failed).toContain('Retry this read')
  expect(failed).not.toContain('/Users/private/token')
})

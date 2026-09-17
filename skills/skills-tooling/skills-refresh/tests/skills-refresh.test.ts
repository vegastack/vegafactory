import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { validateSkill } from '../../../../packages/cli/scripts/validate-skill.mjs'
import { parseDate, readWatchlist, scanFacts } from '../scripts/facts-scan.mjs'

const skillRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(skillRoot, '../../..')
const watchlistPath = join(skillRoot, 'references/watchlist.md')
const today = parseDate('18-09-2026')!

function repo(files: Record<string, string>): { root: string; watchlist: string } {
  const root = mkdtempSync(join(tmpdir(), 'vsk-refresh-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return { root, watchlist: join(root, 'watchlist.md') }
}

const table = (file: string) => `| Topic | Facts file | Official pages |\n|---|---|---|\n| Widgets | \`${file}\` | https://example.test/docs |\n`
const section = (body: string) => `# Facts\n\n## Widgets\n\n${body}`
const fact = (capability: string, checked: string) =>
  `- **${capability}** · do the thing · since 1.2 · checked ${checked} · https://example.test/docs\n`

describe('skills-refresh contract', () => {
  test('SKILL.md passes repo validation', () => {
    const result = validateSkill(skillRoot)
    expect(result.message).toBe('Skill is valid!')
    expect(result.ok).toBe(true)
  })

  test('trigger query fixture is a small hard set with near-miss negatives', () => {
    const queries = JSON.parse(readFileSync(join(skillRoot, 'tests/fixtures/trigger-queries.json'), 'utf8'))
    const positives = queries.filter((entry: { should_trigger: boolean }) => entry.should_trigger)
    const negatives = queries.filter((entry: { should_trigger: boolean }) => !entry.should_trigger)
    expect(positives.length).toBeGreaterThanOrEqual(5)
    expect(negatives.length).toBeGreaterThanOrEqual(4)
    for (const entry of queries) expect(typeof entry.query).toBe('string')
  })
})

describe('the watchlist table', () => {
  test('every row carries a topic, a file and at least one official page', () => {
    const { rows, problems } = readWatchlist(readFileSync(watchlistPath, 'utf8'))
    expect(problems).toEqual([])
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const row of rows) {
      expect(row.file).toMatch(/^skills\/.+\.md$/)
      expect(row.pages.length).toBeGreaterThan(0)
    }
  })

  test('the header and separator rows are not topics', () => {
    const { rows } = readWatchlist('| Topic | Facts file | Official pages |\n|---|---|---|\n| A | `a.md` | https://e.test |\n')
    expect(rows).toEqual([{ topic: 'A', file: 'a.md', pages: ['https://e.test'] }])
  })
})

describe('the sweep window', () => {
  test('a fact past the window is due and one inside it is not', () => {
    const { root, watchlist } = repo({
      'watchlist.md': table('facts.md'),
      'facts.md': section(fact('Fresh thing', '01-09-2026') + fact('Old thing', '01-06-2026')),
    })
    const result = scanFacts({ root, watchlist, today })
    expect(result.problems).toEqual([])
    expect(result.due.map((f: { capability: string }) => f.capability)).toEqual(['Old thing'])
    expect(result.topics[0]).toMatchObject({ topic: 'Widgets', facts: 2, due: 1 })
    expect(result.due[0]).toMatchObject({ file: 'facts.md', line: 6, link: 'https://example.test/docs' })
  })

  test('the window is a knob, so a schedule can sweep harder without editing a fact', () => {
    const { root, watchlist } = repo({ 'watchlist.md': table('facts.md'), 'facts.md': section(fact('Thing', '01-09-2026')) })
    expect(scanFacts({ root, watchlist, today }).due).toHaveLength(0)
    expect(scanFacts({ root, watchlist, today, maxAgeDays: 7 }).due).toHaveLength(1)
  })
})

describe('what the scanner refuses', () => {
  test.each([
    ['a fact line missing its link', '- **Thing** · do it · since 1.2 · checked 01-09-2026\n'],
    ['a fact line missing its checked date', '- **Thing** · do it · since 1.2 · https://example.test/docs\n'],
    ['an http link', '- **Thing** · do it · since 1.2 · checked 01-09-2026 · http://example.test/docs\n'],
    ['a checked date that is not a real day', '- **Thing** · do it · since 1.2 · checked 31-02-2026 · https://example.test/docs\n'],
  ])('%s is a problem, not a silently skipped line', (_label, body) => {
    const { root, watchlist } = repo({ 'watchlist.md': table('facts.md'), 'facts.md': section(body) })
    const result = scanFacts({ root, watchlist, today })
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('facts.md:5')
  })

  test('ordinary prose and ordinary bullets are not fact lines and are not errors', () => {
    const { root, watchlist } = repo({
      'watchlist.md': table('facts.md'),
      'facts.md': section('Some prose.\n\n- an ordinary bullet\n\n' + fact('Thing', '01-09-2026')),
    })
    expect(scanFacts({ root, watchlist, today })).toMatchObject({ ok: true, due: [] })
  })

  test('a missing facts file and an empty one are both named', () => {
    const missing = repo({ 'watchlist.md': table('gone.md') })
    expect(scanFacts({ ...missing, today }).problems.join(' ')).toContain('facts file not found')
    const empty = repo({ 'watchlist.md': table('facts.md'), 'facts.md': section('') })
    expect(scanFacts({ ...empty, today }).problems.join(' ')).toContain('holds no fact lines')
  })

  test('a facts file with no matching section is named, not silently empty', () => {
    const { root, watchlist } = repo({ 'watchlist.md': table('facts.md'), 'facts.md': '# Facts\n\n## Gadgets\n\n' + fact('Thing', '01-09-2026') })
    expect(scanFacts({ root, watchlist, today }).problems.join(' ')).toContain('has no "## Widgets" section')
  })

  test('a topic with no official page is a problem — a fact with no source is not a fact', () => {
    const { problems } = readWatchlist('| Topic | Facts file | Official pages |\n|---|---|---|\n| A | `a.md` | ask around |\n')
    expect(problems.join(' ')).toContain('names no official page')
  })
})

describe('this repo', () => {
  test('every watchlisted facts file parses, so the sweep can actually run here', () => {
    const result = scanFacts({ root: repoRoot, watchlist: watchlistPath, today: Date.now() })
    expect(result.problems).toEqual([])
    expect(result.topics.every((topic: { facts: number }) => topic.facts > 0)).toBe(true)
  })
})

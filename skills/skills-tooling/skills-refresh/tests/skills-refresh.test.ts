import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { validateSkill } from '../../../../packages/cli/scripts/validate-skill.mjs'
import { parseDate, readWatchlist, scanFacts, sectionLines } from '../scripts/facts-scan.mjs'

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

const table = (file: string) => `| Tool | Facts file section | Official pages |\n|---|---|---|\n| Widgets | \`${file}\` | https://example.test/docs |\n`
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
  test('every row carries a tool, a file and at least one official page', () => {
    const { rows, problems } = readWatchlist(readFileSync(watchlistPath, 'utf8'))
    expect(problems).toEqual([])
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const row of rows) {
      expect(row.file).toMatch(/^skills\/.+\.md$/)
      expect(row.pages.length).toBeGreaterThan(0)
    }
  })

  test('the header and separator rows are not tools, whatever the column is called', () => {
    for (const heading of ['Tool | Facts file section', 'Topic | Facts file']) {
      const { rows, problems } = readWatchlist(`| ${heading} | Official pages |\n|---|---|---|\n| A | \`a.md\` | https://e.test |\n`)
      expect(rows).toEqual([{ tool: 'A', file: 'a.md', pages: ['https://e.test'] }])
      expect(problems).toEqual([])
    }
  })

  test('a row whose middle cell is not a facts file is a problem, not a skipped line', () => {
    const { rows, problems } = readWatchlist('| Tool | Facts file section | Official pages |\n|---|---|---|\n| Widgets | ask someone | https://e.test |\n')
    expect(rows).toEqual([])
    expect(problems.join(' ')).toContain('Widgets names no facts file')
  })

  // One subagent per tool only means something if one row is one vendor: two rows resolving to
  // the same section is one agent reading two changelogs, which is what the split prevents.
  test('every tool resolves to its own section, and no two share one', () => {
    const { rows } = readWatchlist(readFileSync(watchlistPath, 'utf8'))
    const seen = new Map<string, string>()
    for (const row of rows) {
      const text = readFileSync(join(repoRoot, row.file), 'utf8')
      const section = sectionLines(text, row.tool)
      expect(section, `${row.tool} has no section in ${row.file}`).not.toBeNull()
      const key = `${row.file}#${section![0]![1]}`
      expect(seen.get(key), `${row.tool} and ${seen.get(key)} resolve to the same section`).toBeUndefined()
      seen.set(key, row.tool)
    }
    expect(seen.size).toBe(rows.length)
  })

  // The hosts each row's pages live on: one vendor per row, so a subagent reads one site.
  test('a row names pages from one vendor, never several', () => {
    const { rows } = readWatchlist(readFileSync(watchlistPath, 'utf8'))
    for (const row of rows) {
      const hosts = new Set(row.pages.map((page: string) => new URL(page).hostname.replace(/^www\./, '')))
      // github.com carries a vendor's own releases, so it pairs with that vendor's docs host.
      const others = [...hosts].filter((host) => host !== 'github.com')
      expect(others.length, `${row.tool} spans ${[...hosts].join(', ')}`).toBeLessThanOrEqual(1)
    }
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
    expect(result.tools[0]).toMatchObject({ tool: 'Widgets', facts: 2, due: 1 })
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
    expect(result.problems.join(' ')).toContain('facts.md line 5')
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
    expect(scanFacts({ root, watchlist, today }).problems.join(' ')).toContain('has no matching ## heading')
  })

  // A section full of dated facts that no row covers looks maintained and is never re-read.
  test('a fact-bearing section no row covers is a problem', () => {
    const { root, watchlist } = repo({
      'watchlist.md': table('facts.md'),
      'facts.md': section(fact('Thing', '01-09-2026')) + '\n## Gadgets\n\n' + fact('Other thing', '01-09-2026'),
    })
    const result = scanFacts({ root, watchlist, today })
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('## Gadgets holds dated facts no watchlist row covers')
  })

  test('a covered section and a section with no facts are both fine', () => {
    const { root, watchlist } = repo({
      'watchlist.md': table('facts.md') + '| Gadgets | `facts.md` | https://example.test/gadgets |\n',
      'facts.md': section(fact('Thing', '01-09-2026')) + '\n## Gadgets\n\n' + fact('Other', '01-09-2026') + '\n## Prose only\n\nNo facts here.\n',
    })
    expect(scanFacts({ root, watchlist, today }).problems).toEqual([])
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
    expect(result.tools.every((entry: { facts: number }) => entry.facts > 0)).toBe(true)
  })
})

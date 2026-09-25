#!/usr/bin/env node
// skills-refresh's gatherer: read the watchlist, parse every facts file it names, and report
// which lines are past the sweep window and which do not parse. Read-only and deterministic —
// it never touches the network and never edits a skill. The skill decides what to do with it.
//
// Flags, all optional: root (the repo to read, default the working directory), watchlist (the
// table's path, default this skill's own), max-age-days (the sweep window, default 60), today
// (a DD-MM-YYYY date, so a test can pin the clock) and json.
// Exit: 0 every fact fresh · 1 something is due · 2 a file or line could not be read.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY = 86_400_000
const here = dirname(fileURLToPath(import.meta.url))

// `- **<capability>** · <how> · since <version> · checked DD-MM-YYYY · <https url>`
const FACT = /^-\s+\*\*(?<capability>[^*]+)\*\*\s+·\s+(?<how>.+?)\s+·\s+since\s+(?<since>[^·]+?)\s+·\s+checked\s+(?<checked>\d{2}-\d{2}-\d{4})\s+·\s+(?<link>https:\/\/\S+)\s*$/

/** A line that opens like a fact but does not parse is an error, not a paragraph. */
const LOOKS_LIKE_FACT = /^-\s+\*\*[^*]+\*\*\s+·/

export function parseDate(text) {
  const [day, month, year] = text.split('-').map(Number)
  const at = Date.UTC(year, month - 1, day)
  const back = new Date(at)
  return back.getUTCDate() === day && back.getUTCMonth() === month - 1 && back.getUTCFullYear() === year ? at : null
}

/** Reads the watchlist's one table: tool, facts file section, official pages. */
export function readWatchlist(text) {
  const rows = []
  const problems = []
  for (const [index, line] of text.split('\n').entries()) {
    const cells = line.trim().startsWith('|') ? line.trim().slice(1, -1).split('|').map(cell => cell.trim()) : null
    if (!cells || cells.length !== 3) continue
    const [tool, raw, pages] = cells
    const file = raw.replace(/^`|`$/g, '')
    // A data row is the one whose middle cell is a Markdown path. The header and the separator
    // are skipped by that shape rather than by their wording, so renaming a column heading
    // cannot turn the header into a tool nobody notices.
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue
    if (!file.endsWith('.md')) {
      if (tool && !/^(tool|topic)$/i.test(tool)) problems.push('watchlist row ' + (index + 1) + ': ' + tool + ' names no facts file')
      continue
    }
    const links = [...pages.matchAll(/https:\/\/[^\s)\]]+/g)].map(match => match[0])
    if (!links.length) problems.push('watchlist row ' + (index + 1) + ': ' + tool + ' names no official page')
    rows.push({ tool, file, pages: links })
  }
  if (!rows.length) problems.push('watchlist: no tool rows found')
  return { rows, problems }
}

/**
 * The lines under `## <tool>` in a facts file, with their 1-based numbers. A row names a
 * section, not a whole file: several tools share one file, and a sweep reads one tool at a
 * time. The heading may carry a version in parentheses, so the match is on its opening words.
 */
export function sectionLines(text, tool) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('## ') && line.slice(3).trim().toLowerCase().startsWith(tool.toLowerCase()))
  if (start === -1) return null
  const after = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, after === -1 ? lines.length : after).map((line, index) => [line, start + 2 + index])
}

export function scanFacts({ root = process.cwd(), watchlist, maxAgeDays = 60, today = Date.now() } = {}) {
  const watchlistPath = watchlist ?? join(here, '../references/watchlist.md')
  if (!existsSync(watchlistPath)) return { ok: false, tools: [], due: [], problems: ['watchlist not found at ' + watchlistPath] }
  const { rows, problems } = readWatchlist(readFileSync(watchlistPath, 'utf8'))
  const tools = []
  const due = []
  const uncovered = new Set()
  let heading = null
  for (const row of rows) {
    const path = isAbsolute(row.file) ? row.file : resolve(root, row.file)
    if (!existsSync(path)) { problems.push(row.tool + ': facts file not found at ' + row.file); continue }
    const section = sectionLines(readFileSync(path, 'utf8'), row.tool)
    if (!section) { problems.push(row.tool + ': ' + row.file + ' has no matching ## heading'); continue }
    const facts = []
    for (const [line, index] of section) {
      const where = row.file + ' line ' + index
      const match = FACT.exec(line)
      if (!match) {
        if (LOOKS_LIKE_FACT.test(line)) problems.push(where + ': does not parse as a fact line')
        continue
      }
      const at = parseDate(match.groups.checked)
      if (at === null) { problems.push(where + ': checked date is not a real date'); continue }
      const ageDays = Math.floor((today - at) / DAY)
      const fact = { tool: row.tool, file: row.file, line: index, capability: match.groups.capability.trim(), since: match.groups.since.trim(), checked: match.groups.checked, ageDays, link: match.groups.link }
      facts.push(fact)
      if (ageDays >= maxAgeDays) due.push(fact)
    }
    if (!facts.length) problems.push(row.tool + ': ' + row.file + ' holds no fact lines under that heading')
    tools.push({ tool: row.tool, file: row.file, pages: row.pages, facts: facts.length, due: facts.filter(fact => fact.ageDays >= maxAgeDays).length, oldestAgeDays: facts.reduce((oldest, fact) => Math.max(oldest, fact.ageDays), 0) })
  }
  // A fact-bearing section no row covers is the quiet failure this scan exists to prevent: the
  // lines look maintained, carry dates, and nothing ever re-reads them. Reported per file, once.
  for (const file of [...new Set(rows.map(row => row.file))]) {
    const path = isAbsolute(file) ? file : resolve(root, file)
    if (!existsSync(path)) continue
    const covered = rows.filter(row => row.file === file).map(row => row.tool.toLowerCase())
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.startsWith('## ')) { if (heading && FACT.test(line)) { uncovered.add(file + ' ## ' + heading); heading = null } ; continue }
      const name = line.slice(3).trim()
      heading = covered.some(tool => name.toLowerCase().startsWith(tool)) ? null : name
    }
  }
  for (const entry of uncovered) problems.push(entry + ' holds dated facts no watchlist row covers')
  return { ok: problems.length === 0, maxAgeDays, tools, due, problems }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const get = flag => { const at = argv.indexOf(flag); return at === -1 ? undefined : argv[at + 1] }
  const todayText = get('--today')
  const today = todayText ? parseDate(todayText.includes('-') && todayText.length === 10 && todayText[4] === '-' ? todayText.slice(8, 10) + '-' + todayText.slice(5, 7) + '-' + todayText.slice(0, 4) : todayText) : Date.now()
  const result = scanFacts({
    root: get('--root') ?? process.cwd(),
    watchlist: get('--watchlist'),
    maxAgeDays: Number(get('--max-age-days') ?? 60),
    today: today ?? Date.now(),
  })
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    for (const entry of result.tools) console.log(entry.tool + ': ' + entry.facts + ' facts, ' + entry.due + ' due, oldest ' + entry.oldestAgeDays + 'd')
    for (const problem of result.problems) console.log('problem: ' + problem)
  }
  process.exit(result.problems.length ? 2 : result.due.length ? 1 : 0)
}

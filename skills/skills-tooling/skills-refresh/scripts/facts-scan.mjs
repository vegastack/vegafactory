#!/usr/bin/env node
// skills-refresh's gatherer: read the watchlist, parse every facts file it names, and report
// which lines are past the sweep window and which do not parse. Read-only and deterministic —
// it never touches the network and never edits a skill. The skill decides what to do with it.
//
// Usage: node facts-scan.mjs [--root <repo>] [--watchlist <path>] [--max-age-days 60]
//                            [--today YYYY-MM-DD] [--json]
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

/** Reads the watchlist's one table: `| topic | facts file | official pages |`. */
export function readWatchlist(text) {
  const rows = []
  const problems = []
  for (const [index, line] of text.split('\n').entries()) {
    const cells = line.trim().startsWith('|') ? line.trim().slice(1, -1).split('|').map(cell => cell.trim()) : null
    if (!cells || cells.length !== 3) continue
    const [topic, file, pages] = cells
    if (!topic || /^-+$/.test(topic) || topic.toLowerCase() === 'topic') continue
    const links = [...pages.matchAll(/https:\/\/[^\s)\]]+/g)].map(match => match[0])
    if (!links.length) problems.push(`watchlist:${index + 1}: topic "${topic}" names no official page`)
    rows.push({ topic, file: file.replace(/^`|`$/g, ''), pages: links })
  }
  if (!rows.length) problems.push('watchlist: no topic rows found')
  return { rows, problems }
}

/**
 * The lines under `## <topic>` in a facts file, with their 1-based numbers. A topic row names
 * a section, not a whole file: several topics share one file, and a sweep reads one topic at a
 * time. The heading may carry a version in parentheses, so the match is on its opening words.
 */
export function sectionLines(text, topic) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('## ') && line.slice(3).trim().toLowerCase().startsWith(topic.toLowerCase()))
  if (start === -1) return null
  const after = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, after === -1 ? lines.length : after).map((line, index) => [line, start + 2 + index])
}

export function scanFacts({ root = process.cwd(), watchlist, maxAgeDays = 60, today = Date.now() } = {}) {
  const watchlistPath = watchlist ?? join(here, '../references/watchlist.md')
  if (!existsSync(watchlistPath)) return { ok: false, topics: [], due: [], problems: [`watchlist not found at ${watchlistPath}`] }
  const { rows, problems } = readWatchlist(readFileSync(watchlistPath, 'utf8'))
  const topics = []
  const due = []
  for (const row of rows) {
    const path = isAbsolute(row.file) ? row.file : resolve(root, row.file)
    if (!existsSync(path)) { problems.push(`${row.topic}: facts file not found at ${row.file}`); continue }
    const section = sectionLines(readFileSync(path, 'utf8'), row.topic)
    if (!section) { problems.push(`${row.topic}: ${row.file} has no "## ${row.topic}" section`); continue }
    const facts = []
    for (const [line, index] of section) {
      const match = FACT.exec(line)
      if (!match) {
        if (LOOKS_LIKE_FACT.test(line)) problems.push(`${row.file}:${index}: does not parse as a fact line`)
        continue
      }
      const at = parseDate(match.groups.checked)
      if (at === null) { problems.push(`${row.file}:${index}: checked date is not a real date`); continue }
      const ageDays = Math.floor((today - at) / DAY)
      const fact = { topic: row.topic, file: row.file, line: index, capability: match.groups.capability.trim(), since: match.groups.since.trim(), checked: match.groups.checked, ageDays, link: match.groups.link }
      facts.push(fact)
      if (ageDays >= maxAgeDays) due.push(fact)
    }
    if (!facts.length) problems.push(`${row.topic}: ${row.file} holds no fact lines under that heading`)
    topics.push({ topic: row.topic, file: row.file, pages: row.pages, facts: facts.length, due: facts.filter(fact => fact.ageDays >= maxAgeDays).length, oldestAgeDays: facts.reduce((oldest, fact) => Math.max(oldest, fact.ageDays), 0) })
  }
  return { ok: problems.length === 0, maxAgeDays, topics, due, problems }
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
    for (const topic of result.topics) console.log(`${topic.topic}: ${topic.facts} facts, ${topic.due} due, oldest ${topic.oldestAgeDays}d`)
    for (const problem of result.problems) console.log(`problem: ${problem}`)
  }
  process.exit(result.problems.length ? 2 : result.due.length ? 1 : 0)
}

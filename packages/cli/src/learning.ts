// `vegafactory learning …` — the general lessons a session leaves behind.
//
// The Stop hook asks a working session for them once and they queue in .vegastack/.tmp/learnings.md;
// the next SessionStart shows what is pending. The model proposes each as one dev.md line and edits
// dev.md itself on the operator's yes — this command only reads the queue and drops a settled lesson.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './issue.ts'

export interface Lesson { id: string; text: string }

// One queue per repository, next to the dev.md the lessons are headed for.
export const learningsPath = (root: string) => join(root, '.vegastack', '.tmp', 'learnings.md')

const idOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 7)

// One lesson per list line; a heading, a blank line or the word `none` is not a lesson.
const lessonOn = (line: string) => /^\s*[-*]\s+(.*\S)\s*$/.exec(line)?.[1] ?? null

export function readLessons(root: string): Lesson[] {
  let text: string
  try { text = readFileSync(learningsPath(root), 'utf8') } catch { return [] }
  const seen = new Set<string>()
  return text.split('\n').flatMap((line) => {
    const found = lessonOn(line)
    if (found === null) return []
    const lesson = { id: idOf(found), text: found }
    if (seen.has(lesson.id)) return []
    seen.add(lesson.id)
    return [lesson]
  })
}

// Drops the lesson, accepted or declined alike: dev.md is the model's to edit, never this command's.
export function settle(root: string, id: string): Lesson | null {
  const lesson = readLessons(root).find((entry) => entry.id === id)
  if (!lesson) return null
  const path = learningsPath(root)
  const kept = readFileSync(path, 'utf8').split('\n').filter((line) => {
    const found = lessonOn(line)
    return found === null || idOf(found) !== lesson.id
  })
  // An empty queue is no queue: the file goes rather than linger with a stale heading.
  if (kept.some((line) => lessonOn(line) !== null)) writeFileSync(path, kept.join('\n'))
  else rmSync(path, { force: true })
  return lesson
}

// The one request a working session gets, delivered as the harness's own Stop continuation.
export function askText(root: string, number: number): string {
  return [
    `Before this session ends, one request: which general lessons did it teach — the things that would have saved time on any issue in this repo, not the ones specific to #${number}?`,
    `Append each as one \`- \` line to ${learningsPath(root)}, keeping the lines already there, or write the single word none.`,
    `They are proposed as .vegastack/dev.md lines at the next session start and land only on the operator's yes. Then stop.`,
  ].join(' ')
}

// What SessionStart says when lessons are waiting.
export function pendingNote(root: string): string | null {
  const lessons = readLessons(root)
  if (!lessons.length) return null
  return [
    `Lessons from earlier sessions are waiting in ${learningsPath(root)}:`,
    ...lessons.map((lesson) => `  ${lesson.id}  ${lesson.text}`),
    'Propose each as ONE .vegastack/dev.md line, folded into an existing line where it fits, and add it only on the user\'s explicit yes.',
    'Then record the answer: `vegafactory learning accept <id>` on a yes, `vegafactory learning decline <id>` on a no, which drops the lesson.',
    'This repository\'s dev.md only — org and group control-room lines stay manual.',
  ].join('\n')
}

export function learningUsage(): string {
  return `Usage: vegafactory learning <verb> [id]

  list [--json]        the lessons waiting for the operator's yes
  accept <id>          the operator said yes — drop it from the queue (you write the dev.md line, not this command)
  decline <id>         the operator said no — drop it from the queue

The Stop hook collects them, one per line, into .vegastack/.tmp/learnings.md.
`
}

export function runLearning(argv: string[], { cwd = process.cwd(), out = console.log } = {}): number {
  const [verb, ...rest] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) { out(learningUsage()); return 0 }
  const root = repoRoot(cwd)
  const json = rest.includes('--json')
  if (verb === 'list') {
    const lessons = readLessons(root)
    const text = lessons.length ? lessons.map((lesson) => `${lesson.id}  ${lesson.text}`).join('\n') : 'no lessons are waiting'
    out(json ? JSON.stringify({ path: learningsPath(root), lessons }, null, 2) : text)
    return 0
  }
  if (verb === 'accept' || verb === 'decline') {
    const id = rest.find((arg) => !arg.startsWith('--'))
    if (!id) throw new Error(`learning ${verb} needs a lesson id — run vegafactory learning list`)
    const lesson = settle(root, id)
    if (!lesson) { out(`no lesson ${id} is waiting`); return 2 }
    const text = verb === 'accept' ? `accepted ${lesson.id} — the dev.md line is yours to write; this only dropped it from the queue` : `declined ${lesson.id}`
    out(json ? JSON.stringify({ verb, ...lesson }, null, 2) : text)
    return 0
  }
  throw new Error(`unknown learning verb: ${verb} — run vegafactory learning --help`)
}

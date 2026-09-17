// `vegafactory learning …` — the general lessons a session leaves behind.
//
// The Stop hook asks a working session for them once and the session records each with `learning
// add`; the next SessionStart shows what is waiting. The model proposes each as one dev.md line and
// edits dev.md itself on the operator's yes — this command only keeps the queue and drops a settled
// lesson. Every read and every write goes through one lock and one checked path, so two sessions
// cannot lose each other's lessons and no link can turn a settlement into an edit of dev.md.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './issue-cache.ts'
import { repoRoot } from './issue.ts'

export interface Lesson { id: string; text: string }

// One lesson is one future dev.md line, so it is one line here too.
const MAX_LESSON = 300

const idOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 7)

// One lesson per list line; a heading, a blank line or any other prose is not a lesson.
const lessonOn = (line: string) => /^\s*[-*]\s+(.*\S)\s*$/.exec(line)?.[1] ?? null

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_LESSON)

function linkFree(path: string) {
  let entry
  try { entry = lstatSync(path) } catch { return }
  if (entry.isSymbolicLink()) throw new Error(`${path} is a symbolic link — delete it; the lessons queue is a plain file under .vegastack/.tmp and this command never writes through a link`)
}

// The queue is a real file inside this repository's own .vegastack/.tmp. Checked on every read and
// every write, because a link left at that name would otherwise make accept rewrite whatever it
// points at — dev.md, say, which nothing here may ever touch.
export function learningsPath(root: string): string {
  const vegastack = join(root, '.vegastack')
  const tmp = join(vegastack, '.tmp')
  const path = join(tmp, 'learnings.md')
  for (const part of [vegastack, tmp, path]) linkFree(part)
  try {
    const expected = join(realpathSync(root), '.vegastack', '.tmp')
    if (realpathSync(tmp) !== expected) throw new Error(`${tmp} resolves to ${realpathSync(tmp)}, outside ${expected}`)
  } catch (error) {
    // The directory not existing yet is fine; anything else is a path we will not write through.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return path
}

// Every read and every write of the queue runs inside this, across processes as well as within one.
export const lockQueue = <T>(root: string, fn: () => T): T =>
  withLock(join(root, '.vegastack', '.tmp', 'learning'), fn, { what: 'the lessons queue' })

function parse(text: string): Lesson[] {
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

function readQueue(root: string): { path: string; text: string } {
  const path = learningsPath(root)
  try { return { path, text: readFileSync(path, 'utf8') } } catch { return { path, text: '' } }
}

// Replaces the queue without following a link: the temp file is renamed over the name, and rename
// replaces the name itself. An empty queue is no queue, so the file goes rather than linger.
function replace(path: string, lines: string[]) {
  if (!lines.some((line) => lessonOn(line) !== null)) return rmSync(path, { force: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, lines.join('\n').replace(/\n*$/, '\n'))
  renameSync(temp, path)
}

export function readLessons(root: string): Lesson[] {
  return lockQueue(root, () => parse(readQueue(root).text))
}

// Appends one lesson. Under the same lock as settling, so an append during an accept is never lost.
export function addLesson(root: string, raw: string): Lesson {
  const text = oneLine(raw)
  if (!text) throw new Error('a lesson needs some text — run vegafactory learning --help')
  return lockQueue(root, () => {
    const { path, text: current } = readQueue(root)
    const lesson = { id: idOf(text), text }
    if (parse(current).some((entry) => entry.id === lesson.id)) return lesson
    const lines = current ? current.replace(/\n*$/, '').split('\n') : []
    replace(path, [...lines, `- ${text}`])
    return lesson
  })
}

// Drops the lesson, accepted or declined alike: dev.md is the model's to edit, never this command's.
export function settle(root: string, id: string): Lesson | null {
  return lockQueue(root, () => {
    const { path, text } = readQueue(root)
    const lesson = parse(text).find((entry) => entry.id === id)
    if (!lesson) return null
    replace(path, text.replace(/\n*$/, '').split('\n').filter((line) => {
      const found = lessonOn(line)
      return found === null || idOf(found) !== lesson.id
    }))
    return lesson
  })
}

// The one request a working session gets, delivered as the harness's own Stop continuation.
export function askText(root: string, number: number): string {
  return [
    `Before this session ends, one request: which general lessons did it teach — the things that would have saved time on any issue in this repo, not the ones specific to #${number}?`,
    `Record each one with: vegafactory learning add "<the lesson in one line>"`,
    `Nothing general to add? Then add nothing and leave the queue in ${learningsPath(root)} exactly as it is.`,
    `Recorded lessons are proposed as .vegastack/dev.md lines at the next session start and land only on the operator's yes. Then stop.`,
  ].join(' ')
}

// What SessionStart says when lessons are waiting. It never throws: a queue that cannot be trusted
// is worth saying out loud, not worth losing the rest of the session's context over.
export function pendingNote(root: string): string | null {
  let lessons: Lesson[]
  try {
    lessons = readLessons(root)
  } catch (error) {
    return `The lessons queue could not be read: ${(error as Error).message}`
  }
  if (!lessons.length) return null
  return [
    `Lessons from earlier sessions are waiting in ${join(root, '.vegastack', '.tmp', 'learnings.md')}:`,
    ...lessons.map((lesson) => `  ${lesson.id}  ${lesson.text}`),
    'Propose each as ONE .vegastack/dev.md line, folded into an existing line where it fits, and add it only on the user\'s explicit yes.',
    'Then record the answer: `vegafactory learning accept <id>` on a yes, `vegafactory learning decline <id>` on a no, which drops the lesson.',
    'This repository\'s dev.md only — org and group control-room lines stay manual.',
  ].join('\n')
}

export function learningUsage(): string {
  return `Usage: vegafactory learning <verb> [text|id]

  add "<lesson>"       record one general lesson, in one line
  list [--json]        the lessons waiting for the operator's yes
  accept <id>          the operator said yes — drop it from the queue (you write the dev.md line, not this command)
  decline <id>         the operator said no — drop it from the queue

The queue is .vegastack/.tmp/learnings.md, which is git-ignored and never leaves the machine.
Nothing to record means running nothing: the queue is left alone.
`
}

export function runLearning(argv: string[], { cwd = process.cwd(), out = console.log } = {}): number {
  const [verb, ...rest] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) { out(learningUsage()); return 0 }
  const root = repoRoot(cwd)
  const json = rest.includes('--json')
  const plain = rest.filter((arg) => !arg.startsWith('--'))
  if (verb === 'add') {
    const lesson = addLesson(root, plain.join(' '))
    out(json ? JSON.stringify({ verb, ...lesson }, null, 2) : `recorded ${lesson.id}  ${lesson.text}`)
    return 0
  }
  if (verb === 'list') {
    const lessons = readLessons(root)
    const text = lessons.length ? lessons.map((lesson) => `${lesson.id}  ${lesson.text}`).join('\n') : 'no lessons are waiting'
    out(json ? JSON.stringify({ path: learningsPath(root), lessons }, null, 2) : text)
    return 0
  }
  if (verb === 'accept' || verb === 'decline') {
    const id = plain[0]
    if (!id) throw new Error(`learning ${verb} needs a lesson id — run vegafactory learning list`)
    const lesson = settle(root, id)
    if (!lesson) { out(`no lesson ${id} is waiting`); return 2 }
    const text = verb === 'accept' ? `accepted ${lesson.id} — the dev.md line is yours to write; this only dropped it from the queue` : `declined ${lesson.id}`
    out(json ? JSON.stringify({ verb, ...lesson }, null, 2) : text)
    return 0
  }
  throw new Error(`unknown learning verb: ${verb} — run vegafactory learning --help`)
}

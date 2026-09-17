// `vegafactory learning …` — the general lessons a session leaves behind.
//
// The Stop hook asks a working session for them once and the session records each with `learning
// add`; the next SessionStart shows what is waiting. The model proposes each as one dev.md line and
// edits dev.md itself on the operator's yes — this command only keeps the queue and drops a settled
// lesson. Every read and every write goes through one lock and one checked path, so two sessions
// cannot lose each other's lessons and no link can turn a settlement into an edit of dev.md.
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { replaceFile, withLock } from './issue-cache.ts'
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

// The queue and its lock are real paths inside this repository's own .vegastack/.tmp. Every
// component is checked before anything is opened, taken or created, because a link anywhere on the
// way would otherwise let this command write outside the repository — over dev.md, say, which
// nothing here may ever touch.
function checkedPaths(root: string): { queue: string; lock: string; drafts: string } {
  const vegastack = join(root, '.vegastack')
  const tmp = join(vegastack, '.tmp')
  const paths = { queue: join(tmp, 'learnings.md'), lock: join(tmp, 'learning'), drafts: join(tmp, 'lessons') }
  for (const part of [vegastack, tmp, paths.lock, paths.queue, paths.drafts]) linkFree(part)
  try {
    const expected = join(realpathSync(root), '.vegastack', '.tmp')
    if (realpathSync(tmp) !== expected) throw new Error(`${tmp} resolves to ${realpathSync(tmp)}, outside ${expected}`)
  } catch (error) {
    // The directory not existing yet is fine; anything else is a path we will not write through.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return paths
}

export const learningsPath = (root: string) => checkedPaths(root).queue

// A fresh, private folder for one session's draft. The folder is created exclusively, so a name
// already taken — by another session's draft or by a link planted to catch the model's own
// file-writing tool — fails here instead of being written into. The draft file itself does not
// exist yet, which is exactly what the model's tool expects and what leaves nothing to follow.
export function scratchFor(root: string, name: string = randomUUID()): string {
  const drafts = checkedPaths(root).drafts
  mkdirSync(drafts, { recursive: true })
  sweepDrafts(drafts)
  const folder = join(drafts, name)
  linkFree(folder)
  mkdirSync(folder)
  return join(folder, 'lessons.md')
}

// A draft a session never came back for is litter after a week.
const DRAFT_LIFE_MS = 7 * 24 * 60 * 60_000
function sweepDrafts(drafts: string, now = Date.now()) {
  for (const name of readdirSync(drafts)) {
    const folder = join(drafts, name)
    try {
      const entry = lstatSync(folder)
      if (entry.isDirectory() && now - entry.mtimeMs > DRAFT_LIFE_MS) rmSync(folder, { recursive: true, force: true })
    } catch { /* gone already, or someone else's to worry about */ }
  }
}

// A draft is spent once its lessons are recorded, and it is ours to remove only inside our own tree.
function dropScratch(root: string, file: string) {
  const folder = dirname(resolve(file))
  if (dirname(folder) !== checkedPaths(root).drafts) return
  rmSync(folder, { recursive: true, force: true })
}

// Every read and every write of the queue runs inside this, across processes as well as within one.
// The checks come first, so a bad path is refused before the lock directory is created anywhere.
export function lockQueue<T>(root: string, fn: () => T): T {
  return withLock(checkedPaths(root).lock, fn, { what: 'the lessons queue' })
}

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

// An empty queue is no queue, so the file goes rather than linger. Anything else is replaced
// through `replaceFile`, which never follows a link.
function replace(path: string, lines: string[]) {
  if (!lines.some((line) => lessonOn(line) !== null)) return rmSync(path, { force: true })
  replaceFile(path, lines.join('\n').replace(/\n*$/, '\n'))
}

export function readLessons(root: string): Lesson[] {
  return lockQueue(root, () => parse(readQueue(root).text))
}

// One lesson per line of whatever the session wrote, with an optional list marker.
export function lessonsIn(text: string): string[] {
  return text.split('\n').map((line) => oneLine(lessonOn(line) ?? line)).filter((line) => line !== '')
}

// Appends lessons in one lock, so an append during an accept is never lost and a batch is one write.
export function addLessons(root: string, texts: string[]): Lesson[] {
  const wanted = texts.map(oneLine).filter((text) => text !== '')
  if (!wanted.length) throw new Error('a lesson needs some text — run vegafactory learning --help')
  return lockQueue(root, () => {
    const { path, text: current } = readQueue(root)
    const lines = current ? current.replace(/\n*$/, '').split('\n') : []
    const added: Lesson[] = []
    for (const text of wanted) {
      const lesson = { id: idOf(text), text }
      added.push(lesson)
      if (parse(lines.join('\n')).some((entry) => entry.id === lesson.id)) continue
      lines.push(`- ${text}`)
    }
    replace(path, lines)
    return added
  })
}

export const addLesson = (root: string, raw: string): Lesson => addLessons(root, [raw])[0]!

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

// The one request a working session gets, delivered as the harness's own Stop continuation. The
// lessons travel in a file, never as words in a command: prose on a command line is prose the
// shell reads, and a backtick or a $(…) in a lesson is text, not an instruction.
export function askText(root: string, number: number): string {
  const draft = scratchFor(root)
  return [
    `Before this session ends, one request: which general lessons did it teach — the things that would have saved time on any issue in this repo, not the ones specific to #${number}?`,
    `Write them with your file-writing tool, one per line, to ${draft}, then record them by running: vegafactory learning add --file ${draft}`,
    `Put the words in the file only, never in the command, so every quote and backtick stays literal.`,
    `Nothing general to add? Then run nothing and leave the queue in ${learningsPath(root)} exactly as it is.`,
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
  return `Usage: vegafactory learning <verb> [options]

  add --file PATH      record the lessons in that file, one per line; a draft written in
                       .vegastack/.tmp/lessons/ is removed once its lessons are recorded
  add --stdin          the same, read from standard input
  add <words…>         one short lesson, for a caller that controls its own quoting
  list [--json]        the lessons waiting for the operator's yes
  accept <id>          the operator said yes — drop it from the queue (you write the dev.md line, not this command)
  decline <id>         the operator said no — drop it from the queue

Prefer --file: lesson text in a file passes through no shell, so quotes and backticks stay literal.
The queue is .vegastack/.tmp/learnings.md, which is git-ignored and never leaves the machine.
Nothing to record means running nothing: the queue is left alone.
`
}

export function runLearning(argv: string[], { cwd = process.cwd(), out = console.log } = {}): number {
  const [verb, ...rest] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) { out(learningUsage()); return 0 }
  const root = repoRoot(cwd)
  const json = rest.includes('--json')
  const flag = (name: string): string | null => {
    const at = rest.indexOf(name)
    if (at === -1) return null
    const value = rest[at + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  const file = flag('--file')
  // Everything that is not a flag or a flag's value.
  const plain = rest.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && rest[index - 1] === '--file'))
  if (verb === 'add') {
    const source = file !== null ? readFileSync(resolve(cwd, file), 'utf8') : rest.includes('--stdin') ? readFileSync(0, 'utf8') : plain.join(' ')
    const lessons = addLessons(root, lessonsIn(source))
    // The draft has done its job; leaving it behind is leaving the same words in two places.
    if (file !== null) dropScratch(root, resolve(cwd, file))
    out(json ? JSON.stringify({ verb, lessons }, null, 2) : lessons.map((lesson) => `recorded ${lesson.id}  ${lesson.text}`).join('\n'))
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

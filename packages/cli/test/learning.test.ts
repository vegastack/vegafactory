import { beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLesson, learningsPath, pendingNote, readLessons, runLearning, settle } from '../src/learning.ts'

let root: string
let out: string[]
const DEV_MD = 'repo: o/r · default branch main\n'
const run = (...argv: string[]) => { out = []; return runLearning(argv, { cwd: root, out: (text) => out.push(text) }) }
const queue = () => readFileSync(learningsPath(root), 'utf8')
const devMdPath = () => join(root, '.vegastack', 'dev.md')
const devMd = () => readFileSync(devMdPath(), 'utf8')

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'learning-')))
  spawnSync('git', ['init', '-q', '-b', 'main', root])
  mkdirSync(join(root, '.vegastack', '.tmp'), { recursive: true })
  writeFileSync(devMdPath(), DEV_MD)
})

describe('the pending queue', () => {
  test('add records one line at a time and list reads them back', () => {
    expect(run('list')).toBe(0)
    expect(out.join('\n')).toBe('no lessons are waiting')
    expect(pendingNote(root)).toBe(null)
    expect(existsSync(learningsPath(root))).toBe(false)

    expect(run('add', 'the skill scan reads the built bundle,\n  so build first')).toBe(0)
    expect(out.join('\n')).toContain('recorded')
    expect(run('add', 'unset ANTHROPIC_BASE_URL before the tests')).toBe(0)
    // A lesson is one line, whatever shape it arrived in.
    expect(queue()).toBe('- the skill scan reads the built bundle, so build first\n- unset ANTHROPIC_BASE_URL before the tests\n')
    expect(readLessons(root).map((lesson) => lesson.text)).toEqual(['the skill scan reads the built bundle, so build first', 'unset ANTHROPIC_BASE_URL before the tests'])

    // The same lesson twice is one lesson, and empty text is refused.
    addLesson(root, 'unset ANTHROPIC_BASE_URL before the tests')
    expect(readLessons(root)).toHaveLength(2)
    expect(() => run('add', '   ')).toThrow('needs some text')
    expect(run('list')).toBe(0)
    expect(out.join('\n')).toBe(readLessons(root).map((lesson) => `${lesson.id}  ${lesson.text}`).join('\n'))
  })

  test('a lesson only reaches dev.md through the model: accept drops it and writes nothing', () => {
    addLesson(root, 'the skill scan reads the built bundle')
    addLesson(root, 'unset ANTHROPIC_BASE_URL before the tests')
    const [first, second] = readLessons(root)
    expect(run('accept', first!.id)).toBe(0)
    expect(out.join('\n')).toContain('the dev.md line is yours to write')
    expect(queue()).toBe(`- ${second!.text}\n`)
    expect(devMd()).toBe(DEV_MD)

    // A declined lesson is dropped just the same, and the empty queue file goes with it.
    expect(run('decline', second!.id)).toBe(0)
    expect(out.join('\n')).toBe(`declined ${second!.id}`)
    expect(existsSync(learningsPath(root))).toBe(false)
    expect(devMd()).toBe(DEV_MD)
  })

  test('an unknown id exits 2 and a missing one is an error', () => {
    addLesson(root, 'one lesson')
    expect(run('accept', 'deadbee')).toBe(2)
    expect(out.join('\n')).toBe('no lesson deadbee is waiting')
    expect(readLessons(root)).toHaveLength(1)
    expect(() => run('accept')).toThrow('needs a lesson id')
    expect(() => run('sprinkle')).toThrow('unknown learning verb')
    expect(run('--help')).toBe(0)
    expect(out.join('\n')).toContain('add "<lesson>"')
  })

  test('the session-start note names the file, the one-line rule and the yes', () => {
    addLesson(root, 'the skill scan reads the built bundle')
    const note = pendingNote(root)!
    expect(note).toContain(learningsPath(root))
    expect(note).toContain('the skill scan reads the built bundle')
    expect(note).toContain('ONE .vegastack/dev.md line')
    expect(note).toContain("only on the user's explicit yes")
    expect(note).toContain('control-room lines stay manual')
  })
})

describe('concurrent settlement', () => {
  const MODULE = JSON.stringify(join(import.meta.dir, '../src/learning.ts'))

  test('appends around an accept and a decline lose nothing and resurrect nothing', () => {
    addLesson(root, 'lesson one')
    addLesson(root, 'lesson two')
    const [one, two] = readLessons(root)

    const appended: string[] = []
    const neighbour = () => { appended.push(addLesson(root, `lesson ${appended.length + 3}`).id) }
    const settledOne = settle(root, one!.id)
    neighbour()
    const settledTwo = settle(root, two!.id)
    neighbour()

    expect([settledOne?.id, settledTwo?.id]).toEqual([one!.id, two!.id])
    const left = readLessons(root)
    expect(left.map((lesson) => lesson.text)).toEqual(['lesson 3', 'lesson 4'])
    expect(left.map((lesson) => lesson.id)).toEqual(appended)
    // Settling the same lesson twice is a no-op, never a resurrection.
    expect(settle(root, one!.id)).toBe(null)
    expect(readLessons(root)).toHaveLength(2)
  })

  test('a mutation waits for the lock another process holds, and settles against what it left', async () => {
    addLesson(root, 'lesson one')
    const [one] = readLessons(root)
    const ready = join(root, 'holding')
    // The other process takes the lock, appends, and keeps holding for a moment.
    const holder = spawn(process.execPath, ['-e', `
      const { addLesson, lockQueue } = await import(${MODULE})
      const { writeFileSync } = await import('node:fs')
      lockQueue(${JSON.stringify(root)}, () => {
        addLesson(${JSON.stringify(root)}, 'lesson from the other process')
        writeFileSync(${JSON.stringify(ready)}, 'held')
        Bun.sleepSync(600)
      })
    `], { stdio: 'ignore' })
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20)
      expect(existsSync(ready)).toBe(true)
      const started = Date.now()
      // This settlement cannot start until the holder lets go, so it sees the appended lesson.
      expect(settle(root, one!.id)?.id).toBe(one!.id)
      expect(Date.now() - started).toBeGreaterThan(100)
      expect(readLessons(root).map((lesson) => lesson.text)).toEqual(['lesson from the other process'])
    } finally { holder.kill() }
  })
})

describe('the queue is a plain file under .vegastack/.tmp', () => {
  test('a learnings.md symlinked at dev.md is refused, so dev.md is neither read nor rewritten', () => {
    symlinkSync(devMdPath(), join(root, '.vegastack', '.tmp', 'learnings.md'))
    expect(lstatSync(join(root, '.vegastack', '.tmp', 'learnings.md')).isSymbolicLink()).toBe(true)

    expect(() => learningsPath(root)).toThrow('symbolic link')
    expect(() => readLessons(root)).toThrow('symbolic link')
    expect(() => addLesson(root, 'a lesson')).toThrow('symbolic link')
    expect(() => settle(root, 'deadbee')).toThrow('symbolic link')
    // dev.md's own lines are never mistaken for lessons, and nothing wrote through the link.
    expect(devMd()).toBe(DEV_MD)
    expect(pendingNote(root)).toContain('could not be read')
  })

  test('a symlinked .tmp directory is refused too', () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'learning-away-')))
    const tmp = join(root, '.vegastack', '.tmp')
    spawnSync('rm', ['-rf', tmp])
    symlinkSync(elsewhere, tmp)
    expect(() => learningsPath(root)).toThrow('symbolic link')
    expect(existsSync(join(elsewhere, 'learnings.md'))).toBe(false)
  })
})

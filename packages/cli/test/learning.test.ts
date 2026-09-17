import { beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { writeNew } from '../src/issue-cache.ts'
import { addLesson, learningsPath, lessonsIn, pendingNote, readLessons, runLearning, scratchFor, settle } from '../src/learning.ts'

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

    expect(run('add', '  the skill scan reads the   built bundle  ')).toBe(0)
    expect(out.join('\n')).toContain('recorded')
    expect(run('add', 'unset ANTHROPIC_BASE_URL before the tests')).toBe(0)
    // One line in, one lesson out, with the spacing tidied.
    expect(queue()).toBe('- the skill scan reads the built bundle\n- unset ANTHROPIC_BASE_URL before the tests\n')
    expect(readLessons(root).map((lesson) => lesson.text)).toEqual(['the skill scan reads the built bundle', 'unset ANTHROPIC_BASE_URL before the tests'])

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
    expect(out.join('\n')).toContain('add --file PATH')
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

  test('a symlinked .tmp directory is refused before anything is created at its target', () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'learning-away-')))
    const tmp = join(root, '.vegastack', '.tmp')
    spawnSync('rm', ['-rf', tmp])
    symlinkSync(elsewhere, tmp)
    expect(() => learningsPath(root)).toThrow('symbolic link')
    expect(() => readLessons(root)).toThrow('symbolic link')
    expect(() => addLesson(root, 'a lesson')).toThrow('symbolic link')
    // The lock is taken only after the checks, so not even the lock directory reaches the target.
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test('a symlinked lock directory is refused, and its target stays empty', () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'learning-lock-')))
    symlinkSync(elsewhere, join(root, '.vegastack', '.tmp', 'learning'))
    expect(() => addLesson(root, 'a lesson')).toThrow('symbolic link')
    expect(() => readLessons(root)).toThrow('symbolic link')
    expect(readdirSync(elsewhere)).toEqual([])
    expect(existsSync(join(root, '.vegastack', '.tmp', 'learnings.md'))).toBe(false)
  })

  test('the replacement write refuses a planted name rather than following it', () => {
    // Every queue replacement goes through this: an exclusive create, so a link planted at the
    // temp name is refused instead of being written through to dev.md.
    const planted = join(root, '.vegastack', '.tmp', 'learnings.md.planted.tmp')
    symlinkSync(devMdPath(), planted)
    expect(() => writeNew(planted, '- a lesson\n')).toThrow(/EEXIST|exists/)
    expect(devMd()).toBe(DEV_MD)
    // And the real path leaves nothing behind for a next attempt to find.
    addLesson(root, 'a lesson')
    expect(readdirSync(join(root, '.vegastack', '.tmp')).filter((name) => name.endsWith('.tmp'))).toEqual(['learnings.md.planted.tmp'])
  })
})

describe('the scratch draft a continuation hands out', () => {
  const drafts = () => join(root, '.vegastack', '.tmp', 'lessons')

  test('each session gets its own folder, so two drafts never collide', () => {
    const one = scratchFor(root)
    const two = scratchFor(root)
    expect(one).not.toBe(two)
    expect(dirname(one)).not.toBe(dirname(two))
    for (const path of [one, two]) {
      expect(dirname(dirname(path))).toBe(drafts())
      // The folder is ours and empty; the file itself is the model's to write.
      expect(readdirSync(dirname(path))).toEqual([])
    }
    // The folder is created exclusively, so a name already taken is refused rather than reused.
    scratchFor(root, 'taken')
    expect(() => scratchFor(root, 'taken')).toThrow(/EEXIST|exists/)
  })

  test('a link planted at the draft path is refused and its target is untouched', () => {
    mkdirSync(drafts(), { recursive: true })
    symlinkSync(devMdPath(), join(drafts(), 'planted'))
    expect(() => scratchFor(root, 'planted')).toThrow(/symbolic link|EEXIST|exists/)
    expect(devMd()).toBe(DEV_MD)
    // The whole drafts folder being a link is refused too, before anything is created at its target.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'learning-drafts-')))
    spawnSync('rm', ['-rf', drafts()])
    symlinkSync(elsewhere, drafts())
    expect(() => scratchFor(root)).toThrow('symbolic link')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test('a recorded draft is removed, and a file outside the drafts folder is left alone', () => {
    const draft = scratchFor(root)
    writeFileSync(draft, '- a lesson from the draft\n')
    expect(run('add', '--file', draft)).toBe(0)
    expect(readLessons(root).map((lesson) => lesson.text)).toEqual(['a lesson from the draft'])
    expect(existsSync(dirname(draft))).toBe(false)

    // The same folder spelled another way is still the same folder.
    const second = scratchFor(root)
    writeFileSync(second, '- a lesson named relatively\n')
    expect(run('add', '--file', relative(root, second))).toBe(0)
    expect(existsSync(dirname(second))).toBe(false)
    expect(readdirSync(drafts())).toEqual([])

    const mine = join(root, 'notes.md')
    writeFileSync(mine, '- a lesson of my own\n')
    expect(run('add', '--file', mine)).toBe(0)
    expect(existsSync(mine)).toBe(true)
  })
})

describe('lesson text never passes through a shell', () => {
  const CLI = join(import.meta.dir, '../src/index.ts')
  // Everything a shell would take an interest in, plus a line a flag parser would.
  const NASTY = (marker: string) => [
    'quotes "double" and \'single\' stay put',
    'a backtick `date` is text',
    `a substitution $(touch ${marker}) is text`,
    'a variable $HOME and ${HOME} are text',
    '--force is a lesson, not a flag',
    'a trailing backslash \\',
  ]

  test('add --file round-trips every lesson exactly and runs none of it', () => {
    const marker = join(root, 'pwned')
    const draft = join(root, 'draft.md')
    writeFileSync(draft, NASTY(marker).map((line) => `- ${line}`).join('\n') + '\n')
    const result = spawnSync(process.execPath, [CLI, 'learning', 'add', '--file', draft], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readLessons(root).map((lesson) => lesson.text)).toEqual(NASTY(marker))
    expect(existsSync(marker)).toBe(false)
    expect(devMd()).toBe(DEV_MD)
  })

  test('add --stdin does the same, and a bare list is accepted with or without markers', () => {
    const marker = join(root, 'pwned-stdin')
    const result = spawnSync(process.execPath, [CLI, 'learning', 'add', '--stdin'], {
      cwd: root, encoding: 'utf8', input: NASTY(marker).join('\n') + '\n\n',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readLessons(root).map((lesson) => lesson.text)).toEqual(NASTY(marker))
    expect(existsSync(marker)).toBe(false)
  })

  test('one line is one lesson, marker or not, and blank lines are not lessons', () => {
    expect(lessonsIn('- one\n\ntwo\n  * three  \n')).toEqual(['one', 'two', 'three'])
    expect(() => runLearning(['add', '--file'], { cwd: root, out: () => {} })).toThrow('--file needs a value')
    writeFileSync(join(root, 'empty.md'), '\n\n')
    expect(() => runLearning(['add', '--file', join(root, 'empty.md')], { cwd: root, out: () => {} })).toThrow('needs some text')
  })
})

import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learningsPath, pendingNote, readLessons, runLearning } from '../src/learning.ts'

let root: string
let out: string[]
const DEV_MD = 'repo: o/r · default branch main\n'
const run = (...argv: string[]) => { out = []; return runLearning(argv, { cwd: root, out: (text) => out.push(text) }) }
const queue = () => readFileSync(learningsPath(root), 'utf8')
const devMd = () => readFileSync(join(root, '.vegastack', 'dev.md'), 'utf8')

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'learning-')))
  spawnSync('git', ['init', '-q', '-b', 'main', root])
  mkdirSync(join(root, '.vegastack', '.tmp'), { recursive: true })
  writeFileSync(join(root, '.vegastack', 'dev.md'), DEV_MD)
})

const write = (...lines: string[]) => writeFileSync(learningsPath(root), lines.join('\n') + '\n')

describe('the pending queue', () => {
  test('lists the list lines and nothing else', () => {
    expect(run('list')).toBe(0)
    expect(out.join('\n')).toBe('no lessons are waiting')
    expect(pendingNote(root)).toBe(null)

    write('# lessons', '', 'none', '- bun test needs ANTHROPIC_BASE_URL unset', '- the skill scan reads the built bundle')
    const lessons = readLessons(root)
    expect(lessons.map((lesson) => lesson.text)).toEqual(['bun test needs ANTHROPIC_BASE_URL unset', 'the skill scan reads the built bundle'])
    expect(run('list')).toBe(0)
    expect(out.join('\n')).toBe(lessons.map((lesson) => `${lesson.id}  ${lesson.text}`).join('\n'))
    expect(JSON.parse((run('list', '--json'), out.join('\n'))).lessons).toEqual(lessons)
  })

  test('a lesson only reaches dev.md through the model: accept drops it and writes nothing', () => {
    write('- bun test needs ANTHROPIC_BASE_URL unset', '- the skill scan reads the built bundle')
    const [first, second] = readLessons(root)
    expect(run('accept', first!.id)).toBe(0)
    expect(out.join('\n')).toContain('the dev.md line is yours to write')
    expect(queue()).not.toContain(first!.text)
    expect(queue()).toContain(second!.text)
    expect(devMd()).toBe(DEV_MD)

    // A declined lesson is dropped just the same, and the empty queue file goes with it.
    expect(run('decline', second!.id)).toBe(0)
    expect(out.join('\n')).toBe(`declined ${second!.id}`)
    expect(existsSync(learningsPath(root))).toBe(false)
    expect(devMd()).toBe(DEV_MD)
  })

  test('an unknown id exits 2 and a missing one is an error', () => {
    write('- one lesson')
    expect(run('accept', 'deadbee')).toBe(2)
    expect(out.join('\n')).toBe('no lesson deadbee is waiting')
    expect(readLessons(root)).toHaveLength(1)
    expect(() => run('accept')).toThrow('needs a lesson id')
    expect(() => run('sprinkle')).toThrow('unknown learning verb')
    expect(run('--help')).toBe(0)
  })

  test('the session-start note names the file, the one-line rule and the yes', () => {
    write('- the skill scan reads the built bundle')
    const note = pendingNote(root)!
    expect(note).toContain(learningsPath(root))
    expect(note).toContain('the skill scan reads the built bundle')
    expect(note).toContain('ONE .vegastack/dev.md line')
    expect(note).toContain("only on the user's explicit yes")
    expect(note).toContain('control-room lines stay manual')
  })
})

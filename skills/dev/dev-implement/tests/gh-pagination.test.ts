import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GhUnavailable, ghJson, splitJsonDocuments } from '../scripts/lib/gh.mjs'

const ghPrinting = (text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'gh-pages-')), 'gh')
  writeFileSync(path, `#!/bin/sh\ncat <<'VSKEOF'\n${text}\nVSKEOF\n`)
  chmodSync(path, 0o755)
  return path
}

describe('one complete stream of JSON documents', () => {
  test('array pages concatenate without confusing attacker-controlled strings for structure', () => {
    const page = (title: string) => JSON.stringify([{ title }])
    expect(splitJsonDocuments(page('fix: ]} [{ braces') + page('an escaped " quote ]'))).toEqual([
      [{ title: 'fix: ]} [{ braces' }],
      [{ title: 'an escaped " quote ]' }],
    ])
    expect(splitJsonDocuments('[1]\n [2]\n')).toEqual([[1], [2]])
    expect(splitJsonDocuments('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('truncation, mixed trailing bytes, imbalance, primitives, and empty output are refused', () => {
    for (const text of ['[{"number":1}', '[{"number":1}]]', '[1][', '[1] trailing', 'trailing [1]', '42', '']) {
      expect(splitJsonDocuments(text), text).toBeNull()
    }
  })

  test('the parser stays linear as pages grow', () => {
    const page = `[${Array.from({ length: 50 }, (_, i) => `{"number":${i},"title":"a ] b [ c"}`).join(',')}]`
    const time = (count: number) => {
      const started = performance.now()
      expect(splitJsonDocuments(page.repeat(count))).toHaveLength(count)
      return performance.now() - started
    }
    time(40)
    const small = Math.max(time(40), 0.5)
    expect(time(400)).toBeLessThan(small * 40)
  })
})

describe('ghJson pagination integration', () => {
  test('concatenated array pages arrive as one flat list', () => {
    const gh = ghPrinting('[{"number":1},{"number":2}]\n[{"number":3}]')
    expect(ghJson(['api', 'repos/o/r/issues', '--paginate'], { gh })).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }])
  })

  test('a single document stays unchanged', () => {
    expect(ghJson(['api', 'x'], { gh: ghPrinting('{"title":"one"}') })).toEqual({ title: 'one' })
    expect(ghJson(['api', 'x'], { gh: ghPrinting('[]') })).toEqual([])
  })

  test('mixed documents and trailing or malformed output fail closed', () => {
    for (const text of ['[1]{"bad":2}', '[1] trailing', '[1']) {
      expect(() => ghJson(['api', 'x', '--paginate'], { gh: ghPrinting(text) }), text).toThrow(GhUnavailable)
    }
  })
})

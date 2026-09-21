import { describe, expect, test } from 'bun:test'
import { splitJsonDocuments } from '../scripts/lib/gh.mjs'

// `gh --paginate` prints one JSON document per page, back to back with no separator. A single
// `JSON.parse` fails the moment a repository has more than a hundred of whatever was asked for,
// and the closed-issue check then silently sees nothing at all.
describe('one document per page, read as the list the caller asked for', () => {
  test('pages concatenate, and a single page still reads', () => {
    expect(splitJsonDocuments('[{"number":1}][{"number":2}]')).toEqual([[{ number: 1 }], [{ number: 2 }]])
    expect(splitJsonDocuments('[{"number":1}]')).toEqual([[{ number: 1 }]])
    // Whitespace is the only thing allowed between documents, and gh does print newlines.
    expect(splitJsonDocuments('[1]\n [2]\n')).toEqual([[1], [2]])
    // Objects, not only arrays — the caller decides whether that is what it wanted.
    expect(splitJsonDocuments('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
    expect(splitJsonDocuments('[]')).toEqual([[]])
  })

  test('brackets and quotes inside strings are text, not structure', () => {
    // A title is attacker-writable: anybody who can open an issue chooses these characters.
    // Built with JSON.stringify so the escaping is the real thing rather than a count of
    // backslashes in a test literal.
    const page = (title: string) => JSON.stringify([{ title }])
    expect(splitJsonDocuments(page('fix: ]} [{ braces') + page('an escaped " quote ]'))).toEqual([
      [{ title: 'fix: ]} [{ braces' }],
      [{ title: 'an escaped " quote ]' }],
    ])
    // A backslash before the closing quote must not escape it away.
    expect(splitJsonDocuments(page('ends with a backslash \\'))).toEqual([[{ title: 'ends with a backslash \\' }]])
  })

  test('anything that is not a run of documents is refused, not half-read', () => {
    // gh's own error text, appended after a good page. Reading the page and dropping the rest
    // would report a complete answer built from an incomplete one.
    expect(splitJsonDocuments('[{"number":1}]gateway timeout')).toBeNull()
    expect(splitJsonDocuments('[{"number":1}]"gateway timeout"')).toBeNull()
    expect(splitJsonDocuments('gateway timeout[{"number":1}]')).toBeNull()
    // Truncated output, an extra closing bracket, and nothing at all.
    expect(splitJsonDocuments('[{"number":1}')).toBeNull()
    expect(splitJsonDocuments('[{"number":1}]]')).toBeNull()
    expect(splitJsonDocuments('[{"number":1}]["unclosed')).toBeNull()
    // A document that opened and never closed leaves the scan mid-document, which is not
    // "nothing to report" either.
    expect(splitJsonDocuments('[1][')).toBeNull()
    expect(splitJsonDocuments('')).toBeNull()
    expect(splitJsonDocuments(null)).toBeNull()
    // Valid JSON that is not a document this can start from.
    expect(splitJsonDocuments('42')).toBeNull()
  })

  // The scan is single-pass. An earlier version re-parsed every prefix, which turns a hundred
  // pages of issue titles — text anybody can write — into quadratic work.
  test('it stays linear as pages are added', () => {
    const page = `[${Array.from({ length: 50 }, (_, i) => `{"number":${i},"title":"a ] b [ c"}`).join(',')}]`
    const time = (count: number) => {
      const text = page.repeat(count)
      const started = performance.now()
      expect(splitJsonDocuments(text)).toHaveLength(count)
      return performance.now() - started
    }
    time(40)
    const small = Math.max(time(40), 0.5)
    const large = time(400)
    // Ten times the input, well under a hundred times the work.
    expect(large).toBeLessThan(small * 40)
  })
})

import { describe, expect, test } from 'bun:test'
import { changelogEntry, checkTag, waitRegistry } from './release.mjs'

const changelog = `# @vegastack/vegafactory

## 0.20.0

### Minor Changes

- Lean rebuild.

## 0.19.9

### Patch Changes

- Older entry.
`

describe('changelogEntry', () => {
  test('returns only the requested version section', () => {
    expect(changelogEntry(changelog, '0.20.0')).toBe('### Minor Changes\n\n- Lean rebuild.')
    expect(changelogEntry(changelog, '0.19.9')).toBe('### Patch Changes\n\n- Older entry.')
  })

  test('is empty for a version with no section', () => {
    expect(changelogEntry(changelog, '1.0.0')).toBe('')
  })
})

describe('checkTag', () => {
  test('accepts a matching tag with a changelog entry', () => {
    expect(() => checkTag('v0.20.0', '0.20.0', changelog)).not.toThrow()
  })

  test('refuses a tag that differs from package.json', () => {
    expect(() => checkTag('v0.20.1', '0.20.0', changelog)).toThrow('does not match')
  })

  test('refuses a version without a changelog entry', () => {
    expect(() => checkTag('v1.0.0', '1.0.0', changelog)).toThrow('no entry for 1.0.0')
  })
})

describe('waitRegistry', () => {
  test('returns once the version becomes visible', async () => {
    const seen = [null, null, '0.20.0']
    const attempt = await waitRegistry('0.20.0', { view: () => seen.shift() ?? null, sleep: async () => {} })
    expect(attempt).toBe(3)
  })

  test('gives up after the attempt budget', async () => {
    await expect(waitRegistry('0.20.0', { attempts: 2, view: () => null, sleep: async () => {} })).rejects.toThrow('not visible')
  })
})

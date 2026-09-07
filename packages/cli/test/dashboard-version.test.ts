import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('the CLI and the dashboard ship one version, so the first-use fetch always resolves', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', p), 'utf8')).version
  expect(read('../dashboard/package.json')).toBe(read('package.json'))
})

test('release rejects mismatched packed discovery versions and tag', async () => {
  const { assertPairVersions } = await import('../../../scripts/release-artifacts.mjs')
  expect(() => assertPairVersions({ cli: '1.0.0', dashboard: '1.0.1', tag: 'v1.0.0' })).toThrow()
  expect(() => assertPairVersions({ cli: '1.0.0', dashboard: '1.0.0', tag: 'v0.9.0' })).toThrow()
})

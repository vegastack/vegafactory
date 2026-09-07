import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8')

test('is publishable at the CLI version, from an assembled standalone tree', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.name).toBe('@vegastack/vegafactory-dashboard')
  expect(manifest.private).toBeUndefined()
  expect(manifest.version).toBe(JSON.parse(read('../cli/package.json')).version)
  expect(manifest.files).toEqual(['dist-standalone', 'README.md', 'LICENSE'])
  expect(manifest.scripts.prepack).toBe('bun run build && bun run assemble')
  const config = read('next.config.ts')
  expect(config).toContain("output: 'standalone'")
  expect(config).toContain('outputFileTracingRoot')
  expect(config).toContain("serverExternalPackages: ['bun:sqlite']")
})

test('standalone runtime declares Node and Bun requirements separately from platform proof', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.engines.node).toBe('>=24')
  expect(manifest.engines.bun).toBe('>=1.3')
})

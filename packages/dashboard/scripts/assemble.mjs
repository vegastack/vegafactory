// Turns `next build`'s standalone output into the exact tree the published tarball ships:
// dist-standalone/packages/dashboard/server.js, with the static assets and public files
// sitting where that server looks for them. `next build` leaves them apart on purpose.
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { materializeTree } from '../../../scripts/release-artifacts.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const next = join(packageRoot, '.next')
const out = join(packageRoot, 'dist-standalone')
const app = join(out, 'packages', 'dashboard')

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

if (!(await exists(join(next, 'standalone')))) {
  console.error('assemble: .next/standalone is absent — run `bun run build` first')
  process.exit(1)
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await materializeTree(join(next, 'standalone'), out)
await materializeTree(join(next, 'static'), join(app, '.next', 'static'))
if (await exists(join(packageRoot, 'public'))) {
  await materializeTree(join(packageRoot, 'public'), join(app, 'public'))
}

const entry = join(app, 'server.js')
if (!(await exists(entry))) {
  console.error(`assemble: expected a server entry at ${entry}`)
  process.exit(1)
}
console.log(`assemble: ${entry}`)

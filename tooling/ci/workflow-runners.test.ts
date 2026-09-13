import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
const read = (name: string) => readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8')
// Comment lines carry the audit list and the fallback line verbatim, so the
// assertions on what actually runs read the executable part of each workflow only.
const executable = (name: string) =>
  read(name)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

describe('workflow runner routing stays reachable and authority-aware', () => {
  for (const name of ['ci.yml', 'factory-board.yml']) {
    test(`${name} targets the registered laptop runners, never a hosted one`, () => {
      // The Mac mini's org group (#119) is documented in the comment block but is
      // NOT the target: an ungranted or empty runner group queues a job forever
      // with `runner: null`, and `check (node 24)` is a required status check, so
      // pointing at it before the operator's org-admin grant would strand every PR.
      // Unquoted: a quoted `"[a, b]"` is one literal label, which also queues forever.
      expect(executable(name)).toMatch(/^ {4}runs-on: \[self-hosted, vsk-runners-mac\]$/m)
      expect(executable(name)).not.toMatch(/^\s*runs-on: ubuntu-latest$/m)
      // Scoped to a runner group, not the bare `group:` key: `concurrency:` takes
      // one too, and a future concurrency block must not read as a runner target.
      expect(executable(name)).not.toMatch(/^\s*group: vsk-runners-/m)
    })
  }

  test('release.yml keeps preparation self-hosted and uses npm-supported hosted authority jobs', () => {
    const workflow = Bun.YAML.parse(read('release.yml')) as any
    expect(workflow.jobs.prepare['runs-on']).toEqual(['self-hosted', 'vsk-runners-mac'])
    expect(workflow.jobs.publish['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.release['runs-on']).toBe('ubuntu-latest')
  })

  for (const name of ['ci.yml', 'release.yml']) {

    test(`${name} names the pending Mac mini group and its provisioning checklist`, () => {
      const body = read(name)
      expect(body).toContain('vsk-runners-mac-mini')
      expect(body).toContain('onboarding/dispatcher-box.md')
    })

    test(`${name} keeps the BSD userland audit valid`, () => {
      const body = executable(name)
      for (const construct of ['sed -i', 'date -d', 'readlink -f', 'base64 -w', 'sort -V', 'grep -P', 'stat -c']) {
        expect(body).not.toContain(construct)
      }
    })
  }
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const skillRoot = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(skillRoot, path), 'utf8')

// One landing order, in three places. The headline sequence used to put the runbook before
// cleanup while the steps below it cleaned up first — and because the runbook stops at its
// release steps, following the headline left the worktree behind.
const ORDER = ['PR', 'merge queue', 'merge', "the issue's worktree cleanup", 'the Ship runbook']

test('the headline sequence names the steps in the order the steps run', () => {
  const skill = read('SKILL.md')
  expect(skill).toContain(ORDER.join(' → '))
})

test('the steps clean up before the runbook, and say why', () => {
  const skill = read('SKILL.md')
  const cleanup = skill.indexOf('vegafactory worktree remove <n> --json')
  const runbook = skill.indexOf('## After the merge — the Ship runbook')
  expect(cleanup).toBeGreaterThan(0)
  expect(runbook).toBeGreaterThan(0)
  expect(cleanup, 'the worktree removal must come before the runbook section').toBeLessThan(runbook)
  expect(skill).toMatch(/before the runbook/)
})

test('the runbook reference gives the same reason at the step that stops', () => {
  const runbook = read('references/runbook.md')
  const exception = runbook.indexOf('## The release exception to `auto:`')
  expect(exception).toBeGreaterThan(0)
  expect(runbook.slice(exception)).toMatch(/worktree is removed before the runbook starts/)
})

test('the eval asserts the same order rather than a different one', () => {
  const evals = JSON.parse(read('evals/evals.json')) as { evals: Array<{ expected_output: string; assertions: string[] }> }
  const shipIt = evals.evals.find((entry) => entry.assertions.some((line) => line.includes('worktree')))!
  expect(shipIt, 'no eval covers the worktree step').toBeDefined()
  const assertion = shipIt.assertions.find((line) => /worktree is removed before the runbook/.test(line))
  expect(assertion, `assertions: ${shipIt.assertions.join(' | ')}`).toBeDefined()
  expect(shipIt.expected_output).toMatch(/worktree directory removed.*only then the runbook/s)
})

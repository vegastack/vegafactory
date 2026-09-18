import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverSkills } from '../../packages/cli/scripts/lib/skills.mjs'

// skillify item 1: a SKILL.md body is at most 1,200 words (the text below the frontmatter, `wc -w`),
// with detail routed to references, or a named exception. Nothing else in `bun run check` counts
// words, so this is the guard. The exceptions below are the named ones: each carries the ceiling
// the body may not grow past, and an entry whose skill drops back under budget is stale and fails,
// so the list can only shrink. Adding a name here is the operator's call, never a session's.
const BUDGET = 1200
const NAMED_EXCEPTIONS: Record<string, number> = {
  'dev-setup': 3100,
  'dev-implement': 1900,
  'dev-intake': 1650,
  'vegafactory-setup': 1400,
}

const repoRoot = resolve(import.meta.dir, '../..')

export function bodyWords(skillMd: string): number {
  let fences = 0
  const body: string[] = []
  for (const line of skillMd.split('\n')) {
    if (fences < 2) {
      if (line === '---') fences += 1
      continue
    }
    body.push(line)
  }
  return body.join('\n').split(/\s+/).filter((word) => word !== '').length
}

describe('SKILL.md bodies stay inside the word budget or a named exception', () => {
  const skills = discoverSkills(join(repoRoot, 'skills')) as Map<string, { path: string }>
  for (const [name, skill] of skills) {
    test(`${name}`, () => {
      const words = bodyWords(readFileSync(join(skill.path, 'SKILL.md'), 'utf8'))
      const ceiling = NAMED_EXCEPTIONS[name]
      if (ceiling === undefined) {
        expect(words, `${name} body is ${words} words against the ${BUDGET} budget with no named exception — route detail to references, or the operator names an exception here`).toBeLessThanOrEqual(BUDGET)
      } else {
        expect(words, `${name} is back under the ${BUDGET} budget (${words}); drop its exception`).toBeGreaterThan(BUDGET)
        expect(words, `${name} body is ${words} words, past its named ceiling of ${ceiling}`).toBeLessThanOrEqual(ceiling)
      }
    })
  }
})

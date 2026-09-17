import { describe, expect, test } from 'bun:test'
import { lintBrief } from '../scripts/brief-lint.mjs'

const quickBuildBrief = `<!-- vsk:v1 type=brief rev=1 size=small -->
**Size:** small — the flow exists.

## Outcome
The status script accepts a flag.
## Approach and touch points
Modify \`skills/dev-status/scripts/status.mjs\`.
## Tests and acceptance
Unit tests over the flag branches.
`

describe('brief-lint', () => {
  test('a complete small brief passes', () => {
    expect(lintBrief(quickBuildBrief, 'small').blocks).toEqual([])
  })
  test('an unknown size blocks', () => {
    expect(lintBrief(quickBuildBrief, 'huge').blocks[0]).toContain('unknown size')
  })
  test('blocks on missing marker and missing sections', () => {
    const r = lintBrief('## Outcome\nA thing.\n', 'medium')
    expect(r.blocks.some((b) => b.includes('marker'))).toBe(true)
    expect(r.blocks.some((b) => b.includes('Out of scope'))).toBe(true)
  })
  test('research briefs need question + answered-when', () => {
    const ok = lintBrief('<!-- vsk:v1 type=brief rev=1 size=research -->\n## The question\nWhy?\n## What "answered" looks like\nA report.\n', 'research')
    expect(ok.blocks).toEqual([])
    const bad = lintBrief('<!-- vsk:v1 type=brief rev=1 size=research -->\n## The question\nWhy?\n', 'research')
    expect(bad.blocks.length).toBe(1)
  })
  test('blocks when Approach names no backticked path', () => {
    const r = lintBrief(quickBuildBrief.replace('Modify `skills/dev-status/scripts/status.mjs`.', 'Modify the status script.'), 'small')
    expect(r.blocks.some((b) => b.includes('backticked paths'))).toBe(true)
  })
  test('fix-type briefs require a Reproduction section', () => {
    const r = lintBrief(quickBuildBrief, 'small', { fix: true })
    expect(r.blocks.some((b) => b.includes('Reproduction'))).toBe(true)
    const withRepro = quickBuildBrief.replace('## Outcome', '## Reproduction\nSteps: run X, see Y.\n## Outcome')
    expect(lintBrief(withRepro, 'small', { fix: true }).blocks).toEqual([])
  })
  test('a missing **Size:** line blocks (research exempt)', () => {
    const noScope = quickBuildBrief.replace(/\*\*Size:\*\*[^\n]*\n\n/, '')
    expect(lintBrief(noScope, 'small').blocks.some((b) => b.includes('**Size:**'))).toBe(true)
    const research = '<!-- vsk:v1 type=brief rev=1 size=research -->\n## The question\nWhy?\n## What answered looks like\nA report.\n'
    expect(lintBrief(research, 'research').blocks).toEqual([])
  })
  test('vague wording warns, never blocks', () => {
    const r = lintBrief(quickBuildBrief.replace('accepts a flag', 'works properly and is robust'), 'small')
    expect(r.blocks).toEqual([])
    expect(r.warns.length).toBeGreaterThanOrEqual(2)
  })

  test('Priority and Effort lines are optional — a brief passes with them and without', () => {
    const withFields = quickBuildBrief.replace(
      '**Size:** small — the flow exists.',
      '**Size:** small — the flow exists.\n**Priority:** Medium\n**Effort:** Low',
    )
    expect(lintBrief(withFields, 'small').blocks).toEqual([])
    expect(lintBrief(withFields, 'small').warns).toEqual([])
    expect(lintBrief(quickBuildBrief, 'small').blocks).toEqual([])
  })
})

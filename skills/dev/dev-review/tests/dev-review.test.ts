import { describe, expect, test } from 'bun:test'

// Acceptance: the comment `vegafactory review` posts is typed and read by the issue cache
// (first-line marker), and its findings JSON is readable again by the next round's reviewer.
// Cross-package import is test-only — tests never ship.
import { commentType } from '../../../../packages/cli/src/issue-cache.ts'
import { markerKeys } from '../../../../packages/cli/src/issue.ts'
import { renderComment, readReviewComment } from '../../../../packages/cli/src/review.ts'

describe('review comment ↔ issue cache contract', () => {
  const data = {
    cycle: 1, round: 2, sha: 'abc1234def5678', base: 'origin/main', brief: 'a'.repeat(12), plan: null,
    reviewer: 'codex' as const, mode: 'cross-tool' as const, fallback: null, verdict: 'needs-fixes' as const,
    findings: [{ id: 'F1', axis: 'bugs' as const, severity: 'must-fix' as const, file: 'src/a.ts', line: 7, issue: 'null deref', fix: 'guard it' }],
  }
  const body = renderComment(data, ['- Cycle 1 round 1 @ def5678 — needs-fixes — must-fix: F1'])

  test('the cache reads the top marker: type, cycle, round, sha, agent, mode, verdict', () => {
    expect(commentType(body)).toBe('review')
    expect(markerKeys(body)).toEqual({ type: 'review', cycle: '1', round: '2', sha: 'abc1234', agent: 'codex', mode: 'cross-tool', verdict: 'needs-fixes' })
  })

  test('the rendered finding carries severity and path:line, and earlier rounds keep one line each', () => {
    expect(body).toContain('**Finding [F1]** — **[MUST-FIX]** `src/a.ts:7` · bugs')
    expect(body).toContain('- Cycle 1 round 1 @ def5678 — needs-fixes — must-fix: F1')
  })

  test('a fresh reviewer on another machine reads the findings back out of the comment', () => {
    expect(readReviewComment(body)).toMatchObject({ round: 2, verdict: 'needs-fixes', findings: data.findings })
  })
})

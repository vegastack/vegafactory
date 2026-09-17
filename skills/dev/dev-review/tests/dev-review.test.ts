import { describe, expect, test } from 'bun:test'

// Acceptance: a review comment in this skill's format is consumable by
// dev-ship's ship-gate (first-marker read, verdict key). Cross-skill import is
// test-only — tests never ship.
import { parseMarker as shipGateParseMarker } from '../../dev-ship/scripts/ship-gate.mjs'

describe('review comment ↔ ship-gate contract', () => {
  const reviewComment = `<!-- vsk:v1 type=review round=2 sha=abc1234 agent=codex verdict=clean -->
## Review — round 2 @ abc1234

**Verdict: clean** — spec: 0 · standards: 0 · security: n/a (no surface)

## Review — round 1 @ def5678

**Verdict: needs-fixes** — spec: 1 must-fix
`
  test('ship-gate reads the top marker: type, verdict, sha, agent', () => {
    const marker = shipGateParseMarker(reviewComment)
    expect(marker?.keys).toEqual({ type: 'review', round: '2', sha: 'abc1234', agent: 'codex', verdict: 'clean' })
  })
  test('appended prior rounds carry no marker, so the first marker stays current', () => {
    const afterTop = reviewComment.split('\n').slice(1).join('\n')
    expect(shipGateParseMarker(afterTop)).toBeNull()
  })
})

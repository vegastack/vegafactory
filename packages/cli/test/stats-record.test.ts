import { describe, expect, test } from 'bun:test'
import {
  monthToken, parseMonthToken, repoSegment, normalizeRecord,
  recordProblems, serializeRecord, parseStatsKnobs, resolveStatsPolicy,
} from '../src/stats/record.ts'

describe('monthToken', () => {
  test('is uppercase three-letter English month plus year, in UTC', () => {
    expect(monthToken(new Date('2026-09-15T12:00:00Z'))).toBe('SEP-2026')
    expect(monthToken(new Date('2026-01-01T00:00:00Z'))).toBe('JAN-2026')
    // 02:00 IST on 1 Sep is 20:30Z on 31 Aug: the token follows UTC, not the machine.
    expect(monthToken(new Date('2026-08-31T20:30:00Z'))).toBe('AUG-2026')
  })
  test('round-trips through parseMonthToken and rejects junk', () => {
    expect(parseMonthToken('SEP-2026')).toEqual({ year: 2026, month: 9 })
    expect(parseMonthToken('sep-2026')).toBeNull()
    expect(parseMonthToken('SEPT-2026')).toBeNull()
  })
})

test('repoSegment is one filename-safe path segment', () => {
  expect(repoSegment('vegastack/vegafactory')).toBe('vegastack__vegafactory')
})

describe('normalizeRecord', () => {
  const base = { repo: 'vegastack/vegafactory', ts: '2026-09-03T10:00:00.000Z' }
  test('missing fields become null, never guesses', () => {
    const record = normalizeRecord(base)
    expect(record.issue).toBeNull()
    expect(record.cost_usd).toBeNull()
    expect(record.tokens).toEqual({ in: null, out: null, cache_read: null, cache_write: null })
    expect(record.skills).toEqual([])
  })
  test('serializeRecord emits one line with a fixed key order', () => {
    const line = serializeRecord(normalizeRecord({ ...base, issue: 121, stage: 'implement' }))
    expect(line.endsWith('\n')).toBe(false)
    expect(line.includes('\n')).toBe(false)
    expect(Object.keys(JSON.parse(line))).toEqual([
      'ts', 'repo', 'issue', 'parent', 'stage', 'harness', 'model', 'effort', 'mode',
      'human', 'session_id', 'worktree', 'duration_s', 'turns', 'tool_calls', 'subagents',
      'tokens', 'cost_usd', 'outcome', 'review_rounds', 'fix_rounds', 'handbacks', 'skills',
    ])
  })
  test('recordProblems names an unusable record instead of writing it', () => {
    const bad = { ...normalizeRecord(base), repo: '', ts: 'not-a-date' }
    expect(recordProblems(bad)).toEqual([
      'repo is empty',
      'ts is not an ISO-8601 timestamp: "not-a-date"',
    ])
    expect(recordProblems(normalizeRecord(base))).toEqual([])
  })
})

describe('resolveStatsPolicy', () => {
  const org = 'org: vegastack\nstats: on\nstats-people: on\nstats-override: allowed\n'
  const orgLocked = 'org: vegastack\nstats: on\nstats-people: off\nstats-override: locked\n'
  test('parseStatsKnobs reads only the three knob lines, and the default is on', () => {
    expect(parseStatsKnobs(org)).toEqual({ stats: 'on', statsPeople: 'on', statsOverride: 'allowed' })
    expect(resolveStatsPolicy({})).toEqual({ enabled: true, people: false, source: 'default', refusal: null })
  })
  test('group overrides org', () => {
    expect(resolveStatsPolicy({ org, group: 'stats: off\n' }))
      .toEqual({ enabled: false, people: false, source: 'group', refusal: null })
  })
  test('a repo opt-out is honoured when the org allows overrides', () => {
    expect(resolveStatsPolicy({ org, repo: 'stats: off\n' }))
      .toEqual({ enabled: false, people: false, source: 'repo', refusal: null })
  })
  test('a repo opt-out under a locked org is ignored, with the reason stated', () => {
    expect(resolveStatsPolicy({ org: orgLocked, repo: 'stats: off\n' })).toEqual({
      enabled: true,
      people: false,
      source: 'org',
      refusal: 'repo: stats override requires exact org delegation',
    })
  })
})

test('group cannot unlock org stats and malformed known knobs refuse capture', () => {
  const policy = resolveStatsPolicy({ org: 'stats: on\nstats-override: locked', group: 'stats-override: allowed', repo: 'stats: off' })
  expect(policy.enabled).toBe(true)
  expect(policy.refusal).toMatch(/delegation/)
  expect(resolveStatsPolicy({ repo: 'stats: nonsense' }).refusal).toMatch(/stats/)
})

import { describe, expect, test } from 'bun:test'
import {
  issueFromWorktree, fromClaudeHeadless, fromCodexExec,
  fromClaudeSessionEnd, fromCodexSessionEnd, fromSkillHook, reworkFromComments,
} from '../src/stats/capture.ts'

const context = { repo: 'vegastack/vegafactory', ts: '2026-09-03T10:00:00.000Z', stage: 'implement' }

test('issueFromWorktree reads the number and slug from the worktree path', () => {
  expect(issueFromWorktree('/repo/.vegastack/.worktrees/121-statistics'))
    .toEqual({ issue: 121, slug: 'statistics' })
  expect(issueFromWorktree('/repo')).toEqual({ issue: null, slug: null })
  expect(issueFromWorktree(null)).toEqual({ issue: null, slug: null })
})

describe('fromClaudeHeadless', () => {
  const stdout = {
    session_id: 'sess-a', duration_ms: 92_000, num_turns: 14, total_cost_usd: 1.25, is_error: false,
    usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1_200 },
  }
  test('maps the documented fields and marks the run headless', () => {
    const record = fromClaudeHeadless(stdout, { ...context, worktree: '/repo/.vegastack/.worktrees/121-statistics' })
    expect(record.session_id).toBe('sess-a')
    expect(record.mode).toBe('headless')
    expect(record.harness).toBe('claude')
    expect(record.duration_s).toBe(92)
    expect(record.turns).toBe(14)
    expect(record.cost_usd).toBe(1.25)
    expect(record.issue).toBe(121)
    expect(record.tokens).toEqual({ in: 900, out: 300, cache_read: 40_000, cache_write: 1_200 })
    expect(record.outcome).toBe('complete')
  })
  test('an absent usage block yields nulls, never zeros, and is_error marks the run failed', () => {
    const record = fromClaudeHeadless({ session_id: 'sess-b' }, context)
    expect(record.tokens).toEqual({ in: null, out: null, cache_read: null, cache_write: null })
    expect(record.duration_s).toBeNull()
    expect(record.cost_usd).toBeNull()
    expect(fromClaudeHeadless({ ...stdout, is_error: true }, context).outcome).toBe('failed')
  })
})

test('fromCodexExec reads usage off the last turn.completed event', () => {
  const events = [
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 } },
    { type: 'turn.completed', usage: { input_tokens: 400, cached_input_tokens: 90, output_tokens: 70 } },
  ]
  const record = fromCodexExec(events, context)
  expect(record.harness).toBe('codex')
  expect(record.mode).toBe('headless')
  expect(record.turns).toBe(2)
  expect(record.tokens).toEqual({ in: 400, out: 70, cache_read: 90, cache_write: null })
  expect(record.cost_usd).toBeNull()
})

test('fromClaudeSessionEnd totals usage and counts tool calls, keeping no text', () => {
  const turn = (usage: object, content: object[]) => JSON.stringify({ type: 'assistant', message: { usage, content } })
  const transcript = [
    turn({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 2 }, [{ type: 'text', text: 'secret plan' }]),
    turn({ input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }, [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /tmp/secret' } }, { type: 'tool_use', name: 'Read', input: {} }]),
    'not json',
  ]
  const record = fromClaudeSessionEnd({ session_id: 'sess-c', transcript_path: '/x.jsonl', cwd: '/repo' }, transcript, context)
  expect(record.mode).toBe('interactive')
  expect(record.tokens).toEqual({ in: 30, out: 12, cache_read: 400, cache_write: 2 })
  expect(record.tool_calls).toBe(2)
  expect(record.turns).toBe(2)
  // The plan's assertion was `not.toContain('ls')`, which no record can satisfy: `skills` and
  // `tool_calls` are field names. What it meant is asserted instead — no assistant text, no tool
  // name and no tool argument reaches the record.
  const serialized = JSON.stringify(record)
  expect(serialized).not.toContain('secret plan')
  expect(serialized).not.toContain('rm -rf')
  expect(serialized).not.toContain('Bash')
})

test('fromCodexSessionEnd records the session with nulls where Codex exposes nothing', () => {
  const record = fromCodexSessionEnd({ session_id: 'sess-d', cwd: '/repo' }, context)
  expect(record.session_id).toBe('sess-d')
  expect(record.mode).toBe('interactive')
  expect(record.harness).toBe('codex')
  expect(record.tokens).toEqual({ in: null, out: null, cache_read: null, cache_write: null })
})

describe('fromSkillHook', () => {
  test('a Claude PostToolUse Skill call is a model-triggered invocation', () => {
    expect(fromSkillHook({ session_id: 's', tool_name: 'Skill', tool_input: { skill: 'dev-architect' } }, 'claude-post-tool'))
      .toEqual({ sessionId: 's', invocations: [{ name: 'dev-architect', trigger: 'model', harness: 'claude' }] })
  })
  test('a Claude UserPromptExpansion is a typed invocation', () => {
    expect(fromSkillHook({ session_id: 's', command_name: 'dev-plan', command_args: '121', command_source: 'user' }, 'claude-prompt-expansion'))
      .toEqual({ sessionId: 's', invocations: [{ name: 'dev-plan', trigger: 'typed', harness: 'claude' }] })
  })
  test('Codex prompt mentions are recorded as a proxy, deduplicated', () => {
    expect(fromSkillHook({ session_id: 's', prompt: 'use $dev-review then $dev-review again' }, 'codex-prompt'))
      .toEqual({ sessionId: 's', invocations: [{ name: 'dev-review', trigger: 'mention', harness: 'codex' }] })
  })
  test('an unrecognised payload yields no invocations rather than a guess', () => {
    expect(fromSkillHook({}, 'claude-post-tool')).toEqual({ sessionId: null, invocations: [] })
  })
})

test('rework is read off the issue comments by marker: review rounds, the ledger fix rounds, hand-backs', () => {
  const comments = [
    '<!-- vsk:v1 type=ledger branch=feat/121-stats -->\n## Ledger — feat/121-stats\n- Task 4: fix round 2/3 (1 addressed)\n- Task 6: fix round 1/3 (2 addressed)',
    '<!-- vsk:v1 type=review round=1 sha=abc1234 agent=codex verdict=needs-fixes -->\n## Review (round 1)',
    '<!-- vsk:v1 type=review round=2 sha=def5678 agent=codex verdict=clean -->\n## Review (round 2)',
    '<!-- vsk:v1 type=handback -->\n## Handed back',
    'a plain comment mentioning fix round 9/3 and type=review in prose',
  ]
  expect(reworkFromComments(comments)).toEqual({ review_rounds: 2, fix_rounds: 2, handbacks: 1 })
  // Comments that were fetched and carry no marker measure zero rework; that is a fact, not a gap.
  expect(reworkFromComments(['hello'])).toEqual({ review_rounds: 0, fix_rounds: 0, handbacks: 0 })
})

test('interactive missing usage stays unknown for each field, including mixed reported and missing turns', () => {
  const usage = { input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
  const fields = [['input_tokens','in'], ['output_tokens','out'], ['cache_read_input_tokens','cache_read'], ['cache_creation_input_tokens','cache_write']] as const
  for (const [vendor, field] of fields) {
    const partial: Record<string, number> = { ...usage }
    delete partial[vendor]
    const lines = [usage, partial].map(value => JSON.stringify({ type: 'assistant', message: { usage: value } }))
    const record = fromClaudeSessionEnd({}, lines, context)
    expect(record.tokens[field]).toBeNull()
    expect(record.tool_calls).toBeNull()
    for (const [other, key] of fields) if (other !== vendor) expect(record.tokens[key]).toBe(usage[other] * 2)
  }
  expect(fromClaudeSessionEnd({}, [JSON.stringify({ type: 'assistant', message: {} })], context).tokens)
    .toEqual({ in: null, out: null, cache_read: null, cache_write: null })
})

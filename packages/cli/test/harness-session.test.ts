import { describe, expect, test } from 'bun:test'
import { harnessInvocation, parseHarnessResult, sessionIdFromCodexEvent, validSessionId } from '../src/harness-session.ts'

const CODEX_ID = '019a0b08-3326-72c3-a5fe-ec02067cf714'
const CLAUDE_ID = 'c1a0de00-0000-4000-8000-000000000001'

describe('harness conversation identity', () => {
  test('only complete UUIDs can be resumed', () => {
    expect(validSessionId(CODEX_ID)).toBe(CODEX_ID)
    for (const value of ['--output=/tmp/other', CODEX_ID.slice(0, -1), 'session id: ' + CODEX_ID, '', null]) {
      expect(validSessionId(value)).toBeNull()
    }
  })

  test('worker Codex starts and resumes with the supported JSON event and exec resume forms', () => {
    const input = { harness: 'codex' as const, prompt: 'continue', model: null, effort: 'high', worker: true }
    const fresh = harnessInvocation({ ...input, sessionId: null })
    expect(fresh).toEqual({ tool: 'codex', args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=high', '-'], stdin: 'continue' })
    const resumed = harnessInvocation({ ...input, sessionId: CODEX_ID })
    expect(resumed.args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(resumed.args).toContain(CODEX_ID)
    expect(resumed.args.at(-1)).toBe('-')
    expect(resumed.stdin).toBe('continue')
  })

  test('worker Claude has distinct start and resume flags and requests a JSON result', () => {
    const input = { harness: 'claude' as const, prompt: 'continue', model: null, effort: 'high', worker: true }
    const fresh = harnessInvocation({ ...input, sessionId: null })
    const resumed = harnessInvocation({ ...input, sessionId: CLAUDE_ID })
    expect(fresh.args).toContain('--output-format')
    expect(fresh.args).not.toContain('--resume')
    expect(resumed.args).toContain('--resume')
    expect(resumed.args).toContain(CLAUDE_ID)
    expect(resumed.stdin).toBe('continue')
  })

  test('Codex identity comes from thread.started, never incidental prose', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: CODEX_ID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n')
    expect(sessionIdFromCodexEvent(stream.split('\n')[0]!)).toBe(CODEX_ID)
    expect(parseHarnessResult('codex', stream, '')).toEqual({ sessionId: CODEX_ID, text: 'done', resumeMissing: false })
    expect(parseHarnessResult('codex', `session id: ${CODEX_ID}\n`, '')).toEqual({ sessionId: null, text: '', resumeMissing: false })
  })

  test('Claude identity comes from its JSON result, not a line of text', () => {
    expect(parseHarnessResult('claude', JSON.stringify({ type: 'result', session_id: CLAUDE_ID, result: 'done' }), ''))
      .toEqual({ sessionId: CLAUDE_ID, text: 'done', resumeMissing: false })
    expect(parseHarnessResult('claude', '{', '')).toEqual({ sessionId: null, text: '', resumeMissing: false })
  })

  test('only a harness-owned missing-session error qualifies for a fresh retry', () => {
    expect(parseHarnessResult('codex', '', `No saved session found with id ${CODEX_ID}`).resumeMissing).toBe(true)
    expect(parseHarnessResult('codex', '', 'model request failed').resumeMissing).toBe(false)
    expect(parseHarnessResult('claude', JSON.stringify({ type: 'result', is_error: true, result: `No conversation found with session ID ${CLAUDE_ID}` }), '').resumeMissing).toBe(true)
    expect(parseHarnessResult('claude', JSON.stringify({ type: 'result', is_error: false, result: 'No conversation found with session ID x' }), '').resumeMissing).toBe(false)
  })
})

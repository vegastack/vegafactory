// The two CLI conversation contracts used by unattended worker runs and read-only review rounds.
// Persist only the UUID; prompts and result text never belong in a worker record.
export type HarnessName = 'claude' | 'codex'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validSessionId = (value: unknown): string | null => typeof value === 'string' && UUID.test(value) ? value : null

export function sessionCommand(harness: HarnessName, sessionId: string | null): string[] {
  if (sessionId && !validSessionId(sessionId)) throw new Error('a harness session id must be a complete UUID')
  if (harness === 'codex') return sessionId ? ['exec', 'resume'] : ['exec']
  return sessionId ? ['-p', '--resume', sessionId] : ['-p']
}

export function harnessInvocation(input: {
  harness: HarnessName
  prompt: string
  sessionId: string | null
  model: string | null
  effort: string
  worker: boolean
}): { tool: HarnessName; args: string[]; stdin: string } {
  const { harness, prompt, sessionId, model, effort, worker } = input
  const head = sessionCommand(harness, sessionId)
  if (harness === 'codex') {
    // `exec resume` accepts the same --json event stream as a fresh `exec`. The ID is positional,
    // after all flags; `-` tells both forms to read the prompt from stdin.
    return {
      tool: harness,
      args: [...head, '--json', ...(worker ? ['--dangerously-bypass-approvals-and-sandbox'] : sessionId ? ['-c', 'sandbox_mode=read-only'] : ['-s', 'read-only']),
        ...(model ? ['-c', `model=${model}`] : []), '-c', `model_reasoning_effort=${effort}`, ...(sessionId ? [sessionId] : []), '-'],
      stdin: prompt,
    }
  }
  return {
    tool: harness,
    args: [...head, ...(worker ? ['--dangerously-skip-permissions'] : ['--restricted']), '--output-format', 'json',
      ...(model ? ['--model', model] : []), '--effort', effort],
    stdin: prompt,
  }
}

export function sessionIdFromCodexEvent(line: string): string | null {
  try {
    const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown }
    return event.type === 'thread.started' ? validSessionId(event.thread_id) : null
  } catch { return null }
}

const CODEX_MISSING = /(?:no saved session found with id|no rollout found for thread id|session (?:id )?[^\n]{0,80}(?:not found|does not exist)|rollout (?:file )?[^\n]{0,80}not found)/i
const CLAUDE_MISSING = /(?:no conversation found with session id|session (?:id )?[^\n]{0,80}(?:not found|does not exist))/i

export function parseHarnessResult(harness: HarnessName, stdout: string, stderr: string): { sessionId: string | null; text: string; resumeMissing: boolean } {
  if (harness === 'claude') {
    let result: { type?: unknown; session_id?: unknown; result?: unknown; is_error?: unknown }
    try { result = JSON.parse(stdout) } catch { return { sessionId: null, text: '', resumeMissing: CLAUDE_MISSING.test(stderr) } }
    if (!result || result.type !== 'result') return { sessionId: null, text: '', resumeMissing: false }
    const text = typeof result.result === 'string' ? result.result : ''
    return { sessionId: validSessionId(result.session_id), text, resumeMissing: result.is_error === true && CLAUDE_MISSING.test(text) }
  }
  let sessionId: string | null = null
  let text = ''
  const errors: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const found = sessionIdFromCodexEvent(line)
    if (found) sessionId = found
    try {
      const event = JSON.parse(line) as { type?: unknown; message?: unknown; item?: { type?: unknown; text?: unknown }; error?: { message?: unknown } }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text
      if (event.type === 'error' || event.type === 'turn.failed') errors.push(typeof event.message === 'string' ? event.message : String(event.error?.message ?? ''))
    } catch { /* an incomplete line is never an identity or an error classification */ }
  }
  return { sessionId, text, resumeMissing: CODEX_MISSING.test([...errors, stderr].join('\n')) }
}

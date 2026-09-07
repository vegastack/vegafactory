// The broker's only outbound call site. Every subrequest the Worker makes goes through here, so
// the allowlist is a property of the code rather than a convention someone has to remember.
//
// The match is exact-host, never a suffix: `api.github.com.evil.test` ends with `api.github.com`
// and is refused. `https:` only, and `redirect: 'error'` so a 3xx from either host can never walk
// the request off the allowlist.

export const ALLOWED_HOSTS = ['api.github.com', 'token.actions.githubusercontent.com'] as const

export class EgressRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressRefused'
  }
}

export type CfInit = RequestInit & { cf?: Record<string, unknown> }

export const FETCH_TIMEOUT_MS = 3000
export const EXCHANGE_TIMEOUT_MS = 15000

export class ExchangeDeadline extends Error {
  constructor() { super('the upstream deadline expired'); this.name = 'ExchangeDeadline' }
}

// Race even bindings/test transports that do not implement cancellation. Callers must check
// the supplied signal before beginning another effect after an await.
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal | null,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(new ExchangeDeadline())
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  const timer = setTimeout(abort, timeoutMs)
  let onAbort: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ExchangeDeadline())
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    controller.signal.throwIfAborted()
    const result = await Promise.race([operation(controller.signal), interrupted])
    controller.signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

export async function allowedFetch(url: string, init: CfInit = {}, doFetch: typeof fetch = fetch): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new EgressRefused('egress refused: not a URL')
  }
  if (parsed.protocol !== 'https:') throw new EgressRefused(`egress refused: ${parsed.protocol} is not https:`)
  if (!(ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname)) {
    throw new EgressRefused(`egress refused: ${parsed.hostname} is not an allowed host`)
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new EgressRefused('egress refused: URL credentials or non-HTTPS port')
  }
  init.signal?.throwIfAborted()
  return await doFetch(parsed.toString(), { ...init, redirect: 'error' } as RequestInit)
}

// A single deadline covers headers AND the complete bounded body, including chunked replies.
// Never reflect response text (which can contain credentials) in an error.
export async function fetchJson(
  url: string, init: CfInit, doFetch: typeof fetch, maxBytes: number,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  return withDeadline(async (signal) => {
    const response = await allowedFetch(url, { ...init, signal }, doFetch)
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
    }
    const reader = response.body?.getReader()
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        throw new EgressRefused('upstream response exceeds the body limit')
      }
      let size = 0
      const chunks: Uint8Array[] = []
      if (reader) {
        while (true) {
          const { value, done } = await reader.read()
          signal.throwIfAborted()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) throw new EgressRefused('upstream response exceeds the body limit')
          chunks.push(value)
        }
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let body: unknown = null
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { /* unusable body */ }
      return { status: response.status, headers: response.headers, body }
    } finally {
      signal.removeEventListener('abort', cancel)
      cancel()
    }
  }, init.signal)
}

import { describe, expect, test } from 'bun:test'
import { ALLOWED_HOSTS, EgressRefused, allowedFetch, fetchJson, withDeadline } from '../src/egress.ts'

describe('allowedFetch', () => {
  const seen: RequestInit[] = []
  const stub = (async (_url: string, init: RequestInit) => { seen.push(init); return new Response('{}') }) as unknown as typeof fetch

  test('allows exactly the two GitHub hosts and never follows a redirect', async () => {
    expect([...ALLOWED_HOSTS]).toEqual(['api.github.com', 'token.actions.githubusercontent.com'])
    await allowedFetch('https://api.github.com/app', { method: 'GET' }, stub)
    await allowedFetch('https://token.actions.githubusercontent.com/.well-known/jwks', {}, stub)
    expect(seen).toHaveLength(2)
    for (const init of seen) expect(init.redirect).toBe('error')
  })

  test('refuses a lookalike host, an unrelated host, plain http, and a non-URL', async () => {
    for (const url of ['https://api.github.com.evil.test/x', 'https://evil.test/x', 'http://api.github.com/x', 'not a url']) {
      await expect(allowedFetch(url, {}, stub)).rejects.toBeInstanceOf(EgressRefused)
    }
    expect(seen).toHaveLength(2)
  })
})

test('bounds chunked JSON without trusting Content-Length and cancels overflow', async () => {
  const fixture = (padding: number) => {
    const body = { padding: 'x'.repeat(padding) }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    let offset = 0
    let cancelled = false
    const transport = (async (_url: string) => {
      const response = new Response(new ReadableStream({
        pull(controller) {
          if (offset === bytes.byteLength) { controller.close(); return }
          const end = Math.min(offset + 32, bytes.byteLength)
          controller.enqueue(bytes.slice(offset, end)); offset = end
        },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 }))
      expect(response.headers.has('content-length')).toBe(false)
      return response
    }) as typeof fetch
    return { body, bytes: bytes.byteLength, transport, cancelled: () => cancelled }
  }
  const under = fixture(40)
  expect(under.bytes).toBeLessThan(64)
  expect((await fetchJson('https://api.github.com/x', {}, under.transport, 64)).body).toEqual(under.body)
  expect(under.cancelled()).toBe(false)
  const over = fixture(80)
  expect(over.bytes).toBeGreaterThan(64)
  const error = await fetchJson('https://api.github.com/x', {}, over.transport, 64).catch((caught) => caught)
  expect(error).toBeInstanceOf(EgressRefused)
  expect(error.message).toBe('upstream response exceeds the body limit')
  expect(over.cancelled()).toBe(true)
})

test('parent cancellation bounds a stalled body and reaches the transport', async () => {
  const controller = new AbortController()
  let seen: AbortSignal | null | undefined
  let cancelled = false
  const transport = (async (_url: string, init: RequestInit) => {
    seen = init.signal
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  }) as typeof fetch
  const pending = fetchJson('https://api.github.com/x', { signal: controller.signal }, transport, 64)
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(seen?.aborted).toBe(true)
  expect(cancelled).toBe(true)
})

test('already-aborted parent refuses before starting an operation', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  await expect(withDeadline(async () => { calls++; return true }, controller.signal)).rejects.toThrow()
  expect(calls).toBe(0)
})

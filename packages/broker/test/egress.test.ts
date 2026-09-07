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
  let cancelled = false
  const transport = (async (_url: string) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(65))) },
    cancel() { cancelled = true },
  }))) as typeof fetch
  await expect(fetchJson('https://api.github.com/x', {}, transport, 64)).rejects.toThrow()
  expect(cancelled).toBe(true)
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

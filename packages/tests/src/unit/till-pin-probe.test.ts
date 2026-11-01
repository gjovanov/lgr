import { afterEach, describe, expect, it } from 'bun:test'

/**
 * Whether a PIN is on offer is asked before sign-in, on every till page a tab without a session
 * opens, and the router waits for the answer. So a server that takes the request and never answers
 * would hold the move for as long as it likes, with nothing on screen.
 */
describe('asking whether a PIN is on offer', () => {
  const real = { fetch: globalThis.fetch, timeout: AbortSignal.timeout }

  afterEach(() => {
    globalThis.fetch = real.fetch
    AbortSignal.timeout = real.timeout
  })

  it('gives up on a server that never answers, as a no', async () => {
    // A few milliseconds stand in for the limit. The stand-in server settles on the abort alone.
    AbortSignal.timeout = ((ms: number) => real.timeout.call(AbortSignal, Math.min(ms, 5))) as typeof AbortSignal.timeout
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))
    })) as typeof fetch

    const { pinOffered } = await import('../../../invoicing-ui/src/pos/composables/useTillPin?hung')
    const answer = await Promise.race([pinOffered(), new Promise(resolve => setTimeout(() => resolve('still waiting'), 500))])

    expect(answer).toBe(false)
  })
})

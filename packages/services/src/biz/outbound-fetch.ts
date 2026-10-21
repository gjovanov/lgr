/**
 * Every call LGR makes to another server has a deadline (FR-20.53, plan step P0a-7).
 *
 * `fetch` has none: a host that accepts the connection and never answers — a black-holed
 * address, a stalled proxy, a provider having a bad day — holds the request, and whatever waits
 * on it (a sign-in, an invoice email, a backup run, a scheduler tick) forever. On a shop's master
 * behind a flaky line that is the normal case, not an outage.
 *
 * Two kinds of deadline:
 * - **`body`** (the default): the whole exchange, response body included. For API calls.
 * - **`headers`**: only until the response starts. For a response that is streamed on to a
 *   client (an installer download): a slow but healthy transfer must not be cut off, while a
 *   host that never answers still fails.
 *
 * ⚠ `unit/outbound-timeouts.test.ts` fails on any `fetch(` in server code that has no deadline,
 * so a new outbound call cannot quietly skip this.
 */

export class OutboundTimeoutError extends Error {
  constructor(public host: string, public timeoutMs: number) {
    super(`${host} did not answer within ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'OutboundTimeoutError'
  }
}

export interface OutboundOptions {
  timeoutMs: number
  until?: 'body' | 'headers'
  /** The fetch to use — injected by code that is tested with a fake one. */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

function hostOf(input: string | URL | Request): string {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host
  } catch {
    return 'the remote server'
  }
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  { timeoutMs, until = 'body', fetchImpl = fetch }: OutboundOptions,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new OutboundTimeoutError(hostOf(input), timeoutMs)), timeoutMs)
  // A caller that never reads the body must not keep the process alive for the deadline.
  ;(timer as any).unref?.()
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  try {
    const res = await fetchImpl(input, { ...init, signal })
    if (until === 'headers') clearTimeout(timer)
    else {
      // The deadline also covers reading the body; it is lifted once the body has been read.
      const lift = () => clearTimeout(timer)
      for (const m of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
        const orig = (res as any)[m]?.bind(res)
        if (orig) (res as any)[m] = () => orig().finally(lift)
      }
    }
    return res
  } catch (e: any) {
    clearTimeout(timer)
    if (controller.signal.aborted && controller.signal.reason instanceof OutboundTimeoutError) throw controller.signal.reason
    throw e
  }
}

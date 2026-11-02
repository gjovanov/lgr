/**
 * `Idempotency-Key` for requests that must not happen twice (FR-20.37, #155): a POS sale,
 * a storno, opening and closing a session.
 *
 * One key per ATTEMPT, reused only when the outcome is unknown — the request may or may not
 * have reached the server — so pressing the button again (or the till retrying) returns what
 * the first attempt did instead of selling twice. A definitive answer, success or a refusal,
 * ends the attempt; the next press is a new one. A different body is always a new attempt:
 * an edited cart must not be mistaken for a retry of the old one (the server would answer 422).
 */

/** A random key. `crypto.randomUUID` needs a secure context; a shop LAN over plain HTTP is not one. */
function newKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether the server may have acted on a request that failed: no answer at all (network,
 * timeout), a proxy that gave up (408/502/504), the pod holding the printer not answering the pod
 * that forwarded to it (FR-24.51: the connection can die mid-print, so the receipt may be out), or
 * the server saying the same key is still being processed. Anything else is the server's own
 * definitive answer.
 */
export function isOutcomeUnknown(err: any): boolean {
  const res = err?.response
  if (!res) return true
  if ([408, 502, 504].includes(res.status)) return true
  if (res.status === 503 && res.data?.code === 'fiscal_holder_unreachable') return true
  return res.status === 409 && res.data?.code === 'idempotency_in_progress'
}

export interface IdempotentAction {
  /** The headers for this attempt of `body`. */
  headers(body: unknown): Record<string, string>
  /** After the request: pass the error, or nothing on success. */
  settle(err?: unknown): void
  /**
   * Send one attempt of `body`: `send` gets the headers to put on the request, and the attempt
   * is settled by its outcome. `body` is also what identifies the attempt — include anything
   * the URL names (e.g. the document id) so two documents never share a key.
   */
  run<T>(body: unknown, send: (headers: Record<string, string>) => Promise<T>): Promise<T>
}

export function createIdempotentAction(): IdempotentAction {
  let key: string | null = null
  let fingerprint = ''
  const action: IdempotentAction = {
    headers(body) {
      const fp = JSON.stringify(body ?? null)
      if (!key || fp !== fingerprint) {
        key = newKey()
        fingerprint = fp
      }
      return { 'Idempotency-Key': key }
    },
    settle(err) {
      if (!err || !isOutcomeUnknown(err)) key = null
    },
    async run(body, send) {
      const headers = action.headers(body)
      try {
        const result = await send(headers)
        action.settle()
        return result
      } catch (e) {
        action.settle(e)
        throw e
      }
    },
  }
  return action
}

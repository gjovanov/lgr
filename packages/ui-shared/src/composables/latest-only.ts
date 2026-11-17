/**
 * The latest question wins (FR-31.4).
 *
 * `latestOnly(fn)` wraps an asynchronous call so that only the answer to the most recent call is delivered. An
 * earlier call's answer, and its error, are dropped: a slow answer to "bo" never replaces the answer to "bolt", and
 * never raises an error message. The earlier call's request is aborted through the `AbortSignal` handed to `fn`,
 * where `fn` passes it on (axios takes `signal`).
 *
 * Each consumer keeps its own wrapper: one shared by two would let one drop the other's answers.
 */

export type Answer<R> = { latest: true; value: R } | { latest: false }

export interface LatestOnly<A extends unknown[], R> {
  (...args: A): Promise<Answer<R>>
  /** Nothing in flight is wanted any more (the field was emptied, the page is going): drop it, and abort it. */
  cancel(): void
}

export function latestOnly<A extends unknown[], R>(fn: (signal: AbortSignal, ...args: A) => Promise<R>): LatestOnly<A, R> {
  let seq = 0
  let current: AbortController | null = null

  const run = (async (...args: A): Promise<Answer<R>> => {
    const mine = ++seq
    current?.abort()
    const controller = new AbortController()
    current = controller
    try {
      const value = await fn(controller.signal, ...args)
      return mine === seq ? { latest: true, value } : { latest: false }
    } catch (e) {
      // An answer nobody waits for any more, an error included (the abort's own among them), says nothing.
      if (mine !== seq) return { latest: false }
      throw e
    } finally {
      if (current === controller) current = null
    }
  }) as LatestOnly<A, R>

  run.cancel = () => {
    seq++
    current?.abort()
    current = null
  }
  return run
}

/** The error an aborted request rejects with (axios' `CanceledError`, the platform's `AbortError`). */
export function isAbort(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | null
  return !!err && (err.name === 'AbortError' || err.name === 'CanceledError' || err.code === 'ERR_CANCELED')
}

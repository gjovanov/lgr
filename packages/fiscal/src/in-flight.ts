/**
 * What the fiscal devices are doing right now (FR-20.23, plan step P1-3).
 *
 * A stop must not land in the middle of a receipt. The device would be left with a receipt open,
 * and refuse everything after it until someone voids it by hand. So the API's graceful stop
 * waits until nothing is in flight here, and the master's status reports the count (the updater
 * defers on it, FR-20.20).
 *
 * Two levels, because one would not do:
 * - **Every printer command**: `getPrinter()` hands out a `tracked()` printer, so a Z-report, a
 *   clock sync or any report counts while it runs, whoever called it.
 * - **A whole receipt**: a sale or a storno is many commands (open, lines, payments, close). Between
 *   two of them nothing is running, and a stop that waited only for commands would slip in there.
 *   `fiscalOperation()` around the whole receipt keeps the count up from the first command to the
 *   last, the error path's void included.
 */

let inFlight = 0

/** How many fiscal operations and commands are running now. */
export function fiscalInFlight(): number {
  return inFlight
}

/** Run `run` as one fiscal operation: counted from its start until it settles, either way. */
export async function fiscalOperation<T>(run: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await run()
  } finally {
    inFlight--
  }
}

/**
 * `printer`, with each of its methods counted while the promise it returns is pending. Everything
 * else passes through: a missing optional method is still `undefined` (callers test for them), and
 * `instanceof` still holds.
 */
export function tracked<P extends object>(printer: P): P {
  const wrapped = new Map<PropertyKey, unknown>()
  return new Proxy(printer, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      let w = wrapped.get(prop)
      if (!w || (w as any).__of !== value) {
        const fn = function (this: unknown, ...args: unknown[]) {
          const result = value.apply(target, args)
          if (!result || typeof (result as any).then !== 'function') return result
          inFlight++
          return Promise.resolve(result).finally(() => { inFlight-- })
        }
        ;(fn as any).__of = value
        wrapped.set(prop, fn)
        w = fn
      }
      return w
    },
  })
}

/**
 * Resolve once nothing is in flight, or once `timeoutMs` has passed. `true` when it went idle.
 * Polled: an operation's end is rare and cheap to notice, and a poll cannot miss one.
 */
export async function whenFiscalIdle(timeoutMs: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (inFlight > 0) {
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, pollMs))
  }
  return true
}

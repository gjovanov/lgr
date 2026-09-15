import { expect } from 'bun:test'

/**
 * Await a promise that is expected to reject, and hand back the error.
 *
 * ⚠ Use this instead of `expect(p).rejects` / `.resolves` anywhere the promise touches
 * MongoDB. On Bun + Windows those matchers DEADLOCK when the rejection follows driver I/O:
 * the pending operation hangs, `mongodb-memory-server` reaps the mongod ("killed N dangling
 * processes"), and every later file in the run cascades into ECONNREFUSED. The failure does
 * not look like a matcher problem — it looks like the database died — which is why it cost
 * real time to find twice already. See the Known Issues table in CLAUDE.md.
 *
 * It is not a Windows-only nicety either: the same test written this way passes identically
 * on Linux, so there is no reason to keep the matcher anywhere in this suite.
 *
 * ```ts
 * const err = await captureRejection(postJournalEntry(id, userId))
 * expect(err).toBeTruthy()
 * expect(String(err?.message)).toContain('Total debits must equal total credits')
 * ```
 *
 * Returns `null` when the promise RESOLVES, so asserting the error is truthy is what proves
 * it rejected at all — a bare `expect(err.message)` would pass vacuously on a resolved
 * promise under optional chaining.
 */
export async function captureRejection(p: Promise<unknown>): Promise<any> {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

/**
 * Assert a captured rejection, as the drop-in for `.rejects.toThrow(...)`.
 *
 * ```ts
 * expectRejection(await captureRejection(login({ … })), 'Invalid credentials')
 * ```
 *
 * `expected` mirrors what `toThrow` accepts — a substring, a RegExp, or an Error subclass.
 * Omit it to assert only that the promise rejected.
 *
 * ⚠ The `!err` check is the load-bearing half. `toThrow` fails when a promise resolves; a
 * hand-rolled `expect(err.message).toContain(…)` under optional chaining does NOT, so a
 * conversion that drops this check silently turns a real assertion into one that passes when
 * the code under test stops throwing.
 */
export function expectRejection(
  err: any,
  expected?: string | RegExp | (new (...args: any[]) => Error),
): void {
  if (!err) throw new Error('Expected the promise to reject, but it resolved')
  if (expected === undefined) return

  if (typeof expected === 'string') {
    expect(String(err.message)).toContain(expected)
  } else if (expected instanceof RegExp) {
    expect(String(err.message)).toMatch(expected)
  } else {
    expect(err).toBeInstanceOf(expected)
  }
}

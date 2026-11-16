import type { ClientSession } from 'mongoose'
import { DuplicateError } from 'dal'
import { mongoose } from 'db/connection'

/** How many times a transaction is run when a duplicate key aborted it. */
const ATTEMPTS = 5

/**
 * A duplicate key: the driver's, or the repository's `DuplicateError`. Inside a transaction it is
 * fatal to the transaction, whatever the code that met it would do outside one.
 */
export const isDuplicateKey = (e: any): boolean =>
  e instanceof DuplicateError || e?.code === 11000 || e?.code === 11001 || e?.code === 'DUPLICATE'

/**
 * Runs `fn` in a transaction of its own and returns what it returns (FR-29.1, FR-29.8).
 *
 * `withTransaction` runs `fn` again on a write conflict or a lost commit. A duplicate key aborts the
 * transaction too, but carries no such label: a row another request created at the same moment (a
 * new stock level, a stock movement's "latest + 1" number), which outside a transaction the code
 * would simply land on or take the next of. So `fn` runs again then, from the start, on the rows that
 * now exist.
 *
 * ⚠ `fn` may run more than once: it builds everything it writes afresh each time, and does nothing
 * outside the session that it would not want twice. ⚠ Never two operations at once on `session`
 * (`Promise.all`): both try to start the transaction, and the loser makes it run `fn` again.
 */
export async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>, opts: { attempts?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? ATTEMPTS
  for (let attempt = 1; ; attempt++) {
    const session = await mongoose.startSession()
    try {
      let out!: T
      await session.withTransaction(async () => { out = await fn(session) })
      return out
    } catch (e) {
      if (attempt < attempts && isDuplicateKey(e)) continue
      throw e
    } finally {
      await session.endSession()
    }
  }
}

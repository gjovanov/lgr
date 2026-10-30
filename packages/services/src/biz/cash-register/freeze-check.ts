/**
 * FR-21.28 — the server reads the till's history from documents only (R4) only once that is safe.
 *
 * R4's readers no longer ask `postransactions` (FR-21.27). A POS row without its document would then
 * be read by nobody: missing from the journal, SUPTO 18.1–18.5, the session journal entry. So the
 * cash-register routes answer 503 with the reason until either:
 * - `0009-cash-register-freeze` is recorded: every row was copied and parity held; or
 * - `postransactions` is empty: there is nothing to miss (a new database, a new master).
 *
 * This is the `0001-unp-per-device` pattern: refuse, and say which migration to run. It is checked at
 * startup and, while not ready, again at most every 15 s, so `bun run migrate` lifts it without a
 * restart. Once ready it stays ready: the model refuses writes (FR-21.26), and the restore of an older
 * bundle converts the rows it lands.
 */
import { mongoose } from 'db/connection'
import { logger } from '../../logger/logger.js'

export const FREEZE_MIGRATION = '0009-cash-register-freeze'
/** `packages/migrations/src/runner.ts#COLLECTION`. `services` must not import `migrations`. */
const MIGRATIONS_COLLECTION = '_migrations'
const RECHECK_MS = 15_000

export interface RegisterReadiness {
  ready: boolean
  /** Why the routes are refused, when they are. */
  reason?: string
}

let ready = false
let checkedAt = 0
let last: RegisterReadiness = { ready: false }
/** The check in flight. Whoever asks while it runs gets its answer. */
let pending: Promise<RegisterReadiness> | null = null
/** Bumped by a reset, so a check that started before it cannot write its answer after it. */
let generation = 0

/** For tests: forget the cached answer, and any check still in flight. */
export function resetRegisterReadiness(): void {
  generation++
  ready = false
  checkedAt = 0
  last = { ready: false }
  pending = null
}

export async function registerReadiness(now = Date.now()): Promise<RegisterReadiness> {
  if (ready) return { ready: true }
  // ⚠ Before the recheck window: `checkedAt` is set when a check STARTS, so without this a request
  // that arrived while the first check was still querying got the initial `last`, not ready and
  // with no reason, and the route answered 503 with no message. On a freshly started server every
  // request of a burst but the first did (found by the parallel test run, 2026-10-30).
  if (pending) return pending
  if (checkedAt && now - checkedAt < RECHECK_MS) return last
  checkedAt = now
  const gen = generation
  const check = readiness().then(answer => {
    if (gen === generation) {
      last = answer
      if (answer.ready) ready = true
    }
    return answer
  })
  pending = check.finally(() => {
    if (gen === generation) pending = null
  })
  return pending
}

async function readiness(): Promise<RegisterReadiness> {
  const db = mongoose.connection.db
  if (!db) return { ready: false, reason: 'The database is not connected yet.' }
  const [recorded, posRow] = await Promise.all([
    db.collection(MIGRATIONS_COLLECTION).findOne({ _id: FREEZE_MIGRATION as any }, { projection: { _id: 1 } }),
    db.collection('postransactions').findOne({}, { projection: { _id: 1 } }),
  ])
  if (recorded || !posRow) return { ready: true }
  return {
    ready: false,
    reason: `The cash register's history is read from documents only, and migration ${FREEZE_MIGRATION} has not run on this database: `
      + 'POS transactions may exist that no reader would see. Run `bun run migrate`.',
  }
}

/** The 503 a cash-register route answers while the server is not ready, or null. */
export async function cashRegisterRefusal(): Promise<{ code: string; message: string } | null> {
  const r = await registerReadiness()
  return r.ready ? null : { code: 'cash_register_not_migrated', message: r.reason! }
}

/** At startup: say so loudly when the cash register will refuse. */
export async function logRegisterReadiness(): Promise<void> {
  try {
    const r = await registerReadiness()
    if (!r.ready) logger.warn({ migration: FREEZE_MIGRATION }, `Cash register refused until migrated: ${r.reason}`)
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'Cash register readiness could not be checked at startup')
  }
}

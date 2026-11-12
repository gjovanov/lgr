import type { RepositoryRegistry } from 'dal'
import { StockMovement } from 'db/models'
import { logger } from '../logger/logger.js'

/**
 * A stock movement's number: `SM-<year>-NNNNN`, the org's latest of the year + 1.
 *
 * These numbers predate the sequence registry and no counter issues them, so "latest + 1" is read and then
 * written: two creators at the same moment read the same latest, and the unique index (orgId + movementNumber)
 * lets only one of them save. Every creator therefore writes through `withMovementNumber`, which tries again
 * under a fresh number. Until 2026-11 only a sale's dispatch did; the form, a goods receipt, an import, a
 * transfer and a count answered the other one a 500.
 *
 * ⚠ A number the CALLER chose never passes through here: it is saved as it is, or refused as it is.
 * ⚠ `unit/movement-number-source.test.ts` fails when another source builds the number itself.
 */

/**
 * How often one creator tries. A creator can lose a number once to each of the others writing at that moment, so
 * this is also how many may write at once with none of them refused, whatever the timing.
 */
export const MOVEMENT_NUMBER_ATTEMPTS = 12

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The digits a number is padded to. Within one width the index's text order is the numbers' own order. */
const WIDTH = 5

/**
 * The latest number of exactly `digits` digits, or null. The latest one only, from the index: listing a year's
 * movements to read the first was the cost of a number in an org with thousands of them.
 */
async function latestOfWidth(orgId: string, prefix: string, digits: number): Promise<number | null> {
  const row: any = await StockMovement
    .findOne({ orgId, movementNumber: { $regex: `^${prefix}[0-9]{${digits}}$` } } as any, { movementNumber: 1, _id: 0 })
    .sort({ movementNumber: -1 })
    .lean()
    .exec()
  return row ? parseInt(String(row.movementNumber).slice(prefix.length), 10) : null
}

/** The org's next number. Read, not reserved: write under it through `withMovementNumber`. */
export async function nextMovementNumber(orgId: string): Promise<string> {
  const prefix = `SM-${new Date().getFullYear()}-`
  // ⚠ The numbers are text in the index, so `…-99999` sorts after `…-100000`. Read as one list, the latest
  // stopped at 99999, and from the 100 001st movement of a year on every creator was offered a taken number
  // (#714). A number of more digits is later than any of fewer, so the latest of each width is asked for, and a
  // wider one only when the width before it is used up: below 99 999 that is the one read it always was.
  let latest = 0
  for (let digits = WIDTH; ; digits++) {
    const found = await latestOfWidth(orgId, prefix, digits)
    if (found === null) break
    latest = found
    if (found < 10 ** digits - 1) break
  }
  return `${prefix}${String(latest + 1).padStart(WIDTH, '0')}`
}

/**
 * Whether a write was refused because another movement has its number: the DAL's refusal
 * (`repos.stockMovements.create`) or the driver's (a model or a collection write, in a transaction or not).
 * A duplicate of anything else, an `_id` inserted twice above all, is not this.
 */
export function isMovementNumberTaken(e: unknown): boolean {
  const err = e as any
  if (err?.code === 'DUPLICATE') {
    const fields = err.fields && typeof err.fields === 'object' ? Object.keys(err.fields) : []
    // No field named: the driver did not say which index. A movement has this one unique index beside its id.
    return !fields.length || fields.includes('movementNumber') || fields.includes('unknown')
  }
  if (err?.code !== 11000 && err?.code !== 11001) return false
  if (err.keyPattern && typeof err.keyPattern === 'object') return 'movementNumber' in err.keyPattern
  return /movementNumber/.test(String(err.message ?? ''))
}

/**
 * Run `write` under the org's next number; when another creator took that number first, again under a fresh one.
 *
 * ⚠ `write` runs more than once, so everything it does must fail with the refused insert: the insert alone, or
 * one transaction around it. What follows the insert (a confirm, an audit entry) belongs after this returns.
 */
export async function withMovementNumber<T>(orgId: string, write: (movementNumber: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const movementNumber = await nextMovementNumber(orgId)
    try {
      return await write(movementNumber)
    } catch (e) {
      if (!isMovementNumberTaken(e) || attempt >= MOVEMENT_NUMBER_ATTEMPTS) throw e
      // Once is the ordinary race; a creator that keeps losing says something about the load.
      if (attempt >= 3) logger.warn({ orgId, movementNumber, attempt }, 'Stock movement number taken again, retrying')
      // Those who lost the same number would read the same next one together: spread them.
      await pause(Math.random() * 8 * attempt)
    }
  }
}

/** Create a stock movement under the org's next number (`withMovementNumber`), through the DAL. */
export function createNumberedMovement(repos: RepositoryRegistry, orgId: string, data: Record<string, any>): Promise<any> {
  return withMovementNumber(orgId, movementNumber => repos.stockMovements.create({ ...data, orgId, movementNumber } as any))
}

import { Sequence } from 'db/models'

/**
 * Atomic sequence number generator using MongoDB findOneAndUpdate with $inc.
 * Race-condition safe — multiple concurrent calls will never get the same number.
 *
 * Usage:
 *   const num = await getNextNumber(orgId, 'INV', 5)  // → "INV-2026-00001"
 *   const num = await getNextNumber(orgId, 'POS', 6)  // → "POS-2026-000001"
 */
export async function getNextNumber(
  orgId: string,
  prefix: string,
  padLength: number = 5,
  year?: number,
): Promise<string> {
  const yr = year ?? new Date().getFullYear()

  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix, year: yr },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()

  const seq = String(doc!.lastNumber).padStart(padLength, '0')
  return `${prefix}-${yr}-${seq}`
}

/**
 * Get the current (last used) number without incrementing.
 * Useful for display or debugging.
 */
export async function getCurrentNumber(orgId: string, prefix: string, year?: number): Promise<number> {
  const yr = year ?? new Date().getFullYear()
  const doc = await Sequence.findOne({ orgId, prefix, year: yr }).exec()
  return doc?.lastNumber ?? 0
}
